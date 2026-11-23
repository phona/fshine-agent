/**
 * 告警的**确定性投影与持久化核心**（无时钟、无网络、无 WS；纯函数 + 本地文件）。
 *
 * 为什么单独成模块：两份执行者都要落同一个 `.runtime/ops/alerts.jsonl` 与冷却文件、都要
 * 把结构化事件 / 底账行投影成 AlertFact、都要把命中项序列化成同一种自包含行——
 *   · `scripts/ops/alerts.ts`（手动 / 离线诊断，进程外读日志 + 只读底账）；
 *   · `apps/server` 的进程内告警引擎（事件驱动就地判 + 低频聚合扫描）。
 * 共享这一层，规则仍是 `alert-rules.ts` 的 `evaluateAlerts` 单源，不写第二套规则、不另开
 * 企微 WS（推送出口各自持有：脚本用 SDK，server 用自己既有的投递端口）。
 *
 * 硬边界（沿用 ops/alerts 纪律）：**绝不改任务事实、绝不写 state.db、绝不重启服务**。
 * state.db 一律只读打开投影；本模块只写 `.runtime/ops/` 下的告警产物（jsonl / 冷却 / evidence）。
 *
 * 行格式（v:1，自包含，供人和后续 AI 消费）：
 *   { v:1, id, rule, severity, subject, evidenceRef, summary, raw(全文), at, taskId?, evidencePath? }
 * `raw` 不截断；超长时另落 evidence/<id>.txt 并在行里给 evidencePath（raw 仍保留全文）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openTaskStore, stillProgressingOf, storedTaskProgressOf, taskEndedOf } from '@fshine/core';
import {
  evaluateAlerts,
  type AlertCooldownState,
  type AlertFact,
  type AlertItem,
} from './alert-rules';

/** raw 内联上限（字节）：超过时另落证据文件，但 raw 字段仍保留全文、绝不截断。 */
export const EVIDENCE_INLINE_LIMIT_BYTES = 8192;

/** 冷却状态文件 schema（与手动脚本同 schema，共享可减重复但不强一致）。 */
export interface AlertsState {
  version: 1;
  /** 进程外脚本的日志增量偏移（进程内引擎不消费，读回时原样保留）。 */
  logOffset: number;
  /** 冷却状态：`${rule}\u0000${subject}` → 上次告警时刻（ISO）。 */
  cooldown: AlertCooldownState;
}

export function emptyAlertsState(): AlertsState {
  return { version: 1, logOffset: 0, cooldown: {} };
}

/** 解析冷却状态文件；缺文件 / 坏 JSON 退回空状态（不猜、不抛）。 */
export function parseAlertsState(raw: string | undefined): AlertsState {
  if (raw === undefined || raw.trim() === '') return emptyAlertsState();
  try {
    const parsed = JSON.parse(raw) as Partial<AlertsState>;
    return {
      version: 1,
      logOffset: typeof parsed.logOffset === 'number' && parsed.logOffset >= 0 ? parsed.logOffset : 0,
      cooldown: parsed.cooldown !== null && typeof parsed.cooldown === 'object'
        ? (parsed.cooldown as AlertCooldownState)
        : {},
    };
  } catch {
    return emptyAlertsState();
  }
}

/** 读冷却状态文件（不存在 = 空状态）。 */
export function readAlertsState(statePath: string): AlertsState {
  return parseAlertsState(existsSync(statePath) ? readFileSync(statePath, 'utf8') : undefined);
}

/** 写冷却状态文件（原子性由单进程串行保证；两执行者共享文件，非强一致）。 */
export function writeAlertsState(statePath: string, state: AlertsState): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 持久化行（v:1 自包含结构化 JSON，供 AI / 人消费）。 */
export interface AlertLine extends AlertItem {
  v: 1;
  id: string;
  evidencePath?: string;
}

/**
 * 把一条命中项序列化为落盘行；超长原文另落证据文件（raw 仍保留全文）。
 * `v:1` 只在这里落一次——脚本与进程内引擎共用本函数，格式单源。
 */
export function buildAlertLine(item: AlertItem, id: string, opsDir: string): { line: AlertLine; evidenceWritten?: string } {
  const base: AlertLine = { v: 1, ...item, id };
  const bytes = Buffer.byteLength(item.raw, 'utf8');
  if (bytes <= EVIDENCE_INLINE_LIMIT_BYTES) return { line: base };
  const evidenceDir = path.join(opsDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${id}.txt`);
  writeFileSync(evidencePath, item.raw, 'utf8');
  return { line: { ...base, evidencePath }, evidenceWritten: evidencePath };
}

/** 追加若干告警行到 jsonl（一次 open；目录不存在则建）。 */
export function appendAlertLines(jsonlPath: string, lines: readonly AlertLine[]): void {
  if (lines.length === 0) return;
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

/**
 * 判定 + 持久化一步（两份执行者共用，避免冷却/格式漂移）：
 *   · 读既有冷却状态 → evaluateAlerts（冷却过滤）→ 命中项落 jsonl → 回写冷却状态（保留 logOffset）；
 *   · 推送出口不在这里——调用方各自持有（脚本 SDK / server 投递端口）。
 * 返回落盘行供调用方拼推送文案；无命中时不写任何文件、不改冷却状态。
 */
export function evaluateAndPersistAlerts(
  facts: readonly AlertFact[],
  deps: {
    now: Date;
    statePath: string;
    jsonlPath: string;
    opsDir: string;
    idPrefix?: string;
    cooldownMs?: number;
  },
): { alerts: AlertItem[]; lines: AlertLine[]; state: AlertsState } {
  const state = readAlertsState(deps.statePath);
  const result = evaluateAlerts(facts, {
    now: deps.now,
    cooldownState: state.cooldown,
    ...(deps.cooldownMs === undefined ? {} : { cooldownMs: deps.cooldownMs }),
  });
  const nextState: AlertsState = { ...state, cooldown: result.cooldownState };
  if (result.alerts.length === 0) return { alerts: [], lines: [], state: nextState };

  const prefix = deps.idPrefix ?? 'alert';
  const lines = result.alerts.map((item, index) =>
    buildAlertLine(item, `${deps.now.getTime()}-${index}-${prefix}-${item.rule}`, deps.opsDir).line,
  );
  appendAlertLines(deps.jsonlPath, lines);
  writeAlertsState(deps.statePath, nextState);
  return { alerts: result.alerts, lines, state: nextState };
}

/** 从一条结构化事件行投影出事实；非结构化行 / 无事件名返回 undefined。 */
export function logLineToFact(line: string, logOffset: number, nowIso: string): AlertFact | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const event = obj['event'];
  if (typeof event !== 'string' || event === '') return undefined;

  const detail: NonNullable<AlertFact['detail']> = {};
  if (typeof obj['operation'] === 'string') detail.operation = obj['operation'];
  const error = obj['error'];
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const err = error as Record<string, unknown>;
    if (typeof err['code'] === 'string') detail.errorCode = err['code'];
    if (typeof err['kind'] === 'string') detail.failureKind = err['kind'];
  }
  if (typeof obj['failureKind'] === 'string') detail.failureKind = obj['failureKind'];
  if (event === 'file_delivery' && typeof obj['status'] === 'string') detail.deliveryStatus = obj['status'];
  // 投递结果（第 3 档接线）：notification_delivery_terminal 的 exhausted/skipped、
  // task_long_running_notice 的 sent/failed——判据只在 isDeliveryFailure 里，不在这里猜。
  if (typeof obj['result'] === 'string') detail.deliveryResult = obj['result'];
  // 部署模式事实（跳过终局随带）：live + skipped 要告警（渠道配错）——判据只在
  // isDeliveryFailure，不在这里猜（2026-11-19 delivery-truth 并集补）。
  if (typeof obj['deliveryMode'] === 'string') detail.deliveryMode = obj['deliveryMode'];
  if (typeof obj['taskStatus'] === 'string') detail.taskStatus = obj['taskStatus'];
  if (typeof obj['taskState'] === 'string') detail.taskStatus = obj['taskState'];
  // 协议违约 / 确认句柄丢失的显式标记（执行层事件形状）。
  if (obj['protocolViolation'] === true) detail.protocolViolation = true;
  if (obj['confirmationLost'] === true) detail.confirmationLost = true;

  const fact: AlertFact = {
    source: 'log',
    event,
    // 结构化行普遍不带时间戳：事实时刻取处理时刻（task_stuck 只走底账，不依赖此值）。
    at: typeof obj['at'] === 'string' ? obj['at'] : nowIso,
    raw: line,
    logOffset,
  };
  if (typeof obj['taskId'] === 'string') fact.taskId = obj['taskId'];
  if (typeof obj['principalId'] === 'string') fact.principalId = obj['principalId'];
  if (typeof obj['sessionId'] === 'string') fact.sessionId = obj['sessionId'];
  if (typeof obj['messageId'] === 'string') fact.messageId = obj['messageId'];
  if (typeof obj['evidenceRef'] === 'string') fact.evidenceRef = obj['evidenceRef'];
  if (Object.keys(detail).length > 0) fact.detail = detail;
  return fact;
}

/** 把任务/执行底账行投影成事实（只读，绝不写）。聚合规则（retry_storm / task_stuck）的来源。 */
export function ledgerFacts(dbPath: string): { facts: AlertFact[]; note?: string } {
  if (!existsSync(dbPath)) return { facts: [], note: `底账不存在，跳过：${dbPath}` };
  let store;
  try {
    store = openTaskStore(dbPath, { readOnly: true });
  } catch (error) {
    return { facts: [], note: `底账只读打开失败，跳过：${error instanceof Error ? error.message : String(error)}` };
  }
  const facts: AlertFact[] = [];
  try {
    for (const stored of store.listTasks()) {
      const task = stored.task;
      const at = task.updatedAt;
      // 读取单位投影：终止事件在 task_events 追加账（tasks 行没有终态列）——只取
      // stored.task 会把已终止的行仍当 running/waiting 投影，task_stuck 会对已结束任务发假告警。
      const progress = storedTaskProgressOf(stored);
      const ended = taskEndedOf(progress);
      // 在跑/等待事实（S1 事实模型：没有 status 列——等待形状与唯一谓词即事实）。
      const waiting = !ended && task.pendingQuestion !== undefined;
      // 已汇报 / 终止事件的行已收尾，不再投影成 running（唯一谓词，与扫描面同口径）。
      const running = stillProgressingOf(progress);
      if (running || waiting) {
        const since = waiting
          ? (task.waitingSince ?? task.updatedAt)
          : (task.runningSince ?? task.updatedAt);
        facts.push({
          source: 'ledger',
          event: 'task_state',
          at: since,
          raw: JSON.stringify(task),
          taskId: task.taskId,
          principalId: task.principalId,
          sessionId: task.sessionId,
          evidenceRef: `task:${task.taskId}`,
          detail: { taskStatus: waiting ? 'waiting_user' : 'running' },
        });
      }
      for (const execution of stored.executions) {
        const detail: NonNullable<AlertFact['detail']> = {
          operation: execution.operation,
          // 结局状态进投影：retry_storm 的 (operation, 错误码) 计数只认失败类结局。
          status: execution.status,
        };
        const err = execution.error;
        if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
          const e = err as Record<string, unknown>;
          if (typeof e['code'] === 'string') detail.errorCode = e['code'];
        }
        facts.push({
          source: 'ledger',
          event: 'execution',
          at,
          raw: JSON.stringify(execution),
          taskId: task.taskId,
          principalId: task.principalId,
          sessionId: task.sessionId,
          evidenceRef: `task:${task.taskId}`,
          detail,
        });
      }
    }
  } finally {
    store.close();
  }
  return { facts };
}
