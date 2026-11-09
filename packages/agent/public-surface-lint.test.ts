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

// 实例名 needle 拆段拼回（platform-leak-lint 同规）：守卫自身不落字面量——
// 否则门①的 git grep 会把这个守卫文件自己算成命中，收口永远差一个文件。
const NEEDLE = '1' + '7dz';

// Tier A: 当前命中全量登记（波次中允许在册，波次末必须全部 stale）
const TIER_A: Entry[] = [
  { needle: NEEDLE, file: 'README.md', tier: 'A' },
  { needle: NEEDLE, file: 'docs/v0-functional-spec.md', tier: 'A' },
  { needle: NEEDLE, file: 'docs/manual-test-wecom.md', tier: 'A' },
  { needle: NEEDLE, file: 'tests/e2e/harness.ts', tier: 'A' },
  { needle: NEEDLE, file: 'config/agent.example.yaml', tier: 'A' },
  { needle: NEEDLE, file: '.env.example', tier: 'A' },
  // .github/workflows/ci.yml 当前 0 命中，不登记
];

// Tier B: 扫描面内其余命中，允许在册但必须带四标签+闭环判据+限期，且 needle 必须仍命中
const TIER_B: Entry[] = [
  // 门①清零后登记表清空（2026-11-06 收口波）：原 Tier B 条目
  // · architecture-laws 守卫命令原文 ×2（警职执法）——靶子已退役且命令已同步更新为中性形态，闭环达成；
  // · docs/scripts 十余条（遗留待清）——收口波逐文件清零，闭环达成。
  // 此后新增命中按四标签 + 闭环判据 + 限期重新登记；表外命中即红（见下方断言）。
];

// package.json name/description（name 当前无命中，description 有 1 处）
const PACKAGE_JSON: Entry[] = [
  { needle: NEEDLE, file: 'package.json', tier: 'A', field: 'description' },
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

  // 1. packages/*/src 与 apps/** 的非测试 .ts；scripts/** 全部文件（含 .mjs/.sh/.md/.jsonl）
  for (const dir of SCAN_DIRS) {
    const absDir = path.join(REPO_ROOT, dir);
    if (!existsSync(absDir)) continue;
    // scripts/** 用 walkAll（含 .mjs/.sh/.md/.jsonl——CI 入口脚本不全在 .ts 里），其余用 walk
    const walker = dir === 'scripts' ? walkAll : walk;
    for (const file of walker(absDir)) {
      const rel = path.relative(REPO_ROOT, file);
      if (rel.endsWith('.test.ts')) continue; // 跳过测试文件
      scanned.add(rel);
      scanLines(readFile(rel), rel, NEEDLE, hits);
    }
  }

  // 2. 固定文件
  for (const rel of SCAN_FILES) {
    scanned.add(rel);
    scanLines(readFile(rel), rel, NEEDLE, hits);
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
      scanLines(readFile(rel), rel, NEEDLE, hits);
    }
  }

  // 4. .github/**（全部文件）
  const githubDir = path.join(REPO_ROOT, '.github');
  if (existsSync(githubDir)) {
    for (const file of walkAll(githubDir)) {
      const rel = path.relative(REPO_ROOT, file);
      scanned.add(rel);
      scanLines(readFile(rel), rel, NEEDLE, hits);
    }
  }

  // 5. tests/e2e/harness.ts
  const harness = 'tests/e2e/harness.ts';
  if (existsSync(path.join(REPO_ROOT, harness))) {
    scanned.add(harness);
    scanLines(readFile(harness), harness, NEEDLE, hits);
  }

  // 6. package.json name/description
  const pkg = 'package.json';
  if (existsSync(path.join(REPO_ROOT, pkg))) {
    scanned.add(pkg);
    const content = readFile(pkg);
    const pkgJson = JSON.parse(content);
    const fields = (pkgJson.name || '') + ' ' + (pkgJson.description || '');
    if (fields.includes(NEEDLE)) {
      hits.push({ file: pkg, needle: NEEDLE, line: 0 });
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
    const invalidTags: string[] = [];
    const ALLOWED_TAGS = new Set(['警职执法', '防御排除', '平台下发', '遗留待清']);
    for (const entry of TIER_B) {
      if (!entry.tag || !entry.closure || !entry.deadline) {
        missing.push(`${entry.file}:${entry.needle} → 缺字段（tag=${entry.tag ?? '无'}, closure=${entry.closure ?? '无'}, deadline=${entry.deadline ?? '无'}）`);
      }
      if (entry.tag && !ALLOWED_TAGS.has(entry.tag)) {
        invalidTags.push(`${entry.file}:${entry.needle} → tag="${entry.tag}" 不在四标签集合（警职执法/防御排除/平台下发/遗留待清）内`);
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
    expect(invalidTags, [
      'Tier B 条目 tag 不在四标签集合（警职执法/防御排除/平台下发/遗留待清）内：',
      ...invalidTags,
      '非法 tag → 改为合法标签或删除条目。',
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

    // ①-reverse：读者必需命令（6 个）必须在 README 中出现（双向守卫，防 README 侧删）
    const essential = new Set(['acceptance', 'ci', 'smoke:commit:mock', 'smoke:wecom', 'test', 'typecheck']);
    const missingFromReadme = [...essential].filter(cmd => !mentioned.has(cmd));
    expect(missingFromReadme, [
      'package.json scripts 中的读者必需命令在 README 中未提及（双向守卫）：',
      ...missingFromReadme.map(cmd => `  npm run ${cmd}`),
      'README 删必需命令 → 还原或同步标记非必需。',
    ].join('\n')).toEqual([]);

    // ② README 目录表条目 ⊆ 仓库真实顶层目录（只查「目录」表，不含「位置」表）
    const dirEntries: string[] = [];
    const dirSection = readme.split(/^## 目录\n/m)[1]?.split(/^## /m)[0] ?? ''; // 取「## 目录」之后、下一个 ## 之前
    const dirRegex = /^\| `([^`]+)` \|/gm;
    let dirMatch: RegExpExecArray | null;
    while ((dirMatch = dirRegex.exec(dirSection)) !== null) {
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

    // ④ README 含 mock 执行器说明（执行层治理变量名以执行层声明为准，接受 EXECUTION_EXECUTOR 或 DZ_EXECUTOR）。
    // 2026-11-08 起不再要求 README 提 FSHINE_REAL_COMMIT：那是宿主侧的落账授权开关，
    // 已随"编排层不判这个部署允不允许写"的裁定删除——README 只说明执行层自己的 mock 开关，
    // 并明说编排层不读它、写授权归执行层。
    const hasMockFuse = readme.includes('EXECUTION_EXECUTOR=mock') || readme.includes('DZ_EXECUTOR=mock');
    expect(hasMockFuse, 'README 缺 mock 执行器说明（执行层治理变量名以该执行层声明为准）').toBe(true);
    expect(readme.includes('编排层不读它'), 'README 未说明 mock 开关由执行层自己读取（宿主不再据此判写权限）').toBe(true);
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
//   ① 守卫的覆盖匹配改恒真（把 scanSurface 里的 includes(NEEDLE) 改成 false）→ 表外命中不再红
//   ② golden 的「README 命令必须存在」反向改成「不校验」（把 missing 断言改成 toEqual([]) 无论 missing）→ 红
//   ③ HF-4 的消费点断言改为只查派生表非空（C5 落地后执行，此处仅占位）
//   ④ 业务词守卫的词表删一个词（把 BUSINESS_WORD_RE 的「账套」删掉后跑）→ 含该词的文档不再红
//   ⑤ Tier A/Tier B 分层判据合并成「一律要求为空」（把 TIER_A 条目也加进 stale 检查）→ Tier B 在册条目让它红
//
// 执行命令示例（以变异①为例）：
//   sed -i 's/\.includes(NEEDLE)/false/g' packages/agent/public-surface-lint.test.ts
//   npx vitest run packages/agent/public-surface-lint.test.ts --project unit
//   git checkout -- packages/agent/public-surface-lint.test.ts

// ── 就绪检查（acceptance ①）──────────────────────────────────────────────
// 明文：四项全部满足才开跑；任何一项不满足，把对应前置波次列为阻塞而不是硬开。
describe('acceptance ①：波次开跑就绪检查（四项全部满足才开跑）', () => {
  const failures: string[] = [];

  // a) roadmap 对 W1–W5 有记载
  const roadmap = readFile('docs/roadmap.md');
  if (!roadmap.includes('W1') || !roadmap.includes('W2') || !roadmap.includes('W3') || !roadmap.includes('W4') || !roadmap.includes('W5')) {
    failures.push('a) docs/roadmap.md 对 W1–W5 零记载（或不全）');
  }

  // b) change-safety 尾部为 §27–§30、W1–W5 在册
  const changeSafety = readFile('docs/change-safety.md');
  const hasW1ToW5 = ['W1', 'W2', 'W3', 'W4', 'W5'].every(w => changeSafety.includes(w));
  const hasS27ToS30 = ['## 27.', '## 28.', '## 29.', '## 30.'].every(s => changeSafety.includes(s));
  if (!hasW1ToW5 || !hasS27ToS30) {
    failures.push('b) docs/change-safety.md 尾部缺少 §27–§30 或 W1–W5 在册');
  }

  // c) AGENTS.md 不声称预算档位迁移已完成（实际平台 plan evaluate 仍为权威）
  const agentsMd = readFile('AGENTS.md');
  if (agentsMd.includes('预算档位决定及累计账本由通用策略管理（迁移完成）')) {
    failures.push('c) AGENTS.md 声称预算档位迁移已完成（实际平台计划门仍为权威，迁移未完成）');
  }

  // d) 跨仓 env 命名空间漂移已按「退役 + 桥接」方案收口（2026-11-06，W5 C8 + 执行层侧 P4 同批落地）：
  //    fshine 侧 env 级门开关已退役（生产 src 不再读门开关），harness 对兄弟仓改名后的 DZ_* 族做桥接
  //    （EXECUTION_* 与 DZ_* 并存设 mock），e2e 因此对改名后的执行层仍可验证——DZ_* 提法在 harness 里
  //    是桥接而非漂移。判据从漂移未修时的代理「零提及 DZ_*」改为已解决架构的机械面：
  //    ① harness 桥接在位（两族 mock 设定都在）；② 生产/src 与 .env.example 无 DZ_* 门命中。
  const harnessContent = readFile('tests/e2e/harness.ts');
  const bridgeKeys = ['EXECUTION_EXECUTOR', 'DZ_EXECUTOR', 'DZ_ALLOW_REAL'];
  const bridgeMissing = bridgeKeys.filter(k => !harnessContent.includes(k));
  // 2026-11-08：platform-mock.ts（宿主读 EXECUTION_EXECUTOR/FSHINE_REAL_COMMIT）与
  // runtime-mode.ts（启动日志汇总 mock/commit 状态）已整模块删除，判据源归执行层，
  // 这里只扫仍然存在的生产/src 面。
  const prodFiles = ['packages/agent/src/context.ts', 'packages/agent/src/pi-coding-driver.ts', '.env.example'];
  const prodDzHits = prodFiles.reduce((n, f) => n + (readFile(f).match(/DZ_EXECUTOR|DZ_ALLOW_REAL/g) ?? []).length, 0);
  if (bridgeMissing.length > 0 || prodDzHits > 0) {
    failures.push(`d) env 命名空间漂移未按既定方案收口：harness 桥接缺 ${bridgeMissing.join('/') || '无'}；生产/src 与 .env.example 有 DZ_* 命中 ${prodDzHits} 处`);
  }

  it('四项全部满足才开跑（当前不满足时列出缺口，阻塞硬开跑）', () => {
    expect(failures, [
      '就绪检查四项不满足，对应前置波次应列为阻塞而不是硬开：',
      ...failures.map(f => `  - ${f}`),
      '修复前置漂移后重跑本测试直至 failures 为空。',
    ].join('\n')).toEqual([]);
  });
});
