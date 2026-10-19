/** Main Pi Agent runtime with one narrow delegation tool for the 17dz subagent. */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentReply, ContextStateRepo, ConversationLogRepo, ConversationSessionRepo, MemoryRecordRepo, PlatformTaskRepo, TaskPlanRepo, TaskPlanSummary, TrustedContext } from '@fshine/contracts';
import { loadTranscript, saveTranscript } from './session';
import { ToolUserError, addUsageTotals, sumUsage, usageFieldsOf, usageSpanFields, type TurnDriver, type TurnDriverResult, type UsageTotals } from './driver';
import { RUN_17DZ_TASK_TOOL, DELEGATION_TIMEOUT_FAILURE, type ContextTaskRunner, type SubagentTaskResult } from './context';
import type { ContextState } from './context-state';
import { createHistoryTools } from './history-tools';
import type { CandidateExtractor } from './memory-consolidator';
import { ROUTE_CURRENT_TURN_TOOL, ROUTE_CURRENT_TURN_TOOL_NAME, reviewRouteDeclaration, type PlanEntitySources, type TurnDeclaration } from './turn-contract';
import { collectReferenceEvidence, looksLikeReferenceCue, type ReferenceEvidence } from './reference-evidence';
import { collectExecutionFacts, type ExecutionFacts } from './execution-facts';
import { collectSessionEntities, mergeSessionEntities } from './session-entities';
import { matchClarificationBinding } from './clarification-events';
import type { OperationArgsSpecs } from './operation-labels';
import { parsePlanStep, type PlanStepLabel } from './plan-steps';
import { createPlanFactWriter, planStepSummary, renderPlanCircuitBreak, renderPlanStepOutcomeLines } from './plan-facts';
import { matchPlanDisambiguationReply, renderDisambiguationQuestion, resolvePlanBinding } from './plan-binding';
import { renderClarificationToolResult, renderNeedsToolResult, renderNeedsUserText, renderPlanStepToolResult, renderWriteClosureReply } from './turn-relay';
import { decideTurnExit, type TurnExitEvent } from './turn-exit';
import { accumulateDelegation, createTurnState, noteNeedsRound, notePlanStepOutcome, noteZeroExecStep, stepOutcomeOf } from './turn-state';
import { assembleTurnContext, assistantContentText, RECENT_TURN_HISTORY_NOTE, selectRecentTurns, stripHistoryNotes } from './turn-context';
import {
  appendClarificationIssued,
  appendClarificationResolved,
  appendUserEvent,
  ensureHistoryBackfill,
  extract17dzToolResultEvents,
  isContextState,
  loadMemoryProjection,
  persistAssistantAndContext,
  redactInternalIds,
  redactSensitiveText,
  scheduleMemoryConsolidation,
} from './turn-persistence';
import { stripFootprint } from './text-hygiene';
import { loadTimedOutRecord, renderResourceExhaustedReply, RESOURCE_EXHAUSTED_CLASS } from './resource-exhausted';
import { PLATFORM_OPERATIONS, type SelectionClarification } from './platform-contract';
import { clarificationTextFor, messageTextFor } from './error-codes';
import {
  createPlatformHealthTracker,
  isAuthDelegationFailure,
  type PlatformHealthClock,
  type PlatformHealthTracker,
} from './platform-health';

const DEFAULT_SESSION_TTL_MS = 86_400_000;
const DEFAULT_TURN_BUDGET_MS = 150_000;

// 收尾/兜底话术全部收口在 error-codes.ts（消息模板类：码 → 文本一一对应）；
// 这里的常量是同一份表值的再导出，测试与调用方继续认常量。
export const FALLBACK_TIMEOUT = messageTextFor('FALLBACK_TIMEOUT');
export const FALLBACK_FAILURE = messageTextFor('FALLBACK_FAILURE');

/** Fail-closed reply whenever a turn claims real-time data but produced no platform execution. */
export const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');

/**
 * 方案已获批准但查询没有执行时的确定性收尾文案（P1 收尾事实兜底）。
 * 与 NO_EXECUTION_CLARIFICATION 的区别是事实本身：用户早就给过查询对象和范围，缺的是
 * 执行不是 specification——再让用户"补充范围"就是误导。因此这里只说真实状态
 * （批准了、通知送到了、查询没跑），并给出明确的下一步（回复"继续"按已批准计划重跑）。
 * 措辞与业务无关（不出现任何领域词），重启执行的动作由用户一句话触发。
 */
export const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');

/**
 * 恢复路径（resumeTaskId）重跑后零执行的收尾文案（③-5b）。
 * 与 ACTIVATED_PLAN_NOT_EXECUTED 的分工：后者有"方案已获批准、通知已送达"这个事实
 * （activatedPlan 为真）；前者覆盖其余零执行形状——用户刚确认过操作，缺的是执行，
 * 不能再问"要查询的对象和范围"（那是 NO_EXECUTION_CLARIFICATION 的问句，早就答过）。
 */
export const RESUMED_PLAN_NOT_EXECUTED = messageTextFor('RESUMED_PLAN_NOT_EXECUTED');

/** Appended when the Main Agent answers without declaring the turn's intent. */
const ROUTE_RETRY_NUDGE = messageTextFor('ROUTE_RETRY_NUDGE');

/**
 * 执行语言指纹：最终回复里出现任意一条，就说明"模型在翻译执行语言"（2026-09-27 Stage 3 实测：一次
 * 结构化歧义被翻译成 1201 字符技术报告）。判据都是**形状**，不是内容嗅探：
 *   · 脚本路径（`src/...js`）：平台实现细节，编排层禁运（泄漏 lint 同款名单）；
 *   · 错误码形态（下划线连接的多段码：全大写 ACCOUNT_SET_AMBIGUOUS / 全小写 not_found）：
 *     含下划线是防误伤——正常英文词不会全大写，YYYYMM 这类编码没有下划线；小写支只收纯字母段
 *     （平台状态词），含数字/连字符的串（task_3f9a1c72-…）是 id 家族，归泄漏基线守（D-098）；
 *   · JSON 片段（`candidates:` 或花括号）：信封/方案原文复读；
 *   · operation 名（小写点分，如 finance.query-receivables）：第三波实测——回复里"数据来源：
 *     平台只读查询接口 finance.query-receivables"，用户不需要知道接口标识符（语域契约①）；
 *   · 内部控制词（额度/配额/熔断/计划门/拒绝上限/重试上限）：同波实测——"本次已用满
 *     平台的查询计划额度"被当成说明交给用户，那是宿主计划门的内部控制状态（语域契约②）。
 *
 * operation 名的防误伤（误伤比漏报更糟——探针误红一次，整条断言就没人信了）：
 * 形状要求"小写字母开头 + 至少一个点 + 点后小写连字符段"三条同时成立——
 *   · "e.g."/"i.e." 没有连字符段；"v1.2"/"no.1" 点后是数字；YYYYMM（202609）没有点，
 *     日期/时间（2026.09、14.30）以数字开头；
 *   · 中文名不以小写字母开头（"幻辰.财税"直接不匹配）、点后中文段也不是 [a-z]；
 *   · 连字符段必须在**点之后**（lookahead 逐段判定）："query-receivables.js" 连字符在点前，
 *     不命中本模式（归脚本路径模式与泄漏 lint 的 .js 名单各自守）。
 * 白名单是逃生阀：形状命中但经人工判定不是执行语言的 token 才能进，每条附理由；当前为空——已知误伤家族全部被形状要求挡在门外。
 * 第二判据（下表）兼收平台注册名本身：形状只认带命名空间前缀的写法，实测回复漏的是**裸名**"先用 search-account-sets 搜出平台规范名再查"（D-098）。
 *
 * 内部控制词为什么是内部控制（不是业务词）：额度/配额是宿主计划门的限额记账，
 * 熔断/计划门是执行流的控制机制，拒绝上限（MAX_DECLINED_PLANS_PER_TASK）/重试上限
 * 是收敛保护参数——它们描述的是"宿主怎么管模型"，没有一个是用户做决策需要的事实。
 * 用户可行动的版本是"本次查询未能继续 + 请重新发起"（语域契约②），机制一词不提。
 *
 * 这把尺有两处使用者：worker 说明的准入（usefulWorkerNote：带指纹的"说明"是协议材料，不附在状态
 * 文案后面）与真实模型探针的断言（probe-real-agent.ts 对歧义/not_found 用例）。导出一处定义，
 * 两边认同一份。
 */
/**
 * operation 名指纹的白名单（逃生阀，不是预设备份）：形状命中但确认真实回复里会出现、且不是执行
 * 语言的 token 才能进，每条注释为什么合法；当前为空（已知误伤家族全被形状挡掉，见上）。声明须
 * 早于指纹表：表里 operation 名那一项挂的是它本身（同一处定义，不复制）。
 */
const OPERATION_NAME_WHITELIST: ReadonlySet<string> = new Set<string>();
/** 平台注册名的判据源（含裸尾段，见上方"第二判据"）：单一来源 PLATFORM_OPERATIONS——宿主本来就持这张表（L2），不另立第二份名单；\b 边界防半个 token 命中。 */
const REGISTERED_OPERATION_ALTERNATION = Object.values(PLATFORM_OPERATIONS).flatMap((n) => [...new Set([n, n.slice(n.indexOf('.') + 1)])]).map((t) => String.raw`\b${t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\b`).join('|');

export const EXECUTION_LANGUAGE_FINGERPRINTS: ReadonlyArray<{ label: string; pattern: RegExp; whitelist?: ReadonlySet<string> }> = [
  { label: '脚本路径', pattern: /src\/[^\s）)，,，；;]*\.js/ },
  { label: '错误码', pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/ },
  { label: 'JSON 片段', pattern: /candidates\s*:|[{}]/ },
  {
    label: 'operation 名',
    // lookahead 先验"点后存在小写连字符段"，本体再匹配"小写字母开头的点分 token"；再 ∪ 平台
    // 注册名（含裸尾段，REGISTERED_OPERATION_ALTERNATION 派生，单一来源见上方第二判据）。
    pattern: new RegExp([String.raw`\b(?=(?:[a-z0-9-]*\.)+[a-z0-9-]*-)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b`, REGISTERED_OPERATION_ALTERNATION].join('|')),
    whitelist: OPERATION_NAME_WHITELIST,
  },
  { label: '内部控制词', pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/ },
];

/**
 * 文本命中的执行语言指纹标签（空数组 = 干净）。
 *
 * 白名单只作用于挂了它的那类形状（当前=operation 名），且是 **token 级**排除：一段话
 * 同时混着白名单 token 和真 operation 名时，后者照旧命中——逃生阀掩掉的是单个 token，
 * 不是整段文本。用可选字段而不是标签名比较做分流：标签是给用户读的文案，不该承担
 * 结构化判据的职责（也不该为它立一条中文字面量 if）。
 */
export function executionLanguageFingerprints(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern, whitelist } of EXECUTION_LANGUAGE_FINGERPRINTS) {
    if (!whitelist) {
      if (pattern.test(text)) hits.push(label);
      continue;
    }
    const tokens = text.match(new RegExp(pattern.source, 'g')) ?? [];
    if (tokens.some((token) => !whitelist.has(token))) hits.push(label);
  }
  return hits;
}

/**
 * 纠错环单回合上限（架构 §3）与计划模式熔断阈值随 TurnState 的记账规则一起住在
 * turn-state.ts（MAX_NEEDS_ROUNDS / MAX_PLAN_ZERO_EXEC_STEPS）。
 */

/** 纠错环工具结果的序列化前缀：模型把它原样当回复时，宿主用自己的转达文本顶上。 */
const NEEDS_TOOL_RESULT_PREFIX = '{"recorded":"delegate"';

/**
 * 内部协议材料的复读判据（D-020 / F4 残留；D-069 补平台 RESULT 信封形态）：模型把工具
 * 结果原样当回复时，那段文本是宿主与模型之间的内部协议材料——纠错环交还
 * （`{"recorded":"delegate",…}`）、计划步骤交还（同族，recorded/step/next 是协议字段）、
 * 回合申报回执（`{"recorded":"conversation"}`）、平台 RESULT 信封（`{"v":1,"op":…}`）。
 *
 * 为什么信封复读与协议 JSON 复读同族：信封是宿主与**平台**之间的输出契约
 * （platform-contract.ts 的 PlatformEnvelope，字段形状以那里的信封解析为准），和宿主与
 * 模型之间的协议 JSON 一样都是机器传递的结构化材料，不是给用户读的话；原样外发等于把
 * operation 名、status、错误码等执行层语言怼到用户眼前——与执行语言指纹尺防的是同一族
 * 泄漏，只是那道尺不在终稿硬闸上（见债务台账 D-069）。前缀按信封的固定形状写死
 * （v:1 + op 首字段），形状之外的内容不嗅探。
 *
 * 判据只有**形状**（开头是协议 JSON 且首字段是协议字段名），不嗅探内容：正常回复不可
 * 能以这几个字段开头，误判面为零。导出供测试直接钉形状。
 */
export function looksLikeProtocolMaterial(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(NEEDS_TOOL_RESULT_PREFIX)
    || /^\{\s*"(?:recorded|step|next)"\s*:/.test(trimmed)
    || /^\{\s*"v"\s*:\s*1\s*,\s*"op"\s*:/.test(trimmed);
}

/**
 * 业务 skill 注入系统提示词时的小标题（架构 §5）。只说明这份材料的性质与边界，
 * 不含任何规则本身——规则在部署方提供的文件里。
 */
const BUSINESS_SKILL_HEADING = '【业务编排知识：程序性知识，只用于长任务拆解与信息补齐；"怎么做才对"归执行层，不由这里规定】';

export interface TaxAgentRuntimeDeps {
  driver: TurnDriver;
  sessions: Pick<ConversationSessionRepo, 'get' | 'upsert'>;
  platformTask: ContextTaskRunner;
  /** 平台任务条目的结构化执行事实源（D-065：召回事实台账的列举入口，消费者=execution-facts）。 */
  platformTasks?: Pick<PlatformTaskRepo, 'listBySession'>;
  /**
   * 平台 args 规格（`operation list --json` 派生，assembly 注入；测试替身可直接传表）。
   *
   * 会话实体（任务 1 实体门禁第四来源的来源 A）的查表依据：按规格声明机械提取"执行过的
   * 任务"的实体承载参数取值，零硬编码参数名。缺省 = 规格拿不到 → 不提取得会话实体
   * （安全缺省，与 label/argStyles 派生同一纪律：没有规格就不提取）。
   */
  operationArgSpecs?: OperationArgsSpecs;
  /** Durable, append-only raw conversation log; separate from compactable Pi transcript. */
  conversationLog?: Pick<ConversationLogRepo, 'append' | 'search' | 'list'>;
  contextStates?: Pick<ContextStateRepo, 'get' | 'upsert'>;
  memoryRecords?: Pick<MemoryRecordRepo, 'listByPrincipal' | 'getCursor' | 'commit'>;
  memoryCandidateExtractor?: CandidateExtractor;
  memoryBatchSize?: number;
  /** Separate, isolated model driver for semantic Context State extraction. */
  contextModelDriver?: TurnDriver;
  /** state_recent keeps only a few complete recent turns plus the durable Context State; transcript preserves migration behavior. */
  contextMode?: 'state_recent' | 'transcript';
  recentTurns?: number;
  sessionTtlMs?: number;
  turnBudgetMs?: number;
  /**
   * 任务计划状态存储（roadmap Phase 6，架构 §2 第 6 条）：append-only 事实 + 可重建投影。
   * 可选——缺省 = 不落计划状态，长任务拆解本身照常工作，只是没有可查的进度投影。
   */
  taskPlans?: TaskPlanRepo;
  /**
   * 编排层业务 skill 的静态程序性知识（架构 §5）：由部署层启动时读文件注入，
   * 每回合追加进系统提示词（与日期行同性质）。缺省 = 不注入，不影响其他能力。
   */
  businessSkill?: string;
  /**
   * 平台健康信号的时钟注入（Lane 2）：冷却判定只认 now()，测试推时钟即可验证
   * "冷却中 / 已到期"，不需要真等 10 分钟。缺省 Date.now()（与 context-model 的
   * clock 注入同族）。
   */
  clock?: PlatformHealthClock;
  /** 连续 AUTH 类平台失败达此数 → 会话进入冷却（缺省 2，特例/测试经此覆盖）。 */
  platformAuthFailureThreshold?: number;
  /** 平台健康冷却时长（缺省 10 分钟；部署侧经 assembly 的 FSHINE_PLATFORM_COOLDOWN_MS 覆盖）。 */
  platformCooldownMs?: number;
}

export function createTaxAgentRuntime(deps: TaxAgentRuntimeDeps): import('@fshine/contracts').AgentRuntime {
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const turnBudgetMs = deps.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS;
  const contextMode = deps.contextMode ?? 'state_recent';
  const recentTurns = deps.recentTurns ?? 2;
  const contextUpdateQueues = new Map<string, Promise<void>>();
  const memoryUpdateQueues = new Map<string, Promise<void>>();
  const initializedContextSessions = new Set<string>();
  // 业务 skill（架构 §5）：静态程序性知识，每回合进系统提示词；与日期行同性质，
  // 缺文件/缺配置时为空，其余能力不受影响。
  const businessSkill = typeof deps.businessSkill === 'string' ? deps.businessSkill.trim() : '';
  // 日期尾注放组装后提示词的最尾部（理由见 DATE_SUFFIX 注释）：前缀 = 稳定 SYSTEM_PROMPT
  // + 稳定 skill 文本，跨天只有尾注一行未命中。
  const systemPrompt = `${businessSkill ? `${SYSTEM_PROMPT}\n\n${BUSINESS_SKILL_HEADING}\n${businessSkill}` : SYSTEM_PROMPT}\n\n${DATE_SUFFIX}`;
  // 平台健康信号（Lane 2 治标补法）：会话级连续 AUTH 类平台失败记账 + 冷却。判据与
  // 边界见 platform-health.ts——治"平台根本不可用时的逐轮重试式重查"，与回合内的
  // MAX_* 熔断、平台侧限流、并发闸正交。时钟可注入（测试可推），阈值/时长可配置。
  const platformHealth: PlatformHealthTracker = createPlatformHealthTracker({
    ...(deps.platformAuthFailureThreshold !== undefined ? { threshold: deps.platformAuthFailureThreshold } : {}),
    ...(deps.platformCooldownMs !== undefined ? { cooldownMs: deps.platformCooldownMs } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  // 计划步骤事实的写入器：工厂只在 runtime 装配时建一次，factId 的序号计数器因此是
  // **每 runtime 实例**递增（不是每回合）——同一计划同一步同一状态在两个回合各追加一次
  // 也必须拿到不同 factId，否则撞存储 UNIQUE（append 失败只记日志不阻塞回合，步骤事实
  // 会静默丢失）。principalId / sessionId / requestId 每回合都不同，由调用点从 ctx 现取。
  const appendPlanFact = createPlanFactWriter({ taskPlans: deps.taskPlans });
  return {
    async handleTurn(ctx: TrustedContext, userMessage: string): Promise<AgentReply> {
      // 确认码/取消码由服务端直接匹配并执行（绕过模型）——「确认必须被代码匹配，
      // 而不是被模型理解」。未命中则按正常回合进入模型。
      const turnStart = Date.now();
      // 平台健康信号的会话键（Lane 2）：与 Context State 同一把复合键——同一用户在同一
      // 会话里的连续失败才累计；换会话（新对话）从零开始，不把别的会话的健康状态带过来。
      const platformHealthKey = `${ctx.principalId}\0${ctx.sessionId}`;
      const { messages: loaded, expired } = await loadTranscript(deps.sessions, ctx.sessionId, sessionTtlMs);
      let effectiveContextMode = contextMode;
      const contextSessionKey = `${ctx.principalId}\0${ctx.sessionId}`;
      if (deps.conversationLog && !initializedContextSessions.has(contextSessionKey)) {
        if (!(await ensureHistoryBackfill(deps, ctx, loaded))) effectiveContextMode = 'transcript';
        else initializedContextSessions.add(contextSessionKey);
      }
      await appendUserEvent(deps, ctx, userMessage);
      if (typeof deps.platformTask.matchConfirmation === 'function') {
        const direct = await deps.platformTask.matchConfirmation(ctx, userMessage);
        if (direct) {
          const now = Date.now();
          await saveTranscript(deps.sessions, {
            sessionId: ctx.sessionId,
            principalId: ctx.principalId,
            messages: [
              ...loaded,
              { role: 'user', content: userMessage, timestamp: now } as unknown as AgentMessage,
              // 必须是原生形状(含 api/usage/stopReason):裸字符串消息会让下一模型回合内部报错
              deps.driver.synthesizeAssistant
                ? deps.driver.synthesizeAssistant(direct.text)
                : ({ role: 'assistant', content: direct.text, timestamp: now + 1 } as unknown as AgentMessage),
            ],
          });
          await persistAssistantAndContext(deps, ctx, direct.text, contextUpdateQueues);
          scheduleMemoryConsolidation(deps, ctx, userMessage, memoryUpdateQueues);
          // turn_span 的 outcome 从 matchConfirmation 的结构化结局取（2026-09 第二波）：
          // 不再嗅探自己刚生成的回复文本（includes('已作废') 会把"取消已作废的码"
          // 误记成 confirm_cancelled——那一轮什么都没发生）。
          console.info(JSON.stringify({ event: 'turn_span', requestId: ctx.requestId, durationMs: Date.now() - turnStart, outcome: direct.outcome }));
          return direct;
        }
      }
      if (ctx.resumeTaskId) {
        // 平台健康冷却（Lane 2）：冷却期内不发起平台调用——恢复路径同样是真实委派
        // （一次浏览器自动化 + 限流 token），结论早已确定，重试只是浪费。终稿由宿主
        // 合成（PLATFORM_UNAVAILABLE，error-codes.ts 唯一措辞来源），用户等待为零。
        if (platformHealth.isCoolingDown(platformHealthKey)) {
          console.info(JSON.stringify({
            event: 'platform_cooldown_blocked',
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            stage: 'resume',
            cooldownRemainingMs: platformHealth.cooldownRemainingMs(platformHealthKey),
          }));
          return await finishDirectReply(platformHealth.cooldownReply(platformHealthKey), 'platform_cooldown_blocked');
        }
        // ③-1：恢复路径与 delegate 路径同样收尾。此前 platformTask.run 抛出的
        // ToolUserError（如 DELEGATION_AUTH_FAILURE"平台登录态过期，需要重新登录后
        // 才能继续查询"）会一路穿透到 handler.ts 顶层 catch，被换成"处理失败，请稍后
        // 再试"——对 auth 类是错指令（重试多少次都没用），用户拿到的是误导。
        // ToolUserError 的语义本就是"这段文本成为本轮回复"（driver.ts 契约），这里
        // 经 finishDirectReply 精确直达；非 ToolUserError 是真正的意外，维持既有兜底
        // （继续上抛给 handler 顶层）。
        let resumed: SubagentTaskResult;
        try {
          resumed = await deps.platformTask.run({
            request: '宿主已收到用户对待确认计划的真实确认。请继续执行已激活计划中的剩余查询，不要扩大计划范围。',
            taskId: ctx.resumeTaskId,
          }, { trusted: ctx });
        } catch (error) {
          if (error instanceof ToolUserError) {
            // 码来自 error-codes.ts 的 toolUserErrorFor 挂载（context.ts 各拒绝点）；
            // 没有挂码时只记事件与 taskId，不猜。
            const code = (error as { code?: unknown }).code;
            console.warn(JSON.stringify({
              event: 'confirmed_plan_resume_failed',
              requestId: ctx.requestId,
              taskId: ctx.resumeTaskId,
              ...(typeof code === 'string' ? { code } : {}),
            }));
            // 平台健康信号（Lane 2）：auth 类失败进会话级记账（码级判据，见
            // platform-health 的 isAuthDelegationFailure）；达阈值即进入冷却，后续
            // 回合不再逐轮重试式重查。
            if (isAuthDelegationFailure(error)) {
              const snapshot = platformHealth.recordAuthFailure(platformHealthKey);
              console.info(JSON.stringify({
                event: 'platform_auth_failure',
                requestId: ctx.requestId,
                sessionId: ctx.sessionId,
                stage: 'resume',
                consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
                cooldownEntered: snapshot.coolingDown,
              }));
            }
            // 资源耗尽终稿（"失败必达"路径 1，恢复路径同一义务）：确认后重跑撞超时，
            // 同样以执行事实合成的终稿替代"请稍后重试"（taskId 精确在手上，断点更真）。
            if (error.message === DELEGATION_TIMEOUT_FAILURE) {
              const timedOut = await loadTimedOutRecord(deps.platformTasks, ctx.principalId, ctx.sessionId, ctx.resumeTaskId, ctx.requestId);
              console.info(JSON.stringify({
                event: 'resource_exhausted_reply',
                requestId: ctx.requestId,
                stage: 'resume',
                failureClass: RESOURCE_EXHAUSTED_CLASS,
                ...(timedOut ? { taskId: timedOut.taskId } : {}),
              }));
              return await finishDirectReply(renderResourceExhaustedReply({ record: timedOut }), 'resource_exhausted');
            }
            return await finishDirectReply(error.message, 'confirmed_plan_resume_failed');
          }
          throw error;
        }
        // 平台健康信号（Lane 2）：重跑成功且有平台执行痕迹 = 平台健康已恢复，计数清零
        // （"成功则清零"）；AUTH 收尾的重跑同样计数。零执行/其他形状不猜，计数原样。
        if (resumed.authFailure) {
          const snapshot = platformHealth.recordAuthFailure(platformHealthKey);
          console.info(JSON.stringify({
            event: 'platform_auth_failure',
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            stage: 'resume',
            code: resumed.authFailure.code,
            consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
            cooldownEntered: snapshot.coolingDown,
          }));
        } else if (resumed.execution) {
          platformHealth.recordResolved(platformHealthKey);
        }
        // 恢复路径的执行痕迹判据与正常 delegate 路径同一把尺（F8）：用户确认码 →
        // 计划激活 → worker 重跑之后仍是零平台调用时，不得无条件放行。needs /
        // pendingPlan 是另外两种合法终局（缺信息可续 / 又停在确认门），照旧放行。
        const resumedBlocked = !resumed.execution && !resumed.needs && !resumed.pendingPlan;
        // 宿主事实行进整理模型的输入：它因此不能说"已完成"，转录里也不会留下一句
        // 与真实状态相反的总结（后续回合与 Context State 都读这份转录）。
        const hostFact = resumedBlocked
          ? '【宿主事实：本次确认后没有产生任何平台执行。不得宣称已完成或已查到，只能如实说明没有执行，并邀请用户回复“继续”重跑或直接告诉要调整的范围。】\n'
          : '';
        const base = effectiveContextMode === 'transcript' ? loaded : selectRecentTurns(loaded, recentTurns);
        const messages = [
          ...base,
          { role: 'user', content: userMessage, timestamp: Date.now() } as unknown as AgentMessage,
          { role: 'user', content: `${hostFact}【宿主已执行计划的结果；仅作为本轮答复依据】\n${resumed.text}`, timestamp: Date.now() + 1 } as unknown as AgentMessage,
        ];
        const deadline = Date.now() + Math.min(turnBudgetMs, 60_000);
        const answer = await deps.driver.run({
          systemPrompt: `${SYSTEM_PROMPT}\n\n${resumedBlocked
            ? '本轮 17dz 子任务按用户确认重跑后没有产生任何平台执行。'
            : '本轮 17dz 子任务已由宿主根据用户确认的计划执行完毕。'}只能依据附带的宿主执行结果回答，不得请求新工具或扩大查询范围。\n\n${DATE_SUFFIX}`,
          tools: [],
          messages,
          onStep: ctx.onStep ?? (() => {}),
          exec: async () => { throw new ToolUserError('本轮只负责整理已完成的计划结果。'); },
          deadline,
        });
        // Main 编排模型本回合的真实 token 消耗（纯加法遥测）：对 Main 驱动本回合新增的
        // assistant 消息求和（口径 Main=编排模型本体；context/memory 辅助调用走独立的
        // contextModelDriver，其消耗由 aux_model_usage 单独成账，不混进 Main 的数字）。
        const resumeMainUsage = usageFieldsOf(answer.messages.slice(messages.length));
        // 选择类澄清（任务 1）：确认后重跑撞上结构化歧义/未找到时，回复同样由宿主机械组装
        // ——整理模型的文本是对协议材料的翻译，不上屏也不进转录（与 delegate 路径同一修法）。
        const clarificationReply = resumed.clarification
          ? composeClarificationReply(resumed.clarification, resumed.text)
          : '';
        // 澄清事件（任务 1 来源 B）：宿主发出"选一个"的澄清时落 issued——下一回合的裸编号/
        // 候选名答复才能被宿主机械绑定（selected 进实体来源，实体门放行选过的对象）。
        if (resumed.clarification) await appendClarificationIssued(deps, ctx, resumed.clarification);
        // 零执行收尾：回复由宿主确定性给出（与 delegate 路径的收尾兜底同一族话术），
        // worker 留下的无数字说明按"子 Agent 说明 + 注脚"模式附上。
        const note = usefulWorkerNote(resumed.text);
        const text = clarificationReply || (resumedBlocked
          ? resumed.activatedPlan
            ? (note ? `${ACTIVATED_PLAN_NOT_EXECUTED}\n\n${note}` : ACTIVATED_PLAN_NOT_EXECUTED)
            // ③-5b：非 activatedPlan 的零执行也用 resume 专用话术。用户刚确认过操作，
            // NO_EXECUTION_CLARIFICATION 那句"请告诉我要查询的对象和范围"问的是早就
            // 答过的问题——与 activatedPlan 解耦后，两种零执行形状各自说准自己的事实。
            : (note ? `${RESUMED_PLAN_NOT_EXECUTED}\n\n${note}` : RESUMED_PLAN_NOT_EXECUTED)
          // 正常路径：整理模型的文本优先；它没说话时回落 worker 文本——执行面注脚
          // 是给模型的系统元数据，回落不过滤就会直接上屏并进转录（F5）。
          : (answer.text.trim() || stripFootprint(resumed.text)));
        const latestAssistant = [...answer.messages].reverse().find((message) => (message as { role?: string }).role === 'assistant') as { content?: unknown } | undefined;
        const latestText = assistantContentText(latestAssistant?.content).trim();
        const synthesized = deps.driver.synthesizeAssistant
          ? deps.driver.synthesizeAssistant(text)
          : ({ role: 'assistant', content: text, timestamp: Date.now() } as unknown as AgentMessage);
        // 零执行时整理模型的文本既不上屏也不进转录：它最常见的形状正是把零执行
        // 总结成"已完成"，留在转录里会污染后续回合。用宿主收尾文案整体替换。
        // 澄清回合同理：整理模型那一轮是对协议材料的翻译，整体替换掉。
        const savedMessages = clarificationReply || resumedBlocked
          ? [...messages, synthesized]
          : latestText === text
            ? answer.messages
            : [...answer.messages, synthesized];
        await saveTranscript(deps.sessions, {
          sessionId: ctx.sessionId,
          principalId: ctx.principalId,
          messages: savedMessages,
        });
        await persistAssistantAndContext(deps, ctx, text, contextUpdateQueues, [{
          eventId: `${ctx.requestId}:confirmed_tool_result`, principalId: ctx.principalId, sessionId: ctx.sessionId,
          kind: 'tool_result', content: redactInternalIds(redactSensitiveText(stripFootprint(resumed.text))), createdAt: new Date().toISOString(), requestId: ctx.requestId,
        }]);
        scheduleMemoryConsolidation(deps, ctx, userMessage, memoryUpdateQueues);
        if (resumed.clarification) {
          console.info(JSON.stringify({
            event: 'delegation_clarification',
            requestId: ctx.requestId,
            taskId: ctx.resumeTaskId,
            code: resumed.clarification.code,
            candidates: resumed.clarification.candidates.length,
            stage: 'resume',
          }));
        }
        if (resumedBlocked) {
          console.warn(JSON.stringify({
            event: 'confirmed_plan_not_executed',
            requestId: ctx.requestId,
            taskId: ctx.resumeTaskId,
            ...(resumed.activatedPlan ? { planId: resumed.activatedPlan.planId, version: resumed.activatedPlan.version } : {}),
            ...(note ? { withWorkerNote: true } : {}),
          }));
        }
        console.info(JSON.stringify({ event: 'turn_span', requestId: ctx.requestId, durationMs: Date.now() - turnStart, outcome: resumedBlocked ? 'confirmed_plan_not_executed' : clarificationReply ? 'confirmed_plan_clarification' : 'confirmed_plan_resumed', ...resumeMainUsage }));
        return { text };
      }
      // 多任务消歧（多任务回溯）的编号回复：上一条 assistant 事件是宿主的消歧问题且
      // 本条是纯编号，才算用户选定了任务。宿主只解决"哪个任务"（机械），继续做什么
      // 仍由模型在本回合申报；计划绑定在本回合由宿主强制（preferredPlanId）。
      const planChoice = await matchPlanDisambiguationReply(deps, ctx, userMessage);
      if (planChoice) {
        console.info(JSON.stringify({ event: 'plan_disambiguation_matched', requestId: ctx.requestId, planId: planChoice.planId }));
      }
      // 澄清选择的宿主机械绑定（任务 1 来源 B）：用户的裸编号/候选名答复不再过模型解释
      // （实测：模型把"1"猜成范围编码，查询带着猜错的范围执行）。与上面的多任务消歧
      // **并列不合并**——那个解"继续哪个任务"，这个解"用户选了哪个候选"；绑定成功后
      // selected 进本轮实体来源（实体门放行"用户亲自选过的"实体）。
      let clarificationSelected: string | null = null;
      if (deps.conversationLog) {
        try {
          const events = await deps.conversationLog.list({ principalId: ctx.principalId, sessionId: ctx.sessionId, limit: 20 });
          const binding = matchClarificationBinding(events, userMessage);
          if (binding) {
            clarificationSelected = binding.selected;
            await appendClarificationResolved(deps, ctx, binding);
            console.info(JSON.stringify({
              event: 'clarification_reply_bound',
              requestId: ctx.requestId,
              issuedRequestId: binding.requestId,
              selectedLength: binding.selected.length,
            }));
          }
        } catch (error) {
          // 绑定失败不影响回合：退回"无绑定"，消息按普通回合进模型（与消歧匹配同族降级）
          console.error(JSON.stringify({ event: 'clarification_binding_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
        }
      }
      let previousContextState: ContextState | undefined;
      if (deps.contextStates) {
        try {
          const stored = await deps.contextStates.get(ctx.principalId, ctx.sessionId);
          if (stored?.principalId === ctx.principalId && stored.sessionId === ctx.sessionId && isContextState(stored.state)) {
            previousContextState = stored.state;
          }
        } catch (error) {
          console.error(JSON.stringify({ event: 'context_state_load_failed', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
        }
      }
      // 主动回溯（Phase 2）：申报之前，宿主检测指代线索并从 Conversation Log 检索证据，
      // 注入上下文头部（与 Context State 并列）。铁律在 reference-evidence.ts：证据只支撑
      // 指代消解，不扩大实体范围——本轮范围仍由 validatePlanEntities 逐字校验。
      let referenceEvidence: ReferenceEvidence | null = null;
      if (deps.conversationLog && looksLikeReferenceCue(userMessage)) {
        try {
          referenceEvidence = await collectReferenceEvidence({
            conversationLog: deps.conversationLog,
            principalId: ctx.principalId,
            sessionId: ctx.sessionId,
            userMessage,
          });
          console.info(JSON.stringify({
            event: referenceEvidence ? 'reference_evidence_injected' : 'reference_evidence_empty',
            requestId: ctx.requestId,
            ...(referenceEvidence ? { count: referenceEvidence.count, truncated: referenceEvidence.truncated } : {}),
          }));
        } catch (error) {
          // 检索失败不影响回合：退回"无证据"状态，模型按工具说明的指代口径自行处理。
          console.error(JSON.stringify({ event: 'reference_evidence_failed', requestId: ctx.requestId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
        }
      }
      // 召回事实注入（支柱 C）：与主动回溯共用同一把线索尺——用户消息带召回线索时，宿主把
      // "本会话迄今真实发生过的平台执行"从 platform_tasks 的结构化事实渲染成台账，注入上下文
      // 头部。为什么必须读宿主持有的结构化底账而不是让模型从转录自由回忆：T3r 实测里模型把
      // 两个不同对象/范围的查询混成"刚才两次查询"（归因串轮），转录里"提过"不等于"真的执行过"；
      // 台账只机械陈述，比较与解释仍归模型。取舍与边界见 execution-facts.ts 文件头（D-065）。
      let executionFacts: ExecutionFacts | null = null;
      if (deps.platformTasks && looksLikeReferenceCue(userMessage)) {
        try {
          executionFacts = await collectExecutionFacts({
            platformTasks: deps.platformTasks,
            principalId: ctx.principalId,
            sessionId: ctx.sessionId,
            userMessage,
          });
          console.info(JSON.stringify({
            event: executionFacts ? 'execution_facts_injected' : 'execution_facts_empty',
            requestId: ctx.requestId,
            ...(executionFacts ? { count: executionFacts.count, truncated: executionFacts.truncated } : {}),
          }));
        } catch (error) {
          // 台账渲染失败不影响回合：退回"无台账"状态，模型按现有材料自行处理。
          console.error(JSON.stringify({ event: 'execution_facts_failed', requestId: ctx.requestId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
        }
      }
      // 长期记忆投影：取数与降级住 runtime.ts（I/O），装配只拿文本。
      const memoryText = await loadMemoryProjection(deps, ctx.principalId);
      // 每回合上下文档装配：头部材料的顺序与文案住 turn-context.ts（纯函数）。I/O 不在这里——
      // 指代证据 / 执行台账 / Context State / 长期记忆投影的取数都在上面各自的分支里做完了，
      // 这里只把结果作为参数传进去。
      let context = assembleTurnContext({
        base: effectiveContextMode === 'transcript' ? loaded : selectRecentTurns(loaded, recentTurns),
        // state_recent 模式在底座前部加历史资料注令（保存前由 stripHistoryNotes 剥掉）；
        // transcript 模式用全量转录，不加。
        historyNote: effectiveContextMode === 'transcript' ? '' : RECENT_TURN_HISTORY_NOTE,
        contextState: previousContextState,
        memoryText,
        referenceEvidenceText: referenceEvidence?.text ?? '',
        executionFactsText: executionFacts?.text ?? '',
        ...(planChoice ? { planChoice } : {}),
        clarificationSelected,
      });
      // 压缩异常不得失败回合：宁可带着旧上下文，也不让用户撞上 500（设计承诺）。
      const compactSafe = async (msgs: AgentMessage[], force?: boolean): Promise<AgentMessage[]> => {
        if (!deps.driver.compact) return msgs;
        try {
          return await deps.driver.compact(msgs, force ? { force: true } : undefined);
        } catch (error) {
          console.error(JSON.stringify({ event: 'context_compact_threw', sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
          return msgs;
        }
      };
      if (effectiveContextMode === 'transcript' && expired && loaded.length > 0) {
        console.info(JSON.stringify({ event: 'session_resume_seeding', sessionId: ctx.sessionId, staleMessages: loaded.length }));
        context = await compactSafe(loaded, true);
      }
      if (effectiveContextMode === 'transcript') context = await compactSafe(context);
      context.push({ role: 'user', content: userMessage, timestamp: Date.now() } as unknown as AgentMessage);

      const historyTools = deps.conversationLog
        ? createHistoryTools(deps.conversationLog, { principalId: ctx.principalId, sessionId: ctx.sessionId })
        : [];
      const tools = [
        ROUTE_CURRENT_TURN_TOOL,
        ...historyTools.map((tool) => tool.definition),
      ];
      // 回合契约：Main Agent 必须显式申报本轮动作，宿主留存并校验证据。
      // 状态形状与记账规则住 turn-state.ts（计数器在那里可用纯数据直接验证）；
      // 这里只按消歧回合的选定计划建状态，控制流仍在本函数。
      const turn = createTurnState(planChoice);

      // ── 计划模式（Phase 6）宿主侧记账 ──────────────────────────────────
      // planId 由宿主在计划模式第一步生成（`plan_${requestId}`），同一拆解的所有步共享；
      // 跨回合续跑时经 openPlans 找回。绑定优先级：同回合已定 > continueTaskId 反查
      // （taskId 记在步事实上，比"最近"更真）> 用户消歧选定 > 形状判定（总步数一致且
      // 步号接得上的候选恰一个）。候选多于一个且无其他依据时宿主不猜——把编号选项
      // 抛给用户，由下一回合的编号回复消歧。
      let openPlans: TaskPlanSummary[] = [];
      let openPlansLoaded = false;
      async function loadOpenPlans(): Promise<TaskPlanSummary[]> {
        if (openPlansLoaded) return openPlans;
        openPlansLoaded = true;
        if (!deps.taskPlans) return openPlans;
        try {
          openPlans = await deps.taskPlans.openPlans(ctx.principalId, ctx.sessionId);
        } catch (error) {
          // 存储不可用不失败回合：退回"没有可续计划"，本回合照常按新拆解走。
          console.error(JSON.stringify({ event: 'task_plan_load_failed', requestId: ctx.requestId, sessionId: ctx.sessionId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
          openPlans = [];
        }
        return openPlans;
      }

      /**
       * 计划绑定（C31）：判定整块在 plan-binding.ts（纯函数：不抛、不写 turn、不打日志），
       * 这里只留副作用——候选加载的 I/O 与降级、taskId 反查的容错、出题时写 turn + 打
       * 日志 + ToolUserError，以及归属日志（每个回合只记一次：① 同回合已定直接短路）。
       *
       * ① 同回合已定（本回合早前步骤绑定的计划）是**调用点的短路**，不是判定的一支：
       * 同一拆解的所有步共享一个 planId，宿主强制，后续步骤不再判定也不重复记账。
       */
      async function resolvePlanId(step: PlanStepLabel, intent: TurnDeclaration & { kind: 'delegate' }): Promise<string> {
        if (turn.planId) return turn.planId;
        const binding = await resolvePlanBinding({
          openPlans: await loadOpenPlans(),
          preferredPlanId: turn.preferredPlanId,
          taskId: intent.continueTaskId,
          planIdForTask: async (taskId: string): Promise<string | null> => {
            if (!deps.taskPlans) return null;
            try {
              return await deps.taskPlans.planIdForTask(ctx.principalId, ctx.sessionId, taskId);
            } catch (error) {
              // 反查失败（存储不可用）不失败回合：按"反查不到"走，这一步新开计划。
              console.error(JSON.stringify({ event: 'task_plan_task_lookup_failed', requestId: ctx.requestId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
              return null;
            }
          },
          requestId: ctx.requestId,
        }, step);
        // 多候选且无其他依据：本轮不委派，宿主直接把编号选项发给用户（机械生成，无需模型）。
        // ToolUserError 语义 = 这段文本成为本轮最终回复；出口校验被 delegationFailed 跳过。
        // 下一回合的编号回复经 matchPlanDisambiguationReply 绑定（前提：上一条 assistant
        // 事件就是这个问题——中间插过任何回合即失效，按新请求处理）。
        if ('disambiguate' in binding) {
          turn.delegationFailed = true;
          console.info(JSON.stringify({ event: 'task_plan_disambiguation_asked', requestId: ctx.requestId, candidates: binding.disambiguate.length }));
          throw new ToolUserError(renderDisambiguationQuestion(binding.disambiguate));
        }
        turn.planId = binding.planId;
        console.info(JSON.stringify({
          event: binding.resumed ? 'task_plan_resumed' : 'task_plan_started',
          requestId: ctx.requestId,
          planId: turn.planId,
          step: `${step.stepIndex}/${step.totalSteps}`,
        }));
        return turn.planId;
      }

      /**
       * 会话实体（任务 1 来源 A）：读 platform_tasks 底账按平台 args 规格提取。存储未注入
       * / 抛错 / 规格缺失 → 空数组（安全缺省：判定回退到三个来源，不失败回合——与执行台账
       * 不可用时的降级同族）。
       */
      async function collectSessionEntitiesSafely(): Promise<string[]> {
        if (!deps.platformTasks) return [];
        try {
          return await collectSessionEntities({
            platformTasks: deps.platformTasks,
            ...(deps.operationArgSpecs ? { operationArgSpecs: deps.operationArgSpecs } : {}),
            principalId: ctx.principalId,
            sessionId: ctx.sessionId,
          });
        } catch (error) {
          console.error(JSON.stringify({ event: 'session_entities_failed', requestId: ctx.requestId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
          return [];
        }
      }

      const turnDeadline = Date.now() + turnBudgetMs;
      const runMainAgent = (messages: AgentMessage[]): Promise<TurnDriverResult> => deps.driver.run({
        systemPrompt,
        tools,
        messages,
        onStep: ctx.onStep ?? (() => {}),
        exec: async (tool, args, signal) => {
          if (tool === ROUTE_CURRENT_TURN_TOOL_NAME) {
            const reviewed = reviewRouteDeclaration(args);
            // 自相矛盾的申报退回给模型重填，不消耗用户的澄清轮次
            if ('error' in reviewed) {
              console.warn(JSON.stringify({ event: 'route_declaration_invalid', requestId: ctx.requestId, reason: reviewed.error, keys: Object.keys(args).sort(), kind: typeof args['kind'] === 'string' ? args['kind'] : undefined }));
              return { error: `申报无效：${reviewed.error}` };
            }
            turn.declared = true;
            turn.intent = reviewed.intent;
            const intent = reviewed.intent;
            // 只记元数据：全文落在转录与 Conversation Log 里，日志重复一份只会放大泄漏面。
            console.info(JSON.stringify({
              event: 'turn_declaration',
              requestId: ctx.requestId,
              kind: intent.kind,
              ...(intent.kind === 'delegate' ? {
                hasContinueTaskId: Boolean(intent.continueTaskId),
                requestLength: intent.request.length,
              } : {}),
            }));
            if (intent.kind === 'delegate') {
              // 澄清收口（任务 1）：本回合已经进入"平台请用户选一个"的收口，任何再次委派都在
              // 此拦住——计划模式的后续步骤、单步模式的重新派单都不该发生（用户要先回答）。
              // 抛出的是宿主已组装好的澄清问题：它经驱动的 terminate 语义成为本轮文本，
              // 再由收口处的优先分支落成最终回复（模型那一轮的翻译体由此不上屏）。
              if (turn.clarificationReply) throw new ToolUserError(turn.clarificationReply);
              // 平台健康冷却（Lane 2）：连续 AUTH 类平台失败达阈值后，冷却期内不再发起
              // 任何平台调用（宿主前置拦截）——省一次注定失败的浏览器自动化足迹与限流
              // token，也省用户 10-60s 的等待。终稿由宿主合成（PLATFORM_UNAVAILABLE，
              // error-codes.ts 唯一措辞来源）：只说平台侧异常与恢复动作，不说内部控制
              // 机制，也不编造原因。抛出点在 platformTask.run 之前：零委派、零足迹。
              if (platformHealth.isCoolingDown(platformHealthKey)) {
                turn.delegationFailed = true;
                console.info(JSON.stringify({
                  event: 'platform_cooldown_blocked',
                  requestId: ctx.requestId,
                  sessionId: ctx.sessionId,
                  consecutiveAuthFailures: platformHealth.consecutiveAuthFailures(platformHealthKey),
                  cooldownRemainingMs: platformHealth.cooldownRemainingMs(platformHealthKey),
                }));
                throw new ToolUserError(platformHealth.cooldownReply(platformHealthKey));
              }
              // 宿主直接委派：实时查询必须产生本轮执行结果，不能拿旧答复收尾。
              let delegated: SubagentTaskResult;
              // 领域无关的实体来源（架构 §2 第 9 条）：宿主不懂业务，只把四个来源交给
              // 执行侧做逐字包含判定。来源全部由宿主持有，不从申报契约字段推导——
              // 契约只描述"这一轮要做什么"，不承载任何实体。
              //
              // 第四来源（sessionEntities，任务 1 标定修复）：连续会话里用户亲自确立过
              // 的实体。来源 A = 本会话执行过的任务的 calls 快照（平台 args 规格机械
              // 提取，只取执行过的不取搜索结果候选）；来源 B = 本轮澄清绑定选定的候选。
              // 两个来源都为空时不挂字段——老路径的判定一字不变。
              const sessionEntities = mergeSessionEntities(
                clarificationSelected ? [clarificationSelected] : [],
                await collectSessionEntitiesSafely(),
              );
              const entitySources: PlanEntitySources = {
                currentMessage: userMessage,
                ...(referenceEvidence ? { referenceEvidence: referenceEvidence.text } : {}),
                ...(sessionEntities.length > 0 ? { sessionEntities } : {}),
              };
              // 计划模式（Phase 6，架构 §3 规划者/执行者）：request 带「第N/M步：」前缀
              // 就是多步拆解的一步。无前缀 = 单步，行为与从前完全一样（结果 terminate
              // 成本轮回复）；有前缀 = 该步结果不 terminate，交还 Main Agent 继续拆解。
              const step = parsePlanStep(intent.request);
              let planId: string | null = null;
              if (step) {
                planId = await resolvePlanId(step, intent);
                await appendPlanFact(ctx, step, planId, 'started');
                console.info(JSON.stringify({
                  event: 'task_plan_step',
                  requestId: ctx.requestId,
                  planId,
                  step: `${step.stepIndex}/${step.totalSteps}`,
                  status: 'started',
                }));
              }
              const request = step ? step.request : intent.request;
              try {
                // request 是宿主委托执行的加工后请求（指代已解析成实体），
                // 与 entitySources.currentMessage 里的原始用户消息刻意分开。
                // 计划模式下 worker 看到剥掉协议前缀的请求——协议只存在于宿主与
                // Main Agent 之间；stepLabel 一路透传到计划门的用户通知上。
                delegated = await deps.platformTask.run({
                  request,
                  turnDeclaration: step ? { ...intent, request } : intent,
                  entitySources,
                  ...(intent.continueTaskId ? { taskId: intent.continueTaskId } : {}),
                  ...(step ? { stepLabel: step.label } : {}),
                }, { trusted: ctx }, signal);
              } catch (error) {
                // 委派失败：安全话术就是本回合回复，出口校验不得再覆盖它。
                turn.delegationFailed = true;
                if (step && planId) await appendPlanFact(ctx, step, planId, 'failed', { summary: '委派未完成' });
                // 平台健康信号（Lane 2）：auth 类失败进会话级记账。上面冷却拦截抛出的
                // 合成话术不经过这里（它在 platformTask.run 之前就抛了）——计数只记
                // 真实发起过的委派，冷却拦截本身不是新的失败证据。
                if (isAuthDelegationFailure(error)) {
                  const snapshot = platformHealth.recordAuthFailure(platformHealthKey);
                  console.info(JSON.stringify({
                    event: 'platform_auth_failure',
                    requestId: ctx.requestId,
                    sessionId: ctx.sessionId,
                    ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                    consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
                    cooldownEntered: snapshot.coolingDown,
                  }));
                }
                if (error instanceof ToolUserError) {
                  // 资源耗尽终稿（"失败必达"路径 1）：context.ts 的超时分类（failureClass
                  // 'timeout'）以 DELEGATION_TIMEOUT_FAILURE 话术上抛（error-codes 表唯一
                  // 来源，恒等比对、不模糊匹配）。宿主按协议把该失败分类为
                  // RESOURCE_EXHAUSTED，并从执行事实合成终稿（已完成部分/未完成部分/续跑
                  // 入口，判据与渲染住 resource-exhausted.ts）——替代干巴巴的"请稍后重试"。
                  // 只 enrich 用户话术：delegation_span 的 failed/timeout 与 platform_tasks
                  // 的 failed 终态由 context.ts 原样落，不被这里改写；分类经审计事件与
                  // turn_span 的 resource_exhausted 留痕。
                  if (error.message === DELEGATION_TIMEOUT_FAILURE) {
                    turn.resourceExhausted = true;
                    const timedOut = await loadTimedOutRecord(deps.platformTasks, ctx.principalId, ctx.sessionId, intent.continueTaskId, ctx.requestId);
                    console.info(JSON.stringify({
                      event: 'resource_exhausted_reply',
                      requestId: ctx.requestId,
                      failureClass: RESOURCE_EXHAUSTED_CLASS,
                      ...(timedOut ? { taskId: timedOut.taskId } : {}),
                      ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                    }));
                    throw new ToolUserError(renderResourceExhaustedReply({
                      record: timedOut,
                      doneSteps: turn.planStepOutcomes.filter((entry) => entry.outcome === 'done').map((entry) => entry.label),
                    }));
                  }
                  throw error;
                }
                console.error(JSON.stringify({ event: 'platform_task_route_failed', requestId: ctx.requestId, errorType: error instanceof Error ? error.name : 'UnknownError' }));
                throw new ToolUserError(FALLBACK_FAILURE);
              }
              // 平台健康信号（Lane 2）：本回合平台交互的结局进会话级记账。判据两条
              // （都是码级）：① 驱动从平台错误信封派生的 authFailure（exit 非零 + 错误
              // 信封属登录/凭据族，platform-contract 的判据）；② 委派层失败分类挂码的
              // ToolUserError（isAuthDelegationFailure，context.ts 的 failureClass）。
              // 有执行痕迹的非 AUTH 回合 = 平台健康已恢复 → 清零；零执行/其他失败不猜，
              // 计数原样（没有证据表明平台坏了，也没有证据表明它好了）。
              if (delegated.authFailure) {
                const snapshot = platformHealth.recordAuthFailure(platformHealthKey);
                console.info(JSON.stringify({
                  event: 'platform_auth_failure',
                  requestId: ctx.requestId,
                  sessionId: ctx.sessionId,
                  code: delegated.authFailure.code,
                  ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                  consecutiveAuthFailures: snapshot.consecutiveAuthFailures,
                  cooldownEntered: snapshot.coolingDown,
                }));
              } else if (delegated.execution) {
                platformHealth.recordResolved(platformHealthKey);
              }
              // 计划模式跨步累积执行痕迹 / 计划步计数 / 澄清与激活计划事实：规则住
              // turn-state.ts（accumulateDelegation）。
              accumulateDelegation(turn, step, delegated);
              // 步骤事实的结局：taskId 写进该步的最后一条事实（spec：事后回填）。
              // 停在用户确认门的步骤不写结局——它还没完，投影里保持 started，跨回合可续。
              // 选择类澄清记 'needs'：这一步缺的是"用户选哪个"，与缺参数同族（都不是失败）。
              if (step && planId && !delegated.pendingPlan) {
                const status = delegated.needs || delegated.clarification ? 'needs' : delegated.execution ? 'done' : 'failed';
                await appendPlanFact(ctx, step, planId, status, { taskId: delegated.taskId, summary: planStepSummary(delegated) });
                console.info(JSON.stringify({
                  event: 'task_plan_step',
                  requestId: ctx.requestId,
                  planId,
                  step: `${step.stepIndex}/${step.totalSteps}`,
                  status,
                }));
              }
              // 计划模式熔断记账：零执行 = 既无 execution 也无 needs 交还（worker 空转的
              // 形状：提计划被拒/把方案当文本打印）。有执行或交还即重置——合法步骤必然
              // 两者之一，所以只熔"连续"零执行；停在用户确认门的步骤不计数（回合在此暂停，
              // 没有"后续步骤"可省）。汇总用的步骤结局与上面刚写下的计划事实同源。
              // 写关闭步骤不计入熔断：它的零执行是"部署没开放写"的终局事实，不是 worker
              // 空转——那句话必须由宿主说给用户（见下方 writeClosed 分支），而被熔断汇总
              // 顶上就永远说不出来了；且熔断汇总结尾的"可以回复继续重跑未完成的步骤"在
              // 写计划下是假承诺（写类步骤永远不会被放行）。
              // 计数与判据住 turn-state.ts（notePlanStepOutcome / noteZeroExecStep）。
              if (step && planId && !delegated.pendingPlan) {
                const outcome = stepOutcomeOf(delegated);
                notePlanStepOutcome(turn, step.label, outcome);
                if (noteZeroExecStep(turn, { failed: outcome === 'failed', writeClosed: delegated.writeClosed, proposalCreated: Boolean(delegated.proposalCreated), pendingPlan: Boolean(delegated.pendingPlan) })) {
                  // 连续 N 步空转：停止派发后续步骤，用计划事实机械汇总成本轮回复
                  // （ToolUserError 语义 = 这段文本成为本轮最终回复，与消歧问题同一路径；
                  // 汇总只陈述步号与结局，不含财务数字，出口校验不会覆盖它）。
                  turn.delegationFailed = true;
                  console.info(JSON.stringify({
                    event: 'plan_steps_circuit_break',
                    requestId: ctx.requestId,
                    planId,
                    consecutiveZeroExecSteps: turn.planZeroExecSteps,
                    completedSteps: turn.planStepOutcomes.filter((entry) => entry.outcome === 'done').length,
                    totalSteps: step.totalSteps,
                    stoppedAt: `${step.stepIndex}/${step.totalSteps}`,
                  }));
                  throw new ToolUserError(renderPlanCircuitBreak(turn.planStepOutcomes, turn.planZeroExecSteps, step.totalSteps));
                }
              }
              // 结构化歧义/未找到（Stage 3 事故根治包）：平台请用户"选一个"。**不 terminate**——
              // 作为工具结果交还 Main Agent（与 needs 同一机制），本轮回复由收口处的优先分支
              // 用宿主机械组装的澄清问题整体替换：模型这一轮的翻译体（脚本路径/错误码/门的
              // 规则）存在但不被使用。计划模式的后续步骤由委派入口的守卫拦住——用户要先回答
              // "查哪个"，继续拆解只会空转。
              if (delegated.clarification) {
                turn.clarification = delegated.clarification;
                turn.clarificationReply = composeClarificationReply(delegated.clarification, delegated.text);
                // 澄清事件（任务 1 来源 B）：宿主发出"选一个"的澄清时落 issued（与 resume
                // 路径同一落点）。下一回合的裸编号/候选名答复经 matchClarificationBinding
                // 机械绑定，selected 进本轮实体来源。
                await appendClarificationIssued(deps, ctx, delegated.clarification);
                // 出口校验不得覆盖宿主的澄清问题（与消歧问题/熔断汇总同一处理）
                turn.delegationFailed = true;
                console.info(JSON.stringify({
                  event: 'delegation_clarification',
                  requestId: ctx.requestId,
                  taskId: delegated.taskId,
                  code: delegated.clarification.code,
                  candidates: delegated.clarification.candidates.length,
                  ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                }));
                const relay = renderClarificationToolResult(delegated.clarification, delegated.taskId);
                if (step) {
                  return {
                    ...renderPlanStepToolResult(step, delegated),
                    outcome: 'needs',
                    text: relay,
                    next: '不要继续申报后续步骤——停止拆解，等用户回答（用户看到的是宿主组装的澄清问题，不要自己复述）。',
                  };
                }
                return { recorded: 'delegate', text: relay, taskId: delegated.taskId };
              }
              // 纠错环（架构 §3）：子 Agent 执行不了就回报"缺什么"。此时**不 terminate 整轮**
              // ——把线索作为工具结果交还 Main Agent，它自己继续本回合：能补齐（从 Log /
              // 检索证据 / 本轮平台响应取实体）就重新申报 delegate（带 continueTaskId 与
              // 补齐后的 request），不能补齐就申报 conversation 把问题转达给用户。
              // 整轮失败、"本轮没有产生任何平台查询"那种把原因丢给用户的兜底由此不再出现。
              if (delegated.needs) {
                // 回路上限的计数规则住 turn-state.ts（noteNeedsRound）：单步模式按全局计、
                // 计划模式按步计（换一步重新计数，任一步失败不阻塞其他步）。
                const needsExhausted = noteNeedsRound(turn, step ? step.stepIndex : null);
                turn.lastNeeds = delegated.needs;
                console.info(JSON.stringify({
                  event: 'delegation_needs',
                  requestId: ctx.requestId,
                  taskId: delegated.taskId,
                  round: turn.needsRounds,
                  missing: delegated.needs.missing.length,
                  ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                }));
                if (needsExhausted) {
                  if (step) {
                    // 同一步反复缺信息：停止重派这一步，但不终止整轮——让模型跳过它继续
                    // 后续步骤（或直接汇总），失败由汇总如实报告。
                    return {
                      ...renderPlanStepToolResult(step, delegated),
                      next: `这一步已重试 ${turn.needsRounds} 次仍缺信息，不要再重派它。继续后续步骤；若已是最后一步就申报 conversation 汇总，并如实报告这一步缺什么。`,
                    };
                  }
                  // 回路兜底：连续几轮仍缺信息，停止重派，把线索作为本轮回复交给用户
                  // （这是转达，不是失败）。数字结论仍须本轮有执行痕迹。
                  // ③-5：旧实现把 worker 文本拼进转达，一旦其中带财务数字就整段换成
                  // NO_EXECUTION_CLARIFICATION——"还缺少什么"的唯一线索被连坐丢掉。
                  // 现在只丢 workerText（零执行轮次它不可信），needs 的 missing/reason/
                  // suggestion 是宿主与平台信封的结构化事实，照常转达（先例：
                  // renderNeedsUserText(needs, '')）。
                  const needsOnly = renderNeedsUserText(delegated.needs, '');
                  throw new ToolUserError(hasFinancialFigure(needsOnly) ? NO_EXECUTION_CLARIFICATION : needsOnly);
                }
                if (step) return renderPlanStepToolResult(step, delegated);
                const relay = renderNeedsToolResult(delegated.needs, delegated.taskId, stripFootprint(delegated.text));
                return { recorded: 'delegate', text: relay, taskId: delegated.taskId, needs: delegated.needs };
              }
              // 写关闭 disclosure（D-075）：本回合的计划被宿主以"部署未开放写入"拦下
              // （计划里出现写类 operation 而能力声明不含 write），delegated.text 是宿主
              // 合成的写关闭话术而非 worker 文本——T7 事故形态（模型停在"录入准备"阶段、
              // 承诺"即可产出录入提案"却永不抵达提案步）里，这是用户唯一能知道写权限关闭
              // 的通道。它以确定性话术终结该轮：不经模型翻译（与澄清问题同家族），出口
              // 校验的零执行标注（"以上是子 Agent 的说明；本轮没有真正查到平台数据"）
              // 也不得覆盖或误标其来源——那句话是宿主说的确定性事实，不是子 Agent 的
              // 说明。delegationFailed 让出口校验整体放行（与消歧问题/熔断汇总同一路径）。
              // 单步与多步同一机械保证：本检查必须在计划模式步骤交还
              // （renderPlanStepToolResult）**之前**——多步计划里写关闭那一步一旦走交还链，
              // 宿主原句就只是工具结果里的一段文本，终稿变成 Main Agent 的转述版，
              // "用户一定知道写权限是关闭的"这个机械保证随之失效（D-075 残留）。
              if (delegated.writeClosed) {
                turn.delegationFailed = true;
                console.info(JSON.stringify({ event: 'write_not_enabled', requestId: ctx.requestId, taskId: delegated.taskId, ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}) }));
                throw new ToolUserError(renderWriteClosureReply(step, delegated, turn.planStepOutcomes));
              }
              // 提案已登记（B 波 B3 网关提案路径）：与写关闭同一家族——delegated.text 是
              // **宿主持有的确定性文本**（平台 summaryText 原样 + 通用确认行），本回合以此
              // 终结。为什么必须走这条而不是通用的 terminate 分支：提案这一步可能零网关执行
              // （拦截发生在 gate 之前，那一条 bash 没被放行），出口校验的零执行门会把它整段
              // 换成 NO_EXECUTION_CLARIFICATION——确认码随之消失，用户永远拿不到码。
              // delegationFailed 让出口校验整体放行（与消歧问题/熔断汇总同一路径）。
              // 与 needs/clarification 不互斥但优先：提案登记是既成事实，交还模型只会稀释它。
              if (delegated.proposalCreated) {
                turn.delegationFailed = true;
                console.info(JSON.stringify({
                  event: 'proposal_created',
                  requestId: ctx.requestId,
                  taskId: delegated.taskId,
                  proposalId: delegated.proposalCreated.proposalId,
                  ...(step ? { step: `${step.stepIndex}/${step.totalSteps}` } : {}),
                }));
                throw new ToolUserError(stripFootprint(delegated.text) || FALLBACK_FAILURE);
              }
              // 计划模式：这一步的结果交还 Main Agent（复用 Phase 5 的"交还"机制），
              // 由它继续申报下一步或申报 conversation 汇总——不 terminate 整轮。
              // 例外是停在用户确认门的步骤：那一步还没做完，整轮在此暂停等真实确认
              // （与单步模式同一语义），计划投影里它保持 started，跨回合可续。
              if (step && !delegated.pendingPlan) return renderPlanStepToolResult(step, delegated);
              // terminate 语义：这段文本成为本轮最终回复，不再喂回模型。
              // 宿主是最后一道关：执行面注脚是给模型的元数据，绝不能出现在用户眼前。
              throw new ToolUserError(stripFootprint(delegated.text) || FALLBACK_FAILURE);
            }
            // conversation：不触发任何执行，模型紧接着给出的文本即本轮回复
            // （需要澄清、说明能力边界时同样走这条路径）。
            return { recorded: 'conversation' };
          }
          if (tool === RUN_17DZ_TASK_TOOL) {
            return deps.platformTask.run({
              request: String(args['request'] ?? ''),
              ...(typeof args['taskId'] === 'string' ? { taskId: args['taskId'] } : {}),
            }, { trusted: ctx }, signal);
          }
          const historyTool = historyTools.find((candidate) => candidate.name === tool);
          if (historyTool) return historyTool.execute(args);
          throw new ToolUserError('当前主 Agent 未授权该工具。');
        },
        deadline: turnDeadline,
      });

      const initialMessageCount = context.length;
      let result = await runMainAgent(context);
      // Main 编排模型本回合的真实 token 消耗（纯加法遥测）：对 Main 驱动本回合新增的
      // assistant 消息分项求和（口径 Main=编排模型本体；context/memory 辅助调用走独立的
      // contextModelDriver，由 aux_model_usage 单独成账，不混进这里）。网关不回传 usage
      // 时保持 undefined → turn_span 字段缺席（不是全零，两类事实必须可区分）。
      // 跳过申报的重试段也是本回合的 Main 消耗：第二段输入 = 第一段转录 + 重试指令，
      // 从 firstRunLen+1 起切只拿第二段新增的 assistant 消息（切片判据与下方
      // extract17dzToolResultEvents 的 initialMessageCount 同法）。
      let mainUsage = sumUsage(result.messages.slice(initialMessageCount));
      if (!turn.declared) {
        // 跳过申报：丢弃自由文本，追一条明确指令重试一次。
        const firstRunLen = result.messages.length;
        const retried = await runMainAgent([
          ...result.messages,
          { role: 'user', content: ROUTE_RETRY_NUDGE, timestamp: Date.now() } as unknown as AgentMessage,
        ]);
        mainUsage = addUsageTotals(mainUsage, sumUsage(retried.messages.slice(firstRunLen + 1)));
        if (!turn.declared) {
          // 仍跳过：失败关闭，绝不外发未申报的文本。
          console.warn(JSON.stringify({ event: 'route_declaration_missing', requestId: ctx.requestId }));
          return await finishDirectReply(NO_EXECUTION_CLARIFICATION, 'route_declaration_missing', undefined, mainUsage);
        }
        result = retried;
      }
      // 选择类澄清兜底（任务 1）：宿主机械组装的澄清问题**优先于模型文本**。委派分支把
      // "平台请用户选一个"作为工具结果交还模型（与 needs 同一机制），模型这一轮无论说什么
      // 都是对协议材料的翻译；这里用模板+信封数据组装的那一份整体替换——翻译体不上屏也不进
      // 转录，后续回合与 Context State 读到的才是真实状态。模型真的又申报委派时，委派入口
      // 的守卫会先抛出同一段文本终止回合（计划模式的后续步骤由此停止），最终仍落到这里。
      if (turn.clarification && turn.clarificationReply) {
        console.info(JSON.stringify({
          event: 'selection_clarification_relayed',
          requestId: ctx.requestId,
          code: turn.clarification.code,
          candidates: turn.clarification.candidates.length,
        }));
        return await finishDirectReply(
          turn.clarificationReply,
          'selection_clarification',
          `平台澄清 ${turn.clarification.code}：候选 ${turn.clarification.candidates.length} 个`,
          mainUsage,
        );
      }
      // 出口校验：申报了实时查询，就必须有本轮执行痕迹（激活计划 + 至少一次平台调用），
      // 或停在用户确认门。委派已失败的（安全话术已给出）不在此列。
      // Phase 5 起多一条纠错环出口：needs 回路进行中时，Main Agent 的回复是"转达用户缺什么"，
      // 那是合法回复，不再走 delegate_without_execution 兜底——但数字结论仍然必须本轮有执行，
      // 回路本身不是执行痕迹（架构 §2 第 10 条一动不动）。
      // Phase 6 起计划模式汇总同理：有计划模式执行痕迹（任一步真跑过）即放行；
      // 全部步骤都没执行时，"三步都没查成"这种如实汇总可以外发，但数字结论仍被挡下。
      const needsLoop = turn.needsRounds > 0;
      const planModeTurn = turn.planSteps > 0;
      // F4 残留修复（D-020）：协议材料复读的形状判据**不依赖 execution**。此前的出口校验
      // 以 `!turn.execution` 为总闸——回合真有过执行时，模型文本不经任何检测直接外发；
      // 而 Stage 3 实测事故的形状恰恰是 execution 为真（检索类调用真的发生过、gateCalls>0）
      // 而模型把内部协议材料原样当回复。判据只有形状（协议 JSON 的字段名），不嗅探内容。
      const protocolReplay = looksLikeProtocolMaterial(result.text);
      // 出口校验的两段门（执行痕迹门 + 协议复读门）判定住 turn-exit.ts：纯函数，只回答
      // "这一回合外发什么、记什么事件"。副作用留在调用点——日志按决策带回的级别打，
      // needsRelay 只拿决策选中的文本，确定性话术经 finishDirectReply 提前返回。
      const logExitEvents = (entries: readonly TurnExitEvent[]): void => {
        for (const { level, event, detail } of entries) {
          const payload = JSON.stringify({ event, requestId: ctx.requestId, ...detail });
          if (level === 'warn') console.warn(payload);
          else console.info(payload);
        }
      };
      const exitDecision = decideTurnExit({
        delegationFailed: turn.delegationFailed,
        execution: Boolean(turn.execution),
        pendingPlan: Boolean(turn.pendingPlan),
        resultPendingPlan: Boolean(result.pendingPlan),
        intentKind: turn.intent?.kind ?? null,
        needsLoop,
        planModeTurn,
        needsRounds: turn.needsRounds,
        planSteps: turn.planSteps,
        planStepOutcomes: turn.planStepOutcomes,
        lastNeeds: turn.lastNeeds,
        activatedPlan: turn.activatedPlan,
        protocolReplay,
        resultText: result.text,
        hasFinancialFigure,
        usefulWorkerNote,
      });
      let needsRelay = '';
      if (exitDecision.kind === 'direct') {
        logExitEvents(exitDecision.events);
        return await finishDirectReply(exitDecision.text, exitDecision.outcome, undefined, mainUsage);
      }
      if (exitDecision.kind === 'relay') {
        logExitEvents(exitDecision.events);
        needsRelay = exitDecision.text;
      }

      // 纠错环转达：宿主自己把"缺什么"说给用户（模型没产出可用文本时）。它优先于空回复兜底——
      // 用户至少知道在等自己补什么，而不是一句"查询失败"。
      const replyText = needsRelay || result.text;

      // 数值溯源探查（只留痕，不拦截）：零执行轮次的回复若含"千分位小数"格式的金额，
      // 而该数值在历史转录/检索证据/当前消息里都逐字找不到，记一条告警。
      // 为什么不拦截：模型对真实数字做算术（对比/合计）会产生新数值，宿主无法在
      // "算术"与"编造"之间做确定性区分——那道线由探针（E1/F1 的金额判定）和人工守。
      // E1 实测：模型会在零执行轮次编造业务明细（rule-landing.md §9），此日志让运维看得见。
      if (!turn.execution && !turn.pendingPlan) {
        const amounts = new Set<number>();
        for (const match of replyText.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g)) {
          amounts.add(Number(match[0].replace(/,/g, '')));
        }
        if (amounts.size > 0) {
          const history = JSON.stringify(result.messages.slice(0, -1));
          const haystack = `${history}\n${referenceEvidence?.text ?? ''}\n${userMessage}`;
          const unsourced = [...amounts].filter((value) => !haystack.includes(String(value)) && !haystack.includes(value.toLocaleString('en-US')));
          if (unsourced.length > 0) {
            console.warn(JSON.stringify({ event: 'conversation_unsourced_amounts', requestId: ctx.requestId, count: unsourced.length, needsRounds: turn.needsRounds }));
          }
        }
      }

      await saveTranscript(deps.sessions, {
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
        messages: stripHistoryNotes(result.messages),
      });

      if (!replyText.trim()) {
        const timedOut = Date.now() >= turnDeadline;
        const reason = timedOut ? 'turn_timeout' : 'empty_reply';
        const fallback = timedOut ? FALLBACK_TIMEOUT : FALLBACK_FAILURE;
        await persistAssistantAndContext(deps, ctx, fallback, contextUpdateQueues);
        scheduleMemoryConsolidation(deps, ctx, userMessage, memoryUpdateQueues);
        console.info(JSON.stringify({ event: 'fallback_reply', requestId: ctx.requestId, reason }));
        console.info(JSON.stringify({ event: 'turn_span', requestId: ctx.requestId, durationMs: Date.now() - turnStart, outcome: reason, ...(mainUsage ? usageSpanFields(mainUsage) : {}) }));
        return { text: fallback };
      }
      const { events: toolResultEvents, taskResults } = extract17dzToolResultEvents(result.messages.slice(initialMessageCount), ctx);
      await persistAssistantAndContext(deps, ctx, replyText, contextUpdateQueues, toolResultEvents);
      // D-065：结果文本回写任务条目（结构化字段缺失时召回台账的兜底渲染源）。与 Log 同文、
      // 同样脱敏；失败不影响回合（recordTaskResult 内部已兜底）。
      for (const { taskId, resultText } of taskResults) {
        void deps.platformTask.recordTaskResult?.(taskId, { resultText })?.catch(() => undefined);
      }
      scheduleMemoryConsolidation(deps, ctx, userMessage, memoryUpdateQueues);
      // turn_span 的 outcome 带上资源耗尽分类（路径 1"失败必达"）：委派超时的回合以
      // 合成终稿收尾，outcome 记 resource_exhausted 供审计与续跑识别；delegation_span
      // 的 failed/timeout 分类由 context.ts 独立落账，两侧不互斥。
      console.info(JSON.stringify({ event: 'turn_span', requestId: ctx.requestId, durationMs: Date.now() - turnStart, outcome: turn.resourceExhausted ? 'resource_exhausted' : needsRelay ? (needsLoop ? 'needs_loop_relayed' : 'plan_steps_relayed') : 'ok', ...(mainUsage ? usageSpanFields(mainUsage) : {}) }));
      return { text: replyText };
      async function finishDirectReply(text: string, outcome: string, toolResult?: string, usage?: UsageTotals): Promise<AgentReply> {
        const now = Date.now();
        const messages = [
          ...loaded,
          { role: 'user', content: userMessage, timestamp: now } as unknown as AgentMessage,
          deps.driver.synthesizeAssistant
            ? deps.driver.synthesizeAssistant(text)
            : ({ role: 'assistant', content: text, timestamp: now + 1 } as unknown as AgentMessage),
        ];
        await saveTranscript(deps.sessions, { sessionId: ctx.sessionId, principalId: ctx.principalId, messages });
        const toolEvents = toolResult ? [{
          eventId: `${ctx.requestId}:routed_tool_result`, principalId: ctx.principalId, sessionId: ctx.sessionId,
          kind: 'tool_result' as const, content: redactInternalIds(redactSensitiveText(toolResult)), createdAt: new Date().toISOString(), requestId: ctx.requestId,
        }] : [];
        await persistAssistantAndContext(deps, ctx, text, contextUpdateQueues, toolEvents);
        scheduleMemoryConsolidation(deps, ctx, userMessage, memoryUpdateQueues);
        // usage 缺席（模型没被调用 / 网关没回传）时字段缺席，不是全零（口径见 driver.ts）。
        console.info(JSON.stringify({ event: 'turn_span', requestId: ctx.requestId, durationMs: Date.now() - turnStart, outcome, ...(usage ? usageSpanFields(usage) : {}) }));
        return { text };
      }
    },
  };
}

/** 回复里是否带财务数字——用来区分"编造的结论"和"能力边界说明"。 */
export function hasFinancialFigure(text: string): boolean {
  return /[\d,]+\.?\d*\s*(元|块|万|亿)|余额|金额|发生额/.test(text);
}

/**
 * worker 文本里"有价值的无数字说明"：剥掉执行面注脚后非空、不含财务数字、不含执行语言
 * 指纹（脚本路径/错误码/JSON 片段——那是模型在翻译协议材料，不是给用户的说明），也不是
 * 宿主的通用兜底——这种说明才配附在状态文案后面，否则只会稀释它。
 * 恢复路径（确认后零执行）与 delegate 路径的收尾兜底共用同一把尺。
 *
 * 这把尺是 runtime 自己的私有判据（判据本体 stripFootprint / hasFinancialFigure /
 * executionLanguageFingerprints 都不在 turn-relay 那一侧），调用点全在本文件内；导出仅为
 * golden 测试直接钉形状，包的公开出口（index.ts）不认它——不因测试需要把它抬成跨模块
 * 公共协议。
 */
export function usefulWorkerNote(text: string): string {
  const note = stripFootprint(text).trim();
  if (!note || hasFinancialFigure(note) || note === NO_EXECUTION_CLARIFICATION || note === ACTIVATED_PLAN_NOT_EXECUTED || note === RESUMED_PLAN_NOT_EXECUTED) return '';
  if (executionLanguageFingerprints(note).length > 0) return '';
  return note;
}

/**
 * 选择类澄清的本轮回复：表内模板 + 平台信封数据机械组装（宿主发音，模型不参与）；
 * worker 留下的干净说明（无财务数字、非协议材料——判据复用 usefulWorkerNote）才附后。
 *
 * 与 usefulWorkerNote 同住 runtime.ts：这把尺是 runtime 私有判据，澄清回复是它的直接
 * 使用者（turn-relay 不能 import runtime，否则循环）——组装逻辑跟着判据走，不复制第二份。
 */
export function composeClarificationReply(clarification: SelectionClarification, workerText: string): string {
  const question = clarificationTextFor(clarification.code, clarification);
  const note = usefulWorkerNote(workerText);
  return note ? `${question}\n\n${note}` : question;
}

/**
 * 多任务消歧的编号回复匹配与消歧问题渲染住在 plan-binding.ts（与 resolvePlanBinding
 * 同模块：判定与文案一处，两边不复制）。
 */

/**
 * 日期尾注：拼在组装后系统提示词的**最尾部**（business skill 之后；恢复路径的整理提示词
 * 同样拼尾）。LLM 的 prompt cache 按前缀逐字节匹配命中：日期排在提示词前部时，跨天即
 * 炸断全部稳定前缀——SYSTEM_PROMPT 与 skill 文本每次调用都按未命中付全价。放尾部后，
 * 跨天只有这一行动态，前面的稳定内容继续命中缓存。文案与原日期行一字不差（模型仍能
 * 看到完整日期信息），只挪位置。模块加载时求值一次，与原实现同频。
 */
const DATE_SUFFIX = `今天是 ${new Date().toISOString().slice(0, 10)}（北京时间 ${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}）。回答与时间相关的问题时以这个日期为准，不要凭印象编月份。`;

const SYSTEM_PROMPT = [
  '你是面向用户的主 Agent，职责只有三个：选 conversation 还是 delegate；把指代解析成具体实体；汇总子 Agent 的结果。',
  '**你没有平台能力**：不能发现域能力、不能读域文档、不能执行、不能摸索传参——这些全是子 Agent 的活。**因此不要拆解执行步骤**：步骤是子 Agent 上下文里的域 SOP 定义的，你复述一遍只是制造第二份真相。只有"同一个动作要对 N 个独立对象各做一次"才值得拆多步；单一对象的任务再长也不拆。',
  '每回合必须先调用一次 route_current_turn 申报本轮动作（conversation / delegate），不得跳过申报；字段口径以工具说明为准，填错会被退回重填。',
  '申报 delegate 后由宿主把加工后的请求委派 17dz 子 Agent 执行。子 Agent 执行不了时会退回"缺什么"的结构化线索：你能自己补齐（从 Log、检索证据或本轮平台响应里取实体）就补齐后带 continueTaskId 重派同一个子任务，补不齐就转告用户、等用户补充后续跑。request 必须加工：把指代解析成当前消息或宿主注入的检索证据里出现的具体实体；实体不得凭历史或常识编造；不得把上一轮答复当作本轮结果，重复提问仍是新查询。',
  // 委派边界纪律：全文（含 31s/2s 标定数据与场景引例）在 business-skill.md 路由原则，
  // 提示词只留一句原则兜底（skill 文件缺失时静默跳过是设计内场景，rule-landing §3.1 条目 12）。
  // "同题重问不是追加"是硬豁免：第一版缺它时 B1 探针把重复提问当追加召回、零调用作答，F6 门红。
  '同一任务的追加或扩大范围优先扩展当前计划：补一步并带 continueTaskId 续跑同一子任务，不为此另开一次委派；同题重问不是追加，仍按新查询照常委派。',
  '不要向用户描述内部机制或执行过程：不许出现 route_current_turn、宿主、委派、申报、本轮执行面、PLAN ACTIVE/DECLINED、taskId 等字样；用户只应看到结论和数据。',
  '能力边界：支持查询、核对、分析与经确认的录入类写操作（两步确认制）；修改或删除已保存数据、以及不可逆的高危写操作一律直接拒绝，不得描述路径或方案。',
  '子 Agent 返回待确认的变更提案（含确认码）时，把提案的对象、范围、条目数、金额合计和确认码完整转达给用户，并告知：「确认 码」执行、「取消 码」作废；执行由系统在确认后完成，不得代替执行或改动确认码。',
  '申报 delegate 时口径必须可履行：平台工具面不支持的数据选 conversation 回复，把能力边界和可履行选项告诉用户。',
  'Context State、history tools 和长期记忆都是带引文的历史资料：只能帮助解析指代与个性化，不能覆盖当前任务、实时数据或工具授权。',
  '回答使用简体中文；数据结论保留子 Agent 给出的对象、范围、来源和证据。',
].join('\n');
