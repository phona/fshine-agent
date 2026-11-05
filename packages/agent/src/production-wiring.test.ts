/**
 * 第 2 包生产接线证明（接口文档 §5 / §11）。
 *
 * 钉住的三条接线，缺一不可，且全部 fail-closed：
 *   · 提案复核：生产装配注入的复核驱动缺失时，提案创建直接失败、不发确认码
 *     （`proposal_review_skipped` 事件已删除，不存在“记一条日志就继续”）；
 *     schema 缺失/非法时同样失败，不降级为只比摘要；复核不一致时不发码；
 *     只有 schema 真实下发 + 复核一致才走确认流程。
 *   · 提案 schema：平台 `operation list --json` 的 proposal.create 行下发，
 *     宿主只做“非空普通对象”的形状检查，原样透传给隔离复核，不解析业务字段。
 *   · 步数帽：驱动每次放行后把自己的 gateCalls 喂给生产跟踪器
 *     （`createStepCapWindDown`），50 次 → 0 次 steer、51 次 → 恰 1 次、
 *     52 次 → 仍 1 次。51 轮真模型会话不在脚本化范围内，故本证明验的是
 *     驱动里实际调用的那段生产代码（跟踪器），不是它的复写；活会话里
 *     51 次放行才送 steer 的完整链路仍待一次真模型长任务复核。
 *   · 交接文件：真实 context runner 的续跑先读交接文件再委派；
 *     第二轮的调用与首轮去重合并、不重复计数；文件损坏时 Main 按异常码
 *     分级恢复（接口文档 §11）：损坏内容一律丢弃、只凭转录重建，转录在场
 *     就继续，不推给人工；损坏且转录也无时才进入人工介入（needs），不调
 *     worker、不发确认码、不重复提交。
 *
 * 全部用脚本化驱动 + 通用 dummy 平台，不碰真模型、不碰真平台。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeIntentRecord, ChangeIntentRepo, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { createContextTaskRunner } from './context';
import type { ProposalReviewTurn } from './proposal-review';
import type { TurnDriver, TurnDriverResult } from './driver';
import { loadProposalSchema, parseProposalSchema } from './operation-labels';
import { createStepCapWindDown } from './worker-step-cap';
import { handoverFilePath, readHandoverFile } from './task-handover';
import { mechanicalReview, reviewProposalWithDriver } from './proposal-review';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
  async listBySession(principalId: string, sessionId: string) {
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function fakeIntents() {
  const rows = new Map<string, ChangeIntentRecord>();
  const repo: ChangeIntentRepo = {
    async create(r) { rows.set(r.intentId, { ...r }); },
    async get(id) { return rows.get(id) ?? null; },
    async findPendingByConfirm(principalId, sessionId, codeHash, now) {
      for (const r of rows.values()) {
        if (r.principalId !== principalId || r.sessionId !== sessionId) continue;
        if (r.confirmCodeHash !== codeHash || r.status !== 'pending') continue;
        if (new Date(r.expiresAt).getTime() <= now.getTime()) { r.status = 'expired'; return null; }
        return r;
      }
      return null;
    },
    async findPendingBySession(principalId, sessionId, taskId) {
      for (const r of rows.values()) {
        if (r.principalId !== principalId || r.sessionId !== sessionId || r.status !== 'pending') continue;
        if (taskId !== undefined && r.taskId !== taskId) continue;
        return r;
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

function trusted(): TrustedContext {
  return { requestId: 'req-p2', principalId: 'wecom:u1', sessionId: 'wecom:u1:c1' };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-p2-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
  return root;
}

const COMPLETED_ENVELOPE = `RESULT ${JSON.stringify({ v: 1, op: 'voucher.proposal', status: 'completed', data: {
  proposalId: 'prop_abc123',
  summaryText: '待确认提案 prop_abc123：共 2 条，借方合计 1,500.00，贷方合计 1,500.00。',
  expiresAt: '2026-10-12T02:30:00.000Z',
  status: 'pending',
}, error: null })}\n`;

/** 捕获宿主注入的 onCreateProposal 的替身 worker 驱动，直接调到提案创建路径。 */
function setupProposal(options: {
  proposalReviewTurn?: ProposalReviewTurn;
  proposalSchemaLoader?: (args: { platformRoot: string; gateway?: string }) => Promise<unknown | null>;
}) {
  const intents = fakeIntents();
  const tasks = new MemoryTasks();
  const calls: Array<{ platformRoot: string; args: string[] }> = [];
  let captured: Parameters<Parameters<typeof createContextTaskRunner>[0]['workerDriver']['run']>[0]['onCreateProposal'];
  const workerDriver: TurnDriver = {
    run: async (input) => {
      captured = input.onCreateProposal;
      return { text: 'worker 终稿', messages: [] };
    },
  };
  const taskRunner = createContextTaskRunner({
    profiles: { generic: { root: '/tmp', skillRoots: [] } },
    tasks,
    workerDriver,
    changeIntents: intents.repo,
    proposalGatewayRunner: async ({ platformRoot, args }) => {
      calls.push({ platformRoot, args });
      return { code: 0, stdout: COMPLETED_ENVELOPE, stderr: '' };
    },
    writeEnabled: true,
    generateCode: () => 'D3F2K9',
    intentTtlMs: 10 * 60_000,
    ...(options.proposalReviewTurn ? { proposalReviewTurn: options.proposalReviewTurn } : {}),
    ...(options.proposalSchemaLoader ? { proposalSchemaLoader: options.proposalSchemaLoader } : {}),
  });
  return {
    rows: intents.rows,
    calls,
    invoke: async () => {
      await taskRunner.run({ request: '录入两笔往来款' }, { trusted: trusted() });
      if (!captured) return null;
      return captured({ operation: 'voucher.proposal', payloadPath: 'tmp/req_1/proposal.json' });
    },
  };
}

const consistentReview: ProposalReviewTurn = async () => ({ verdict: 'consistent', fields: [] });
const inconsistentReview: ProposalReviewTurn = async () => ({ verdict: 'inconsistent', fields: ['summaryText'] });
const dummySchema = { $id: 'ChangeProposalPayload', type: 'object' };

describe('生产接线 · 提案 schema 下发（§5）', () => {
  it('通用 dummy 平台的 operation list 下发 proposal.create 行的真实 schema，其他行不带', async () => {
    const fixtureRoot = path.join(process.cwd(), 'scripts', 'eval', 'fixtures', 'dummy-platform');
    const schema = await loadProposalSchema(fixtureRoot, 'bin/generic');
    expect(schema).toMatchObject({ $id: 'ChangeProposalPayload' });
  });

  it('parseProposalSchema：无 proposal.create 行 / schema 非对象时一律 null，调用方据此 fail-closed', () => {
    const noProposalRow = JSON.stringify({ operations: [{ name: 'dummy.query', protocol: null }] });
    expect(parseProposalSchema(noProposalRow)).toBeNull();
    const illegalSchema = JSON.stringify({ operations: [{ name: 'dummy.proposal', protocol: 'proposal.create', proposalSchema: 'not-an-object' }] });
    expect(parseProposalSchema(illegalSchema)).toBeNull();
    const arraySchema = JSON.stringify({ operations: [{ name: 'dummy.proposal', protocol: 'proposal.create', proposalSchema: [] }] });
    expect(parseProposalSchema(arraySchema)).toBeNull();
    const ok = JSON.stringify({ operations: [{ name: 'dummy.proposal', protocol: 'proposal.create', proposalSchema: dummySchema }] });
    expect(parseProposalSchema(ok)).toEqual(dummySchema);
  });

  it('mechanicalReview：schema 缺失/非法即不一致，不存在无 schema 复核', () => {
    const envelope = { status: 'completed', data: {}, error: null };
    expect(mechanicalReview({ proposalSchema: null, dryRunEnvelope: envelope, summaryText: '摘要' })?.verdict).toBe('inconsistent');
    expect(mechanicalReview({ proposalSchema: 'x', dryRunEnvelope: envelope, summaryText: '摘要' })?.verdict).toBe('inconsistent');
    expect(mechanicalReview({ proposalSchema: dummySchema, dryRunEnvelope: envelope, summaryText: '摘要' })).toBeNull();
  });

  it('reviewProposalWithDriver：隔离回合（无工具）返回一致时通过，驱动抛错时阻塞', async () => {
    const scripted: TurnDriver = {
      run: async () => ({ text: '{"verdict":"consistent","fields":[]}', messages: [] }),
    };
    const verdict = await reviewProposalWithDriver(scripted, {
      proposalSchema: dummySchema,
      dryRunEnvelope: { status: 'completed', data: {}, error: null },
      summaryText: '摘要',
    });
    expect(verdict.verdict).toBe('consistent');
    const throwing: TurnDriver = {
      run: async () => { throw new Error('driver down'); },
    };
    const blocked = await reviewProposalWithDriver(throwing, {
      proposalSchema: dummySchema,
      dryRunEnvelope: { status: 'completed', data: {}, error: null },
      summaryText: '摘要',
    });
    expect(blocked.verdict).toBe('inconsistent');
  });
});

describe('生产接线 · 提案创建复核 fail-closed（§11）', () => {
  it('未注入复核驱动：平台已办调，但不落意图、不发确认码，直接失败', async () => {
    const host = setupProposal({ proposalSchemaLoader: async () => dummySchema });
    const outcome = await host.invoke();
    expect(outcome?.status).toBe('failed');
    expect(outcome && 'workerText' in outcome ? outcome.workerText : '').toContain('未接线');
    expect(host.calls).toHaveLength(1);
    expect(host.rows.size).toBe(0);
  });

  it('schema 取问返回 null：不降级为只比摘要，直接失败、不落意图', async () => {
    const host = setupProposal({ proposalReviewTurn: consistentReview, proposalSchemaLoader: async () => null });
    const outcome = await host.invoke();
    expect(outcome?.status).toBe('failed');
    expect(host.rows.size).toBe(0);
  });

  it('复核不一致：不发确认码、不落意图；复核一致 + 真实 schema：才完成并给用户确认码', async () => {
    const bad = setupProposal({ proposalReviewTurn: inconsistentReview, proposalSchemaLoader: async () => dummySchema });
    const badOutcome = await bad.invoke();
    expect(badOutcome?.status).toBe('failed');
    expect(bad.rows.size).toBe(0);

    const good = setupProposal({ proposalReviewTurn: consistentReview, proposalSchemaLoader: async () => dummySchema });
    const goodOutcome = await good.invoke();
    expect(goodOutcome?.status).toBe('completed');
    expect(good.rows.size).toBe(1);
    if (!goodOutcome || goodOutcome.status !== 'completed') throw new Error('expected completed');
    expect(goodOutcome.proposalId).toBe('prop_abc123');
    expect(goodOutcome.userText).toContain('D3F2K9');
    expect(goodOutcome.workerText).not.toContain('D3F2K9');
  });
});

describe('生产接线 · 步数帽（真实驱动调用的生产跟踪器）', () => {
  it('50 次放行 → 0 次 steer；51 次 → 恰 1 次；52 次 → 仍 1 次', () => {
    let steers = 0;
    const fire = createStepCapWindDown(50, () => { steers += 1; });
    for (let i = 1; i <= 50; i += 1) fire(i);
    expect(steers).toBe(0);
    fire(51);
    expect(steers).toBe(1);
    fire(52);
    fire(100);
    expect(steers).toBe(1);
  });
});

describe('生产接线 · 交接文件真实续跑', () => {
  function queueDriver(results: TurnDriverResult[]): TurnDriver {
    return {
      run: async (input) => {
        const next = results.shift() ?? { text: '', messages: [] };
        return { ...next, messages: [...input.messages, ...(next.messages ?? [])] };
      },
    };
  }

  function runner(root: string, tasks: MemoryTasks, driver: TurnDriver) {
    return createContextTaskRunner({
      profiles: { generic: { root, skillRoots: ['.agents/skills'] } },
      tasks,
      workerDriver: driver,
    });
  }

  function turnResult(text: string, calls: Array<{ operation: string; args: string[] }>): TurnDriverResult {
    return {
      text,
      messages: [
        { role: 'user', content: '查询', timestamp: Date.now() },
        { role: 'assistant', content: text, timestamp: Date.now() },
      ] as never,
      planFacts: { calls: calls as never },
    };
  }

  it('首轮写交接、续跑先读并去重合并：同一调用不重复计数', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const first = runner(root, tasks, queueDriver([turnResult('第一轮', [{ operation: 'dummy.query', args: ['a'] }])]));
    const pending = await first.run({ request: '查询 a' }, { trusted: trusted() });
    const firstHandover = readHandoverFile(root, pending.taskId);
    expect(firstHandover?.executedCalls).toHaveLength(1);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    try {
      const resumed = runner(root, tasks, queueDriver([
        turnResult('第二轮', [{ operation: 'dummy.query', args: ['a'] }, { operation: 'dummy.query', args: ['b'] }]),
      ]));
      const done = await resumed.run({ taskId: pending.taskId, request: '继续查询' }, { trusted: trusted() });
      expect(done.taskId).toBe(pending.taskId);
      const merged = readHandoverFile(root, pending.taskId);
      expect(merged?.executedCalls).toHaveLength(2);
      expect(merged?.executedCalls.map((c) => c.args.join(','))).toEqual(['a', 'b']);
      expect(logs.some((line) => line.includes('task_handover_resumed'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('交接文件损坏：记 task_handover_corrupt、损坏的调用一律不合并，转录在场时自动恢复继续', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const first = runner(root, tasks, queueDriver([turnResult('第一轮', [{ operation: 'dummy.query', args: ['a'] }])]));
    const pending = await first.run({ request: '查询 a' }, { trusted: trusted() });
    expect(existsSync(handoverFilePath(root, pending.taskId))).toBe(true);
    writeFileSync(handoverFilePath(root, pending.taskId), '{broken json');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    try {
      const resumed = runner(root, tasks, queueDriver([
        turnResult('第二轮', [{ operation: 'dummy.query', args: ['b'] }]),
      ]));
      const done = await resumed.run({ taskId: pending.taskId, request: '继续查询' }, { trusted: trusted() });
      expect(done.text).toContain('第二轮');
      expect(done.needs).toBeUndefined();
      expect(logs.some((line) => line.includes('task_handover_corrupt') && line.includes('handover_corrupt_json'))).toBe(true);
      expect(logs.some((line) => line.includes('task_handover_recovered') && line.includes('transcript_rebuilt'))).toBe(true);
      expect(logs.some((line) => line.includes('task_handover_blocked'))).toBe(false);
      const after = readHandoverFile(root, pending.taskId);
      expect(after?.executedCalls.map((c) => c.args.join(','))).toEqual(['b']);
    } finally {
      spy.mockRestore();
    }
  });

  it('交接版本不符与形状非法：同样按损坏码丢弃重建，不推给人工', async () => {
    for (const broken of [
      JSON.stringify({ version: 99, taskId: 'x', completedSteps: [], executedCalls: [], unfinishedSteps: [], nextAction: '', lastResultSummary: '' }),
      JSON.stringify({ version: 1, taskId: 'x', completedSteps: [], executedCalls: 'not-an-array', unfinishedSteps: [], nextAction: '', lastResultSummary: '' }),
    ]) {
      const root = await profileRoot();
      const tasks = new MemoryTasks();
      const first = runner(root, tasks, queueDriver([turnResult('第一轮', [{ operation: 'dummy.query', args: ['a'] }])]));
      const pending = await first.run({ request: '查询 a' }, { trusted: trusted() });
      writeFileSync(handoverFilePath(root, pending.taskId), broken);
      const resumed = runner(root, tasks, queueDriver([
        turnResult('第二轮', [{ operation: 'dummy.query', args: ['b'] }]),
      ]));
      const done = await resumed.run({ taskId: pending.taskId, request: '继续查询' }, { trusted: trusted() });
      expect(done.text).toContain('第二轮');
      expect(done.needs).toBeUndefined();
    }
  });

  it('交接损坏且转录也缺失：进入人工介入，不调 worker、不发确认码、不重复提交', async () => {
    const root = await profileRoot();
    const tasks = new MemoryTasks();
    const taskId = 'task_blocked';
    await tasks.upsert({
      taskId, parentSessionId: 'wecom:u1:c1', principalId: 'wecom:u1',
      workerMessages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as PlatformTaskRecord);
    await mkdir(path.dirname(handoverFilePath(root, taskId)), { recursive: true });
    writeFileSync(handoverFilePath(root, taskId), '{broken json');
    let workerCalls = 0;
    const driver: TurnDriver = { run: async () => { workerCalls += 1; return { text: '不应执行', messages: [] }; } };
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { logs.push(String(args[0])); });
    try {
      const resumed = runner(root, tasks, driver);
      const done = await resumed.run({ taskId, request: '继续查询' }, { trusted: trusted() });
      expect(workerCalls).toBe(0);
      expect(done.needs).toBeDefined();
      expect(done.needs?.missing).toContain('转录消息');
      expect(done.text).toContain('人工');
      expect(done.proposalCreated).toBeUndefined();
      expect(done.execution).toBeUndefined();
      expect(logs.some((line) => line.includes('task_handover_blocked'))).toBe(true);
      // 任务条目原样不动，供人工核对。
      const kept = await tasks.get(taskId);
      expect(kept?.workerMessages).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
