/**
 * run 目录保留期**执行器**（显式 ops 入口；`resource-policy.ts` 的纯判定接到磁盘上）。
 *
 * 背景：`fileRetentionDecision` 只回答「该不该清」，此前没有任何执行器调用它——run 目录
 * 只增不减。本模块补上执行侧，但刻意保持**保守**：
 *
 *   · **只删自己拥有的目录**：唯一识别的布局是仓库自己的 workspace 面
 *     `<workspaceRoot>/<principalHash16hex>/<sessionHash16hex>/runs/run_<32hex>`
 *     （file-store.ts 的派生公式 / run-js-executor.ts 的 runId 生成）。其它名字
 *     （历史/夹具形状）只记 `skipped_unexpected_name`，不删；非哈希身份目录整棵不遍历。
 *   · **绝不解引用符号链接**：逐层 `lstat`，`runs/` 或 run 目录是 symlink 时整目录跳过并
 *     记事件；删除前再 `lstat` 复核一次（TOCTOU 收窄到一次调用）——目标仍是普通目录才删。
 *   · **根内包含判定**：删除目标 `path.resolve` 后必须严格落在根内（带分隔符前缀，
 *     防 `workspace-other` 这类前缀碰撞）；否则 `skipped_outside_root`，不删。
 *   · **保守失败**：非目录 / IO 错误 / 删除抛错 → 记结构化事件后继续下一个，不中断整轮、
 *     不"尽力而为"地删。
 *   · **可空跑**：`dryRun` 下零删除，只报 `would_delete`（删除动作一次都不调用）。
 *   · **只删磁盘目录**：本模块不接 store/registry，不删 `file_refs` 行；父目录（runs/、
 *     会话目录、principal 目录）与 `files/` 登记字节一律不动。
 *
 * 判定口径：run 目录的年龄取 `lstat().mtimeMs`（最后一次目录级改动）；是否到期仍由
 * `fileRetentionDecision` 决定（`runtime` 段 -> `resolveRuntimeConfig` 的解析值透传，
 * 不在本模块另读配置——单一配置源守卫 `resource-policy-single-source.test.ts` 覆盖）。
 *
 * 接线边界：`scripts/cleanup-runs.ts`（`npm run cleanup:runs`）显式调用；server 启动路径
 * 只在 `runtime.fileRetentionSweepOnStart=true` 时经 `apps/server/startup-sweep.ts` 调用一次
 * （开关缺省 false = 默认产品行为零变化，守卫见 `scripts/cleanup-runs.test.ts`）。
 */
import { lstatSync, readdirSync, rmSync, type Stats } from 'node:fs';
import path from 'node:path';
import { fileRetentionDecision, type ResolvedRuntimeConfig } from './resource-policy';

/**
 * 仓库自己生成的 run 目录名（run-js-executor.ts：`run_${randomUUID 去连字符}` =
 * `run_` + 32 位小写 hex）。**故意比 file-store 的 `RUN_ID_PATTERN` 更严**：只认现行
 * 生成器实际产出的形状，历史/夹具命名（`run_w1`、`run-ok_9` …）一律不删。
 */
export const RUN_DIR_NAME_PATTERN = /^run_[0-9a-f]{32}$/;

/** 身份目录名：sha256 前 16 位小写 hex（file-store.ts `hashId` 的形状）。 */
const HASH_DIR_NAME_PATTERN = /^[0-9a-f]{16}$/;

export type RunDirCleanupAction =
  | 'deleted'
  | 'would_delete'
  | 'kept'
  | 'skipped_symlink'
  | 'skipped_not_directory'
  | 'skipped_outside_root'
  | 'skipped_unexpected_name'
  | 'skipped_io_error'
  | 'delete_failed';

/** 一条结构化清理事件（CLI 逐行 JSON 输出；ops 观察面）。 */
export interface RunDirCleanupEvent {
  readonly event: 'run_dir_cleanup';
  readonly action: RunDirCleanupAction;
  /** 被检查/处理的目标路径（绝对路径；来自本机 ops 入口，不进用户话术）。 */
  readonly path: string;
  /** 判定层给出的年龄（ms；仅进入判定后的事件带）。 */
  readonly ageMs?: number;
  /** 判定层使用的保留期（天；仅进入判定后的事件带）。 */
  readonly retentionDays?: number;
  /** 机械原因（IO 错误 / 删除失败原文；不重写、不吞）。 */
  readonly reason?: string;
}

export interface RunDirCleanupSummary {
  /** 处理的 run 目录候选数（= 事件数；含被跳过的候选）。 */
  readonly scanned: number;
  readonly deleted: number;
  readonly wouldDelete: number;
  readonly kept: number;
  /** 全部 skipped_* 事件（symlink / 非目录 / 根外 / 非仓库形状 / IO）。 */
  readonly skipped: number;
  /** 删除抛错数（`delete_failed`）。 */
  readonly failed: number;
}

export interface RunDirCleanupResult {
  /** workspace 根不存在（尚未产生任何文件区字节）= 正常空态，零事件。 */
  readonly rootMissing: boolean;
  readonly events: readonly RunDirCleanupEvent[];
  readonly summary: RunDirCleanupSummary;
}

export interface CleanupRunDirsInput {
  readonly workspaceRoot: string;
  /** `resolveRuntimeConfig` 的解析值（判定层唯一入口；本模块不重读配置）。 */
  readonly config: ResolvedRuntimeConfig;
  /** 注入时钟（缺省 `Date.now`）。 */
  readonly nowMs?: number;
  readonly dryRun?: boolean;
  /** 删除动作注入（测试用；缺省 `rmSync(recursive)`，不跟随 symlink）。 */
  readonly remove?: (runDir: string) => void;
}

export interface CleanupOneRunDirInput extends CleanupRunDirsInput {
  /** 候选 run 目录（可以是任何路径——包含判定在这里兜底）。 */
  readonly runDir: string;
}

/**
 * 抛出值 → 机械原因原文（**全仓唯一一份**，issue #72 合并）。
 *
 * 原来是 6 份逐字相同的私有副本：本模块、`file-ref-cleanup.ts`（同一套保守纪律的姊妹
 * 执行器）、`scripts/cleanup-runs.ts` 与 `apps/server/startup-sweep.ts`（这两个清扫入口
 * 的驱动方）、`scripts/tasks.ts` 与 `scripts/ops.ts`（两个 CLI 面）。合并到这里的理由：
 * 这六处都在 `packages/agent/src` 的值图内（脚本/服务层本来就单向依赖它），**就近归属**
 * 到消费方最多的同层模块，不另建 utils 万能桶；定义点集合由
 * `packages/agent/dead-code-merge.test.ts` 钉住，再抄一份即红。
 *
 * 语义边界：只做「`Error` 取 message，其余 `String()`」——不解释、不归类、不套用户
 * 话术；产出的原文只进结构化事件的 `reason` 字段与 CLI stderr（机械事实面）。
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Probe {
  readonly stat?: Stats;
  readonly error?: { readonly message: string; readonly code?: string };
}

/** `lstat`（不跟随 symlink）+ 错误原文/errno code（区分「不存在」与其它 IO 错误）。 */
function probe(target: string): Probe {
  try {
    return { stat: lstatSync(target) };
  } catch (error) {
    const rawCode = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    return {
      error: {
        message: errorText(error),
        ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
      },
    };
  }
}

function cleanupEvent(
  action: RunDirCleanupAction,
  target: string,
  extra: { ageMs?: number; retentionDays?: number; reason?: string } = {},
): RunDirCleanupEvent {
  return { event: 'run_dir_cleanup', action, path: target, ...extra };
}

/** 缺省删除：recursive 删除目录树；不跟 symlink（遇到链接本身只 unlink）；ENOENT 照实报错。 */
function defaultRemoveRunDir(target: string): void {
  rmSync(target, { recursive: true, force: false, maxRetries: 0 });
}

/**
 * 处理单个 run 目录候选（扫描器逐项调用；也是根内包含判定的唯一落点）。
 *
 * 顺序 = 安全闸门顺序：根内包含 → lstat（symlink 整目录跳过）→ 目录 → 保留判定 →
 * dryRun → 删除前复核 → 删除（失败只记事件）。
 */
export function cleanupOneRunDir(input: CleanupOneRunDirInput): RunDirCleanupEvent {
  const root = path.resolve(input.workspaceRoot);
  const target = path.resolve(input.runDir);
  // 严格子路径（带分隔符）：`root` 自身与 `root-other` 这类前缀碰撞都不算根内。
  if (target === root || !target.startsWith(root + path.sep)) {
    return cleanupEvent('skipped_outside_root', target);
  }

  const first = probe(target);
  if (first.error !== undefined) {
    return cleanupEvent('skipped_io_error', target, { reason: first.error.message });
  }
  const stat = first.stat!;
  if (stat.isSymbolicLink()) return cleanupEvent('skipped_symlink', target);
  if (!stat.isDirectory()) return cleanupEvent('skipped_not_directory', target);

  const decision = fileRetentionDecision(input.config, {
    createdAtMs: stat.mtimeMs,
    nowMs: input.nowMs ?? Date.now(),
  });
  const timing = { ageMs: decision.ageMs, retentionDays: decision.retentionDays };
  if (decision.verdict === 'keep') return cleanupEvent('kept', target, timing);
  if (input.dryRun === true) return cleanupEvent('would_delete', target, timing);

  // 删除前复核（lstat → rm 之间的 TOCTOU 收窄）：目标仍是普通目录（非 symlink）才删。
  const recheck = probe(target);
  if (recheck.error !== undefined) {
    return cleanupEvent('skipped_io_error', target, { ...timing, reason: recheck.error.message });
  }
  if (recheck.stat!.isSymbolicLink()) return cleanupEvent('skipped_symlink', target, timing);
  if (!recheck.stat!.isDirectory()) return cleanupEvent('skipped_not_directory', target, timing);

  try {
    (input.remove ?? defaultRemoveRunDir)(target);
  } catch (error) {
    return cleanupEvent('delete_failed', target, { ...timing, reason: errorText(error) });
  }
  return cleanupEvent('deleted', target, timing);
}

/** 读目录条目；失败（权限等）记事件并返回 undefined（扫描继续）。 */
function listEntries(dir: string, events: RunDirCleanupEvent[]): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch (error) {
    events.push(cleanupEvent('skipped_io_error', dir, { reason: errorText(error) }));
    return undefined;
  }
}

/**
 * 目录级遍历（`lstat`，不跟随）：不存在 = 跳过（正常空态）；symlink = 整目录跳过并记事件；
 * 非目录 = 跳过并记事件；其它 IO 错误同样只记事件。
 */
function descend(
  dir: string,
  events: RunDirCleanupEvent[],
): 'directory' | 'skip' {
  const checked = probe(dir);
  if (checked.error !== undefined) {
    if (checked.error.code !== 'ENOENT') {
      events.push(cleanupEvent('skipped_io_error', dir, { reason: checked.error.message }));
    }
    return 'skip';
  }
  if (checked.stat!.isSymbolicLink()) {
    events.push(cleanupEvent('skipped_symlink', dir));
    return 'skip';
  }
  if (!checked.stat!.isDirectory()) {
    events.push(cleanupEvent('skipped_not_directory', dir));
    return 'skip';
  }
  return 'directory';
}

function summarize(events: readonly RunDirCleanupEvent[]): RunDirCleanupSummary {
  const summary = { scanned: events.length, deleted: 0, wouldDelete: 0, kept: 0, skipped: 0, failed: 0 };
  for (const event of events) {
    switch (event.action) {
      case 'deleted': summary.deleted += 1; break;
      case 'would_delete': summary.wouldDelete += 1; break;
      case 'kept': summary.kept += 1; break;
      case 'delete_failed': summary.failed += 1; break;
      default: summary.skipped += 1; break;
    }
  }
  return summary;
}

/**
 * 扫描 workspace 根并按保留期清理到期 run 目录。
 *
 * 只遍历 `root/<16hex>/<16hex>/runs/<run_32hex>`；任何一层不匹配布局都不往下猜。
 * 单项失败（symlink / 非目录 / 根外 / IO / 删除抛错）只记事件，整轮继续。
 */
export function cleanupExpiredRunDirs(input: CleanupRunDirsInput): RunDirCleanupResult {
  const root = path.resolve(input.workspaceRoot);
  const nowMs = input.nowMs ?? Date.now();
  const dryRun = input.dryRun === true;
  const remove = input.remove;
  const events: RunDirCleanupEvent[] = [];

  const rootProbe = probe(root);
  if (rootProbe.error !== undefined) {
    // 根不存在 = 还没产生任何 workspace 字节（正常空态；不是错误）。
    if (rootProbe.error.code === 'ENOENT') {
      return { rootMissing: true, events, summary: summarize(events) };
    }
    events.push(cleanupEvent('skipped_io_error', root, { reason: rootProbe.error.message }));
    return { rootMissing: false, events, summary: summarize(events) };
  }
  if (rootProbe.stat!.isSymbolicLink()) {
    events.push(cleanupEvent('skipped_symlink', root));
    return { rootMissing: false, events, summary: summarize(events) };
  }
  if (!rootProbe.stat!.isDirectory()) {
    events.push(cleanupEvent('skipped_not_directory', root));
    return { rootMissing: false, events, summary: summarize(events) };
  }

  const principalNames = listEntries(root, events);
  if (principalNames === undefined) return { rootMissing: false, events, summary: summarize(events) };

  for (const principalName of principalNames) {
    // 身份目录名必须是 16 位小写 hex：其它条目不是本仓布局，不遍历、不猜。
    if (!HASH_DIR_NAME_PATTERN.test(principalName)) continue;
    const principalDir = path.join(root, principalName);
    if (descend(principalDir, events) !== 'directory') continue;

    const sessionNames = listEntries(principalDir, events);
    if (sessionNames === undefined) continue;
    for (const sessionName of sessionNames) {
      if (!HASH_DIR_NAME_PATTERN.test(sessionName)) continue;
      const sessionDir = path.join(principalDir, sessionName);
      if (descend(sessionDir, events) !== 'directory') continue;

      const runsDir = path.join(sessionDir, 'runs');
      if (descend(runsDir, events) !== 'directory') continue;

      const runNames = listEntries(runsDir, events);
      if (runNames === undefined) continue;
      for (const runName of runNames) {
        const runDir = path.join(runsDir, runName);
        // 名字不是仓库生成的 run 形状：只记事件，不删（比「看起来像 run 目录」更保守）。
        if (!RUN_DIR_NAME_PATTERN.test(runName)) {
          events.push(cleanupEvent('skipped_unexpected_name', runDir));
          continue;
        }
        events.push(cleanupOneRunDir({
          workspaceRoot: root,
          runDir,
          config: input.config,
          nowMs,
          dryRun,
          ...(remove === undefined ? {} : { remove }),
        }));
      }
    }
  }

  return { rootMissing: false, events, summary: summarize(events) };
}
