/**
 * P7a 结构化轨迹（ask --script / ask --interactive 的证据落盘与校验）。
 *
 * 依据：R4 验收设计 §3.1（复用 convergence-r1 runner 证据 schema：inputs/model/toolcalls/
 * transcripts/audit+index/executions/reply/meta/judgment 共 11 类）与 P7-T03；owner 裁定
 * P7a = 前置能力，轨迹取 runner schema 的**适用子集**，缺失类在 evidence.manifest.json
 * 里**显式声明**（blocked=依赖未合入；not_applicable=不在本片范围），不假装齐全。
 *
 * 布局：`--trace <dir>` 根目录=证据文件；`<dir>/runtime/`=运行态（dummy 配置副本、SQLite
 * 底账、原始审计），不参与证据逐字对比。
 *
 * 确定性（script 模式）：运行期标识归一为 task@n/req@n（n 按创建序），剔除时钟字段（ts、
 * createdAt/updatedAt）与耗时；管理员仍需原值时可查 runtime/ 下的底账与原始审计。
 * 交互模式（interactive）：原样记录，未归一（无逐字确定性承诺）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AssertionResult } from './ask-assert';
import type { TaskRecord } from '../packages/agent/src/task-registry';

export const TRACE_SCHEMA = 'p7a-trace-v1';

/** runner 证据 schema 的 11 类（judgment 在本片不产出，manifest 显式声明）。 */
export const RUNNER_CLASSES = [
  'inputs', 'model', 'toolcalls', 'transcript_main', 'transcript_worker',
  'audit', 'audit_index', 'executions', 'reply', 'meta', 'judgment',
] as const;
export type RunnerClass = (typeof RUNNER_CLASSES)[number];

/** 类别 → 文件名（assertions 为 P7a 追加的证据件，数组外）。 */
const CLASS_FILE: Readonly<Record<string, string>> = {
  inputs: 'inputs.json',
  model: 'model.json',
  toolcalls: 'toolcalls.jsonl',
  transcript_main: 'transcript.main.json',
  transcript_worker: 'transcript.worker.jsonl',
  audit: 'audit.jsonl',
  audit_index: 'audit.index.json',
  executions: 'executions.json',
  reply: 'reply.jsonl',
  meta: 'meta.json',
  judgment: 'judgment.json',
  assertions: 'assertions.json',
};

export type ClassStatus = 'present' | 'empty' | 'not_applicable' | 'blocked';

export interface TraceClassRecord {
  status: ClassStatus;
  path?: string;
  reason?: string;
}

export interface TraceManifest {
  schema: string;
  mode: 'script' | 'interactive';
  classes: Record<string, TraceClassRecord>;
  normalization: string;
  source: string;
}

/** 非断言类 blocked 事实（注入回合/证据类/threshold）。 */
export interface BlockedFact {
  kind: 'turn' | 'evidence' | 'threshold';
  index?: number;
  name?: string;
  reason: string;
}

export interface TraceToolCall {
  driver: 'main' | 'worker';
  tool: string;
  args: unknown;
}

/** 一个已执行回合的记录面（回放引擎/交互循环按此装配）。 */
export interface TraceTurnRecord {
  index: number;
  session: string;
  text: string;
  reply: string;
  taskIds: readonly string[];
  executionCount: number;
  auditLines: readonly string[];
  mainMessages: readonly unknown[];
  workerMessages: readonly (readonly unknown[])[];
  toolcalls?: readonly TraceToolCall[];
  kind?: string;
}

export interface TraceRecorderInput {
  dir: string;
  mode: 'script' | 'interactive';
  principalId: string;
  sessionId?: string;
  sessions?: ReadonlyArray<{ name: string; principal: string; session: string }>;
  scriptPath?: string;
  scriptSha256?: string;
  configPath?: string;
  dbPath?: string;
  model?: Record<string, unknown>;
}

export interface TraceFinishInput {
  scenario?: string;
  threshold?: string;
  assertions?: readonly AssertionResult[];
  blocked?: readonly BlockedFact[];
  finalTasks?: readonly TaskRecord[];
}

export interface TraceRecorder {
  recordTurn(record: TraceTurnRecord): void;
  finish(input?: TraceFinishInput): TraceManifest;
}

export interface TraceValidation {
  ok: boolean;
  errors: string[];
  manifest?: TraceManifest;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

/** transcript 投影：JSON 往返 + 剔除 timestamp（回放确定性；toolCall 等其余形状原样）。 */
function normalizeMessage(message: unknown, normalize: boolean): unknown {
  const copy = jsonSafe(message);
  if (normalize && copy !== null && typeof copy === 'object' && !Array.isArray(copy)) {
    delete (copy as Record<string, unknown>)['timestamp'];
  }
  return copy;
}

/** 审计行归一：script 模式剔 ts；interactive 原样。解析失败的行原样保留（不吞证据）。 */
function normalizeAuditLine(line: string, mode: 'script' | 'interactive'): string {
  if (mode !== 'script') return line;
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    delete row['ts'];
    return JSON.stringify(row);
  } catch {
    return line;
  }
}

interface IdentifierAliases {
  taskAlias: Map<string, string>;
  requestAlias: Map<string, string>;
}

function buildAliases(tasks: readonly TaskRecord[]): IdentifierAliases {
  const taskAlias = new Map<string, string>();
  const requestAlias = new Map<string, string>();
  let taskSeq = 0;
  let requestSeq = 0;
  for (const task of tasks) {
    taskSeq += 1;
    taskAlias.set(task.taskId, `task@${taskSeq}`);
    for (const execution of task.executions) {
      if (!requestAlias.has(execution.requestId)) {
        requestSeq += 1;
        requestAlias.set(execution.requestId, `req@${requestSeq}`);
      }
    }
  }
  return { taskAlias, requestAlias };
}

function normalizeTask(task: TaskRecord, aliases: IdentifierAliases): Record<string, unknown> {
  return {
    taskId: aliases.taskAlias.get(task.taskId) ?? task.taskId,
    principalId: task.principalId,
    sessionId: task.sessionId,
    request: task.request,
    status: task.status,
    ...(task.resultText !== undefined ? { resultText: task.resultText } : {}),
    ...(task.failureReason !== undefined ? { failureReason: task.failureReason } : {}),
    executions: task.executions.map((execution) => ({
      requestId: aliases.requestAlias.get(execution.requestId) ?? execution.requestId,
      operation: execution.operation,
      status: execution.status,
      ...(execution.error !== undefined ? { error: execution.error } : {}),
    })),
  };
}

function summarizeAssertions(results: readonly AssertionResult[]): { pass: number; fail: number; blocked: number } {
  return {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    blocked: results.filter((result) => result.status === 'blocked').length,
  };
}

function writeJsonLines(file: string, lines: readonly string[]): void {
  writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

function presentOrEmpty(empty: boolean, name: string): TraceClassRecord {
  const record: TraceClassRecord = { status: empty ? 'empty' : 'present' };
  const file = CLASS_FILE[name];
  if (file !== undefined) record.path = file;
  return record;
}

function buildManifest(input: TraceRecorderInput, turns: readonly TraceTurnRecord[]): TraceManifest {
  const scriptMode = input.mode === 'script';
  const toolcallCount = turns.reduce((sum, turn) => sum + (turn.toolcalls?.length ?? 0), 0);
  const workerRuns = turns.reduce((sum, turn) => sum + turn.workerMessages.length, 0);
  const auditCount = turns.reduce((sum, turn) => sum + turn.auditLines.length, 0);
  const hasMainMessages = turns.some((turn) => turn.mainMessages.length > 0);
  const classes: Record<string, TraceClassRecord> = {
    inputs: { status: 'present', path: CLASS_FILE['inputs']! },
    model: { status: 'present', path: CLASS_FILE['model']! },
    toolcalls: scriptMode
      ? presentOrEmpty(toolcallCount === 0, 'toolcalls')
      : { status: 'not_applicable', reason: '交互模式记录 Main 面；结构化调用入参在 P7b 需要时补（未接线）' },
    transcript_main: presentOrEmpty(!hasMainMessages, 'transcript_main'),
    transcript_worker: scriptMode
      ? presentOrEmpty(workerRuns === 0, 'transcript_worker')
      : { status: 'not_applicable', reason: '交互模式未接线 Worker 转录（P7b 需要时补）' },
    audit: presentOrEmpty(auditCount === 0, 'audit'),
    audit_index: { status: 'present', path: CLASS_FILE['audit_index']! },
    executions: { status: 'present', path: CLASS_FILE['executions']! },
    reply: presentOrEmpty(turns.length === 0, 'reply'),
    meta: { status: 'present', path: CLASS_FILE['meta']! },
    judgment: {
      status: 'not_applicable',
      reason: 'P7a 不产 convergence-r1 判定（判据/锁属冻结面）；本片断言报告为 assertions.json',
    },
    assertions: { status: 'present', path: CLASS_FILE['assertions']! },
    notifications: { status: 'blocked', reason: '依赖 P4（通知 outbox），未合入' },
    resources: { status: 'blocked', reason: '依赖 P5（资源强制），未合入' },
  };
  return {
    schema: TRACE_SCHEMA,
    mode: input.mode,
    classes,
    normalization: scriptMode
      ? 'script：运行期标识归一为 task@n/req@n（创建序）；剔除时钟（ts/createdAt/updatedAt）与耗时；transcript 投影（剔 timestamp）。原始面见 runtime/。'
      : 'interactive：原样记录（含运行期标识），未归一。',
    source: scriptMode ? 'ask --script（共享装配 + 记录包装器）' : 'ask --interactive（共享装配 + 记录包装器）',
  };
}

/** 创建轨迹记录器（内存累积回合，finish 时一次落盘）。 */
export function createTraceRecorder(input: TraceRecorderInput): TraceRecorder {
  const turns: TraceTurnRecord[] = [];
  return {
    recordTurn(record: TraceTurnRecord): void {
      turns.push(record);
    },
    finish(finishInput: TraceFinishInput = {}): TraceManifest {
      const scriptMode = input.mode === 'script';
      mkdirSync(input.dir, { recursive: true });
      const aliases = scriptMode ? buildAliases(finishInput.finalTasks ?? []) : undefined;

      writeJsonLines(
        path.join(input.dir, 'reply.jsonl'),
        turns.map((turn) => JSON.stringify({
          turn: turn.index,
          session: turn.session,
          text: turn.reply,
          sha256: sha256Hex(turn.reply),
        })),
      );

      const mainTranscript = turns.map((turn) => ({
        turn: turn.index,
        session: turn.session,
        messages: turn.mainMessages.map((message) => normalizeMessage(message, scriptMode)),
      }));
      writeFileSync(path.join(input.dir, 'transcript.main.json'), JSON.stringify(mainTranscript, null, 2) + '\n');

      const workerLines: string[] = [];
      for (const turn of turns) {
        turn.workerMessages.forEach((messages, run) => {
          workerLines.push(JSON.stringify({
            turn: turn.index,
            session: turn.session,
            run: run + 1,
            messages: messages.map((message) => normalizeMessage(message, scriptMode)),
          }));
        });
      }
      writeJsonLines(path.join(input.dir, 'transcript.worker.jsonl'), workerLines);

      const toolcallLines: string[] = [];
      for (const turn of turns) {
        for (const call of turn.toolcalls ?? []) {
          toolcallLines.push(JSON.stringify({
            turn: turn.index,
            session: turn.session,
            driver: call.driver,
            tool: call.tool,
            args: jsonSafe(call.args),
          }));
        }
      }
      writeJsonLines(path.join(input.dir, 'toolcalls.jsonl'), toolcallLines);

      const auditLines: string[] = [];
      const auditTurns: Array<{ index: number; fromLine: number; toLine: number; sha256: string }> = [];
      for (const turn of turns) {
        const slice = turn.auditLines.map((line) => normalizeAuditLine(line, input.mode));
        const fromLine = auditLines.length + 1;
        auditLines.push(...slice);
        auditTurns.push({
          index: turn.index,
          fromLine,
          toLine: auditLines.length,
          sha256: sha256Hex(slice.join('\n') + (slice.length > 0 ? '\n' : '')),
        });
      }
      writeJsonLines(path.join(input.dir, 'audit.jsonl'), auditLines);
      writeFileSync(path.join(input.dir, 'audit.index.json'), JSON.stringify({ turns: auditTurns, totalLines: auditLines.length }, null, 2) + '\n');

      const tasks = finishInput.finalTasks ?? [];
      writeFileSync(path.join(input.dir, 'executions.json'), JSON.stringify({
        tasks: scriptMode ? tasks.map((task) => normalizeTask(task, aliases!)) : tasks.map((task) => jsonSafe(task)),
      }, null, 2) + '\n');

      const inputs = {
        schema: TRACE_SCHEMA,
        mode: input.mode,
        scenario: finishInput.scenario ?? null,
        principalId: input.principalId,
        sessionId: input.sessionId ?? null,
        sessions: input.sessions ?? null,
        scriptPath: input.scriptPath ?? null,
        scriptSha256: input.scriptSha256 ?? null,
        configPath: input.configPath ?? null,
        dbPath: input.dbPath ?? null,
        turns: turns.map((turn) => ({
          index: turn.index,
          session: turn.session,
          kind: turn.kind ?? 'message',
          text: turn.text,
          sha256: sha256Hex(turn.text),
        })),
      };
      writeFileSync(path.join(input.dir, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');

      const model = input.model ?? (scriptMode
        ? { mode: 'scripted-fake', modelId: null, keyPresent: false, source: '回放脚本 model 计划（假 driver；零模型、零网络）' }
        : { mode: 'interactive', modelId: null, source: '交互模式记录面（真实模型归黑盒层；不落密钥）' });
      writeFileSync(path.join(input.dir, 'model.json'), JSON.stringify(model, null, 2) + '\n');

      const meta = {
        schema: TRACE_SCHEMA,
        mode: input.mode,
        scenario: finishInput.scenario ?? null,
        threshold: finishInput.threshold ?? null,
        turns: turns.map((turn) => ({
          index: turn.index,
          session: turn.session,
          kind: turn.kind ?? 'message',
          tasks: scriptMode
            ? turn.taskIds.map((taskId) => aliases!.taskAlias.get(taskId) ?? taskId)
            : [...turn.taskIds],
          executionCount: turn.executionCount,
        })),
        notes: [scriptMode
          ? '确定性回放：运行期标识已归一（task@n/req@n，创建序），时钟与耗时字段已剔除；原始面见 runtime/。'
          : '交互记录：原样保存（含运行期标识与时钟）；未归一。'],
      };
      writeFileSync(path.join(input.dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

      const assertionResults = finishInput.assertions ?? [];
      writeFileSync(path.join(input.dir, 'assertions.json'), JSON.stringify({
        schema: TRACE_SCHEMA,
        scenario: finishInput.scenario ?? null,
        threshold: finishInput.threshold ?? null,
        results: assertionResults,
        blocked: finishInput.blocked ?? [],
        summary: summarizeAssertions(assertionResults),
      }, null, 2) + '\n');

      const manifest = buildManifest(input, turns);
      writeFileSync(path.join(input.dir, 'evidence.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      return manifest;
    },
  };
}

const VALID_STATUSES: readonly ClassStatus[] = ['present', 'empty', 'not_applicable', 'blocked'];

/** 校验轨迹目录：schema、11 类覆盖、声明 present/empty 的文件存在且可解析；缺失类须有声明。 */
export function validateTraceDir(dir: string): TraceValidation {
  const errors: string[] = [];
  const manifestPath = path.join(dir, 'evidence.manifest.json');
  if (!existsSync(manifestPath)) return { ok: false, errors: ['缺少 evidence.manifest.json'] };
  let manifest: TraceManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TraceManifest;
  } catch (error) {
    return { ok: false, errors: [`evidence.manifest.json 不可解析：${error instanceof Error ? error.message : String(error)}`] };
  }
  if (manifest.schema !== TRACE_SCHEMA) {
    errors.push(`evidence.manifest.json schema 不是 ${TRACE_SCHEMA}：${String(manifest.schema)}`);
  }
  if (manifest.mode !== 'script' && manifest.mode !== 'interactive') {
    errors.push(`evidence.manifest.json mode 未知：${String(manifest.mode)}`);
  }
  const classes = manifest.classes;
  if (classes === null || typeof classes !== 'object' || Array.isArray(classes)) {
    return { ok: false, errors: [...errors, 'evidence.manifest.json 缺少 classes'] };
  }
  for (const name of RUNNER_CLASSES) {
    if ((classes as Record<string, unknown>)[name] === undefined) errors.push(`manifest 缺类别：${name}`);
  }
  for (const [name, raw] of Object.entries(classes)) {
    const record = raw as Partial<TraceClassRecord> | null;
    if (record === null || typeof record !== 'object') {
      errors.push(`类别 ${name} 记录不是对象`);
      continue;
    }
    if (typeof record.status !== 'string' || !VALID_STATUSES.includes(record.status as ClassStatus)) {
      errors.push(`类别 ${name} 状态未知：${String(record.status)}`);
      continue;
    }
    if (record.status === 'blocked' || record.status === 'not_applicable') {
      if (typeof record.reason !== 'string' || record.reason === '') {
        errors.push(`类别 ${name} 为 ${record.status} 但缺 reason（缺失类须显式声明）`);
      }
      continue;
    }
    const file = CLASS_FILE[name];
    if (file === undefined) {
      errors.push(`类别 ${name} 声明 ${record.status} 但无文件映射`);
      continue;
    }
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) {
      errors.push(`类别 ${name} 声明 ${record.status} 但文件缺失：${file}`);
      continue;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      if (file.endsWith('.json')) {
        JSON.parse(content);
      } else {
        for (const line of content.split('\n').filter((entry) => entry.trim() !== '')) JSON.parse(line);
      }
    } catch (error) {
      errors.push(`类别 ${name} 不可解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length === 0 ? { ok: true, errors, manifest } : { ok: false, errors, manifest };
}
