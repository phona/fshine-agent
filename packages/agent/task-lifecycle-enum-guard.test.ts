/**
 * 「不维护任务状态机」守卫（2026-11-23 owner 定；删状态机轮；2026-11-23 第 1 轮审查加固）。
 *
 * 口径（docs/architecture/tasks.md §1、docs/design/task-redefinition.md §3/§7、AGENTS.md）：
 * task 只存事实（身份/归属/交办原文/汇报/提问/执行账本）；活/结束现推；消费方读原始事实算。
 * **不存在**「任务级生命周期枚举」：既没有终止种类（cancelled/timed_out/resource_limited/
 * died/round_failed/completed），也没有 liveness 三值（running/died/waiting_user）。
 *
 * 守卫按**形状**判（不认函数名/字段名）：
 *   ① 函数形状：函数**自身** return 出，或 push/unshift 进数组（事实投影的常见写法），
 *      ≥2 个「任务级收尾词」（died/cancelled/canceled/timed_out/resource_limited/
 *      round_failed/completed/failed）→ 红。
 *      例外（形状明确、与执行层事实同源）：词只落在执行行原始状态 {completed, failed} 内，
 *      且不读任何任务行事实字段——这是「单条执行行成败归一化」，不是任务级分类器。
 *   ② 函数形状·存活：函数自身 return/push 出 ≥2 个存活词（running/died/waiting_user）→ 红。
 *   ③ 类型形状·收尾：导出的字符串字面量并集，含 ≥2 个收尾词 → 红。**不再豁免**混有事件/
 *      通知词的并集：`completed|failed|cancelled|waiting_user|warning` 这种「投递归属/事实
 *      种类」与通知 kind 并集正是任务级分类器的换形。合法例外只有「单笔执行/操作账状态」
 *      并集（成员全部落在执行行状态 + claimed/unknown 内）——那是每笔执行的事实，不是任务级
 *      聚合；执行行状态并集本身（ExecutionStatus）照旧放行。
 *   ④ 类型形状·存活：导出的字符串字面量并集，含 ≥2 个存活词（running/died/waiting_user）→ 红。
 *   ⑤ 类型形状·字段：导出 interface/对象类型里的属性名形如 `taskStatus` / `taskState` /
 *      `taskLiveness`（或属性类型是 ≥2 收尾词/存活词的字符串并集）→ 红。底账事实字段用原始
 *      布尔/时刻（progressing / waitingSince / lastAt），不传任务级状态词。
 *   ⑥ 文档形状：docs/**.md 与 AGENTS.md 的**句子**里，把 task/任务/底账描述成有
 *      「状态机 / 存活三值 / liveness 三值 / 唯一任务级状态 / running/died/waiting_user」
 *      属性且句子内没有否定词（不/没有/已删/删除/不再/无）→ 红；句子没有 task 主语但带任务
 *      生命周期邻近词（running/waiting/cancelled/取消/超时/等待/失败/完成…）同样判——表格
 *      单元格「状态机、取消、故障注入」这类陈旧清单不得漏判。
 *   ⑦ 源码注释形状：产品源码（apps/packages/scripts 的非测试文件）注释里出现同样的禁句
 *      （状态机/存活三值/任务级状态，带 task 主语或生命周期邻近词）且没有否定词 → 红。
 *      注释不参与运行时，但把「等待状态机 / 存活三值」写成现行属性会误导后续实现。
 *   ⑧ 反向绊线（实跑）：把被删形状（终止种类函数 / 收尾枚举 / liveness 三值 / 底账状态投影
 *      push / interface taskStatus 字段 / 状态机文档句 / 状态机源码注释）放回合成源码与合成
 *      文档，扫描器必须报红；合法负例（执行层原始状态并集、操作账状态、通知事件通道、否定句、
 *      无关状态机句）不得报红——证明守卫不是见词就杀。
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

/**
 * 单笔执行/操作账的原始状态词：执行行 status + 账号行的 claimed/unknown。
 * 这些是「一笔操作怎么了」的执行层事实；并集全部落在其中 = 单笔账状态，不是任务级分类器。
 */
const EXECUTION_ROW_STATUS_WORDS = new Set([
  ...EXECUTION_STATUS_WORDS,
  'claimed',
  'unknown',
  // 执行采集面的单笔执行事实（eval judge 的 ExecutionFact.status：查不到对象也是这一笔的事实）。
  'not_found',
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

/**
 * 是否「产出事实」的调用：数组 push/unshift（底账投影、事件清单的常见写法）。
 * 只收这些位置，避免把 log({result:'cancelled'}) 这类单笔执行日志误判成任务级分类器。
 */
function producesFactCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.name)
    && (callee.name.text === 'push' || callee.name.text === 'unshift');
}

/** 函数自身（不下潜内层函数）的 return/push 词与任务事实读取。 */
function functionShape(fn: ts.Node): FunctionShape {
  const words = new Set<string>();
  let readsTaskFacts = false;
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) collectReturnedWords(node.expression, words);
    if (producesFactCall(node)) {
      for (const argument of node.arguments) collectReturnedWords(argument, words);
    }
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
 * 扫描器（纯函数，供反向绊线自证）：返回「函数 return/push 出任务级生命周期词」的命中点。
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
 * ③ 收尾词 ≥2（例外：并集全部落在单笔执行/操作账状态内 = 执行行事实，不是任务级聚合）；
 * ④ 存活词 ≥2（liveness 三值及其换形）。
 */
export function findForbiddenLifecycleTypes(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const checkMembers = (name: string, members: string[], label: string): void => {
      const endings = members.filter((member) => ENDING_WORDS.has(member));
      const liveness = members.filter((member) => LIVENESS_WORDS.has(member));
      const executionRowStatuses = members.every((member) => EXECUTION_ROW_STATUS_WORDS.has(member));
      if (endings.length >= 2 && !executionRowStatuses) {
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

/** 任务级状态字段名形状（`taskStatus` / `taskState` / `taskLiveness` / `taskLifecycle*`）。 */
const TASK_STATE_FIELD_RE = /^task(?:Status|State|Liveness|Lifecycle)/u;

/**
 * 扫描器（纯函数）：导出 interface / 对象类型里的「任务级状态字段」。
 * ⑤ 属性名形如 taskStatus/taskState/taskLiveness → 红（底账事实字段用原始布尔/时刻）；
 *    属性类型是内联字符串并集且命中收尾/存活形状 → 红（换字段名也拦）。
 */
export function findForbiddenLifecycleFields(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const checkMembers = (owner: string, members: readonly ts.TypeElement[]): void => {
      for (const member of members) {
        if (!ts.isPropertySignature(member) || member.name === undefined || !ts.isIdentifier(member.name)) continue;
        const name = member.name.text;
        if (TASK_STATE_FIELD_RE.test(name)) {
          hits.push({ file, hit: `field:${owner}.${name}` });
          continue;
        }
        if (member.type === undefined) continue;
        // 嵌套对象类型里的字段也要扫（`truth: { taskStatus?: … }` 这种换形不放过）。
        if (ts.isTypeLiteralNode(member.type)) {
          checkMembers(`${owner}.${name}`, member.type.members);
          continue;
        }
        const union = typeLiteralMembers(member.type);
        if (union === undefined) continue;
        const endings = union.filter((word) => ENDING_WORDS.has(word));
        const liveness = union.filter((word) => LIVENESS_WORDS.has(word));
        const executionRowStatuses = union.every((word) => EXECUTION_ROW_STATUS_WORDS.has(word));
        if ((endings.length >= 2 && !executionRowStatuses) || liveness.length >= 2) {
          hits.push({ file, hit: `field-type:${owner}.${name}(${union.sort().join(',')})` });
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) checkMembers(node.name.text, node.members);
      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
        checkMembers(node.name.text, node.type.members);
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
  // 「状态机械读数」里的「状态机」不是状态机——排除这种中文子串误报。
  /状态机(?!械)/u,
  /存活三值/u,
  /liveness\s*三值/u,
  /唯一任务级状态/u,
  /任务级状态/u,
  /running\s*\/\s*died\s*\/\s*waiting_user/u,
  /存活\s*[（(]\s*running/u,
];

/** 否定词：子句内出现任一 = 描述「没有/不维护/已删除」，不是把状态写成现行属性。 */
const NEGATION_RE = /不|没有|删|不再|无/u;

/** 句子主语：task 本身。 */
const TASK_SUBJECT_RE = /task|任务|底账/iu;

/**
 * 任务生命周期邻近词：句子没写 task 主语、但在列任务生命周期相关事实（表格单元格/清单）
 * 时同样算「把状态当现行属性」。只用于禁句形状的邻近判定，不单独判负。
 */
const LIFECYCLE_PROXIMITY_RE = /running|waiting(?:_user)?|cancelled|canceled|timed_out|resource_limited|completed|failed|终态|结束事实|存活三值|liveness\s*三值|取消|超时|等待|失败|完成/iu;

/**
 * 禁句形状判定：整句先有 task 主语或生命周期邻近词（否则是无关的「状态机」句）；
 * 再按子句判禁句形状——整句级否定会误放行「（无队列位）→ 任务按状态机…」这类句子，
 * 所以否定只在**命中禁句的那个子句**里才算数。
 */
function forbiddenStateSentence(sentence: string): RegExp | undefined {
  if (!TASK_SUBJECT_RE.test(sentence) && !LIFECYCLE_PROXIMITY_RE.test(sentence)) return undefined;
  for (const clause of sentence.split(/[，,（）()→]|——/u)) {
    if (NEGATION_RE.test(clause)) continue;
    const pattern = FORBIDDEN_DOC_PATTERNS.find((candidate) => candidate.test(clause));
    if (pattern !== undefined) return pattern;
  }
  return undefined;
}

/**
 * 扫描器（纯函数）：文档句子把 task/任务/底账描述成有状态机/存活三值/任务级状态。
 * 句子 = 以 。；切分（按行）；否定句与无关状态机句不得判红。
 */
export function findForbiddenStateDocs(docs: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of docs) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const sentence of line.split(/[。；]/u)) {
        if (forbiddenStateSentence(sentence) === undefined) continue;
        hits.push({ file, hit: `line ${index + 1}: ${sentence.trim().slice(0, 80)}` });
      }
    });
  }
  return hits;
}

/**
 * 源码注释（单行 + 块注释）取出：用 TS 语法树的 leading/trailing comment ranges。
 * 不用裸 scanner——模板字符串里的 `${}` 会让 scanner 错过插值后的注释。
 */
function commentLinesOf(file: string, text: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const ranges = new Map<number, ts.CommentRange>();
  const add = (candidates: readonly ts.CommentRange[] | undefined): void => {
    for (const range of candidates ?? []) if (!ranges.has(range.pos)) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...ranges.values()]
    .sort((left, right) => left.pos - right.pos)
    .map((range) => ({ line: sf.getLineAndCharacterOfPosition(range.pos).line + 1, text: text.slice(range.pos, range.end) }));
}

/**
 * 扫描器（纯函数）：产品源码**注释**把 task 描述成有状态机/存活三值/任务级状态。
 * 与文档同一禁句形状（含否定句放行）；注释里的 `//` / `/** *\/` 都扫。
 */
export function findForbiddenStateComments(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    for (const comment of commentLinesOf(file, text)) {
      for (const line of comment.text.split('\n')) {
        for (const sentence of line.split(/[。；]/u)) {
          if (forbiddenStateSentence(sentence) === undefined) continue;
          hits.push({ file, hit: `line ${comment.line}: ${sentence.replace(/^[\s/*]+/u, '').trim().slice(0, 80)}` });
        }
      }
    }
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
  it('① 产品源码没有「读事实/事件 → 返回或 push 任务级收尾词/存活词」的函数', () => {
    expect(findForbiddenLifecycleFunctions(productSources())).toEqual([]);
  });

  it('② 导出的共享类型里没有任务级生命周期枚举（收尾枚举 / liveness 三值）', () => {
    expect(findForbiddenLifecycleTypes(productSources())).toEqual([]);
  });

  it('③ 导出类型/interface 里没有 taskStatus/taskState 之类任务级状态字段', () => {
    expect(findForbiddenLifecycleFields(productSources())).toEqual([]);
  });

  it('④ 被删机制的原名不再存在（terminationKindOf / TaskTerminationKind / TaskLiveness / taskLivenessOf）', () => {
    const sources = productSources();
    const offenders = [...sources]
      .filter(([, text]) => /terminationKindOf|TaskTerminationKind|TaskLiveness\b|taskLivenessOf/u.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('⑤ 反向绊线：把被删形状放回合成源码，扫描器必须报红；合法负例不得报红', () => {
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

    // 底账投影的 push 形状：不是 return，而是把任务级状态词 push 进事实数组（判据 1 的真实形状）。
    const pushedProjection = findForbiddenLifecycleFunctions(new Map([
      ['packages/agent/src/alert-persistence.ts', `
        export function ledgerFacts(task: { pendingQuestion?: unknown; runningSince?: string }): unknown[] {
          const facts: unknown[] = [];
          const waiting = task.pendingQuestion !== undefined;
          facts.push({ event: 'task_state', detail: { taskStatus: waiting ? 'waiting_user' : 'running' } });
          return facts;
        }`],
    ]));
    expect(pushedProjection.some((hit) => hit.hit.startsWith('liveness:'))).toBe(true);

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

    // 类型：投递归属换形——混有事件/通知词（warning）的并集也按收尾词判（判据 1 的真实形状）。
    const deliveryFactKind = findForbiddenLifecycleTypes(new Map([
      ['apps/server/task-completion-delivery.ts',
        `export type TaskResultFactKind = 'completed' | 'failed' | 'cancelled' | 'waiting_user' | 'warning';`],
      ['scripts/eval/shared/conversation-shape.ts',
        `export type TaskFactKind = 'completed' | 'failed' | 'cancelled' | 'waiting_user' | 'warning';`],
    ]));
    expect(deliveryFactKind.filter((hit) => hit.hit.startsWith('type-ending:'))).toHaveLength(2);

    // 类型：liveness 三值（TaskLiveness 的形状）。
    const livenessType = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/l.ts', `export type TaskLiveness = 'running' | 'died' | 'waiting_user';`],
    ]));
    expect(livenessType.some((hit) => hit.hit.startsWith('type-liveness:'))).toBe(true);

    // 字段：底账状态投影的 interface 字段（判据 1 的真实形状：AlertFactDetail.taskStatus）。
    const stateField = findForbiddenLifecycleFields(new Map([
      ['packages/agent/src/alert-rules.ts', `
        export interface AlertFactDetail {
          operation?: string;
          taskStatus?: string;
        }`],
    ]));
    expect(stateField.some((hit) => hit.hit.startsWith('field:AlertFactDetail.taskStatus'))).toBe(true);
    const stateFieldUnion = findForbiddenLifecycleFields(new Map([
      ['packages/agent/src/s.ts', `
        export interface TaskDetail {
          state?: 'running' | 'died' | 'waiting_user';
        }`],
    ]));
    expect(stateFieldUnion.some((hit) => hit.hit.startsWith('field-type:'))).toBe(true);

    // 合法负例 1：执行层原始状态并集（每笔执行的事实，保留）。
    const executionStatus = findForbiddenLifecycleTypes(new Map([
      ['packages/contracts/src/c.ts', `export type ExecutionStatus = 'completed' | 'needs_confirmation' | 'needs_input' | 'failed' | 'refused' | 'accepted';`],
    ]));
    expect(executionStatus).toEqual([]);

    // 合法负例 2：单笔操作账状态（执行行状态 + claimed/unknown）——每笔账的事实，不是任务级聚合。
    const operationStatus = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/task-registry.ts',
        `export type OperationStatus = 'claimed' | 'accepted' | 'completed' | 'needs_confirmation' | 'needs_input' | 'failed' | 'refused' | 'unknown';`],
    ]));
    expect(operationStatus).toEqual([]);

    // 合法负例 3：单条执行行成败归一化（只 {completed,failed} 且不读任务事实）。
    const rowNormalization = findForbiddenLifecycleFunctions(new Map([
      ['apps/server/x.ts', `
        function rowPassed(execution: { status: string }): string {
          return execution.status === 'failed' ? 'failed' : 'completed';
        }`],
    ]));
    expect(rowNormalization).toEqual([]);

    // 合法负例 4：事件/通知通道枚举——只留「发生了什么」的触发词，不得带收尾/存活词。
    const eventChannel = findForbiddenLifecycleTypes(new Map([
      ['packages/agent/src/n.ts',
        `export type FactChannel = 'accepted' | 'started' | 'waiting_user' | 'user_stop' | 'deadline_reached' | 'capacity_blocked';`],
    ]));
    expect(eventChannel).toEqual([]);

    // 合法负例 5：合法字段（底账原始布尔/时刻）不算任务级状态字段。
    const rawFields = findForbiddenLifecycleFields(new Map([
      ['packages/agent/src/a.ts', `
        export interface AlertFactDetail {
          progressing?: boolean;
          waitingSince?: string;
          lastAt?: string;
        }`],
    ]));
    expect(rawFields).toEqual([]);
  });

  it('⑥ 文档里没有把 task 描述成有状态机/存活三值/任务级状态的句子', () => {
    expect(findForbiddenStateDocs(docSources())).toEqual([]);
  });

  it('⑦ 反向绊线：把状态机文档句放回合成文档，扫描器必须报红；否定句/无关句不得报红', () => {
    const byLiveness = findForbiddenStateDocs(new Map([
      ['docs/architecture/tasks.md', 'task 的「状态」只有存活三值（running/died/waiting_user）。'],
    ]));
    expect(byLiveness.length).toBeGreaterThan(0);

    const byStateMachine = findForbiddenStateDocs(new Map([
      ['docs/design/task-redefinition.md', '任务底账按状态机推进：排队 → 在跑 → 终态。'],
    ]));
    expect(byStateMachine.length).toBeGreaterThan(0);

    // 没有 task 主语、但单元格里列了「状态机、取消」这类任务生命周期词的陈旧清单。
    const tableCell = findForbiddenStateDocs(new Map([
      ['docs/product/wecom-live-dummy-cases.md', '| 确定性全量门 | `npm test` | 状态机、取消、故障注入、投递记账等 |'],
    ]));
    expect(tableCell.length).toBeGreaterThan(0);

    const negation = findForbiddenStateDocs(new Map([
      ['docs/architecture/tasks.md', '不维护任务状态机：task 只存事实，活/结束现推。'],
    ]));
    expect(negation).toEqual([]);

    const unrelated = findForbiddenStateDocs(new Map([
      ['docs/architecture/channels.md', '投递状态分已送达/未送达，与任务无关。'],
    ]));
    expect(unrelated).toEqual([]);

    const unrelatedStateMachine = findForbiddenStateDocs(new Map([
      ['AGENTS.md', '异步交错、竞态这类 blocking：要么把状态机重做一次，要么升级给人。'],
    ]));
    expect(unrelatedStateMachine).toEqual([]);
  });

  it('⑧ 产品源码注释里没有把 task 描述成有状态机/存活三值/任务级状态的句子', () => {
    expect(findForbiddenStateComments(productSources())).toEqual([]);
  });

  it('⑨ 反向绊线：把状态机注释放回合成源码，扫描器必须报红；否定注释不得报红', () => {
    const byStateMachine = findForbiddenStateComments(new Map([
      ['packages/agent/src/x.ts', '// 任务按 P2 状态机落终态 failed + resource_limited'],
    ]));
    expect(byStateMachine.length).toBeGreaterThan(0);

    const byWaiting = findForbiddenStateComments(new Map([
      ['packages/agent/src/y.ts', '// 状态机禁止 waiting→waiting：回 running 再进等待 = 新的一次'],
    ]));
    expect(byWaiting.length).toBeGreaterThan(0);

    const byLiveness = findForbiddenStateComments(new Map([
      ['packages/agent/src/z.ts', '// 账本机械事实（存活三值 + 收尾/汇报/执行事实）'],
    ]));
    expect(byLiveness.length).toBeGreaterThan(0);

    const negation = findForbiddenStateComments(new Map([
      ['packages/agent/src/a.ts', '// 不维护任务状态机：task 只存事实，活/结束现推。'],
      ['packages/agent/src/b.ts', '// 文件投递一条 UPDATE，无状态机。'],
    ]));
    expect(negation).toEqual([]);

    const unrelated = findForbiddenStateComments(new Map([
      ['packages/agent/src/c.ts', '// 退避重试：指数退避，与任务无关。'],
    ]));
    expect(unrelated).toEqual([]);
  });
});
