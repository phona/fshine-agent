/**
 * 采集映射的行为绊线（2026-11-24 grok blocking）。
 *
 * 缺陷形态：底账终局事件改名（cancelled/timed_out/resource_limited → user_stop/
 * deadline_reached/capacity_blocked）后，business-e2e 采集侧两份「事件 → 事实增量」表都没跟上；
 * 未知事件走 `?? {}` 回落成 `ended:false`，于是取消、到点、容量拒绝都被采集成「还没结束」，
 * d6 的活跃峰值虚高（`peakFromTaskFacts` 只认 ended 进出活跃集），而 d6 单测自己手写
 * ended:true、不经过这条映射，门禁可以全绿。
 *
 * 本测试**走产品真链路**（createSqliteTaskRegistry → markCancelled / markTimedOut /
 * noteResourceRefused → onTaskFact 钩子 → taskFactLineOf），不手写任何 ended 值：
 * 只要底账再改事件名而映射没跟上，这里立刻红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import type { TaskFactLine } from './collect';
import { isNotificationFact, notificationLineOf, TASK_FACT_EVENTS, taskFactLineOf } from './task-facts-collect';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registryWith(dbPath: string): ReturnType<typeof createSqliteTaskRegistry> {
  return createSqliteTaskRegistry(dbPath);
}

const SCOPE = { principalId: 'p', sessionId: 's' } as const;

describe('底账终局事实 → 采集行（task-facts-collect）', () => {
  it('三种停法都投影成 ended:true（取消/到点/容量拒绝不再是「还没结束」）', () => {
    const stops = [
      ['user_stop', (r: ReturnType<typeof registryWith>, id: string) => r.markCancelled(id)],
      ['deadline_reached', (r: ReturnType<typeof registryWith>, id: string) => r.markTimedOut(id, 'execution')],
      ['capacity_blocked', (r: ReturnType<typeof registryWith>, id: string) => r.noteResourceRefused(id)],
    ] as const;
    for (const [event, stop] of stops) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'task-facts-collect-'));
      dirs.push(dir);
      const registry = registryWith(path.join(dir, 'state.db'));
      const lines: TaskFactLine[] = [];
      registry.onTaskFact((fact) => lines.push(taskFactLineOf(fact)));
      registry.begin({ taskId: 't1', ...SCOPE, request: '核对单据' });
      lines.length = 0;
      stop(registry, 't1');
      expect(lines.map((line) => line.ended), event).toEqual([true]);
      expect(lines[0]!.taskId, event).toBe('t1');
    }
  });

  it('等待与汇报投影不回归（waiting_user / result_archived）', () => {
    expect(TASK_FACT_EVENTS.waiting_user).toMatchObject({ waiting: true, mayBeRunning: false });
    expect(TASK_FACT_EVENTS.result_archived).toMatchObject({ ended: true, reported: true });
    // 反绊线：ended 事件不得被误投影成 waiting（会把「已停」采成「还在等用户」）。
    for (const event of ['user_stop', 'deadline_reached', 'capacity_blocked', 'ended'] as const) {
      expect(TASK_FACT_EVENTS[event].waiting, event).toBeUndefined();
    }
  });

  it('通知行照搬事件名，且三种停法都算用户可见通知', () => {
    const fact = { taskId: 't1', taskNo: 1, name: '核对单据', event: 'user_stop' as const, at: '2026-11-24T00:00:00.000Z' };
    expect(notificationLineOf(fact)).toEqual({ ts: fact.at, taskId: 't1', kind: 'user_stop' });
    for (const event of ['user_stop', 'deadline_reached', 'capacity_blocked'] as const) {
      expect(isNotificationFact(event), event).toBe(true);
    }
    // 反绊线：汇报存档/这一轮停下不是通知种类（不拿「已存档」再打扰用户）。
    expect(isNotificationFact('result_archived')).toBe(false);
    expect(isNotificationFact('ended')).toBe(false);
  });
});
