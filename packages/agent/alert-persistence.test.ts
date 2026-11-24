/**
 * 底账告警投影守卫（2026-11-23 零状态判负 + 第 1 轮审查）：结束事实在 task_ends 追加账，
 * tasks 行没有任何终态列。`ledgerFacts` 若只把 `stored.task` 喂给唯一谓词，「已启动 +
 * 无汇报 + 有结束事实」的任务仍会被投影成「仍在推进」，`task_stuck` 规则就会对已结束任务
 * 发假「卡住」告警（进程内周期扫描 + `npm run alerts` 共用本投影）。
 *
 * 投影只带**原始事实**（`progressing` 布尔谓词 / `waitingSince` / `lastAt`），不带任务级
 * 状态词（旧 `task_state: running|waiting_user` / `detail.taskStatus` 已删）。
 *
 * 反向绊线：把投影改回 `stillProgressingOf(stored.task)`（丢弃 ends）或把状态词加回来，
 * 本文件与 `task-lifecycle-enum-guard.test.ts` 必红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
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

/** 用 core 的写引擎落真实事实（与生产同 schema）：已启动任务 + 可选等待/结束事实。 */
function seed(
  dbPath: string,
  taskId: string,
  options: { ended?: boolean; waiting?: boolean } = {},
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
    if (options.ended === true) {
      store.appendEndFact({ taskId, at: NOW, updatedAt: NOW });
    }
  } finally {
    store.close();
  }
}

function taskLedgerFacts(dbPath: string): Array<Record<string, unknown>> {
  const { facts } = ledgerFacts(dbPath);
  return facts.filter((fact) => fact.event === 'task_ledger') as unknown as Array<Record<string, unknown>>;
}

describe('ledgerFacts：结束事实在场 = 已停，不投影成仍在推进/等待', () => {
  it('正例：已启动、无汇报、无结束事实 → 投影原始事实 progressing=true + lastAt', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_running');
    const facts = taskLedgerFacts(dbPath);
    expect(facts).toHaveLength(1);
    expect(facts[0]!['detail']).toEqual({ progressing: true, lastAt: NOW });
    // 投影不带任务级状态词（判据 1：任务级状态投影已删）。
    expect(JSON.stringify(facts[0])).not.toMatch(/taskStatus|task_state|"running"|"waiting_user"/u);
  });

  it('等待形状 → 投影 waitingSince 原始时刻（progressing=false），不投影 waiting_user 状态词', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_waiting', { waiting: true });
    const facts = taskLedgerFacts(dbPath);
    expect(facts).toHaveLength(1);
    expect(facts[0]!['detail']).toEqual({ progressing: false, waitingSince: NOW, lastAt: NOW });
  });

  it('结束事实（不分类，无 kind）→ 不再投影任何 task_ledger（已停不翻案）', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_ended', { ended: true });
    expect(taskLedgerFacts(dbPath)).toEqual([]);
  });

  it('等待形状 + 结束事实（等待到期）→ 不再投影任何 task_ledger', () => {
    const dbPath = tempDbPath();
    seed(dbPath, 'task_waiting_ended', { waiting: true, ended: true });
    expect(taskLedgerFacts(dbPath)).toEqual([]);
  });
});
