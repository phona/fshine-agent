/**
 * 真模型写闭环**小场景集**验收（`npm run eval:write-loop-scenarios`）——单条闭环
 * （`scripts/eval/real/write-loop.ts`）的兄弟入口：同一装配面（server 面 + 仓内 dummy
 * 执行层 + env 里的真实模型），把最容易出事的几条路也纳进机械验收。
 *
 * 场景（每个都用真模型走真路径；判据全部机械事实）：
 *   · `stop`        用户说停：交办一件 10 分钟慢活（dummy.longtask）→ 受理后用户说「停」
 *                   → 断言任务真的停了（底账 cancelled）、执行层真被中止（abort 审计 +
 *                   job 文件 cancelled）、停后审计行数冻结（不再被调用）、用户收到
 *                   「一句话（宿主停止事实模板）+ 一个动作（task_cancel 真的发生了）」。
 *   · `failure`     执行层业务失败：让用户在**锁定集合** locked-one 上新增记录
 *                   （执行层确定性拒写 COLLECTION_LOCKED）→ 断言用户收到宿主失败话术
 *                   模板（按底账 code 归类，`failureTextFor` 同源）、没有成功通道原文、
 *                   同对象只被调一次（审计行数 == 1）、没有任何写入落地。
 *   · `idempotency` 同一消息重发（入站幂等）：同 messageId 在办理中并发再发一次 →
 *                   断言不新起工作（任务数 1、prepare 成功 1 次）、第二次拿到宿主
 *                   确定性回执（同一句回放或「上次没办完」如实兜底）、最终只写入一次且读回 4 条。
 *   · `reconfirm`   确认之后又确认一次（旧句柄复用）：走完一次完整写入后，用户再说一次
 *                   「确认」→ 断言没有第二次写入（成功 commit 仍 1、读回仍 4 条、句柄
 *                   未被再次消耗）、没有新任务/没有接续、用户收到一句话、且第三次回合
 *                   之后不出现成功通道原文（不是假成功）。
 *   · `two-objects` 两件事同回合：一次交办含两个对象（两个集合）→ 断言两件事各自提交
 *                   成功恰好一次、各自读回与自己的请求逐条一致（没有串线）、没有非终局
 *                   残留、完成交付出现。
 *
 * 判据纪律（仓规红线）：只用机械事实——执行层审计行（execution layer 自己的
 * audit.jsonl）、底账状态与执行事实、结构化读回、工具调用记录、投递端口收到的原文、
 * 执行层 job 文件。**不判模型措辞质量**；允许的文本判据只有「已知字符串存在性」：
 *   · 宿主话术模板（`failureTextFor` / 通知渲染器取消模板）——确定性文本；
 *   · 宿主/办事通道的**成功通道原文**（`办好了：` / `办完了` / `Confirmed write
 *     applied`）在失败/取消/重复确认场景里的**不出现**——这些字符串只有真成功才会产生，
 *     出现即「假成功」事实；
 *   · 幂等回放与「上次没办完」如实兜底（宿主常量，逐字）。
 * 每条判据都有反向破坏用例（见 write-loop-scenarios.test.ts 的逐条变异）。
 *
 * 退出码（沿用兄弟入口约定）：0 = 全部场景判据全过；1 = 有判据红（含场景中断）；
 * 2 = 前置未过（缺模型配置 / 权限 / 隔离门 / 写前基线不干净）。模型不可用一律如实失败，
 * 不退回脚本模型顶替。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AppConfig, ChannelReply, ChannelRoute, DeliveryReceipt, IncomingChannelMessage, Permission } from '@fshine/contracts';
import { effectiveDeploymentEnv, effectiveRoleOf, loadConfig, permissionsOfRole } from '@fshine/core';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TaskRecord, TaskScope } from '../../../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from '../../../packages/agent/testing/task-facts';
import type { Notification, NotificationSink } from '../../../packages/agent/src/notifications';
import { stripServerPaths } from '../../../packages/agent/src/server-paths';
import { createServer, resolveSingleProfile, type FileDeliveryPort, type Server } from '../../../apps/server/server';
import { failureTextFor } from '../../../apps/server/task-completion-delivery';
import { renderNotification } from '../../../packages/agent/src/notification-render';
import { mainSessionOptions, mainThinkingLevelFrom, resolveExecutionFace } from '../../ask-runtime';
import { materializeEvalConfig } from '../../resolve-config-path';
import { assessEvalIsolation } from '../safety-gate';
import { scanUserVisibleText } from '../shared/internal-terms';
import {
  checkTurnFaceShape,
  createDeliveryProvenanceAttributor,
  formatShapeViolations,
  type ShapeViolation,
} from '../shared/conversation-shape';
import {
  EXPECTED_RECORDS,
  LedgerWatcher,
  USER_TURN_1,
  USER_TURN_2,
  WRITE_COLLECTION,
  WRITE_WINDOW,
  readCollection,
  recordingDriver,
  type CriterionResult,
  type ObservationResult,
  type PushEvidence,
  type QueryReading,
  type ToolCallEvidence,
  type TurnEvidence,
} from './write-loop';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, '.runtime', 'real-write-loop-scenarios');
const PRINCIPAL_ID = 'wecom:fixture-writer';
const FAKE_CHANNEL = 'wecom';

// ---------------------------------------------------------------------------
// 场景常量（业务面：对象/窗口/期望内容；全是执行层世界里的名字）
// ---------------------------------------------------------------------------

export const SCENARIO_IDS = ['stop', 'failure', 'idempotency', 'reconfirm', 'two-objects'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** stop：慢活（业务上的长时导出）与「停」的原话。 */
export const STOP_TURN_1 =
  '帮我导出去年全年的凭证，这是个慢活，要跑一会儿。'
  + '受理了说一声，我等着，之后可能让你停。';
export const STOP_TURN_2 = '停。这件事我不要了，立刻停下。';

/** failure：锁定集合（执行层声明的 locked: true，写路径确定性拒绝）。 */
export const LOCKED_COLLECTION = 'locked-one';
export const LOCKED_WINDOW = 'W1';
export const LOCKED_BASELINE_COUNT = 1; // 夹具 seed：locked-one/W1 已有 1 条 locked-item-1
export const FAILURE_TURN_1 =
  `请帮我在 ${LOCKED_COLLECTION} 集合的 ${LOCKED_WINDOW} 窗口新增 2 条记录：`
  + 'name 分别是 lock-a、lock-b，value 都是 10。';

/** two-objects：两个对象两套期望内容（第二个对象非空：读回按增量 + 尾部逐条核对）。 */
export const TWO_OBJECTS_TURN_1 =
  '请帮我办两件事：'
  + `① 在 ${WRITE_COLLECTION} 集合的 ${WRITE_WINDOW} 窗口新增 2 条记录：name 分别是 pair-a、pair-b，value 都是 7；`
  + '② 在 alpha 集合的 W1 窗口新增 3 条记录：name 分别是 m-1、m-2、m-3，value 都是 9。';
export interface CollectionSpec {
  collection: string;
  window: string;
  expected: ReadonlyArray<{ name: string; value: number }>;
}
export const TWO_OBJECTS_SPECS: readonly CollectionSpec[] = [
  { collection: WRITE_COLLECTION, window: WRITE_WINDOW, expected: [{ name: 'pair-a', value: 7 }, { name: 'pair-b', value: 7 }] },
  { collection: 'alpha', window: 'W1', expected: [{ name: 'm-1', value: 9 }, { name: 'm-2', value: 9 }, { name: 'm-3', value: 9 }] },
];

/**
 * 宿主/办事通道「成功通道」原文（只有真的成功才会产生的字符串；不是模型措辞判断）：
 *   · `办好了：`        —— task-completion-delivery.taskCompletionFallbackText 模板形态；
 *   · `办完了：`        —— notification-render 的 completed 通知模板形态；
 *   · `[任务完成]`     —— task-completion-delivery.taskCompletionFactText 事实句头（宿主喂模型的成功事实）；
 *   · `Confirmed write applied` —— dummy 夹具 commit 成功摘要（执行层自己的成功原文）。
 * 失败/取消/重复确认场景里出现任意一条 = 用户被喂了与事实相反的「成功」。
 */
export const SUCCESS_CHANNEL_MARKERS: readonly string[] = [
  '办好了：',
  '办完了：',
  '[任务完成]',
  'Confirmed write applied',
];

/** 宿主取消事实模板（notification-render cancelled：`已按你说的停了：<name>。`）。 */
export const CANCELLATION_FACT_MARKER = '已按你说的停了：';

/** 宿主「上次没办完」如实兜底（server.ts 的 INBOUND_STILL_PROCESSING_NOTE，逐字同源；
 *  2026-11-21 已撤回旧「还在办，办完会发你」承诺——上一进程已死，那句话永远兑现不了）。 */
export const STILL_PROCESSING_NOTE = '这条消息上次没办完（我这边中途中断过），我不会重复执行它，结果未知——麻烦你重发一次。';


// ---------------------------------------------------------------------------
// 输出（脱敏：绝对路径先替换；密钥永不打印）
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
function emit(event: string, detail: Record<string, unknown>): void {
  console.log(redact(JSON.stringify({ event, ...detail })));
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

// ---------------------------------------------------------------------------
// 证据形状（判据评估在这些形状上做纯函数；测试钉住正反两向）
// ---------------------------------------------------------------------------

/** 执行层审计行（比兄弟入口多留 longTask/operationId/phase/callId——长任务判据要用）。 */
export interface AuditFact {
  mode: string;
  script: string;
  via?: string;
  exitCode?: number;
  refused?: string;
  args?: unknown;
  phase?: string;
  callId?: string;
  longTask?: string;
  operationId?: string;
}

/** 执行层 job 文件事实（长任务：<state-dir>/jobs/<operationId>.json 的投影）。 */
export interface JobFact {
  operationId: string;
  status: string;
  seconds?: number;
  failAfter?: number;
}

/** 底账任务事实（本场景判据用的机械读取：liveness + 逐笔执行行 + 汇报存档 + 一次性时刻）。 */
export interface TaskFact {
  taskId: string;
  taskNo?: number;
  name?: string;
  liveness: string | null;
  /** 用户取消事实（cancelled_at 在场）。 */
  cancelled: boolean;
  /** worker 汇报已存档（resultText ?? replyText 非空）。 */
  reported: boolean;
  reason?: string;
  resultText?: string | null;
  failureReason?: string;
  executions: Array<{ operation: string; status: string; code?: string }>;
}

/** 用户可见面的一条文本（回合回复或主动投递；`at` 为结束时刻，ISO）。 */
export interface VisibleText {
  at: string;
  source: 'turn' | 'push';
  text: string;
  turnIndex?: number;
  /** push 的投递记账归属任务（按 task_result_delivery_sent 补填；判定"迟到投递"要靠它）。 */
  taskId?: string;
  /**
   * 可选的用户可见渠道名：给泄漏扫描的 `where` 用，用来区分同一回合里多次独立回执。
   * 幂等场景的第二次回执（duplicate.secondReply）标 `幂等第二次回执`，确保它和第一次回执
   * 各自作为独立条目进入扫描面——两次文本不同时（sameText=false）也不会漏掉第二次。
   * 不填则沿用既有「回合回复/主动投递#N」标签，判据强度不变。
   */
  channel?: string;
}

export interface BaseEvidence {
  turns: TurnEvidence[];
  pushes: PushEvidence[];
  toolCalls: ToolCallEvidence[];
  audit: AuditFact[];
  jobs: JobFact[];
  tasks: TaskFact[];
  factSequence: string[];
  visible: VisibleText[];
  deliveryEvents: Array<Record<string, unknown>>;
}

export interface StopEvidence extends BaseEvidence {
  /** 终态（cancelled）观测时刻的审计行数。 */
  auditAtCancel: number;
  /** 冻结窗口结束时的审计行数（两值必须相等 = 停后不再调用执行层）。 */
  auditAfterFreeze: number;
  freezeWindowMs: number;
  cancelToolCall?: { ok: boolean; summary: string; args: string };
  /** 受理是否在「停」之前观测到（时序事实，记录用；判据不依赖它）。 */
  acceptedBeforeStop: boolean;
}

export interface FailureEvidence extends BaseEvidence {
  readbackBefore: QueryReading;
  readbackAfter: QueryReading;
  /** 审计里引用目标集合的写调用（prepare/commit）行（保序）。 */
  writeCallsOnTarget: AuditFact[];
  /** 底账失败执行事实里的执行层错误码（取第一条非 completed 的 code）。 */
  failureCode?: string;
  /** 用户可见投递文本（主动推送原文）。 */
  pushTexts: string[];
  /** 失败投递是否走「本回合已交给模型」抑制（relayed_in_turn 事件）。 */
  failureRelayedInTurn: boolean;
  /** 目标对象上 A2b 放行的事实数（执行层显式声明 retryable:true 的重试允许）。 */
  retryAllowed: number;
  /** 目标对象上 A2b 拦截的事实数（确定性失败后再次发起被宿主拦下，未到达执行层）。 */
  retryBlocked: number;
  /** 工具调用里发起过 execute_operation 且引用目标对象的次数（含未到达执行层的被拦尝试）。 */
  attemptsOnTarget: number;
}

export interface IdempotencyEvidence extends BaseEvidence {
  duplicate: {
    firstReply: string;
    secondReply: string;
    firstDurationMs: number;
    secondDurationMs: number;
    sameText: boolean;
    events: string[];
  };
  readbackBefore: QueryReading;
  readbackAfter: QueryReading;
  confirmations: ConfirmationLedgerFacts;
  prepareSuccessCount: number;
  commitSuccessCount: number;
  /** 工具调用里 task_run（委派）次数——重发不得产生第二次委派。 */
  taskRunCalls: number;
}

export interface ReconfirmEvidence extends BaseEvidence {
  /** 场景目标态：第一次写入确实落地（commit completed 事实 ≥ 1 且句柄 usedAt 非空）。 */
  firstWriteLanded: boolean;
  confirmRounds: number;
  commitSuccessCount: number;
  commitCompletedFacts: number;
  readbackAfter: QueryReading;
  confirmations: ConfirmationLedgerFacts;
  /** 第一次写入完成后的句柄快照（第三次之后的 usedAt/usedCount 必须与之相等）。 */
  confirmationsAfterFirstWrite: ConfirmationLedgerFacts;
  taskCountAfterFirstWrite: number;
  taskCountAfterReconfirm: number;
  /** 第一次写入任务的 taskId（机械：含 completed commit 事实的任务；拿不到才空）。 */
  writeTaskId?: string;
  /**
   * 第一次写入的完成投递是否已按该任务记账落定（sent/suppressed 事件、非固定窗口）。
   * 第三次回合的窗口锚点以此为准：晚到的完成推送不再落进"二次确认后"的窗口。
   */
  firstWriteDeliverySettled: boolean;
  thirdTurnStartedAt: string;
  textsAfterThirdTurn: VisibleText[];
  auditCountAfterFirstWrite: number;
  auditCountAfterReconfirm: number;
  taskConfirmStartedCalls: ToolCallEvidence[];
}

export interface TwoObjectsEvidence extends BaseEvidence {
  perCollection: Array<{
    collection: string;
    window: string;
    expected: ReadonlyArray<{ name: string; value: number }>;
    readbackBefore: QueryReading;
    readbackAfter: QueryReading;
    prepareSuccessCount: number;
    commitSuccessCount: number;
  }>;
  /** 底账里 completed 的 dummy.commit 执行事实总数（与审计成功行总数交叉核对）。 */
  commitCompletedFactsTotal: number;
  confirmTurns: number;
  completionDeliverySeen: boolean;
}

// ---------------------------------------------------------------------------
// 机械事实读取（审计行 / job 文件 / 底账投影 / 工具调用）
// ---------------------------------------------------------------------------

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 执行层自己的 audit.jsonl（坏行按 unparsable 记一行，不静默吞）。 */
export function readAuditFacts(stateDir: string): AuditFact[] {
  const file = path.join(stateDir, 'audit.jsonl');
  if (!existsSync(file)) return [];
  const rows: AuditFact[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      rows.push({
        mode: stringOf(parsed['mode']) ?? 'unknown',
        script: stringOf(parsed['script']) ?? 'unknown',
        ...(stringOf(parsed['via']) === undefined ? {} : { via: stringOf(parsed['via'])! }),
        ...(typeof parsed['exitCode'] === 'number' ? { exitCode: parsed['exitCode'] } : {}),
        ...(stringOf(parsed['refused']) === undefined ? {} : { refused: stringOf(parsed['refused'])! }),
        ...(parsed['args'] === undefined ? {} : { args: parsed['args'] }),
        ...(stringOf(parsed['phase']) === undefined ? {} : { phase: stringOf(parsed['phase'])! }),
        ...(stringOf(parsed['callId']) === undefined ? {} : { callId: stringOf(parsed['callId'])! }),
        ...(stringOf(parsed['longTask']) === undefined ? {} : { longTask: stringOf(parsed['longTask'])! }),
        ...(stringOf(parsed['operationId']) === undefined ? {} : { operationId: stringOf(parsed['operationId'])! }),
      });
    } catch {
      rows.push({ mode: 'unparsable', script: 'unknown' });
    }
  }
  return rows;
}

/** 确认句柄账的逐句柄事实（多条句柄绑同一集合时不像兄弟入口那样只取一条）。 */
export interface ConfirmationLedgerFacts {
  /** 绑定目标集合的句柄条数。 */
  handles: number;
  /** 已被 dummy.commit 消耗的句柄条数（写入真正落地的机械事实）。 */
  usedCount: number;
  /** 被消耗句柄的 usedAt（取最早一条；未消耗 = undefined）。 */
  usedAt?: string;
}

/** 读执行层 confirmations.json：按绑定集合逐条判定「是否已被提交消耗」。 */
export function readConfirmationLedger(stateDir: string, collection: string): ConfirmationLedgerFacts {
  const file = path.join(stateDir, 'confirmations.json');
  if (!existsSync(file)) return { handles: 0, usedCount: 0 };
  let store: { confirmations?: Record<string, { usedAt?: string | null; usedBy?: string; collection?: string }> };
  try {
    store = JSON.parse(readFileSync(file, 'utf8')) as typeof store;
  } catch {
    return { handles: 0, usedCount: 0 };
  }
  const entries = Object.values(store.confirmations ?? {});
  const bound = entries.filter((entry) => entry.collection === collection);
  const used = bound
    .filter((entry) => typeof entry.usedAt === 'string' && entry.usedAt !== '' && entry.usedBy === 'dummy.commit')
    .sort((left, right) => (left.usedAt! < right.usedAt! ? -1 : 1));
  return {
    handles: bound.length,
    usedCount: used.length,
    ...(used[0]?.usedAt === undefined ? {} : { usedAt: used[0]!.usedAt! }),
  };
}

/** 长任务 job 文件（<state-dir>/jobs/*.json）逐条投影。 */export function readJobFacts(stateDir: string): JobFact[] {
  const dir = path.join(stateDir, 'jobs');
  if (!existsSync(dir)) return [];
  const jobs: JobFact[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
      const operationId = stringOf(parsed['operationId']);
      const status = stringOf(parsed['status']);
      if (operationId === undefined || status === undefined) continue;
      jobs.push({
        operationId,
        status,
        ...(typeof parsed['seconds'] === 'number' ? { seconds: parsed['seconds'] } : {}),
        ...(typeof parsed['failAfter'] === 'number' ? { failAfter: parsed['failAfter'] } : {}),
      });
    } catch {
      jobs.push({ operationId: name.replace(/\.json$/, ''), status: 'unreadable' });
    }
  }
  return jobs;
}

/** 底账任务投影（全量字段足够判据；executions 带执行层错误码）。 */
export function taskFactsOf(records: readonly TaskRecord[]): TaskFact[] {
  return records.map((record) => ({
    taskId: record.taskId,
    ...(record.taskNo === undefined ? {} : { taskNo: record.taskNo }),
    ...(record.name === undefined ? {} : { name: record.name }),
    liveness: taskLivenessOf(record) ?? null,
    cancelled: record.cancelledAt !== undefined,
    reported: archivedReportOf(record) !== undefined,
    ...(lastFailureOf(record)?.error?.code === undefined ? {} : { reason: lastFailureOf(record)?.error?.code! }),
    resultText: record.resultText ?? null,
    ...(lastFailureOf(record)?.error?.message === undefined ? {} : { failureReason: lastFailureOf(record)?.error?.message! }),
    executions: record.executions.map((execution) => ({
      operation: execution.operation,
      status: execution.status,
      ...(execution.error?.code === undefined ? {} : { code: execution.error.code }),
    })),
  }));
}

/** args（结构化对象或 argv 数组）里是否出现某个字符串（深扫；对象键与值都扫）。 */
export function argsMention(args: unknown, needle: string): boolean {
  if (typeof args === 'string') return args.includes(needle);
  if (Array.isArray(args)) return args.some((entry) => argsMention(entry, needle));
  if (args !== null && typeof args === 'object') {
    return Object.entries(args as Record<string, unknown>)
      .some(([key, value]) => key.includes(needle) || argsMention(value, needle));
  }
  return false;
}

const WRITE_SCRIPTS = new Set(['dummy.prepare', 'dummy.commit']);
function isStructuredSuccess(row: AuditFact): boolean {
  return row.via === 'structured' && row.refused === undefined && row.exitCode === 0;
}
/** 审计里引用目标集合的写调用（prepare/commit；读调用不算「撞执行层」）。 */
export function writeCallsOn(audit: readonly AuditFact[], collection: string): AuditFact[] {
  return audit.filter((row) => WRITE_SCRIPTS.has(row.script) && argsMention(row.args, collection));
}
export function commitSuccessRows(audit: readonly AuditFact[], collection?: string): AuditFact[] {
  return audit.filter((row) =>
    row.script === 'dummy.commit' && isStructuredSuccess(row)
    && (collection === undefined || argsMention(row.args, collection)));
}
export function prepareSuccessRows(audit: readonly AuditFact[], collection?: string): AuditFact[] {
  return audit.filter((row) =>
    row.script === 'dummy.prepare' && isStructuredSuccess(row)
    && (collection === undefined || argsMention(row.args, collection)));
}

/** 用户可见文本里命中的成功通道原文（空 = 没有假成功形态）。 */
export function successMarkersIn(texts: readonly string[]): string[] {
  return SUCCESS_CHANNEL_MARKERS.filter((marker) => texts.some((text) => text.includes(marker)));
}

/** 用户可见文本里是否出现至少一条（非空）文本。 */
function hasNonEmptyText(texts: readonly string[]): boolean {
  return texts.some((text) => text.trim() !== '');
}

// ---------------------------------------------------------------------------
// 判据评估（纯函数；逐条可反向破坏）
// ---------------------------------------------------------------------------

/** 收集器（判据按场景顺序追加；`results` 挂在函数上，便于调用处取回）。 */
export interface CriteriaBuilder {
  (id: string, title: string, kind: CriterionResult['kind'], pass: boolean, detail: string): void;
  results: CriterionResult[];
}

export function createCriteriaBuilder(): CriteriaBuilder {
  const results: CriterionResult[] = [];
  const add = (id: string, title: string, kind: CriterionResult['kind'], pass: boolean, detail: string): void => {
    results.push({ id, title, kind, status: pass ? 'pass' : 'fail', detail });
  };
  return Object.assign(add, { results });
}

// ---- stop ----

export function evaluateStopCriteria(evidence: StopEvidence): CriterionResult[] {
  const add = createCriteriaBuilder();

  // S1-C1 执行层确实受理了长任务（它自己的审计行 + job 文件）。
  const acceptedRows = evidence.audit.filter((row) => row.script === 'dummy.longtask' && row.longTask === 'accepted');
  add(
    'S1-C1', '执行层受理长任务（审计 accepted 行 + job 文件存在）', 'mechanical',
    acceptedRows.length >= 1 && evidence.jobs.length >= 1,
    `accepted 审计行 ${acceptedRows.length} 条；job 文件 ${evidence.jobs.length} 个`
      + `（${evidence.jobs.map((job) => `${job.operationId}:${job.status}`).join('；') || '-'}）`,
  );

  // S1-C2 「停」是一次实际动作，且任务真的停了：task_cancel 调用 + 底账终态 cancelled + 无残留非终局任务。
  const cancelledTasks = evidence.tasks.filter((task) => task.cancelled);
  const leftover = evidence.tasks.filter((task) => !(task.cancelled || task.reported || task.liveness === 'died'));
  const cancelCall = evidence.cancelToolCall;
  add(
    'S1-C2', '「停」是实际动作：task_cancel 调用 + 底账终态 cancelled + 无非终局残留', 'structured',
    cancelCall !== undefined && cancelCall.ok && cancelledTasks.length >= 1 && leftover.length === 0,
    `task_cancel=${cancelCall === undefined ? '未调用' : `${cancelCall.ok ? 'ok' : '抛错'}(${cancelCall.summary})`}`
      + `；任务终局=${evidence.tasks.map((task) => `#${String(task.taskNo ?? '-')}:${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}`).join(',') || '(无)'}`
      + `；非终局残留=${leftover.length} 条`,
  );

  // S1-C3 执行层确认中止（不是嘴上停）：abort 审计行 + job 文件 cancelled。
  const abortRows = evidence.audit.filter((row) => row.script === 'dummy.longtask' && row.mode === 'abort' && row.exitCode === 0);
  const cancelledJobs = evidence.jobs.filter((job) => job.status === 'cancelled');
  add(
    'S1-C3', '执行层真的被中止（abort 审计行 + job 文件 status=cancelled）', 'mechanical',
    abortRows.length >= 1 && cancelledJobs.length >= 1,
    `abort 成功审计行 ${abortRows.length} 条；job 文件 cancelled ${cancelledJobs.length} 个`
      + `（${evidence.jobs.map((job) => `${job.operationId}:${job.status}`).join('；') || '-'}）`,
  );

  // S1-C4 停后执行层不再被调用：终态前的行数与冻结窗口后的行数相等。
  add(
    'S1-C4', `停后执行层调用次数冻结（${evidence.freezeWindowMs}ms 窗口内审计行数不变）`, 'mechanical',
    evidence.auditAfterFreeze === evidence.auditAtCancel,
    `终态观测时审计行=${evidence.auditAtCancel}；${evidence.freezeWindowMs}ms 后=${evidence.auditAfterFreeze}`
      + `（${evidence.auditAfterFreeze === evidence.auditAtCancel ? '冻结' : `仍在增加：+${evidence.auditAfterFreeze - evidence.auditAtCancel}`}）`,
  );

  // S1-C5 用户收到一句话，且不是假完成。
  const texts = evidence.visible.map((entry) => entry.text);
  const markers = successMarkersIn(texts);
  add(
    'S1-C5', '用户收到非空的一句话，且用户可见面没有成功通道原文（不是假完成）', 'mechanical',
    hasNonEmptyText(texts) && markers.length === 0,
    `非空文本 ${texts.filter((text) => text.trim() !== '').length} 条；成功通道原文命中=[${markers.join('、')}]`,
  );

  // S1-C6 用户可见面出现**非空的停止告知**：唤醒设计下模型说话为主（停止回合的回复 /
  // 唤醒投递），宿主停止模板「已按你说的停了：」只在「唤醒说不出话」的降级路径出现——
  // 来源不限，模型的话与降级模板都算。本条把「用户看到了非空告知」与底账终局 cancelled、
  // 停后审计冻结一起断言（这些机械事实另由 S1-C2/C3/C4 独立钉住，此处重复是为了净更严）；
  // 不再要求宿主模板必现（否则只有系统退化时才可能绿——旧判据的假红根因）。
  const stopNotice = texts.find((text) => text.trim() !== '');
  const cancelledLedger = evidence.tasks.some((task) => task.cancelled);
  const frozenAfterStop = evidence.auditAfterFreeze === evidence.auditAtCancel;
  add(
    'S1-C6', '非空停止告知（来源不限）+ 底账终局 cancelled + 停后审计冻结', 'mechanical',
    stopNotice !== undefined && cancelledLedger && frozenAfterStop,
    `停止告知=${stopNotice === undefined ? '(无非空文本)' : digestValue(stopNotice, 200)}`
      + `；非空用户可见文本 ${texts.filter((text) => text.trim() !== '').length} 条`
      + `；底账 cancelled=${cancelledLedger}；停后审计冻结=${frozenAfterStop}`
      + `（终态=${evidence.auditAtCancel}、冻结后=${evidence.auditAfterFreeze}）`,
  );

  return add.results;
}

export function evaluateStopObservations(evidence: StopEvidence): ObservationResult[] {
  const acceptedBeforeStop = evidence.acceptedBeforeStop;
  const acceptToStop = evidence.audit.findIndex((row) => row.script === 'dummy.longtask' && row.longTask === 'accepted');
  return [
    {
      id: 'O1',
      title: '受理与「停」的时序',
      detail: `受理在「停」之前观测到=${acceptedBeforeStop}；accepted 审计行序号=${acceptToStop}`,
    },
    {
      id: 'O2',
      title: '长任务 duration（seconds 参数）',
      detail: evidence.jobs.map((job) => `${job.operationId}: seconds=${String(job.seconds ?? '?')} status=${job.status}`).join('；') || '无 job 文件',
    },
    {
      id: 'O3',
      title: '用户可见面原文（复核用；不作质量判据）',
      detail: evidence.visible.map((entry) => `[${entry.source}] ${digestValue(entry.text, 300)}`).join('\n        ') || '(空)',
    },
  ];
}

// ---- failure ----

export function evaluateFailureCriteria(evidence: FailureEvidence): CriterionResult[] {
  const add = createCriteriaBuilder();

  // S2-C1 确定性业务失败确实发生：目标对象的写调用失败（执行层审计）+ 底账有失败执行事实。
  const failedWrite = evidence.writeCallsOnTarget.find((row) => row.refused !== undefined || row.exitCode !== 0);
  const failedFacts = evidence.tasks.flatMap((task) => task.executions.filter((execution) => execution.status !== 'completed'));
  add(
    'S2-C1', '执行层对目标对象确定性拒写（审计失败行 + 底账失败执行事实）', 'mechanical',
    failedWrite !== undefined && failedFacts.length >= 1,
    `失败写调用=${failedWrite === undefined ? '无' : `${failedWrite.script}(exit=${String(failedWrite.exitCode ?? '-')}${failedWrite.refused === undefined ? '' : `,refused=${failedWrite.refused}`})`}`
      + `；底账失败执行=${failedFacts.map((fact) => `${fact.operation}:${fact.status}${fact.code === undefined ? '' : `(${fact.code})`}`).join(',') || '无'}`,
  );

  // S2-C2 同对象不反复撞执行层（A2b 语义的机械读数）：
  //   · 到达执行层的失败行数 ≤ 1（确定性业务失败）+ 执行层显式声明可重试的放行次数
  //     （`execution_retry_allowed`；夹具对参数形状错误 INVALID_RECORDS 声明 retryable:true，
  //     修正写法重试是设计允许的路径，但不能超预算）；
  //   · 最后一次到达执行层的写调用必须是失败（确定性业务失败之后不得再撞出成功/新调用）；
  //   · 拦截事实（`execution_retry_blocked`）如实进 detail：被本地拦下的重复发起根本不
  //     到达执行层，不进失败行预算。
  const failureRows = evidence.writeCallsOnTarget.filter((row) =>
    row.refused !== undefined || (row.exitCode !== undefined && row.exitCode !== 0));
  const lastRow = evidence.writeCallsOnTarget[evidence.writeCallsOnTarget.length - 1];
  const lastRowFailed = lastRow !== undefined && (lastRow.refused !== undefined || (lastRow.exitCode ?? 0) !== 0);
  const retryBudgetOk = failureRows.length <= 1 + evidence.retryAllowed;
  add(
    'S2-C2', '同对象不反复撞执行层：失败行 ≤ 业务失败 1 次 + 显式可重试放行，且最后一次到达必为失败', 'mechanical',
    evidence.writeCallsOnTarget.length >= 1 && lastRowFailed && retryBudgetOk,
    `到达执行层的写调用 ${evidence.writeCallsOnTarget.length} 条（失败 ${failureRows.length} 条：`
      + evidence.writeCallsOnTarget.map((row) => `${row.script}(exit=${String(row.exitCode ?? '-')}${row.refused === undefined ? '' : `,refused=${row.refused}`})`).join('；')
      + `）；A2b 放行（显式可重试）=${evidence.retryAllowed} 次、拦截=${evidence.retryBlocked} 次；`
      + `工具面发起写调用（含被本地拦下的）=${evidence.attemptsOnTarget} 次`,
  );

  // S2-C3 用户收到如实的失败告知：唤醒设计下模型说话为主（失败回合回复 / 唤醒投递），
  // 宿主失败话术模板只在「唤醒说不出话」的降级路径出现——来源不限，模型的话与降级模板
  // 都算，统一在用户可见面（回合回复 + 主动投递）上判定非空文本。同时把零写入与无成功
  // 通道原文两条机械事实并入本条，使判据比旧版更严（旧版只钉模板 / relayed_in_turn）。
  // 具体失败业务事实（执行层拒写、读回零落地、无假成功）另由 S2-C1/C4/C5 机械钉住。
  const visibleTexts = evidence.visible.map((entry) => entry.text);
  const failureNotice = visibleTexts.find((text) => text.trim() !== '');
  const expectedFailureText = failureTextFor('failed');
  const deliveredTemplate = evidence.pushTexts.some((text) => text.includes(expectedFailureText));
  const zeroWrites = evidence.readbackAfter.status === 'completed'
    && evidence.readbackAfter.count === evidence.readbackBefore.count
    && digestValue(evidence.readbackAfter.items, 300) === digestValue(evidence.readbackBefore.items, 300);
  const noSuccessChannel = successMarkersIn(visibleTexts).length === 0;
  add(
    'S2-C3', '用户可见面非空失败告知（来源不限）+ 零写入 + 无成功通道原文', 'mechanical',
    failureNotice !== undefined && zeroWrites && noSuccessChannel,
    `失败告知=${failureNotice === undefined ? '(无非空文本)' : digestValue(failureNotice, 200)}`
      + `（非空用户可见文本 ${visibleTexts.filter((text) => text.trim() !== '').length} 条）`
      + `；期望模板=${digestValue(expectedFailureText, 120)}、模板命中=${deliveredTemplate}、relayed_in_turn=${evidence.failureRelayedInTurn}`
      + `；零写入=${zeroWrites}；无成功通道原文=${noSuccessChannel}`,
  );

  // S2-C4 不是假成功：用户可见面没有成功通道原文（一次成功写都没有，出现即假）。
  const markers = successMarkersIn(evidence.visible.map((entry) => entry.text));
  add(
    'S2-C4', '用户可见面没有成功通道原文（不得出现「办好了」这类假成功）', 'mechanical',
    markers.length === 0,
    markers.length === 0 ? '未命中成功通道原文' : `命中：${markers.join('、')}`,
  );

  // S2-C5 没有任何写入落地：锁定集合读回与写前逐条一致。
  const before = evidence.readbackBefore;
  const after = evidence.readbackAfter;
  const beforeItems = digestValue(before.items, 300);
  const afterItems = digestValue(after.items, 300);
  add(
    'S2-C5', '锁定集合读回与写前一致（零写入落地）', 'mechanical',
    after.status === 'completed' && after.count === before.count && beforeItems === afterItems,
    `写前 count=${String(before.count)} items=${digestValue(before.items, 200)}；`
      + `写后 count=${String(after.count)} items=${digestValue(after.items, 200)}`,
  );

  return add.results;
}

export function evaluateFailureObservations(evidence: FailureEvidence): ObservationResult[] {
  return [
    {
      id: 'O1',
      title: '失败投递通道',
      detail: `主动投递文本=${evidence.pushTexts.map((text) => digestValue(text, 200)).join(' | ') || '(无)'}；`
        + `relayed_in_turn=${evidence.failureRelayedInTurn}`,
    },
    {
      id: 'O2',
      title: '失败话术归类（底账 code → 宿主模板）',
      detail: `code=${evidence.failureCode ?? '(无)'} → ${digestValue(failureTextFor('failed'), 200)}`,
    },
    {
      id: 'O3',
      title: '重撞读数（工具面发起 vs 到达执行层 vs A2b 放行/拦截）',
      detail: `工具面发起 ${evidence.attemptsOnTarget} 次；到达执行层 ${evidence.writeCallsOnTarget.length} 次；`
        + `A2b 放行 ${evidence.retryAllowed} 次、拦截 ${evidence.retryBlocked} 次；`
        + evidence.toolCalls.map((call) => `#${call.seq} [${call.agent}] ${call.tool}(${digestValue(call.args, 120)}) → ${call.summary}`).join('；'),
    },
  ];
}

// ---- idempotency ----

export function evaluateIdempotencyCriteria(evidence: IdempotencyEvidence): CriterionResult[] {
  const add = createCriteriaBuilder();
  const tasks = evidence.tasks;

  // S3-C1 重发不新起一份工作：任务数 1 + 只委派过一次（task_run 1 次）+ 确有 prepare 到达执行层。
  add(
    'S3-C1', '同 messageId 重发不新起工作（任务数 1、task_run 委派 1 次）', 'mechanical',
    tasks.length === 1 && evidence.taskRunCalls === 1 && evidence.prepareSuccessCount >= 1,
    `会话任务数=${tasks.length}（${tasks.map((task) => `#${String(task.taskNo ?? '-')}:${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}`).join(',')}）；`
      + `task_run 委派=${evidence.taskRunCalls} 次；成功 prepare 审计行=${evidence.prepareSuccessCount}`,
  );

  // S3-C2 第二次拿到宿主确定性回执：同一句回放或「上次没办完」如实兜底；且落了幂等事件。
  const replaySame = evidence.duplicate.sameText;
  const stillProcessing = evidence.duplicate.secondReply === STILL_PROCESSING_NOTE;
  const duplicateEventSeen = evidence.duplicate.events.some((event) =>
    event === 'message_duplicate_replayed' || event === 'message_still_processing');
  add(
    'S3-C2', '第二次收到宿主确定性回执（同一句回放或「上次没办完」兜底）且落了幂等事件', 'mechanical',
    (replaySame || stillProcessing) && duplicateEventSeen,
    `同一句回放=${replaySame}；中断兜底话术=${stillProcessing}；幂等事件=[${evidence.duplicate.events.join('、')}]`
      + `；第二次回执=${digestValue(evidence.duplicate.secondReply, 200)}`,
  );

  // S3-C3 最终只写入一次（成功 commit 1 次 + 句柄消耗 + 读回 4 条且内容一致）。
  const items = evidence.readbackAfter.items ?? [];
  const contentMatches = items.length === EXPECTED_RECORDS.length
    && EXPECTED_RECORDS.every((expected, index) =>
      items[index]?.name === expected.name && items[index]?.value === expected.value);
  add(
    'S3-C3', `最终只写入一次且读回 ${WRITE_COLLECTION}/${WRITE_WINDOW} = 4 条内容一致`, 'mechanical',
    evidence.commitSuccessCount === 1
      && evidence.confirmations.usedCount === 1
      && evidence.readbackAfter.status === 'completed'
      && evidence.readbackAfter.count === EXPECTED_RECORDS.length
      && contentMatches,
    `成功 commit 审计行=${evidence.commitSuccessCount}；消耗句柄=${evidence.confirmations.usedCount}/${evidence.confirmations.handles}`
      + `（usedAt=${evidence.confirmations.usedAt ?? '(未消耗)'}）；`
      + `读回 status=${evidence.readbackAfter.status} count=${String(evidence.readbackAfter.count)} items=${digestValue(items, 300)}`,
  );

  // S3-C4 用户可见回执非空（两次都有）。
  add(
    'S3-C4', '两次入站都拿到非空回执', 'mechanical',
    evidence.duplicate.firstReply.trim() !== '' && evidence.duplicate.secondReply.trim() !== '',
    `第一次=${digestValue(evidence.duplicate.firstReply, 200)}；第二次=${digestValue(evidence.duplicate.secondReply, 200)}`,
  );

  return add.results;
}

export function evaluateIdempotencyObservations(evidence: IdempotencyEvidence): ObservationResult[] {
  return [
    {
      id: 'O1',
      title: '第二次回执的通道与耗时（in_flight 等待 vs 底账回放 vs 中断兜底）',
      detail: `第二次耗时=${evidence.duplicate.secondDurationMs}ms（第一次=${evidence.duplicate.firstDurationMs}ms）；`
        + `事件=[${evidence.duplicate.events.join('、')}]`,
    },
    {
      id: 'O2',
      title: '工具调用记录（是否只委派了一次）',
      detail: evidence.toolCalls.map((call) => `#${call.seq} [${call.agent}·回合${call.turn}] ${call.tool} → ${call.summary}`).join('；') || '(无)',
    },
  ];
}

// ---- reconfirm ----

export function evaluateReconfirmCriteria(evidence: ReconfirmEvidence): CriterionResult[] {
  const add = createCriteriaBuilder();

  // S4-P0 场景目标态：第一次写入已落地（旧句柄已被消费）——不达态则本场景的复用断言无从谈起。
  add(
    'S4-P0', '场景目标态：第一次写入已落地（commit completed ≥ 1 且句柄 usedAt 非空）', 'mechanical',
    evidence.firstWriteLanded,
    `firstWriteLanded=${evidence.firstWriteLanded}；确认回合数=${evidence.confirmRounds}；`
      + `消耗句柄=${evidence.confirmationsAfterFirstWrite.usedCount}/${evidence.confirmationsAfterFirstWrite.handles}`
      + `（usedAt=${evidence.confirmationsAfterFirstWrite.usedAt ?? '(未消耗)'}）`,
  );

  // S4-C1 没有第二次写入：成功 commit 仍 1、读回仍 4 条内容一致、句柄 usedAt 未被再次消耗。
  const items = evidence.readbackAfter.items ?? [];
  const contentMatches = items.length === EXPECTED_RECORDS.length
    && EXPECTED_RECORDS.every((expected, index) =>
      items[index]?.name === expected.name && items[index]?.value === expected.value);
  const usedAtUnchanged = evidence.confirmationsAfterFirstWrite.usedAt !== undefined
    && evidence.confirmations.usedCount === evidence.confirmationsAfterFirstWrite.usedCount
    && evidence.confirmations.usedAt === evidence.confirmationsAfterFirstWrite.usedAt;
  add(
    'S4-C1', '第二次「确认」之后没有第二次写入（成功 commit 1 次、读回 4 条、句柄 usedAt 未变）', 'mechanical',
    evidence.commitSuccessCount === 1
      && evidence.commitCompletedFacts === 1
      && evidence.readbackAfter.status === 'completed'
      && evidence.readbackAfter.count === EXPECTED_RECORDS.length
      && contentMatches
      && usedAtUnchanged,
    `成功 commit 审计行=${evidence.commitSuccessCount}；底账 completed commit 事实=${evidence.commitCompletedFacts}；`
      + `读回 count=${String(evidence.readbackAfter.count)} items=${digestValue(items, 300)}；`
      + `消耗句柄 第一次后=${evidence.confirmationsAfterFirstWrite.usedCount}/${evidence.confirmationsAfterFirstWrite.handles}`
      + ` 第三次后=${evidence.confirmations.usedCount}/${evidence.confirmations.handles}`
      + `（usedAt ${evidence.confirmationsAfterFirstWrite.usedAt ?? '(未消耗)'} → ${evidence.confirmations.usedAt ?? '(未消耗)'}）`,
  );

  // S4-C2 没有新任务 / 没有接续：任务数不变、没有非终局残留、第三次回合没有 started 的 task_confirm。
  const leftover = evidence.tasks.filter((task) => !(task.cancelled || task.reported || task.liveness === 'died'));
  add(
    'S4-C2', '第二次「确认」没有新起任务、没有接续（任务数不变、无非终局残留、无 started 确认）', 'structured',
    evidence.taskCountAfterReconfirm === evidence.taskCountAfterFirstWrite
      && leftover.length === 0
      && evidence.taskConfirmStartedCalls.length === 0,
    `任务数 第一次后=${evidence.taskCountAfterFirstWrite} 第三次后=${evidence.taskCountAfterReconfirm}；`
      + `任务终局=${evidence.tasks.map((task) => `#${String(task.taskNo ?? '-')}:${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}`).join(',')}；`
      + `非终局残留=${leftover.length} 条；started 的 task_confirm=${evidence.taskConfirmStartedCalls.length} 次`,
  );

  // S4-C3 用户收到一句话（第三次回合回复非空或该回合之后有主动投递）。
  const textsAfter = evidence.textsAfterThirdTurn.map((entry) => entry.text);
  add(
    'S4-C3', '第二次「确认」后用户收到非空的一句话（回合回复或主动投递）', 'mechanical',
    hasNonEmptyText(textsAfter),
    `第三次回合之后文本 ${textsAfter.length} 条：${textsAfter.map((text) => digestValue(text, 200)).join(' | ') || '(空)'}`,
  );

  // S4-C4 不是假成功：第二次「确认」之后**新到达**的成功通道原文为零，且执行层没有新调用
  // （审计行数不变）。窗口锚在 thirdTurnStartedAt 之后（textsAfterThirdTurn），并排除第一次
  // 写入自己的完成投递（2026-11-20 假红修复：第一次合法写入的成功推送晚到，曾落进"二次确认后"
  // 的窗口被当成假成功；当时审计 14→14、句柄未消费，实际零新执行）：
  //   · 按投递归属排除：push.taskId == 含 completed commit 事实的任务（task_result_delivery_sent
  //     记账时采集端补填）——迟到的第一次完成推送不是第二次确认产生的假成功；
  //   · 按内容比对排除：push 原文与已归属的第一次完成投递逐字相同（同内容复述）同样不算；
  //   · 比对用归属/送达原文，不用固定时间窗（窗口开启前的等待由 waitForTaskDeliverySettle 按
  //     该任务自己的投递记账落定）。
  // 第二次确认真生产生假成功（第三次回合回复或新投递里出现成功话术）仍全部落网（负例绊线）。
  const writeTaskIds = evidence.tasks
    .filter((task) => task.executions.some((execution) =>
      execution.operation === 'dummy.commit' && execution.status === 'completed'))
    .map((task) => task.taskId);
  const firstWriteDeliveryTexts = new Set(
    evidence.pushes
      .filter((push) => push.taskId !== undefined && writeTaskIds.includes(push.taskId))
      .map((push) => push.text),
  );
  const isFirstWriteDelivery = (entry: VisibleText): boolean =>
    entry.source === 'push'
    && ((entry.taskId !== undefined && writeTaskIds.includes(entry.taskId))
      || firstWriteDeliveryTexts.has(entry.text));
  const excludedDeliveries = evidence.textsAfterThirdTurn.filter((entry) => isFirstWriteDelivery(entry));
  const markers = successMarkersIn(
    evidence.textsAfterThirdTurn.filter((entry) => !isFirstWriteDelivery(entry)).map((entry) => entry.text),
  );
  add(
    'S4-C4', '第二次「确认」不产生假成功（无新成功通道原文、执行层零新调用）', 'mechanical',
    markers.length === 0 && evidence.auditCountAfterReconfirm === evidence.auditCountAfterFirstWrite,
    `成功通道原文=[${markers.join('、')}]；已排除第一次写入完成投递 ${excludedDeliveries.length} 条；`
      + `审计行数 第一次后=${evidence.auditCountAfterFirstWrite} 第三次后=${evidence.auditCountAfterReconfirm}`,
  );

  return add.results;
}

export function evaluateReconfirmObservations(evidence: ReconfirmEvidence): ObservationResult[] {
  const thirdTurnIndex = 2 + evidence.confirmRounds;
  return [
    {
      id: 'O0',
      title: '第一次写入达态用了几个确认回合',
      detail: `firstWriteLanded=${evidence.firstWriteLanded}；确认回合数=${evidence.confirmRounds}`
        + `；第一次完成投递落定=${evidence.firstWriteDeliverySettled}（taskId=${evidence.writeTaskId ?? '(未知)'}）`,
    },
    {
      id: 'O1',
      title: '最后一次「确认」回合的工具调用（模型如何处置旧「确认」）',
      detail: evidence.toolCalls.filter((call) => call.turn >= thirdTurnIndex)
        .map((call) => `#${call.seq} ${call.tool}(${digestValue(call.args, 160)}) → ${call.summary}`).join('；') || '(无)',
    },
    {
      id: 'O2',
      title: '第三次回合的用户可见原文（复核用）',
      detail: evidence.textsAfterThirdTurn.map((entry) => `[${entry.source}] ${digestValue(entry.text, 300)}`).join('\n        ') || '(空)',
    },
  ];
}

// ---- two-objects ----

export function evaluateTwoObjectsCriteria(evidence: TwoObjectsEvidence): CriterionResult[] {
  const add = createCriteriaBuilder();
  const specs = evidence.perCollection;

  // S5-C1 每个对象各自成功提交恰好一次（审计逐对象 + 审计/底账总数交叉核对）。
  const perObject = specs.map((spec) =>
    `${spec.collection}: prepare成功=${spec.prepareSuccessCount} commit成功=${spec.commitSuccessCount}`);
  const commitSuccessTotal = specs.reduce((sum, spec) => sum + spec.commitSuccessCount, 0);
  add(
    'S5-C1', '两个对象各自提交成功恰好一次（审计逐对象 + 总数与底账交叉核对）', 'mechanical',
    specs.length === 2
      && specs.every((spec) => spec.prepareSuccessCount >= 1 && spec.commitSuccessCount === 1)
      && commitSuccessTotal === 2
      && evidence.commitCompletedFactsTotal === 2,
    `${perObject.join('；')}；审计成功 commit 总数=${commitSuccessTotal}；底账 completed commit 事实=${evidence.commitCompletedFactsTotal}`,
  );

  // S5-C2 各自读回与自己的请求一致（增量 + 尾部逐条；没有串线）。
  const mismatches: string[] = [];
  for (const spec of specs) {
    const items = spec.readbackAfter.items ?? [];
    const beforeCount = spec.readbackBefore.count;
    const expectedCount = beforeCount === undefined ? undefined : beforeCount + spec.expected.length;
    const tail = items.slice(items.length - spec.expected.length);
    const tailMatches = spec.expected.every((expected, index) =>
      tail[index]?.name === expected.name && tail[index]?.value === expected.value);
    const ok = spec.readbackBefore.status === 'completed'
      && spec.readbackAfter.status === 'completed'
      && spec.readbackAfter.count === expectedCount
      && tailMatches;
    if (!ok) {
      mismatches.push(`${spec.collection}: 期望增量 ${spec.expected.length}（前 ${String(beforeCount)} → 后 ${String(expectedCount)}）与尾部 ${LIKE(spec.expected)}；`
        + `实得 count=${String(spec.readbackAfter.count)} items=${digestValue(items, 240)}`);
    }
  }
  add(
    'S5-C2', '每个对象读回与自己的请求逐条一致（增量 + 尾部逐条；没有串线）', 'mechanical',
    mismatches.length === 0,
    mismatches.length === 0
      ? specs.map((spec) => `${spec.collection}/${spec.window} 前 ${String(spec.readbackBefore.count)} → 后 ${String(spec.readbackAfter.count)} items=${digestValue(spec.readbackAfter.items, 200)}`).join('；')
      : mismatches.join('；'),
  );

  // S5-C3 两件事都落终局，没有失败/超时/未知，也没有非终局残留。
  const bad = evidence.tasks.filter((task) => !task.reported);
  add(
    'S5-C3', '两件事都落终局 completed（没有失败/超时/未知/残留）', 'mechanical',
    evidence.tasks.length >= 1 && bad.length === 0,
    `任务终局=${evidence.tasks.map((task) => `#${String(task.taskNo ?? '-')}:${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}`).join(',') || '(无)'}`
      + `；非 completed=${bad.length} 条`,
  );

  // S5-C4 完成交付出现（完成唤醒/主动投递/本回合转述至少一条路径落事件）。
  add(
    'S5-C4', '完成交付路径确实发生（唤醒/主动投递/本回合转述至少一条）', 'structured',
    evidence.completionDeliverySeen,
    `完成交付事件=${evidence.deliveryEvents.filter((event) =>
      ['task_result_delivery_sent', 'task_completion_wake', 'task_result_delivery_suppressed'].includes(String(event['event']))).length} 条`
      + `（明细见事件列表）`,
  );

  return add.results;
}

function LIKE(expected: ReadonlyArray<{ name: string; value: number }>): string {
  return expected.map((entry) => `${entry.name}=${entry.value}`).join('/');
}

export function evaluateTwoObjectsObservations(evidence: TwoObjectsEvidence): ObservationResult[] {
  return [
    {
      id: 'O1',
      title: '确认回合数',
      detail: `共发「确认」${evidence.confirmTurns} 次（每个提案一次是期望上限；多出来的是重复确认或追问）`,
    },
    {
      id: 'O2',
      title: '工具调用记录',
      detail: evidence.toolCalls.map((call) => `#${call.seq} [${call.agent}·回合${call.turn}] ${call.tool}(${digestValue(call.args, 160)}) → ${call.summary}`).join('；') || '(无)',
    },
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ScenarioRunOptions {
  scenarioIds: ScenarioId[];
  outDir?: string;
  turnTimeoutMs: number;
  settleTimeoutMs: number;
}

const USAGE = [
  '用法：node --env-file-if-exists=.env --import tsx scripts/eval/real/write-loop-scenarios.ts [--scenario <id>]... [--out-dir <dir>] [--turn-timeout-ms N] [--settle-timeout-ms N]',
  `  场景：${SCENARIO_IDS.join(' / ')}（缺省全跑）。每个场景都对着仓内 dummy 执行层用真实模型（env LLM_*）真跑。`,
  '  --scenario <id>        只跑一个场景（可重复；逗号分隔亦可）',
  '  --out-dir <dir>        证据落点（缺省 .runtime/real-write-loop-scenarios/<时间戳>/）',
  '  --turn-timeout-ms N    单个用户回合/等待步的上限（缺省 240000）',
  '  --settle-timeout-ms N  等待后台落定的上限（缺省 240000）',
  '  --help                 打印本用法。',
  '退出码：0 = 全过；1 = 有判据红；2 = 前置未过（缺模型配置/权限/隔离门/基线不干净）。',
].join('\n');

export function parseScenarioArgs(argv: readonly string[]): ScenarioRunOptions | { usageError: string } | { help: true } {
  const options: ScenarioRunOptions = { scenarioIds: [], turnTimeoutMs: 240_000, settleTimeoutMs: 240_000 };
  const parseScenarioList = (raw: string): ScenarioId[] | { error: string } => {
    const parts = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
    const ids: ScenarioId[] = [];
    for (const part of parts) {
      if (!(SCENARIO_IDS as readonly string[]).includes(part)) {
        return { error: `未知场景「${part}」（可用：${SCENARIO_IDS.join(' / ')}）。` };
      }
      ids.push(part as ScenarioId);
    }
    return ids;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { help: true };
    const takeValue = (flag: string): string | undefined => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      index += 1;
      return value;
    };
    if (arg === '--scenario' || arg.startsWith('--scenario=')) {
      const raw = arg.startsWith('--scenario=') ? arg.slice('--scenario='.length) : takeValue('--scenario');
      if (raw === undefined || raw.trim() === '') return { usageError: '--scenario 需要一个场景名。' };
      const parsed = parseScenarioList(raw);
      if (!Array.isArray(parsed)) return { usageError: parsed.error };
      for (const id of parsed) if (!options.scenarioIds.includes(id)) options.scenarioIds.push(id);
      continue;
    }
    if (arg === '--out-dir' || arg.startsWith('--out-dir=')) {
      const raw = arg.startsWith('--out-dir=') ? arg.slice('--out-dir='.length).trim() : takeValue('--out-dir');
      if (raw === undefined || raw === '') return { usageError: '--out-dir 需要一个值。' };
      options.outDir = raw;
      continue;
    }
    if (arg === '--turn-timeout-ms' || arg.startsWith('--turn-timeout-ms=')) {
      const raw = arg.startsWith('--turn-timeout-ms=') ? arg.slice('--turn-timeout-ms='.length) : takeValue('--turn-timeout-ms');
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(value) || value <= 0) return { usageError: `--turn-timeout-ms 必须是正整数（当前：${raw ?? '(缺值)'}）。` };
      options.turnTimeoutMs = value;
      continue;
    }
    if (arg === '--settle-timeout-ms' || arg.startsWith('--settle-timeout-ms=')) {
      const raw = arg.startsWith('--settle-timeout-ms=') ? arg.slice('--settle-timeout-ms='.length) : takeValue('--settle-timeout-ms');
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(value) || value <= 0) return { usageError: `--settle-timeout-ms 必须是正整数（当前：${raw ?? '(缺值)'}）。` };
      options.settleTimeoutMs = value;
      continue;
    }
    return { usageError: `未知参数：${digestValue(arg, 80)}（--help 看用法）。` };
  }
  if (options.scenarioIds.length === 0) options.scenarioIds = [...SCENARIO_IDS];
  return options;
}

// ---------------------------------------------------------------------------
// 装配（server 面；与 write-loop.ts 同形——同一 createServer + recordingDriver）
// ---------------------------------------------------------------------------

class InfraAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraAbort';
  }
}

interface RecordingSink {
  currentTurn: number;
  toolCalls: ToolCallEvidence[];
  pushes: PushEvidence[];
  seq: number;
}

interface Harness {
  id: ScenarioId;
  conversationId: string;
  scope: TaskScope;
  stateDir: string;
  dbPath: string;
  server: Server;
  registry: SqliteTaskRegistry;
  watcher: LedgerWatcher;
  sink: RecordingSink;
  logs: Array<Record<string, unknown>>;
  notifications: Notification[];
  turns: TurnEvidence[];
  visible: VisibleText[];
  profile: Parameters<typeof resolveExecutionFace>[0]['profile'];
  env: NodeJS.ProcessEnv;
  sendTurn(index: number, text: string, messageId: string): Promise<TurnEvidence>;
  tasksNow(): TaskFact[];
  taskRecords(): readonly TaskRecord[];
  auditNow(): AuditFact[];
  close(): Promise<void>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function receipt(route: ChannelRoute, kind: 'text' | 'file'): DeliveryReceipt {
  return { route, parts: [{ kind, index: 0, status: 'sent' }] };
}

interface PreflightResult {
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  profile: Parameters<typeof resolveExecutionFace>[0]['profile'];
  profileId: string;
  permissions: Permission[];
  modelId: string;
  baseUrl: string;
  apiKey: string;
}

/** 前置门（全场景共用；逐项机械）：配置物化 / 写开关 / 角色 / 隔离 / 模型 env。 */
function preflight(runRoot: string): PreflightResult {
  const configCopy = path.join(runRoot, 'agent-config.yaml');
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['runtime'] = { ...(configDoc['runtime'] as Record<string, unknown> ?? {}), allowWriteOperations: true };
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
  const permissions = permissionsOfRole(config, effectiveRoleOf(config, PRINCIPAL_ID)) as Permission[];
  if (!permissions.includes('write')) {
    throw new InfraAbort(`主体 ${PRINCIPAL_ID} 的角色权限不含 write（当前：${permissions.join(',')}）——写闭环无法验收。`);
  }
  if (config.principals[PRINCIPAL_ID]?.enabled !== true) {
    throw new InfraAbort(`主体 ${PRINCIPAL_ID} 未在配置里开通（enabled）。`);
  }
  log(`  配置源：仓内夹具物化副本（contextProfiles.${profileId} · gateway=${profile.gateway}）`);
  log(`  主体：${PRINCIPAL_ID} · 权限：${permissions.join(',')} · 写开关 runtime.allowWriteOperations=true`);
  log(`  模型：${modelId} @ ${baseUrl}（key 已提供，不打印）`);
  log(`  隔离：root 在仓内夹具之下=${isolation.fixtureWithinRepo} · gateway 存在=${isolation.gatewayPresent}`);
  emit('write_loop_scenarios_precondition', {
    profileId, principalId: PRINCIPAL_ID, permissions: permissions.join('+'), model: modelId,
  });
  return { config, env, profile, profileId, permissions, modelId, baseUrl, apiKey };
}

/** 每个场景一个独立 server/底账/state 根（场景之间零串扰）。 */
async function createHarness(
  id: ScenarioId,
  runRoot: string,
  pre: PreflightResult,
): Promise<Harness> {
  const dir = path.join(runRoot, id);
  rmSync(dir, { recursive: true, force: true });
  const stateDir = path.join(dir, 'state');
  const dbPath = path.join(dir, 'state.db');
  mkdirSync(stateDir, { recursive: true });
  registerRedaction(dir, `<run:${id}>`);
  registerRedaction(stateDir, `<state:${id}>`);
  registerRedaction(REPO_ROOT, '<repo>');
  registerRedaction(pre.profile.root, '<fixture>');

  const conversationId = `wloop2-${id}`;
  const scope: TaskScope = { principalId: PRINCIPAL_ID, sessionId: `${FAKE_CHANNEL}:${conversationId}` };
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
  // 宿主 sent 记账行 → 推送归属补填（taskId/factKind；对话形态 ② 的前提；targets = sink.pushes）。
  // 必须声明在 createServer 之前：logger 闭包在装配期就会同步被调用（无 role 主体的
  // principal_role_defaulted 行），const 在 TDZ 里会抛 ReferenceError。
  const attributeDeliveryProvenance = createDeliveryProvenanceAttributor(sink.pushes);
  const server = await createServer({
    env: pre.env,
    config: pre.config,
    dbPath,
    stateDir,
    fileDelivery: delivery,
    notificationSink,
    createDrivers: (driverEnv, mainSession) => ({
      // 与缺省装配逐项同形（ask-runtime 缺省分支）：Main 持实例级会话 + 会话落盘位置
      // ——唤醒（wake）以实例级会话为前提；思考档同样同源（mainThinkingLevel 回落 thinkingLevel）。
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
      // 完成/失败投递的记账行带 taskId/factKind；deliverText 先 await sendText（push 已是
      // sink 末条）再写 sent 账。记 sent 时给最近一条未归属的 push_text 补归属——迟到的
      // 第一次完成推送靠它归属到任务（S4-C4 用）+ 对话形态 ② 判「同事实投两次」（要求 D）。
      // 补填器单源（conversation-shape 的 createDeliveryProvenanceAttributor）。
      attributeDeliveryProvenance(line);
    },
  });

  const registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
  const watcher = new LedgerWatcher(registry, scope);
  watcher.start();
  const turns: TurnEvidence[] = [];
  const visible: VisibleText[] = [];

  const harness: Harness = {
    id,
    conversationId,
    scope,
    stateDir,
    dbPath,
    server,
    registry,
    watcher,
    sink,
    logs,
    notifications,
    turns,
    visible,
    profile: pre.profile,
    env: pre.env,
    async sendTurn(index, text, messageId) {
      sink.currentTurn = index;
      log(`\n[回合 ${index}] 用户：${text}`);
      const startedMs = Date.now();
      const message: IncomingChannelMessage = {
        wecomUserId: 'fixture-writer',
        channel: FAKE_CHANNEL,
        conversationId,
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
      visible.push({ at: new Date().toISOString(), source: 'turn', text: reply, turnIndex: index });
      log(`  用户可见回复：${digestValue(reply, 1200)}`);
      emit('write_loop_scenarios_turn', { scenario: id, index, durationMs: turn.durationMs, replyLength: reply.length, error: error ?? null });
      return turn;
    },
    taskRecords() {
      return registry.list(scope);
    },
    tasksNow() {
      return taskFactsOf(harness.taskRecords());
    },
    auditNow() {
      return readAuditFacts(stateDir);
    },
    async close() {
      watcher.stop();
      await server.close();
      registry.close();
    },
  };
  return harness;
}

function baseEvidence(harness: Harness): BaseEvidence {
  const deliveryEvents = harness.logs.filter((line) =>
    String(line['event'] ?? '').startsWith('task_result_delivery')
    || String(line['event'] ?? '').startsWith('notification_push')
    || line['event'] === 'task_completion_wake'
    || line['event'] === 'message_done'
    || line['event'] === 'task_failure_delivery_suppressed');
  const taskId = harness.watcher.taskIds()[0];
  // 用户可见面 = 回合回复 + 主动投递原文（按时间排序；两者都是用户真看得到的文本）。
  const visible: VisibleText[] = [
    ...harness.visible,
    ...harness.sink.pushes
      .filter((push) => push.source === 'push_text')
      .map((push) => ({ at: push.at, source: 'push' as const, text: push.text })),
  ].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  return {
    turns: harness.turns,
    pushes: harness.sink.pushes,
    toolCalls: harness.sink.toolCalls,
    audit: harness.auditNow(),
    jobs: readJobFacts(harness.stateDir),
    tasks: harness.tasksNow(),
    factSequence: taskId === undefined ? [] : harness.watcher.sequenceOf(taskId),
    visible,
    deliveryEvents: deliveryEvents.map((line) => ({ ...line })),
  };
}

function pushTextsOf(harness: Harness): string[] {
  return harness.sink.pushes.filter((push) => push.source === 'push_text').map((push) => push.text);
}

// ---------------------------------------------------------------------------
// 场景流程
// ---------------------------------------------------------------------------

/** 用户可见文本内部词泄漏报告（机械扫描；命中即机械失败，不进 judge、不降级为观察）。 */
export interface LeakReport {
  hitCount: number;
  hits: Array<{ where: string; marker: string; excerpt: string }>;
  channels: string[];
  notes: string[];
}

/**
 * 收集某场景的全部用户可见文本并扫描内部词。收全面：
 *   · 回合回复（BaseEvidence.visible source=turn，含 Main 每轮回复）；
 *   · 宿主主动投递文字（source=push / push_text：受理回执、通知、完成/失败消息）；
 *   · 宿主通知面（notificationSink 捕获的 Notification，经 renderNotification 还原用户语言）。
 * 文件投递（sendToConversation）当前夹具只投 `(files:N)` 计数占位、没有 caption 文本——
 * 渠道缺口在 notes 里如实登记，不拿空数组冒充扫过。
 *
 * 记录项（不改语义）：notifications 扫描面当前把 `notification_push_skipped`（kind 不在
 * PUSHED_NOTIFICATION_KINDS、本 sink 未投递；见 apps/server/notification-chat-sink.ts）的
 * Notification 也一并渲染进扫描。这类文案实际没到用户面，存在把它计为泄漏的风险。
 * 这里如实登记该口径、不改成「只看已投递」——是否收窄由用户级 eval / owner 裁定。
 */
export function scanScenarioLeaks(evidence: BaseEvidence, notifications: readonly Notification[]): LeakReport {
  const texts: Array<{ where: string; text: string }> = [];
  evidence.visible.forEach((entry, index) => {
    const where = entry.channel
      ?? `${entry.source === 'turn' ? '回合回复' : '主动投递'}#${index + 1}${entry.turnIndex === undefined ? '' : `(回合${entry.turnIndex})`}`;
    texts.push({ where, text: entry.text });
  });
  notifications.forEach((notification, index) => {
    try {
      texts.push({
        where: `通知#${index + 1}(${notification.kind})`,
        text: renderNotification({ kind: notification.kind, payload: notification.payload }),
      });
    } catch {
      // 渲染器自身拦内部术语并抛错（文案没到用户），此处不重复计泄漏。
    }
  });
  const { hits } = scanUserVisibleText(texts);
  return {
    hitCount: hits.length,
    hits,
    channels: ['回合回复(Main)', '宿主主动投递文字(push_text)', '宿主通知面(renderNotification)'],
    notes: [
      '文件投递渠道：本夹具 sendToConversation 只投 (files:N) 计数占位、无文件说明/caption 文本，故无 caption 可扫。',
      '记录项：通知扫描面含 notification_push_skipped（未投递）的渲染文本，可能把未到用户面的文案计为泄漏；此处如实登记，不收窄为「只看已投递」。',
    ],
  };
}

interface ScenarioResult {
  id: ScenarioId;
  title: string;
  criteria: CriterionResult[];
  observations: ObservationResult[];
  leak: LeakReport;
  /** 对话形态四条（要求 D）：独立守卫，违规即本场景失败（不进判据打分）。 */
  shape: { violationCount: number; violations: ShapeViolation[] };
  evidencePath?: string;
  infraError?: string;
}

const SCENARIO_TITLES: Record<ScenarioId, string> = {
  stop: '用户说停（慢活受理后被取消）',
  failure: '执行层业务失败（锁定集合确定性拒写）',
  idempotency: '同一消息重发（入站幂等）',
  reconfirm: '确认之后又确认一次（旧句柄复用）',
  'two-objects': '两件事同回合（两个对象各有各的结果）',
};

async function runStopScenario(harness: Harness, options: ScenarioRunOptions): Promise<StopEvidence> {
  const messageBase = nowSlug();
  await harness.sendTurn(1, STOP_TURN_1, `wloop2-stop-${messageBase}-1`);
  // 等执行层受理（审计 accepted 行）——这是「慢活已经在跑」的机械事实。
  const acceptedBeforeStop = await waitFor(
    () => harness.auditNow().some((row) => row.script === 'dummy.longtask' && row.longTask === 'accepted'),
    Math.min(options.turnTimeoutMs, 180_000),
  );
  log(`  长任务受理观测：${acceptedBeforeStop}`);
  await harness.sendTurn(2, STOP_TURN_2, `wloop2-stop-${messageBase}-2`);

  // 等任务真的落终局（cancelled）且没有非终局残留。
  const terminal = await waitFor(() => {
    const tasks = harness.tasksNow();
    return tasks.some((task) => task.cancelled) && tasks.every((task) => (task.cancelled || task.reported || task.liveness === 'died'));
  }, options.settleTimeoutMs);
  log(`  终局落定（cancelled）：${terminal}`);
  // 给宿主取消事实的主动推送一点落定时间（投递不改任务/审计事实）。
  await waitFor(
    () => harness.logs.some((line) =>
      String(line['event'] ?? '').startsWith('notification_push')
      || String(line['event'] ?? '').startsWith('task_result_delivery')),
    30_000,
  );
  await sleep(500);

  // 冻结窗口：终态观测时与 8s 后的审计行数必须相等（停后不再调用执行层）。
  const freezeWindowMs = 8_000;
  const auditAtCancel = harness.auditNow().length;
  await sleep(freezeWindowMs);
  const auditAfterFreeze = harness.auditNow().length;

  const cancelToolCall = harness.sink.toolCalls.find((call) => call.tool === 'task_cancel');
  const base = baseEvidence(harness);
  return {
    ...base,
    auditAtCancel,
    auditAfterFreeze,
    freezeWindowMs,
    acceptedBeforeStop,
    ...(cancelToolCall === undefined
      ? {}
      : { cancelToolCall: { ok: cancelToolCall.ok, summary: cancelToolCall.summary, args: cancelToolCall.args } }),
  };
}

async function runFailureScenario(harness: Harness, options: ScenarioRunOptions): Promise<FailureEvidence> {
  const readbackOptions = {
    profile: harness.profile, env: harness.env, stateDir: harness.stateDir,
    collection: LOCKED_COLLECTION, window: LOCKED_WINDOW,
  };
  const readbackBefore = await readCollection(readbackOptions);
  log(`[写前基线] ${LOCKED_COLLECTION}/${LOCKED_WINDOW} status=${readbackBefore.status} count=${String(readbackBefore.count)}`);
  if (readbackBefore.status !== 'completed' || readbackBefore.count !== LOCKED_BASELINE_COUNT) {
    throw new InfraAbort(`前置未过：${LOCKED_COLLECTION}/${LOCKED_WINDOW} 基线不是 ${LOCKED_BASELINE_COUNT} 条（当前 ${String(readbackBefore.count)}）。`);
  }

  await harness.sendTurn(1, FAILURE_TURN_1, `wloop2-failure-${nowSlug()}`);
  const landed = await waitFor(
    () => harness.tasksNow().some((task) => lastExecutionOf(task)?.status === 'failed'),
    options.settleTimeoutMs,
  );
  log(`  底账出现 failed 终局：${landed}`);
  // 给失败投递一点落定时间（投递不改任务事实）：等失败交付事件或超时。
  await waitFor(
    () => harness.logs.some((line) =>
      String(line['event'] ?? '').startsWith('task_result_delivery')
      || line['event'] === 'task_failure_delivery_suppressed'),
    30_000,
  );
  await sleep(500);
  const readbackAfter = await readCollection(readbackOptions);

  const audit = harness.auditNow();
  const writeCallsOnTarget = writeCallsOn(audit, LOCKED_COLLECTION);
  const tasks = harness.tasksNow();
  const failureCode = tasks
    .flatMap((task) => task.executions)
    .find((execution) => execution.status !== 'completed')?.code;
  const failureRelayedInTurn = harness.logs.some((line) =>
    line['event'] === 'task_failure_delivery_suppressed' && line['reason'] === 'relayed_in_turn');
  const retryAllowed = harness.logs.filter((line) =>
    line['event'] === 'execution_retry_allowed'
    && (line['object'] === undefined || argsMention(line['object'], LOCKED_COLLECTION))).length;
  const retryBlocked = harness.logs.filter((line) =>
    line['event'] === 'execution_retry_blocked'
    && (line['object'] === undefined || argsMention(line['object'], LOCKED_COLLECTION))).length;
  const attemptsOnTarget = harness.sink.toolCalls.filter((call) =>
    call.tool === 'execute_operation'
    && (call.args.includes('dummy.prepare') || call.args.includes('dummy.commit'))
    && argsMention(call.args, LOCKED_COLLECTION)).length;
  const base = baseEvidence(harness);
  return {
    ...base,
    audit,
    tasks,
    readbackBefore,
    readbackAfter,
    writeCallsOnTarget,
    ...(failureCode === undefined ? {} : { failureCode }),
    pushTexts: pushTextsOf(harness),
    failureRelayedInTurn,
    retryAllowed,
    retryBlocked,
    attemptsOnTarget,
  };
}

async function waitForProposal(harness: Harness, options: ScenarioRunOptions): Promise<boolean> {
  return await waitFor(
    () => harness.tasksNow().some((task) => task.liveness === 'waiting_user') || harness.watcher.snapshots.some((snapshot) => snapshot.proposal !== undefined),
    Math.min(options.turnTimeoutMs, 180_000),
  );
}

async function waitForTerminal(harness: Harness, options: ScenarioRunOptions): Promise<boolean> {
  return await waitFor(
    () => {
      const tasks = harness.tasksNow();
      return tasks.length > 0 && tasks.every((task) => (task.cancelled || task.reported || task.liveness === 'died'));
    },
    options.settleTimeoutMs,
  );
}

async function waitForDeliverySettle(harness: Harness): Promise<void> {
  await waitFor(
    () => harness.logs.some((line) =>
      line['event'] === 'task_result_delivery_sent' || line['event'] === 'task_result_delivery_suppressed'),
    30_000,
  );
  await sleep(500);
}

/**
 * 等待**指定任务**的完成投递按它自己的记账落定（sent/suppressed 事件，非固定时间窗）。
 *
 * 2026-11-20 修复（reconfirm 假红）：旧实现只等"任意一条投递事件"——更早的失败任务
 * 早已记账，于是立刻通过，第一次合法写入的完成推送（走唤醒，慢几秒）落进"二次确认后"
 * 的窗口被当成假成功。锚点改为按任务归属的投递记账：第三次回合开启前必须先看到
 * 该写入任务的投递落定（或如实记未落定，由判据按归属/内容排除迟到投递兜底）。
 */
async function waitForTaskDeliverySettle(harness: Harness, taskId: string | undefined, options: ScenarioRunOptions): Promise<boolean> {
  if (taskId === undefined) return false;
  const settled = await waitFor(
    () => harness.logs.some((line) =>
      (line['event'] === 'task_result_delivery_sent' || line['event'] === 'task_result_delivery_suppressed')
      && line['taskId'] === taskId),
    Math.min(options.settleTimeoutMs, 120_000),
  );
  await sleep(500);
  return settled;
}

async function runIdempotencyScenario(harness: Harness, options: ScenarioRunOptions): Promise<IdempotencyEvidence> {
  const readbackOptions = {
    profile: harness.profile, env: harness.env, stateDir: harness.stateDir,
    collection: WRITE_COLLECTION, window: WRITE_WINDOW,
  };
  const readbackBefore = await readCollection(readbackOptions);
  log(`[写前基线] ${WRITE_COLLECTION}/${WRITE_WINDOW} status=${readbackBefore.status} count=${String(readbackBefore.count)}`);
  if (readbackBefore.status !== 'completed' || readbackBefore.count !== 0) {
    throw new InfraAbort(`前置未过：${WRITE_COLLECTION}/${WRITE_WINDOW} 基线不是空集（count=${String(readbackBefore.count)}）。`);
  }

  // 同一 messageId 并发发两次：第一次受理、第二次在办理中到达（入站幂等路径）。
  const message: IncomingChannelMessage = {
    wecomUserId: 'fixture-writer',
    channel: FAKE_CHANNEL,
    conversationId: harness.conversationId,
    messageId: `wloop2-idempotency-${nowSlug()}`,
    chatType: 'single',
    text: USER_TURN_1,
    receivedAt: new Date().toISOString(),
  };
  harness.sink.currentTurn = 1;
  log(`\n[回合 1] 用户（同 messageId 并发重发）：${USER_TURN_1}`);
  const firstStartedAt = Date.now();
  const firstPending = (async () => {
    const result = await harness.server.handler(message);
    return { reply: typeof result === 'string' ? result : (result.text ?? ''), elapsedMs: Date.now() - firstStartedAt };
  })();
  const secondStartedAt = Date.now();
  const secondPending = (async () => {
    const result = await harness.server.handler(message);
    return { reply: typeof result === 'string' ? result : (result.text ?? ''), elapsedMs: Date.now() - secondStartedAt };
  })();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  harness.turns.push({ index: 1, userText: `${USER_TURN_1}（同 messageId 并发重发一次）`, reply: first.reply, durationMs: first.elapsedMs });
  harness.visible.push({ at: new Date().toISOString(), source: 'turn', text: first.reply, turnIndex: 1 });
  // 幂等第二次回执也进用户可见面：两次回执各自独立扫描（channel 名区分），
  // 否则 sameText=false（第二次文本不同）时第二次回执的内部词会从扫描面漏掉。
  harness.visible.push({ at: new Date().toISOString(), source: 'turn', text: second.reply, turnIndex: 1, channel: '幂等第二次回执' });
  const events = harness.logs
    .filter((line) => line['event'] === 'message_duplicate_replayed' || line['event'] === 'message_still_processing')
    .map((line) => String(line['event']));
  log(`  第一次回执（${first.elapsedMs}ms）：${digestValue(first.reply, 600)}`);
  log(`  第二次回执（${second.elapsedMs}ms）：${digestValue(second.reply, 600)}`);
  emit('write_loop_scenarios_duplicate', {
    scenario: 'idempotency', sameText: second.reply === first.reply,
    firstDurationMs: first.elapsedMs, secondDurationMs: second.elapsedMs, events,
  });

  const sawProposal = await waitForProposal(harness, options);
  log(`  提案已落底账：${sawProposal}`);
  await harness.sendTurn(2, USER_TURN_2, `wloop2-idempotency-${nowSlug()}-confirm`);
  const landed = await waitForTerminal(harness, options);
  log(`  终局落定：${landed}`);
  await waitForDeliverySettle(harness);

  const audit = harness.auditNow();
  const base = baseEvidence(harness);
  return {
    ...base,
    audit,
    duplicate: {
      firstReply: first.reply,
      secondReply: second.reply,
      firstDurationMs: first.elapsedMs,
      secondDurationMs: second.elapsedMs,
      sameText: second.reply === first.reply,
      events,
    },
    readbackBefore,
    readbackAfter: await readCollection(readbackOptions),
    confirmations: readConfirmationLedger(harness.stateDir, WRITE_COLLECTION),
    prepareSuccessCount: prepareSuccessRows(audit).length,
    commitSuccessCount: commitSuccessRows(audit).length,
    taskRunCalls: harness.sink.toolCalls.filter((call) => call.tool === 'task_run').length,
  };
}

async function runReconfirmScenario(harness: Harness, options: ScenarioRunOptions): Promise<ReconfirmEvidence> {
  const readbackOptions = {
    profile: harness.profile, env: harness.env, stateDir: harness.stateDir,
    collection: WRITE_COLLECTION, window: WRITE_WINDOW,
  };
  const readbackBefore = await readCollection(readbackOptions);
  if (readbackBefore.status !== 'completed' || readbackBefore.count !== 0) {
    throw new InfraAbort(`前置未过：${WRITE_COLLECTION}/${WRITE_WINDOW} 基线不是空集（count=${String(readbackBefore.count)}）。`);
  }

  await harness.sendTurn(1, USER_TURN_1, `wloop2-reconfirm-${nowSlug()}-1`);
  const sawProposal = await waitForProposal(harness, options);
  log(`  提案已落底账：${sawProposal}`);

  // 确认回合：模型可能一次不成（例如先把 --records 写坏、任务失败后重开任务重新提案）——
  // 最多三轮，直到「写入真的落地」（commit completed 事实 ≥ 1 且句柄 usedAt 非空）。
  const writeLandedNow = (): boolean => harness.tasksNow().some((task) =>
    task.executions.some((execution) => execution.operation === 'dummy.commit' && execution.status === 'completed'))
    && readConfirmationLedger(harness.stateDir, WRITE_COLLECTION).usedCount >= 1;
  let confirmRounds = 0;
  let firstWriteLanded = false;
  while (confirmRounds < 3 && !firstWriteLanded) {
    confirmRounds += 1;
    await harness.sendTurn(1 + confirmRounds, USER_TURN_2, `wloop2-reconfirm-${nowSlug()}-${1 + confirmRounds}`);
    await waitFor(() => writeLandedNow(), Math.min(options.settleTimeoutMs, 120_000));
    firstWriteLanded = writeLandedNow();
    log(`  第 ${confirmRounds} 轮确认后写入落地：${firstWriteLanded}`);
    if (!firstWriteLanded) {
      // 没落地：给后台一个落定/重新提案的窗口再决定是否再来一轮。
      await waitForTerminal(harness, options);
      await sleep(1_000);
    }
  }
  await waitForTerminal(harness, options);
  // 锚点：等**第一次写入任务自己的**完成投递按记账落定（不是"任意一条投递"——旧实现被更早的
  // 失败任务投递骗过，见 waitForTaskDeliverySettle 注释），再开第三次回合的窗口。
  const writeTask = harness.tasksNow().find((task) =>
    task.executions.some((execution) => execution.operation === 'dummy.commit' && execution.status === 'completed'));
  const writeTaskId = writeTask?.taskId;
  const firstWriteDeliverySettled = await waitForTaskDeliverySettle(harness, writeTaskId, options);
  if (!firstWriteDeliverySettled) {
    // 该任务自己的投递记账未等到（唤醒慢/记账缺失）：退回通用落定等待，如实记事实；
    // 迟到投递由 C4 按任务归属/内容排除兜底。
    await waitForDeliverySettle(harness);
  }
  log(`  第一次写入完成投递落定：${firstWriteDeliverySettled}（taskId=${writeTaskId ?? '(未知)'}）`);

  const auditAfterFirstWrite = harness.auditNow();
  const confirmationsAfterFirstWrite = readConfirmationLedger(harness.stateDir, WRITE_COLLECTION);
  const taskCountAfterFirstWrite = harness.tasksNow().length;
  emit('write_loop_scenarios_first_write', {
    scenario: 'reconfirm', firstWriteLanded,
    confirmRounds, commitSuccess: commitSuccessRows(auditAfterFirstWrite).length,
    usedAt: confirmationsAfterFirstWrite.usedAt ?? null,
    writeTaskId: writeTaskId ?? null, firstWriteDeliverySettled,
  });

  // 目标回合：写入已完成之后，用户又说一次「确认」（旧句柄复用路径）。
  const thirdTurnStartedAt = new Date().toISOString();
  const thirdTurnIndex = 2 + confirmRounds;
  await harness.sendTurn(thirdTurnIndex, USER_TURN_2, `wloop2-reconfirm-${nowSlug()}-${thirdTurnIndex}`);
  // 若模型又起了后台任务，给它落定的机会（判据要看到它）。
  await waitForTerminal(harness, options);
  await sleep(2_000);

  const auditAfterReconfirm = harness.auditNow();
  const tasks = harness.tasksNow();
  const textsAfterThirdTurn: VisibleText[] = [
    ...harness.visible.filter((entry) => entry.at >= thirdTurnStartedAt),
    ...harness.sink.pushes
      .filter((push) => push.source === 'push_text' && push.at >= thirdTurnStartedAt)
      .map((push) => ({
        at: push.at, source: 'push' as const, text: push.text,
        ...(push.taskId === undefined ? {} : { taskId: push.taskId }),
      })),
  ].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  const taskConfirmStartedCalls = harness.sink.toolCalls.filter((call) =>
    call.turn >= thirdTurnIndex && call.tool === 'task_confirm' && call.ok && call.summary.startsWith('started'));
  const base = baseEvidence(harness);
  return {
    ...base,
    audit: auditAfterReconfirm,
    tasks,
    firstWriteLanded,
    confirmRounds,
    commitSuccessCount: commitSuccessRows(auditAfterReconfirm).length,
    commitCompletedFacts: tasks.flatMap((task) => task.executions)
      .filter((execution) => execution.operation === 'dummy.commit' && execution.status === 'completed').length,
    readbackAfter: await readCollection(readbackOptions),
    confirmations: readConfirmationLedger(harness.stateDir, WRITE_COLLECTION),
    confirmationsAfterFirstWrite,
    taskCountAfterFirstWrite,
    taskCountAfterReconfirm: tasks.length,
    ...(writeTaskId === undefined ? {} : { writeTaskId }),
    firstWriteDeliverySettled,
    thirdTurnStartedAt,
    textsAfterThirdTurn,
    auditCountAfterFirstWrite: auditAfterFirstWrite.length,
    auditCountAfterReconfirm: auditAfterReconfirm.length,
    taskConfirmStartedCalls,
  };
}

async function runTwoObjectsScenario(harness: Harness, options: ScenarioRunOptions): Promise<TwoObjectsEvidence> {
  const readbackFor = (spec: CollectionSpec) => ({
    profile: harness.profile, env: harness.env, stateDir: harness.stateDir,
    collection: spec.collection, window: spec.window,
  });
  const readbackBefore: QueryReading[] = [];
  for (const spec of TWO_OBJECTS_SPECS) {
    const reading = await readCollection(readbackFor(spec));
    if (reading.status !== 'completed' || typeof reading.count !== 'number') {
      throw new InfraAbort(`前置未过：${spec.collection}/${spec.window} 基线读数不可用（status=${reading.status}）。`);
    }
    readbackBefore.push(reading);
    log(`[写前基线] ${spec.collection}/${spec.window} count=${reading.count}`);
  }

  await harness.sendTurn(1, TWO_OBJECTS_TURN_1, `wloop2-two-${nowSlug()}-1`);
  let confirmTurns = 0;
  for (let round = 0; round < 3; round += 1) {
    const waiting = harness.taskRecords().filter((task) => task.pendingQuestion !== undefined && task.pendingQuestion?.confirmation !== undefined);
    if (waiting.length === 0) {
      // 还没有提案再等一次（Worker 回合可能仍在跑）。
      const sawProposal = await waitForProposal(harness, options);
      if (!sawProposal) break;
      const waitingAfter = harness.taskRecords().filter((task) => task.pendingQuestion !== undefined && task.pendingQuestion?.confirmation !== undefined);
      if (waitingAfter.length === 0) break;
    }
    confirmTurns += 1;
    await harness.sendTurn(1 + confirmTurns, USER_TURN_2, `wloop2-two-${nowSlug()}-confirm-${confirmTurns}`);
    await sleep(1_500);
  }
  const landed = await waitForTerminal(harness, options);
  log(`  终局落定：${landed}（确认回合 ${confirmTurns} 次）`);
  await waitForDeliverySettle(harness);

  const audit = harness.auditNow();
  const tasks = harness.tasksNow();
  const perCollection = [];
  for (let index = 0; index < TWO_OBJECTS_SPECS.length; index += 1) {
    const spec = TWO_OBJECTS_SPECS[index]!;
    perCollection.push({
      collection: spec.collection,
      window: spec.window,
      expected: spec.expected,
      readbackBefore: readbackBefore[index]!,
      readbackAfter: await readCollection(readbackFor(spec)),
      prepareSuccessCount: prepareSuccessRows(audit, spec.collection).length,
      commitSuccessCount: commitSuccessRows(audit, spec.collection).length,
    });
  }
  const commitCompletedFactsTotal = tasks.flatMap((task) => task.executions)
    .filter((execution) => execution.operation === 'dummy.commit' && execution.status === 'completed').length;
  const completionDeliverySeen = harness.logs.some((line) =>
    line['event'] === 'task_result_delivery_sent'
    || line['event'] === 'task_completion_wake'
    || (line['event'] === 'task_result_delivery_suppressed' && line['reason'] === 'relayed_in_turn'))
    || tasks.some((task) => task.reported);
  const base = baseEvidence(harness);
  return {
    ...base,
    audit,
    tasks,
    perCollection,
    commitCompletedFactsTotal,
    confirmTurns,
    completionDeliverySeen,
  };
}

async function runScenario(
  id: ScenarioId,
  runRoot: string,
  options: ScenarioRunOptions,
  pre: PreflightResult,
): Promise<ScenarioResult> {
  log(`\n${'='.repeat(78)}\n== 场景 ${id}：${SCENARIO_TITLES[id]}\n${'='.repeat(78)}`);
  const harness = await createHarness(id, runRoot, pre);
  try {
    let criteria: CriterionResult[];
    let observations: ObservationResult[];
    let evidence: unknown;
    if (id === 'stop') {
      const result = await runStopScenario(harness, options);
      evidence = result;
      criteria = evaluateStopCriteria(result);
      observations = evaluateStopObservations(result);
    } else if (id === 'failure') {
      const result = await runFailureScenario(harness, options);
      evidence = result;
      criteria = evaluateFailureCriteria(result);
      observations = evaluateFailureObservations(result);
    } else if (id === 'idempotency') {
      const result = await runIdempotencyScenario(harness, options);
      evidence = result;
      criteria = evaluateIdempotencyCriteria(result);
      observations = evaluateIdempotencyObservations(result);
    } else if (id === 'reconfirm') {
      const result = await runReconfirmScenario(harness, options);
      evidence = result;
      criteria = evaluateReconfirmCriteria(result);
      observations = evaluateReconfirmObservations(result);
    } else {
      const result = await runTwoObjectsScenario(harness, options);
      evidence = result;
      criteria = evaluateTwoObjectsCriteria(result);
      observations = evaluateTwoObjectsObservations(result);
    }

    // 证据打印（机械事实；原文不截断判读，这里限长只为可读）。
    printEvidence(id, evidence as BaseEvidence);

    log('\n== 判据（机械事实） ==');
    for (const criterion of criteria) {
      log(`  [${criterion.status === 'pass' ? 'PASS' : 'FAIL'}] ${criterion.id} ${criterion.title}（${criterion.kind}）`);
      log(`        ${criterion.detail}`);
      emit('write_loop_scenarios_criterion', { scenario: id, id: criterion.id, status: criterion.status, kind: criterion.kind });
    }
    log('\n== 观察（只记录，不判红） ==');
    for (const observation of observations) {
      log(`  · ${observation.id} ${observation.title}：${observation.detail}`);
      emit('write_loop_scenarios_observation', { scenario: id, id: observation.id });
    }

    // 用户可见文本内部词泄漏：机械扫描，命中即本场景失败（不进 judge、不降级为观察）。
    const leak = scanScenarioLeaks(evidence as BaseEvidence, harness.notifications);
    log(`\n== 用户可见文本内部词泄漏（通用守卫，场景 ${id}） ==`);
    log(`  命中数=${leak.hitCount}；扫描渠道=${leak.channels.join('、')}`);
    for (const note of leak.notes) log(`  注：${note}`);
    for (const hit of leak.hits) log(`  命中@${hit.where} 「${hit.marker}」：${redact(hit.excerpt)}`);
    emit('write_loop_scenarios_leak', { scenario: id, hitCount: leak.hitCount, hits: leak.hits.map((h) => ({ where: h.where, marker: h.marker })) });

    // 对话形态四条（交接门 2026-11-21）：回合 + 推送（含归属补填）+ 底账业务名喂共享断言层，
    // 违规即本场景失败（与内部词泄漏同一独立守卫位，不进判据打分、不降级为观察）。
    const shapeTaskNames = harness.tasksNow()
      .map((task) => (task.name ?? '').trim())
      .filter((name) => name !== '');
    const shapeViolations: ShapeViolation[] = checkTurnFaceShape(harness.turns, harness.sink.pushes, shapeTaskNames);
    log(`\n== 对话形态（通用守卫，要求 D，场景 ${id}） ==`);
    if (shapeViolations.length === 0) {
      log('  零违规（①每消息≤1回复 ②同事实≤1投递 ③推送自含话题 ④回复不错挂）');
    } else {
      log(redact(formatShapeViolations(shapeViolations, `违规 ${shapeViolations.length} 条`)));
    }
    emit('write_loop_scenarios_shape', {
      scenario: id,
      violationCount: shapeViolations.length,
      codes: shapeViolations.map((violation) => violation.code),
    });

    const evidenceDir = path.join(runRoot, id);
    const evidencePath = path.join(evidenceDir, 'evidence.json');
    const bundle = {
      generatedAt: new Date().toISOString(),
      scenario: id,
      title: SCENARIO_TITLES[id],
      model: { modelId: pre.modelId, apiBaseUrl: redact(pre.baseUrl), apiKeyProvided: pre.apiKey !== '' },
      evidence: redactEvidence(evidence),
      criteria,
      observations,
      shape: { violationCount: shapeViolations.length, violations: shapeViolations },
      leak: {
        hitCount: leak.hitCount,
        hits: leak.hits.map((hit) => ({ where: hit.where, marker: hit.marker, excerpt: redact(hit.excerpt) })),
        channels: leak.channels,
        notes: leak.notes,
      },
    };
    writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`);
    log(`\n证据已落盘：${path.relative(REPO_ROOT, evidencePath)}（gitignored；不含密钥）`);
    return { id, title: SCENARIO_TITLES[id], criteria, observations, leak, shape: { violationCount: shapeViolations.length, violations: shapeViolations }, evidencePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const infra = error instanceof InfraAbort;
    const criteria: CriterionResult[] = [{
      id: `${id.toUpperCase()}-X0`,
      title: infra ? '场景前置未过（基线/装配），本场景未验' : '场景跑通（无中断异常）',
      kind: 'mechanical',
      status: 'fail',
      detail: redact(message),
    }];
    log(`\n[场景 ${id} 中断] ${redact(message)}`);
    emit('write_loop_scenarios_criterion', { scenario: id, id: criteria[0]!.id, status: 'fail', kind: 'mechanical' });
    const leak: LeakReport = {
      hitCount: 0, hits: [], channels: [],
      notes: [`场景在用户可见文本收集前中断（${infra ? '前置未过' : '运行异常'}），本场景无文本可扫；如实登记，不冒充扫过。`],
    };
    // 中断场景无对话形态证据：violationCount=0 只是「未判」的形状位（判据已如实记中断 fail）。
    const shape = { violationCount: 0, violations: [] as ShapeViolation[] };
    return { id, title: SCENARIO_TITLES[id], criteria, observations: [], leak, shape, ...(infra ? { infraError: message } : { infraError: message }) };
  } finally {
    await harness.close().catch(() => {});
  }
}

function printEvidence(id: ScenarioId, evidence: BaseEvidence): void {
  log('\n== 机械证据 ==');
  log(`[任务底账] 会话内任务数=${evidence.tasks.length} · 事实序列=${evidence.factSequence.join(' → ') || '(未观测到)'}`);
  for (const task of evidence.tasks) {
    log(`  · 任务 #${String(task.taskNo ?? '-')}（${task.taskId}）终局=${task.liveness ?? (task.reported ? '已汇报' : '已收尾')}${task.reason === undefined ? '' : ` reason=${task.reason}`}`
      + `：${task.executions.map((execution) => `${execution.operation}:${execution.status}${execution.code === undefined ? '' : `(${execution.code})`}`).join(' → ') || '(无执行事实)'}`);
  }
  log('[工具调用]（记录包装器透传采集）');
  for (const call of evidence.toolCalls) {
    log(`  · #${call.seq} [${call.agent}·回合${call.turn}] ${call.tool}(${digestValue(call.args, 300)}) → ${call.summary}${call.ok ? '' : ' [抛错]'} (${call.elapsedMs}ms)`);
  }
  log('[执行层收到的请求]（执行层自己的 audit.jsonl）');
  for (const row of evidence.audit) {
    log(`  · mode=${row.mode} script=${row.script} via=${row.via ?? '-'} exit=${String(row.exitCode ?? '-')}`
      + `${row.refused === undefined ? '' : ` refused=${row.refused}`}`
      + `${row.longTask === undefined ? '' : ` longTask=${row.longTask}`}`
      + `${row.phase === undefined ? '' : ` phase=${row.phase}`} args=${digestValue(row.args, 240)}`);
  }
  if (evidence.jobs.length > 0) {
    log('[执行层 job 文件]');
    for (const job of evidence.jobs) log(`  · ${job.operationId} status=${job.status} seconds=${String(job.seconds ?? '-')}`);
  }
  log('[用户可见面]');
  for (const entry of evidence.visible) {
    log(`  · [${entry.source}${entry.turnIndex === undefined ? '' : `·回合${entry.turnIndex}`}] ${digestValue(entry.text, 1500)}`);
  }
  log('[投递事件]');
  for (const event of evidence.deliveryEvents) log(`  · ${digestValue(event, 300)}`);
  log('[读回]');
  log(`  · 见判据 detail 与 evidence.json（结构化读数）`);
  emit(`write_loop_scenarios_evidence_${id.replace(/-/g, '_')}`, {
    tasks: evidence.tasks.map((task) => ({ taskNo: task.taskNo ?? null, liveness: task.liveness, reported: task.reported, executions: task.executions.length })),
    auditRows: evidence.audit.length,
    toolCalls: evidence.toolCalls.length,
  });
}

/** 证据落盘前的文本脱敏（密钥永不入盘；路径先替换再 stripServerPaths）。 */
function redactEvidence(evidence: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = walk(entry);
      return out;
    }
    return value;
  };
  return walk(evidence);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 自动生成的运行目录（显式 --out-dir 时 undefined）：前置门失败时清掉，不留空目录。 */
let autoRunDirForCleanup: string | undefined;

async function main(): Promise<void> {
  const parsed = parseScenarioArgs(process.argv.slice(2));
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
  const runRoot = options.outDir !== undefined
    ? path.resolve(options.outDir)
    : path.join(DEFAULT_OUT_ROOT, nowSlug());
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  autoRunDirForCleanup = options.outDir === undefined ? runRoot : undefined;
  registerRedaction(runRoot, '<run>');
  registerRedaction(REPO_ROOT, '<repo>');

  log('== 真模型写闭环小场景集验收（server 装配 · 仓内 dummy 执行层 · 不触真实平台） ==');
  log(`  场景：${options.scenarioIds.join(' / ')}`);
  log('\n[S0] 前置门（配置 / 写开关 / 角色 / 隔离 / 模型 env）');

  let pre: PreflightResult;
  try {
    pre = preflight(runRoot);
  } catch (error) {
    if (error instanceof InfraAbort) {
      console.error(`\n前置未过（如实失败，不退回脚本模型）：${redact(error.message)}`);
      if (autoRunDirForCleanup !== undefined && !existsSync(path.join(autoRunDirForCleanup, 'summary.json'))) {
        rmSync(autoRunDirForCleanup, { recursive: true, force: true });
      }
      process.exitCode = 2;
      return;
    }
    console.error(`验收中断：${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    process.exitCode = 1;
    return;
  }

  const results: ScenarioResult[] = [];
  for (const id of options.scenarioIds) {
    results.push(await runScenario(id, runRoot, options, pre));
  }

  // ---- 汇总 ----
  const allCriteria = results.flatMap((result) => result.criteria);
  const failedCriteria = allCriteria.filter((criterion) => criterion.status === 'fail');
  const leakedScenarios = results.filter((result) => result.leak.hitCount > 0);
  const leakHitTotal = leakedScenarios.reduce((sum, result) => sum + result.leak.hitCount, 0);
  const shapeFailedScenarios = results.filter((result) => result.shape.violationCount > 0);
  const shapeViolationTotal = shapeFailedScenarios.reduce((sum, result) => sum + result.shape.violationCount, 0);
  log(`\n${'='.repeat(78)}\n== 汇总 ==`);
  for (const result of results) {
    const failed = result.criteria.filter((criterion) => criterion.status === 'fail');
    log(`  · ${result.id}（${result.title}）：判据 ${result.criteria.length} 条，fail=${failed.length}`
      + `${failed.length === 0 ? '' : ` → ${failed.map((criterion) => criterion.id).join(',')}`}`
      + `；内部词泄漏命中=${result.leak.hitCount}${result.leak.hitCount > 0 ? '（机械失败）' : ''}`
      + `；对话形态违规=${result.shape.violationCount}${result.shape.violationCount > 0 ? '（机械失败）' : ''}`);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    model: { modelId: pre.modelId, apiBaseUrl: redact(pre.baseUrl) },
    scenarios: results.map((result) => ({
      id: result.id, title: result.title,
      criteria: result.criteria, observations: result.observations,
      leak: {
        hitCount: result.leak.hitCount,
        hits: result.leak.hits.map((hit) => ({ where: hit.where, marker: hit.marker, excerpt: redact(hit.excerpt) })),
        channels: result.leak.channels, notes: result.leak.notes,
      },
      shape: { violationCount: result.shape.violationCount, violations: result.shape.violations },
      ...(result.evidencePath === undefined ? {} : { evidencePath: path.relative(REPO_ROOT, result.evidencePath) }),
      ...(result.infraError === undefined ? {} : { infraError: redact(result.infraError) }),
    })),
    totals: { criteria: allCriteria.length, failed: failedCriteria.length, leakHits: leakHitTotal, shapeViolations: shapeViolationTotal },
    leak: {
      hitCount: leakHitTotal,
      scenarios: leakedScenarios.map((result) => ({
        id: result.id,
        hits: result.leak.hits.map((hit) => ({ where: hit.where, marker: hit.marker, excerpt: redact(hit.excerpt) })),
      })),
    },
  };
  writeFileSync(path.join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`  判据合计 ${allCriteria.length} 条，fail=${failedCriteria.length}；内部词泄漏命中=${leakHitTotal}；对话形态违规=${shapeViolationTotal}`);
  log(`  汇总落盘：${path.relative(REPO_ROOT, path.join(runRoot, 'summary.json'))}`);
  emit('write_loop_scenarios_summary', {
    scenarios: results.map((result) => result.id).join('+'),
    criteria: allCriteria.length,
    failed: failedCriteria.length,
    leakHits: leakHitTotal,
    shapeViolations: shapeViolationTotal,
  });
  if (failedCriteria.length > 0) {
    for (const criterion of failedCriteria) log(`  FAIL ${criterion.id}：${criterion.detail}`);
  }
  if (leakedScenarios.length > 0) {
    for (const result of leakedScenarios) {
      log(`  FAIL LEAK_INTERNAL_TERM（场景 ${result.id}）：命中 ${result.leak.hitCount} 处（见各场景 evidence.json#leak）。`);
    }
  }
  if (shapeFailedScenarios.length > 0) {
    for (const result of shapeFailedScenarios) {
      log(`  FAIL SHAPE_CONVERSATION（场景 ${result.id}）：对话形态违规 ${result.shape.violationCount} 条（见各场景 evidence.json#shape）。`);
    }
  }
  if (failedCriteria.length > 0 || leakedScenarios.length > 0 || shapeFailedScenarios.length > 0) process.exitCode = 1;
  log(`\n== 场景集结束：判据 ${allCriteria.length} 条，pass=${allCriteria.length - failedCriteria.length} fail=${failedCriteria.length}；内部词泄漏命中=${leakHitTotal}；对话形态违规=${shapeViolationTotal} ==`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`验收中断：${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
