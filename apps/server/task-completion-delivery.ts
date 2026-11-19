/**
 * 后台任务完成的主动投递（B 切片，工单回执收敛）：任务经执行端确认 completed 后，
 * 把结果原文发回原会话——走宿主既有主动投递面（装配注入的 `fileDelivery.sendText`）。
 *
 * 纪律（与文件投递 / 附件追问同一套，四必守同源）：
 *   · 非 live 部署**不发起投递**，记 `task_result_delivery_suppressed`，**不许记 sent**
 *     （silent 闸的回执会假报 sent 而用户什么都看不到，宿主不得采信）；
 *   · live 送达才记 `task_result_delivery_sent`（唯一允许 sent 的分支）；
 *   · live 投递失败记 `task_result_delivery_failed`，不记 sent（失败必须可查）；
 *   · 结果原文投递前过 stripServerPaths——与用户可见回复同一道出口清理（2026-10-19
 *     事故形状：服务器路径不进用户文本）；剥完为空不投递（空文本帧会让渠道无终帧）；
 *   · 投递是 fire-and-forget：失败/抑制只记事件，不改变任务事实（与通知 outbox 同语义）。
 *
 * 路由：宿主构造事实 sessionId = `${channel}:${conversationId}`（server.ts handler），
 * 机械拆分还原投递路由；拆不出来（异常形状）按 suppressed 记账，不猜。
 * 抑制去重：同任务「已在本回合交给模型」（快活）的抑制由 server 装配面处置（见 server.ts），
 * 本模块只负责单次事实的投递与记账。
 */
import type { ChannelRoute, DeliveryReceipt } from '@fshine/contracts';
import { classifyFailure, failureMessageFor } from '../../packages/agent/src/user-facing-failure';
import { stripServerPaths } from '../../packages/agent/src/server-paths';

/** 宿主主动投递面（文字；与文件投递同一端口形状——FileDeliveryPort 的结构子集）。 */
export interface TaskResultDeliveryPort {
  readonly deliveryMode: 'live' | 'silent';
  sendText?(route: ChannelRoute, text: string): Promise<DeliveryReceipt>;
}

/** 一次后台任务完成的事实（来自执行端确认的回合结局；resultText 逐字未清理）。 */
export interface TaskCompletionFact {
  taskId: string;
  principalId: string;
  sessionId: string;
  resultText: string;
  /**
   * 业务名（任务底账 name / deriveTaskName(request) 的机械回落值）。给到时，投递文本加
   * 一行身份「<name>」办完了：<结果正文>——用户一眼看出是哪件事（2026-11-19：完成消息
   * 没有任务身份，「不知道是不是 longtask 的」）。缺省 = 无身份行（逐字节不变）。
   */
  name?: string;
}

/**
 * 一次后台任务失败的事实（任务终局 = failed，或结果未知 result_unknown——两者都不是
 * 「成功」，用户必须主动收到一句人话）。**不带 Worker 失败汇报原文**：原文只进
 * task_result_delivery_failed 等结构化事件与底账，不进用户文本（2026-11-19 收口）。
 */
export interface TaskFailureFact {
  taskId: string;
  principalId: string;
  sessionId: string;
  /**
   * 归类输入：底账执行事实的 error.code（执行层原始码，只用于 classifyFailure 归类）。
   * 取不到 = 落 executor_failed。**码不进用户文本**，只决定 kind 与话术。
   */
  code?: string;
  /** result_unknown 单独带状态（classifyFailure 的状态分支；其余 = failed/refused）。 */
  status?: 'failed' | 'refused' | 'result_unknown';
}

export interface TaskResultDeliveryOptions {
  /** 主动投递面；缺省 = 无投递面（按 suppressed 记账，绝不记 sent）。 */
  delivery?: TaskResultDeliveryPort;
  /** 结构化事件出口（scope/taskId/mode/parts；不含结果内容与内部路径）。 */
  log: (line: Record<string, unknown>) => void;
}

/** sessionId（宿主构造事实 `${channel}:${conversationId}`）→ 主动投递路由；拆不出返回 undefined。 */
export function routeFromSessionId(sessionId: string): ChannelRoute | undefined {
  const separator = sessionId.indexOf(':');
  if (separator <= 0 || separator === sessionId.length - 1) return undefined;
  return { channel: sessionId.slice(0, separator), conversationId: sessionId.slice(separator + 1) };
}

/** 完成消息身份行的业务名上限（字符；超长截断加省略号，防止用户刷屏读长名）。 */
const COMPLETION_NAME_MAX = 30;

/** 业务名截断（机械；只截显示，不改底账值）。 */
function truncatedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= COMPLETION_NAME_MAX) return trimmed;
  return `${trimmed.slice(0, COMPLETION_NAME_MAX)}…`;
}

/**
 * 单次文本投递的核心（完成/失败共用同一套四必守：live 才发、送达才记 sent、失败记
 * failed 不记 sent、剥空不投）。事件名统一 `task_result_delivery_*`（taskId 可区分场景）。
 * 返回是否真的发起了投递（测试断言用；生产调用方不依赖返回值）。
 */
async function deliverText(
  fact: { taskId: string; principalId: string; sessionId: string },
  text: string,
  options: TaskResultDeliveryOptions,
): Promise<boolean> {
  const base = {
    principalId: fact.principalId,
    sessionId: fact.sessionId,
    taskId: fact.taskId,
  };
  const delivery = options.delivery;
  if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
    options.log({
      event: 'task_result_delivery_suppressed',
      ...base,
      deliveryMode: delivery?.deliveryMode ?? 'unavailable',
    });
    return false;
  }
  const route = routeFromSessionId(fact.sessionId);
  if (route === undefined) {
    options.log({
      event: 'task_result_delivery_suppressed',
      ...base,
      deliveryMode: 'live',
      reason: 'route_unresolvable',
    });
    return false;
  }
  // 结果原文过出口清理（与用户可见回复同一道尺）；剥完为空不投递（空帧用户什么都收不到）。
  const stripped = stripServerPaths(text).text;
  if (stripped.trim() === '') {
    options.log({
      event: 'task_result_delivery_suppressed',
      ...base,
      deliveryMode: 'live',
      reason: 'empty_after_strip',
    });
    return false;
  }
  try {
    const receipt = await delivery.sendText(route, stripped);
    options.log({
      event: 'task_result_delivery_sent',
      ...base,
      deliveryMode: 'live',
      parts: receipt.parts.length,
    });
    return true;
  } catch (error) {
    options.log({
      event: 'task_result_delivery_failed',
      ...base,
      deliveryMode: 'live',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 单次完成投递（调用方 fire-and-forget；本函数内部吞掉一切错误并如实记账）。
 * 返回是否真的发起了投递（测试断言用；生产调用方不依赖返回值）。
 */
export async function deliverTaskResult(fact: TaskCompletionFact, options: TaskResultDeliveryOptions): Promise<boolean> {
  const base = {
    principalId: fact.principalId,
    sessionId: fact.sessionId,
    taskId: fact.taskId,
  };
  const delivery = options.delivery;
  if (delivery === undefined || delivery.deliveryMode !== 'live' || typeof delivery.sendText !== 'function') {
    options.log({
      event: 'task_result_delivery_suppressed',
      ...base,
      deliveryMode: delivery?.deliveryMode ?? 'unavailable',
    });
    return false;
  }
  // 结果正文的空白判定先行（2026-11-19）：resultText 为空/只有空白时仍按既有
  // empty_after_strip 抑制——身份行本身不算正文，空结果不许只发一句「办完了」。
  const bodyStripped = stripServerPaths(fact.resultText).text;
  if (bodyStripped.trim() === '') {
    options.log({
      event: 'task_result_delivery_suppressed',
      ...base,
      deliveryMode: 'live',
      reason: 'empty_after_strip',
    });
    return false;
  }
  // 任务身份行（2026-11-19）：「<业务名>」办完了：<结果正文>；name 缺省 = 无身份行（逐字节不变）。
  const header = fact.name !== undefined && fact.name.trim() !== ''
    ? `「${truncatedName(fact.name)}」办完了：`
    : '';
  return deliverText(fact, `${header}${bodyStripped}`, options);
}

/**
 * 失败话术（2026-11-19 收口；单一来源，聊天推送与完成投递共用）：
 * kind 由执行层码 / result_unknown 状态归类，取不到 = executor_failed；返回 failureMessageFor
 * 的用户话术文本。**不含执行层原文、不含内部词**（执行层原始码只进分类，不进文本）。
 */
export function failureTextFor(code: string | undefined, status?: 'failed' | 'refused' | 'result_unknown'): string {
  const kind = status === 'result_unknown'
    ? 'unknown_result'
    : classifyFailure({ code, status });
  return failureMessageFor(kind).text;
}

/**
 * 单次失败投递（调用方 fire-and-forget；内部吞错并如实记账）。
 * 用户文本 = 话术模板（failureTextFor），**不含任何执行层原文/内部词**；
 * kind 由底账执行事实的 code / result_unknown 状态归类，取不到 = executor_failed。
 */
export async function deliverTaskFailure(fact: TaskFailureFact, options: TaskResultDeliveryOptions): Promise<boolean> {
  return deliverText(fact, failureTextFor(fact.code, fact.status), options);
}
