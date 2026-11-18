/**
 * 文档结构守卫（vitest）：四条检查把 docs/ 重组的约束变成常驻测试。
 *
 * 范围与判据
 *   1. 入口覆盖：docs/index.md 链接到的文件集合 == 现存 docs 下全部 md（index 自身除外）；
 *      缺失（文件在、索引没链）与多余（索引链了、文件不存在）逐条报错。
 *   2. 无死链：docs 内 `docs/...md` 引用目标必须存在；docs/history/** 作为来源豁免
 *      （文首已标历史归档）。index.md 的相对 .md 链接同属「docs 内引用」，一并纳入，
 *      使绊线①（索引链到不存在文件）在 1、2 两条上同时红。
 *   3. 命名规则：docs/{product,architecture,eval,decisions}/** 文件名不得带轮次前缀
 *      ^(r|p|b|m|s)[0-9]+-；history 不限。
 *   4. 状态头 + 指针：architecture/*.md、eval/README.md、ops/README.md 文首必须有
 *      「状态 / 最后核对 / 上游」三行（语义匹配：状态 / 核对 / 上游|指针），且至少
 *      3 个 file.ts:LINE 指针，文件与行号真实存在（读文件取行数，越界即失败）。
 *
 * 现状张力与窄豁免（⚠️ 现行 docs 与「字面规范」不一致，以现状为准并显式登记）
 *   · 检查 2：docs 现行页里保留了一批指向已删文档的考古引用（均标注「已删/git 历史
 *     可考/不在当前树/本仓无此文件/跨仓」）。它们不是活链接而是历史锚点，与 history
 *     来源豁免同类。仅当引用所在行带这些归档标记时豁免；未标注的死链一律红。豁免
 *     是「按行标记」而非按目标白名单，新增死链无标记必红。
 *   · 检查 3：docs/product/ 现存 5 篇带轮次前缀的文件是冻结中的预注册 / 验收 / 契约
 *     记录，仍被代码以路径引用（见 LEGACY_PREFIXED_FILES 理由），当前不可改名。用
 *     闭合白名单逐条登记；白名单双向闭合（陈旧条目也红），白名单外的 r9-x.md 必红。
 *   · 检查 4：三行标签在不同页用词不同（最后核对 / 最后核对日期 / 核对 @；上游 /
 *     上游指针 / 指针），按语义 Token 匹配，不按精确字面。
 *
 * 反向绊线（本套测试自身的有效性证明）：
 *   ① index 链到不存在文件 → 检查 1、2 红；
 *   ② 任一页指针行号改 99999 → 检查 4 红；
 *   ③ product/ 放 r9-x.md → 检查 3 红。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const INDEX_REL = 'docs/index.md';

// ---------- 通用工具 ----------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function repoRel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(REPO_ROOT, rel));
}

function lineCount(rel: string): number {
  return read(rel).split('\n').length;
}

/** 所有 docs 下的 md（仓库相对路径，正斜杠）。 */
function allDocsMd(): string[] {
  return walk(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map(repoRel);
}

/** 解析一个 .md 引用 Token 到 docs 下的仓库相对路径；非 docs 引用返回 null。 */
function resolveDocRef(token: string, sourceRel: string): string | null {
  const clean = token.replace(/:.*$/, '').trim(); // 去掉 :LINE / :A-B
  if (!clean.endsWith('.md') || clean.includes('*')) return null;
  let norm: string;
  if (clean.startsWith('docs/')) norm = path.posix.normalize(clean);
  else if (clean.startsWith('../')) norm = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRel), clean));
  else norm = path.posix.normalize(path.posix.join('docs', clean));
  return norm.startsWith('docs/') ? norm : null;
}

/** 抽取一行里的反引号片段与 markdown 链接目标。 */
function refTokens(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]!);
  for (const m of line.matchAll(/\]\(([^)]+)\)/g)) out.push(m[1]!);
  return out;
}

// ---------- 检查 1：入口覆盖 ----------

describe('检查 1 · 入口覆盖：index 链接集合 == 现存 docs/**/*.md', () => {
  it('index 链到全部现存文档，且不存在多余链接', () => {
    const indexText = read(INDEX_REL);
    const linked = new Set<string>();
    for (const line of indexText.split('\n')) {
      for (const tok of refTokens(line)) {
        const resolved = resolveDocRef(tok, INDEX_REL);
        if (resolved && resolved !== INDEX_REL) linked.add(resolved);
      }
    }
    const onDisk = new Set(allDocsMd().filter((rel) => rel !== INDEX_REL));

    const missing = [...onDisk].filter((rel) => !linked.has(rel)).sort(); // 文件在、索引没链
    const extra = [...linked].filter((rel) => !exists(rel)).sort(); // 索引链了、文件不在

    console.log(JSON.stringify({
      event: 'docs_guard_index_coverage',
      onDisk: onDisk.size,
      linked: linked.size,
      missing: missing.length,
      extra: extra.length,
    }));
    expect(missing, `现存但未被 docs/index.md 链接：\n${missing.join('\n')}`).toEqual([]);
    expect(extra, `docs/index.md 链接到不存在的目标：\n${extra.join('\n')}`).toEqual([]);
  });
});

// ---------- 检查 2：无死链 ----------

/** 行内归档标记：带这些词的引用是「历史锚点」而非活链接，与 history 来源豁免同类。 */
const ARCHIVE_MARKERS: readonly string[] = [
  '已删', '已删除', '已移', '已拆档', '不在当前树', '本仓无', '已不存在', '不存在',
  'git 历史', '跨仓',
];

interface DeadRef {
  source: string;
  line: number;
  token: string;
  target: string;
}

describe('检查 2 · 无死链：docs 内 docs/...md 引用目标必须存在', () => {
  it('非 history 来源、且未标注归档的 docs 引用全部指向现存文件', () => {
    const dead: DeadRef[] = [];
    const archived: DeadRef[] = [];
    for (const source of allDocsMd()) {
      if (source.startsWith('docs/history/')) continue; // 文首已标历史归档，来源豁免
      const lines = read(source).split('\n');
      lines.forEach((line, i) => {
        for (const tok of refTokens(line)) {
          // 范围：显式的 docs/... 引用；或 index.md 的相对 .md 链接（绊线①双红）。
          const isDocsPrefixed = /^docs\//.test(tok);
          const isIndexRel = source === INDEX_REL && /\.md/.test(tok);
          if (!isDocsPrefixed && !isIndexRel) continue;
          const target = resolveDocRef(tok, source);
          if (!target || target === INDEX_REL) continue;
          if (exists(target)) continue;
          const hit: DeadRef = { source, line: i + 1, token: tok, target };
          if (ARCHIVE_MARKERS.some((marker) => line.includes(marker))) archived.push(hit);
          else dead.push(hit);
        }
      });
    }
    console.log(JSON.stringify({
      event: 'docs_guard_dead_links',
      archivedExempt: archived.length,
      dead: dead.length,
    }));
    const labels = dead.map((d) => `${d.source}:${d.line}  ${d.token} -> ${d.target}（未标注归档）`);
    expect(labels, `docs 内未标注归档的死链：\n${labels.join('\n')}`).toEqual([]);
  });
});

// ---------- 检查 3：命名规则 ----------

const ROUND_PREFIX = /^(r|p|b|m|s)[0-9]+-/;
const NAMED_DIRS = ['product', 'architecture', 'eval', 'decisions'] as const;

/**
 * 冻结中的旧命名文件：仍被代码/构建以路径引用，当前不可改名。闭合白名单，逐条给理由。
 *   · 白名单外任何带轮次前缀的新文件（如 r9-x.md）必红；
 *   · 白名单条目必须仍存在且仍命中前缀（陈旧豁免同样红）。
 */
const LEGACY_PREFIXED_FILES: ReadonlyArray<{ rel: string; reason: string }> = [
  {
    rel: 'docs/product/p2-business-e2e-prereg.md',
    reason: 'P2 业务 E2E 冻结预注册；scripts/eval/p2/p2-types.ts:4、p2-scenarios.ts:2 以路径引用',
  },
  {
    rel: 'docs/product/p3-human-redo.md',
    reason: '--redo 语义报告；scripts/p0-redo-doc-scan.test.ts:27 逐字扫描该文件',
  },
  {
    rel: 'docs/product/r4-acceptance.md',
    reason: 'R4 验收用例冻结基线；测试文件头注释按 P*-T* 编号引用',
  },
  {
    rel: 'docs/product/r4-joint-interfaces.md',
    reason: 'R4 联合接口 v1 冻结面；packages/agent/src/task-registry.ts:14 等多处以路径引用',
  },
  {
    rel: 'docs/product/r6-longsession-prereg.md',
    reason: 'R6 预注册；scripts/eval/long-session/wave1-runner.ts:66 运行时读取并算 sha256',
  },
];

describe('检查 3 · 命名规则：现行目录文件名不得带轮次前缀', () => {
  it('product/architecture/eval/decisions 下无新轮次前缀文件', () => {
    const prefixes = new Set(LEGACY_PREFIXED_FILES.map((e) => e.rel));
    const offenders: string[] = [];
    for (const source of allDocsMd()) {
      const dir = source.split('/')[1];
      if (!NAMED_DIRS.includes(dir as (typeof NAMED_DIRS)[number])) continue;
      const base = path.posix.basename(source);
      if (ROUND_PREFIX.test(base) && !prefixes.has(source)) offenders.push(source);
    }
    console.log(JSON.stringify({
      event: 'docs_guard_naming',
      legacyGrandfathered: LEGACY_PREFIXED_FILES.length,
      offenders: offenders.length,
    }));
    expect(offenders, `现行目录出现轮次前缀文件（未登记豁免）：\n${offenders.join('\n')}`).toEqual([]);

    // 闭合性：白名单条目必须仍存在且仍命中前缀，防陈旧豁免长期积灰。
    const stale = LEGACY_PREFIXED_FILES
      .filter((e) => !exists(e.rel) || !ROUND_PREFIX.test(path.posix.basename(e.rel)))
      .map((e) => `${e.rel}（理由：${e.reason}）`);
    expect(stale, `陈旧的命名豁免：\n${stale.join('\n')}`).toEqual([]);
  });
});

// ---------- 检查 4：状态头 + 真实指针 ----------

const HEADER_TARGETS: readonly string[] = [
  ...readdirSync(path.join(DOCS_DIR, 'architecture'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/architecture/${f}`)
    .sort(),
  'docs/eval/README.md',
  'docs/ops/README.md',
];

/** 文首引用块：从开头到第一个 ## 之间的 `> ` 行。 */
function leadingQuoteBlock(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) break;
    if (/^>/.test(line)) out.push(line);
  }
  return out.join('\n');
}

interface TsPointer {
  raw: string;
  path: string;
  start: number;
  end: number;
}

const TS_PTR = /([A-Za-z0-9_@./-]+\.ts):(\d+)(?:[-–](\d+))?/g;
const TS_FILES: string[] = walk(REPO_ROOT)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}.git${path.sep}`))
  .map(repoRel);

function tsCandidates(p: string): string[] {
  const norm = path.posix.normalize(p);
  if (norm.includes('/') && exists(norm)) return [norm]; // 全路径且存在
  const base = path.posix.basename(p);
  return TS_FILES.filter((f) => path.posix.basename(f) === base); // 裸文件名按 basename 解析
}

describe('检查 4 · 状态头 + 真实指针', () => {
  it('文首三行齐全（状态 / 核对 / 上游）', () => {
    const missing: string[] = [];
    for (const target of HEADER_TARGETS) {
      const block = leadingQuoteBlock(read(target));
      const hasStatus = /状态/.test(block);
      const hasVerified = /核对/.test(block);
      const hasUpstream = /上游|指针/.test(block);
      if (!hasStatus || !hasVerified || !hasUpstream) {
        missing.push(`${target}: 状态=${hasStatus} 核对=${hasVerified} 上游=${hasUpstream}`);
      }
    }
    console.log(JSON.stringify({ event: 'docs_guard_header', targets: HEADER_TARGETS.length, missing: missing.length }));
    expect(missing, `文首缺少「状态 / 最后核对 / 上游」三行：\n${missing.join('\n')}`).toEqual([]);
  });

  it('每页至少 3 个真实 file.ts:LINE 指针，且行号不越界', () => {
    const problems: string[] = [];
    const summary: Array<{ file: string; valid: number; oob: number; unresolved: number }> = [];
    for (const target of HEADER_TARGETS) {
      const text = read(target);
      const ptrs: TsPointer[] = [...text.matchAll(TS_PTR)].map((m) => ({
        raw: m[0],
        path: m[1]!,
        start: Number(m[2]),
        end: m[3] ? Number(m[3]) : Number(m[2]),
      }));
      let valid = 0;
      const oob: string[] = [];
      const unresolved: string[] = [];
      for (const p of ptrs) {
        const candidates = tsCandidates(p.path);
        if (candidates.length === 0) {
          unresolved.push(p.raw);
          continue;
        }
        // 全路径取该文件行数；裸名（多候选）取候选最大行数——99999 之类越界在任何
        // 候选下都必然红，而普通行号仍按现状放过（现状多候选指针本就合法）。
        const bound = Math.max(...candidates.map(lineCount));
        if (p.start < 1 || p.end > bound || p.end < p.start) oob.push(`${p.raw}（最大行 ${bound}）`);
        else valid += 1;
      }
      if (valid < 3) problems.push(`${target}: 有效指针 ${valid} 个（需 ≥3）`);
      if (oob.length) problems.push(`${target}: 行号越界 -> ${oob.join(', ')}`);
      if (unresolved.length) problems.push(`${target}: 指针文件不存在 -> ${unresolved.join(', ')}`);
      summary.push({ file: target, valid, oob: oob.length, unresolved: unresolved.length });
    }
    console.log(JSON.stringify({ event: 'docs_guard_pointers', targets: HEADER_TARGETS.length, summary }));
    expect(problems, `状态头指针问题：\n${problems.join('\n')}`).toEqual([]);
  });

  it('头部目标清单非空且逐页存在', () => {
    expect(HEADER_TARGETS.length).toBeGreaterThan(0);
    for (const target of HEADER_TARGETS) {
      expect(exists(target), `头部目标不存在：${target}`).toBe(true);
    }
  });
});
