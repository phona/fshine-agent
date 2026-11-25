/**
 * executions 时间列（issue #69）：started_at / finished_at（nullable，纯前向加法）。
 *
 * 闭环判据（issue #69 原文）：
 *   1. 迁移加时间列（started_at / finished_at，nullable），旧库可读、纯前向加法、不升破坏性版本；
 *   2. 写入路径在真实执行前后落时刻；未知/旧行不伪造时刻；
 *   3. tasks / ops 渲染金样覆盖有/无时刻两态 + 受理行单点第三态（scripts/tasks.test.ts、scripts/ops.test.ts）；
 *   4. 只读旧库打开不崩溃、写入确定性拒绝的语义不变（本文件⑤）。
 *
 * 本文件覆盖①④与存储层②的前半（行形状/不伪造）；真实执行边界的落时刻见
 * packages/agent/runtime.test.ts（inline）、runtime-worker-run-js.test.ts（Worker run_js）。
 *
 * 迁移纪律（与 file_refs.task_id / deliverable 同款前向加法）：
 *   · 新库建表即带两列（TEXT，可空）；
 *   · 缺列旧库可写打开 → ADD COLUMN 补齐，旧行两列 = NULL（读出缺省，不伪造）；
 *   · 不升 user_version（纯加法，仍是 v7）；迁移前自动备份 <db>.backup-v7；
 *   · 半迁移旧库（只缺一列）→ 只补缺的那列；
 *   · 只读打开缺列旧库：不建表、不加列、不改哈希，读出缺省；写入仍走 SQLite 只读拒绝。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore } from './src/task-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-store-exec-times-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

/** 造一个当前形状的库并种一行任务 + 一行执行记录（历史行：两列本应为 NULL）。 */
function seedCurrentDb(dbPath: string): void {
  const store = openTaskStore(dbPath);
  store.insertTask({
    taskId: 'task_old',
    principalId: 'wecom:u',
    sessionId: 'sess_old',
    request: '历史任务',
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:01:00.000Z',
  });
  store.insertExecution({
    requestId: 'req_old',
    taskId: 'task_old',
    operation: 'dummy.query',
    status: 'completed',
  });
  store.close();
}

/** 精确复刻「时间列上线前」的旧库形状：删掉 started_at / finished_at（可只删一列）。 */
function shrinkTimeColumns(dbPath: string, columns: readonly string[]): void {
  const db = new Database(dbPath);
  try {
    for (const column of columns) db.exec(`ALTER TABLE executions DROP COLUMN ${column}`);
  } finally {
    db.close();
  }
}

describe('executions 时间列（issue #69：started_at / finished_at）', () => {
  it('① 新库：executions 建表即带 started_at/finished_at（可空）；写入读回原值', () => {
    const dbPath = tempDb();
    const store = openTaskStore(dbPath);
    expect(tableColumns(dbPath, 'executions')).toEqual(expect.arrayContaining(['started_at', 'finished_at']));
    store.insertTask({
      taskId: 'task_a',
      principalId: 'wecom:u',
      sessionId: 'sess_a',
      request: '查 beta',
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:00:00.000Z',
    });
    store.insertExecution({
      requestId: 'req_1',
      taskId: 'task_a',
      operation: 'dummy.query',
      status: 'completed',
      startedAt: '2026-11-24T10:00:01.000Z',
      finishedAt: '2026-11-24T10:00:03.500Z',
    });
    const stored = store.getTask('task_a')!;
    expect(stored.executions).toHaveLength(1);
    expect(stored.executions[0]).toMatchObject({
      requestId: 'req_1',
      operation: 'dummy.query',
      status: 'completed',
      startedAt: '2026-11-24T10:00:01.000Z',
      finishedAt: '2026-11-24T10:00:03.500Z',
    });
    store.close();
  });

  it('② 不落时刻的写入：两列 NULL，读出缺省（未知/旧行不伪造时刻）', () => {
    const dbPath = tempDb();
    const store = openTaskStore(dbPath);
    store.insertTask({
      taskId: 'task_b',
      principalId: 'wecom:u',
      sessionId: 'sess_b',
      request: '查 beta',
      createdAt: '2026-11-24T10:00:00.000Z',
      updatedAt: '2026-11-24T10:00:00.000Z',
    });
    store.insertExecution({
      requestId: 'req_2',
      taskId: 'task_b',
      operation: 'dummy.query',
      status: 'completed',
    });
    const stored = store.getTask('task_b')!;
    expect(stored.executions[0]!.startedAt).toBeUndefined();
    expect(stored.executions[0]!.finishedAt).toBeUndefined();
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw.prepare('SELECT started_at, finished_at FROM executions WHERE request_id = ?')
        .get('req_2') as { started_at: string | null; finished_at: string | null };
      expect(row).toEqual({ started_at: null, finished_at: null });
    } finally {
      raw.close();
    }
    store.close();
  });

  it('③ 旧库（缺两列）可写打开：ADD COLUMN 补齐、旧行 NULL、版本不升、备份生成、二次打开幂等', () => {
    const dbPath = tempDb();
    seedCurrentDb(dbPath);
    shrinkTimeColumns(dbPath, ['started_at', 'finished_at']);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath);
    expect(tableColumns(dbPath, 'executions')).toEqual(expect.arrayContaining(['started_at', 'finished_at']));
    // 历史行两列 NULL：读出缺省，不伪造时刻。
    const stored = store.getTask('task_old')!;
    expect(stored.executions[0]!.startedAt).toBeUndefined();
    expect(stored.executions[0]!.finishedAt).toBeUndefined();
    // 纯前向加法：不升 user_version（仍是 v7），不重建任何表。
    expect(TASK_STORE_SCHEMA_VERSION).toBe(7);
    expect(userVersion(dbPath)).toBe(TASK_STORE_SCHEMA_VERSION);
    // 迁移前备份（目标版本命名；内容 = 打开前字节）。
    const backupPath = `${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`;
    expect(existsSync(backupPath)).toBe(true);
    expect(sha256(backupPath)).toBe(before);
    // 迁移后新行仍可带时刻写读。
    store.insertExecution({
      requestId: 'req_new',
      taskId: 'task_old',
      operation: 'dummy.query',
      status: 'completed',
      startedAt: '2026-11-24T11:00:00.000Z',
      finishedAt: '2026-11-24T11:00:02.000Z',
    });
    expect(store.getTask('task_old')!.executions[1]).toMatchObject({
      requestId: 'req_new',
      startedAt: '2026-11-24T11:00:00.000Z',
      finishedAt: '2026-11-24T11:00:02.000Z',
    });
    store.close();

    // 幂等：二次打开零差异（谓词不再命中、无新备份、历史行原样）。
    const second = openTaskStore(dbPath);
    const again = second.getTask('task_old')!;
    expect(again.executions[0]!.startedAt).toBeUndefined();
    expect(again.executions[0]!.finishedAt).toBeUndefined();
    expect(again.executions[1]!.startedAt).toBe('2026-11-24T11:00:00.000Z');
    second.close();
    expect(sha256(backupPath)).toBe(before);
  });

  it('④ 半迁移旧库（只缺 started_at）：只补缺的那列，finished_at 原样不动', () => {
    const dbPath = tempDb();
    seedCurrentDb(dbPath);
    shrinkTimeColumns(dbPath, ['started_at']);
    expect(tableColumns(dbPath, 'executions')).toContain('finished_at');
    expect(tableColumns(dbPath, 'executions')).not.toContain('started_at');

    const store = openTaskStore(dbPath);
    expect(tableColumns(dbPath, 'executions')).toEqual(expect.arrayContaining(['started_at', 'finished_at']));
    const stored = store.getTask('task_old')!;
    expect(stored.executions[0]!.startedAt).toBeUndefined();
    expect(stored.executions[0]!.finishedAt).toBeUndefined();
    store.insertExecution({
      requestId: 'req_half',
      taskId: 'task_old',
      operation: 'dummy.query',
      status: 'completed',
      startedAt: '2026-11-24T12:00:00.000Z',
      finishedAt: '2026-11-24T12:00:01.000Z',
    });
    expect(store.getTask('task_old')!.executions[1]).toMatchObject({
      startedAt: '2026-11-24T12:00:00.000Z',
      finishedAt: '2026-11-24T12:00:01.000Z',
    });
    store.close();
  });

  it('⑤ 只读旧库（缺两列）：不迁移、哈希不变、无备份、读出缺省；写入仍确定性拒绝（语义不变）', () => {
    const dbPath = tempDb();
    seedCurrentDb(dbPath);
    shrinkTimeColumns(dbPath, ['started_at', 'finished_at']);
    const before = sha256(dbPath);

    const store = openTaskStore(dbPath, { readOnly: true });
    // 只读打开不崩溃、不迁移：缺列不 prepare 新列语句，历史行原样读出（缺省 = 无时刻）。
    const stored = store.getTask('task_old')!;
    expect(stored.executions[0]!.startedAt).toBeUndefined();
    expect(stored.executions[0]!.finishedAt).toBeUndefined();
    // 写入确定性拒绝的语义不变：只读连接上 insertExecution 被 SQLite 拒绝（不是静默丢列）。
    expect(() => store.insertExecution({
      requestId: 'req_ro',
      taskId: 'task_old',
      operation: 'dummy.query',
      status: 'completed',
      startedAt: '2026-11-24T13:00:00.000Z',
      finishedAt: '2026-11-24T13:00:01.000Z',
    })).toThrow(/readonly/i);
    store.close();

    expect(sha256(dbPath)).toBe(before);
    expect(existsSync(`${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`)).toBe(false);
    expect(tableColumns(dbPath, 'executions')).not.toContain('started_at');
    expect(tableColumns(dbPath, 'executions')).not.toContain('finished_at');
  });
});
