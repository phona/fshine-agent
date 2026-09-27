/**
 * 召回事实注入（支柱 C：分层知识单一读写契约）。
 *
 * 为什么召回轮次必须读宿主持有的执行底账、而不是让模型从转录自由回忆：
 * 真实平台多轮实测（T3r）里，用户问"刚才查出来是多少钱"，模型从原始转录自由回忆，
 * 把两个不同对象、不同时间范围的查询混成"刚才两次查询"——归因串轮。同类形状还有
 * 在真实数据旁边编造一个从未查过的对象（rule-landing §14）。转录里"提过"不等于
 * "真的执行过"：宿主持久写下的执行底账才是"本会话迄今真实发生过的平台执行"。
 *
 * 数据来源（D-065 起）：`platform_tasks` 的**结构化事实**（accountSet / period /
 * calls / label / outcome）+ 结果原文（resultText）。整份事实链都是委派时的确定性
 * 信息回填的：calls 是宿主自己从 worker 提交的计划命令解析的，取值按平台 args 规格
 * 的声明名机械提取，label 是平台清单第 5 列——**没有一步是从 worker 文本解析的**。
 * 结构化字段缺失的任务（升级前的旧条目 / 没提过计划的委派）降级为渲染结果文本
 * （现有行为）；两者都没有的条目不进台账（Conversation Log 仍是完整存档）。
 *
 * 渲染纪律：只机械陈述，不解释、不排名、不比较（"哪个数值最高"这类比较让模型基于
 * 条目自己做）；结构化条目里的领域词只可能作为**数据**出现（平台 label、调用参数），
 * 渲染模板零业务词；查不到执行记录 → 返回 null，宿主静默不注入（安全缺省）；
 * 存储抛错由调用方兜底，同样不注入、不失败回合。
 */
import type { PlatformTaskRecord, PlatformTaskRepo } from '@fshine/contracts';
import { looksLikeReferenceCue } from './reference-evidence';

/** 台账条目上限：召回轮次要的是"本会话执行过哪些"，不是全部历史。 */
export const MAX_EXECUTION_FACTS = 5;
/** 单条结果原文的截断长度（字符）——全文在 Conversation Log 里，可检索。 */
const EXECUTION_FACT_CONTENT_LIMIT = 300;

/**
 * 台账文本的起始标记。两个用途：测试断言注入形态；runtime 保存转录前按它剥离
 * （台账每回合重算，旧的副本留在转录里会和新的并列——那正是串轮的形状）。
 */
export const EXECUTION_FACTS_MARKER = '【宿主执行事实：';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'] as const;

/** 结局 → 台账用词（机械映射，不发明状态词，也不把"没有执行"洗成结果）。 */
const OUTCOME_TEXT: Readonly<Record<NonNullable<PlatformTaskRecord['outcome']>, string>> = {
  done: 'done',
  needs: '缺信息',
  failed: '失败',
};

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
  platformTasks: Pick<PlatformTaskRepo, 'listBySession'>;
  principalId: string;
  sessionId: string;
  userMessage: string;
}): Promise<ExecutionFacts | null> {
  const { platformTasks, principalId, sessionId, userMessage } = options;
  // 线索触发与主动回溯同一把尺（reference-evidence.ts）：召回轮才注入，省 token。
  if (!looksLikeReferenceCue(userMessage)) return null;

  const records = await platformTasks.listBySession(principalId, sessionId);
  // 只认有内容可渲染的条目：结构化字段或结果文本至少占一项（两者都没有的旧条目
  // 不进台账——不猜、不拿空条目占位）。
  const kept = records.filter((record) => hasStructuredFacts(record) || Boolean(record.resultText?.trim()));
  if (kept.length === 0) return null;
  const visible = kept.slice(-MAX_EXECUTION_FACTS);
  const truncated = kept.length > visible.length;
  return { text: renderExecutionFacts(visible, truncated), count: visible.length, truncated };
}

/** 条目是否带结构化事实（任一字段即算——缺的字段在渲染时自然省略）。 */
function hasStructuredFacts(record: PlatformTaskRecord): boolean {
  return Boolean(record.accountSet || record.period || record.label || record.calls?.length || record.outcome);
}

/** 条目时间：ISO 串取到分钟，零时区运算（与系统提示词日期行同一取法）。 */
function formatFactTime(createdAt: string): string {
  const stamp = Date.parse(createdAt);
  if (!Number.isFinite(stamp)) return '';
  return new Date(stamp).toISOString().slice(0, 16).replace('T', ' ');
}

/** 结果正文：折叠空白后截断——台账是紧凑材料，全文在 Log 里可检索。 */
function factBody(content: string): string {
  const body = content.replace(/\s+/g, ' ').trim();
  return body.length > EXECUTION_FACT_CONTENT_LIMIT ? `${body.slice(0, EXECUTION_FACT_CONTENT_LIMIT)}…` : body;
}

/**
 * 单条渲染：有结构化字段 → 机械结构化条目（时间｜对象 时间窗 平台label → 结局），
 * 结果原文仍附在其后（数值结论只能来自原文——结构化条目管归因，不管数值）；
 * 字段缺失 → 降级为结果原文（现有行为）。
 */
function renderFact(record: PlatformTaskRecord): string {
  const time = formatFactTime(record.createdAt);
  const scope = [record.accountSet, record.period, record.label].filter(Boolean).join(' ');
  const outcome = record.outcome ? OUTCOME_TEXT[record.outcome] : '';
  const head = `${time ? `${time}｜` : ''}${scope}${scope && outcome ? ' ' : ''}${outcome ? `→ ${outcome}` : ''}`;
  const body = factBody(record.resultText ?? '');
  // 时间戳后已有分隔符：结构化段为空时不能再补一个｜（降级形态 = 时间｜原文，与旧行为一致）
  const separator = scope || outcome ? '｜' : '';
  return [head, body].filter(Boolean).join(separator);
}

function renderExecutionFacts(records: readonly PlatformTaskRecord[], truncated: boolean): string {
  const lines = records.map((event, index) => {
    const marker = CIRCLED[index] ?? `${index + 1}.`;
    return `${marker} ${renderFact(event)}`;
  });
  const tail = truncated ? `\n（执行条目较多，仅保留最近 ${records.length} 条；更早的执行不在本材料内。）` : '';
  return [
    `${EXECUTION_FACTS_MARKER}本会话迄今真实发生过的平台执行，按时间正序，由宿主持有的底账机械渲染，一条目一次委派。`,
    '回答"刚才/之前/那次"类召回问题时只能依据这些条目陈述：条目之外没有发生过的执行，',
    '不得引用转录里其他地方提到的对象或结果，也不得把不同条目混称为一次查询；',
    '条目里没有的结论就是没有发生过，如实说明，不要用估计值填充。】',
    ...lines,
    tail,
  ].filter(Boolean).join('\n');
}
