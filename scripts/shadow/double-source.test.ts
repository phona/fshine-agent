/**
 * R4 Shadow 演练（Dummy 路线）· 双源对照 harness —— **先在红**。
 *
 * 本文件先于实现提交：`./double-source-harness` 尚不存在（harness 缺失 → 模块解析失败即红）。
 * 绿色阶段实现 harness 后，本文件转绿；任何一条不得弱化。
 *
 * 双源定义（对照的两种「说话人」）：
 *   · 源 A = `dummy`：仓内 dummy fixture（scripts/eval/fixtures/dummy-platform）+ 生产适配器
 *     `packages/agent/src/dummy-cli-client.ts`（真实 spawn、真实 --state-dir、真实 audit.jsonl）；
 *   · 源 B = `fake-real`：测试用进程内 ExecutionClient（可配四态 completed/failed/needs_input/refused、
 *     错误信封 {code,message,retryable?,details?}、能力快照形状）；零子进程、零网络、零凭据、零真实数据。
 *
 * 边界（硬性）：double 仅测试夹具层级——不模拟平台实现、不模拟网络/限流/凭据、不进入产品代码路径；
 * 不连接真实企微/真实执行层。真实连接需 owner 授权（本 Run 不连接）。
 * 依据：docs/product/real-read-readiness.md（三步：fake-adapter dry-run → shadow 只读 → 受限真实只读）。
 *
 * 断言清单（与 runbook 同源）：
 *   ① 任务链语义等价（受理/执行/终态/存档/通知意图）× 四态；
 *   ② 只读路径哈希不变（数据面指纹前后相等 + 只读复读同哈希）+ 只读面派生双源一致；
 *   ③ 失败 fail-closed（failed/refused/needs_input 绝不报 completed；跨场景不得判等）；
 *   ④ 回退开关生效（缺省 dummy / 未知值 fail-closed / 双源 kind 可机械区分）；
 *   ⑤ 证据落盘可复跑（两次同场景 digest 相同、证据文件可解析、realConnection=false）；
 *   ⑥ 绊线 ≥3 类：单源事实冒充双源成功 / 只读哈希漂移 / fail-closed 破坏（见文末 describe）。
 *
 * 运行链路：assembleSessionCore(background，测试假 driver/sink) → send 委派 → 受理(queued/notice)
 *   → TaskRunner pump → 真实 createTaskExecutor → execute_operation（宿主生成 requestId）
 *   → client.execute（A=spawn 夹具 / B=进程内）→ 终态 + archiveReply 存档 → 通知 outbox → 假 sink。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXECUTION_CONTRACT_VERSION } from '@fshine/contracts/execution-contract';
import {
  compareChains,
  createFakeRealClient,
  createShadowSource,
  dataSurfaceFingerprint,
  parseShadowSourceName,
  probeReadOnlyStability,
  projectChain,
  runChainOnSource,
  runShadowComparison,
  verifyReadOnlyStable,
  type ChainScenario,
  type FakeRealConfig,
  type ShadowSourceRun,
} from './double-source-harness';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const dirs: string[] = [];
function tempDir(prefix = 'shadow-test-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 场景（两源同一条委派 + 同一次 operation 调用；差别只在执行层如何回答）
// ---------------------------------------------------------------------------
const SUCCESS_SCENARIO: ChainScenario = {
  request: '帮我查一下 documents 集合在 W202611 窗口的数据。',
  operation: 'dummy.query',
  args: { '--collection': 'documents', '--window': 'W202611' },
};
const NEEDS_INPUT_SCENARIO: ChainScenario = {
  request: '帮我查一下 contoso 集合的数据。',
  operation: 'dummy.query',
  args: { '--collection': 'contoso' },
};
const FAILED_SCENARIO: ChainScenario = {
  request: '帮我查一下 faulty-one 集合的数据。',
  operation: 'dummy.query',
  args: { '--collection': 'faulty-one' },
};
const REFUSED_SCENARIO: ChainScenario = {
  request: '帮我查一下 denied-one 集合的数据。',
  operation: 'dummy.query',
  args: { '--collection': 'denied-one' },
};

/** 源 B 的四种结果脚本（错误信封与源 A 夹具的事实原文同形，用于对照等价）。 */
const B_SUCCESS: FakeRealConfig = {
  outcomes: { 'dummy.query': { status: 'completed', data: { collection: 'documents', window: 'W202611', count: 3 } } },
};
const B_NEEDS_INPUT: FakeRealConfig = {
  outcomes: {
    'dummy.query': {
      status: 'needs_input',
      missing: [{ description: 'More than one collection matches "contoso"' }],
      data: { query: 'contoso', candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
      error: { code: 'COLLECTION_AMBIGUOUS', message: 'More than one collection matches "contoso"' },
    },
  },
};
const B_FAILED: FakeRealConfig = {
  outcomes: {
    'dummy.query': {
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: 'Collection faulty-one cannot be read in its current state' },
    },
  },
};
const B_REFUSED: FakeRealConfig = {
  outcomes: {
    'dummy.query': {
      status: 'refused',
      error: { code: 'GATE_REFUSE', message: 'GATE_REFUSE collection denied-one is restricted for the current caller' },
    },
  },
};

async function chainOn(
  source: 'dummy' | 'fake-real',
  scenario: ChainScenario,
  fakeReal?: FakeRealConfig,
): Promise<ShadowSourceRun> {
  return await runChainOnSource({
    source,
    scenario,
    workDir: tempDir(`shadow-chain-${source}-`),
    ...(fakeReal === undefined ? {} : { fakeReal }),
  });
}

describe('Shadow 双源对照 ①：任务链语义等价（成功链路）', () => {
  it('受理/执行/终态/存档/通知意图在两源同形，且两源机械事实非空（防单源冒充）', async () => {
    const a = await chainOn('dummy', SUCCESS_SCENARIO);
    const b = await chainOn('fake-real', SUCCESS_SCENARIO, B_SUCCESS);

    // 受理：两源同一条委派 → 同一机械受理形状（数字编号 + 业务名 + queued）
    for (const run of [a, b]) {
      expect(run.acceptance).toMatchObject({ taskNo: 1, status: 'queued', accepted: true });
      expect(run.acceptance.notice).toContain('#1');
      expect(run.acceptance.name.length).toBeGreaterThan(0);
      expect(run.afterAcceptStatus).toBe('running');
    }

    // 两源机械执行事实都真实存在（源 A=执行层审计行；源 B=进程内调用记录）
    expect(a.mechanical).toMatchObject({ executions: 1, spawnedGateway: true, calls: 0 });
    expect(a.mechanical.auditLines).toBeGreaterThan(0);
    expect(b.mechanical).toMatchObject({ executions: 1, spawnedGateway: false, auditLines: 0 });
    expect(b.mechanical.calls).toBe(1);

    // 终态/存档/通知意图：逐源直接断言 + 跨源投影等价
    for (const run of [a, b]) {
      expect(run.terminal.status).toBe('completed');
      expect(run.terminal.replyText).toBeTruthy();
      expect(run.terminal.replyText).toContain('dummy.query');
      expect(run.executions.map((entry) => entry.status)).toEqual(['completed']);
      expect(run.notifications.map((entry) => entry.kind)).toEqual(['accepted', 'started', 'completed']);
      expect(run.notifications.every((entry) => entry.delivered)).toBe(true);
      expect(run.sinkKinds).toEqual(['accepted', 'started', 'completed']);
    }
    const comparison = compareChains(a, b);
    expect(comparison.equivalent).toBe(true);
    expect(comparison.diffs).toEqual([]);
  });
});

describe('Shadow 双源对照 ②：四态语义等价（needs_input / failed / refused）', () => {
  it('needs_input：等待态 + 缺失原文同形；绝不报 completed', async () => {
    const a = await chainOn('dummy', NEEDS_INPUT_SCENARIO);
    const b = await chainOn('fake-real', NEEDS_INPUT_SCENARIO, B_NEEDS_INPUT);
    for (const run of [a, b]) {
      expect(run.terminal.status).toBe('waiting_user');
      expect(run.terminal.status).not.toBe('completed');
      expect(run.terminal.pendingMissing).toEqual(['More than one collection matches "contoso"']);
      expect(run.terminal.replyText).toBeUndefined();
      expect(run.executions.map((entry) => entry.status)).toEqual(['needs_input']);
      expect(run.notifications.map((entry) => entry.kind)).toEqual(['accepted', 'started', 'waiting_user']);
    }
    expect(compareChains(a, b).equivalent).toBe(true);
  });

  it('failed：终态 failed + 原文原因；通知 failed；不得 completed', async () => {
    const a = await chainOn('dummy', FAILED_SCENARIO);
    const b = await chainOn('fake-real', FAILED_SCENARIO, B_FAILED);
    for (const run of [a, b]) {
      expect(run.terminal.status).toBe('failed');
      expect(run.terminal.failureReason).toContain('执行层未成功：dummy.query 返回 failed');
      expect(run.terminal.failureReason).toContain('Collection faulty-one cannot be read in its current state');
      expect(run.terminal.replyText).toBeUndefined();
      expect(run.executions.map((entry) => entry.status)).toEqual(['failed']);
      expect(run.executions[0]?.errorCode).toBe('COLLECTION_FAULT');
      expect(run.notifications.map((entry) => entry.kind)).toEqual(['accepted', 'started', 'failed']);
    }
    expect(compareChains(a, b).equivalent).toBe(true);
  });

  it('refused：执行层拒绝（非失败码面）如实转述；终态 failed 且 error code 保留', async () => {
    const a = await chainOn('dummy', REFUSED_SCENARIO);
    const b = await chainOn('fake-real', REFUSED_SCENARIO, B_REFUSED);
    for (const run of [a, b]) {
      expect(run.terminal.status).toBe('failed');
      expect(run.terminal.failureReason).toContain('返回 refused');
      expect(run.executions.map((entry) => entry.status)).toEqual(['refused']);
      expect(run.executions[0]?.errorCode).toBe('GATE_REFUSE');
      expect(run.notifications.map((entry) => entry.kind)).toEqual(['accepted', 'started', 'failed']);
    }
    expect(compareChains(a, b).equivalent).toBe(true);
  });
});

describe('Shadow 双源对照 ③：只读路径哈希不变', () => {
  it('数据面指纹读前=读后、只读复读同哈希；只读面派生双源一致（同一 access=read 规则）', async () => {
    const a = await probeReadOnlyStability({
      source: 'dummy',
      workDir: tempDir('shadow-probe-dummy-'),
      operation: 'dummy.query',
      args: { '--collection': 'documents', '--window': 'W202611' },
    });
    const b = await probeReadOnlyStability({
      source: 'fake-real',
      workDir: tempDir('shadow-probe-fake-real-'),
      operation: 'dummy.query',
      args: { '--collection': 'documents', '--window': 'W202611' },
      fakeReal: B_SUCCESS,
    });
    for (const probe of [a, b]) {
      expect(verifyReadOnlyStable(probe)).toEqual({ ok: true, violations: [] });
      expect(probe.readDigests[0]).toBe(probe.readDigests[1]);
      expect(probe.before).toBe(probe.after);
    }
    // 只读面派生（readOnlyOperationNames 单源规则）：两源声明同形 → 允许集合一致且只含 read
    expect(a.allowedOperations).toEqual(b.allowedOperations);
    expect(a.allowedOperations).toEqual(['ballot.query', 'dummy.query']);
    expect(a.allowedOperations).not.toContain('dummy.commit');
  });
});

describe('Shadow 双源对照 ④：回退开关与装配面 fail-closed', () => {
  it('源开关解析：缺省 dummy、两值确定、未知值（含 real）fail-closed', () => {
    expect(parseShadowSourceName(undefined)).toBe('dummy');
    expect(parseShadowSourceName('')).toBe('dummy');
    expect(parseShadowSourceName('dummy')).toBe('dummy');
    expect(parseShadowSourceName('fake-real')).toBe('fake-real');
    expect(() => parseShadowSourceName('real')).toThrowError(/dummy \| fake-real/);
    expect(createShadowSource('dummy').kind).toBe('repo-dummy-fixture');
    expect(createShadowSource('fake-real').kind).toBe('test-fake-real');
  });

  it('源 B 能力快照形状可配（args 投影/契约版本/错误信封原样透传）', async () => {
    const client = createFakeRealClient({
      operations: [
        {
          name: 'fake.query',
          label: 'fake query',
          access: 'read',
          args: { flags: [{ flag: '--collection', required: true, style: 'name' }] },
        },
        { name: 'fake.write', access: 'write' },
      ],
      outcomes: {
        'fake.query': { status: 'refused', error: { code: 'FAKE_REFUSED', message: 'nope', retryable: false } },
      },
    });
    const manifest = await client.capabilities();
    expect(manifest.contractVersion).toBe(EXECUTION_CONTRACT_VERSION);
    expect(manifest.operations.map((operation) => operation.name)).toEqual(['fake.query', 'fake.write']);
    const collection = manifest.operations[0]?.args.find((entry) => entry.name === '--collection');
    expect(collection).toMatchObject({ required: true, type: 'name' });
    // 错误信封原样进契约层（四态之一），不被宿主改写
    await expect(client.execute({ requestId: 'req_test', operation: 'fake.query', args: { '--collection': 'alpha' } }))
      .resolves.toEqual({
        status: 'refused',
        error: { code: 'FAKE_REFUSED', message: 'nope', retryable: false },
      });
  });

  it('空只读面 fail-closed：源 B 只声明写操作时装配拒绝（不以空允许集合运行）', async () => {
    const writeOnly: FakeRealConfig = {
      operations: [{ name: 'dummy.commit', access: 'write', args: { flags: [{ flag: '--collection', required: true }] } }],
    };
    await expect(runChainOnSource({
      source: 'fake-real',
      scenario: SUCCESS_SCENARIO,
      workDir: tempDir('shadow-empty-'),
      fakeReal: writeOnly,
    })).rejects.toThrowError(/只读|允许集合/);
  });
});

describe('Shadow 双源对照 ⑤：证据落盘可复跑', () => {
  it('两次同场景运行 digest 相同；证据文件可解析且明示未接真实', async () => {
    const evidenceDir = tempDir('shadow-evidence-');
    const first = await runShadowComparison({
      label: 'success',
      scenario: SUCCESS_SCENARIO,
      evidenceDir,
      fakeReal: B_SUCCESS,
    });
    const second = await runShadowComparison({
      label: 'success',
      scenario: SUCCESS_SCENARIO,
      evidenceDir,
      fakeReal: B_SUCCESS,
    });
    expect(first.comparison.equivalent).toBe(true);
    expect(first.readOnlyStable.dummy.ok).toBe(true);
    expect(first.readOnlyStable['fake-real'].ok).toBe(true);
    expect(first.digest).toBe(second.digest);
    expect(first.evidenceFiles.length).toBeGreaterThanOrEqual(3);
    const summaryPath = first.evidenceFiles.find((file) => file.endsWith('summary.json'));
    expect(summaryPath).toBeTruthy();
    for (const file of first.evidenceFiles) {
      expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    }
    const summary = JSON.parse(readFileSync(summaryPath!, 'utf8')) as {
      digest: string;
      realConnection: boolean;
      comparison: { equivalent: boolean };
    };
    // 规范化证据里不得带时间戳/随机 id（否则复跑 digest 必漂移）
    expect(summary.digest).toBe(first.digest);
    expect(summary.realConnection).toBe(false);
    expect(summary.comparison.equivalent).toBe(true);
  });
});

describe('Shadow 双源对照 ⑥：反向绊线（故意破坏必须红）', () => {
  it('绊线① 单源事实冒充双源成功：克隆源 A 证据伪装成 fake-real → 对照拒绝', async () => {
    const a = await chainOn('dummy', SUCCESS_SCENARIO);
    const forgedB: ShadowSourceRun = { ...a, source: 'fake-real' };
    const comparison = compareChains(a, forgedB);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.diffs.length).toBeGreaterThan(0);
  });

  it('绊线② 只读哈希漂移：数据面被写改或复读结果漂移 → verifyReadOnlyStable 红', async () => {
    const probe = await probeReadOnlyStability({
      source: 'dummy',
      workDir: tempDir('shadow-drift-'),
      operation: 'dummy.query',
      args: { '--collection': 'documents', '--window': 'W202611' },
    });
    expect(verifyReadOnlyStable(probe).ok).toBe(true);
    // 写改数据面（模拟写路径泄漏到只读链路）
    writeFileSync(path.join(probe.stateDir, 'dummy-state.json'), JSON.stringify({ collections: {} }));
    const drifted = { ...probe, after: dataSurfaceFingerprint(probe.stateDir) };
    const driftVerdict = verifyReadOnlyStable(drifted);
    expect(driftVerdict.ok).toBe(false);
    expect(driftVerdict.violations.length).toBeGreaterThan(0);
    // 复读结果漂移同样红
    const resultDrift = { ...probe, readDigests: [probe.readDigests[0], 'deadbeef'] as const };
    expect(verifyReadOnlyStable(resultDrift).ok).toBe(false);
  });

  it('绊线③ fail-closed 破坏：失败/等待链不得被投影成 completed，跨场景不得判等', async () => {
    const failedA = await chainOn('dummy', FAILED_SCENARIO);
    const failedB = await chainOn('fake-real', FAILED_SCENARIO, B_FAILED);
    const successB = await chainOn('fake-real', SUCCESS_SCENARIO, B_SUCCESS);
    // 失败两源同形（等价），但投影的终态必须是 failed
    expect(projectChain(failedB).terminal.status).toBe('failed');
    expect(compareChains(failedA, failedB).equivalent).toBe(true);
    // 跨场景（失败 × 成功）不得判等——若失败被误投影成成功，这里会红
    const cross = compareChains(failedA, successB);
    expect(cross.equivalent).toBe(false);
    expect(cross.diffs).toContain('terminal');
  });
});
