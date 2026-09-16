import { randomBytes } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  READ_TOOLS,
  type AccountSet,
  type EnvelopeMeta,
  type ErrorCode,
  type ErrorEnvelope,
  type GetCurrentAccountingPeriodArgs,
  type GetCurrentAccountingPeriodResult,
  type InspectAccountSetArgs,
  type ListVouchersArgs,
  type ListVouchersResult,
  type McpError,
  type ReadToolName,
  type SearchAccountSetsArgs,
  type SearchAccountSetsResult,
  type SuccessEnvelope,
} from '@fshine/contracts';
import { TOOL_DEFINITIONS } from './schemas';
import {
  ACCOUNT_SETS,
  CURRENT_PERIOD,
  accountSetById,
  buildVoucherDoc,
  decodeCursor,
  encodeCursor,
  inspectAccountSet,
  voucherTotalFor,
} from './registry';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_NAME = '17dz-read';
export const SERVER_VERSION = '0.1.0';
export const SPEC_VERSION = '0.5';

const DEFAULT_PAGE_SIZE = 20;
const ALL_PAGES_PAGE_SIZE = 100;
const ALL_PAGES_SERVER_CAP = 1000;

export interface FakeServerOptions {
  /** 场景注入用 env;缺省回落到 process.env */
  env?: Record<string, string | undefined>;
  /** retrievedAt 时钟,测试可注入 */
  now?: () => Date;
}

export interface FakeServerTransport {
  /** 进程内直驱:输入一行 JSON-RPC,返回应写出的响应行(通知为空数组) */
  handleLine(line: string): Promise<string[]>;
  /** tools/call 回包计数达到 FAKE_CRASH_AFTER_N_CALLS 后取走崩溃信号(取走即复位) */
  takeCrashSignal(): boolean;
}

class BizError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>,
    retryAfterMs?: number,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }

  toMcpError(): McpError {
    const error: McpError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterMs !== undefined) error.retryAfterMs = this.retryAfterMs;
    if (this.details !== undefined) error.details = this.details;
    return error;
  }
}

class InvalidParamsError extends Error {}

interface JsonRpcErrorObject {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

function formatBeijingIso(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

function buildMeta(account?: { id: string; name?: string }): EnvelopeMeta {
  const meta: EnvelopeMeta = {
    traceId: `trc_${randomBytes(8).toString('hex')}`,
    retrievedAt: formatBeijingIso(new Date()),
    source: 'api_cache',
  };
  if (account) {
    meta.accountSetId = account.id;
    if (account.name !== undefined) meta.accountSetName = account.name;
  }
  return meta;
}

function metaAccountFor(rawArgs: Record<string, unknown>): { id: string; name?: string } | undefined {
  const id = rawArgs['accountSetId'];
  if (typeof id !== 'string') return undefined;
  const name = accountSetById(id)?.name;
  return name === undefined ? { id } : { id, name };
}

function serialize(response: JsonRpcResponse): string {
  return JSON.stringify(response);
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function formatAjvErrors(errors: ValidateFunction['errors']): string {
  if (!errors || errors.length === 0) return '参数不符合 inputSchema';
  return errors
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
    .join('; ');
}

export function createFakeServerTransport(options: FakeServerOptions = {}): FakeServerTransport {
  const envSource: Record<string, string | undefined> = options.env ?? process.env;
  const envOf = (key: string): string | undefined => envSource[key];
  const nowFn = options.now ?? (() => new Date());

  const allowed = parseAllowed(envOf('FAKE_ALLOWED_ACCOUNT_SETS'));
  const scenario = envOf('FAKE_SCENARIO')?.trim() || undefined;
  const slowMs = parseNonNegativeInt(envOf('FAKE_SLOW_MS')) ?? 0;
  const crashAfter = parseNonNegativeInt(envOf('FAKE_CRASH_AFTER_N_CALLS'));

  const serverInfo = {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    specVersion: SPEC_VERSION,
    allowedAccountSets: allowed ? [...allowed] : null,
  };

  const validators = new Map<ReadToolName, ValidateFunction>();
  const ajv = new Ajv({ allErrors: true, strictSchema: false });
  for (const tool of READ_TOOLS) {
    const definition = TOOL_DEFINITIONS.find((t) => t.name === tool);
    if (!definition) throw new Error(`缺少 tool 定义: ${tool}`);
    validators.set(tool, ajv.compile(definition.inputSchema));
  }

  let toolCallCount = 0;
  let crashPending = false;

  const isAllowed = (id: string): boolean => allowed === null || allowed.has(id);

  function parseAllowed(raw: string | undefined): Set<string> | null {
    if (raw === undefined || raw.trim() === '') return null;
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    );
  }

  function resolveAccount(rawId: string): AccountSet {
    const known = accountSetById(rawId);
    if (!known) {
      throw new BizError(
        'ACCOUNT_SET_NOT_FOUND',
        `账套 id 解析失败: ${rawId}(可能已改名),请重新 search_account_sets 定位新 id`,
        false,
        { nameHint: rawId },
      );
    }
    if (!isAllowed(rawId)) {
      throw new BizError(
        'ACCOUNT_SET_FORBIDDEN',
        `账套 ${rawId}(${known.name}) 超出本实例允许范围,拒绝并报告,不要重试`,
        false,
      );
    }
    return known;
  }

  function scenarioBizError(tool: ReadToolName): BizError | null {
    switch (scenario) {
      case 'needs_login':
        if (tool === 'get_login_status') return null;
        return new BizError('NEEDS_LOGIN', '幻账平台登录态失效,请通知人工处理登录', false);
      case 'profile_busy':
        return new BizError('PROFILE_BUSY', '17dz 浏览器 profile 被其他任务占用,请按 retryAfterMs 退避后重试', true, undefined, 1500);
      case 'timeout':
        return new BizError('TIMEOUT', '17dz 队列等待超时,请退避后重试', true);
      case 'account_set_ambiguous':
        if (tool !== 'search_account_sets') return null;
        return new BizError('ACCOUNT_SET_AMBIGUOUS', '账套名称命中多个候选,请先消歧', false, {
          candidates: [
            { id: 'as_001', name: '幻晟' },
            { id: 'as_002', name: '幻晟(深圳)' },
          ],
        });
      case 'needs_user_input':
        return new BizError('NEEDS_USER_INPUT', '缺少必要数据/口径未定,请停下找人,不要重试', false, {
          needs: ['请确认要查询的往来单位与口径'],
        });
      case 'internal':
        return new BizError('INTERNAL', '17dz 内部未预期错误(fake 注入场景)', false);
      default:
        return null;
    }
  }

  function dispatchTool(tool: ReadToolName, rawArgs: Record<string, unknown>): unknown {
    switch (tool) {
      case 'get_login_status':
        return { loggedIn: scenario !== 'needs_login' };
      case 'search_account_sets': {
        const args = rawArgs as unknown as SearchAccountSetsArgs;
        const matches = ACCOUNT_SETS.filter((a) => a.name.includes(args.query) && isAllowed(a.id));
        const data: SearchAccountSetsResult = { accountSets: matches };
        return data;
      }
      case 'get_current_accounting_period': {
        const args = rawArgs as unknown as GetCurrentAccountingPeriodArgs;
        resolveAccount(args.accountSetId);
        const data: GetCurrentAccountingPeriodResult = { period: CURRENT_PERIOD };
        return data;
      }
      case 'list_vouchers': {
        const args = rawArgs as unknown as ListVouchersArgs;
        resolveAccount(args.accountSetId);
        return listVouchersData(args);
      }
      case 'inspect_account_set': {
        const args = rawArgs as unknown as InspectAccountSetArgs;
        const account = resolveAccount(args.accountSetId);
        return inspectAccountSet(account);
      }
    }
  }

  function listVouchersData(args: ListVouchersArgs): ListVouchersResult {
    const total = voucherTotalFor(args.period);
    let pageNo: number;
    let pageSize: number;
    let allPages = false;

    if (args.cursor !== undefined) {
      const decoded = decodeCursor(args.cursor);
      if (decoded === null) throw new InvalidParamsError(`cursor 无法解析: ${args.cursor}`);
      pageNo = decoded;
      pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
    } else if (args.allPages === true) {
      allPages = true;
      pageNo = 0;
      pageSize = ALL_PAGES_PAGE_SIZE;
    } else {
      pageNo = args.pageNo ?? 0;
      pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    const effectiveTotal = allPages ? Math.min(total, ALL_PAGES_SERVER_CAP) : total;
    const start = pageNo * pageSize;
    const docs: ListVouchersResult['docs'] = [];
    for (let i = 0; i < pageSize && start + i < effectiveTotal; i++) {
      docs.push(buildVoucherDoc(args.period, start + i + 1));
    }
    const result: ListVouchersResult = { total: effectiveTotal, docs };
    if (!allPages && (pageNo + 1) * pageSize < effectiveTotal) {
      result.nextCursor = encodeCursor(pageNo + 1);
    }
    return result;
  }

  async function handleToolCall(id: string | number | null, rawParams: unknown): Promise<JsonRpcResponse> {
    if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
      return errorResponse(id, -32602, 'tools/call 的 params 必须是含 name/arguments 的对象');
    }
    const params = rawParams as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string' || !(READ_TOOLS as readonly string[]).includes(params.name)) {
      return errorResponse(id, -32602, `未知的 tool: ${String(params.name)}`);
    }
    const tool = params.name as ReadToolName;
    let rawArgs: Record<string, unknown>;
    if (params.arguments === undefined) {
      rawArgs = {};
    } else if (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)) {
      rawArgs = params.arguments as Record<string, unknown>;
    } else {
      return errorResponse(id, -32602, 'tools/call 的 arguments 必须是对象');
    }

    if (slowMs > 0) await delay(slowMs);

    const validate = validators.get(tool);
    if (validate && !validate(rawArgs)) {
      return errorResponse(id, -32602, `${tool} 参数不符合 inputSchema: ${formatAjvErrors(validate.errors)}`);
    }

    const meta = buildMeta(metaAccountFor(rawArgs));
    try {
      const injected = scenarioBizError(tool);
      if (injected) throw injected;
      const data = dispatchTool(tool, rawArgs);
      const envelope: SuccessEnvelope = { data, meta };
      return toolResult(id, JSON.stringify(envelope), false);
    } catch (err) {
      if (err instanceof InvalidParamsError) return errorResponse(id, -32602, err.message);
      const mcpError =
        err instanceof BizError
          ? err.toMcpError()
          : { code: 'INTERNAL', message: `Fake server 未预期错误: ${String(err)}`, retryable: false } satisfies McpError;
      const envelope: ErrorEnvelope = { error: mcpError, meta };
      return toolResult(id, JSON.stringify(envelope), true);
    } finally {
      toolCallCount += 1;
      if (crashAfter !== null && toolCallCount === crashAfter) crashPending = true;
    }
  }

  function toolResult(id: string | number | null, text: string, isError: boolean): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], isError },
    };
  }

  function handleRequest(method: string, id: string | number | null, params: unknown): JsonRpcResponse | Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo,
          },
        };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
      case 'tools/call':
        return handleToolCall(id, params);
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      default:
        return errorResponse(id, -32601, `方法不存在: ${method}`);
    }
  }

  return {
    async handleLine(line: string): Promise<string[]> {
      const trimmed = line.trim();
      if (trimmed === '') return [];
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return [serialize(errorResponse(null, -32700, 'JSON 解析失败:请求必须是合法 JSON'))];
      }
      if (Array.isArray(message)) {
        return [serialize(errorResponse(null, -32600, '不支持批量请求'))];
      }
      if (typeof message !== 'object' || message === null) {
        return [serialize(errorResponse(null, -32600, '请求必须是 JSON-RPC 2.0 对象'))];
      }
      const { method, params } = message as Record<string, unknown>;
      const hasId = 'id' in message;
      const rawId = (message as Record<string, unknown>)['id'];
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

      if (typeof method !== 'string') {
        return hasId ? [serialize(errorResponse(id, -32600, '缺少 method 字段'))] : [];
      }
      if (method.startsWith('notifications/')) return [];
      if (!hasId) return [];

      const response = await handleRequest(method, id, params);
      return [serialize(response)];
    },
    takeCrashSignal(): boolean {
      const due = crashPending;
      crashPending = false;
      return due;
    },
  };
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
