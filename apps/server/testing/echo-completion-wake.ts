/**
 * 测试夹具（**非生产**）：apps/server 各假主驱动的「唤醒回合脚本模型」公共形状。
 *
 * 新形状（owner 2026-11-19 唤醒切片）：后台任务完成 → 唤醒会话模型、由它把话带给用户，
 * 宿主只投递它说的话。假驱动没有真实模型，这里按**产品形状**给出一份脚本：模型把注入事实
 * 里的「结果正文（逐字）」段复读给用户（用户可见内容仍由各用例的既有断言钉住）。
 * 生产实现见 `packages/agent/src/pi-driver.ts` 的 wake；事实拼装见
 * `apps/server/task-completion-delivery.ts` 的 taskCompletionFactText。
 *
 * 2026-11-21 live P0 补等待事实的脚本：`[任务等待]`（进入 waiting_user 的唤醒事实）——
 * 待确认复读「将写入（逐字）」段（提案原文 + 有效期），待补复读 missing 条目。产品形状 =
 * 模型把待确认/待补内容**原样**告诉用户并等表态。
 */
import type { WakeResult } from '../../../packages/agent/src/driver-contract';

const RESULT_MARKER = '结果正文（逐字）：';
const TAIL_MARKER = '。请把这件事告诉用户。';
const PROPOSAL_MARKER = '将写入（逐字）：';
const MISSING_MARKER = '还缺：';
const WAITING_TAIL_MARKER = '。请把待确认/待补内容原样告诉用户并等表态。';

/** 复读事实里的结果正文；形状不符/正文为空 → failed（与真实驱动的空回复出口同态）。 */
export function echoCompletionWake(factText: string): WakeResult {
  const start = factText.indexOf(RESULT_MARKER);
  if (start !== -1) {
    const rest = factText.slice(start + RESULT_MARKER.length);
    const end = rest.lastIndexOf(TAIL_MARKER);
    const body = end === -1 ? rest : rest.slice(0, end);
    return body.trim() === '' ? { outcome: 'failed' } : { outcome: 'woken', text: body };
  }
  // 等待事实（待确认）：复读提案原文段（含有效期从句）；句柄不进事实，复读也带不出。
  const proposalStart = factText.indexOf(PROPOSAL_MARKER);
  if (proposalStart !== -1) {
    const rest = factText.slice(proposalStart + PROPOSAL_MARKER.length);
    const end = rest.lastIndexOf(WAITING_TAIL_MARKER);
    const body = (end === -1 ? rest : rest.slice(0, end)).trim();
    return body === ''
      ? { outcome: 'failed' }
      : { outcome: 'woken', text: `待确认内容（原样）：${body}。请回复确认或说不确认。` };
  }
  // 等待事实（待补）：把缺的条目原样报给用户。
  const missingStart = factText.indexOf(MISSING_MARKER);
  if (missingStart !== -1) {
    const rest = factText.slice(missingStart + MISSING_MARKER.length);
    const end = rest.indexOf('。');
    const body = (end === -1 ? rest : rest.slice(0, end)).trim();
    return body === '' ? { outcome: 'failed' } : { outcome: 'woken', text: `这件事在等你补充：${body}。请补一句。` };
  }
  return { outcome: 'failed' };
}
