import { describe, expect, it } from 'vitest';
import { ERROR_CODES, type ErrorEnvelope } from '@fshine/contracts';
import { asError, asSuccess, callTool, makeTransport } from './test-helpers';

/** spec §9 错误协议的全部 13 个码。 */
const SPEC_ERROR_CODES = [
  'NEEDS_LOGIN',
  'PROFILE_BUSY',
  'ACCOUNT_SET_NOT_FOUND',
  'ACCOUNT_SET_AMBIGUOUS',
  'ACCOUNT_SET_FORBIDDEN',
  'CONTRACT_INVALID',
  'NEEDS_USER_INPUT',
  'NEEDS_APPROVAL',
  'NEEDS_HUMAN_TAKEOVER',
  'IDEMPOTENCY_CONFLICT',
  'EXECUTION_FAILED',
  'TIMEOUT',
  'INTERNAL',
] as const;

describe('ERROR_CODES 与 spec §9 对齐', () => {
  it('contracts 的 ERROR_CODES 恰好包含 spec 的 13 个码', () => {
    expect([...ERROR_CODES].sort()).toEqual([...SPEC_ERROR_CODES].sort());
    expect(ERROR_CODES).toHaveLength(13);
  });
});

describe('read 侧可达错误码(场景注入)', () => {
  it('FAKE_SCENARIO=needs_login:get_login_status 报 loggedIn:false,其余 tool 全部 NEEDS_LOGIN', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'needs_login' } });
    const login = await callTool(transport, 1, 'get_login_status');
    expect(login.isError).toBe(false);
    expect(asSuccess(login.envelope).data).toEqual({ loggedIn: false });

    const listed = await callTool(transport, 2, 'list_vouchers', { accountSetId: 'as_001', period: '202607' });
    expect(listed.isError).toBe(true);
    const error = asError(listed.envelope).error;
    expect(error.code).toBe('NEEDS_LOGIN');
    expect(error.retryable).toBe(false);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('FAKE_SCENARIO=profile_busy:PROFILE_BUSY + retryable=true + retryAfterMs', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'profile_busy' } });
    const { envelope } = await callTool(transport, 3, 'search_account_sets', { query: '幻晟' });
    const error = asError(envelope).error;
    expect(error.code).toBe('PROFILE_BUSY');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1500);
  });

  it('FAKE_SCENARIO=timeout:TIMEOUT retryable=true', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'timeout' } });
    const { envelope } = await callTool(transport, 4, 'get_current_accounting_period', { accountSetId: 'as_001' });
    const error = asError(envelope).error;
    expect(error.code).toBe('TIMEOUT');
    expect(error.retryable).toBe(true);
  });

  it('FAKE_SCENARIO=account_set_ambiguous:search 返回 candidates 候选', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'account_set_ambiguous' } });
    const { envelope } = await callTool(transport, 5, 'search_account_sets', { query: '幻晟' });
    const error = asError(envelope).error;
    expect(error.code).toBe('ACCOUNT_SET_AMBIGUOUS');
    expect(error.retryable).toBe(false);
    const candidates = (error.details as { candidates: Array<{ id: string; name: string }> }).candidates;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]).toEqual({ id: 'as_001', name: '幻晟' });
    expect(candidates[1]).toEqual({ id: 'as_002', name: '幻晟(深圳)' });
  });

  it('FAKE_SCENARIO=needs_user_input:details.needs 缺口清单', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'needs_user_input' } });
    const { envelope } = await callTool(transport, 6, 'list_vouchers', { accountSetId: 'as_001', period: '202607' });
    const error = asError(envelope).error;
    expect(error.code).toBe('NEEDS_USER_INPUT');
    expect(error.retryable).toBe(false);
    const needs = (error.details as { needs: unknown[] }).needs;
    expect(Array.isArray(needs)).toBe(true);
    expect(needs.length).toBeGreaterThan(0);
  });

  it('FAKE_SCENARIO=internal:INTERNAL retryable=false', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'internal' } });
    const { envelope } = await callTool(transport, 7, 'get_login_status');
    const error = asError(envelope).error;
    expect(error.code).toBe('INTERNAL');
    expect(error.retryable).toBe(false);
  });

  it('account_set_ambiguous 场景只影响 search,其他 tool 正常', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'account_set_ambiguous' } });
    const login = await callTool(transport, 8, 'get_login_status');
    expect(login.isError).toBe(false);
    expect(asSuccess(login.envelope).data).toEqual({ loggedIn: true });
  });

  it('未知 accountSetId → ACCOUNT_SET_NOT_FOUND + details.nameHint', async () => {
    const transport = makeTransport({ env: {} });
    const { envelope } = await callTool(transport, 9, 'get_current_accounting_period', { accountSetId: 'as_999' });
    const err = asError(envelope);
    expect(err.error.code).toBe('ACCOUNT_SET_NOT_FOUND');
    expect(err.error.retryable).toBe(false);
    expect((err.error.details as { nameHint?: string }).nameHint).toBe('as_999');
    expect(err.meta.accountSetId).toBe('as_999');
  });

  it('FAKE_ALLOWED_ACCOUNT_SETS 范围外账套 → ACCOUNT_SET_FORBIDDEN,search 只返回子集', async () => {
    const transport = makeTransport({ env: { FAKE_ALLOWED_ACCOUNT_SETS: 'as_001,as_002' } });
    const search = await callTool(transport, 10, 'search_account_sets', { query: '易晟' });
    expect(search.isError).toBe(false);
    expect(asSuccess(search.envelope).data).toEqual({ accountSets: [] });

    const search2 = await callTool(transport, 11, 'search_account_sets', { query: '幻晟' });
    const data = asSuccess(search2.envelope).data as { accountSets: Array<{ id: string }> };
    expect(data.accountSets.map((a) => a.id)).toEqual(['as_001', 'as_002']);

    const forbidden = await callTool(transport, 12, 'list_vouchers', { accountSetId: 'as_003', period: '202607' });
    expect(forbidden.isError).toBe(true);
    const error = asError(forbidden.envelope).error;
    expect(error.code).toBe('ACCOUNT_SET_FORBIDDEN');
    expect(error.retryable).toBe(false);
  });
});

describe('错误信封契约', () => {
  it('错误信封也带完整 meta(traceId/retrievedAt/source),字段符合 ErrorEnvelope', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'needs_login' } });
    const { envelope } = await callTool(transport, 13, 'list_vouchers', { accountSetId: 'as_001', period: '202607' });
    const err: ErrorEnvelope = asError(envelope);
    expect(err.meta.traceId).toMatch(/^trc_/);
    expect(err.meta.retrievedAt).toMatch(/\+08:00$/);
    expect(err.meta.source).toBe('api_cache');
    expect(err.meta.accountSetId).toBe('as_001');
    expect(err.meta.accountSetName).toBe('幻晟');
    expect(Object.keys(err.error)).toEqual(expect.arrayContaining(['code', 'message', 'retryable']));
  });
});

describe('FAKE_SLOW_MS 与 FAKE_CRASH_AFTER_N_CALLS', () => {
  it('FAKE_SLOW_MS 延迟每次 tools/call 响应', { timeout: 10_000 }, async () => {
    const transport = makeTransport({ env: { FAKE_SLOW_MS: '120' } });
    const start = Date.now();
    await callTool(transport, 1, 'get_login_status');
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
  });

  it('FAKE_CRASH_AFTER_N_CALLS=N:第 N 次 tools/call 回包后给出一次崩溃信号', async () => {
    const transport = makeTransport({ env: { FAKE_CRASH_AFTER_N_CALLS: '2' } });
    await callTool(transport, 1, 'get_login_status');
    expect(transport.takeCrashSignal()).toBe(false);
    await callTool(transport, 2, 'get_login_status');
    expect(transport.takeCrashSignal()).toBe(true);
    expect(transport.takeCrashSignal()).toBe(false);
    await callTool(transport, 3, 'get_login_status');
    expect(transport.takeCrashSignal()).toBe(false);
  });
});
