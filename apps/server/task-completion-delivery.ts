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
  const stripped = stripServerPaths(fact.resultText).text;
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
