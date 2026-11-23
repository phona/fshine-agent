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
 *      pendingQuestion/runningSince/leaseUntil/resultText/replyText/executions），又 return 出 ≥2 个
 *      **生命周期独有词**（queued/running/waiting_user/died/cancelled/timed_out/resource_limited；
 *      不含与执行行/答复集重叠的 completed/failed）→ 命中——这正是「账本事实 → 多态任务状态词」
 *      投影的形状。唯一按 (file,name) 精确放行的是设计 §3 指定的 `taskLivenessOf`（liveness 三值）；
 *      把只 return {completed,failed} 的**成败分类器**列为已登记局限（见 ④ 末段，不装没看见）。
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

/** 生命周期**独有**词（去掉 completed/failed——它们与执行行/答复集的成败词重叠，合法分类器也会用）。 */
const LIFECYCLE_ONLY_WORDS = new Set([...LIFECYCLE_WORDS].filter((word) => word !== 'completed' && word !== 'failed'));

/** 形状族门槛：读 ≥3 账本事实字段，且 return ≥2 个生命周期独有词——「事实→多态状态词」投影形状。 */
const SHAPE_LIFECYCLE_ONLY_THRESHOLD = 2;
const SHAPE_FACT_THRESHOLD = 3;

/**
 * 唯一允许的投影：`packages/agent/src/task-registry.ts` 的 `taskLivenessOf`（设计 §3 指定的
 * liveness 三值）。它同样读账本事实、return running/died/waiting_user，形状上和「被禁投影」同形，
 * 所以按 (file, name) 精确放行；改名搬移它到别处或换名会重新落入形状族而被拦。
 */
const CANONICAL_LIVENESS_FILE = 'packages/agent/src/task-registry.ts';
const CANONICAL_LIVENESS_NAME = 'taskLivenessOf';

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
        const isCanonicalLiveness = file.split(path.sep).join('/') === CANONICAL_LIVENESS_FILE && name === CANONICAL_LIVENESS_NAME;
        if (!isCanonicalLiveness && lifecycleOnly.length >= SHAPE_LIFECYCLE_ONLY_THRESHOLD && facts.size >= SHAPE_FACT_THRESHOLD) {
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

    // 负例对照一类：liveness 投影（唯一允许的投影）不得报红——按 (file,name) 精确放行。
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
// 守卫按**形状**判（facts → 回合级词），不认名字：
//   ① 「回合事实 → 结局词」：函数自身 return 出 success/refused/not_permitted（回合级
//      枚举独有词），且读到了账本/执行事实字段 → 命中；
//   ② 「问答五态分类器」（eval 旧 mechanicalOutcome）：函数自身 return ≥2 个
//      completed/partial/unsupported/blocked/failed，且至少含一个 partial/unsupported/blocked
//      （这三个不是执行行原始 status 词）→ 命中。
// 执行层适配器直传 `{ status: 'refused', ... }`（原始执行 status）不读账本事实，不命中；
// 只 return {completed, failed} 的成败分类器也不命中（已登记局限，见 ④ 末段）。
// ---------------------------------------------------------------------------

/** 回合级结局词（executionOutcome 的枚举值）；`refused`/`failed` 也是执行行原始 status，故需与「读事实」同形才判。 */
const ROUND_VERDICT_WORDS = new Set(['success', 'refused', 'not_permitted']);
/** eval 答复五态词（classifyOutcome 已删的旧枚举）。 */
const ANSWER_OUTCOME_WORDS = new Set(['completed', 'partial', 'unsupported', 'blocked', 'failed']);
/** 五态里**不是执行行原始 status** 的三个词——只有任务级分类器才会成组 return 它们。 */
const ANSWER_OUTCOME_ONLY_WORDS = new Set(['partial', 'unsupported', 'blocked']);

/**
 * 「return 出来的词」：只认**直接返回位置**的字符串字面量（return 表达式本身 / 三元两支 /
 * 对象属性值 / 数组元素）。比较表达式里的状态码（`status === 'refused'`）是被读的事实，
 * 不是被产出的词——不收集（否则任何布尔判断都会被误判成投影）。
 */
function collectReturnedLiterals(node: ts.Node, words: Set<string>): void {
  if (
    ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isNonNullExpression(node)
  ) {
    collectReturnedLiterals(node.expression, words);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    words.add(node.text);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectReturnedLiterals(node.whenTrue, words);
    collectReturnedLiterals(node.whenFalse, words);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) collectReturnedLiterals(property.initializer, words);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectReturnedLiterals(element, words);
  }
}

/** 函数**自身**（不下潜内层函数）return 出的词 + 读到的账本事实字段。 */
function ownReturnedWordsAndFactReads(fn: ts.Node): { words: Set<string>; facts: Set<string> } {
  const words = new Set<string>();
  const facts = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) collectReturnedLiterals(node.expression, words);
    if (ts.isPropertyAccessExpression(node) && LEDGER_FACT_NAMES.has(node.name.text)) facts.add(node.name.text);
    if (ts.isPropertyAssignment(node) && LEDGER_FACT_NAMES.has(node.name.getText())) facts.add(node.name.getText());
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) walk(body);
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
        // ① 回合事实 → 结局词（success/refused/not_permitted）。执行行 status 直传不读账本事实。
        const roundWords = [...words].filter((word) => ROUND_VERDICT_WORDS.has(word));
        if (roundWords.length >= 1 && facts.size >= 1) {
          hits.push({ file, hit: `round:${name ?? '<anonymous>'}(${roundWords.sort().join(',')})` });
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

describe('删回合级结局词：宿主/eval 只留事实 + liveness', () => {
  it('⑤ 源码里不再有回合级 outcome 字段/投影（executionOutcome / roundFailureOf 双退役）', () => {
    const sources = productSources();
    expect(findForbiddenVerdictProjections(sources)).toEqual([]);
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

    // 负例对照二类：只有单支（只 return completed/failed 之一）的事实归一化不得报红。
    const single = findForbiddenVerdictProjections(new Map([
      ['scripts/eval/x.ts', `
        function rowPassed(execution: { status: string }): string {
          return execution.status === 'failed' ? 'failed' : 'completed';
        }`],
    ]));
    expect(single).toEqual([]);
  });
});
