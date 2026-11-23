/**
 * 底账告警投影守卫（2026-11-23 零状态判负）：终止事件在 task_events 追加账，tasks 行没有
 * 任何终态列。`ledgerFacts` 若只把 `stored.task` 喂给唯一谓词，「已启动 + 无汇报 + 有终止
 * 事件（died/round_failed/cancelled/timed_out/resource_limited）」的任务仍会被投影成
 * `task_state: running`（等待形状残留则成 waiting_user），`task_stuck` 规则就会对已结束
 * 任务发假「卡住」告警（进程内周期扫描 + `npm run alerts` 共用本投影）。
 *
 * 反向绊线：把投影改回 `stillProgressingOf(stored.task)`（丢弃 terminations），本文件全红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore, type TaskTerminationKind } from '@fshine/core';
import { ledgerFacts } from './src/alert-persistence';

const NOW = '2026-11-23T00:00:00.000Z';
const LEASE_UNTIL = '2999-01-01T00:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alert-ledger-facts-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

/** 用 core 的写引擎落真实事实（与生产同 schema）：已启动任务 + 可选等待/终止事件。 */
function seed(
  dbPath: string,
  taskId: string,
  options: { termination?: TaskTerminationKind; waiting?: boolean } = {},
): void {
  const store = openTaskStore(dbPath);
  try {
    store.insertTask({
      taskId,
      principalId: 'wecom:fixture-user',
      sessionId: 'alert-ledger',
      request: `任务 ${taskId}`,
      runningSince: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (options.waiting === true) {
      store.setWaiting(taskId, { pendingQuestion: { missing: ['窗口'] }, waitingSince: NOW, updatedAt: NOW });
    }
    if (options.termination !== undefined) {
      // died 只允许写「仍在推进」的行；等待中的任务用 timed_out 表达「等待到期」。
      store.appendTermination({ taskId, kind: options.termination, at: NOW, updatedAt: NOW });
    }
  } finally {
    store.close();
  }
}

function taskStateFacts(dbPath: string): Array<Record<string, unknown>> {
  const { facts } = ledgerFacts(dbPath);
  return facts.filter((fact) => fact.event === 'task_state') as unknown as Array<Record<string, unknown>>;
}

describe('ledgerFacts：终止事件在场 = 已结束，不投影成 running/waiting', () => {
  it('正例：已启动、无汇报、无终止事件 → 投影 task_state=running', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_running');
    const facts = taskStateFacts(dbPath);
    expect(facts).toHaveLength(1);
    expect(facts[0]!['detail']).toEqual({ taskStatus: 'running' });
  });

  it.each(['died', 'round_failed', 'cancelled', 'timed_out', 'resource_limited'] as const)(
    '终止事件 %s → 不再投影任何 task_state（已结束不翻案）',
    (kind) => {
      const dbPath = tempDbPath();
      seed(dbPath, `task_${kind}`, { termination: kind });
      expect(taskStateFacts(dbPath)).toEqual([]);
    },
  );

  it('等待形状 + 终止事件（等待到期 = timed_out）→ 不再投影 waiting_user', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_waiting_ended', { waiting: true, termination: 'timed_out' });
    expect(taskStateFacts(dbPath)).toEqual([]);
  });
});
