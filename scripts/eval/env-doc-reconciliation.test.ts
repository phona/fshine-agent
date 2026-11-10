/**
 * 文档条目 ↔ 夹具读取点对账守卫（issue #20 验收 4，切片 E 落地；2026-11-10 续篇重写）。
 *
 * 验收原文：「`docs/environment-variables.md` 条目数 = 代码真实读取点数（机械对账，
 * 纳入 docs-reality 或新增守卫）」。仓内此前没有解析该文档的守卫（`docs-reality.test.ts`
 * 只对 v0-architecture 等做点状断言），本文件补上夹具侧的可执行对账：
 *
 *   ① §4 / §4b 的「规范名 | 调试专名」两列表 == 夹具源码里 `env2(规范名, 专名, ...)`
 *      的实际配对（逐条双向相等；计划绑定两键按文档归 §9.1/§9.3，显式排除）；
 *   ② 每条 `env2` 的第一参数必须是 `EXECUTION_*`，第二参数必须是该夹具的调试专名；
 *   ③ 夹具用 `env()` / `num()` 读的每个字面量名字都必须在文档里登记（§4/§4b/§9.1/
 *      §9.2/§9.3 的并集）；
 *   ④ §9.1 / §9.2 的条目（含 `AUTO/NOTIFY/CONFIRM/HARD_CALLS` 这类斜杠缩写，展开后）
 *      与夹具实际读取的按用例旋钮双向相等——两侧任一增减都红；
 *   ⑤ §4 / §4b 的条目数钉住 3 / 6（2026-11-10 续篇：四个状态路径退役后，§4 只剩三个
 *      令牌面；§4b 只剩三个辅助组 + 三个令牌面）；
 *   ⑥ 四个状态路径（PLAN / PROPOSAL / MOCK / AUDIT）在夹具源码里 **零 env 读取**（含
 *      调试回退），文档只在 §4a「仅真平台契约」表登记它们；夹具状态根只认测试专用
 *      `--state-dir` flag（dummy 测试面，非消费协议）。
 *
 * 这不是业务词扫描（L1 的 `scripts/` 排除口径不适用于本文件）：夹具源码在这里是
 * 被对账的数据源，不是被扫描的编排层代码。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const docPath = path.join(repoRoot, 'docs', 'environment-variables.md');
const dummyPath = path.join(repoRoot, 'scripts', 'eval', 'fixtures', 'dummy-platform', 'bin', 'dummy.cjs');
const stockPath = path.join(repoRoot, 'scripts', 'eval', 'fixtures', 'stock-platform', 'bin', 'stock.cjs');

const doc = readFileSync(docPath, 'utf8');
const dummySource = readFileSync(dummyPath, 'utf8');
const stockSource = readFileSync(stockPath, 'utf8');

function section(startMarker: string, endMarker: string): string {
  const start = doc.indexOf(startMarker);
  if (start < 0) throw new Error(`文档缺少节标记：${startMarker}`);
  const end = doc.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`文档缺少节结束标记：${endMarker}`);
  return doc.slice(start, end);
}

/** §9.3 是文末节：从标记切到文件末。 */
function sectionToEnd(startMarker: string): string {
  const start = doc.indexOf(startMarker);
  if (start < 0) throw new Error(`文档缺少节标记：${startMarker}`);
  return doc.slice(start);
}

/** Markdown 表格行 → 单元格；表头与 `---` 分隔行随后由调用方按内容过滤。 */
function tableRows(text: string): string[][] {
  return text.split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2)
    .filter((cells) => !cells.every((cell) => cell === '' || /^:?-{2,}:?$/.test(cell)));
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

interface PairRow { canonical: string; debug: string; description: string }

/** 「规范名 | 调试专名 | 作用」两列表；表头行没有反引号，自然跳过。 */
function pairRows(text: string): PairRow[] {
  const rows: PairRow[] = [];
  for (const cells of tableRows(text)) {
    const canonical = backticked(cells[0] ?? '');
    const debug = backticked(cells[1] ?? '');
    if (canonical.length !== 1 || debug.length !== 1) continue;
    rows.push({ canonical: canonical[0]!, debug: debug[0]!, description: cells[2] ?? '' });
  }
  return rows;
}

/** 「变量 | 缺省 / 行为 | 声明处」单名表（§9.1 / §9.2 / §9.3 / §4a 契约表）。 */
function singleNameRows(text: string): string[] {
  const names: string[] = [];
  for (const cells of tableRows(text)) {
    const namesInCell = backticked(cells[0] ?? '');
    if (namesInCell.length !== 1) continue;
    names.push(namesInCell[0]!);
  }
  return names;
}

/**
 * 展开文档里的斜杠缩写：`PREFIX_AUTO/NOTIFY/CONFIRM/HARD_CALLS` →
 * `PREFIX_AUTO_CALLS`、`PREFIX_NOTIFY_CALLS`、`PREFIX_CONFIRM_CALLS`、`PREFIX_HARD_CALLS`。
 */
function expandSlashName(token: string): string[] {
  if (!token.includes('/')) return [token];
  const parts = token.split('/');
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const tail = last.slice(last.lastIndexOf('_') + 1);
  const prefix = first.slice(0, first.lastIndexOf('_') + 1);
  return parts.map((part) => {
    const base = part.endsWith(`_${tail}`) ? part.slice(0, -(tail.length + 1)) : part;
    // 第一段已带公共前缀（`PREFIX_AUTO`），其余段只是备选词（`NOTIFY`）。
    const alternative = base.startsWith(prefix) ? base.slice(prefix.length) : base;
    return `${prefix}${alternative}_${tail}`;
  });
}

interface FixtureReads {
  pairs: Array<{ canonical: string; debug: string }>;
  singles: Set<string>;
}

/** 夹具的真实读取点：`env2('规范名','专名',…)` 配对 + `env('名',…)` / `num('名',…)` 单名。 */
function fixtureReads(source: string): FixtureReads {
  const pairs: Array<{ canonical: string; debug: string }> = [];
  for (const match of source.matchAll(/env2\(\s*'([A-Z0-9_]+)'\s*,\s*'([A-Z0-9_]+)'/g)) {
    pairs.push({ canonical: match[1]!, debug: match[2]! });
  }
  const singles = new Set<string>();
  for (const match of source.matchAll(/env\(\s*'([A-Z0-9_]+)'/g)) singles.add(match[1]!);
  for (const match of source.matchAll(/num\(\s*'([A-Z0-9_]+)'/g)) singles.add(match[1]!);
  return { pairs, singles };
}

const PLAN_BINDING_DEBUG = new Set(['DUMMY_PLAN_ID', 'DUMMY_REQUIRE_PLAN', 'STOCK_PLAN_ID', 'STOCK_REQUIRE_PLAN']);

/** 2026-11-10 续篇退役的四个状态路径（规范名与两套调试专名）。 */
const RETIRED_STATE_CANONICAL = [
  'EXECUTION_MOCK_STATE', 'EXECUTION_PLAN_STATE', 'EXECUTION_PROPOSAL_STATE', 'EXECUTION_AUDIT_PATH',
] as const;
const RETIRED_STATE_DEBUG = [
  'DUMMY_STATE', 'DUMMY_PLAN_STATE', 'DUMMY_PROPOSAL_STATE', 'DUMMY_AUDIT_PATH',
  'STOCK_STATE', 'STOCK_PLAN_STATE', 'STOCK_PROPOSAL_STATE', 'STOCK_AUDIT_PATH',
] as const;

const section4 = pairRows(section('## 4. 通用夹具', '### 4b.'));
const section4b = pairRows(section('### 4b.', '## 5.'));
const knobs91 = singleNameRows(section('### 9.1', '### 9.2')).flatMap(expandSlashName);
const knobs92 = singleNameRows(section('### 9.2', '### 9.3')).flatMap(expandSlashName);
const hostInjected = singleNameRows(sectionToEnd('### 9.3'));
/** §4a「仅真平台契约」表里登记的四个状态路径（过滤掉派生文件行）。 */
const retiredStateRows = singleNameRows(section('### 4a.', '### 4b.'))
  .filter((name) => (RETIRED_STATE_CANONICAL as readonly string[]).includes(name));

const dummyReads = fixtureReads(dummySource);
const stockReads = fixtureReads(stockSource);

function pairKeys(rows: Array<{ canonical: string; debug: string }>): string[] {
  const keys = rows.map((row) => `${row.canonical} -> ${row.debug}`);
  return [...new Set(keys)].sort();
}

describe('environment-variables.md 条目 ↔ 夹具读取点机械对账', () => {
  it('§4 的 3 条 == dummy 夹具的 env2 配对（四个状态路径已退役；计划绑定两键归 §9.1/§9.3）', () => {
    expect(section4.length, '§4 条目数应为 3（三个令牌面；四个状态路径已移 §4a）').toBe(3);
    const isolation = dummyReads.pairs.filter((pair) => !PLAN_BINDING_DEBUG.has(pair.debug));
    expect(pairKeys(isolation), '§4 与 dummy.cjs 的 env2 配对不一致：改一侧必须同批改另一侧').toEqual(pairKeys(section4));
  });

  it('§4b 的 6 条 == stock 夹具的 env2 配对（四个状态路径已退役；三个辅助组 + 三个令牌面）', () => {
    expect(section4b.length, '§4b 条目数应为 6（三个辅助组 + 三个令牌面；四个状态路径已移 §4a）').toBe(6);
    const isolation = stockReads.pairs.filter((pair) => !PLAN_BINDING_DEBUG.has(pair.debug));
    expect(pairKeys(isolation), '§4b 与 stock.cjs 的 env2 配对不一致：改一侧必须同批改另一侧').toEqual(pairKeys(section4b));
  });

  it('夹具 env2 一律规范名优先：第一参数 EXECUTION_*，第二参数是本夹具的调试专名', () => {
    for (const pair of dummyReads.pairs) {
      expect(pair.canonical, `dummy env2 第一参数必须是 EXECUTION_*：${pair.canonical}`).toMatch(/^EXECUTION_/);
      expect(pair.debug, `dummy env2 第二参数必须是 DUMMY_* 调试专名：${pair.debug}`).toMatch(/^DUMMY_/);
    }
    for (const pair of stockReads.pairs) {
      expect(pair.canonical, `stock env2 第一参数必须是 EXECUTION_*：${pair.canonical}`).toMatch(/^EXECUTION_/);
      expect(pair.debug, `stock env2 第二参数必须是 STOCK_* 调试专名：${pair.debug}`).toMatch(/^STOCK_/);
    }
  });

  it('§9.1 / §9.2 的按用例旋钮与夹具读取双向相等（含斜杠缩写展开）', () => {
    const dummyKnobs = [...new Set([
      ...dummyReads.singles,
      ...dummyReads.pairs.filter((pair) => PLAN_BINDING_DEBUG.has(pair.debug)).map((pair) => pair.debug),
    ])].sort();
    expect(dummyKnobs, '§9.1 与 dummy.cjs 的按用例旋钮不一致').toEqual([...knobs91].sort());

    const stockKnobs = [...new Set([
      ...stockReads.singles,
      ...stockReads.pairs.filter((pair) => PLAN_BINDING_DEBUG.has(pair.debug)).map((pair) => pair.debug),
    ])].sort();
    expect(stockKnobs, '§9.2 与 stock.cjs 的按用例旋钮不一致').toEqual([...knobs92].sort());
  });

  it('夹具读取的每个名字都在文档登记；计划绑定键的规范名在 §9.3 在册', () => {
    const documented = new Set<string>([
      ...section4.flatMap((row) => [row.canonical, row.debug]),
      ...section4b.flatMap((row) => [row.canonical, row.debug]),
      ...knobs91,
      ...knobs92,
      ...hostInjected,
    ]);
    for (const pair of [...dummyReads.pairs, ...stockReads.pairs]) {
      expect(documented.has(pair.canonical), `${pair.canonical} 被夹具读取但未在文档登记`).toBe(true);
      expect(documented.has(pair.debug), `${pair.debug} 被夹具读取但未在文档登记`).toBe(true);
    }
    for (const name of [...dummyReads.singles, ...stockReads.singles]) {
      expect(documented.has(name), `${name} 被夹具读取但未在文档登记`).toBe(true);
    }
    for (const pair of [...dummyReads.pairs, ...stockReads.pairs]) {
      if (!PLAN_BINDING_DEBUG.has(pair.debug)) continue;
      expect(hostInjected, `${pair.canonical} 是计划绑定规范名，应在 §9.3 在册`).toContain(pair.canonical);
    }
  });

  it('四个状态路径：夹具零 env 读取（含调试回退），文档只在 §4a 保留真平台契约行', () => {
    const readNames = new Set<string>([
      ...[...dummyReads.pairs, ...stockReads.pairs].flatMap((pair) => [pair.canonical, pair.debug]),
      ...dummyReads.singles,
      ...stockReads.singles,
    ]);
    for (const name of [...RETIRED_STATE_CANONICAL, ...RETIRED_STATE_DEBUG]) {
      expect(readNames.has(name), `${name} 仍在夹具的 env/env2 读取点里——四个状态路径必须只认 --state-dir`).toBe(false);
    }
    expect([...retiredStateRows].sort(), '§4a 应登记四个状态路径的真平台契约行').toEqual([...RETIRED_STATE_CANONICAL].sort());
  });

  it('夹具状态根只认测试专用 --state-dir flag（dummy 测试面，非消费协议）', () => {
    for (const [label, source] of [['dummy.cjs', dummySource], ['stock.cjs', stockSource]] as const) {
      expect(source, `${label} 缺少 --state-dir flag 解析`).toContain("arg === '--state-dir'");
      expect(source, `${label} 的审计文件应从状态根派生`).toContain("path.join(dir, 'audit.jsonl')");
      expect(source, `${label} 的默认状态文件应仍在夹具 .runtime 下`).toContain("path.join(FIXTURE_ROOT, '.runtime')");
    }
  });
});
