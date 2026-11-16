/**
 * file_refs 行访问器（CAP-01 S0；docs/product/cap01-main-direct-execution.md §4）。
 *
 * 覆盖：
 *   ① 插/查/列的最小面：插入行回读字段一致；activated_at NULL 读出 undefined（= pending，
 *      没有 state 枚举）；
 *   ② 越权与不存在同形：换 principal / 换 session 读 fileId 一律 undefined（与「不存在」
 *      无法区分——防存在性 oracle）；
 *   ③ list 按 scope 隔离，不跨会话泄漏；
 *   ④ 关库重开：行仍在（底账跨进程）；旧库可写打开时 file_refs 由 SCHEMA_BASE 补建，
 *      旧任务行不动（纯新增表，不升版本）；
 *   ⑤ 旧库只读打开（无 file_refs 表）：读出缺省（undefined/[]）不崩溃，写入确定性拒绝。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore, type FileRefRow } from './src/task-store';

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'file-refs-'));
  dirs.push(dir);
  return path.join(dir, 'state.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE_A = { principalId: 'wecom:u1', sessionId: 'cap01-s0' };
const SCOPE_B = { principalId: 'wecom:u1', sessionId: 'other-session' };

function rowOf(overrides: Partial<FileRefRow> & { fileId: string; scope?: typeof SCOPE_A }): FileRefRow {
  const { fileId, scope = SCOPE_A, ...rest } = overrides;
  return {
    fileId,
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    name: '数据.xlsx',
    sha256: `sha_${fileId}`,
    bytes: 128,
    activatedAt: 1700000000000,
    createdAt: 1699999999000,
    ...rest,
  };
}

describe('file_refs 行访问器（CAP-01 S0）', () => {
  it('① 插/查/列回读一致；activated_at 缺省读出 undefined（NULL = pending）', () => {
    const store = openTaskStore(tempDbPath());
    const activated = store.insertFileRef(rowOf({ fileId: 'file_a' }));
    expect(activated).toMatchObject({ fileId: 'file_a', name: '数据.xlsx', bytes: 128 });
    expect(activated.activatedAt).toBe(1700000000000);

    const pending = store.insertFileRef(rowOf({ fileId: 'file_b', activatedAt: undefined }));
    expect(pending.activatedAt).toBeUndefined(); // pending 的存储形状就是 NULL

    const readBack = store.getFileRef('file_b', SCOPE_A)!;
    expect(readBack.fileId).toBe('file_b');
    expect(readBack.activatedAt).toBeUndefined();
    expect(readBack.createdAt).toBe(1699999999000);
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId).sort()).toEqual(['file_a', 'file_b']);
    store.close();
  });

  it('② 越权与不存在同形：换 principal / 换 session 与不存在一样是 undefined（防 oracle）', () => {
    const store = openTaskStore(tempDbPath());
    store.insertFileRef(rowOf({ fileId: 'file_a' }));
    expect(store.getFileRef('file_a', SCOPE_A)).toBeDefined();
    expect(store.getFileRef('file_a', { principalId: 'wecom:u2', sessionId: 'cap01-s0' })).toBeUndefined();
    expect(store.getFileRef('file_a', SCOPE_B)).toBeUndefined();
    expect(store.getFileRef('file_absent', SCOPE_A)).toBeUndefined();
    store.close();
  });

  it('③ list 按 scope 隔离', () => {
    const store = openTaskStore(tempDbPath());
    store.insertFileRef(rowOf({ fileId: 'file_a1', scope: SCOPE_A }));
    store.insertFileRef(rowOf({ fileId: 'file_b1', scope: SCOPE_B }));
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId)).toEqual(['file_a1']);
    expect(store.listFileRefs(SCOPE_B).map((row) => row.fileId)).toEqual(['file_b1']);
    store.close();
  });

  it('④ 关库重开行仍在；旧库可写打开补建 file_refs（纯新增表），旧任务行不动', () => {
    const dbPath = tempDbPath();
    // 造一个 v4 前形状的旧库（只有 tasks 基础列），再以当前版本可写打开。
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
        request TEXT NOT NULL, status TEXT NOT NULL, result_text TEXT, failure_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (task_id, principal_id, session_id, request, status, created_at, updated_at)
      VALUES ('task_legacy', 'wecom:u1', 'cap01-s0', '旧任务', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    legacy.close();

    const first = openTaskStore(dbPath);
    first.insertFileRef(rowOf({ fileId: 'file_after_migration' }));
    expect(first.getTask('task_legacy')?.task.status).toBe('completed');
    first.close();

    const second = openTaskStore(dbPath);
    expect(second.getFileRef('file_after_migration', SCOPE_A)).toBeDefined();
    expect(second.getTask('task_legacy')?.task.status).toBe('completed');
    second.close();
  });

  it('⑤ 旧库只读打开（无 file_refs 表）：读出缺省不崩溃；写入确定性拒绝', () => {
    const dbPath = tempDbPath();
    // P2a 时代的旧库形状（有 tasks/executions，无 operations/dispatch_key/file_refs）。
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
        request TEXT NOT NULL, status TEXT NOT NULL, result_text TEXT, failure_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
        operation TEXT NOT NULL, status TEXT NOT NULL, error_json TEXT
      );
    `);
    legacy.close();

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getFileRef('file_any', SCOPE_A)).toBeUndefined();
    expect(store.listFileRefs(SCOPE_A)).toEqual([]);
    expect(() => store.insertFileRef(rowOf({ fileId: 'file_new' }))).toThrow(/file_refs/);
    store.close();
  });
});
