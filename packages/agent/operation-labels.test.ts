import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest } from '@fshine/contracts';
import { isWriteAccess, loadOperationArgSpecs, loadOperationArgStyles, loadOperationLabels, loadOperationSemantics, operationLabel, parseAccessSemantics, parseCapabilityManifest, parseOperationArgSpecs, parseOperationArgStyles, parseOperationLabels, parseOperationSemantics, serveModesOf } from './src/operation-labels';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** 造一个假平台根：bin/example-gateway 把预置 TSV 吐到 stdout（可指定退出码或挂住）。 */
async function fakePlatformRoot(tsv: string, options: { exitCode?: number; hang?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'op-labels-'));
  roots.push(root);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'bin', 'list.tsv'), tsv);
  const script = options.hang
    ? '#!/bin/sh\nexec sleep 30\n'
    : `#!/bin/sh\ncat "$(dirname "$0")/list.tsv"\nexit ${options.exitCode ?? 0}\n`;
  await writeFile(path.join(root, 'bin', 'example-gateway'), script);
  await chmod(path.join(root, 'bin', 'example-gateway'), 0o755);
  return root;
}

const LIST_TSV = [
  'finance.search-account-sets\tsearch-account-sets\tread\tcompat-script\t检索单位名称',
  'voucher.query-saved\tquery-saved\tread\tcompat-script\t查询已存档记录',
  'voucher.fill\tfill\twrite-flag\tcompat-script\t', // 第 5 列为空 → 不收
  'voucher.smoke\tsmoke\tread\tcompat-script', // 旧版平台：没有第 5 列 → 不收
].join('\n');

describe('parseOperationLabels（TSV 第 1/2/5 列）', () => {
  it('只收 label 非空的条目，script 与 name 两种写法都入表', () => {
    const labels = parseOperationLabels(LIST_TSV);
    expect([...labels.entries()]).toEqual([
      ['search-account-sets', '检索单位名称'],
      ['finance.search-account-sets', '检索单位名称'],
      ['query-saved', '查询已存档记录'],
      ['voucher.query-saved', '查询已存档记录'],
    ]);
  });

  it('控制字符/超长 label 被清洗（进度帧必须是一行短句）', () => {
    const labels = parseOperationLabels(`a\tb\tread\tcompat-script\t 读取\u0000记录\r${'x'.repeat(60)}`);
    const label = labels.get('b');
    expect(label).toBe(`读取 记录 ${'x'.repeat(60)}`.slice(0, 40));
    expect(label).not.toMatch(/[\r\n\u0000]/);
  });

  it('空输出/无表头/列数不足都得到空表', () => {
    expect(parseOperationLabels('').size).toBe(0);
    expect(parseOperationLabels('name\tscript\n').size).toBe(0);
  });
});

describe('loadOperationLabels（经公共 CLI 派生一次）', () => {
  it('platformRoot 缺省 → 空表（静默降级，不 spawn）', async () => {
    expect((await loadOperationLabels()).size).toBe(0);
    expect((await loadOperationLabels('')).size).toBe(0);
  });

  it('CLI 正常 → 解析出 label 表', async () => {
    const root = await fakePlatformRoot(LIST_TSV);
    expect(await loadOperationLabels(root, 'bin/example-gateway')).toEqual(parseOperationLabels(LIST_TSV));
  });

  it('CLI 非零退出 → 空表', async () => {
    const root = await fakePlatformRoot(LIST_TSV, { exitCode: 3 });
    expect((await loadOperationLabels(root)).size).toBe(0);
  });

  it('CLI 不存在 → 空表（spawn error 被吞掉）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'op-labels-empty-'));
    roots.push(root);
    expect((await loadOperationLabels(root)).size).toBe(0);
  });

  it('CLI 挂住 → 3s 超时后空表，绝不拖住 worker', async () => {
    const root = await fakePlatformRoot('', { hang: true });
    expect((await loadOperationLabels(root)).size).toBe(0);
  }, 15_000);
});

describe('operationLabel（引用归一后查表）', () => {
  const labels = parseOperationLabels(LIST_TSV);

  it('操作名 / 裸名 / 脚本路径三种合法写法都命中同一条 label', () => {
    for (const reference of ['voucher.query-saved', 'query-saved', 'src/voucher/scripts/query-saved.js', 'query-saved.js']) {
      expect(operationLabel(labels, reference)).toBe('查询已存档记录');
    }
  });

  it('查不到 → undefined（调用方据此静默不发帧，不回退脚本名）', () => {
    expect(operationLabel(labels, 'voucher.smoke')).toBeUndefined();
    expect(operationLabel(labels, 'unknown-thing')).toBeUndefined();
    expect(operationLabel(labels, null)).toBeUndefined();
    expect(operationLabel(new Map(), 'query-saved')).toBeUndefined();
    expect(operationLabel(undefined, 'query-saved')).toBeUndefined();
  });
});

// ── args 规格（L2：flag → 样式由平台机器可读地拥有，宿主消费不镜像）──────────────
//
// 平台把 args 规格只放 `operation list --json`（TSV 维持 5 列纪律），宿主据此渲染
// 参数摘要——KEY_ARG_FLAGS 硬编码名单已删（D-012），这里钉住"规格是唯一口径"。

/** 与平台 `operation list --json` 同形的预置输出（节选三个 operation 的 args）。 */
const LIST_JSON = JSON.stringify([
  {
    name: 'finance.search-account-sets', command: 'search-account-sets',
    args: { positional: [], flags: [{ flag: '--query', required: true, style: 'name', desc: '账套名关键词' }] },
  },
  {
    name: 'finance.query-receivables', command: 'query-receivables',
    args: {
      positional: [],
      flags: [
        { flag: '--query', required: true, style: 'name', desc: '账套业务名关键词' },
        { flag: '--customer', required: false, style: 'name', desc: '客户名关键词' },
        { flag: '--subject-code', required: false, style: 'code', desc: '科目编码' },
        { flag: '--period', required: false, style: 'code', desc: '期间 YYYYMM' },
      ],
    },
  },
  {
    name: 'voucher.query-saved', command: 'query-saved',
    args: { positional: [{ name: 'accountSet', required: true, style: 'name' }, { name: 'period', required: true, style: 'code' }], flags: [] },
  },
  {
    name: 'voucher.fill', command: 'fill',
    args: { positional: [], flags: [{ flag: '--batch', required: false, style: 'none' }, { flag: '--save', required: false, style: 'none' }] },
  },
]);

/** 假平台根（JSON 面）：`--json` 时吐预置 JSON，否则吐预置 TSV（与真 CLI 同形）。 */
async function fakePlatformRootWithJson(json: string, options: { exitCode?: number; hang?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'op-args-'));
  roots.push(root);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'bin', 'list.json'), json);
  const script = options.hang
    ? '#!/bin/sh\nexec sleep 30\n'
    : `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--json" ]; then cat "$(dirname "$0")/list.json"; exit ${options.exitCode ?? 0}; fi\ndone\ncat "$(dirname "$0")/list.tsv" 2>/dev/null\nexit ${options.exitCode ?? 0}\n`;
  await writeFile(path.join(root, 'bin', 'example-gateway'), script);
  await chmod(path.join(root, 'bin', 'example-gateway'), 0o755);
  return root;
}

describe('parseOperationArgStyles（--json 的 args 规格 → flag→样式）', () => {
  it('只收有取值的 flag（name/code），布尔开关（none）与位置参数不入表', () => {
    const styles = parseOperationArgStyles(LIST_JSON);
    expect([...styles.entries()]).toEqual([
      ['--query', 'name'],
      ['--customer', 'name'],
      ['--subject-code', 'code'],
      ['--period', 'code'],
    ]);
  });

  it('空输出 / 非 JSON / 非数组 / 缺 args 列都得到空表（安全缺省）', () => {
    expect(parseOperationArgStyles('').size).toBe(0);
    expect(parseOperationArgStyles('not json').size).toBe(0);
    expect(parseOperationArgStyles('{"operations":[]}').size).toBe(0);
    expect(parseOperationArgStyles('[{"name":"x","args":null}]').size).toBe(0);
    expect(parseOperationArgStyles('[{"name":"x","args":{"flags":"bad"}}]').size).toBe(0);
  });
});

describe('loadOperationArgStyles（经公共 CLI 派生一次）', () => {
  it('platformRoot 缺省 → 空表（静默降级，不 spawn）', async () => {
    expect((await loadOperationArgStyles()).size).toBe(0);
    expect((await loadOperationArgStyles('')).size).toBe(0);
  });

  it('CLI 正常 → 解析出样式表', async () => {
    const root = await fakePlatformRootWithJson(LIST_JSON);
    expect(await loadOperationArgStyles(root, 'bin/example-gateway')).toEqual(parseOperationArgStyles(LIST_JSON));
  });

  it('CLI 非零退出 / 不存在 / 挂住 → 空表（与 label 派生同一套失败语义）', async () => {
    expect((await loadOperationArgStyles(await fakePlatformRootWithJson(LIST_JSON, { exitCode: 3 }))).size).toBe(0);
    const empty = await mkdtemp(path.join(os.tmpdir(), 'op-args-empty-'));
    roots.push(empty);
    expect((await loadOperationArgStyles(empty)).size).toBe(0);
    expect((await loadOperationArgStyles(await fakePlatformRootWithJson('', { hang: true }))).size).toBe(0);
  }, 15_000);
});

describe('parseOperationArgSpecs（整份规格：位置参数声明名 + flag 样式）', () => {
  it('按 operation 收录 positionalNames 与 flagStyles，注册名与 command 裸名同表', () => {
    const specs = parseOperationArgSpecs(LIST_JSON);
    expect([...specs.keys()].sort()).toEqual([
      'fill', 'finance.query-receivables', 'finance.search-account-sets', 'query-receivables',
      'query-saved', 'search-account-sets', 'voucher.fill', 'voucher.query-saved',
    ]);
    expect(specs.get('voucher.query-saved')).toEqual({
      positionalNames: ['accountSet', 'period'],
      flagStyles: new Map(),
    });
    expect(specs.get('query-receivables')?.flagStyles).toEqual(new Map([
      ['--query', 'name'], ['--customer', 'name'], ['--subject-code', 'code'], ['--period', 'code'],
    ]));
    // 位置参数声明名是机械取值的依据（host 不猜第几个参数是什么）
    expect(specs.get('voucher.query-saved')?.positionalNames).toEqual(['accountSet', 'period']);
  });

  it('顶层新增未知键（如 accessSemantics 信封）不破坏既有解析', () => {
    // 平台把 `operation list --json` 从裸数组演进成对象信封时，只认数组的解析器会整份
    // 返回空表——那正是必须宽容的形状。信封与裸数组必须解析出同一份规格。
    const enveloped = JSON.stringify({ operations: JSON.parse(LIST_JSON), accessSemantics: { read: { plan: true, confirm: false, mock: true } } });
    expect(parseOperationArgSpecs(enveloped)).toEqual(parseOperationArgSpecs(LIST_JSON));
    expect(parseOperationArgStyles(enveloped)).toEqual(parseOperationArgStyles(LIST_JSON));
  });

  it('布尔开关（style none）不入 flagStyles；无 args 列的 operation 不入表', () => {
    const specs = parseOperationArgSpecs(LIST_JSON);
    expect(specs.has('voucher.fill')).toBe(true);
    expect(specs.get('voucher.fill')?.flagStyles.size).toBe(0);
    expect(specs.get('voucher.fill')?.positionalNames).toEqual([]);
  });

  it('空输出/非 JSON/非数组/缺 args 列都得到空表（与样式表同一套安全缺省）', () => {
    expect(parseOperationArgSpecs('').size).toBe(0);
    expect(parseOperationArgSpecs('not json').size).toBe(0);
    expect(parseOperationArgSpecs('{"operations":[]}').size).toBe(0);
    expect(parseOperationArgSpecs('[{"name":"x"}]').size).toBe(0);
  });
});

describe('loadOperationArgSpecs（经公共 CLI 派生整份规格）', () => {
  it('CLI 正常 → 解析出规格表；非零退出 → 空表', async () => {
    const root = await fakePlatformRootWithJson(LIST_JSON);
    expect(await loadOperationArgSpecs(root, 'bin/example-gateway')).toEqual(parseOperationArgSpecs(LIST_JSON));
    expect((await loadOperationArgSpecs(await fakePlatformRootWithJson(LIST_JSON, { exitCode: 3 }))).size).toBe(0);
  });

  it('platformRoot 缺省 → 空表（不 spawn，宁缺勿猜）', async () => {
    expect((await loadOperationArgSpecs()).size).toBe(0);
  });
});

// ── access 语义（平台 accessSemantics 表：写类判据的平台数据面，宿主消费不镜像）──────
//
// 语义只活在平台的顶层 `accessSemantics` 表里：宿主查 confirm 列判"要不要用户确认"
// （= 是不是写），不再前缀匹配 access 字符串，也不列举平台的 access 词表（L2）。

/** 与平台 `operation list --json` 同形的预置输出（新信封形状：operations + accessSemantics）。 */
const SEMANTICS_LIST_JSON = JSON.stringify({
  operations: [
    { name: 'finance.query-receivables', command: 'query-receivables', access: 'read' },
    { name: 'voucher.query-saved', command: 'query-saved', access: 'read' },
    { name: 'voucher.precheck', command: 'precheck', access: 'scratch' },
    { name: 'payroll.transform', command: 'transform', access: 'scratch' },
    { name: 'voucher.prepare', command: 'prepare', access: 'write' },
    { name: 'voucher.commit', command: 'commit', access: 'write' },
    { name: 'voucher.unregistered', command: 'unregistered', access: 'read' },
  ],
  accessSemantics: {
    read: { plan: true, confirm: false, mock: true },
    scratch: { plan: false, confirm: false, mock: false },
    write: { plan: true, confirm: true, mock: true },
  },
});

/** 平台声明之外的自造 access 取值：语义表里查不到 → 该 operation 不进表（宁缺勿猜）。 */
const SEMANTICS_WITH_UNKNOWN_ACCESS = JSON.stringify({
  operations: [{ name: 'voucher.batch', command: 'batch', access: 'write-batch' }],
  accessSemantics: { read: { plan: true, confirm: false, mock: true } },
});

describe('parseAccessSemantics（顶层 accessSemantics 表）', () => {
  it('按 access 取值收两列语义（plan/confirm 都是平台数据）', () => {
    expect([...parseAccessSemantics(SEMANTICS_LIST_JSON).entries()]).toEqual([
      ['read', { plan: true, confirm: false }],
      ['scratch', { plan: false, confirm: false }],
      ['write', { plan: true, confirm: true }],
    ]);
  });

  it('缺列/非布尔一律按 false（判据不成立时绝不放大权限）', () => {
    const table = parseAccessSemantics(JSON.stringify({
      accessSemantics: {
        read: { plan: true, confirm: false, mock: true },
        partial: { confirm: true },
        broken: { plan: 'yes', confirm: 1, mock: null },
        notObject: 'read',
      },
    }));
    expect([...table.entries()]).toEqual([
      ['read', { plan: true, confirm: false }],
      ['partial', { plan: false, confirm: true }],
      ['broken', { plan: false, confirm: false }],
    ]);
  });

  it('空输出/非 JSON/旧版裸数组/缺 accessSemantics 键都得到空表（安全缺省）', () => {
    expect(parseAccessSemantics('').size).toBe(0);
    expect(parseAccessSemantics('not json').size).toBe(0);
    expect(parseAccessSemantics('[{"name":"x","access":"write"}]').size).toBe(0);
    expect(parseAccessSemantics('{"operations":[]}').size).toBe(0);
    expect(parseAccessSemantics('{"accessSemantics":[]}').size).toBe(0);
    expect(parseAccessSemantics('{"accessSemantics":null}').size).toBe(0);
  });
});

describe('parseOperationSemantics（--json 的 access 列 × 顶层语义表）', () => {
  it('按 operation 收录语义对象，注册名与 command 裸名同表', () => {
    const semantics = parseOperationSemantics(SEMANTICS_LIST_JSON);
    expect([...semantics.entries()]).toEqual([
      ['finance.query-receivables', { plan: true, confirm: false }],
      ['query-receivables', { plan: true, confirm: false }],
      ['voucher.query-saved', { plan: true, confirm: false }],
      ['query-saved', { plan: true, confirm: false }],
      ['voucher.precheck', { plan: false, confirm: false }],
      ['precheck', { plan: false, confirm: false }],
      ['payroll.transform', { plan: false, confirm: false }],
      ['transform', { plan: false, confirm: false }],
      ['voucher.prepare', { plan: true, confirm: true }],
      ['prepare', { plan: true, confirm: true }],
      ['voucher.commit', { plan: true, confirm: true }],
      ['commit', { plan: true, confirm: true }],
      ['voucher.unregistered', { plan: true, confirm: false }],
      ['unregistered', { plan: true, confirm: false }],
    ]);
  });

  it('access 取值在语义表里查不到 → 该 operation 不进表（不猜它的语义）', () => {
    const semantics = parseOperationSemantics(SEMANTICS_WITH_UNKNOWN_ACCESS);
    expect(semantics.size).toBe(0);
  });

  it('缺 access 列的 operation / 空输出 / 非 JSON / 裸数组都得到空表', () => {
    expect(parseOperationSemantics(JSON.stringify([
      { name: 'x' },
      { name: 'y', access: '' },
      { name: 'z', access: 7 },
    ])).size).toBe(0);
    expect(parseOperationSemantics('').size).toBe(0);
    expect(parseOperationSemantics('not json').size).toBe(0);
    expect(parseOperationSemantics('{"operations":[]}').size).toBe(0);
    expect(parseOperationSemantics('{"accessSemantics":{"write":{"confirm":true}}}').size).toBe(0);
  });
});

describe('loadOperationSemantics（经公共 CLI 派生一次）', () => {
  it('platformRoot 缺省 → 空表（不 spawn，宁缺勿猜）', async () => {
    expect((await loadOperationSemantics()).size).toBe(0);
    expect((await loadOperationSemantics('')).size).toBe(0);
  });

  it('CLI 正常 → 解析出语义表；非零退出 → 空表', async () => {
    const root = await fakePlatformRootWithJson(SEMANTICS_LIST_JSON);
    expect(await loadOperationSemantics(root, 'bin/example-gateway')).toEqual(parseOperationSemantics(SEMANTICS_LIST_JSON));
    expect((await loadOperationSemantics(await fakePlatformRootWithJson(SEMANTICS_LIST_JSON, { exitCode: 3 }))).size).toBe(0);
  });

  it('CLI 不存在 / 挂住 / 平台还没下发 accessSemantics → 空表（fail-closed）', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'op-semantics-empty-'));
    roots.push(empty);
    expect((await loadOperationSemantics(empty)).size).toBe(0);
    // 旧版平台（裸数组、没有语义表）：写类判定整体不生效，平台门禁照旧兜底
    expect((await loadOperationSemantics(await fakePlatformRootWithJson(JSON.stringify([{ name: 'voucher.prepare', command: 'prepare', access: 'write-flag' }])))).size).toBe(0);
    expect((await loadOperationSemantics(await fakePlatformRootWithJson('', { hang: true }))).size).toBe(0);
  }, 15_000);
});

describe('isWriteAccess（平台 access 语义：confirm 列是唯一判据）', () => {
  const semantics = parseOperationSemantics(SEMANTICS_LIST_JSON);

  it('write（confirm=true）属写类；read / scratch 不是', () => {
    expect(isWriteAccess(semantics.get('voucher.prepare'))).toBe(true);
    expect(isWriteAccess(semantics.get('commit'))).toBe(true);
    expect(isWriteAccess(semantics.get('voucher.query-saved'))).toBe(false);
    // 纯本地处理（scratch：plan=false / confirm=false）绝不是写类
    expect(isWriteAccess(semantics.get('payroll.transform'))).toBe(false);
    expect(isWriteAccess(semantics.get('precheck'))).toBe(false);
  });

  it('拿不到语义表 → 什么都不算写（fail-closed，交给平台门禁既有路径）', () => {
    // 语义表整体缺失（平台还没下发 / CLI 派生失败 / 旧版平台）
    expect(isWriteAccess(undefined)).toBe(false);
    expect(isWriteAccess(new Map().get('voucher.prepare'))).toBe(false);
    // 表在但该 operation 未登记 / access 取值不在语义表里
    expect(isWriteAccess(parseOperationSemantics(SEMANTICS_WITH_UNKNOWN_ACCESS).get('voucher.batch'))).toBe(false);
    expect(isWriteAccess(parseOperationSemantics('{"operations":[],"accessSemantics":{}}').get('x'))).toBe(false);
  });
});

describe('serveModesOf（执行模式词汇从平台 serve 矩阵派生，宿主不另立名单）', () => {
  const declaration = (operation: string, serveMatrix: readonly string[]): CapabilityManifest['operations'][number] => ({
    operation, requiresPlan: true, effects: [], estSeconds: null, label: null, serveMatrix,
  });

  it('取每行 serve 矩阵的并集：平台新声明的 mode 自动进词汇，无需宿主改名单', () => {
    const manifest: CapabilityManifest = {
      version: '1.0',
      operations: [
        declaration('dummy.query', ['query', 'prepare', 'commit']),
        declaration('dummy.scratch', ['query', 'prepare']),
        declaration('dummy.fetch', ['fetch']),
      ],
    };
    expect([...serveModesOf(manifest)]).toEqual(['query', 'prepare', 'commit', 'fetch']);
  });

  it('清单缺失 / 没声明任何 serve 键 → 空集 = 判据不成立（调用方退回契约兜底词汇）', () => {
    expect(serveModesOf(null).size).toBe(0);
    expect(serveModesOf(undefined).size).toBe(0);
    expect(serveModesOf({ version: '1.0', operations: [declaration('dummy.query', [])] }).size).toBe(0);
  });
});

// ── 平台清单键名漂移：serve → modes（2026-11-12 跨仓实测）──────────────────────
//
// 17dz 平台自 f963930 起把 `operation list --json` 每行的 serve 矩阵改名为 `modes`。
// 宿主只读 `serve` 时新平台的矩阵读成空集——`serveModesOf` 的词汇随之消失，门里那支
// "读平台矩阵、不另立名单"的实现静默失效（不是报错，是什么都不做，最难发现的那种）。
// 读取规则：两键并存时以 `serve` 为准（旧键在位时不改变既有行为）；两键内容不同属
// 平台异常，宿主不静默合并。
describe('平台清单键名漂移：serve / modes 双键读取', () => {
  const manifestJson = (row: Record<string, unknown>): string => JSON.stringify({
    operations: [{ name: 'dummy.query', command: 'query', access: 'readonly', effects: [], est_seconds: 1, ...row }],
  });

  it('新版键 modes（无 serve）：矩阵照读，不因改名读成空集', () => {
    const parsed = parseCapabilityManifest(manifestJson({ modes: { query: true, prepare: true, commit: false } }));
    expect(parsed).not.toBeNull();
    expect([...serveModesOf(parsed)]).toEqual(['query', 'prepare']);
  });

  it('旧版键 serve 照旧（回归锁：本支改动不动旧平台行为）', () => {
    const parsed = parseCapabilityManifest(manifestJson({ serve: { query: true } }));
    expect([...serveModesOf(parsed)]).toEqual(['query']);
  });

  it('两键并存：以 serve 为准（不为过渡期猜内容，也不合并两边的键）', () => {
    const parsed = parseCapabilityManifest(manifestJson({ serve: { query: true }, modes: { query: true, commit: true } }));
    expect([...serveModesOf(parsed)]).toEqual(['query']);
  });

  it('两键都没有 → 空矩阵（平台未下发，与既有安全缺省同语义）', () => {
    const parsed = parseCapabilityManifest(manifestJson({}));
    expect([...serveModesOf(parsed)]).toEqual([]);
  });
});
