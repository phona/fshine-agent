/**
 * Thin adapter from the main Agent to a Pi subagent rooted in a trusted
 * platform workspace. The subagent returns natural language; the main Agent
 * decides whether to answer, ask the user, or resume the same session.
 *
 * 写开放（两步确认）：worker 产出变更提案 JSON → 本层做 capability/账套
 * 代码级校验 + 服务端 dry-run 预检 → 创建 pending intent（确认码哈希存储）
 * → 主代理转达预览。用户回复「确认 码」由 matchConfirmation 直接匹配执行
 * （绕过模型）；「取消 码」作废；新提案使旧 pending 作废（superseded）。
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverMessage, TurnDriver } from './driver';
import type { PendingPlanConfirmation } from './plan-runtime';
import type { TaskIntent } from './task-intent';
import { ToolUserError, type TurnDriverResult } from './driver';
import type {
  AgentReply,
  ChangeIntentRecord,
  ChangeIntentRepo,
  ContextProfileConfig,
  DiscoveredTool,
  PlatformTaskRecord,
  PlatformTaskRepo,
  TrustedContext,
} from '@fshine/contracts';

export const RUN_17DZ_TASK_TOOL = 'run_17dz_task';
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

export const RUN_17DZ_TASK_DESCRIPTION = [
  '当用户的问题需要访问或处理 幻账平台中的真实财税数据时，将任务委托给 17dz 子 Agent。',
  '子 Agent 在受信的 17dz-platform 工作目录中加载平台 Skill，并返回自然语言结果。',
  '你负责理解该结果：可以直接回答用户、把子 Agent 的问题转达给用户，或携带 taskId 继续同一个任务。',
  '涉及 17dz 实时数据时必须调用本工具，不得凭历史对话猜测账套 ID、科目编码、客户 ID 或实时结果。',
  '继续同一任务时传入此前返回的 taskId，并把用户最新补充完整放入 request；新任务不要复用 taskId。',
].join('\n');

export interface Run17dzTaskArgs {
  request: string;
  taskId?: string;
  /** Host-only semantic intent; this is never part of the Main Agent tool schema. */
  taskIntent?: Extract<TaskIntent, { kind: 'platform_query' }>;
}

export interface SubagentTaskResult {
  taskId: string;
  text: string;
  pendingPlan?: PendingPlanConfirmation;
}

/** 服务端预检（dry-run）注入点：默认实现由部署层提供（直调平台网关 bin/17dz prepare）。 */
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
  /** 单提案凭证张数上限，默认 50。 */
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
   */
  matchConfirmation?(ctx: TrustedContext, message: string): Promise<AgentReply | null>;
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

export function createContextTaskRunner(options: ContextTaskRunnerOptions): ContextTaskRunner {
  const profileId = options.profileId ?? '17dz';
  const maxBatchCount = options.maxBatchCount ?? 50;
  const intentTtlMs = options.intentTtlMs ?? 10 * 60_000;
  const generateCode = options.generateCode ?? defaultGenerateCode;
  const hashCode = options.hashCode ?? defaultHashCode;
  const tool: DiscoveredTool = {
    name: RUN_17DZ_TASK_TOOL,
    description: RUN_17DZ_TASK_DESCRIPTION,
    inputSchema: RUN_17DZ_TASK_SCHEMA,
  };

  async function finalizeProposal(
    proposal: ChangeProposal,
    ctx: ContextTaskExecutionContext,
    taskId: string,
  ): Promise<SubagentTaskResult> {
    const ci = options.changeIntents!;
    const stop = (text: string) => ({ taskId, text });

    const capabilities = ctx.trusted.capabilities ?? [];
    if (!capabilities.includes('write')) {
      return stop('已收到录入提案，但当前账号未开放写入权限，已停止。请联系管理员开通后重试。');
    }
    // allowlist principal 的授权以账套 id 表达，而提案携带平台账套名——
    // 名称到 id 的映射不在 fshine 侧，V1 仅对 scope=all 的账号开放写。
    if (ctx.trusted.allowedAccountSetIds.length > 0) {
      return stop('已收到录入提案，但当前账号为账套白名单授权模式，写开放暂不支持该模式，已停止。');
    }

    const active = await options.changeIntents!.findPendingBySession(ctx.trusted.principalId, ctx.trusted.sessionId);
    const intentId = `intent_${randomUUID()}`;
    const prepareRunner = options.prepareRunner;
    if (!prepareRunner) throw new ToolUserError('写流程未配置预检执行器。');
    const prep = await prepareRunner({ intentId, accountSet: proposal.accountSet, period: proposal.period, contracts: proposal.contracts });
    if (!prep.ok) {
      console.warn(JSON.stringify({ event: 'change_proposal_precheck_failed', intentId, taskId }));
      return stop(`变更提案未通过预检（dry-run），未创建待确认任务。原因摘要：${truncate(prep.error || prep.output, 300)}`);
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
      `- 账套：${proposal.accountSet}`,
      `- 期间：${proposal.period}`,
      `- 凭证：${proposal.summary.count} 张，借贷合计各 ${proposal.summary.credit} 元`,
      confirmLine,
    ].join('\n'));
  }

  return {
    tool,
    matchConfirmation: async (ctx, message) => {
      const ci = options.changeIntents;
      if (!ci) return null;
      const now = new Date();

      const cancelM = message.match(CANCEL_RE);
      if (cancelM) {
        const hash = hashCode(cancelM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          await ci.updateStatus(rec.intentId, 'cancelled');
          return { text: `已作废：${rec.accountSet} ${rec.period} 的录入提案（${rec.summary.count} 张）未执行。` };
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
        return { text: `该确认码对应的提案${why[stale.status]}，无需取消。` };
      }

      const confirmM = message.match(CONFIRM_RE);
      if (confirmM) {
        const hash = hashCode(confirmM[1]!);
        const rec = await ci.findPendingByConfirm(ctx.principalId, ctx.sessionId, hash, now);
        if (rec) {
          if (!options.commitEnabled) {
            return { text: '确认已收到。当前落账执行未启用（对真实平台的写入需显式开启），本次未写入任何数据；提案保持待确认，如需作废请回复「取消 <确认码>」或等待其过期。' };
          }
          const commitRunner = options.commitRunner;
          if (!commitRunner) {
            await ci.updateStatus(rec.intentId, 'failed', { error: 'commit runner 未配置' });
            return { text: '执行失败：落账执行器未配置，请联系管理员。' };
          }
          const contracts = (rec.payload as ChangeProposal).contracts;
          const out = await commitRunner({ intentId: rec.intentId, accountSet: rec.accountSet, period: rec.period, contracts });
          if (!out.ok) {
            console.error(JSON.stringify({ event: 'change_intent_commit_failed', intentId: rec.intentId, taskIdCorrelate: rec.sessionId }));
            await ci.updateStatus(rec.intentId, 'failed', { output: out.output.slice(0, 2000), error: out.error });
            return { text: '执行失败：落账未完成，系统已停止并留痕。请联系管理员核对平台实际状态后，再重新发起录入。' };
          }
          await ci.updateStatus(rec.intentId, 'committed', { output: out.output.slice(0, 2000) });
          return { text: `已完成：${rec.summary.count} 张凭证已录入（${rec.accountSet} ${rec.period}），读回校验通过。` };
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
        return { text: `该确认码对应的提案${why[stale.status]}。` };
      }
      return null;
    },
    async run(args, ctx, signal) {
      if (!args || typeof args.request !== 'string' || args.request.trim() === '') {
        throw new ToolUserError('17dz 任务不能为空。');
      }
      if (args.taskId !== undefined && (typeof args.taskId !== 'string' || args.taskId.trim() === '')) {
        throw new ToolUserError('17dz taskId 无效。');
      }

      const profile = await resolveContextProfile(options.profiles, profileId);
      const existing = args.taskId ? await options.tasks.get(args.taskId) : null;
      if (args.taskId && !existing) throw new ToolUserError('未找到可继续的 17dz 任务。');
      if (existing && (existing.principalId !== ctx.trusted.principalId || existing.parentSessionId !== ctx.trusted.sessionId)) {
        throw new ToolUserError('无权继续该 17dz 任务。');
      }

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
        result = await options.workerDriver.run({
          systemPrompt: workerSystemPrompt(profile.root, ctx.trusted.allowedAccountSetIds, args.taskIntent),
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
          ...(args.taskIntent ? { taskIntent: args.taskIntent } : {}),
          ...(profile.knowledgePaths ? { knowledgePaths: profile.knowledgePaths } : {}),
          ...(profile.sensitivePaths ? { sensitivePaths: profile.sensitivePaths } : {}),
          ...(ctx.trusted.onNotice ? { onNotice: ctx.trusted.onNotice } : {}),
        });
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
          if (!ctx.trusted.onPlanPending) throw new Error('平台计划待确认，但宿主未配置安全持久化回调。');
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
          return { taskId, text: result.text, pendingPlan };
        }
        const proposal = options.changeIntents ? extractChangeProposal(result.text, maxBatchCount) : null;
        if (proposal) {
          const handled = await finalizeProposal(proposal, ctx, taskId);
          await options.tasks.upsert({
            ...running,
            workerMessages: result.messages as unknown[],
            updatedAt: new Date().toISOString(),
          });
          const outcome = handled.text.includes('未开放写入权限') ? 'proposal_declined'
            : handled.text.includes('未通过预检') ? 'proposal_precheck_failed'
            : 'proposal_created';
          console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome }));
          return handled;
        }
        const final: SubagentTaskResult = {
          taskId,
          // 执行面回执：主 Agent 的重量反馈（系统元数据，提示词约定不转述给用户）。
          // 必须拼在 extractChangeProposal 之后——尾部注脚会破坏"整段纯 JSON"提案候选。
          text: result.footprint ? `${result.text}\n\n〔本轮执行面：${result.footprint}〕` : result.text,
        };
        await options.tasks.upsert({
          ...running,
          workerMessages: result.messages as unknown[],
          updatedAt: new Date().toISOString(),
        });
        console.info(JSON.stringify({ event: 'delegation_span', requestId: ctx.trusted.requestId, taskId, durationMs: Date.now() - delegationStart, outcome: 'ok' }));
        return final;
      } catch (error) {
        const failureClass = signal?.aborted ? 'cancelled'
          : Date.now() >= deadline ? 'timeout'
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
          ...running,
          ...(result?.messages?.length ? { workerMessages: result.messages as unknown[] } : {}),
          updatedAt: new Date().toISOString(),
        });
        throw new ToolUserError(signal?.aborted ? '17dz 子任务已取消。' : '17dz 子任务执行失败，请稍后再试。');
      }
    },
  };
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
  taskIntent?: Extract<TaskIntent, { kind: 'platform_query' }>,
): string {
  const scope = allowedAccountSetIds.length > 0
    ? `调用者的应用层账套 allowlist：${allowedAccountSetIds.join(', ')}。不得查询或操作名单外账套。`
    : '应用层未提供账套 allowlist；账套访问范围必须以平台领域脚本的权限校验为准。';
  return [
    '你是 幻账平台任务子 Agent。你在受信工作目录中为主 Agent 执行一项具体任务。',
    `平台工作目录：${root}`,
    '先按 Pi 的 Skill 机制读取与任务相关的 SKILL.md、MECHANISMS.md 和契约说明，再调用其中指定的领域脚本。',
    '实时账务数据必须来自领域脚本结果，不得编造；不要读取源码后猜内部 ID，也不要自行重实现平台流程。',
    '本链路支持只读查询与录入类准备（按 17dz-bookkeeping-prepare 技能产出变更提案）。写操作由服务端在用户确认后执行——你不得也不需要执行；修改/删除已保存凭证、过账、结账类请求直接报告能力边界。',
    '调用网关直接使用 `bin/17dz <query|prepare> …`（平台统一网关，mode 决定裁决矩阵），不要加 cd/env 等前缀。',
    '执行前必须先提交精确执行方案：第一条 bash 命令为单行 JSON——bin/17dz plan {"goal":"…","calls":[{"operation":"voucher.query-saved","args":["账套名","期间"]}]}。calls 必须逐项列出你准备执行的平台注册 operation 及其原生参数；照 Skill/operation 文档填写，禁止自行把账套、期间映射成参数。平台返回 PLAN ACTIVE 后才能查询。',
    '计划由平台 CLI 评估并在每次调用时校验。PLAN DECLINED 可按平台原因修正后重提；PLAN NEEDS_USER_CONFIRM 或 PLAN PAUSED 必须结束回合，等待宿主收到并验证真实用户确认/通知，不得凭模型字段或用户消息转述自行激活。PLAN STOP 时直接说明停止原因。计划范围扩大时必须重新提交完整精确 calls。',
    '用户只问账套是否存在或要查账套候选时，只能调用 finance.search-account-sets，并且只提交这一项调用。不得用 finance.query-receivables、凭证查询或科目查询代替，也不得继续查期间、余额或客户。若平台 operation 清单或 Skill 中没有 finance.search-account-sets，或它明确报告能力不可用，应停止并明确告知用户无法确认；不得用其它查询接口试探。',
    '未指定账套时不能把历史出现过的账套自动当作本次范围；如果当前请求和紧邻上下文不能唯一确定账套，先向用户询问要查哪个账套，不得并行遍历历史账套。',
    '余额查询没有用户指定期间时只查当前期间。应收余额查询失败后必须停止并如实报告；不得用历史凭证或扩大期间范围估算期末余额。历史凭证查询只用于用户明确要求的凭证明细或期间核对，不能替代余额表。',
    ...(taskIntent ? [`宿主意图路由已核验本轮范围；严格按此结构化意图执行，不得扩大或从其他历史内容补范围：${JSON.stringify(taskIntent)}`] : []),
    '知识只经 read 读取固定知识面：技能 SKILL.md、src/<域>/MECHANISMS.md、*.schema.json；实现源码不可读也不需要读（工具面无 grep/find）。',
    scope,
    '缺少信息时直接用自然语言说明需要用户补充什么；完成时直接返回可供主 Agent 使用的自然语言结果和必要证据。',
    '不要替主 Agent 决定如何回复用户，也不要输出状态 JSON 或控制协议。',
  ].join('\n\n');
}
