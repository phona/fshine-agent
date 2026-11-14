/**
 * P4 通知 outbox（冻结契约 §4；B 类：任务事实到用户的如实交付，渠道无关）。
 *
 * 为什么需要它：后台/长任务的状态变化必须能被用户看见，但「投递」不是任务事实本身——
 * 通知失败或延迟不得改变任务结果。因此本模块把「通知事实」先落同库 outbox，再由
 * 渠道无关的 `NotificationSink` 投递；投递成功与否只改 outbox 的投递列。
 *
 * 最小形状（全部冻结项，见 docs/product/r4-joint-interfaces.md §4）：
 *   · 9 类通知意图枚举 + 状态转移→意图映射（阶段进展/里程碑由 state fact 生成）；
 *   · 同库最小表 notifications(id, task_id, kind, state_version, payload_json, created_at,
 *     delivered_at, attempts, last_error)，由本模块 `CREATE TABLE IF NOT EXISTS` 自建（幂等）；
 *     唯一 (task_id, kind, state_version) —— 重复触发不新增、不覆盖首次事实；
 *   · 同进程有界重试：退避（基数指数、上限封顶）到点才重试，attempts 达上限即停止；
 *     「下一次可尝试时间」由 created_at + 累计退避机械推出（不新增冻结列）；
 *   · payload 仅来自传入底账事实的白名单字段（taskNo/name/reason/requestIds/at），
 *     未知字段一律拒绝（拒绝编造百分比/内部路径/自由文本）；
 *   · 未送达（含超限停止）可查：listNotifications / undelivered 只读查询，供 tasks/ops
 *     与后续只读工具使用（不自动注入对话历史——T05 按联合契约只读形态）。
 *
 * 不做的（登记边界）：通用事件总线、独立消息系统、第二套对话历史、跨进程投递服务/
 * 守护进程；重试由集成侧调用 `deliverPending()` 驱动，本模块只持有确定性语义与状态。
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** 9 类通知意图（冻结顺序；契约 §4）。 */
export const NOTIFICATION_KINDS = [
  'accepted',
  'started',
  'waiting_user',
  'resumed',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'resource_limited',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 机械失败/终止原因（契约 §1 冻结集合；payload.reason 仅允许此集合）。 */
export const NOTIFICATION_REASONS = [
  'cancelled_by_user',
  'timeout',
  'failed_confirmed',
  'result_unknown',
  'resource_limited',
] as const;

export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

/** 任务状态集（契约 §1 冻结；含保留的 unexecuted）。 */
export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'unexecuted';

/** payload 字段白名单（仅底账事实；不接受自由文本编造）。 */
export interface NotificationPayload {
  /** 事实时间（底账事实，ISO）。 */
  at: string;
  /** 数字任务编号（底账分配）。 */
  taskNo?: number;
  /** 业务名称（底账机械回落值）。 */
  name?: string;
  /** 机械失败/终止原因（§1 枚举）。 */
  reason?: NotificationReason;
  /** Request ID 仅追溯，非凭据。 */
  requestIds?: readonly string[];
}

/**
 * 一条通知事实输入（写点）。字段全部对应底账事实；运行时同时做白名单键校验，
 * 未知字段（如 percent/内部路径）抛 NotificationPayloadError 且不落库。
 */
export interface NotificationFact {
  taskId: string;
  kind: NotificationKind;
  /** 事实时间（底账 TaskFact.at）。必填；stateVersion 缺省时用它做去重键。 */
  at: string;
  /** 状态版本（唯一键第三段）；缺省 = at，防止同一事实重复触发产生新行。 */
  stateVersion?: string | number;
  taskNo?: number;
  name?: string;
  reason?: NotificationReason;
  requestIds?: readonly string[];
}

/** 白名单违规（编造/未知字段、非法枚举、缺必填）：拒绝写入，不污染 outbox。 */
export class NotificationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationPayloadError';
  }
}

/** 一条 outbox 通知（对外只读形状）。 */
export interface Notification {
  id: number;
  taskId: string;
  kind: NotificationKind;
  stateVersion: string;
  payload: NotificationPayload;
  /** 写点接收事实的时间（outbox 时钟）。 */
  createdAt: string;
  deliveredAt?: string;
  attempts: number;
  lastError?: string;
  /** true = 未送达且 attempts 已达上限：同进程重试已停止（未送达仍可见）。 */
  exhausted: boolean;
}

/** 渠道应答：delivered=false 时 error 为机械原因（不得含凭据/内部路径）。 */
export interface DeliveryReceipt {
  delivered: boolean;
  error?: string;
}

/** 渠道无关发送器（server 集成注入 WeCom sink；测试用假发送器）。 */
export interface NotificationSink {
  send(notification: Notification): Promise<DeliveryReceipt>;
}

export interface RecordNotificationResult {
  notification: Notification;
  /** false = 同 (task_id, kind, state_version) 已存在：重复触发，未新增/未覆盖。 */
  created: boolean;
}

export type DeliveryOutcome = 'delivered' | 'retry_scheduled' | 'stopped' | 'skipped_not_due';

export interface DeliveryAttempt {
  notificationId: number;
  outcome: DeliveryOutcome;
  /** 本次尝试后（或跳过时当前）的 attempts。 */
  attempts: number;
  error?: string;
}

export interface NotificationOutboxOptions {
  /** 与任务底账同一 SQLite 库路径（本模块自建 notifications 表）。 */
  dbPath: string;
  sink: NotificationSink;
  /** attempts 上限（缺省 5）；到达即停止重试，未送达仍可查。 */
  maxAttempts?: number;
  /** 退避基数（毫秒；缺省 1000）。 */
  baseBackoffMs?: number;
  /** 退避封顶（毫秒；缺省 60000）——退避有界。 */
  maxBackoffMs?: number;
  /** 时钟注入（测试确定性用；缺省系统时钟）。 */
  now?: () => Date;
}

export interface NotificationOutbox {
  record(fact: NotificationFact): RecordNotificationResult;
  /**
   * 尝试投递所有未送达通知（同进程、串行化、有界）：
   *   · 未到退避时间 → skipped_not_due；attempts 已达上限 → stopped（不再调 sink）；
   *   · sink 返回/抛出失败 → 记 last_error，未达上限 retry_scheduled，达上限 stopped；
   *   · 成功 → 写 delivered_at、清 last_error。
   * sink 失败绝不逃逸（投递与事实解耦）；DB 错误才是异常。
   */
  deliverPending(): Promise<DeliveryAttempt[]>;
  /** 按任务（缺省全部）读通知，时间/id 升序。 */
  listNotifications(taskId?: string): Notification[];
  /** 未送达集合（含超限停止）；tasks/ops 可见。 */
  undelivered(taskId?: string): Notification[];
  close(): void;
}

/** 只读查询面（tasks/ops 只读打开；不写任何字节、不自建表）。 */
export interface NotificationReader {
  listNotifications(taskId?: string): Notification[];
  undelivered(taskId?: string): Notification[];
  close(): void;
}

/** 缺省 bounds（未在冻结契约中固定数值；可配置，语义不变）。 */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/** sink 返回未送达但未给原因的机械占位（不编造业务原因）。 */
const SINK_UNDELIVERED_ERROR = 'SINK_UNDELIVERED';

const FACT_KEYS: ReadonlySet<string> = new Set([
  'taskId',
  'kind',
  'at',
  'stateVersion',
  'taskNo',
  'name',
  'reason',
  'requestIds',
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (task_id, kind, state_version)
);
`;

const SELECT_COLUMNS =
  'id, task_id, kind, state_version, payload_json, created_at, delivered_at, attempts, last_error';

interface NotificationRow {
  id: number;
  task_id: string;
  kind: string;
  state_version: string;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
  attempts: number;
  last_error: string | null;
}

/**
 * 状态转移→通知意图（纯函数；契约 §4）。无法映射的过渡（cancelling/unexecuted 等
 * 过渡态与保留态）返回 undefined = 不产生通知；result_unknown 仍落 failed 状态，
 * 机械原因由 payload.reason 如实携带（不伪装成成功，也不额外造第十类意图）。
 */
export function notificationKindForTransition(
  from: TaskState | undefined,
  to: TaskState,
  reason?: NotificationReason,
): NotificationKind | undefined {
  if (reason === 'resource_limited') return 'resource_limited';
  if (reason === 'cancelled_by_user') return 'cancelled';
  if (reason === 'timeout') return 'timed_out';
  switch (to) {
    case 'queued':
      return 'accepted';
    case 'running':
      return from === 'waiting_user' ? 'resumed' : 'started';
    case 'waiting_user':
      return 'waiting_user';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    default:
      return undefined;
  }
}

function validateFact(fact: NotificationFact): void {
  for (const key of Object.keys(fact)) {
    if (!FACT_KEYS.has(key)) {
      throw new NotificationPayloadError(`通知事实含未知字段「${key}」：payload 仅允许来自底账事实的白名单字段。`);
    }
  }
  if (typeof fact.taskId !== 'string' || fact.taskId === '') {
    throw new NotificationPayloadError('通知事实缺少 taskId。');
  }
  if (!NOTIFICATION_KINDS.includes(fact.kind)) {
    throw new NotificationPayloadError('通知意图不是冻结的九类之一。');
  }
  if (typeof fact.at !== 'string' || fact.at === '') {
    throw new NotificationPayloadError('通知事实缺少时间 at（底账事实，不得缺省编造）。');
  }
  if (fact.stateVersion !== undefined) {
    const validNumber = typeof fact.stateVersion === 'number' && Number.isFinite(fact.stateVersion);
    const validString = typeof fact.stateVersion === 'string' && fact.stateVersion !== '';
    if (!validNumber && !validString) {
      throw new NotificationPayloadError('stateVersion 只能是有限数字或非空字符串。');
    }
  }
  if (fact.taskNo !== undefined && (!Number.isInteger(fact.taskNo) || fact.taskNo <= 0)) {
    throw new NotificationPayloadError('taskNo 必须是正整数（底账分配，不得编造）。');
  }
  if (fact.name !== undefined && (typeof fact.name !== 'string' || fact.name.trim() === '')) {
    throw new NotificationPayloadError('name 必须是非空字符串（底账业务名称）。');
  }
  if (fact.reason !== undefined && !NOTIFICATION_REASONS.includes(fact.reason)) {
    throw new NotificationPayloadError('reason 不是冻结的机械原因集合之一。');
  }
  if (
    fact.requestIds !== undefined
    && (!Array.isArray(fact.requestIds) || fact.requestIds.some((id) => typeof id !== 'string' || id === ''))
  ) {
    throw new NotificationPayloadError('requestIds 必须是非空字符串数组（仅追溯用）。');
  }
}

function buildPayload(fact: NotificationFact): NotificationPayload {
  return {
    at: fact.at,
    ...(fact.taskNo === undefined ? {} : { taskNo: fact.taskNo }),
    ...(fact.name === undefined ? {} : { name: fact.name }),
    ...(fact.reason === undefined ? {} : { reason: fact.reason }),
    ...(fact.requestIds === undefined ? {} : { requestIds: [...fact.requestIds] }),
  };
}

function toNotification(row: NotificationRow, maxAttempts: number): Notification {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as NotificationKind,
    stateVersion: row.state_version,
    payload: JSON.parse(row.payload_json) as NotificationPayload,
    createdAt: row.created_at,
    attempts: row.attempts,
    exhausted: row.delivered_at === null && row.attempts >= maxAttempts,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

/** 已发生 attempts 次尝试后的累计退避（attempts=0 立即到点；总退避有界）。 */
function cumulativeBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  let total = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) total += backoffDelayMs(attempt, baseMs, maxMs);
  return total;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} 必须是正整数。`);
  return value;
}

function queryRows(
  db: Database.Database,
  maxAttempts: number,
  taskId: string | undefined,
  onlyUndelivered: boolean,
): Notification[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (taskId !== undefined) {
    conditions.push('task_id = ?');
    params.push(taskId);
  }
  if (onlyUndelivered) conditions.push('delivered_at IS NULL');
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM notifications${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as NotificationRow[];
  return rows.map((row) => toNotification(row, maxAttempts));
}

export function createNotificationOutbox(options: NotificationOutboxOptions): NotificationOutbox {
  const { dbPath, sink } = options;
  const maxAttempts = requirePositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const baseBackoffMs = requirePositiveInteger(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, 'baseBackoffMs');
  const maxBackoffMs = requirePositiveInteger(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, 'maxBackoffMs');
  const now = options.now ?? (() => new Date());

  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertNotification = db.prepare(`
    INSERT OR IGNORE INTO notifications (task_id, kind, state_version, payload_json, created_at)
    VALUES (@taskId, @kind, @stateVersion, @payloadJson, @createdAt)
  `);
  const selectByKey = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM notifications WHERE task_id = ? AND kind = ? AND state_version = ?`,
  );
  const selectUndelivered = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM notifications WHERE delivered_at IS NULL ORDER BY created_at ASC, id ASC`,
  );
  const updateDelivered = db.prepare(
    'UPDATE notifications SET attempts = attempts + 1, delivered_at = @deliveredAt, last_error = NULL WHERE id = @id',
  );
  const updateFailed = db.prepare(
    'UPDATE notifications SET attempts = attempts + 1, last_error = @lastError WHERE id = @id',
  );

  /** 投递调用串行化：并发 deliverPending 不重复送达同一通知。 */
  let deliveryChain: Promise<unknown> = Promise.resolve();

  async function deliverOnce(): Promise<DeliveryAttempt[]> {
    const results: DeliveryAttempt[] = [];
    const nowIso = now().toISOString();
    const nowMs = Date.parse(nowIso);
    const rows = selectUndelivered.all() as NotificationRow[];
    for (const row of rows) {
      if (row.attempts >= maxAttempts) {
        results.push({
          notificationId: row.id,
          outcome: 'stopped',
          attempts: row.attempts,
          ...(row.last_error === null ? {} : { error: row.last_error }),
        });
        continue;
      }
      const dueAtMs = Date.parse(row.created_at) + cumulativeBackoffMs(row.attempts, baseBackoffMs, maxBackoffMs);
      if (nowMs < dueAtMs) {
        results.push({ notificationId: row.id, outcome: 'skipped_not_due', attempts: row.attempts });
        continue;
      }
      let receipt: DeliveryReceipt;
      try {
        receipt = await sink.send(toNotification(row, maxAttempts));
      } catch (error) {
        receipt = { delivered: false, error: error instanceof Error ? error.message : String(error) };
      }
      const nextAttempts = row.attempts + 1;
      if (receipt.delivered === true) {
        updateDelivered.run({ id: row.id, deliveredAt: nowIso });
        results.push({ notificationId: row.id, outcome: 'delivered', attempts: nextAttempts });
      } else {
        const error = typeof receipt.error === 'string' && receipt.error !== '' ? receipt.error : SINK_UNDELIVERED_ERROR;
        updateFailed.run({ id: row.id, lastError: error });
        results.push({
          notificationId: row.id,
          outcome: nextAttempts >= maxAttempts ? 'stopped' : 'retry_scheduled',
          attempts: nextAttempts,
          error,
        });
      }
    }
    return results;
  }

  return {
    record(fact) {
      validateFact(fact);
      const createdAt = now().toISOString();
      const stateVersion = String(fact.stateVersion ?? fact.at);
      const payload = buildPayload(fact);
      const info = insertNotification.run({
        taskId: fact.taskId,
        kind: fact.kind,
        stateVersion,
        payloadJson: JSON.stringify(payload),
        createdAt,
      });
      const row = selectByKey.get(fact.taskId, fact.kind, stateVersion) as NotificationRow;
      return { notification: toNotification(row, maxAttempts), created: info.changes === 1 };
    },
    deliverPending() {
      const run = deliveryChain.then(() => deliverOnce());
      deliveryChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    listNotifications(taskId) {
      return queryRows(db, maxAttempts, taskId, false);
    },
    undelivered(taskId) {
      return queryRows(db, maxAttempts, taskId, true);
    },
    close() {
      db.close();
    },
  };
}

/**
 * 只读查询面（tasks/ops / 后续只读工具）：库不存在或表未建给空集合，
 * 不建目录、不建表、不写字节（只读打开既有库）。
 */
export function createNotificationReader(
  dbPath: string,
  options: { maxAttempts?: number } = {},
): NotificationReader {
  const maxAttempts = requirePositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
  const db = existsSync(dbPath)
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : undefined;
  const hasTable =
    db !== undefined
    && db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get()
      !== undefined;
  return {
    listNotifications(taskId) {
      return hasTable ? queryRows(db as Database.Database, maxAttempts, taskId, false) : [];
    },
    undelivered(taskId) {
      return hasTable ? queryRows(db as Database.Database, maxAttempts, taskId, true) : [];
    },
    close() {
      db?.close();
    },
  };
}
