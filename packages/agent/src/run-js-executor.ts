/**
 * run_js 执行器（CAP-01 S0；docs/product/cap01-main-direct-execution.md §2/§3/§8）。
 *
 * S0 面只到「跑完一次受限脚本并登记产物」：不接 Main、不接渠道、不进 Execution
 * Contract、不改 execution-runtime 的工具面（接线与端口注入归 S1）。
 *
 * 每次 runJs 调用：
 *   ① 开独立 run 目录（不共享）：<root>/<ph>/<sh>/runs/<runId>/{in,out,scratch,home,tmp}；
 *      输入先过 scope/激活校验并物化到 in/（fileId 命名，见 file-store.ts）——校验失败
 *      不起子进程；模型代码（CommonJS）**原样**写进 <runDir>/run.cjs，审计哈希 = 实际执行字节。
 *      **布局收窄（symlink 收窄）**：物化前、建目录后与 spawn 前逐个 lstat runDir/in/out/
 *      scratch/home/tmp——存在但不是真目录（软链/普通文件/其它）→ 拒跑
 *      （RunJsLayoutUnsafeError；不写 run.cjs、不起子进程、零产物），机械事实进结构化事件。
 *   ② 受限子进程（v8 §3 实测有效，不是沙箱）：
 *        node --permission --allow-fs-read=<runDir> --allow-fs-read=<node_modules>
 *             --allow-fs-write=<runDir>/out --allow-fs-write=<runDir>/scratch run.cjs
 *      env 按 worker-env 白名单重建（PATH），再加 NODE_PATH=<node_modules>；HOME/TMPDIR
 *      指向 run 目录下的空目录——宿主凭据结构上进不了子进程。
 *   ③ detached:true 建进程组；超时/宿主中止 → kill(-pid,'SIGKILL') 杀**整组**（SIGTERM
 *      对同步忙循环不可靠、孙进程会逃逸，v8 §3）。stdout/stderr 在 data 回调里逐块计数，
 *      超限即弃并标 truncated（不先全读再截）。
 *   ④ 收尾扫 out/ 登记产物（fileStore.registerOutputsFromOut：只收普通文件、拒 symlink/
 *      hardlink、uid/大小/份数上限；候选按 realpath 包含校验必须仍在 runDir 内；同一 fd
 *      流式 copy-on-register 成新 fileId + sha256，原件字节不动）。**无论 exitCode 都扫**——
 *      out/ 就是交付箱；交付去留归 S1。
 *   ⑤ 审计随返回值走（脚本 sha256、输入/输出 fileId、exitCode、耗时、kill 原因）。
 *      S0 不落审计表（v8 §9 不做 run_code_runs 第二张表）；持久化落点归 S1 接线裁定。
 *
 * 超时/内存/份数/字节数值按 v8 §11 owner 裁决由 S0 写死为模块常量（构造参数可覆盖，
 * 仅供测试收紧；生产装配不得放宽）：
 *   · 超时 120s（缺省 mainConcurrency=4，一个 60s 脚本期间超出 4 槽的会话已排队等待，
 *     v8 §8——上限取两倍该成本）；· V8 堆 1024MB（CAP-01 owner 裁决：入站附件上限
 *     20MB 的实处理峰值远超 512MB，给 20MB 留余量）；· stdout/stderr 各 64KiB；
 *   · 单产物 50MiB；· 产物 20 份。
 *
 * 残余风险按 v8 §3 如实登记（owner 裁决：接受）：网络未阻断（脚本可外传它能读到的
 * 内容）、无 OS 级隔离、提示注入仍可驱动模型写恶意代码（但它读不到宿主凭据，最坏是
 * 写坏产物）、文件类型检查不是机密性边界。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { workerSubprocessEnv } from './worker-env';
import type { FileStore, MaterializedInput, RegisteredFile, SkippedOutput } from './file-store';
import { runDirOf } from './file-store';
import { RunJsLayoutUnsafeError, type RunJsLayoutItem, type RunJsLayoutUnsafeKind } from './run-js-layout';

// 布局收窄的公开面（事件/错误/话术）与执行器同处一个入口：测试与装配方不必知道拆分模块。
export {
  RUN_JS_LAYOUT_UNSAFE_CODE,
  RUN_JS_LAYOUT_UNSAFE_MESSAGE,
  RunJsLayoutUnsafeError,
  type RunJsLayoutItem,
  type RunJsLayoutUnsafeEvent,
  type RunJsLayoutUnsafeKind,
} from './run-js-layout';

/** 超时上限（宿主常量；模型没有 timeoutMs 参数，只能把请求调小，v8 §2）。 */
export const RUN_JS_TIMEOUT_MS = 120_000;
/** stdout/stderr 各自的流式截断上限（字节）。 */
export const RUN_JS_MAX_STREAM_BYTES = 64 * 1024;
/** 单个产物文件大小上限（字节）。 */
export const RUN_JS_MAX_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
/** 单次 run 产物份数上限。 */
export const RUN_JS_MAX_OUTPUT_COUNT = 20;
/** 子进程 V8 堆上限（MB；--max-old-space-size，写进 spawn argv；CAP-01：1024 给 20MB 附件留余量）。 */
export const RUN_JS_MAX_OLD_SPACE_MB = 1024;

export interface RunJsScope {
  principalId: string;
  sessionId: string;
}

export interface RunJsInput {
  /** CommonJS 代码原样（写进 <runDir>/run.cjs 执行）。 */
  code: string;
  /** 输入文件 fileId（本会话 scope 内、已激活）；宿主物化到 <run>/in/。 */
  inputs?: readonly string[];
  scope: RunJsScope;
  /**
   * 任务作用域（CAP-01 S2 ①，v8 §4）：设置后为 **Worker 面**——输入只解析当前任务的
   * 绑定行（{side:'worker', taskId}，越权/不存在同码 FILE_REF_UNAVAILABLE），产物登记
   * 绑定该任务（task_id）；缺省 = Main 面（只解析 task_id IS NULL 的行，产物不绑任务）。
   */
  taskId?: string;
  /** 宿主中止信号（任务取消等）；触发即对进程组 SIGKILL。超时不是模型参数（宿主常量）。 */
  signal?: AbortSignal;
}

export interface RunJsOutputFile {
  fileId: string;
  name: string;
  bytes: number;
}

export interface RunJsAudit {
  runId: string;
  /** run 目录绝对路径（机械审计用；不出现在用户可见话术）。 */
  runDir: string;
  /** 实际执行的 run.cjs 字节的 sha256。 */
  scriptSha256: string;
  /** 请求的输入 fileId（请求面）。 */
  inputFileIds: string[];
  /** 物化结果（fileId → in/ 文件名；审计面）。 */
  materializedInputs: MaterializedInput[];
  /**
   * 本次运行的输入总字节 = 脚本字节 + in/ 物化输入文件字节和（CAP-01 内存墙事件用：
   * 「多大」要可追溯；稀疏/外部改动的 in/ 文件按实际字节计）。
   */
  inputBytes: number;
  /** 登记成功的产物（fileId/name/bytes）。 */
  outputs: Array<{ fileId: string; name: string; bytes: number }>;
  /** 被拒收的 out/ 条目与机械原因（symlink/hardlink/超限等）。 */
  skippedOutputs: SkippedOutput[];
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  /** 宿主主动杀进程组的原因；不出现 = 自然退出。 */
  killReason?: 'timeout' | 'abort';
  durationMs: number;
}

export interface RunJsOutput {
  /** null = 被信号终止（宿主超时/中止杀进程组）。 */
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputs: RunJsOutputFile[];
  audit: RunJsAudit;
}

export interface RunJsExecutor {
  runJs(input: RunJsInput): Promise<RunJsOutput>;
}

/**
 * 杀整组进程（detached spawn 的 pgid = pid）。ESRCH（已退出/已 reap）忽略——
 * 竞态下的无事可做，不是错误。
 */
export function killRunProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已不存在：无需处理。
  }
}

/**
 * 运行目录布局校验（symlink 收窄的 fail-closed 边界）：逐个 lstat runDir/in/out/scratch/
 * home/tmp；**不存在**是正常状态（随后由宿主创建），**存在但不是真目录**（软链/普通文件/
 * fifo 等）→ RunJsLayoutUnsafeError。lstat 不跟随软链：symlink 的 isDirectory() 恒 false，
 * 所以 isDirectory() 为真即真目录。
 *
 * 调用点三处（见 runJs 内注释）：物化输入前（in/ 是宿主写侧）、mkdir 前（物化期间可能被
 * 换成软链）、spawn 前（此刻的布局项就是子进程的读/写面）。任一失败都在写 run.cjs/spawn
 * 之前抛出——脚本零执行、零产物。
 */
/** 目录树软链扫描上限（防御病态目录，超限即判不安全）。 */
const RUN_LAYOUT_SCAN_MAX_ENTRIES = 2000;
const RUN_LAYOUT_SCAN_MAX_DEPTH = 8;

function assertRunLayoutSafe(runId: string, runDir: string): void {
  const items: ReadonlyArray<{ item: RunJsLayoutItem; itemPath: string }> = [
    { item: 'runDir', itemPath: runDir },
    { item: 'in', itemPath: path.join(runDir, 'in') },
    { item: 'out', itemPath: path.join(runDir, 'out') },
    { item: 'scratch', itemPath: path.join(runDir, 'scratch') },
    { item: 'home', itemPath: path.join(runDir, 'home') },
    { item: 'tmp', itemPath: path.join(runDir, 'tmp') },
  ];
  for (const { item, itemPath } of items) {
    let st;
    try {
      st = lstatSync(itemPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue; // 尚未创建 = 正常
      throw error;
    }
    if (st.isDirectory()) continue;
    const kind: RunJsLayoutUnsafeKind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
    throw new RunJsLayoutUnsafeError({ runId, item, kind });
  }
  assertNoSymlinkInside(runId, runDir);
}

/**
 * 目录树内软链扫描（2026-11-17 补）：只校验六个布局项**本身**不够——`--allow-fs-read=<runDir>`
 * 放行的是整个 run 目录，树内任一软链（例如预植的 `in/evil.txt → /etc/passwd`）都会被跟随。
 * 实测：布局项都是真目录时，脚本仍能 readFileSync('in/evil.txt') 读到 run 目录之外。
 *
 * 判据：run 目录树下**不允许存在任何软链**；发现即拒跑。上限（条目数/深度）超限同样拒跑——
 * 病态目录不"尽力而为"。
 */
function assertNoSymlinkInside(runId: string, runDir: string): void {
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > RUN_LAYOUT_SCAN_MAX_DEPTH) {
      throw new RunJsLayoutUnsafeError({ runId, item: 'nested', kind: 'other' });
    }
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > RUN_LAYOUT_SCAN_MAX_ENTRIES) {
        throw new RunJsLayoutUnsafeError({ runId, item: 'nested', kind: 'other' });
      }
      if (entry.isSymbolicLink()) {
        throw new RunJsLayoutUnsafeError({ runId, item: 'nested', kind: 'symlink' });
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(runDir, 0);
}

export interface RunJsExecutorOptions {
  fileStore: FileStore;
  /** node_modules 目录：`--allow-fs-read` 与 NODE_PATH 共用（require('exceljs') 的解析根）。 */
  nodeModulesDir: string;
  /** node 可执行文件；缺省 process.execPath。 */
  nodePath?: string;
  /** 超时上限；缺省 RUN_JS_TIMEOUT_MS。生产装配不得放宽（v8 §11：数值 S0 写死）。 */
  timeoutMs?: number;
  maxStreamBytes?: number;
  maxOutputFileBytes?: number;
  maxOutputCount?: number;
}

interface StreamCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

/** data 回调里逐块计数截断：超限部分直接丢弃并标 truncated（v8 §3，不先全读再截）。 */
function onChunk(capture: StreamCapture, chunk: Buffer, maxStreamBytes: number): void {
  if (capture.bytes >= maxStreamBytes) {
    capture.truncated = true;
    return;
  }
  const room = maxStreamBytes - capture.bytes;
  if (chunk.length <= room) {
    capture.chunks.push(chunk);
    capture.bytes += chunk.length;
    return;
  }
  capture.chunks.push(chunk.subarray(0, room));
  capture.bytes = maxStreamBytes;
  capture.truncated = true;
}

export function createRunJsExecutor(options: RunJsExecutorOptions): RunJsExecutor {
  const timeoutMs = options.timeoutMs ?? RUN_JS_TIMEOUT_MS;
  const maxStreamBytes = options.maxStreamBytes ?? RUN_JS_MAX_STREAM_BYTES;
  const maxOutputFileBytes = options.maxOutputFileBytes ?? RUN_JS_MAX_OUTPUT_FILE_BYTES;
  const maxOutputCount = options.maxOutputCount ?? RUN_JS_MAX_OUTPUT_COUNT;
  const nodePath = options.nodePath ?? process.execPath;

  return {
    async runJs(input: RunJsInput): Promise<RunJsOutput> {
      if (typeof input.code !== 'string' || input.code.length === 0) {
        throw new Error('run_js 需要 code（非空 CommonJS 字符串）。');
      }
      if (!input.scope?.principalId || !input.scope?.sessionId) {
        throw new Error('run_js 需要 scope（principalId/sessionId）。');
      }
      const startedAt = Date.now();
      const scope = input.scope;
      const runId = `run_${randomUUID().replaceAll('-', '')}`;
      const runDir = runDirOf(options.fileStore.workspaceRoot, scope, runId);
      const outDir = path.join(runDir, 'out');
      const scratchDir = path.join(runDir, 'scratch');
      const homeDir = path.join(runDir, 'home');
      const tmpDir = path.join(runDir, 'tmp');

      // 预取消（2026-11-17）：信号在调用前就已经 aborted 时，后面只注册 abort 监听不会触发
      // （事件早已发生），执行器仍会 spawn 并跑到自然结束或超时。这里直接拒跑：
      // 不建目录、不物化输入、不写 run.cjs、不 spawn、零产物、零 file_refs。
      if (input.signal?.aborted === true) {
        const scriptBytesForAudit = Buffer.from(input.code, 'utf8');
        return {
          exitCode: null,
          exitSignal: null,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          outputs: [],
          audit: {
            runId,
            runDir,
            scriptSha256: createHash('sha256').update(scriptBytesForAudit).digest('hex'),
            inputFileIds: [...(input.inputs ?? [])],
            materializedInputs: [],
            inputBytes: scriptBytesForAudit.length,
            outputs: [],
            skippedOutputs: [],
            exitCode: null,
            exitSignal: null,
            killReason: 'abort',
            durationMs: Date.now() - startedAt,
          },
        };
      }

      // 布局收窄 ①：先于输入物化。in/ 是宿主写侧（copyFileSync）——若它是预植软链，
      // 物化会把输入写进 run 目录之外；物化前先确认所有布局项要么不存在、要么是真目录。
      assertRunLayoutSafe(runId, runDir);

      // ① 输入面先过（scope/激活校验 + 物化）：失败抛 FILE_REF_UNAVAILABLE，不起子进程。
      // 解析作用域（CAP-01 S2，v8 §4）：缺省 Main 面（task_id IS NULL）；Worker 面
      // （taskId 设置）只解析当前任务的绑定行。
      const materializedInputs = options.fileStore.materializeInputs({
        runDir,
        scope,
        fileIds: input.inputs ?? [],
        resolution: input.taskId === undefined ? { side: 'main' } : { side: 'worker', taskId: input.taskId },
      });

      // 布局收窄 ②：物化期间布局项可能被替换（空输入时 in/ 已由物化创建）；mkdir 前再验，
      // 避免 mkdirSync 对「软链 → 已存在目录」静默通过、或对悬空软链抛裸 ENOENT。
      assertRunLayoutSafe(runId, runDir);

      for (const dir of [outDir, scratchDir, homeDir, tmpDir]) mkdirSync(dir, { recursive: true });

      // 布局收窄 ③（spawn 前最后一道）：此刻的目录项就是子进程的读/写面与产物收集面。
      assertRunLayoutSafe(runId, runDir);

      // ② 模型代码原样写进 run.cjs（CommonJS）；审计哈希 = 实际执行字节。
      const scriptBytes = Buffer.from(input.code, 'utf8');
      const runCjsPath = path.join(runDir, 'run.cjs');
      writeFileSync(runCjsPath, scriptBytes, { mode: 0o600 });
      const scriptSha256 = createHash('sha256').update(scriptBytes).digest('hex');

      // 输入总字节（CAP-01 内存墙事件「多大」的机械事实）：脚本字节 + in/ 物化输入实际字节。
      // stat 失败（物化后被外部删除等）只影响记账，不拦运行——子进程读不到会自己非零退出。
      let inputBytes = scriptBytes.length;
      for (const materialized of materializedInputs) {
        try {
          inputBytes += statSync(path.join(runDir, 'in', materialized.materializedName)).size;
        } catch {
          // 该份不计入；运行与失败面仍由子进程如实带回。
        }
      }

      // ③ 受限子进程（v8 §3 的命令形状 + 内存上限 argv）。
      const child = spawn(
        nodePath,
        [
          '--permission',
          `--allow-fs-read=${runDir}`,
          `--allow-fs-read=${options.nodeModulesDir}`,
          `--allow-fs-write=${outDir}`,
          `--allow-fs-write=${scratchDir}`,
          `--max-old-space-size=${RUN_JS_MAX_OLD_SPACE_MB}`,
          runCjsPath,
        ],
        {
          cwd: runDir,
          detached: true, // 独立进程组：kill(-pid) 才能整组带走
          stdio: ['ignore', 'pipe', 'pipe'],
          // env 按 worker-env 白名单重建（fail-closed），再叠 run 目录指针：
          // HOME/TMPDIR 指向 run 目录下的空目录；NODE_PATH 指向授权读的 node_modules。
          env: {
            ...workerSubprocessEnv(process.env),
            HOME: homeDir,
            TMPDIR: tmpDir,
            NODE_PATH: options.nodeModulesDir,
          },
        },
      );

      const pid = child.pid;
      if (pid === undefined) {
        // spawn 同步失败（pid 只在成功 spawn 后有值）：把异步 'error' 带出来，不做进程组 kill。
        throw await new Promise<Error>((resolve) => child.once('error', resolve));
      }

      const stdoutCapture: StreamCapture = { chunks: [], bytes: 0, truncated: false };
      const stderrCapture: StreamCapture = { chunks: [], bytes: 0, truncated: false };
      child.stdout.on('data', (chunk: Buffer) => onChunk(stdoutCapture, chunk, maxStreamBytes));
      child.stderr.on('data', (chunk: Buffer) => onChunk(stderrCapture, chunk, maxStreamBytes));

      let killReason: 'timeout' | 'abort' | undefined;
      const timer = setTimeout(() => {
        killReason = 'timeout';
        killRunProcessGroup(pid);
      }, timeoutMs);
      const onAbort = (): void => {
        killReason = 'abort';
        killRunProcessGroup(pid);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject); // spawn 本身失败（ENOENT 等）
          child.once('close', () => resolve());
        });
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      }

      const exitCode = child.exitCode;
      const exitSignal = child.signalCode;

      // ④ 扫 out/ 登记产物（无论 exitCode——out/ 就是交付箱；交付去留归 S1）。
      // 产物绑定（CAP-01 S2 ①）：Worker 面（taskId 设置）的产物行绑定当前任务。
      const { outputs, skipped } = options.fileStore.registerOutputsFromOut({
        runDir,
        scope,
        limits: { maxFileBytes: maxOutputFileBytes, maxCount: maxOutputCount },
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      });

      const outputFiles = outputs.map(
        (file: RegisteredFile): RunJsOutputFile => ({ fileId: file.fileId, name: file.name, bytes: file.bytes }),
      );
      return {
        exitCode,
        exitSignal,
        stdout: Buffer.concat(stdoutCapture.chunks).toString('utf8'),
        stderr: Buffer.concat(stderrCapture.chunks).toString('utf8'),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        outputs: outputFiles,
        audit: {
          runId,
          runDir,
          scriptSha256,
          inputFileIds: [...(input.inputs ?? [])],
          materializedInputs,
          inputBytes,
          outputs: outputFiles,
          skippedOutputs: skipped,
          exitCode,
          exitSignal,
          ...(killReason === undefined ? {} : { killReason }),
          durationMs: Date.now() - startedAt,
        },
      };
    },
  };
}
