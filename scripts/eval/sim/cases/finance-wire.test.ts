/**
 * S3 接线自测（确定性假模型；零真实模型、零触网）。
 *
 * 证明三件事：
 *   ① 财务数据确实由 S1 的声明式 Dummy 提供，且 `--where customer=…` 维度过滤生效；
 *   ② S4 的财务 Oracle 在假模型下能给出 pass / fail（一条正确样本 + 一条错误样本）；
 *   ③ 两臂（A 无技能 / B 有 catalog）各跑通 1 条 SIM-FIN-03，并记录技能装配事实。
 *
 * 技能链路遥测的边界（诚实登记，不补零）：
 *   · 已存在且已接上：`loadMainSkillDelivery` 的 catalog / catalogBytes / registry（B 臂非空、
 *     A 臂为空）——这是装配期事实，S0 的唯一技能形态；
 *   · 不存在：S5 的 `SimSystemTurn` 只投影执行层 `executions` 与模型 `calls`，没有 Main 工具面
 *     （`read_skill`）的调用投影；`ask-adapter` 也未暴露。故本自测**不伪造** read_skill 命中数，
 *     留 TODO：等 `SimSystemTurn` 增加 mainToolCalls 字段后接入。
 *
 * 故障触发方式见 `./fixtures` 的 `dummy-platform:finance`：`finance-mingda-receipts` 在
 * scenario.faults 里声明 `read_fault`，任何 `dummy.query --collection finance-mingda-receipts`
 * 都确定性返回 `failed / COLLECTION_FAULT`（exit 2，无载荷）。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMainSkillDelivery } from '../../../../packages/agent/src/worker-skills';
import { runSimTrial, type SimSystemTurn } from '../run';
import { ScriptedSimulator, ScriptedSystem, finishCompletion } from '../fakes';
import { resolveOracle, type SimExecutionFact } from '../oracle';
import { SIM_CASE_ORACLES, SIM_READ_CASES } from './index';
import { FINANCE_AR_CASES } from './finance-cases';
import { AR_TRUTH_PATTERNS, FINANCE_AR_ORACLES } from './finance-oracles';
import { resolveFixtureDeclaration } from './fixtures';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures');
const DUMMY_BIN = path.join(FIXTURES_ROOT, 'dummy-platform', 'bin', 'dummy');
/** 臂 A：目录故意不存在（`loadMainSkillDelivery` 对缺失目录 = 空索引）。 */
const SKILLS_NONE_DIR = path.join(FIXTURES_ROOT, 'dummy-platform', '.agents', 'skills-none');
/** 臂 B：仓库生产技能目录（当前含 `finance-business-basics`）。 */
const SKILLS_CATALOG_DIR = path.join(REPO_ROOT, '.agents', 'skills');

const TMP_DIRS: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface DummyRun {
  readonly status: number | null;
  readonly envelope: Record<string, unknown> | null;
}

/** 与 `scripts/dummy-declarative.test.ts` 同型调用（每次新 state-dir，互不共享）。 */
function runDummy(args: readonly string[], stateDir: string): DummyRun {
  const r = spawnSync(DUMMY_BIN, ['--state-dir', stateDir, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] ?? tmpdir() },
  });
  const lines = (r.stdout ?? '').trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  const envelope = last.startsWith('RESULT ')
    ? JSON.parse(last.slice('RESULT '.length)) as Record<string, unknown>
    : null;
  return { status: r.status, envelope };
}

function itemsOf(envelope: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const data = envelope?.['data'] as { items?: Array<Record<string, unknown>> } | null;
  return data?.items ?? [];
}

const READ_OK: SimExecutionFact = { operation: 'dummy.query', status: 'completed' };

/** 一条正确的 SIM-FIN-03 答复（明达物流一行）。 */
const CORRECT_MINGDA_REPLY = '明达物流截至 2026-10-31：应收 25000 元，已核销 7000 元，未结清 18000 元。';
/** 一条错误答复：把全量当成指定客户的汇总。 */
const WRONG_MINGDA_REPLY = '截至 2026-10-31：应收 60000 元，已核销 23500 元，未结清 36500 元。';

async function runOneTrial(input: {
  readonly caseId: string;
  readonly reply: string;
  readonly arm: 'A' | 'B';
}): Promise<Awaited<ReturnType<typeof runSimTrial>>> {
  const caseDef = FINANCE_AR_CASES.find((entry) => entry.id === input.caseId);
  if (caseDef === undefined) throw new Error(`缺用例 ${input.caseId}`);
  const system = new ScriptedSystem([
    { visibleReply: input.reply, executions: [READ_OK] } satisfies SimSystemTurn,
  ]);
  const simulator = new ScriptedSimulator([finishCompletion('satisfied', `臂 ${input.arm}：结果够用`)]);
  const oracle = resolveOracle(caseDef.oracleId, SIM_CASE_ORACLES);
  return runSimTrial(caseDef, 1, {
    outRoot: tmpDir(`s3-wire-${input.arm}-`),
    createSystem: () => system,
    simulator,
    oracle,
  });
}

describe('① Dummy 财务数据与维度过滤', () => {
  it('finance-invoices 全量 10 条；--where customer=明达物流 只返回 3 条且合计 25000', () => {
    const stateDir = tmpDir('s3-wire-dummy-');
    const all = runDummy(['query', 'dummy.query', '--collection', 'finance-invoices'], stateDir);
    expect(all.status).toBe(0);
    expect(all.envelope).toMatchObject({ status: 'completed', data: { collection: 'finance-invoices', count: 10 } });

    const mingda = runDummy(
      ['query', 'dummy.query', '--collection', 'finance-invoices', '--where', 'customer=明达物流'],
      stateDir,
    );
    expect(mingda.status).toBe(0);
    expect(mingda.envelope).toMatchObject({ status: 'completed', data: { collection: 'finance-invoices', count: 3 } });
    const items = itemsOf(mingda.envelope);
    expect(items.map((item) => item['customer'])).toEqual(['明达物流', '明达物流', '明达物流']);
    expect(items.map((item) => item['id'])).toEqual(['INV-B-001', 'INV-B-002', 'INV-B-003']);
    expect(items.reduce((sum, item) => sum + Number(item['amount']), 0)).toBe(25000);
  });

  it('收款 / 核销集合可读（7 条 / 7 条），时间窗成员校验不改变数据', () => {
    const stateDir = tmpDir('s3-wire-dummy-');
    const receipts = runDummy(['query', 'dummy.query', '--collection', 'finance-receipts'], stateDir);
    expect(receipts.envelope).toMatchObject({ status: 'completed', data: { count: 7 } });
    const writeoffs = runDummy(['query', 'dummy.query', '--collection', 'finance-writeoffs'], stateDir);
    expect(writeoffs.envelope).toMatchObject({ status: 'completed', data: { count: 7 } });
    const receiptWindow = runDummy(
      ['query', 'dummy.query', '--collection', 'finance-receipts', '--window', '2026-10'],
      stateDir,
    );
    expect(receiptWindow.envelope).toMatchObject({ status: 'completed', data: { count: 7 } });
  });

  it('数据缺失集合 finance-mingda-receipts 确定性触发 COLLECTION_FAULT（exit 2，无载荷）', () => {
    const stateDir = tmpDir('s3-wire-dummy-');
    const fault = runDummy(['query', 'dummy.query', '--collection', 'finance-mingda-receipts'], stateDir);
    expect(fault.status).toBe(2);
    expect(fault.envelope).toMatchObject({
      status: 'failed',
      data: null,
      error: { code: 'COLLECTION_FAULT' },
    });
  });

  it('非法维度值仍是 WHERE_INVALID（维度来自声明，不是模型自由发挥）', () => {
    const stateDir = tmpDir('s3-wire-dummy-');
    const bad = runDummy(
      ['query', 'dummy.query', '--collection', 'finance-invoices', '--where', 'customer=不存在客户'],
      stateDir,
    );
    expect(bad.status).toBe(1);
    expect(bad.envelope).toMatchObject({ status: 'failed', data: null, error: { code: 'WHERE_INVALID' } });
  });
});

describe('② Oracle 在假模型下的 pass / fail', () => {
  it('正确样本判 pass，并落出 checks', async () => {
    const result = await runOneTrial({ caseId: 'SIM-FIN-03', reply: CORRECT_MINGDA_REPLY, arm: 'A' });
    expect(result.terminal).toBe('satisfied');
    expect(result.oracle?.verdict.pass, JSON.stringify(result.oracle?.verdict.detail)).toBe(true);
    expect(result.oracle?.verdict.detail['checks']).toMatchObject({
      receivable_total: true, written_off_total: true, outstanding_total: true,
    });
    console.log('[S3-WIRE][oracle-pass]', JSON.stringify({
      caseId: result.caseId, terminal: result.terminal, pass: result.pass,
      verdict: result.oracle?.verdict,
    }));
  });

  it('错误样本判 fail（把全量当客户汇总），且客户筛选维度为 false', async () => {
    const result = await runOneTrial({ caseId: 'SIM-FIN-03', reply: WRONG_MINGDA_REPLY, arm: 'A' });
    expect(result.terminal).toBe('satisfied');
    expect(result.oracle?.verdict.pass).toBe(false);
    expect(result.oracle?.verdict.detail['checks']).toMatchObject({
      receivable_total: false, written_off_total: false, outstanding_total: false,
    });
    console.log('[S3-WIRE][oracle-fail]', JSON.stringify({
      caseId: result.caseId, terminal: result.terminal, pass: result.pass,
      verdict: result.oracle?.verdict,
    }));
  });
});

describe('③ 两臂（A 无技能 / B 有 catalog）各跑通一条', () => {
  it('臂 A：空索引（catalogBytes=0，无 read_skill 登记表），SIM-FIN-03 跑通', async () => {
    const delivery = await loadMainSkillDelivery(SKILLS_NONE_DIR);
    expect(delivery.catalog).toBe('');
    expect(delivery.catalogBytes).toBe(0);
    expect(delivery.registry).toBeUndefined();

    const result = await runOneTrial({ caseId: 'SIM-FIN-03', reply: CORRECT_MINGDA_REPLY, arm: 'A' });
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    console.log('[S3-WIRE][arm-A]', JSON.stringify({
      arm: 'A', catalogBytes: delivery.catalogBytes, skills: [],
      caseId: result.caseId, terminal: result.terminal, pass: result.pass,
      oraclePass: result.oracle?.verdict.pass,
      // TODO(S5 技能链路遥测): read_skill 命中数不可观测（SimSystemTurn 无 mainToolCalls 投影）。
    }));
  });

  it('臂 B：catalog 含 finance-business-basics，SIM-FIN-03 跑通', async () => {
    const delivery = await loadMainSkillDelivery(SKILLS_CATALOG_DIR);
    expect(delivery.catalogBytes).toBeGreaterThan(0);
    expect(delivery.catalog).toContain('finance-business-basics');
    expect(delivery.registry).toBeDefined();

    const result = await runOneTrial({ caseId: 'SIM-FIN-03', reply: CORRECT_MINGDA_REPLY, arm: 'B' });
    expect(result.terminal).toBe('satisfied');
    expect(result.pass).toBe(true);
    console.log('[S3-WIRE][arm-B]', JSON.stringify({
      arm: 'B', catalogBytes: delivery.catalogBytes,
      skills: (await delivery.registry?.discover() ?? []).map((skill) => skill.name),
      caseId: result.caseId, terminal: result.terminal, pass: result.pass,
      oraclePass: result.oracle?.verdict.pass,
      // TODO(S5 技能链路遥测): read_skill 命中数不可观测（SimSystemTurn 无 mainToolCalls 投影）。
    }));
  });
});

describe('④ 接线登记（用例 / Oracle / 夹具）', () => {
  it('五条用例 fixtureId 为真实夹具、trials=3、forbiddenKnowledge 覆盖真值', () => {
    expect(FINANCE_AR_CASES.map((caseDef) => caseDef.id)).toEqual([
      'SIM-FIN-01', 'SIM-FIN-02', 'SIM-FIN-03', 'SIM-FIN-04', 'SIM-FIN-05',
    ]);
    for (const caseDef of FINANCE_AR_CASES) {
      expect(caseDef.fixtureId, caseDef.id).toBe('dummy-platform:finance');
      expect(caseDef.limits.trials, caseDef.id).toBe(3);
      for (const pattern of AR_TRUTH_PATTERNS) {
        expect(caseDef.forbiddenKnowledge, `${caseDef.id} 缺 ${pattern}`).toContain(pattern);
      }
      expect(() => resolveFixtureDeclaration(caseDef.fixtureId), caseDef.id).not.toThrow();
    }
  });

  it('五条用例与其 Oracle 已进读套件 / 注册表', () => {
    const readIds = SIM_READ_CASES.map((caseDef) => caseDef.id);
    for (const caseDef of FINANCE_AR_CASES) expect(readIds).toContain(caseDef.id);
    for (const oracle of FINANCE_AR_ORACLES) expect(SIM_CASE_ORACLES.map((entry) => entry.id)).toContain(oracle.id);
  });

  it('夹具声明与 scenario 同源：customer 维度 + read_fault 集合', () => {
    const fixture = resolveFixtureDeclaration('dummy-platform:finance');
    expect(fixture.scenario).toBe('dummy-finance');
    expect(fixture.collections).toEqual([
      'finance-invoices', 'finance-receipts', 'finance-writeoffs', 'finance-mingda-receipts',
    ]);
    expect(fixture.deterministicFaults).toEqual([
      expect.objectContaining({ collection: 'finance-mingda-receipts' }),
    ]);
  });
});
