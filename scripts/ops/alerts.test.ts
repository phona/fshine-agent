/**
 * ops/alerts 的**上游接线**（2026-11-19 第 3 档补口，确定性）：
 * 「兜不住、用户也做不了什么」这一类不许断了归宿——投递终局与长活提醒投递失败必须**真的**
 * 能被告警面看见。判据链 = **真生产者**（outbox 的终局事件 / 真 runner 的提醒事件）→
 * `logLineToFact`（真投影）→ `evaluateAlerts`（真规则，既有 delivery_failed 形状）。
 *
 * 反向绊线（已实测会红，随后还原）：
 *   ① 去掉 outbox 的 `onTerminal` 调用 → 「通知投递终局」用例红（没有事件行 → 没有告警）；
 *   ② 去掉 `isDeliveryFailure` 里的 `notification_delivery_terminal` / `task_long_running_notice`
 *      判据 → 两条命中用例红。
 *
 * 不新建告警机制：只落一条既有形状的结构化事件 + 既有规则接住它（同四条规则的写法）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAlerts, type AlertItem } from '../../packages/agent/src/alert-rules';
import { createNotificationOutbox } from '../../packages/agent/src/notifications';
import { createResourcePolicy } from '../../packages/agent/src/resource-policy';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import {
  createTaskRunner,
  type LongRunningNoticePort,
  type TaskExecutionInput,
  type TaskExecutionOutcome,
  type TaskExecutor,
} from '../../packages/agent/src/task-runner';
import { notificationTerminalLogLine } from '../../apps/server/notification-chat-sink';
import { logLineToFact } from './alerts';

const NOW_ISO = '2026-11-19T12:00:00.000Z';
const NOW = new Date(NOW_ISO);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-alerts-wiring-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

/** 结构化日志行（生产写的就是一行一个 JSON）→ 告警项：走**真实**投影 + 规则。 */
function alertsOf(lines: readonly Record<string, unknown>[]): AlertItem[] {
  const facts = lines
    .map((line, index) => logLineToFact(JSON.stringify(line), index, NOW_ISO))
    .filter((fact) => fact !== undefined);
  return evaluateAlerts(facts, { now: NOW }).alerts;
}

describe('投递终局的上帝视角：既有 delivery_failed 规则看得见（第 3 档归宿）', () => {
  it('通知投递失败到 attempts 上限（exhausted）→ 告警面收到一条 critical；终态跳过不告警', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const outbox = createNotificationOutbox({
      dbPath: tempDbPath(),
      // 渠道一直不可用 = 用户最终收不到这条通知。
      sink: { async send() { return { delivered: false, error: '渠道不可用' }; } },
      maxAttempts: 2,
      baseBackoffMs: 1,
      maxBackoffMs: 1,
      // 与 server 装配同一接线（事件形状单源）。
      onTerminal: (terminal) => lines.push(notificationTerminalLogLine(terminal)),
    });
    try {
      outbox.record({ taskId: 'task-alert-exhausted', kind: 'waiting_user', at: NOW_ISO });
      await outbox.deliverPending();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await outbox.deliverPending();

      const alerts = alertsOf(lines);
      expect(alerts.map((alert) => alert.rule)).toEqual(['delivery_failed']);
      expect(alerts[0]!.severity).toBe('critical');
      expect(alerts[0]!.subject).toBe('task:task-alert-exhausted');
      // 证据可回溯：告警项带原始事件原文（含 taskId/result）。
      expect(alerts[0]!.raw).toContain('task-alert-exhausted');
      expect(alerts[0]!.raw).toContain('"result":"exhausted"');
    } finally {
      outbox.close();
    }
  });

  it('终态跳过（skipped）不告警：没有东西可发 / 永不可能送达，开发也做不了什么', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const outbox = createNotificationOutbox({
      dbPath: tempDbPath(),
      sink: { async send() { return { delivered: false, skipped: 'delivery_unavailable' }; } },
      maxAttempts: 2,
      onTerminal: (terminal) => lines.push(notificationTerminalLogLine(terminal)),
    });
    try {
      outbox.record({ taskId: 'task-alert-skipped', kind: 'timed_out', at: NOW_ISO });
      await outbox.deliverPending();
      expect(lines).toHaveLength(1); // 事件照落（如实留痕）
      expect(alertsOf(lines)).toEqual([]); // 但不进告警面（静默部署上每条都 skipped）
    } finally {
      outbox.close();
    }
  });

  it('长活提醒投递两次都失败（result=failed）→ 告警面收到一条 critical', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const dbPath = tempDbPath();
    const registry = createSqliteTaskRegistry(dbPath);
    try {
      // 造一条 running 行（10 分钟前开始）——提醒扫描的唯一判据来源。
      const startedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
      registry.begin({ taskId: 'task-alert-notice', principalId: 'wecom:owner', sessionId: 'wecom:conv-owner', request: '查一下' });
      registry.store.applyTaskState('task-alert-notice', {
        expectedStatus: 'running',
        status: 'running',
        leaseOwner: 'task-runner',
        leaseUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
        updatedAt: startedAt,
      });
      const failingPort: LongRunningNoticePort = {
        // 渠道故障：两次尝试都送不出去（runner 同一档内重试一次，见 deliverNotice）。
        async sendNotice() { return false; },
      };
      const idleExecutor: TaskExecutor = {
        execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
          return new Promise<TaskExecutionOutcome>(() => { /* 刻意不落定：提醒判据只看底账行 */ });
        },
      };
      const runner = createTaskRunner({
        registry,
        policy: createResourcePolicy(),
        executor: idleExecutor,
        now: () => NOW,
        // 不真起定时器：本用例只手动 pump 一次。
        timers: { set: () => 0, clear: () => {} },
        leaseMs: 3_600_000,
        longRunningNoticeMs: 60_000,
        longRunningNotice: failingPort,
        log: (line) => lines.push(line),
      });
      runner.pump();
      await runner.whenIdle();

      // 事件逐次留痕（首投 + 一次重试），且**真的**进了告警面。
      expect(lines.filter((line) => line['event'] === 'task_long_running_notice').map((line) => line['result']))
        .toEqual(['failed', 'failed']);
      const alerts = alertsOf(lines);
      expect(alerts.map((alert) => alert.rule)).toEqual(['delivery_failed']);
      expect(alerts[0]!.severity).toBe('critical');
      expect(alerts[0]!.raw).toContain('task-alert-notice');
    } finally {
      registry.close();
    }
  });
});
