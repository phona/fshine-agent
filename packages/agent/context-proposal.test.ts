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
    async findByCodeHash(principalId, sessionId, codeHash) {
      let latest: ChangeIntentRecord | null = null;
      for (const r of rows.values()) {
        if (r.principalId === principalId && r.sessionId === sessionId && r.confirmCodeHash === codeHash) {
          if (!latest || r.createdAt > latest.createdAt) latest = r;
        }
      }
      return latest;
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

/** 提案/确认流的标准装配（模块级：两个 describe 共用）。 */
function setup(opts?: { capabilities?: string[]; prepareOk?: boolean; commitEnabled?: boolean }) {
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
    commitEnabled: opts?.commitEnabled ?? false,
  });
  const testCtx = opts?.capabilities
    ? { trusted: { ...ctx.trusted, capabilities: opts.capabilities } }
    : ctx;
  return { runner, intents, prepareCalls, commitCalls, testCtx };
}

describe('两步确认状态机', () => {
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

  it('落账未启用（默认，如真平台未声明 FSHINE_REAL_COMMIT）：确认 → 确定性拒绝，commitRunner 零调用，意图保持 pending', async () => {
    const { runner, intents, commitCalls, testCtx } = setup();
    const r = await runner.run({ request: '录一张凭证' }, testCtx);
    expect(r.text).toContain('确认 D3F2K9');
    expect(r.text).toContain('落账执行未启用');
    const reply = await runner.matchConfirmation!(testCtx.trusted, '确认 D3F2K9');
    expect(reply?.text).toContain('落账执行未启用');
    expect(reply?.text).toContain('未写入任何数据');
    expect(commitCalls).toHaveLength(0);
    expect([...intents.rows.values()][0]!.status).toBe('pending');
  });

  it('commitEnabled（mock 或显式 FSHINE_REAL_COMMIT=1）：pending 创建 + 确认 → commit → committed', async () => {
    const { runner, intents, prepareCalls, commitCalls, testCtx } = setup({ commitEnabled: true });
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

  it('过期确认码 → 确定性答复（不落模型），意图标记 expired', async () => {
    const { runner, intents, commitCalls, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    const rec = [...intents.rows.values()][0]!;
    rec.expiresAt = new Date(Date.now() - 1000).toISOString();
    const reply = await runner.matchConfirmation!(testCtx.trusted, '确认 D3F2K9');
    expect(reply?.text).toContain('已过期');
    expect(rec.status).toBe('expired');
    expect(commitCalls).toHaveLength(0);
  });

  it('未知确认码 → null 走模型（普通对话不误触）', async () => {
    const { runner, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    expect(await runner.matchConfirmation!(testCtx.trusted, '确认 ZZZ999')).toBeNull();
  });

  it('执行面回执：普通结果尾部拼接系统注脚', async () => {
    const runner = createContextTaskRunner({
      profiles: { '17dz': { root: '/tmp', skillRoots: [] } },
      tasks: noopTasks,
      workerDriver: {
        run: async () => ({ text: '幻晟本期凭证 0 张。', messages: [], footprint: '3/6 次 bin/17dz 调用' }),
      },
    });
    const r = await runner.run({ request: '查凭证' }, ctx);
    expect(r.text.startsWith('幻晟本期凭证 0 张。')).toBe(true);
    expect(r.text).toContain('〔本轮执行面：3/6 次 bin/17dz 调用〕');
  });

  it('提案路径不拼回执（注脚不得污染确认流程文本）', async () => {
    const intents = fakeIntents();
    const runner = createContextTaskRunner({
      profiles: { '17dz': { root: '/tmp', skillRoots: [] } },
      tasks: noopTasks,
      workerDriver: {
        run: async () => ({ text: proposalText, messages: [], footprint: '4/6 次 bin/17dz 调用' }),
      },
      changeIntents: intents.repo,
      prepareRunner: async () => ({ ok: true, output: 'dry-run' }),
      commitRunner: async () => ({ ok: true, output: 'ok' }),
      generateCode: () => 'D3F2K9',
      commitEnabled: true,
    });
    const r = await runner.run({ request: '录一张凭证' }, ctx);
    expect(r.text).toContain('确认 D3F2K9');
    expect(r.text).not.toContain('本轮执行面');
  });

  it('取消码用于已终结提案 → 确定性答复', async () => {
    const { runner, intents, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    const rec = [...intents.rows.values()][0]!;
    rec.status = 'committed';
    const reply = await runner.matchConfirmation!(testCtx.trusted, '取消 D3F2K9');
    expect(reply?.text).toContain('已完成录入');
    expect(rec.status).toBe('committed');
  });
});

/**
 * 任务4（2026-09 第二波）：结构化 outcome 取代回复文本嗅探。
 *
 * 旧实现拿自己刚生成的回复文本 includes 两句中文给日志 outcome 分类——
 *   · 授权名单限制模式的拒绝文本两个关键词都不含 → 误记 proposal_created（日志说谎）；
 *   · 取消一个"已作废"的码 → 回复含"已作废" → 误记 confirm_cancelled（那一轮什么都没发生）。
 * 现在 finalizeProposal / matchConfirmation 直接返回结构化结局，日志从数据里取。
 */
describe('结构化 outcome：日志分类从数据里取，不嗅探回复文本', () => {
  /** 捕获 delegation_span 的 outcome 字段（console.info 的 JSON 行）。 */
  function captureSpans(): { spans: Array<Record<string, unknown>>; restore: () => void } {
    const spans: Array<Record<string, unknown>> = [];
    const original = console.info;
    console.info = (line: string) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed['event'] === 'delegation_span') spans.push(parsed);
      } catch { /* 非 JSON 行忽略 */ }
    };
    return { spans, restore: () => { console.info = original; } };
  }

  it('提案结局三种：declined / precheck_failed / created 各归各位', async () => {
    const declined = captureSpans();
    try {
      const { runner, testCtx } = setup({ capabilities: ['read'] });
      await runner.run({ request: '录一张凭证' }, testCtx);
    } finally { declined.restore(); }
    expect(declined.spans.map((span) => span['outcome'])).toEqual(['proposal_declined']);

    const precheck = captureSpans();
    try {
      const { runner, testCtx } = setup({ prepareOk: false });
      await runner.run({ request: '录一张凭证' }, testCtx);
    } finally { precheck.restore(); }
    expect(precheck.spans.map((span) => span['outcome'])).toEqual(['proposal_precheck_failed']);

    const created = captureSpans();
    try {
      const { runner, testCtx } = setup();
      await runner.run({ request: '录一张凭证' }, testCtx);
    } finally { created.restore(); }
    expect(created.spans.map((span) => span['outcome'])).toEqual(['proposal_created']);
  });

  it('授权名单限制模式同归 proposal_declined（旧实现误记 proposal_created）', async () => {
    const { runner, intents, prepareCalls, testCtx } = setup();
    const allowlistCtx = { trusted: { ...testCtx.trusted, allowedAccountSetIds: ['as_001'] } };
    const capture = captureSpans();
    let text = '';
    try {
      text = (await runner.run({ request: '录一张凭证' }, allowlistCtx)).text;
    } finally { capture.restore(); }
    expect(text).toContain('授权名单限制模式');
    // 结构化 outcome：确定性拒绝，不是"已创建待确认任务"
    expect(capture.spans.map((span) => span['outcome'])).toEqual(['proposal_declined']);
    expect(intents.rows.size).toBe(0);
    expect(prepareCalls).toHaveLength(0);
  });

  it('确认码结局：executed / held / failed / stale 由结构化字段给出', async () => {
    const executed = (await setup({ commitEnabled: true })).runner;
    await executed.run({ request: '录一张凭证' }, ctx);
    expect((await executed.matchConfirmation!(ctx.trusted, '确认 D3F2K9'))?.outcome).toBe('confirm_executed');

    const held = setup().runner;
    await held.run({ request: '录一张凭证' }, ctx);
    expect((await held.matchConfirmation!(ctx.trusted, '确认 D3F2K9'))?.outcome).toBe('confirm_held');

    const cancelled = setup().runner;
    await cancelled.run({ request: '录一张凭证' }, ctx);
    expect((await cancelled.matchConfirmation!(ctx.trusted, '取消 D3F2K9'))?.outcome).toBe('confirm_cancelled');

    const failed = createContextTaskRunner({
      profiles: { '17dz': { root: '/tmp', skillRoots: [] } },
      tasks: noopTasks,
      workerDriver: workerReturning(proposalText),
      changeIntents: fakeIntents().repo,
      prepareRunner: async () => ({ ok: true, output: 'dry-run' }),
      commitRunner: async () => ({ ok: false, output: '', error: '落账拒绝' }),
      generateCode: () => 'D3F2K9',
      commitEnabled: true,
    });
    await failed.run({ request: '录一张凭证' }, ctx);
    expect((await failed.matchConfirmation!(ctx.trusted, '确认 D3F2K9'))?.outcome).toBe('confirm_failed');
  });

  it('取消一个已作废的码 → confirm_stale（旧实现按回复含"已作废"误记 confirm_cancelled）', async () => {
    const { runner, intents, testCtx } = setup();
    await runner.run({ request: '录一张凭证' }, testCtx);
    await runner.matchConfirmation!(testCtx.trusted, '取消 D3F2K9');
    expect([...intents.rows.values()][0]!.status).toBe('cancelled');
    // 第二发取消码：提案早已终结，这一轮没有任何状态变化
    const stale = await runner.matchConfirmation!(testCtx.trusted, '取消 D3F2K9');
    expect(stale?.text).toContain('已作废');
    expect(stale?.outcome).toBe('confirm_stale');
  });
});
