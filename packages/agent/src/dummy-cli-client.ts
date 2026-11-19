/**
 * 仓内 dummy 执行层适配器：把 ExecutionClient 语义翻译成 dummy 网关 CLI 调用。
 *
 * 位置与依赖方向：这是**传输适配器**，只被装配入口（scripts/ask.ts、apps/server/server.ts）使用；
 * 通用运行时（execution-runtime.ts）不 import 它。适配器单向依赖执行契约。
 *
 * 职责只有翻译，没有裁决：
 *   · 能力快照 = 执行层 `operation list --json` 的投影（一次取回，进程内复用）；
 *   · 结构化请求 = `call --file <json>`（CLI 只认带前缀的参数键：适配器按执行层声明
 *     把裸参数名规范化成声明里的形态，其余原样透传，由执行层校验并拒绝）；
 *     `confirmation`（句柄 + 用户原话）按契约放在请求体顶层，适配器**原样转发**，
 *     不解析句柄、不判断用户是不是在确认；
 *   · 结果 = stdout 末行 RESULT 信封 → ExecutionOutcome 五态（含 needs_confirmation）；
 *     非零退出且无信封 = 执行层拒绝或失败，按退出码与 stderr 机械分流，不嗅探文案。
 *   · 单次调用的传输超时（owner 2026-11-19 分工表第一格）= 传输入口的**唯一**界
 *     （`runGateway` 定时器；缺省 `EXECUTION_CALL_TIMEOUT_MS` = 60s，可用构造参数收窄）：
 *     到点停掉子进程并如实返回 `failed` + `code: result_unknown`（**结果未知**：没有回执，
 *     无法确认执行层那边做没做完），不声明可重试——宿主据此走待核对收口，不做「失败已确认」。
 *     `wait` 的截断（子进程上限 = 长轮询窗口 + 5s）**同一语义**：没有回执 ≠ 长任务失败，
 *     任务仍在等（task-runner 退避续等、如实告知用户一次，不判死、不重试风暴）。
 *
 * 读路径切片的作用域不在这里：本适配器按契约忠实执行被请求的 operation；
 * 「本轮开放哪些 operation」由装配方从执行层自述的 access 声明派生（只读集合 +
 * `runtime.allowWriteOperations` 打开时的写集合）并由通用运行时的允许集合在发起执行前
 * 拒收集合外调用。本文件不持治理策略。
 *
 * 子进程 env 走 worker 白名单（worker-env.ts，B 类凭据隔离）；状态根只经
 * 测试专用 `--state-dir` 传入（不依赖任何环境变量改道）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXECUTION_CONTRACT_VERSION,
  type CapabilityManifest,
  type ConfirmationPrompt,
  type ExecutionAbortResult,
  type ExecutionArgDeclaration,
  type ExecutionCallOptions,
  type ExecutionClient,
  type ExecutionFailure,
  type ExecutionItemResult,
  type ExecutionOutcome,
  type ExecutionRequest,
  type MissingInput,
} from '@fshine/contracts/execution-contract';
import { workerSubprocessEnv } from './worker-env';

/** 执行层清单行（原始面）：只做形状读取，未知字段原样忽略。 */
export interface RawGatewayOperation {
  name: string;
  label?: string;
  access?: string;
  /** 执行层自述的成本提示（A1）：形状校验后投影为契约的 weight/estimatedSeconds。 */
  weight?: unknown;
  est_seconds?: unknown;
  /**
   * 长任务声明（契约 v4）：只做形状校验（true 才投影）——执行层声明该 operation 可能
   * 返回 accepted；宿主据此决定是否允许 accepted（未声明却返回 = 协议违约，fail-closed）。
   */
  long_running?: unknown;
  /**
   * 模型可见性声明（契约 v4，可选）：只做形状校验（false 才投影）——执行层声明该
   * operation 不进模型可见面；宿主据此收紧允许集合与委派清单。缺省/其它形状 = 可见。
   */
  model_visible?: unknown;
  args?: {
    positional?: Array<{ name?: string; required?: boolean; payload?: { schema?: unknown } }>;
    flags?: Array<{ flag?: string; required?: boolean; style?: string; payload?: { schema?: unknown } }>;
  };
}

/**
 * 单次执行层调用的传输超时（宿主常量，2026-11-19 owner 分工表第一格）：**执行层调用挂住**
 * 由「单次调用的传输超时」兜底——不是任务总时长、不是回合总时长、不是到点杀任务。
 * 缺省 60s 沿用既有旋钮缺省（本适配器 `timeoutMs` 一直有此缺省，见
 * `docs/product/real-read-readiness.md`「单次适配器调用缺省 60s」）；导出只为守卫测试，
 * 不新增 runtime 配置键（与 `WAKE_TURN_MS` 同口径）。
 */
export const EXECUTION_CALL_TIMEOUT_MS = 60_000;

export interface DummyCliClientOptions {
  /** 夹具根（绝对路径）：网关与技能面的挂载点。 */
  root: string;
  /** 网关入口（相对 root，例如 bin/dummy）。 */
  gateway: string;
  /** 本试用的执行层状态根（`--state-dir`；审计与数据都落在这里）。 */
  stateDir: string;
  /** 继承的进程 env——spawn 前按 worker 白名单重建，不整体继承。 */
  env: NodeJS.ProcessEnv;
  /** 单次网关调用上限；缺省 {@link EXECUTION_CALL_TIMEOUT_MS}（60s）。 */
  timeoutMs?: number;
}

export interface DummyCliClient extends ExecutionClient {
  /** 原始清单（适配器面）：读路径切片的作用域从执行层自述的 access 派生。 */
  listOperations(): Promise<readonly RawGatewayOperation[]>;
}

/** 从执行层自述的 access 声明派生只读 operation 集合（读路径作用域；不是契约语义）。 */
export function readOnlyOperationNames(operations: readonly RawGatewayOperation[]): string[] {
  return operations.filter((operation) => operation.access === 'read').map((operation) => operation.name);
}

/**
 * 从执行层自述的 access 声明派生写 operation 集合（装配开关打开时才进入允许集合）。
 * 与只读集合各自独立派生：写操作**永不**混进只读集合（否则重试会把写当读安全重发）。
 */
export function writeOperationNames(operations: readonly RawGatewayOperation[]): string[] {
  return operations.filter((operation) => operation.access === 'write').map((operation) => operation.name);
}

interface GatewayRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  spawnFailed?: boolean;
  /** 宿主取消信号触发：网关子进程已被终止，本次调用没有可用回执。 */
  aborted?: boolean;
}

interface ResultEnvelope {
  status?: unknown;
  data?: unknown;
  error?: unknown;
  confirmation?: unknown;
  /** 长任务受理句柄（accepted 信封的顶层字段，与 confirmation 同层）。 */
  operationId?: unknown;
  pollAfterMs?: unknown;
  /** 批量写逐条结果（completed 信封的顶层字段；与 data 同层，宿主只做形状校验）。 */
  items?: unknown;
}

export function createDummyCliClient(options: DummyCliClientOptions): DummyCliClient {
  const timeoutMs = options.timeoutMs ?? EXECUTION_CALL_TIMEOUT_MS;
  const gatewayPath = path.join(options.root, options.gateway);
  let listing: Promise<readonly RawGatewayOperation[]> | undefined;

  function runGateway(args: string[], signal?: AbortSignal, timeoutOverrideMs?: number): Promise<GatewayRun> {
    // 预取消：不 spawn、不产生任何网关副作用（与 run_js 执行器的预取消同口径）。
    if (signal?.aborted === true) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', aborted: true });
    }
    // wait 的长轮询窗口可以超过通用单次调用上限：调用方给出覆盖值（网关内部按 timeoutMs
    // 自己返回 accepted，适配器只负责别在窗口内把自己的子进程杀掉）。
    const callTimeoutMs = timeoutOverrideMs ?? timeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (run: GatewayRun): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        resolve(run);
      };
      // 取消在飞调用：杀网关子进程并如实返回「无回执」，由调用方按取消语义处置。
      const onAbort = (): void => {
        child.kill('SIGKILL');
        settle({ code: null, stdout: '', stderr: '', aborted: true });
      };
      const child = spawn(gatewayPath, args, {
        cwd: options.root,
        // B 类凭据隔离：白名单重建（见 worker-env.ts）。
        env: workerSubprocessEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', () => settle({ code: null, stdout: '', stderr: '', spawnFailed: true }));
      child.once('close', (code: number | null) => settle({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        settle({ code: null, stdout: '', stderr: '', timedOut: true });
      }, callTimeoutMs);
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  const listOperations = (): Promise<readonly RawGatewayOperation[]> => {
    listing ??= runGateway(['operation', 'list', '--json']).then((run) => {
      if (run.timedOut) throw new Error('执行层能力清单读取超时。');
      if (run.spawnFailed) throw new Error(`执行层网关无法启动：${gatewayPath}`);
      if (run.code !== 0) throw new Error(`执行层能力清单读取失败（exit ${run.code}）：${run.stderr.trim()}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.stdout);
      } catch {
        throw new Error('执行层能力清单不是可解析的 JSON。');
      }
      const operations = (parsed as { operations?: unknown }).operations;
      if (!Array.isArray(operations)) throw new Error('执行层能力清单缺少 operations 数组。');
      return operations.flatMap((entry): RawGatewayOperation[] => {
        const candidate = entry as { name?: unknown };
        return typeof candidate?.name === 'string' && candidate.name !== ''
          ? [entry as RawGatewayOperation]
          : [];
      });
    });
    return listing;
  };

  return {
    listOperations,
    async capabilities(): Promise<CapabilityManifest> {
      const operations = await listOperations();
      return {
        contractVersion: EXECUTION_CONTRACT_VERSION,
        operations: operations.map((operation) => {
          // A1 成本提示投影：执行层自述的 weight/est_seconds 原样进声明（缺省/形状不对
          // = 字段不出现，零行为变化）；宿主只转述，不解释、不裁决、不做阈值判定。
          const weight = declaredCostOf(operation.weight);
          const estimatedSeconds = declaredCostOf(operation.est_seconds);
          return {
            name: operation.name,
            ...(typeof operation.label === 'string' && operation.label !== '' ? { label: operation.label } : {}),
            ...(weight === undefined ? {} : { weight }),
            ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }),
            // 契约 v4：long_running 只认显式 true（缺省/其它形状 = 未声明）。
            ...(operation.long_running === true ? { long_running: true } : {}),
            // 契约 v4：model_visible 只认显式 false（缺省/其它形状 = 可见，逐字节不变）。
            ...(operation.model_visible === false ? { model_visible: false } : {}),
            args: declaredArgsOf(operation),
          };
        }),
      };
    },
    async execute(
      request: ExecutionRequest,
      callOptions?: ExecutionCallOptions,
    ): Promise<ExecutionOutcome> {
      const operations = await listOperations();
      const operation = operations.find((entry) => entry.name === request.operation);
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'dummy-exec-'));
      try {
        const callFile = path.join(scratch, 'call.json');
        // U3：请求体同时携带逻辑操作身份（dispatchKey）——执行层可据此派生幂等键；
        // requestId 只作追踪，不承担身份语义。
        writeFileSync(callFile, JSON.stringify({
          operation: request.operation,
          dispatchKey: request.dispatchKey,
          args: normalizeArgs(operation, request.args),
          // 确认引用按契约原样转发：适配器不解释句柄、不改写用户原话。
          ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
        }));
        const run = await runGateway(['call', '--file', callFile, '--state-dir', options.stateDir], callOptions?.signal);
        // 取消是「调用被中止」，不是执行层返回的失败：只抛中止，由运行时按取消语义处置。
        if (run.aborted === true) {
          const error = new Error('执行层调用已被取消。');
          error.name = 'AbortError';
          throw error;
        }
        return outcomeOf(run, request, operations, timeoutMs);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    /**
     * 长轮询等待（契约 v4）：`wait --operation-id <id> --timeout-ms <n>` 在网关侧阻塞到
     * 完成/失败/窗口到期；窗口到期返回 accepted（仍在执行）。适配器的子进程上限取
     * `max(timeoutMs + 5s, 通用上限)`——窗口是网关自己的事，别在窗口内杀它。
     */
    async wait(
      operationId: string,
      timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<ExecutionOutcome> {
      const run = await runGateway(
        ['wait', '--operation-id', operationId, '--timeout-ms', String(timeoutMs), '--state-dir', options.stateDir],
        signal,
        Math.max(timeoutMs + 5_000, timeoutMs),
      );
      if (run.aborted === true) {
        const error = new Error('执行层等待已被取消。');
        error.name = 'AbortError';
        throw error;
      }
      return waitOutcomeOf(run, operationId, timeoutMs);
    },
    /** 中止（契约 v4）：只有执行层明确回 `aborted: true` 才算停掉，其余如实返回失败原因。 */
    async abort(operationId: string, callOptions?: ExecutionCallOptions): Promise<ExecutionAbortResult> {
      const run = await runGateway(
        ['abort', '--operation-id', operationId, '--state-dir', options.stateDir],
        callOptions?.signal,
      );
      if (run.aborted === true) return { aborted: false, reason: '中止请求已被宿主取消。' };
      if (run.timedOut === true) return { aborted: false, reason: `中止请求超时（${timeoutMs}ms）。` };
      if (run.spawnFailed === true) return { aborted: false, reason: '执行层网关无法启动。' };
      const envelope = parseEnvelope(run.stdout);
      const data = envelope?.data;
      if (envelope?.status === 'completed' && data !== null && typeof data === 'object'
        && (data as { aborted?: unknown }).aborted === true) {
        return { aborted: true };
      }
      const reason = data !== null && typeof data === 'object' && typeof (data as { reason?: unknown }).reason === 'string'
        ? (data as { reason: string }).reason
        : (run.stderr.trim() !== '' ? run.stderr.trim() : `执行层未确认中止（exit ${String(run.code)}）。`);
      return { aborted: false, reason };
    },
  };
}

/** 成本提示的形状校验：有限数值才投影；缺省/非数值 = 字段不出现（不解释、不裁决）。 */
function declaredCostOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 载荷型参数声明的形状投影：只认 `{ schema }`（schema 缺省 = 不校验）；其余形状丢弃。 */
function declaredPayloadOf(value: unknown): { schema?: unknown } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as { schema?: unknown };
  return candidate.schema === undefined ? {} : { schema: candidate.schema };
}

/** 参数声明投影：位置参数在前、flag 在后；空名条目丢弃。载荷型声明（payload）原样带上。 */
function declaredArgsOf(operation: RawGatewayOperation): ExecutionArgDeclaration[] {
  const positional = (operation.args?.positional ?? [])
    .filter((entry) => typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => ({
      name: entry.name as string,
      required: entry.required === true,
      ...(declaredPayloadOf(entry.payload) === undefined ? {} : { payload: declaredPayloadOf(entry.payload) }),
    }));
  const flags = (operation.args?.flags ?? [])
    .filter((entry) => typeof entry.flag === 'string' && entry.flag !== '')
    .map((entry) => ({
      name: entry.flag as string,
      required: entry.required === true,
      ...(typeof entry.style === 'string' && entry.style !== '' ? { type: entry.style } : {}),
      ...(declaredPayloadOf(entry.payload) === undefined ? {} : { payload: declaredPayloadOf(entry.payload) }),
    }));
  return [...positional, ...flags];
}

/**
 * 结构化 args → CLI 参数键：CLI 只认声明里的形态（flag 带前缀）。裸名与声明一致时
 * 规范化为声明形态；其余键原样透传，由执行层按自己的声明拒绝未登记参数。
 */
function normalizeArgs(
  operation: RawGatewayOperation | undefined,
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declaredFlags = new Set(
    (operation?.args?.flags ?? [])
      .map((flag) => flag.flag)
      .filter((name): name is string => typeof name === 'string' && name.startsWith('--')),
  );
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[declaredFlags.has(`--${key}`) ? `--${key}` : key] = value;
  }
  return normalized;
}

function parseEnvelope(stdout: string): ResultEnvelope | undefined {
  const lines = stdout.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith('RESULT ')) continue;
    try {
      const parsed = JSON.parse(line.slice('RESULT '.length)) as ResultEnvelope;
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function failureOf(error: unknown): ExecutionFailure {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; correctForm?: unknown; retryable?: unknown };
    const code = typeof candidate.code === 'string' && candidate.code !== '' ? candidate.code : 'EXECUTION_UNKNOWN_ERROR';
    const message = typeof candidate.message === 'string' && candidate.message !== ''
      ? candidate.message
      : '执行层返回了未结构化错误。';
    return {
      code,
      message,
      // 执行层的 **retryable 声明必须透传**：这是「确定性失败本回合不再撞」的唯一判据
      // （execution-runtime A2b）。此前这里丢了这个字段，导致守卫在真实链路里从不生效——
      // E14 30 轮里 11 次重试风暴就是这条断线。
      ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {}),
      ...(typeof candidate.correctForm === 'string' && candidate.correctForm !== ''
        ? { details: { correctForm: candidate.correctForm } }
        : {}),
    };
  }
  return { code: 'EXECUTION_UNKNOWN_ERROR', message: '执行层返回了未结构化错误。' };
}

function missingInputsOf(
  request: ExecutionRequest,
  operation: RawGatewayOperation | undefined,
  envelope: ResultEnvelope,
): MissingInput[] {
  const declared = declaredArgsOf(operation ?? { name: request.operation });
  const provided = request.args;
  const absent = declared.filter((entry) => (
    entry.required
    && provided[entry.name] === undefined
    && provided[entry.name.replace(/^--/, '')] === undefined
  ));
  if (absent.length > 0) {
    return absent.map((entry) => ({
      name: entry.name,
      description: `执行层声明该输入必填：${entry.name}`,
    }));
  }
  const failure = failureOf(envelope.error);
  return [{ description: failure.message }];
}

/**
 * needs_confirmation 的确认提示：只做形状校验（handle/summary 非空字符串，
 * expiresAt 可选字符串）。形状不合法 = 执行层回执不可用，按 failed 机械分流，
 * 绝不把半截提示交给宿主当成「可确认」。
 */
function confirmationOf(value: unknown): ConfirmationPrompt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { handle?: unknown; summary?: unknown; expiresAt?: unknown };
  if (typeof candidate.handle !== 'string' || candidate.handle === '') return undefined;
  if (typeof candidate.summary !== 'string' || candidate.summary === '') return undefined;
  if (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== 'string') return undefined;
  return {
    handle: candidate.handle,
    summary: candidate.summary,
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
  };
}

function outcomeOf(
  run: GatewayRun,
  request: ExecutionRequest,
  operations: readonly RawGatewayOperation[],
  timeoutMs: number,
): ExecutionOutcome {
  if (run.timedOut) {
    // 单次调用的传输超时（`timeoutMs`，缺省 EXECUTION_CALL_TIMEOUT_MS = 60s）：到点停掉本次
    // 传输，但**不冒充「已确认失败」**——截断后无法确认执行层那边做没做完（写操作可能已经
    // 生效），按宿主既有的「结果未知」语义如实落定（`execution-runtime` 的待核对收口）：
    // 账行落 unknown、任务落 reason=result_unknown、不自动重试，把核对交给用户。
    // retryable 显式 false：同一 (operation, 对象) 不因这次超时被重撞（fail-safe，
    // 与 2026-11-18「缺省不可重试」同一口径）。
    return {
      status: 'failed',
      error: {
        code: 'result_unknown',
        message: `执行层调用超时（${timeoutMs}ms）：没有收到回执，无法确认这次操作是否已经发生。`,
        retryable: false,
      },
    };
  }
  if (run.spawnFailed) {
    return {
      status: 'failed',
      error: { code: 'EXECUTION_SPAWN_FAILED', message: '执行层网关无法启动。', retryable: true },
    };
  }
  const envelope = parseEnvelope(run.stdout);
  if (envelope) {
    const status = envelope.status;
    if (status === 'completed') {
      const items = itemsOf(envelope);
      return {
        status: 'completed',
        data: envelope.data ?? undefined,
        ...(items === undefined ? {} : { items }),
      };
    }
    if (status === 'needs_confirmation') {
      const confirmation = confirmationOf(envelope.confirmation);
      if (confirmation === undefined) {
        return {
          status: 'failed',
          error: {
            code: 'EXECUTION_BAD_CONFIRMATION',
            message: '执行层返回的 needs_confirmation 缺少有效的 confirmation（handle/summary）。',
          },
        };
      }
      return { status: 'needs_confirmation', confirmation, data: envelope.data ?? undefined };
    }
    if (status === 'needs_input') {
      const operation = operations.find((entry) => entry.name === request.operation);
      return {
        status: 'needs_input',
        missing: missingInputsOf(request, operation, envelope),
        data: envelope.data ?? undefined,
        error: failureOf(envelope.error),
      };
    }
    if (status === 'accepted') {
      return acceptedOutcomeOf(envelope);
    }
    if (status === 'not_found') {
      // 执行层的确定性答案（查无匹配）：执行完成，事实在 data 里，宿主不改写语义。
      return { status: 'completed', data: envelope.data ?? undefined };
    }
    if (status === 'failed') {
      return { status: 'failed', error: failureOf(envelope.error) };
    }
    return {
      status: 'failed',
      error: { code: 'EXECUTION_UNKNOWN_STATUS', message: `执行层返回了未定义状态：${String(status)}` },
    };
  }
  const stderr = run.stderr.trim();
  if (run.code === 3) {
    const firstToken = stderr.split(/\s+/)[0] ?? '';
    const code = /^[A-Z][A-Z0-9_]*$/.test(firstToken) ? firstToken : 'EXECUTION_REFUSED';
    return { status: 'refused', error: { code, message: stderr !== '' ? stderr : '执行层拒绝了本次调用。' } };
  }
  return {
    status: 'failed',
    error: {
      code: 'EXECUTION_NO_RESULT',
      message: (stderr !== '' ? stderr : run.stdout.trim()).slice(0, 500) || '执行层没有返回结果信封。',
    },
  };
}

/**
 * 批量写逐条结果的形状校验（契约 v4）：只收 index 为非负整数、status 为
 * ok/failed/unknown 的条目；reason 非空字符串才带上。信封顶层 items 优先，
 * 其次 data.items（执行层两种放法都认）。没有合法条目 = 不携带 items。
 */
function itemsOf(envelope: ResultEnvelope): ExecutionItemResult[] | undefined {
  const candidate = Array.isArray(envelope.items)
    ? envelope.items
    : (envelope.data !== null && typeof envelope.data === 'object' && Array.isArray((envelope.data as { items?: unknown }).items)
      ? (envelope.data as { items: unknown[] }).items
      : undefined);
  if (candidate === undefined) return undefined;
  const items: ExecutionItemResult[] = [];
  for (const entry of candidate) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as { index?: unknown; status?: unknown; reason?: unknown };
    const index = typeof record.index === 'number' && Number.isInteger(record.index) && record.index >= 0
      ? record.index
      : undefined;
    const status = record.status === 'ok' || record.status === 'failed' || record.status === 'unknown'
      ? record.status
      : undefined;
    if (index === undefined || status === undefined) continue;
    items.push({
      index,
      status,
      ...(typeof record.reason === 'string' && record.reason !== '' ? { reason: record.reason } : {}),
    });
  }
  return items.length === 0 ? undefined : items;
}

/**
 * accepted 信封的形状校验（与 confirmation 同口径）：operationId 必须是非空字符串；
 * pollAfterMs 只收有限非负数（缺省/坏形状 = 不出现，宿主用缺省间隔）。形状不合法 =
 * 执行层回执不可用，按 failed 机械分流——绝不把半截句柄交给宿主去 wait。
 */
function acceptedOutcomeOf(envelope: ResultEnvelope): ExecutionOutcome {
  const candidate = envelope.operationId ?? (envelope.data !== null && typeof envelope.data === 'object'
    ? (envelope.data as { operationId?: unknown }).operationId
    : undefined);
  if (typeof candidate !== 'string' || candidate === '') {
    return {
      status: 'failed',
      error: { code: 'EXECUTION_BAD_ACCEPTED', message: '执行层返回的 accepted 缺少有效的 operationId。' },
    };
  }
  const pollAfterMs = declaredCostOf(envelope.pollAfterMs);
  return {
    status: 'accepted',
    operationId: candidate,
    ...(pollAfterMs === undefined || pollAfterMs < 0 ? {} : { pollAfterMs }),
  };
}

/**
 * `wait` 信封投影：completed/failed/refused/needs_* 原样映射；accepted = 窗口内仍在执行。
 * 与 execute 的 outcomeOf 同一套机械分流（wait 没有请求参数，needs_input 的 missing 用
 * 执行层错误原话兜底）。
 */
function waitOutcomeOf(run: GatewayRun, operationId: string, timeoutMs: number): ExecutionOutcome {
  if (run.timedOut) {
    // 单次 wait 调用的传输截断（子进程上限 = 窗口 + 5s；网关没有在自己的窗口内回话）：
    // 与 execute 的截断**同源**——没有回执，**不代表长任务失败**（它可能还在执行层跑）。
    // 宿主（task-runner）据此继续退避轮询、不落下终态、并如实告知用户一次；
    // retryable 显式 false：这次调用本身不构成「可重试的业务失败」。
    return {
      status: 'failed',
      error: {
        code: 'result_unknown',
        message: `执行层等待调用超时（${timeoutMs}ms）：没有收到回执，无法确认长任务当前的状态。`,
        retryable: false,
      },
    };
  }
  if (run.spawnFailed) {
    return {
      status: 'failed',
      error: { code: 'EXECUTION_SPAWN_FAILED', message: '执行层网关无法启动。', retryable: true },
    };
  }
  const envelope = parseEnvelope(run.stdout);
  if (envelope !== undefined) {
    if (envelope.status === 'completed') {
      const items = itemsOf(envelope);
      return {
        status: 'completed',
        data: envelope.data ?? undefined,
        ...(items === undefined ? {} : { items }),
      };
    }
    if (envelope.status === 'failed') return { status: 'failed', error: failureOf(envelope.error) };
    if (envelope.status === 'refused') return { status: 'refused', error: failureOf(envelope.error) };
    if (envelope.status === 'needs_confirmation') {
      const confirmation = confirmationOf(envelope.confirmation);
      return confirmation === undefined
        ? { status: 'failed', error: { code: 'EXECUTION_BAD_CONFIRMATION', message: '执行层返回的 needs_confirmation 缺少有效的 confirmation（handle/summary）。' } }
        : { status: 'needs_confirmation', confirmation, data: envelope.data ?? undefined };
    }
    if (envelope.status === 'needs_input') {
      const failure = failureOf(envelope.error);
      return {
        status: 'needs_input',
        missing: [{ description: failure.message }],
        data: envelope.data ?? undefined,
        error: failure,
      };
    }
    if (envelope.status === 'accepted') {
      // 仍在执行：沿用受理句柄（wait 只等，不换号）。
      const pollAfterMs = declaredCostOf(envelope.pollAfterMs);
      return {
        status: 'accepted',
        operationId: typeof envelope.operationId === 'string' && envelope.operationId !== ''
          ? envelope.operationId
          : operationId,
        ...(pollAfterMs === undefined || pollAfterMs < 0 ? {} : { pollAfterMs }),
      };
    }
    return {
      status: 'failed',
      error: { code: 'EXECUTION_UNKNOWN_STATUS', message: `执行层返回了未定义状态：${String(envelope.status)}` },
    };
  }
  const stderr = run.stderr.trim();
  if (run.code === 3) {
    const firstToken = stderr.split(/\s+/)[0] ?? '';
    const code = /^[A-Z][A-Z0-9_]*$/.test(firstToken) ? firstToken : 'EXECUTION_REFUSED';
    return { status: 'refused', error: { code, message: stderr !== '' ? stderr : '执行层拒绝了本次等待。' } };
  }
  return {
    status: 'failed',
    error: {
      code: 'EXECUTION_NO_RESULT',
      message: (stderr !== '' ? stderr : run.stdout.trim()).slice(0, 500) || '执行层没有返回等待结果信封。',
    },
  };
}
