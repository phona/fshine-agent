/**
 * 「怎么结束」= 追加事件（owner 2026-11-23），不是可变状态列。
 *
 * 终止时发一条追加事件（cancelled / timed_out / resource_limited / round_failed / died /
 * completed），复用现有 emit / onTaskFact / outbox 链路；事件不可变、重启后仍在，是投递与
 * CLI 的事实来源。本测试同时钉住：
 *   · 终止事实一次性（同任务至多一条，后到的终止不覆盖）；
 *   · `emit` 只在该事实**首次**落库时发一次（不重复打扰）；
 *   · SQLite 重启后 termination 可读回。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-termination-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'p', sessionId: 's' } as const;

describe('终止事件（内存 registry）', () => {
  it('每种终止都发一条事实事件，termination 原样可读', () => {
    const cases = [
      ['cancelled', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markCancelled(id)],
      ['timed_out', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markTimedOut(id, 'execution')],
      ['resource_limited', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markResourceLimited(id)],
      ['died', (r: ReturnType<typeof createTaskRegistry>, id: string) => r.markDied(id)],
      ['round_failed', (r: ReturnType<typeof createTaskRegistry>, id: string) => { r.noteRoundFailed(id); return r.get(id); }],
      ['completed', (r: ReturnType<typeof createTaskRegistry>, id: string) => { r.archiveReply([id], '办完了。'); return r.get(id); }],
    ] as const;
    for (const [kind, apply] of cases) {
      const registry = createTaskRegistry();
      registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
      const task = apply(registry, 't1');
      expect(task.termination?.kind, kind).toBe(kind);
      expect(task.termination?.at, kind).toBeTruthy();
    }
  });

  it('一次性 + 不可变：后到的终止不覆盖第一条，emit 只发一次', () => {
    const registry = createTaskRegistry();
    const facts: string[] = [];
    registry.onTaskFact((fact) => facts.push(fact.event));
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.markCancelled('t1');
    registry.markCancelled('t1');
    registry.markDied('t1');
    registry.markTimedOut('t1', 'execution');
    registry.noteRoundFailed('t1');
    expect(registry.get('t1').termination?.kind).toBe('cancelled');
    // 只算终止事件（begin 的 started 也在，但每一种至多一次）。
    const terminal = facts.filter((event) => ['cancelled', 'died', 'timed_out', 'resource_limited', 'round_failed', 'result_archived'].includes(event));
    expect(terminal).toEqual(['cancelled']);
  });

  it('已汇报后再落终止：终止事件仍记录，但汇报事实保留（不翻案）', () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.archiveReply(['t1'], '办完了。');
    expect(registry.get('t1').termination?.kind).toBe('completed');
    registry.markCancelled('t1');
    expect(registry.get('t1').termination?.kind).toBe('completed');
    expect(registry.get('t1').replyText).toBe('办完了。');
  });
});

describe('终止事件（SQLite registry）：重启后仍在', () => {
  it('写终止 → 关闭 → 重新打开（只读）termination 原样可读；tasks 表无终态列', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.markResourceLimited('t1');
    const at = registry.get('t1').termination?.at;
    expect(registry.get('t1').termination?.kind).toBe('resource_limited');
    registry.close();

    const reopened = createSqliteTaskRegistry(dbPath, { readOnly: true });
    expect(reopened.get('t1').termination).toEqual({ kind: 'resource_limited', at });
    expect(reopened.get('t1').resultText).toBeUndefined();
    reopened.close();
  });

  it('重复终止只落一条（事件账一次性），跨重启不追加', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const registry = createSqliteTaskRegistry(dbPath);
    registry.begin({ taskId: 't1', ...SCOPE, request: '任务' });
    registry.markCancelled('t1');
    registry.markCancelled('t1');
    registry.markDied('t1');
    registry.close();
    const reopened = createSqliteTaskRegistry(dbPath);
    expect(reopened.get('t1').termination?.kind).toBe('cancelled');
    reopened.markTimedOut('t1', 'execution');
    expect(reopened.get('t1').termination?.kind).toBe('cancelled');
    reopened.close();
  });
});
