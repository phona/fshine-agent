/**
 * oneOf/anyOf 载荷校验：17dz voucher operation 的 payload.schema 顶层是
 * `{ oneOf: [单对象分支, 数组分支] }`、没有顶层 type——旧 lint 对任何值都放行（空转）。
 *
 * 本套件锁：
 *   A. 正向 8 条（4 个 operation × 单对象/数组两形状）：lint 通过 + 物化逐字一致；
 *   B. 反向 9 条（照干校验同款坏值）：全部被拒，且反馈含「按哪个形状差什么」；
 *   C. anyOf 同义、单分支不回归、嵌套组合子只展开一层（如实登记）。
 *
 * 反向绊线：删除 lintValue 里的 oneOf/anyOf 分派（回到空转）→ B 组 9 条全红。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lintPayload, materializePayload } from './src/payload-materializer';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── 17dz 真实 schema 的形状（忠实截取校验相关关键字；描述文字略去） ──────────────
const ENTRY = {
  type: 'object',
  required: ['summary', 'subjectCode'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1 },
    subjectCode: { type: 'string', minLength: 1 },
    assistantName: { type: 'string', minLength: 1 },
    debit: { type: 'number' },
    credit: { type: 'number' },
  },
};
const VOUCHER_OBJECT = {
  title: 'VoucherContract',
  type: 'object',
  required: ['accountSet', 'entries'],
  additionalProperties: false,
  properties: {
    accountSet: { type: 'string', minLength: 1 },
    date: { type: 'string' },
    template: { type: 'string' },
    voucherNo: { type: 'string' },
    entries: { type: 'array', minItems: 1, items: ENTRY },
  },
};
const VOUCHER_SCHEMA = {
  oneOf: [VOUCHER_OBJECT, { type: 'array', minItems: 1, items: VOUCHER_OBJECT }],
};

const PROPOSAL_OBJECT = {
  title: 'ChangeProposalPayload',
  type: 'object',
  required: ['type', 'domain', 'accountSet', 'period', 'contracts', 'summary'],
  additionalProperties: false,
  properties: {
    type: { const: 'change_proposal' },
    domain: { const: 'voucher' },
    accountSet: { type: 'string', minLength: 1 },
    period: { type: 'string', pattern: '^[0-9]{6}$' },
    contracts: { type: 'array', minItems: 1, maxItems: 50, items: VOUCHER_OBJECT },
    summary: {
      type: 'object',
      required: ['count', 'debit', 'credit'],
      additionalProperties: false,
      properties: { count: { type: 'integer' }, debit: { type: 'number' }, credit: { type: 'number' } },
    },
  },
};
const PROPOSAL_SCHEMA = {
  oneOf: [PROPOSAL_OBJECT, { type: 'array', minItems: 1, items: PROPOSAL_OBJECT }],
};

// ── 正向样本（与干校验同款） ────────────────────────────────────────────────────
const singleVoucher = {
  accountSet: '芳晟',
  date: '2026-11-20',
  voucherNo: '200',
  entries: [
    { summary: '收到货款', subjectCode: '1122', debit: 1000, credit: 0 },
    { summary: '主营业务收入', subjectCode: '6001', debit: 0, credit: 1000 },
  ],
};
const batchVouchers = [singleVoucher, { accountSet: '芳晟', entries: [{ summary: '第二张凭证', subjectCode: '1122', debit: 50, credit: 50 }] }];
const singleProposal = {
  type: 'change_proposal', domain: 'voucher', accountSet: '芳晟', period: '202611',
  contracts: [singleVoucher], summary: { count: 1, debit: 1000, credit: 1000 },
};
const batchProposals = [singleProposal, { ...singleProposal, period: '202612', summary: { count: 1, debit: 50, credit: 50 } }];

function materialize(value: unknown, schema: unknown, label = 'contract') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-oneof-'));
  dirs.push(dir);
  const result = materializePayload({ taskDir: dir, label, value, schema });
  if (!result.ok) return result;
  return { ...result, onDisk: JSON.parse(readFileSync(result.path, 'utf8')) };
}

// ── A. 正向 8 条 ───────────────────────────────────────────────────────────────
describe('A. oneOf 正向：单对象形状 + 数组形状（4 个 operation × 2）', () => {
  const cases: ReadonlyArray<[string, unknown, unknown]> = [
    ['voucher.fill [single]', singleVoucher, VOUCHER_SCHEMA],
    ['voucher.fill [batch]', batchVouchers, VOUCHER_SCHEMA],
    ['voucher.prepare [single]', singleVoucher, VOUCHER_SCHEMA],
    ['voucher.prepare [batch]', batchVouchers, VOUCHER_SCHEMA],
    ['voucher.commit [single]', singleVoucher, VOUCHER_SCHEMA],
    ['voucher.commit [batch]', batchVouchers, VOUCHER_SCHEMA],
    ['voucher.proposal [single]', singleProposal, PROPOSAL_SCHEMA],
    ['voucher.proposal [batch]', batchProposals, PROPOSAL_SCHEMA],
  ];
  for (const [name, value, schema] of cases) {
    it(`${name}: lint 通过、物化逐字一致`, () => {
      expect(lintPayload(value, schema)).toEqual({ missing: [], unknown: [] });
      const mat = materialize(value, schema);
      expect(mat.ok).toBe(true);
      if (!mat.ok) return;
      expect((mat as { onDisk: unknown }).onDisk).toEqual(value);
    });
  }
});

// ── B. 反向 9 条 ───────────────────────────────────────────────────────────────
interface ReverseCase { label: string; value: unknown; schema: unknown; wantShape: string; wantHint: string }

const reverseCases: ReverseCase[] = [
  { label: 'missing accountSet+entries', value: { template: 'x' }, schema: VOUCHER_SCHEMA, wantShape: 'VoucherContract', wantHint: 'accountSet、entries' },
  { label: 'missing entries', value: { accountSet: '芳晟' }, schema: VOUCHER_SCHEMA, wantShape: 'VoucherContract', wantHint: 'entries' },
  { label: 'extra field', value: { ...singleVoucher, bogus: 1 }, schema: VOUCHER_SCHEMA, wantShape: 'VoucherContract', wantHint: 'bogus' },
  { label: 'string-as-array (entries)', value: { accountSet: '芳晟', entries: 'not-an-array' }, schema: VOUCHER_SCHEMA, wantShape: 'VoucherContract', wantHint: 'entries' },
  { label: 'empty entries', value: { accountSet: '芳晟', entries: [] }, schema: VOUCHER_SCHEMA, wantShape: 'VoucherContract', wantHint: 'entries' },
  { label: 'missing contracts', value: { type: 'change_proposal', domain: 'voucher', accountSet: '芳晟', period: '202611', summary: { count: 1, debit: 0, credit: 0 } }, schema: PROPOSAL_SCHEMA, wantShape: 'ChangeProposalPayload', wantHint: 'contracts' },
  { label: 'extra field', value: { ...singleProposal, bogus: 1 }, schema: PROPOSAL_SCHEMA, wantShape: 'ChangeProposalPayload', wantHint: 'bogus' },
  { label: 'string-as-array (contracts)', value: { ...singleProposal, contracts: 'not-an-array' }, schema: PROPOSAL_SCHEMA, wantShape: 'ChangeProposalPayload', wantHint: 'contracts' },
  { label: 'bad period (not 6 digits)', value: { ...singleProposal, period: '2026-11' }, schema: PROPOSAL_SCHEMA, wantShape: 'ChangeProposalPayload', wantHint: 'period' },
];

describe('B. oneOf 反向 9 条：全部被拒且反馈可修复', () => {
  for (const c of reverseCases) {
    it(`REJECT ${c.label}`, () => {
      const lint = lintPayload(c.value, c.schema);
      const rejected = lint.missing.length > 0 || lint.unknown.length > 0;
      expect(rejected, `lint 必须拒绝：${JSON.stringify(lint)}`).toBe(true);
      // 反馈要可修复：指名「按哪个形状」+「差什么」，不许只说「不匹配」。
      const feedback = [...lint.missing, ...lint.unknown].join(' ');
      expect(feedback).toContain(`按${c.wantShape}形状`);
      expect(feedback).toContain(c.wantHint);
      // 物化同样拒绝：不落盘。
      const mat = materialize(c.value, c.schema);
      expect(mat.ok).toBe(false);
    });
  }
});

// ── C. anyOf 同义 / 单分支不回归 / 嵌套克制 ──────────────────────────────────────
describe('C. 组合子边界', () => {
  it('anyOf 与 oneOf 同义：任一分支干净即通过，全不干净才拒', () => {
    const schema = { anyOf: [
      { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } },
      { type: 'array', minItems: 1 },
    ] };
    expect(lintPayload({ a: 'x' }, schema)).toEqual({ missing: [], unknown: [] });
    expect(lintPayload(['x'], schema)).toEqual({ missing: [], unknown: [] });
    const bad = lintPayload({ a: 'x', bogus: 1 }, schema);
    expect(bad.unknown.join(' ')).toContain('按单对象形状多出/写法不对 bogus');
    expect(bad.unknown.join(' ')).toContain('按数组形状多出/写法不对 (root)');
  });

  it('单分支普通对象 schema（dummy.proposal）不回归', () => {
    const dummy = {
      type: 'object',
      required: ['collection', 'window', 'records'],
      additionalProperties: false,
      properties: {
        collection: { type: 'string', minLength: 1 },
        window: { type: 'string', minLength: 1 },
        records: { type: 'array', maxItems: 50, items: {
          type: 'object', required: ['name', 'value'], additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1 }, value: { type: 'number' } },
        } },
      },
    };
    expect(lintPayload({ collection: 'a', window: 'W1', records: [{ name: 'x', value: 1 }] }, dummy))
      .toEqual({ missing: [], unknown: [] });
    expect(lintPayload({ collection: 'a' }, dummy)).toEqual({ missing: ['window', 'records'], unknown: [] });
    expect(lintPayload({ collection: 'a', window: 'W1', records: [], bump: 1 }, dummy))
      .toEqual({ missing: [], unknown: ['bump'] });
  });

  it('嵌套组合子只展开一层（如实登记：更深的组合子不覆盖）', () => {
    // 分支内含 oneOf：内层不被展开，视为无约束 → 该分支放行（不误判为通过之外的裁决）。
    const nested = { oneOf: [
      { oneOf: [{ type: 'object', required: ['x'] }, { type: 'array' }] },
      { type: 'string' },
    ] };
    // 根层两支：第一支（内层组合子被抑制 → 无约束 → 干净）→ 通过。
    expect(lintPayload({ whatever: 1 }, nested)).toEqual({ missing: [], unknown: [] });
  });

  it('非法 pattern 不裁决（窄实现：执行层 schema 权威）', () => {
    expect(lintPayload('anything', { type: 'string', pattern: '[' })).toEqual({ missing: [], unknown: [] });
  });
});
