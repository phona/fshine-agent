/**
 * 执行层文件桥（CAP-01 S2 ②③④；docs/architecture/files.md §6/§10-3）。
 *
 * 位置与依赖方向：由**装配层**（ask-runtime 的装配核心）构造——它持有 `platformRoot`
 * （profile.root）与 fileStore（文件区监管，唯一写侧），并把装饰后的执行客户端按任务交给
 * runtime。runtime 只认 RuntimeOptions.taskExecutionBridge 端口（type-only import），
 * 不持任何平台路径；通用运行时的值闭包不含本模块。
 *
 * 两个方向、两个所有者：
 *   · **出站 = assemble 装饰器（本模块）**：把任务文件物化到 `<platformRoot>/tmp/task_<id>/in/`
 *     并替换执行层**声明的目录参数**（如 `--input-dir`）的值；产物目录参数（如
 *     `--output-dir`）替换为 `…/out/`。只按装配方声明的参数名替换（含裸名形态归一）——
 *     **不遍历 args 猜类型**、不引入 `kind:"file"`、不新增契约字段（execution-contract.ts：
 *     args 对宿主不透明）。未声明目录参数的调用零翻译、零物化。
 *   · **回程 = runtime 出口调用（登记本体在本模块，调用点不在适配器）**：执行层返回
 *     `data.files[...]` 的 path/base64 条目 → fileStore 登记成新 file_id（任务产物池 sha256
 *     去重，ask ⑤）→ 返回等长替换列表（登记事实），path/base64 从 data 里剥掉——runtime
 *     以替换列表回填 outcome 后才交模型/落定（转录与底账不见路径与内联字节）。
 *     不能在适配器登记：登记面必须盖住所有 ExecutionClient（含测试假件），且剥除必须先于
 *     outcome 进转录。
 *   · **兜底（v8 §10-3）**：任务收尾（无论有没有汇报/执行成败）扫 `<taskDir>/out/` 全量
 *     登记——执行层写了产物但 outcome 没带回 data.files（失败/中止）时产物不丢；与回程
 *     登记同池去重（同 sha 复用旧 fileId，不重复落盘）。
 *
 * 边界纪律：回程 path 必须是 allowedRoot（任务暂存目录）内的绝对路径——执行层之外的
 * 路径不开口子；无字节面的条目（纯 name 元数据、字符串等）原样透传（宿主只消费它声明
 * 的形状）；本模块不 spawn、不触网、不读 data 的其他字段。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ExecutionCallOptions, ExecutionClient, ExecutionRequest } from '@fshine/contracts/execution-contract';
import {
  TaskFileRejectedError,
  type ActiveFileRef,
  type FileScope,
  type FileStore,
  type RegisteredFile,
  type SkippedOutput,
} from './file-store';
import { materializePayload, type PayloadMaterializeResult } from './payload-materializer';

/** 任务产物上限（缺省与 run_js 交付箱同值；生产装配不得放宽，v8 §11 数值 S0 写死）。 */
export const TASK_FILE_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
export const TASK_FILE_MAX_OUTPUT_COUNT = 20;

/** 桥依赖的文件区监管面（Pick；装配层注入 fileStore 本身——与 taskInputCopier 同一实例）。 */
export type TaskFileBridgeStore = Pick<
  FileStore,
  'listTaskFiles' | 'materializeInputs' | 'registerTaskFile' | 'registerTaskFileFromPath' | 'registerOutputsFromOut'
>;

export interface TaskExecutionBridgeOptions {
  /** 平台根（装配层持有的可信路径，如 profile.root）；任务暂存目录在其 tmp/ 下。 */
  platformRoot: string;
  /** 文件区监管（唯一写侧）的交接面；与交办复制面同一 fileStore 实例。 */
  fileStore: TaskFileBridgeStore;
  /** 会话身份（装配层渠道事实；每会话一个桥）。 */
  scope: FileScope;
  /** 被装饰的内层执行客户端（桥不改写它的响应——登记调用点在 runtime 出口）。 */
  inner: ExecutionClient;
  /**
   * 执行层声明的目录参数名（宿主替换其值；缺省无 = 桥只承担回程登记与兜底扫描）。
   * 参数名来自部署对该执行层的声明认知（如 '--input-dir'），不来自对 args 的形状猜测。
   */
  dirParams?: { input?: string; output?: string };
  /**
   * 执行层声明的**单文件**参数名（2026-11-17 补）：宿主把任务文件的物化路径填进去。
   *   · input：任务必须**恰好一个**文件（多或少都不猜，fail-closed 抛错）；
   *   · output：宿主在任务 out/ 下分配一个确定路径（`exec-output.json`），执行层写到那里，
   *     随后由兜底扫描登记成任务产物并进入交付。
   * 与 dirParams 同源：只认装配方声明的参数名，不按 args 形状猜测。
   */
  fileParams?: { input?: string; output?: string };
  /** 产物上限（缺省 TASK_FILE_*）。 */
  maxOutputFileBytes?: number;
  maxOutputCount?: number;
  /** 拒收/扫描失败的上报（机械 reason，只进日志；缺省静默）。 */
  onSkip?: (reason: string) => void;
}

/** 回程登记结果：与输入条目等长的替换列表 + 登记成功的事实（交付收集用）。 */
export interface ReturnedFileRegistration {
  /**
   * 与 entries 等长：登记事实（fileId/name/bytes）替换有字节面的条目；拒收条目替换为
   * { name, unavailable: reason }；未消费条目（无字节面/非对象）原样。
   */
  entries: unknown[];
  /** 登记成功的事实。 */
  files: RegisteredFile[];
}

export interface TaskExecutionBridge {
  /** 出站装饰后的执行客户端（本任务的目录翻译；响应原样透传）。 */
  readonly client: ExecutionClient;
  /**
   * 当前任务的文件面（机械事实投影：fileId/name/bytes；与物化同源、同一可读性谓词）。
   * Worker 委派的任务文件清单从这里取——后台单回合执行器不另建文件发现路径。
   */
  taskFiles(): ActiveFileRef[];
  /** 回程登记（runtime 出口调用）：data.files 原始条目 → 等长替换列表 + 登记事实。 */
  registerReturnedFiles(entries: readonly unknown[]): Promise<ReturnedFileRegistration>;
  /** 兜底扫描（v8 §10-3）：任务 out/ 全量登记（同池去重）；目录不存在 → 空结果。 */
  sweepTaskOutputs(): { files: RegisteredFile[]; skipped: SkippedOutput[] };
  /**
   * 载荷型参数的物化（2026-11-19）：把模型给的结构化**值**按 schema lint 后原子落盘到
   * `<taskDir>/in/<param>.json`，返回绝对路径或结构化失败（missing/unknown）。
   * 任务暂存目录是桥持有的可信路径（模型/用户看不到、填不进）。
   */
  materializePayload(input: { param: string; value: unknown; schema?: unknown; maxBytes?: number }): PayloadMaterializeResult;
}

/** 按任务构造桥的工厂（runtime 的 RuntimeOptions.taskExecutionBridge 端口形状）。 */
export type TaskExecutionBridgeFactory = (taskId: string) => TaskExecutionBridge;

/** taskId 形状守卫：任务暂存目录名由宿主派生，拒绝越界形状进路径拼接。 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function taskDirOf(platformRoot: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`taskId 形状非法，拒绝派生任务暂存目录：${JSON.stringify(taskId.slice(0, 64))}`);
  return path.join(platformRoot, 'tmp', `task_${taskId}`);
}

/** 声明目录参数在 args 里的命中形态：声明名（'--input-dir'）或裸名（'input-dir'）。 */
function dirParamKeyOf(args: Readonly<Record<string, unknown>>, declared: string): { declaredKey: string; bareKey?: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(args, declared)) return { declaredKey: declared };
  const bare = declared.replace(/^--/, '');
  if (bare !== declared && Object.prototype.hasOwnProperty.call(args, bare)) return { declaredKey: declared, bareKey: bare };
  return undefined;
}

/** 有无字节面（path / base64 content）的条目分类；其余条目宿主不消费、原样透传。 */
interface PayloadEntry {
  kind: 'payload';
  name: string | null;
  sourcePath?: string;
  contentBase64?: string;
  /**
   * 登记角色（契约 v4 长任务大日志）：条目显式 `deliverable:false` = 宿主内部产物
   * （任务作用域可读，不进用户附件）。缺省/true = 用户产物（既有语义不变）。
   */
  deliverable?: boolean;
}

function classifyEntry(entry: unknown): PayloadEntry | { kind: 'unconsumed' } {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { kind: 'unconsumed' };
  const record = entry as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : null;
  const deliverable = record.deliverable === false ? false : undefined;
  if (typeof record.path === 'string' && record.path.trim() !== '') {
    return { kind: 'payload', name, sourcePath: record.path, ...(deliverable === undefined ? {} : { deliverable }) };
  }
  if (typeof record.content === 'string' && record.content.trim() !== '') {
    return { kind: 'payload', name, contentBase64: record.content, ...(deliverable === undefined ? {} : { deliverable }) };
  }
  return { kind: 'unconsumed' };
}

export function createTaskExecutionBridge(options: TaskExecutionBridgeOptions): TaskExecutionBridgeFactory {
  const maxOutputFileBytes = options.maxOutputFileBytes ?? TASK_FILE_MAX_OUTPUT_BYTES;
  const maxOutputCount = options.maxOutputCount ?? TASK_FILE_MAX_OUTPUT_COUNT;
  const inputParam = options.dirParams?.input;
  const outputParam = options.dirParams?.output;
  const inputFileParam = options.fileParams?.input;
  const outputFileParam = options.fileParams?.output;
  const skip = (reason: string): void => options.onSkip?.(reason);

  return (taskId: string) => {
    const taskDir = taskDirOf(options.platformRoot, taskId);
    const inDir = path.join(taskDir, 'in');
    const outDir = path.join(taskDir, 'out');

    /** 出站翻译：只替换声明的目录参数（含裸名归一），其余 args 原样（未命中返回原引用）。 */
    function replaceDeclaredDir(args: Readonly<Record<string, unknown>>, declared: string, value: string): Record<string, unknown> {
      const hit = dirParamKeyOf(args, declared);
      if (hit === undefined) return args as Record<string, unknown>;
      const next: Record<string, unknown> = { ...args };
      if (hit.bareKey !== undefined) delete next[hit.bareKey];
      next[hit.declaredKey] = value;
      return next;
    }

    const client: ExecutionClient = {
      capabilities: () => options.inner.capabilities(),
      async execute(request: ExecutionRequest, callOptions?: ExecutionCallOptions) {
        let nextArgs = request.args;
        if (inputParam !== undefined && dirParamKeyOf(nextArgs, inputParam) !== undefined) {
          // 物化当前任务的文件面（可读绑定行，v8 §4 Worker 解析侧）到 <taskDir>/in/。
          // 任一不可读 → FileRefUnavailableError 上抛（不起执行，走既有失败路径）。
          const taskFiles = options.fileStore.listTaskFiles({ scope: options.scope, taskId, now: Date.now() });
          options.fileStore.materializeInputs({
            runDir: taskDir,
            scope: options.scope,
            fileIds: taskFiles.map((file) => file.fileId),
            resolution: { side: 'worker', taskId },
          });
          nextArgs = replaceDeclaredDir(nextArgs, inputParam, inDir);
        }
        if (outputParam !== undefined && dirParamKeyOf(nextArgs, outputParam) !== undefined) {
          mkdirSync(outDir, { recursive: true });
          nextArgs = replaceDeclaredDir(nextArgs, outputParam, outDir);
        }
        if (inputFileParam !== undefined && dirParamKeyOf(nextArgs, inputFileParam) !== undefined) {
          // 单文件输入：任务必须恰好一个文件——数量不符就 fail-closed（不替调用方挑文件）。
          const taskFiles = options.fileStore.listTaskFiles({ scope: options.scope, taskId, now: Date.now() });
          if (taskFiles.length !== 1) {
            throw new Error(
              `单文件参数 ${inputFileParam} 需要恰好 1 个任务文件（当前 ${taskFiles.length} 个），拒绝猜测`,
            );
          }
          const materialized = options.fileStore.materializeInputs({
            runDir: taskDir,
            scope: options.scope,
            fileIds: [taskFiles[0]!.fileId],
            resolution: { side: 'worker', taskId },
          });
          nextArgs = replaceDeclaredDir(nextArgs, inputFileParam, path.join(inDir, materialized[0]!.materializedName));
        }
        if (outputFileParam !== undefined && dirParamKeyOf(nextArgs, outputFileParam) !== undefined) {
          // 单文件输出：宿主分配任务 out/ 下的确定路径；写进去后由兜底扫描登记成产物。
          mkdirSync(outDir, { recursive: true });
          nextArgs = replaceDeclaredDir(nextArgs, outputFileParam, path.join(outDir, 'exec-output.json'));
        }
        if (nextArgs === request.args) {
          return callOptions === undefined ? options.inner.execute(request) : options.inner.execute(request, callOptions);
        }
        const decorated = { ...request, args: nextArgs };
        return callOptions === undefined ? options.inner.execute(decorated) : options.inner.execute(decorated, callOptions);
      },
    };

    return {
      client,
      taskFiles() {
        // 与出站物化同一来源：任务副本 + 任务产物池（当前任务的绑定行、已激活且 TTL 内）。
        return options.fileStore.listTaskFiles({ scope: options.scope, taskId, now: Date.now() });
      },
      materializePayload(input: { param: string; value: unknown; schema?: unknown; maxBytes?: number }): PayloadMaterializeResult {
        // 装信封归宿主：值 → lint → 落盘到本任务 in/，返回路径。执行层只认路径参数。
        return materializePayload({
          taskDir,
          label: input.param,
          value: input.value,
          ...(input.schema === undefined ? {} : { schema: input.schema }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        });
      },
      async registerReturnedFiles(entries: readonly unknown[]): Promise<ReturnedFileRegistration> {
        const out: unknown[] = [];
        const files: RegisteredFile[] = [];
        for (const entry of entries) {
          const classified = classifyEntry(entry);
          if (classified.kind === 'unconsumed') {
            out.push(entry); // 执行层自己的数据（元数据/字符串）：宿主不改写。
            continue;
          }
          if (files.length >= maxOutputCount) {
            skip(`count_limit:${classified.name ?? ''}`);
            out.push({ name: classified.name, unavailable: 'count_limit' });
            continue;
          }
          if (classified.sourcePath === undefined && classified.name === null) {
            // 内联字节面没有可归属的文件名：登记面（file_refs.name）无法成立，拒收。
            skip('missing_name');
            out.push({ name: null, unavailable: 'missing_name' });
            continue;
          }
          try {
            const file = classified.sourcePath !== undefined
              ? options.fileStore.registerTaskFileFromPath({
                scope: options.scope,
                taskId,
                sourcePath: classified.sourcePath,
                allowedRoot: taskDir,
                name: classified.name ?? path.basename(classified.sourcePath),
                maxFileBytes: maxOutputFileBytes,
              })
              : options.fileStore.registerTaskFile({
                scope: options.scope,
                taskId,
                name: classified.name!,
                bytes: Buffer.from(classified.contentBase64!, 'base64'),
                maxFileBytes: maxOutputFileBytes,
                ...(classified.deliverable === undefined ? {} : { deliverable: classified.deliverable }),
              });
            files.push(file);
            // 登记事实整体替换原条目：path / base64 不进替换列表（runtime 回填后进转录与落定）。
            out.push({ fileId: file.fileId, name: file.name, bytes: file.bytes });
          } catch (error) {
            const reason = error instanceof TaskFileRejectedError ? error.reason : 'register_failed';
            skip(`${reason}:${classified.name ?? classified.sourcePath ?? ''}`);
            out.push({ name: classified.name, unavailable: reason });
          }
        }
        return { entries: out, files };
      },
      sweepTaskOutputs(): { files: RegisteredFile[]; skipped: SkippedOutput[] } {
        try {
          const swept = options.fileStore.registerOutputsFromOut({
            runDir: taskDir,
            scope: options.scope,
            limits: { maxFileBytes: maxOutputFileBytes, maxCount: maxOutputCount },
            taskId,
          });
          return { files: swept.outputs, skipped: swept.skipped };
        } catch (error) {
          // 扫描失败不阻塞任务收尾（产物仍在磁盘，事件如实上报）。
          skip(`scan_failed:${error instanceof Error ? error.message : String(error)}`);
          return { files: [], skipped: [] };
        }
      },
    };
  };
};
