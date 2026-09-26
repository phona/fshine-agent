import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOperationLabels, operationLabel, parseOperationLabels } from './src/operation-labels';

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
