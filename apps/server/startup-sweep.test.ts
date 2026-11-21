/**
 * server 启动保留期清扫（`runtime.fileRetentionSweepOnStart`）的接线测试。
 *
 * 钉住三件事：
 *   · 缺省 false = 零行为：注入的清扫器零调用、无日志、磁盘不新建/不删除；
 *   · true = 调用一次真实执行器（dryRun=false），启动日志含删除/跳过计数与跳过原因分布；
 *   · 清扫抛错不阻断启动：只记观测事件，调用方继续后续装配步骤。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTaskStore } from '@fshine/core';
import type { FileRefCleanupResult } from '../../packages/agent/src/file-ref-cleanup';
import { resolveRuntimeConfig } from '../../packages/agent/src/resource-policy';
import type { RunDirCleanupEvent, RunDirCleanupResult } from '../../packages/agent/src/run-dir-cleanup';
import { sweepExpiredRunDirsOnStart } from './startup-sweep';

const DAY_MS = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'startup-sweep-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一个仓库布局的到期 run 目录（mtime = 31 天前，超过缺省 30 天保留期）。 */
function expiredRunDir(workspaceRoot: string): string {
  const runDir = path.join(
    workspaceRoot,
    '0123456789abcdef',
    'fedcba9876543210',
    'runs',
    `run_${'a'.repeat(32)}`,
  );
  mkdirSync(runDir, { recursive: true });
  const old = new Date(Date.now() - 31 * DAY_MS);
  utimesSync(runDir, old, old);
  return runDir;
}

describe('sweepExpiredRunDirsOnStart：缺省 false = 零行为', () => {
  it('缺省配置（fileRetentionSweepOnStart=false）→ 注入的清扫器零调用、零日志', () => {
    const workspaceRoot = tempDir();
    const sweep = vi.fn(() => {
      throw new Error('缺省关闭时不得调用清扫器');
    });
    const log = vi.fn();

    const result = sweepExpiredRunDirsOnStart({
      config: resolveRuntimeConfig(),
      workspaceRoot,
      sweep,
      log,
    });

    expect(resolveRuntimeConfig().fileRetentionSweepOnStart).toBe(false);
    expect(sweep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('缺省 false 时即使存在到期 run 目录也不删除、不打日志', () => {
    const workspaceRoot = tempDir();
    const runDir = expiredRunDir(workspaceRoot);
    const log = vi.fn();

    sweepExpiredRunDirsOnStart({ config: resolveRuntimeConfig(), workspaceRoot, log });

    expect(existsSync(runDir)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('sweepExpiredRunDirsOnStart：true = 启动时清扫一次', () => {
  it('调用一次（dryRun=false），启动日志含计数与跳过原因分布', () => {
    const events: RunDirCleanupEvent[] = [
      { event: 'run_dir_cleanup', action: 'deleted', path: '/ws/a' },
      { event: 'run_dir_cleanup', action: 'deleted', path: '/ws/b' },
      { event: 'run_dir_cleanup', action: 'kept', path: '/ws/c' },
      { event: 'run_dir_cleanup', action: 'skipped_symlink', path: '/ws/d' },
      { event: 'run_dir_cleanup', action: 'skipped_io_error', path: '/ws/e', reason: 'EACCES' },
    ];
    const cleanupResult: RunDirCleanupResult = {
      rootMissing: false,
      events,
      summary: { scanned: 5, deleted: 2, wouldDelete: 0, kept: 1, skipped: 2, failed: 0 },
    };
    const sweep = vi.fn(() => cleanupResult);
    const log = vi.fn();
    const config = resolveRuntimeConfig({ fileRetentionSweepOnStart: true, fileRetentionDays: 30 });

    const returned = sweepExpiredRunDirsOnStart({ config, workspaceRoot: '/ws', sweep, log });

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith({ workspaceRoot: '/ws', config, dryRun: false });
    expect(returned).toBe(cleanupResult);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toEqual({
      event: 'run_dir_cleanup_startup',
      workspaceRoot: '/ws',
      rootMissing: false,
      scanned: 5,
      deleted: 2,
      kept: 1,
      skipped: 2,
      failed: 0,
      skipReasons: { skipped_symlink: 1, skipped_io_error: 1 },
    });
  });

  it('真实执行器：到期 run 目录被删除，日志记 deleted=1', () => {
    const workspaceRoot = tempDir();
    const runDir = expiredRunDir(workspaceRoot);
    const log = vi.fn();

    sweepExpiredRunDirsOnStart({
      config: resolveRuntimeConfig({ fileRetentionSweepOnStart: true, fileRetentionDays: 30 }),
      workspaceRoot,
      log,
    });

    expect(existsSync(runDir)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({
      event: 'run_dir_cleanup_startup',
      deleted: 1,
      skipped: 0,
      failed: 0,
    });
  });
});

describe('sweepExpiredRunDirsOnStart：失败不阻断启动', () => {
  it('清扫抛错 → 不向上抛、记失败观测事件、调用方继续后续步骤', () => {
    const log = vi.fn();
    const sweep = (() => {
      throw new Error('boom');
    }) as () => RunDirCleanupResult;
    const steps: string[] = [];

    expect(() => {
      sweepExpiredRunDirsOnStart({
        config: resolveRuntimeConfig({ fileRetentionSweepOnStart: true }),
        workspaceRoot: '/ws',
        sweep,
        log,
      });
      // 启动装配点的后续步骤（main.ts 里是 startChannelForMode）必须继续执行。
      steps.push('start_channel');
    }).not.toThrow();

    expect(steps).toEqual(['start_channel']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toEqual({
      event: 'run_dir_cleanup_startup_failed',
      workspaceRoot: '/ws',
      reason: 'boom',
    });
  });
});

describe('sweepExpiredRunDirsOnStart：同一轮顺带回收过期 file_refs 字节', () => {
  function taskDb(dir: string): string {
    const dbPath = path.join(dir, 'state.db');
    openTaskStore(dbPath).close();
    return dbPath;
  }

  it('给出 dbPath 且库存在 → 文件引用回收执行器调用一次（dryRun=false），单独记启动日志', () => {
    const workspaceRoot = tempDir();
    const dbPath = taskDb(tempDir());
    const runDirs: RunDirCleanupResult = {
      rootMissing: false,
      events: [],
      summary: { scanned: 0, deleted: 0, wouldDelete: 0, kept: 0, skipped: 0, failed: 0 },
    };
    const fileRefs: FileRefCleanupResult = {
      rootMissing: false,
      events: [
        {
          event: 'file_ref_cleanup',
          action: 'deleted_bytes',
          fileId: 'file_x',
          path: path.join(workspaceRoot, 'file_x.csv'),
        },
        { event: 'file_ref_cleanup', action: 'skipped_symlink', fileId: 'file_y', path: path.join(workspaceRoot, 'file_y.csv') },
      ],
      summary: { scanned: 2, deleted: 1, wouldDelete: 0, kept: 0, bytesMissing: 0, skipped: 1, failed: 0 },
    };
    const sweep = vi.fn(() => runDirs);
    const fileRefSweep = vi.fn(() => fileRefs);
    const log = vi.fn();
    const config = resolveRuntimeConfig({ fileRetentionSweepOnStart: true });

    sweepExpiredRunDirsOnStart({ config, workspaceRoot, dbPath, sweep, fileRefSweep, log });

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(fileRefSweep).toHaveBeenCalledTimes(1);
    expect(fileRefSweep).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot,
      config,
      dryRun: false,
    }));
    const fileRefLog = log.mock.calls.map((call) => call[0]).find((event) => event['event'] === 'file_ref_cleanup_startup');
    expect(fileRefLog).toEqual({
      event: 'file_ref_cleanup_startup',
      workspaceRoot,
      rootMissing: false,
      scanned: 2,
      deleted: 1,
      bytesMissing: 0,
      kept: 0,
      skipped: 1,
      failed: 0,
      skipReasons: { skipped_symlink: 1 },
    });
  });

  it('未给 dbPath → 不做文件引用回收（零调用、零新增日志）', () => {
    const workspaceRoot = tempDir();
    const fileRefSweep = vi.fn();
    const log = vi.fn();
    sweepExpiredRunDirsOnStart({
      config: resolveRuntimeConfig({ fileRetentionSweepOnStart: true }),
      workspaceRoot,
      fileRefSweep,
      log,
    });
    expect(fileRefSweep).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => call[0]['event'])).toEqual(['run_dir_cleanup_startup']);
  });

  it('文件引用回收抛错 → 只记失败事件，run 目录结果照常返回（不阻断启动）', () => {
    const workspaceRoot = tempDir();
    const dbPath = taskDb(tempDir());
    const runDirs: RunDirCleanupResult = {
      rootMissing: false,
      events: [],
      summary: { scanned: 0, deleted: 0, wouldDelete: 0, kept: 0, skipped: 0, failed: 0 },
    };
    const fileRefSweep = (() => {
      throw new Error('disk-on-fire');
    }) as () => FileRefCleanupResult;
    const log = vi.fn();

    const returned = sweepExpiredRunDirsOnStart({
      config: resolveRuntimeConfig({ fileRetentionSweepOnStart: true }),
      workspaceRoot,
      dbPath,
      sweep: () => runDirs,
      fileRefSweep,
      log,
    });

    expect(returned).toBe(runDirs);
    expect(log.mock.calls.map((call) => call[0]['event'])).toEqual([
      'run_dir_cleanup_startup',
      'file_ref_cleanup_startup_failed',
    ]);
  });
});
