/**
 * bizbatch2 三实验装配自测——**零真实模型**（确定性假 driver / 假执行面）。
 *
 * 覆盖：
 *   ① 用例展开与硬上限（缺一不跑）；
 *   ② **工具面门控核实**（缺口 1）：withTaskRunner 注入 runner → 四工具注册；否则仅 run_task
 *      （bizprobe/ask 的 inline 装配路径缺省无 runner → 四工具**不注册**，如实登记）；
 *   ③ 四工具全流程（假件）：run_task/task_status/task_result/task_cancel 各发生一次；取消如实；
 *   ④ 越权=找不到（T03，预置他会话任务）；挂起→接着办（T02，预置 waiting 任务 + resume）；
 *   ⑤ 跑批装配：逐样本工作目录 + 证据落盘 + 判定汇总；
 *   ⑥ 串并行一致性（确定性假件同集两跑）；
 *   ⑦ 缺口 3 装配接线：小 LLM_CONTEXT_WINDOW 经 contextWindowFrom 触发压缩尝试，缺省不触发；
 *   ⑧ infra 门结构（模型钉 step-3.7-flash）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../../../packages/agent/src/driver-contract';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import { contextWindowFrom } from '../../../ask-runtime';
import { expCases, T01, T02, T03, C01 } from './cases';
import { assertWithinExpHardLimits, EXP_HARD_LIMITS, effectiveTurns, expandExpItems, type ExpCase, type ExpItem } from './model';
import { createExpExecutor, type ExpExecutor } from './executor';
import { judgeExp, type ExpEvidence } from './judge';
import { compareExpSerialParallel, runExpBatch, summarizeExp, summarizeSkillArms } from './harness';
import { checkExpInfraGate } from './run';
import type { MetaFile, ReplyLine, TaskRecordJson, ToolCallRecord } from '../../convergence-r1/evidence';

const FIXTURE_ROOT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'), 'scripts', 'eval', 'fixtures', 'dummy-platform');
const FAKE_ENV = { LLM_API_KEY: 'test-placeholder', LLM_MODEL: 'test-model', LLM_API_BASE_URL: 'http://localhost' };

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bizbatch2-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); tmpRoots = []; });

const FACE_MANIFEST: CapabilityManifest = { contractVersion: 1, operations: [{ name: 'dummy.query', label: 'query', args: [] }] };
class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> { return FACE_MANIFEST; }
  async execute(): Promise<ExecutionOutcome> { return { status: 'completed', data: { collection: 'alpha', window: 'W1', count: 2 } }; }
}
function fakeFace() { return { client: new FaceClient(), allowedOperations: ['dummy.query'] }; }

type Exec = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** 脚本化 Main：第 n 次 run 执行第 n 个 step（越界则无工具调用）；工具抛错被吞（与真实 Pi 面一致）。 */
function scriptedMain(steps: Array<(exec: Exec) => Promise<void>>, reply = '已按你的要求处理。'): TurnDriver {
  let turn = 0;
  return {
    async run(input) {
      turn += 1;
      const step = steps[turn - 1];
      if (step !== undefined) {
        const safeExec: Exec = async (tool, args) => {
          try { return await input.exec(tool, args); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
        };
        await step(safeExec);
      }
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

/** 假 Worker：一次结构化只读查询。 */
function workerQuerier(collection = 'alpha', window = 'W1'): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools.find((t) => t.name === 'execute_operation') ?? input.tools[0]!;
      await input.exec(tool.name, { operation: 'dummy.query', args: { collection, window } });
      const reply = '查询完成。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

function executorWith(steps: Array<(exec: Exec) => Promise<void>>, reply?: string, worker: () => TurnDriver = () => workerQuerier()): ExpExecutor {
  return createExpExecutor({
    createDrivers: () => ({ mainDriver: scriptedMain(steps, reply), workerDriver: worker() }),
    createExecutionFace: async () => fakeFace(),
    env: FAKE_ENV,
  });
}

function itemFor(caseDef: ExpCase, trial = 1): ExpItem {
  return { id: `${caseDef.id}#${trial}`, caseId: caseDef.id, kind: caseDef.kind, arm: caseDef.kind === 'skill-arm' ? (caseDef.arm ?? 'none') : null, trial, sessionId: `s-${caseDef.id}-${trial}` };
}

/** 确定性假件证据：按用例期望机械满足（用于串并行一致性/汇总，不触装配）。 */
function satisfyingEvidence(caseDef: ExpCase, item: ExpItem): ExpEvidence {
  const calls: ToolCallRecord[] = (caseDef.toolsMustBeCalled ?? []).map((tool, i) => ({
    turn: 1, agent: 'main', seq: i + 1, tool,
    args: tool === 'run_task' ? { task: 'x' } : tool === 'task_resume' ? { ref: '#1', answer: 'y' } : { ref: '#1' },
    result: { ok: true }, resultSummary: '', startedAt: '2026-01-01T00:00:00Z', elapsedMs: 1,
  }));
  const replies: ReplyLine[] = [{ turn: 1, text: (caseDef.replyMustInclude ?? []).join(' ') || 'ok', sha256: '' }];
  const meta: MetaFile = { turns: [{ index: 1, durationMs: 1, modelCalls: 1, taskIds: [], tokens: { available: false, source: 'fake' }, retries: 0, notes: [] }], driverEvents: [], notes: [] };
  return {
    caseDef,
    inputs: { caseId: item.caseId, trial: item.trial, principalId: 'p', sessionId: item.sessionId, turns: [], configPath: 'c', profileRoot: FIXTURE_ROOT, gateway: 'bin/dummy', dbPath: 'db' },
    toolCalls: calls,
    tasks: [] as TaskRecordJson[],
    replies,
    meta,
    perTurnMainTools: [],
    skillBlockBytes: 0,
    seedTaskNos: {},
    compaction: [],
    sample: { id: item.id, granted: caseDef.granted, executions: [], reply: { claimsCompletion: false } },
  };
}
const fakeExec: ExpExecutor = async (item, caseDef) => satisfyingEvidence(caseDef, item);

/** ~30k token 的转录（4 字符 ≈ 1 token）：越 12k 窗口的阈值，不越 128k 阈值。 */
function longTranscript(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 133; index += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `第 ${index} 段资料：${'x'.repeat(900)}` }], stopReason: 'stop', timestamp: index } as unknown as AgentMessage);
  }
  return messages;
}

describe('① 用例展开与硬上限（缺一不跑）', () => {
  it('展开：id 唯一；compaction 用例的 filler 使回合数显著增多', () => {
    const items = expandExpItems(expCases);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(effectiveTurns(C01).length).toBe(C01.turns.length + (C01.bulkFiller?.repeat ?? 0) + (C01.postFillerTurns?.length ?? 0));
    expect(effectiveTurns(C01).length).toBeGreaterThan(C01.turns.length);
  });

  it('硬上限：会话/并发/调用越界 fail-closed', () => {
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: EXP_HARD_LIMITS.maxSessions + 1, concurrency: 4, maxModelCalls: 72, maxWallMs: 1_800_000 })).toThrow(/会话数/);
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: 9, concurrency: 5, maxModelCalls: 72, maxWallMs: 1_800_000 })).toThrow(/并发/);
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: 9, concurrency: 4, maxModelCalls: 73, maxWallMs: 1_800_000 })).toThrow(/模型调用/);
  });
});

describe('② 工具面门控核实（缺口 1 taskRunner 同源门控）', () => {
  it('withTaskRunner 注入 runner → 四工具注册；无 runner → 仅 run_task', async () => {
    const root = freshRoot();
    const steps = [async (e: Exec) => { await e('run_task', { task: '核对 alpha W1 记录' }); }];
    const exec = executorWith(steps);

    const withRunner = await exec(itemFor(T01), T01, path.join(root, 'a'));
    expect(withRunner.perTurnMainTools[0]).toEqual(['run_task', 'task_status', 'task_result', 'task_cancel', 'task_resume']);

    const bare: ExpCase = { ...T01, id: 'T01bare', withTaskRunner: false };
    const without = await exec(itemFor(bare), bare, path.join(root, 'b'));
    expect(without.perTurnMainTools[0], 'bizprobe/ask inline 路径缺省无 runner → 四工具不注册').toEqual(['run_task']);
  });
});

describe('③ 四工具全流程（假件）', () => {
  it('T01：run_task/task_status/task_result/task_cancel 各发生一次；取消如实（completed→terminal）；判定通过', async () => {
    const root = freshRoot();
    const exec = executorWith([
      async (e) => { await e('run_task', { task: '核对 alpha 集合 W1 的记录' }); },
      async (e) => { await e('task_status', { ref: '#1' }); },
      async (e) => { await e('task_result', { ref: '#1' }); },
      async (e) => { await e('task_cancel', { ref: '#1' }); },
    ]);
    const ev = await exec(itemFor(T01), T01, path.join(root, 't01'));
    const verdict = judgeExp(ev);
    expect(verdict.pass, JSON.stringify(verdict.checks)).toBe(true);
    expect(verdict.counters.taskToolCalls).toBe(3);
    const cancel = ev.toolCalls.find((c) => c.tool === 'task_cancel');
    expect(cancel, 'task_cancel 必须真实发生').toBeDefined();
    expect((cancel!.result as { outcome?: string }).outcome).toBe('terminal');
  });
});

describe('④ 越权=找不到 与 挂起→接着办（预置任务）', () => {
  it('T03：他会话 #1 不可见 → task_status 抛错（不泄露存在性）；判定通过', async () => {
    const root = freshRoot();
    const exec = executorWith([
      async (e) => { await e('run_task', { task: '核对 beta 集合 W1 的记录' }); },
      async (e) => { await e('task_status', { ref: '#1' }); },
    ], undefined, () => workerQuerier('beta', 'W1'));
    const ev = await exec(itemFor(T03), T03, path.join(root, 't03'));
    expect(ev.seedTaskNos.foreign, '预置的他会话任务应占 #1').toBe(1);
    const call = ev.toolCalls.find((c) => c.tool === 'task_status');
    expect(call?.isError, '他会话 #1 必须表现为找不到（抛错）').toBe(true);
    expect(judgeExp(ev).pass, JSON.stringify(judgeExp(ev).checks)).toBe(true);
  });

  it('T02：挂起任务可查（pendingQuestion）→ task_resume 接续 → 落终态', async () => {
    const root = freshRoot();
    const exec = executorWith([
      async (e) => { await e('task_status', {}); },
      async (e) => { await e('task_resume', { ref: '#1', answer: 'contoso-trade W1' }); },
    ], undefined, () => workerQuerier('contoso-trade', 'W1'));
    const ev = await exec(itemFor(T02), T02, path.join(root, 't02'));
    expect(ev.seedTaskNos.waiting, '预置的挂起任务应占 #1').toBe(1);
    expect(ev.toolCalls.some((c) => c.tool === 'task_resume' && c.isError !== true), 'resume 应被受理').toBe(true);
    expect(ev.tasks.some((t) => t.status === 'completed'), 'resume 后应落终态 completed').toBe(true);
    expect(judgeExp(ev).pass, JSON.stringify(judgeExp(ev).checks)).toBe(true);
  });
});

describe('⑤ 跑批装配（batch + collect + judge，假件）', () => {
  it('T01 × N=3：逐样本工作目录 + 证据落盘 + 判定汇总（Wilson）', async () => {
    const root = freshRoot();
    const outRoot = path.join(root, 'out');
    const exec = executorWith([
      async (e) => { await e('run_task', { task: '核对 alpha 集合 W1 的记录' }); },
      async (e) => { await e('task_status', { ref: '#1' }); },
      async (e) => { await e('task_result', { ref: '#1' }); },
      async (e) => { await e('task_cancel', { ref: '#1' }); },
    ]);
    const items = expandExpItems([T01]);
    const report = await runExpBatch({ kind: 'task-surface', cases: [T01], items, executor: exec, outRoot, concurrency: 4 });
    expect(report.samples).toHaveLength(3);
    expect(report.samples.every((s) => s.verdict?.pass === true)).toBe(true);
    expect(existsSync(path.join(outRoot, 'work', 'T01#1'))).toBe(true);
    expect(existsSync(path.join(outRoot, 'T01', '1', 'verdict.json'))).toBe(true);
    const summary = summarizeExp(report);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.n).toBe(3);
    expect(summary[0]!.pass).toBe(3);
  });
});

describe('⑥ 串并行一致性（确定性假件）', () => {
  it('串行与并行逐样本判定读数一致', async () => {
    const root = freshRoot();
    const cases = [T01, C01, ...expCases.filter((c) => c.kind === 'skill-arm')];
    const items = expandExpItems(cases);
    const cmp = await compareExpSerialParallel({ kind: 'task-surface', cases, items, executor: fakeExec, outRoot: path.join(root, 'sp'), concurrency: 4 });
    expect(cmp.consistent).toBe(true);
    expect(cmp.differences).toEqual([]);
    expect(cmp.serial.observedMaxConcurrency).toBe(1);
    expect(cmp.parallel.observedMaxConcurrency).toBe(4);
  });
});

describe('⑦ 缺口 3 装配接线（确定性）', () => {
  it('小 LLM_CONTEXT_WINDOW 经 contextWindowFrom 触发压缩尝试；缺省 128k 不触发', async () => {
    const messages = longTranscript();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
    try {
      const baseEnv = { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'k', LLM_MODEL: 'step-3.7-flash' };
      const fallback = createPiTurnDriver({ env: baseEnv, ...contextWindowFrom(baseEnv) });
      const out = await fallback.compact!(messages);
      expect(out, '缺省 128k：阈值未到，原样返回').toBe(messages);
      expect(warns, '缺省不应触发压缩尝试').toEqual([]);

      const smallEnv = { ...baseEnv, LLM_CONTEXT_WINDOW: '12000' };
      const capped = createPiTurnDriver({ env: smallEnv, ...contextWindowFrom(smallEnv) });
      await capped.compact!(messages);
      expect(warns.some((l) => l.includes('context_compact_failed')), '12k 窗口应触发压缩尝试').toBe(true);

      expect(contextWindowFrom(smallEnv)).toEqual({ contextWindow: 12000 });
      expect(contextWindowFrom(baseEnv)).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });
});

describe('⑧ Skill 臂汇总与 infra 门', () => {
  it('skill 三臂配对分组 + 逐用例 k/N', async () => {
    const root = freshRoot();
    const arms = expCases.filter((c) => c.kind === 'skill-arm');
    const items = expandExpItems(arms);
    const report = await runExpBatch({ kind: 'skill-arm', cases: arms, items, executor: fakeExec, outRoot: path.join(root, 'sa'), concurrency: 4 });
    const rows = summarizeSkillArms(report);
    expect(rows.find((r) => r.base === 'S-digest' && r.arm === 'inline')?.n).toBe(3);
    expect(rows.find((r) => r.base === 'S-note' && r.arm === 'catalog')?.n).toBe(3);
    expect(summarizeExp(report)).toHaveLength(6);
  });

  it('infra 门返回逐项检查与 blocking 布尔（模型钉 step-3.7-flash）', () => {
    const gate = checkExpInfraGate();
    expect(typeof gate.blocking).toBe('boolean');
    expect(gate.expectedModel).toBe('step-3.7-flash');
    expect(gate.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      '.env 存在（gitignored）', 'LLM_API_KEY 非空', 'LLM_MODEL 解析', 'LLM_MODEL === step-3.7-flash',
    ]));
  });
});
