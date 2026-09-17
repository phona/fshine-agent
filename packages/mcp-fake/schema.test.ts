import { describe, expect, it } from 'vitest';
import { READ_TOOLS } from '@fshine/contracts';
import { asError, callTool, makeTransport, rpc } from './test-helpers';

describe('生命周期握手(进程内)', () => {
  it('initialize 返回 protocolVersion/capabilities/serverInfo', async () => {
    const transport = makeTransport({ env: {} });
    const response = await rpc(transport, 1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tax-agent', version: '0.1.0' },
    });
    expect(response['jsonrpc']).toBe('2.0');
    expect(response['id']).toBe(1);
    const result = response['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2025-06-18');
    expect(result['capabilities']).toEqual({ tools: {} });
    expect(result['serverInfo']).toEqual({
      name: '17dz-read',
      version: '0.1.0',
      specVersion: '0.5',
      allowedAccountSets: null,
    });
  });

  it('notifications/initialized 不回包', async () => {
    const transport = makeTransport({ env: {} });
    const lines = await transport.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(lines).toEqual([]);
  });

  it('FAKE_ALLOWED_ACCOUNT_SETS 在 serverInfo.allowedAccountSets 回显,未设为 null', async () => {
    const limited = makeTransport({ env: { FAKE_ALLOWED_ACCOUNT_SETS: 'as_001, as_002' } });
    const response = await rpc(limited, 1, 'initialize', {});
    const serverInfo = (response['result'] as Record<string, unknown>)['serverInfo'] as Record<string, unknown>;
    expect(serverInfo['allowedAccountSets']).toEqual(['as_001', 'as_002']);
  });

  it('tools/list 返回 5 个 read tool,名字与 READ_TOOLS 一致', async () => {
    const transport = makeTransport({ env: {} });
    await rpc(transport, 1, 'initialize', {});
    const response = await rpc(transport, 2, 'tools/list');
    const tools = (response['result'] as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t['name'])).toEqual([...READ_TOOLS]);
    for (const tool of tools) {
      expect(typeof tool['description']).toBe('string');
      expect((tool['description'] as string).length).toBeGreaterThan(0);
      expect(tool['inputSchema']).toBeDefined();
    }
  });
});

describe('inputSchema 保真(spec §6.2)', () => {
  const transport = makeTransport({ env: {} });

  async function listTools(): Promise<Array<{ name: string; inputSchema: Record<string, unknown> }>> {
    const response = await rpc(transport, 100, 'tools/list');
    return (response['result'] as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  }

  it('所有 tool 的 inputSchema 都是 object + additionalProperties:false', async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  it('get_login_status:空 properties,无 required', async () => {
    const tools = await listTools();
    const schema = tools.find((t) => t.name === 'get_login_status')!.inputSchema;
    expect(schema['properties']).toEqual({});
    expect(schema['required']).toBeUndefined();
  });

  it('search_account_sets:required query,minLength 1', async () => {
    const tools = await listTools();
    const schema = tools.find((t) => t.name === 'search_account_sets')!.inputSchema;
    expect(schema['required']).toEqual(['query']);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['query']).toEqual({ type: 'string', minLength: 1 });
  });

  it('list_vouchers:oneOf 四分支存在,comment 与 spec 一致', async () => {
    const tools = await listTools();
    const schema = tools.find((t) => t.name === 'list_vouchers')!.inputSchema;
    const oneOf = schema['oneOf'] as Array<Record<string, unknown>>;
    expect(oneOf).toHaveLength(4);
    expect(oneOf.map((b) => b['comment'])).toEqual([
      '默认模式:不传任何分页参数 = 首页 4 张',
      '手动翻页',
      '拉全(allPages 仅 const true 命中,false 不算数)',
      '游标续翻',
    ]);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['period']).toEqual({ type: 'string', pattern: '^\\d{6}$' });
    expect(props['pageSize']).toEqual({ type: 'integer', minimum: 1, maximum: 20, default: 4 });
    expect(schema['required']).toEqual(['accountSetId', 'period']);
  });

  it('inspect_account_set:accountSetId 必填,task 可选', async () => {
    const tools = await listTools();
    const schema = tools.find((t) => t.name === 'inspect_account_set')!.inputSchema;
    expect(schema['required']).toEqual(['accountSetId']);
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['task']?.['type']).toBe('string');
  });
});

describe('ajv 参数校验 → JSON-RPC -32602', () => {
  const transport = makeTransport({ env: {} });

  async function expectInvalidParams(method: string, params: unknown): Promise<void> {
    const response = await rpc(transport, 200, method, params);
    const error = response['error'] as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  }

  it('pageNo 与 cursor 同传(oneOf 互斥)被拒绝', async () => {
    await expectInvalidParams('tools/call', {
      name: 'list_vouchers',
      arguments: { accountSetId: 'as_001', period: '202607', pageNo: 1, cursor: 'eyJvZmZzZXQiOjF9' },
    });
  });

  it('allPages=false 不算任何分支,被拒绝', async () => {
    await expectInvalidParams('tools/call', {
      name: 'list_vouchers',
      arguments: { accountSetId: 'as_001', period: '202607', allPages: false },
    });
  });

  it('pageNo 与 allPages 同传被拒绝', async () => {
    await expectInvalidParams('tools/call', {
      name: 'list_vouchers',
      arguments: { accountSetId: 'as_001', period: '202607', pageNo: 1, allPages: true },
    });
  });

  it('period 不满足 ^\\d{6}$ 被拒绝', async () => {
    await expectInvalidParams('tools/call', {
      name: 'list_vouchers',
      arguments: { accountSetId: 'as_001', period: '2026-07' },
    });
  });

  it('缺少必填参数被拒绝(search 无 query)', async () => {
    await expectInvalidParams('tools/call', { name: 'search_account_sets', arguments: {} });
  });

  it('多余字段被拒绝(get_login_status 传了额外属性)', async () => {
    await expectInvalidParams('tools/call', { name: 'get_login_status', arguments: { foo: 1 } });
  });

  it('未知 tool 被 -32602 拒绝', async () => {
    await expectInvalidParams('tools/call', { name: 'submit_voucher', arguments: {} });
  });

  it('合法的默认/手动/拉全/游标分页参数都通过 schema(由业务层返回成功验证)', async () => {
    const base = { accountSetId: 'as_001', period: '202607' };
    for (const args of [
      base,
      { ...base, pageNo: 0 },
      { ...base, pageNo: 1, pageSize: 10 },
      { ...base, allPages: true },
      { ...base, cursor: Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url') },
      { ...base, cursor: Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url'), pageSize: 5 },
    ]) {
      const { envelope, isError } = await callTool(transport, 201, 'list_vouchers', args);
      expect(isError, `参数应通过 schema: ${JSON.stringify(args)}`).toBe(false);
      expect('data' in envelope).toBe(true);
    }
  });
});

describe('JSON-RPC 协议层错误', () => {
  it('非法 JSON → -32700', async () => {
    const transport = makeTransport({ env: {} });
    const response = JSON.parse((await transport.handleLine('{not json'))[0]!) as Record<string, unknown>;
    expect((response['error'] as Record<string, unknown>)['code']).toBe(-32700);
  });

  it('批量请求 → -32600', async () => {
    const transport = makeTransport({ env: {} });
    const response = JSON.parse((await transport.handleLine('[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]'))[0]!) as Record<string, unknown>;
    expect((response['error'] as Record<string, unknown>)['code']).toBe(-32600);
  });

  it('未知方法 → -32601', async () => {
    const transport = makeTransport({ env: {} });
    const response = await rpc(transport, 9, 'resources/list');
    expect((response['error'] as Record<string, unknown>)['code']).toBe(-32601);
  });

  it('业务失败是 result.isError=true,不是 JSON-RPC error', async () => {
    const transport = makeTransport({ env: { FAKE_SCENARIO: 'internal' } });
    const { raw, isError, envelope } = await callTool(transport, 10, 'get_login_status');
    expect(raw['error']).toBeUndefined();
    expect(isError).toBe(true);
    expect(asError(envelope).error.code).toBe('INTERNAL');
  });
});
