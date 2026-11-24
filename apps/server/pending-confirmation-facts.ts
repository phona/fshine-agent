/**
 * 久未表态的写确认：**新一轮里提示**（owner 2026-11-24）。
 *
 * 形状：提案还在等用户确认（底账等待行 + 有 confirmation），用户却又开了一轮说别的事——
 * 本轮开头把「还有一件没表态」当机械事实注入给 Main，**说不说、怎么说由 Main 定**
 * （宿主不主动推送、不设提醒定时器：没有新机制、没有新常量）。
 *
 * 为什么读底账而不是复用通知事实队列：通知事实（waiting_user）在**进入等待那一刻**注入一次，
 * 之后用户连开几轮就不再有人提；而「还在等确认」是底账的持续事实，每轮现读即可——
 * 无队列状态、无去重计数，确认/取消/超时后自然消失（`listWaiting` 已按 canonical 谓词过滤：
 * 提问在场且无结束事实）。
 *
 * 硬边界：**不含 handle**（句柄是宿主持有的凭据，永不出宿主）、不含 taskId/内部码；
 * summary 是执行层提案原话，逐字进事实（模型要能原样转述）。缺信息类等待（无 confirmation）
 * 不在这里提示——它没有「将写入什么」，提示了用户也无从表态。
 */
import type { InjectionValue } from '../../packages/agent/src/execution-runtime';
import type { TaskRegistry, TaskScope } from '../../packages/agent/src/task-registry';

/** 一条待表态事实的文本（给模型读；用户听到的话由模型写）。 */
export function renderPendingConfirmationFact(input: {
  name?: string;
  summary: string;
  /** 末次失败/拒绝执行的原始事实（code/message 原话；提案被拒时用户要听见为什么）。 */
  refusal?: { code?: string; reason?: string };
}): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${input.name.trim()}」`
    : '之前那件事';
  const refusal = input.refusal;
  const refusalClause = refusal === undefined
    ? ''
    : ` 注意：这笔写**已经被执行层拒绝**（${[refusal.code, refusal.reason].filter((part) => part !== undefined && part.trim() !== '').join('：') || '未给出原因'}），别再当「等你确认」问——按这个拒绝事实回话。`;
  return `[仍等你表态]${subject}有个写操作提案还没得到你答复：将写入（逐字）：${input.summary}。${refusalClause}`
    + '用户自己提起了就别重复；没提就按情况问一句。';
}

/**  scope → 待表态提案的 provider（无 pending 返回 undefined；纯函数，无状态）。 */
export function createPendingConfirmationProvider(
  registry: Pick<TaskRegistry, 'listWaiting'>,
): (principalId: string, sessionId: string) => InjectionValue | undefined {
  return (principalId, sessionId) => {
    const scope: TaskScope = { principalId, sessionId };
    const lines = registry
      .listWaiting(scope)
      .map((task) => {
        const summary = task.pendingQuestion?.confirmation?.summary;
        if (summary === undefined || summary.trim() === '') return undefined;
        // 拒绝原因**读底账已有的执行行**（不新增任何状态/字段）：末条执行是 failed/refused
        // 时，这个提案已经被执行层拒过——同回合自 commit 被 GATE_REFUSE 正是这个形状
        // （background-write-confirmation.test.ts ⑮ 已冻）。此前拒绝只活在一次性的
        // notice.report 里，下一轮用户开口就丢了（2026-11-24 grok major）。
        const lastFailure = [...(task.executions ?? [])]
          .reverse()
          .find((entry) => entry.status === 'failed' || entry.status === 'refused');
        return renderPendingConfirmationFact({
          ...(task.name === undefined ? {} : { name: task.name }),
          summary,
          ...(lastFailure === undefined ? {} : {
            refusal: {
              ...(lastFailure.error?.code === undefined ? {} : { code: lastFailure.error.code }),
              ...(lastFailure.error?.message === undefined ? {} : { reason: lastFailure.error.message }),
            },
          }),
        });
      })
      .filter((line): line is string => line !== undefined);
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  };
}
