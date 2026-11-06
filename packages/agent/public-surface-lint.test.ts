import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSINESS_WORD_RE } from './platform-leak-lint.test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Scan surface ──────────────────────────────────────────────────────────
const SCAN_DIRS = ['packages', 'apps', 'scripts'];
const SCAN_FILES = [
  'config/agent.example.yaml',
  'README.md',
];
const SCAN_DOCS_EXCLUDE = new Set(['debt-ledger.md', 'change-safety.md']);

// Tier A: wave scope 七文件 + package.json name/description，波次末必须清零
const TIER_A_FILES = new Set([
  'README.md',
  'docs/v0-functional-spec.md',
  'docs/manual-test-wecom.md',
  'tests/e2e/harness.ts',
  'config/agent.example.yaml',
  '.env.example',
  '.github/workflows/ci.yml',
]);

// ── Registry ──────────────────────────────────────────────────────────────
interface Entry {
  needle: string;
  file: string;
  tier: 'A' | 'B';
  tag?: string;
  closure?: string;
  deadline?: string;
  field?: string; // for package.json field-specific checks
}

// Tier A: 当前命中全量登记（波次中允许在册，波次末必须全部 stale）
const TIER_A: Entry[] = [
  { needle: '17dz', file: 'README.md', tier: 'A' },
  { needle: '17dz', file: 'docs/v0-functional-spec.md', tier: 'A' },
  { needle: '17dz', file: 'docs/manual-test-wecom.md', tier: 'A' },
  { needle: '17dz', file: 'tests/e2e/harness.ts', tier: 'A' },
  { needle: '17dz', file: 'config/agent.example.yaml', tier: 'A' },
  { needle: '17dz', file: '.env.example', tier: 'A' },
  // .github/workflows/ci.yml 当前 0 命中，不登记
];

// Tier B: 扫描面内其余命中，允许在册但必须带四标签+闭环判据+限期，且 needle 必须仍命中
const TIER_B: Entry[] = [
  // architecture-laws.md 守卫命令原文 → 警职执法
  { needle: 'grep -rn "bin/17dz"', file: 'docs/architecture-laws.md', tier: 'B', tag: '警职执法', closure: '该 grep 的靶子改名或退役后命令同步更新', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/architecture-laws.md', tier: 'B', tag: '警职执法', closure: '守卫定义原文保留，靶子退役后同步更新', deadline: '迁移完成' },

  // Docs: 环境变量 / roadmap / e2e-ownership / v0-implementation-decisions / execution-layer-interface / execution-layer-admission / rule-landing / test-hardening / v0-architecture
  { needle: '17dz', file: 'docs/environment-variables.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/roadmap.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/e2e-ownership.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/v0-implementation-decisions.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/execution-layer-interface.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/execution-layer-admission.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/rule-landing.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/test-hardening.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'docs/v0-architecture.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  // business-skill.md 当前 0 命中，不登记

  // Scripts（非 .test.ts，负面夹具行挂 // leak-lint: fixture 豁免）
  { needle: '17dz', file: 'scripts/acceptance-22-supplement.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/acceptance.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/ask.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/eval/GENERIC_MOCK_NOTES.md', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/eval/corpus.jsonl', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/long-session-acceptance.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/mock-commit-smoke.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/probe-real-agent.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
  { needle: '17dz', file: 'scripts/smoke-real-platform.ts', tier: 'B', tag: '遗留待清', closure: '随 W5 尾程落定后由收口波清零', deadline: '迁移完成' },
];

// package.json name/description（name 当前无命中，description 有 1 处）
const PACKAGE_JSON: Entry[] = [
  { needle: '17dz', file: 'package.json', tier: 'A', field: 'description' },
];

const ALL_ENTRIES = [...TIER_A, ...TIER_B, ...PACKAGE_JSON];
const ENTRY_MAP = new Map(ALL_ENTRIES.map(e => [`${e.file}:${e.needle}`, e]));

// ── Scan helpers ──────────────────────────────────────────────────────────
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full;
  }
}

function readFile(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function fileMatchesNeedle(rel: string, needle: string): boolean {
  const content = readFile(rel);
  if (rel === 'package.json') {
    // For package.json, only check name/description fields
    const pkg = JSON.parse(content);
    const fields = (pkg.name || '') + ' ' + (pkg.description || '');
    return fields.includes(needle);
  }
  return content.includes(needle);
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walkTs(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full;
  }
}

function* walkAll(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walkAll(full);
    } else yield full;
  }
}

function scanLines(content: string, file: string, needle: string, hits: { file: string; needle: string; line: number }[]): void {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes(needle)) {
      hits.push({ file, needle, line: i + 1 });
    }
  }
}

function scanSurface(): { file: string; needle: string; line: number }[] {
  const hits: { file: string; needle: string; line: number }[] = [];
  const scanned = new Set<string>();

  // 1. packages/*/src 与 apps/** 的非测试 .ts
  for (const dir of SCAN_DIRS) {
    const absDir = path.join(REPO_ROOT, dir);
    if (!existsSync(absDir)) continue;
    for (const file of walk(absDir)) {
      const rel = path.relative(REPO_ROOT, file);
      scanned.add(rel);
      scanLines(readFile(rel), rel, '17dz', hits);
    }
  }

  // 2. 固定文件
  for (const rel of SCAN_FILES) {
    scanned.add(rel);
    scanLines(readFile(rel), rel, '17dz', hits);
  }

  // 3. docs/**（排除 debt-ledger / change-safety）
  const docsDir = path.join(REPO_ROOT, 'docs');
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(docsDir)) {
      if (SCAN_DOCS_EXCLUDE.has(entry)) continue;
      const rel = path.join('docs', entry);
      const abs = path.join(REPO_ROOT, rel);
      if (!statSync(abs).isFile()) continue;
      scanned.add(rel);
      scanLines(readFile(rel), rel, '17dz', hits);
    }
  }

  // 4. .github/**（全部文件）
  const githubDir = path.join(REPO_ROOT, '.github');
  if (existsSync(githubDir)) {
    for (const file of walkAll(githubDir)) {
      const rel = path.relative(REPO_ROOT, file);
      scanned.add(rel);
      scanLines(readFile(rel), rel, '17dz', hits);
    }
  }

  // 5. tests/e2e/harness.ts
  const harness = 'tests/e2e/harness.ts';
  if (existsSync(path.join(REPO_ROOT, harness))) {
    scanned.add(harness);
    scanLines(readFile(harness), harness, '17dz', hits);
  }

  // 6. package.json name/description
  const pkg = 'package.json';
  if (existsSync(path.join(REPO_ROOT, pkg))) {
    scanned.add(pkg);
    const content = readFile(pkg);
    const pkgJson = JSON.parse(content);
    const fields = (pkgJson.name || '') + ' ' + (pkgJson.description || '');
    if (fields.includes('17dz')) {
      hits.push({ file: pkg, needle: '17dz', line: 0 });
    }
  }

  return hits;
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('public-surface-lint：产品面执行层实例痕迹分层守卫', () => {
  it('表外新命中 = 0（所有命中必须在登记表内）', () => {
    const hits = scanSurface();
    const unregistered = hits.filter(h => !ENTRY_MAP.has(`${h.file}:${h.needle}`));
    expect(unregistered, [
      '发现表外新命中（未在注册表登记的执行层实例痕迹）：',
      ...unregistered.map(h => `  ${h.file}:${h.line} → "${h.needle}"`),
      '新增命中 → 在 TIER_A 或 TIER_B 登记并补全四标签（Tier B）+ 闭环判据 + 限期；真违例 → 改中性措辞或删除。',
    ].join('\n')).toEqual([]);
  });

  it('Tier B 条目字段齐全且 needle 仍命中（条目不陈旧）', () => {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const entry of TIER_B) {
      if (!entry.tag || !entry.closure || !entry.deadline) {
        missing.push(`${entry.file}:${entry.needle} → 缺字段（tag=${entry.tag ?? '无'}, closure=${entry.closure ?? '无'}, deadline=${entry.deadline ?? '无'}）`);
      }
      if (entry.file === 'package.json') {
        const pkg = JSON.parse(readFile(entry.file));
        const fields = (pkg.name || '') + ' ' + (pkg.description || '');
        if (!fields.includes(entry.needle)) stale.push(`${entry.file}:${entry.needle} → needle 不再命中`);
      } else if (!fileMatchesNeedle(entry.file, entry.needle)) {
        stale.push(`${entry.file}:${entry.needle} → needle 不再命中`);
      }
    }
    expect(missing, [
      'Tier B 条目缺字段（每条必须带四标签之一 + 闭环判据 + 限期）：',
      ...missing,
      '缺字段 → 补全；条目陈旧 → 若已清除则移入 Tier A  stale 验证流或删除条目。',
    ].join('\n')).toEqual([]);
    expect(stale, [
      'Tier B 条目已陈旧（needle 不再命中任何行）——若已清除应移出 Tier B，不得静默保留过期条目：',
      ...stale,
      '真清除 → 从 TIER_B 删除该条目；未清除 → 改回正确 needle。',
    ].join('\n')).toEqual([]);
  });

  it('门面表征 golden：README 命令/目录/保险丝（四项全绿）', () => {
    const readme = readFile('README.md');
    const pkg = JSON.parse(readFile('package.json'));
    const scripts = Object.keys(pkg.scripts || {});

    // ① README 出现的每个 npm 命令都 ∈ package.json scripts
    const mentioned = new Set<string>();
    const cmdRegex = /npm run ([a-zA-Z0-9_:.-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = cmdRegex.exec(readme)) !== null) {
      mentioned.add(m[1]!);
    }
    const missing = [...mentioned].filter(cmd => !scripts.includes(cmd));
    expect(missing, [
      'README 提到的 npm 命令在 package.json  scripts 中不存在：',
      ...missing.map(cmd => `  npm run ${cmd}`),
      '新增命令 → 同步 package.json；删除命令 → 同步 README。',
    ].join('\n')).toEqual([]);

    // ② README 目录表条目 ⊆ 仓库真实顶层目录（只查「目录」表，不含「位置」表）
    const dirEntries: string[] = [];
    const firstTable = readme.split(/^## /m)[0]!; // 取第一个 ## 标题之前
    const dirRegex = /^\| `([^`]+)` \|/gm;
    let dirMatch: RegExpExecArray | null;
    while ((dirMatch = dirRegex.exec(firstTable)) !== null) {
      const dir = dirMatch[1]!;
      // 只取顶层目录（不含 .env 等文件与含 / 的子路径）
      if (dir.includes('/')) continue;
      dirEntries.push(dir);
    }
    const missingDirs = dirEntries.filter(d => !existsSync(path.join(REPO_ROOT, d)));
    expect(missingDirs, [
      'README 目录表中的目录在仓库中不存在：',
      ...missingDirs.map(d => `  ${d}`),
      '目录表只写真实存在的顶层目录；缺口登记为现状，不伪造。',
    ].join('\n')).toEqual([]);

    // ③ README 含「不开浏览器、不触网」
    expect(readme.includes('不开浏览器、不触网'), 'README 缺「不开浏览器、不触网」措辞——mock 联调节的读者入口消失').toBe(true);

    // ④ README 含 EXECUTION_EXECUTOR=mock 与 FSHINE_REAL_COMMIT 两道保险丝
    expect(readme.includes('EXECUTION_EXECUTOR=mock'), 'README 缺 EXECUTION_EXECUTOR=mock 保险丝说明').toBe(true);
    expect(readme.includes('FSHINE_REAL_COMMIT'), 'README 缺 FSHINE_REAL_COMMIT 保险丝说明').toBe(true);
  });

  it('业务用例与口径断言移出守卫：manual-test-wecom.md 业务词命中 = 0（C4 整篇重写后移除 .skip()）', () => {
    const doc = readFile('docs/manual-test-wecom.md');
    const hits = doc.match(new RegExp(BUSINESS_WORD_RE.source, 'g')) ?? [];
    expect(hits, [
      'docs/manual-test-wecom.md 中业务词命中（应已全部移出或中性化）：',
      ...hits.map((h: string) => `  "${h}"`),
      '业务词 → 改中性措辞「执行层返回的结果/对象」；若属执行层数据下发则挂「平台下发」标签。',
    ].join('\n')).toEqual([]);
  });

  it('Tier A wave scope 已清零（波次末启用：移除 .skip() 后运行）', () => {
    const stale: string[] = [];
    for (const entry of TIER_A) {
      if (fileMatchesNeedle(entry.file, entry.needle)) {
        stale.push(`${entry.file}:${entry.needle} 仍命中`);
      }
    }
    expect(stale, [
      'Tier A 波次范围文件仍含执行层实例痕迹（波次末必须清零）：',
      ...stale,
      '未清零文件 → 对应 C2–C11 未完成或回退。',
    ].join('\n')).toEqual([]);
  });
});

// ── F3 变异验证（§24 同款方法：临时改 → 跑 → 立即还原） ──────────────────
//
// 以下五条变异在 C1 落地后手动执行，留档一行进 change-safety §25：
//   ① 守卫的覆盖匹配改恒真（把 scanSurface 里的 includes('17dz') 改成 false）→ 表外命中不再红
//   ② golden 的「README 命令必须存在」反向改成「不校验」（把 missing 断言改成 toEqual([]) 无论 missing）→ 红
//   ③ HF-4 的消费点断言改为只查派生表非空（C5 落地后执行，此处仅占位）
//   ④ 业务词守卫的词表删一个词（把 BUSINESS_WORD_RE 的「账套」删掉后跑）→ 含该词的文档不再红
//   ⑤ Tier A/Tier B 分层判据合并成「一律要求为空」（把 TIER_A 条目也加进 stale 检查）→ Tier B 在册条目让它红
//
// 执行命令示例（以变异①为例）：
//   sed -i 's/\.includes(.17dz.)/false/g' packages/agent/public-surface-lint.test.ts
//   npx vitest run packages/agent/public-surface-lint.test.ts --project unit
//   git checkout -- packages/agent/public-surface-lint.test.ts
