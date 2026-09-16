/**
 * McpConnection:单 server 的 stdio JSON-RPC 2.0 连接(17dz-mcp-spec §5/§11.1)。
 * 进程死亡后可懒重连:下一次 ensureReady 重新 spawn + 握手 + tools/list。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DiscoveredTool } from '@fshine/contracts';
import { checkServerSpecVersion } from './spec-version';
import { isRecord } from './utils';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'tax-agent', version: '0.1.0' } as const;
/** 握手兜底超时:server 冷启动(如 npx tsx)耗时不应挤占工具调用单次尝试预算 */
const MIN_HANDSHAKE_TIMEOUT_MS = 15_000;
const STDERR_LINE_MAX_CHARS = 2_000;

export type McpTransportErrorKind =
  | 'timeout'
  | 'process_exit'
  | 'spawn_failed'
  | 'jsonrpc_error'
  | 'closed';

export class McpTransportError extends Error {
  constructor(
    readonly kind: McpTransportErrorKind,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

export interface McpConnectionOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** 传给 server 的、该 MCP profile 专属的环境变量。不会继承宿主环境。 */
  env?: Record<string, string>;
  /** 单次工具调用尝试预算(ms) */
  requestTimeoutMs: number;
  /** stderr 转发的 server 前缀 */
  stderrPrefix?: string;
}

export class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private toolsCache: DiscoveredTool[] = [];
  private stopped = false;
  private recyclePromise: Promise<void> | null = null;

  constructor(private readonly options: McpConnectionOptions) {}

  get discoveredTools(): readonly DiscoveredTool[] {
    return this.toolsCache;
  }

  get alive(): boolean {
    return this.child !== null;
  }

  /** 幂等:已就绪直接返回;进程死亡后再次调用会自动重连。 */
  ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const connecting = this.connect();
    const guarded = connecting.catch((err: unknown) => {
      if (this.readyPromise === guarded) this.readyPromise = null;
      throw err;
    });
    this.readyPromise = guarded;
    return guarded;
  }

  /** 单次尝试预算内计时;超时后晚到的响应在 handleLine 中被丢弃。 */
  request(
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new McpTransportError('process_exit', 'MCP server 未在运行', true));
    }
    const id = this.nextId++;
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.takePending(key);
        if (!entry) return;
        reject(new McpTransportError('timeout', `MCP 请求 ${method} 超过单次尝试预算 ${timeoutMs}ms`, true));
        this.recycle(child, key);
      }, timeoutMs);
      const cancel = () => {
        const entry = this.takePending(key);
        if (!entry) return;
        entry.reject(new McpTransportError('closed', `MCP 请求 ${method} 已取消`, false));
        this.recycle(child, key);
      };
      const removeAbortListener = signal
        ? (() => signal.removeEventListener('abort', cancel))
        : undefined;
      this.pending.set(key, { resolve, reject, timer, removeAbortListener });
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
      if (params !== undefined) body['params'] = params;
      child.stdin.write(`${JSON.stringify(body)}\n`);
    });
  }

  /** 杀子进程、清定时器、拒绝未决请求。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.readyPromise = null;
    this.rejectAllPending(new McpTransportError('closed', 'MCP 连接已由宿主关闭', false));
    const child = this.child;
    this.child = null;
    if (!child) {
      await this.recyclePromise;
      return;
    }
    await this.terminateChild(child);
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      throw new McpTransportError('closed', 'MCP 连接已关闭,不再重连', false);
    }
    if (this.recyclePromise) await this.recyclePromise;
    if (this.stopped) throw new McpTransportError('closed', 'MCP 连接已关闭,不再重连', false);
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...this.options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdin.on('error', () => {}); // 进程退出时的写入失败由 exit 统一收尾
    child.on('error', (err: Error) => {
      this.rejectAllPending(new McpTransportError('spawn_failed', `MCP server 进程启动失败: ${err.message}`, true));
      this.handleChildGone(child);
    });
    child.on('exit', () => this.handleChildGone(child));
    createInterface({ input: child.stdout }).on('line', (line: string) => this.handleLine(line));
    createInterface({ input: child.stderr }).on('line', (line: string) => this.forwardStderr(line));

    // 握手:initialize → 校验 specVersion → notifications/initialized → tools/list
    const handshakeTimeoutMs = Math.max(this.options.requestTimeoutMs, MIN_HANDSHAKE_TIMEOUT_MS);
    try {
      const initResult = await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, handshakeTimeoutMs);
      if (!isRecord(initResult) || initResult['protocolVersion'] !== MCP_PROTOCOL_VERSION) {
        throw new McpTransportError('jsonrpc_error', `MCP protocolVersion 不匹配:期望 ${MCP_PROTOCOL_VERSION},实际 ${isRecord(initResult) ? String(initResult['protocolVersion'] ?? '') : '缺失'}`, false);
      }
      checkServerSpecVersion(isRecord(initResult) ? initResult['serverInfo'] : undefined);
      this.notify('notifications/initialized');
      const listResult = await this.request('tools/list', undefined, handshakeTimeoutMs);
      this.toolsCache = parseDiscoveredTools(listResult);
    } catch (err) {
      this.cleanupChild(child, err instanceof McpTransportError ? err : new McpTransportError('closed', errorText(err), true));
      throw err;
    }
  }

  /** 通知(无 id)不占 pending。 */
  private notify(method: string): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行视为 server 噪声,丢弃
    }
    if (!isRecord(message)) return;
    if (!('id' in message)) return; // server 主动通知:V0 未订阅,忽略
    const rawId = message['id'];
    if (rawId === null || rawId === undefined) return;
    const key = String(rawId);
    const entry = this.pending.get(key);
    if (!entry) return; // 已超时或未知 id 的晚到响应:直接丢弃
    this.takePending(key);
    const error = message['error'];
    if (isRecord(error)) {
      entry.reject(
        new McpTransportError('jsonrpc_error', `MCP JSON-RPC 错误 ${String(error['code'])}: ${String(error['message'] ?? '')}`, false),
      );
      return;
    }
    if ('result' in message) {
      entry.resolve(message['result']);
      return;
    }
    entry.reject(new McpTransportError('jsonrpc_error', 'MCP 响应缺少 result', false));
  }

  private forwardStderr(line: string): void {
    const clean = line.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (clean === '') return;
    const prefix = this.options.stderrPrefix ?? '17dz-mcp';
    const clipped = clean.length > STDERR_LINE_MAX_CHARS ? `${clean.slice(0, STDERR_LINE_MAX_CHARS)}…` : clean;
    console.error(`[${prefix}] ${clipped}`);
  }

  private handleChildGone(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = null;
    this.readyPromise = null;
    this.rejectAllPending(new McpTransportError('process_exit', 'MCP server 进程已退出', true));
  }

  private cleanupChild(child: ChildProcessWithoutNullStreams, error: McpTransportError): void {
    if (this.child !== child) return;
    this.child = null;
    this.readyPromise = null;
    this.rejectAllPending(error);
    void this.terminateChild(child);
  }

  private recycle(child: ChildProcessWithoutNullStreams, requestKey: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.readyPromise = null;
    this.rejectAllPending(new McpTransportError('process_exit', 'MCP 请求超时,连接已重置', true));
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: Number(requestKey) } })}\n`);
    } catch { /* process is already gone */ }
    this.recyclePromise = this.terminateChild(child).finally(() => {
      this.recyclePromise = null;
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3_000);
      force.unref();
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private rejectAllPending(error: McpTransportError): void {
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      clearTimeout(entry.timer);
      entry.removeAbortListener?.();
      entry.reject(error);
    }
  }

  private takePending(key: string): PendingEntry | undefined {
    const entry = this.pending.get(key);
    if (!entry) return undefined;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    entry.removeAbortListener?.();
    return entry;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseDiscoveredTools(listResult: unknown): DiscoveredTool[] {
  if (!isRecord(listResult) || !Array.isArray(listResult['tools'])) {
    throw new McpTransportError('jsonrpc_error', 'tools/list 响应缺少 tools 数组', false);
  }
  const tools: DiscoveredTool[] = [];
  const names = new Set<string>();
  for (const raw of listResult['tools']) {
    if (!isRecord(raw) || typeof raw['name'] !== 'string' || raw['name'].trim() === '') {
      throw new McpTransportError('jsonrpc_error', 'tools/list 包含无效工具定义(name 必须是非空字符串)', false);
    }
    if (names.has(raw['name'])) {
      throw new McpTransportError('jsonrpc_error', `tools/list 包含重复工具名: ${raw['name']}`, false);
    }
    // JSON Schema permits schemas without a top-level `type` (for example `oneOf`).
    if (!isRecord(raw['inputSchema'])) {
      throw new McpTransportError('jsonrpc_error', `工具 ${raw['name']} 的 inputSchema 无效`, false);
    }
    if ('description' in raw && typeof raw['description'] !== 'string') {
      throw new McpTransportError('jsonrpc_error', `工具 ${raw['name']} 的 description 无效`, false);
    }
    names.add(raw['name']);
    tools.push({
      name: raw['name'],
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      inputSchema: raw['inputSchema'],
    });
  }
  return tools;
}
