/**
 * 澄清选择事件（任务 1 来源 B）：Conversation Log 的新事件族 `clarification_event`。
 *
 * 与 `plan_event` 同模式（append-only、结构化内容），载荷是结构化 JSON：
 *   · issued   `{status:'issued', code, query, candidates[], requestId}`——宿主向用户发出
 *     "选一个"的澄清时落账（requestId = 发出澄清那一回合，即确立轮次）；
 *   · resolved `{status:'resolved', selected, requestId}`——用户的裸编号/候选名答复被
 *     宿主机械绑定到某个候选时落账（requestId = 被 resolves 的那条澄清的 requestId，
 *     关联键；eventId 用绑定回合自己的 requestId）。
 *
 * 为什么需要它：宿主发出澄清后，用户的裸编号答复此前只能由**模型**解释——2026-09-27
 * 实测里模型把"1"猜成范围编码，查询带着猜错的范围执行。绑定改宿主持有：消息是纯编号
 * （落在候选个数内）或与候选逐字相同、且会话里有 issued 未 resolved 的澄清 → 绑定到
 * 对应候选，selected 进本轮实体来源（实体门因此放行"用户亲自选过的"实体）。
 *
 * 与 C31 多任务消歧（runtime.ts 的 matchPlanDisambiguationReply）**并列不合并**：那个
 * 解"用户要继续哪个任务"，这个解"用户选了哪个候选"；沿用同一条纪律——编号只有紧跟
 * 澄清问题才算数，中间插过任何回合即失效。
 */
import type { ConversationEventRecord, TrustedContext } from '@fshine/contracts';

/** 事件类型（ contracts 的 ConversationEventKind 联合成员之一）。 */
export const CLARIFICATION_EVENT_KIND = 'clarification_event';

export interface ClarificationIssuedPayload {
  status: 'issued';
  /** 平台选择类错误码（数据判据）。 */
  code: string;
  /** 用户的查询词（信封 data.query 原样回显）。 */
  query: string;
  /** 平台候选名（只取平台返回的——列表外的名字由此绝迹）。 */
  candidates: readonly string[];
  /** 发出澄清那一回合的 requestId（确立轮次，可审计）。 */
  requestId: string;
}

export interface ClarificationResolvedPayload {
  status: 'resolved';
  /** 用户选定的候选名（逐字来自 issued 的 candidates，不是模型转述）。 */
  selected: string;
  /** 被 resolves 的那条澄清的 requestId（关联键）。 */
  requestId: string;
}

export type ClarificationEventPayload = ClarificationIssuedPayload | ClarificationResolvedPayload;

/** 宿主发出澄清时的一条 issued 事件（id 按回合唯一：同回合重复追加同内容为幂等空操作）。 */
export function clarificationIssuedRecord(
  ctx: TrustedContext,
  clarification: { code: string; query: string; candidates: readonly string[] },
): ConversationEventRecord {
  const payload: ClarificationIssuedPayload = {
    status: 'issued',
    code: clarification.code,
    query: clarification.query,
    candidates: [...clarification.candidates],
    requestId: ctx.requestId,
  };
  return {
    eventId: `${ctx.requestId}:clarification_issued`,
    principalId: ctx.principalId,
    sessionId: ctx.sessionId,
    kind: CLARIFICATION_EVENT_KIND,
    content: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
    requestId: ctx.requestId,
  };
}

/** 裸编号/名称答复绑定成功时的一条 resolved 事件。 */
export function clarificationResolvedRecord(
  ctx: TrustedContext,
  binding: { selected: string; requestId: string },
): ConversationEventRecord {
  const payload: ClarificationResolvedPayload = {
    status: 'resolved',
    selected: binding.selected,
    requestId: binding.requestId,
  };
  return {
    eventId: `${ctx.requestId}:clarification_resolved`,
    principalId: ctx.principalId,
    sessionId: ctx.sessionId,
    kind: CLARIFICATION_EVENT_KIND,
    content: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
    requestId: ctx.requestId,
  };
}

/** 解析事件载荷：非本族事件/坏 JSON/字段不齐 → null（调用方按"没有"处理，不猜）。 */
export function parseClarificationEvent(content: string | undefined): ClarificationEventPayload | null {
  if (!content?.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const item = parsed as Record<string, unknown>;
  if (item['status'] === 'issued') {
    if (typeof item['requestId'] !== 'string' || !item['requestId']) return null;
    const candidates = Array.isArray(item['candidates'])
      ? item['candidates'].filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];
    if (candidates.length === 0) return null;
    return {
      status: 'issued',
      code: typeof item['code'] === 'string' ? item['code'] : '',
      query: typeof item['query'] === 'string' ? item['query'] : '',
      candidates,
      requestId: item['requestId'],
    };
  }
  if (item['status'] === 'resolved') {
    if (typeof item['selected'] !== 'string' || !item['selected']) return null;
    if (typeof item['requestId'] !== 'string' || !item['requestId']) return null;
    return { status: 'resolved', selected: item['selected'], requestId: item['requestId'] };
  }
  return null;
}

export interface ClarificationBinding {
  /** 绑定到的候选名（逐字来自 issued 的 candidates）。 */
  selected: string;
  /** 被 resolves 的那条澄清的 requestId（写 resolved 事件用）。 */
  requestId: string;
}

/**
 * 裸编号/名称答复的宿主机械绑定（纯函数：事件列表 + 本条消息 → 绑定或 null）。
 *
 * 绑定条件（全部满足才绑）：
 *   ① 本会话最后一条澄清事件是 issued 且尚未 resolved（已 resolved → 不再重复绑）；
 *   ② 邻近性：最后一条 assistant 消息就是那条澄清问题（requestId 相同）——中间插过
 *      任何回合即失效（与多任务消歧同一纪律：编号只有紧跟问题才算数）；
 *   ③ 本条消息是纯编号（1–2 位、落在候选个数内）或与某个候选逐字相同。
 * 任一条不满足 → null：消息按普通回合进模型，澄清保持 issued（不误绑）。
 */
export function matchClarificationBinding(
  events: readonly ConversationEventRecord[],
  userMessage: string,
): ClarificationBinding | null {
  const lastClarification = [...events].reverse().find((event) => event.kind === CLARIFICATION_EVENT_KIND);
  const issued = lastClarification ? parseClarificationEvent(lastClarification.content) : null;
  if (!issued || issued.status !== 'issued') return null;
  const lastAssistant = [...events].reverse().find((event) => event.kind === 'assistant_message');
  if (!lastAssistant || lastAssistant.requestId !== issued.requestId) return null;
  const trimmed = userMessage.trim();
  if (/^[1-9]\d?$/.test(trimmed)) {
    const selected = issued.candidates[Number(trimmed) - 1];
    return selected ? { selected, requestId: issued.requestId } : null;
  }
  const exact = issued.candidates.find((candidate) => candidate === trimmed);
  return exact ? { selected: exact, requestId: issued.requestId } : null;
}
