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
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './turn-contract';

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
function routeReceiptMarker(message: AgentMessage): 'delegate' | 'precondition' | undefined {
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const marker = (details as { routeReceipt?: unknown }).routeReceipt;
  return marker === 'delegate' || marker === 'precondition' ? marker : undefined;
}

/** 结构化回执只认 `recorded=delegate`。 */
function isStructuredDelegationReceipt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as { recorded?: unknown }).recorded === 'delegate';
  } catch {
    // A malformed object-shaped result cannot be proved to be a delegate receipt.
    return false;
  }
}

/**
 * 这一轮是否真的走过 delegate：优先使用宿主持有的转录标记，旧转录才回退到文本形状。
 *
 * 正常单步委派以 ToolUserError 纯文本终结；新转录上的纯文本必须有 delegate 标记，避免
 * 把计划消歧、冷却、熔断等前置拦截的用户话术误当成历史委派。没有 details 的旧转录保留
 * 纯文本兼容路径，结构化 JSON 仍只认 recorded=delegate。
 */
function isDelegationReceipt(message: AgentMessage): boolean {
  const marker = routeReceiptMarker(message);
  if (marker) return marker === 'delegate';
  const text = messageText(message);
  const hasDetails = Object.prototype.hasOwnProperty.call(message, 'details');
  if (hasDetails) return isStructuredDelegationReceipt(text);
  return text.trim().startsWith('{') ? isStructuredDelegationReceipt(text) : Boolean(text.trim());
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
): RepeatedRequest | null {
  const request = normalizeUserRequest(currentMessage);
  if (!request) return null;

  const delegatedRequests: string[] = [];
  let turnRequest = '';
  let turnReceipt: AgentMessage | null = null;
  let awaitingRouteResult = false;

  const closeTurn = (): void => {
    // 申报过（有合法委派回执）= 这一轮真的委派执行了。没有申报的回合整轮被
    // 丢弃（route_declaration_missing），同样不算执行。
    if (turnRequest && turnReceipt !== null && isDelegationReceipt(turnReceipt)) {
      delegatedRequests.push(turnRequest);
    }
    turnRequest = '';
    turnReceipt = null;
    awaitingRouteResult = false;
  };

  for (const message of transcript) {
    if (message.role === 'user') {
      closeTurn();
      turnRequest = normalizeUserRequest(messageText(message));
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

  const priorDelegations = delegatedRequests.filter((text) => text === request).length;
  return priorDelegations > 0 ? { request, priorDelegations } : null;
}
