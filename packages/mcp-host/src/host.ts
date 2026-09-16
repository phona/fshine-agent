/**
 * McpHost:runtime 侧唯一的 MCP 入口(架构 §4/§6,17dz-mcp-spec §11)。
 * 职责:连接生命周期、scope 预检、信封解析、可重试错误重试、渠道预算、结果裁剪、审计事件。
 */
import type {
  DiscoveredTool,
  ErrorCode,
  HostToolClient,
  McpProfileConfig,
  ReadToolName,
  ToolOutcome,
} from '@fshine/contracts';
import { READ_TOOLS } from '@fshine/contracts';
import { McpConnection, McpTransportError, type McpConnectionOptions } from './connection';
import { parseEnvelope } from './envelope-parse';
import { SpecVersionMismatchError } from './spec-version';
import { trimForRuntime } from './trim';
import { delay, errorMessage, isRecord } from './utils';

export const DEFAULT_CHANNEL_BUDGET_MS = 75_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['PROFILE_BUSY', 'TIMEOUT']);

export interface McpToolCallStartEvent {
  requestId: string;
  toolName: string;
  safeArguments: Record<string, unknown>;
  /** ISO 8601 */
  startedAt: string;
}

export interface McpToolCallEndEvent {
  requestId: string;
  toolName: string;
  /** ISO 8601 */
  finishedAt: string;
  status: 'ok' | 'error';
  errorCode?: string;
  traceId?: string;
  source?: string;
  artifactId?: string;
}

export interface McpHostAudit {
  onStart?(event: McpToolCallStartEvent): void;
  onEnd?(event: McpToolCallEndEvent): void;
}

export interface McpHostOptions {
  profile: McpProfileConfig;
  /** 工具白名单:tools/list 声明了名单之外的工具即拒绝连接。V0 默认只读五件套(验收 #9 代码强制)。 */
  allowedTools?: readonly string[];
  /** 渠道同步回复总预算(硬约束);重试前检查,超了就停止重试 */
  channelBudgetMs?: number;
  audit?: McpHostAudit;
}

/** V0 只读硬闸:server 声明了白名单之外的工具(如误配 write server),拒连并标记不可用。 */
export class DisallowedToolsError extends Error {
  constructor(readonly offendingTools: readonly string[]) {
    super(`MCP server 声明了白名单之外的工具(${offendingTools.join(', ')}),拒绝连接`);
    this.name = 'DisallowedToolsError';
  }
}

export class McpHost {
  private connection: McpConnection | null = null;
  private unusable = false;
  private unusableReason = '';
  private readonly allowedTools: ReadonlySet<string>;

  constructor(private readonly options: McpHostOptions) {
    this.allowedTools = new Set<string>(options.allowedTools ?? READ_TOOLS);
  }

  /** 最近一次(重)连接的 tools/list 结果;连接建立前为空。 */
  get discoveredTools(): readonly DiscoveredTool[] {
    return this.connection?.discoveredTools ?? [];
  }

  get connected(): boolean {
    return this.connection?.alive ?? false;
  }

  /** 懒建立连接(spawn + 握手 + tools/list);需要在 tools() 同步读取前就绪的装配方先 await 它。 */
  async ensureReady(): Promise<void> {
    this.assertUsable();
    try {
      await this.ensureConnection();
    } catch (err) {
      if (err instanceof SpecVersionMismatchError) this.markUnusable(err.message);
      throw err;
    }
    const offending = (this.connection?.discoveredTools ?? [])
      .filter((tool) => !this.allowedTools.has(tool.name))
      .map((tool) => tool.name);
    if (offending.length > 0) {
      const err = new DisallowedToolsError(offending);
      this.markUnusable(err.message);
      throw err;
    }
  }

  /** 同一 requestId 可复用同一 client。 */
  clientFor(requestId: string, allowedAccountSetIds: readonly string[]): HostToolClient {
    void this.ensureReady().catch(() => {}); // 预热连接;失败在 call 中呈现
    const host = this;
    return {
      tools: () => host.discoveredTools,
      call: (tool, args) => host.call(requestId, allowedAccountSetIds, tool, args),
    };
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.stop();
  }

  private assertUsable(): void {
    if (this.unusable) throw new Error(`MCP server 不可用: ${this.unusableReason}`);
  }

  private markUnusable(reason: string): void {
    this.unusable = true;
    this.unusableReason = reason;
    void this.stop();
  }

  private async ensureConnection(): Promise<McpConnection> {
    if (!this.connection) {
      const { profile } = this.options;
      const connectionOptions: McpConnectionOptions = {
        command: profile.command,
        args: profile.args,
        cwd: profile.cwd,
        env: profile.env,
        requestTimeoutMs: profile.requestTimeoutMs,
      };
      this.connection = new McpConnection(connectionOptions);
    }
    await this.connection.ensureReady();
    return this.connection;
  }

  private async call(
    requestId: string,
    allowedAccountSetIds: readonly string[],
    tool: ReadToolName,
    args: Record<string, unknown>,
  ): Promise<ToolOutcome> {
    if (this.unusable) {
      return internalError(`MCP server 不可用: ${this.unusableReason}`);
    }
    // scope 预检:未授权账套在 MCP 调用前被拒——不发往 server,也不触发 audit onStart
    const accountSetId = args['accountSetId'];
    if (typeof accountSetId === 'string' && !allowedAccountSetIds.includes(accountSetId)) {
      return { ok: false, error: { code: 'ACCOUNT_SET_FORBIDDEN', message: '没有该账套的访问权限', retryable: false } };
    }
    try {
      await this.ensureReady();
    } catch (err) {
      return internalError(`MCP 连接失败: ${errorMessage(err)}`);
    }
    const connection = this.connection;
    if (!connection) return internalError('MCP 连接不可用');
    if (!connection.discoveredTools.some((t) => t.name === tool)) {
      return internalError('工具不存在');
    }
    // 契约约定 tool 参数不含凭据,args 原样即为 safeArguments
    const audit = this.options.audit;
    audit?.onStart?.call(audit, {
      requestId,
      toolName: tool,
      safeArguments: { ...args },
      startedAt: new Date().toISOString(),
    });

    const { requestTimeoutMs, maxRetries } = this.options.profile;
    const channelBudgetMs = this.options.channelBudgetMs ?? DEFAULT_CHANNEL_BUDGET_MS;
    const maxAttempts = Math.max(0, maxRetries) + 1;
    const startedAtMs = Date.now();
    let outcome: ToolOutcome = internalError('工具调用未执行');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      outcome = await this.attemptOnce(connection, tool, args, requestTimeoutMs);
      if (outcome.ok) break;
      const error = outcome.error;
      if (!(error.retryable && RETRYABLE_ERROR_CODES.has(error.code))) break;
      if (attempt >= maxAttempts) break;
      const retryAfterMs =
        typeof error.retryAfterMs === 'number' && error.retryAfterMs >= 0 ? error.retryAfterMs : DEFAULT_RETRY_AFTER_MS;
      const elapsed = Date.now() - startedAtMs;
      if (elapsed + retryAfterMs + requestTimeoutMs > channelBudgetMs) break; // 渠道总预算是硬约束
      await delay(retryAfterMs); // 契约退避;退避不占单次尝试预算
      try {
        await this.ensureReady(); // 若进程已死,这里自动重连(spawn + 握手 + tools/list)
      } catch (err) {
        if (err instanceof SpecVersionMismatchError) this.markUnusable(err.message);
        outcome = internalError(`MCP 重连失败: ${errorMessage(err)}`);
        break;
      }
    }

    this.emitEnd(requestId, tool, outcome);
    return trimForRuntime(outcome);
  }

  private async attemptOnce(
    connection: McpConnection,
    tool: ReadToolName,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolOutcome> {
    let result: unknown;
    try {
      result = await connection.request('tools/call', { name: tool, arguments: args }, timeoutMs);
    } catch (err) {
      if (err instanceof McpTransportError) {
        if (err.kind === 'timeout') {
          return { ok: false, error: { code: 'TIMEOUT', message: err.message, retryable: true } };
        }
        return { ok: false, error: { code: 'INTERNAL', message: err.message, retryable: err.retryable } };
      }
      return internalError(errorMessage(err));
    }
    return outcomeFromToolResult(result);
  }

  private emitEnd(requestId: string, toolName: string, outcome: ToolOutcome): void {
    const audit = this.options.audit;
    const onEnd = audit?.onEnd;
    if (!onEnd) return;
    const event: McpToolCallEndEvent = {
      requestId,
      toolName,
      finishedAt: new Date().toISOString(),
      status: outcome.ok ? 'ok' : 'error',
    };
    if (!outcome.ok) {
      event.errorCode = outcome.error.code;
      if (outcome.error.artifact) event.artifactId = outcome.error.artifact.id;
    }
    if (outcome.meta) {
      event.traceId = outcome.meta.traceId;
      event.source = outcome.meta.source;
    }
    onEnd.call(audit, event);
  }
}

function outcomeFromToolResult(result: unknown): ToolOutcome {
  if (!isRecord(result) || !Array.isArray(result['content'])) return formatError();
  const first = result['content'][0];
  if (!isRecord(first) || typeof first['text'] !== 'string') return formatError();
  const parsed = parseEnvelope(first['text']);
  if (!parsed.ok) return formatError();
  const envelope = parsed.envelope;
  if ('error' in envelope) return { ok: false, error: envelope.error, meta: envelope.meta };
  return { ok: true, data: envelope.data, meta: envelope.meta };
}

function formatError(): ToolOutcome {
  return internalError('上游返回格式异常');
}

function internalError(message: string): ToolOutcome {
  return { ok: false, error: { code: 'INTERNAL', message, retryable: false } };
}
