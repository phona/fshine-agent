/**
 * 资源耗尽（RESOURCE_EXHAUSTED）终稿合成——"失败必达"路径 1 的宿主侧收尾。
 *
 * 背景（2026-10 事故）：worker 洗数据 15 分钟撞回合墙钟被强制截停，任务 outcome=failed，
 * 用户拿到的只有"平台响应超时，请稍后重试"——不可行动，且与企微流式回复的 10 分钟更新
 * 窗口叠加后整轮静默（终帧被渠道拒收，用户端停在旧进度帧）。协议对 RESOURCE_EXHAUSTED
 * 的宿主送达义务（contracts/a2a-protocol.ts 的 FAILURE_CLASS_POLICIES）是"送达已完成
 * 部分与下一步，并附续跑入口"——本模块把那份义务落成终稿。
 *
 * 事实面（全部宿主持有，零 worker 文本嗅探）：
 *   · platform_tasks 底账的刚失败条目：结构化执行事实（label / accountSet / period /
 *     calls，D-065 口径）与此前回合已取得的结果原文（resultText，续跑任务的断点内容）；
 *     中间转录（workerMessages）已由 context.ts 的超时 catch 持久化，是"进度已保留"
 *     这句话的事实依据；
 *   · 本回合计划模式已完成步骤（runtime 的 turn.planStepOutcomes）。
 *
 * 分类判定权：超时的判定在 context.ts（failureClass 'timeout'，取消先于超时先于 auth），
 * 本模块不重判——runtime 在收到 DELEGATION_TIMEOUT_FAILURE 话术（error-codes 表唯一
 * 来源，按字符串恒等比对，不做模糊匹配）时把该失败映射为协议分类 RESOURCE_EXHAUSTED
 * 并合成终稿。底账不可用 / 查不到条目时同样合成（降级为无事实版本），绝不回落到
 * "请稍后重试"——失败必达的判据是"用户拿到可行动的反馈"，不是"底账必须在场"。
 */
import type { PlatformTaskRecord, PlatformTaskRepo } from '@fshine/contracts';

/** 协议失败分类（contracts FAILURE_CLASS_POLICIES 五类之一），进审计事件供续跑识别。 */
export const RESOURCE_EXHAUSTED_CLASS = 'RESOURCE_EXHAUSTED';

/**
 * 从会话底账挑出刚超时的任务条目：优先按显式 taskId（continueTaskId / resumeTaskId，
 * 比时间序更真），否则取最近一条 failed——context.ts 的 catch 先落账再抛话术，抛出
 * 时刻最近的一条 failed 就是刚超时的这条。
 */
export function pickTimedOutRecord(
  records: readonly PlatformTaskRecord[],
  preferredTaskId?: string,
): PlatformTaskRecord | null {
  if (preferredTaskId) {
    const exact = records.find((record) => record.taskId === preferredTaskId);
    if (exact) return exact;
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.outcome === 'failed') return records[index]!;
  }
  return null;
}

/**
 * 读底账并挑出刚超时的条目；存储未注入 / 抛错 → null（终稿降级为无事实版本，不失败
 * 回合——与执行台账不可用时的降级同纪律）。requestId 只进降级日志。
 */
export async function loadTimedOutRecord(
  platformTasks: Pick<PlatformTaskRepo, 'listBySession'> | undefined,
  principalId: string,
  sessionId: string,
  preferredTaskId?: string,
  requestId?: string,
): Promise<PlatformTaskRecord | null> {
  if (!platformTasks) return null;
  try {
    return pickTimedOutRecord(await platformTasks.listBySession(principalId, sessionId), preferredTaskId);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'resource_exhausted_record_lookup_failed',
      ...(requestId ? { requestId } : {}),
      error: error instanceof Error ? error.message.slice(0, 160) : String(error),
    }));
    return null;
  }
}

export interface ResourceExhaustedInput {
  /** 底账里刚超时的任务条目；null = 底账不可用或查不到（渲染无事实版本）。 */
  record: PlatformTaskRecord | null;
  /** 本回合已完成的计划步骤标签（turn.planStepOutcomes 中 outcome='done' 的那些）。 */
  doneSteps?: readonly string[];
}

/** 单条事实行截断：终稿是给用户的摘要，不是底账转储；全文在 Log 与任务条目里可查。 */
const FACT_LINE_LIMIT = 160;

/** 任务条目的结构化事实 → 一行"已执行操作"描述；没有任何结构化字段时返回空。 */
function executedLineOf(record: PlatformTaskRecord): string {
  const scope = [record.accountSet, record.period].filter(Boolean).join(' ');
  const action = record.label ?? record.calls?.[0]?.operation;
  if (!action && !scope) return '';
  return [action, scope].filter(Boolean).join('（') + (scope && action ? '）' : '');
}

/**
 * 合成资源耗尽终稿。三要素固定在场（协议送达义务）：
 *   ① 已完成部分——事实在场时逐行列出（已完成步骤 / 已执行操作 / 此前结果），全部缺席
 *      时如实说"暂无可确认的已完成产出"，不编造；
 *   ② 未完成部分——任务未能在本轮时间预算内执行完毕；
 *   ③ 续跑入口——回复"继续"从断点续跑（中间转录已持久化，taskId 续跑由宿主底账承接）。
 * 措辞纪律：零业务词、零内部机制词（预算/墙钟/worker 不出现）、零 id 与错误码形状——
 * 分类 RESOURCE_EXHAUSTED 进审计事件，不进用户文本。
 */
export function renderResourceExhaustedReply(input: ResourceExhaustedInput): string {
  const completed: string[] = [];
  for (const label of input.doneSteps ?? []) {
    completed.push(`· 已完成步骤：${label}`);
  }
  const record = input.record;
  if (record) {
    const executed = executedLineOf(record);
    if (executed) completed.push(`· 已执行操作：${executed}`);
    const prior = (record.resultText ?? '').replace(/\s+/g, ' ').trim();
    if (prior) completed.push(`· 此前已取得的结果：${prior.length > FACT_LINE_LIMIT ? `${prior.slice(0, FACT_LINE_LIMIT)}…` : prior}`);
  }
  if (completed.length === 0) {
    completed.push('· 本轮暂无可确认的已完成产出；已发生的工作痕迹已保留。');
  }
  return [
    '[资源超时] 本次任务处理时间达到上限，已自动停止，进度已保留。',
    '已完成部分：',
    ...completed,
    '未完成部分：任务未能在本轮时间预算内执行完毕，剩余工作已暂停。',
    '回复“继续”可从断点续跑。',
  ].join('\n');
}
