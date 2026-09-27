import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOperationArgStyles, loadOperationLabels, operationLabel, parseOperationArgStyles, parseOperationLabels } from './src/operation-labels';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** 造一个假平台根：bin/17dz 把预置 TSV 吐到 stdout（可指定退出码或挂住）。 */
async function fakePlatformRoot(tsv: string, options: { exitCode?: number; hang?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'op-labels-'));
  roots.push(root);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'bin', 'list.tsv'), tsv);
  const script = options.hang
    ? '#!/bin/sh\nexec sleep 30\n'
    : `#!/bin/sh\ncat "$(dirname "$0")/list.tsv"\nexit ${options.exitCode ?? 0}\n`;
  await writeFile(path.join(root, 'bin', '17dz'), script);
  await chmod(path.join(root, 'bin', '17dz'), 0o755);
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
    expect(await loadOperationLabels(root)).toEqual(parseOperationLabels(LIST_TSV));
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
  await writeFile(path.join(root, 'bin', '17dz'), script);
  await chmod(path.join(root, 'bin', '17dz'), 0o755);
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
    expect(await loadOperationArgStyles(root)).toEqual(parseOperationArgStyles(LIST_JSON));
  });

  it('CLI 非零退出 / 不存在 / 挂住 → 空表（与 label 派生同一套失败语义）', async () => {
    expect((await loadOperationArgStyles(await fakePlatformRootWithJson(LIST_JSON, { exitCode: 3 }))).size).toBe(0);
    const empty = await mkdtemp(path.join(os.tmpdir(), 'op-args-empty-'));
    roots.push(empty);
    expect((await loadOperationArgStyles(empty)).size).toBe(0);
    expect((await loadOperationArgStyles(await fakePlatformRootWithJson('', { hang: true }))).size).toBe(0);
  }, 15_000);
});
