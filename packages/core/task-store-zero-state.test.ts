/**
 * 零状态守卫（owner 2026-11-23）：tasks 表不存任何「怎么结束」的可变状态列。
 *
 * 只存事实：
 *   · started_at（running_since）= 这一轮何时启动（区分排队 vs 已开始）；
 *   · reply_text / result_text = worker/Main 汇报；
 *   · pending_question + waiting_since = 等待形状；
 *   · lease_* = 在跑凭据；long_running_notified_at 等 = 提醒一次性事实。
 * 「活/结束」由事实现推（启动 + 汇报 + 等待 + 进程内活 worker）；结束后只留一条「这一轮
 * 在 T 停下」的机械事实（task_ends，task_id + at）——**没有 kind**，怎么结束不存。
 *
 * 本文件是**结构性判据**（不是名列表）：tasks 表的任何列不得以 `_at` 结尾的终态形状出现
 * （died/cancelled/timed_out/resource_limited/round_failed/cancel_requested），也不得有
 * status/reason/liveness 这类结论/状态列。反向绊线：把终态列塞进列清单，断言必须报红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from './src/task-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-zero-state-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 允许的 `_at` 事实列（提醒/审计时刻）；其余任何 `_at` 列都视为终态/状态列（含 completed_at）。 */
const ALLOWED_AT_COLUMNS = new Set([
  'created_at',
  'updated_at',
  'long_running_notified_at',
  'wait_contact_lost_notified_at',
]);

/** 结构性判据：列清单里不得有任何终态/结论列（纯函数，便于反向绊线直测）。 */
function assertZeroStateColumns(columns: readonly string[]): void {
  const forbidden = columns.filter(
    (column) => (column.endsWith('_at') && !ALLOWED_AT_COLUMNS.has(column))
      || column === 'status'
      || column === 'reason'
      || column === 'failure_reason'
      || column === 'liveness',
  );
  if (forbidden.length > 0) {
    throw new Error(`tasks 表出现可变状态列：${forbidden.join(', ')}（零状态只允许事实列）。`);
  }
}

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}

function seedTask(store: ReturnType<typeof openTaskStore>, taskId: string): void {
  store.insertTask({
    taskId,
    principalId: 'wecom:fixture-user',
    sessionId: 'zero-state',
    request: `任务 ${taskId}`,
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
  });
}

describe('零状态：tasks 表只存事实', () => {
  it('新建库：无终态列 / 无 status / 无 liveness；running_since 与汇报/等待/租约事实在', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const store = openTaskStore(dbPath);
    store.close();

    const columns = columnNames(dbPath, 'tasks');
    assertZeroStateColumns(columns);
    expect(columns).toEqual(expect.arrayContaining([
      'running_since',
      'reply_text',
      'result_text',
      'pending_question',
      'waiting_since',
      'lease_owner',
      'lease_until',
    ]));
    for (const forbidden of [
      'died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at',
      'round_failed_at', 'cancel_requested_at', 'completed_at', 'status',
    ]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('结束事实只留时刻：task_ends 存在（无 kind）、一次性（同任务至多一条）、只读重开仍在', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const store = openTaskStore(dbPath);
    seedTask(store, 'task_a');

    expect(store.appendEndFact({
      taskId: 'task_a', at: '2026-11-23T00:01:00.000Z', updatedAt: '2026-11-23T00:01:00.000Z',
    })).toBe(true);
    // 一次性事实：第二次结束不覆盖、不追加。
    expect(store.appendEndFact({
      taskId: 'task_a', at: '2026-11-23T00:02:00.000Z', updatedAt: '2026-11-23T00:02:00.000Z',
    })).toBe(false);
    expect(store.listEndFacts('task_a')).toEqual([
      { taskId: 'task_a', at: '2026-11-23T00:01:00.000Z' },
    ]);
    store.close();

    // task_ends 只有 task_id + at（没有 kind/state_version）。
    expect(columnNames(dbPath, 'task_ends').sort()).toEqual(['at', 'task_id']);
    expect(columnNames(dbPath, 'task_events')).toEqual([]);

    // 重启后仍在（追加事实不改写、不丢）。
    const reopened = openTaskStore(dbPath);
    expect(reopened.listEndFacts('task_a')).toEqual([
      { taskId: 'task_a', at: '2026-11-23T00:01:00.000Z' },
    ]);
    // 事实写入不出现在 tasks 行上。
    const row = reopened.getTask('task_a')!.task;
    assertZeroStateColumns(Object.keys(row));
    expect(Object.keys(row)).not.toContain('diedAt');
    reopened.close();
  });

  it('反向绊线：往列清单塞回任一终态列 / 状态列，结构性判据必须报红', () => {
    expect(() => assertZeroStateColumns(['task_id', 'running_since', 'died_at'])).toThrow(/died_at/);
    expect(() => assertZeroStateColumns(['task_id', 'cancelled_at'])).toThrow(/cancelled_at/);
    expect(() => assertZeroStateColumns(['task_id', 'timed_out_at'])).toThrow(/timed_out_at/);
    expect(() => assertZeroStateColumns(['task_id', 'resource_limited_at'])).toThrow(/resource_limited_at/);
    expect(() => assertZeroStateColumns(['task_id', 'round_failed_at'])).toThrow(/round_failed_at/);
    expect(() => assertZeroStateColumns(['task_id', 'cancel_requested_at'])).toThrow(/cancel_requested_at/);
    expect(() => assertZeroStateColumns(['task_id', 'completed_at'])).toThrow(/completed_at/);
    expect(() => assertZeroStateColumns(['task_id', 'status'])).toThrow(/status/);
    expect(() => assertZeroStateColumns(['task_id', 'liveness'])).toThrow(/liveness/);
    // 事实列本身不误伤。
    expect(() => assertZeroStateColumns([
      'task_id', 'running_since', 'reply_text', 'result_text', 'pending_question',
      'waiting_since', 'lease_owner', 'lease_until',
    ])).not.toThrow();
  });
});
