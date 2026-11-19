/**
 * A2b「同对象确定性失败不重撞」锁（2026-11-18 执行面可靠性）——**前台会话 execute_operation
 * 与后台单回合执行器（createTaskExecutor）共用这一份实现**（键 + 记录 + 判定）。
 *
 * 根因（live 实测 E14，2026-11-18）：同一集合的窗口参数被执行层判定不可用后，模型换着写法
 * （`2026-10` / `W202610`）连撞两次，又换新任务继续撞——单回合最多撞到 5 次上限。
 *
 * 纪律（owner 2026-11-18 fail-safe）：判据是**执行层没有显式说可重试**——只有 `retryable: true`
 * （瞬时故障）放行；`false` 与**未声明**都按不可重试处理，本回合内该 (operation, 对象参数)
 * 的后续调用一律不发起。宁可停下报错让人介入，也不在不确定时继续撞。
 *
 * 本模块只做「键 + 记录 + 判定」这件确定性的事；**拦截话术不在本模块**——前台与后台的模型
 * 可见面不同（前台要带执行层原话的逐字提醒，后台按用户话术收口），由调用点各自接线。
 * 锁的作用域 = 一次「回合」：调用点每回合新建一个锁，回合结束即丢弃（不跨回合记忆）。
 */
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';

/**
 * 对象参数名（与内联路径逐字一致）：取对象参数里第一个存在的字符串值作为「对象标识」。
 * 一个都取不到时保守行为 = 不启用锁（没有对象名就无法判定「同对象」，宁可不挡也不误挡）。
 * 2026-11-19 起本函数同时是**「同对象」判据的唯一来源**：回合终局把「成功后同对象的重复写失败」
 * 归为多余尝试（见 execution-runtime 的终局判定），不要在别处另造一套对象识别。
 */
const OBJECT_ARG_KEYS = ['--collection', '--topic', 'collection', 'topic'] as const;

/** 被拦下的一次重试（观测用；对象/操作/执行层码与它的 retryable 声明）。 */
export interface RetryBlock {
  operation: string;
  object: string;
  code: string;
  /** 执行层对该失败的 retryable 声明；undefined = 未声明（按不可重试处理）。 */
  declaredRetryable?: boolean;
}

/** 放行的一次重试（观测用）：执行层显式声明 retryable:true 的失败——本回合允许继续尝试。 */
export interface RetryAllowed {
  operation: string;
  object: string;
  code: string;
}

/** 发起前被拦的判定事实：拦截记录 + 执行层原话（原话是否展示由调用点决定）。 */
export interface BlockedRetry {
  block: RetryBlock;
  /** 执行层对该失败给出的原话（留住以便如实转述）；未留存则 undefined。 */
  executorMessage?: string;
}

export interface DeterministicRetryLock {
  /**
   * 发起前判定：同一 (operation, 对象) 本回合已被判定确定性失败 → 返回拦截事实（调用点
   * 不再发起执行、自行投递可见面）；未命中 / 取不到对象名 → undefined（照常发起）。
   */
  before(operation: string, args: Record<string, unknown>): BlockedRetry | undefined;
  /**
   * 执行后登记：**只对 failed / refused** 按 retryable 声明记录——
   *   · retryable:true（瞬时故障）→ 不锁，返回放行事实（调用点可留「为什么还在试」的可见面）；
   *   · 其余（false / 未声明）→ 记入本回合集合（后续同键调用在 before 被拦）；
   * completed / accepted / needs_confirmation / needs_input 与取不到对象名 → undefined
   * （成功过的重复照常放行；待确认/待补充是交互事实，不归本锁）。
   */
  after(operation: string, args: Record<string, unknown>, outcome: ExecutionOutcome): RetryAllowed | undefined;
}

/** 对象标识的取法（逐字搬运内联路径）：args 里第一个存在的字符串对象参数。 */
export function retryObjectOf(args: Record<string, unknown>): string | undefined {
  for (const key of OBJECT_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** 锁键 = (operation, 对象)。用 NUL 分隔避免两段拼接歧义。 */
function retryLockKey(operation: string, object: string): string {
  return `${operation}\u0000${object}`;
}

/** 新建一次回合的锁（回合边界清零：每次调用即独立作用域，不跨回合记忆）。 */
export function createDeterministicRetryLock(): DeterministicRetryLock {
  const failures = new Map<string, { code: string; declaredRetryable?: boolean; message?: string }>();
  return {
    before(operation, args) {
      const object = retryObjectOf(args);
      if (object === undefined) return undefined;
      const failure = failures.get(retryLockKey(operation, object));
      if (failure === undefined) return undefined;
      return {
        block: {
          operation,
          object,
          code: failure.code,
          ...(failure.declaredRetryable === undefined ? {} : { declaredRetryable: failure.declaredRetryable }),
        },
        ...(failure.message === undefined ? {} : { executorMessage: failure.message }),
      };
    },
    after(operation, args, outcome) {
      const object = retryObjectOf(args);
      if (object === undefined) return undefined;
      // 只对 failed / refused 登记：completed / accepted / needs_confirmation / needs_input 都不参与
      // 判定——成功过的重复照常放行；待确认/待补充是交互事实（归等待状态机），不是「失败重撞」。
      if (outcome.status !== 'failed' && outcome.status !== 'refused') return undefined;
      const error = outcome.error;
      if (error.retryable === true) {
        // 瞬时故障：不锁，返回放行事实（调用点可留「为什么还在试」的可见面）。
        return { operation, object, code: error.code ?? 'retryable_failure' };
      }
      failures.set(retryLockKey(operation, object), {
        code: error.code ?? 'unclassified_failure',
        ...(error.retryable === undefined ? {} : { declaredRetryable: error.retryable }),
        // 原话要留住：被拦下时调用点仍要能如实转述「执行层说了什么」。
        ...(typeof error.message === 'string' && error.message !== '' ? { message: error.message } : {}),
      });
      return undefined;
    },
  };
}
