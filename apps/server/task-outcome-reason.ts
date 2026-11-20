/**
 * 失败唤醒出口的零执行 outcome 判据（F3-1）：**只用结构化原因码**判 blocked，不扫文案。
 *
 * 旧实现（server.ts）用 `reason.includes('权限') || reason.includes('不允许')` 判
 * permission_denied —— 用户可见原因文本里只要出现「权限」字样（例如执行层如实回报
 * 「对象 X 的权限字段校验失败」，那是业务失败，不是本次允许集合拒绝）就会被误判成
 * blocked。原因码是宿主/执行层在发起执行前/失败结局里机械带下来的结构化事实，文本只是
 * 给模型读的转述；判据只认前者。
 */
import {
  classifyOutcome,
  OUTCOME_REASON_NOT_PERMITTED,
  type OutcomeLedger,
  type TaskOutcome,
} from '../../packages/agent/src/task-outcome';

/** 零执行的原因码判据输入。 */
export interface ZeroExecReasonInput {
  /** 执行层/宿主的结构化原因码（如 `not_permitted` / `result_unknown`）。 */
  reasonCode?: string;
  /** 底账终态失败码（如 `failed_confirmed`）。 */
  ledgerReasonCode?: string;
  /** 任务终态。 */
  terminal: OutcomeLedger['terminal'];
  /**
   * Worker 失败汇报的文本（只进事实/日志给模型读）。**判据刻意不读取本字段**——保留在输入
   * 形状里是为了让「误用文本判 blocked」的反向绊线能在旧实现上真实变红（见 test 文件末注）。
   */
  reasonText?: string;
}

/**
 * 一条失败任务是否属于「零执行 + 权限拒绝」。
 * 只看结构化原因码；`reasonText`（哪怕含「权限」）一律不参与——这是 F3-1 的反向绊线。
 */
export function isZeroExecutionPermissionDenied(input: ZeroExecReasonInput): boolean {
  return input.reasonCode === OUTCOME_REASON_NOT_PERMITTED;
}

/**
 * 失败唤醒出口的五态分类：把机械事实喂给宿主侧分类器。
 * `reasonCode` 来自执行端失败结局的结构化码，`ledgerReasonCode` 来自底账；都**不是**文案。
 */
export function classifyFailureOutcome(
  executions: OutcomeLedger['executions'],
  input: ZeroExecReasonInput,
): TaskOutcome {
  const zeroReason = executions.length === 0 && isZeroExecutionPermissionDenied(input)
    ? 'permission_denied'
    : undefined;
  return classifyOutcome({
    executions,
    terminal: input.terminal,
    ...(zeroReason === undefined ? {} : { zeroReason }),
    ...(input.ledgerReasonCode === undefined ? {} : { reasonCode: input.ledgerReasonCode }),
    ...(input.reasonCode === undefined ? {} : { outcomeReasonCode: input.reasonCode }),
  });
}
