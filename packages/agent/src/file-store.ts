/**
 * 文件区监管 fileStore（CAP-01 S0；docs/product/cap01-main-direct-execution.md §1/§2/§3/§4）。
 *
 * 职责：workspace 布局派生 + 文件字节与 file_refs 行的**唯一写侧**（putFile 落新文件 /
 * materializeInputs 物化输入 / registerOutputsFromOut 从交付箱 copy-on-register 登记产物）。
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
 * 登记纪律（v8 §3）：扫 out/ 只收普通文件——lstat 拒 symlink（含 symlink 目录，不递归）、
 * fd 上的 fstat 拒 hardlink（nlink!==1）与外来 uid、大小/份数上限；**从同一个 fd** 流式
 * 读字节做 copy-on-register（新 fileId + sha256），原件字节不动、sha256 前后不变。
 * open 用 O_NOFOLLOW：走查后路径被换成 symlink → ELOOP，按拒收处理（TOCTOU 收窄到 fd）。
 *
 * 错误面（v8 §4）：输入物化对「越权 / 不存在 / pending / 字节缺失」抛同一
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
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { TaskStore } from '@fshine/core';

/** 文件事实归属（S0 形状；S2 追加 task 维度，见 v8 §4 的派生口径）。 */
export interface FileScope {
  principalId: string;
  sessionId: string;
}

/**
 * 输入不可用（越权/不存在/pending/字节缺失同码，防存在性 oracle；v8 §4）。
 * reason 是机械原因，只进日志，不进用户话术。
 */
export class FileRefUnavailableError extends Error {
  readonly code = 'FILE_REF_UNAVAILABLE';
  constructor(readonly reason: string) {
    super(`文件不可用（FILE_REF_UNAVAILABLE）：${reason}`);
    this.name = 'FileRefUnavailableError';
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
}

export interface PutFileInput {
  scope: FileScope;
  name: string;
  bytes: Buffer;
  /** epoch ms；缺省 = pending（入站上传的缺省形状，v8 §4 激活语义归 S1 接线）。 */
  activatedAt?: number | null;
}

export interface MaterializedInput {
  fileId: string;
  /** 用户可见名（file_refs.name 原值）。 */
  name: string;
  /** 物化到 <run>/in/ 的文件名（<fileId><safeExt>）；脚本领按这个名字打开。 */
  materializedName: string;
}

export interface SkippedOutput {
  /** out/ 相对路径。 */
  name: string;
  /** 机械拒收原因（symlink/linked/foreign_uid/size_limit/count_limit/not_regular_file/symlink_or_gone）。 */
  reason: string;
}

export interface ScanLimits {
  /** 单个产物大小上限（字节；fd fstat + 流式累计双重把守）。 */
  maxFileBytes: number;
  /** 单次 run 产物份数上限（超出部分按 relPath 排序后截尾，保证确定性）。 */
  maxCount: number;
}

/** 文件区监管的唯一写侧（S0 形状；S1 入站登记复用 putFile，S2 接 Task 副本）。 */
export interface FileStore {
  /** workspace 根（执行器派生 run 目录用；不暴露到契约/转录）。 */
  readonly workspaceRoot: string;
  /** 写入新文件并登记行（fileId 本侧生成；copy 的源头——输入与产物都经这里落地）。 */
  putFile(input: PutFileInput): RegisteredFile;
  /**
   * 把 inputs 里每个 fileId 的字节物化到 <runDir>/in/<fileId><safeExt>。
   * 任一 fileId 越权/不存在/pending/字节缺失 → FileRefUnavailableError（不起子进程）。
   */
  materializeInputs(input: { runDir: string; scope: FileScope; fileIds: readonly string[] }): MaterializedInput[];
  /**
   * 扫 <runDir>/out/ 登记产物（copy-on-register：新 fileId + sha256；activated_at = 登记时刻，
   * 产出即交付箱内容，S1 回合末投递直接用）。只收普通文件；拒收项进 skipped（审计）。
   */
  registerOutputsFromOut(input: { runDir: string; scope: FileScope; limits: ScanLimits }): {
    outputs: RegisteredFile[];
    skipped: SkippedOutput[];
  };
}

/** 产物登记的流式拷贝块大小（登记阻塞 ≈ 一次流过；v8 §10-2 的处置就是流式）。 */
const REGISTER_COPY_CHUNK_BYTES = 64 * 1024;

function newFileId(): string {
  return `file_${randomUUID().replaceAll('-', '')}`;
}

export function createFileStore(options: { store: TaskStore; workspaceRoot: string }): FileStore {
  const { store, workspaceRoot } = options;

  /**
   * 走查 out/：lstat 不跟随——symlink 文件与 symlink 目录都直接不收、不递归（v8 §3）；
   * 只收普通文件候选。候选按 relPath 全排序（跨目录确定性），count_limit 截尾因此可复现。
   */
  function collectCandidates(outDir: string): {
    candidates: Array<{ relPath: string; absPath: string }>;
    skipped: SkippedOutput[];
  } {
    const candidates: Array<{ relPath: string; absPath: string }> = [];
    const skipped: SkippedOutput[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir)) {
        const absPath = path.join(dir, entry);
        const relPath = rel === '' ? entry : `${rel}/${entry}`;
        const st = lstatSync(absPath);
        if (st.isSymbolicLink()) {
          skipped.push({ name: relPath, reason: 'symlink' }); // 不收、不递归
          continue;
        }
        if (st.isDirectory()) {
          walk(absPath, relPath);
          continue;
        }
        if (st.isFile()) candidates.push({ relPath, absPath });
        // 其它（fifo/socket/device）一律不收
      }
    };
    walk(outDir, '');
    candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { candidates, skipped };
  }

  /** copy-on-register：从**同一个 fd** 流式读 → 哈希 + 落到新 fileId 的存储位（原件不动）。 */
  function registerFromFd(fd: number, input: { scope: FileScope; name: string; limits: ScanLimits }): RegisteredFile {
    const fileId = newFileId();
    const destPath = fileStoragePathOf(workspaceRoot, input.scope, fileId, input.name);
    mkdirSync(path.dirname(destPath), { recursive: true });
    const destFd = openSync(destPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(REGISTER_COPY_CHUNK_BYTES);
    let bytes = 0;
    try {
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        bytes += read;
        if (bytes > input.limits.maxFileBytes) {
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
    const row = store.insertFileRef({
      fileId,
      principalId: input.scope.principalId,
      sessionId: input.scope.sessionId,
      name: input.name,
      sha256: hash.digest('hex'),
      bytes,
      // 产出即交付箱内容：登记时刻即激活（S1 回合末投递与 S2 链式取用都可读）。
      activatedAt: Date.now(),
      createdAt: Date.now(),
    });
    return { fileId: row.fileId, name: row.name, bytes: row.bytes, sha256: row.sha256 };
  }

  return {
    workspaceRoot,
    putFile(input) {
      const fileId = newFileId();
      const storagePath = fileStoragePathOf(workspaceRoot, input.scope, fileId, input.name);
      mkdirSync(path.dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, input.bytes, { flag: 'wx', mode: 0o600 });
      return store.insertFileRef({
        fileId,
        principalId: input.scope.principalId,
        sessionId: input.scope.sessionId,
        name: input.name,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        bytes: input.bytes.length,
        activatedAt: input.activatedAt ?? undefined,
        createdAt: Date.now(),
      });
    },
    materializeInputs({ runDir, scope, fileIds }) {
      const inDir = path.join(runDir, 'in');
      mkdirSync(inDir, { recursive: true });
      const materialized: MaterializedInput[] = [];
      for (const fileId of fileIds) {
        const row = store.getFileRef(fileId, scope);
        // 越权/不存在/pending/字节缺失同码（v8 §4；机械 reason 随异常带出，只进日志）。
        if (row === undefined) throw new FileRefUnavailableError(`missing_or_foreign:${fileId}`);
        if (row.activatedAt === undefined) throw new FileRefUnavailableError(`pending:${fileId}`);
        const source = fileStoragePathOf(workspaceRoot, scope, fileId, row.name);
        if (!existsSync(source)) throw new FileRefUnavailableError(`bytes_missing:${fileId}`);
        const materializedName = `${fileId}${safeExtensionOf(row.name)}`;
        copyFileSync(source, path.join(inDir, materializedName));
        materialized.push({ fileId, name: row.name, materializedName });
      }
      return materialized;
    },
    registerOutputsFromOut({ runDir, scope, limits }) {
      const outDir = path.join(runDir, 'out');
      const outputs: RegisteredFile[] = [];
      const skipped: SkippedOutput[] = [];
      if (!existsSync(outDir)) return { outputs, skipped };
      const { candidates, skipped: walkSkipped } = collectCandidates(outDir);
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
          outputs.push(registerFromFd(fd, { scope, name: candidate.relPath, limits }));
        } catch (error) {
          if (error instanceof RangeError && error.message === 'size_limit') {
            skipped.push({ name: candidate.relPath, reason: 'size_limit' });
            continue;
          }
          throw error;
        } finally {
          closeSync(fd);
        }
      }
      return { outputs, skipped };
    },
  };
}
