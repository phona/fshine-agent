/**
 * 召回事实注入（支柱 C：分层知识单一读写契约）。
 *
 * 为什么召回轮次必须读宿主持有的执行底账、而不是让模型从转录自由回忆：
 * 真实平台多轮实测（T3r）里，用户问"刚才查出来是多少钱"，模型从原始转录自由回忆，
 * 把两个不同对象、不同时间范围的查询混成"刚才两次查询"——归因串轮。同类形状还有
 * 在真实数据旁边编造一个从未查过的对象（rule-landing §14）。转录里"提过"不等于
 * "真的执行过"：宿主持久写下的执行底账才是"本会话迄今真实发生过的平台执行"。
 *
 * 数据来源的取舍（按设计文档给的优先级逐个读过 store.ts 之后的诚实结论，宁少勿猜）：
 *   · `platform_tasks`：任务记录只存 taskId / 归属会话 / worker 原始转录 / 时间戳——
 *     没有对象、没有时间范围、没有调用次数；`workerMessages` 是 worker 的转录，渲染它
 *     就是重新注入"转录里偶然提到的文本"，正是本模块要替代的东西。仓库接口也只有
 *     get/upsert，没有按会话列举的入口。→ 不贡献任何事实（如实记录，不猜字段）。
 *   · `task_plan_steps`：只有多步拆解才写步骤事实，而每一步的结果在 Log 里本来就有
 *     一条 tool_result；两侧合并会把同一次执行渲染两遍——那正是 T3r"混成两次查询"的
 *     形状。步骤事实里的 taskId 在 Log 事件里已被脱敏，没有可串联的键。→ 不作第二来源。
 *   · Conversation Log 的 `tool_result` 事件：每次委派的结果恰好一条，append-only、
 *     按会话隔离、时间有序，是唯一无缺口也无重复的执行底账。→ 唯一事实源。
 *   · `plan_event`（计划门通知）刻意不收：它是"准备查什么"的预告，不是执行结果——
 *     把预告当结果注入正是另一种归因错误。
 *
 * 渲染纪律：只机械陈述，不解释、不排名、不比较（"哪个余额最高"这类比较让模型基于
 * 条目自己做）；业务词只可能作为数据出现在记录原文里，渲染模板零业务词；查不到
 * 执行记录（无任务/无步骤）→ 返回 null，宿主静默不注入（安全缺省）；存储抛错由
 * 调用方兜底，同样不注入、不失败回合。
 */
import type { ConversationEventRecord, ConversationLogRepo } from '@fshine/contracts';
import { looksLikeReferenceCue } from './reference-evidence';

/** 台账条目上限：召回轮次要的是"本会话执行过哪些"，不是全部历史。 */
export const MAX_EXECUTION_FACTS = 5;
/** 扫窗大小：台账要尽量完整地回答"迄今执行过哪些"，窗口取大一些（store 上限 500）。 */
const EXECUTION_FACT_SCAN_LIMIT = 100;
/** 单条记录内容截断长度（字符）——原文全文在 Conversation Log 里，可检索。 */
const EXECUTION_FACT_CONTENT_LIMIT = 300;

/**
 * 台账文本的起始标记。两个用途：测试断言注入形态；runtime 保存转录前按它剥离
 * （台账每回合重算，旧的副本留在转录里会和新的并列——那正是串轮的形状）。
 */
export const EXECUTION_FACTS_MARKER = '【宿主执行事实：';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'] as const;

export interface ExecutionFacts {
  /** 注入给模型的台账文本。 */
  text: string;
  /** 实际注入的条目数。 */
  count: number;
  /** 是否因上限截断（更早的执行不在本材料内）。 */
  truncated: boolean;
}

/**
 * 检索执行台账。返回 null 的三种情况：没有召回线索、没有任何执行记录、存储不可用
 * （存储抛错由调用方前置 try/catch 兜底，与主动回溯同一套降级路径）。
 */
export async function collectExecutionFacts(options: {
  conversationLog: Pick<ConversationLogRepo, 'list'>;
  principalId: string;
  sessionId: string;
  userMessage: string;
}): Promise<ExecutionFacts | null> {
  const { conversationLog, principalId, sessionId, userMessage } = options;
  // 线索触发与主动回溯同一把尺（reference-evidence.ts）：召回轮才注入，省 token。
  if (!looksLikeReferenceCue(userMessage)) return null;

  const events = await conversationLog.list({ principalId, sessionId, limit: EXECUTION_FACT_SCAN_LIMIT });
  // 只认宿主持有的执行底账：每次委派的结果恰好写一条 tool_result 事件
  // （runtime.ts extract17dzToolResultEvents；纯 conversation 申报不写条目）。
  const records = events.filter((event) => event.kind === 'tool_result' && (event.content ?? '').trim());
  if (records.length === 0) return null;
  const kept = records.slice(-MAX_EXECUTION_FACTS);
  const truncated = records.length > kept.length;
  return { text: renderExecutionFacts(kept, truncated), count: kept.length, truncated };
}

/** 记录时间：ISO 串取到分钟，零时区运算（与系统提示词日期行同一取法）。 */
function formatFactTime(createdAt: string): string {
  const stamp = Date.parse(createdAt);
  if (!Number.isFinite(stamp)) return '';
  return new Date(stamp).toISOString().slice(0, 16).replace('T', ' ');
}

/** 记录正文：折叠空白后截断——台账是紧凑材料，全文在 Log 里可检索。 */
function factBody(content: string): string {
  const body = content.replace(/\s+/g, ' ').trim();
  return body.length > EXECUTION_FACT_CONTENT_LIMIT ? `${body.slice(0, EXECUTION_FACT_CONTENT_LIMIT)}…` : body;
}

function renderExecutionFacts(records: readonly ConversationEventRecord[], truncated: boolean): string {
  const lines = records.map((event, index) => {
    const marker = CIRCLED[index] ?? `${index + 1}.`;
    const time = formatFactTime(event.createdAt);
    return `${marker} ${time ? `${time}｜` : ''}${factBody(event.content ?? '')}`;
  });
  const tail = truncated ? `\n（执行记录较多，仅保留最近 ${records.length} 条；更早的执行不在本材料内。）` : '';
  return [
    `${EXECUTION_FACTS_MARKER}本会话迄今真实发生过的平台执行，按时间正序，由宿主持有的记录机械渲染，一条目一次委派。`,
    '回答"刚才/之前/那次"类召回问题时只能依据这些条目陈述：条目之外没有发生过的执行，',
    '不得引用转录里其他地方提到的对象或结果，也不得把不同条目混称为一次查询；',
    '条目里没有的结论就是没有发生过，如实说明，不要用估计值填充。】',
    ...lines,
    tail,
  ].filter(Boolean).join('\n');
}
