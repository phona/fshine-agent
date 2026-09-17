import { describe, expect, it } from 'vitest';
import type { ListVouchersResult, SearchAccountSetsResult, VoucherDoc } from '@fshine/contracts';
import { asSuccess, callTool, makeTransport, rpc, type RpcResponse } from './test-helpers';

function cursorOf(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

async function initialize(transport: ReturnType<typeof makeTransport>): Promise<RpcResponse> {
  return rpc(transport, 1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' },
  });
}

describe('查询链路 search → period → list_vouchers', () => {
  const transport = makeTransport({ env: {} });
  let listResult: ListVouchersResult;

  it('search_account_sets("幻晟") 命中 as_001 与 as_002 两个候选', async () => {
    await initialize(transport);
    const { isError, envelope } = await callTool(transport, 2, 'search_account_sets', { query: '幻晟' });
    expect(isError).toBe(false);
    const success = asSuccess(envelope);
    const data = success.data as SearchAccountSetsResult;
    expect(data.accountSets.map((a) => a.id)).toEqual(['as_001', 'as_002']);
    expect(data.accountSets[0]).toEqual({ id: 'as_001', name: '幻晟' });
    expect(data.accountSets[1]).toEqual({ id: 'as_002', name: '幻晟(深圳)' });
  });

  it('search_account_sets("易晟") 只命中 as_003', async () => {
    const { envelope } = await callTool(transport, 3, 'search_account_sets', { query: '易晟' });
    const data = asSuccess(envelope).data as SearchAccountSetsResult;
    expect(data.accountSets).toEqual([{ id: 'as_003', name: '易晟汽车' }]);
  });

  it('search_account_sets("不存在") 返回空列表(成功信封)', async () => {
    const { isError, envelope } = await callTool(transport, 4, 'search_account_sets', { query: '不存在' });
    expect(isError).toBe(false);
    const data = asSuccess(envelope).data as SearchAccountSetsResult;
    expect(data.accountSets).toEqual([]);
  });

  it('get_current_accounting_period 返回期间且 meta 带账套信息', async () => {
    const { isError, envelope } = await callTool(transport, 5, 'get_current_accounting_period', {
      accountSetId: 'as_001',
    });
    expect(isError).toBe(false);
    const success = asSuccess(envelope);
    expect(success.data).toEqual({ period: '202607' });
    expect(success.meta.accountSetId).toBe('as_001');
    expect(success.meta.accountSetName).toBe('幻晟');
  });

  it('list_vouchers 默认首页:total 45,docs 4 张(契约页大小),有 nextCursor,docDto 结构正确', async () => {
    const { isError, envelope } = await callTool(transport, 6, 'list_vouchers', {
      accountSetId: 'as_001',
      period: '202607',
    });
    expect(isError).toBe(false);
    const success = asSuccess(envelope);
    const data = success.data as ListVouchersResult;
    listResult = data;
    expect(data.total).toBe(45);
    expect(data.docs).toHaveLength(4);
    expect(data.offset).toBe(0);
    expect(data.nextCursor).toBe(cursorOf(4));
    expect(data.docs).toHaveLength(4);

    const first = data.docs[0]!;
    expect(first).toEqual({
      id: 'doc_202607_0001',
      type: '记',
      number: '001',
      journalDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      haveAnnex: expect.any(Number),
      entryDtoList: expect.any(Array),
    });
    // 凭证显示号 = type + '-' + number → 记-001
    expect(`${first.type}-${first.number}`).toBe('记-001');
    const entry = first.entryDtoList[0]!;
    expect(Object.keys(entry).sort()).toEqual(
      expect.arrayContaining(['accountTitleCode', 'creditAmount', 'debitAmount', 'summary']),
    );
    expect(entry.debitAmount + first.entryDtoList[1]!.debitAmount).toBeGreaterThan(0);
    // 借贷平衡
    const debit = first.entryDtoList.reduce((sum, e) => sum + e.debitAmount, 0);
    const credit = first.entryDtoList.reduce((sum, e) => sum + e.creditAmount, 0);
    expect(debit).toBe(credit);
    expect(success.meta.accountSetId).toBe('as_001');
  });

  it('cursor 续翻第 2、3 页,末页(第 12 页)nextCursor 终止', async () => {
    const next1 = listResult.nextCursor!;
    const page2 = await callTool(transport, 7, 'list_vouchers', { accountSetId: 'as_001', period: '202607', cursor: next1 });
    const data2 = asSuccess(page2.envelope).data as ListVouchersResult;
    expect(data2.total).toBe(45);
    expect(data2.docs).toHaveLength(4);
    expect(data2.docs[0]!.id).toBe('doc_202607_0005');
    expect(data2.offset).toBe(4);
    expect(data2.prevCursor).toBe(cursorOf(0));
    expect(data2.nextCursor).toBe(cursorOf(8));

    const page3 = await callTool(transport, 8, 'list_vouchers', { accountSetId: 'as_001', period: '202607', cursor: data2.nextCursor! });
    const data3 = asSuccess(page3.envelope).data as ListVouchersResult;
    expect(data3.docs).toHaveLength(4);
    expect(data3.docs.map((d) => d.id)).toEqual([
      'doc_202607_0009',
      'doc_202607_0010',
      'doc_202607_0011',
      'doc_202607_0012',
    ]);
    expect(data3.nextCursor).toBe(cursorOf(12));

    // 末页(第 12 页,pageNo=11):仅剩 1 张,nextCursor 终止
    const lastPage = await callTool(transport, 9, 'list_vouchers', { accountSetId: 'as_001', period: '202607', cursor: cursorOf(44) });
    const dataLast = asSuccess(lastPage.envelope).data as ListVouchersResult;
    expect(dataLast.docs).toHaveLength(1);
    expect(dataLast.docs[0]!.id).toBe('doc_202607_0045');
    expect(dataLast.prevCursor).toBe(cursorOf(40));
    expect(dataLast.nextCursor).toBeUndefined();
  });

  it('allPages=true 一次拉全 45 张且不返回 nextCursor', async () => {
    const { envelope } = await callTool(transport, 9, 'list_vouchers', {
      accountSetId: 'as_001',
      period: '202607',
      allPages: true,
    });
    const data = asSuccess(envelope).data as ListVouchersResult;
    expect(data.total).toBe(45);
    expect(data.docs).toHaveLength(45);
    expect(data.nextCursor).toBeUndefined();
  });

  it('pageNo 手动翻页 + pageSize 生效(pageNo*pageSize=offset)', async () => {
    const { envelope } = await callTool(transport, 10, 'list_vouchers', {
      accountSetId: 'as_001',
      period: '202607',
      pageNo: 1,
      pageSize: 10,
    });
    const data = asSuccess(envelope).data as ListVouchersResult;
    expect(data.docs.map((d) => d.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `doc_202607_${String(i + 11).padStart(4, '0')}`),
    );
    expect(data.offset).toBe(10);
    expect(data.nextCursor).toBe(cursorOf(20));
  });

  it('超出末页的 pageNo 返回空 docs、无 nextCursor', async () => {
    const { envelope } = await callTool(transport, 11, 'list_vouchers', {
      accountSetId: 'as_001',
      period: '202607',
      pageNo: 99,
    });
    const data = asSuccess(envelope).data as ListVouchersResult;
    expect(data.docs).toEqual([]);
    expect(data.nextCursor).toBeUndefined();
  });

  it('其他期间确定性出数:202606 共 23 张,未知期间 0 张', async () => {
    const june = await callTool(transport, 12, 'list_vouchers', { accountSetId: 'as_001', period: '202606' });
    expect((asSuccess(june.envelope).data as ListVouchersResult).total).toBe(23);

    const none = await callTool(transport, 13, 'list_vouchers', { accountSetId: 'as_001', period: '209901' });
    const data = asSuccess(none.envelope).data as ListVouchersResult;
    expect(data.total).toBe(0);
    expect(data.docs).toEqual([]);
  });

  it('同参数两次调用结果确定性一致(除 meta)', async () => {
    const args = { accountSetId: 'as_001', period: '202607' };
    const a = asSuccess((await callTool(transport, 14, 'list_vouchers', args)).envelope).data as ListVouchersResult;
    const b = asSuccess((await callTool(transport, 15, 'list_vouchers', args)).envelope).data as ListVouchersResult;
    expect(a).toEqual(b);
  });

  it('inspect_account_set 返回科目/辅助核算/近期凭证', async () => {
    const { isError, envelope } = await callTool(transport, 16, 'inspect_account_set', {
      accountSetId: 'as_003',
      task: 'bills',
    });
    expect(isError).toBe(false);
    const success = asSuccess(envelope);
    const data = success.data as { subjects: unknown[]; assistants: unknown[]; recentVouchers: unknown[] };
    expect(data.subjects.length).toBeGreaterThan(0);
    expect(data.assistants).toContainEqual({ type: '客户', name: '易晟汽车', id: 'c00089' });
    expect(data.recentVouchers.length).toBeGreaterThan(0);
    expect(success.meta.accountSetId).toBe('as_003');
    expect(success.meta.accountSetName).toBe('易晟汽车');
  });
});

describe('V1 写入确认链路', () => {
  const contract = {
    accountSetId: 'as_001',
    entries: [
      { summary: '测试录入', subjectCode: '1001', debit: 100, credit: 0 },
      { summary: '测试录入', subjectCode: '2202', debit: 0, credit: 100 },
    ],
  };

  it('validate → dry-run 不落库 → confirmed 执行，并按相同 key 重放', async () => {
    const transport = makeTransport({ env: { FAKE_ENABLE_WRITE: '1' } });
    const validation = await callTool(transport, 901, 'validate_voucher', { contract });
    expect((asSuccess(validation.envelope).data as { ok: boolean }).ok).toBe(true);

    const key = 'test-write-key';
    const preview = await callTool(transport, 902, 'submit_voucher', { contract, idempotencyKey: key, confirmed: false });
    expect(asSuccess(preview.envelope).data).toMatchObject({ dryRun: true, preview: { accountSetId: 'as_001' } });
    const before = await callTool(transport, 903, 'get_submission_status', { tool: 'submit_voucher', idempotencyKey: key });
    expect(asSuccess(before.envelope).data).toMatchObject({ status: 'not_found', executionState: 'not_started' });

    const submitted = await callTool(transport, 904, 'submit_voucher', { contract, idempotencyKey: key, confirmed: true });
    const result = asSuccess(submitted.envelope).data as { dryRun: boolean; voucherNo: string };
    expect(result.dryRun).toBe(false);
    const replay = await callTool(transport, 905, 'submit_voucher', { contract, idempotencyKey: key, confirmed: true });
    expect(asSuccess(replay.envelope).data).toEqual(result);
  });
});

describe('信封契约(contracts 类型视角)', () => {
  it('成功信封字段完整:traceId trc_ 前缀、retrievedAt ISO+08:00、source=api_cache', async () => {
    const transport = makeTransport({ env: {} });
    const { envelope } = await callTool(transport, 20, 'get_login_status');
    const success = asSuccess(envelope);
    expect(success.meta.traceId).toMatch(/^trc_[0-9a-f]{16}$/);
    expect(success.meta.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    expect(success.meta.source).toBe('api_cache');
    expect(Object.keys(success.data as Record<string, unknown>)).toEqual(['loggedIn']);
    // 不涉及账套的 tool 不带 accountSet 元数据
    expect(success.meta.accountSetId).toBeUndefined();
    expect(success.meta.accountSetName).toBeUndefined();
  });

  it('list_vouchers 的 docs 逐张满足 VoucherDoc 结构', async () => {
    const transport = makeTransport({ env: {} });
    const { envelope } = await callTool(transport, 21, 'list_vouchers', {
      accountSetId: 'as_002',
      period: '202607',
      allPages: true,
    });
    const docs = (asSuccess(envelope).data as ListVouchersResult).docs;
    for (const doc of docs as VoucherDoc[]) {
      expect(typeof doc.id).toBe('string');
      expect(typeof doc.type).toBe('string');
      expect(typeof doc.number).toBe('string');
      expect(doc.journalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(doc.haveAnnex)).toBe(true);
      expect(doc.entryDtoList.length).toBeGreaterThan(0);
      for (const entry of doc.entryDtoList) {
        expect(typeof entry.summary).toBe('string');
        expect(typeof entry.accountTitleCode).toBe('string');
        expect(typeof entry.debitAmount).toBe('number');
        expect(typeof entry.creditAmount).toBe('number');
      }
    }
  });

  it('非法 cursor(业务层无法解码)→ -32602', async () => {
    const transport = makeTransport({ env: {} });
    const response = await rpc(transport, 22, 'tools/call', {
      name: 'list_vouchers',
      arguments: { accountSetId: 'as_001', period: '202607', cursor: 'not-a-cursor!!' },
    });
    expect((response['error'] as Record<string, unknown>)['code']).toBe(-32602);
  });
});
