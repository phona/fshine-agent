/**
 * run 目录保留期**执行器**（`packages/agent/src/run-dir-cleanup.ts`）的确定性测试。
 *
 * 背景：`fileRetentionDecision` 此前只有纯判定、没有任何执行器调用——run 目录只增不减。
 * 本切片把判定接到一个**保守**执行器上（显式入口；server/ask 启动路径不调用）。
 *
 * TDD：先写本文件（模块尚不存在 → 红）→ 最小实现转绿 → 反向绊线（拿掉 symlink 守卫 /
 * dryRun 守卫 / 根内包含判定，对应用例必须重新红）。
 *
 * 安全不变量（逐条钉住）：
 *   ① 只处理 `<workspaceRoot>/<16hex>/<16hex>/runs/run_<32hex>` 这一种仓库自己的布局；
 *      不按前缀猜测、不遍历其它形状；
 *   ② 绝不解引用符号链接：lstat 判定，遇到 symlink 整目录跳过并记结构化事件（目标原样保留）；
 *   ③ 保守失败：非目录 / 路径逃出根 / 删除抛错 → 跳过或记失败事件，扫描继续；
 *   ④ dryRun 零删除，只报 `would_delete`；
 *   ⑤ 只删 run 目录本身——父目录（runs/、会话目录、principal 目录）与 files/ 等登记字节不动，
 *      也不触碰 file_refs 行（本模块不接任何 store 依赖）。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_DIR_NAME_PATTERN,
  cleanupExpiredRunDirs,
  cleanupOneRunDir,
} from './src/run-dir-cleanup';
import { FILE_RETENTION_DAY_MS, resolveRuntimeConfig } from './src/resource-policy';

/** 固定钟：执行器只接受调用方给的时间（与判定层同一纪律）。 */
const NOW = 1_800_000_000_000;
const DAY = FILE_RETENTION_DAY_MS;

/** 仓库布局里的身份目录名形状（sha256 前 16 hex，见 file-store.ts）。 */
const PRINCIPAL = 'a'.repeat(16);
const SESSION = 'b'.repeat(16);

/** 仓库自己生成的 runId 形状（run-js-executor.ts：`run_<uuid 去连字符>`）。 */
const RUN_OLD = `run_${'1'.repeat(32)}`;
const RUN_NEW = `run_${'2'.repeat(32)}`;
const RUN_OLD_B = `run_${'3'.repeat(32)}`;

let workspace: string;
let outsideRoot: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'fshine-run-cleanup-'));
  outsideRoot = mkdtempSync(path.join(tmpdir(), 'fshine-run-cleanup-outside-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

/** 把整棵 run 目录（含 out/ 产物）的 mtime 拨到 ageDays 天前。 */
function makeRunDir(runId: string, ageDays: number, root: string = workspace): string {
  const runDir = path.join(root, PRINCIPAL, SESSION, 'runs', runId);
  const outFile = path.join(runDir, 'out', '产物.txt');
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, 'artifact');
  const stamp = new Date(NOW - ageDays * DAY);
  utimesSync(outFile, stamp, stamp);
  utimesSync(path.dirname(outFile), stamp, stamp);
  utimesSync(runDir, stamp, stamp);
  return runDir;
}

const config30 = resolveRuntimeConfig({ fileRetentionDays: 30 });

function byPath(events: readonly { path: string }[], target: string) {
  return events.find((event) => event.path === target);
}

describe('仓库 run 目录布局匹配（只删自己拥有的目录）', () => {
  it('runId 形状 = run_<32 hex>；测试夹具用的形状必须命中', () => {
    expect(RUN_DIR_NAME_PATTERN.test(RUN_OLD)).toBe(true);
    expect(RUN_DIR_NAME_PATTERN.test('run-ok_9')).toBe(false);
    expect(RUN_DIR_NAME_PATTERN.test('run_w1')).toBe(false);
    expect(RUN_DIR_NAME_PATTERN.test(`run_${'g'.repeat(32)}`)).toBe(false);
    expect(RUN_DIR_NAME_PATTERN.test('run_short')).toBe(false);
  });

  it('不到期不删：29 天前的 run 目录判 kept，目录与产物原样保留', () => {
    const runDir = makeRunDir(RUN_NEW, 29);
    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(result.rootMissing).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ action: 'kept', path: runDir });
    expect(result.summary).toMatchObject({ scanned: 1, kept: 1, deleted: 0, wouldDelete: 0, failed: 0, skipped: 0 });
    expect(existsSync(path.join(runDir, 'out', '产物.txt'))).toBe(true);
  });

  it('到期就删：31 天前的 run 目录删除，父目录（runs/、会话、principal）仍在', () => {
    const runDir = makeRunDir(RUN_OLD, 31);
    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ action: 'deleted', path: runDir });
    expect(result.summary).toMatchObject({ scanned: 1, deleted: 1, kept: 0, failed: 0 });
    expect(existsSync(runDir)).toBe(false);

    // ⑤ 只删 run 目录本身：父目录必须仍在（不级联、不误删会话面）。
    expect(existsSync(path.join(workspace, PRINCIPAL, SESSION, 'runs'))).toBe(true);
    expect(existsSync(path.join(workspace, PRINCIPAL, SESSION))).toBe(true);
    expect(existsSync(path.join(workspace, PRINCIPAL))).toBe(true);
  });

  it('不在仓库布局里的旧目录一律不碰（不按名字/前缀猜测）', () => {
    // runs/ 下的非仓库形状（历史/夹具命名）。
    const oldDir = path.join(workspace, PRINCIPAL, SESSION, 'runs', 'run_w1_legacy');
    mkdirSync(oldDir, { recursive: true });
    const stamp = new Date(NOW - 365 * DAY);
    utimesSync(oldDir, stamp, stamp);
    // principal 层目录名不是 16 hex —— 整棵子树不遍历。
    const foreignDir = path.join(workspace, 'not-a-hash-dir', SESSION, 'runs', RUN_OLD);
    mkdirSync(foreignDir, { recursive: true });
    utimesSync(foreignDir, stamp, stamp);

    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(foreignDir)).toBe(true);
    expect(byPath(result.events, oldDir)).toMatchObject({ action: 'skipped_unexpected_name' });
    // 非布局子树既不删也不出现在事件里（不是 run 目录候选）。
    expect(byPath(result.events, foreignDir)).toBeUndefined();
    expect(result.summary.deleted).toBe(0);
  });
});

describe('dryRun：零删除，只报「本应删哪些」', () => {
  it('到期的 run 目录在 dryRun 下删零次：目录仍在、删除动作从未被调用', () => {
    const runDir = makeRunDir(RUN_OLD, 31);
    const removed: string[] = [];
    const result = cleanupExpiredRunDirs({
      workspaceRoot: workspace,
      config: config30,
      nowMs: NOW,
      dryRun: true,
      remove: (target) => removed.push(target),
    });

    expect(result.events[0]).toMatchObject({ action: 'would_delete', path: runDir });
    expect(result.summary).toMatchObject({ scanned: 1, wouldDelete: 1, deleted: 0 });
    expect(removed).toEqual([]);
    expect(existsSync(path.join(runDir, 'out', '产物.txt'))).toBe(true);
  });

  it('fileRetentionDays = 0（不清理旋钮）下永不到期：dryRun 也无 would_delete', () => {
    const runDir = makeRunDir(RUN_OLD, 3650);
    const result = cleanupExpiredRunDirs({
      workspaceRoot: workspace,
      config: resolveRuntimeConfig({ fileRetentionDays: 0 }),
      nowMs: NOW,
      dryRun: true,
    });

    expect(result.events[0]).toMatchObject({ action: 'kept', path: runDir });
    expect(result.summary).toMatchObject({ kept: 1, wouldDelete: 0 });
    expect(existsSync(runDir)).toBe(true);
  });
});

describe('符号链接：绝不解引用，整目录跳过并记事件', () => {
  it('run 目录是 symlink（指向根外旧目录）→ skipped_symlink，链接与目标都原样保留', () => {
    const targetDir = path.join(outsideRoot, '旧运行目录');
    const targetFile = path.join(targetDir, 'out', '产物.txt');
    mkdirSync(path.dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, 'target-artifact');
    const stamp = new Date(NOW - 365 * DAY);
    utimesSync(targetFile, stamp, stamp);
    utimesSync(path.dirname(targetFile), stamp, stamp);
    utimesSync(targetDir, stamp, stamp);

    const runsDir = path.join(workspace, PRINCIPAL, SESSION, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const linkPath = path.join(runsDir, RUN_OLD);
    symlinkSync(targetDir, linkPath, 'dir');

    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(byPath(result.events, linkPath)).toMatchObject({ action: 'skipped_symlink' });
    expect(result.summary.deleted).toBe(0);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(targetFile)).toBe(true);
  });

  it('runs/ 本身是 symlink → 整个会话跳过（skipped_symlink），不往下走', () => {
    const targetRuns = path.join(outsideRoot, 'runs');
    const targetRun = path.join(targetRuns, RUN_OLD);
    mkdirSync(targetRun, { recursive: true });
    const stamp = new Date(NOW - 365 * DAY);
    utimesSync(targetRun, stamp, stamp);

    const sessionDir = path.join(workspace, PRINCIPAL, SESSION);
    mkdirSync(sessionDir, { recursive: true });
    const linkPath = path.join(sessionDir, 'runs');
    symlinkSync(targetRuns, linkPath, 'dir');

    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(byPath(result.events, linkPath)).toMatchObject({ action: 'skipped_symlink' });
    expect(result.summary.deleted).toBe(0);
    expect(existsSync(targetRun)).toBe(true);
  });
});

describe('路径逃出根：跳过并记事件，根外目录原样保留', () => {
  it('cleanupOneRunDir 拒绝根外路径（含仅前缀相同的兄弟目录）', () => {
    const outsideRun = path.join(outsideRoot, 'run_outside');
    mkdirSync(outsideRun, { recursive: true });
    const stamp = new Date(NOW - 365 * DAY);
    utimesSync(outsideRun, stamp, stamp);

    const direct = cleanupOneRunDir({
      workspaceRoot: workspace,
      runDir: outsideRun,
      config: config30,
      nowMs: NOW,
      remove: () => {
        throw new Error('根外路径不得调用删除');
      },
    });
    expect(direct).toMatchObject({ action: 'skipped_outside_root', path: outsideRun });
    expect(existsSync(outsideRun)).toBe(true);

    // 前缀相同但不同目录（workspace-other 不是 workspace 的子目录）：同样拒绝。
    const sibling = `${workspace}-sibling`;
    mkdirSync(sibling, { recursive: true });
    const siblingRun = path.join(sibling, RUN_OLD);
    mkdirSync(siblingRun, { recursive: true });
    utimesSync(siblingRun, stamp, stamp);
    try {
      const prefixed = cleanupOneRunDir({
        workspaceRoot: workspace,
        runDir: siblingRun,
        config: config30,
        nowMs: NOW,
      });
      expect(prefixed).toMatchObject({ action: 'skipped_outside_root' });
      expect(existsSync(siblingRun)).toBe(true);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe('保守失败：单项失败不中断整轮', () => {
  it('一个 run 目录删除抛错 → delete_failed 事件，另一个照常删完', () => {
    const runA = makeRunDir(RUN_OLD, 31);
    const runB = makeRunDir(RUN_OLD_B, 31);
    const result = cleanupExpiredRunDirs({
      workspaceRoot: workspace,
      config: config30,
      nowMs: NOW,
      remove: (target) => {
        if (target === runA) throw new Error('EACCES: 模拟权限错误');
        rmSync(target, { recursive: true, force: false });
      },
    });

    expect(byPath(result.events, runA)).toMatchObject({ action: 'delete_failed', reason: 'EACCES: 模拟权限错误' });
    expect(byPath(result.events, runB)).toMatchObject({ action: 'deleted' });
    expect(result.summary).toMatchObject({ scanned: 2, failed: 1, deleted: 1 });
    expect(existsSync(runA)).toBe(true);   // 删除失败 = 什么都不动
    expect(existsSync(runB)).toBe(false);
  });

  it('run 目录候选是普通文件（非目录）→ skipped_not_directory，文件保留', () => {
    const runsDir = path.join(workspace, PRINCIPAL, SESSION, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const filePath = path.join(runsDir, RUN_OLD);
    writeFileSync(filePath, 'not-a-directory');

    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(byPath(result.events, filePath)).toMatchObject({ action: 'skipped_not_directory' });
    expect(existsSync(filePath)).toBe(true);
  });

  it('workspace 根本身不存在 → rootMissing，零事件零删除', () => {
    const result = cleanupExpiredRunDirs({
      workspaceRoot: path.join(workspace, 'missing-root'),
      config: config30,
      nowMs: NOW,
    });
    expect(result.rootMissing).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.summary.scanned).toBe(0);
  });
});

describe('不碰登记表与文件区字节（本切片只删磁盘 run 目录）', () => {
  it('会话 files/ 下的登记字节保留；执行器不依赖任何 store', () => {
    const filesDir = path.join(workspace, PRINCIPAL, SESSION, 'files');
    mkdirSync(filesDir, { recursive: true });
    const stored = path.join(filesDir, 'file_registered.xlsx');
    writeFileSync(stored, 'registered-bytes');
    const stamp = new Date(NOW - 365 * DAY);
    utimesSync(stored, stamp, stamp);
    utimesSync(filesDir, stamp, stamp);

    makeRunDir(RUN_OLD, 31);
    const result = cleanupExpiredRunDirs({ workspaceRoot: workspace, config: config30, nowMs: NOW });

    expect(result.summary.deleted).toBe(1);
    expect(existsSync(stored)).toBe(true);
  });
});
