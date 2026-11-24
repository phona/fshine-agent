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
  /** 本任务的执行行原话（status + code/message，未作任何判断）。给 Main 自己看，不代替它判。 */
  ledger?: readonly string[];
}): string {
  const subject = input.name !== undefined && input.name.trim() !== ''
    ? `「${input.name.trim()}」`
    : '之前那件事';
  // **只原样给执行事实，不下结论**（2026-11-24 grok blocking：我曾在这里写「这笔写已经被
  // 执行层拒绝，别再当『等你确认』问」——那正是宿主又在判。默认写确认的形状就是 prepare →
  // needs_confirmation → 同回合 commit 被 CONFIRMATION_REQUIRED 拒，提案仍然有效、仍在等
  // 用户确认；按我的结论走，Main 会把正常的确认请求带偏。也不按码排除——那就是把已删的
  // 容忍码表换个名字接回来。要做判断的是 Main，它自己会读这些行。
  const ledgerClause = input.ledger === undefined || input.ledger.length === 0
    ? ''
    : `\n本任务执行行原话（未作判断，做没做成你看了算）：\n${input.ledger.map((line) => `  ${line}`).join('\n')}\n`;
  // 注意 ledgerClause 以换行收尾：否则最后一条执行行原话会和下句宿主指令粘成一行，
  // Main 照原话转述时，用户看到的拒绝原因里夹着「用户自己提起了就别重复」（2026-11-24
  // grok major——原话边界丢了。
  return `[仍等你表态]${subject}有个写操作提案还没得到你答复：将写入（逐字）：${input.summary}。${ledgerClause}`
    + '用户自己提起了就别重复；没提就按情况问一句。';
}

/** 一条执行行的原话（status + code/message；都不缺才拼得出来）。 */
export function executionLineText(entry: { status: string; error?: { code?: string; message?: string } }): string {
  const parts = [entry.status];
  if (entry.error?.code !== undefined && entry.error.code.trim() !== '') parts.push(entry.error.code);
  if (entry.error?.message !== undefined && entry.error.message.trim() !== '') parts.push(entry.error.message.trim());
  return parts.join(' · ');
}

/** 执行行原话最多带几条（有界；防止把大账整段灌进模型上下文）。 */
const LEDGER_TAIL_LINES = 6;

/** scope → 待表态提案的 provider（无 pending 返回 undefined；纯函数，无状态）。 */
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
        // 执行行原样带上（有界）：此前下一轮只有提案摘要，Main 看不见这一笔到底发生过什么
        // （2026-11-24 grok major）。**不筛状态、不下结论**——同回合确认被
        // CONFIRMATION_REQUIRED 拒与「写真被拒」在行里都写着，由 Main 自己读了自己判；
        // 宿主再按码分类就是把删掉的容忍码表接回来（grok blocking）。
        const executions = task.executions ?? [];
        const ledger = executions.slice(-LEDGER_TAIL_LINES).map(executionLineText);
        return renderPendingConfirmationFact({
          ...(task.name === undefined ? {} : { name: task.name }),
          summary,
          ...(ledger.length === 0 ? {} : { ledger }),
        });
      })
      .filter((line): line is string => line !== undefined);
    if (lines.length === 0) return undefined;
    return lines.join('\n');
  };
}
