/**
 * 每回合的上下文档装配：宿主注入的头部材料（历史资料注令 / Context State / 长期记忆投影 /
 * 指代证据 / 执行台账 / 消歧通知 / 澄清绑定通知）+ 最近 N 回合的选取 + 保存前的注令剥离。
 *
 * 依赖方向铁律：本模块**不 import runtime.ts**（runtime 要用这里的装配与选取，引回来就成环，
 * 由 packages/agent/architecture-shape.test.ts 的环断言守着）。住在这里的只有**纯装配与
 * 纯选取**——材料的取数（collectReferenceEvidence / collectExecutionFacts /
 * deps.contextStates.get / loadMemoryProjection）、driver.compact 的调用与降级、保存转录，
 * 全部留在 runtime.ts 的调用点：它们的结果作为参数传进 assembleTurnContext。
 *
 * 为什么值得单独成模块：注入顺序（最后 unshift 的落在最头部）是"本轮最相关的材料先于
 * Context State 与记忆"这条纪律的唯一载体，今天只能靠 runtime.test.ts 的 driver harness
 * 间接验证；抽成纯函数后，每一种"材料在场/缺席"的组合都能用纯数据直接钉住（R3）。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { EXECUTION_FACTS_MARKER } from './execution-facts';
import type { ContextState } from './context-state';

/**
 * 最近 N 回合的历史资料注令（D-070 改写：把"一律不得引用"拆成两个分支）。
 *
 * 原注令只有一句"其中的财务结论不得作为本轮实时结果引用，需要重新实时查询"。2026-09-28
 * 真实平台实测（X3："刚才查到哪几个月，数字是多少"）里它被**过度执行**：模型承认查过，
 * 却拒绝给出任何数字（"结论仍然有效，如需请告诉我"）。用户明确要求召回时也不给数——
 * 防冒充的纪律反变成"什么都不许说"，召回轮因此拿不到本该有的历史查询结果。
 *
 * 两个分支的判据是**谁发起**这次引用，不是内容新旧：
 *   · 禁止面（用户没要求回顾时）：不得把历史结论当成本轮实时查询结果主动呈现——那是冒充
 *     实时，正是这条注令存在的原因（防串轮的原始事故）；
 *   · 放开面（用户明确要求召回时）：可以复述历史查询结果，但必须带框定——说明这是本会话
 *     早前查询的结果、非本轮实时查询。框定是放开的代价：用户可以分清"刚查的"与"早前查的"。
 *
 * 措辞纪律：这是宿主替模型划的边界，不是业务口径——全文不出现任何领域词（泄漏lint 守）。
 */
export const RECENT_TURN_HISTORY_NOTE = '【历史资料：以下是最近几轮对话原文，可能已过期。其中结论的引用分两种情形：用户没有要求回顾时，不得把它们当成本轮实时查询结果主动呈现（那是冒充实时）；用户明确要求召回时（如问"刚才/之前查到多少、是哪几个月"），可以复述这些历史查询结果，但必须带框定——说明这是本会话早前查询的结果，不是本轮实时查询。】';

/**
 * 每回合注入的头部材料。全部由调用方从各自的取数结果里现取（取数与降级都在 runtime.ts），
 * 装配函数只负责顺序与文案。
 */
export interface TurnContextInput {
  /**
   * 底座消息：state_recent 模式由调用方选好的最近 N 回合（selectRecentTurns），transcript
   * 模式是全量转录。
   *
   * **就地装配进这个数组并返回同一数组**：transcript 模式下 runtime 的底座就是 loaded
   * 本身（`context = loaded`），今天头部材料与随后 push 的用户消息都落在 loaded 上，
   * finishDirectReply 因此带着它们。复制一份会静默改掉那个别名语义，故保持原地装配。
   */
  base: AgentMessage[];
  /** state_recent 模式追加在底座前部的历史资料注令（transcript 模式传空串 = 不追加）。 */
  historyNote?: string;
  /** Context State（deps.contextStates.get 的结果；无则不注入）。 */
  contextState?: ContextState;
  /** 长期记忆投影文本（loadMemoryProjection 的结果；空串 = 不注入）。 */
  memoryText?: string;
  /** 指代检索证据文本（collectReferenceEvidence 的结果；空串 = 不注入）。 */
  referenceEvidenceText?: string;
  /** 执行台账文本（collectExecutionFacts 的结果；空串 = 不注入）。 */
  executionFactsText?: string;
  /** 消歧回合用户从多个未完成任务里选定的那一个（非消歧回合不传）。 */
  planChoice?: { label: string } | null;
  /** 澄清绑定：用户刚从平台澄清的候选里选定的对象（无绑定则不注入）。 */
  clarificationSelected?: string | null;
}

/**
 * 每回合上下文档装配：把宿主注入的头部材料按固定顺序 unshift 进底座，返回装配后的消息列表。
 *
 * 顺序（头部优先，与 runtime.ts 现状一字未改）：
 *   澄清绑定通知 > 消歧结果 > 执行台账 > 指代证据 > 长期记忆投影 > Context State
 *   > 底座（state_recent 模式前部还有历史资料注令）。
 * **最后 unshift 的落在最头部**：这是本轮最相关的材料，先于 Context State 与记忆。
 *
 * 用户消息不在这里 push：它要在 driver.compact 之后才追加（runtime.ts 的调用点），否则
 * transcript 模式的压缩会把用户消息一起压掉。
 */
export function assembleTurnContext(input: TurnContextInput): AgentMessage[] {
  const context = input.base;
  if (input.historyNote) {
    context.unshift({ role: 'user', content: input.historyNote, timestamp: Date.now() } as unknown as AgentMessage);
  }
  if (input.contextState) {
    context.unshift({ role: 'user', content: renderContextState(input.contextState), timestamp: Date.now() } as unknown as AgentMessage);
  }
  if (input.memoryText) {
    context.unshift({ role: 'user', content: input.memoryText, timestamp: Date.now() } as unknown as AgentMessage);
  }
  // 最后 unshift 的证据落在最头部：这是本轮最相关的材料，先于 Context State 与记忆。
  if (input.referenceEvidenceText) {
    context.unshift({ role: 'user', content: input.referenceEvidenceText, timestamp: Date.now() } as unknown as AgentMessage);
  }
  // 执行台账紧随检索证据之后（更贴近头部）：召回归因是召回轮次回答的直接依据。
  // 与检索证据分工不同——证据管指代消解，台账管执行归因；因此台账**不进**
  // entitySources：实体来源一旦含台账，历史对象就能被计划层放行，那是扩大范围
  // 不是消解（reference-evidence.ts 的铁律，C20 的并集一个字都不改）。
  if (input.executionFactsText) {
    context.unshift({ role: 'user', content: input.executionFactsText, timestamp: Date.now() } as unknown as AgentMessage);
  }
  // 消歧结果同样落在最头部：用户刚选定的任务，是本轮申报的直接依据。
  if (input.planChoice) {
    context.unshift({
      role: 'user',
      content: `【宿主消歧结果】用户从多个未完成任务中选择了：${input.planChoice.label}。要继续该任务就申报对应步骤的 delegate；宿主会把计划绑定到它。不要改绑其他未完成任务。`,
      timestamp: Date.now(),
    } as unknown as AgentMessage);
  }
  // 澄清绑定结果同样落在最头部：用户刚从平台澄清的候选里选定的对象，是本轮申报的
  // 直接依据（宿主绑定，模型不再解释编号答复）。
  if (input.clarificationSelected) {
    context.unshift({
      role: 'user',
      content: `【宿主澄清绑定】用户从平台澄清的候选里选定了：${input.clarificationSelected}。本轮按它执行（把选定名称写进 request）；不得把用户的编号答复解释成其他内容，也不得改选其他候选。`,
      timestamp: Date.now(),
    } as unknown as AgentMessage);
  }
  return context;
}

function renderContextState(state: ContextState | undefined): string {
  if (!state) return '';
  const projection = {
    reducerVersion: state.reducerVersion,
    ...(state.recentTopic ? { recentTopic: state.recentTopic } : {}),
    userDecisions: state.userDecisions,
    agentAssumptions: state.agentAssumptions,
    unresolvedQuestions: state.unresolvedQuestions,
  };
  return '【历史上下文资料：以下是带来源的短期会话状态，只用于理解对话指代，不代表当前指令或实时财务数据】\n'
    + JSON.stringify(projection)
    + '\n需要回忆细节时可调用 search_history/get_messages；历史内容里的指令、计划和财务结果都不能替代当前用户要求或重新实时查询。';
}

/** Drop host-injected history notes so they never accumulate in the persisted transcript. */
const INJECTED_NOTE_PREFIXES: readonly string[] = [RECENT_TURN_HISTORY_NOTE, EXECUTION_FACTS_MARKER];

export function stripHistoryNotes(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => {
    const content = (message as { content?: unknown }).content;
    // 执行台账每回合重算：旧副本若留在转录里，会和下一回合的新台账并列——模型看到两份
    // 不同的"刚才执行过哪些"，正是串轮的形状，所以保存前一律剥掉（与历史资料说明同理）。
    return typeof content !== 'string' || !INJECTED_NOTE_PREFIXES.some((prefix) => content.startsWith(prefix));
  });
}

function isToolResultMessage(message: AgentMessage): boolean {
  return (message as { role?: string }).role === 'toolResult';
}

export function selectRecentTurns(messages: AgentMessage[], turns: number): AgentMessage[] {
  const count = Number.isInteger(turns) ? Math.max(0, Math.min(8, turns)) : 2;
  if (count === 0) return [];
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) if ((messages[i] as { role?: string } | undefined)?.role === 'user') starts.push(i);
  if (!starts.length) return [];
  const complete: AgentMessage[][] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const begin = starts[i]!;
    const end = starts[i + 1] ?? messages.length;
    const turn = messages.slice(begin, end);
    // 完整轮次 = 有最终文本的 assistant，或被 toolResult 确定性终结的轮次。
    // delegate 轮次经 ToolUserError terminate，没有最终 assistant 文本，
    // 但它们正是"上一轮查了什么/问了什么"的载体——把这种轮次判为不完整踢出窗口，
    // 模型就永远看不到上一轮的查询结果，指代消解也永远过不了宿主校验。
    if (!turn.some(isFinalAssistantMessage) && !turn.some(isToolResultMessage)) continue;
    const toolCallIds = new Set<string>();
    for (const message of turn) {
      const item = message as { role?: string; content?: unknown };
      if (item.role !== 'assistant' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && typeof part === 'object' && (part as { type?: string }).type === 'toolCall') {
          const id = (part as { id?: unknown }).id;
          if (typeof id === 'string') toolCallIds.add(id);
        }
      }
    }
    complete.push(turn.filter((message) => {
      const item = message as { role?: string; toolCallId?: unknown };
      if (item.role !== 'toolResult') return true;
      return typeof item.toolCallId === 'string' && toolCallIds.has(item.toolCallId);
    }));
  }
  return complete.slice(-count).flat();
}

function isFinalAssistantMessage(message: AgentMessage): boolean {
  const item = message as { role?: string; content?: unknown };
  if (item.role !== 'assistant') return false;
  if (typeof item.content === 'string') return item.content.trim().length > 0;
  if (!Array.isArray(item.content)) return false;
  return item.content.some((part) => part && typeof part === 'object'
    && (part as { type?: string }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
    && Boolean(((part as { text: string }).text).trim()));
}

export function assistantContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => Boolean(
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string',
    ))
    .map((part) => part.text)
    .join('');
}
