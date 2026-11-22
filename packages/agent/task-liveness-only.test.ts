/**
 * 绊线：task 没有 status/outcome，只留 liveness（宿主守护状态）与账本事实。
 *
 * 设计见 docs/design/task-redefinition.md：task = 账本事实 + liveness + worker 汇报。
 * §3 明确**唯一保留的投影是 liveness 三值**（running/died/waiting_user）；任何把账本事实
 * 投影成一个「任务级状态词」的中间层都必须删。
 *
 * 本守卫是**结构性判据**（不是精确名列表——改名搬移的同形函数一律拦）：
 *   ① 名字族：一个函数名里同时出现 `task` 与 `status/state/outcome`，且自身 return 出任务
 *      生命周期词 → 命中（taskStatusOf / observedTaskStatusOf / muTaskStateOf / TaskStateWord …）；
 *   ② 形状族：一个函数读了 ≥3 个账本事实字段（cancelledAt/diedAt/timedOutAt/resourceLimitedAt/
 *      pendingQuestion/runningSince/leaseUntil/resultText/replyText/executions），又 return 出 ≥4 个
 *      互不相同的任务生命周期词（queued/running/waiting_user/died/cancelled/timed_out/
 *      resource_limited/failed/completed）→ 命中——这正是「账本事实 → 任务级状态词」投影的形状。
 *   ③ task_status 投影只返回 liveness + 账本事实，键名不得出现 status/state/outcome。
 *   ④ 反向绊线：把同形投影重新放进源码，扫描器必须报红（证明守卫不是永绿）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createSession } from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry, type TaskScope } from './src/task-registry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 任务生命周期状态词（离散、互斥）——只有「任务级状态投影」才会成组 return 这些词。 */
const LIFECYCLE_WORDS = new Set([
  'queued',
  'running',
  'waiting_user',
  'died',
  'cancelled',
  'canceled',
  'timed_out',
  'resource_limited',
  'failed',
  'completed',
]);

/** 账本事实字段名（宿主守护事实 + 汇报存档 + 执行清单）。 */
const LEDGER_FACT_NAMES = new Set([
  'cancelledAt',
  'timedOutAt',
  'resourceLimitedAt',
  'diedAt',
  'pendingQuestion',
  'runningSince',
  'leaseUntil',
  'resultText',
  'replyText',
  'executions',
]);

const SHAPE_WORD_THRESHOLD = 4;
const SHAPE_FACT_THRESHOLD = 3;

/** 名字族：函数名里 `task` 与 `status|state|outcome` 同现（大小写敏感的 CamelCase 段）。 */
const TASK_WORD_NAME_RE = /[Tt]ask[A-Za-z_$]*(?:Status|State|Outcome)|(?:Status|State|Outcome)[A-Za-z_$]*?[Tt]ask/;

/** 扫描范围（产品面 + 消费方 + 测试/评测）。 */
const SCAN_DIRS = ['apps', 'packages', 'scripts'];

/** 递归列 .ts/.tsx（不用 shell；确定性）。 */
function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      out.push(...listTs(full));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
}

/** 函数**自身**（不下潜到内层函数）的 return 生命周期词 + 读到的账本事实字段。 */
function ownReturnsAndFactReads(fn: ts.Node): { words: Set<string>; facts: Set<string> } {
  const words = new Set<string>();
  const facts = new Set<string>();
  const collectExpr = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (LIFECYCLE_WORDS.has(node.text)) words.add(node.text);
    }
    ts.forEachChild(node, collectExpr);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) collectExpr(node.expression);
    if (ts.isPropertyAccessExpression(node) && LEDGER_FACT_NAMES.has(node.name.text)) facts.add(node.name.text);
    if (ts.isPropertyAssignment(node) && LEDGER_FACT_NAMES.has(node.name.getText())) facts.add(node.name.getText());
    // 不下潜内层函数：返回值/事实读取归属最内层函数。
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  // 从函数体遍历（跳过函数自身的名字/参数）。
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) walk(body);
  return { words, facts };
}

function declaredName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text;
  if (ts.isArrowFunction(node)) return undefined;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

/** 函数名（含 `const x = () => {}` 的变量名）。 */
function functionName(node: ts.Node): string | undefined {
  const direct = declaredName(node);
  if (direct !== undefined) return direct;
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/**
 * 扫描器（纯函数，供反向绊线自证）：返回命中的文件与命中点。
 * ①（名字族 + 有生命周期词 return）与 ②（形状族）各自独立，任一命中即报。
 */
export function findForbiddenProjections(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const name = functionName(node);
        const { words, facts } = ownReturnsAndFactReads(node);
        if (name !== undefined && TASK_WORD_NAME_RE.test(name) && words.size >= 1) {
          hits.push({ file, hit: `name:${name}(${[...words].sort().join(',')})` });
        }
        if (words.size >= SHAPE_WORD_THRESHOLD && facts.size >= SHAPE_FACT_THRESHOLD) {
          hits.push({ file, hit: `shape:${name ?? '<anonymous>'}(${[...words].sort().join(',')})` });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return hits;
}

describe('删投影：只留 liveness + 账本事实', () => {
  it('① 源码不再有任务级状态词投影（名字族 / 形状族），旧测试投影模块已删除', () => {
    const sources = new Map<string, string>();
    for (const dir of SCAN_DIRS) {
      for (const file of listTs(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        // 本守卫自身含被判词串，排除自身。
        if (rel === 'packages/agent/task-liveness-only.test.ts') continue;
        sources.set(rel, readFileSync(file, 'utf8'));
      }
    }
    expect(findForbiddenProjections(sources)).toEqual([]);
    expect(existsSync(path.join(ROOT, 'packages/agent/testing/task-fact-view.ts'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'scripts/eval/task-observation.ts'))).toBe(false);
  });

  it('② task-registry 只导出 liveness 三值，没有状态词/状态枚举', () => {
    const source = readFileSync(path.join(ROOT, 'packages/agent/src/task-registry.ts'), 'utf8');
    expect(source).toContain("export type TaskLiveness = 'running' | 'died' | 'waiting_user';");
    expect(source).not.toMatch(/export type TaskStateWord/u);
    expect(source).not.toMatch(/export (type|enum) Task(State|Status)\b/u);
  });

  it('③ task_status 投影只返回 liveness + 账本事实 + replyText（无 status/state/outcome 键）', async () => {
    const scope: TaskScope = { principalId: 'wecom:liveness', sessionId: 'conv-liveness' };
    const registry: TaskRegistry = createTaskRegistry();
    registry.begin({ taskId: 'task_liveness', principalId: scope.principalId, sessionId: scope.sessionId, request: '查一下窗口 W202611' });
    registry.waitForUser('task_liveness', { missing: ['窗口编号'] });

    let captured: Record<string, unknown> | undefined;
    const mainDriver: TurnDriver = {
      async run(input) {
        captured = await input.exec('task_status', { ref: 'task_liveness' }) as Record<string, unknown>;
        return { text: '（测试回合）', messages: [] };
      },
    };
    const client: ExecutionClient = {
      async capabilities(): Promise<CapabilityManifest> {
        return { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
      },
      async execute(): Promise<ExecutionOutcome> {
        return { status: 'completed', data: {} };
      },
    };
    const session = await createSession({
      principalId: scope.principalId,
      sessionId: scope.sessionId,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver,
      workerDriver: { async run() { throw new Error('（测试）Worker 不应被调用'); } },
      mainSystemPrompt: '（测试）Main 系统提示',
      taskRegistry: registry,
    });
    await session.send('看看那个任务');

    expect(captured).toBeDefined();
    const keys = Object.keys(captured!);
    expect(keys.filter((key) => /^(status|state|outcome|stateWord|factKey)$/u.test(key))).toEqual([]);
    const liveness = captured!['liveness'];
    if (liveness !== undefined) expect(['running', 'died', 'waiting_user']).toContain(liveness);
    expect(captured!['pendingQuestion']).toBeDefined();
    expect(captured!['claimed']).toBe(0);
    expect(captured!['resulted']).toBe(0);
  });

  it('④ 反向绊线：同形投影重新放回源码，扫描器必须报红', () => {
    // 名字族：改名搬移（不同名字、同一 family，函数自身 return 生命周期词）。
    const byName = findForbiddenProjections(new Map([
      ['packages/agent/src/x.ts', `export function observedTaskStatusOf(task: { cancelledAt?: string }): string { return task.cancelledAt !== undefined ? 'cancelled' : 'completed'; }`],
      ['scripts/y.ts', `const taskStateWordOf = (task: { diedAt?: string }): string => (task.diedAt !== undefined ? 'failed' : 'completed');`],
    ]));
    expect(byName.some((hit) => hit.hit.startsWith('name:'))).toBe(true);

    // 形状族：换名（不含 task+status/state/outcome 字样）但保留「账本事实 → 状态词」形状。
    const byShape = findForbiddenProjections(new Map([
      ['scripts/z.ts', `
        export function observe(task: { cancelledAt?: string; diedAt?: string; executions?: { status: string }[] }): string {
          if (task.cancelledAt !== undefined) return 'cancelled';
          if (task.diedAt !== undefined) return 'failed';
          const last = task.executions?.[0]?.status;
          if (last === 'accepted') return 'running';
          if (last === undefined) return 'queued';
          return 'completed';
        }`],
    ]));
    expect(byShape.some((hit) => hit.hit.startsWith('shape:'))).toBe(true);

    // 负例对照一类：liveness 投影（只 running/died/waiting_user 三值）不得报红。
    const livenessOnly = findForbiddenProjections(new Map([
      ['packages/agent/src/task-registry.ts', `
        export type TaskLiveness = 'running' | 'died' | 'waiting_user';
        export function taskLivenessOf(task: { cancelledAt?: string; diedAt?: string; pendingQuestion?: unknown }): TaskLiveness | undefined {
          if (task.cancelledAt !== undefined) return undefined;
          if (task.diedAt !== undefined) return 'died';
          if (task.pendingQuestion !== undefined) return 'waiting_user';
          return 'running';
        }`],
    ]));
    expect(livenessOnly).toEqual([]);

    // 负例对照二类：产品工具 / 执行层类型（名字含 task+status/outcome，但不是账本投影）不得报红。
    const product = findForbiddenProjections(new Map([
      ['packages/agent/src/execution-runtime.ts', `
        function taskStatus(args: Record<string, unknown>): unknown { return statusView(args); }
        function taskStatusTool(): DiscoveredTool { return { name: 'task_status' } as DiscoveredTool; }`],
    ]));
    expect(product).toEqual([]);
  });
});
