/**
 * Dummy 夹具新能力自测（2026-11-18）：三种「执行层会花时间/会中途要东西」的场景。
 *
 * 背景：既有夹具只能造「立刻成功 / 立刻失败 / 立刻策略拒绝」，于是
 * 「调用执行层很久」「执行很久后异常」「needs_input → 用户补答 → 同一任务续跑」
 * 三条用户级路径在产品里根本点不出来。本套件钉住夹具侧的三条新声明：
 *   ① `--delay-ms <n>`：dummy.query / dummy.prepare / dummy.commit 的显式参数，
 *      真实等待（Atomics.wait），0..60000 上限，超限确定性拒绝；
 *   ② 场景故障 kind `slow_fault`：先真实等待 delayMs，再以既有错误信封失败（exit 2）；
 *   ③ 集合绑定 `requires: ["name", ...]`：调用没带该输入 → 确定性
 *      `status:"needs_input"` + 结构化 `missing`，不写任何数据；补齐后同一调用正常完成。
 *
 * 计时断言只用**下界**（sleep 只会被负载拖长，不会被缩短），并用同一条无延迟调用
 * 作差值对照（证明等待来自夹具而不是进程启动开销）。延迟值一律 ≤200ms。
 *
 * 三层纪律不变：新能力全部由 capabilities.json / scenario.json 声明驱动，
 * 运行时只懂 flag 名、毫秒数与 missing 名称，不懂业务。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const FIXTURES_ROOT = __dirname;
const FIXTURE_ROOT = path.join(FIXTURES_ROOT, 'dummy-platform');
const BIN = path.join(FIXTURE_ROOT, 'bin', 'dummy');
const SCENARIO = path.join(FIXTURES_ROOT, 'scenarios', 'dummy-finance', 'scenario.json');

const TMP_DIRS: string[] = [];
afterAll(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  TMPDIR: process.env['TMPDIR'],
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  envelope: Record<string, unknown> | null;
  audit: Array<Record<string, unknown>>;
  elapsedMs: number;
  stateDir: string;
}

/** 跑一次网关并把耗时一起记下（下界断言用；不读墙钟做上限）。 */
function runDummy(
  args: string[],
  options: { bin?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const bin = options.bin ?? BIN;
  const stateDir = options.stateDir ?? freshDir('dummy-cap-state-');
  const started = Date.now();
  const r = spawnSync(bin, ['--state-dir', stateDir, ...args], {
    encoding: 'utf8',
    env: { ...BASE_ENV, ...options.env },
  });
  const elapsedMs = Date.now() - started;
  const lines = (r.stdout ?? '').trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  const envelope = last.startsWith('RESULT ')
    ? JSON.parse(last.slice('RESULT '.length)) as Record<string, unknown>
    : null;
  let audit: Array<Record<string, unknown>> = [];
  try {
    audit = readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        delete row['ts'];
        return row;
      });
  } catch {
    // 没有审计文件 = 这次没有落库（合法形态）
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', envelope, audit, elapsedMs, stateDir };
}

/** 复制整套 fixtures（排除运行期临时目录），供「改声明看行为」的用例使用。 */
function copyFixtures(): { fixturesRoot: string; bin: string } {
  const root = freshDir('dummy-cap-fixtures-');
  cpSync(FIXTURES_ROOT, root, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(FIXTURES_ROOT, src).split(path.sep).join('/');
      return !rel.startsWith('dummy-platform/tmp') && !rel.startsWith('dummy-platform/.runtime');
    },
  });
  return { fixturesRoot: root, bin: path.join(root, 'dummy-platform', 'bin', 'dummy') };
}

function editJson<T>(file: string, mutate: (value: T) => void): void {
  const value = JSON.parse(readFileSync(file, 'utf8')) as T;
  mutate(value);
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function dataOf(envelope: Record<string, unknown> | null): Record<string, unknown> {
  return (envelope?.['data'] ?? {}) as Record<string, unknown>;
}

function errorOf(envelope: Record<string, unknown> | null): Record<string, unknown> {
  return (envelope?.['error'] ?? {}) as Record<string, unknown>;
}

describe('① --delay-ms：声明式、真实等待、有上限', () => {
  it('operation list --json 把 --delay-ms 声明为 dummy.query/prepare/commit 的显式 flag（ballot 不声明）', () => {
    const r = spawnSync(BIN, ['operation', 'list', '--json'], { encoding: 'utf8', env: BASE_ENV });
    expect(r.status).toBe(0);
    const listing = JSON.parse(r.stdout) as {
      operations: Array<{ name: string; args: { flags: Array<{ flag: string }> } }>;
    };
    const flagsOf = (name: string): string[] => {
      const operation = listing.operations.find((entry) => entry.name === name);
      expect(operation, name).toBeDefined();
      return (operation!.args.flags ?? []).map((flag) => flag.flag);
    };
    for (const name of ['dummy.query', 'dummy.prepare', 'dummy.commit']) {
      expect(flagsOf(name), name).toContain('--delay-ms');
    }
    // 未声明 = 结构化 call 仍按既有规则拒绝（下面 ⑤ 用例验证），这里先钉声明面。
    expect(flagsOf('ballot.query')).not.toContain('--delay-ms');
  });

  it('dummy.query --delay-ms 150 真的等（耗时下界 + 与无延迟调用差值）且结果不变', () => {
    const stateDir = freshDir('dummy-cap-delay-query-');
    const baseline = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { stateDir });
    const delayed = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--delay-ms', '150'], { stateDir });

    expect(delayed.status).toBe(0);
    expect(delayed.envelope).toMatchObject({
      status: 'completed',
      data: { collection: 'alpha', count: 2 },
    });
    // 下界：150ms 的等待不可能因为负载变成更短。
    expect(delayed.elapsedMs, `delayed=${delayed.elapsedMs}ms baseline=${baseline.elapsedMs}ms`).toBeGreaterThanOrEqual(120);
    // 差值：同一条调用、同一个进程启动路径，多出来的时间只能来自夹具的 sleep。
    expect(delayed.elapsedMs - baseline.elapsedMs, `delayed=${delayed.elapsedMs}ms baseline=${baseline.elapsedMs}ms`)
      .toBeGreaterThanOrEqual(100);
  });

  it('dummy.prepare / dummy.commit 同样真实等待，行为与无延迟时一致', () => {
    const stateDir = freshDir('dummy-cap-delay-write-');
    const prepare = runDummy(
      ['prepare', 'dummy.prepare', '--collection', 'alpha', '--window', 'W1', '--count', '1', '--delay-ms', '120'],
      { stateDir },
    );
    expect(prepare.status).toBe(0);
    expect(prepare.envelope).toMatchObject({ status: 'needs_confirmation' });
    expect(prepare.elapsedMs).toBeGreaterThanOrEqual(95);
    const handle = (prepare.envelope?.['confirmation'] as { handle?: string } | undefined)?.handle;
    expect(handle).toMatch(/^cf_/);

    const commit = runDummy(
      ['commit', 'dummy.commit', '--collection', 'alpha', '--window', 'W1', '--count', '1', '--confirmation', handle!,
        '--delay-ms', '120'],
      { stateDir },
    );
    expect(commit.status).toBe(0);
    expect(commit.envelope).toMatchObject({ status: 'completed', data: { verified: true, added: 1 } });
    expect(commit.elapsedMs).toBeGreaterThanOrEqual(95);
  });

  it('上限保护：--delay-ms 60001 确定性拒绝（exit 2 + DELAY_OUT_OF_RANGE），不等待也不执行', () => {
    const r = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--delay-ms', '60001']);
    expect(r.status).toBe(2);
    expect(r.envelope).toMatchObject({ status: 'failed', data: null, error: { code: 'DELAY_OUT_OF_RANGE' } });
    expect(r.elapsedMs).toBeLessThan(1_000); // 拒绝路径不 sleep
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ exitCode: 2 });
  });

  it('结构化 call 接受已声明的 --delay-ms；未声明该参数的操作仍按既有规则拒绝', () => {
    const stateDir = freshDir('dummy-cap-delay-call-');
    const okFile = path.join(stateDir, 'ok.json');
    writeFileSync(okFile, JSON.stringify({ operation: 'dummy.query', args: { '--collection': 'alpha', '--delay-ms': '120' } }));
    const ok = runDummy(['call', '--file', okFile], { stateDir });
    expect(ok.status).toBe(0);
    expect(ok.envelope).toMatchObject({ status: 'completed', data: { count: 2 } });
    expect(ok.elapsedMs).toBeGreaterThanOrEqual(95);

    const refusedFile = path.join(stateDir, 'refused.json');
    writeFileSync(refusedFile, JSON.stringify({ operation: 'ballot.query', args: { '--topic': 'alpha', '--delay-ms': '120' } }));
    const refused = runDummy(['call', '--file', refusedFile], { stateDir });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('undeclared args');
  });
});

describe('② slow_fault：先真实延迟，再按既有错误信封失败', () => {
  it('仓库场景声明 slow_fault + delayMs（声明面可读，不靠约定）', () => {
    const scenario = JSON.parse(readFileSync(SCENARIO, 'utf8')) as {
      faults: Array<Record<string, unknown>>;
    };
    const fault = scenario.faults.find((entry) => entry['collection'] === 'slow-fault-one');
    expect(fault).toMatchObject({ kind: 'slow_fault', delayMs: 2500, exitCode: 2 });
    expect((fault?.['error'] as Record<string, unknown> | undefined)?.['code']).toBe('COLLECTION_FAULT');
  });

  it('复制夹具改成 150ms：耗时下界 → exit 2 + 结构化失败 + 无载荷 + 审计只有失败结果', () => {
    const { fixturesRoot, bin } = copyFixtures();
    editJson<{ faults: Array<Record<string, unknown>> }>(
      path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'scenario.json'),
      (value) => {
        const fault = value.faults.find((entry) => entry['collection'] === 'slow-fault-one')!;
        fault['delayMs'] = 150;
      },
    );
    const r = runDummy(['query', 'dummy.query', '--collection', 'slow-fault-one'], { bin });
    expect(r.status).toBe(2);
    expect(r.elapsedMs, `elapsed=${r.elapsedMs}ms`).toBeGreaterThanOrEqual(120);
    expect(r.envelope).toMatchObject({
      status: 'failed',
      data: null,
      error: { code: 'COLLECTION_FAULT', message: 'Collection slow-fault-one cannot be read after a long run' },
    });
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ exitCode: 2 });
    expect(r.audit[0]?.['result']).toBeUndefined();
  });
});

describe('③ needs_input：确定性缺失输入 → 补齐后同一调用完成；不写数据', () => {
  it('仓库 receivables-open 缺 window：needs_input + missing ["window"]，状态文件逐字节不变', () => {
    const stateDir = freshDir('dummy-cap-needs-');
    // 先制造一次真实写（prepare + commit），让 state 文件存在，再证明 needs_input 不改它。
    const prepare = runDummy(['prepare', 'dummy.prepare', '--collection', 'alpha', '--window', 'W1', '--count', '1'], { stateDir });
    const handle = (prepare.envelope?.['confirmation'] as { handle?: string } | undefined)?.handle;
    expect(handle).toMatch(/^cf_/);
    const commit = runDummy(
      ['commit', 'dummy.commit', '--collection', 'alpha', '--window', 'W1', '--count', '1', '--confirmation', handle!],
      { stateDir },
    );
    expect(commit.status).toBe(0);

    const stateFile = path.join(stateDir, 'dummy-state.json');
    const confirmationsFile = path.join(stateDir, 'confirmations.json');
    const stateBefore = readFileSync(stateFile);
    const confirmationsBefore = readFileSync(confirmationsFile);

    const missing = runDummy(['query', 'dummy.query', '--collection', 'receivables-open'], { stateDir });
    expect(missing.status).toBe(0);
    expect(missing.envelope).toMatchObject({
      status: 'needs_input',
      missing: ['window'],
      data: { collection: 'receivables-open', missing: ['window'] },
      error: { code: 'MISSING_INPUT' },
    });
    // 不冒充完成：没有 items / count。
    expect(missing.envelope?.['data']).not.toHaveProperty('items');
    expect(missing.envelope?.['data']).not.toHaveProperty('count');
    // 不写任何数据：状态与写确认句柄逐字节不变。
    expect(readFileSync(stateFile).equals(stateBefore), 'dummy-state.json 变了').toBe(true);
    expect(readFileSync(confirmationsFile).equals(confirmationsBefore), 'confirmations.json 变了').toBe(true);
    // 审计如实记 needs_input（不是 completed），且没有 items 载荷。
    const queryRow = missing.audit[missing.audit.length - 1];
    expect(queryRow).toMatchObject({
      script: 'dummy.query',
      exitCode: 0,
      result: { status: 'needs_input', collection: 'receivables-open', missing: ['window'] },
    });
    expect(queryRow?.['result']).not.toHaveProperty('items');

    // 带上该参数重试 → 正常完成（不是新建的第三条路径）。
    const provided = runDummy(['query', 'dummy.query', '--collection', 'receivables-open', '--window', '2026-10'], { stateDir });
    expect(provided.status).toBe(0);
    expect(provided.envelope).toMatchObject({ status: 'completed', data: { collection: 'receivables-open', count: 3 } });
  });

  it('示例 requires:["customer"]（维度过滤形态）：缺 --where → missing ["customer"]；--where / --window 别名都能补齐', () => {
    const { fixturesRoot, bin } = copyFixtures();
    // 只改副本：beta 声明 customer 维度 + requires，数据集每条带 customer。
    editJson<{ collections: Array<Record<string, unknown>> }>(
      path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'scenario.json'),
      (value) => {
        const beta = value.collections.find((collection) => collection['collection'] === 'beta')!;
        beta['dimension'] = { name: 'customer', values: ['acme', 'globex'] };
        beta['requires'] = ['customer'];
      },
    );
    editJson<{ items: Array<Record<string, unknown>> }>(
      path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'datasets', 'beta.json'),
      (value) => {
        value.items[0]!['customer'] = 'acme';
        value.items[1]!['customer'] = 'globex';
        value.items[2]!['customer'] = 'acme';
      },
    );

    const missing = runDummy(['query', 'dummy.query', '--collection', 'beta'], { bin });
    expect(missing.status).toBe(0);
    expect(missing.envelope).toMatchObject({
      status: 'needs_input',
      missing: ['customer'],
      data: { collection: 'beta', missing: ['customer'] },
      error: { code: 'MISSING_INPUT' },
    });

    const viaWhere = runDummy(['query', 'dummy.query', '--collection', 'beta', '--where', 'customer=acme'], { bin });
    expect(viaWhere.envelope).toMatchObject({ status: 'completed', data: { count: 2 } });

    const viaAlias = runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'globex'], { bin });
    expect(viaAlias.envelope).toMatchObject({ status: 'completed', data: { count: 1 } });
  });

  it('与既有 ambiguous（候选歧义）是两条路：歧义返回候选、不带 missing 字段', () => {
    const ambiguous = runDummy(['query', 'dummy.query', '--collection', 'contoso']);
    expect(ambiguous.status).toBe(0);
    expect(ambiguous.envelope).toMatchObject({
      status: 'needs_input',
      data: { query: 'contoso', candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
      error: { code: 'COLLECTION_AMBIGUOUS' },
    });
    expect(ambiguous.envelope).not.toHaveProperty('missing');
  });

  it('声明面 fail-closed：requires 非数组 / 空名 / 重复名在加载期拒绝（不猜）', () => {
    const variants: unknown[] = ['window', ['', 'x'], ['window', 'window']];
    for (const requires of variants) {
      const { fixturesRoot, bin } = copyFixtures();
      const scenarioFile = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'scenario.json');
      editJson<{ collections: Array<Record<string, unknown>> }>(scenarioFile, (value) => {
        const target = value.collections.find((collection) => collection['collection'] === 'receivables-open')!;
        target['requires'] = requires;
      });
      const r = runDummy(['query', 'dummy.query', '--collection', 'receivables-open'], { bin });
      expect(r.status, JSON.stringify(requires)).not.toBe(0);
      expect(r.stderr, JSON.stringify(requires)).toMatch(/requires/);
    }
  });
});
