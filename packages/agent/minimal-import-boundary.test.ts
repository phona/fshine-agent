/**
 * 最小切片静态 import 图检查（依赖方向 + 无旧治理模块）。
 *
 * 用 TS 编译器 API 解析六个入口文件的 import/export 边，按值边（运行期保留）做
 * 传递闭包，type-only 边只登记不遍历（编译期擦除）。断言：
 *   ① 值闭包不触及旧 Runtime 治理模块清单里的任何文件；
 *   ② 执行契约模块零 import（无传输实现）；
 *   ③ 通用运行时（execution-runtime）的值闭包不含 CLI 适配器（依赖方向：适配器单向依赖契约）；
 *   ④ 装配入口同时到达通用运行时与适配器（接线完整性 sanity）。
 *
 * 闭包以 JSON 单行打印，作为评审时的静态证据。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ENTRIES = [
  'packages/contracts/src/execution-contract.ts',
  'packages/agent/src/minimal/worker-env.ts',
  'packages/agent/src/minimal/task-registry.ts',
  'packages/agent/src/minimal/task-registry-sqlite.ts',
  'packages/agent/src/minimal/execution-runtime.ts',
  'packages/agent/src/minimal/dummy-cli-client.ts',
  // U2/U3 入口同受边界约束：新增装配不得以值边触及旧治理模块。
  'scripts/ask-minimal.ts',
  'apps/server/minimal-server.ts',
] as const;

const CONTRACT = 'packages/contracts/src/execution-contract.ts';
const RUNTIME = 'packages/agent/src/minimal/execution-runtime.ts';
const ADAPTER = 'packages/agent/src/minimal/dummy-cli-client.ts';
const ENTRY_SCRIPT = 'scripts/ask-minimal.ts';

/** 旧 Runtime 治理模块清单（M1 最小路径不得以值边触及）。 */
const FORBIDDEN = new Set([
  'packages/agent/src/runtime.ts',
  'packages/agent/src/plan-runtime.ts',
  'packages/agent/src/serve-gate.ts',
  'packages/agent/src/turn-contract.ts',
  'packages/agent/src/session-entities.ts',
  'packages/agent/src/clarification-events.ts',
  'packages/agent/src/error-codes.ts',
  'packages/agent/src/task-manager.ts',
  'packages/agent/src/pi-coding-driver.ts',
  'packages/agent/src/context.ts',
  'packages/agent/src/turn-state.ts',
  'packages/agent/src/turn-exit.ts',
  'packages/agent/src/turn-relay.ts',
  'packages/agent/src/turn-context.ts',
  'packages/agent/src/turn-persistence.ts',
  'packages/agent/src/failure-delivery.ts',
  'packages/agent/src/platform-contract.ts',
  'packages/agent/src/platform-entities.ts',
  'packages/agent/src/operation-labels.ts',
  'packages/agent/src/execution-language.ts',
  'packages/agent/src/execution-scope.ts',
  'packages/agent/src/reply-exit.ts',
  'packages/agent/src/repeat-request.ts',
  'packages/agent/src/resend-tool.ts',
  'packages/agent/src/task-control.ts',
  'packages/agent/src/task-handover.ts',
  'packages/agent/src/task-stall.ts',
  'packages/agent/src/freeze-task-inputs.ts',
  'packages/agent/src/committed-unverified.ts',
  'packages/agent/src/protocol-material.ts',
  'packages/agent/src/runtime-quality.ts',
  'packages/agent/src/tool-definition-guard.ts',
  'packages/agent/src/delegation-failure.ts',
  'packages/agent/src/worker-step-cap.ts',
  'packages/agent/src/budget-policy.ts',
  'packages/agent/src/task-budget.ts',
  'packages/agent/src/platform-execution-gate.ts',
  'packages/agent/src/scratch-cleanup.ts',
  'packages/agent/src/message-reference.ts',
  'packages/agent/src/session.ts',
  'packages/agent/src/plan-facts.ts',
  'packages/agent/src/plan-steps.ts',
  'packages/agent/src/plan-binding.ts',
  'packages/agent/src/plan-confirmation.ts',
  'packages/agent/src/proposal-runtime.ts',
  'packages/agent/src/proposal-review.ts',
  'packages/agent/src/result-contract.ts',
  'apps/server/assembly.ts',
  'apps/server/handler.ts',
]);

const ALIASES: Record<string, string> = {
  '@fshine/contracts/execution-contract': 'packages/contracts/src/execution-contract.ts',
  '@fshine/contracts': 'packages/contracts/src/index.ts',
  '@fshine/agent': 'packages/agent/src/index.ts',
  '@fshine/core': 'packages/core/src/index.ts',
};

interface Edge {
  from: string;
  specifier: string;
  typeOnly: boolean;
  /** 解析到的仓库内文件（相对仓根）；外部包/node 内建为 undefined。 */
  to?: string;
}

function rel(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function importsOf(absoluteFile: string): Array<{ specifier: string; typeOnly: boolean }> {
  const source = ts.createSourceFile(absoluteFile, readFileSync(absoluteFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Array<{ specifier: string; typeOnly: boolean }> = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      let typeOnly = clause?.isTypeOnly === true;
      if (clause && !typeOnly && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        // 全部分项都带 type → 该 import 整体被擦除。
        typeOnly = clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every((element) => element.isTypeOnly);
      }
      found.push({ specifier: statement.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      found.push({ specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly === true });
    }
  }
  return found;
}

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`最小路径 import 图无法解析：${specifier}（from ${rel(fromFile)}）`);
  }
  const mapped = ALIASES[specifier];
  return mapped === undefined ? undefined : path.join(REPO_ROOT, mapped);
}

function edgesOf(absoluteFile: string): Edge[] {
  return importsOf(absoluteFile).map((entry) => {
    const to = resolveSpecifier(entry.specifier, absoluteFile);
    return {
      from: rel(absoluteFile),
      specifier: entry.specifier,
      typeOnly: entry.typeOnly,
      ...(to !== undefined ? { to: rel(to) } : {}),
    };
  });
}

/** 从入口出发按**值边**做传递闭包。 */
function valueClosure(entryRels: readonly string[]): { files: Set<string>; edges: Edge[] } {
  const files = new Set<string>();
  const edges: Edge[] = [];
  const queue = entryRels.map((entry) => path.join(REPO_ROOT, entry));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentRel = rel(current);
    if (files.has(currentRel)) continue;
    files.add(currentRel);
    for (const edge of edgesOf(current)) {
      edges.push(edge);
      if (edge.typeOnly || edge.to === undefined || files.has(edge.to)) continue;
      queue.push(path.join(REPO_ROOT, edge.to));
    }
  }
  return { files, edges };
}

describe('最小切片 import 图', () => {
  it('值闭包不触及旧治理模块；适配器单向依赖契约；契约零 import', () => {
    const { files, edges } = valueClosure(ENTRIES);
    console.log(JSON.stringify({ event: 'minimal_value_closure', files: [...files].sort() }));

    const forbiddenHits = [...files].filter((file) => FORBIDDEN.has(file));
    expect(forbiddenHits, `最小路径值边触及旧治理模块：${forbiddenHits.join(', ')}`).toEqual([]);

    // ② 执行契约零 import（无传输实现；也不含 node: 内建导入）。
    const contractText = readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf8');
    expect(contractText).not.toMatch(/from\s+'node:/);
    expect(importsOf(path.join(REPO_ROOT, CONTRACT))).toEqual([]);

    // ③ 通用运行时值闭包不含 CLI 适配器。
    const runtimeClosure = valueClosure([RUNTIME]);
    expect([...runtimeClosure.files]).not.toContain(ADAPTER);
    expect(runtimeClosure.edges.some((edge) => edge.specifier === 'node:child_process')).toBe(false);

    // ④ 装配入口同时到达通用运行时与适配器（接线完整性）。
    expect(files.has(RUNTIME)).toBe(true);
    expect(files.has(ADAPTER)).toBe(true);
    expect(files.has(ENTRY_SCRIPT)).toBe(true);

    // type-only 边全部落在标注列表内（打印供评审，不断言具体成员）。
    const typeOnlyTargets = [...new Set(edges.filter((edge) => edge.typeOnly).map((edge) => edge.to ?? edge.specifier))].sort();
    console.log(JSON.stringify({ event: 'minimal_type_only_edges', targets: typeOnlyTargets }));
  });
});
