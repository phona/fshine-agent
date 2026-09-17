import { randomBytes } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import {
  READ_TOOLS,
  type GetSubmissionStatusArgs,
  type GetSubmissionStatusResult,
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
  type SubmitVoucherArgs,
  type SubmitVoucherBatchArgs,
  type VoucherContract,
  type VoucherPreview,
  type WriteToolName,
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
export const WRITE_SERVER_NAME = '17dz-write';
export const SERVER_VERSION = '0.1.0';
export const SPEC_VERSION = '0.5';

const DEFAULT_PAGE_SIZE = 4; // 对齐真实 17dz:页大小即模型视野,翻页由用户驱动
const ALL_PAGES_PAGE_SIZE = 100;
const ALL_PAGES_SERVER_CAP = 1000;

const FAKE_RESOURCES = [
  {
    uri: '17dz://domains/voucher/templates',
    name: 'voucher templates',
    description: '凭证业务模板',
    mimeType: 'text/markdown',
    text: '# voucher templates\n\nFake resource for MCP host tests.\n',
  },
  {
    uri: '17dz://domains/voucher/mechanisms',
    name: 'voucher mechanisms',
    description: '凭证域执行机制',
    mimeType: 'text/markdown',
    text: '# voucher mechanisms\n\nFake resource for MCP host tests.\n',
  },
] as const;

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

function buildMeta(account?: { id: string; name?: string }, now: Date = new Date()): EnvelopeMeta {
  const meta: EnvelopeMeta = {
    traceId: `trc_${randomBytes(8).toString('hex')}`,
    retrievedAt: formatBeijingIso(now),
    source: 'api_cache',
  };
  if (account) {
    meta.accountSetId = account.id;
    if (account.name !== undefined) meta.accountSetName = account.name;
  }
  return meta;
}

function metaAccountFor(rawArgs: Record<string, unknown>): { id: string; name?: string } | undefined {
  const direct = rawArgs['accountSetId'];
  const contract = rawArgs['contract'];
  const contractId = contract !== null && typeof contract === 'object'
    ? (contract as Record<string, unknown>)['accountSetId']
    : undefined;
  const contracts = rawArgs['contracts'];
  const batchId = Array.isArray(contracts) && contracts[0] !== null && typeof contracts[0] === 'object'
    ? (contracts[0] as Record<string, unknown>)['accountSetId']
    : undefined;
  const id = direct ?? contractId ?? batchId;
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
  const enableWrite = envOf('FAKE_ENABLE_WRITE') === '1';
  const scenario = envOf('FAKE_SCENARIO')?.trim() || undefined;
  const slowMs = parseNonNegativeInt(envOf('FAKE_SLOW_MS')) ?? 0;
  const crashAfter = parseNonNegativeInt(envOf('FAKE_CRASH_AFTER_N_CALLS'));
  const enableResources = envOf('FAKE_ENABLE_RESOURCES') === '1';

  const activeTools = enableWrite ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((tool) => (READ_TOOLS as readonly string[]).includes(tool.name));
  const serverInfo = {
    name: enableWrite ? WRITE_SERVER_NAME : SERVER_NAME,
    version: SERVER_VERSION,
    specVersion: SPEC_VERSION,
    allowedAccountSets: allowed ? [...allowed] : null,
  };

  const validators = new Map<string, ValidateFunction>();
  // Ajv's core package does not ship the optional format vocabulary. Register
  // the protocol's date format here; business validation below enforces the
  // actual YYYY-MM-DD shape as well.
  const ajv = new Ajv({ allErrors: true, strictSchema: false, formats: { date: true } });
  for (const tool of activeTools) {
    validators.set(tool.name, ajv.compile(tool.inputSchema));
  }

  type LedgerEntry = {
    tool: 'submit_voucher' | 'submit_voucher_batch';
    idempotencyKey: string;
    contractCanonical: string;
    status: 'retryable' | 'bound';
    executionState: 'not_started' | 'succeeded' | 'failed' | 'unknown' | 'may_have_succeeded';
    boundStep?: string;
    result?: Record<string, unknown>;
    error?: Record<string, unknown>;
    batch?: { batchKey: string; index: number; total: number };
  };
  const ledger = new Map<string, LedgerEntry>();
  let nextVoucherNumber = 46;

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

  function scenarioBizError(tool: ReadToolName | WriteToolName): BizError | null {
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

  function canonicalize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function ledgerKey(tool: 'submit_voucher' | 'submit_voucher_batch', key: string): string {
    return `${tool}:${key}`;
  }

  function validateContract(contract: VoucherContract): { account: AccountSet; errors: string[] } {
    const account = resolveAccount(contract.accountSetId);
    const errors: string[] = [];
    let debitTotal = 0;
    let creditTotal = 0;
    contract.entries.forEach((entry, index) => {
      const debit = entry.debit ?? 0;
      const credit = entry.credit ?? 0;
      if (debit === 0 && credit === 0) errors.push(`entries[${index}]: 借贷不能同时为零`);
      if (debit > 0 && credit > 0) errors.push(`entries[${index}]: 借贷不能同时有值`);
      debitTotal += debit;
      creditTotal += credit;
    });
    if (Math.abs(debitTotal - creditTotal) > 0.000001) errors.push(`借贷不平衡: debit=${debitTotal}, credit=${creditTotal}`);
    if (contract.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(contract.date)) errors.push('date: 必须是 YYYY-MM-DD');
    return { account, errors };
  }

  function previewFor(contract: VoucherContract, account: AccountSet): VoucherPreview {
    const date = contract.date ?? formatBeijingIso(nowFn()).slice(0, 10);
    const voucherNo = contract.voucherNo ?? `记-${String(nextVoucherNumber).padStart(3, '0')}`;
    const entries = contract.entries.map((entry) => {
      const output: VoucherPreview['entries'][number] = {
        summary: entry.summary,
        subjectCode: entry.subjectCode,
        debit: entry.debit ?? 0,
        credit: entry.credit ?? 0,
      };
      if (entry.assistantName !== undefined) output.assistantName = entry.assistantName;
      return output;
    });
    return {
      accountSetId: account.id,
      accountSetName: account.name,
      date,
      voucherNo,
      entries,
      totalDebit: entries.reduce((sum, entry) => sum + entry.debit, 0),
      totalCredit: entries.reduce((sum, entry) => sum + entry.credit, 0),
    };
  }

  function contractValidationError(errors: string[]): BizError {
    return new BizError('CONTRACT_INVALID', '凭证契约校验失败，请根据 errors 修改后重试', false, { errors });
  }

  function existingLedger(tool: 'submit_voucher' | 'submit_voucher_batch', key: string, contract: unknown): LedgerEntry | undefined {
    const existing = ledger.get(ledgerKey(tool, key));
    if (!existing) return undefined;
    if (existing.contractCanonical !== canonicalize(contract)) {
      throw new BizError('IDEMPOTENCY_CONFLICT', `同一 idempotencyKey 已绑定不同契约: ${key}`, false);
    }
    return existing;
  }

  function resultFromLedger(entry: LedgerEntry): GetSubmissionStatusResult {
    const result: GetSubmissionStatusResult = {
      status: entry.status,
      executionState: entry.executionState,
    };
    if (entry.boundStep !== undefined) result.boundStep = entry.boundStep;
    if (entry.result !== undefined) result.result = entry.result;
    if (entry.error !== undefined) result.error = entry.error;
    if (entry.batch !== undefined) result.batch = entry.batch;
    return result;
  }

  function executeVoucher(contract: VoucherContract, key: string, batch?: { batchKey: string; index: number; total: number }): Record<string, unknown> {
    const canonical = canonicalize(contract);
    const old = existingLedger('submit_voucher', key, contract);
    if (old) {
      if (old.status === 'bound') return old.result ?? { error: old.error };
      // retryable entries are deliberately re-entered below with the same key.
    }
    const entry: LedgerEntry = old ?? {
      tool: 'submit_voucher', idempotencyKey: key, contractCanonical: canonical,
      status: 'retryable', executionState: 'not_started', batch,
    };
    if (batch !== undefined) entry.batch = batch;
    ledger.set(ledgerKey('submit_voucher', key), entry);

    const failIndex = envOf('FAKE_BATCH_FAIL_INDEX');
    const retryableIndex = envOf('FAKE_BATCH_RETRYABLE_INDEX');
    const isBatchIndex = batch !== undefined ? String(batch.index) : undefined;
    if ((isBatchIndex !== undefined && isBatchIndex === retryableIndex) || (!batch && envOf('FAKE_EXECUTION_RETRYABLE') === '1')) {
      throw new BizError('EXECUTION_FAILED', 'Fake 执行尚未到达保存动作', true, {
        executionState: 'not_started', step: 'fill_entries',
      });
    }
    if ((isBatchIndex !== undefined && isBatchIndex === failIndex) || (!batch && envOf('FAKE_EXECUTION_FAILED') === '1')) {
      const error = { code: 'EXECUTION_FAILED', details: { executionState: 'failed', boundStep: 'save_click', step: 'save', diff: 'fake 注入执行失败' } };
      entry.status = 'bound'; entry.executionState = 'failed'; entry.boundStep = 'save_click'; entry.error = error;
      throw new BizError('EXECUTION_FAILED', 'Fake 执行失败', false, error.details);
    }
    const allocatedNumber = nextVoucherNumber;
    const number = contract.voucherNo ?? `记-${String(allocatedNumber).padStart(3, '0')}`;
    if (contract.voucherNo === undefined) nextVoucherNumber += 1;
    const result = { dryRun: false, voucherNo: number, docId: `doc_fake_${String(allocatedNumber).padStart(4, '0')}`, verified: true };
    entry.status = 'bound'; entry.executionState = 'succeeded'; entry.boundStep = 'save_click'; entry.result = result;
    return result;
  }

  function dispatchTool(tool: ReadToolName | WriteToolName, rawArgs: Record<string, unknown>): unknown {
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
      case 'validate_voucher': {
        const contract = (rawArgs as { contract: VoucherContract }).contract;
        const validation = validateContract(contract);
        return validation.errors.length === 0
          ? { ok: true }
          : { ok: false, errors: validation.errors };
      }
      case 'submit_voucher': {
        const args = rawArgs as unknown as SubmitVoucherArgs;
        const validation = validateContract(args.contract);
        if (validation.errors.length > 0) throw contractValidationError(validation.errors);
        const preview = previewFor(args.contract, validation.account);
        if (args.confirmed !== true) {
          return { dryRun: true, preview, precheckFlags: [] };
        }
        const existing = existingLedger('submit_voucher', args.idempotencyKey, args.contract);
        if (existing?.status === 'bound') {
          if (existing.error !== undefined) throw new BizError('EXECUTION_FAILED', '返回既有执行失败记录', false, existing.error['details'] as Record<string, unknown>);
          return existing.result;
        }
        return executeVoucher(args.contract, args.idempotencyKey);
      }
      case 'submit_voucher_batch': {
        const args = rawArgs as unknown as SubmitVoucherBatchArgs;
        const validations = args.contracts.map((contract, index) => ({ index, contract, result: validateContract(contract) }));
        const invalid = validations.filter((item) => item.result.errors.length > 0);
        if (args.confirmed !== true) {
          return {
            dryRun: true,
            previews: validations.map((item) => item.result.errors.length > 0
              ? { index: item.index, ok: false, errors: item.result.errors }
              : { index: item.index, ok: true, preview: previewFor(item.contract, item.result.account), precheckFlags: [] }),
          };
        }
        if (invalid.length > 0) {
          throw contractValidationError(invalid.flatMap((item) => item.result.errors.map((error) => `contracts[${item.index}]: ${error}`)));
        }
        const existing = existingLedger('submit_voucher_batch', args.idempotencyKey, args.contracts);
        if (existing?.status === 'bound') {
          if (existing.error !== undefined) throw new BizError('EXECUTION_FAILED', '返回既有批量执行失败记录', false, existing.error['details'] as Record<string, unknown>);
          return existing.result;
        }
        const batchEntry: LedgerEntry = existing ?? {
          tool: 'submit_voucher_batch', idempotencyKey: args.idempotencyKey,
          contractCanonical: canonicalize(args.contracts), status: 'retryable', executionState: 'not_started',
        };
        ledger.set(ledgerKey('submit_voucher_batch', args.idempotencyKey), batchEntry);
        const results: Array<Record<string, unknown>> = [];
        for (const item of validations) {
          const key = `${args.idempotencyKey}:${item.index}`;
          try {
            const result = executeVoucher(item.contract, key, { batchKey: args.idempotencyKey, index: item.index, total: args.contracts.length });
            results.push({ index: item.index, ok: true, voucherNo: result['voucherNo'], docId: result['docId'], verified: result['verified'] });
          } catch (error) {
            if (error instanceof BizError) {
              const executionState = (error.details?.['executionState'] as string | undefined) ?? 'failed';
              results.push({ index: item.index, ok: false, error: { code: error.code, details: { ...(error.details ?? {}), executionState } } });
            } else {
              results.push({ index: item.index, ok: false, error: { code: 'EXECUTION_FAILED', details: { executionState: 'unknown', boundStep: 'save_click' } } });
            }
          }
        }
        const succeeded = results.filter((result) => result['ok'] === true).length;
        const result = { dryRun: false, batchKey: args.idempotencyKey, summary: { total: results.length, succeeded, failed: results.length - succeeded }, results };
        batchEntry.status = 'bound'; batchEntry.executionState = 'succeeded'; batchEntry.boundStep = 'save_click'; batchEntry.result = result;
        return result;
      }
      case 'get_submission_status': {
        const args = rawArgs as unknown as GetSubmissionStatusArgs;
        const entry = ledger.get(ledgerKey(args.tool, args.idempotencyKey));
        if (!entry) return { status: 'not_found', executionState: 'not_started' } satisfies GetSubmissionStatusResult;
        return resultFromLedger(entry) satisfies GetSubmissionStatusResult;
      }
    }
  }

  function listVouchersData(args: ListVouchersArgs): ListVouchersResult {
    const total = voucherTotalFor(args.period);
    let offset: number;
    let pageSize: number;
    let allPages = false;

    if (args.cursor !== undefined) {
      const decoded = decodeCursor(args.cursor);
      if (decoded === null) throw new InvalidParamsError(`cursor 无法解析: ${args.cursor}`);
      offset = decoded;
      pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
    } else if (args.allPages === true) {
      allPages = true;
      offset = 0;
      pageSize = ALL_PAGES_PAGE_SIZE;
    } else {
      offset = (args.pageNo ?? 0) * (args.pageSize ?? DEFAULT_PAGE_SIZE);
      pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    const effectiveTotal = allPages ? Math.min(total, ALL_PAGES_SERVER_CAP) : total;
    const docs: ListVouchersResult['docs'] = [];
    for (let i = 0; i < pageSize && offset + i < effectiveTotal; i++) {
      docs.push(buildVoucherDoc(args.period, offset + i + 1));
    }
    const hasPrev = offset > 0;
    const hasNext = offset + docs.length < effectiveTotal;
    const result: ListVouchersResult = { total: effectiveTotal, docs, offset };
    if (!allPages && hasPrev) result.prevCursor = encodeCursor(Math.max(0, offset - pageSize));
    if (!allPages && hasNext) result.nextCursor = encodeCursor(offset + docs.length);
    return result;
  }

  async function handleToolCall(id: string | number | null, rawParams: unknown): Promise<JsonRpcResponse> {
    if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
      return errorResponse(id, -32602, 'tools/call 的 params 必须是含 name/arguments 的对象');
    }
    const params = rawParams as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string' || !activeTools.some((definition) => definition.name === params.name)) {
      return errorResponse(id, -32602, `未知的 tool: ${String(params.name)}`);
    }
    const tool = params.name as ReadToolName | WriteToolName;
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

    const meta = buildMeta(metaAccountFor(rawArgs), nowFn());
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
            capabilities: { tools: {}, ...(enableResources ? { resources: {} } : {}) },
            serverInfo,
          },
        };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: activeTools } };
      case 'resources/list':
        if (!enableResources) return errorResponse(id, -32601, '方法不存在: resources/list');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: FAKE_RESOURCES.map(({ text: _text, ...resource }) => resource),
          },
        };
      case 'resources/read':
        if (!enableResources) return errorResponse(id, -32601, '方法不存在: resources/read');
        if (typeof params !== 'object' || params === null || Array.isArray(params) || typeof (params as Record<string, unknown>)['uri'] !== 'string') {
          return errorResponse(id, -32602, 'resources/read 的 params 必须包含 uri');
        }
        {
          const uri = (params as Record<string, unknown>)['uri'] as string;
          const resource = FAKE_RESOURCES.find((candidate) => candidate.uri === uri);
          if (!resource) return errorResponse(id, -32602, `资源不存在: ${uri}`);
          return {
            jsonrpc: '2.0',
            id,
            result: { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] },
          };
        }
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
