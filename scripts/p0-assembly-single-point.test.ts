/**
 * P0-T03 单一装配点守卫（静态检查；TDD：实现前红 → P0 装配同源实现后绿）。
 *
 * 为什么需要它：现状 ask/tasks 走 `scripts/ask-runtime.ts`，但 server 与 convergence-r1 runner
 * 各自持有一份装配链（client→只读允许集→底账→技能/角色→createSession）。P0 的目标是
 * 「三入口走同一装配（或同一核心装配），无第二份装配链」——靠人工审查容易回潮，这里把它
 * 变成常驻测试。
 *
 * 判据（只用 AST 的调用/导入事实，不做文本猜测；注释与字符串不计）：
 *  ① 装配链调用（`createSession(` / `createDummyCliClient(` / `readOnlyOperationNames(`）在
 *     生产文件中都恰好只出现在**同一个**文件里（唯一装配模块）；
 *  ② 四个入口（scripts/ask.ts、scripts/tasks.ts、apps/server/server.ts、
 *     scripts/eval/convergence-r1/runner.ts）沿相对导入图（含动态 import）都能到达该模块——
 *     不许旁路另建；
 *  ③ ask/redo 五门拒绝话术的完整短语各只在一个生产文件**字面量**出现（拒绝话术不得被复制；
 *     注释与历史说明不计）；server/runner 各自的装配门方言（已在实现中保留原样）不在此列。
 *
 * 扫描范围 = scripts/apps/packages 下的生产 .ts（排除 *.test.ts、fixtures、.runtime 等）。
 * 现状（实现前）预期红：① server.ts / runner.ts 各持装配链 → 三符号各命中 3 个文件；
 * ② server.ts / runner.ts 不导入共享装配模块。实现后全绿。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['scripts', 'apps', 'packages'] as const;
const SKIP_DIR_NAMES = new Set(['node_modules', '.runtime', '.git', 'fixtures', 'dist', 'out', 'tmp']);

const CHAIN_SYMBOLS = ['createSession', 'createDummyCliClient', 'readOnlyOperationNames'] as const;

/**
 * P0 目标：四个入口同源（ask 单轮、tasks --redo、server、eval runner）。
 * P7a 扩展（2026-11-14，守卫扩展到 ask-first 新入口）：脚本回放与交互式 ask 也必须
 * 沿导入图到达同一装配模块——新入口不许旁路自建 Runtime（P7-T05）。
 */
const ENTRY_FILES = [
  'scripts/ask.ts',
  'scripts/tasks.ts',
  'apps/server/server.ts',
  'scripts/eval/convergence-r1/runner.ts',
  'scripts/ask-replay.ts',
  'scripts/ask-interactive.ts',
] as const;

/** ask/redo 五门话术的完整短语（不含 server/runner 自己的方言串）。 */
const GATE_PHRASES = [
  '需要真实模型（密钥只在 .env，或配置 llm.apiKey）。',
  '最小切片不做多 profile 选择',
  '最小切片需要执行层挂载声明',
  '最小切片需要可信身份来源',
  '最小切片拒绝以空允许集合运行',
] as const;

const sourceCache = new Map<string, ts.SourceFile>();

function sourceOf(relative: string): ts.SourceFile {
  let source = sourceCache.get(relative);
  if (source === undefined) {
    const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(relative, source);
  }
  return source;
}

function productionFiles(): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string): void => {
    const absolute = path.join(REPO_ROOT, relativeDir);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(relative);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      files.push(relative);
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return files.sort();
}

/** 生产文件里对该符号的**调用**次数（AST CallExpression；定义/注释/字符串不计）。 */
function callCount(source: ts.SourceFile, symbol: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === symbol) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function callSiteFiles(symbol: string): string[] {
  return productionFiles().filter((file) => callCount(sourceOf(file), symbol) > 0);
}

/** 相对导入说明符（静态 import/export 与动态 import 都收）。 */
function relativeImports(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

function resolveRelative(fromRelative: string, specifier: string): string | undefined {
  const base = path.resolve(REPO_ROOT, path.dirname(fromRelative), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && candidate.endsWith('.ts')) {
      return path.relative(REPO_ROOT, candidate);
    }
  }
  return undefined;
}

/** 入口沿相对导入图是否可达目标文件（BFS，防环）。 */
function reaches(entry: string, target: string): boolean {
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const specifier of relativeImports(sourceOf(current))) {
      const resolved = resolveRelative(current, specifier);
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return false;
}

/** 生产文件的字符串字面量文本（含模板字符串各段；注释不在内——话术副本只认字面量）。 */
function stringLiteralsOf(source: ts.SourceFile): string[] {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      literals.push(node.head.text);
      for (const span of node.templateSpans) literals.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

function filesContainingPhrase(phrase: string): string[] {
  return productionFiles().filter((file) => stringLiteralsOf(sourceOf(file)).some((literal) => literal.includes(phrase)));
}

describe('P0-T03 单一装配点守卫（ask/server/runner 同一装配，静态检查）', () => {
  it('装配链调用（会话/执行面/只读允许集）只存在于唯一装配模块', () => {
    const bySymbol = new Map<string, string[]>();
    for (const symbol of CHAIN_SYMBOLS) bySymbol.set(symbol, callSiteFiles(symbol));
    console.log(JSON.stringify({
      event: 'p0_single_assembly_callsites',
      files: Object.fromEntries(bySymbol),
    }));
    for (const symbol of CHAIN_SYMBOLS) {
      const files = bySymbol.get(symbol)!;
      expect(files, `${symbol} 出现多份装配（现状=server/runner 各自装配）：${files.join(', ')}`).toHaveLength(1);
    }
    const unique = new Set([...bySymbol.values()].map((files) => files[0]));
    expect([...unique], `装配链符号分属不同文件（存在第二份装配链）：${[...unique].join(', ')}`).toHaveLength(1);
  });

  it('四个入口沿导入图都到达唯一装配模块（无旁路）', () => {
    const assemblyFiles = callSiteFiles('createSession');
    expect(assemblyFiles).toHaveLength(1);
    const assembly = assemblyFiles[0]!;
    for (const entry of ENTRY_FILES) {
      expect(reaches(entry, assembly), `${entry} 未（经相对导入图）到达装配模块 ${assembly}`).toBe(true);
    }
  });

  it('ask/redo 五门话术短语各只在一个生产文件出现（拒绝话术不复制）', () => {
    for (const phrase of GATE_PHRASES) {
      const files = filesContainingPhrase(phrase);
      expect(files, `门话术「${phrase}」出现在多个文件：${files.join(', ')}`).toHaveLength(1);
    }
  });
});
