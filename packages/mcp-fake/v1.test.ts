import { describe, expect, it } from 'vitest';
import { asError, asSuccess, callTool, makeTransport, rpc } from './test-helpers';

const contract = {
  accountSetId: 'as_001',
  date: '2026-07-01',
  entries: [
    { summary: '收款', subjectCode: '1002', debit: 100 },
    { summary: '收入', subjectCode: '6001', credit: 100 },
  ],
};

describe('V1 fake write tools', () => {
  it('write server discovers four V1 tools and read server remains V0 compatible', async () => {
    const read = await rpc(makeTransport({ env: {} }), 1, 'tools/list');
    expect((read.result as { tools: Array<{ name: string }> }).tools).toHaveLength(5);
    const write = await rpc(makeTransport({ env: { FAKE_ENABLE_WRITE: '1' } }), 2, 'tools/list');
    expect((write.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).slice(-4)).toEqual([
      'validate_voucher', 'submit_voucher', 'submit_voucher_batch', 'get_submission_status',
    ]);
  });

  it('validates business rules and dry-run does not consume the idempotency key', async () => {
    const transport = makeTransport({ env: { FAKE_ENABLE_WRITE: '1' } });
    const invalid = await callTool(transport, 1, 'validate_voucher', {
      contract: { ...contract, entries: [{ summary: '坏', subjectCode: '1002' }] },
    });
    expect(asSuccess(invalid.envelope).data).toEqual({ ok: false, errors: ['entries[0]: 借贷不能同时为零'] });
    const dryRun = await callTool(transport, 2, 'submit_voucher', { contract, idempotencyKey: 'k1' });
    expect(asSuccess(dryRun.envelope).data).toMatchObject({ dryRun: true, precheckFlags: [] });
    const status = await callTool(transport, 3, 'get_submission_status', { tool: 'submit_voucher', idempotencyKey: 'k1' });
    expect(asSuccess(status.envelope).data).toEqual({ status: 'not_found', executionState: 'not_started' });
  });

  it('confirmed submit records a bound snapshot and rejects a changed contract', async () => {
    const transport = makeTransport({ env: { FAKE_ENABLE_WRITE: '1' } });
    const first = await callTool(transport, 1, 'submit_voucher', { contract, idempotencyKey: 'k2', confirmed: true });
    expect(asSuccess(first.envelope).data).toMatchObject({ dryRun: false, verified: true });
    const replay = await callTool(transport, 2, 'submit_voucher', { contract, idempotencyKey: 'k2', confirmed: true });
    expect(asSuccess(replay.envelope).data).toEqual(asSuccess(first.envelope).data);
    const conflict = await callTool(transport, 3, 'submit_voucher', {
      contract: { ...contract, template: 'changed' }, idempotencyKey: 'k2', confirmed: true,
    });
    expect(conflict.isError).toBe(true);
    expect(asError(conflict.envelope).error.code).toBe('IDEMPOTENCY_CONFLICT');
    const status = await callTool(transport, 4, 'get_submission_status', { tool: 'submit_voucher', idempotencyKey: 'k2' });
    expect(asSuccess(status.envelope).data).toMatchObject({ status: 'bound', executionState: 'succeeded', boundStep: 'save_click' });
  });

  it('batch dry-run previews each contract and confirmed execution creates child ledgers', async () => {
    const transport = makeTransport({ env: { FAKE_ENABLE_WRITE: '1' } });
    const args = { contracts: [contract, { ...contract, voucherNo: '记-999' }], idempotencyKey: 'batch-1' };
    const dryRun = await callTool(transport, 1, 'submit_voucher_batch', args);
    expect(asSuccess(dryRun.envelope).data).toMatchObject({ dryRun: true, previews: [{ index: 0, ok: true }, { index: 1, ok: true }] });
    const submitted = await callTool(transport, 2, 'submit_voucher_batch', { ...args, confirmed: true });
    expect(asSuccess(submitted.envelope).data).toMatchObject({ dryRun: false, summary: { total: 2, succeeded: 2, failed: 0 } });
    const child = await callTool(transport, 3, 'get_submission_status', { tool: 'submit_voucher', idempotencyKey: 'batch-1:1' });
    expect(asSuccess(child.envelope).data).toMatchObject({ status: 'bound', executionState: 'succeeded', batch: { batchKey: 'batch-1', index: 1, total: 2 } });
  });
});
