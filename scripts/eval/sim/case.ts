/**
 * SimCase 薄机制 · 用例 schema 与模拟用户动作协议（确定性、零模型）。
 *
 * 定位：把「一个业务目标 + 一个模拟用户」写成可复现的样本定义，供 `./run` 的样本级
 * 并发池执行。本模块只做**形状校验 + 动作解析**，不跑模型、不读 env、不触网。
 *
 * 关键纪律（对齐 AGENTS.md「不得建模拟用户平台」）：
 *   · `fixtureId` / `oracleId` **只给 Harness**；它们不得进入模拟用户 prompt（见 `./simulator`
 *     的泄漏守卫）。
 *   · 模拟用户**知道业务目标但不知道正确答案**：`knowledge` = 用户本来就掌握的业务信息，
 *     真值只登记在 oracle（`./oracle`），不得写进 `knowledge`（用例卫生由 `findCaseLeaks` 检查）。
 *   · 终态分开记：`satisfied` / `gave_up` / `budget_exhausted` / `contaminated` /
 *     `protocol_error`；只有 `satisfied` **且** Oracle 判真值通过才算该 trial 通过（`./run` 实施）。
 *   · 动作协议 = 每轮只输出 `say(text)` / `wait(reason)` / `finish(kind, reason)` 之一。
 *     解析失败先做最多 `SIM_PROTOCOL_REPAIRS` 次修复重问（计入 `kind: simulator`），
 *     仍失败 → 终态 `protocol_error`（`pass=false`，不计入 gave_up / satisfied）。
 */

/** 模拟用户每轮可选动作。 */
export type SimActionKind = 'say' | 'wait' | 'finish';

/** 模拟用户决定收尾的两种方式（与 trial 终态区分：finish 的 kind 不是终态本身）。 */
export type SimFinishKind = 'satisfied' | 'gave_up';

/**
 * trial 终态（分开记；`null` 只用于 Harness/协议缺陷，不冒充任何一种终态）。
 *
 * `protocol_error` = 模拟用户模型在「首答 + 最多 2 次修复重问」后仍交不出合法动作；
 * 它是**协议终态**，不是 gave_up、也不是 satisfied，永不算通过（`pass=false`）。
 * 报告把「有效样本数」定义为 `总数 − protocol_error`（`./run-real` 显式标注）。
 */
export type SimTerminal = 'satisfied' | 'gave_up' | 'budget_exhausted' | 'contaminated' | 'protocol_error';

/** 协议修复重问次数上限（预注册冻结；每次重问单独计入 `kind: simulator`）。 */
export const SIM_PROTOCOL_REPAIRS = 2;

/** 预算耗尽的具体来源（`budget_exhausted` 的归因，不并进终态计数）。 */
export type SimBudgetReason = 'user_turns' | 'wait_turns' | 'wall_ms';

/** 注入锚点：只绑确定性位置（系统回合 / 执行调用 / 事件序号），不挂墙钟。 */
export type SimInjectionAnchor = 'systemTurn' | 'toolCall' | 'event';

/** 故障注入声明：在第 `at` 个 `anchor` 位置触发 `kind` 故障。`at` 从 1 起。 */
export interface SimInjection {
  readonly anchor: SimInjectionAnchor;
  readonly at: number;
  readonly kind: string;
}

/** 单 trial 预算上限（`trials` = 该用例重复次数）。 */
export interface SimLimits {
  /** 允许发出的用户消息条数（含 initialMessage）。 */
  readonly maxUserTurns: number;
  /** 允许的 `wait` 次数上限（超过即 `budget_exhausted`；不允许无限等待）。 */
  readonly maxWaitTurns: number;
  /** 单 trial 墙钟上限（只用于预算，不作为注入锚点）。 */
  readonly maxWallMs: number;
  /** 该用例的重复次数（样本级并发池展开为 case × trials）。 */
  readonly trials: number;
}

/** 样本级并发池并发度缺省值（预注册冻结：5）。 */
export const SIM_DEFAULT_CONCURRENCY = 5;

/** 一条 SimCase。命名与任务书一致（可微调命名，不改语义）。 */
export interface SimCase {
  readonly id: string;
  /** 业务目标（模拟用户知道这个，但不知道正确答案）。 */
  readonly goal: string;
  /** 人设（说话风格/身份/耐心）。 */
  readonly persona: string;
  /** 用户本来就掌握的信息（禁止写答案/真值）。 */
  readonly knowledge: readonly string[];
  /** 首条用户消息（也算一条用户消息，过污染检测）。 */
  readonly initialMessage: string;
  /** 行为规则（例如「一次只问一件事」「不接受含糊答复」）。 */
  readonly behaviorRules: readonly string[];
  /** 模拟用户绝不能说出的知识（敏感项/内部项）。 */
  readonly forbiddenKnowledge: readonly string[];
  /** 允许的动作（至少一项）。 */
  readonly allowedActions: readonly SimActionKind[];
  /** 完成标准描述（给模拟用户判断何时 finish；不是真值）。 */
  readonly terminal: { readonly satisfied: string; readonly gaveUp: string };
  readonly injection?: SimInjection;
  /** 夹具 id：**只给 Harness**，不进模拟用户 prompt。 */
  readonly fixtureId: string;
  /** Oracle id：**只给 Harness**，不进模拟用户 prompt。 */
  readonly oracleId: string;
  readonly limits: SimLimits;
}

/** 模拟用户的三个动作（解析后的强类型）。 */
export type SimAction =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'finish'; readonly finishKind: SimFinishKind; readonly reason: string };

export type ParseSimActionResult =
  | { readonly ok: true; readonly action: SimAction }
  | { readonly ok: false; readonly error: string };

/** 动作协议文本（进模拟用户 prompt 的「允许的动作」段；测试同时引用）。 */
export const SIM_ACTION_PROTOCOL = [
  '每轮只能输出一个 JSON 对象，不要输出解释或多余文本：',
  '{"action":"say","text":"<你要对系统说的话>"}',
  '{"action":"wait","reason":"<为什么先等一等>"}',
  '{"action":"finish","finishKind":"satisfied"|"gave_up","reason":"<你的判断依据>"}',
].join('\n');

const VALID_ACTIONS: readonly SimActionKind[] = ['say', 'wait', 'finish'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 校验用例形状（不检查 oracle/fixture 是否存在——那由 `./oracle` 与 Harness 解析）。 */
export function validateSimCase(caseDef: SimCase): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isNonEmptyString(caseDef.id)) errors.push('id 必须是非空字符串');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseDef.id)) errors.push(`id 含非法字符：${caseDef.id}`);
  for (const key of ['goal', 'persona', 'initialMessage', 'fixtureId', 'oracleId'] as const) {
    if (!isNonEmptyString(caseDef[key])) errors.push(`${key} 必须是非空字符串`);
  }
  if (!isNonEmptyString(caseDef.terminal?.satisfied)) errors.push('terminal.satisfied 必须是非空字符串');
  if (!isNonEmptyString(caseDef.terminal?.gaveUp)) errors.push('terminal.gaveUp 必须是非空字符串');
  if (caseDef.allowedActions.length === 0) errors.push('allowedActions 不能为空');
  const seen = new Set<string>();
  for (const action of caseDef.allowedActions) {
    if (!VALID_ACTIONS.includes(action)) errors.push(`allowedActions 含未知动作：${String(action)}`);
    if (seen.has(action)) errors.push(`allowedActions 重复：${action}`);
    seen.add(action);
  }
  for (const [index, item] of caseDef.forbiddenKnowledge.entries()) {
    if (!isNonEmptyString(item)) errors.push(`forbiddenKnowledge[${index}] 必须是非空字符串`);
  }
  for (const [index, item] of caseDef.knowledge.entries()) {
    if (!isNonEmptyString(item)) errors.push(`knowledge[${index}] 必须是非空字符串`);
  }
  const limits = caseDef.limits;
  if (limits === undefined) {
    errors.push('limits 缺失');
  } else {
    if (!Number.isInteger(limits.maxUserTurns) || limits.maxUserTurns < 1) errors.push('limits.maxUserTurns 必须是 ≥1 的整数');
    if (!Number.isInteger(limits.maxWaitTurns) || limits.maxWaitTurns < 0) errors.push('limits.maxWaitTurns 必须是 ≥0 的整数');
    if (!Number.isInteger(limits.maxWallMs) || limits.maxWallMs < 1) errors.push('limits.maxWallMs 必须是 ≥1 的整数');
    if (!Number.isInteger(limits.trials) || limits.trials < 1) errors.push('limits.trials 必须是 ≥1 的整数');
    if (limits.maxUserTurns === 1 && caseDef.allowedActions.includes('finish') === false) {
      // 只有首条消息且不允许 finish：永远无法收尾——直接拒绝，不留给运行时烧预算。
      errors.push('maxUserTurns=1 时 allowedActions 必须包含 finish');
    }
  }
  if (caseDef.injection !== undefined) {
    const injection = caseDef.injection;
    if (!['systemTurn', 'toolCall', 'event'].includes(injection.anchor)) errors.push(`injection.anchor 未知：${String(injection.anchor)}`);
    if (!Number.isInteger(injection.at) || injection.at < 1) errors.push('injection.at 必须是 ≥1 的整数');
    if (!isNonEmptyString(injection.kind)) errors.push('injection.kind 必须是非空字符串');
  }
  return { ok: errors.length === 0, errors };
}

/** 从模型输出里抽取第一个 JSON 对象（容错 markdown 代码围栏与前后废话）。 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * 解析模拟用户一轮输出：只接受 `say` / `wait` / `finish`，且必须在 `allowedActions` 内。
 * 任何解析/字段/许可问题都返回 `{ok:false}`——由 Harness 先做修复重问，仍失败则记
 * 终态 `protocol_error`，不静默当作 `gave_up` 或 `budget_exhausted`。
 */
export function parseSimAction(raw: string, allowed: readonly SimActionKind[]): ParseSimActionResult {
  const json = extractJsonObject(raw ?? '');
  if (json === null) return { ok: false, error: '输出里没有 JSON 对象' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (value === null || typeof value !== 'object') return { ok: false, error: '动作必须是 JSON 对象' };
  const record = value as Record<string, unknown>;
  const action = record['action'];
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as SimActionKind)) {
    return { ok: false, error: `action 必须是 say|wait|finish（收到 ${String(action)}）` };
  }
  const kind = action as SimActionKind;
  if (!allowed.includes(kind)) return { ok: false, error: `动作 ${kind} 不在 allowedActions 内` };
  if (kind === 'say') {
    if (!isNonEmptyString(record['text'])) return { ok: false, error: 'say 需要非空 text' };
    return { ok: true, action: { kind: 'say', text: record['text'] } };
  }
  if (kind === 'wait') {
    if (!isNonEmptyString(record['reason'])) return { ok: false, error: 'wait 需要非空 reason' };
    return { ok: true, action: { kind: 'wait', reason: record['reason'] } };
  }
  const finishKind = record['finishKind'];
  if (finishKind !== 'satisfied' && finishKind !== 'gave_up') {
    return { ok: false, error: 'finish 需要 finishKind=satisfied|gave_up' };
  }
  if (!isNonEmptyString(record['reason'])) return { ok: false, error: 'finish 需要非空 reason' };
  return { ok: true, action: { kind: 'finish', finishKind, reason: record['reason'] } };
}

/** 并发池展开项：case × trials（每 trial 独立目录，见 `./run`）。 */
export interface SimItem {
  readonly id: string;
  readonly caseId: string;
  readonly trial: number;
}

export function expandSimTrials(cases: readonly SimCase[]): SimItem[] {
  const items: SimItem[] = [];
  const seen = new Set<string>();
  for (const caseDef of cases) {
    for (let trial = 1; trial <= caseDef.limits.trials; trial += 1) {
      const id = `${caseDef.id}#${trial}`;
      if (seen.has(id)) throw new Error(`重复的 trial id：${id}`);
      seen.add(id);
      items.push({ id, caseId: caseDef.id, trial });
    }
  }
  return items;
}
