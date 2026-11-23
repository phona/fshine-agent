/**
 * 逐样本 run-dir 证据采集器（业务 E2E 阶段 1）。
 *
 * 复用 runner 证据 schema（`../convergence-r1/evidence.ts`）：ToolCallRecord /
 * TaskRecordJson / ExecutionsExport / ReplyLine / MetaFile / InputsFile。本采集器
 * 只**落盘 + 机械核对**，不做判定（判定归 `./judge`，UX 指标只统计）。
 *
 * 落盘形状：`<root>/<caseId>/<trial>/`，八类证据齐全：
 *   inputs.json / meta.json / tool-calls.json（trace）/ tasks.json（执行记录）/
 *   replies.jsonl（回复）/ task-facts.jsonl（TaskFact 流）/ notifications.jsonl（通知）/
 *   audit.jsonl（执行层审计），外加 verdict.json（判定器输出）与 manifest.json
 *   （逐文件 sha256 可复核）。
 *
 * 诚实纪律：模型调用数 / token / 耗时若驱动面不可得，manifest.modelUsage 如实标注
 * `available:false` + `note`，不编造数字。manifest.files 不含 manifest.json 自身
 * （自指哈希不可满足）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { judgeMechanical } from './judge';
import type { SampleRecord } from './judge';
import type {
  ExecutionsExport,
  InputsFile,
  MetaFile,
  ReplyLine,
  TaskRecordJson,
  ToolCallRecord,
} from '../convergence-r1/evidence';

/** TaskFact 流的一行：任务账本**机械事实快照**（中性名词，只为采集存档；无任务级状态词/种类）。 */
export interface TaskFactLine {
  ts: string;
  taskId: string;
  /** 事实（布尔）：启动 / 已停（结束事实在场）/ 有汇报 / 等待 / 跨进程可能还在跑。 */
  started: boolean;
  ended: boolean;
  reported: boolean;
  waiting: boolean;
  mayBeRunning: boolean;
  [key: string]: unknown;
}

/** 通知的一行。 */
export interface NotificationLine {
  ts: string;
  taskId: string;
  kind: string;
  [key: string]: unknown;
}

export interface SampleRunInput {
  inputs: InputsFile;
  toolCalls: readonly ToolCallRecord[];
  tasks: readonly TaskRecordJson[];
  replies: readonly ReplyLine[];
  meta: MetaFile;
  taskFacts?: readonly TaskFactLine[];
  notifications?: readonly NotificationLine[];
  /** 执行层审计 JSONL 原文（逐行字符串）。 */
  auditLines?: readonly string[];
  sample: SampleRecord;
}

export interface ManifestFileEntry {
  name: string;
  sha256: string;
}

export interface ModelUsage {
  /** token 计数是否可得（驱动面不可得 = false，不编造）。 */
  available: boolean;
  note: string;
  modelCalls: { available: boolean; perTurn: number[]; total: number };
  tokens: { available: boolean; source: string; perTurn?: unknown[]; total?: number; note?: string };
  durationMs: { available: boolean; perTurn: number[]; total: number };
}

export interface SampleManifest {
  sampleId: string;
  caseId: string;
  trial: number;
  files: ManifestFileEntry[];
  modelUsage: ModelUsage;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function jsonl(rows: readonly unknown[]): string {
  return rows.length === 0 ? '' : rows.map(jsonLine).join('\n') + '\n';
}

/** 从逐轮 meta 汇总模型用量；token 不可得时如实标注，不编造。 */
export function summarizeModelUsage(meta: MetaFile): ModelUsage {
  const turns = meta.turns ?? [];
  const calls = turns.map((t) => t.modelCalls ?? 0);
  const durations = turns.map((t) => t.durationMs ?? 0);
  const totalCalls = calls.reduce((a, b) => a + b, 0);
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const tokensAvailable = turns.length > 0 && turns.every((t) => t.tokens?.available === true);
  if (!tokensAvailable) {
    return {
      available: false,
      note: '驱动面未提供 token 计数（逐轮 tokens.available=false）；如实标注不可得，不编造',
      modelCalls: { available: true, perTurn: calls, total: totalCalls },
      tokens: { available: false, source: turns[0]?.tokens?.source ?? 'unknown' },
      durationMs: { available: true, perTurn: durations, total: totalDuration },
    };
  }
  const tokenTotal = turns.reduce((a, t) => a + (t.tokens?.total ?? 0), 0);
  return {
    available: true,
    note: 'token 计数来自驱动面（逐轮 tokens.available=true）',
    modelCalls: { available: true, perTurn: calls, total: totalCalls },
    tokens: { available: true, source: turns[0]?.tokens?.source ?? 'driver', perTurn: turns.map((t) => t.tokens), total: tokenTotal },
    durationMs: { available: true, perTurn: durations, total: totalDuration },
  };
}

/** 落一个样本的一次 trial；返回 run-dir 绝对路径。 */
export function writeSampleRun(root: string, input: SampleRunInput): string {
  const runDir = path.join(root, input.inputs.caseId, String(input.inputs.trial));
  mkdirSync(runDir, { recursive: true });

  const verdict = {
    sampleId: input.sample.id,
    mechanical: judgeMechanical(input.sample),
    behavior: input.sample.behavior ?? null,
    ux: input.sample.ux ?? null,
    observations: input.sample.observations ?? null,
  };

  const files: Array<[string, string]> = [
    ['inputs.json', pretty(input.inputs)],
    ['meta.json', pretty(input.meta)],
    ['tool-calls.json', pretty({ toolCalls: input.toolCalls })],
    ['tasks.json', pretty({ tasks: [...input.tasks] } satisfies ExecutionsExport)],
    ['replies.jsonl', jsonl(input.replies)],
    ['task-facts.jsonl', jsonl(input.taskFacts ?? [])],
    ['notifications.jsonl', jsonl(input.notifications ?? [])],
    ['audit.jsonl', jsonl(input.auditLines ?? [])],
    ['verdict.json', pretty(verdict)],
  ];
  for (const [name, content] of files) {
    writeFileSync(path.join(runDir, name), content, 'utf8');
  }

  const manifest: SampleManifest = {
    sampleId: input.sample.id,
    caseId: input.inputs.caseId,
    trial: input.inputs.trial,
    files: files.map(([name, content]) => ({ name, sha256: sha256(content) })),
    modelUsage: summarizeModelUsage(input.meta),
  };
  writeFileSync(path.join(runDir, 'manifest.json'), pretty(manifest), 'utf8');
  return runDir;
}
