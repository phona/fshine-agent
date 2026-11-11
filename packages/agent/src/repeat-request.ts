/**
 * 重复请求的机械判据（2026-10-19 真机实测暴露的第二形态）。
 *
 * 事故形状：用户把同一句话连发三次（16:06 / 16:10 / 23:30），中间那次真委派了、文件
 * 也真落盘了；第三次模型申报 conversation，拿 7 小时前的结论重新排版输出——零执行、
 * 零产物，用户拿到的是服务器路径而不是文件。转录里模型的 thinking 原话是
 * "The user has re-asked the same question. The Sub Agent previously returned…"：
 * 它**明确认出**是重复请求，还是选了对话枝。
 *
 * 为什么宿主必须有一把机械尺：`route_current_turn` 的描述里早就写了「之前的回答、
 * 工具结果、确认计划只是历史资料，不是当前授权；用户重复实时数据问题仍是新查询」，
 * 模型照样判错。缺的不是更重的措辞，是宿主把「这条消息本会话已经委派执行过」这个
 * **确定性事实**递到申报处。提示词与机械复核各管一段（AGENTS.md：不同层可以分别
 * 提供提示与确定性复核，但不能维护两份相互冲突的要求），本模块只做后者。
 *
 * 判据全部来自宿主持有的两份材料，**零领域知识**：
 *   ① 会话转录（runtime 的 `loaded`）：同文的早前用户消息，且那一轮申报并执行过委派；
 *   ② 当前消息原文。
 * 「那一轮委派过」按转录形状判——route_current_turn 的 toolCall 之后紧接的那条
 * toolResult 是单步委派的纯文本终结结果，或结构化的 `{"recorded":"delegate",…}` 回执。
 * `{"error":…}` 是申报被退回，不代表委派执行过；`{"recorded":"conversation"}` 则是对话枝。
 * 纯文本终结结果带有宿主写入 `toolResult.details.routeReceipt` 的标记：
 * `delegate` 表示委派已经开始，`precondition` 表示前置拦截。没有该标记的旧转录保留
 * 兼容判定；新转录不再靠用户可见文案猜测。
 * 不做语义判断：不猜"这句话像不像任务"，所以不会把闲聊误判成重复任务请求
 * （"在吗"发两遍而本会话另有委派时，早前那个"在吗"没有委派痕迹，判据不成立）。
 *
 * 命中之后怎么办（调用方的纪律，写在这里因为取舍属于判据的一部分）：**退回重填一次，
 * 之后放行**。它与 `reviewRouteDeclaration` 的退回同一族（都是"申报填错了，重填"，
 * 不消耗用户的澄清轮次），但它是**增强不是门**——拦住不放，用户连历史结论都看不到，
 * 比给一段可能过期的答复更糟；模型已经拿到这个确定性事实仍坚持对话枝时，宿主没有领域
 * 语义可以替它判断，只能放行并留痕。因此调用方自己记"退过没有"，同一个回合不重复退。
 */
import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { TurnInputContext } from '@fshine/contracts';
import { extractCurrentMessageBody, hostContextMetadataOf, normalizeMessageReference } from './message-reference';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './turn-contract';

/**
 * 一次委派的记账（请求键 → 次数）。
 *
 * 判据来源只有一处：**仍在转录里的具体轮次**（collectDelegatedRequestCounts）。
 * 曾经还有第二条来源——压缩 sidecar（宿主塞进压缩产物的"已压缩派发计数"）：它随宿主
 * 影子状态一起删除（相位 1 的 T3），压缩后的重复请求复核退回"只看仍在场的轮次"，
 * 不再有第二份账。
 */
export interface DelegatedRequestCount {
  requestKey: string;
  count: number;
}

/**
 * 宿主追加在用户消息尾部的附件路径后缀起始标记。
 *
 * 单一来源：`apps/server/handler.ts` 的 `withAttachmentPaths` 与这里的归一化共用一份。
 * 归一化必须先剥它——同一条指令带 1 个文件和带 3 个文件时后缀内容不同而用户意图
 * 完全相同（本次实测：16:06 带 1 个、16:10 带 3 个，指令一字不差），不剥就永远判不
 * 出同文。宿主侧注入的结构不该参与"用户说了什么"的判定。
 */
export const ATTACHMENT_PATHS_MARKER = '[本次消息附带的文件路径';

/** 消息正文：content 可能是字符串或块数组，块数组只取 text 块拼起来（与转录落库形状一致）。 */
function messageText(message: AgentMessage): string {
  const content: unknown = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** 归一化用户请求：剥掉宿主追加的附件路径后缀，折叠空白，去首尾空。 */
export function normalizeUserRequest(text: string): string {
  const cut = text.indexOf(ATTACHMENT_PATHS_MARKER);
  const head = cut === -1 ? text : text.slice(0, cut);
  return head.replace(/\s+/g, ' ').trim();
}

/** 取宿主持有的 route_current_turn 终结标记；未知 details 形状一律交给兼容判定。 */
function routeReceiptMarker(message: AgentMessage): 'delegate' | 'precondition' | 'background' | undefined {
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const marker = (details as { routeReceipt?: unknown }).routeReceipt;
  return marker === 'delegate' || marker === 'precondition' || marker === 'background' ? marker : undefined;
}

/** 结构化回执只认已派发的 `delegate` / `background`；后台受理不是执行成功证明。 */
function isStructuredDelegationReceipt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const recorded = (parsed as { recorded?: unknown }).recorded;
    return recorded === 'delegate' || recorded === 'background';
  } catch {
    // A malformed object-shaped result cannot be proved to be a delegate receipt.
    return false;
  }
}

/**
 * 这一轮是否真的走过 delegate：优先使用宿主持有的转录标记，旧转录才回退到文本形状。
 *
 * 正常单步委派以 ToolUserError 纯文本终结；新转录上的纯文本必须有 delegate 标记，避免
 * 把计划消歧、熔断、队列已满等前置拦截的用户话术误当成历史委派。没有 details 的旧转录保留
 * 纯文本兼容路径，结构化 JSON 仍只认 recorded=delegate。
 */
function isDelegationReceipt(message: AgentMessage): boolean {
  const marker = routeReceiptMarker(message);
  if (marker) return marker === 'delegate' || marker === 'background';
  const text = messageText(message);
  const hasDetails = Object.prototype.hasOwnProperty.call(message, 'details');
  if (hasDetails) return isStructuredDelegationReceipt(text);
  return text.trim().startsWith('{') ? isStructuredDelegationReceipt(text) : Boolean(text.trim());
}

/** Stable body + quote key; with no quote the request still matches legacy body-only behavior. */
export function buildRequestKey(currentMessage: string, inputContext?: TurnInputContext): string {
  const request = normalizeUserRequest(currentMessage);
  const reference = normalizeMessageReference(inputContext?.messageReference);
  const payload = JSON.stringify({
    version: 1,
    request,
    messageReference: reference ? {
      kind: reference.kind,
      text: normalizeReferenceText(reference.text ?? ''),
      truncated: reference.truncated === true,
      ...(reference.sourceMessageId ? { sourceMessageId: reference.sourceMessageId } : {}),
    } : null,
  });
  return `request-v1:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

function normalizeReferenceText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

interface HistoricalUserRequest {
  request: string;
  requestKey: string;
}

function historicalUserRequest(message: AgentMessage): HistoricalUserRequest {
  const hostContext = hostContextMetadataOf(message);
  const content = messageText(message);
  const messageReference = hostContext?.messageReference;
  const body = extractCurrentMessageBody(content, messageReference !== undefined);
  const request = normalizeUserRequest(body);
  const storedKey = hostContext?.requestKey;
  return {
    request,
    requestKey: typeof storedKey === 'string' && storedKey
      ? storedKey
      : buildRequestKey(body, { ...(messageReference ? { messageReference } : {}) }),
  };
}

/** assistant 消息里是否含一次 route_current_turn 调用。 */
function isRouteCall(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false;
  const content: unknown = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const item = block as { type?: unknown; name?: unknown };
    return item.type === 'toolCall' && item.name === ROUTE_CURRENT_TURN_TOOL_NAME;
  });
}

export interface RepeatedRequest {
  /** 归一化后的请求文本（与当前消息同文）。 */
  request: string;
  /** 本会话里此前以同一文本申报并执行过委派的次数。 */
  priorDelegations: number;
}

/**
 * 当前消息是不是"本会话已经委派执行过的同文请求"。是 → 返回事实；否 → null。
 *
 * 纯函数：只读传入的转录数组与消息文本，不碰存储、不抛异常。转录损坏/形状异常时
 * 各项判据自然不成立（返回 null），调用方按"没有重复"继续——这道尺是增强，不是门，
 * 判不出来也不该让回合失败。
 *
 * 轮次切分：每条 `user` 消息开一轮。一轮之内可能多次调用 route_current_turn
 * （填错被退回后重填），取**最后一次**的回执——`{"error":…}` 那种重试指令之后的
 * 那次申报才代表这一轮的最终动作。
 */
export function findRepeatedDelegatedRequest(
  transcript: readonly AgentMessage[],
  currentMessage: string,
  inputContext?: TurnInputContext,
): RepeatedRequest | null {
  const request = normalizeUserRequest(currentMessage);
  if (!request) return null;

  const priorCounts = new Map<string, number>();
  addRequestCounts(priorCounts, collectDelegatedRequestCounts(transcript));

  const currentRequestKey = buildRequestKey(currentMessage, inputContext);
  const priorDelegations = priorCounts.get(currentRequestKey) ?? 0;
  return priorDelegations > 0 ? { request, priorDelegations } : null;
}

/** Collect completed/accepted dispatches represented by concrete, still-present Pi turns only. */
export function collectDelegatedRequestCounts(transcript: readonly AgentMessage[]): DelegatedRequestCount[] {
  const delegatedRequestCounts = new Map<string, number>();
  let turnRequest = '';
  let turnRequestKey = '';
  let turnReceipt: AgentMessage | null = null;
  let awaitingRouteResult = false;

  const closeTurn = (): void => {
    // 申报过（有合法委派回执）= 这一轮真的委派执行了。没有申报的回合整轮被
    // 丢弃（route_declaration_missing），同样不算执行。
    if (turnRequest && turnReceipt !== null && isDelegationReceipt(turnReceipt)) {
      delegatedRequestCounts.set(turnRequestKey, (delegatedRequestCounts.get(turnRequestKey) ?? 0) + 1);
    }
    turnRequest = '';
    turnRequestKey = '';
    turnReceipt = null;
    awaitingRouteResult = false;
  };

  for (const message of transcript) {
    if (message.role === 'user') {
      closeTurn();
      const historical = historicalUserRequest(message);
      turnRequest = historical.request;
      turnRequestKey = historical.requestKey;
      continue;
    }
    if (isRouteCall(message)) {
      awaitingRouteResult = true;
      continue;
    }
    if (awaitingRouteResult && message.role === 'toolResult') {
      turnReceipt = message;
      awaitingRouteResult = false;
    }
  }
  closeTurn();
  return [...delegatedRequestCounts.entries()].map(([requestKey, count]) => ({ requestKey, count }));
}

function addRequestCounts(target: Map<string, number>, counts: readonly DelegatedRequestCount[]): void {
  for (const item of counts) {
    if (!item.requestKey || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
    target.set(item.requestKey, (target.get(item.requestKey) ?? 0) + item.count);
  }
}
