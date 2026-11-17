/**
 * SimCase 薄机制 · 模拟用户（prompt 构造 + 模型接口 + 泄漏守卫）。
 *
 * 模拟用户**只看**：goal / persona / knowledge / behaviorRules / terminal 描述 /
 * 自己已发出的消息 / 系统**用户可见**的上一轮回复。
 * **看不到**：工具结果内部字段、日志、Oracle、真值、fixtureId、oracleId。
 *
 * 泄漏守卫（fail-closed，确定性）：
 *   · `findCaseLeaks` —— 用例作者把真值/禁知写进 goal/persona/knowledge/behaviorRules/terminal；
 *   · `findPromptLeaks` —— 构造出的 prompt 里出现 fixtureId / oracleId / 禁知（整段），
 *     或用例字段段落里出现禁知 / 真值模式。
 * 任一命中 → Harness 在该 trial 第一次发消息前拒绝（终态 null + error），不烧模型。
 */

import { SIM_ACTION_PROTOCOL, type SimActionKind, type SimCase } from './case';
import type { CallTokens } from '../r6/accounting';

/** 一次模型调用最小的 prompt 形状（判官调用也用它）。 */
export interface ModelPrompt {
  readonly system: string;
  readonly user: string;
}

/** 一次模拟用户模型调用的最小接口（真实模型/确定性假件同签名）。 */
export interface SimModel {
  complete(prompt: ModelPrompt): Promise<SimModelCompletion>;
}

export interface SimulatorPrompt extends ModelPrompt {
  readonly system: string;
  readonly user: string;
  /**
   * 由**用例字段**构造的段落（goal/persona/knowledge/behaviorRules/terminal）。
   * 真值只允许在这里做泄漏检查——系统回复/用户历史里出现真值是被允许的（模拟用户本来就能看到）。
   */
  readonly authoring: string;
}

export interface SimModelCompletion {
  readonly text: string;
  readonly tokens?: CallTokens;
  readonly tokensObserved?: boolean;
}

/** 构造 prompt 的视图：只含用户视角可见的东西。 */
export interface SimulatorView {
  readonly goal: string;
  readonly persona: string;
  readonly knowledge: readonly string[];
  readonly behaviorRules: readonly string[];
  readonly terminal: { readonly satisfied: string; readonly gaveUp: string };
  readonly allowedActions: readonly SimActionKind[];
  /** 已发出的用户消息（含 initialMessage），按时间序。 */
  readonly userMessages: readonly string[];
  /** 系统**用户可见**的上一轮回复。 */
  readonly lastSystemReply: string;
  /** 即将发出的第几条用户消息（1 起）。 */
  readonly userTurn: number;
}

function bullets(items: readonly string[]): string {
  return items.length === 0 ? '（无）' : items.map((item) => `- ${item}`).join('\n');
}

/**
 * markdown 噪声：强调标记（`**` / `__` / `*` / `_`）、行内代码反引号、全角/不换行空格。
 * 系统回复常写成 `共 **2 条**记录`、`第 **2 条**`——标记夹在数字与量词/序号之间，
 * 直接对原文做正则匹配会漏判。**所有**正则/包含匹配前都应先走这里（默认路径）。
 */
export function stripMarkdownNoise(text: string): string {
  return (text ?? '').replace(/[*_`\u3000\u00a0]/g, '');
}

/** 重复意图守卫的窗口：最近 N 条用户消息（预注册冻结为 3）。 */
export const SIM_REPEAT_GUARD_WINDOW = 3;

/** 意图相似度阈值（字符二元组 Dice）：≥ 该值视为「同一意图的重复表达」的机械代理。 */
export const SIM_REPEAT_INTENT_SIMILARITY = 0.6;

/** 意图归一化：剥 markdown 噪声、小写，只保留字母/数字/汉字（去标点与空白）。 */
export function normalizeIntentText(text: string): string {
  return stripMarkdownNoise(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function charBigrams(text: string): Set<string> {
  if (text.length <= 1) return new Set([text]);
  const grams = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

/** 两条用户消息是否为「同一意图」：归一化后相等，或字符二元组 Dice ≥ 阈值。 */
export function isRepeatedIntent(a: string, b: string): boolean {
  const normalizedA = normalizeIntentText(a);
  const normalizedB = normalizeIntentText(b);
  if (normalizedA === '' || normalizedB === '') return false;
  if (normalizedA === normalizedB) return true;
  const gramsA = charBigrams(normalizedA);
  const gramsB = charBigrams(normalizedB);
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared += 1;
  const dice = (2 * shared) / (gramsA.size + gramsB.size);
  return dice >= SIM_REPEAT_INTENT_SIMILARITY;
}

/**
 * 硬守卫（bounded）：最近 `SIM_REPEAT_GUARD_WINDOW` 条用户消息是否都重复了**此前已问过**的意图。
 *
 * 只用于终止「系统已清楚回答、用户仍重复同一意图」的循环（`run.ts` 记 `reason=repeat_guard`）；
 * **不参与 pass 判定**——Oracle 仍是唯一判据。窗口不足 3 条一律返回 false。
 */
export function hasRepeatedUserIntent(userMessages: readonly string[]): boolean {
  const window = SIM_REPEAT_GUARD_WINDOW;
  if (userMessages.length < window) return false;
  const offset = userMessages.length - window;
  for (let index = 0; index < window; index += 1) {
    const current = userMessages[offset + index] ?? '';
    const prior = userMessages.slice(0, offset + index);
    if (!prior.some((earlier) => isRepeatedIntent(current, earlier))) return false;
  }
  return true;
}

/**
 * 泄漏硬规则（进模拟用户 system prompt）：**不得复述系统给出的任何数值**来「确认」。
 *
 * 背景（sim5 SIM-05#2）：模拟用户回了「alpha 2 条合计 2000，收到」——它把系统给的答案
 * 复述了一遍。污染检测按设计把该 trial 作废（用户消息出现真值），机制正确但整条样本浪费。
 * 这条规则让模拟用户用「收到了 / 明白了」确认，不给它复述机会；检测本身不放松。
 */
export const SIM_NO_ECHO_NUMBERS_RULE =
  '你绝不能再复述或引用系统给出的任何数字、条数、金额、编号来「确认」或追问；需要确认时只用「收到了」「明白了」这类不含任何数值的措辞。';

/** 构造模拟用户 prompt。**不得**接收 fixtureId/oracleId/真值——参数类型即边界。 */
export function buildSimulatorPrompt(view: SimulatorView): SimulatorPrompt {
  const system = [
    '你是一名参与产品评测的模拟业务用户。你只知道下面给出的业务目标、人设和已知信息；',
    '你不知道正确答案，也不掌握系统内部接口、日志或工具返回值。',
    '你的任务：像真实用户一样与系统对话；目标达成后主动收尾，做不到就放弃。',
    '系统已经清楚回答过的问题不要再问；不要为了确认而重复同一句话；目标达成就立即 finish(satisfied)。',
    SIM_NO_ECHO_NUMBERS_RULE,
    '严格按协议输出：只输出一个 JSON 动作，不要输出解释或多余文本。',
  ].join('');
  const authoring = [
    '# 业务目标',
    view.goal,
    '',
    '# 人设',
    view.persona,
    '',
    '# 你已知的信息',
    bullets(view.knowledge),
    '',
    '# 行为规则',
    bullets(view.behaviorRules),
    '',
    '# 什么时候算结束',
    `- 满意（finish satisfied）：${view.terminal.satisfied}`,
    `- 放弃（finish gave_up）：${view.terminal.gaveUp}`,
  ].join('\n');
  const user = [
    authoring,
    '',
    '# 允许的动作',
    `只能使用：${view.allowedActions.join(' / ')}`,
    SIM_ACTION_PROTOCOL,
    '',
    '# 你已发出的消息',
    view.userMessages.length === 0
      ? '（还没有）'
      : view.userMessages.map((text, index) => `${index + 1}. ${text}`).join('\n'),
    '',
    '# 系统上一轮回复（用户可见）',
    view.lastSystemReply.trim() === '' ? '（空回复）' : view.lastSystemReply,
    '',
    '# 现在',
    `这是你准备发出的第 ${view.userTurn} 条用户消息。输出你的动作 JSON。`,
  ].join('\n');
  return { system, user, authoring };
}

/**
 * 修复重问 prompt：同一视图 + 上一轮解析错误 + 强化的「只输出 JSON 动作」指令。
 *
 * 只追加协议要求，不把原始输出回灌给模型（避免把它的废话再喂回去扩大上下文）；
 * `authoring` 原样保留，泄漏守卫仍适用。
 */
export function buildRepairPrompt(
  prompt: SimulatorPrompt,
  error: string,
  attempt: number,
  maxAttempts: number,
): SimulatorPrompt {
  const repair = [
    '',
    `# 协议修复（第 ${attempt}/${maxAttempts} 次重问）`,
    `你上一轮输出不符合动作协议：${error}`,
    '请只输出一个 JSON 动作，不要输出解释、前后缀、思考过程或 markdown 代码围栏。',
    SIM_ACTION_PROTOCOL,
  ].join('\n');
  return { system: prompt.system, user: `${prompt.user}\n${repair}`, authoring: prompt.authoring };
}

/**
 * 用例卫生检查：真值不得出现在**喂给模拟用户**的字段里。
 * `initialMessage` 不在此列——它作为用户消息由 `detectContamination` 在运行时作废。
 */
export function findCaseLeaks(
  caseDef: Pick<SimCase, 'goal' | 'persona' | 'knowledge' | 'behaviorRules' | 'terminal'>,
  truthPatterns: readonly string[],
  normalize: (text: string) => string,
): string[] {
  const fields = [
    caseDef.goal,
    caseDef.persona,
    ...caseDef.knowledge,
    ...caseDef.behaviorRules,
    caseDef.terminal.satisfied,
    caseDef.terminal.gaveUp,
  ];
  const haystack = fields.map(normalize).join('\n');
  const leaked = new Set<string>();
  for (const pattern of truthPatterns) {
    const normalized = normalize(pattern);
    if (normalized.length < 2) continue;
    if (haystack.includes(normalized)) leaked.add(pattern);
  }
  return [...leaked];
}

/**
 * prompt 泄漏守卫：
 *   · fixtureId / oracleId 不得出现在 prompt 任何位置（Harness 标识符）；
 *   · 真值模式与「本身就是真值的禁知」只查**用例字段构造的段落**——系统用户可见回复里
 *     出现答案属正常（模拟用户本来就看得见回复，见 contamination.test「系统回复里的真值
 *     不算泄漏」）；用户复述真值由运行时 `detectContamination` 作废该 trial；
 *   · 其余禁知（内部编号等）仍扫整段 prompt：它们不该出现在系统对用户的任何输出里。
 */
export function findPromptLeaks(
  prompt: SimulatorPrompt,
  caseDef: Pick<SimCase, 'fixtureId' | 'oracleId' | 'forbiddenKnowledge'>,
  truthPatterns: readonly string[],
  normalize: (text: string) => string,
): string[] {
  const whole = normalize(`${prompt.system}\n${prompt.user}`);
  const authoring = normalize(prompt.authoring);
  const leaked = new Set<string>();
  for (const secret of [caseDef.fixtureId, caseDef.oracleId]) {
    const normalized = normalize(secret);
    if (normalized.length < 2) continue;
    if (whole.includes(normalized)) leaked.add(secret);
  }
  // 禁知若与某条真值模式完全相同，按真值口径只查用例字段（上面的理由）；否则整段扫描。
  const truthSet = new Set(truthPatterns.map((pattern) => normalize(pattern)));
  for (const secret of caseDef.forbiddenKnowledge) {
    const normalized = normalize(secret);
    if (normalized.length < 2) continue;
    const haystack = truthSet.has(normalized) ? authoring : whole;
    if (haystack.includes(normalized)) leaked.add(secret);
  }
  for (const pattern of truthPatterns) {
    const normalized = normalize(pattern);
    if (normalized.length < 2) continue;
    if (authoring.includes(normalized)) leaked.add(pattern);
  }
  return [...leaked];
}
