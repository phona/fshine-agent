/**
 * Host-written task handover (Phase 2).
 *
 * The host, not the worker, owns the resume state. At turn end the host
 * writes one fixed-field file; on continue (continueTaskId / user says
 * "continue") the host reads it first and environment-checks it before
 * any new delegation. Worker text is never a handover source: fields come
 * only from host facts (plan identity, executed calls, result summary).
 *
 * File location (by convention, wired in context.ts): the task workspace
 * `<platformRoot>/tmp/<taskId>/handover.json`. The file is task state, not
 * a sensitive credential and not a business payload; it carries only
 * operation names, args as given, and a result summary already shown to
 * the user.
 *
 * No-double-count rule: executed calls are deduplicated by their exact
 * JSON key (operation + args). A resumed turn merges the handover's
 * executed calls with any already-recorded calls by that key, never by
 * appending blindly.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HANDOVER_FILE_NAME = 'handover.json';
export const HANDOVER_VERSION = 1;

export interface HandoverExecutedCall {
  operation: string;
  args: readonly string[];
}

export interface TaskHandover {
  version: typeof HANDOVER_VERSION;
  taskId: string;
  planId: string | null;
  planVersion: number | null;
  completedSteps: readonly string[];
  executedCalls: readonly HandoverExecutedCall[];
  unfinishedSteps: readonly string[];
  nextAction: string;
  lastResultSummary: string;
  updatedAt: string;
}

export function handoverFilePath(platformRoot: string, taskId: string): string {
  return path.join(platformRoot, 'tmp', taskId, HANDOVER_FILE_NAME);
}

export function callKey(call: HandoverExecutedCall): string {
  return JSON.stringify([call.operation, [...call.args]]);
}

/** Merge executed calls by exact key; handover calls already recorded are not counted twice. */
export function mergeExecutedCalls(
  already: readonly HandoverExecutedCall[],
  fromHandover: readonly HandoverExecutedCall[],
): HandoverExecutedCall[] {
  const seen = new Set(already.map(callKey));
  const merged = [...already];
  for (const call of fromHandover) {
    if (!seen.has(callKey(call))) {
      seen.add(callKey(call));
      merged.push(call);
    }
  }
  return merged;
}

export function serializeHandover(handover: TaskHandover): string {
  return JSON.stringify(handover, null, 2) + '\n';
}

export function parseHandover(raw: string): TaskHandover | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.version !== HANDOVER_VERSION) return null;
  if (typeof row.taskId !== 'string' || !row.taskId) return null;
  if (!Array.isArray(row.completedSteps) || !Array.isArray(row.executedCalls) || !Array.isArray(row.unfinishedSteps)) return null;
  if (typeof row.nextAction !== 'string' || typeof row.lastResultSummary !== 'string') return null;
  const calls: HandoverExecutedCall[] = [];
  for (const item of row.executedCalls as unknown[]) {
    if (!item || typeof item !== 'object') return null;
    const call = item as Record<string, unknown>;
    if (typeof call.operation !== 'string' || !Array.isArray(call.args)) return null;
    if (!call.args.every((a) => typeof a === 'string')) return null;
    calls.push({ operation: call.operation, args: [...(call.args as string[])] });
  }
  return {
    version: HANDOVER_VERSION,
    taskId: row.taskId,
    planId: typeof row.planId === 'string' ? row.planId : null,
    planVersion: typeof row.planVersion === 'number' ? row.planVersion : null,
    completedSteps: (row.completedSteps as unknown[]).filter((s): s is string => typeof s === 'string'),
    executedCalls: calls,
    unfinishedSteps: (row.unfinishedSteps as unknown[]).filter((s): s is string => typeof s === 'string'),
    nextAction: row.nextAction,
    lastResultSummary: row.lastResultSummary,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
  };
}

export function writeHandoverFile(platformRoot: string, taskId: string, handover: TaskHandover): string {
  const file = handoverFilePath(platformRoot, taskId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeHandover(handover));
  return file;
}

export function readHandoverFile(platformRoot: string, taskId: string): TaskHandover | null {
  try {
    return parseHandover(readFileSync(handoverFilePath(platformRoot, taskId), 'utf8'));
  } catch {
    return null;
  }
}
