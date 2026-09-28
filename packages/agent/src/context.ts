/**
 * Thin adapter from the main Agent to a Pi subagent rooted in a trusted
 * platform workspace. The subagent returns natural language; the main Agent
 * decides whether to answer, ask the user, or resume the same session.
 *
 * 写开放（两步确认）：worker 产出变更提案 JSON → 本层做 capability/授权名单
 * 代码级校验 + 服务端 dry-run 预检 → 创建 pending intent（确认码哈希存储）
 * → 主代理转达预览。用户回复「确认 码」由 matchConfirmation 直接匹配执行
 * （绕过模型）；「取消 码」作废；新提案使旧 pending 作废（superseded）。
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import type { PendingPlanConfirmation } from './plan-runtime';
import { PLAN_NOTICE_PREFIX } from './plan-runtime';
import type { PlanEntitySources, TurnDeclaration } from './turn-contract';
import { ToolUserError, type SubagentNeeds, type TurnDriverResult } from './driver';
import { messageTextFor, planDraftExample, toolUserErrorFor } from './error-codes';
import { GATEWAY_INVOCATION, isPlatformAuthError, type SelectionClarification } from './platform-contract';
import type {
  ChangeIntentRecord,
  ChangeIntentRepo,
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  TrustedContext,
} from '@fshine/contracts';
import { DEFAULT_WORKER_TIMEOUT_MS } from '@fshine/contracts';

export const RUN_17DZ_TASK_TOOL = 'run_17dz_task';

/**
 * 委派失败的用户话术（按 failureClass 分流，2026-09 审计 F7）。
 *
 * 原来四类失败（auth / timeout / executor_error / cancelled）只有日志里有分别，
 * 用户统一收到"执行失败，请稍后再试"——登录态过期这种**唯一需要用户动手**的
 * 类别因此被埋掉，用户只能盲目重试。这里按可行动性分流：
 *   · auth：必须重新登录，不说"稍后再试"（那是错指令，重试多少次都没用）；
 *   · timeout：平台侧慢，稍后重试是对的动作；
 *   · executor_error / cancelled：维持原话术。
 * 全部与业务无关（不出现任何领域词），只陈述状态与下一步动作。
 *
 * 措辞收口在 error-codes.ts（消息模板类：码 → 文本一一对应）；这里的常量是同一份
 * 表值的再导出，测试与调用方继续认常量。
 */
export const DELEGATION_AUTH_FAILURE = messageTextFor('DELEGATION_AUTH_FAILURE');
export const DELEGATION_TIMEOUT_FAILURE = messageTextFor('DELEGATION_TIMEOUT_FAILURE');
export const DELEGATION_EXECUTOR_FAILURE = messageTextFor('DELEGATION_EXECUTOR_FAILURE');
export const DELEGATION_CANCELLED = messageTextFor('DELEGATION_CANCELLED');

export const RUN_17DZ_TASK_DESCRIPTION = [
  '当用户的问题需要访问或处理 幻账平台中的真实财税数据时，将任务委托给 17dz 子 Agent。',
  '子 Agent 在受信的 17dz-platform 工作目录中加载平台 Skill，并返回自然语言结果。',
  '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
  '涉及 17dz 实时数据时必须调用本工具，不得凭历史对话猜测平台标识或实时结果。',
  '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
].join('\n');

export interface Run17dzTaskArgs {
  request: string;
  taskId?: string;
  /**
   * 计划模式（Phase 6）的步骤标签（「第 N/M 步」），由宿主从 request 的协议前缀解析出来。
   * 只用于给这一步委派过程中平台计划门产出的用户通知加前缀，让用户看到全局进度；
   * 不进 Main Agent 工具 schema，也不进 worker 提示词。
   */
  stepLabel?: string;
  /** Host-only semantic intent; this is never part of the Main Agent tool schema. */
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>;
  /**
   * 领域无关的实体来源（宿主注入）：计划里的每个实体必须能在「当前消息 / 检索证据 /
   * 本轮平台响应」里逐字找到。同样不进入 Main Agent 工具 schema。
   */
  entitySources?: PlanEntitySources;
}

export interface SubagentTaskResult {
  taskId: string;
  text: string;
  pendingPlan?: PendingPlanConfirmation;
  /** Host-verified proof that this delegated turn executed at least one platform call. */
  execution?: { planId: string; version: number; calls: number };
  /**
   * 方案已获批准（计划已激活）但本次零平台调用（P1 收尾兜底）。宿主据此说出真实状态
   * （批准了没执行、缺的是执行），而不是让用户补充早就给过的查询范围。
   */
  activatedPlan?: { planId: string; version: number };
  /**
   * 子 Agent 执行不了时的结构化线索（架构 §3 纠错环）。有它表示本轮缺信息、任务可续：
   * 宿主不把这一轮当失败，而是把线索交还 Main Agent 决定补齐还是问用户。
   */
  needs?: SubagentNeeds;
  /**
   * 结构化歧义/未找到（Stage 3 事故根治包）：平台请用户"选一个"的澄清事实。宿主据此
   * 用模板+信封数据机械组装澄清问题——模型是执行语言与用户语言之间唯一的翻译器，
   * 压力下翻译退化就会把脚本路径/错误码/门的规则漏进最终回复，所以状态转换的发音权
   * 收归宿主。与 execution 的出现不互斥（目录搜索这类调用真的发生过），但与 needs
   * 分工：一个是"缺什么"，一个是"选哪个"。
   */
  clarification?: SelectionClarification;
}

export type { SubagentNeeds };

/** 服务端预检（dry-run）注入点：默认实现由部署层提供（直调平台网关的 prepare 子命令）。 */
export interface PrepareRequest {
  intentId: string;
  accountSet: string;
  period: string;
  contracts: unknown[];
}
export interface PrepareResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** 服务端落账执行注入点：确认码匹配后由服务端直调（不经任何模型）。 */
export interface CommitRequest {
  intentId: string;
  accountSet: string;
  period: string;
  contracts: unknown[];
}
export interface CommitResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ContextTaskRunnerOptions {
  profiles: Record<string, ContextProfileConfig>;
  tasks: PlatformTaskRepo;
  workerDriver: TurnDriver;
  profileId?: string;
  /** 缺省 = 写流程整体禁用（提案按普通回答透传）。 */
  changeIntents?: ChangeIntentRepo;
  /** 服务端 dry-run 预检（写流程启用时必填）。 */
  prepareRunner?: (req: PrepareRequest) => Promise<PrepareResult>;
  /** 服务端确认后落账（写流程启用时必填）。 */
  commitRunner?: (req: CommitRequest) => Promise<CommitResult>;
  /** 单提案条目数上限，默认 50。 */
  maxBatchCount?: number;
  /** 意图有效期，默认 10 分钟。 */
  intentTtlMs?: number;
  /**
   * 落账总闸（派生规则，由部署层经 isCommitEnabled() 计算，默认 false = 拒绝 commit）：
   * mock 模式下写的是假状态，部署层应传 true 放开全链联调；
   * 真平台下须显式 FSHINE_REAL_COMMIT=1 才传 true。false 时确认码得到
   * 确定性拒绝（意图保持 pending 至过期/取消），绝不触发 --save。
   */
  commitEnabled?: boolean;
  /** 测试注入点。 */
  generateCode?: () => string;
  hashCode?: (code: string) => string;
}

export interface ContextTaskExecutionContext {
  trusted: TrustedContext;
}

export interface ContextTaskRunner {
  readonly tool: DiscoveredTool;
  run(
    args: Run17dzTaskArgs,
    ctx: ContextTaskExecutionContext,
    signal?: AbortSignal,
  ): Promise<SubagentTaskResult>;
  /**
   * 确认码/取消码匹配：命中则由服务端直接执行或作废并返回回复（绕过模型）；
   * 未命中返回 null，消息按正常流程进入模型。
   *
   * 回复带结构化 outcome（2026-09 第二波）：turn_span 的日志分类从数据里取，
   * 不再嗅探自己刚生成的回复文本（旧实现拿回复 includes 一句"已作废"来分类，
   * 会把"取消一个已作废的码"误记成 confirm_cancelled——那一轮什么都没发生）。
   */
  matchConfirmation?(ctx: TrustedContext, message: string): Promise<ConfirmationReply | null>;
  /**
   * 把一次委派的**用户可见结果文本**回写任务条目（D-065 结构化事实的兜底渲染源）。
   *
   * 为什么由 runtime 调：这段文本与 Conversation Log 的 tool_result 事件同文（宿主组装
   * 的转达/交还材料），只有 runtime 知道最终形态；任务条目由此自含"这次委派用户看到了
   * 什么"，召回台账才能在结构化字段缺失时降级渲染它。存储失败只记日志——事实回写是
   * 增强，不回写不该让回合失败。
   */
  recordTaskResult?(taskId: string, facts: { resultText: string }): Promise<void>;
}

/**
 * 确认码匹配的结构化结局（替代回复文本嗅探）：
 *   · confirm_executed：确认码命中待确认提案且落账完成；
 *   · confirm_cancelled：取消码命中待确认提案且作废完成；
 *   · confirm_failed：确认/落账链路失败（执行器未配置或落账未完成，意图置 failed）；
 *   · confirm_held：确认收到但落账执行未启用，提案保持待确认（无状态变化）；
 *   · confirm_stale：码已终结，给出确定性解释（无状态变化）。
 */
export type ConfirmationOutcome =
  | 'confirm_executed'
  | 'confirm_cancelled'
  | 'confirm_failed'
  | 'confirm_held'
  | 'confirm_stale';

export interface ConfirmationReply {
  text: string;
  outcome: ConfirmationOutcome;
}

export const RUN_17DZ_TASK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['request'],
  additionalProperties: false,
  properties: {
    request: { type: 'string', minLength: 1, description: '交给 17dz 子 Agent 的完整任务或用户最新补充' },
    taskId: { type: 'string', description: '仅在继续此前 17dz 子任务时使用返回的 taskId' },
  },
};

/** 变更提案（worker 按 17dz-bookkeeping-prepare 技能产出的冻结载荷）。 */
export interface ChangeProposal {
  type: 'change_proposal';
  domain: 'voucher';
  accountSet: string;
  period: string;
  contracts: unknown[];
  summary: { count: number; debit: number; credit: number };
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CONFIRM_RE = /确认\s*([A-Z0-9]{6})/;
const CANCEL_RE = /取消\s*([A-Z0-9]{6})/;

function defaultGenerateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function defaultHashCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
}

/** 从 worker 文本提取并结构校验提案；不合法一律视为普通回答。 */
export function extractChangeProposal(text: string, maxBatchCount: number): ChangeProposal | null {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!);
  candidates.push(text.trim());
  for (const raw of candidates) {
    if (!raw.startsWith('{')) continue;
    try {
      const p = JSON.parse(raw) as ChangeProposal;
      if (
        p.type === 'change_proposal'
        && p.domain === 'voucher'
        && typeof p.accountSet === 'string' && p.accountSet.trim() !== ''
        && typeof p.period === 'string' && /^\d{6}$/.test(p.period)
        && Array.isArray(p.contracts) && p.contracts.length > 0 && p.contracts.length <= maxBatchCount
        && p.summary && typeof p.summary.count === 'number' && p.summary.count === p.contracts.length
        && typeof p.summary.debit === 'number' && typeof p.summary.credit === 'number'
      ) {
        return p;
      }
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/**
 * 把驱动上报的结构化事实（D-065）合并进任务条目：calls/accountSet/period/label 取本次
 * 委派的快照（替换式——任务的最新范围），resultText 追加（同一任务多次委派的结果 trail，
 * 上限见 RESULT_TEXT_MAX_CHARS），outcome 由委派结局定。全部字段可选——缺一个就不写一个，
 * 消费方据此降级，不猜不补。
 */
const RESULT_TEXT_MAX_CHARS = 2_000;

function withExecutionFacts(
  running: PlatformTaskRecord,
  result: TurnDriverResult,
  outcome: PlatformTaskRecord['outcome'],
): PlatformTaskRecord {
  const facts = result.planFacts;
  const resultText = [running.resultText, result.text.trim()].filter(Boolean).join('\n').slice(-RESULT_TEXT_MAX_CHARS);
  return {
    ...running,
    outcome,
    ...(facts ? {
      calls: facts.calls.map((call) => ({ operation: call.operation, args: call.args })),
      ...(facts.accountSet ? { accountSet: facts.accountSet } : {}),
      ...(facts.period ? { period: facts.period } : {}),
      ...(facts.label ? { label: facts.label } : {}),
    } : {}),
    ...(resultText ? { resultText } : {}),
  };
}

export function createContextTaskRunner(options: ContextTaskRunnerOptions): ContextTaskRunner {
  const profileId = options.profileId ?? '17dz';
  const maxBatchCount = options.maxBatchCount ?? 50;
  const intentTtlMs = options.intentTtlMs ?? 10 * 60_000;
  const generateCode = options.generateCode ?? defaultGenerateCode;
  const hashCode = options.hashCode ?? defaultHashCode;
  // ── 下游平台保护（并发闸）────────────────────────────────────────────
  // 真实平台的浏览器是共享登录态的持久 profile（launchPersistentContext）：
  // 并发委派会多开 Chrome 抢同一 profile——那正是"被平台感知"的典型方式
  // （会话互踢、登录态竞争、行为像自动化）。默认全局串行，可用
  // FSHINE_PLATFORM_CONCURRENCY 放宽。排队只增加等待，不影响正确性；
  // 速率另由平台侧 DZ_RATE_LIMIT 令牌桶控制（read/global/api 分类）。
  const platformLimit = Math.max(1, Number.parseInt(process.env.FSHINE_PLATFORM_CONCURRENCY ?? '', 10) || 1);
  let platformActive = 0;
  const platformWaiters: Array<() => void> = [];
  function releasePlatformSlot(): void {
    platformActive -= 1;
    const next = platformWaiters.shift();
    if (next) next();
  }
  async function acquirePlatformSlot(requestId: string, queuedSince: number): Promise<() => void> {
    if (platformActive < platformLimit) {
      platformActive += 1;
      return releasePlatformSlot;
    }
    await new Promise<void>((resolve) => platformWaiters.push(resolve));
    platformActive += 1; // 取走 releaser 刚释放的份额
    console.info(JSON.stringify({ event: 'platform_delegation_queued', requestId, waitedMs: Date.now() - queuedSince }));
    return releasePlatformSlot;
  }
  const tool: DiscoveredTool = {
    name: RUN_17DZ_TASK_TOOL,
    description: RUN_17DZ_TASK_DESCRIPTION,
    inputSchema: RUN_17DZ_TASK_SCHEMA,
  };

  /**
   * 提案落账前的宿主持结构化结局（2026-09 第二波）：日志分类从数据里取，
   * 不再嗅探回复文本（旧实现拿回复 includes 两句中文来分类）。授权名单限制模式与
   * 未开放写入权限同归 proposal_declined——两者都是确定性拒绝，旧实现把前者算成
   * proposal_created（文本里两个关键词都不含），日志因此说谎。
   */
  type ProposalOutcome = 'proposal_declined' | 'proposal_precheck_failed' | 'proposal_created';

  async function finalizeProposal(
    proposal: ChangeProposal,
    ctx: ContextTaskExecutionContext,
    taskId: string,
  ): Promise<{ result: SubagentTaskResult; outcome: ProposalOutcome }> {
    const ci = options.changeIntents!;
    const stop = (text: string, outcome: ProposalOutcome) => ({ result: { taskId, text }, outcome });

    const capabilities = ctx.trusted.capabilities ?? [];
    if (!capabilities.includes('write')) {
      // 写关闭话术唯一来源在 error-codes.ts（WRITE_NOT_ENABLED）：与计划门拒绝路径
      // （pi-coding-driver 的 evaluate 失败分支）共用同一句，不造第二份。
      return stop(`已收到录入提案，但${messageTextFor('WRITE_NOT_ENABLED')}`, 'proposal_declined');
    }
    // allowlist principal 的授权以对象 id 表达，而提案携带平台侧名称——
    // 名称到 id 的映射不在 fshine 侧，V1 仅对 scope=all 的账号开放写。
    if (ctx.trusted.allowedAccountSetIds.length > 0) {
      return stop('已收到录入提案，但当前账号为授权名单限制模式，写开放暂不支持该模式，已停止。', 'proposal_declined');
    }

    const active = await options.changeIntents!.findPendingBySession(ctx.trusted.principalId, ctx.trusted.sessionId);
    const intentId = `intent_${randomUUID()}`;
    const prepareRunner = options.prepareRunner;
    if (!prepareRunner) throw new ToolUserError('写流程未配置预检执行器。');
    const prep = await prepareRunner({ intentId, accountSet: proposal.accountSet, period: proposal.period, contracts: proposal.contracts });
    if (!prep.ok) {
      console.warn(JSON.stringify({ event: 'change_proposal_precheck_failed', intentId, taskId }));
      return stop(`变更提案未通过预检（dry-run），未创建待确认任务。原因摘要：${truncate(prep.error || prep.output, 300)}`, 'proposal_precheck_failed');
    }
    if (active) await ci.updateStatus(active.intentId, 'superseded');

    const code = generateCode();
    const now = new Date();
    const record: ChangeIntentRecord = {
      intentId,
      principalId: ctx.trusted.principalId,
      sessionId: ctx.trusted.sessionId,
      kind: 'voucher.batch',
      accountSet: proposal.accountSet,
      period: proposal.period,
      payload: proposal,
      summary: { count: proposal.summary.count, debit: proposal.summary.debit, credit: proposal.summary.credit },
      confirmCodeHash: hashCode(code),
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + intentTtlMs).toISOString(),
    };
    await ci.create(record);
    const ttlMinutes = Math.round(intentTtlMs / 60_000);
    const confirmLine = options.commitEnabled
      ? `回复「确认 ${code}」执行录入；回复「取消 ${code}」作废。${ttlMinutes} 分钟内有效。`
      : `回复「确认 ${code}」完成确认流程（当前落账执行未启用——确认不会写入任何数据）；回复「取消 ${code}」作废。${ttlMinutes} 分钟内有效。`;
    return stop([
      '已收到录入提案并通过预检（dry-run）：',
      `- 对象：${proposal.accountSet}`,
      `- 时间：${proposal.period}`,
      `- 条目：${proposal.summary.count} 条，借贷合计各 ${proposal.summary.credit} 元`,
      confirmLine,
    ].join('\n'), 'proposal_created');
  }

  return {
    tool,
    // D-065：结果原文回写。get→合并→upsert（保留结构化字段，只补 resultText）；
    // 失败只记日志——事实回写是增强，不该让回合失败。
    recordTaskResult: async (taskId, facts) => {
      try {
        const existing = await options.tasks.get(taskId);
        if (!existing) return;
        const appended = [existing.resultText, facts.resultText.trim()].filter(Boolean).join('\n').slice(-RESULT_TEXT_MAX_CHARS);
        await options.tasks.upsert({ ...existing, ...(appended ? { resultText: appended } : {}), updatedAt: new Date().toISOString() });
      } catch (error) {
        console.warn(JSON.stringify({ event: 'platform_task_result_record_failed', taskId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }));
      }
    },
    matchConfirmation: async (ctx, message): Promise<ConfirmationReply | null> => {
      const ci = options.changeIntents;
      if (!ci) return null;
      const now = new Date();

      const cancelM = message.match(CANCEL_RE);
      if (cancelM) {
        const hash = hashCode(cancelM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          await ci.updateStatus(rec.intentId, 'cancelled');
          return { text: `已作废：${rec.accountSet} ${rec.period} 的录入提案（${rec.summary.count} 条）未执行。`, outcome: 'confirm_cancelled' };
        }
        const stale = await ci.findByCodeHash(ctx.principalId, ctx.sessionId, hash);
        if (!stale) return null;
        const why: Record<ChangeIntentRecord['status'], string> = {
          pending: '仍在等待确认',
          committed: '已完成录入',
          expired: '已过期',
          cancelled: '已作废',
          superseded: '已被更新的提案取代',
          failed: '执行失败',
        };
        return { text: `该确认码对应的提案${why[stale.status]}，无需取消。`, outcome: 'confirm_stale' };
      }

      const confirmM = message.match(CONFIRM_RE);
      if (confirmM) {
        const hash = hashCode(confirmM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          if (!options.commitEnabled) {
            return { text: '确认已收到。当前落账执行未启用（对真实平台的写入需显式开启），本次未写入任何数据；提案保持待确认，如需作废请回复「取消 <确认码>」或等待其过期。', outcome: 'confirm_held' };
          }
          const commitRunner = options.commitRunner;
          if (!commitRunner) {
            await ci.updateStatus(rec.intentId, 'failed', { error: 'commit runner 未配置' });
            return { text: '执行失败：落账执行器未配置，请联系管理员。', outcome: 'confirm_failed' };
          }
          const contracts = (rec.payload as ChangeProposal).contracts;
          const out = await commitRunner({ intentId: rec.intentId, accountSet: rec.accountSet, period: rec.period, contracts });
          if (!out.ok) {
            console.error(JSON.stringify({ event: 'change_intent_commit_failed', intentId: rec.intentId, taskIdCorrelate: rec.sessionId }));
            await ci.updateStatus(rec.intentId, 'failed', { output: out.output.slice(0, 2000), error: out.error });
            return { text: '执行失败：落账未完成，系统已停止并留痕。请联系管理员核对平台实际状态后，再重新发起录入。', outcome: 'confirm_failed' };
          }
          await ci.updateStatus(rec.intentId, 'committed', { output: out.output.slice(0, 2000) });
          return { text: `已完成：${rec.summary.count} 条已录入（${rec.accountSet} ${rec.period}），读回校验通过。`, outcome: 'confirm_executed' };
        }
        // 码存在但已终结 → 确定性答复（散漫用法高频：拿到预览后被别的事打断）；
        // 码完全未知 → 走模型（普通对话里出现"确认 XX"字样不算数）。
        const stale = await ci.findByCodeHash(ctx.principalId, ctx.sessionId, hash);
        if (!stale) return null;
        const why: Record<ChangeIntentRecord['status'], string> = {
          pending: '仍在等待确认',
          committed: '已完成录入',
          expired: '已过期（超过有效期），请重新发起录入',
          cancelled: '已作废',
          superseded: '已被更新的提案取代，确认最新的提案即可',
          failed: '执行失败，请联系管理员核对后重新发起',
        };
        return { text: `该确认码对应的提案${why[stale.status]}。`, outcome: 'confirm_stale' };
      }
      return null;
    },
    async run(args, ctx, signal) {
      if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
        throw toolUserErrorFor('TASK_REQUEST_EMPTY');
      }
      if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.trim() === '')) {
        throw toolUserErrorFor('TASK_ID_INVALID');
      }

      const profile = await resolveContextProfile(options.profiles, profileId);
      // continueTaskId 查不到就抛 ToolUserError——不猜、不兜底。宿主只保证两件事：
      // 错误永远诚实可行动、爆炸永远有界。"这个会话里有几个开放任务"宿主确实知道，
      // 但"模型想续的是哪一个"只有模型知道；替它猜（哪怕恰一个时猜对）就是把重试的
      // 职责从模型手里拿回来，猜错时用户的问题会被静默送进别的子任务。编号无效时说清
      // 编号无效、并给出下一步动作（措辞在 error-codes.ts 表里），模型下一轮自己改。
      const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
      if (args.taskId && !existing) throw toolUserErrorFor('TASK_NOT_FOUND');
      if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
        throw toolUserErrorFor('TASK_FORBIDDEN');
      }

      // 计划模式（Phase 6）：这一步的计划门通知带上「第 N/M 步」前缀交付用户——
      // 用户因此看到"现在在拆解的第几步"，而不是一条没有上下文的孤立通知。
      // 前缀插在固定标记之后，渠道与 e2e 替身仍按「计划通知：」识别这是通知帧。
      const stepLabel = typeof args.stepLabel === 'string' ? args.stepLabel.trim() : '';
      const trustedNotice = ctx.trusted.onNotice;
      const onNotice = trustedNotice
        ? stepLabel
          ? async (text: string) => { await trustedNotice(withStepLabel(text, stepLabel)); }
          : trustedNotice
        : undefined;
      const taskId = existing?.taskId ?? `task_${randomUUID()}`;
      const running: PlatformTaskRecord = {
        taskId,
        parentSessionId: ctx.trusted.sessionId,
        principalId: ctx.trusted.principalId,
        workerMessages: existing?.workerMessages ?? [],
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await options.tasks.upsert(running);

      const messages = [
        ...((existing?.workerMessages ?? []) as DriverMessage[]),
        { role: 'user', content: args.request, timestamp: Date.now() } as unknown as DriverMessage,
      ];
      let result: TurnDriverResult | undefined;
      const delegationStart = Date.now();
      const deadline = delegationStart + (profile.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
      try {
        // 并发闸：worker 会话期间独占下游平台（默认全局串行，见文件顶部说明）
        const release = await acquirePlatformSlot(ctx.trusted.requestId, delegationStart);
        try {
          result = await options.workerDriver.run({
            systemPrompt: workerSystemPrompt(profile.root, ctx.trusted.allowedAccountSetIds, args.turnDeclaration),
            tools: [],
            messages,
            cwd: profile.root,
            skillRoots: profile.skillRoots,
            sessionId: taskId,
            requestId: ctx.trusted.requestId,
            onStep: ctx.trusted.onStep ?? (() => {}),
            exec: async () => { throw new ToolUserError('17dz 子 Agent 只能使用其工作目录内配置的原生工具。'); },
            deadline,
            signal,
            ...(args.turnDeclaration ? { turnDeclaration: args.turnDeclaration } : {}),
            ...(args.entitySources ? { entitySources: args.entitySources } : {}),
            ...(profile.knowledgePaths ? { knowledgePaths: profile.knowledgePaths } : {}),
            ...(profile.sensitivePaths ? { sensitivePaths: profile.sensitivePaths } : {}),
            ...(onNotice ? { onNotice } : {}),
          });
        } finally {
          release();
        }
        if (!result.text.trim()) throw new Error(signal?.aborted ? '17dz 子任务已取消。' : '17dz 子 Agent 未返回可用结果。');
        if (result.pendingPlan) {
          const pendingPlan: PendingPlanConfirmation = {
            ...result.pendingPlan,
            taskId,
            principalId: ctx.trusted.principalId,
            sessionId: ctx.trusted.sessionId,
            requestId: ctx.trusted.requestId,
          };
          await options.tasks.upsert({
            ...running,
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          if (!ctx.trusted.onPlanPending) throw toolUserErrorFor('PLAN_PENDING_PERSIST_MISSING');
          await ctx.trusted.onPlanPending({
            planId: pendingPlan.planId,
            version: pendingPlan.version,
            taskId,
            principalId: ctx.trusted.principalId,
            sessionId: ctx.trusted.sessionId,
            requestId: ctx.trusted.requestId,
            userText: result.pendingPlan.userText,
          });
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'plan_confirmation_pending' }));
          return { taskId, text: result.text, pendingPlan, ...(result.execution ? { execution: result.execution } : {}) };
        }
        // 纠错环（架构 §3）：worker 执行不了，回报"缺什么/为什么/建议用户提供什么"。
        // 任务保持可续（taskId 已知会宿主侧，用户补充后经 continueTaskId 重派），
        // 线索原样上交，由 Main Agent 决定自己补齐还是转告用户。这一轮零执行，
        // 因此没有执行面注脚可拼（注脚只描述真实发生过的网关调用）。
        if (result.needs) {
          await options.tasks.upsert({
            ...withExecutionFacts(running, result, 'needs'),
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'needs_input' }));
          return { taskId, text: result.text, needs: result.needs };
        }
        const proposal = options.changeIntents ? extractChangeProposal(result.text, maxBatchCount) : null;
        if (proposal) {
          const handled = await finalizeProposal(proposal, ctx, taskId);
          await options.tasks.upsert({
            ...running,
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          // 日志分类从结构化 outcome 取（2026-09 第二波）：不再嗅探回复文本
          // （旧实现拿回复 includes 两句中文给 outcome 分类，连字面量 if 预算都报了）。
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: handled.outcome }));
          return handled.result;
        }
        const final: SubagentTaskResult = {
          taskId,
          ...(result.execution ? { execution: result.execution } : {}),
          // 收尾兜底（P1）：批准了但零执行，原样上交——宿主需要这个事实才能说对状态
          ...(result.activatedPlan ? { activatedPlan: result.activatedPlan } : {}),
          // 结构化歧义/未找到：平台请用户"选一个"的澄清事实，原样上交——宿主据此机械
          // 组装澄清问题（与 needs 同一族的结构化上交，模型不参与翻译）。
          ...(result.clarification ? { clarification: result.clarification } : {}),
          // 执行面回执：主 Agent 的重量反馈（系统元数据，提示词约定不转述给用户）。
          // 必须拼在 extractChangeProposal 之后——尾部注脚会破坏"整段纯 JSON"提案候选。
          text: result.footprint ? `${result.text}\n\n〔本轮执行面：${result.footprint}〕` : result.text,
        };
        await options.tasks.upsert({
          ...withExecutionFacts(running, result, result.execution ? 'done' : 'failed'),
          workerMessages: result.messages as unknown[],
          updatedAt: new Date().toISOString(),
        });
        console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'ok' }));
        return final;
      } catch (error) {
        // 已经是面向用户的安全话术（ToolUserError 语义 = 这段文本成为本轮回复）时
        // 原样抛出：配置故障（如 onPlanPending 缺失）有自己精确的话术，再套一层
        // "执行失败请稍后再试"就是把部署漏配伪装成平台抖动——用户重试多少次都不会好
        // （③-3：宿主不猜但也没对齐用户的那类去向）。
        if (error instanceof ToolUserError) throw error;
        // 失败分类的判定顺序即优先级：取消（用户/上层主动中止）先于超时（时间到了），
        // 再看登录态。同一时刻可能多个条件成立，取最贴近用户动作的那个。
        // 登录态判定以**码**为准（isPlatformAuthError：信封/挂码/码前缀，见
        // platform-contract.ts 的 auth 码集合）。下面那条中文正则是**过渡**：平台
        // auth.js 的自动重登录失败消息（"平台登录已过期，自动登录失败——…"）是既有
        // 唯一不带码前缀的形态，17dz 侧尚未给它挂码；在平台收口之前先留正则兜底，
        // 否则那一条会退化成 executor_error——而"请稍后再试"对 auth 是错指令。
        // 平台侧该消息一带码（走 messageFor），这行即可删除。
        const failureClass = signal?.aborted ? 'cancelled'
          : Date.now() >= deadline ? 'timeout'
          : isPlatformAuthError(error) ? 'auth'
          : /平台登录已过期/.test(error instanceof Error ? error.message : '') ? 'auth'
          : 'executor_error';
        console.info(JSON.stringify({
          event: 'delegation_span',
          requestId: ctx.trusted.requestId,
          taskId,
          durationMs: Date.now() - delegationStart,
          outcome: 'failed',
          failureClass,
        }));
        console.error(JSON.stringify({
          event: 'subagent_task_failed',
          taskId,
          failureClass,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        // 超时/失败也持久化本轮已产生的中间转录：taskId 续跑从断点继续，
        // 而不是从零重付全部时间与浏览器占用（长任务业务稳定性的关键）。
        await options.tasks.upsert({
          ...withExecutionFacts(running, result ?? { text: '', messages: [] }, 'failed'),
          ...(result?.messages?.length ? { workerMessages: result.messages as unknown[] } : {}),
          updatedAt: new Date().toISOString(),
        });
        throw new ToolUserError(signal?.aborted ? DELEGATION_CANCELLED
          : failureClass === 'auth' ? DELEGATION_AUTH_FAILURE
          : failureClass === 'timeout' ? DELEGATION_TIMEOUT_FAILURE
          : DELEGATION_EXECUTOR_FAILURE);
      }
    },
  };
}

/**
 * 给计划门通知加步骤前缀（计划模式）。固定标记保持在最前——渠道适配器与测试替身
 * 都按它识别"这是一条计划通知"；步骤标签紧跟其后，用户先看到"第几步"再看范围。
 */
export function withStepLabel(text: string, stepLabel: string): string {
  const tag = `【${stepLabel}】`;
  if (!stepLabel) return text;
  if (!text.startsWith(PLAN_NOTICE_PREFIX)) return `${tag}${text}`;
  return `${PLAN_NOTICE_PREFIX}${tag}${text.slice(PLAN_NOTICE_PREFIX.length)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text;
}

async function resolveContextProfile(profiles: Record<string, ContextProfileConfig>, id: string): Promise<ResolvedContextProfile> {
  const configured = profiles[id];
  if (!configured) throw new ToolUserError(`未配置 17dz 上下文 profile:${id}`);
  const root = await fs.realpath(configured.root).catch(() => { throw new ToolUserError(`17dz 上下文目录不可用:${id}`); });
  const skillRoots: string[] = [];
  for (const relative of configured.skillRoots) {
    if (path.isAbsolute(relative)) throw new ToolUserError('17dz skillRoots 必须是相对 root 的路径。');
    const resolved = await fs.realpath(path.join(root, relative)).catch(() => undefined);
    if (!resolved || !isInside(root, resolved)) throw new ToolUserError('17dz skillRoots 未通过路径安全校验。');
    skillRoots.push(resolved);
  }
  return {
    root,
    skillRoots,
    workerTimeoutMs: configured.workerTimeoutMs,
    ...(configured.knowledgePaths ? { knowledgePaths: configured.knowledgePaths } : {}),
    ...(configured.sensitivePaths ? { sensitivePaths: configured.sensitivePaths } : {}),
  };
}

interface ResolvedContextProfile {
  root: string;
  skillRoots: string[];
  workerTimeoutMs?: number;
  knowledgePaths?: string[];
  sensitivePaths?: string[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workerSystemPrompt(
  root: string,
  allowedAccountSetIds: readonly string[],
  turnDeclaration?: Extract<TurnDeclaration, { kind: 'delegate' }>,
): string {
  const scope = allowedAccountSetIds.length > 0
    ? `调用者的应用层授权名单：${allowedAccountSetIds.join(', ')}。不得查询或操作名单外对象。`
    : '应用层未提供授权名单；访问范围必须以平台领域脚本的权限校验为准。';
  return [
    '你是 幻账平台任务子 Agent，在受信工作目录中执行一项具体任务。最终回复会原样展示给最终用户——直接对用户说话；不要输出内部协议文案（"给主 Agent 的说明"、宿主、委派、route_current_turn、PLAN ACTIVE/DECLINED 等字样和状态 JSON 不允许）。',
    // 回复语域契约（2026-09-27 Stage 3 事故根治包）：格式规范，不是行为恳求。你的工作上下文
    // 全部泡在执行语言里（协议命令 / SKILL 文档 / 信封错误码），你是执行语言与用户语言之间
    // 唯一的翻译器——压力下翻译退化，执行语言就越界进最终回复（实测：一次结构化歧义被写成
    // 1201 字符技术报告，脚本路径、原始错误码、门的规则引述全上屏）。宿主已改为替你把结构化
    // 平台状态组装成用户消息；你只需要为"数据答案"发声，别把内部语言带进回复。
    '最终回复面向用户——只说结论和需要用户给什么；脚本路径、错误码、JSON、平台门的规则是内部语言，不得出现在回复里；证据最多一行来源标注。',
    `平台工作目录：${root}`,
    '先按 Pi 的 Skill 机制读取相关 SKILL.md、MECHANISMS.md 和契约说明，再调用其中指定的领域脚本；实时数据必须来自领域脚本结果，不得编造。',
    '按平台 SKILL 与 operation 文档声明的能力边界执行：只做 Skill 与 operation 文档支持的操作，超出能力边界的请求直接如实报告，不要换口径试探。写操作由服务端在用户确认后执行。',
    `执行前必须先提交精确执行方案：第一条 bash 命令为单行 JSON——${planDraftExample()}，calls 逐项列出准备执行的 operation 及原生参数（args 为字符串数组，即命令行原样参数，如 ["--query","某公司全称","--period","202609"]），照 Skill/operation 文档填写。PLAN ACTIVE 后才能查询；PLAN DECLINED 可按平台原因修正后重提；PLAN NEEDS_USER_CONFIRM 或 PLAN PAUSED 必须结束回合，等待宿主验证真实用户确认；PLAN STOP 直接说明停止原因。范围扩大时重新提交完整 calls。`,
    // 调用形式纪律（B1-fshine）：平台调用只认网关这一种形状。这里刻意只给占位符——
    // 具体脚本路径以平台 Skill 文档为准，写死任何一条示例都会随平台演进过期，
    // 也会把平台实现细节带进编排层（泄漏 lint 的 FORBIDDEN 名单）。
    `平台调用必须走网关形式 \`${GATEWAY_INVOCATION} query <脚本路径> --<flag> 值\`：脚本路径用平台 Skill/operation 文档给出的完整相对路径（带域目录前缀，照文档逐字抄），flag 用 kebab-case 短横线；不要写裸名、驼峰或 \`--flag=值\` 之类等号变形，也不要绕过网关直调脚本。`,
    // 回复语域契约三条（2026-09-27 第三波，手机实测补漏）：Stage 3 根治包只挡住了"协议命令/
    // 信封错误码/JSON"那几条粗漏，实测里更细的三样执行层语言仍会越界进最终回复——operation
    // 名当数据来源标注、宿主计划门的内部控制状态当"说明"、用户没问的能力边界主动交代。
    // 三条都是格式规范（说什么形状的话），不是行为恳求；宿主侧同一把尺由 runtime.ts 的
    // EXECUTION_LANGUAGE_FINGERPRINTS 与探针断言机械执行。
    // ① 来源标注纪律：用户不需要知道接口标识符。"平台实时查询"已足够证明数据
    //    不是编的；写出 operation 名/接口名/脚本名只会把内部语言带上屏。
    '来源标注纪律：回复里标注数据来源时只能说“平台实时查询”这类中性表述，不得出现 operation 名、接口名或脚本名（如 finance.query-receivables、query-receivables.js）。',
    // ② 内部控制不上屏：计划额度、拒绝次数、熔断、计划门、重试上限是宿主/平台的内部
    //    控制状态，对用户"下一步做什么"没有任何帮助——实测里它被当成"说明"交出去，
    //    反而像在推卸。因内部限制停顿时只说事实与出路，不说机制。
    '内部控制不上屏：计划额度、拒绝次数、熔断、计划门、重试上限等宿主或平台的内部控制状态不得出现在回复里；因内部限制停顿时，说“本次查询未能继续”并告诉用户能做什么（如“请重新发起”），不得说明内部机制。',
    // ③ 不主动交代表能力边界：诚实不等于全说。用户没问到的口径，接口不支持就不是他
    //    需要知道的事——主动交代整段边界说明只是噪音；问到该口径时才如实说明。
    '不主动交代表能力边界：只回答用户问到的内容；接口能力边界（不支持某口径）仅在用户问到该口径时才说明。',
    ...(turnDeclaration ? [`宿主已核验本轮请求；严格按此执行，不得扩大范围或从其他历史内容补范围：${turnDeclaration.request}`] : []),
    '知识只经 read 读取固定知识面：SKILL.md、MECHANISMS.md、*.schema.json；实现源码不可读。',
    scope,
    '缺少信息或执行不了时，直接用自然语言向用户说明缺什么、为什么做不了、建议用户提供什么；完成时直接给出结论、数据和来源证据。',
    '只能执行宿主批准的计划内的调用。能力不足、结果不确定或计划被拒时，如实说明看到的事实并停止；不要换口径试探，也不要代替用户做选择。',
  ].join('\n\n');
}
