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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * 交接读取的异常码（Main 分级恢复的唯一判据，见接口文档 §11）：
 * - handover_ok：文件可用。
 * - handover_missing：文件不存在（从未写成；不是损坏的证据）。
 * - handover_corrupt_json：文件存在但 JSON 解析失败。
 * - handover_version_mismatch：JSON 合法但 version 不是当前版本（不做版本迁移，不猜字段）。
 * - handover_schema_invalid：JSON 合法、版本对，但必填字段/调用形状不对；文件不可读
 *   （exists 后读失败）也归入此类——内容无法验证，一律按不可信处理。
 * 损坏族（后三码）一律丢弃文件内容，绝不做部分解析后合并。
 */
export type HandoverReadCode =
  | 'handover_ok'
  | 'handover_missing'
  | 'handover_corrupt_json'
  | 'handover_version_mismatch'
  | 'handover_schema_invalid';

export interface HandoverReadResult {
  code: HandoverReadCode;
  handover: TaskHandover | null;
  /** version 字段的原值（仅 version_mismatch 时有意义，供日志与人工核对）。 */
  rawVersion?: unknown;
}

export function parseHandoverWithCode(raw: string): HandoverReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: 'handover_corrupt_json', handover: null };
  }
  if (!parsed || typeof parsed !== 'object') return { code: 'handover_schema_invalid', handover: null };
  const row = parsed as Record<string, unknown>;
  if (row.version !== HANDOVER_VERSION) {
    return { code: 'handover_version_mismatch', handover: null, rawVersion: row.version };
  }
  const handover = parseHandover(raw);
  return handover
    ? { code: 'handover_ok', handover }
    : { code: 'handover_schema_invalid', handover: null };
}

export function readHandoverFileWithCode(platformRoot: string, taskId: string): HandoverReadResult {
  const file = handoverFilePath(platformRoot, taskId);
  if (!existsSync(file)) return { code: 'handover_missing', handover: null };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 文件存在但读失败：内容无法验证，按不可信处理。
    return { code: 'handover_schema_invalid', handover: null };
  }
  return parseHandoverWithCode(raw);
}
