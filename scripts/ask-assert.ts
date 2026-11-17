/**
 * P7a 断言引擎（最小集；脚本回放的 expect 判定）。
 *
 * 依据：R4 验收设计 §3.1「断言类型（最小集）」与 P7-T02/T03。owner 裁定 P7a 只做前置能力：
 *   · 支持：reply_contains / reply_not_contains / task_state / task_no / execution_count /
 *     hash_unchanged / no_fabricated；
 *   · blocked（未就绪依赖，fail-closed 报 blocked，不静默通过、不计入 pass）：
 *     notification_delivered（P4）、resource_released（P5）、not_blocked/main_not_blocked（P5/P6）。
 *
 * 语义边界（与本文件一并冻结，见 scripts/ask-replay.test.ts）：
 *   · after=N 指第 N 回合（1-based）；after='all' 指全部回合（回复按序拼接）。
 *   · task 为 1-based 任务序（按本回放底账创建序）；缺省第 1 个。
 *   · task_no：钉「任务标识非空、互异（不复用）、跨回合稳定」不变量；P1（task_no 列）合入后
 *     实现升级为同时接受 #<no> 形态的 value（当前 value 匹配底账标识）。
 *   · hash_unchanged：facts.hashBaselines 为载入时基线（脚本目录相对路径原样为 key），
 *     facts.hashNow 读现值；两者缺一即 fail（不可验证 = 不通过）。
 *   · no_fabricated：P7a 子集取**严格可溯源**口径（比 convergence-r1 的「无法溯源独立数字=
 *     弱告警」更严）：回复中每个数值 token 必须能在该时点的机械证据中溯源（回合用户消息、
 *     该回合执行层审计行、任务汇报文本）；本断言由脚本显式声明时启用。
 *   · 未知 kind 在 parse 阶段即拒绝（脚本级 fail-closed，exit 2）。
 */
import type { TaskRecord } from '../packages/agent/src/task-registry';

export type AssertionAfter = number | 'all';

export interface AssertionSpec {
  after: AssertionAfter;
  assert: string;
  value?: unknown;
  task?: number;
}

/** 断言求值输入：引擎按断言时点构造（数组均为 1-based，索引 0 未用）。 */
export interface AssertionFacts {
  replies: readonly string[];
  messages: readonly string[];
  auditLinesByTurn: readonly (readonly string[])[];
  tasks: readonly TaskRecord[];
  /** 载入时哈希基线：spec.value 原样 → sha256。 */
  hashBaselines: Readonly<Record<string, string>>;
  /** 现值读取（缺省 = 不可验证 → fail）。 */
  hashNow?: (target: string) => string;
}

export interface AssertionResult {
  index: number;
  after: AssertionAfter;
  assert: string;
  status: 'pass' | 'fail' | 'blocked';
  detail: string;
}

/** 支持集（顺序即文档顺序；冻结于测试）。 */
export const SUPPORTED_ASSERTIONS = [
  'reply_contains',
  'reply_not_contains',
  'task_state',
  'task_no',
  'execution_count',
  'hash_unchanged',
  'no_fabricated',
] as const;

/** blocked 集（键=kind，值=未就绪原因；冻结于测试，恰为四个）。 */
export const BLOCKED_ASSERTIONS: Readonly<Record<string, string>> = {
  notification_delivered: '依赖 P4（通知 outbox），未合入——fail-closed 报 blocked，不静默通过。',
  resource_released: '依赖 P5（资源强制），未合入——fail-closed 报 blocked。',
  not_blocked: '依赖 P5/P6（前台不假死/后台调度），未合入——fail-closed 报 blocked。',
  main_not_blocked: '同 not_blocked（§3.1 别名）：依赖 P5/P6，未合入——fail-closed 报 blocked。',
};

type SupportedKind = (typeof SUPPORTED_ASSERTIONS)[number];

function isSupported(kind: string): kind is SupportedKind {
  return (SUPPORTED_ASSERTIONS as readonly string[]).includes(kind);
}

/** 解析一条 expect 条目；任何形状/取值问题抛出（错误进脚本级拒绝，exit 2）。 */
export function parseAssertionSpec(raw: unknown): AssertionSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('断言条目需要对象');
  }
  const record = raw as Record<string, unknown>;
  const after = record['after'];
  if (after !== 'all' && !(typeof after === 'number' && Number.isInteger(after) && after >= 1)) {
    throw new Error(`断言 after 需要 >=1 的整数或 "all"：${String(after)}`);
  }
  const kind = record['assert'];
  if (typeof kind !== 'string' || kind.trim() === '') throw new Error('断言缺少 assert（kind）');
  if (!isSupported(kind) && BLOCKED_ASSERTIONS[kind] === undefined) {
    throw new Error(`未知断言 kind：${kind}`);
  }
  const spec: AssertionSpec = { after, assert: kind };
  if (record['value'] !== undefined) spec.value = record['value'];
  const task = record['task'];
  if (task !== undefined) {
    if (!(typeof task === 'number' && Number.isInteger(task) && task >= 1)) {
      throw new Error(`断言 task 需要 >=1 的整数：${String(task)}`);
    }
    spec.task = task;
  }
  switch (kind) {
    case 'reply_contains':
    case 'reply_not_contains':
    case 'task_state':
      if (typeof spec.value !== 'string' || spec.value === '') {
        throw new Error(`断言 ${kind} 需要非空字符串 value`);
      }
      break;
    case 'task_no':
      if (spec.value !== undefined && (typeof spec.value !== 'string' || spec.value === '')) {
        throw new Error('断言 task_no 的 value 需要非空字符串');
      }
      break;
    case 'execution_count':
      if (!(typeof spec.value === 'number' && Number.isInteger(spec.value) && spec.value >= 0)) {
        throw new Error('断言 execution_count 需要 >=0 的整数 value');
      }
      break;
    case 'hash_unchanged':
      if (typeof spec.value !== 'string' || spec.value === '') {
        throw new Error('断言 hash_unchanged 需要文件路径 value');
      }
      break;
    default:
      break;
  }
  return spec;
}

/** 数值 token（千分位合并；词内数字如 W1/rec-101/#1 不计——标识不是数据）。 */
const NUMBER_TOKEN = /(?<![\w#-])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\w])/g;

export function extractNumberTokens(text: string): number[] {
  const tokens: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    if (Number.isFinite(value)) tokens.push(value);
  }
  return tokens;
}

function replyTextOf(after: AssertionAfter, facts: AssertionFacts): string {
  if (after === 'all') return facts.replies.slice(1).join('\n');
  return facts.replies[after] ?? '';
}

export function evaluateAssertion(spec: AssertionSpec, facts: AssertionFacts, index = 0): AssertionResult {
  const base = { index, after: spec.after, assert: spec.assert };
  const blocked = BLOCKED_ASSERTIONS[spec.assert];
  if (blocked !== undefined) return { ...base, status: 'blocked', detail: blocked };
  const fail = (detail: string): AssertionResult => ({ ...base, status: 'fail', detail });
  const pass = (detail: string): AssertionResult => ({ ...base, status: 'pass', detail });

  switch (spec.assert) {
    case 'reply_contains': {
      const haystack = replyTextOf(spec.after, facts);
      const needle = String(spec.value);
      return haystack.includes(needle)
        ? pass(`回复出现「${needle}」`)
        : fail(`回复未出现「${needle}」`);
    }
    case 'reply_not_contains': {
      const haystack = replyTextOf(spec.after, facts);
      const needle = String(spec.value);
      return haystack.includes(needle)
        ? fail(`回复出现禁止文本「${needle}」`)
        : pass(`回复未出现「${needle}」`);
    }
    case 'task_state': {
      const taskIndex = spec.task ?? 1;
      const task = facts.tasks[taskIndex - 1];
      if (task === undefined) return fail(`任务 #${taskIndex} 不存在（当前 ${facts.tasks.length} 个）`);
      return task.status === spec.value
        ? pass(`任务 #${taskIndex} 状态=${task.status}`)
        : fail(`任务 #${taskIndex} 状态=${task.status}，期望 ${String(spec.value)}`);
    }
    case 'task_no': {
      if (facts.tasks.some((task) => task.taskId.trim() === '')) return fail('存在空任务标识');
      const ids = facts.tasks.map((task) => task.taskId);
      if (new Set(ids).size !== ids.length) return fail('任务标识重复（编号被复用）');
      if (spec.value !== undefined) {
        const expected = String(spec.value);
        if (!ids.some((id) => id === expected || id.includes(expected))) {
          return fail(`未找到任务标识「${expected}」（当前 ${ids.length} 个任务）`);
        }
      }
      return pass(`任务标识非空且互异（${ids.length} 个）`);
    }
    case 'execution_count': {
      const expected = spec.value as number;
      let actual = 0;
      if (spec.task !== undefined) {
        const task = facts.tasks[spec.task - 1];
        if (task === undefined) return fail(`任务 #${spec.task} 不存在（当前 ${facts.tasks.length} 个）`);
        actual = task.executions.length;
      } else {
        actual = facts.tasks.reduce((sum, task) => sum + task.executions.length, 0);
      }
      return actual === expected
        ? pass(`结构化执行数=${actual}`)
        : fail(`结构化执行数=${actual}，期望 ${expected}`);
    }
    case 'hash_unchanged': {
      const target = String(spec.value);
      const baseline = facts.hashBaselines[target];
      if (baseline === undefined) return fail(`没有「${target}」的载入基线（load 时未记录）`);
      const current = facts.hashNow?.(target);
      if (current === undefined) return fail(`无法读取「${target}」现值（未注入哈希读取）`);
      return current === baseline
        ? pass(`「${target}」哈希不变`)
        : fail(`「${target}」哈希变化：${baseline} → ${current}`);
    }
    case 'no_fabricated': {
      const targets: string[] = spec.after === 'all'
        ? facts.replies.slice(1)
        : [facts.replies[spec.after] ?? ''];
      const limit = spec.after === 'all' ? Number.POSITIVE_INFINITY : spec.after;
      const sources: string[] = [];
      for (let turn = 1; turn <= Math.min(limit, facts.messages.length - 1); turn += 1) {
        sources.push(facts.messages[turn] ?? '');
      }
      for (let turn = 1; turn <= Math.min(limit, facts.auditLinesByTurn.length - 1); turn += 1) {
        sources.push(...(facts.auditLinesByTurn[turn] ?? []));
      }
      for (const task of facts.tasks) {
        if (task.resultText !== undefined) sources.push(task.resultText);
      }
      const traceable = new Set<number>();
      for (const source of sources) for (const value of extractNumberTokens(source)) traceable.add(value);
      for (const text of targets) {
        for (const token of extractNumberTokens(text)) {
          if (!traceable.has(token)) return fail(`回复出现不可溯源数值 ${token}`);
        }
      }
      return pass('回复数值全部可溯源');
    }
    default:
      return fail(`未实现的断言 kind：${spec.assert}`);
  }
}
