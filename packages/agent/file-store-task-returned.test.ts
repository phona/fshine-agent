/**
 * 任务回程文件登记与任务产物去重（CAP-01 S2 ③⑤；docs/product/cap01-main-direct-execution.md §4/§6/§10-3）。
 *
 * 覆盖：
 *   · registerTaskFile（内联字节）：新 file_id + task_id 绑定 + 登记即激活；
 *     同 (scope, taskId, sha256) 再次登记 → **复用旧 fileId、不重复落盘、不新增行**（ask ⑤）；
 *     不同任务同字节 → 新 file_id（任务产物池不跨任务；Main 侧行也不参与复用）；
 *   · registerTaskFileFromPath（路径源）：allowedRoot 包含性（外部绝对路径拒收
 *     path_outside_task_dir、相对路径拒收 path_not_absolute）；O_NOFOLLOW（symlink →
 *     symlink_or_gone）与 fd fstat 纪律（hardlink → linked、目录 → not_regular_file、
 *     超限 → size_limit）；同 sha 复用旧 fileId（两遍读取一致性核对）；
 *   · registerOutputsFromOut 带 taskId（任务 out/ 兜底扫描的去重面）：产物绑定任务；
 *     **重扫同目录 → 复用同一 fileId、行数不增、files/ 不多落盘**（v8 §10-3：unexecuted/
 *     failed 也扫 out/，扫到的必须与已登记产物同池去重）；
 *   · listTaskFiles：只含当前任务绑定、已激活且 TTL 内的行（目录桥物化源）；
 *     过期任务行不可见（与 resolveReadableFile 同一 TTL 谓词）。
 *
 * 库用 :memory:，workspace 与任务暂存目录都用临时目录；不触网、不碰真实平台。
 */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import {
  createFileStore,
  fileStoragePathOf,
  sessionDirOf,
  TaskFileRejectedError,
  runDirOf,
  type FileStore,
} from './src/file-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:u-s2b', sessionId: 'cap01-s2b' };
const TASK_A = 'task_aaaa';
const TASK_B = 'task_bbbb';

function makeFixture(): {
  root: string;
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-store-s2b-'));
  dirs.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  return { root, workspaceRoot, store, fileStore };
}

/** files/ 目录里的实际落盘份数（去重「不重复落盘」的可观察面；目录未创建 = 0）。 */
function storedFileCount(workspaceRoot: string): number {
  const filesDir = path.join(sessionDirOf(workspaceRoot, SCOPE), 'files');
  return existsSync(filesDir) ? readdirSync(filesDir).length : 0;
}

function catchRejected(fn: () => unknown): TaskFileRejectedError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskFileRejectedError);
    return error as TaskFileRejectedError;
  }
  throw new Error('预期 TaskFileRejectedError 未抛出');
}

describe('registerTaskFile：任务回程内联字节登记 + sha256 去重（ask ⑤）', () => {
  it('⑤ 同 sha256 **同名**两次登记 → 复用同一 fileId；同字节不同名各自成行（2026-11-17 修）', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const bytes = Buffer.from('季度汇总,v1\n合计,42\n');
    const first = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_A, name: '汇总.xlsx', bytes, maxFileBytes: 1024 });
    expect(first.fileId).toMatch(/^file_[0-9a-f]{32}$/);
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(first.bytes).toBe(bytes.length);

    // 同名同字节 → 复用旧 fileId（去重仍然生效）。
    const again = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_A, name: '汇总.xlsx', bytes, maxFileBytes: 1024 });
    expect(again.fileId).toBe(first.fileId);
    expect(storedFileCount(workspaceRoot)).toBe(1);

    // 同字节**不同名** → 不复用：名字是交付面的用户可见事实，不能被旧行吞掉。
    const renamed = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_A, name: '汇总副本.csv', bytes, maxFileBytes: 1024 });
    expect(renamed.fileId).not.toBe(first.fileId);
    expect(renamed.name).toBe('汇总副本.csv');
    const rows = store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK_A);
    expect(rows.map((row) => row.name).sort()).toEqual(['汇总.xlsx', '汇总副本.csv']);
    store.close();
  });

  it('不同任务 / Main 侧同字节不复用：任务产物池不跨任务、不跨解析侧', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const bytes = Buffer.from('same-bytes');
    const taskA = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_A, name: 'a.csv', bytes, maxFileBytes: 1024 });
    const taskB = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_B, name: 'b.csv', bytes, maxFileBytes: 1024 });
    const mainSide = fileStore.putFile({ scope: SCOPE, name: 'main.csv', bytes, activatedAt: Date.now() });
    expect(taskB.fileId).not.toBe(taskA.fileId);
    expect(mainSide.fileId).not.toBe(taskA.fileId);
    // 三行三份字节（Main 侧行 + 两个任务行）。
    expect(store.listFileRefs(SCOPE)).toHaveLength(3);
    expect(storedFileCount(workspaceRoot)).toBe(3);
    store.close();
  });

  it('超限拒收（size_limit）：不登记、不落盘', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    const error = catchRejected(() =>
      fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_A, name: '大.bin', bytes: Buffer.alloc(64, 7), maxFileBytes: 8 }),
    );
    expect(error.reason).toBe('size_limit');
    expect(store.listFileRefs(SCOPE)).toHaveLength(0);
    expect(storedFileCount(workspaceRoot)).toBe(0);
    store.close();
  });
});

describe('registerTaskFileFromPath：路径源登记（allowedRoot 包含性 + fd 纪律 + 去重）', () => {
  it('任务目录内的文件登记成新 file_id（task 绑定、字节一致）；同 sha 复用旧 fileId', () => {
    const { root, workspaceRoot, store, fileStore } = makeFixture();
    const taskDir = path.join(root, 'tmp', `task_${TASK_A}`);
    mkdirSync(taskDir, { recursive: true });
    const bytes = Buffer.from('执行层产物,P1\n合计,7\n');
    const source = path.join(taskDir, 'out', 'result.csv');
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, bytes);

    const first = fileStore.registerTaskFileFromPath({
      scope: SCOPE,
      taskId: TASK_A,
      sourcePath: source,
      allowedRoot: taskDir,
      name: 'result.csv',
      maxFileBytes: 1024,
    });
    expect(first.fileId).toMatch(/^file_[0-9a-f]{32}$/);
    expect(first.bytes).toBe(bytes.length);
    expect(createHash('sha256').update(readFileSync(fileStoragePathOf(workspaceRoot, SCOPE, first.fileId, first.name))).digest('hex'))
      .toBe(first.sha256);
    const row = store.getFileRef(first.fileId, SCOPE, { side: 'worker', taskId: TASK_A })!;
    expect(row.taskId).toBe(TASK_A);
    expect(row.activatedAt).toBeDefined();

    // 同字节再登记（同一源文件再返回一次）→ 复用旧 fileId、不重复落盘。
    const second = fileStore.registerTaskFileFromPath({
      scope: SCOPE,
      taskId: TASK_A,
      sourcePath: source,
      allowedRoot: taskDir,
      name: 'result.csv',
      maxFileBytes: 1024,
    });
    expect(second.fileId).toBe(first.fileId);
    expect(store.listFileRefs(SCOPE).filter((row2) => row2.taskId === TASK_A)).toHaveLength(1);
    expect(storedFileCount(workspaceRoot)).toBe(1);
    store.close();
  });

  it('allowedRoot 包含性：目录外绝对路径与相对路径都拒收（机械 reason 一一对应）', () => {
    const { root, workspaceRoot, store, fileStore } = makeFixture();
    const taskDir = path.join(root, 'tmp', `task_${TASK_A}`);
    mkdirSync(taskDir, { recursive: true });
    const outside = path.join(root, 'outside.csv');
    writeFileSync(outside, Buffer.from('outside'));

    expect(
      catchRejected(() =>
        fileStore.registerTaskFileFromPath({ scope: SCOPE, taskId: TASK_A, sourcePath: outside, allowedRoot: taskDir, name: 'x.csv', maxFileBytes: 1024 }),
      ).reason,
    ).toBe('path_outside_task_dir');
    expect(
      catchRejected(() =>
        fileStore.registerTaskFileFromPath({ scope: SCOPE, taskId: TASK_A, sourcePath: 'tmp/rel.csv', allowedRoot: taskDir, name: 'x.csv', maxFileBytes: 1024 }),
      ).reason,
    ).toBe('path_not_absolute');
    // 拒收零副作用：无行、无落盘。
    expect(store.listFileRefs(SCOPE)).toHaveLength(0);
    expect(storedFileCount(workspaceRoot)).toBe(0);
    store.close();
  });

  it('fd 纪律：symlink（O_NOFOLLOW）→ symlink_or_gone；hardlink → linked；目录 → not_regular_file；超限 → size_limit', () => {
    const { root, workspaceRoot, store, fileStore } = makeFixture();
    const taskDir = path.join(root, 'tmp', `task_${TASK_A}`);
    mkdirSync(taskDir, { recursive: true });
    const realFile = path.join(taskDir, 'real.csv');
    writeFileSync(realFile, Buffer.from('real'));
    symlinkSync(realFile, path.join(taskDir, 'link.csv'));
    const hardTarget = path.join(taskDir, 'hard-src.csv');
    writeFileSync(hardTarget, Buffer.from('hard'));
    linkSync(hardTarget, path.join(taskDir, 'hard.csv'));

    mkdirSync(path.join(taskDir, '子目录'), { recursive: true });
    const attempt = (sourcePath: string, name: string, maxFileBytes = 1024) => () =>
      fileStore.registerTaskFileFromPath({ scope: SCOPE, taskId: TASK_A, sourcePath, allowedRoot: taskDir, name, maxFileBytes });
    expect(catchRejected(attempt(path.join(taskDir, 'link.csv'), 'link.csv')).reason).toBe('symlink_or_gone');
    expect(catchRejected(attempt(path.join(taskDir, 'hard.csv'), 'hard.csv')).reason).toBe('linked');
    expect(catchRejected(attempt(path.join(taskDir, '子目录'), 'dir')).reason).toBe('not_regular_file');
    // allowedRoot 本身不算「其内」（登记对象必须是目录下的文件）。
    expect(catchRejected(attempt(taskDir, 'root-itself')).reason).toBe('path_outside_task_dir');
    expect(catchRejected(attempt(realFile, 'big.csv', 1)).reason).toBe('size_limit'); // maxFileBytes=1 < 4 字节
    // 零副作用。
    expect(store.listFileRefs(SCOPE)).toHaveLength(0);
    expect(storedFileCount(workspaceRoot)).toBe(0);
    store.close();
  });
});

describe('registerOutputsFromOut 带 taskId：任务 out/ 兜底扫描（v8 §10-3）', () => {
  it('产物绑定任务登记；重扫同目录复用同一 fileId（不重复落盘、不新增行）', () => {
    const { root, workspaceRoot, store, fileStore } = makeFixture();
    const taskDir = path.join(root, 'tmp', `task_${TASK_A}`);
    mkdirSync(path.join(taskDir, 'out'), { recursive: true });
    writeFileSync(path.join(taskDir, 'out', '汇总.csv'), Buffer.from('汇总,1\n'));

    const first = fileStore.registerOutputsFromOut({
      runDir: taskDir,
      scope: SCOPE,
      limits: { maxFileBytes: 1024, maxCount: 5 },
      taskId: TASK_A,
    });
    expect(first.outputs).toHaveLength(1);
    expect(first.outputs[0]!.name).toBe('汇总.csv');
    expect(store.getFileRef(first.outputs[0]!.fileId, SCOPE, { side: 'worker', taskId: TASK_A })!.taskId).toBe(TASK_A);

    // 重扫（unexecuted/failed 收尾的兜底扫同一路径）：同 sha 复用旧 fileId，零新增。
    const second = fileStore.registerOutputsFromOut({
      runDir: taskDir,
      scope: SCOPE,
      limits: { maxFileBytes: 1024, maxCount: 5 },
      taskId: TASK_A,
    });
    expect(second.outputs).toHaveLength(1);
    expect(second.outputs[0]!.fileId).toBe(first.outputs[0]!.fileId);
    expect(store.listFileRefs(SCOPE).filter((row) => row.taskId === TASK_A)).toHaveLength(1);
    expect(storedFileCount(workspaceRoot)).toBe(1);
    store.close();
  });

  it('不带 taskId 的扫箱与改造前一致：Main 侧行（task_id NULL），重复扫箱产生新 file_id（S1 语义不变）', () => {
    const { root, workspaceRoot, store, fileStore } = makeFixture();
    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_main1');
    mkdirSync(path.join(runDir, 'out'), { recursive: true });
    writeFileSync(path.join(runDir, 'out', 'm.csv'), Buffer.from('main-product'));

    const first = fileStore.registerOutputsFromOut({ runDir, scope: SCOPE, limits: { maxFileBytes: 1024, maxCount: 5 } });
    const second = fileStore.registerOutputsFromOut({ runDir, scope: SCOPE, limits: { maxFileBytes: 1024, maxCount: 5 } });
    expect(first.outputs[0]!.fileId).not.toBe(second.outputs[0]!.fileId);
    expect(store.listFileRefs(SCOPE).every((row) => row.taskId === undefined)).toBe(true);
    expect(store.listFileRefs(SCOPE)).toHaveLength(2);
    store.close();
  });
});

describe('listTaskFiles：目录桥物化源（只含当前任务绑定、已激活且 TTL 内）', () => {
  it('Main 侧行与其他任务的行都不可见；本任务行投影三字段（fileId/name/bytes，无行数据）', () => {
    const { store, fileStore } = makeFixture();
    const mainFile = fileStore.putFile({ scope: SCOPE, name: 'main.csv', bytes: Buffer.from('m'), activatedAt: Date.now() });
    const [copy] = fileStore.copyInputsForTask({ scope: SCOPE, fileIds: [mainFile.fileId], taskId: TASK_A });
    const otherTask = fileStore.registerTaskFile({ scope: SCOPE, taskId: TASK_B, name: 'b.csv', bytes: Buffer.from('b'), maxFileBytes: 1024 });

    const taskFiles = fileStore.listTaskFiles({ scope: SCOPE, taskId: TASK_A, now: Date.now() });
    expect(taskFiles.map((file) => file.fileId)).toEqual([copy!.fileId]);
    expect(taskFiles.map((file) => file.fileId)).not.toContain(mainFile.fileId);
    expect(taskFiles.map((file) => file.fileId)).not.toContain(otherTask.fileId);
    for (const file of taskFiles) {
      expect(Object.keys(file).sort()).toEqual(['bytes', 'fileId', 'name']);
    }
    store.close();
  });
});
