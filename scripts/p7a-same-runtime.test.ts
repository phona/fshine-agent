/**
 * P7a 同一 Runtime 守卫（扩展 P0-T03 判据到 ask-first 新入口）——测试先行（P7-T05）。
 *
 * 依据：R4 验收设计 P7-T05「交互/回放/生产同装配（复用 P0-T03 守卫）」；owner 接线纪律
 * 「同一 Runtime=共享装配（P0 已合入）+ import 守卫；不建第二套 Runtime」。
 *
 * 判据（AST 事实，不做文本猜测；注释与字符串不计）：
 *  ① P7a 新生产模块都存在（ask-replay / ask-interactive / ask-trace / ask-assert）；
 *  ② 两个新入口（回放、交互）沿相对导入图（含动态 import）都能到达共享装配模块
 *     `scripts/ask-runtime.ts`——不许旁路；
 *  ③ `scripts/ask.ts` 的相对导入同时含 './ask-runtime'、'./ask-interactive'、'./ask-replay'
 *     ——新入口挂钩在 ask.ts，单轮路径仍走共享装配；
 *  ④ 四个新生产文件对装配链符号（createSession / createDummyCliClient / readOnlyOperationNames）
 *     的调用数均为 0——新入口只消费共享装配，不自建 Runtime。
 *
 * 现状（实现前）预期红：新模块尚未落地。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

/** P7a 新生产模块（新增入口与共享小件）。 */
const P7A_MODULES = [
  'scripts/ask-replay.ts',
  'scripts/ask-interactive.ts',
  'scripts/ask-trace.ts',
  'scripts/ask-assert.ts',
] as const;

const ASSEMBLY_MODULE = 'scripts/ask-runtime.ts';
const CHAIN_SYMBOLS = ['createSession', 'createDummyCliClient', 'readOnlyOperationNames'] as const;

const sourceCache = new Map<string, ts.SourceFile>();

function sourceOrFail(relative: string): ts.SourceFile {
  const absolute = path.join(REPO_ROOT, relative);
  if (!existsSync(absolute)) throw new Error(`${relative} 不存在（实现前红：P7a 模块尚未落地）`);
  let source = sourceCache.get(relative);
  if (source === undefined) {
    const text = readFileSync(absolute, 'utf8');
    source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(relative, source);
  }
  return source;
}

/** 生产文件里对该符号的调用次数（AST CallExpression；定义/注释/字符串不计）。 */
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
    if (existsSync(candidate) && candidate.endsWith('.ts')) return path.relative(REPO_ROOT, candidate);
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
    for (const specifier of relativeImports(sourceOrFail(current))) {
      const resolved = resolveRelative(current, specifier);
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return false;
}

describe('P7a 同一 Runtime 守卫（新入口同装配；静态检查）', () => {
  it('P7a 新生产模块存在', () => {
    for (const module of P7A_MODULES) {
      expect(existsSync(path.join(REPO_ROOT, module)), `${module} 不存在（实现前红）`).toBe(true);
    }
  });

  it('回放入口沿导入图到达共享装配模块（scripts/ask-runtime.ts）', () => {
    expect(reaches('scripts/ask-replay.ts', ASSEMBLY_MODULE), 'ask-replay.ts 未接共享装配').toBe(true);
  });

  it('交互入口沿导入图到达共享装配模块（scripts/ask-runtime.ts）', () => {
    expect(reaches('scripts/ask-interactive.ts', ASSEMBLY_MODULE), 'ask-interactive.ts 未接共享装配').toBe(true);
  });

  it('ask.ts 挂钩：单轮仍走共享装配，新入口经 ask.ts 接线', () => {
    const imports = relativeImports(sourceOrFail('scripts/ask.ts'));
    for (const specifier of ['./ask-runtime', './ask-interactive', './ask-replay']) {
      expect(imports, `ask.ts 缺少相对导入 ${specifier}`).toContain(specifier);
    }
  });

  it('新入口不自建装配链（链符号调用数均为 0）', () => {
    for (const module of P7A_MODULES) {
      const source = sourceOrFail(module);
      for (const symbol of CHAIN_SYMBOLS) {
        expect(callCount(source, symbol), `${module} 直接调用 ${symbol}（第二套 Runtime 嫌疑）`).toBe(0);
      }
    }
  });
});
