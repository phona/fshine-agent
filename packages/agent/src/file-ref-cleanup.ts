/**
 * file_refs 过期字节回收执行器（2026-11-18 owner，B 方案第 4 项）。
 *
 * 背景：文件引用有可读 TTL（`runtime.fileRefTtlDays`，缺省 7 天），过期后清单不再列出、
 * 引用得 FILE_REF_UNAVAILABLE——但字节此前**不回收**，磁盘只增不减。本模块把
 * 「过期 = 不可读」接到磁盘上，扩展既有保留期清扫入口（`npm run cleanup:runs` /
 * server 启动开关 `fileRetentionSweepOnStart`），不新增定时器。
 *
 * 边界（保守纪律与 run 目录回收同一套）：
 *   · **只处理底账里真实存在的行**：逐行按 (principal, session, file_id, name) 派生字节
 *     路径（与 file-store 同一公式），**不猜目录、不扫未知文件**；
 *   · **过期判据**：activated_at 非 NULL → now − activated_at > TTL；pending（NULL）→
 *     now − created_at > TTL（激活窗口已关闭，同样不可读）。未过期行一律不碰；
 *   · **根内包含判定**：派生路径 `path.resolve` 后必须严格落在 workspace 根内（带分隔符
 *     前缀），且 root → principal → session → files 目录链**逐层 `lstat`**——任一层是软链
 *     （或非目录）即 `skipped_symlink`，不删（词法前缀看不见父层软链，会把删除带到根外）；
 *   · **lstat 不跟随软链**：软链整项跳过；非普通文件跳过；删除前再 lstat 复核一次
 *     （TOCTOU 收窄到一次调用）；
 *   · **可空跑**：dryRun 下零删除，只报 `would_delete_bytes`；
 *   · **只删字节，不删行**：行保留做审计；删除后该 fileId 自然不可读（去重也检查字节
 *     存在），不会出现「引用得到行、读不到字节」的静默假成功；
 *   · **失败不中断**：单项 IO/删除失败只记事件，整轮继续。
 *
 * 配置来源：只读 `resolveRuntimeConfig` 的解析值（TTL 毫秒经 `fileRefTtlMsOf` 派生，
 * 唯一解释点），本模块不读原始 `config.runtime.*`、不重定义缺省。
 */
import { lstatSync, rmSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { FileRefRow, TaskStore } from '@fshine/core';
import { fileStoragePathOf, type FileScope } from './file-store';
import { fileRefTtlMsOf, type ResolvedRuntimeConfig } from './resource-policy';
// 机械原因原文与 run 目录回收**同一份实现**（issue #72 合并）：两套清扫执行器的保守纪律
// 同源，归属理由见 `run-dir-cleanup.ts` 的 `errorText` 注释。
import { errorText } from './run-dir-cleanup';

export type FileRefCleanupAction =
  | 'deleted_bytes'
  | 'would_delete_bytes'
  | 'kept'
  | 'bytes_missing'
  | 'skipped_symlink'
  | 'skipped_not_file'
  | 'skipped_outside_root'
  | 'skipped_io_error'
  | 'delete_failed';

/** 一条结构化回收事件（CLI/启动日志逐行输出；ops 观察面）。 */
export interface FileRefCleanupEvent {
  readonly event: 'file_ref_cleanup';
  readonly action: FileRefCleanupAction;
  readonly fileId: string;
  /** 派生的字节路径（绝对路径；本机 ops 面，不进用户话术）。 */
  readonly path: string;
  /** 行的年龄（ms；activated_at 优先，pending 用 created_at）。 */
  readonly ageMs?: number;
  /** 判定使用的可读期（天）。 */
  readonly ttlDays?: number;
  /** 机械原因（IO 错误 / 删除失败原文；不重写、不吞）。 */
  readonly reason?: string;
}

export interface FileRefCleanupSummary {
  readonly scanned: number;
  readonly deleted: number;
  readonly wouldDelete: number;
  readonly kept: number;
  /** 过期但字节已不在（已被删/从未落盘）。 */
  readonly bytesMissing: number;
  /** 全部 skipped_* 事件（symlink / 非普通文件 / 根外 / IO）。 */
  readonly skipped: number;
  /** 删除抛错数（`delete_failed`）。 */
  readonly failed: number;
}

export interface FileRefCleanupResult {
  /** workspace 根不存在（尚未产生任何文件区字节）= 正常空态，零事件。 */
  readonly rootMissing: boolean;
  readonly events: readonly FileRefCleanupEvent[];
  readonly summary: FileRefCleanupSummary;
}

export interface CleanupFileRefBytesInput {
  /** 底账行访问器（只读扫描；不删行、不写库）。 */
  readonly store: Pick<TaskStore, 'listAllFileRefs'>;
  readonly workspaceRoot: string;
  /** `resolveRuntimeConfig` 的解析值（TTL 的唯一来源；本模块不重读配置）。 */
  readonly config: ResolvedRuntimeConfig;
  /** 注入时钟（缺省 `Date.now`）。 */
  readonly nowMs?: number;
  readonly dryRun?: boolean;
  /** 删除动作注入（测试用；缺省 `rmSync` 单文件，不递归、不跟随软链）。 */
  readonly remove?: (filePath: string) => void;
}

interface Probe {
  readonly stat?: Stats;
  readonly code?: string;
  readonly message?: string;
}

function probe(target: string): Probe {
  try {
    return { stat: lstatSync(target) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    return { ...(typeof code === 'string' ? { code } : {}), message: errorText(error) };
  }
}

/** 行是否已过可读期：激活行按 activated_at，pending 按 created_at（激活窗口）。 */
function isExpiredRow(row: FileRefRow, nowMs: number, ttlMs: number): { expired: boolean; ageMs: number } {
  const anchor = row.activatedAt ?? row.createdAt;
  const ageMs = Math.max(0, nowMs - anchor);
  return { expired: ageMs > ttlMs, ageMs };
}

type ChainVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly action: FileRefCleanupAction; readonly reason?: string };

/**
 * 目录链逐层 `lstat`（root 之下到 files/）：**任一层是软链（或不是目录）→ 整项跳过**。
 *
 * 为什么不能只做词法前缀比较：派生路径 `path.resolve` 后看起来在根内，但父层（如
 * `<principal>/<session>/files`）本身是软链时，删除会沿着软链落到根外文件上——
 * 前缀比较只看字符串，看不见这一层。祖先不存在 = 派生字节不可能存在（按字节缺失处理）。
 * 与 `run-dir-cleanup.ts` 的逐层 lstat 纪律同一套。
 */
function directoryChainVerdict(dirs: readonly string[]): ChainVerdict {
  for (const dir of dirs) {
    const checked = probe(dir);
    if (checked.stat === undefined) {
      if (checked.code === 'ENOENT') return { ok: false, action: 'bytes_missing' };
      return { ok: false, action: 'skipped_io_error', reason: checked.message ?? 'lstat 失败' };
    }
    if (checked.stat.isSymbolicLink() || !checked.stat.isDirectory()) {
      return { ok: false, action: 'skipped_symlink' };
    }
  }
  return { ok: true };
}

/**
 * root 之下到目标父目录的每一层（`<principal>` → `<session>` → `files`；不含 root 自身）。
 * 按相对路径逐段拼出，不写死层数——布局派生的父链就是实际要校验的目录链。
 */
function directoryChainOf(root: string, target: string): string[] {
  const chain: string[] = [];
  let current = root;
  for (const segment of path.relative(root, path.dirname(target)).split(path.sep)) {
    if (segment === '') continue;
    current = path.join(current, segment);
    chain.push(current);
  }
  return chain;
}

function cleanupEvent(
  action: FileRefCleanupAction,
  row: FileRefRow,
  target: string,
  extra: { ageMs?: number; ttlDays?: number; reason?: string } = {},
): FileRefCleanupEvent {
  return { event: 'file_ref_cleanup', action, fileId: row.fileId, path: target, ...extra };
}

function summarize(events: readonly FileRefCleanupEvent[]): FileRefCleanupSummary {
  const summary = {
    scanned: events.length,
    deleted: 0,
    wouldDelete: 0,
    kept: 0,
    bytesMissing: 0,
    skipped: 0,
    failed: 0,
  };
  for (const event of events) {
    switch (event.action) {
      case 'deleted_bytes': summary.deleted += 1; break;
      case 'would_delete_bytes': summary.wouldDelete += 1; break;
      case 'kept': summary.kept += 1; break;
      case 'bytes_missing': summary.bytesMissing += 1; break;
      case 'delete_failed': summary.failed += 1; break;
      default: summary.skipped += 1; break;
    }
  }
  return summary;
}

/** 缺省删除：只删单个普通文件（recursive=false，绝不跟随软链）。 */
function defaultRemoveFile(target: string): void {
  rmSync(target, { recursive: false, force: false, maxRetries: 0 });
}

/**
 * 扫描底账全部文件事实行，删除已过可读期行的字节文件。
 *
 * 只遍历 `store.listAllFileRefs()` 返回的行；每行路径由布局公式派生并做根内包含判定。
 * 单项失败（symlink / 非普通文件 / 根外 / IO / 删除抛错）只记事件，整轮继续。
 */
export function cleanupExpiredFileRefBytes(input: CleanupFileRefBytesInput): FileRefCleanupResult {
  const root = path.resolve(input.workspaceRoot);
  const nowMs = input.nowMs ?? Date.now();
  const dryRun = input.dryRun === true;
  const remove = input.remove ?? defaultRemoveFile;
  const ttlMs = fileRefTtlMsOf(input.config);
  const ttlDays = input.config.fileRefTtlDays;
  const events: FileRefCleanupEvent[] = [];

  const rootProbe = probe(root);
  if (rootProbe.stat === undefined) {
    // 根不存在 = 还没产生任何 workspace 字节（正常空态；不是错误）。
    if (rootProbe.code === 'ENOENT') {
      return { rootMissing: true, events, summary: summarize(events) };
    }
    events.push({
      event: 'file_ref_cleanup',
      action: 'skipped_io_error',
      fileId: '',
      path: root,
      reason: rootProbe.message ?? 'workspace 根不可读',
    });
    return { rootMissing: false, events, summary: summarize(events) };
  }
  if (rootProbe.stat.isSymbolicLink()) {
    events.push({ event: 'file_ref_cleanup', action: 'skipped_symlink', fileId: '', path: root });
    return { rootMissing: false, events, summary: summarize(events) };
  }
  if (!rootProbe.stat.isDirectory()) {
    events.push({ event: 'file_ref_cleanup', action: 'skipped_not_file', fileId: '', path: root });
    return { rootMissing: false, events, summary: summarize(events) };
  }

  for (const row of input.store.listAllFileRefs()) {
    const scope: FileScope = { principalId: row.principalId, sessionId: row.sessionId };
    const target = path.resolve(fileStoragePathOf(root, scope, row.fileId, row.name));
    if (target === root || !target.startsWith(root + path.sep)) {
      events.push(cleanupEvent('skipped_outside_root', row, target));
      continue;
    }

    const { expired, ageMs } = isExpiredRow(row, nowMs, ttlMs);
    const timing = { ageMs, ttlDays };
    if (!expired) {
      events.push(cleanupEvent('kept', row, target, timing));
      continue;
    }

    // 根内判定不止词法前缀：<principal>/<session>/files 任一层是软链时，删除会沿软链
    // 落到根外——逐层 lstat，软链/非目录整项跳过（root 自身已在上方校验）。
    const chain = directoryChainVerdict(directoryChainOf(root, target));
    if (!chain.ok) {
      events.push(cleanupEvent(chain.action, row, target, {
        ...timing,
        ...(chain.reason === undefined ? {} : { reason: chain.reason }),
      }));
      continue;
    }

    const checked = probe(target);
    if (checked.stat === undefined) {
      if (checked.code === 'ENOENT') {
        events.push(cleanupEvent('bytes_missing', row, target, timing));
      } else {
        events.push(cleanupEvent('skipped_io_error', row, target, { ...timing, reason: checked.message ?? 'lstat 失败' }));
      }
      continue;
    }
    if (checked.stat.isSymbolicLink()) {
      events.push(cleanupEvent('skipped_symlink', row, target, timing));
      continue;
    }
    if (!checked.stat.isFile()) {
      events.push(cleanupEvent('skipped_not_file', row, target, timing));
      continue;
    }
    if (dryRun) {
      events.push(cleanupEvent('would_delete_bytes', row, target, timing));
      continue;
    }

    // 删除前复核（lstat → rm 之间的 TOCTOU 收窄）：仍是普通文件（非 symlink）才删。
    const recheck = probe(target);
    if (recheck.stat === undefined) {
      if (recheck.code === 'ENOENT') {
        events.push(cleanupEvent('bytes_missing', row, target, timing));
      } else {
        events.push(cleanupEvent('skipped_io_error', row, target, { ...timing, reason: recheck.message ?? 'lstat 失败' }));
      }
      continue;
    }
    if (recheck.stat.isSymbolicLink()) {
      events.push(cleanupEvent('skipped_symlink', row, target, timing));
      continue;
    }
    if (!recheck.stat.isFile()) {
      events.push(cleanupEvent('skipped_not_file', row, target, timing));
      continue;
    }

    try {
      remove(target);
    } catch (error) {
      events.push(cleanupEvent('delete_failed', row, target, { ...timing, reason: errorText(error) }));
      continue;
    }
    events.push(cleanupEvent('deleted_bytes', row, target, timing));
  }

  return { rootMissing: false, events, summary: summarize(events) };
}
