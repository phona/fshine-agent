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

/**
 * 任务级专属收尾词：只可能是「整个任务怎么结束」的结论词，不是单笔执行行 status
 * （completed/failed/refused 是执行层契约事实，允许单值出现）。单值返回这些词 = 任务级
 * 失败原因/终止种类分类器（2026-11-23 第 2 轮审查的真实形状）。
 */
const TASK_EXCLUSIVE_ENDING_WORDS = new Set([
  'died',
  'cancelled',
  'canceled',
  'timed_out',
  'resource_limited',
  'round_failed',
]);

/** 存活词（liveness 三值及其换形）。 */
const LIVENESS_WORDS = new Set(['running', 'died', 'waiting_user']);

/** 任务级生命周期**事件名**（`task_completed` / `task_failed` / …）：对象键表也不得出现。 */
const TASK_LIFECYCLE_EVENT_NAME_RE = /^task_(?:completed|failed|cancelled|canceled|timed_out|timeout|died|round_failed|resource_limited)$/u;

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
  /** 顶层 return 的裸值（字面量 / 同文件 const 字符串），不含对象属性值。 */
  bareWords: Set<string>;
  readsTaskFacts: boolean;
}

/** 同文件里 const 字符串字面量（含 `as const`）：用于解析 `return SOME_REASON` 的形状。 */
function constStringLiterals(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      let initializer: ts.Expression = node.initializer;
      while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)
        || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        map.set(node.name.text, initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** 解析表达式为字符串字面量（含同文件 const 引用）；解析不出返回 undefined。 */
function resolveStringExpr(node: ts.Node, consts: ReadonlyMap<string, string>): string | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return resolveStringExpr(node.expression, consts);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text);
  return undefined;
}

/** 函数顶层 return 的裸值词（三元两支；不下潜对象/数组属性）。 */
function collectBareReturnWords(node: ts.Node, consts: ReadonlyMap<string, string>, words: Set<string>): void {
  if (ts.isConditionalExpression(node)) {
    collectBareReturnWords(node.whenTrue, consts, words);
    collectBareReturnWords(node.whenFalse, consts, words);
    return;
  }
  const word = resolveStringExpr(node, consts);
  if (word !== undefined) words.add(word);
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
function functionShape(fn: ts.Node, consts: ReadonlyMap<string, string>): FunctionShape {
  const words = new Set<string>();
  const bareWords = new Set<string>();
  let readsTaskFacts = false;
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      collectReturnedWords(node.expression, words);
      collectBareReturnWords(node.expression, consts, bareWords);
    }
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
  return { name: functionName(fn), words, bareWords, readsTaskFacts };
}

/**
 * 扫描器（纯函数，供反向绊线自证）：返回「函数 return/push 出任务级生命周期词」的命中点。
 * ① 收尾词 ≥2（例外：只 {completed,failed} 且不读任务事实 = 执行行归一化）；
 * ② 存活词 ≥2；
 * ③ 单值任务级失败原因/终止种类：顶层 return 裸出 ≥1 个任务级专属收尾词
 *   （died/cancelled/timed_out/resource_limited/round_failed；含 `return SOME_REASON`
 *   的同文件 const 解析）。对象属性里的 `{ kind: 'cancelled' }` 不在此列——那是单笔回合事实。
 */
export function findForbiddenLifecycleFunctions(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const consts = constStringLiterals(sf);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const { name, words, bareWords, readsTaskFacts } = functionShape(node, consts);
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
        const exclusive = [...bareWords].filter((word) => TASK_EXCLUSIVE_ENDING_WORDS.has(word));
        if (exclusive.length >= 1) {
          hits.push({ file, hit: `single-ending:${name ?? '<anonymous>'}(${exclusive.sort().join(',')})` });
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

/**
 * 扫描器（纯函数）：任务级生命周期**事件名**（`task_completed` / `task_failed` /
 * `task_cancelled` / `task_timeout` …）作为字符串字面量或对象键出现 → 红。
 * 这是「任务生命周期事件名表」（Record/对象键式）的形状：怎么结束不存，也不给它起事件名。
 */
export function findForbiddenTaskEventNames(sources: ReadonlyMap<string, string>): Array<{ file: string; hit: string }> {
  const hits: Array<{ file: string; hit: string }> = [];
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const check = (value: string, line: number): void => {
      if (TASK_LIFECYCLE_EVENT_NAME_RE.test(value)) hits.push({ file, hit: `event-name:line ${line}:${value}` });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        check(node.text, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        check(node.name.text, sf.getLineAndCharacterOfPosition(node.name.getStart()).line + 1);
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

/** 任务级 lifecycle 状态词（英文；文档/注释把它们当任务属性写才是禁句）。 */
const TASK_STATE_WORDS = 'running|waiting_user|cancelled|canceled|timed_out|resource_limited|completed|failed|died';

/** 文档里被禁的「task 有状态」句子形状（按子句判）。 */
const FORBIDDEN_DOC_PATTERNS: readonly RegExp[] = [
  // 「状态机械读数」里的「状态机」不是状态机——排除这种中文子串误报。
  /状态机(?!械)/u,
  /存活三值/u,
  /liveness\s*三值/u,
  /唯一任务级状态/u,
  /任务级状态/u,
  /running\s*\/\s*died\s*\/\s*waiting_user/u,
  /存活\s*[（(]\s*running/u,
  // 任务级状态序列 / 终态 / 失败原因（2026-11-23 第 2 轮审查的真实形状）。
  new RegExp(`状态序列[^。；\\n]{0,40}(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`任务终局\\s*(?:=|为|是|：|:)\\s*[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`底账终态\\s*(?:=|为|是|：|:)?\\s*[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`底账状态[^。；\\n]{0,12}[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`任务\\s*[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`任务[^。；\\n]{0,12}(?:保持|仍|依旧|处于|落|进入|回|最终|真的|被判|收尾|终局|终态)[^。；\\n]{0,12}[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  // 任务级「终态/终局」措辞（2026-11-23 第 3 轮审查的真实形状）。
  /(?:任务|后台|底账)[^。；\n]{0,8}(?:终态|终局)/u,
  new RegExp(`(?:终态|终局)\\s*(?:[=＝:：]\\s*)?[\\u0060'"*]*(?:${TASK_STATE_WORDS})`, 'iu'),
  /终态类型/u,
  // 「落/进入/处于 + 终态/终局」与「落/回/进入/处于 + 任务级状态词」
  // （落终态、回 running、落终局 completed、底账落 result_unknown；「取回终态」这类执行层措辞不判）。
  new RegExp(`(?:落|进入|处于|收尾为?)\\s*[\\u0060'"*]*(?:终态|终局)`, 'iu'),
  new RegExp(`(?:落|回|进入|处于)\\s*[\\u0060'"*]*(?:result_unknown|unexecuted|running|waiting_user|cancelled|timed_out|died|resource_limited|round_failed)`, 'iu'),
  // 把 task 当状态机的措辞。
  /状态(?:唯一)?写路径/u,
  /状态迁移/u,
  // 旧 liveness 三值换形：存活面/存活谓词 + running。
  /存活[^。；\n]{0,12}(?:running|died|waiting_user)/iu,
  // 旧 schema 的 status 列写法（现行底账没有 status/reason/failure_reason 列）。
  /底账[^。；\n]{0,12}\b(?:tasks\.)?status\s*=/iu,
];

/** 跨标点（括号/箭头）才看得出的句子形状：在整句上判（整句无否定词才判）。 */
const FORBIDDEN_SENTENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(`任务收尾[^。；\\n]{0,30}(?:${TASK_STATE_WORDS}|unexecuted)`, 'iu'),
  new RegExp(`底账[^。；\\n]{0,20}(?:终态|状态序列)[^。；\\n]{0,40}(?:${TASK_STATE_WORDS})`, 'iu'),
  new RegExp(`状态序列[^。；\\n]{0,60}(?:${TASK_STATE_WORDS})`, 'iu'),
  // 状态箭头序列（跨箭头才看得出的任务生命周期迁移；`accepted → completed` 属单笔操作账，不判）。
  new RegExp(`(?:queued|running|waiting(?:_user)?|died|cancelled|timed_out|resource_limited|round_failed|终态)[^。；\\n]{0,12}(?:→|->)[^。；\\n]{0,12}(?:queued|running|waiting(?:_user)?|died|cancelled|timed_out|resource_limited|round_failed|终态)`, 'iu'),
];

/**
 * 否定/历史词：子句内出现任一 = 描述「没有/不维护/已删除/旧 schema」，不是现行属性。
 * 历史只认明确标记（旧 schema / 历史 run / 当时 schema），避免「依旧」这类词误豁免。
 */
const NEGATION_RE = /不|没有|删|不再|无|旧\s*schema|历史\s*(?:run|记录|口径)|当时\s*schema/iu;

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
  // 跨标点的形状（任务收尾（completed/failed…）、状态序列 A → B → completed）在整句上判；
  // 整句否定/旧 schema 标注放行。
  if (!NEGATION_RE.test(sentence)) {
    const whole = FORBIDDEN_SENTENCE_PATTERNS.find((candidate) => candidate.test(sentence));
    if (whole !== undefined) return whole;
  }
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

  it('④ 产品源码里没有 task_completed/task_failed 之类的任务级生命周期事件名', () => {
    expect(findForbiddenTaskEventNames(productSources())).toEqual([]);
  });

  it('⑤ 被删机制的原名不再存在（terminationKindOf / TaskTerminationKind / TaskLiveness / taskLivenessOf）', () => {
    const sources = productSources();
    const offenders = [...sources]
      .filter(([, text]) => /terminationKindOf|TaskTerminationKind|TaskLiveness\b|taskLivenessOf/u.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('⑥ 反向绊线：把被删形状放回合成源码，扫描器必须报红；合法负例不得报红', () => {
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

    // 单值任务级失败原因函数（第 2 轮审查真实形状：const 原因 + return CONST）。
    const singleReason = findForbiddenLifecycleFunctions(new Map([
      ['packages/agent/src/resource-policy.ts', `
        export const RESOURCE_LIMITED_REASON = 'resource_limited' as const;
        export function taskFailureReasonFor(_rejection: unknown): typeof RESOURCE_LIMITED_REASON {
          return RESOURCE_LIMITED_REASON;
        }`],
    ]));
    expect(singleReason.some((hit) => hit.hit.startsWith('single-ending:'))).toBe(true);

    // 合法负例：单笔回合事实 `{ kind: 'cancelled' }` 是对象属性值，不是任务级单值分类器。
    const roundOutcomeObject = findForbiddenLifecycleFunctions(new Map([
      ['packages/agent/src/x.ts', `
        function abortedOutcome(): { kind: 'cancelled' } {
          return { kind: 'cancelled' };
        }`],
    ]));
    expect(roundOutcomeObject).toEqual([]);

    // 对象键式任务生命周期事件名表（第 2 轮审查真实形状：BLOCKED_EVENTS）。
    const eventTable = findForbiddenTaskEventNames(new Map([
      ['scripts/ask-replay.ts', `
        const BLOCKED_EVENTS: Readonly<Record<string, string>> = {
          task_completed: '依赖 P2（任务生命周期），未合入',
          task_failed: '依赖 P2（任务生命周期），未合入',
        };`],
    ]));
    expect(eventTable.some((hit) => hit.hit.startsWith('event-name:'))).toBe(true);

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

  it('⑦ 文档里没有把 task 描述成有状态机/存活三值/任务级状态的句子', () => {
    expect(findForbiddenStateDocs(docSources())).toEqual([]);
  });

  it('⑧ 反向绊线：把状态机文档句放回合成文档，扫描器必须报红；否定句/无关句不得报红', () => {
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

    // 状态序列 / 任务终局 / 底账终态（第 2 轮审查的真实文档形状）。
    const stateSequence = findForbiddenStateDocs(new Map([
      ['docs/ops/real-write-loop.md', '底账状态序列按序包含 `running → waiting_user → running → completed`。'],
    ]));
    expect(stateSequence.length).toBeGreaterThan(0);
    const terminal = findForbiddenStateDocs(new Map([
      ['apps/server/task-completion-delivery.ts', '一次后台任务失败的事实（任务终局 = failed）。'],
      ['docs/ops/real-write-loop.md', '底账终态 completed；成功 prepare 先于唯一一次成功 commit。'],
    ]));
    expect(terminal.length).toBeGreaterThanOrEqual(2);
    const taskStateWord = findForbiddenStateDocs(new Map([
      ['docs/product/wecom-live-dummy-cases.md', '任务在后台推进并最终 completed。'],
      ['docs/architecture/contract.md', 'wait 截断时任务保持 running，不杀任务。'],
    ]));
    expect(taskStateWord.length).toBeGreaterThanOrEqual(2);
    const taskStatusColumn = findForbiddenStateDocs(new Map([
      ['docs/ops/real-write-loop.md', '任务底账 `status=failed`，`reason=failed_confirmed`。'],
    ]));
    expect(taskStatusColumn.length).toBeGreaterThan(0);

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

    const oldSchemaMarked = findForbiddenStateDocs(new Map([
      ['docs/ops/real-write-loop.md', '历史 run 的旧 schema 任务底账 `status=failed`，现行无该列。'],
    ]));
    expect(oldSchemaMarked).toEqual([]);

    const executionRowFact = findForbiddenStateDocs(new Map([
      ['docs/architecture/contract.md', '执行行 completed / failed 是执行层契约事实，原样转述。'],
      ['docs/product/capability.md', '任务完成后通知用户，不给状态词。'],
    ]));
    expect(executionRowFact).toEqual([]);
  });

  it('⑨ 产品源码注释里没有把 task 描述成有状态机/存活三值/任务级状态的句子', () => {
    expect(findForbiddenStateComments(productSources())).toEqual([]);
  });

  it('⑩ 反向绊线：把状态机注释放回合成源码，扫描器必须报红；否定注释不得报红', () => {
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

    // 任务级终态/状态序列注释（第 2 轮审查的真实注释形状）。
    const byTaskTerminal = findForbiddenStateComments(new Map([
      ['apps/server/task-completion-delivery.ts', '// 一次后台任务失败的事实（任务终局 = failed）。'],
      ['apps/server/server.ts', '// 任务落 waiting_user → 唤醒原会话模型说。'],
    ]));
    expect(byTaskTerminal.length).toBeGreaterThanOrEqual(2);
    const bySequence = findForbiddenStateComments(new Map([
      ['scripts/eval/real/write-loop.ts', '// C9 底账状态序列按序包含 running → waiting_user → running → completed。'],
    ]));
    expect(bySequence.length).toBeGreaterThan(0);

    // 第 3 轮审查的真实形状：终态/终局措辞、落/回 + 状态词、状态唯一写路径、存活面 running。
    const byTerminalWording = findForbiddenStateComments(new Map([
      ['packages/agent/src/t1.ts', '// 任务终态——(taskId, 终态类型) 一次性核销。'],
      ['packages/agent/src/t2.ts', '// 确认才落 cancelled，否则回 running 并如实记失败事件。'],
      ['packages/agent/src/t3.ts', '// 状态唯一写路径 = 注入的 TaskRegistryPort；后台终态 = 执行端确认的回合结局。'],
      ['packages/agent/src/t4.ts', '// 残留有效租约，存活面会一直报「running」。'],
      ['scripts/eval/real/w2.ts', '// 两件事都落终局 completed（没有失败/超时/未知/残留）。'],
      ['packages/agent/src/t5.ts', '// 已启动且租约过期 → 底账落 result_unknown（禁止自动重放）。'],
    ]));
    expect(byTerminalWording.length).toBeGreaterThanOrEqual(6);

    // 负例：单笔操作账、执行层失败码、投递终态与任务无关，不得误伤。
    const inlineFacts = findForbiddenStateComments(new Map([
      ['packages/agent/src/n1.ts', '// 操作账行落定：accepted → completed/failed（单笔操作状态，非任务级）。'],
      ['packages/agent/src/n2.ts', '// 适配器如实回 `failed` + `code: result_unknown`，不代表长任务失败。'],
      ['packages/agent/src/n3.ts', '// 通知投递终态跳过不重试（部署属性），不告警。'],
    ]));
    expect(inlineFacts).toEqual([]);

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
