/**
 * 绊线：task 没有 status/outcome，也没有任何任务级生命周期枚举（2026-11-23 删状态机轮）：
 * 只留账本事实与布尔事实谓词（仍在推进 / 等待 / 可能还在跑）。
 *
 * 设计见 docs/design/task-redefinition.md：task = 账本事实 + 布尔事实谓词 + worker 汇报。
 * 「liveness 三值」已删；任何把账本事实投影成一个「任务级状态词/多值生命周期枚举」的
 * 中间层都必须删（新守卫：packages/agent/task-lifecycle-enum-guard.test.ts）。
 *
 * 本守卫是**结构性判据**（不是精确名列表——改名搬移的同形函数一律拦）：
 *   ① 名字族：一个函数名里同时出现 `task` 与 `status/state/outcome`，且自身 return 出任务
 *      生命周期词 → 命中（taskStatusOf / observedTaskStatusOf / muTaskStateOf / TaskStateWord …）；
 *   ② 形状族：一个函数读了 ≥3 个账本事实字段（endedAt/executions/pendingQuestion/runningSince/
 *      leaseUntil/resultText/replyText），又 return 出 ≥2 个**生命周期独有词**
 *      （queued/running/waiting_user/died/cancelled/timed_out/resource_limited；不含与执行行/
 *      答复集重叠的 completed/failed）→ 命中——这正是「账本事实 → 多态任务状态词」投影的形状。
 *      已无任何按 (file,name) 放行的 liveness 投影；把只 return {completed,failed} 的
 *      **成败分类器**列为已登记局限（见 ④ 末段，不装没看见）。
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
  // 现行事实
  'endedAt',
  'pendingQuestion',
  'runningSince',
  'leaseUntil',
  'resultText',
  'replyText',
  'executions',
  // 已删的终态列名（旧投影换名/考古时仍要按「读事实」形状拦）
  'cancelledAt',
  'timedOutAt',
  'resourceLimitedAt',
  'diedAt',
]);

/** 生命周期**独有**词（去掉 completed/failed——它们与执行行/答复集的成败词重叠，合法分类器也会用）。 */
const LIFECYCLE_ONLY_WORDS = new Set([...LIFECYCLE_WORDS].filter((word) => word !== 'completed' && word !== 'failed'));

/** 形状族门槛：读 ≥3 账本事实字段，且 return ≥2 个生命周期独有词——「事实→多态状态词」投影形状。 */
const SHAPE_LIFECYCLE_ONLY_THRESHOLD = 2;
const SHAPE_FACT_THRESHOLD = 3;

/** 已无可放行的 liveness 投影（2026-11-23 删状态机轮）：任何同形投影都落入形状族被拦。 */

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
        const lifecycleOnly = [...words].filter((word) => LIFECYCLE_ONLY_WORDS.has(word));
        if (lifecycleOnly.length >= SHAPE_LIFECYCLE_ONLY_THRESHOLD && facts.size >= SHAPE_FACT_THRESHOLD) {
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

  it('② task-registry 不再导出 liveness 三值/状态词/状态枚举', () => {
    const source = readFileSync(path.join(ROOT, 'packages/agent/src/task-registry.ts'), 'utf8');
    expect(source).not.toMatch(/export type TaskLiveness\b/u);
    expect(source).not.toMatch(/taskLivenessOf/u);
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

    // 形状族·收紧后：只 return 2 个生命周期独有词（died/running）的换形投影也必须报红。
    // （门槛降到「≥2 个独有词」，正是为拦这种「精简版」投影——名字族不含 family、词数也少。）
    const shortProjection = findForbiddenProjections(new Map([
      ['scripts/min.ts', `
        export function peek(task: { cancelledAt?: string; diedAt?: string; timedOutAt?: string }): string {
          if (task.cancelledAt !== undefined) return 'cancelled';
          if (task.diedAt !== undefined) return 'died';
          if (task.timedOutAt !== undefined) return 'timed_out';
          return 'running';
        }`],
    ]));
    expect(shortProjection.some((hit) => hit.hit.startsWith('shape:'))).toBe(true);

    // 反向绊线：被删的 liveness 三值投影放回来，扫描器必须报红（已无放行名单）。
    const livenessOnly = findForbiddenProjections(new Map([
      ['packages/agent/src/task-registry.ts', `
        export type TaskLiveness = 'running' | 'died' | 'waiting_user';
        export function taskLivenessOf(task: { endedAt?: string; pendingQuestion?: unknown; resultText?: string }): TaskLiveness | undefined {
          if (task.endedAt !== undefined) return undefined;
          if (task.resultText !== undefined) return undefined;
          if (task.pendingQuestion !== undefined) return 'waiting_user';
          return 'running';
        }`],
    ]));
    expect(livenessOnly.some((hit) => hit.hit.startsWith('shape:'))).toBe(true);

    // 负例对照二类：产品工具 / 执行层类型（名字含 task+status/outcome，但不是账本投影）不得报红。
    const product = findForbiddenProjections(new Map([
      ['packages/agent/src/execution-runtime.ts', `
        function taskStatus(args: Record<string, unknown>): unknown { return statusView(args); }
        function taskStatusTool(): DiscoveredTool { return { name: 'task_status' } as DiscoveredTool; }`],
    ]));
    expect(product).toEqual([]);

    // 已登记局限（显式，不装没看见）：只 return {completed, failed} 两词、读 ≥3 事实的**成败分类器**
    // 不报红。它和 E11 判据（读 executions 判 completed/failed）同形，且不构成「多态任务状态」投影
    // （无 running/queued/waiting_user/timed_out 等）；把它也拦掉会误伤合法成败归类。要拦它得另立
    // 判据形状（例如按 export 名/调用点），本轮不做，登记为已知强度边界。
    const successFailureClassifier = findForbiddenProjections(new Map([
      ['scripts/verdict.ts', `
        export function didSucceed(task: { diedAt?: string; timedOutAt?: string; resourceLimitedAt?: string }): string {
          if (task.diedAt !== undefined) return 'failed';
          if (task.timedOutAt !== undefined) return 'failed';
          if (task.resourceLimitedAt !== undefined) return 'failed';
          return 'completed';
        }`],
    ]));
    expect(successFailureClassifier).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 回合级结局词（executionOutcome）退役守卫（2026-11-23）
//
// 唯一任务级状态是 liveness 三值。宿主回合收尾只记机械事实（execution 逐条 status +
// replyText + 死亡事实），**不再**把事实聚合成回合级结局词（success/failed/refused/
// not_permitted）；唤醒把 executions/liveness/replyText 喂给 Main，由 Main 判成败。
// 守卫按**形状**判（不认函数名/字段名）：
//   ① 「返回的取值可能集」⊆ 结局词族：函数 return 出的词（直接字面量 + 被返回标识符在
//      同函数内被比较到的字面量）落在执行状态词全集里的那部分，若 ≥2 个、全部属于
//      {success,failed,refused,not_permitted,completed}、且含一个回合独有词
//      （success/refused/not_permitted）→ 命中。`const status = entry.outcome.status;
//      return { verdict: status }` 这种「读事实 → 把窄化标识符当结局词返回」正是被删
//      roundFailureOf 的形状；把字段名换成 verdict 也一样拦。
//   ①' 补充：读账本事实字段且 return 出回合独有词（单支也算）。
//   ② 「问答五态分类器」（eval 旧 mechanicalOutcome）：函数自身 return ≥2 个
//      completed/partial/unsupported/blocked/failed，且至少含一个 partial/unsupported/blocked
//      （这三个不是执行行原始 status 词）→ 命中。
// 执行层适配器直传 `{ status: 'refused', ... }`（单条执行结果原样透传，返回词混入
// needs_input 等原词）不命中；只 return {completed, failed} 的成败分类器也不命中
// （已登记局限，见 ⑦ 末段）。
// ⑧ 再用 TS 类型结构兜底：{kind:'ended'} 对象的任何字段类型若是结局词并集，同样报红——
//    与字段名无关，且能拦「只删消费点、留下空字段」。
// ---------------------------------------------------------------------------

/** 回合级结局词（executionOutcome 的枚举值）；`refused`/`failed` 也是执行行原始 status，故需与「读事实」同形才判。 */
const ROUND_VERDICT_WORDS = new Set(['success', 'refused', 'not_permitted']);
/**
 * 结局词族（闭集）：任务/回合级结局投影可能产出的词。判定形状时看「函数 return 的词集合」是否
 * **整体落在该族内**——collection 里混进 needs_input 等执行行原词即认定为事实透传，不是投影。
 */
const VERDICT_FAMILY_WORDS = new Set(['success', 'failed', 'refused', 'not_permitted', 'completed']);
/** 只在结局投影里成组出现的词（completed/failed 同时也是执行行原词，合法透传/单行归一化会用）。 */
const ROUND_SPECIFIC_WORDS = new Set(['success', 'refused', 'not_permitted']);
/** 执行状态词全集（判断「返回词集合是否混入执行行原词」用）。 */
const STATUS_UNIVERSE_WORDS = new Set([
  'completed',
  'needs_confirmation',
  'needs_input',
  'failed',
  'refused',
  'accepted',
  'success',
  'not_permitted',
]);
/** eval 答复五态词（classifyOutcome 已删的旧枚举）。 */
const ANSWER_OUTCOME_WORDS = new Set(['completed', 'partial', 'unsupported', 'blocked', 'failed']);
/** 五态里**不是执行行原始 status** 的三个词——只有任务级分类器才会成组 return 它们。 */
const ANSWER_OUTCOME_ONLY_WORDS = new Set(['partial', 'unsupported', 'blocked']);

/**
 * 「return 出来的值」：**直接返回位置**的字符串字面量（return 表达式本身 / 三元两支 /
 * 对象属性值 / 数组元素）与**标识符**。标识符本身不是词——它的可能取值要看同函数内对它的
 * 比较（见 ownReturnedWordsAndFactReads）：`const status = entry.outcome.status; if (status !==
 * 'failed' && status !== 'refused') continue; return { verdict: status }` 这种「读事实 → 把窄化
 * 后的标识符当作结局词返回」正是被删 roundFailureOf 的形状，必须按**返回值的可能取值**判。
 */
function collectReturnedValues(node: ts.Node, words: Set<string>, identifiers: Set<string>): void {
  if (
    ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isNonNullExpression(node)
  ) {
    collectReturnedValues(node.expression, words, identifiers);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    words.add(node.text);
    return;
  }
  if (ts.isIdentifier(node)) {
    identifiers.add(node.text);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectReturnedValues(node.whenTrue, words, identifiers);
    collectReturnedValues(node.whenFalse, words, identifiers);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) collectReturnedValues(property.initializer, words, identifiers);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectReturnedValues(element, words, identifiers);
  }
}

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** 同函数内 `identifier === 'literal'` / `'literal' !== identifier` 比较到的字面量（窄化证据）。 */
function comparedLiteralsByIdentifier(body: ts.Node): Map<string, Set<string>> {
  const compared = new Map<string, Set<string>>();
  const add = (identifier: string, literal: string): void => {
    let set = compared.get(identifier);
    if (set === undefined) {
      set = new Set();
      compared.set(identifier, set);
    }
    set.add(literal);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      const left = node.left;
      const right = node.right;
      if (ts.isIdentifier(left) && ts.isStringLiteral(right)) add(left.text, right.text);
      else if (ts.isStringLiteral(left) && ts.isIdentifier(right)) add(right.text, left.text);
    }
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  walk(body);
  return compared;
}

/**
 * 函数**自身**（不下潜内层函数）return 出的可能取值 + 读到的账本事实字段。
 * 返回词集合 = 直接返回的字面量 ∪ 被返回的标识符在同函数内比较到的字面量（窄化取值）。
 */
function ownReturnedWordsAndFactReads(fn: ts.Node): { words: Set<string>; facts: Set<string> } {
  const words = new Set<string>();
  const facts = new Set<string>();
  const identifiers = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      collectReturnedValues(node.expression, words, identifiers);
    }
    if (ts.isPropertyAccessExpression(node) && LEDGER_FACT_NAMES.has(node.name.text)) facts.add(node.name.text);
    if (ts.isPropertyAssignment(node) && LEDGER_FACT_NAMES.has(node.name.getText())) facts.add(node.name.getText());
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) {
    walk(body);
    const compared = comparedLiteralsByIdentifier(body);
    for (const identifier of identifiers) {
      for (const literal of compared.get(identifier) ?? []) words.add(literal);
    }
  }
  return { words, facts };
}

/** 扫描器（纯函数，供反向绊线自证）：返回「事实 → 回合级词」投影的命中点。 */
export function findForbiddenVerdictProjections(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const name = functionName(node);
        const { words, facts } = ownReturnedWordsAndFactReads(node);
        // ① 回合级结局投影的**形状**（与函数名/字段名无关）：函数 return 出的可能取值在「执行状态
        //    词全集」里的那部分，若**整体落在结局词族内**（≥2 个词、含一个回合独有词）——就是
        //    「账本事实/执行行 → 回合级结局词」的投影。混入 needs_input 等执行行原词 = 事实透传，
        //    不判（合法适配器/单行归一化）。
        const statusWords = [...words].filter((word) => STATUS_UNIVERSE_WORDS.has(word));
        const verdictShape = statusWords.length >= 2
          && statusWords.every((word) => VERDICT_FAMILY_WORDS.has(word))
          && statusWords.some((word) => ROUND_SPECIFIC_WORDS.has(word));
        if (verdictShape) {
          hits.push({ file, hit: `round:${name ?? '<anonymous>'}(${statusWords.sort().join(',')})` });
        }
        // ①' 补充：读账本事实字段且 return 出回合独有词（单支也算）——旧形状的窄分支。
        const roundOnly = [...words].filter((word) => ROUND_VERDICT_WORDS.has(word));
        if (!verdictShape && roundOnly.length >= 1 && facts.size >= 1) {
          hits.push({ file, hit: `round:${name ?? '<anonymous>'}(${roundOnly.sort().join(',')})` });
        }
        // ② 答复五态分类器：≥2 个五态词且含 partial/unsupported/blocked。
        const answerWords = [...words].filter((word) => ANSWER_OUTCOME_WORDS.has(word));
        if (answerWords.length >= 2 && answerWords.some((word) => ANSWER_OUTCOME_ONLY_WORDS.has(word))) {
          hits.push({ file, hit: `answer:${name ?? '<anonymous>'}(${answerWords.sort().join(',')})` });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return hits;
}

/** 产品面源码（测试/退役校验脚本自身含被判词串与断言，不参与形状扫描）。 */
function productSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of listTs(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      if (rel === 'packages/agent/task-liveness-only.test.ts') continue;
      sources.set(rel, readFileSync(file, 'utf8'));
    }
  }
  return sources;
}

// ---------------------------------------------------------------------------
// 类型结构判据（与字段名/函数名无关）：回合收尾对象 {kind:'ended'} 的任何字段，其类型若是
// 「结局词并集」（success/failed/refused/not_permitted 的 ≥2 元并集，含至少一个回合独有词），
// 就是被删的回合级 outcome 投影换了字段名——报红。TaskExecutionOutcome.ended 的成员同样检查，
// 防止「只删消费点、留下空字段」。
// ---------------------------------------------------------------------------

interface VerdictProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** 只扫描这些根文件（其 import 图可解析类型，但只有根文件的 return 参与判定）。 */
  fileNames: ReadonlySet<string>;
}

/** 产品面类型扫描根：回合收尾对象的三个产地（runner 类型 + 两个装配面）。 */
const VERDICT_PROGRAM_ROOTS = [
  'packages/agent/src/task-runner.ts',
  'packages/agent/src/execution-runtime.ts',
  'scripts/ask-runtime.ts',
] as const;

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  if (config.error !== undefined) throw new Error('读取 tsconfig.json 失败');
  return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
}

/** 建编译器 program；overlay 用于反向绊线：用内存源码替换指定文件。 */
function buildVerdictProgram(
  rootFiles: readonly string[],
  overlay: ReadonlyMap<string, string> = new Map(),
): VerdictProgram {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const overlayByPath = new Map([...overlay].map(([file, text]) => [path.resolve(file), text]));
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = overlayByPath.get(path.resolve(fileName));
    return text === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
  };
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => overlayByPath.get(path.resolve(fileName)) ?? originalReadFile(fileName);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => overlayByPath.has(path.resolve(fileName)) || originalFileExists(fileName);
  const roots = rootFiles.map((file) => path.resolve(file));
  const program = ts.createProgram(roots, options, host);
  return { program, checker: program.getTypeChecker(), fileNames: new Set(roots) };
}

let productVerdictProgram: VerdictProgram | undefined;

function buildProductVerdictProgram(): VerdictProgram {
  productVerdictProgram ??= buildVerdictProgram(VERDICT_PROGRAM_ROOTS.map((file) => path.join(ROOT, file)));
  return productVerdictProgram;
}

function buildVerdictProgramFromSources(sources: ReadonlyMap<string, string>): VerdictProgram {
  return buildVerdictProgram([...sources.keys()], sources);
}

/**
 * 类型的「结局词并集」读取：仅当类型是 ≥2 个字符串字面量的并集、全部落在 VERDICT_FAMILY_WORDS
 * 内、且至少含一个回合独有词（success/refused/not_permitted）时返回成员词；否则 undefined。
 * undefined/null/never/void 成员忽略（可选字段不改变判定）。
 */
function verdictUnionWords(type: ts.Type): string[] | undefined {
  if (!type.isUnion()) return undefined;
  const words: string[] = [];
  for (const member of type.types) {
    if ((member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never | ts.TypeFlags.Void)) !== 0) continue;
    if (!member.isStringLiteral()) return undefined;
    words.push(member.value);
  }
  if (words.length < 2) return undefined;
  if (!words.every((word) => VERDICT_FAMILY_WORDS.has(word))) return undefined;
  if (!words.some((word) => ROUND_SPECIFIC_WORDS.has(word))) return undefined;
  return words;
}

/** {kind:'ended'} 对象字面量的 return 中，字段类型是结局词并集的字段名（与字段名无关）。 */
function findEndedVerdictReturns(scope: VerdictProgram): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const sourceFile of scope.program.getSourceFiles()) {
    if (!scope.fileNames.has(path.resolve(sourceFile.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression !== undefined && isEndedObjectLiteral(node.expression, scope.checker)) {
        const type = scope.checker.getTypeAtLocation(node.expression);
        if ((type.flags & ts.TypeFlags.Object) !== 0) {
          for (const property of scope.checker.getPropertiesOfType(type)) {
            const words = verdictUnionWords(scope.checker.getTypeOfSymbol(property));
            if (words !== undefined) {
              const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              hits.push({ file: path.relative(ROOT, sourceFile.fileName), hit: `ended-field:${property.name}(${words.sort().join(',')})@${line}` });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return hits;
}

/** 对象字面量是否带 `kind: 'ended'`（回合收尾形状）。 */
function isEndedObjectLiteral(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const kind = node.properties.find((property): property is ts.PropertyAssignment => (
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'kind'
  ));
  if (kind === undefined) return false;
  const type = checker.getTypeAtLocation(kind.initializer);
  return type.isStringLiteral() && type.value === 'ended';
}

/** 取导出类型（按根文件名后缀 + 导出名）；找不到返回 undefined。 */
function exportedTypeOf(scope: VerdictProgram, fileSuffix: string, typeName: string): ts.Type | undefined {
  for (const sourceFile of scope.program.getSourceFiles()) {
    if (!scope.fileNames.has(path.resolve(sourceFile.fileName))) continue;
    if (!sourceFile.fileName.endsWith(fileSuffix)) continue;
    const moduleSymbol = scope.checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol === undefined) continue;
    const symbol = scope.checker.getExportsOfModule(moduleSymbol).find((entry) => entry.name === typeName);
    if (symbol !== undefined) return scope.checker.getDeclaredTypeOfSymbol(symbol);
  }
  return undefined;
}

/** 联合类型里 `kind:'ended'` 成员的字段中，类型是结局词并集的字段名列表。 */
function endedVerdictFieldKeys(type: ts.Type, checker: ts.TypeChecker): string[] {
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    const kind = checker.getPropertiesOfType(member).find((property) => property.name === 'kind');
    if (kind === undefined) continue;
    const kindType = checker.getTypeOfSymbol(kind);
    if (!kindType.isStringLiteral() || kindType.value !== 'ended') continue;
    return checker.getPropertiesOfType(member)
      .filter((property) => verdictUnionWords(checker.getTypeOfSymbol(property)) !== undefined)
      .map((property) => property.name);
  }
  return [];
}


describe('删回合级结局词：宿主/eval 只留事实 + liveness', () => {
  it('⑤ 源码里不再有回合级 outcome 字段/投影（executionOutcome / roundFailureOf 双退役）', () => {
    const sources = productSources();
    // 形状族（与函数名/字段名无关）：见本文件「类型结构判据」段与 ⑦ 的换名绊线。
    expect(findForbiddenVerdictProjections(sources)).toEqual([]);
    // 精确名兜底（附加检查，不是形状判据的替代）：被删实现的原名也不得复活。
    const offenders = [...sources]
      .filter(([, text]) => text.includes('executionOutcome') || text.includes('roundFailureOf'))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    // 类型声明里也不再有该字段（防止只删消费点、留下空字段）。
    const runnerType = readFileSync(path.join(ROOT, 'packages/agent/src/task-runner.ts'), 'utf8');
    expect(runnerType).not.toMatch(/executionOutcome/u);
    expect(runnerType).not.toMatch(/roundSucceeded/u);
  });

  it('⑥ eval 不再有答复五态：TaskOutcome / acceptedOutcomes / mechanicalOutcome 退役', () => {
    const sources = productSources();
    const offenders = [...sources]
      .filter(([file]) => file.includes('convergence-r1'))
      .filter(([, text]) => /TaskOutcome|acceptedOutcomes|mechanicalOutcome|outcomeAccepted/u.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    // 判据仍直读逐条 execution status（事实面没被一起删掉）。
    const judge = readFileSync(path.join(ROOT, 'scripts/eval/convergence-r1/judge.ts'), 'utf8');
    expect(judge).toMatch(/\.status\b/u);
  });

  it('⑦ 反向绊线：把「事实 → 回合级词」投影放回源码，扫描器必须报红', () => {
    // ① 改名换形：读执行事实、return success/failed（回合级结局词）。
    const roundVerdict = findForbiddenVerdictProjections(new Map([
      ['packages/agent/src/x.ts', `
        export function observeRound(task: { executions?: Array<{ status: string }>; replyText?: string }): string {
          const rows = task.executions ?? [];
          if (task.replyText !== undefined && rows.every((row) => row.status === 'completed')) return 'success';
          return 'failed';
        }`],
    ]));
    expect(roundVerdict.some((hit) => hit.hit.startsWith('round:'))).toBe(true);

    // ② eval 五态分类器（旧 mechanicalOutcome 形状）：读 executions 归成 unsupported/blocked/completed。
    const answerClassifier = findForbiddenVerdictProjections(new Map([
      ['scripts/eval/convergence-r1/judge.ts', `
        export function classify(executions: Array<{ status: string }>): string {
          if (executions.length === 0) return 'unsupported';
          const last = executions[executions.length - 1]!.status;
          return last === 'completed' ? 'completed' : 'blocked';
        }`],
    ]));
    expect(answerClassifier.some((hit) => hit.hit.startsWith('answer:'))).toBe(true);

    // 负例对照一类：执行层适配器直传原始执行 status（不读账本事实）不得报红。
    const adapter = findForbiddenVerdictProjections(new Map([
      ['packages/agent/src/dummy-cli-client.ts', `
        function refusalOf(code: string, stderr: string): ExecutionOutcome {
          return { status: 'refused', error: { code, message: stderr !== '' ? stderr : '这次请求被拒绝了。' } };
        }`],
    ]));
    expect(adapter).toEqual([]);

    // 负例对照二类：单条执行行的成败归一化（只有 failed/completed 两个原词）不得报红。
    const single = findForbiddenVerdictProjections(new Map([
      ['scripts/eval/x.ts', `
        function rowPassed(execution: { status: string }): string {
          return execution.status === 'failed' ? 'failed' : 'completed';
        }`],
    ]));
    expect(single).toEqual([]);

    // ③ 换名搬移（复核探针）：被删 roundFailureOf 的等价重写——局部数组里读 entry.outcome.status，
    //    return { verdict: status }；既没有账本事实字段名，也没有「直接返回位置的字符串字面量」
    //    （'failed'/'refused' 只出现在比较式里）。按**返回值的形状**必须报红。
    const renamedVerdict = findForbiddenVerdictProjections(new Map([
      ['packages/agent/src/execution-runtime.ts', `
        function lastDecisiveVerdictOf(recorded: Array<{ outcome: { status: 'completed' | 'failed' | 'refused'; error: { code: string } } }>): { verdict: 'failed' | 'refused'; code?: string } | undefined {
          for (let index = recorded.length - 1; index >= 0; index -= 1) {
            const entry = recorded[index];
            if (entry === undefined) continue;
            const status = entry.outcome.status;
            if (status === 'completed') return undefined;
            if (status !== 'failed' && status !== 'refused') continue;
            const code = entry.outcome.error.code;
            return { verdict: status, code };
          }
          return undefined;
        }`],
    ]));
    expect(renamedVerdict.some((hit) => hit.hit.startsWith('round:'))).toBe(true);

    // 负例对照三类：执行层「原样透传单条执行结果 status」不得报红——返回词集合混入
    // needs_input 等执行行原词，就不是「任务级结局投影」。
    const passthrough = findForbiddenVerdictProjections(new Map([
      ['scripts/eval/x.ts', `
        function statusOf(outcome: { status?: string } | undefined): string {
          const status = outcome?.status;
          if (status === 'completed' || status === 'needs_input' || status === 'failed' || status === 'refused') return status;
          return 'failed';
        }`],
    ]));
    expect(passthrough).toEqual([]);
  });

  it('⑧ 类型结构：{kind:"ended"} 回合收尾对象的字段类型不得是结局词并集（与字段名无关）', () => {
    const product = buildProductVerdictProgram();
    // 产品面：execution-runtime / ask-runtime 的 {kind:"ended"} 返回 + TaskExecutionOutcome.ended。
    expect(findEndedVerdictReturns(product)).toEqual([]);
    const endedType = exportedTypeOf(product, 'packages/agent/src/task-runner.ts', 'TaskExecutionOutcome');
    expect(endedType).toBeDefined();
    expect(endedVerdictFieldKeys(endedType!, product.checker)).toEqual([]);

    // 反向绊线：把同一个形状换任意字段名放回，类型扫描必须报红（不认字段名/函数名）。
    const synthetic = buildVerdictProgramFromSources(new Map([
      [path.join(ROOT, 'guard-synthetic.ts'), `
        export type TaskExecutionOutcome = { kind: 'ended'; report?: string; verdict?: 'failed' | 'refused' };
        export function restoredRoundVerdict(recorded: Array<{ status: 'failed' | 'refused' }>): TaskExecutionOutcome {
          const status = recorded[0]!.status;
          return { kind: 'ended', verdict: status };
        }`],
    ]));
    expect(findEndedVerdictReturns(synthetic).some((hit) => hit.hit.includes('verdict'))).toBe(true);
    const badType = exportedTypeOf(synthetic, 'guard-synthetic.ts', 'TaskExecutionOutcome');
    expect(badType).toBeDefined();
    expect(endedVerdictFieldKeys(badType!, synthetic.checker)).toEqual(['verdict']);
  });
});

// ---------------------------------------------------------------------------
// 「任务是否仍在推进」唯一谓词守卫（2026-11-23）
//
// 背景：宿主里「任务还在跑」的判定复制过约 5 份、口径漂移（只看 running_since + 四个结束
// 时刻），导致已汇报 / round_failed 已落的行仍被当「在办」；SQL 扫描面与 TS 判定各写各的。
// 收敛口径：唯一实现 = `packages/core/src/task-progress.ts` 的 `stillProgressingOf` 与
// `stillProgressingSqlWhere`（同一份「结束事实列清单」派生 TS 判定与 SQL WHERE）。
//
// 守卫按形状判（不认函数名）：
//   ① TS：函数**自身**同时读「已启动」事实（runningSince）与任一结束事实
//      （diedAt/cancelledAt/timedOutAt/resourceLimitedAt/roundFailedAt），或调结束判定
//      helper（taskEndedOf / taskProgressEndedOf / runInactiveOf）→ 命中——这正是手写
//      「running_since 非空 && 若干结束事实为空」的形状。唯一实现按 (file,name) 精确放行。
//   ② SQL：字符串字面量里同时出现 `running_since` 与 `IS NOT NULL` → 命中（底账扫描必须
//      走共享 SQL 片段；手写 WHERE 一律拦）。唯一实现文件放行。
//   ③ 反向绊线：把旧口径（TS 组合判定 / SQL WHERE）放回合成源码，扫描器必须报红；
//      只读 runningSince 的「已启动」判定与唯一实现不得报红（证明不是见词就杀）。
// ---------------------------------------------------------------------------

/** 「已启动」事实字段（TS camel）。 */
const START_FACT_NAMES = new Set(['runningSince']);
/** 收尾事实字段（TS camel；round_failed_at 是「本轮已停」，不是终局）。 */
const END_FACT_NAMES = new Set(['diedAt', 'cancelledAt', 'timedOutAt', 'resourceLimitedAt', 'roundFailedAt']);
/** 结束判定 helper（调用它们 = 读结束事实；再与 runningSince 组合就是手写在跑判定）。 */
const END_HELPER_NAMES = new Set(['taskEndedOf', 'taskProgressEndedOf', 'runInactiveOf']);
/** 唯一实现（TS 判定 + SQL 片段同源）。 */
const CANONICAL_PROGRESS_FILE = 'packages/core/src/task-progress.ts';
/** 唯一实现文件里允许的组合判定（「在跑」唯一谓词 + 其逆面「未启动」）。 */
const CANONICAL_PROGRESS_NAMES = new Set(['stillProgressingOf', 'taskUnstartedOf']);

/**
 * 扫描器（纯函数，供反向绊线自证）：返回手写「在跑」判定的命中点。
 * ① TS：同一个 &&/|| 表达式里同时出现「已启动」事实与结束事实/结束判定 helper
 *    （armLease 这类「分别读 runningSince、分别调 taskEndedOf」的写路径不命中）；
 * ② SQL：字符串字面量手写 `running_since ... IS NOT NULL`。
 */
export function findForbiddenRunningJudgments(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const rel = file.split(path.sep).join('/');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const name = functionName(node);
        const canonical = rel === CANONICAL_PROGRESS_FILE && name !== undefined && CANONICAL_PROGRESS_NAMES.has(name);
        const body = (node as { body?: ts.Node }).body;
        if (!canonical && body !== undefined && hasRunningCombo(body)) {
          hits.push({ file, hit: `ts:${name ?? '<anonymous>'}` });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    // ② SQL 手写 WHERE（唯一实现文件以外）：所有底账「在跑」扫描都必须走共享片段。
    if (rel !== CANONICAL_PROGRESS_FILE) {
      const walkStrings = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (/\brunning_since\b/iu.test(node.text) && /\bIS\s+NOT\s+NULL\b/iu.test(node.text)) {
            hits.push({ file, hit: 'sql:running_since IS NOT NULL' });
          }
        }
        ts.forEachChild(node, walkStrings);
      };
      walkStrings(sf);
    }
  }
  return hits;
}

/** 函数自身（不下潜内层函数）是否存在「已启动 && 结束事实」的同一逻辑表达式。 */
function hasRunningCombo(body: ts.Node): boolean {
  const isLogical = (node: ts.Node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  const containsCombo = (root: ts.Node): boolean => {
    let readsStart = false;
    let readsEnd = false;
    let callsEndHelper = false;
    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        if (START_FACT_NAMES.has(node.name.text)) readsStart = true;
        if (END_FACT_NAMES.has(node.name.text)) readsEnd = true;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && END_HELPER_NAMES.has(node.expression.text)) {
        callsEndHelper = true;
      }
      ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
    };
    walk(root);
    return readsStart && (readsEnd || callsEndHelper);
  };
  let hit = false;
  const walk = (node: ts.Node): void => {
    if (isLogical(node) && containsCombo(node)) hit = true;
    if (!hit) ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  walk(body);
  return hit;
}

describe('「仍在推进」判定唯一化：只允许一份实现', () => {
  it('⑨ 产品源码里没有第二份手写的「在跑」判定（TS 组合 / SQL WHERE）', () => {
    const sources = productSources();
    expect(findForbiddenRunningJudgments(sources)).toEqual([]);
    // 唯一实现存在且两侧派生自同一模块（防「删光所有调用点」的假绿）。
    const progressSource = readFileSync(path.join(ROOT, CANONICAL_PROGRESS_FILE), 'utf8');
    expect(progressSource).toContain('export function stillProgressingOf');
    expect(progressSource).toContain('export function stillProgressingSqlWhere');
    const storeSource = readFileSync(path.join(ROOT, 'packages/core/src/task-store.ts'), 'utf8');
    expect(storeSource).toContain('stillProgressingSqlWhere()');
    const registrySource = readFileSync(path.join(ROOT, 'packages/agent/src/task-registry.ts'), 'utf8');
    expect(registrySource).toContain('stillProgressingOf');
  });

  it('⑩ 反向绊线：把旧口径放回源码，扫描器必须报红（TS 组合 / helper 组合 / SQL WHERE）', () => {
    // ① 直接字段组合（旧内存 listRunning / noWaitingTargetFacts 的形状）。
    const byFields = findForbiddenRunningJudgments(new Map([
      ['packages/agent/src/legacy-running.ts', `
        export function isRunning(task: { runningSince?: string; diedAt?: string; cancelledAt?: string }): boolean {
          return task.runningSince !== undefined && task.diedAt === undefined && task.cancelledAt === undefined;
        }`],
    ]));
    expect(byFields.some((hit) => hit.hit.startsWith('ts:'))).toBe(true);

    // ② 与结束判定 helper 组合（旧实现常见写法）。
    const byHelper = findForbiddenRunningJudgments(new Map([
      ['packages/agent/src/legacy-running.ts', `
        function listRunning(tasks: Array<{ runningSince?: string }>): unknown[] {
          return tasks.filter((task) => task.runningSince !== undefined && !taskEndedOf(task));
        }`],
    ]));
    expect(byHelper.some((hit) => hit.hit.startsWith('ts:'))).toBe(true);

    // ③ SQL 手写 WHERE（旧 selectRunningTasks / selectExpiredLeases 的形状）。
    const bySql = findForbiddenRunningJudgments(new Map([
      ['packages/core/src/legacy-store.ts', `
        const statement = db.prepare(\`
          SELECT * FROM tasks
          WHERE running_since IS NOT NULL AND died_at IS NULL AND cancelled_at IS NULL
        \`);`],
    ]));
    expect(bySql.some((hit) => hit.hit.startsWith('sql:'))).toBe(true);

    // 负例对照一：唯一实现（按 file,name 放行）与其逆面「未启动」不得报红。
    const canonical = findForbiddenRunningJudgments(new Map([
      [CANONICAL_PROGRESS_FILE, `
        export function stillProgressingOf(task: { runningSince?: string; diedAt?: string }): boolean {
          return task.runningSince !== undefined && task.diedAt === undefined;
        }
        export function taskUnstartedOf(task: { runningSince?: string; diedAt?: string }): boolean {
          return task.runningSince === undefined && task.diedAt === undefined;
        }`],
    ]));
    expect(canonical).toEqual([]);

    // 负例对照二：只读 runningSince 的「已启动」判定（不看结束事实）不得报红。
    const startedOnly = findForbiddenRunningJudgments(new Map([
      ['packages/agent/src/started.ts', `
        function startedOf(task: { runningSince?: string }): boolean { return task.runningSince !== undefined; }`],
    ]));
    expect(startedOnly).toEqual([]);
  });
});
