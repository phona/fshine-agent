/**
 * 「不维护任务状态机」守卫（2026-11-23 owner 定；删状态机轮）。
 *
 * 口径（docs/architecture/tasks.md §1、docs/design/task-redefinition.md §3/§7、AGENTS.md）：
 * task 只存事实（身份/归属/交办原文/汇报/提问/执行账本）；活/结束现推；消费方读原始事实算。
 * **不存在**「任务级生命周期枚举」：既没有终止种类（cancelled/timed_out/resource_limited/
 * died/round_failed/completed），也没有 liveness 三值（running/died/waiting_user）。
 *
 * 守卫按**形状**判（不认函数名/字段名）：
 *   ① 函数形状：函数**自身** return 出 ≥2 个「任务级收尾词」（died/cancelled/canceled/
 *      timed_out/resource_limited/round_failed/completed/failed）→ 红。
 *      例外（形状明确、与执行层事实同源）：return 词只落在执行行原始状态 {completed, failed}
 *      内，且不读任何任务行事实字段——这是「单条执行行成败归一化」，不是任务级分类器。
 *   ② 函数形状·存活：函数自身 return 出 ≥2 个存活词（running/died/waiting_user）→ 红。
 *   ③ 类型形状·收尾：导出的字符串字面量并集，含 ≥2 个收尾词，且**不带**事件/通知词表
 *      （accepted/started/resumed/result_archived/ended/warning）→ 红。纯收尾枚举
 *      （TaskTerminationKind 的形状）与「状态 = 排队/在跑/死/取消」换形都命中；混有事件/
 *      通知词表的通道枚举（通知意图、事实事件流）不判——它们是「发生了什么」的通道，不是
 *      任务状态。
 *   ④ 类型形状·存活：导出的字符串字面量并集，含 ≥2 个存活词（running/died/waiting_user）→ 红。
 *   ⑤ 文档形状：docs/**.md 与 AGENTS.md 的**句子**里，把 task/任务/底账描述成有
 *      「状态机 / 存活三值 / liveness 三值 / 唯一任务级状态 / running/died/waiting_user」
 *      属性且句子内没有否定词（不/没有/已删/删除/不再/无）→ 红。目标句必须能写成
 *      「不维护任务状态机」这种否定句，守卫不得把它判红。
 *   ⑥ 反向绊线（实跑）：把被删形状（终止种类函数 / 收尾枚举 / liveness 三值 / 状态机文档句）
 *      放回合成源码与合成文档，扫描器必须报红；合法负例（执行层原始状态并集、通知事件通道、
 *      否定句）不得报红——证明守卫不是见词就杀。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_DIRS = ['apps', 'packages', 'scripts'] as const;

/** 任务级收尾词：这些词只在「一个任务怎么结束」的枚举/分类器里成组出现。 */
const ENDING_WORDS = new Set([
  'died',
  'cancelled',
  'canceled',
  'timed_out',
  'resource_limited',
  'round_failed',
  'completed',
  'failed',
]);

/** 执行行原始状态词（执行层契约事实；单行归一化允许，任务级分类器不允许）。 */
const EXECUTION_STATUS_WORDS = new Set([
  'completed',
  'needs_confirmation',
  'needs_input',
  'failed',
  'refused',
  'accepted',
]);

/** 存活词（liveness 三值及其换形）。 */
const LIVENESS_WORDS = new Set(['running', 'died', 'waiting_user']);

/** 事件/通知通道词汇：并集里出现任一即视为「发生了什么」的通道枚举，不是任务状态枚举。 */
const EVENT_CHANNEL_WORDS = new Set([
  'accepted',
  'started',
  'resumed',
  'result_archived',
  'ended',
  'warning',
]);

/** 回合/操作结果词：函数返回它们 = 在跑一回合/一笔操作的结局，不是任务级分类器。 */
const ROUND_OUTCOME_WORDS = new Set([
  'needs_confirmation',
  'needs_input',
  'result_unknown',
  'refused',
  'ended',
  'unknown',
  'claimed',
]);

/** 任务行事实字段（读它们 = 读任务事实；用于函数形状的「事实 → 词」方向判定）。 */
const TASK_FACT_FIELDS = new Set([
  'runningSince',
  'leaseUntil',
  'resultText',
  'replyText',
  'pendingQuestion',
  'executions',
  'endedAt',
]);

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      out.push(...listFiles(full, suffix));
    } else if (name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
}

function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return node.name?.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** 函数自身 return 位置上的字符串字面量（含三元两支 / 对象属性 / 数组元素 / 括号与断言）。 */
function collectReturnedWords(node: ts.Node, words: Set<string>): void {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    collectReturnedWords(node.expression, words);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    words.add(node.text);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectReturnedWords(node.whenTrue, words);
    collectReturnedWords(node.whenFalse, words);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) collectReturnedWords(property.initializer, words);
    }
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectReturnedWords(element, words);
  }
}

interface FunctionShape {
  name?: string;
  words: Set<string>;
  readsTaskFacts: boolean;
}

/** 函数自身（不下潜内层函数）的 return 词与任务事实读取。 */
function functionShape(fn: ts.Node): FunctionShape {
  const words = new Set<string>();
  let readsTaskFacts = false;
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) collectReturnedWords(node.expression, words);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && TASK_FACT_FIELDS.has(node.name.text)) {
      readsTaskFacts = true;
    }
    ts.forEachChild(node, (child) => { if (!isFunctionLike(child)) walk(child); });
  };
  const body = (fn as { body?: ts.Node }).body;
  if (body !== undefined) walk(body);
  return { name: functionName(fn), words, readsTaskFacts };
}

/**
 * 扫描器（纯函数，供反向绊线自证）：返回「函数 return 出任务级生命周期词」的命中点。
 * ① 收尾词 ≥2（例外：只 {completed,failed} 且不读任务事实 = 执行行归一化）；
 * ② 存活词 ≥2。
 */
export function findForbiddenLifecycleFunctions(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const { name, words, readsTaskFacts } = functionShape(node);
        const endings = [...words].filter((word) => ENDING_WORDS.has(word));
        const liveness = [...words].filter((word) => LIVENESS_WORDS.has(word));
        const roundOutcome = [...words].some((word) => ROUND_OUTCOME_WORDS.has(word));
        const executionRowNormalization = endings.length > 0
          && endings.every((word) => word === 'completed' || word === 'failed')
          && !readsTaskFacts;
        if (endings.length >= 2 && !roundOutcome && !executionRowNormalization) {
          hits.push({ file, hit: `ending:${name ?? '<anonymous>'}(${endings.sort().join(',')})` });
        }
        if (liveness.length >= 2) {
          hits.push({ file, hit: `liveness:${name ?? '<anonymous>'}(${liveness.sort().join(',')})` });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return hits;
}

/** 类型字面量并集成员（忽略 undefined/null/never/void）；不是纯字符串并集返回 undefined。 */
function stringUnionMembers(type: ts.Type): string[] | undefined {
  if (!type.isUnion()) return undefined;
  const members: string[] = [];
  for (const member of type.types) {
    if ((member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never | ts.TypeFlags.Void)) !== 0) continue;
    if (!member.isStringLiteral()) return undefined;
    members.push(member.value);
  }
  return members.length >= 2 ? members : undefined;
}

/**
 * 扫描器（纯函数）：导出类型别名里「任务级生命周期枚举」的形状。
 * ③ 收尾词 ≥2 且不带事件/通知通道词（纯收尾枚举 / 排队+在跑+死+取消的换形）；
 * ④ 存活词 ≥2（liveness 三值及其换形）。
 */
export function findForbiddenLifecycleTypes(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const checkMembers = (name: string, members: string[], label: string): void => {
      const endings = members.filter((member) => ENDING_WORDS.has(member));
      const liveness = members.filter((member) => LIVENESS_WORDS.has(member));
      const eventChannel = members.some((member) => EVENT_CHANNEL_WORDS.has(member));
      if (endings.length >= 2 && !eventChannel) {
        hits.push({ file, hit: `${label}-ending:${name}(${endings.sort().join(',')})` });
      }
      if (liveness.length >= 2) {
        hits.push({ file, hit: `${label}-liveness:${name}(${liveness.sort().join(',')})` });
      }
    };
    /** `type X = (typeof SOME_CONST)[number]` 的词表派生枚举（TaskTerminationKind 的形状）。 */
    const derivedConstNames = new Set<string>();
    const collectDerived = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.type !== undefined) {
        let typeNode = node.type;
        while (ts.isParenthesizedTypeNode(typeNode)) typeNode = typeNode.type;
        if (!ts.isIndexedAccessTypeNode(typeNode)) return;
        let objectType = typeNode.objectType;
        while (ts.isParenthesizedTypeNode(objectType)) objectType = objectType.type;
        if (ts.isTypeQueryNode(objectType)
          && typeNode.indexType.kind === ts.SyntaxKind.NumberKeyword
          && ts.isIdentifier(objectType.exprName)) {
          derivedConstNames.add(objectType.exprName.text);
        }
      }
      ts.forEachChild(node, collectDerived);
    };
    collectDerived(sf);
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.type !== undefined) {
        const members = typeLiteralMembers(node.type);
        if (members !== undefined) checkMembers(node.name.text, members, 'type');
      }
      // 词表常量只在**派生枚举**（有 `(typeof X)[number]` 类型别名）时按共享枚举判；
      // 普通常量数组（通知推送清单 / 状态过滤清单）不是任务状态类型。
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (derivedConstNames.has(node.name.text)) {
          let initializer = node.initializer;
          while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
          if (ts.isArrayLiteralExpression(initializer)) {
            const literals: string[] = [];
            let allString = true;
            for (const element of initializer.elements) {
              const value = ts.isStringLiteral(element) ? element.text : undefined;
              if (value === undefined) allString = false;
              else literals.push(value);
            }
            if (allString) checkMembers(node.name.text, literals, 'const');
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return hits;
}

/** 语法侧读取字符串字面量并集成员（递归联合 + 括号），不建 program、不依赖类型检查器。 */
function typeLiteralMembers(node: ts.TypeNode): string[] | undefined {
  const members: string[] = [];
  const collect = (current: ts.TypeNode): boolean => {
    if (ts.isParenthesizedTypeNode(current)) return collect(current.type);
    if (ts.isLiteralTypeNode(current)) {
      if (ts.isStringLiteral(current.literal)) {
        members.push(current.literal.text);
        return true;
      }
      return false;
    }
    if (ts.isUnionTypeNode(current)) {
      return current.types.every((part) => collect(part));
    }
    return false;
  };
  if (!collect(node)) return undefined;
  return members.length >= 2 ? members : undefined;
}

/** 文档里被禁的「task 有状态」句子形状。 */
const FORBIDDEN_DOC_PATTERNS: readonly RegExp[] = [
  /状态机/u,
  /存活三值/u,
  /liveness\s*三值/u,
  /唯一任务级状态/u,
  /任务级状态/u,
  /running\s*\/\s*died\s*\/\s*waiting_user/u,
  /存活\s*[（(]\s*running/u,
];

/** 否定词：句子内出现任一 = 描述「没有/不维护」，不是把状态写成现行属性。 */
const NEGATION_RE = /不|没有|已删|删除|不再|无/u;

/**
 * 扫描器（纯函数）：文档句子把 task/任务/底账描述成有状态机/存活三值/任务级状态。
 * 句子 = 以 。；换行 切分；必须同时出现 task 主语与禁句形状，且句子内没有否定词。
 */
export function findForbiddenStateDocs(docs: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of docs) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const sentence of line.split(/[。；]/u)) {
        if (!/task|任务|底账/iu.test(sentence)) continue;
        if (NEGATION_RE.test(sentence)) continue;
        const pattern = FORBIDDEN_DOC_PATTERNS.find((candidate) => candidate.test(sentence));
        if (pattern !== undefined) {
          hits.push({ file, hit: `line ${index + 1}: ${sentence.trim().slice(0, 80)}` });
        }
      }
    });
  }
  return hits;
}

/** 产品面源码（测试文件自身含被判词串与断言，不参与形状扫描）。 */
function productSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of listFiles(path.join(ROOT, dir), '.ts')) {
      const rel = path.relative(ROOT, file);
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      if (rel === path.join('packages', 'agent', 'task-lifecycle-enum-guard.test.ts')) continue;
      sources.set(rel, readFileSync(file, 'utf8'));
    }
  }
  return sources;
}

/**
 * 文档面：**现行** docs/**.md + 仓根 AGENTS.md。
 * `docs/history/` 是历史分片（已删机制的原文记录，写作约束要求原样保留），不参与现行口径守卫。
 */
function docSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of listFiles(path.join(ROOT, 'docs'), '.md')) {
    const rel = path.relative(ROOT, file);
    if (rel.split(path.sep).includes('history')) continue;
    sources.set(rel, readFileSync(file, 'utf8'));
  }
  sources.set('AGENTS.md', readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'));
  return sources;
}

describe('不维护任务状态机：代码里没有任务级生命周期枚举', () => {
  it('① 产品源码没有「读事实/事件 → 返回任务级收尾词/存活词」的函数', () => {
    expect(findForbiddenLifecycleFunctions(productSources())).toEqual([]);
  });

  it('② 导出的共享类型里没有任务级生命周期枚举（收尾枚举 / liveness 三值）', () => {
    expect(findForbiddenLifecycleTypes(productSources())).toEqual([]);
  });

  it('③ 被删机制的原名不再存在（terminationKindOf / TaskTerminationKind / TaskLiveness / taskLivenessOf）', () => {
    const sources = productSources();
    const offenders = [...sources]
      .filter(([, text]) => /terminationKindOf|TaskTerminationKind|TaskLiveness\b|taskLivenessOf/u.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('④ 反向绊线：把被删形状放回合成源码，扫描器必须报红；合法负例不得报红', () => {
    // 收尾分类器（被删 terminationKindOf 的形状：读任务事实 → return 终止种类）。
    const classifier = findForbiddenLifecycleFunctions(new Map([
      ['packages/agent/src/x.ts', `
        export function terminationKindOf(task: { endedAt?: string; resultText?: string }): string | undefined {
          if (task.endedAt === undefined) return undefined;
          if (task.resultText !== undefined) return 'completed';
          return 'cancelled';
        }`],
    ]));
    expect(classifier.some((hit) => hit.hit.startsWith('ending:'))).toBe(true);

    // 换名换字段：读执行账本 → return 两个收尾词（任务级分类器，不是单行归一化）。
    const renamed = findForbiddenLifecycleFunctions(new Map([
      ['scripts/y.ts', `
        export function observe(task: { executions?: Array<{ status: string }> }): string {
          return (task.executions ?? []).length === 0 ? 'round_failed' : 'died';
        }`],
    ]));
    expect(renamed.some((hit) => hit.hit.startsWith('ending:'))).toBe(true);

    // liveness 三值函数（被删 taskLivenessOf 的形状）。
    const liveness = findForbiddenLifecycleFunctions(new Map([
      ['packages/agent/src/z.ts', `
        export function livenessOf(task: { pendingQuestion?: unknown; endedAt?: string }): string {
          if (task.endedAt !== undefined) return 'died';
          if (task.pendingQuestion !== undefined) return 'waiting_user';
          return 'running';
        }`],
    ]));
    expect(liveness.some((hit) => hit.hit.startsWith('liveness:'))).toBe(true);

    // 类型：纯收尾枚举（TaskTerminationKind 的形状：词表常量 + 派生类型）。
    const endingType = findForbiddenLifecycleTypes(new Map([
      ['packages/core/src/p.ts', `
        export const KINDS = ['cancelled', 'timed_out', 'died'] as const;
        export type TerminationKind = (typeof KINDS)[number];`],
    ]));
    expect(endingType.some((hit) => hit.hit.startsWith('const-ending:'))).toBe(true);
    const endingUnion = findForbiddenLifecycleTypes(new Map([
      ['packages/core/src/p.ts', `export type TerminationKind = 'cancelled' | 'timed_out' | 'died';`],
    ]));
    expect(endingUnion.some((hit) => hit.hit.startsWith('type-ending:'))).toBe(true);

    // 类型：排队 + 在跑 + 死 + 取消的换形状态枚举。
    const stateShape = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/s.ts', `export type TaskPhase = 'queued' | 'running' | 'died' | 'cancelled';`],
    ]));
    expect(stateShape.some((hit) => hit.hit.startsWith('type-ending:'))).toBe(true);

    // 类型：liveness 三值（TaskLiveness 的形状）。
    const livenessType = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/l.ts', `export type TaskLiveness = 'running' | 'died' | 'waiting_user';`],
    ]));
    expect(livenessType.some((hit) => hit.hit.startsWith('type-liveness:'))).toBe(true);

    // 合法负例 1：执行层原始状态并集（每笔执行的事实，保留）。
    const executionStatus = findForbiddenLifecycleTypes(new Map([
      ['packages/contracts/src/c.ts', `export type ExecutionStatus = 'completed' | 'needs_confirmation' | 'needs_input' | 'failed' | 'refused' | 'accepted';`],
    ]));
    expect(executionStatus).toEqual([]);

    // 合法负例 2：单条执行行成败归一化（只 {completed,failed} 且不读任务事实）。
    const rowNormalization = findForbiddenLifecycleFunctions(new Map([
      ['apps/server/x.ts', `
        function rowPassed(execution: { status: string }): string {
          return execution.status === 'failed' ? 'failed' : 'completed';
        }`],
    ]));
    expect(rowNormalization).toEqual([]);

    // 合法负例 3：事件/通知通道枚举（混有事件词表，是「发生了什么」的通道）。
    const eventChannel = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/n.ts', `export type FactChannel = 'accepted' | 'started' | 'cancelled' | 'timed_out' | 'resource_limited';`],
    ]));
    expect(eventChannel).toEqual([]);
  });

  it('⑤ 文档里没有把 task 描述成有状态机/存活三值/任务级状态的句子', () => {
    expect(findForbiddenStateDocs(docSources())).toEqual([]);
  });

  it('⑥ 反向绊线：把状态机文档句放回合成文档，扫描器必须报红；否定句不得报红', () => {
    const byLiveness = findForbiddenStateDocs(new Map([
      ['docs/architecture/tasks.md', 'task 的「状态」只有存活三值（running/died/waiting_user）。'],
    ]));
    expect(byLiveness.length).toBeGreaterThan(0);

    const byStateMachine = findForbiddenStateDocs(new Map([
      ['docs/design/task-redefinition.md', '任务底账按状态机推进：排队 → 在跑 → 终态。'],
    ]));
    expect(byStateMachine.length).toBeGreaterThan(0);

    const negation = findForbiddenStateDocs(new Map([
      ['docs/architecture/tasks.md', '不维护任务状态机：task 只存事实，活/结束现推。'],
    ]));
    expect(negation).toEqual([]);

    const unrelated = findForbiddenStateDocs(new Map([
      ['docs/architecture/channels.md', '投递状态分已送达/未送达，与任务无关。'],
    ]));
    expect(unrelated).toEqual([]);
  });
});
