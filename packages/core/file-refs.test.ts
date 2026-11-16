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
 * S1 测试补齐（2026-11-17，缺口来自对 S0 测试面的重读）：
 *   ⑥ 插/查往返 8 列全字段全等（getFileRef 与 listFileRefs 两条读路径；pending 形状同锁）；
 *   ⑦ activatePendingFileRefs：窗口内 pending → 激活；窗口外 pending 与已激活行不动；
 *      二次激活零行；激活只做 NULL → 时刻，其余 7 列不动（无第二套状态）；
 *   ⑧ 激活与 list 的 scope 隔离：另一 session / 另一 principal 的 pending 不被触碰、行不串
 *      （getFileRef 双维隔离 S0 ②已锁，这里补 list 另一 principal 与激活侧）；
 *   ⑨ 同 file_id 重复插入被主键拒（零写入，不覆盖已有行——INSERT OR REPLACE 在此红）；
 *   ⑩ TTL 过期后存储层查询语义：行仍在、activated_at 原值（TTL 是读方谓词，存储层不删行
 *      不降级——孤儿清理归后续 TTL 清扫，本层无 TTL 概念）。
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
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL,
        request TEXT NOT NULL, status TEXT NOT NULL, result_text TEXT, failure_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tasks (task_id, principal_id, session_id, request, status, created_at, updated_at)
      VALUES ('task_legacy', 'wecom:u1', 'cap01-s0', '旧任务', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    oldDb.close();

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
    const oldDb = new Database(dbPath);
    oldDb.exec(`
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
    oldDb.close();

    const store = openTaskStore(dbPath, { readOnly: true });
    expect(store.getFileRef('file_any', SCOPE_A)).toBeUndefined();
    expect(store.listFileRefs(SCOPE_A)).toEqual([]);
    expect(() => store.insertFileRef(rowOf({ fileId: 'file_new' }))).toThrow(/file_refs/);
    store.close();
  });

  it('⑥ 插/查往返：8 列全字段全等（getFileRef 与 listFileRefs 两条读路径；pending 形状同锁）', () => {
    const store = openTaskStore(tempDbPath());
    const scope = { principalId: 'wecom:u-rt', sessionId: 'sess-rt' };
    const row: FileRefRow = {
      fileId: 'file_roundtrip',
      principalId: 'wecom:u-rt',
      sessionId: 'sess-rt',
      name: '季度报表.xlsx',
      sha256: 'a'.repeat(64),
      bytes: 4096,
      activatedAt: 1_760_000_000_123,
      createdAt: 1_759_999_999_000,
    };
    expect(store.insertFileRef(row)).toEqual(row);
    expect(store.getFileRef('file_roundtrip', scope)).toEqual(row);
    expect(store.listFileRefs(scope)).toEqual([row]);

    // pending 形状（activated_at NULL）同样全字段往返：读出是 undefined，不是 0/'' 之类改写。
    const pending: FileRefRow = { ...row, fileId: 'file_rt_pending', sha256: 'b'.repeat(64), bytes: 1, activatedAt: undefined };
    expect(store.insertFileRef(pending)).toEqual(pending);
    expect(store.getFileRef('file_rt_pending', scope)).toEqual(pending);
    store.close();
  });

  it('⑦ activatePendingFileRefs：窗口内 pending 置激活；窗口外 pending 与已激活行不动；二次激活零行', () => {
    const store = openTaskStore(tempDbPath());
    const now = 1_770_000_000_000;
    const windowStart = now - 60_000;
    const inWindow = store.insertFileRef(
      rowOf({ fileId: 'file_win', activatedAt: undefined, createdAt: now - 30_000 }),
    );
    store.insertFileRef(rowOf({ fileId: 'file_old_pending', activatedAt: undefined, createdAt: now - 120_000 }));
    store.insertFileRef(rowOf({ fileId: 'file_already', createdAt: now - 10_000 })); // activatedAt = rowOf 缺省

    expect(store.activatePendingFileRefs(SCOPE_A, { activatedAt: now, createdAfter: windowStart })).toBe(1);

    const activated = store.getFileRef('file_win', SCOPE_A)!;
    expect(activated.activatedAt).toBe(now);
    // 激活只是 NULL → 时刻：其余 7 列原样（无第二套状态、无改写）。
    expect(activated).toEqual({ ...inWindow, activatedAt: now });

    expect(store.getFileRef('file_old_pending', SCOPE_A)?.activatedAt).toBeUndefined(); // 过期 pending 保持 pending
    expect(store.getFileRef('file_already', SCOPE_A)?.activatedAt).toBe(1_700_000_000_000); // 已激活时间戳不变

    expect(store.activatePendingFileRefs(SCOPE_A, { activatedAt: now + 1, createdAfter: windowStart })).toBe(0);
    expect(store.getFileRef('file_win', SCOPE_A)?.activatedAt).toBe(now); // 二次激活不重写时间戳
    store.close();
  });

  it('⑧ 激活与 list 按 scope 隔离：另一 session / 另一 principal 的 pending 不被触碰、行不串', () => {
    const store = openTaskStore(tempDbPath());
    const now = 1_770_000_000_000;
    const PRINCIPAL_B = { principalId: 'wecom:u2', sessionId: 'cap01-s0' }; // 与 SCOPE_A 同 session、不同 principal
    store.insertFileRef(
      rowOf({ fileId: 'file_other_session', scope: SCOPE_B, activatedAt: undefined, createdAt: now - 10_000 }),
    );
    store.insertFileRef(
      rowOf({ fileId: 'file_other_principal', scope: PRINCIPAL_B, activatedAt: undefined, createdAt: now - 10_000 }),
    );

    expect(store.activatePendingFileRefs(SCOPE_A, { activatedAt: now, createdAfter: now - 60_000 })).toBe(0);
    expect(store.getFileRef('file_other_session', SCOPE_B)?.activatedAt).toBeUndefined();
    expect(store.getFileRef('file_other_principal', PRINCIPAL_B)?.activatedAt).toBeUndefined();

    // list 侧另一 principal 补全（getFileRef 双维 S0 ②已锁）：A 的行不串进别人的会话列表。
    store.insertFileRef(rowOf({ fileId: 'file_only_a' }));
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId)).toEqual(['file_only_a']);
    expect(store.listFileRefs(PRINCIPAL_B).map((row) => row.fileId)).toEqual(['file_other_principal']);
    store.close();
  });

  it('⑨ 同 file_id 重复插入被主键拒：零写入、不覆盖不改写已有行', () => {
    const store = openTaskStore(tempDbPath());
    store.insertFileRef(rowOf({ fileId: 'file_dup', name: '首行.xlsx', sha256: 'sha_first' }));
    expect(() =>
      store.insertFileRef(rowOf({ fileId: 'file_dup', name: '冒名.xlsx', sha256: 'sha_second' })),
    ).toThrowError(/UNIQUE constraint failed: file_refs\.file_id/);
    // 主键冲突必须零写入：首行原样（INSERT OR REPLACE / OR IGNORE 之类的写法在这里红）。
    const kept = store.getFileRef('file_dup', SCOPE_A)!;
    expect(kept.name).toBe('首行.xlsx');
    expect(kept.sha256).toBe('sha_first');
    expect(store.listFileRefs(SCOPE_A)).toHaveLength(1);
    store.close();
  });

  it('⑩ TTL 过期后存储层查询语义：行仍在、activated_at 原值（存储层不删行不降级，TTL 是读方谓词）', () => {
    const store = openTaskStore(tempDbPath());
    const staleActivatedAt = 1_560_000_000_000; // 远早于任何合理 TTL；读方按 activated_at 自判
    store.insertFileRef(
      rowOf({ fileId: 'file_stale', activatedAt: staleActivatedAt, createdAt: staleActivatedAt - 1_000 }),
    );
    expect(store.getFileRef('file_stale', SCOPE_A)?.activatedAt).toBe(staleActivatedAt);
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId)).toEqual(['file_stale']);
    store.close();
  });
});
