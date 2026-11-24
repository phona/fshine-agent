/**
 * 死代码重复实现收敛守卫（issue #72：8 组重复实现「每组择一」+ `missingSimKinds` 接线）。
 *
 * 为什么需要它：重复实现不是「看起来脏」，而是**下一次只改一份**——两份 `errorText`
 * 早晚会长成两种行为，而两侧的测试各自全绿。靠人工审查抓不到「又抄了一份」。本守卫把
 * 「这些名字在全仓的定义点集合」钉成一张显式表：新增一份定义即红，删错一份也红。
 *
 * 判据（机械事实，不判语义）：
 *   · **定义点集合**：对每个名字，用 TS AST 收集**全部**跟踪 `.ts` 文件里的函数声明
 *     （含嵌套函数；注释与字符串不会误伤，与 `transition-naming.test.ts` 同法）；
 *   · **导出面**：合并后的唯一实现必须 `export`——否则其它文件只能再抄一份；
 *   · **锁死面**（有意镜像）：两份实现的函数体归一化空白后必须逐字相同，且镜像方必须
 *     自带指向唯一实现的注释（否则下一个人会以为它是漏网的重复）；
 *   · **冻结面**：`convergence-r1/hash.ts` 的 `sha256Hex` 签名与「eval 树从它 import」
 *     的事实被钉住——按 eval 锁不动，不并进 ask 面；
 *   · **倒置依赖面**：被锁死的跨层镜像，必须仍不存在会让依赖方向倒过来的值 import 边；
 *   · **现状陈述一致面**：`AGENTS.md` 的未决项清单与 `debt.md` 的 #72 状态必须同侧
 *     （代码收敛了、文档还写着未决，等于给下一个人留假现状）。
 *
 * 扫描范围 = `git ls-files -- '*.ts'` 的跟踪文件（排除守卫自身；结果与工作区清洗状态
 * 无关）。`.test.ts` 里的本地夹具同样在表内——它们是刻意的测试内复刻，写进表就是登记，
 * ≠ 生产面又抄一份。
 *
 * 窄豁免（需理由，逐条注明）：`scripts/eval/**` 与 `scripts/eval/cap01/**` 下的历史
 * 夹具副本签名不同（`jsonSafe<T>(value: T): T`）、归属不同跑批器，不在 #72 的 8 组清单内；
 * 登记在此表 = 已知未合并，不假装已清零。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GUARD_FILE = 'packages/agent/dead-code-merge.test.ts';

interface Site {
  readonly file: string;
  readonly exported: boolean;
  /** 签名原文（`export` 修饰符之后到 `{` 之前；用于冻结签名断言）。 */
  readonly signature: string;
  /** 函数体原文（空白归一化后：换行/缩进差异不算差异）。 */
  readonly body: string;
}

/** 归一化：把一切空白折叠成单空格——只抹排版，不动语义 token。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trackedTsFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '--', '*.ts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== GUARD_FILE);
}

/** 全仓收集某个名字的函数声明（含嵌套；AST 法，注释/字符串不误伤）。 */
const DECLARATION_CACHE = new Map<string, readonly Site[]>();

function declarationsOf(name: string): readonly Site[] {
  const cached = DECLARATION_CACHE.get(name);
  if (cached !== undefined) return cached;
  const sites: Site[] = [];
  for (const file of trackedTsFiles()) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        const exported = (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        sites.push({
          file,
          exported,
          signature: normalize(node.getText(source).replace(/^(export\s+)?function\s+/, '').split('{')[0] ?? ''),
          body: normalize(node.body?.getText(source) ?? ''),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  DECLARATION_CACHE.set(name, sites);
  return sites;
}

/** 声明点集合必须恰好等于期望表（文件 → 是否导出）。 */
function expectSites(name: string, expected: Readonly<Record<string, boolean>>): void {
  const sites = declarationsOf(name);
  const actual: Record<string, boolean> = {};
  for (const site of sites) actual[site.file] = site.exported;
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [file, exported] of Object.entries(expected)) {
    expect({ file, exported: actual[file] }).toEqual({ file, exported });
  }
}

/** 只取某个文件里的那一份实现（不存在即算失败，报错信息里带上实际集合）。 */
function siteIn(name: string, file: string): Site {
  const site = declarationsOf(name).find((candidate) => candidate.file === file);
  if (site === undefined) throw new Error(`${name} 在 ${file} 没有定义（实际：${declarationsOf(name).map((s) => s.file).join(', ')}）`);
  return site;
}

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** 某文件是否以**值边** import 了目标模块（`import type` 不计——编译期擦除）。 */
function hasValueImport(file: string, moduleSpecifier: string): boolean {
  const text = sourceOf(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier.getText(source).replace(/['"]/g, '');
      if (specifier === moduleSpecifier) {
        // `import type {...}` 整句是 type-only；`import { type X }` 的命名符逐个看。
        if (node.importClause !== undefined && node.importClause.isTypeOnly) return;
        const bindings = node.importClause?.namedBindings;
        if (bindings === undefined || ts.isNamespaceImport(bindings)) {
          found = true; // 缺省导入 / `import * as ns`
        } else if (ts.isNamedImports(bindings)) {
          if (bindings.elements.some((element) => !element.isTypeOnly)) found = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// 合并组：#72 清单里的重复实现在全仓只剩一份，且那份是导出的
// ─────────────────────────────────────────────────────────────────────────────

describe('issue #72 · 合并组：全仓只剩一份定义，且唯一实现可被 import', () => {
  it('errorText：6 份合并为 1 份（run-dir-cleanup 导出）', () => {
    // 原 6 份：run-dir-cleanup / file-ref-cleanup / cleanup-runs / ops / tasks / startup-sweep。
    expectSites('errorText', { 'packages/agent/src/run-dir-cleanup.ts': true });
    // ops 不直接引用清理执行器（`scripts/cleanup-runs.test.ts` 的接线边界：ops 只经
    // `./tasks` 转取这段原文）。这条断言把「为什么 ops 走转出口」钉在本表旁边，
    // 免得后来者为了少一层转手把边界放宽。
    expect(sourceOf('scripts/ops.ts')).not.toContain('run-dir-cleanup');
    expect(sourceOf('scripts/ops.ts')).toContain("} from './tasks';");
    expect(sourceOf('scripts/tasks.ts')).toContain('export { errorText };');
  });

  it('isInside：3 份合并为 1 份（skills 导出）', () => {
    // 原 3 份：file-store（嵌套）/ skills / sim/skill-telemetry。
    expectSites('isInside', { 'packages/agent/src/skills.ts': true });
  });

  it('stripQuotes：2 份合并为 1 份（skills 导出）', () => {
    // 原 2 份：agent-profile（正则）/ skills（首尾判断）。
    expectSites('stripQuotes', { 'packages/agent/src/skills.ts': true });
  });

  it('jsonSafe：ask 面 2 份合并为 1 份（ask-trace 导出）；eval 历史夹具副本另行登记', () => {
    // 原 ask 面 2 份：ask-replay / ask-trace。eval 树 6 份签名不同（`jsonSafe<T>(v:T):T`），
    // 归属不同跑批器，不在 #72 清单内——登记 ≠ 已合并。
    expectSites('jsonSafe', {
      'scripts/ask-trace.ts': true,
      'scripts/eval/business-e2e/experiments/executor.ts': false,
      'scripts/eval/business-e2e/model-executor.ts': false,
      'scripts/eval/business-e2e/spread-axis/executor.ts': false,
      'scripts/eval/pi152-stageD/run.ts': false,
      'scripts/eval/pi152-stageD/harness.ts': false,
      'scripts/eval/pi152-stageD2/run.ts': false,
    });
  });

  it('sha256Hex：ask 面 2 份合并为 1 份；冻结件与测试夹具原位登记', () => {
    // 原 ask 面 2 份：ask-replay / ask-trace → 合入 ask-trace。
    // convergence-r1/hash.ts 按 eval 锁不动（见下方冻结组断言）。
    expectSites('sha256Hex', {
      'scripts/ask-trace.ts': true,
      'scripts/eval/convergence-r1/hash.ts': true,
      'packages/agent/reply-archive.test.ts': false,
      'scripts/p0-runner-lock.test.ts': false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 锁死组：有意镜像（#72 允许的第二种择一方式）——逐字同实现 + 注释指向唯一实现
// ─────────────────────────────────────────────────────────────────────────────

describe('issue #72 · 锁死组：有意镜像逐字同实现，且注释指向唯一实现', () => {
  it('isRecord ×2（agent ↔ core）：归一化后逐字相同，镜像方注明理由', () => {
    const agent = siteIn('isRecord', 'packages/agent/src/session-persistence.ts');
    const core = siteIn('isRecord', 'packages/core/src/config.ts');
    expect(agent.body).toBe(core.body);
    // 合并会让 session-persistence 值 import @fshine/core（barrel 拖进 sqlite/yaml），
    // 而这个模块今天只依赖 node 内建——镜像方必须把这个事实写在代码里，否则下一个人
    // 会以为它是漏网的重复。
    expect(sourceOf('packages/agent/src/session-persistence.ts')).toContain('有意镜像');
    expect(sourceOf('packages/agent/src/session-persistence.ts')).toContain('packages/core/src/config.ts');
    expect(sourceOf('packages/core/src/config.ts')).toContain('有意镜像');
    expect(sourceOf('packages/core/src/config.ts')).toContain('packages/agent/src/session-persistence.ts');
    // 反向绊线：一旦有人把 @fshine/core 接进 session-persistence，说明他选了合并——
    // 那条路会把 core barrel（含 better-sqlite3）拖进 Pi 驱动的导入图，必须先回来改本表。
    expect(hasValueImport('packages/agent/src/session-persistence.ts', '@fshine/core')).toBe(false);
  });

  it('isAbortErrorLike / isAbortError：归一化后逐字相同，且两层之间没有倒置的值 import 边', () => {
    const runtime = siteIn('isAbortErrorLike', 'packages/agent/src/execution-runtime.ts');
    const runner = siteIn('isAbortError', 'packages/agent/src/task-runner.ts');
    expect(normalize(runtime.body)).toBe(normalize(runner.body));
    // 合并要求通用运行时的值图包含后台调度器（或反之），把依赖方向倒过来——两者今天
    // 只有 type-only 边。这两条断言就是「为什么现在是镜像而不是合并」的机械形式。
    expect(hasValueImport('packages/agent/src/execution-runtime.ts', './task-runner')).toBe(false);
    expect(hasValueImport('packages/agent/src/task-runner.ts', './execution-runtime')).toBe(false);
  });

  it('compareSkillNames ×2（生产 ↔ sim 遥测）：逐字相同，且遥测方注明「有意镜像」', () => {
    const production = siteIn('compareSkillNames', 'packages/agent/src/worker-skills.ts');
    const telemetry = siteIn('compareSkillNames', 'scripts/eval/sim/skill-telemetry.ts');
    expect(production.body).toBe(telemetry.body);
    expect(sourceOf('scripts/eval/sim/skill-telemetry.ts')).toContain('有意镜像');
    expect(sourceOf('scripts/eval/sim/skill-telemetry.ts')).toContain('worker-skills.ts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 冻结组：convergence-r1 判据按 eval 锁不动
// ─────────────────────────────────────────────────────────────────────────────

describe('issue #72 · 冻结组：convergence-r1 的 sha256Hex 不动，eval 树仍从它取', () => {
  it('冻结签名与「eval 树唯一来源」的事实被钉住', () => {
    const frozen = siteIn('sha256Hex', 'scripts/eval/convergence-r1/hash.ts');
    expect(frozen.exported).toBe(true);
    // 冻结件的入参形状（`string | Buffer`）与 ask 面那份（`string`）不同——合并即改判据面。
    expect(frozen.signature).toBe('sha256Hex(text: string | Buffer): string');
    expect(hasValueImport('scripts/eval/sim/run.ts', '../convergence-r1/hash')).toBe(true);
    expect(hasValueImport('scripts/eval/sim/skill-telemetry.ts', '../convergence-r1/hash')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// missingSimKinds：接线而非删除（零 import = 又是死代码）
// ─────────────────────────────────────────────────────────────────────────────

describe('issue #72 · missingSimKinds 必须接线进 sim 套件的记账覆盖检查', () => {
  it('run.ts 以值边 import 它（不再是零调用定义）', () => {
    expect(hasValueImport('scripts/eval/sim/run.ts', './accounting')).toBe(true);
    const sites = declarationsOf('missingSimKinds');
    expect(sites.map((site) => site.file)).toEqual(['scripts/eval/sim/accounting.ts']);
    expect(sites[0]!.exported).toBe(true);
  });
});

/**
 * 文档一致性：#72 收敛后，`AGENTS.md` 的「未决项」现状陈述与 `debt.md` 的状态必须同侧。
 *
 * 为什么用文本锚点（而不是更「机械」的判据）：这是**文档一致性**检查，不是行为评估——
 * 两处都是人写的现状陈述，唯一能确定比对的就是字面（`dead-code-audit` 类清单没有结构化
 * 状态字段可读）。它想拦的失败形态是「代码已收敛、文档还把它列为未决」（或反过来），
 * 判①/②判不了：没有机械事实承载「AGENTS.md 认为这项还没做」。
 * 会误伤的 correct 措辞：无——只匹配「结转的未决项」那一段里的主题名。
 * 负例绊线：仍开着的主题必须还在清单里（见 `toContain('会话存储 retention/capacity')`），
 * 防止有人为了过审把整段删掉。
 */
describe('issue #72 · 现状陈述一致：AGENTS.md 未决项清单 ↔ debt.md 状态', () => {
  it('#72 在 debt.md 记为已清，且不再被 AGENTS.md 列为未决项', () => {
    const debtRow = sourceOf('docs/decisions/debt.md')
      .split('\n')
      .find((line) => line.startsWith('| #72 |'));
    expect(debtRow, 'debt.md 必须仍有 #72 这一行').toBeDefined();
    expect(debtRow).toContain('已清');

    const pointer = sourceOf('AGENTS.md')
      .split('\n')
      .find((line) => line.includes('2026-11-18 结转的未决项'));
    expect(pointer, 'AGENTS.md 的 issue 指针段必须在').toBeDefined();
    if (pointer === undefined) return;
    // 未决项清单本体 = 「结转的未决项：」到其后第一个「；」为止。
    const listStart = pointer.indexOf('结转的未决项：');
    const listEnd = pointer.indexOf('；', listStart);
    expect(listStart, '清单分隔符「；」必须在').toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(pointer.slice(listStart, listEnd), '#72 已收敛，不得再留在未决项清单里').not.toContain('死代码重复实现');
    // 反向绊线一：不许靠把整段删掉来免检。
    expect(pointer.slice(listStart, listEnd)).toContain('会话存储 retention/capacity');
    expect(pointer.slice(listStart, listEnd)).toContain('B2 真实租户联调');
    // 反向绊线二：收敛项要显式注在清单后面，不能只是悄悄摘掉（否则读者不知道它去哪了）。
    const note = pointer.slice(listEnd);
    expect(note).toContain('#72');
    expect(note).toContain('收敛');
  });
});
