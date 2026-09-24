import {
  matchAndResolvePlanConfirmation,
  type PendingPlanConfirmationRecord,
  type PendingPlanConfirmationRepo,
  type WecomUserConfirmationMessage,
} from '@fshine/agent';
import type { SqlitePendingPlanConfirmationRepo, StoredPendingPlanConfirmation } from '@fshine/core';

export interface PlanConfirmationRouteOptions {
  repo: PendingPlanConfirmationRepo | SqlitePendingPlanConfirmationRepo;
  activate: (pending: PendingPlanConfirmationRecord, evidence: { messageId: string; principalId: string; sessionId: string; text: string; receivedAt: string }) => Promise<void>;
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
