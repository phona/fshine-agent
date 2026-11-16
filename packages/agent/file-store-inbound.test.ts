/**
 * 入站附件登记与激活（CAP-01 S1；docs/product/cap01-main-direct-execution.md §4/§8）。
 *
 * 覆盖：
 *   ① registerInboundFile：字节从源路径**流式**读、算 sha256、copy 进 workspace——登记为
 *      pending 行（activated_at NULL）；登记后源文件可删（不引用原路径），激活后物化读回字节一致；
 *   ② 激活（activatePendingInputs）：TTL 内 pending 全部激活；过期 pending 不激活；
 *      已激活不动（时间戳不变）；
 *   ③ 读路径同码（v8 §4）：越权 / 不存在 / 过期 → 同为 FILE_REF_UNAVAILABLE（防存在性
 *      oracle；机械 reason 只随异常对象带出，不进用户话术）；
 *   ④ 源不可读（缺失 / 目录 / symlink）→ 确定性拒收，不留行、不留半份。
 *
 * 库用 :memory:，workspace 用临时目录；不触网、不碰真实平台。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  sessionDirOf,
  type FileStore,
} from './src/file-store';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:u-s1', sessionId: 'cap01-s1' };

function makeFixture(): {
  fixtureRoot: string;
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
} {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'file-store-s1-'));
  dirs.push(fixtureRoot);
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  return { fixtureRoot, workspaceRoot, store, fileStore };
}

/** 渠道落盘形状的源文件：字节数跨流式块（64KB）边界，验流式哈希与拷贝。 */
function stagedSource(fixtureRoot: string, filename: string, totalBytes: number): { path: string; bytes: Buffer } {
  const bytes = randomBytes(totalBytes);
  const filePath = path.join(fixtureRoot, 'staging', filename);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  return { path: filePath, bytes };
}

describe('入站附件登记与激活（CAP-01 S1）', () => {
  it('① 流式登记为 pending：copy 进 workspace、sha256/bytes 一致；源删后仍可物化读回', () => {
    const { fixtureRoot, workspaceRoot, store, fileStore } = makeFixture();
    const source = stagedSource(fixtureRoot, '工资表.xlsx', 200 * 1024 + 7);
    const expectedSha = createHash('sha256').update(source.bytes).digest('hex');

    const registered = fileStore.registerInboundFile({ scope: SCOPE, name: '工资表.xlsx', sourcePath: source.path });

    expect(registered.fileId).toMatch(/^file_[0-9a-f]{32}$/);
    expect(registered.name).toBe('工资表.xlsx');
    expect(registered.bytes).toBe(source.bytes.length);
    expect(registered.sha256).toBe(expectedSha);

    const row = store.getFileRef(registered.fileId, SCOPE);
    expect(row).toBeDefined();
    expect(row?.activatedAt).toBeUndefined(); // pending：等带文字的消息激活
    expect(row?.bytes).toBe(source.bytes.length);
    expect(row?.sha256).toBe(expectedSha);

    // 副本在 workspace（派生布局）；登记后源文件可删——不引用原路径。
    const storagePath = fileStoragePathOf(workspaceRoot, SCOPE, registered.fileId, '工资表.xlsx');
    expect(readFileSync(storagePath)).toEqual(source.bytes);
    rmSync(source.path);

    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_t1');
    fileStore.activatePendingInputs({ scope: SCOPE, now: Date.now() });
    const materialized = fileStore.materializeInputs({ runDir, scope: SCOPE, fileIds: [registered.fileId] });
    expect(materialized).toHaveLength(1);
    expect(materialized[0]!.name).toBe('工资表.xlsx');
    expect(readFileSync(path.join(runDir, 'in', materialized[0]!.materializedName))).toEqual(source.bytes);
    store.close();
  });

  it('② 激活：TTL 内 pending 全部激活；过期 pending 不激活；已激活不动（时间戳不变）', () => {
    const { store, fileStore } = makeFixture();
    const fresh = fileStore.putFile({ scope: SCOPE, name: '新.txt', bytes: Buffer.from('x') }); // pending
    // 过期 pending（created_at 早于 TTL 窗口）——putFile 不收 createdAt，直接种子行。
    store.insertFileRef({
      fileId: 'file_stale_pending',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: '过期.xlsx',
      sha256: 'sha_stale',
      bytes: 1,
      createdAt: Date.now() - FILE_REF_TTL_MS - 60_000, // activatedAt 缺省 = pending
    });
    const now = Date.now();
    const already = fileStore.putFile({
      scope: SCOPE,
      name: '旧激活.txt',
      bytes: Buffer.from('y'),
      activatedAt: now - 5_000,
    });

    expect(fileStore.activatePendingInputs({ scope: SCOPE, now })).toBe(1);

    expect(store.getFileRef(fresh.fileId, SCOPE)?.activatedAt).toBe(now);
    expect(store.getFileRef('file_stale_pending', SCOPE)?.activatedAt).toBeUndefined(); // TTL 过期不激活
    expect(store.getFileRef(already.fileId, SCOPE)?.activatedAt).toBe(now - 5_000); // 已激活不动
    expect(fileStore.activatePendingInputs({ scope: SCOPE, now: Date.now() })).toBe(0); // 已无 TTL 内 pending
    store.close();
  });

  it('③ 读路径同码：越权 / 不存在 / 过期 → 同为 FILE_REF_UNAVAILABLE（防存在性 oracle）', () => {
    const { workspaceRoot, store, fileStore } = makeFixture();
    // 过期已激活行（activated_at 远早于 TTL 窗口）+ 落字节（排除 bytes_missing 干扰）。
    const expiredAt = Date.now() - 2 * FILE_REF_TTL_MS;
    store.insertFileRef({
      fileId: 'file_expired',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: '过期.xlsx',
      sha256: 'sha_e',
      bytes: 1,
      activatedAt: expiredAt,
      createdAt: expiredAt - 1_000,
    });
    const expiredStorage = fileStoragePathOf(workspaceRoot, SCOPE, 'file_expired', '过期.xlsx');
    mkdirSync(path.dirname(expiredStorage), { recursive: true });
    writeFileSync(expiredStorage, 'e');

    const foreign = fileStore.putFile({
      scope: { principalId: SCOPE.principalId, sessionId: 'other-session' },
      name: '他人.txt',
      bytes: Buffer.from('y'),
      activatedAt: Date.now(),
    });

    const runDir = runDirOf(workspaceRoot, SCOPE, 'run_t3');
    const cases: ReadonlyArray<readonly [string, string]> = [
      [foreign.fileId, '越权（他会话）'],
      ['file_absent', '不存在'],
      ['file_expired', '过期'],
    ];
    const reasons: string[] = [];
    for (const [fileId, label] of cases) {
      let caught: unknown;
      try {
        fileStore.materializeInputs({ runDir, scope: SCOPE, fileIds: [fileId] });
      } catch (error) {
        caught = error;
      }
      expect(caught, `${label} 必须被拒`).toBeInstanceOf(FileRefUnavailableError);
      const error = caught as FileRefUnavailableError;
      expect(error.code, `${label} 与其它拒绝同码`).toBe('FILE_REF_UNAVAILABLE');
      reasons.push(error.reason);
    }
    // 机械 reason 随异常带出（只进日志）：三种拒绝原因互不相同，但用户面同码。
    expect(new Set(reasons).size).toBe(3);
    store.close();
  });

  it('④ 源不可读（缺失 / 目录 / symlink）→ 确定性拒收，不留行、不留半份', () => {
    const { fixtureRoot, workspaceRoot, store, fileStore } = makeFixture();
    const staging = path.join(fixtureRoot, 'staging');
    mkdirSync(staging, { recursive: true });

    const before = store.listFileRefs(SCOPE).length;
    expect(() =>
      fileStore.registerInboundFile({ scope: SCOPE, name: '缺失.txt', sourcePath: path.join(staging, '不存在.txt') }),
    ).toThrow(/入站附件不可读/);
    expect(() => fileStore.registerInboundFile({ scope: SCOPE, name: '目录.txt', sourcePath: staging })).toThrow(
      /不是普通文件/,
    );
    // symlink 源（O_NOFOLLOW）按拒收。
    writeFileSync(path.join(staging, '真身.txt'), 'bytes');
    symlinkSync(path.join(staging, '真身.txt'), path.join(staging, '链接.txt'));
    expect(() =>
      fileStore.registerInboundFile({ scope: SCOPE, name: '链接.txt', sourcePath: path.join(staging, '链接.txt') }),
    ).toThrow(/入站附件不可读/);

    expect(store.listFileRefs(SCOPE).length).toBe(before); // 一次都没登记
    const filesDir = path.join(sessionDirOf(workspaceRoot, SCOPE), 'files');
    if (existsSync(filesDir)) expect(readdirSync(filesDir)).toEqual([]); // 无半成品
    store.close();
  });
});
