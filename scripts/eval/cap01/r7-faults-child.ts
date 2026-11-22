/**
 * CAP-01 R7 故障注入的子进程（scripts/eval/cap01/r7-faults.ts 的 spawn 目标；不单独运行）。
 *
 * 职责：把「宿主写侧」放进独立 OS 进程，让父脚本可以用 SIGKILL / 并发双进程 / 长锁三种
 * 可复现方式注入故障——不依赖真磁盘满，也不改动任何产品码：
 *   · register    —— 打开真实 SQLite 底账 + 真实 fileStore（宿主唯一写侧，与 server/ask
 *                     同一构造：task-store.ts + file-store.ts），登记一个 prepared out/ 目录。
 *                     stdout 的 `ready` / `done` 行（writeSync 同步刷出）是父脚本 kill 时序锚点。
 *   · burst       —— 对同一 dbPath 并发写（insertTask / insertFileRef / mintOperation），
 *                     逐笔 try/catch 记录错误（SQLITE_BUSY 等），供 F4a 双进程并发观察。
 *   · hold-lock   —— 在 store.transaction（BEGIN IMMEDIATE）里持写锁 holdMs（Atomics.wait
 *                     同步睡眠），锁内先落一行，供 F4b/4c 阻塞另一进程的写。
 *   · probe-write —— 被阻塞方的单笔写：记录 elapsedMs 与错误（code/message），如实回报。
 *   · busy-report —— 只读连接读 busy_timeout / journal_mode（记录本仓 better-sqlite3 缺省行为）。
 *
 * 全部走真实产品代码，零替身；本文件不含任何测试断言（判定都在父脚本）。
 */
import { writeSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openTaskStore } from '@fshine/core';
import { createFileStore, type FileScope } from '../../../packages/agent/src/file-store';

function out(line: string): void {
  // 子进程的 stdout 是时序锚点与结果通道：同步刷出，父脚本逐行解析。
  writeSync(1, `${line}\n`);
}

/** 同步睡眠（阻塞事件循环）：hold-lock 模式用它把 BEGIN IMMEDIATE 写事务钉住 holdMs。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errInfo(error: unknown): { code?: string; message: string } {
  const typed = error as { code?: string; message?: string };
  return {
    ...(typed?.code === undefined ? {} : { code: typed.code }),
    message: typed?.message === undefined ? String(error) : typed.message,
  };
}

interface RegisterPayload {
  dbPath: string;
  workspaceRoot: string;
  runDir: string;
  scope: FileScope;
  maxFileBytes: number;
  maxCount: number;
}

function runRegister(payload: RegisterPayload): void {
  const store = openTaskStore(payload.dbPath);
  const fileStore = createFileStore({ store, workspaceRoot: payload.workspaceRoot });
  out(`ready t=${Date.now()}`);
  const startedAt = Date.now();
  const { outputs, skipped } = fileStore.registerOutputsFromOut({
    runDir: payload.runDir,
    scope: payload.scope,
    limits: { maxFileBytes: payload.maxFileBytes, maxCount: payload.maxCount },
  });
  out(`done t=${Date.now()} rows=${outputs.length} skipped=${skipped.length} elapsedMs=${Date.now() - startedAt}`);
  store.close();
}

interface BurstPayload {
  dbPath: string;
  childId: string;
  iterations: number;
  scope: FileScope;
  scopeKey: string;
}

function runBurst(payload: BurstPayload): void {
  const store = openTaskStore(payload.dbPath);
  const now = (): string => new Date().toISOString();
  const errors: Array<{ op: string; key: string; code?: string; message: string }> = [];
  let taskOk = 0;
  let refOk = 0;
  let mintOk = 0;
  for (let index = 0; index < payload.iterations; index += 1) {
    const key = `${payload.childId}-${index}`;
    try {
      store.insertTask({
        taskId: `bt_${key}`,
        principalId: payload.scope.principalId,
        sessionId: payload.scope.sessionId,
        request: `burst ${key}`,
        createdAt: now(),
        updatedAt: now(),
      });
      taskOk += 1;
    } catch (error) {
      errors.push({ op: 'insertTask', key, ...errInfo(error) });
    }
    try {
      store.insertFileRef({
        fileId: `bfile_${key}`,
        principalId: payload.scope.principalId,
        sessionId: payload.scope.sessionId,
        name: `burst-${key}.txt`,
        sha256: 'f'.repeat(64),
        bytes: 3,
        activatedAt: Date.now(),
        createdAt: Date.now(),
      });
      refOk += 1;
    } catch (error) {
      errors.push({ op: 'insertFileRef', key, ...errInfo(error) });
    }
    try {
      store.mintOperation({ scopeKey: payload.scopeKey, operation: 'burst.op', attempt: 1, now: now() });
      mintOk += 1;
    } catch (error) {
      errors.push({ op: 'mintOperation', key, ...errInfo(error) });
    }
  }
  out(`result ${JSON.stringify({ childId: payload.childId, taskOk, refOk, mintOk, errors })}`);
  store.close();
}

interface HoldLockPayload {
  dbPath: string;
  fileId: string;
  holdMs: number;
  scope: FileScope;
}

function runHoldLock(payload: HoldLockPayload): void {
  const store = openTaskStore(payload.dbPath);
  const startedAt = Date.now();
  store.transaction(() => {
    store.insertFileRef({
      fileId: payload.fileId,
      principalId: payload.scope.principalId,
      sessionId: payload.scope.sessionId,
      name: `${payload.fileId}.txt`,
      sha256: 'a'.repeat(64),
      bytes: 1,
      activatedAt: Date.now(),
      createdAt: Date.now(),
    });
    // 持锁锚点：BEGIN IMMEDIATE 已拿到、sleepSync 尚未开始——父脚本看到这行才发起被阻塞方。
    out(`locked t=${Date.now()} holdMs=${payload.holdMs}`);
    sleepSync(payload.holdMs);
    return 0;
  });
  out(`held-done heldMs=${payload.holdMs} elapsedMs=${Date.now() - startedAt} fileId=${payload.fileId}`);
  store.close();
}

interface ProbeWritePayload {
  dbPath: string;
  fileId: string;
  scope: FileScope;
}

function runProbeWrite(payload: ProbeWritePayload): void {
  const startedAt = Date.now();
  let error: { code?: string; message: string } | undefined;
  let store: ReturnType<typeof openTaskStore> | undefined;
  try {
    // 注意：openTaskStore 打开期本身有写动作（schema ensure + task_sequences 计数器 upsert），
    // 长锁期间连「打开」都可能阻塞/报错——这属于要如实记录的行为，不能让子进程裸崩。
    store = openTaskStore(payload.dbPath);
    // 开/写分界锚点：error 落在这行之前 = 打开期被锁卡住；之后 = INSERT 被锁卡住。
    out(`opened t=${Date.now()} elapsedMs=${Date.now() - startedAt}`);
    store.insertFileRef({
      fileId: payload.fileId,
      principalId: payload.scope.principalId,
      sessionId: payload.scope.sessionId,
      name: `${payload.fileId}.txt`,
      sha256: 'b'.repeat(64),
      bytes: 1,
      activatedAt: Date.now(),
      createdAt: Date.now(),
    });
  } catch (caught) {
    error = errInfo(caught);
  } finally {
    store?.close();
  }
  out(`probe ${JSON.stringify({ fileId: payload.fileId, elapsedMs: Date.now() - startedAt, error })}`);
}

function runBusyReport(dbPath: string): void {
  // 只读连接只读 pragma，不建表不迁移（记录本仓 better-sqlite3 的缺省行为）。
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const busyTimeoutMs = db.pragma('busy_timeout', { simple: true }) as number;
  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  out(`busy ${JSON.stringify({ busyTimeoutMs, journalMode })}`);
  db.close();
}

const mode = process.argv[2];
const payload = JSON.parse(process.argv[3] ?? '{}') as Record<string, unknown>;
if (mode === 'register') runRegister(payload as unknown as RegisterPayload);
else if (mode === 'burst') runBurst(payload as unknown as BurstPayload);
else if (mode === 'hold-lock') runHoldLock(payload as unknown as HoldLockPayload);
else if (mode === 'probe-write') runProbeWrite(payload as unknown as ProbeWritePayload);
else if (mode === 'busy-report') runBusyReport(String(payload.dbPath));
else {
  out(`unknown-mode ${String(mode)}`);
  process.exitCode = 2;
}
