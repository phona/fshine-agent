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
  type ExecutionArgDeclaration,
  type ExecutionCallOptions,
  type ExecutionClient,
  type ExecutionFailure,
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
  args?: {
    positional?: Array<{ name?: string; required?: boolean }>;
    flags?: Array<{ flag?: string; required?: boolean; style?: string }>;
  };
}

export interface DummyCliClientOptions {
  /** 夹具根（绝对路径）：网关与技能面的挂载点。 */
  root: string;
  /** 网关入口（相对 root，例如 bin/dummy）。 */
  gateway: string;
  /** 本试用的执行层状态根（`--state-dir`；审计与数据都落在这里）。 */
  stateDir: string;
  /** 继承的进程 env——spawn 前按 worker 白名单重建，不整体继承。 */
  env: NodeJS.ProcessEnv;
  /** 单次网关调用上限；缺省 60s。 */
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
}

export function createDummyCliClient(options: DummyCliClientOptions): DummyCliClient {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const gatewayPath = path.join(options.root, options.gateway);
  let listing: Promise<readonly RawGatewayOperation[]> | undefined;

  function runGateway(args: string[], signal?: AbortSignal): Promise<GatewayRun> {
    // 预取消：不 spawn、不产生任何网关副作用（与 run_js 执行器的预取消同口径）。
    if (signal?.aborted === true) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', aborted: true });
    }
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
      }, timeoutMs);
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
  };
}

/** 成本提示的形状校验：有限数值才投影；缺省/非数值 = 字段不出现（不解释、不裁决）。 */
function declaredCostOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 参数声明投影：位置参数在前、flag 在后；空名条目丢弃。 */
function declaredArgsOf(operation: RawGatewayOperation): ExecutionArgDeclaration[] {
  const positional = (operation.args?.positional ?? [])
    .filter((entry) => typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => ({ name: entry.name as string, required: entry.required === true }));
  const flags = (operation.args?.flags ?? [])
    .filter((entry) => typeof entry.flag === 'string' && entry.flag !== '')
    .map((entry) => ({
      name: entry.flag as string,
      required: entry.required === true,
      ...(typeof entry.style === 'string' && entry.style !== '' ? { type: entry.style } : {}),
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
    return {
      status: 'failed',
      error: { code: 'EXECUTION_TIMEOUT', message: `执行层调用超时（${timeoutMs}ms）。`, retryable: true },
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
      return { status: 'completed', data: envelope.data ?? undefined };
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
