/**
 * file_refs 行访问器（CAP-01 S0；docs/architecture/files.md §4）。
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
 * S2 测试补齐（task_id 列 + 解析侧，v8 §4 作用域规则）：
 *   ⑪ 带 taskId 行只在 Worker 解析（task_id = 当前任务）可见；无 taskId 行只在 Main 解析
 *      （task_id IS NULL）可见；越权与不存在在两侧同样 undefined（同码防 oracle）；
 *   ⑫ S1 时代旧库（file_refs 无 task_id 列）可写打开：ADD COLUMN 补齐（前向加法）、旧行
 *      全字段不动且归 Main 侧、迁移备份生成、user_version 不升（仍 v4）、二次打开零差异；
 *   ⑬ 只读旧库（有 file_refs 无 task_id 列）：Main 解析退回旧查询（历史行都是 Main 侧）、
 *      Worker 解析读出 undefined（不崩溃）、写入确定性拒绝。
 *
 * 库路径用临时目录（mkdtemp）；不触网、不碰真实平台。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STORE_SCHEMA_VERSION, openTaskStore, type FileRefRow } from './src/task-store';

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
    deliverable: true,
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

    const readBack = store.getFileRef('file_b', SCOPE_A, { side: 'main' })!;
    expect(readBack.fileId).toBe('file_b');
    expect(readBack.activatedAt).toBeUndefined();
    expect(readBack.createdAt).toBe(1699999999000);
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId).sort()).toEqual(['file_a', 'file_b']);
    store.close();
  });

  it('② 越权与不存在同形：换 principal / 换 session 与不存在一样是 undefined（防 oracle）', () => {
    const store = openTaskStore(tempDbPath());
    store.insertFileRef(rowOf({ fileId: 'file_a' }));
    expect(store.getFileRef('file_a', SCOPE_A, { side: 'main' })).toBeDefined();
    expect(store.getFileRef('file_a', { principalId: 'wecom:u2', sessionId: 'cap01-s0' }, { side: 'main' })).toBeUndefined();
    expect(store.getFileRef('file_a', SCOPE_B, { side: 'main' })).toBeUndefined();
    expect(store.getFileRef('file_absent', SCOPE_A, { side: 'main' })).toBeUndefined();
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
    // 旧任务行事实原样保留（status 列已随 S1 删除：读业务字段证明行未丢/未改）。
    expect(first.getTask('task_legacy')?.task.request).toBe('旧任务');
    first.close();

    const second = openTaskStore(dbPath);
    expect(second.getFileRef('file_after_migration', SCOPE_A, { side: 'main' })).toBeDefined();
    expect(second.getTask('task_legacy')?.task.request).toBe('旧任务');
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
    expect(store.getFileRef('file_any', SCOPE_A, { side: 'main' })).toBeUndefined();
    expect(store.listFileRefs(SCOPE_A)).toEqual([]);
    expect(() => store.insertFileRef(rowOf({ fileId: 'file_new' }))).toThrow(/file_refs/);
    store.close();
  });

  it('⑥ 插/查往返：9 列全字段全等（getFileRef 与 listFileRefs 两条读路径；pending 形状同锁）', () => {
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
      // 方案 A（第 9 列）：用户产物角色；读路径总是返回布尔。
      deliverable: true,
    };
    expect(store.insertFileRef(row)).toEqual(row);
    expect(store.getFileRef('file_roundtrip', scope, { side: 'main' })).toEqual(row);
    expect(store.listFileRefs(scope)).toEqual([row]);

    // pending 形状（activated_at NULL）同样全字段往返：读出是 undefined，不是 0/'' 之类改写。
    const pending: FileRefRow = { ...row, fileId: 'file_rt_pending', sha256: 'b'.repeat(64), bytes: 1, activatedAt: undefined };
    expect(store.insertFileRef(pending)).toEqual(pending);
    expect(store.getFileRef('file_rt_pending', scope, { side: 'main' })).toEqual(pending);
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

    const activated = store.getFileRef('file_win', SCOPE_A, { side: 'main' })!;
    expect(activated.activatedAt).toBe(now);
    // 激活只是 NULL → 时刻：其余 7 列原样（无第二套状态、无改写）。
    expect(activated).toEqual({ ...inWindow, activatedAt: now });

    expect(store.getFileRef('file_old_pending', SCOPE_A, { side: 'main' })?.activatedAt).toBeUndefined(); // 过期 pending 保持 pending
    expect(store.getFileRef('file_already', SCOPE_A, { side: 'main' })?.activatedAt).toBe(1_700_000_000_000); // 已激活时间戳不变

    expect(store.activatePendingFileRefs(SCOPE_A, { activatedAt: now + 1, createdAfter: windowStart })).toBe(0);
    expect(store.getFileRef('file_win', SCOPE_A, { side: 'main' })?.activatedAt).toBe(now); // 二次激活不重写时间戳
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
    expect(store.getFileRef('file_other_session', SCOPE_B, { side: 'main' })?.activatedAt).toBeUndefined();
    expect(store.getFileRef('file_other_principal', PRINCIPAL_B, { side: 'main' })?.activatedAt).toBeUndefined();

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
    const kept = store.getFileRef('file_dup', SCOPE_A, { side: 'main' })!;
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
    expect(store.getFileRef('file_stale', SCOPE_A, { side: 'main' })?.activatedAt).toBe(staleActivatedAt);
    expect(store.listFileRefs(SCOPE_A).map((row) => row.fileId)).toEqual(['file_stale']);
    store.close();
  });

  it('⑪ S2 解析侧：带 taskId 行只在 Worker（task_id=当前任务）可见；无 taskId 行只在 Main 可见；越权/不存在同形', () => {
    const store = openTaskStore(tempDbPath());
    const mainOnly = store.insertFileRef(rowOf({ fileId: 'file_main_only' }));
    const bound = store.insertFileRef(rowOf({ fileId: 'file_bound', taskId: 'task_x' }));

    // Main 侧：只解析 task_id IS NULL。
    expect(store.getFileRef('file_main_only', SCOPE_A, { side: 'main' })).toEqual(mainOnly);
    expect(store.getFileRef('file_bound', SCOPE_A, { side: 'main' })).toBeUndefined();
    // Worker 侧：只解析 task_id = 当前任务；其他任务/缺省行一律不可见。
    expect(store.getFileRef('file_bound', SCOPE_A, { side: 'worker', taskId: 'task_x' })).toEqual(bound);
    expect(store.getFileRef('file_bound', SCOPE_A, { side: 'worker', taskId: 'task_y' })).toBeUndefined();
    expect(store.getFileRef('file_main_only', SCOPE_A, { side: 'worker', taskId: 'task_x' })).toBeUndefined();
    // 越权与不存在同形（Worker 侧换 principal 也 undefined——不泄露存在性）。
    expect(
      store.getFileRef('file_bound', { principalId: 'wecom:u2', sessionId: 'cap01-s0' }, { side: 'worker', taskId: 'task_x' }),
    ).toBeUndefined();
    expect(store.getFileRef('file_absent', SCOPE_A, { side: 'worker', taskId: 'task_x' })).toBeUndefined();
    store.close();
  });

  it('⑫ S1 时代旧库（file_refs 无 task_id 列）可写打开：ADD COLUMN 补齐、旧行归 Main 不动、备份生成、版本不升', () => {
    const dbPath = tempDbPath();
    // 造一个当前形状的库再 DROP COLUMN task_id = 精确复刻 S1 时代的 file_refs（8 列 + 一行旧行）。
    {
      const seeded = openTaskStore(dbPath);
      seeded.insertFileRef(rowOf({ fileId: 'file_legacy', name: '旧表.xlsx', sha256: 'sha_legacy', bytes: 7 }));
      seeded.close();
    }
    {
      const shrink = new Database(dbPath);
      shrink.exec('ALTER TABLE file_refs DROP COLUMN task_id');
      shrink.close();
    }

    const store = openTaskStore(dbPath); // 可写打开 → 迁移谓词命中 → ADD COLUMN task_id
    // 旧行全字段不动，读出 taskId undefined（历史行都是 Main 侧会话文件）。
    const oldRow = store.getFileRef('file_legacy', SCOPE_A, { side: 'main' })!;
    expect(oldRow).toEqual(
      rowOf({ fileId: 'file_legacy', name: '旧表.xlsx', sha256: 'sha_legacy', bytes: 7 }),
    );
    expect(oldRow.taskId).toBeUndefined();
    expect(store.getFileRef('file_legacy', SCOPE_A, { side: 'worker', taskId: 'task_new' })).toBeUndefined();

    // 新行可带 taskId（Worker 解析可见）；版本不升（仍 v4——纯前向加法，不改 user_version）。
    store.insertFileRef(rowOf({ fileId: 'file_new_bound', taskId: 'task_new' }));
    expect(store.getFileRef('file_new_bound', SCOPE_A, { side: 'worker', taskId: 'task_new' })).toBeDefined();
    store.close();

    expect(existsSync(`${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`)).toBe(true);
    expect(TASK_STORE_SCHEMA_VERSION).toBe(4);
    const probe = new Database(dbPath);
    expect(probe.pragma('user_version', { simple: true })).toBe(TASK_STORE_SCHEMA_VERSION);
    probe.close();

    // 幂等：二次打开零差异（列已在，迁移谓词不再命中，行原样）。
    const second = openTaskStore(dbPath);
    expect(second.getFileRef('file_legacy', SCOPE_A, { side: 'main' })).toEqual(oldRow);
    expect(second.getFileRef('file_new_bound', SCOPE_A, { side: 'worker', taskId: 'task_new' })).toBeDefined();
    second.close();
  });

  it('⑬ 只读旧库（有 file_refs 无 task_id 列）：Main 解析退回旧查询、Worker 读出 undefined、写入确定性拒绝', () => {
    const dbPath = tempDbPath();
    {
      const seeded = openTaskStore(dbPath);
      seeded.insertFileRef(rowOf({ fileId: 'file_legacy' }));
      seeded.close();
      const shrink = new Database(dbPath);
      shrink.exec('ALTER TABLE file_refs DROP COLUMN task_id');
      shrink.close();
    }

    const store = openTaskStore(dbPath, { readOnly: true });
    // Main 解析可用（退回旧 3 条件查询：历史行都是 Main 侧）；Worker 解析无行可解析（不崩溃）。
    expect(store.getFileRef('file_legacy', SCOPE_A, { side: 'main' })).toBeDefined();
    expect(store.getFileRef('file_legacy', SCOPE_A, { side: 'worker', taskId: 'task_x' })).toBeUndefined();
    expect(() => store.insertFileRef(rowOf({ fileId: 'file_new' }))).toThrow(/file_refs/);
    store.close();
  });

  it('⑭ deliverable 列（方案 A）：写 false 读回 false；旧库缺列/旧行按 true 读出、user_version 不升', () => {
    const dbPath = tempDbPath();
    {
      const seeded = openTaskStore(dbPath);
      seeded.insertFileRef(rowOf({ fileId: 'file_user' }));
      seeded.insertFileRef(rowOf({ fileId: 'file_diag', name: '明细.values.csv', deliverable: false }));
      seeded.close();
    }
    {
      // 新库：角色标记往返（读路径两条都返回布尔）。
      const store = openTaskStore(dbPath);
      expect(store.getFileRef('file_user', SCOPE_A, { side: 'main' })!.deliverable).toBe(true);
      expect(store.getFileRef('file_diag', SCOPE_A, { side: 'main' })!.deliverable).toBe(false);
      expect(store.listFileRefs(SCOPE_A).find((row) => row.fileId === 'file_diag')!.deliverable).toBe(false);
      store.close();
    }
    {
      // 角色标记上线前的旧库：删列 = 精确复刻缺列形状。
      const shrink = new Database(dbPath);
      shrink.exec('ALTER TABLE file_refs DROP COLUMN deliverable');
      shrink.close();
    }
    {
      // 只读旧库（不迁移）：缺列按 true 读出，不崩溃。
      const readonlyStore = openTaskStore(dbPath, { readOnly: true });
      expect(readonlyStore.getFileRef('file_diag', SCOPE_A, { side: 'main' })!.deliverable).toBe(true);
      readonlyStore.close();
    }
    {
      // 可写旧库：ADD COLUMN ... NOT NULL DEFAULT 1（前向加法），旧行按 true 读出；
      // 纯加法不升 user_version（仍 v4），备份生成。
      const migrated = openTaskStore(dbPath);
      expect(migrated.getFileRef('file_diag', SCOPE_A, { side: 'main' })!.deliverable).toBe(true);
      expect(migrated.getFileRef('file_user', SCOPE_A, { side: 'main' })!.deliverable).toBe(true);
      // 迁移后新行仍可写 false 并读回。
      migrated.insertFileRef(rowOf({ fileId: 'file_diag2', deliverable: false }));
      expect(migrated.getFileRef('file_diag2', SCOPE_A, { side: 'main' })!.deliverable).toBe(false);
      migrated.close();
    }
    expect(TASK_STORE_SCHEMA_VERSION).toBe(4);
    expect(existsSync(`${dbPath}.backup-v${TASK_STORE_SCHEMA_VERSION}`)).toBe(true);
    const probe = new Database(dbPath);
    expect(probe.pragma('user_version', { simple: true })).toBe(TASK_STORE_SCHEMA_VERSION);
    probe.close();
  });
});
