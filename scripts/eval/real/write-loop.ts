/**
 * 真模型写闭环验收（`npm run eval:write-loop`）——上线前的必过闸。
 *
 * 定位：验的不是「单元测试绿」，而是**用真模型走完一次写入、并且它真的写进去了**。
 * 装配面 = **server 面**（apps/server/server.ts 的 createServer；含后台派发、完成唤醒、
 * 主动投递端口与 run_js——ask 面没有这些），执行层 = **仓内 dummy 夹具**
 * （scripts/eval/fixtures/dummy-platform），模型 = env（LLM_*）里的**真实端点**。
 * 本脚本不触网到任何业务平台；模型端点是唯一外部依赖。
 *
 * 闭环形状（每一步都是机械事实，不判模型措辞）：
 *   用户交办（写一句业务话）
 *     → 模型（Main）task_run 委派 → Worker 向执行层发 dummy.prepare
 *     → 执行层返回 needs_confirmation 提案（带摘要；句柄留在宿主持有的会话小表里）
 *     → 用户回「确认」→ 模型（Main）task_confirm → runner.confirm 接续任务
 *     → Worker 发 dummy.commit（句柄由宿主随请求透传）→ 执行层落盘 + 自己读回验证
 *     → 任务 completed → 宿主**唤醒原会话的模型**，由它把话带给用户（投递端口 sendText）
 *     → 本脚本经结构化契约读回该集合（记录条数与逐条内容）
 *
 * 判据（全部机械；判据实现见 evaluateCriteria——纯函数，可单测）：
 *   C1 写前基线读回 count=0；C2 执行层确实收到 prepare 并成功返回提案（它自己的 audit.jsonl）；
 *   C3 底账出现过 waiting_user + 待确认提案（含摘要）；C4 「确认」回合确实调用了
 *   task_confirm 且 runner 接续（outcome=started）；C5 **写入恰好一次**（成功 commit 1 次，
 *   底账与执行层审计交叉核对；无句柄的 commit 被拒登记在 detail，不判红）且句柄被消耗；
 *   C6 写后读回 count 与逐条 name/value 与请求一致；C7 底账终态 completed 且成功
 *   prepare(needs_confirmation) 先于唯一一次成功 commit(completed)；
 *   C8 完成消息确实出现在用户可见面（主动投递的文字或本回合回复之一）；
 *   C9 底账状态序列按序包含 running → waiting_user → running → completed（确认把任务带回执行）。
 * 不要求执行事实恰好两条：模型重试、无句柄 commit 被拒、Worker 事后读回都是合法事实，
 * 如实记录不当违约。
 * 三条观察（**只记录、不判红**，见 evaluateObservations）：① 提案消息里有没有执行层摘要
 * （已知字符串存在性）；② 完成那条消息是模型的话还是宿主兜底；③ 有没有「收到，正在处理」
 * 这类冗余过程话术（固定短语表的已知子串命中记录，不当质量判据）。
 *
 * 不做什么：不用关键词/正则判「模型说得好不好」（仓规红线）；不改产品行为迁就验收；
 * 模型不可用（缺 key / 端点不通）一律如实失败（exit 2），**不退回脚本模型冒充真模型**。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AppConfig, ChannelReply, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, Permission } from '@fshine/contracts';
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { effectiveDeploymentEnv, effectiveRoleOf, loadConfig, permissionsOfRole } from '@fshine/core';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput, WakeResult } from '../../../packages/agent/src/driver-contract';
import type { Notification, NotificationSink } from '../../../packages/agent/src/notifications';
import { stripServerPaths } from '../../../packages/agent/src/server-paths';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import type { TaskScope } from '../../../packages/agent/src/task-registry';
import { createServer, resolveSingleProfile, type FileDeliveryPort } from '../../../apps/server/server';
import { mainSessionOptions, mainThinkingLevelFrom, resolveExecutionFace } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { assessEvalIsolation } from '../safety-gate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'real-write-loop');

/** 写闭环场景（对着 dummy 夹具的 empty-one 集合：seed 时 W1 有 0 条，读回干净）。 */
export const WRITE_COLLECTION = 'empty-one';
export const WRITE_WINDOW = 'W1';
export const EXPECTED_RECORDS: ReadonlyArray<{ name: string; value: number }> = [
  { name: 'item-1', value: 100 },
  { name: 'item-2', value: 100 },
  { name: 'item-3', value: 100 },
  { name: 'item-4', value: 100 },
];
export const USER_TURN_1 =
  `请帮我在 ${WRITE_COLLECTION} 集合的 ${WRITE_WINDOW} 窗口里新增 4 条记录：`
  + 'name 分别是 item-1、item-2、item-3、item-4，value 都是 100。';
export const USER_TURN_2 = '确认';
const PRINCIPAL_ID = 'wecom:fixture-writer';
const SESSION_ID = 'wecom:write-loop';
const FAKE_CHANNEL = 'wecom';

/** 冗余过程话术的固定短语表（观察③用；只是已知子串命中记录，不是质量判据）。 */
export const PROCESS_TALK_PHRASES: readonly string[] = [
  '收到，正在处理',
  '正在处理',
  '请稍等',
  '稍等一下',
  '马上处理',
  '这就去办',
];

// ---------------------------------------------------------------------------
// 输出（脱敏：绝对路径先替换再走 server-paths 一把尺；密钥永不打印）
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[string, string]> = [];
function registerRedaction(absolute: string | undefined, label: string): void {
  if (absolute !== undefined && absolute !== '') REDACTIONS.unshift([absolute, label]);
}
function redact(text: string): string {
  let out = text;
  for (const [absolute, label] of REDACTIONS) out = out.split(absolute).join(label);
  return stripServerPaths(out).text;
}
function log(line: string): void {
  console.log(redact(line));
}
/** 机器可读行（与人类可读行并行一份，供证据聚合）。 */
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(redact(JSON.stringify({ event, ...detail })));
}

// ---------------------------------------------------------------------------
// 证据形状（判据与观察都在这些形状上评估——纯函数，见文件尾）
// ---------------------------------------------------------------------------

export interface TurnEvidence {
  index: number;
  userText: string;
  reply: string;
  durationMs: number;
  error?: string;
}

export interface ToolCallEvidence {
  seq: number;
  agent: 'main' | 'worker';
  turn: number;
  tool: string;
  /** 参数摘要（JSON，已脱敏；模型给的业务值原样保留，便于人工核对）。 */
  args: string;
  ok: boolean;
  summary: string;
  elapsedMs: number;
}

export interface PushEvidence {
  at: string;
  source: 'push_text' | 'file_push';
  text: string;
}

export interface LedgerSnapshot {
  at: string;
  taskId: string;
  status: string;
  executions: Array<{ operation: string; status: string }>;
  proposal?: {
    summary: string;
    /** 句柄只留前缀（凭据不进证据面；判据只看存在性与「已消耗」事实）。 */
    handlePrefix: string;
    operation: string;
  };
}

export interface AuditRow {
  mode: string;
  script: string;
  via?: string;
  exitCode?: number;
  refused?: string;
  args?: unknown;
}

export interface QueryReading {
  status: string;
  collection?: string;
  window?: string;
  count?: number;
  sum?: number;
  items?: Array<{ id?: string; name?: string; value?: unknown }>;
  errorCode?: string;
}

export interface WriteLoopEvidence {
  turns: TurnEvidence[];
  toolCalls: ToolCallEvidence[];
  pushes: PushEvidence[];
  ledger: {
    taskId?: string;
    taskCount: number;
    /** 观测到的状态序列（250ms 轮询；观测粒度即事实边界）——主任务（首个）。 */
    statusSequence: string[];
    snapshots: LedgerSnapshot[];
    finalStatus?: string;
    finalExecutions: Array<{ operation: string; status: string }>;
    /** 会话内每个任务的终局（多任务如实列出，主任务排首）。 */
    finalTasks: Array<{ taskId: string; taskNo?: number; status: string; executions: Array<{ operation: string; status: string }> }>;
    proposal?: { summary: string; handlePrefix: string; operation: string };
  };
  audit: AuditRow[];
  confirmations: {
    usedByCommit: boolean;
    usedAt?: string;
    boundCollection?: string;
    boundWindow?: string;
    boundCount?: number;
  };
  readbackBefore: QueryReading;
  readbackAfter: QueryReading;
  wake?: { outcome: string; text?: string };
  deliveryEvents: Array<Record<string, unknown>>;
}

export interface CriterionResult {
  id: string;
  title: string;
  /** mechanical = 纯机械事实；structured = 结构化提取（工具名/事件字段等）。 */
  kind: 'mechanical' | 'structured';
  status: 'pass' | 'fail';
  detail: string;
}

export interface ObservationResult {
  id: string;
  title: string;
  detail: string;
}

function digestValue(value: unknown, maxLength = 400): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 底账执行事实里某个 operation 的全部记录（保序）。 */
function sequenceOfOperation(
  executions: ReadonlyArray<{ operation: string; status: string }>,
  operation: string,
): Array<{ operation: string; status: string }> {
  return executions.filter((execution) => execution.operation === operation);
}

function summarizeToolResult(result: unknown): string {
  if (result !== null && typeof result === 'object') {
    const record = result as { status?: unknown; outcome?: unknown; error?: unknown; userMessage?: unknown };
    const status = typeof record.status === 'string' ? record.status : (typeof record.outcome === 'string' ? record.outcome : 'unknown');
    const code = record.error !== null && typeof record.error === 'object' && typeof (record.error as { code?: unknown }).code === 'string'
      ? ` error=${(record.error as { code: string }).code}`
      : '';
    return `${status}${code}`;
  }
  return String(result).slice(0, 200);
}

// ---------------------------------------------------------------------------
// 记录包装器（唯一允许的插桩：TurnDriver 透传包装，采工具调用与唤醒出口）
// ---------------------------------------------------------------------------

interface RecordingSink {
  currentTurn: number;
  toolCalls: ToolCallEvidence[];
  pushes: PushEvidence[];
  wake?: { outcome: string; text?: string };
  seq: number;
}

/** 透传包装：不改语义，只记录 exec 调用（工具名/参数/结果摘要）与 wake 出口。 */
export function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: RecordingSink): TurnDriver {
  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput) {
      const turn = sink.currentTurn;
      const wrappedInput: TurnDriverInput = {
        ...input,
        exec: async (tool, args, signal) => {
          sink.seq += 1;
          const seq = sink.seq;
          const startedMs = Date.now();
          try {
            const result = await input.exec(tool, args, signal);
            sink.toolCalls.push({
              seq, agent, turn, tool,
              args: digestValue(args),
              ok: true,
              summary: summarizeToolResult(result),
              elapsedMs: Date.now() - startedMs,
            });
            return result;
          } catch (error) {
            sink.toolCalls.push({
              seq, agent, turn, tool,
              args: digestValue(args),
              ok: false,
              summary: error instanceof Error ? error.message : String(error),
              elapsedMs: Date.now() - startedMs,
            });
            throw error;
          }
        },
      };
      return await inner.run(wrappedInput);
    },
    ...(inner.wake === undefined
      ? {}
      : {
          async wake(factText: string, options?: { deadline?: number }): Promise<WakeResult> {
            const result = await inner.wake!(factText, options);
            sink.wake = { outcome: result.outcome, ...(result.text === undefined ? {} : { text: result.text }) };
            return result;
          },
        }),
    ...(inner.transcript === undefined ? {} : { transcript: () => inner.transcript!() }),
    ...(inner.close === undefined ? {} : { close: () => inner.close!() }),
    ...(inner.sessionInfo === undefined ? {} : { sessionInfo: () => inner.sessionInfo!() }),
    ...(inner.synthesizeAssistant === undefined
      ? {}
      : { synthesizeAssistant: (text: string) => inner.synthesizeAssistant!(text) }),
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// 任务底账观测（只读第二连接；250ms 轮询，记录观测到的状态序列与提案）
// ---------------------------------------------------------------------------

export class LedgerWatcher {
  readonly snapshots: LedgerSnapshot[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly lastSignature = new Map<string, string>();

  constructor(
    private readonly registry: SqliteTaskRegistry,
    private readonly scope: TaskScope,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    const tick = (): void => {
      try {
        this.sample();
      } catch {
        // 只读观测不得影响主流程（库暂不可读 = 采样缺口，不抛）。
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  sample(): void {
    for (const record of this.registry.list(this.scope)) {
      const executions = record.executions.map((execution) => ({
        operation: execution.operation,
        status: execution.status,
      }));
      const confirmation = record.pendingQuestion?.confirmation;
      const proposal = confirmation === undefined
        ? undefined
        : {
            summary: confirmation.summary,
            handlePrefix: confirmation.handle.slice(0, 12),
            operation: confirmation.operation,
          };
      const signature = JSON.stringify([record.status, executions, proposal?.summary ?? '']);
      if (this.lastSignature.get(record.taskId) === signature) continue;
      this.lastSignature.set(record.taskId, signature);
      this.snapshots.push({
        at: new Date().toISOString(),
        taskId: record.taskId,
        status: record.status,
        executions,
        ...(proposal === undefined ? {} : { proposal }),
      });
    }
  }

  taskIds(): string[] {
    return [...new Set(this.snapshots.map((snapshot) => snapshot.taskId))];
  }

  sequenceOf(taskId: string): string[] {
    const seen: string[] = [];
    for (const snapshot of this.snapshots) {
      if (snapshot.taskId !== taskId) continue;
      if (seen[seen.length - 1] !== snapshot.status) seen.push(snapshot.status);
    }
    return seen;
  }
}

// ---------------------------------------------------------------------------
// 执行层证据（它自己的 audit.jsonl 与 confirmations.json）
// ---------------------------------------------------------------------------

export function readAuditRows(stateDir: string): AuditRow[] {
  const file = path.join(stateDir, 'audit.jsonl');
  if (!existsSync(file)) return [];
  const rows: AuditRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      rows.push({
        mode: typeof parsed['mode'] === 'string' ? parsed['mode'] : 'unknown',
        script: typeof parsed['script'] === 'string' ? parsed['script'] : 'unknown',
        ...(typeof parsed['via'] === 'string' ? { via: parsed['via'] } : {}),
        ...(typeof parsed['exitCode'] === 'number' ? { exitCode: parsed['exitCode'] } : {}),
        ...(typeof parsed['refused'] === 'string' ? { refused: parsed['refused'] } : {}),
        ...(parsed['args'] === undefined ? {} : { args: parsed['args'] }),
      });
    } catch {
      // 坏行不吞：按 unknown 记一行（执行层证据面不许静默丢）。
      rows.push({ mode: 'unparsable', script: 'unknown' });
    }
  }
  return rows;
}

export interface ConfirmationFacts {
  usedByCommit: boolean;
  usedAt?: string;
  boundCollection?: string;
  boundWindow?: string;
  boundCount?: number;
}

/** 读执行层确认句柄账：轴心句柄（绑定目标集合的那条）是否已被 commit 消耗。 */
export function readConfirmationFacts(stateDir: string, collection: string): ConfirmationFacts {
  const file = path.join(stateDir, 'confirmations.json');
  if (!existsSync(file)) return { usedByCommit: false };
  const store = JSON.parse(readFileSync(file, 'utf8')) as {
    confirmations?: Record<string, { usedAt?: string | null; usedBy?: string; collection?: string; window?: string; count?: number }>;
  };
  const entries = Object.values(store.confirmations ?? {});
  const target = entries.find((entry) => entry.collection === collection) ?? entries[0];
  if (target === undefined) return { usedByCommit: false };
  const usedAt = typeof target.usedAt === 'string' && target.usedAt !== '' ? target.usedAt : undefined;
  return {
    usedByCommit: usedAt !== undefined && target.usedBy === 'dummy.commit',
    ...(usedAt === undefined ? {} : { usedAt }),
    ...(target.collection === undefined ? {} : { boundCollection: target.collection }),
    ...(target.window === undefined ? {} : { boundWindow: target.window }),
    ...(target.count === undefined ? {} : { boundCount: target.count }),
  };
}

// ---------------------------------------------------------------------------
// 结构化读回（经同源执行面；**只读权限**，读回路径结构上不可能写）
// ---------------------------------------------------------------------------

interface ReadbackOptions {
  profile: Parameters<typeof resolveExecutionFace>[0]['profile'];
  env: NodeJS.ProcessEnv;
  stateDir: string;
  collection: string;
  window: string;
}

export async function readCollection(options: ReadbackOptions): Promise<QueryReading> {
  const face = await resolveExecutionFace({
    profile: options.profile,
    env: options.env,
    stateDir: options.stateDir,
    emptyOperationsMessage: '执行层没有声明任何只读 operation——读回前置未通过。',
    allowWriteOperations: false,
    allowedPermissions: ['read'],
  });
  const outcome: ExecutionOutcome = await face.client.execute({
    requestId: `readback-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    dispatchKey: `write-loop-readback-${options.collection}-${options.window}`,
    operation: 'dummy.query',
    args: { '--collection': options.collection, '--window': options.window },
  });
  if (outcome.status !== 'completed') {
    return {
      status: outcome.status,
      ...(outcome.status === 'failed' || outcome.status === 'refused' ? { errorCode: outcome.error.code } : {}),
    };
  }
  const data = (outcome.data ?? {}) as {
    collection?: string;
    window?: string | null;
    count?: number;
    sum?: number;
    items?: Array<{ id?: string; name?: string; value?: unknown }>;
  };
  return {
    status: 'completed',
    ...(data.collection === undefined ? {} : { collection: data.collection }),
    ...(typeof data.window === 'string' ? { window: data.window } : {}),
    ...(typeof data.count === 'number' ? { count: data.count } : {}),
    ...(typeof data.sum === 'number' ? { sum: data.sum } : {}),
    ...(data.items === undefined ? {} : { items: data.items.map((item) => ({ id: item.id, name: item.name, value: item.value })) }),
  };
}

// ---------------------------------------------------------------------------
// 判据与观察（纯函数；测试钉住正反两向）
// ---------------------------------------------------------------------------

export function evaluateCriteria(evidence: WriteLoopEvidence): CriterionResult[] {
  const results: CriterionResult[] = [];
  const add = (id: string, title: string, kind: CriterionResult['kind'], pass: boolean, detail: string): void => {
    results.push({ id, title, kind, status: pass ? 'pass' : 'fail', detail });
  };

  // C1 写前基线：empty-one W1 = 0 条（读回干净才有「新增 4 条」可言）。
  add(
    'C1', `写前基线读回 ${WRITE_COLLECTION}/${WRITE_WINDOW} = 0 条`, 'mechanical',
    evidence.readbackBefore.status === 'completed' && evidence.readbackBefore.count === 0,
    `status=${evidence.readbackBefore.status} count=${String(evidence.readbackBefore.count)}`,
  );

  // C2 执行层收到 prepare（执行层自己的审计行）：至少一条成功行（exit=0 即拿到提案）；
  // 失败的重试尝试如实列在 detail（不当违约——模型按执行层错误信息改参数是合法路径）。
  const prepareRows = evidence.audit.filter((row) => row.script === 'dummy.prepare' && row.via === 'structured');
  add(
    'C2', '执行层确实收到 dummy.prepare 并成功返回提案（审计行）', 'mechanical',
    prepareRows.some((row) => row.refused === undefined && row.exitCode === 0),
    `structured prepare 行 ${prepareRows.length} 条：${prepareRows.map((row) => `exit=${String(row.exitCode)}${row.refused === undefined ? '' : ` refused=${row.refused}`}`).join('；')}`,
  );

  // C3 底账出现过 waiting_user + 提案（含摘要）。
  const proposal = evidence.ledger.proposal;
  add(
    'C3', '底账出现 waiting_user 与待确认提案（摘要非空）', 'mechanical',
    evidence.ledger.statusSequence.includes('waiting_user')
      && proposal !== undefined
      && proposal.summary.trim() !== ''
      && proposal.handlePrefix !== '',
    proposal === undefined
      ? `状态序列=${evidence.ledger.statusSequence.join('→')}；未观测到 pendingQuestion.confirmation`
      : `序列=${evidence.ledger.statusSequence.join('→')}；提案 operation=${proposal.operation} summary=${proposal.summary}`,
  );

  // C4 「确认」回合确实调用 task_confirm，且宿主接续（outcome=started）。
  const confirmCalls = evidence.toolCalls.filter((call) => call.tool === 'task_confirm');
  add(
    'C4', '「确认」回合调用 task_confirm 并接续任务（started）', 'structured',
    confirmCalls.some((call) => call.ok && call.summary.startsWith('started')),
    confirmCalls.length === 0
      ? '工具调用记录里没有 task_confirm'
      : confirmCalls.map((call) => `${call.tool}(${call.args}) → ${call.summary}`).join('; '),
  );

  // C5 写只发生一次（执行层两处账交叉核对）：
  //   · 底账执行事实里 commit 成功（completed）恰好 1 条；
  //   · 执行层审计里成功的 commit 行恰好 1 条（exit=0 且无 refused）；
  //   · 句柄被消耗（usedAt）。
  // 被拒/失败的 commit 尝试**登记在 detail，不判红**——无句柄的 commit 被拒
  // （CONFIRMATION_REQUIRED）正是确认闸在工作（句柄只在确认路径透传）；写有没有重复
  // 由「成功恰好一次」+ C6 读回条数（不是 8 条）共同钉住。
  const commitExecutions = sequenceOfOperation(evidence.ledger.finalExecutions, 'dummy.commit');
  const completedCommits = commitExecutions.filter((execution) => execution.status === 'completed');
  const refusedCommits = commitExecutions.filter((execution) => execution.status !== 'completed');
  const commitAuditSuccess = evidence.audit.filter((row) =>
    row.script === 'dummy.commit' && row.via === 'structured' && row.refused === undefined && row.exitCode === 0);
  add(
    'C5', '写入恰好一次：成功 commit 1 次（底账 + 执行层审计）且提案句柄被消耗', 'mechanical',
    completedCommits.length === 1 && commitAuditSuccess.length === 1 && evidence.confirmations.usedByCommit,
    `底账 commit 事实=成功 ${completedCommits.length} 条／未成功 ${refusedCommits.length} 条`
      + `（${refusedCommits.map((execution) => execution.status).join(',') || '-'}）`
      + `；审计成功行 ${commitAuditSuccess.length} 条；usedAt=${evidence.confirmations.usedAt ?? '(未消耗)'}`
      + `（绑定 ${evidence.confirmations.boundCollection ?? '?'}/${evidence.confirmations.boundWindow ?? '?'} 共 ${String(evidence.confirmations.boundCount)} 条）`,
  );

  // C6 写后读回：条数与逐条内容。
  const after = evidence.readbackAfter;
  const names = (after.items ?? []).map((item) => item.name);
  const values = (after.items ?? []).map((item) => item.value);
  const contentMatches = names.length === EXPECTED_RECORDS.length
    && EXPECTED_RECORDS.every((expected, index) => names[index] === expected.name && values[index] === expected.value);
  add(
    'C6', `写后读回 ${WRITE_COLLECTION}/${WRITE_WINDOW} = 4 条且 name/value 与请求一致`, 'mechanical',
    after.status === 'completed' && after.count === EXPECTED_RECORDS.length && contentMatches,
    `status=${after.status} count=${String(after.count)} items=${digestValue(after.items)}`,
  );

  // C7 底账终态与执行事实形状：终态 completed；成功 prepare(needs_confirmation) 先于**唯一一次
  // 成功 commit**（写发生在确认之后，顺序可查）。不要求执行事实恰好两条：模型的重试、
  // 无句柄 commit 被拒、Worker 事后读回都是合法事实，如实记录不当违约。
  const proposalIndex = evidence.ledger.finalExecutions.findIndex((execution) =>
    execution.operation === 'dummy.prepare' && execution.status === 'needs_confirmation');
  const completedCommitIndex = evidence.ledger.finalExecutions.findIndex((execution) =>
    execution.operation === 'dummy.commit' && execution.status === 'completed');
  add(
    'C7', '底账终态 completed；成功的 prepare(needs_confirmation) 先于唯一一次成功 commit(completed)', 'mechanical',
    evidence.ledger.finalStatus === 'completed'
      && proposalIndex >= 0
      && completedCommitIndex > proposalIndex
      && completedCommits.length === 1,
    `finalStatus=${String(evidence.ledger.finalStatus)} executions=${evidence.ledger.finalExecutions.map((execution) => `${execution.operation}:${execution.status}`).join(',') || '(空)'}`,
  );

  // C8 完成消息出现在用户可见面（答对谁写的判在观察②）。
  const completionPushes = evidence.pushes.filter((push) => push.source === 'push_text' && push.text.trim() !== '');
  const relayedInTurn = evidence.deliveryEvents.some((event) =>
    event['event'] === 'task_result_delivery_suppressed' && event['reason'] === 'relayed_in_turn');
  const replyWithText = evidence.turns.filter((turn) => turn.reply.trim() !== '');
  add(
    'C8', '完成消息出现在用户可见面（主动投递或本回合回复）', 'mechanical',
    evidence.ledger.finalStatus === 'completed'
      && (completionPushes.length >= 1 || (relayedInTurn && replyWithText.length >= 2)),
    `push_text ${completionPushes.length} 条；relayed_in_turn=${relayedInTurn}`,
  );

  // C9 底账状态序列（观测）：确认路径确实把任务从等待里带回执行（waiting_user 之后 wieder running），
  // 不是「等确认 → 直接终态」。序列按序包含（允许观测到额外中间态）。
  const orderedSequence = evidence.ledger.statusSequence;
  const subsequence = ['running', 'waiting_user', 'running', 'completed'];
  let cursor = 0;
  for (const status of orderedSequence) {
    if (status === subsequence[cursor]) cursor += 1;
  }
  add(
    'C9', '底账状态序列按序包含 running → waiting_user → running → completed', 'mechanical',
    cursor === subsequence.length,
    `观测序列=${orderedSequence.join(' → ') || '(空)'}`,
  );

  return results;
}

export function evaluateObservations(evidence: WriteLoopEvidence, proposalSummary: string | undefined): ObservationResult[] {
  const observations: ObservationResult[] = [];

  // ① 提案那条消息里有没有执行层摘要（已知字符串存在性——不算判据、不判措辞）。
  const proposalMessages = evidence.pushes.filter((push) => push.source === 'push_text');
  const summaryInMessage = proposalSummary !== undefined && proposalSummary !== ''
    ? proposalMessages.some((push) => push.text.includes(proposalSummary)) || evidence.turns.some((turn) => turn.reply.includes(proposalSummary))
    : false;
  const summaryPrefix = proposalSummary?.slice(0, 40) ?? '';
  const prefixInMessage = summaryPrefix !== ''
    ? proposalMessages.some((push) => push.text.includes(summaryPrefix)) || evidence.turns.some((turn) => turn.reply.includes(summaryPrefix))
    : false;
  observations.push({
    id: 'O1',
    title: '提案消息里有没有执行层摘要',
    detail: proposalSummary === undefined
      ? '底账未记录提案摘要，无法比对'
      : `摘要全文命中=${summaryInMessage}；摘要前 40 字命中=${prefixInMessage}；投影摘要=${summaryPrefix}…`,
  });

  // ② 完成那条消息是谁的话：唤醒出口（模型）vs 宿主兜底（taskCompletionFallbackText 形状）。
  const wake = evidence.wake;
  const lastPush = [...evidence.pushes].reverse().find((push) => push.source === 'push_text');
  const fallbackMarker = '办好了：';
  const pushedText = lastPush?.text ?? '';
  observations.push({
    id: 'O2',
    title: '完成那条消息是谁的话',
    detail: wake === undefined
      ? '未观测到唤醒出口'
      : wake.outcome !== 'woken' || (wake.text ?? '').trim() === ''
        ? `唤醒出口=${wake.outcome}（非模型正文）→ 完成消息走了宿主兜底路径；投递文本=${digestValue(pushedText, 200)}`
        : wake.text === pushedText
          ? `模型的话（wake=woken，投递文本与唤醒回合正文逐字相同）：${digestValue(wake.text, 300)}`
          : pushedText.includes(fallbackMarker) && !wake.text!.includes(fallbackMarker)
            ? `宿主兜底（投递文本带「${fallbackMarker}」且与唤醒正文不同）：${digestValue(pushedText, 200)}`
            : `模型的话（wake=woken；投递文本与唤醒正文不同：WakeResult 与投递面各自记录）：${digestValue(pushedText, 200)}`,
  });

  // ③ 冗余过程话术（固定短语表命中记录；不判红）。
  const visibleTexts = [
    ...evidence.turns.map((turn) => turn.reply),
    ...evidence.pushes.map((push) => push.text),
  ].filter((text) => text.trim() !== '');
  const hits = PROCESS_TALK_PHRASES.filter((phrase) => visibleTexts.some((text) => text.includes(phrase)));
  observations.push({
    id: 'O3',
    title: '冗余过程话术（固定短语表命中记录，不当判据）',
    detail: hits.length === 0
      ? `未命中（表：${PROCESS_TALK_PHRASES.join('/')}）`
      : `命中：${hits.join('、')}——原文见证据 userVisible 段，复核以原文为准`,
  });

  return observations;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface WriteLoopOptions {
  outDir?: string;
  turnTimeoutMs: number;
  settleTimeoutMs: number;
}

const USAGE = [
  '用法：node --env-file-if-exists=.env --import tsx scripts/eval/real/write-loop.ts [--out-dir <dir>] [--turn-timeout-ms N] [--settle-timeout-ms N]',
  '  对着仓内 dummy 执行层用**真实模型**（env LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL）',
  '  走一次完整写闭环：交办 → 等确认提案 → 用户「确认」→ 提交 → 读回验证。',
  '  --out-dir <dir>        证据落点（缺省 .runtime/real-write-loop/<时间戳>/）',
  '  --turn-timeout-ms N    单个用户回合的上限（缺省 240000）',
  '  --settle-timeout-ms N  等待后台写入落定的上限（缺省 240000）',
  '  --help                 打印本用法。',
  '判据与观察（全部机械事实）见脚本头部注释与 docs/ops/real-write-loop.md。',
].join('\n');

export function parseWriteLoopArgs(argv: readonly string[]): WriteLoopOptions | { usageError: string } | { help: true } {
  const options: WriteLoopOptions = { turnTimeoutMs: 240_000, settleTimeoutMs: 240_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg.startsWith('--out-dir=')) {
      options.outDir = arg.slice('--out-dir='.length).trim() || undefined;
      continue;
    }
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { usageError: '--out-dir 需要一个值。' };
      options.outDir = value;
      index += 1;
      continue;
    }
    const parsePositiveInt = (flag: string, raw: string): number | { error: string } => {
      const value = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(value) || value <= 0) return { error: `${flag} 必须是正整数（当前：${raw}）。` };
      return value;
    };
    if (arg.startsWith('--turn-timeout-ms=')) {
      const value = parsePositiveInt('--turn-timeout-ms', arg.slice('--turn-timeout-ms='.length));
      if (typeof value !== 'number') return { usageError: value.error };
      options.turnTimeoutMs = value;
      continue;
    }
    if (arg.startsWith('--settle-timeout-ms=')) {
      const value = parsePositiveInt('--settle-timeout-ms', arg.slice('--settle-timeout-ms='.length));
      if (typeof value !== 'number') return { usageError: value.error };
      options.settleTimeoutMs = value;
      continue;
    }
    return { usageError: `未知参数：${digestValue(arg, 80)}（--help 看用法）。` };
  }
  return options;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

class InfraAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraAbort';
  }
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function receipt(route: ChannelRoute, kind: 'text' | 'file'): DeliveryReceipt {
  return { route, parts: [{ kind, index: 0, status: 'sent' }] };
}

/** 自动生成的运行目录（显式 --out-dir 时 undefined）：前置门失败时清掉，不留空目录。 */
let autoRunDirForCleanup: string | undefined;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseWriteLoopArgs(argv);
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  if ('usageError' in parsed) {
    console.error(parsed.usageError);
    process.exitCode = 2;
    return;
  }
  const options = parsed;

  const runDir = options.outDir !== undefined
    ? path.resolve(options.outDir)
    : path.join(DEFAULT_OUT_ROOT, nowSlug());
  rmSync(runDir, { recursive: true, force: true });
  const stateDir = path.join(runDir, 'state');
  const dbPath = path.join(runDir, 'state.db');
  mkdirSync(stateDir, { recursive: true });
  // 自动生成的运行目录在**前置门失败**时清掉（缺 key 这类拒绝不该留空目录；显式
  // --out-dir 归调用方处置，不清）。有证据落盘（evidence.json）的一律保留。
  autoRunDirForCleanup = options.outDir === undefined ? runDir : undefined;
  registerRedaction(runDir, '<run>');
  registerRedaction(stateDir, '<state>');
  registerRedaction(REPO_ROOT, '<repo>');

  log('== 真模型写闭环验收（server 装配 · 仓内 dummy 执行层 · 不触真实平台） ==');

  // ---- S0 前置门 ----
  log('\n[S0] 前置门（配置 / 写开关 / 角色 / 隔离 / 模型 env）');
  const configCopy = path.join(runDir, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  // 写面总闸（runtime.allowWriteOperations，缺省 false）：本验收要开它，只改本次物化副本。
  configDoc['runtime'] = { ...(configDoc['runtime'] as Record<string, unknown> ?? {}), allowWriteOperations: true };
  configDoc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(configDoc));

  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, process.env);
  const baseUrl = (env['LLM_API_BASE_URL'] ?? '').trim();
  const modelId = (env['LLM_MODEL'] ?? '').trim();
  const apiKey = (env['LLM_API_KEY'] ?? '').trim();
  if (apiKey === '' || baseUrl === '' || modelId === '') {
    throw new InfraAbort(
      '缺少真实模型配置：需要 LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（env 或 .env）。'
      + '本入口不接受脚本模型顶替——跑不通就如实失败。'
      + `当前：baseUrl=${baseUrl === '' ? '(空)' : baseUrl} model=${modelId === '' ? '(空)' : modelId} key=${apiKey === '' ? '(缺失)' : '(已提供)'}`,
    );
  }
  const { id: profileId, profile } = resolveSingleProfile(config);
  const isolation = assessEvalIsolation({ env, platformRoot: profile.root, gateway: profile.gateway });
  if (!isolation.fixtureWithinRepo || !isolation.gatewayPresent) {
    throw new InfraAbort(
      `评测隔离门未过：root 必须在仓内夹具目录之下且 gateway 存在。\n${isolation.problems.join('\n')}`,
    );
  }
  registerRedaction(profile.root, '<fixture>');
  const permissions = permissionsOfRole(config, effectiveRoleOf(config, PRINCIPAL_ID)) as Permission[];
  if (!permissions.includes('write')) {
    throw new InfraAbort(`主体 ${PRINCIPAL_ID} 的角色权限不含 write（当前：${permissions.join(',')}）——写闭环无法验收。`);
  }
  if (config.principals[PRINCIPAL_ID]?.enabled !== true) {
    throw new InfraAbort(`主体 ${PRINCIPAL_ID} 未在配置里开通（enabled）。`);
  }
  log(`  配置源：仓内夹具物化副本（contextProfiles.${profileId} · gateway=${profile.gateway}）`);
  log(`  主体：${PRINCIPAL_ID} · 权限：${permissions.join(',')} · 写开关 runtime.allowWriteOperations=true`);
  log(`  模型：${modelId} @ ${baseUrl}（key ${apiKey === '' ? '缺失' : '已提供，不打印'}）`);
  log(`  隔离：root 在仓内夹具之下=${isolation.fixtureWithinRepo} · gateway 存在=${isolation.gatewayPresent}`);
  emit('real_write_loop_precondition', {
    profileId, principalId: PRINCIPAL_ID, permissions: permissions.join('+'),
    model: modelId, enforceDummyFixture: true,
  });

  // ---- 装配（server 面；假渠道端口 + 记录包装器） ----
  const sink: RecordingSink = { currentTurn: 0, toolCalls: [], pushes: [], seq: 0 };
  const logs: Array<Record<string, unknown>> = [];
  const notifications: Notification[] = [];
  const delivery: FileDeliveryPort = {
    deliveryMode: 'live',
    async sendToConversation(route, files): Promise<DeliveryReceipt> {
      sink.pushes.push({ at: new Date().toISOString(), source: 'file_push', text: `(files:${files.length})` });
      return receipt(route, 'file');
    },
    async sendText(route, text): Promise<DeliveryReceipt> {
      sink.pushes.push({ at: new Date().toISOString(), source: 'push_text', text });
      return receipt(route, 'text');
    },
  };
  const notificationSink: NotificationSink = {
    async send(notification: Notification) {
      notifications.push(notification);
      return { delivered: true };
    },
  };
  const server = await createServer({
    env,
    config,
    dbPath,
    stateDir,
    fileDelivery: delivery,
    notificationSink,
    createDrivers: (driverEnv, mainSession) => ({
      // 与缺省装配逐项同形（ask-runtime 的缺省分支）：Main 持实例级会话 + 会话落盘位置
      // ——**唤醒（wake）以实例级会话为前提**，少了 reuseConversation 就只剩宿主兜底；
      // 思考档同样同源：Main = mainThinkingLevel 回落 thinkingLevel。
      mainDriver: recordingDriver(createPiTurnDriver({
        env: driverEnv,
        ...mainThinkingLevelFrom(driverEnv),
        reuseConversation: true,
        ...mainSessionOptions(mainSession),
      }), 'main', sink),
      workerDriver: recordingDriver(createPiTurnDriver({ env: driverEnv }), 'worker', sink),
    }),
    logger: (line) => logs.push(line),
  });

  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  const scope: TaskScope = { principalId: PRINCIPAL_ID, sessionId: SESSION_ID };
  const watcher = new LedgerWatcher(registry, scope);
  watcher.start();

  const readbackOptions = { profile, env, stateDir, collection: WRITE_COLLECTION, window: WRITE_WINDOW };
  const turns: TurnEvidence[] = [];
  let readbackBefore: QueryReading = { status: 'unavailable' };
  try {
    // ---- S1 写前基线 ----
    log('\n[S1] 写前基线读回（结构化契约 · 只读权限）');
    readbackBefore = await readCollection(readbackOptions);
    log(`  ${WRITE_COLLECTION}/${WRITE_WINDOW}：status=${readbackBefore.status} count=${String(readbackBefore.count)} sum=${String(readbackBefore.sum)}`);
    if (readbackBefore.status !== 'completed' || readbackBefore.count !== 0) {
      throw new InfraAbort(`写前基线不是干净状态（count=${String(readbackBefore.count)}）——本验收要求空集读回。`);
    }
    const auditBaseline = readAuditRows(stateDir).length;
    if (auditBaseline < 1) {
      throw new InfraAbort('执行层审计通道不可用（audit.jsonl 无行）——执行层证据面缺失，判据无法成立。');
    }
    emit('real_write_loop_baseline', { collection: WRITE_COLLECTION, window: WRITE_WINDOW, count: 0, auditLines: auditBaseline });

    // ---- S2 回合 1：用户交办 ----
    const sendTurn = async (index: number, text: string, messageId: string): Promise<TurnEvidence> => {
      sink.currentTurn = index;
      log(`\n[S${index + 1}] 用户回合 ${index}：${text}`);
      const startedMs = Date.now();
      const message: IncomingChannelMessage = {
        wecomUserId: 'fixture-writer',
        channel: FAKE_CHANNEL,
        conversationId: 'write-loop',
        messageId,
        chatType: 'single',
        text,
        receivedAt: new Date().toISOString(),
      };
      let reply = '';
      let error: string | undefined;
      try {
        const result: ChannelReply = await server.handler(message);
        reply = typeof result === 'string' ? result : (result.text ?? '');
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const turn: TurnEvidence = {
        index, userText: text, reply, durationMs: Date.now() - startedMs,
        ...(error === undefined ? {} : { error }),
      };
      turns.push(turn);
      log(`  用户可见回复：${digestValue(reply, 1200)}`);
      emit('real_write_loop_turn', { index, durationMs: turn.durationMs, replyLength: reply.length, error: error ?? null });
      return turn;
    };

    await sendTurn(1, USER_TURN_1, `write-loop-${nowSlug()}-1`);
    // 等提案落到用户可见面（waiting_user 推送 / 回合回复）或超时——超时只影响后续步骤的时序，不伪造事实。
    const sawProposal = await waitFor(
      () => watcher.sequenceOf(watcher.taskIds()[0] ?? '').includes('waiting_user')
        || watcher.snapshots.some((snapshot) => snapshot.proposal !== undefined),
      Math.min(options.turnTimeoutMs, 30_000),
    );
    log(`  提案已落底账：${sawProposal}`);

    // ---- S3 回合 2：用户确认（显式动作 task_confirm） ----
    await sendTurn(2, USER_TURN_2, `write-loop-${nowSlug()}-2`);

    // ---- S4 等写入落定 + 完成投递 ----
    const taskId = watcher.taskIds()[0];
    log('\n[S4] 等待后台写入落定与完成投递');
    const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'unexecuted']);
    const landed = await waitFor(() => {
      if (taskId === undefined) return false;
      for (let index = watcher.snapshots.length - 1; index >= 0; index -= 1) {
        const snapshot = watcher.snapshots[index]!;
        if (snapshot.taskId === taskId) return terminal.has(snapshot.status);
      }
      return false;
    }, options.settleTimeoutMs);
    log(`  底账终态落定：${landed}（任务 ${taskId ?? '未观测到'}）`);
    if (landed) {
      await waitFor(
        () => logs.some((line) => line['event'] === 'task_result_delivery_sent'
          || (line['event'] === 'task_result_delivery_suppressed')),
        30_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    watcher.stop();
  }

  // ---- S5 证据收集 ----
  log('\n[S5] 证据收集（执行层审计 / 确认句柄账 / 底账 / 读回）');
  watcher.sample();
  const audit = readAuditRows(stateDir);
  const confirmations = readConfirmationFacts(stateDir, WRITE_COLLECTION);
  const readbackAfter = await readCollection(readbackOptions);
  const taskIds = watcher.taskIds();
  const taskId = taskIds[0];
  const finalTasks: WriteLoopEvidence['ledger']['finalTasks'] = [];
  for (const id of taskIds) {
    try {
      const record = registry.get(id, scope);
      finalTasks.push({
        taskId: id,
        ...(record.taskNo === undefined ? {} : { taskNo: record.taskNo }),
        status: record.status,
        executions: record.executions.map((execution) => ({ operation: execution.operation, status: execution.status })),
      });
    } catch {
      finalTasks.push({ taskId: id, status: 'unreadable', executions: [] });
    }
  }
  const primary = finalTasks.find((task) => task.taskId === taskId);
  const finalStatus = primary?.status;
  const finalExecutions = primary?.executions ?? [];
  const proposalSnapshot = watcher.snapshots.find((snapshot) => snapshot.proposal !== undefined);
  const proposal = proposalSnapshot?.proposal;

  const deliveryEvents = logs.filter((line) => String(line['event'] ?? '').startsWith('task_result_delivery')
    || line['event'] === 'task_completion_wake'
    || line['event'] === 'notification_push_sent'
    || line['event'] === 'message_done');

  const evidence: WriteLoopEvidence = {
    turns,
    toolCalls: sink.toolCalls,
    pushes: sink.pushes,
    ledger: {
      ...(taskId === undefined ? {} : { taskId }),
      taskCount: taskIds.length,
      statusSequence: taskId === undefined ? [] : watcher.sequenceOf(taskId),
      snapshots: watcher.snapshots,
      ...(finalStatus === undefined ? {} : { finalStatus }),
      finalExecutions,
      finalTasks,
      ...(proposal === undefined ? {} : { proposal }),
    },
    audit,
    confirmations,
    readbackBefore,
    readbackAfter,
    ...(sink.wake === undefined ? {} : { wake: sink.wake }),
    deliveryEvents: deliveryEvents.map((line) => ({ ...line })),
  };

  // ---- 打印证据 ----
  log('\n== 机械证据 ==');
  log(`[任务底账] 会话内任务数=${evidence.ledger.taskCount} · 状态序列（250ms 轮询观测）=${evidence.ledger.statusSequence.join(' → ') || '(未观测到)'}`);
  for (const task of evidence.ledger.finalTasks) {
    log(`  · 任务 ${task.taskId}（#${String(task.taskNo ?? '-')}）终局=${task.status}`
      + `：${task.executions.map((execution) => `${execution.operation}:${execution.status}`).join(' → ') || '(无执行事实)'}`);
  }
  log('[工具调用]（记录包装器透传采集）');
  for (const call of sink.toolCalls) {
    log(`  · #${call.seq} [${call.agent}·回合${call.turn}] ${call.tool}(${call.args}) → ${call.summary}${call.ok ? '' : ' [抛错]'} (${call.elapsedMs}ms)`);
  }
  log('[执行层收到的请求]（执行层自己的 audit.jsonl）');
  for (const row of audit) {
    log(`  · mode=${row.mode} script=${row.script} via=${row.via ?? '-'} exit=${String(row.exitCode ?? '-')}`
      + `${row.refused === undefined ? '' : ` refused=${row.refused}`} args=${digestValue(row.args, 300)}`);
  }
  log('[用户可见面]');
  for (const turn of turns) log(`  · 回合${turn.index} 回复：${digestValue(turn.reply, 1500)}`);
  for (const push of sink.pushes.filter((entry) => entry.source === 'push_text')) log(`  · 主动投递：${digestValue(push.text, 1500)}`);
  log(`[读回] 写前 count=0；写后 status=${readbackAfter.status} count=${String(readbackAfter.count)} sum=${String(readbackAfter.sum)} items=${digestValue(readbackAfter.items)}`);
  log(`[唤醒出口] ${sink.wake === undefined ? '(未观测到)' : `outcome=${sink.wake.outcome} text=${digestValue(sink.wake.text ?? '', 800)}`}`);
  emit('real_write_loop_audit', { rows: audit.length, structured: audit.filter((row) => row.via === 'structured').length });
  emit('real_write_loop_readback', { status: readbackAfter.status, count: readbackAfter.count ?? null });

  // ---- 判据与观察 ----
  const criteria = evaluateCriteria(evidence);
  const observations = evaluateObservations(evidence, proposal?.summary);
  log('\n== 判据（机械事实） ==');
  for (const criterion of criteria) {
    log(`  [${criterion.status === 'pass' ? 'PASS' : 'FAIL'}] ${criterion.id} ${criterion.title}（${criterion.kind}）`);
    log(`        ${criterion.detail}`);
    emit('real_write_loop_criterion', { id: criterion.id, status: criterion.status, kind: criterion.kind });
  }
  log('\n== 观察（只记录，不判红） ==');
  for (const observation of observations) {
    log(`  · ${observation.id} ${observation.title}：${observation.detail}`);
    emit('real_write_loop_observation', { id: observation.id, detail: observation.detail });
  }

  // ---- 证据落盘 ----
  const evidencePath = path.join(runDir, 'evidence.json');
  const bundle = {
    generatedAt: new Date().toISOString(),
    model: { modelId, apiBaseUrl: redact(baseUrl), apiKeyProvided: apiKey !== '' },
    scenario: {
      principalId: PRINCIPAL_ID, sessionId: SESSION_ID,
      collection: WRITE_COLLECTION, window: WRITE_WINDOW,
      expectedRecords: EXPECTED_RECORDS, userTurns: [USER_TURN_1, USER_TURN_2],
    },
    evidence: {
      ...evidence,
      turns: evidence.turns.map((turn) => ({ ...turn, reply: redact(turn.reply) })),
      pushes: evidence.pushes.map((push) => ({ ...push, text: redact(push.text) })),
      ...(evidence.wake === undefined ? {} : { wake: { outcome: evidence.wake.outcome, ...(evidence.wake.text === undefined ? {} : { text: redact(evidence.wake.text) }) } }),
      ...(evidence.ledger.proposal === undefined
        ? {}
        : { ledger: { ...evidence.ledger, proposal: { ...evidence.ledger.proposal, summary: redact(evidence.ledger.proposal.summary) } } }),
    },
    notifications: notifications.map((notification) => ({ kind: notification.kind, taskId: notification.taskId, createdAt: notification.createdAt })),
    criteria,
    observations,
  };
  writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`);
  log(`\n证据已落盘：${path.relative(REPO_ROOT, evidencePath)}（gitignored；不含密钥）`);

  await server.close();
  registry.close();

  const failed = criteria.filter((criterion) => criterion.status === 'fail');
  log(`\n== 写闭环结束：判据 ${criteria.length} 条，pass=${criteria.length - failed.length} fail=${failed.length} ==`);
  if (failed.length > 0) {
    for (const criterion of failed) log(`  FAIL ${criterion.id}：${criterion.detail}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    if (error instanceof InfraAbort) {
      console.error(`\n前置未过（如实失败，不退回脚本模型）：${redact(error.message)}`);
      if (autoRunDirForCleanup !== undefined && !existsSync(path.join(autoRunDirForCleanup, 'evidence.json'))) {
        rmSync(autoRunDirForCleanup, { recursive: true, force: true });
      }
      process.exitCode = 2;
      return;
    }
    console.error(`验收中断：${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
