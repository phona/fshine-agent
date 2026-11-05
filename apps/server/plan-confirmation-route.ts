import {
  activatePendingPlan,
  loadPlanStatus,
  matchAndResolvePlanConfirmation,
  PlanSupersededError,
  type PendingPlanConfirmationRecord,
  type PendingPlanConfirmationRepo,
  type WecomUserConfirmationMessage,
} from '@fshine/agent';
import { createSqlitePendingPlanConfirmationRepo, type SqlitePendingPlanConfirmationRepo, type StoredPendingPlanConfirmation } from '@fshine/core';

/**
 * 待确认计划的 TTL（D-013：`10 * 60_000` 这个字面量曾在 assembly.ts 与 scripts/ask.ts
 * 逐字复刻两遍，现在只有这一处定义）。用户确认门的有效期——超时后确认码自然失效，
 * 由平台侧计划状态（verifyActivatable）与仓库的过期判定共同把关。
 */
export const PLAN_CONFIRMATION_TTL_MS = 10 * 60_000;

export interface PlanConfirmationRouteOptions {
  repo: PendingPlanConfirmationRepo | SqlitePendingPlanConfirmationRepo;
  activate: (pending: PendingPlanConfirmationRecord, evidence: { messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }) => Promise<void>;
  /** Host-side pre-check against the platform, so a stale confirmation is explained, not generic-failed. */
  verifyActivatable?: (pending: PendingPlanConfirmationRecord) => Promise<void>;
}

/** Host-only bridge from a trusted channel message to the durable confirmation matcher. */
export function createPlanConfirmationRoute(options: PlanConfirmationRouteOptions) {
  const repo = isAgentRepo(options.repo) ? options.repo : asAgentPendingRepo(options.repo);
  return {
    async handle(message: WecomUserConfirmationMessage, now?: string) {
      return matchAndResolvePlanConfirmation({
        message,
        repo,
        activate: options.activate,
        ...(options.verifyActivatable ? { verifyActivatable: options.verifyActivatable } : {}),
        ...(now ? { now } : {}),
      });
    },
  };
}

function isAgentRepo(value: PlanConfirmationRouteOptions['repo']): value is PendingPlanConfirmationRepo {
  return typeof (value as PendingPlanConfirmationRepo).resolvePending === 'function';
}

/** Adapt the SQLite repository without exposing its storage types to agent code. */
export function asAgentPendingRepo(repo: SqlitePendingPlanConfirmationRepo): PendingPlanConfirmationRepo {
  return {
    async listPending(principalId, sessionId) {
      return repo.listPending(principalId, sessionId) as Promise<PendingPlanConfirmationRecord[]>;
    },
    async resolvePending(pending, evidence, resolution, action) {
      return repo.resolvePending(
        pending as unknown as StoredPendingPlanConfirmation,
        evidence,
        resolution,
        action,
      );
    },
  };
}
/**
 * 计划确认门的装配工厂（D-013：assembly.ts 与 scripts/ask.ts 曾逐字复刻同一段接线）。
 *
 * 复刻的病灶：`cc4ea40`（ask.ts 接计划确认门）为了让单进程 CLI 覆盖 confirm 档，把装配层
 * 的接线整段抄了一份——savePending 的三个字面量（decision:'confirm' / TTL / evaluation:{}）
 * 两处各写一遍，改一处漏一处就是静默漂移。现在接线只有这一份：仓库创建、verify/activate
 * 两个平台回调、savePending 的落库形状，全部由本工厂产出，两个入口都调它。
 *
 * 行为与复刻版逐字一致：verifyActivatable 先问平台"这条待确认计划还活着吗"（被取代 →
 * PlanSupersededError → 用户收到确定性解释而不是 generic-fail）；activate 用宿主持有的
 * 计划激活密钥铸令牌。platformRoot 缺省（平台未配置）时两个回调都 fail-loud——确认门
 * 不可能在不知道平台的情况下放行。
 */
export function createPlanConfirmationWiring(options: {
  /** SQLite 库文件路径（待确认计划与审计库同一个文件，跟随其生命周期）。 */
  dbPath: string;
  /** 平台根路径；缺省 = 平台未配置，verify/activate fail-loud。 */
  platformRoot?: string;
  /** 宿主计划激活密钥（进程级机密，不进 worker env）。 */
  planActivationSecret: string;
}) {
  const pendingPlanRepo = createSqlitePendingPlanConfirmationRepo(options.dbPath);
  const confirmationRoute = createPlanConfirmationRoute({
    repo: asAgentPendingRepo(pendingPlanRepo),
    verifyActivatable: async (pending) => {
      if (!options.platformRoot) throw new Error('平台根路径未配置');
      const status = await loadPlanStatus({ platformRoot: options.platformRoot, planId: pending.planId });
      if (status && status.status !== 'pending') {
        throw new PlanSupersededError(pending.planId, pending.version, pending.taskId);
      }
    },
    activate: async (pending) => {
      if (!options.platformRoot) throw new Error('平台根路径未配置');
      await activatePendingPlan({
        platformRoot: options.platformRoot,
        planId: pending.planId,
        evidence: 'user-confirmed',
        activationSecret: options.planActivationSecret,
      });
    },
  });
  return {
    /** 挂到 createMessageHandler 的 planConfirmation.handle。 */
    handle: confirmationRoute.handle,
    /** Host task-control cancellation is separate from user confirmation evidence. */
    cancelTask: (principalId: string, sessionId: string, taskId: string) =>
      pendingPlanRepo.cancelTask(principalId, sessionId, taskId),
    /** 挂到 createMessageHandler 的 planConfirmation.savePending（决策固定 confirm）。 */
    savePending: async (pending: { planId: string; version: number; taskId: string; principalId: string; sessionId: string; requestId: string; userText: string }) => {
      await pendingPlanRepo.savePending({ ...pending, decision: 'confirm', expiresAt: new Date(Date.now() + PLAN_CONFIRMATION_TTL_MS).toISOString(), evaluation: {} });
    },
    /** 关库（生产装配的 close 链；单进程 CLI 退出前调用，避免句柄泄漏）。 */
    close: () => pendingPlanRepo.close(),
  };
}
