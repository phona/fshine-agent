/**
 * A1 执行成本可见性（2026-11-18 执行面可靠性；2026-11-24 模型面再收口）。
 *
 * 根因：执行层 `operation list --json` 自述 `est_seconds` / `weight`，但契约与投影
 * 把它们丢了——模型拿到的能力快照里没有任何成本事实，完全感觉不到一次任务发起 N 次
 * 执行意味着 N 倍的等待与失败面。
 *
 * 覆盖：
 *   · 投影：执行层声明 weight/est_seconds → manifest 带 weight/estimatedSeconds；
 *     未声明（或形状不对）→ 字段不出现（向后兼容：零行为变化）；
 *   · 渲染：Worker 委派文本里**看不到**估时/重量（2026-11-19 收口），清单标题下也没有
 *     成本陈述（2026-11-24 删 `WORKER_SNAPSHOT_COST_NOTE`）——模型只需选对操作、填对参数。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest } from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from './src/dummy-cli-client';
import { renderWorkerDelegation } from './src/execution-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
}

/**
 * 最小 stub 网关：三个 operation——
 *   · stub.heavy：声明 weight=20、est_seconds=10（执行层自述的成本提示）；
 *   · stub.light：什么都不声明（缺省 → 字段不出现）；
 *   · stub.badshape：weight/est_seconds 形状不对（字符串/None）→ 字段不出现。
 */
function writeCostStubGateway(rootDir: string): void {
  const operations = [
    {
      name: 'stub.heavy',
      access: 'read',
      weight: 20,
      est_seconds: 10,
      args: { flags: [{ flag: '--collection', required: false, style: 'name' }] },
    },
    {
      name: 'stub.light',
      access: 'read',
      args: { flags: [] },
    },
    {
      name: 'stub.badshape',
      access: 'read',
      weight: '20',
      est_seconds: null,
      args: { flags: [] },
    },
  ];
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(${JSON.stringify({ operations })}));
  process.exit(0);
}
process.stdout.write('RESULT {"status":"completed"}\\n');
process.exit(0);
`;
  mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
  const stub = path.join(rootDir, 'bin', 'stub');
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
}

describe('A1 投影：执行层自述的成本提示进能力快照', () => {
  it('声明了 weight/est_seconds 的 operation → manifest 带 weight/estimatedSeconds', async () => {
    const root = tempDir('cost-stub-');
    writeCostStubGateway(root);
    const client = createDummyCliClient({
      root,
      gateway: 'bin/stub',
      stateDir: path.join(root, 'state'),
      env: baseEnv(),
    });
    const manifest = await client.capabilities();
    const heavy = manifest.operations.find((entry) => entry.name === 'stub.heavy');
    expect(heavy).toBeDefined();
    expect(heavy!.weight).toBe(20);
    expect(heavy!.estimatedSeconds).toBe(10);
  });

  it('未声明 / 形状不对 → 字段不出现（向后兼容：零行为变化）', async () => {
    const root = tempDir('cost-stub-');
    writeCostStubGateway(root);
    const client = createDummyCliClient({
      root,
      gateway: 'bin/stub',
      stateDir: path.join(root, 'state'),
      env: baseEnv(),
    });
    const manifest = await client.capabilities();
    const light = manifest.operations.find((entry) => entry.name === 'stub.light');
    expect(light).toBeDefined();
    expect('weight' in light!).toBe(false);
    expect('estimatedSeconds' in light!).toBe(false);
    const badshape = manifest.operations.find((entry) => entry.name === 'stub.badshape');
    expect(badshape).toBeDefined();
    expect('weight' in badshape!).toBe(false);
    expect('estimatedSeconds' in badshape!).toBe(false);
  });

  it('真夹具（bin/dummy）：dummy.query / dummy.commit 的成本提示原样投影', async () => {
    const client = createDummyCliClient({
      root: FIXTURE_ROOT,
      gateway: 'bin/dummy',
      stateDir: tempDir('cost-fixture-'),
      env: baseEnv(),
    });
    const manifest = await client.capabilities();
    const query = manifest.operations.find((entry) => entry.name === 'dummy.query');
    // 夹具自述：query est_seconds=10、weight=2；commit weight=20（见 operation list --json）。
    expect(query!.estimatedSeconds).toBe(10);
    expect(query!.weight).toBe(2);
    const commit = manifest.operations.find((entry) => entry.name === 'dummy.commit');
    expect(commit!.weight).toBe(20);
    expect(commit!.estimatedSeconds).toBe(10);
  });
});

describe('A1 渲染：Worker 能力快照不含内部度量（2026-11-19 模型可见面收口）', () => {
  const MANIFEST: CapabilityManifest = {
    contractVersion: 3,
    operations: [
      { name: 'dummy.query', label: 'query records', args: [], weight: 2, estimatedSeconds: 10 },
      { name: 'dummy.commit', label: 'commit records', args: [], weight: 20, estimatedSeconds: 10 },
    ],
  };

  it('快照 JSON 块不再出现估时与重量（内部度量只进宿主接收/日志，不进委派）', () => {
    const text = renderWorkerDelegation({ task: '查一下 alpha', manifest: MANIFEST });
    // 口径变更（owner 2026-11-19 抽象泄露）：weight/est_seconds 是内部度量，模型拿它
    // 只会向用户承诺「单次估时约半小时」这类时长——已从委派清单去掉（只留调用所需）。
    expect(text).not.toContain('"estimatedSeconds"');
    expect(text).not.toContain('"weight"');
    // 声明仍然原样交给装配面：快照 JSON 是委派投影的输入，不在委派输出里出现度量。
    expect(manifestHasMetrics(MANIFEST)).toBe(true);
  });

  it('清单标题下不再有成本陈述（2026-11-24 删 WORKER_SNAPSHOT_COST_NOTE；调用所需仍在）', () => {
    const text = renderWorkerDelegation({ task: '查一下 alpha', manifest: MANIFEST });
    expect(text).toContain('## 可调用的操作');
    // 原中性事实整句删除（O-6）：执行次数是宿主侧资源边界（A2 单回合上界如实报数），
    // 不是给模型的成本课——模型拿它只会向用户承诺时长。复活即红。
    expect(text).not.toContain('一次任务发起 N 次执行');
    expect(text).not.toContain('控制执行次数');
    // 调用所需仍在：operation 名紧跟标题，投影没被削空。
    expect(text).toContain('"dummy.query"');
    expect(text).toContain('"dummy.commit"');
  });
});

/** 快照清单是否仍带内部度量（原样输入断言：投影发生在 renderWorkerDelegation 内）。 */
function manifestHasMetrics(manifest: CapabilityManifest): boolean {
  return manifest.operations.some((operation) =>
    operation.weight !== undefined || operation.estimatedSeconds !== undefined);
}
