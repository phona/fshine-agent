/**
 * 任务**状态变化**的主动投递（B 切片，工单回执收敛；2026-11-19 唤醒切片改形并扩到四条出口）：
 * 任务由执行端确认的终局/状态变化（完成 / 失败 / 用户说停 / 久无动静 / 重启后状态说不清）→
 * **唤醒原会话的模型、由它把这件事说给用户**，宿主只投递它说的话——走宿主既有主动投递面
 * （装配注入的 `fileDelivery.sendText`）。宿主不再有常规用户文案（身份行「<业务名>」办完了：
 * 与失败/取消模板都已随唤醒切片退出常规路径，只留「模型回合挂掉时」的兜底句）；喂给模型的
 * 是**事实**（见 taskCompletionFactText / taskFailureFactText / taskCancelledFactText /
 * taskRestartFactText），不是话术。**唯一例外**是唤醒降级（模型说不出话）与非 live 不唤醒时
 * 的宿主兜底一句（见 taskCompletionFallbackText / failureTextFor）——它如实报事实，不是话术
 * 模板。
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
import { resourceLimitedText } from '../../packages/agent/src/notification-render';
import {
  classifyFailure,
  failureMessageFor,
  USER_FACING_FAILURE_KIND_LABEL,
  type UserFacingFailureKind,
} from '../../packages/agent/src/user-facing-failure';
import { stripServerPaths } from '../../packages/agent/src/server-paths';
import { renderOutcomeFact, type TaskOutcome } from '../../packages/agent/src/task-outcome';

/** 宿主主动投递面（文字；与文件投递同一端口形状——FileDeliveryPort 的结构子集）。 */
export interface TaskResultDeliveryPort {
  readonly deliveryMode: 'live' | 'silent';
  sendText?(route: ChannelRoute, text: string): Promise<DeliveryReceipt>;
}

/**
 * 投递归属的事实种类（2026-11-21 对话形态断言层 ② 的前提）：投递记账行
 * （task_result_delivery_sent/failed/suppressed）带上「这是哪个任务的哪类事实」，
 * eval 侧据此判「同一事实投递两次」。缺省 = 调用方不知道（字段缺省，不猜）。
 */
export type TaskResultFactKind = 'completed' | 'failed' | 'cancelled' | 'waiting_user' | 'warning';

/** 一次后台任务完成的事实（来自执行端确认的回合结局；resultText 逐字未清理）。 */
export interface TaskCompletionFact {
  taskId: string;
  principalId: string;
  sessionId: string;
  resultText: string;
  /** 投递归属（进 task_result_delivery_* 记账行；缺省 = 不带，不猜）。 */
  factKind?: TaskResultFactKind;
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
  /**
   * 底账机械原因（§1 枚举；只用于归类，不进文本）。`resource_limited` = 池满/队列满的
   * 确定性拒绝——那种失败不是「执行端没办成」，话术必须走「系统太忙，这个没接」
   * （2026-11-19 只读审计 #18）。
   */
  reason?: string;
  /** 业务名（只给资源受限那句带上「是哪件事」；其余话术不带名字）。 */
  name?: string;
  /** 投递归属（进 task_result_delivery_* 记账行；缺省 = 不带，不猜）。 */
  factKind?: TaskResultFactKind;
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
 *   `[任务完成]「<业务名>」办完了。结果正文（逐字）：<resultText>。请把这件事告诉用户。`
 *
 * 硬边界（与 handle 隔离同一纪律）：不含 handle、不含 taskId/内部码、不含任何内部称谓与原文
 * 标识——resultText 是确认过的结果正文，逐字进事实（模型要能原样转述）。
 * name 缺省 = 主语用中性指代（不猜名）；不加任何投递/记账话术。
 */
export function taskCompletionFactText(input: { name?: string; resultText: string }): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  return `[任务完成]${subject}办完了。结果正文（逐字）：${input.resultText}。请把这件事告诉用户。`;
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
 * 投递归属（factKind）随已知带进三类记账行（sent/failed/suppressed 同字段；2026-11-21
 * 对话形态断言层 ② 的前提——只加字段，不改文案与投递语义）。
 * 返回是否真的发起了投递（测试断言用；生产调用方不依赖返回值）。
 */
async function deliverText(
  fact: { taskId: string; principalId: string; sessionId: string; factKind?: TaskResultFactKind },
  text: string,
  options: TaskResultDeliveryOptions,
): Promise<boolean> {
  const base = {
    principalId: fact.principalId,
    sessionId: fact.sessionId,
    taskId: fact.taskId,
    ...(fact.factKind === undefined ? {} : { factKind: fact.factKind }),
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
  return failureMessageFor(failureKindFor(code, status)).text;
}

/**
 * 失败**归类**（安全口径的唯一实现；话术与喂模型的事实共用同一出口）：
 * result_unknown 状态优先；否则按执行层码归类，取不到 = executor_failed；
 * needs_confirmation / needs_input 一律改判 host_fault（理由见 {@link failureTextFor}）。
 *
 * 资源受限（底账 reason=resource_limited：池满/队列满的确定性拒绝，没进入执行）不属于
 * 上面任何一类——它有自己的既有句子（见 {@link failureFallbackTextFor}），因此这里只负责
 * 码/状态那一半；调用方按 reason 优先判资源受限。
 */
export function failureKindFor(
  code: string | undefined,
  status?: 'failed' | 'refused' | 'result_unknown',
): UserFacingFailureKind {
  const kind = status === 'result_unknown'
    ? 'unknown_result'
    : classifyFailure({ code, status });
  return kind === 'needs_confirmation' || kind === 'needs_input' ? 'host_fault' : kind;
}

/**
 * 失败降级话术（**模型回合挂掉时的兜底**；唯一入口，完成/失败投递与回合内沉默兜底共用）：
 *   · 底账 reason=resource_limited（池满/队列满的确定性拒绝）→ 复用通知渲染器的既有那句
 *     「系统太忙，这个没接：<业务名>。」（2026-11-19 只读审计 #18：此前这类失败落到
 *     「没办成。再试一次，还是先放着？」——把「系统太忙」说成了「执行端没办成」，不实话）；
 *   · 其余按种类走 `failureMessageFor`（needs_* 已在 failureKindFor 里归 host_fault）。
 */
export function failureFallbackTextFor(input: {
  code?: string;
  status?: 'failed' | 'refused' | 'result_unknown';
  reason?: string;
  name?: string;
}): string {
  if (input.reason === 'resource_limited') {
    return resourceLimitedText(input.name);
  }
  return failureTextFor(input.code, input.status);
}

/** 失败事实里机械原因的上限（字符；超长截断——事实给模型读，防止把执行层原文整段灌进去）。 */
const FAILURE_REASON_MAX = 200;

/**
 * 任务失败**事实**文本（宿主拼，给模型读；用户看到的话由模型写）：
 *   `[任务失败]「<业务名>」这次没办成，问题分类：<业务种类>。机械原因：<原因>。
 *    请把这件事如实告诉用户，并给他一个能做的下一步。`
 *
 * 硬边界：不含 handle、不含 taskId、不含执行层原始码；种类用 `USER_FACING_FAILURE_KIND_LABEL`
 * 的业务语言名（即使被原样复述也不含内部形态）；原因只作判断依据（截断 + 去换行），模型
 * 不该原样丢给用户。name 缺省 = 主语用中性指代（不猜名）。
 */
export function taskFailureFactText(input: {
  name?: string;
  kind: UserFacingFailureKind;
  reason?: string;
  /** 结构化答复五态（B2 机械事实，不是话术）；缺省 = 不追加（既有路径逐字节不变）。 */
  outcome?: TaskOutcome;
  /** blocked 的缺失条件（非空）；只有 outcome=blocked 时写入事实。 */
  missing?: string;
}): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  const reason = input.reason === undefined
    ? ''
    : input.reason.replace(/\s+/g, ' ').trim().slice(0, FAILURE_REASON_MAX);
  const base = `[任务失败]${subject}这次没办成，问题分类：${USER_FACING_FAILURE_KIND_LABEL[input.kind]}。`
    + `${reason === '' ? '' : `机械原因（供你判断，别原样丢给用户）：${reason}。`}`;
  // B2：outcome 值作为结构化机械事实进唤醒事实，Main 据此按值选措辞（不是话术替换）。
  const outcomeFact = input.outcome === undefined ? '' : ` ${renderOutcomeFact(input.outcome, { missing: input.missing })}`;
  return `${base}${outcomeFact}请把这件事如实告诉用户，并给他一个能做的下一步。`;
}

/**
 * 任务被用户停掉**事实**文本（宿主拼，给模型读）：`[已停止]「<业务名>」已经按用户的要求停下了。
 * 请把这件事如实告诉用户。`
 */
export function taskCancelledFactText(input: { name?: string }): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  return `[已停止]${subject}已经按用户的要求停下了。请把这件事如实告诉用户。`;
}

/**
 * 重启对账**事实**文本（宿主拼，给模型读）：进程重启后，用户以为还在办的任务实际状态已变或
 * 说不清（`running` 且租约过期的行在启动 pump 里如实落 result_unknown，不重放；
 * `cancelling` 断电遗留的「取消孤儿」也一并回收）——
 *   `[重启对账]「<业务名>」这件事我这边重启过，现在状态说不清（做没做完无法确认）。
 *    请如实告诉用户，别让他一直等下去，并给出下一步能做什么。`
 * `pendingCancel` = 用户说过停、重启前没停完的那一类：主语如实点明「你要我停」，
 * 免得用户以为停已经生效。
 *
 * 这是新增出口（此前没有任何东西告诉用户），宿主没有对应文案——唤醒不可用时只记事件
 * （不猜、不替它说）。
 */
export function taskRestartFactText(input: { name?: string; pendingCancel?: boolean }): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  const subjectClause = input.pendingCancel === true
    ? `${subject}这件事你要我停，我重启前没停完`
    : `${subject}这件事我这边重启过`;
  return `[重启对账]${subjectClause}，现在状态说不清（做没做完无法确认）。`
    + '请如实告诉用户，别让他一直等下去，并给出下一步能做什么。';
}

/**
 * 等待用户**事实**文本（2026-11-21 live P0；宿主拼，给模型读；用户看到的话由模型写）：
 * 任务由非等待态进入 waiting_user（needs_input / needs_confirmation 同一状态机）——
 *   `[任务等待]「<业务名>」办到一半，需要用户表态才能继续。还缺：<missing 顿号连接>。
 *    将写入（逐字）：<confirmation.summary 执行端原话>（<expiresAt> 前有效）。
 *    请把待确认/待补内容原样告诉用户并等表态。`
 *
 * 硬边界：**不含 handle**（句柄是宿主持有的凭据，永不出宿主）、不含 taskId/内部码；
 * summary 是执行端提案原话，逐字进事实（模型要能原样转述）；待补（无提案）没有
 * 「将写入」句。expiresAt 机械校验（解析不出就不写有效期，不猜）。name 缺省 = 主语用
 * 中性指代。这条事实的出口见 server 的 waitingUserNotice 接线（task_waiting_user_wake）。
 */
export function taskWaitingUserFactText(input: {
  name?: string;
  missing: readonly string[];
  summary?: string;
  expiresAt?: string;
}): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${truncatedName(input.name)}」`
    : '你交代的那件事';
  const missing = input.missing.filter((entry) => entry.trim() !== '').join('、');
  const proposal = input.summary === undefined || input.summary.trim() === ''
    ? ''
    : `将写入（逐字）：${input.summary}${expiresAtClause(input.expiresAt)}。`;
  return `[任务等待]${subject}办到一半，需要用户表态才能继续。`
    + (missing === '' ? '' : `还缺：${missing}。`)
    + proposal
    + '请把待确认/待补内容原样告诉用户并等表态。';
}

/** 有效期从句（机械；解析不出 = 不写，不猜）。 */
function expiresAtClause(expiresAt: string | undefined): string {
  if (expiresAt === undefined || !Number.isFinite(Date.parse(expiresAt))) return '';
  return `（${expiresAt} 前有效）`;
}

/**
 * 等待用户的**兜底**文本（模型说不出话时的宿主文案）：只用于**待确认**（有提案）——
 * 内容 = 执行端提案原文（summary）+ 有效期，逐字拼装，**不编新话术**（用户要拿它当确认
 * 依据）。待补（无提案）没有兜底：宿主没有这一条的文案，只记事件 + 事实留待注入
 * （与重启对账出口同一口径——不猜、不替它说）。
 */
export function waitingUserFallbackText(input: { summary: string; expiresAt?: string }): string {
  return `${input.summary}${expiresAtClause(input.expiresAt)}`;
}

/**
 * 单次失败投递（调用方 fire-and-forget；内部吞错并如实记账）。
 * 用户文本 = 降级话术（failureFallbackTextFor：资源受限走既有「系统太忙」句，其余按 kind），
 * **不含任何执行层原文/内部词**；kind 由底账执行事实的 code / result_unknown 状态归类，
 * 取不到 = executor_failed；reason=resource_limited 单独成句（审计 #18）。
 */
export async function deliverTaskFailure(fact: TaskFailureFact, options: TaskResultDeliveryOptions): Promise<boolean> {
  return deliverText(fact, failureFallbackTextFor(fact), options);
}
