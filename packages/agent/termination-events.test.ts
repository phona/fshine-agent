/**
 * 「这一轮在 T 停下」= 一条追加事实（owner 2026-11-23），不是可变状态列，也**没有种类**。
 *
 * 停下时写一条 task_ends 事实（task_id + at），复用现有 emit / onTaskFact / outbox 链路；
 * 事实不可变、重启后仍在。怎么结束不存：cancelled/timed_out/resource_limited/lease-expired/
 * no-report 都只留下同一个「停下时刻」，消费方读汇报/执行行/活 worker 自己算。
 * 本测试同时钉住：
 *   · 结束事实一次性（同任务至多一条，后到的写不覆盖）；
 *   · `emit` 只在该事实**首次**落库时发一次（不重复打扰；事件词是「发生了什么」的通道词）；
 *   · SQLite 重启后 endedAt 可读回，tasks 表无终态列。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-ended-facts-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'p', sessionId: 's' } as const;

describe('结束事实（内存 registry）', () => {
  it('每种停法都只写一条「停下时刻」，不写种类', () => {
    const cases = [
      ['user_stop', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markCancelled(id)],
      ['deadline_reached', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markTimedOut(id, 'execution')],
      ['capacity_blocked', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.noteResourceRefused(id)],
      ['ended', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markLeaseExpired(id)],
      ['ended', (r: ReturnType<typeof createTaskRegistry>, id: string) => { r.noteRoundEnded(id); return r.get(id); }],
      ['result_archived', (r: ReturnType<typeof createTaskRegistry>, id: string) => { r.archiveReply([id], '办完了。'); return r.get(id); }],
    ] as const;
    for (const [event, apply] of cases) {
      const registry = createTaskRegistry();
      const facts: string[] = [];
      registry.onTaskFact((fact) => facts.push(fact.event));
      registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
      facts.length = 0;
      const task = apply(registry, 't1');
      expect(task.endedAt, event).toBeTruthy();
      expect(facts, event).toEqual([event]);
      expect('termination' in task, event).toBe(false);
    }
  });

  it('一次性 + 不可变：后到的停法不覆盖第一条，事实事件只发一次', () => {
    const registry = createTaskRegistry();
    const facts: string[] = [];
    registry.onTaskFact((fact) => facts.push(fact.event));
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.markCancelled('t1');
    const firstAt = registry.get('t1').endedAt;
    registry.markCancelled('t1');
    registry.markLeaseExpired('t1');
    registry.markTimedOut('t1', 'execution');
    registry.noteRoundEnded('t1');
    expect(registry.get('t1').endedAt).toBe(firstAt);
    // 只算结束事实事件（begin 的 accepted 也在，但结束事件至多一次）。
    const terminal = facts.filter((event) => ['user_stop', 'ended', 'deadline_reached', 'capacity_blocked', 'result_archived'].includes(event));
    expect(terminal).toEqual(['user_stop']);
  });

  it('已汇报后再落停法：结束时刻不变，汇报事实保留（不翻案）', () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.archiveReply(['t1'], '办完了。');
    const at = registry.get('t1').endedAt;
    expect(at).toBeTruthy();
    registry.markCancelled('t1');
    expect(registry.get('t1').endedAt).toBe(at);
    expect(registry.get('t1').replyText).toBe('办完了。');
  });
});

describe('结束事实（SQLite registry）：重启后仍在', () => {
  it('写结束事实 → 关闭 → 重新打开（只读）endedAt 原样可读；tasks 表无终态列', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.noteResourceRefused('t1');
    const at = registry.get('t1').endedAt;
    expect(at).toBeTruthy();
    registry.close();

    const reopened = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(reopened.get('t1').endedAt).toBe(at);
    expect(reopened.get('t1').resultText).toBeUndefined();
    reopened.close();

    // tasks 行没有终态列（事实账独立）。
    const columns = dbAccessColumns(dbPath, 'tasks');
    for (const forbidden of ['died_at', 'cancelled_at', 'timed_out_at', 'resource_limited_at', 'round_failed_at', 'status']) {
      expect(columns).not.toContain(forbidden);
    }
    expect(dbAccessColumns(dbPath, 'task_ends').sort()).toEqual(['at', 'task_id']);
  });

  it('重复停法只落一条（事实账一次性），跨重启不追加', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.markCancelled('t1');
    const at = registry.get('t1').endedAt;
    registry.markCancelled('t1');
    registry.markLeaseExpired('t1');
    registry.close();
    const reopened = createSqliteTaskRegistry(dbPath);
    expect(reopened.get('t1').endedAt).toBe(at);
    reopened.markTimedOut('t1', 'execution');
    expect(reopened.get('t1').endedAt).toBe(at);
    reopened.close();
  });
});

/** 只读列清单（测试自用；不引第二套存储实现）。 */
function dbAccessColumns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}
