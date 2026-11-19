/**
 * 后台任务完成的主动投递（B 切片，工单回执收敛；2026-11-19 唤醒切片改形）：任务经执行端
 * 确认 completed 后，**唤醒原会话的模型、由它把这件事说给用户**，宿主只投递它说的话——走
 * 宿主既有主动投递面（装配注入的 `fileDelivery.sendText`）。宿主不再有常规成功文案
 * （身份行「<业务名>」办完了： 已随唤醒切片删除）；喂给模型的是**事实**（见
 * taskCompletionFactText），不是话术。**唯一例外**是唤醒降级（模型说不出话）与非 live
 * 不唤醒时的宿主兜底一句（见 taskCompletionFallbackText）——它如实报完成事实，不是话术模板。
 *
 * 纪律（与文件投递 / 附件追问同一套，四必守同源）：
 *   · 非 live 部署**不发起投递**，记 `task_result_delivery_suppressed`，**不许记 sent**
 *     （silent 闸的回执会假报 sent 而用户什么都看不到，宿主不得采信）；
 *   · live 送达才记 `task_result_delivery_sent`（唯一允许 sent 的分支）；
 *   · live 投递失败记 `task_result_delivery_failed`，不记 sent（失败必须可查）；
 *   · 待投递文本投递前过 stripServerPaths——与用户可见回复同一道出口清理（2026-10-19
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

/** 完成事实里业务名的上限（字符；超长截断加省略号——事实给模型读，防止刷屏）。 */
const COMPLETION_NAME_MAX = 30;

/** 业务名截断（机械；只影响事实文本，不改底账值）。 */
function truncatedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= COMPLETION_NAME_MAX) return trimmed;
  return `${trimmed.slice(0, COMPLETION_NAME_MAX)}…`;
}

/**
 * 任务完成**事实**文本（宿主拼，给模型读；用户看到的话由模型写，宿主不再拼结果文案）：
 *   `[任务完成]「<业务名>」已由执行端确认完成。结果正文（逐字）：<resultText>。请把这件事告诉用户。`
 *
 * 硬边界（与 handle 隔离同一纪律）：不含 handle、不含 taskId/内部码、不含执行层原文以外的
 * 任何内部标识——resultText 是执行端确认的结果正文，逐字进事实（模型要能原样转述）。
 * name 缺省 = 主语用中性指代（不猜名）；不加任何投递/记账话术。
 */
export function taskCompletionFactText(input: { name?: string; resultText: string }): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  return `[任务完成]${subject}已由执行端确认完成。结果正文（逐字）：${input.resultText}。请把这件事告诉用户。`;
}

/**
 * 唤醒降级兜底文本：**全方案唯一允许的宿主用户文案**，只走唤醒降级路径
 * （unavailable / failed / 非 live 不唤醒），模型说得出话（woken）时永远不用它。
 *
 * 为什么必须如实报事实（2026-11-19 复核 F2，最严重一条）：走到这里时任务**已经由执行端
 * 确认完成**——一审兜底投 `failureMessageFor('host_fault')`（「是我这边没弄好。再试一次，
 * 还是记下来让人看？」）是**假话**，对写操作还会诱导用户重复执行一次写。所以本句：
 *   · 只陈述已完成的事实 + 结果正文（逐字，与旧宿主完成模板同形）；业务名缺省用中性指代；
 *   · **不得出现「再试一次」这类导向重试的话**；
 *   · 剥路径 / 空白不投 / sent·failed·suppressed 四必守记账全走 `deliverTaskResult`，
 *     不另开投递路径。
 */
export function taskCompletionFallbackText(input: { name?: string; resultText: string }): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  return `${subject}办好了：${input.resultText}`;
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
 * 单次完成投递（调用方 fire-and-forget；本函数内部吞掉一切错误并如实记账）：
 * text = 唤醒回合里模型写给用户的正文（或兜底话术），宿主不再拼任何结果文案。
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
  // 投递文本的空白判定先行：空文本不投（空帧用户什么都收不到），按 empty_after_strip 抑制记账。
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
  return deliverText(fact, bodyStripped, options);
}

/**
 * 失败话术（2026-11-19 收口；单一来源，聊天推送与完成投递共用）：
 * kind 由执行层码 / result_unknown 状态归类，取不到 = executor_failed；返回 failureMessageFor
 * 的用户话术文本。**不含执行层原文、不含内部词**（执行层原始码只进分类，不进文本）。
 *
 * 失败路径不得输出「需要你确认/补充」类话术（2026-11-19）：任务已落 failed/终局，底账里
 * **没有等待中的提案、也没有有效句柄或可接续任务**。若归类落到 `needs_confirmation` /
 * `needs_input`（说明宿主没把提案/问题交给用户——例如把 CONFIRMATION_REQUIRED 这类被挡码
 * 误当业务码），说「点个头 / 补一句」就是**假承诺**（用户回「确认」什么都不会发生，比不说更糟）。
 * 这属于我方故障：一律改判 `host_fault`，话术不解释内部原因，只说「我这边没弄好，再试/记下来」。
 */
export function failureTextFor(code: string | undefined, status?: 'failed' | 'refused' | 'result_unknown'): string {
  const kind = status === 'result_unknown'
    ? 'unknown_result'
    : classifyFailure({ code, status });
  const safeKind = kind === 'needs_confirmation' || kind === 'needs_input' ? 'host_fault' : kind;
  return failureMessageFor(safeKind).text;
}

/**
 * 单次失败投递（调用方 fire-and-forget；内部吞错并如实记账）。
 * 用户文本 = 话术模板（failureTextFor），**不含任何执行层原文/内部词**；
 * kind 由底账执行事实的 code / result_unknown 状态归类，取不到 = executor_failed。
 */
export async function deliverTaskFailure(fact: TaskFailureFact, options: TaskResultDeliveryOptions): Promise<boolean> {
  return deliverText(fact, failureTextFor(fact.code, fact.status), options);
}
