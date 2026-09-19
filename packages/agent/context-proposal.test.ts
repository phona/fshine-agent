import { describe, expect, it } from 'vitest';
import {
  createContextTaskRunner,
  extractChangeProposal,
  type ChangeProposal,
  type CommitRequest,
  type CommitResult,
  type PrepareRequest,
  type PrepareResult,
} from './src/context';
import type { ChangeIntentRecord, ChangeIntentRepo, DiscoveredTool, PlatformTaskRepo } from '@fshine/contracts';
import type { TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver';

const proposal: ChangeProposal = {
  type: 'change_proposal',
  domain: 'voucher',
  accountSet: '幻州市幻晟财务代理有限公司',
  period: '202608',
  contracts: [{ voucherDate: '2026-08-31', entries: [] }],
  summary: { count: 1, debit: 100, credit: 100 },
};
const proposalText = `已洗好契约。\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\`\n请确认。`;

const noopTool: DiscoveredTool = { name: 'x', description: '', inputSchema: {} };
const noopTasks: PlatformTaskRepo = { get: async () => null, upsert: async () => {} };
const workerReturning = (text: string): TurnDriver => ({
  run: async (_input: TurnDriverInput): Promise<TurnDriverResult> => ({ text, messages: [] }),
});
const ctx = {
  trusted: {
    requestId: 'req_1',
    principalId: 'wecom:u1',
    allowedAccountSetIds: [] as string[],
    sessionId: 'wecom:u1:c1',
    capabilities: ['read', 'write'] as string[],
  },
};

/** 内存版 ChangeIntentRepo：语义镜像 SQLite 实现（含过期就地置 expired） */
function fakeIntents() {
  const rows = new Map<string, ChangeIntentRecord>();
  const repo: ChangeIntentRepo = {
    async create(r) { rows.set(r.intentId, { ...r }); },
    async get(id) { return rows.get(id) ?? null; },
    async findPendingByConfirm(principalId, sessionId, codeHash, now) {
      for (const r of rows.values()) {
        if (r.principalId !== principalId || r.sessionId !== sessionId) continue;
        if (r.confirmCodeHash !== codeHash || r.status !== 'pending') continue;
        if (new Date(r.expiresAt).getTime() <= now.getTime()) {
          r.status = 'expired';
          return null;
        }
        return r;
      }
      return null;
    },
    async findPendingBySession(principalId, sessionId) {
      for (const r of rows.values()) {
        if (r.principalId === principalId && r.sessionId === sessionId && r.status === 'pending') return r;
      }
      return null;
    },
    async updateStatus(id, status, result) {
      const r = rows.get(id);
      if (r) { r.status = status; r.decidedAt = new Date().toISOString(); if (result !== undefined) r.result = result; }
    },
  };
  return { repo, rows };
}

describe('extractChangeProposal', () => {
  it('从 fenced JSON 提取合法提案', () => {
    expect(extractChangeProposal(proposalText, 50)).toEqual(proposal);
  });
  it('整段纯 JSON 也识别', () => {
    expect(extractChangeProposal(JSON.stringify(proposal), 50)).toEqual(proposal);
  });
  it('type 不符/张数不符/超上限 → null', () => {
    expect(extractChangeProposal('```json\n{"type":"other"}\n```', 50)).toBeNull();
    const bad = { ...proposal, summary: { ...proposal.summary, count: 5 } };
    expect(extractChangeProposal('```json\n' + JSON.stringify(bad) + '\n```', 50)).toBeNull();
    const big = { ...proposal, contracts: Array.from({ length: 51 }, () => ({})) };
    expect(extractChangeProposal('```json\n' + JSON.stringify(big) + '\n```', 50)).toBeNull();
  });
  it('普通回答 → null', () => {
    expect(extractChangeProposal('幻晟本期凭证 0 张。', 50)).toBeNull();
  });
});

describe('两步确认状态机', () => {
  function setup(opts?: { capabilities?: string[]; prepareOk?: boolean; submitEnabled?: boolean }) {
    const intents = fakeIntents();
    const prepareCalls: PrepareRequest[] = [];
    const commitCalls: CommitRequest[] = [];
    const runner = createContextTaskRunner({
      profiles: { '17dz': { root: '/tmp', skillRoots: [] } },
      tasks: noopTasks,
      workerDriver: workerReturning(proposalText),
      changeIntents: intents.repo,
      prepareRunner: async (req: PrepareRequest): Promise<PrepareResult> => {
        prepareCalls.push(req);
        return opts?.prepareOk === false
          ? { ok: false, output: '科目不存在：库存现金2', error: 'precheck fail' }
          : { ok: true, output: 'BATCH {"count":1} mode: dry-run' };
      },
      commitRunner: async (req: CommitRequest): Promise<CommitResult> => {
        commitCalls.push(req);
        return { ok: true, output: '已保存' };
      },
      generateCode: () => 'D3F2K9',
      intentTtlMs: 10 * 60_000,
      maxBatchCount: 50,
      submitEnabled: opts?.submitEnabled ?? false,
    });
    const testCtx = opts?.capabilities
      ? { trusted: { ...ctx.trusted, capabilities: opts.capabilities } }
      : ctx;
    return { runner, intents, prepareCalls, commitCalls, testCtx };
  }

  it('无 write capability → 提案被拒，不创建 intent', async () => {
    const { runner, intents, prepareCalls, testCtx } = setup({ capabilities: ['read'] });
    const r = await runner.run({ request: '录一张凭证' }, testCtx);
    expect(r.text).toContain('未开放写入权限');
    expect(prepareCalls).toHaveLength(0);
    expect(intents.rows.size).toBe(0);
  });

  it('dry-run 失败 → 不创建 intent，回复原因摘要', async () => {
    const { runner, intents, prepareCalls, testCtx } = setup({ prepareOk: false });
    const r = await runner.run({ request: '录一张凭证' }, testCtx);
    expect(r.text).toContain('未通过预检');
    expect(r.text).toContain('precheck fail');
    expect(prepareCalls).toHaveLength(1);
    expect(intents.rows.size).toBe(0);
  });

  it('演练模式（默认）：预览声明不写入；确认 → confirmed_dry，commitRunner 零调用', async () => {
    const { runner, intents, commitCalls, testCtx } = setup();
    const r = await runner.run({ request: '录一张凭证' }, testCtx);
    expect(r.text).toContain('演练模式');
    expect(r.text).toContain('不会写入任何数据');
    expect(r.text).toContain('确认 D3F2K9');
    const reply = await runner.matchConfirmation!(testCtx.trusted, '确认 D3F2K9');
    expect(reply?.text).toContain('演练模式');
    expect(reply?.text).toContain('未写入任何数据');
    expect(commitCalls).toHaveLength(0);
    expect([...intents.rows.values()][0]!.status).toBe('confirmed_dry');
  });

  it('启用 submit：pending 创建 + 确认 → commit → committed', async () => {
    const { runner, intents, prepareCalls, commitCalls, testCtx } = setup({ submitEnabled: true });
    const r = await runner.run({ request: '录一张凭证' }, testCtx);
    expect(r.text).toContain('确认 D3F2K9');
    expect(r.text).toContain('幻州市幻晟财务代理有限公司');
    expect(prepareCalls).toHaveLength(1);
    expect(intents.rows.size).toBe(1);

    // 错误码不触发（返回 null 走正常模型流程）
    expect(await runner.matchConfirmation!(testCtx.trusted, '确认 ZZZ999')).toBeNull();

    // 正确码 → commitRunner 执行（冻结参数）→ committed
    const reply = await runner.matchConfirmation!(testCtx.trusted, '确认 D3F2K9');
    expect(reply?.text).toContain('已完成');
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]?.intentId).toBe([...intents.rows.values()][0]!.intentId);
    expect(commitCalls[0]?.contracts).toEqual(proposal.contracts);
    expect([...intents.rows.values()][0]!.status).toBe('committed');
  });

  it('新提案使旧 pending 作废（superseded）', async () => {
    const { runner, intents, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    const first = [...intents.rows.values()][0]!;
    await runner.run({ request: '改成两张' }, testCtx);
    expect(first.status).toBe('superseded');
    expect(intents.rows.size).toBe(2);
  });

  it('取消码作废 pending', async () => {
    const { runner, intents, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    const reply = await runner.matchConfirmation!(testCtx.trusted, '取消 D3F2K9');
    expect(reply?.text).toContain('已作废');
    expect([...intents.rows.values()][0]!.status).toBe('cancelled');
  });

  it('确认码过期 → null（正常流程），意图标记 expired', async () => {
    const { runner, intents, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    const rec = [...intents.rows.values()][0]!;
    rec.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await runner.matchConfirmation!(testCtx.trusted, '确认 D3F2K9')).toBeNull();
    expect(rec.status).toBe('expired');
  });
});
