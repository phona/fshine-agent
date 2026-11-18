/**
 * S1 · 声明式 Dummy：三层分离、只读声明驱动、写路径确认回环、黄金字节兼容。
 *
 * 三层（fixtures 根 = scripts/eval/fixtures）：
 *   · dummy-platform/runtime/            通用加载器/校验/解析/模板/故障/错误（不懂业务）
 *   · platforms/dummy-platform/capabilities.json   能力定义（name/args/access/protocol/只读声明）
 *   · scenarios/dummy-finance/scenario.json + datasets/   数据/绑定/故障
 *
 * 证明方式：除「跑一遍断言现状」外，还**复制整套 fixtures 到临时目录后改声明/数据/故障**，
 * 断言行为随之改变——否则"声明驱动"只是把常量换个文件存放的自证。
 * `operation list --json` 与 `__golden__/operations-list.json` 做逐字节比较（不是 JSON 深等）。
 */
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const FIXTURES_ROOT = path.resolve(__dirname, 'eval', 'fixtures');
const FIXTURE_ROOT = path.join(FIXTURES_ROOT, 'dummy-platform');
const BIN = path.join(FIXTURE_ROOT, 'bin', 'dummy');
const GOLDEN = path.join(FIXTURE_ROOT, '__golden__', 'operations-list.json');
const RUNTIME_DIR = path.join(FIXTURE_ROOT, 'runtime');
const requireCjs = createRequire(__filename);

const TMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

const BASE_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] };
  return env;
})();

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  envelope: Record<string, unknown> | null;
  audit: Array<Record<string, unknown>>;
  stateDir: string;
}

/** 跑一次网关（默认新状态根；也可复用同一状态根做写读回）。 */
function runDummy(
  args: string[],
  options: { bin?: string; stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const bin = options.bin ?? BIN;
  const stateDir = options.stateDir ?? freshDir('s1-declarative-state-');
  const r = spawnSync(bin, ['--state-dir', stateDir, ...args], {
    encoding: 'utf8',
    env: { ...BASE_ENV, ...options.env },
  });
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
        delete row['ts']; // 时间戳是墙钟，不是行为
        return row;
      });
  } catch {
    // 无审计（未执行/无 state-dir 写入）是合法形态
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', envelope, audit, stateDir };
}

/** 复制整套 fixtures（排除运行期临时目录），供"改声明看行为"的用例使用。 */
function copyFixtures(): { fixturesRoot: string; bin: string } {
  const root = freshDir('s1-fixtures-copy-');
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

describe('① operation list --json 黄金字节（逐字节，不是 JSON 深等）', () => {
  it('与 __golden__/operations-list.json 完全一致', () => {
    const r = spawnSync(BIN, ['operation', 'list', '--json'], { encoding: 'buffer', env: BASE_ENV });
    expect(r.status).toBe(0);
    const golden = readFileSync(GOLDEN);
    const actual = r.stdout as Buffer;
    expect(Buffer.isBuffer(actual)).toBe(true);
    expect(actual.length, '字节数').toBe(golden.length);
    expect(actual.equals(golden), '字节内容').toBe(true);
  });
});

describe('② 只读路径声明驱动后，现有形态与数据不变', () => {
  it('completed：documents / W202611 的条目与字段逐项保留', () => {
    const r = runDummy(['query', 'dummy.query', '--collection', 'documents', '--window', 'W202611']);
    expect(r.status).toBe(0);
    expect(r.envelope).toMatchObject({
      v: 1,
      op: 'dummy.query',
      status: 'completed',
      data: {
        collection: 'documents',
        window: 'W202611',
        count: 3,
        items: [
          { id: 'doc-001', name: 'document-1', value: 1200 },
          { id: 'doc-002', name: 'document-2', value: 800 },
          { id: 'doc-003', name: 'document-2', value: 900 },
        ],
      },
      error: null,
    });
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({
      mode: 'query',
      script: 'dummy.query',
      exitCode: 0,
      result: { status: 'completed', collection: 'documents', count: 3, fields: ['id', 'name', 'value'] },
    });
  });

  it('substring 唯一命中落规范名；精确名优先于前缀（alpha vs alpha-group）', () => {
    const substring = runDummy(['query', 'dummy.query', '--collection', 'alpha-gro']);
    expect(substring.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha-group', count: 1 } });
    const exact = runDummy(['query', 'dummy.query', '--collection', 'alpha']);
    expect(exact.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', count: 2 } });
  });

  it('歧义 → needs_input + 候选（顺序稳定）；未命中 → not_found + 空候选', () => {
    const ambiguous = runDummy(['query', 'dummy.query', '--collection', 'contoso']);
    expect(ambiguous.status).toBe(0);
    expect(ambiguous.envelope).toMatchObject({
      status: 'needs_input',
      data: { query: 'contoso', candidates: [{ name: 'contoso-trade' }, { name: 'contoso-logistics' }] },
      error: { code: 'COLLECTION_AMBIGUOUS', message: 'More than one collection matches "contoso"' },
    });
    const missing = runDummy(['query', 'dummy.query', '--collection', 'nope']);
    expect(missing.status).toBe(0);
    expect(missing.envelope).toMatchObject({
      status: 'not_found',
      data: { query: 'nope', candidates: [] },
      error: { code: 'COLLECTION_NOT_FOUND' },
    });
  });

  it('缺必填参数 → QUERY_REQUIRED（声明里的统一报错，exit 1）', () => {
    for (const operation of ['dummy.query', 'ballot.query']) {
      const r = runDummy(['query', operation]);
      expect(r.status, operation).toBe(1);
      expect(r.envelope).toMatchObject({
        status: 'failed',
        data: null,
        error: { code: 'QUERY_REQUIRED', message: 'Missing --collection or --topic', correctForm: 'Provide --collection <name>.' },
      });
      expect(r.audit[0]).toMatchObject({ exitCode: 1 });
      expect(r.audit[0]?.['result']).toBeUndefined();
    }
  });

  it('窗口不存在 → WINDOW_NO_DATA + availableWindows；window/round 同义', () => {
    const bad = runDummy(['query', 'dummy.query', '--collection', 'bankflow-oct', '--window', '2025-09']);
    expect(bad.status).toBe(0);
    expect(bad.envelope).toMatchObject({
      status: 'not_found',
      data: { query: 'bankflow-oct', window: '2025-09', availableWindows: ['2025-10'] },
      error: { code: 'WINDOW_NO_DATA' },
    });
    const round = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--round', 'W2']);
    expect(round.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', window: 'W2' } });
  });

  it('读故障来自 scenario.faults：faulty-one → failed/COLLECTION_FAULT exit 2；denied-one → exit 3 无信封', () => {
    const faulty = runDummy(['query', 'dummy.query', '--collection', 'faulty-one']);
    expect(faulty.status).toBe(2);
    expect(faulty.envelope).toMatchObject({
      status: 'failed',
      data: null,
      error: { code: 'COLLECTION_FAULT', message: 'Collection faulty-one cannot be read in its current state' },
    });
    expect(faulty.audit[0]).toMatchObject({ exitCode: 2 });
    expect(faulty.audit[0]?.['result']).toBeUndefined();

    const denied = runDummy(['query', 'dummy.query', '--collection', 'denied-one']);
    expect(denied.status).toBe(3);
    expect(denied.envelope).toBeNull();
    expect(denied.stderr).toContain('GATE_REFUSE collection denied-one is restricted for the current caller');
    expect(denied.audit[0]).toMatchObject({ exitCode: 3, refused: 'collection-restricted' });
  });

  it('默认种子逐集合保持（locked/empty/negative-value/ballot topic）', () => {
    const locked = runDummy(['query', 'dummy.query', '--collection', 'locked-one']);
    expect(locked.envelope).toMatchObject({ status: 'completed', data: { count: 1 } });
    const empty = runDummy(['query', 'dummy.query', '--collection', 'empty-one']);
    expect(empty.envelope).toMatchObject({ status: 'completed', data: { items: [], count: 0 } });
    const negative = runDummy(['query', 'dummy.query', '--collection', 'bankflow-oct', '--window', '2025-10']);
    expect((negative.envelope as { data: { items: Array<{ value: number }> } }).data.items.map((item) => item.value))
      .toEqual([5200, -3600, 12800, 12800]);
    const ballot = runDummy(['query', 'ballot.query', '--topic', 'alpha', '--round', 'W1']);
    expect(ballot.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', window: 'W1', count: 2 } });
  });
});

describe('③ 声明驱动可验证：改声明/数据/故障，行为随之改变', () => {
  it('数据来自 datasets：改一份数据集，查询结果跟着变', () => {
    const { fixturesRoot, bin } = copyFixtures();
    const dataset = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'datasets', 'alpha.json');
    editJson<{ items: Array<{ id: string; name: string; value: number }>; windows: string[] }>(dataset, (value) => {
      value.items[0]!.value = 4242;
    });
    const r = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], { bin });
    expect((r.envelope as { data: { items: Array<{ value: number }> } }).data.items[0]!.value).toBe(4242);
  });

  it('故障来自 scenario.faults：给 beta 新登记读故障，查询即按声明拒绝', () => {
    const { fixturesRoot, bin } = copyFixtures();
    const scenario = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'scenario.json');
    editJson<{ faults: Array<Record<string, unknown>> }>(scenario, (value) => {
      value.faults.push({
        collection: 'beta',
        kind: 'read_fault',
        exitCode: 2,
        error: { code: 'COLLECTION_FAULT', message: 'Collection {{source.collection}} cannot be read in its current state' },
      });
    });
    const r = runDummy(['query', 'dummy.query', '--collection', 'beta'], { bin });
    expect(r.status).toBe(2);
    expect(r.envelope).toMatchObject({ status: 'failed', error: { code: 'COLLECTION_FAULT' } });
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).not.toHaveProperty('result');
  });

  it('required 来自 capabilities.json：给只读声明加一条要求，缺参即被统一拦下', () => {
    const { fixturesRoot, bin } = copyFixtures();
    const capabilities = path.join(fixturesRoot, 'platforms', 'dummy-platform', 'capabilities.json');
    editJson<{ reads: Record<string, { requirements: Array<Record<string, unknown>> }> }>(capabilities, (value) => {
      value.reads['dummy.query']!.requirements.push({
        allOf: ['--window'],
        error: { code: 'QUERY_REQUIRED', message: 'Missing --window' },
      });
    });
    const missing = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { bin });
    expect(missing.status).toBe(1);
    expect(missing.envelope).toMatchObject({ status: 'failed', error: { code: 'QUERY_REQUIRED', message: 'Missing --window' } });
    const provided = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], { bin });
    expect(provided.envelope).toMatchObject({ status: 'completed' });
  });

  it('模板闭合白名单：未声明的占位符在加载期就被拒（不执行、不猜测）', () => {
    const { renderTemplate } = requireCjs(path.join(RUNTIME_DIR, 'template.cjs')) as {
      renderTemplate: (template: string, values: Record<string, unknown>) => unknown;
    };
    expect(() => renderTemplate('{{nope}}', {})).toThrow(/nope/);
    expect(renderTemplate('{{source.keyword}}', { 'source.keyword': 'alpha' })).toBe('alpha');

    const { fixturesRoot, bin } = copyFixtures();
    const capabilities = path.join(fixturesRoot, 'platforms', 'dummy-platform', 'capabilities.json');
    editJson<{ reads: Record<string, { responses: Record<string, { data: Record<string, unknown> }> }> }>(capabilities, (value) => {
      value.reads['dummy.query']!.responses['completed']!.data['collection'] = '{{not.declared}}';
    });
    const r = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { bin });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not\.declared/);
  });
});

describe('④ 写路径：prepare 冻结提案 → commit 凭句柄提交并读回', () => {
  it('prepare 返回 needs_confirmation 且不写；commit 凭句柄提交后 query 读回新记录', () => {
    const stateDir = freshDir('s1-write-state-');
    const prepare = runDummy(['prepare', 'dummy.prepare', '--collection', 'alpha', '--window', 'W1', '--count', '2'], { stateDir });
    expect(prepare.status).toBe(0);
    expect(prepare.envelope).toMatchObject({
      status: 'needs_confirmation',
      confirmation: {
        handle: expect.stringMatching(/^cf_/),
        summary: expect.stringContaining('alpha'),
      },
      data: { collection: 'alpha', window: 'W1', count: 2, status: 'pending' },
    });
    const handle = (prepare.envelope?.['confirmation'] as { handle: string }).handle;

    // 预演不是写：用户确认之前数据原样。
    const before = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { stateDir });
    expect(before.envelope).toMatchObject({ status: 'completed', data: { count: 2 } });

    // 没有句柄的 commit 是确定性拒绝（执行层自己的门）。
    const noHandle = runDummy(['commit', 'dummy.commit', '--collection', 'alpha', '--count', '2'], { stateDir });
    expect(noHandle.status).toBe(3);
    expect(noHandle.stderr).toContain('CONFIRMATION_REQUIRED');

    const commit = runDummy(['commit', 'dummy.commit', '--collection', 'alpha', '--window', 'W1', '--count', '2', '--confirmation', handle], { stateDir });
    expect(commit.status).toBe(0);
    expect(commit.envelope).toMatchObject({
      status: 'completed',
      data: { collection: 'alpha', window: 'W1', added: 2, total: 4, verified: true },
    });

    const after = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { stateDir });
    expect(after.envelope).toMatchObject({ status: 'completed', data: { count: 4 } });
  });

  it('argv 路径仍可用：--records 的 JSON 字符串还原成数组，摘要含逐条内容', () => {
    const stateDir = freshDir('s1-write-records-argv-');
    const prepare = runDummy([
      'prepare', 'dummy.prepare', '--collection', 'alpha', '--window', 'W1',
      '--records', JSON.stringify([{ name: 'argv-1', value: 11 }, { name: 'argv-2', value: 22 }]),
    ], { stateDir });
    expect(prepare.status).toBe(0);
    expect(prepare.envelope).toMatchObject({ status: 'needs_confirmation' });
    const confirmation = prepare.envelope?.['confirmation'] as { summary?: string };
    expect(confirmation.summary).toContain('argv-1=11');
    expect(confirmation.summary).toContain('argv-2=22');
  });

  it('proposal create → commit 全链读回，且后续 query 看得到提交的条目', () => {
    const stateDir = freshDir('s1-proposal-state-');
    const payload = path.join(stateDir, 'payload.json');
    writeFileSync(payload, JSON.stringify({
      collection: 'alpha',
      window: 'W1',
      records: [{ name: 'extra-1', value: 11 }, { name: 'extra-2', value: 22 }],
    }));
    const created = runDummy(['prepare', 'dummy.proposal', payload], { stateDir });
    expect(created.status).toBe(0);
    const data = created.envelope?.['data'] as { proposalId: string; expiresAt: string };
    expect(data.proposalId).toMatch(/^prop_/);

    const secret = 's1-secret';
    const body = Buffer.from(JSON.stringify({ proposalId: data.proposalId, expiresAt: data.expiresAt })).toString('base64url');
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    const committed = runDummy(['commit', 'dummy.proposal-commit', '--proposal-id', data.proposalId], {
      stateDir,
      env: { EXECUTION_GATE_SECRET: secret, EXECUTION_COMMIT_TOKEN: `${body}.${signature}` },
    });
    expect(committed.status).toBe(0);
    expect(committed.envelope).toMatchObject({
      status: 'completed',
      data: { ok: true, verified: true, count: 2, readBack: { before: 2, after: 4, delta: 2, required: 2 } },
    });

    const after = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'W1'], { stateDir });
    const items = (after.envelope as { data: { items: Array<{ name: string }> } }).data.items;
    expect(items.map((item) => item.name)).toContain('extra-1');
    expect(after.envelope).toMatchObject({ status: 'completed', data: { count: 4 } });
  });
});

describe('⑤ 分层纪律：runtime 通用、业务判定不进 runtime', () => {
  it('runtime 模块不含业务词（只做加载/校验/解析/模板/故障/错误）', () => {
    const forbidden = ['逾期', '核对完成', '风险', '财务', '金额', '账', '单据'];
    const files = readdirSync(RUNTIME_DIR).filter((name) => name.endsWith('.cjs'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(path.join(RUNTIME_DIR, name), 'utf8');
      for (const word of forbidden) expect(source, `${name} 含业务词 ${word}`).not.toContain(word);
    }
  });

  it('三层文件存在且配置是纯 JSON（无脚本）', () => {
    expect(() => readFileSync(path.join(FIXTURES_ROOT, 'platforms', 'dummy-platform', 'capabilities.json'))).not.toThrow();
    expect(() => readFileSync(path.join(FIXTURES_ROOT, 'scenarios', 'dummy-finance', 'scenario.json'))).not.toThrow();
    const datasets = readdirSync(path.join(FIXTURES_ROOT, 'scenarios', 'dummy-finance', 'datasets'));
    expect(datasets.length).toBeGreaterThan(0);
    for (const name of datasets) expect(name.endsWith('.json'), name).toBe(true);
  });
});

/**
 * S2 · 集合维度（dimension）。
 *
 * 维度是集合绑定上的一句纯声明 `{ name, values }`，items 自带该字段；查询用
 * `--where <name>=<value>` 真过滤，`--window` 作为同一维度的兼容别名。仓库内现有
 * 集合不声明维度，所以全部旧行为（含 operation list 黄金字节）保持零 diff——本组用
 * 「复制整套 fixtures 再声明维度」验证新能力，不碰仓库里的旧夹具。
 */
describe('⑥ S2 集合维度：--where 真过滤 / --window 别名 / 无维度不变 / 非法值可诊断', () => {
  /** 只改副本：给 alpha 声明 customer 维度，并让它的两条 item 各带一个值。 */
  function dimensionedFixtures(): { fixturesRoot: string; bin: string } {
    const { fixturesRoot, bin } = copyFixtures();
    const scenario = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'scenario.json');
    editJson<{ collections: Array<Record<string, unknown>> }>(scenario, (value) => {
      const alpha = value.collections.find((collection) => collection['collection'] === 'alpha')!;
      alpha['dimension'] = { name: 'customer', values: ['acme', 'globex'] };
    });
    const dataset = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'datasets', 'alpha.json');
    editJson<{ items: Array<Record<string, unknown>> }>(dataset, (value) => {
      value.items[0]!['customer'] = 'acme';
      value.items[1]!['customer'] = 'globex';
    });
    return { fixturesRoot, bin };
  }

  it('--where 真过滤 items（不是只校验枚举）', () => {
    const { bin } = dimensionedFixtures();
    const acme = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'customer=acme'], { bin });
    expect(acme.status).toBe(0);
    expect(acme.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', count: 1 } });
    expect((acme.envelope as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id))
      .toEqual(['rec-001']);

    const globex = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'customer=globex'], { bin });
    expect(globex.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', count: 1 } });
    expect((globex.envelope as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id))
      .toEqual(['rec-002']);

    // 不带过滤 -> 返回全部（维度声明不改变默认行为）
    const all = runDummy(['query', 'dummy.query', '--collection', 'alpha'], { bin });
    expect(all.envelope).toMatchObject({ status: 'completed', data: { count: 2 } });
  });

  it('--window 保留为声明维度的兼容别名（--round 同位）', () => {
    const { bin } = dimensionedFixtures();
    const alias = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--window', 'acme'], { bin });
    expect(alias.envelope).toMatchObject({ status: 'completed', data: { collection: 'alpha', window: 'acme', count: 1 } });
    expect((alias.envelope as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id))
      .toEqual(['rec-001']);

    const round = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--round', 'globex'], { bin });
    expect(round.envelope).toMatchObject({ status: 'completed', data: { count: 1 } });
    expect((round.envelope as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id))
      .toEqual(['rec-002']);
  });

  it('未声明 dimension 的集合行为不变：无过滤返回全部，--window 仍是窗口成员校验', () => {
    const { bin } = dimensionedFixtures();
    const all = runDummy(['query', 'dummy.query', '--collection', 'beta'], { bin });
    expect(all.envelope).toMatchObject({ status: 'completed', data: { collection: 'beta', count: 3 } });

    const knownWindow = runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'W1'], { bin });
    expect(knownWindow.envelope).toMatchObject({ status: 'completed', data: { collection: 'beta', window: 'W1', count: 3 } });

    const unknownWindow = runDummy(['query', 'dummy.query', '--collection', 'beta', '--window', 'W2'], { bin });
    expect(unknownWindow.envelope).toMatchObject({
      status: 'not_found',
      data: { availableWindows: ['W1'] },
      error: { code: 'WINDOW_NO_DATA' },
    });
  });

  it('非法维度值 / 维度名 / 缺维度集合 / 多条件 都是可诊断的 WHERE_INVALID（exit 1）', () => {
    const { bin } = dimensionedFixtures();
    const badValue = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'customer=initech'], { bin });
    expect(badValue.status).toBe(1);
    expect(badValue.envelope).toMatchObject({ status: 'failed', data: null, error: { code: 'WHERE_INVALID' } });
    const badValueMessage = (badValue.envelope?.['error'] as { message: string }).message;
    expect(badValueMessage).toContain('initech');
    expect(badValueMessage).toContain('acme');
    expect(badValue.audit[0]).toMatchObject({ exitCode: 1 });

    const badName = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'region=acme'], { bin });
    expect(badName.status).toBe(1);
    expect((badName.envelope?.['error'] as { message: string }).message).toContain('region');

    const noDimension = runDummy(['query', 'dummy.query', '--collection', 'beta', '--where', 'customer=acme'], { bin });
    expect(noDimension.status).toBe(1);
    expect(noDimension.envelope).toMatchObject({ status: 'failed', error: { code: 'WHERE_INVALID' } });
    expect((noDimension.envelope?.['error'] as { message: string }).message).toContain('no dimension');

    const twoConditions = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'customer=acme&customer=globex'], { bin });
    expect(twoConditions.status).toBe(1);
    expect(twoConditions.envelope).toMatchObject({ status: 'failed', error: { code: 'WHERE_INVALID' } });

    const bothFlags = runDummy(['query', 'dummy.query', '--collection', 'alpha', '--where', 'customer=acme', '--window', 'globex'], { bin });
    expect(bothFlags.status).toBe(1);
    expect(bothFlags.envelope).toMatchObject({ status: 'failed', error: { code: 'WHERE_INVALID' } });
  });

  it('维度声明在加载期 fail-closed：item 缺字段或值未声明即拒绝整个 scenario', () => {
    const { fixturesRoot } = dimensionedFixtures();
    const { loadScenario, ConfigError } = requireCjs(path.join(RUNTIME_DIR, 'loader.cjs')) as {
      loadScenario: (options: { fixturesRoot: string; scenarioId: string }) => unknown;
      ConfigError: new (message: string) => Error;
    };
    expect(() => loadScenario({ fixturesRoot, scenarioId: 'dummy-finance' })).not.toThrow();

    const dataset = path.join(fixturesRoot, 'scenarios', 'dummy-finance', 'datasets', 'alpha.json');
    editJson<{ items: Array<Record<string, unknown>> }>(dataset, (value) => {
      delete value.items[1]!['customer'];
    });
    expect(() => loadScenario({ fixturesRoot, scenarioId: 'dummy-finance' })).toThrow(ConfigError);

    editJson<{ items: Array<Record<string, unknown>> }>(dataset, (value) => {
      value.items[1]!['customer'] = 'not-declared';
    });
    expect(() => loadScenario({ fixturesRoot, scenarioId: 'dummy-finance' })).toThrow(/not-declared/);
  });

  it('旧夹具不声明 dimension；仅 S3 财务应收集合声明 customer 维度', () => {
    const scenario = JSON.parse(readFileSync(path.join(FIXTURES_ROOT, 'scenarios', 'dummy-finance', 'scenario.json'), 'utf8')) as {
      collections: Array<Record<string, unknown>>;
    };
    const finance = scenario.collections.filter((collection) => String(collection['collection']).startsWith('finance-'));
    expect(finance.map((collection) => collection['collection'])).toEqual([
      'finance-invoices', 'finance-receipts', 'finance-writeoffs', 'finance-mingda-receipts',
    ]);
    // S2 既有集合（零 diff 前提）：不得因为 S3 接线被顺手加上维度。
    for (const collection of scenario.collections) {
      if (finance.includes(collection)) continue;
      expect(collection, String(collection['collection'])).not.toHaveProperty('dimension');
    }
    // S3 财务集合：只有应收声明 customer（场景 3 的 --where 过滤入口）。
    const invoices = finance.find((collection) => collection['collection'] === 'finance-invoices');
    expect(invoices?.['dimension']).toEqual({ name: 'customer', values: ['华远贸易', '明达物流', '新程科技'] });
    for (const collection of finance) {
      if (collection === invoices) continue;
      expect(collection, String(collection['collection'])).not.toHaveProperty('dimension');
    }
  });
});
