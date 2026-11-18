/**
 * 文件区监管 fileStore（CAP-01 S0；docs/architecture/files.md §1/§2/§3/§4）。
 *
 * 职责：workspace 布局派生 + 文件字节与 file_refs 行的**唯一写侧**（putFile 落新文件 /
 * materializeInputs 物化输入 / registerOutputsFromOut 从交付箱 copy-on-register 登记产物 /
 * copyInputsForTask 交办时复制任务副本 / listTaskFiles 任务文件面 + registerTaskFile·
 * registerTaskFileFromPath 执行层回程产物登记——任务产物池 sha256 去重，S2）。
 * 表访问只走 @fshine/core 的 TaskStore 行访问器（insertFileRef/getFileRef/listFileRefs），
 * 本模块不建第二套 store、不开第二个端口实现（S0 收口约束）。
 *
 * 布局（v8 §2/§3；**不存 path**，字节位置按布局 + file_id 派生）：
 *   <workspaceRoot>/<principalHash>/<sessionHash>/files/<fileId><ext>     登记文件的字节落点
 *   <workspaceRoot>/<principalHash>/<sessionHash>/runs/<runId>/in         只读输入物化（fileId 命名）
 *                                                       /out              交付箱（宿主扫这里）
 *                                                       /scratch          中间文件（永不当产物）
 *                                                       /home /tmp        子进程 HOME/TMPDIR（空目录）
 *
 * 命名纪律（v8 §4「文件名用 file_id（扩展名取自 name）」）：目录与文件名一律由
 * file_id + 安全扩展名机械拼出；用户可见 name 只活在 file_refs 行里——路径不可由
 * name 拼出，name 里的 `..`/`/` 注入路径在结构上不可能。
 *
 * 登记纪律（v8 §3）：扫 out/ 只收普通文件——dirent 拒 symlink（含 symlink 目录，不递归）、
 * 候选再按 realpath 包含校验（真实路径不在 runDir 内即跳过，不交付/不登记）；fd 上的 fstat
 * 拒 hardlink（nlink!==1）与外来 uid、大小/份数上限；**从同一个 fd** 流式读字节做
 * copy-on-register（新 fileId + sha256），原件字节不动、sha256 前后不变。
 * open 用 O_NOFOLLOW：走查后路径被换成 symlink → ELOOP，按拒收处理（TOCTOU 收窄到 fd）。
 *
 * 解析作用域（CAP-01 S2，v8 §4）：所有读路径都带解析侧——Main 只解析 task_id IS NULL 的
 * 行；Worker 只解析 task_id = 当前任务的行（FileRefResolution）。越权/不存在/过期同码。
 *
 * 错误面（v8 §4）：输入物化对「越权 / 不存在 / pending / 过期 / 字节缺失」抛同一
 * FILE_REF_UNAVAILABLE（防存在性 oracle）；机械 reason 随异常携带，只进日志，不进用户话术。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { FileRefResolution, FileRefRow, TaskStore } from '@fshine/core';
import { DEFAULT_RUNTIME_CONFIG, fileRefTtlMsOf } from './resource-policy';

/**
 * 文件事实归属（S0 形状）：principal + session。任务维度（CAP-01 S2）不走这里——
 * 它在 file_refs.task_id 列 + FileRefResolution 解析侧上（v8 §4：Main 解析 task_id IS NULL，
 * Worker 解析 task_id = 当前任务；身份仍以 principal/session 为底）。
 */
export interface FileScope {
  principalId: string;
  sessionId: string;
}

/**
 * 输入不可用（越权/不存在/pending/过期/字节缺失同码，防存在性 oracle；v8 §4）。
 * reason 是机械原因，只进日志，不进用户话术。
 */
export class FileRefUnavailableError extends Error {
  readonly code = 'FILE_REF_UNAVAILABLE';
  constructor(readonly reason: string) {
    super(`文件不可用（FILE_REF_UNAVAILABLE）：${reason}`);
    this.name = 'FileRefUnavailableError';
  }
}

/**
 * 任务回程文件拒收（CAP-01 S2 ③）：执行层返回的文件条目不满足登记纪律（路径越出任务
 * 暂存目录、非普通文件、symlink/hardlink、超限等）。机械 reason 随异常带出，只进日志
 * 与 unavailable 标记，不进用户话术；拒收零副作用（无行、无落盘）。
 */
export class TaskFileRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`任务回程文件拒收（${reason}）`);
    this.name = 'TaskFileRejectedError';
  }
}

/** 身份目录哈希：sha256 前 16 个 hex 字符（确定性派生，不存原值映射）。 */
const ID_HASH_HEX_CHARS = 16;

function hashId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, ID_HASH_HEX_CHARS);
}

export function principalHashOf(principalId: string): string {
  return hashId(principalId);
}

export function sessionHashOf(sessionId: string): string {
  return hashId(sessionId);
}

/**
 * 安全扩展名：只保留 `.<字母数字>{1,16}` 形态的末段扩展名（`.xlsx`/`.csv`），其余
 * （无扩展名、全角、超长、多级之外）一律丢弃——扩展名只影响可读性，不是机密性边界。
 */
const SAFE_EXTENSION_PATTERN = /^(\.[A-Za-z0-9]{1,16})$/;

export function safeExtensionOf(name: string): string {
  const ext = path.extname(name);
  return SAFE_EXTENSION_PATTERN.test(ext) ? ext : '';
}

/** runId 形状守卫：runId 只由本侧生成（run_<hex32>）或测试给定；拼路径前拒绝越界形状。 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function sessionDirOf(workspaceRoot: string, scope: FileScope): string {
  return path.join(workspaceRoot, principalHashOf(scope.principalId), sessionHashOf(scope.sessionId));
}

export function runDirOf(workspaceRoot: string, scope: FileScope, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`runId 形状非法：${JSON.stringify(runId.slice(0, 64))}`);
  return path.join(sessionDirOf(workspaceRoot, scope), 'runs', runId);
}

/** 登记文件的字节落点（派生，不入库）：…/files/<fileId><safeExt>。 */
export function fileStoragePathOf(workspaceRoot: string, scope: FileScope, fileId: string, name: string): string {
  return path.join(sessionDirOf(workspaceRoot, scope), 'files', `${fileId}${safeExtensionOf(name)}`);
}

/** 登记成功的文件（RegisteredFile）：fileId 由本侧生成，bytes 为实际登记字节数。 */
export interface RegisteredFile {
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
  /**
   * 是否可交付给用户（方案 A：登记面角色标记）。用户产物/任务回程/入站文件 = true；
   * `putFile` 缺省 = false（宿主内部写出的字节默认不算交付物，只作诊断/中间产物）。
   */
  deliverable: boolean;
}

export interface PutFileInput {
  scope: FileScope;
  name: string;
  bytes: Buffer;
  /** epoch ms；缺省 = pending（入站上传的缺省形状，v8 §4 激活语义归 S1 接线）。 */
  activatedAt?: number | null;
  /**
   * 是否可交付给用户；**缺省 false**（宿主内部写出的字节默认不算交付物）。
   * 用户产物请走 register* 入口或显式传 true；投递面只按这个角色过滤，不看文件名。
   */
  deliverable?: boolean;
}

export interface MaterializedInput {
  fileId: string;
  /** 用户可见名（file_refs.name 原值）。 */
  name: string;
  /** 物化到 <run>/in/ 的文件名（<fileId><safeExt>）；脚本领按这个名字打开。 */
  materializedName: string;
}

/**
 * 交办复制结果（CAP-01 S2；机械事实随返回值带走——不进模型转录，交付/清单也不含它）：
 * 副本是任务私有文件（task_id 绑定），Worker 只解析当前任务的副本，原件不动。
 */
export interface CopiedTaskInput {
  /** 源 fileId（Main 作用域，原件保持 task_id NULL）。 */
  sourceFileId: string;
  /** 副本 fileId（新 file_id；task_id = 目标任务）。 */
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
}

export interface SkippedOutput {
  /** out/ 相对路径。 */
  name: string;
  /**
   * 机械拒收原因：
   * symlink / linked / foreign_uid / size_limit / count_limit / not_regular_file /
   * symlink_or_gone / outside_run_dir（realpath 不在 runDir 内——目录项被换成软链等）。
   */
  reason: string;
}

/**
 * 已激活文件清单项（CAP-01 S1 清单注入源；机械事实投影）：fileId/name/bytes +
 * activatedAt（激活时刻，TTL 起点）+ createdAt（**登记/真收到时刻**）。不暴露 sha256
 * 与身份键——清单仍不含行数据（v8 §8 S1）。
 *
 * 时间口径（2026-11-18 修）：清单渲染的「收到」时间取 **createdAt**（渠道真收到/登记
 * 时刻），不取 activatedAt——纯附件场景的 activated_at 是**文字消息激活时刻**，可能比
 * 真正收到晚几天（与 apps/server/attachment-facts 的 receivedAt 口径一致）。
 */
export interface ActiveFileRef {
  fileId: string;
  name: string;
  bytes: number;
  /** 激活时刻（epoch ms；可读性 TTL 起点，不是「收到」时间）。 */
  activatedAt: number;
  /** 登记/真收到时刻（epoch ms；清单按它渲染「收到」时间）。 */
  createdAt: number;
}

export interface ScanLimits {
  /** 单个产物大小上限（字节；fd fstat + 流式累计双重把守）。 */
  maxFileBytes: number;
  /** 单次 run 产物份数上限（超出部分按 relPath 排序后截尾，保证确定性）。 */
  maxCount: number;
}

/** 文件区监管的唯一写侧（S0 形状；S1 入站登记复用 putFile，S2 交办复制 + 解析作用域）。 */
export interface FileStore {
  /** workspace 根（执行器派生 run 目录用；不暴露到契约/转录）。 */
  readonly workspaceRoot: string;
  /** 写入新文件并登记行（fileId 本侧生成；copy 的源头——输入与产物都经这里落地）。 */
  putFile(input: PutFileInput): RegisteredFile;
  /**
   * 把 inputs 里每个 fileId 的字节物化到 <runDir>/in/<fileId><safeExt>。
   * 解析侧由 resolution 决定（v8 §4）：Main 只解析 task_id IS NULL；Worker 只解析
   * task_id = 指定任务。任一 fileId 越权/不存在/pending/过期/字节缺失 →
   * FileRefUnavailableError（不起子进程）。
   */
  materializeInputs(input: {
    runDir: string;
    scope: FileScope;
    fileIds: readonly string[];
    resolution: FileRefResolution;
  }): MaterializedInput[];
  /**
   * 交办复制（CAP-01 S2，v8 §4/§6）：把 Main 作用域（task_id IS NULL、已激活、TTL 内）
 * 输入文件复制成绑定 taskId 的新 file_id 行（登记即激活；Worker 只解析当前任务的副本）。
 * 先全部解析、后复制——任一 fileId 不可用 → FileRefUnavailableError（整次拒绝，零复制、
 * 零行，不部分执行）；副本 sha256/bytes 与原件行一致，不一致（存储损坏）即删半成品并拒绝。
   */
  copyInputsForTask(input: { scope: FileScope; fileIds: readonly string[]; taskId: string }): CopiedTaskInput[];
  /**
   * 当前任务的文件面（CAP-01 S2 目录桥物化源）：task_id = taskId、已激活且 TTL 内的行
   * （与 resolveReadableFile 同一可读性谓词；交办副本与任务产物都是任务文件面）。
   * 只投影 fileId/name/bytes（机械事实，无行数据）。Main 清单（listActiveFiles）不含这些行，
   * Worker 清单只归当前任务——作用域规则见 v8 §4。
   */
  listTaskFiles(input: { scope: FileScope; taskId: string; now: number }): ActiveFileRef[];
  /**
   * 任务回程文件登记（CAP-01 S2 ③，内联字节面）：执行层返回的 base64 字节 → 新 file_id +
   * task_id 绑定 + 登记即激活。**任务产物池 sha256 去重**：同 (scope, taskId, sha256) 已有行
   * → 复用旧 fileId、不重复落盘、不新增行（ask ⑤）。超限抛 TaskFileRejectedError('size_limit')。
   */
  registerTaskFile(input: {
    scope: FileScope;
    taskId: string;
    name: string;
    bytes: Buffer;
    maxFileBytes: number;
  }): RegisteredFile;
  /**
   * 任务回程文件登记（CAP-01 S2 ③，路径源）：执行层返回的 path → 校验 sourcePath 是
   * allowedRoot 内的绝对路径（任务暂存目录之外一律拒收）→ O_NOFOLLOW 打开 + fd fstat
   * 纪律（普通文件、nlink=1、同 uid、大小上限，与 out/ 扫描同一套）→ 两遍读取（先哈希
   * 查重、后落盘）→ 任务产物池 sha256 去重。violation 抛 TaskFileRejectedError（机械
   * reason：path_not_absolute / path_outside_task_dir / symlink_or_gone / not_regular_file /
   * linked / foreign_uid / size_limit / source_changed）。
   */
  registerTaskFileFromPath(input: {
    scope: FileScope;
    taskId: string;
    sourcePath: string;
    allowedRoot: string;
    name: string;
    maxFileBytes: number;
  }): RegisteredFile;
  /**
   * 扫 <runDir>/out/ 登记产物（copy-on-register：新 fileId + sha256；activated_at = 登记时刻，
   * 产出即交付箱内容，S1 回合末投递直接用）。只收普通文件；拒收项进 skipped（审计）。
   * **taskId 缺省 = Main 交付箱（S1 语义不变：每次登记新 file_id）**；传入 taskId = 任务
   * out/ 兜底扫描（CAP-01 S2 ④，v8 §10-3）：登记绑定任务并与任务产物池 sha256 去重——
   * 同字节复用旧 fileId、不重复落盘（回程已登记的产物重扫不重复）。
   */
  registerOutputsFromOut(input: {
    runDir: string;
    scope: FileScope;
    limits: ScanLimits;
    taskId?: string;
  }): {
    outputs: RegisteredFile[];
    skipped: SkippedOutput[];
  };
  /**
   * 入站登记（CAP-01 S1）：把渠道落盘的附件**流式**登记为 **pending** 行
   * （activated_at = NULL，等带文字的消息激活）。字节从 sourcePath 流式读、算 sha256、
   * copy 进 workspace（…/files/<fileId><safeExt>）——不引用原路径，登记后渠道层可清理
   * 原文件。fileId 本侧生成；源 O_NOFOLLOW 打开 + 只收普通文件（与 out/ 同纪律）。
   * **内容去重（2026-11-18 owner）**：同 (principal, session)、同 sha256、仍可读的 Main
   * 侧行 → 复用该 fileId（不落盘、不新增行），name 更新为本次名、TTL 起点刷新；跨身份/
   * 会话/任务一律不复用。
   * **pending → pending 复用（2026-11-18 owner，F-1）**：既有 pending 行（activated_at
   * NULL）未过期（now − created_at ≤ TTL，与回收器同口径）、派生字节文件存在且字节数
   * 一致时同样复用——同 fileId、不新增行、不新增字节；name 更新为本次名、created_at
   * 刷新为本次收到时刻（pending 窗口重新计时），**但仍不激活**（激活仍归带文字的消息）。
   * 已过期 pending、任务副本、跨作用域、字节缺失/不符一律不复用。
   * 源不可读 / 非普通文件 / 超大小兜底 → 抛错（handler 转述为回执失败，不登记半份）。
   */
  registerInboundFile(input: { scope: FileScope; name: string; sourcePath: string }): RegisteredFile;
  /**
   * 激活（CAP-01 S1）：带文字的消息把 scope 内 TTL 窗口（created_at >= now - FILE_REF_TTL_MS）
   * 的全部 pending 行置 activated_at = now；过期 pending 保持 pending（不激活、不删除）。
   * 返回本次激活的行数（观察项，进日志）。
   */
  activatePendingInputs(input: { scope: FileScope; now: number }): number;
  /**
   * 本会话已激活（activated_at IS NOT NULL 且 TTL 内，与 materializeInputs 同一 TTL 谓词；
   * 只含 Main 侧行——task_id IS NULL，任务副本不进 Main 清单）的文件清单（CAP-01 S1
   * 清单注入源；机械事实投影，只有 fileId/name/bytes + activatedAt + createdAt——
   * 清单时间取 **createdAt**（登记/真收到时刻），不是 activatedAt）。
   * 顺序 = 底账既有排序（created_at, file_id 升序）。
   */
  listActiveFiles(input: { scope: FileScope; now: number }): ActiveFileRef[];
}

/**
 * 交办复制端口（CAP-01 S2）：runtime 只认这一个面（task_run.inputFiles 的宿主侧执行）；
 * 装配层注入 fileStore 本身（结构满足 Pick）。缺省不注入 = task_run 工具面不带 inputFiles。
 */
export type TaskInputCopier = Pick<FileStore, 'copyInputsForTask'>;

/** 产物登记的流式拷贝块大小（登记阻塞 ≈ 一次流过；v8 §10-2 的处置就是流式）。 */
const REGISTER_COPY_CHUNK_BYTES = 64 * 1024;

/**
 * 文件引用的**缺省**可读期（ms）：**唯一缺省值住 `resource-policy`**
 * （`DEFAULT_RUNTIME_CONFIG.fileRefTtlDays = 7`），本模块只经 `fileRefTtlMsOf` 派生——
 * 不再重定义第二份缺省（配置旋钮的缺省与解释只归 resource-policy）。
 *
 * 真正的 TTL 由装配层按 `runtime.fileRefTtlDays`（经 `resolveRuntimeConfig` +
 * `fileRefTtlMsOf`）解析后以 `createFileStore({ ttlMs })` 注入；本常量只用于未注入的
 * 构造（测试/嵌入）。语义不变（v8 §4）：activated_at 非 NULL 即可读、同时是可读性
 * TTL 起点；pending 的激活窗口（created_at → 被带文字的消息激活）沿用同一值。
 */
export const FILE_REF_TTL_MS = fileRefTtlMsOf(DEFAULT_RUNTIME_CONFIG);

/**
 * 入站登记的大小上限（20MB，2026-11-17 CAP-01 owner 裁决：100MB 必 OOM——实测 1.1MB
 * 文件处理峰值 396MB）：与 server 入站登记前的准入校验（`apps/server/server.ts` 同一
 * 常量）同值——server 按契约 `IncomingAttachment.bytes` 先拒、这里按流式实际字节兜底，
 * 判据都是「> 上限才拒」（恰好 20MB 放行）。渠道适配器侧另有自己的渠道限额（WeCom
 * 32MB）先行拒收；到不了这里。这是 handler 直调者的机械防线，不是第二套限额。
 */
export const INBOUND_MAX_FILE_BYTES = 20 * 1024 * 1024;

function newFileId(): string {
  return `file_${randomUUID().replaceAll('-', '')}`;
}

/** 打开句柄的真实路径（Linux 走 /proc/self/fd；失败回落到 realpath(resolved)）。 */
function realpathOfOpenFd(fd: number, resolved: string): string | undefined {
  try {
    const link = readlinkSync(`/proc/self/fd/${fd}`);
    // 已删除文件带 " (deleted)" 后缀，去掉后再比较。
    return link.replace(/ \(deleted\)$/, '');
  } catch {
    try {
      return realpathSync(resolved);
    } catch {
      return undefined;
    }
  }
}

export function createFileStore(options: {
  store: TaskStore;
  workspaceRoot: string;
  /**
   * 文件引用可读期（ms）：装配层按 `runtime.fileRefTtlDays` 解析后注入
   * （`fileRefTtlMsOf`）；缺省 = 7 天。本模块不读配置、不重定义缺省。
   */
  ttlMs?: number;
}): FileStore {
  const { store, workspaceRoot } = options;
  const ttlMs = options.ttlMs ?? FILE_REF_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`文件引用 TTL 必须是正整数毫秒（当前: ${String(ttlMs)}）`);
  }

  /** 严格包含判定（realpath 之后用；与 skills.ts 的 isInside 同语义）。 */
  function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  /**
   * 走查 out/：**dirent 类型位**不跟随——symlink 文件与 symlink 目录都直接不收、不递归；
   * 只收普通文件候选。目录项被换成软链等竞态下，dirent 可能仍报普通文件——每个候选再按
   * `realpathSync` 做包含校验：真实路径必须严格位于 `realpathSync(runDir)` 之内，否则跳过
   * 并记 `outside_run_dir`（不交付、不登记）。候选按 relPath 全排序（跨目录确定性），
   * count_limit 截尾因此可复现。
   */
  function collectCandidates(outDir: string, realRunDir: string): {
    candidates: Array<{ relPath: string; absPath: string }>;
    skipped: SkippedOutput[];
  } {
    const candidates: Array<{ relPath: string; absPath: string }> = [];
    const skipped: SkippedOutput[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absPath = path.join(dir, entry.name);
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          skipped.push({ name: relPath, reason: 'symlink' }); // 不收、不递归
          continue;
        }
        if (entry.isDirectory()) {
          walk(absPath, relPath);
          continue;
        }
        if (!entry.isFile()) continue; // fifo/socket/device/未知类型：一律不收
        // realpath 包含校验（防御纵深）：候选的真实路径必须仍在 runDir 的真实路径之内。
        // runDir 自身也可能经过软链（如 /tmp → /private/tmp）——两边都取 realpath 再比，
        // 不做字符串前缀比较（'..' 与符号链接都不会被误放行）。
        let realCandidate: string;
        try {
          realCandidate = realpathSync(absPath);
        } catch {
          skipped.push({ name: relPath, reason: 'symlink_or_gone' });
          continue;
        }
        if (!isInside(realRunDir, realCandidate)) {
          skipped.push({ name: relPath, reason: 'outside_run_dir' });
          continue;
        }
        candidates.push({ relPath, absPath });
      }
    };
    walk(outDir, '');
    candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { candidates, skipped };
  }

  /**
   * 从 fd 流式拷贝到 destPath 并哈希（登记阻塞 ≈ 一次流过；v8 §10-2 的处置就是流式）。
   * 超过 maxFileBytes 即弃（删半成品，不登记半份）。copy-on-register 的共同底座：
   * registerFromFd（out/ 产物、入站附件）与 copyInputsForTask（交办副本）共用。
   */
  function copyFdWithHash(fd: number, destPath: string, maxFileBytes: number): { sha256: string; bytes: number } {
    const destFd = openSync(destPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(REGISTER_COPY_CHUNK_BYTES);
    let bytes = 0;
    let offset = 0;
    try {
      for (;;) {
        // 显式偏移读取（fd 上的两遍读取安全：回程登记先哈希后落盘共用同一 fd）。
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        if (read === 0) break;
        offset += read;
        bytes += read;
        if (bytes > maxFileBytes) {
          // fstat 之后仍在生长的写入面：超限即弃（删除半成品，不登记半份产物）。
          throw new RangeError('size_limit');
        }
        hash.update(buffer.subarray(0, read));
        writeSync(destFd, buffer, 0, read);
      }
    } catch (error) {
      closeSync(destFd);
      try {
        rmSync(destPath);
      } catch {
        // 半成品清理失败只能留给 TTL 清孤儿；不掩盖原始错误。
      }
      throw error;
    }
    closeSync(destFd);
    return { sha256: hash.digest('hex'), bytes };
  }

  /**
   * copy-on-register：从**同一个 fd** 流式读 → 哈希 + 落到新 fileId 的存储位（原件不动）。
   * activatedAt 由调用方决定：out/ 产物 = 登记时刻（产出即可读）；入站附件 = undefined
   * （pending，等带文字的消息激活）。超过 maxFileBytes 即弃（删半成品，不登记半份）。
   */
  function registerFromFd(
    fd: number,
    input: { scope: FileScope; name: string; maxFileBytes: number; activatedAt: number | undefined },
  ): RegisteredFile {
    const fileId = newFileId();
    const destPath = fileStoragePathOf(workspaceRoot, input.scope, fileId, input.name);
    mkdirSync(path.dirname(destPath), { recursive: true });
    const { sha256, bytes } = copyFdWithHash(fd, destPath, input.maxFileBytes);
    const row = store.insertFileRef({
      fileId,
      principalId: input.scope.principalId,
      sessionId: input.scope.sessionId,
      name: input.name,
      sha256,
      bytes,
      // 产出即交付箱内容（登记时刻激活）；入站附件传 undefined = pending（NULL）。
      ...(input.activatedAt === undefined ? {} : { activatedAt: input.activatedAt }),
      createdAt: Date.now(),
      // 用户产物入口（out/ 扫描 / 入站附件）：可交付角色。
      deliverable: true,
    });
    return { fileId: row.fileId, name: row.name, bytes: row.bytes, sha256: row.sha256, deliverable: true };
  }

  /**
   * 按解析侧读一行**可读**文件（v8 §4 同码谓词的单一实现）：越权/不存在（missing_or_foreign）、
   * pending、过期（activated_at 是 TTL 起点）→ FileRefUnavailableError（机械 reason 随异常
   * 带出，只进日志）。materializeInputs 与 copyInputsForTask 共用。
   */
  function resolveReadableFile(
    fileId: string,
    scope: FileScope,
    resolution: FileRefResolution,
    now: number,
  ): FileRefRow {
    const row = store.getFileRef(fileId, scope, resolution);
    if (row === undefined) throw new FileRefUnavailableError(`missing_or_foreign:${fileId}`);
    if (row.activatedAt === undefined) throw new FileRefUnavailableError(`pending:${fileId}`);
    if (now - row.activatedAt > ttlMs) throw new FileRefUnavailableError(`expired:${fileId}`);
    return row;
  }

  /**
   * 任务产物池去重（CAP-01 S2 ⑤）：同 (scope, taskId, sha256) 已有行 → 复用旧 fileId
   * （不落盘、不新增行）。池不跨任务、不跨解析侧——Main 侧行与其他任务的行不参与复用。
   */
  function findTaskRowBySha(scope: FileScope, taskId: string, sha256: string, name: string): FileRefRow | undefined {
    // 2026-11-17 修：复用键必须含文件名——只按 sha 复用会把「同字节不同名」的乙.csv 换成
    // 甲.csv，投递层的 (sha256, 文件名) 去重无法把名字还原，用户就少收一份文件。
    return store.listFileRefs(scope).find((row) => row.taskId === taskId && row.sha256 === sha256 && row.name === name);
  }

  /**
   * 入站内容去重（2026-11-18 owner，B 方案）：同 scope、同 sha256、未过期、字节文件存在
   * 且字节数一致的 Main 侧行可复用。跨 principal/session 由 scope 查询隔离；task_id 绑定的
   * 副本/产物不参与（它们只归对应任务解析，复用会让 Main 拿到不可读的 fileId）。顺序 =
   * 底账既有排序（created_at, file_id），确定性取第一行。
   *
   * 两类可复用行（2026-11-18 F-1）：
   *   · 已激活：激活行 TTL 内（now − activated_at ≤ TTL），复用刷新 activated_at；
   *   · pending：激活窗口未关闭（now − created_at ≤ TTL，与 `file-ref-cleanup.ts` 的
   *     pending 过期口径一致），复用只刷新 created_at/name，**保持 pending**——同一份纯
   *     附件连发两次不再产生第二行/第二个 fileId/第二份字节。
   */
  function findReusableInboundRow(
    scope: FileScope,
    expected: { sha256: string; bytes: number },
    now: number,
  ): { row: FileRefRow; pending: boolean } | undefined {
    for (const row of store.listFileRefs(scope)) {
      if (row.taskId !== undefined) continue;
      if (row.sha256 !== expected.sha256 || row.bytes !== expected.bytes) continue;
      // 字节可能已被保留期回收 / 被截断：文件不是普通文件或字节数不配即视为不可读，
      // 复用会把坏引用交出去（lstat 不跟随软链，比 existsSync 更严）。
      if (!byteFileMatches(scope, row)) continue;
      if (row.activatedAt !== undefined) {
        if (now - row.activatedAt > ttlMs) continue;
        return { row, pending: false };
      }
      // pending：过期口径 = now − created_at > TTL（过期的 pending 不复用，新登记）。
      if (now - row.createdAt > ttlMs) continue;
      return { row, pending: true };
    }
    return undefined;
  }

  /** 派生字节文件存在、是普通文件、字节数与行一致（复用前置条件）。 */
  function byteFileMatches(scope: FileScope, row: FileRefRow): boolean {
    try {
      const stat = lstatSync(fileStoragePathOf(workspaceRoot, scope, row.fileId, row.name));
      return stat.isFile() && stat.size === row.bytes;
    } catch {
      return false;
    }
  }

  /**
   * 复用既有 fileId：name 更新为本次文件名（用户最后一次的名字代表意图）。已激活行把
   * activated_at 刷新为本次收到时刻（避免「重发反而更快过期」），created_at 保留原始登记
   * 时间做审计；pending 行只刷新 created_at（pending 窗口重新计时）并**保持 activated_at
   * NULL**（复用不得替用户激活，激活仍归带文字的消息）。字节不重写、不新增行；若安全
   * 扩展名变化导致派生存储路径变化，先把字节改名到新路径，再更新行——保证不变量「字节
   * 位置 = fileId + 当前 name 的安全扩展名」始终成立。
   * 改名/更新失败（竞态/IO）返回 undefined，调用方回落到新登记（零半成品）。
   */
  function reuseInboundRow(input: {
    scope: FileScope;
    name: string;
    row: FileRefRow;
    now: number;
    pending: boolean;
  }): RegisteredFile | undefined {
    const { scope, name, row, now, pending } = input;
    const oldPath = fileStoragePathOf(workspaceRoot, scope, row.fileId, row.name);
    const newPath = fileStoragePathOf(workspaceRoot, scope, row.fileId, name);
    let moved = false;
    if (oldPath !== newPath) {
      try {
        const stat = lstatSync(oldPath);
        if (!stat.isFile()) return undefined;
        if (existsSync(newPath)) return undefined;
        renameSync(oldPath, newPath);
        moved = true;
      } catch {
        return undefined;
      }
    }
    const updated = store.updateFileRef({
      fileId: row.fileId,
      principalId: scope.principalId,
      sessionId: scope.sessionId,
      name,
      // pending 复用保持 pending（NULL）；已激活复用刷新激活时刻。
      activatedAt: pending ? null : now,
      // pending 窗口从本次收到重新计时；已激活行保留原始 created_at（审计）。
      ...(pending ? { createdAt: now } : {}),
    });
    if (!updated) {
      if (moved) {
        try {
          renameSync(newPath, oldPath);
        } catch {
          // 回滚失败：旧行按「字节缺失」处理（不可读），不制造半份新引用。
        }
      }
      return undefined;
    }
    return { fileId: row.fileId, name, bytes: row.bytes, sha256: row.sha256, deliverable: true };
  }

  /** fd 单遍流式哈希（回程登记/入站去重第一遍：先哈希查重，再决定是否落盘）。 */
  function hashFd(fd: number, maxFileBytes: number): { sha256: string; bytes: number } {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(REGISTER_COPY_CHUNK_BYTES);
    let bytes = 0;
    let offset = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      offset += read;
      bytes += read;
      if (bytes > maxFileBytes) throw new RangeError('size_limit');
      hash.update(buffer.subarray(0, read));
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  /**
   * 任务产物登记（fd 源，CAP-01 S2 ③④共用底座）：先流式哈希查重（同 sha 复用旧 fileId、
   * 不落盘），新产物再从**同一 fd** 第二遍流式落盘（copy-on-register），并核对两遍读取一致
   * （不一致 = 源在读取间被改写 → 删半成品拒收）。行 task_id 绑定、登记即激活。
   */
  function registerTaskFromFd(
    fd: number,
    input: { scope: FileScope; taskId: string; name: string; maxFileBytes: number },
  ): RegisteredFile {
    let hashed: { sha256: string; bytes: number };
    try {
      hashed = hashFd(fd, input.maxFileBytes);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'size_limit') throw new TaskFileRejectedError('size_limit');
      throw error;
    }
    const reused = findTaskRowBySha(input.scope, input.taskId, hashed.sha256, input.name);
    if (reused !== undefined) return { fileId: reused.fileId, name: reused.name, bytes: reused.bytes, sha256: reused.sha256, deliverable: true };
    const fileId = newFileId();
    const destPath = fileStoragePathOf(workspaceRoot, input.scope, fileId, input.name);
    mkdirSync(path.dirname(destPath), { recursive: true });
    let copied: { sha256: string; bytes: number };
    try {
      copied = copyFdWithHash(fd, destPath, input.maxFileBytes);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'size_limit') throw new TaskFileRejectedError('size_limit');
      throw error;
    }
    if (copied.sha256 !== hashed.sha256 || copied.bytes !== hashed.bytes) {
      try {
        rmSync(destPath);
      } catch {
        // 半成品清理失败留给 TTL 清孤儿；不掩盖完整性错误。
      }
      throw new TaskFileRejectedError('source_changed');
    }
    const row = store.insertFileRef({
      fileId,
      principalId: input.scope.principalId,
      sessionId: input.scope.sessionId,
      taskId: input.taskId,
      name: input.name,
      sha256: copied.sha256,
      bytes: copied.bytes,
      activatedAt: Date.now(),
      createdAt: Date.now(),
      // 任务回程产物（内联/路径/out/ 兜底扫）：用户产物角色。
      deliverable: true,
    });
    return { fileId: row.fileId, name: row.name, bytes: row.bytes, sha256: row.sha256, deliverable: true };
  }

  return {
    workspaceRoot,
    putFile(input) {
      const fileId = newFileId();
      const storagePath = fileStoragePathOf(workspaceRoot, input.scope, fileId, input.name);
      mkdirSync(path.dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, input.bytes, { flag: 'wx', mode: 0o600 });
      const row = store.insertFileRef({
        fileId,
        principalId: input.scope.principalId,
        sessionId: input.scope.sessionId,
        name: input.name,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        bytes: input.bytes.length,
        activatedAt: input.activatedAt ?? undefined,
        createdAt: Date.now(),
        // 方案 A：缺省 false——宿主内部写出的字节默认不算交付物（只有显式/register* 入口才是用户产物）。
        deliverable: input.deliverable ?? false,
      });
      return {
        fileId: row.fileId,
        name: row.name,
        bytes: row.bytes,
        sha256: row.sha256,
        deliverable: row.deliverable ?? false,
      };
    },
    materializeInputs({ runDir, scope, fileIds, resolution }) {
      const inDir = path.join(runDir, 'in');
      mkdirSync(inDir, { recursive: true });
      const materialized: MaterializedInput[] = [];
      for (const fileId of fileIds) {
        // 越权/不存在/pending/过期/字节缺失同码（v8 §4；机械 reason 随异常带出，只进日志）。
        // 解析侧由 resolution 决定：Main 只解析 task_id IS NULL；Worker 只解析当前任务的行。
        const row = resolveReadableFile(fileId, scope, resolution, Date.now());
        const source = fileStoragePathOf(workspaceRoot, scope, fileId, row.name);
        if (!existsSync(source)) throw new FileRefUnavailableError(`bytes_missing:${fileId}`);
        const materializedName = `${fileId}${safeExtensionOf(row.name)}`;
        copyFileSync(source, path.join(inDir, materializedName));
        materialized.push({ fileId, name: row.name, materializedName });
      }
      return materialized;
    },
    copyInputsForTask({ scope, fileIds, taskId }) {
      // 去重保序：同一 fileId 重复引用只复制一份。
      const uniqueFileIds = [...new Set(fileIds)];
      // 先全部按 Main 侧解析（任一不可用 → 整次拒绝：零复制、零行，不部分执行）。
      const now = Date.now();
      const resolved = uniqueFileIds.map((fileId) => resolveReadableFile(fileId, scope, { side: 'main' }, now));
      // 全部可用后才复制：新 fileId + task_id 绑定 + 登记即激活（Worker 只解析当前任务的副本）。
      return resolved.map((row) => {
        const source = fileStoragePathOf(workspaceRoot, scope, row.fileId, row.name);
        if (!existsSync(source)) throw new FileRefUnavailableError(`bytes_missing:${row.fileId}`);
        let fd: number;
        try {
          fd = openSync(source, fsConstants.O_RDONLY);
        } catch {
          throw new FileRefUnavailableError(`bytes_missing:${row.fileId}`);
        }
        try {
          const fileId = newFileId();
          const destPath = fileStoragePathOf(workspaceRoot, scope, fileId, row.name);
          mkdirSync(path.dirname(destPath), { recursive: true });
          const { sha256, bytes } = copyFdWithHash(fd, destPath, row.bytes);
          // 完整性（B 类）：副本字节/哈希必须与原件行一致——不一致即源存储损坏，删半成品
          // 并拒绝交办（不登记一份与底账不符的副本）。
          if (sha256 !== row.sha256 || bytes !== row.bytes) {
            try {
              rmSync(destPath);
            } catch {
              // 半成品清理失败留给 TTL 清孤儿；不掩盖完整性错误。
            }
            throw new Error(`任务副本与原件不一致（sha256/bytes 不符），未登记副本（源行 ${row.fileId}）`);
          }
          store.insertFileRef({
            fileId,
            principalId: scope.principalId,
            sessionId: scope.sessionId,
            taskId,
            name: row.name,
            sha256,
            bytes,
            activatedAt: Date.now(),
            createdAt: Date.now(),
            // 交办副本继承源行的交付角色（用户输入文件复制品，不是宿主诊断产物）。
            deliverable: row.deliverable ?? true,
          });
          return { sourceFileId: row.fileId, fileId, name: row.name, bytes, sha256 };
        } finally {
          closeSync(fd);
        }
      });
    },
    registerOutputsFromOut({ runDir, scope, limits, taskId }) {
      const outDir = path.join(runDir, 'out');
      const outputs: RegisteredFile[] = [];
      const skipped: SkippedOutput[] = [];
      if (!existsSync(outDir)) return { outputs, skipped };
      // 包含校验的基准 = runDir 的真实路径；取不到（异常布局/权限）即 fail closed：
      // 不枚举、不登记、不交付。
      let realRunDir: string;
      try {
        realRunDir = realpathSync(runDir);
      } catch {
        return { outputs, skipped };
      }
      const { candidates, skipped: walkSkipped } = collectCandidates(outDir, realRunDir);
      skipped.push(...walkSkipped);
      for (const candidate of candidates) {
        if (outputs.length >= limits.maxCount) {
          skipped.push({ name: candidate.relPath, reason: 'count_limit' });
          continue;
        }
        // O_NOFOLLOW：走查后被换成 symlink 的路径在这里 ELOOP，按拒收处理。
        let fd: number;
        try {
          fd = openSync(candidate.absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        } catch {
          skipped.push({ name: candidate.relPath, reason: 'symlink_or_gone' });
          continue;
        }
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) {
            skipped.push({ name: candidate.relPath, reason: 'not_regular_file' });
            continue;
          }
          if (st.nlink !== 1) {
            skipped.push({ name: candidate.relPath, reason: 'linked' });
            continue;
          }
          if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
            skipped.push({ name: candidate.relPath, reason: 'foreign_uid' });
            continue;
          }
          if (st.size > limits.maxFileBytes) {
            skipped.push({ name: candidate.relPath, reason: 'size_limit' });
            continue;
          }
          outputs.push(
            taskId === undefined
              // Main 交付箱（S1 语义不变）：每次登记新 file_id。
              ? registerFromFd(fd, { scope, name: candidate.relPath, maxFileBytes: limits.maxFileBytes, activatedAt: Date.now() })
              // 任务 out/ 兜底扫描（CAP-01 S2 ④，v8 §10-3）：绑定任务并与任务产物池去重。
              : registerTaskFromFd(fd, { scope, taskId, name: candidate.relPath, maxFileBytes: limits.maxFileBytes }),
          );
        } catch (error) {
          if (error instanceof RangeError && error.message === 'size_limit') {
            skipped.push({ name: candidate.relPath, reason: 'size_limit' });
            continue;
          }
          if (error instanceof TaskFileRejectedError) {
            skipped.push({ name: candidate.relPath, reason: error.reason });
            continue;
          }
          throw error;
        } finally {
          closeSync(fd);
        }
      }
      return { outputs, skipped };
    },
    listTaskFiles({ scope, taskId, now }) {
      // 目录桥物化源：当前任务绑定 + 可读性谓词（activated 非 NULL 且 TTL 内，与
      // resolveReadableFile 同源）。只投影 fileId/name/bytes（机械事实，无行数据）。
      return store
        .listFileRefs(scope)
        .filter(
          (row) => row.taskId === taskId && row.activatedAt !== undefined && now - row.activatedAt <= ttlMs,
        )
        .map((row) => ({
          fileId: row.fileId,
          name: row.name,
          bytes: row.bytes,
          activatedAt: row.activatedAt!,
          createdAt: row.createdAt,
        }));
    },
    registerTaskFile({ scope, taskId, name, bytes, maxFileBytes }) {
      // 内联字节面：超限拒收 → 任务池 sha256 去重（复用旧 fileId、不落盘）→ 新 file_id 落盘登记。
      if (bytes.length > maxFileBytes) throw new TaskFileRejectedError('size_limit');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const reused = findTaskRowBySha(scope, taskId, sha256, name);
      if (reused !== undefined) return { fileId: reused.fileId, name: reused.name, bytes: reused.bytes, sha256: reused.sha256, deliverable: true };
      const fileId = newFileId();
      const storagePath = fileStoragePathOf(workspaceRoot, scope, fileId, name);
      mkdirSync(path.dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, bytes, { flag: 'wx', mode: 0o600 });
      const row = store.insertFileRef({
        fileId,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
        taskId,
        name,
        sha256,
        bytes: bytes.length,
        activatedAt: Date.now(),
        createdAt: Date.now(),
        // 任务回程文件（内联字节）：用户产物角色。
        deliverable: true,
      });
      return { fileId: row.fileId, name: row.name, bytes: row.bytes, sha256: row.sha256, deliverable: true };
    },
    registerTaskFileFromPath({ scope, taskId, sourcePath, allowedRoot, name, maxFileBytes }) {
      // 路径源：先包含性（任务暂存目录之外的任何路径不开口子），再 fd 纪律，再查重落盘。
      if (!path.isAbsolute(sourcePath)) throw new TaskFileRejectedError('path_not_absolute');
      const resolved = path.resolve(sourcePath);
      const root = path.resolve(allowedRoot);
      if (resolved === root || !resolved.startsWith(root + path.sep)) {
        throw new TaskFileRejectedError('path_outside_task_dir');
      }
      // 真实根：allowedRoot 自身可能是软链；边界按 realpath 判定（2026-11-17 Codex blocking）。
      const realRoot = realpathSync(root);
      let fd: number;
      try {
        fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        throw new TaskFileRejectedError('symlink_or_gone');
      }
      try {
        // 父目录软链：O_NOFOLLOW 只拒绝末级组件，`taskA/link -> taskB` 这种会被跟随。
        // 判定以**实际打开的文件**为准（/proc/self/fd 指向真实路径），而不是入参字符串。
        const actualPath = realpathOfOpenFd(fd, resolved);
        if (actualPath === undefined || actualPath === realRoot || !actualPath.startsWith(realRoot + path.sep)) {
          throw new TaskFileRejectedError('path_outside_task_dir');
        }
        const st = fstatSync(fd);
        if (!st.isFile()) throw new TaskFileRejectedError('not_regular_file');
        if (st.nlink !== 1) throw new TaskFileRejectedError('linked');
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new TaskFileRejectedError('foreign_uid');
        if (st.size > maxFileBytes) throw new TaskFileRejectedError('size_limit');
        return registerTaskFromFd(fd, { scope, taskId, name, maxFileBytes });
      } finally {
        closeSync(fd);
      }
    },
    registerInboundFile({ scope, name, sourcePath }) {
      // O_NOFOLLOW：源路径被换成 symlink → ELOOP，按拒收处理（与 out/ 扫描同纪律）。
      let fd: number;
      try {
        fd = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        throw new Error(`入站附件不可读：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error('入站附件不是普通文件，拒收');
        // 入站源头是渠道适配器落盘（受信写侧，见 contracts IncomingAttachment 义务），不做
        // out/ 的 nlink/uid 走查；大小兜底见 INBOUND_MAX_FILE_BYTES。
        //
        // 内容去重（2026-11-18 owner，B 方案 + F-1）：先流式哈希（侧效零），同 scope 内
        // 已有同 sha256 且未过期、字节一致的行 → 复用该 fileId（不落盘、不新增行）：
        // 已激活行刷新 name/activated_at；pending 行刷新 name/created_at 且保持 pending。
        // 无命中才走既有 pending 登记（copy-on-register + 新 file_id）。
        const hashed = hashFd(fd, INBOUND_MAX_FILE_BYTES);
        const now = Date.now();
        const reusable = findReusableInboundRow(scope, hashed, now);
        if (reusable !== undefined) {
          const reused = reuseInboundRow({ scope, name, row: reusable.row, now, pending: reusable.pending });
          if (reused !== undefined) return reused;
        }
        return registerFromFd(fd, { scope, name, maxFileBytes: INBOUND_MAX_FILE_BYTES, activatedAt: undefined });
      } catch (error) {
        if (error instanceof RangeError && error.message === 'size_limit') {
          throw new Error(`入站附件超过大小上限（${INBOUND_MAX_FILE_BYTES} 字节），未登记`);
        }
        throw error;
      } finally {
        closeSync(fd);
      }
    },
    activatePendingInputs({ scope, now }) {
      // TTL 窗口（created_at >= now - ttlMs）内的全部 pending → activated_at = now；
      // 过期 pending 保持 pending（孤儿清理归后续 TTL 清扫）。机械事实一条 UPDATE，无状态机。
      return store.activatePendingFileRefs(scope, { activatedAt: now, createdAfter: now - ttlMs });
    },
    listActiveFiles({ scope, now }) {
      // 与 materializeInputs 的可读性谓词同源：activated_at 非 NULL 且 (now - activated_at) ≤ TTL。
      // 只含 Main 侧行（task_id IS NULL）：任务副本只归当前任务的 Worker 解析，不进 Main 清单
      // （清单是 Main 的 run_js/inputFiles 引用面——给了也解析不到，且是存在性 oracle，v8 §4）。
      // 投影 fileId/name/bytes + activatedAt（TTL 起点）+ createdAt（登记/真收到时刻，
      // 清单按它渲染「收到」）——sha256/身份键仍不进清单。
      return store
        .listFileRefs(scope)
        .filter(
          (row) =>
            row.taskId === undefined && row.activatedAt !== undefined && now - row.activatedAt <= ttlMs,
        )
        .map((row) => ({
          fileId: row.fileId,
          name: row.name,
          bytes: row.bytes,
          activatedAt: row.activatedAt!,
          createdAt: row.createdAt,
        }));
    },
  };
}
