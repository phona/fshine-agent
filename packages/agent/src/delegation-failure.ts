/**
 * 委派失败分类纯函数（C3）：从 context.ts 的五路链逐字搬移，行为零变化。
 *
 * 入参是结构化判据，不是 reason 字符串——平台-contract.ts 头注释「码是数据，
 * 消息文案不是」，字符串入参会引向消息嗅探。分类结果是协议五类之一，供宿主
 * 审计与话术选择使用。
 *
 * 判定顺序即优先级：取消 > 超时 > model_transient > auth > executor_error。
 * 同一时刻多条件成立时取最贴近用户动作的那个。
 */

import { isPlatformAuthError } from './platform-contract';

/** 五类协议失败分类。 */
export type DelegationFailureClass =
  | 'cancelled'
  | 'timeout'
  | 'model_transient'
  | 'auth'
  | 'executor_error';

/**
 * 结构化判据：把 context.ts catch 分支里的布尔事实与错误对象拆成独立字段，
 * 调用方按实际执行状态填入，不传 reason 字符串。
 */
export interface ClassifyDelegationFailureInput {
  /** runSignal?.aborted：用户/上层主动中止。 */
  aborted: boolean;
  /** Date.now() >= deadline：时间到了。 */
  deadlinePassed: boolean;
  /** result?.modelError：驱动透传的模型侧瞬时失败。 */
  modelError: unknown;
  /** 平台 auth 码级判定（isPlatformAuthError）。 */
  isPlatformAuthError(error: unknown): boolean;
  /** 原始错误对象（用于过渡正则兜底）。 */
  error: unknown;
}

/**
 * 五路链纯函数：输入结构化判据，输出协议分类。
 *
 * 与 context.ts 原 inline 代码逐字等价；唯一差异是把闭包变量（runSignal、
 * deadline、result、error）改成显式入参，使判定逻辑可单测、可复用。
 */
export function classifyDelegationFailure(input: ClassifyDelegationFailureInput): DelegationFailureClass {
  const { aborted, deadlinePassed, modelError, isPlatformAuthError, error } = input;
  if (aborted) return 'cancelled';
  if (deadlinePassed) return 'timeout';
  if (modelError) return 'model_transient';
  if (isPlatformAuthError(error)) return 'auth';
  // 过渡正则兜底：平台 auth.js 的自动重登录失败消息是既有唯一不带码前缀的形态，
  // 平台侧尚未给它挂码；在平台收口之前先留正则，否则退化成 executor_error。
  // 平台侧该消息一带码（走 messageFor），这行即可删除。
  if (/平台登录已过期/.test(error instanceof Error ? error.message : '')) return 'auth';
  return 'executor_error';
}
