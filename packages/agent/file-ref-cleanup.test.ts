/**
 * file_refs 过期字节回收（2026-11-18 owner，B 方案第 4 项）。
 *
 * 覆盖：
 *   · 过期激活行的字节被删、**行保留**（审计）；
 *   · 未过期激活行、TTL 内 pending 行（未过期）不删；
 *   · 过期 pending 行（激活窗口已关闭、同样不可读）字节回收；
 *   · dryRun 零删除，只报 would_delete_bytes；
 *   · 根外路径（行字段构造的穿越）不碰；软链不跟随（外部目标保留）；
 *   · TTL 来自 runtime.fileRefTtlDays（1 天 vs 缺省 7 天可观察）；空根 = 正常空态。
 *
 * 库用 :memory:，workspace 用临时目录；不触网、不碰真实平台。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTaskStore } from '@fshine/core';
import { createFileStore, fileStoragePathOf, sessionDirOf, type FileScope, type FileStore } from './src/file-store';
import { cleanupExpiredFileRefBytes } from './src/file-ref-cleanup';
import { resolveRuntimeConfig } from './src/resource-policy';

const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE: FileScope = { principalId: 'wecom:u-cleanup', sessionId: 'cap01-cleanup' };

interface Fixture {
  root: string;
  workspaceRoot: string;
  store: ReturnType<typeof openTaskStore>;
  fileStore: FileStore;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'file-ref-cleanup-'));
  dirs.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = openTaskStore(':memory:');
  const fileStore = createFileStore({ store, workspaceRoot });
  return { root, workspaceRoot, store, fileStore };
}

/** 手工种一行 + 写字节（pending / 软链 / 穿越等 putFile 造不出的形状）。 */
function seedRow(
  fixture: Fixture,
  input: { fileId: string; name: string; activatedAt?: number; createdAt: number; bytes?: Buffer },
): string {
  const target = fileStoragePathOf(fixture.workspaceRoot, SCOPE, input.fileId, input.name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, input.bytes ?? Buffer.from(input.fileId));
  fixture.store.insertFileRef({
    fileId: input.fileId,
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    name: input.name,
    sha256: `sha_${input.fileId}`,
    bytes: (input.bytes ?? Buffer.from(input.fileId)).length,
    ...(input.activatedAt === undefined ? {} : { activatedAt: input.activatedAt }),
    createdAt: input.createdAt,
  });
  return target;
}

describe('过期字节回收：删字节、留行', () => {
  it('过期激活行 → 字节删除、行保留（不可读判定已经生效）', () => {
    const fx = makeFixture();
    const now = Date.now();
    const expired = fx.fileStore.putFile({
      scope: SCOPE,
      name: '过期.csv',
      bytes: Buffer.from('old'),
      activatedAt: now - 8 * DAY_MS,
    });
    const target = fileStoragePathOf(fx.workspaceRoot, SCOPE, expired.fileId, '过期.csv');
    expect(existsSync(target)).toBe(true);

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(), // 缺省 7 天
      nowMs: now,
    });

    expect(existsSync(target)).toBe(false);
    expect(fx.store.listAllFileRefs().map((row) => row.fileId)).toEqual([expired.fileId]);
    expect(result.summary).toMatchObject({ scanned: 1, deleted: 1, kept: 0, failed: 0 });
    expect(result.events[0]).toMatchObject({
      event: 'file_ref_cleanup',
      action: 'deleted_bytes',
      fileId: expired.fileId,
      ttlDays: 7,
    });
    // 行还在、仍不可读：引用得 FILE_REF_UNAVAILABLE（走 TTL 判定），不会假成功。
    expect(() =>
      fx.fileStore.materializeInputs({
        runDir: path.join(fx.root, 'run'),
        scope: SCOPE,
        fileIds: [expired.fileId],
        resolution: { side: 'main' },
      }),
    ).toThrow(/FILE_REF_UNAVAILABLE/);
    fx.store.close();
  });

  it('未过期激活行 / TTL 内 pending 行不删（被引用的文件不回收）', () => {
    const fx = makeFixture();
    const now = Date.now();
    const fresh = fx.fileStore.putFile({
      scope: SCOPE,
      name: '六天.csv',
      bytes: Buffer.from('fresh'),
      activatedAt: now - 6 * DAY_MS,
    });
    const pendingTarget = seedRow(fx, {
      fileId: 'file_pending01',
      name: '待激活.csv',
      createdAt: now - 1 * DAY_MS,
    });

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });

    expect(result.summary).toMatchObject({ scanned: 2, deleted: 0, kept: 2 });
    expect(existsSync(fileStoragePathOf(fx.workspaceRoot, SCOPE, fresh.fileId, '六天.csv'))).toBe(true);
    expect(existsSync(pendingTarget)).toBe(true);
    fx.store.close();
  });

  it('过期 pending 行（激活窗口已关闭）字节同样回收', () => {
    const fx = makeFixture();
    const now = Date.now();
    const target = seedRow(fx, {
      fileId: 'file_pending02',
      name: '老待激活.csv',
      createdAt: now - 9 * DAY_MS,
    });

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });

    expect(existsSync(target)).toBe(false);
    expect(result.events[0]).toMatchObject({ action: 'deleted_bytes', fileId: 'file_pending02' });
    fx.store.close();
  });
});

describe('回收的安全边界：dryRun / 根外 / 软链 / 空根', () => {
  it('dryRun：零删除，只报 would_delete_bytes', () => {
    const fx = makeFixture();
    const now = Date.now();
    const expired = fx.fileStore.putFile({
      scope: SCOPE,
      name: '过期.csv',
      bytes: Buffer.from('old'),
      activatedAt: now - 30 * DAY_MS,
    });
    const target = fileStoragePathOf(fx.workspaceRoot, SCOPE, expired.fileId, '过期.csv');

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
      dryRun: true,
    });

    expect(existsSync(target)).toBe(true);
    expect(result.summary).toMatchObject({ deleted: 0, wouldDelete: 1 });
    expect(result.events[0]!.action).toBe('would_delete_bytes');
    fx.store.close();
  });

  it('根外路径（行字段构造的穿越）不碰：skipped_outside_root', () => {
    const fx = makeFixture();
    const now = Date.now();
    const outside = path.join(fx.root, 'outside-ref.txt');
    writeFileSync(outside, 'do-not-touch');
    fx.store.insertFileRef({
      fileId: '../../../../outside-ref',
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: 'evil.txt',
      sha256: 'sha_evil',
      bytes: 12,
      activatedAt: now - 30 * DAY_MS,
      createdAt: now - 30 * DAY_MS,
    });

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });

    expect(result.events[0]).toMatchObject({ action: 'skipped_outside_root' });
    expect(result.summary).toMatchObject({ deleted: 0, skipped: 1 });
    expect(existsSync(outside)).toBe(true);
    fx.store.close();
  });

  it('软链不跟随：skipped_symlink，外部目标保留', () => {
    const fx = makeFixture();
    const now = Date.now();
    const external = path.join(fx.root, 'external.txt');
    writeFileSync(external, 'external-bytes');
    const fileId = 'file_symlink01';
    const target = fileStoragePathOf(fx.workspaceRoot, SCOPE, fileId, '链接.csv');
    const filesDir = path.dirname(target);
    mkdirSync(filesDir, { recursive: true });
    symlinkSync(external, target);
    fx.store.insertFileRef({
      fileId,
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: '链接.csv',
      sha256: 'sha_sym',
      bytes: 14,
      activatedAt: now - 30 * DAY_MS,
      createdAt: now - 30 * DAY_MS,
    });

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });

    expect(result.events[0]).toMatchObject({ action: 'skipped_symlink' });
    expect(existsSync(external)).toBe(true);
    expect(existsSync(target)).toBe(true); // 软链本身也不删（保守）
    fx.store.close();
  });

  it('父层软链（<session>/files → 根外目录）不跟随：根外过期文件保留、skipped_symlink、deleted:0', () => {
    const fx = makeFixture();
    const now = Date.now();
    // 根外目录里放一个「本该被回收」的过期文件；词法路径仍在根内（<session>/files/...），
    // 但 <session>/files 整层是软链——纯 path.resolve 前缀比较会把它当根内并真的删掉。
    const outsideDir = path.join(fx.root, 'outside-files');
    mkdirSync(outsideDir, { recursive: true });
    const fileId = 'file_symlinked_files';
    const outsideTarget = path.join(outsideDir, `${fileId}.csv`);
    writeFileSync(outsideTarget, 'outside-bytes');
    const sessionDir = sessionDirOf(fx.workspaceRoot, SCOPE);
    mkdirSync(sessionDir, { recursive: true });
    symlinkSync(outsideDir, path.join(sessionDir, 'files'));
    fx.store.insertFileRef({
      fileId,
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      name: '根外.csv',
      sha256: 'sha_outside',
      bytes: 13,
      activatedAt: now - 30 * DAY_MS,
      createdAt: now - 30 * DAY_MS,
    });

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });

    expect(existsSync(outsideTarget)).toBe(true); // 根外字节未被删
    expect(result.events[0]).toMatchObject({ action: 'skipped_symlink', fileId });
    expect(result.summary).toMatchObject({ deleted: 0, skipped: 1 });
    fx.store.close();
  });

  it('删除抛错：该行记 delete_failed、同轮后续行仍被处理、summary.failed=1', () => {
    const fx = makeFixture();
    const now = Date.now();
    const failingId = 'file_delete_fail';
    const succeedingId = 'file_delete_ok';
    // created_at 升序 = 处理顺序：先失败项、后成功项（钉住「失败不中断整轮」）。
    seedRow(fx, {
      fileId: failingId,
      name: '删不掉.csv',
      activatedAt: now - 40 * DAY_MS,
      createdAt: now - 40 * DAY_MS,
    });
    seedRow(fx, {
      fileId: succeedingId,
      name: '能删.csv',
      activatedAt: now - 30 * DAY_MS,
      createdAt: now - 30 * DAY_MS,
    });
    const failingTarget = fileStoragePathOf(fx.workspaceRoot, SCOPE, failingId, '删不掉.csv');
    const succeedingTarget = fileStoragePathOf(fx.workspaceRoot, SCOPE, succeedingId, '能删.csv');

    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
      remove: (target) => {
        if (path.basename(target).startsWith(failingId)) throw new Error('EACCES: 注入的删除失败');
        rmSync(target);
      },
    });

    expect(result.events.map((event) => event.action)).toEqual(['delete_failed', 'deleted_bytes']);
    expect(result.events[0]).toMatchObject({
      action: 'delete_failed',
      fileId: failingId,
      reason: expect.stringContaining('注入的删除失败'),
    });
    expect(result.summary).toMatchObject({ scanned: 2, deleted: 1, failed: 1 });
    expect(existsSync(failingTarget)).toBe(true); // 失败项字节保留（不掩盖）
    expect(existsSync(succeedingTarget)).toBe(false); // 同轮后续行照常处理
    fx.store.close();
  });

  it('workspace 根不存在 = 正常空态（rootMissing，零事件零删除）', () => {
    const fx = makeFixture();
    const result = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: path.join(fx.root, 'absent-workspace'),
      config: resolveRuntimeConfig(),
    });
    expect(result.rootMissing).toBe(true);
    expect(result.events).toEqual([]);
    fx.store.close();
  });
});

describe('TTL 来源：runtime.fileRefTtlDays（不是写死常数）', () => {
  it('fileRefTtlDays=1：2 天前的行被回收；缺省 7 天同一行不回收', () => {
    const fx = makeFixture();
    const now = Date.now();
    const row = seedRow(fx, {
      fileId: 'file_two_days',
      name: '两天前.csv',
      activatedAt: now - 2 * DAY_MS,
      createdAt: now - 2 * DAY_MS,
    });

    const kept = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });
    expect(kept.events[0]!.action).toBe('kept');
    expect(existsSync(row)).toBe(true);

    const deleted = cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig({ fileRefTtlDays: 1 }),
      nowMs: now,
    });
    expect(deleted.events[0]).toMatchObject({ action: 'deleted_bytes', ttlDays: 1 });
    expect(existsSync(row)).toBe(false);
    fx.store.close();
  });

  it('回收后去重也不复用该行（字节存在校验与回收闭环）', () => {
    const fx = makeFixture();
    const now = Date.now();
    const expired = fx.fileStore.putFile({
      scope: SCOPE,
      name: '过期.csv',
      bytes: Buffer.from('gap'),
      activatedAt: now - 8 * DAY_MS,
    });
    cleanupExpiredFileRefBytes({
      store: fx.store,
      workspaceRoot: fx.workspaceRoot,
      config: resolveRuntimeConfig(),
      nowMs: now,
    });
    const staging = path.join(fx.root, 'staging');
    mkdirSync(staging, { recursive: true });
    const source = path.join(staging, 'gap.csv');
    writeFileSync(source, 'gap');

    const received = fx.fileStore.registerInboundFile({ scope: SCOPE, name: 'gap.csv', sourcePath: source });
    expect(received.fileId).not.toBe(expired.fileId);
    expect(fx.store.listFileRefs(SCOPE)).toHaveLength(2);
    // files/ 目录可见（断言只为确认 sessionDirOf 形状未变）。
    expect(existsSync(path.join(sessionDirOf(fx.workspaceRoot, SCOPE), 'files'))).toBe(true);
    fx.store.close();
  });
});
