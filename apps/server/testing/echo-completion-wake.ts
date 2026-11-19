/**
 * 测试夹具（**非生产**）：apps/server 各假主驱动的「唤醒回合脚本模型」公共形状。
 *
 * 新形状（owner 2026-11-19 唤醒切片）：后台任务完成 → 唤醒会话模型、由它把话带给用户，
 * 宿主只投递它说的话。假驱动没有真实模型，这里按**产品形状**给出一份脚本：模型把注入事实
 * 里的「结果正文（逐字）」段复读给用户（用户可见内容仍由各用例的既有断言钉住）。
 * 生产实现见 `packages/agent/src/pi-driver.ts` 的 wake；事实拼装见
 * `apps/server/task-completion-delivery.ts` 的 taskCompletionFactText。
 */
import type { WakeResult } from '../../../packages/agent/src/driver-contract';

const RESULT_MARKER = '结果正文（逐字）：';
const TAIL_MARKER = '。请把这件事告诉用户。';

/** 复读事实里的结果正文；形状不符/正文为空 → failed（与真实驱动的空回复出口同态）。 */
export function echoCompletionWake(factText: string): WakeResult {
  const start = factText.indexOf(RESULT_MARKER);
  if (start === -1) return { outcome: 'failed' };
  const rest = factText.slice(start + RESULT_MARKER.length);
  const end = rest.lastIndexOf(TAIL_MARKER);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body.trim() === '' ? { outcome: 'failed' } : { outcome: 'woken', text: body };
}
