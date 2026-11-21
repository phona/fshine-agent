/**
 * 模型用量观测装配守卫（静态 AST；owner 2026-11-21 批准的最小方案阶段 2）。
 *
 * 为什么需要它：采集（pi-driver onModelUsage）与落盘（model-usage sink）都有运行时单测，
 * 但「装配处是否真的把 sink 注入到了每个生产驱动」只有静态事实能守——注入被摘掉不会让
 * 任何运行时用例红（测试走 createDrivers 注入的假驱动，缺省装配不经过）。这里把两件事
 * 变成常驻测试：
 *   ① scripts/ask-runtime.ts 的每个 `createPiTurnDriver(` 调用（后台兜底 Worker + 会话缺省
 *      Main/Worker，恰三处）都在选项里注入 `onModelUsage`；
 *   ② apps/server/server.ts 的 `createBackgroundDispatch(` 调用传 `dbPath`——后台兜底
 *      Worker 的 usage.jsonl 才与前台 Main/inline Worker 同一文件（`<dbPath 同目录>/usage.jsonl`）。
 *
 * 判据只用 AST 的调用/属性事实，不做文本猜测；注释与字符串不计。
 * 绊线：去掉任一处注入 / 去掉 dbPath 透传 → 本文件对应用例必红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

function sourceOf(relative: string): ts.SourceFile {
  return ts.createSourceFile(
    relative,
    readFileSync(path.join(REPO_ROOT, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function callsOf(source: ts.SourceFile, calleeName: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      out.push(node);
    }
  });
  return out;
}

/** 首参对象字面量的属性名列表（展开项带 `...` 前缀，不会与目标名相等）。 */
function argumentPropertyNames(call: ts.CallExpression): string[] {
  const first = call.arguments[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) return [];
  return first.properties.map((property) => property.name?.getText() ?? '').filter((name) => name !== '');
}

describe('模型用量观测装配守卫（静态 AST）', () => {
  it('ask-runtime.ts 的每个 createPiTurnDriver 调用都注入 onModelUsage（摘掉注入必红）', () => {
    const driverCalls = callsOf(sourceOf('scripts/ask-runtime.ts'), 'createPiTurnDriver');
    expect(
      driverCalls.length,
      'ask-runtime 生产驱动调用恰三处：后台兜底 Worker + assembleSessionCore 缺省 Main/Worker',
    ).toBe(3);
    for (const call of driverCalls) {
      expect(argumentPropertyNames(call), `createPiTurnDriver(${call.getStart()} 处) 必须注入 onModelUsage`)
        .toContain('onModelUsage');
    }
  });

  it('server.ts 的 createBackgroundDispatch 传 dbPath（后台 Worker 落同一 usage.jsonl）', () => {
    const dispatchCalls = callsOf(sourceOf('apps/server/server.ts'), 'createBackgroundDispatch');
    expect(dispatchCalls.length, 'server 恰一处后台派发装配').toBe(1);
    expect(argumentPropertyNames(dispatchCalls[0]!)).toContain('dbPath');
  });
});
