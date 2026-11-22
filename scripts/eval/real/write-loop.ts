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
 *   C9 底账状态序列按序包含 running → waiting_user → running → completed（确认把任务带回执行）；
 *   C10 有执行层摘要时，用户可见文本里出现摘要关键字段（集合名、窗口码、记录条数——
 *   这些是执行层给的已知字符串，属"已知字符串存在性"，不违红线；无摘要时判 inconclusive，不判红）。
 * 不要求执行事实恰好两条：模型重试、无句柄 commit 被拒、Worker 事后读回都是合法事实，
 * 如实记录不当违约。
 * 两条观察（**只记录、不判红**，见 evaluateObservations）：① 完成那条消息是模型的话还是宿主兜底；
 * ② 有没有「收到，正在处理」这类冗余过程话术（固定短语表的已知子串命中记录，不当质量判据）。
 * （原观察 O1「摘要全文命中」已升级为判据 C10，见 evaluateCriteria。）
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
import { renderNotification } from '../../../packages/agent/src/notification-render';
import { scanUserVisibleText } from '../shared/internal-terms';
import {
  checkTurnFaceShape,
  createDeliveryProvenanceAttributor,
  formatShapeViolations,
  type ShapeViolation,
  type TaskFactKind,
} from '../shared/conversation-shape';
import { stripServerPaths } from '../../../packages/agent/src/server-paths';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from '../../../packages/agent/testing/task-facts';
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
  /** 回合开始时刻（毫秒；对话形态判据的流内排序用）。 */
  atMs?: number;
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
  /** 投递记账归属的任务（采集端按 task_result_delivery_sent 记账补填；可选——迟到的完成投递靠它归属）。 */
  taskId?: string;
  /** 投递归属的事实种类（与 taskId 同源补填；对话形态 ② 判「同一事实投递两次」用）。 */
  factKind?: TaskFactKind;
  /** 非文字推送（file_push 占位）不进对话形态面。 */
  excluded?: boolean;
}

export interface LedgerSnapshot {
  at: string;
  taskId: string;
  liveness: string | null;
  cancelled: boolean;
  reported: boolean;
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
    factSequence: string[];
    snapshots: LedgerSnapshot[];
    finalReported?: boolean;
    finalExecutions: Array<{ operation: string; status: string }>;
    /** 会话内每个任务的终局（多任务如实列出，主任务排首）。 */
    finalTasks: Array<{ taskId: string; taskNo?: number; liveness: string | null; cancelled: boolean; reported: boolean; executions: Array<{ operation: string; status: string }> }>;
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
      const signature = JSON.stringify([taskLivenessOf(record) ?? null, record.cancelledAt !== undefined, archivedReportOf(record) !== undefined, executions, proposal?.summary ?? '']);
      if (this.lastSignature.get(record.taskId) === signature) continue;
      this.lastSignature.set(record.taskId, signature);
      this.snapshots.push({
        at: new Date().toISOString(),
        taskId: record.taskId,
        liveness: taskLivenessOf(record) ?? null,
        cancelled: record.cancelledAt !== undefined,
        reported: archivedReportOf(record) !== undefined,
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
      // 机械事实标签：liveness 三值 + 取消/汇报事实 + 末条执行行原值（不合成任务级状态词）。
      const lastExecutionStatus = snapshot.executions[snapshot.executions.length - 1]?.status;
      const fact = `liveness=${snapshot.liveness ?? 'null'} cancelled=${snapshot.cancelled} reported=${snapshot.reported} exec=${lastExecutionStatus ?? 'null'}`;
      if (seen[seen.length - 1] !== fact) seen.push(fact);
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

/**
 * 摘要的关键字段（执行层给的已知字符串；存在性判据，不判措辞质量）：
 *   · 集合名 —— 摘要里的「<name>」；
 *   · 窗口码 —— 「<code> 窗口」；
 *   · 记录条数 —— 「共 <n> 条」的整段（含数字与量词，避免只凭一个数字命中）。
 * 任取不到的字段不算违约（摘要形状可能因执行层版本变化），只按取到的字段判存在性。
 */
export function summaryKeyFields(summary: string | undefined): string[] {
  if (summary === undefined || summary.trim() === '') return [];
  const fields: string[] = [];
  const collection = /「[^」]+」/u.exec(summary);
  if (collection !== null) fields.push(collection[0]);
  const window = /[A-Za-z0-9_-]+\s*窗口/u.exec(summary);
  if (window !== null) fields.push(window[0]);
  const count = /共\s*\d+\s*条/u.exec(summary);
  if (count !== null) fields.push(count[0]);
  return fields;
}

/**
 * 「已知字符串存在性」的比对形态（2026-11-20 第三次同形假红修复）：去掉包裹类符号
 * （「」『』【】[]()（）“”‘’）并折叠空白后做包含判定——括号与空白是排版，不是事实内容
 * ——写闭环 2/3 次实测：模型把摘要里的「empty-one」（带角括号字面量）改写成
 * 「empty-one 集合」就挂 C10。数值/条数/对象名本身的事实内容**不放宽**：
 * 去括号只让「共 4 条」匹配「共4条」，「共 40 条」仍不命中（负例绊线）。
 */
export function bareForm(text: string): string {
  return text.replace(/[「」『』【】[\]()（）“”‘’"']/gu, '').replace(/\s+/gu, '');
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
/** 十位/个位汉字的边界：避免「四」在「十四」里被当成 4。 */
const CN_NUMERAL_CHARS = '零一二两三四五六七八九十百千万亿';

/**
 * 1～99 的中文写法（判据只需识别摘要里抽取出的那个小整数条数；≥100 不猜中文形态，
 * 交给阿拉伯数字 token 判定）。这是字面转换，不是语义理解。
 */
export function chineseNumeral(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 100) return '';
  if (n < 10) return CN_DIGITS[n]!;
  if (n < 20) return `十${n === 10 ? '' : CN_DIGITS[n - 10]!}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${CN_DIGITS[tens]!}十${ones === 0 ? '' : CN_DIGITS[ones]!}`;
}

/**
 * 条数 token 命中（2026-11-20 第四次同形假红修复）：从摘要字段「共 N 条」抽出 N，判
 * 用户可见面是否出现**独立的** N——阿拉伯数字前后都不是数字（所以 4 不命中 40/14/140），
 * 或 N 的中文写法独立出现（「四条」算命中）。这是"已知字符串存在性"的机械扩展：
 * 只认执行层摘要给的那个数，不判措辞、不判语义——模型说「新增 4 条」「四条记录」都算，
 * 完全不提条数 / 只写 40 / 只写 14 都不算。
 *
 * 拦的是：摘要把条数给了用户，但用户可见面把这个数改成了别的数或干脆省略。
 * 可能漏判：可见面出现的 4 指的是别的量（如「4 个字段」）也可能被当成条数命中——
 * 但这仍是字符串存在性层面的机械判定，语义层面的对错归用户级 eval，不在此处扩张。
 */
export function countTokenHit(countField: string, texts: readonly string[]): boolean {
  const match = /共\s*(\d+)\s*条/u.exec(countField);
  if (match === null) return false; // 抽不出 N：形状变了，按缺失处理，不冒充命中。
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n)) return false;
  const ascii = String(n); // 去前导零，统一比较形态。
  const asciiToken = new RegExp(`(?<![0-9])${ascii}(?![0-9])`, 'u');
  const zh = chineseNumeral(n);
  const zhToken = zh === ''
    ? null
    : new RegExp(`(?<![${CN_NUMERAL_CHARS}0-9])${zh}(?![${CN_NUMERAL_CHARS}0-9])`, 'u');
  return texts.some((text) => asciiToken.test(text) || (zhToken !== null && zhToken.test(text)));
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
    evidence.ledger.factSequence.includes('waiting_user')
      && proposal !== undefined
      && proposal.summary.trim() !== ''
      && proposal.handlePrefix !== '',
    proposal === undefined
      ? `状态序列=${evidence.ledger.factSequence.join('→')}；未观测到 pendingQuestion.confirmation`
      : `序列=${evidence.ledger.factSequence.join('→')}；提案 operation=${proposal.operation} summary=${proposal.summary}`,
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
    evidence.ledger.finalReported === true
      && proposalIndex >= 0
      && completedCommitIndex > proposalIndex
      && completedCommits.length === 1,
    `finalReported=${String(evidence.ledger.finalReported)} executions=${evidence.ledger.finalExecutions.map((execution) => `${execution.operation}:${execution.status}`).join(',') || '(空)'}`,
  );

  // C8 完成消息出现在用户可见面（答对谁写的判在观察②）。
  const completionPushes = evidence.pushes.filter((push) => push.source === 'push_text' && push.text.trim() !== '');
  const relayedInTurn = evidence.deliveryEvents.some((event) =>
    event['event'] === 'task_result_delivery_suppressed' && event['reason'] === 'relayed_in_turn');
  const replyWithText = evidence.turns.filter((turn) => turn.reply.trim() !== '');
  add(
    'C8', '完成消息出现在用户可见面（主动投递或本回合回复）', 'mechanical',
    evidence.ledger.finalReported === true
      && (completionPushes.length >= 1 || (relayedInTurn && replyWithText.length >= 2)),
    `push_text ${completionPushes.length} 条；relayed_in_turn=${relayedInTurn}`,
  );

  // C9 底账状态序列（观测）：确认路径确实把任务从等待里带回执行（waiting_user 之后 wieder running），
  // 不是「等确认 → 直接终态」。序列按序包含（允许观测到额外中间态）。
  const orderedSequence = evidence.ledger.factSequence;
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

  // C10 提案摘要转述守卫（PM P1-4）：有执行层摘要时，用户可见文本里必须出现摘要的关键字段
  // （集合名 / 窗口码 / 记录条数）。这些是执行层给的已知字符串，属"已知字符串存在性"，不判措辞。
  // 三类字段按各自性质比对：
  //   · 集合名「empty-one」、窗口码「W1 窗口」——是标识符，不该被模型改写，仍走 bareForm
  //     逐字包含（2026-11-20 前三次同形假红修复）；
  //   · 条数「共 4 条」——用户只需看到那个数，措辞可换（「新增 4 条」「四条记录」都算），
  //     改用 countTokenHit 判独立数字 token（2026-11-20 第四次同形假红修复，见该函数注释）。
  // 事实内容不放宽：集合名/窗口码缺一仍判缺失；条数只有 40/14 或完全不提都判缺失。
  // 拦的是：摘要把已知字段给了用户，用户可见面却漏掉或改错（尤其条数被换数/省略）。
  // 可能漏判：可见面的 4 可能指别的量却仍命中——语义对错归用户级 eval，此处只做机械存在性。
  // 用户可见文本 = 各回合回复 + push_text（与原 O1 观察同一取值面）。无摘要 = 前置缺失，判
  // inconclusive（detail 说明，不判红——与"模型没转述"区分开）。
  const keyFields = summaryKeyFields(evidence.ledger.proposal?.summary);
  const userVisible = [
    ...evidence.turns.map((turn) => turn.reply),
    ...evidence.pushes.filter((push) => push.source === 'push_text').map((push) => push.text),
  ];
  if (keyFields.length === 0) {
    results.push({
      id: 'C10', title: '提案摘要关键字段进用户可见面', kind: 'structured', status: 'pass',
      detail: '无执行层摘要或摘要无可提取关键字段 → inconclusive（前置缺失，不判红）',
    });
  } else {
    const hit = (field: string): boolean => {
      if (/^共\s*\d+\s*条$/u.test(field)) return countTokenHit(field, userVisible);
      const expected = bareForm(field);
      return userVisible.some((text) => bareForm(text).includes(expected));
    };
    const missing = keyFields.filter((field) => !hit(field));
    results.push({
      id: 'C10', title: '提案摘要关键字段进用户可见面', kind: 'structured',
      status: missing.length === 0 ? 'pass' : 'fail',
      detail: `摘要关键字段=[${keyFields.join(' | ')}]；`
        + `命中=[${keyFields.filter((field) => hit(field)).join(' | ') || '无'}]；`
        + `缺失=[${missing.join(' | ') || '无'}]（标识符去括号逐字 / 条数按独立数字 token 比对）`,
    });
  }

  return results;
}

/**
 * 用户级批次的通用「内部词泄漏」机械扫描（所有用户级批次共用同一个 scanUserVisibleText）。
 * 命中就是机械事实：调用方据此让本批次**失败**，不降级为观察、不进 judge 加分项。
 *
 * 用户可见面**尽量收全**：
 *   · 每个回合的 Main 回复（turns[].reply）；
 *   · 宿主主动投递文字（push_text：受理回执 / 通知 / 任务完成与失败消息）；
 *   · 宿主通知面（notificationSink 捕获的 Notification，经 renderNotification 还原用户语言）；
 *   · 唤醒出口正文（模型在被唤醒后说给用户的话，通常也会同时进 push_text，这里一并收）。
 * 文件投递（sendToConversation）当前夹具只投 `(files:N)` 计数占位、没有文件说明/caption 文本，
 * 故无 caption 可扫——channels/notes 如实登记该渠道缺口，不拿空数组冒充扫过。
 */
export interface LeakReport {
  hitCount: number;
  hits: Array<{ where: string; marker: string; excerpt: string }>;
  channels: string[];
  notes: string[];
}

export function scanWriteLoopLeaks(evidence: WriteLoopEvidence, notifications: readonly Notification[]): LeakReport {
  const texts: Array<{ where: string; text: string }> = [];
  for (const turn of evidence.turns) texts.push({ where: `回合${turn.index} 回复`, text: turn.reply });
  evidence.pushes.forEach((push, index) => {
    if (push.source === 'push_text') texts.push({ where: `主动投递#${index + 1}(push_text)`, text: push.text });
  });
  notifications.forEach((notification, index) => {
    try {
      texts.push({
        where: `通知#${index + 1}(${notification.kind})`,
        text: renderNotification({ kind: notification.kind, payload: notification.payload }),
      });
    } catch {
      // renderNotification 自身会拦内部术语并抛错（文案根本没到用户）；此处不重复计泄漏。
    }
  });
  if (evidence.wake !== undefined && evidence.wake.text !== undefined && evidence.wake.text !== '') {
    texts.push({ where: '唤醒出口正文', text: evidence.wake.text });
  }
  const { hits } = scanUserVisibleText(texts);
  return {
    hitCount: hits.length,
    hits,
    channels: ['回合回复(Main)', '宿主主动投递文字(push_text)', '宿主通知面(renderNotification)', '唤醒出口正文'],
    notes: [
      '文件投递渠道：本夹具 sendToConversation 只投 (files:N) 计数占位、无文件说明/caption 文本，故无 caption 可扫。',
      // 记录项（不改语义）：通知扫描面含 notification_push_skipped（未投递）的渲染文本，
      // 这类文案没到用户面，存在被计为泄漏的风险；如实登记，不改成「只看已投递」。
      '记录项：通知扫描面含 notification_push_skipped（未投递）的渲染文本，可能把未到用户面的文案计为泄漏；此处如实登记，不收窄为「只看已投递」。',
    ],
  };
}

export function evaluateObservations(evidence: WriteLoopEvidence): ObservationResult[] {
  const observations: ObservationResult[] = [];

  // ① 完成那条消息是谁的话：唤醒出口（模型）vs 宿主兜底（taskCompletionFallbackText 形状）。
  const wake = evidence.wake;
  const lastPush = [...evidence.pushes].reverse().find((push) => push.source === 'push_text');
  const fallbackMarker = '办好了：';
  const pushedText = lastPush?.text ?? '';
  observations.push({
    id: 'O1',
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

  // ② 冗余过程话术（固定短语表命中记录；不判红）。
  const visibleTexts = [
    ...evidence.turns.map((turn) => turn.reply),
    ...evidence.pushes.map((push) => push.text),
  ].filter((text) => text.trim() !== '');
  const hits = PROCESS_TALK_PHRASES.filter((phrase) => visibleTexts.some((text) => text.includes(phrase)));
  observations.push({
    id: 'O2',
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
      // file_push 是占位（无用户文本），excluded = 不进对话形态面。
      sink.pushes.push({ at: new Date().toISOString(), source: 'file_push', text: `(files:${files.length})`, excluded: true });
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
  // 宿主 sent 记账行 → 推送归属补填（对话形态 ② 的前提；共享补填器，targets = sink.pushes）。
  // 必须声明在 createServer 之前：logger 闭包在装配期就会同步被调用（无 role 主体的
  // principal_role_defaulted 行），const 在 TDZ 里会抛 ReferenceError。
  const attributeDeliveryProvenance = createDeliveryProvenanceAttributor(sink.pushes);
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
    logger: (line) => {
      logs.push(line);
      // 宿主 sent 记账行 → 最近一条未归属文字推送补归属（taskId/factKind；对话形态 ② 的
      // 前提，共享补填器单源——deliverText 先 await sendText 再写 sent 行，此刻 sink 末条
      // 就是这次投递的那条）。
      attributeDeliveryProvenance(line);
    },
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
        atMs: startedMs,
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
    const terminal = new Set(['completed', 'failed', 'refused']);
    const landed = await waitFor(() => {
      if (taskId === undefined) return false;
      for (let index = watcher.snapshots.length - 1; index >= 0; index -= 1) {
        const snapshot = watcher.snapshots[index]!;
        if (snapshot.taskId === taskId) {
          const lastExecutionStatus = snapshot.executions[snapshot.executions.length - 1]?.status;
          if (snapshot.reported || snapshot.cancelled || snapshot.liveness === 'died'
            || (lastExecutionStatus !== undefined && terminal.has(lastExecutionStatus))) return true;
        }
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
  const taskNames: string[] = [];
  for (const id of taskIds) {
    try {
      const record = registry.get(id, scope);
      finalTasks.push({
        taskId: id,
        ...(record.taskNo === undefined ? {} : { taskNo: record.taskNo }),
        liveness: taskLivenessOf(record) ?? null,
        cancelled: record.cancelledAt !== undefined,
        reported: archivedReportOf(record) !== undefined,
        executions: record.executions.map((execution) => ({ operation: execution.operation, status: execution.status })),
      });
      // 业务名（对话形态 ③ 的「任务名」判据用；机械回落已由底账解析）。
      if ((record.name ?? '').trim() !== '') taskNames.push(record.name!.trim());
    } catch {
      finalTasks.push({ taskId: id, liveness: null, cancelled: false, reported: false, executions: [] });
    }
  }
  const primary = finalTasks.find((task) => task.taskId === taskId);
  const finalReported = primary?.reported;
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
      factSequence: taskId === undefined ? [] : watcher.sequenceOf(taskId),
      snapshots: watcher.snapshots,
      ...(finalReported === undefined ? {} : { finalReported }),
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
  log(`[任务底账] 会话内任务数=${evidence.ledger.taskCount} · 状态序列（250ms 轮询观测）=${evidence.ledger.factSequence.join(' → ') || '(未观测到)'}`);
  for (const task of evidence.ledger.finalTasks) {
    log(`  · 任务 ${task.taskId}（#${String(task.taskNo ?? '-')}）终局=${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}`
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
  const observations = evaluateObservations(evidence);
  // 用户可见文本内部词泄漏：机械扫描，命中即本批次失败（不进 judge、不降级为观察）。
  const leak = scanWriteLoopLeaks(evidence, notifications);
  log('\n== 用户可见文本内部词泄漏（通用守卫） ==');
  log(`  命中数=${leak.hitCount}；扫描渠道=${leak.channels.join('、')}`);
  for (const note of leak.notes) log(`  注：${note}`);
  for (const hit of leak.hits) log(`  命中@${hit.where} 「${hit.marker}」：${redact(hit.excerpt)}`);
  emit('real_write_loop_leak', { hitCount: leak.hitCount, hits: leak.hits.map((h) => ({ where: h.where, marker: h.marker })) });
  // 对话形态四条（交接门 2026-11-21）：回合 + 推送 + 归属喂共享断言层，违规即本批次失败
  // （不进判据打分、不降级为观察——与内部词泄漏同一独立守卫位）。
  const shapeViolations: ShapeViolation[] = checkTurnFaceShape(evidence.turns, evidence.pushes, taskNames);
  log('\n== 对话形态（通用守卫，要求 D） ==');
  if (shapeViolations.length === 0) {
    log('  零违规（①每消息≤1回复 ②同事实≤1投递 ③推送自含话题 ④回复不错挂）');
  } else {
    log(redact(formatShapeViolations(shapeViolations, `违规 ${shapeViolations.length} 条`)));
  }
  emit('real_write_loop_shape', {
    violationCount: shapeViolations.length,
    codes: shapeViolations.map((violation) => violation.code),
  });
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
    shape: {
      violationCount: shapeViolations.length,
      violations: shapeViolations,
    },
    leak: {
      hitCount: leak.hitCount,
      hits: leak.hits.map((hit) => ({ where: hit.where, marker: hit.marker, excerpt: redact(hit.excerpt) })),
      channels: leak.channels,
      notes: leak.notes,
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`);
  log(`\n证据已落盘：${path.relative(REPO_ROOT, evidencePath)}（gitignored；不含密钥）`);

  await server.close();
  registry.close();

  const failed = criteria.filter((criterion) => criterion.status === 'fail');
  const leakFailed = leak.hitCount > 0;
  const shapeFailed = shapeViolations.length > 0;
  log(`\n== 写闭环结束：判据 ${criteria.length} 条，pass=${criteria.length - failed.length} fail=${failed.length}；内部词泄漏命中=${leak.hitCount}（${leakFailed ? '机械失败' : '无'}）；对话形态违规=${shapeViolations.length}（${shapeFailed ? '机械失败' : '无'}） ==`);
  if (failed.length > 0) {
    for (const criterion of failed) log(`  FAIL ${criterion.id}：${criterion.detail}`);
  }
  if (leakFailed) {
    log(`  FAIL LEAK_INTERNAL_TERM：用户可见文本命中内部词 ${leak.hitCount} 处（见上面 leak 小节与 evidence.json#leak）。`);
  }
  if (shapeFailed) {
    log(`  FAIL SHAPE_CONVERSATION：对话形态违规 ${shapeViolations.length} 条（见上面「对话形态」小节与 evidence.json#shape）。`);
  }
  if (failed.length > 0 || leakFailed || shapeFailed) process.exitCode = 1;
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
