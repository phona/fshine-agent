/**
 * Task 副本与解析作用域（CAP-01 S2；docs/product/cap01-main-direct-execution.md §4）。
 *
 * 覆盖（对应 ask ①②③④ 的 file-store 侧断言）：
 *   · copyInputsForTask（交办复制）：先全部解析、后复制——任一 fileId 不可用 → 整次拒绝
 *     （零复制、零行，不部分执行）；副本 = 新 file_id + task_id 绑定 + 登记即激活；
 *     副本 sha256/bytes 与原件行一致；原件字节与行原样不动；
 *   · 解析作用域（v8 §4）：Main 只解析 task_id IS NULL；Worker 只解析 task_id = 当前任务；
 *     越权 / 不存在 / 过期 → 同码 FILE_REF_UNAVAILABLE（防存在性 oracle；机械 reason 只随
 *     异常对象带出，不进用户话术）；
 *   · Main 清单（listActiveFiles）不含任务绑定行：Main 看不见、也用不了 Worker 的副本。
 *
 * 库用 :memory:，workspace 用临时目录；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import {
  createFileStore,
  FILE_REF_TTL_MS,
  fileStoragePathOf,
  FileRefUnavailableError,
  runDirOf,
  type CopiedTaskInput,
  type FileStore,
} from './src/file-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:u-s2', sessionId: 'cap01-s2' };
const TASK_A = 'task_aaaa';
const TASK_B = 'task_bbbb';

function makeFixture(): {
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
} {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'file-store-s2-'));
  dirs.push(fixtureRoot);
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  return { workspaceRoot, store, fileStore };
}

/** Main 侧已激活源文件（activatedAt 稍早于 now，TTL 内）。 */
function putActiveSource(fileStore: FileStore, name: string, bytes: Buffer, activatedAt = Date.now() - 1_000) {
  return fileStore.putFile({ scope: SCOPE, name, bytes, activatedAt });
}

/** 捕获 FileRefUnavailableError（不捕获 = 断言失败）。 */
function catchUnavailable(fn: () => unknown): FileRefUnavailableError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FileRefUnavailableError);
    return error as FileRefUnavailableError;
  }
  throw new Error('预期 FILE_REF_UNAVAILABLE 未抛出');
}

describe('Task 副本与解析作用域（CAP-01 S2）', () => {
  it('③ 交办复制：副本 sha256/bytes 与原件一致；原件字节与行原样不动；副本登记即激活且只归任务', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const sourceBytes = Buffer.from('季度数据,v1\n2026-11,42\n');
    const source = putActiveSource(fileStore, '季度数据.csv', sourceBytes);
    const sourceStorage = fileStoragePathOf(workspaceRoot, SCOPE, source.fileId, '季度数据.csv');
    const sourceRowBefore = store.getFileRef(source.fileId, SCOPE, { side: 'main' })!;

    const copies = fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [source.fileId], taskId: TASK_A });

    // 副本事实：新 file_id、同名、字节/哈希与原件行一致（内容逐字节相同）。
    expect(copies).toHaveLength(1);
    const copy: CopiedTaskInput = copies[0]!;
    expect(copy.sourceFileId).toBe(source.fileId);
    expect(copy.fileId).toMatch(/^file_[0-9a-f]{32}$/);
    expect(copy.fileId).not.toBe(source.fileId);
    expect(copy.name).toBe('季度数据.csv');
    expect(copy.bytes).toBe(sourceBytes.length);
    expect(copy.sha256).toBe(source.sha256);
    expect(createHash('sha256').update(readFileSync(sourceStorage)).digest('hex')).toBe(source.sha256);

    // 副本行：task_id 绑定目标任务、登记即激活（Worker 侧立即可解析）。
    const copyRow = store.getFileRef(copy.fileId, SCOPE, { side: 'worker', taskId: TASK_A })!;
    expect(copyRow.taskId).toBe(TASK_A);
    expect(copyRow.activatedAt).toBeDefined();
    expect(copyRow.sha256).toBe(source.sha256);
    expect(copyRow.bytes).toBe(sourceBytes.length);
    expect(copyRow.name).toBe('季度数据.csv');

    // 原件不动：行（全字段）与磁盘字节都原样。
    const sourceRowAfter = store.getFileRef(source.fileId, SCOPE, { side: 'main' })!;
    expect(sourceRowAfter).toEqual(sourceRowBefore);
    expect(readFileSync(sourceStorage)).toEqual(sourceBytes);
    store.close();
  });

  it('① Main 的 fileId 在 Worker 侧不可解析：同码 FILE_REF_UNAVAILABLE（与不存在无法区分）', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const source = putActiveSource(fileStore, 'main.csv', Buffer.from('main-bytes'));
    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_w1');

    const error = catchUnavailable(() =>
      fileStore.materializeInputs({
        runDir,
        scope: SCOPE,
        fileIds: [source.fileId],
        resolution: { side: 'worker', taskId: TASK_A },
      }),
    );
    expect(error.code).toBe('FILE_REF_UNAVAILABLE');
    expect(error.reason).toBe(`missing_or_foreign:${source.fileId}`);
    // 机械对照：同一 fileId 在 Main 侧可解析（行存在，拒绝只因作用域不符）。
    expect(store.getFileRef(source.fileId, SCOPE, { side: 'main' })).toBeDefined();
    store.close();
  });

  it('② Worker 的 fileId（任务绑定行）在 Main 侧不可解析：同码；其他任务的 Worker 也解析不到', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const source = putActiveSource(fileStore, '源.csv', Buffer.from('src'));
    const [copy] = fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [source.fileId], taskId: TASK_A });
    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_w2');

    // Main 侧（run_js 的解析面）解析任务副本 → 同码拒绝。
    const mainSide = catchUnavailable(() =>
      fileStore.materializeInputs({ runDir, scope: SCOPE, fileIds: [copy!.fileId], resolution: { side: 'main' } }),
    );
    expect(mainSide.code).toBe('FILE_REF_UNAVAILABLE');
    expect(mainSide.reason).toBe(`missing_or_foreign:${copy!.fileId}`);

    // 另一个任务的 Worker 解析 TASK_A 的副本 → 同码拒绝（任务作用域不跨任务）。
    const otherTask = catchUnavailable(() =>
      fileStore.materializeInputs({
        runDir,
        scope: SCOPE,
        fileIds: [copy!.fileId],
        resolution: { side: 'worker', taskId: TASK_B },
      }),
    );
    expect(otherTask.code).toBe('FILE_REF_UNAVAILABLE');
    expect(otherTask.reason).toBe(`missing_or_foreign:${copy!.fileId}`);

    // 机械对照：本任务的 Worker 能物化副本，字节与原件一致。
    const materialized = fileStore.materializeInputs({
      runDir: runDirOf(workspaceRoot, SCOPE, 'run_w2b'),
      scope: SCOPE,
      fileIds: [copy!.fileId],
      resolution: { side: 'worker', taskId: TASK_A },
    });
    expect(materialized).toHaveLength(1);
    expect(
      readFileSync(path.join(runDirOf(workspaceRoot, SCOPE, 'run_w2b'), 'in', materialized[0]!.materializedName)),
    ).toEqual(Buffer.from('src'));
    store.close();
  });

  it('④ 混入不可用 fileId → 整次拒绝：零复制、零行（不部分执行）；拒绝同码、机械 reason 一一对应', () => {
    const { store, fileStore } = makeFixture();
    const good = putActiveSource(fileStore, '好.csv', Buffer.from('good'));
    // 他人 = 另一会话的文件（fileId 存在，但不在 Main 的会话作用域内）。
    const foreignInOtherSession = fileStore
      .putFile({
        scope: { principalId: SCOPE.principalId, sessionId: 'other-session' },
        name: '别人.xlsx',
        bytes: Buffer.from('other'),
        activatedAt: Date.now(),
      })
      .fileId;

    const beforeRows = store.listFileRefs(SCOPE).length;

    const error = catchUnavailable(() =>
      fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [good.fileId, foreignInOtherSession], taskId: TASK_A }),
    );
    expect(error.code).toBe('FILE_REF_UNAVAILABLE');
    expect(error.reason.startsWith('missing_or_foreign:')).toBe(true);

    // 不部分执行：可用文件也不复制（零新增行），本会话没有任务绑定行。
    expect(store.listFileRefs(SCOPE)).toHaveLength(beforeRows);
    expect(store.listFileRefs(SCOPE).every((row) => row.taskId === undefined)).toBe(true);

    // 同码对照（reason 一一对应，不互串）：pending / 过期 / 不存在。
    const pending = fileStore.putFile({ scope: SCOPE, name: '待激活.csv', bytes: Buffer.from('p') });
    const expiredAt = Date.now() - FILE_REF_TTL_MS - 60_000;
    const expired = putActiveSource(fileStore, '过期.csv', Buffer.from('e'), expiredAt);
    expect(
      catchUnavailable(() => fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [pending.fileId], taskId: TASK_A })).reason,
    ).toBe(`pending:${pending.fileId}`);
    expect(
      catchUnavailable(() => fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [expired.fileId], taskId: TASK_A })).reason,
    ).toBe(`expired:${expired.fileId}`);
    expect(
      catchUnavailable(() => fileStore.copyInputsForTask({ scope: SCOPE, fileIds: ['file_absent'], taskId: TASK_A })).reason,
    ).toBe('missing_or_foreign:file_absent');
    // 只多了 pending/expired 两个源行，没有任何副本。
    expect(store.listFileRefs(SCOPE)).toHaveLength(beforeRows + 2);
    expect(store.listFileRefs(SCOPE).filter((row) => row.taskId !== undefined)).toHaveLength(0);
    store.close();
  });

  it('交办复制：同一 fileId 重复出现只复制一份（去重保序）', () => {
    const { store, fileStore } = makeFixture();
    const source = putActiveSource(fileStore, '重复.csv', Buffer.from('dup'));
    const copies = fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [source.fileId, source.fileId], taskId: TASK_A });
    expect(copies).toHaveLength(1);
    expect(store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK_A)).toHaveLength(1);
    store.close();
  });

  it('Main 清单（listActiveFiles）不含任务绑定行：副本不进 Main 的文件清单', () => {
    const { store, fileStore } = makeFixture();
    const source = putActiveSource(fileStore, '清单.csv', Buffer.from('m'));
    fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [source.fileId], taskId: TASK_A });

    const manifest = fileStore.listActiveFiles({ scope: SCOPE, now: Date.now() });
    expect(manifest.map((file) => file.fileId)).toEqual([source.fileId]);
    store.close();
  });

  it('作用域谓词对缺省行安全：task_id 缺省（NULL）行只归 Main；Worker 解析一律不可见', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const mainFile = putActiveSource(fileStore, 'main-only.csv', Buffer.from('m'));
    expect(store.getFileRef(mainFile.fileId, SCOPE, { side: 'main' })!.taskId).toBeUndefined();
    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_w3');
    const error = catchUnavailable(() =>
      fileStore.materializeInputs({
        runDir,
        scope: SCOPE,
        fileIds: [mainFile.fileId],
        resolution: { side: 'worker', taskId: TASK_A },
      }),
    );
    expect(error.code).toBe('FILE_REF_UNAVAILABLE');
    store.close();
  });
});
