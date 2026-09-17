import { afterEach, describe, expect, it } from 'vitest';
import type { McpProfileConfig, ReadToolName } from '@fshine/contracts';
import { McpHost, type McpHostOptions } from './src/index';
import {
  AuditRecorder,
  BAD_SPEC_SERVER_SCRIPT,
  BAD_PROTOCOL_SERVER_SCRIPT,
  EXTRA_TOOL_SERVER_SCRIPT,
  expectErr,
  expectOk,
  makeHost,
  makeHostWithProfile,
  repoRoot,
} from './test-helpers';

const hosts: McpHost[] = [];

function trackedHost(...args: Parameters<typeof makeHost>): McpHost {
  const host = makeHost(...args);
  hosts.push(host);
  return host;
}

function trackedHostWithProfile(profile: McpProfileConfig): McpHost {
  const host = makeHostWithProfile(profile);
  hosts.push(host);
  return host;
}

function trackedHostWithPolicy(options: McpHostOptions): McpHost {
  const host = new McpHost(options);
  hosts.push(host);
  return host;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
});

describe('McpHost × Fake server 子进程(npx tsx packages/mcp-fake/src/main.ts)', () => {
  it('验收 #1:握手成功并经 tools/list 发现 5 个工具', { timeout: 60_000 }, async () => {
    const host = trackedHost();
    await host.ensureReady();
    expect(host.discoveredTools.map((t) => t.name)).toEqual([
      'get_login_status',
      'search_account_sets',
      'get_current_accounting_period',
      'list_vouchers',
      'inspect_account_set',
    ]);
    const listVouchers = host.discoveredTools.find((t) => t.name === 'list_vouchers');
    expect(listVouchers?.inputSchema).toHaveProperty('oneOf'); // inputSchema 自包含原样保留
  });

  it('验收 #2:成功链路 search → period → list_vouchers,meta.traceId/retrievedAt/source 透传', { timeout: 120_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({}, {}, audit);
    const client = host.clientFor('req-success', ['as_001', 'as_002', 'as_003']);

    const search = expectOk(await client.call('search_account_sets', { query: '幻晟' }));
    const accountSets = (search.data as { accountSets: Array<{ id: string; name: string }> }).accountSets;
    expect(accountSets.map((a) => a.id)).toEqual(['as_001', 'as_002']);
    expect(search.meta.source).toBe('api_cache');
    expect(search.meta.traceId).toMatch(/^trc_/);

    const period = expectOk(await client.call('get_current_accounting_period', { accountSetId: 'as_001' }));
    expect((period.data as { period: string }).period).toBe('202607');

    const vouchers = expectOk(await client.call('list_vouchers', { accountSetId: 'as_001', period: '202607' }));
    const data = vouchers.data as Record<string, unknown>;
    expect(data['total']).toBe(45);
    expect(Array.isArray(data['docs'])).toBe(true);
    expect(data['docs']).toHaveLength(4); // fake 按契约首页 4 张,预算内不触发裁剪
    expect(data['_docsTruncated']).toBeUndefined();
    expect(vouchers.meta.retrievedAt).toMatch(/\+08:00$/);
    expect(vouchers.meta.source).toBe('api_cache');

    // 审计 onStart/onEnd 字段(验收 #10 成功侧)
    expect(audit.starts).toHaveLength(3);
    expect(audit.starts[0]).toMatchObject({
      requestId: 'req-success',
      toolName: 'search_account_sets',
      safeArguments: { query: '幻晟' },
    });
    expect(audit.starts[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(audit.ends).toHaveLength(3);
    const end = audit.ends[0];
    expect(end).toMatchObject({
      requestId: 'req-success',
      toolName: 'search_account_sets',
      status: 'ok',
      source: 'api_cache',
    });
    expect(end?.traceId).toMatch(/^trc_/);
    expect(end?.errorCode).toBeUndefined();
    expect(end?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('验收 #3:scope 预检——未授权账套在 MCP 调用前被拒,不触发 audit onStart', { timeout: 60_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({}, {}, audit);
    const client = host.clientFor('req-scope', ['as_001']);

    const outcome = await client.call('get_current_accounting_period', { accountSetId: 'as_003' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.code).toBe('ACCOUNT_SET_FORBIDDEN');
    expect(outcome.error.message).toBe('没有该账套的访问权限');
    expect(outcome.error.retryable).toBe(false);
    expect(outcome.meta).toBeUndefined();
    expect(audit.starts).toHaveLength(0); // 未发往 server、未触发 onStart
    expect(audit.ends).toHaveLength(0);

    const allowed = expectOk(await client.call('get_current_accounting_period', { accountSetId: 'as_001' }));
    expect((allowed.data as { period: string }).period).toBe('202607');
    expect(audit.starts).toHaveLength(1);
  });

  it('scope 过滤搜索结果:模型看不到未授权账套', { timeout: 60_000 }, async () => {
    const host = trackedHost();
    const client = host.clientFor('req-search-scope', ['as_001']);

    const matched = expectOk(await client.call('search_account_sets', { query: '幻晟' }));
    expect(matched.data).toEqual({ accountSets: [{ id: 'as_001', name: '幻晟' }] });

    const inaccessible = expectOk(await client.call('search_account_sets', { query: '易晟' }));
    expect(inaccessible.data).toEqual({ accountSets: [] });
  });

  it('验收 #4a:FAKE_SCENARIO=needs_login → ok:false NEEDS_LOGIN,get_login_status 本身仍可用', { timeout: 60_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({ FAKE_SCENARIO: 'needs_login' }, {}, audit);
    const client = host.clientFor('req-login', ['as_001']);

    const login = expectOk(await client.call('get_login_status', {}));
    expect((login.data as { loggedIn: boolean }).loggedIn).toBe(false);

    const period = expectErr(await client.call('get_current_accounting_period', { accountSetId: 'as_001' }));
    expect(period.error.code).toBe('NEEDS_LOGIN');
    expect(period.error.retryable).toBe(false);
    expect(period.meta?.traceId).toMatch(/^trc_/);
    // 审计失败侧字段(验收 #10)
    const periodEnd = audit.ends.find((e) => e.toolName === 'get_current_accounting_period');
    expect(periodEnd?.errorCode).toBe('NEEDS_LOGIN');
    expect(periodEnd?.status).toBe('error');
    expect(periodEnd?.traceId).toMatch(/^trc_/);
  });

  it('验收 #4b:FAKE_SCENARIO=account_set_ambiguous → 候选错误透传', { timeout: 60_000 }, async () => {
    const host = trackedHost({ FAKE_SCENARIO: 'account_set_ambiguous' });
    const client = host.clientFor('req-amb', ['as_001']);
    const outcome = expectErr(await client.call('search_account_sets', { query: '幻晟' }));
    expect(outcome.error.code).toBe('ACCOUNT_SET_AMBIGUOUS');
    expect(outcome.error.retryable).toBe(false);
    const candidates = (outcome.error.details as { candidates: Array<{ id: string }> }).candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.id)).toEqual(['as_001', 'as_002']);
  });

  it('验收 #5:profile_busy + maxRetries=1 → 两次尝试后返回 PROFILE_BUSY,总耗时 ≥ retryAfterMs', { timeout: 120_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({ FAKE_SCENARIO: 'profile_busy' }, { profile: { maxRetries: 1 } }, audit);
    await host.ensureReady(); // 预热连接,让耗时只反映尝试与退避
    const client = host.clientFor('req-busy', ['as_001']);

    const started = Date.now();
    const outcome = expectErr(await client.call('get_login_status', {}));
    const elapsed = Date.now() - started;

    expect(outcome.error.code).toBe('PROFILE_BUSY');
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.retryAfterMs).toBe(1500); // server 建议的退避原样透传
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(audit.starts).toHaveLength(1); // onStart 每次 call 一次,不按尝试重复
    expect(audit.ends).toHaveLength(1);
    expect(audit.ends[0]?.errorCode).toBe('PROFILE_BUSY');
  });

  it('渠道总预算不足时不再重试,快速返回最后错误', { timeout: 120_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost(
      { FAKE_SCENARIO: 'profile_busy' },
      { profile: { maxRetries: 3 }, channelBudgetMs: 2_000 },
      audit,
    );
    await host.ensureReady();
    const client = host.clientFor('req-budget', ['as_001']);

    const started = Date.now();
    const outcome = expectErr(await client.call('get_login_status', {}));
    const elapsed = Date.now() - started;

    expect(outcome.error.code).toBe('PROFILE_BUSY');
    expect(elapsed).toBeLessThan(1_000); // 预算不足:没睡 retryAfterMs 就放弃了
    expect(audit.starts).toHaveLength(1);
    expect(audit.ends).toHaveLength(1);
  });

  it('验收 #6:FAKE_SLOW_MS=3000 + requestTimeoutMs=800 → TIMEOUT;maxRetries=0 不重试', { timeout: 60_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost(
      { FAKE_SLOW_MS: '3000' },
      { profile: { requestTimeoutMs: 800, maxRetries: 0 } },
      audit,
    );
    const client = host.clientFor('req-timeout', ['as_001']);

    const started = Date.now();
    const outcome = expectErr(await client.call('get_login_status', {}));
    const elapsed = Date.now() - started;

    expect(outcome.error.code).toBe('TIMEOUT');
    expect(outcome.error.retryable).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(790);
    expect(elapsed).toBeLessThan(2_500); // 单次尝试即返回,无退避重试
    expect(audit.starts).toHaveLength(1);
    expect(audit.ends).toHaveLength(1);
    expect(audit.ends[0]?.errorCode).toBe('TIMEOUT');
  });

  it('验收 #7:FAKE_CRASH_AFTER_N_CALLS=1 → 第一次成功(回包后进程退出),第二次自动重连成功', { timeout: 120_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({ FAKE_CRASH_AFTER_N_CALLS: '1' }, {}, audit);
    const client = host.clientFor('req-crash', ['as_001']);

    const first = expectOk(await client.call('get_login_status', {}));
    expect((first.data as { loggedIn: boolean }).loggedIn).toBe(true);
    await waitFor(() => !host.connected); // 等子进程退出被感知

    const second = expectOk(await client.call('get_current_accounting_period', { accountSetId: 'as_001' }));
    expect((second.data as { period: string }).period).toBe('202607'); // 自动 spawn + 握手 + tools/list

    expect(audit.ends).toHaveLength(2);
    expect(audit.ends.every((e) => e.status === 'ok')).toBe(true);
  });

  it('tools/list 之外的工具名 → INTERNAL「工具不存在」,不触发 audit', { timeout: 60_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({}, {}, audit);
    await host.ensureReady();
    const client = host.clientFor('req-unknown', ['as_001']);
    const outcome = await client.call('not_a_tool' as ReadToolName, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toBe('工具不存在');
    expect(audit.starts).toHaveLength(0);
    expect(audit.ends).toHaveLength(0);
  });

  it('工具参数不符合 tools/list inputSchema → CONTRACT_INVALID 且不触发 audit', { timeout: 60_000 }, async () => {
    const audit = new AuditRecorder();
    const host = trackedHost({}, {}, audit);
    const client = host.clientFor('req-invalid-args', ['as_001']);
    const outcome = expectErr(await client.call('search_account_sets', { query: '' }));
    expect(outcome.error.code).toBe('CONTRACT_INVALID');
    expect(outcome.error.retryable).toBe(false);
    expect(audit.starts).toHaveLength(0);
    expect(audit.ends).toHaveLength(0);
  });

  it('specVersion 不匹配 → 连接失败且 profile 标记不可用,后续 call 直接失败', { timeout: 60_000 }, async () => {
    const host = trackedHostWithProfile({
      command: process.execPath,
      args: ['-e', BAD_SPEC_SERVER_SCRIPT],
      cwd: repoRoot,
      requestTimeoutMs: 5_000,
      maxRetries: 0,
    });
    const client = host.clientFor('req-spec', ['as_001']);

    const first = await client.call('get_login_status', {});
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe('INTERNAL');
      expect(first.error.retryable).toBe(false);
      expect(first.error.message).toContain('specVersion');
    }

    const started = Date.now();
    const second = await client.call('get_login_status', {});
    expect(Date.now() - started).toBeLessThan(1_000); // 不再尝试重连,直接失败
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('specVersion');
  });

  it('MCP protocolVersion 未协商到客户端版本 → 拒绝连接', { timeout: 60_000 }, async () => {
    const host = trackedHostWithProfile({
      command: process.execPath,
      args: ['-e', BAD_PROTOCOL_SERVER_SCRIPT],
      cwd: repoRoot,
      requestTimeoutMs: 5_000,
      maxRetries: 0,
    });
    const outcome = await host.clientFor('req-protocol', ['as_001']).call('get_login_status', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.error.message).toContain('protocolVersion');
    }
  });

  it('tools/list 声明白名单外工具 → 拒绝连接且标记不可用(V0 只读硬闸)', { timeout: 60_000 }, async () => {
    const host = trackedHostWithProfile({
      command: process.execPath,
      args: ['-e', EXTRA_TOOL_SERVER_SCRIPT],
      cwd: repoRoot,
      requestTimeoutMs: 5_000,
      maxRetries: 0,
    });
    const client = host.clientFor('req-allowlist', ['as_001']);

    const first = await client.call('get_login_status', {});
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe('INTERNAL');
      expect(first.error.retryable).toBe(false);
    }

    const started = Date.now();
    const second = await client.call('get_login_status', {});
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain('submit_voucher'); // 不可用原因:白名单外工具
  });

  it('V1 显式工具类别策略允许组合 server,但缺少类别的工具仍拒绝', { timeout: 60_000 }, async () => {
    const readTools = ['get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set'];
    const categories = Object.fromEntries(readTools.map((name) => [name, 'read' as const]));
    const host = new McpHost({
      profile: {
        command: process.execPath,
        args: ['-e', EXTRA_TOOL_SERVER_SCRIPT],
        cwd: repoRoot,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
      },
      toolPolicy: {
        allowedTools: [...readTools, 'submit_voucher'],
        categories: { ...categories, submit_voucher: 'write' },
        allowedCategories: ['read', 'write'],
      },
    });
    hosts.push(host);
    await host.ensureReady();
    expect(host.discoveredTools.map((tool) => tool.name)).toContain('submit_voucher');
  });

  it('V1 类别门禁在 request-scoped client 拒绝 write capability', { timeout: 60_000 }, async () => {
    const readTools = ['get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set'];
    const categories = Object.fromEntries(readTools.map((name) => [name, 'read' as const]));
    const host = trackedHostWithPolicy({
      profile: {
        command: process.execPath,
        args: ['-e', EXTRA_TOOL_SERVER_SCRIPT],
        cwd: repoRoot,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
      },
      toolPolicy: {
        allowedTools: [...readTools, 'submit_voucher'],
        categories: { ...categories, submit_voucher: 'write' },
      },
    });
    await host.ensureReady();
    const outcome = await host.clientFor('req-v1-policy', ['as_001'], undefined, ['read'])
      .call('submit_voucher' as ReadToolName, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('操作权限');
  });

  it('普通 client 不能自行把 confirmed 设为 true', { timeout: 60_000 }, async () => {
    const readTools = ['get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set'];
    const categories = Object.fromEntries(readTools.map((name) => [name, 'read' as const]));
    const host = trackedHostWithPolicy({
      profile: { command: process.execPath, args: ['-e', EXTRA_TOOL_SERVER_SCRIPT], cwd: repoRoot, requestTimeoutMs: 5_000, maxRetries: 0 },
      toolPolicy: { allowedTools: [...readTools, 'submit_voucher'], categories: { ...categories, submit_voucher: 'write' } },
    });
    const outcome = await host.clientFor('req-confirm-gate', ['as_001'], undefined, ['read', 'write'])
      .call('submit_voucher', { confirmed: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('尚未获得用户确认');
  });
});
