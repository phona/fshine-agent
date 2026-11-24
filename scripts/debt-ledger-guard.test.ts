/**
 * debt.md §二 登记行的机械守卫（2026-11-24 debt 切片，HEAD `2645e46f`）。
 *
 * 背景：`docs/decisions/debt.md` §二 8 条「有现行指针」项在 2026-11-24 逐条对现行树
 * 核实——3 条结案（D-052 / D-062 / D-196）、5 条改写登记（D-204 / D-156 / D-168 /
 * D-170 / D-190）。按文档约束纪律，台账登记行里每条「现状陈述」都要有一个能变红的
 * 守卫：本文件把那些陈述钉成机械断言，代码或档案一动就红，逼使台账同步复核。
 *
 * 判据形状（全部是机械事实/结构化计数，不判语义；文本字面量只用于泄漏类确定性
 * 检查——两支真实读数与内部词 `17dz` / `FSHINE_PLATFORM_ROOT` 都属这一类）：
 *   · D-052：`step-text.ts` 无六个退役工具名、无 switch；whitelist 载体
 *     `platform-leak-lint.test.ts` 不在树内（死分支连同白名单整体删除）。
 *   · D-156：`61,000`/`86,000`/`61000`/`86000` 在非档案面零命中；history 档案 9 行。
 *   · D-062：无用例从 `process.env` 读企微凭据；原红的根因 `tests/e2e/harness.ts`
 *     （启动真实渠道）不在树内。
 *   · D-168/D-190：17dz 按三张脸分别计数——packages/apps 非测试 0 行；`*.test.ts`
 *     2 行 1 文件；scripts/ 非测试 1 行 1 文件（这张脸就是口径存疑点，台账不自行裁定）。
 *   · D-170：`exposure-lint.test.ts` / `platform-leak-lint.test.ts` /
 *     `history-hygiene.test.ts` 三个守卫文件均不在树内；删除记录在 decision-log 可考。
 *   · D-196：`FSHINE_PLATFORM_ROOT` 在 docs/ 之外零命中；history 档案 8 行。
 *   · D-204：dummy.cjs 两套 commit 令牌契约仍不一致（任一侧被统一即红，逼台账结案）。
 *   · 指针：§二（含结案行）全部 `file:LINE` 反引号指针真实存在且行号不越界。
 *
 * 反向绊线（证明守卫不是恒过）：指针校验器对合成坏指针必须报错；各扫描器对合成
 * 坏内容/现存对照内容必须报红（见各 describe 末尾的绊线例）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DEBT_MD = 'docs/decisions/debt.md';

/** 机器状态/编辑器产物不入扫描面（gitignored，随机器变）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.runtime', '.zcode', '.zcode-out.txt']);

/** 守卫自身含全部被判词串（词表/注释里必须出现它们），扫描面排除自己，否则恒红。 */
const SELF = 'scripts/debt-ledger-guard.test.ts';

/**
 * 收集扫描面文件。`skipDir` 只剪目录枝（如 docs/history），`skipFile` 只滤文件
 * （如「只要 *.test.ts」）——两者分开，否则「只要 .test.ts」这类文件过滤器会把所有
 * 目录都剪掉，扫描面恒空（2026-11-24 实测踩过：packages/** 整林被剪，期望值假过）。
 */
function walk(roots: readonly string[], skipDir?: (rel: string) => boolean, skipFile?: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const rec = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      const rel = path.relative(ROOT, child).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!skipDir?.(rel)) rec(child);
        continue;
      }
      if (rel === SELF) continue;
      if (!skipFile?.(rel)) out.push(rel);
    }
  };
  for (const root of roots) {
    const abs = path.join(ROOT, root);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) rec(abs);
    else if (root !== SELF && !skipFile?.(root)) out.push(root); // 根级单文件（README.md 等）
  }
  return out.sort();
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

/** 逐行命中，返回 `rel:line` 标签（行号 1 起）。 */
function lineHits(files: readonly string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}`);
      });
  }
  return hits;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

// ---------- D-052：step-text.ts 六个退役工具名死分支（2026-11-24 结案） ----------

describe('D-052 · step-text.ts 退役工具死分支已清（结案守卫）', () => {
  const RETIRED = [
    'search_account_sets',
    'get_current_accounting_period',
    'list_vouchers',
    'inspect_account_set',
    'search_references',
    'get_login_status',
  ];

  it('六个退役工具名在 step-text.ts 零命中，且无 switch (toolName) 死分支', () => {
    const src = read('packages/agent/src/step-text.ts');
    for (const name of RETIRED) expect(src, `${name} 不得出现在 step-text.ts`).not.toContain(name);
    expect(src).not.toContain('switch (toolName)');
    // 现形状 = 通用模板（原判据允许的收敛终点）：defaultStepText 对任何工具名出一帧。
    expect(src).toContain('return `正在调用 ${toolName}…`;');
  });

  it('白名单载体 platform-leak-lint.test.ts 与 rememberAccountSets 均不在树内', () => {
    expect(exists('packages/agent/platform-leak-lint.test.ts')).toBe(false);
    const tsFiles = walk(['packages', 'apps', 'scripts'], undefined, (rel) => !rel.endsWith('.ts'));
    expect(lineHits(tsFiles, /rememberAccountSets/)).toEqual([]);
  });

  it('反向绊线：扫描器对现存对照词报红（不是恒过）', () => {
    const src = read('packages/agent/src/step-text.ts');
    expect(lineHits(['packages/agent/src/step-text.ts'], /defaultStepText/).length).toBeGreaterThan(0);
    expect(src).toContain('defaultStepText');
  });
});

// ---------- D-156：两支真实读数（61,000 / 86,000） ----------

const READING_PATTERN = /61,000|86,000|61000|86000/;

describe('D-156 · 两支真实读数非档案面零命中（登记行守卫）', () => {
  /** 非档案面 = 全部代码/现行文档面；档案面 = docs/history/** 与台账自身（登记即提）。 */
  const nonArchive = (): string[] =>
    walk(
      ['packages', 'apps', 'scripts', 'config', 'tests', '.github', 'patches', 'docs', 'README.md', 'AGENTS.md', 'package.json'],
      (rel) => rel === 'docs/history' || rel.startsWith('docs/history/'),
      (rel) => rel === DEBT_MD,
    );

  it('非档案面对两支读数（含无千分位形）零命中', () => {
    expect(lineHits(nonArchive(), READING_PATTERN)).toEqual([]);
  });

  it('history 档案面 = 9 行（过程史不重写；行数变了就红，逼台账复核）', () => {
    const historyFiles = walk(['docs/history']);
    expect(lineHits(historyFiles, READING_PATTERN).length).toBe(9);
  });

  it('反向绊线：档案面抽样命中（证明扫描器活着）', () => {
    expect(lineHits(['docs/history/architecture-laws-2026-11_undated.md'], READING_PATTERN).length).toBe(1);
  });
});

// ---------- D-062：npm test 无凭据环境全红（2026-11-24 结案） ----------

describe('D-062 · 无凭据环境不再红（结案守卫）', () => {
  it('无用例从 process.env 读企微凭据（自供假值的对象字面量不算）', () => {
    const testFiles = walk(['packages', 'apps', 'scripts', 'tests'], undefined, (rel) => !rel.endsWith('.test.ts'));
    const offenders = lineHits(testFiles, /process\.env[^\n]*WECOM_BOT|WECOM_BOT[^\n]*process\.env/);
    expect(offenders).toEqual([]);
  });

  it('原红的根因 tests/e2e/harness.ts（启动真实渠道）不在树内', () => {
    expect(exists('tests/e2e/harness.ts')).toBe(false);
  });

  it('反向绊线：既有自供假值处被扫描器认到（证明扫描器活着）', () => {
    expect(lineHits(['packages/channel-wecom/adapter.test.ts'], /WECOM_BOT_ID/).length).toBeGreaterThan(0);
  });
});

// ---------- D-168 / D-190：门①「产品面」17dz 口径 ----------

const PLATFORM_NAME = /17dz/;

describe('D-168/D-190 · 17dz 三张脸分别计数（登记行守卫，不裁定口径）', () => {
  const codeRoots = ['packages', 'apps', 'scripts'] as const;

  it('packages/apps 非测试文件：17dz 零命中', () => {
    const files = walk(codeRoots, undefined, (rel) => (!rel.startsWith('packages/') && !rel.startsWith('apps/')) || rel.endsWith('.test.ts'));
    expect(lineHits(files, PLATFORM_NAME)).toEqual([]);
  });

  it('*.test.ts 面 = 2 行 1 文件（payload-oneof.test.ts）', () => {
    const files = walk(codeRoots, undefined, (rel) => !rel.endsWith('.test.ts'));
    expect(lineHits(files, PLATFORM_NAME)).toEqual([
      'packages/agent/payload-oneof.test.ts:2',
      'packages/agent/payload-oneof.test.ts:23',
    ]);
  });

  it('scripts/ 非测试面 = 1 行 1 文件（真实执行层只读冒烟准备档；口径存疑点）', () => {
    const files = walk(codeRoots, undefined, (rel) => !rel.startsWith('scripts/') || rel.endsWith('.test.ts'));
    expect(lineHits(files, PLATFORM_NAME)).toEqual(['scripts/eval/real/smoke.ts:4']);
  });

  it('反向绊线：三张脸的扫描器各认到一个现存对照词', () => {
    expect(lineHits(['packages/agent/payload-oneof.test.ts'], PLATFORM_NAME).length).toBe(2);
    expect(lineHits(['scripts/eval/real/smoke.ts'], PLATFORM_NAME).length).toBe(1);
  });
});

// ---------- D-170：exposure-lint 剩余核对与扩展 ----------

describe('D-170 · 三个旧守卫文件均不在树内（登记行守卫）', () => {
  it('exposure-lint / platform-leak-lint / history-hygiene 测试文件不存在', () => {
    expect(exists('packages/agent/exposure-lint.test.ts')).toBe(false);
    expect(exists('packages/agent/platform-leak-lint.test.ts')).toBe(false);
    expect(exists('packages/agent/history-hygiene.test.ts')).toBe(false);
  });

  it('身份面守卫 execution-identity-surface.test.ts 同批不在树内（门④三道守卫俱删）', () => {
    expect(exists('packages/agent/execution-identity-surface.test.ts')).toBe(false);
  });

  it('删除记录在 decision-log 可考（Reset 提交 + owner 待裁定两句都在）', () => {
    const log = read('docs/history/decision-log-part01-2026-11_undated.md');
    expect(log).toContain('platform-leak-lint.test.ts');
    expect(log).toContain('0b97227');
    expect(log).toContain('恢复最小闭集守卫或改 D-209 闭环判据属 owner 待裁定');
  });

  it('反向绊线：现存对照词被扫描器认到（证明存在性断言不是恒过）', () => {
    expect(exists('packages/agent/step-text.test.ts')).toBe(true);
  });
});

// ---------- D-196：退役 FSHINE_PLATFORM_ROOT（2026-11-24 结案） ----------

const PLATFORM_ROOT = /FSHINE_PLATFORM_ROOT/;

describe('D-196 · FSHINE_PLATFORM_ROOT 代码面零命中（结案守卫）', () => {
  it('docs/ 之外（代码/配置/CI/README/AGENTS）零命中', () => {
    const files = walk(['packages', 'apps', 'scripts', 'config', 'tests', '.github', 'patches', 'README.md', 'AGENTS.md', 'package.json']);
    expect(lineHits(files, PLATFORM_ROOT)).toEqual([]);
  });

  it('history 档案面 = 8 行（过程史不重写；行数变了就红）', () => {
    expect(lineHits(walk(['docs/history']), PLATFORM_ROOT).length).toBe(8);
  });

  it('统一配置解析继任者在树内（explicitConfigFrom）', () => {
    expect(exists('scripts/resolve-config-path.ts')).toBe(true);
    expect(read('scripts/resolve-config-path.ts')).toContain('export function explicitConfigFrom');
  });

  it('反向绊线：档案面抽样命中（证明扫描器活着）', () => {
    expect(lineHits(['docs/history/change-safety-part03-2026-11.md'], PLATFORM_ROOT).length).toBe(1);
  });
});

// ---------- D-204：dummy 两套 commit 令牌契约不一致（登记行守卫：统一即红） ----------

describe('D-204 · dummy.cjs 两套 commit 令牌契约仍不一致（未统一，现状钉住）', () => {
  const src = read('scripts/eval/fixtures/dummy-platform/bin/dummy.cjs');

  it('proposal-commit 路径：verifyProposalToken 函数体不读 script 字段', () => {
    const start = src.indexOf('function verifyProposalToken');
    const end = src.indexOf('\nfunction ', start + 1);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('script');
  });

  it('proposal-commit 令牌门 fail-closed（!verifyProposalToken），注释自述两者不一致已登记', () => {
    expect(countMatches(src, /if \(!verifyProposalToken\(/g)).toBe(1);
    expect(src).toContain('两者不一致已登记 debt-ledger');
  });

  it('dummy.commit 直提两处：if (secret) 有门才验 + 多一项 p.script === op.name', () => {
    expect(countMatches(src, /^ +if \(secret\) \{$/gm)).toBe(2);
    expect(countMatches(src, /p\.script === op\.name/g)).toBe(2);
  });

  it('反向绊线：两个契约形状的差异可被机械认出（拿现存的 fail-closed 门当对照）', () => {
    expect(countMatches(src, /if \(!verifyProposalToken\(/g)).toBe(1);
    expect(countMatches('x\n      if (secret) {\ny\n      if (secret) {\n', /^ +if \(secret\) \{$/gm)).toBe(2);
  });
});

// ---------- §二 指针有效性：file:LINE 真实存在且行号不越界 ----------

const PTR_TOKEN = /^(?<path>[^\s`]+\.(?:ts|cjs|mjs|js|json|md|sh|ya?ml))(?::(?<start>\d+)(?:-(?<end>\d+))?)?$/;

/**
 * 行内归档/删除标记：台账行引用**已删对象**当证据时（如 D-170 引 exposure-lint.test.ts
 * 证明它不在树内），该行带这些标记即豁免存在性断言——与 docs-guard 检查 2/5 的
 * ARCHIVE_MARKERS 同思路（按行标记，不建目标白名单）。豁免只免「不存在」：
 * 目标文件若在，行号越界照判（表格行是单行，一行里既有删文件引用又有真指针，
 * 2026-11-24 实测踩过：整行豁免会把真指针一起放掉）。
 */
const DELETION_MARKERS = ['已删', '不存在', '不在树内', 'ls 实测', 'git 历史', '跨仓'];

/** 台账在 docs/decisions/ 下；`../` 相对它解析，其余相对仓根。 */
function resolvePointerPath(p: string): string {
  return p.startsWith('../') ? path.posix.normalize(path.posix.join('docs/decisions', p)) : path.posix.normalize(p);
}

/** 返回问题描述；不是指针、或校验通过，返回 null。 */
function pointerProblem(token: string, line: string): string | null {
  const m = PTR_TOKEN.exec(token.trim());
  if (!m) return null;
  const rel = resolvePointerPath(m.groups!.path!);
  if (!exists(rel)) {
    return DELETION_MARKERS.some((marker) => line.includes(marker)) ? null : `${token} → ${rel} 不存在`;
  }
  if (m.groups!.start === undefined) return null;
  const lines = read(rel).split('\n').length;
  const start = Number(m.groups!.start);
  const end = m.groups!.end === undefined ? start : Number(m.groups!.end);
  if (start < 1 || end < start || end > lines) return `${token} → 行号越界（${rel} 共 ${lines} 行）`;
  return null;
}

describe('§二 指针有效性（闭环判据：每个 file:LINE 真实存在且不越界）', () => {
  function sectionTwo(): string {
    const text = read(DEBT_MD);
    const a = text.indexOf('## 二、');
    const b = text.indexOf('## 三、');
    expect(a, 'debt.md 缺少「## 二、」节').toBeGreaterThanOrEqual(0);
    expect(b, 'debt.md 缺少「## 三、」节').toBeGreaterThan(a);
    return text.slice(a, b);
  }

  it('§二 全部反引号 file:LINE 指针通过校验', () => {
    const problems: string[] = [];
    for (const line of sectionTwo().split('\n')) {
      for (const token of line.match(/`([^`]+)`/g) ?? []) {
        const problem = pointerProblem(token.slice(1, -1), line);
        if (problem) problems.push(problem);
      }
    }
    expect(problems, `debt.md §二 指针问题：\n${problems.join('\n')}`).toEqual([]);
  });

  it('反向绊线：校验器对合成坏指针报错（不存在文件 / 越界行号 / 反向区间）', () => {
    expect(pointerProblem('packages/agent/src/nope.ts:1', '')).toMatch(/不存在/);
    expect(pointerProblem('packages/agent/src/step-text.ts:99999', '')).toMatch(/越界/);
    expect(pointerProblem('packages/agent/src/step-text.ts:53-51', '')).toMatch(/越界/);
    expect(pointerProblem('packages/agent/src/step-text.ts:51-53', '')).toBeNull();
    expect(pointerProblem('不是指针的 token', '')).toBeNull();
    // 删除标记行豁免（引用已删对象当证据的形态）
    expect(pointerProblem('packages/agent/exposure-lint.test.ts', '该文件已不存在（ls 实测）')).toBeNull();
  });
});
