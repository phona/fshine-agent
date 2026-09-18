import { describe, expect, it } from 'vitest';
import type { SearchReferencesResult } from '@fshine/contracts';
import { asError, asSuccess, callTool, makeTransport, rpc } from './test-helpers';

async function search(id: number, args: Record<string, unknown>) {
  const { isError, envelope } = await callTool(makeTransport({ env: {} }), id, 'search_references', args);
  return { isError, envelope, data: asSuccess(envelope).data as SearchReferencesResult };
}

describe('search_references(fake × 统一返回形状)', () => {
  it('subject 精确匹配 code → matched,候选保留平台真实 id/code/name', async () => {
    const { data } = await search(1, { accountSetId: 'as_003', referenceType: 'subject', query: '1122' });
    expect(data.status).toBe('matched');
    expect(data.candidates).toEqual([
      { id: 'u1122', code: '1122', name: '应收账款', useAssistant: true, assistantType: 'customer' },
    ]);
  });

  it('subject 关键字唯一匹配(归一化包含)', async () => {
    const { data } = await search(2, { accountSetId: 'as_003', referenceType: 'subject', query: '银行' });
    expect(data.status).toBe('matched');
    expect(data.candidates[0]?.code).toBe('1002');
  });

  it('assistant 简称「幻东」在 customer 范围内唯一匹配', async () => {
    const { data } = await search(3, {
      accountSetId: 'as_003',
      referenceType: 'assistant',
      query: '幻东',
      filters: { subjectCode: '1122' },
    });
    expect(data.status).toBe('matched');
    expect(data.candidates).toEqual([
      { id: '283655291', code: '00002', name: '幻州幻东机械制造有限公司', type: 'customer' },
    ]);
  });

  it('assistant 多候选 → ambiguous(客户+供应商都命中,不自动选择)', async () => {
    const { data } = await search(4, { accountSetId: 'as_003', referenceType: 'assistant', query: '幻东' });
    expect(data.status).toBe('ambiguous');
    expect(data.candidates.map((c) => ('type' in c ? c.type : undefined)).sort()).toEqual(['customer', 'supplier']);
    // 同名不同类型(易晟汽车)同样 ambiguous
    const sameName = await search(5, { accountSetId: 'as_003', referenceType: 'assistant', query: '易晟汽车' });
    expect(sameName.data.status).toBe('ambiguous');
  });

  it('customer/supplier 类型过滤收窄候选', async () => {
    const customer = await search(6, {
      accountSetId: 'as_003', referenceType: 'assistant', query: '易晟汽车',
      filters: { assistantType: 'customer' },
    });
    expect(customer.data.status).toBe('matched');
    expect(customer.data.candidates[0]).toMatchObject({ id: 'c00089', type: 'customer' });
    const supplier = await search(7, {
      accountSetId: 'as_003', referenceType: 'assistant', query: '易晟汽车',
      filters: { assistantType: 'supplier' },
    });
    expect(supplier.data.status).toBe('matched');
    expect(supplier.data.candidates[0]).toMatchObject({ id: 's00231', type: 'supplier' });
  });

  it('不存在 → not_found(空候选,不伪装成别的状态)', async () => {
    const { data } = await search(8, { accountSetId: 'as_003', referenceType: 'assistant', query: '不存在的公司' });
    expect(data.status).toBe('not_found');
    expect(data.candidates).toEqual([]);
  });

  it('不支持 referenceType → unavailable + supportedTypes', async () => {
    const { data } = await search(9, { accountSetId: 'as_003', referenceType: 'employee', query: '张三' });
    expect(data.status).toBe('unavailable');
    expect(data.candidates).toEqual([]);
    expect(data.details).toMatchObject({ supportedTypes: ['subject', 'assistant'] });
  });

  it('employee 类辅助科目档案未加载 → unavailable(不静默 not_found)', async () => {
    const { data } = await search(10, {
      accountSetId: 'as_003', referenceType: 'assistant', query: '张三',
      filters: { subjectCode: '1221' },
    });
    expect(data.status).toBe('unavailable');
    expect(data.details).toMatchObject({ supportedAssistantTypes: ['customer', 'supplier'] });
  });

  it('不同账套不串结果:同名查询在 as_001 是 not_found', async () => {
    const in003 = await search(11, {
      accountSetId: 'as_003', referenceType: 'assistant', query: '幻东',
      filters: { assistantType: 'customer' },
    });
    expect(in003.data.status).toBe('matched');
    const in001 = await search(12, { accountSetId: 'as_001', referenceType: 'assistant', query: '幻东' });
    expect(in001.data.status).toBe('not_found');
    // meta 标注账套,信封可审计
    expect(in001.envelope.meta.accountSetId).toBe('as_001');
  });

  it('账套越权被拒绝(FAKE_ALLOWED_ACCOUNT_SETS)', async () => {
    const transport = makeTransport({ env: { FAKE_ALLOWED_ACCOUNT_SETS: 'as_001' } });
    const { isError, envelope } = await callTool(transport, 13, 'search_references', {
      accountSetId: 'as_003', referenceType: 'assistant', query: '幻东',
    });
    expect(isError).toBe(true);
    expect(asError(envelope).error.code).toBe('ACCOUNT_SET_FORBIDDEN');
  });

  it('inputSchema 拒绝:query 为空 / filters 多余字段', async () => {
    const transport = makeTransport({ env: {} });
    // -32602 是 JSON-RPC 层错误(无 result.content),在 rpc 层断言
    const missing = await rpc(transport, 14, 'tools/call', {
      name: 'search_references', arguments: { accountSetId: 'as_003', referenceType: 'subject', query: '' },
    });
    expect((missing['error'] as { code: number }).code).toBe(-32602);
    const extra = await rpc(transport, 15, 'tools/call', {
      name: 'search_references',
      arguments: { accountSetId: 'as_003', referenceType: 'subject', query: 'x', filters: { assistantType: 'customer', bogus: 1 } },
    });
    expect((extra['error'] as { code: number }).code).toBe(-32602);
  });
});
