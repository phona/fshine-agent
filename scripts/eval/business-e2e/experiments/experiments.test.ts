/**
 * bizbatch3/bizbatch2 实验装配自测——**零真实模型**（确定性假 driver / 假执行面）。
 *
 * 覆盖：
 *   ① 用例展开与硬上限（缺一不跑）；
 *   ② **工具面门控核实**（缺口 1）：withTaskRunner 注入 runner → 四工具注册；否则仅 task_run
 *      （bizprobe/ask 的 inline 装配路径缺省无 runner → 四工具**不注册**，如实登记）；
 *   ③ 四工具全流程（假件）：task_run/task_status/task_result/task_cancel 各发生一次；取消如实；
 *   ④ 越权=找不到（T03，预置他会话任务）；挂起→接着办（T02，预置 waiting 任务 + resume）；
 *   ⑤ 跑批装配：逐样本工作目录 + 证据落盘 + 判定汇总；
 *   ⑥ 串并行一致性（确定性假件同集两跑）；
 *   ⑦ 缺口 3 装配接线：小 LLM_CONTEXT_WINDOW 经 contextWindowFrom 触发压缩尝试，缺省不触发；
 *   ⑧ infra 门结构（模型钉 step-3.7-flash）+ 两态（可得=不阻塞 / 缺失=blocking）；
 *   ⑨ **#7 重设计**：自然语料体量下界 + **压缩触发可被机械捕获**（驱动事件经 ALS 归属样本）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../../../packages/agent/src/driver-contract';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateContextTokens } from '../../token-estimate';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import { contextWindowFrom } from '../../../ask-runtime';
import { expCases, T01, T02, T03, C03, C04, digestArm } from './cases';
import { NATURAL_CORPUS, RECOVERY_PROBES } from './natural-corpus';
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
function fakeFace() { return { client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] }; }

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
    args: tool === 'task_run' ? { task: 'x' } : tool === 'task_resume' ? { ref: '#1', answer: 'y' } : { ref: '#1' },
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
  it('展开：id 唯一；compaction 用例的自然语料使回合数显著增多', () => {
    const items = expandExpItems(expCases);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(effectiveTurns(C03).length).toBe(C03.turns.length + (C03.postFillerTurns?.length ?? 0));
    expect(effectiveTurns(C03).length).toBeGreaterThan(C03.turns.length);
  });

  it('硬上限：会话/并发/调用越界 fail-closed', () => {
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: EXP_HARD_LIMITS.maxSessions + 1, concurrency: 4, maxModelCalls: 72, maxWallMs: 1_800_000 })).toThrow(/会话数/);
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: 9, concurrency: 5, maxModelCalls: 72, maxWallMs: 1_800_000 })).toThrow(/并发/);
    expect(() => assertWithinExpHardLimits({ kind: 'task-surface', sessions: 9, concurrency: 4, maxModelCalls: 73, maxWallMs: 1_800_000 })).toThrow(/模型调用/);
  });
});

describe('② 工具面门控核实（缺口 1：只读查询始终注册，治理工具随 taskRunner）', () => {
  it('withTaskRunner 注入 runner → 四工具注册；无 runner → 只读查询注册、治理工具不注册', async () => {    const root = freshRoot();
    const steps = [async (e: Exec) => { await e('task_run', { task: '核对 alpha W1 记录' }); }];
    const exec = executorWith(steps);
    // 本用例只验 runner 门控。Main 技能 catalog 是正交变量：S3 往 `.agents/skills` 加了
    // 生产技能后，缺省目录会多出 read_skill——用空索引臂隔离，避免断言随技能内容漂移。
    const skillsNone = path.join(FIXTURE_ROOT, '.agents', 'skills-none');
    const isolated: ExpCase = { ...T01, mainSkillsDir: skillsNone };

    const withRunner = await exec(itemFor(isolated), isolated, path.join(root, 'a'));
    expect(withRunner.perTurnMainTools[0]).toEqual(['task_run', 'task_status', 'task_result', 'task_cancel', 'task_resume']);

    const bare: ExpCase = { ...isolated, id: 'T01bare', withTaskRunner: false };
    const without = await exec(itemFor(bare), bare, path.join(root, 'b'));
    expect(without.perTurnMainTools[0], 'bizprobe/ask inline 路径无 runner → 只读查询仍注册、治理工具不注册')
      .toEqual(['task_run', 'task_status', 'task_result']);  });

  /**
   * 回归（S5 合并暴露）：`read_skill` 属**技能面**，只由 catalog 非空决定；taskRunner 门控只管
   * 四件任务工具。四格矩阵逐格断言，防止再次出现「把空索引臂的执行结果与非隔离期望混在一行」
   * 的装配/断言错配（`execution-runtime.ts` 的 Main 工具面里两个门控互相独立）。
   */
  it('read_skill 只由 catalog 决定：有/无 runner 各有技能面；空目录两者都没有', async () => {
    const root = freshRoot();
    const exec = executorWith([async () => {}]);
    const skillsMain = path.join(FIXTURE_ROOT, '.agents', 'skills-main'); // 夹具 catalog（两技能）
    const skillsNone = path.join(FIXTURE_ROOT, '.agents', 'skills-none'); // 故意不存在 = 空索引
    const taskTools = ['task_status', 'task_result', 'task_cancel', 'task_resume'];
    const queryTools = ['task_status', 'task_result'];
    const cells: ReadonlyArray<{ label: string; withTaskRunner: boolean; mainSkillsDir: string; expected: string[]; catalog: boolean }> = [
      { label: 'runner＋catalog', withTaskRunner: true, mainSkillsDir: skillsMain, expected: ['task_run', ...taskTools, 'read_skill'], catalog: true },
      { label: 'runner＋空目录', withTaskRunner: true, mainSkillsDir: skillsNone, expected: ['task_run', ...taskTools], catalog: false },
      { label: '无 runner＋catalog', withTaskRunner: false, mainSkillsDir: skillsMain, expected: ['task_run', ...queryTools, 'read_skill'], catalog: true },
      { label: '无 runner＋空目录', withTaskRunner: false, mainSkillsDir: skillsNone, expected: ['task_run', ...queryTools], catalog: false },    ];
    for (const cell of cells) {
      const def: ExpCase = { ...T01, id: `gate-${cell.label}`, withTaskRunner: cell.withTaskRunner, mainSkillsDir: cell.mainSkillsDir };
      const ev = await exec(itemFor(def), def, path.join(root, cell.label.replace(/[^\w-]/g, '_')));
      expect(ev.perTurnMainTools[0], `${cell.label}：工具面`).toEqual(cell.expected);
      expect(ev.skillBlockBytes > 0, `${cell.label}：catalog 字节数为 0 与非空判定一致`).toBe(cell.catalog);
    }
  });
});

describe('③ 四工具全流程（假件）', () => {
  it('T01：task_run/task_status/task_result/task_cancel 各发生一次；取消如实（completed→terminal）；判定通过', async () => {
    const root = freshRoot();
    const exec = executorWith([
      async (e) => { await e('task_run', { task: '核对 alpha 集合 W1 的记录' }); },
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
      async (e) => { await e('task_run', { task: '核对 beta 集合 W1 的记录' }); },
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
      async (e) => { await e('task_run', { task: '核对 alpha 集合 W1 的记录' }); },
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
    const cases = [T01, C03, ...expCases.filter((c) => c.kind === 'skill-arm')];
    const items = expandExpItems(cases);
    const cmp = await compareExpSerialParallel({ kind: 'task-surface', cases, items, executor: fakeExec, outRoot: path.join(root, 'sp'), concurrency: 4 });
    expect(cmp.consistent).toBe(true);
    expect(cmp.differences).toEqual([]);
    expect(cmp.serial.observedMaxConcurrency).toBe(1);
    expect(cmp.parallel.observedMaxConcurrency).toBe(4);
  });
});

describe('⑧ Skill 臂汇总与 infra 门', () => {
  it('Skill 两臂装配：none 空索引无技能块/无 read_skill；catalog 注入清单 + 暴露 read_skill', async () => {
    const root = freshRoot();
    const prompts: Record<string, string> = {};
    const toolNames: Record<string, readonly string[]> = {};
    const catalogBytes: Record<string, number> = {};
    const captureMain = (label: string): TurnDriver => ({
      async run(input) {
        prompts[label] = input.systemPrompt;
        toolNames[label] = input.tools.map((t) => t.name);
        return { text: 'ok', messages: [...input.messages, { role: 'assistant', content: 'ok' } as never] };
      },
    });
    for (const arm of ['none', 'catalog'] as const) {
      const caseDef = digestArm(arm);
      const exec = createExpExecutor({
        createDrivers: () => ({ mainDriver: captureMain(arm), workerDriver: workerQuerier() }),
        createExecutionFace: async () => fakeFace(),
        env: FAKE_ENV,
      });
      const evidence = await exec(itemFor(caseDef), caseDef, path.join(root, arm));
      catalogBytes[arm] = evidence.skillBlockBytes;
    }
    expect(prompts.none).not.toContain('【可用技能');
    expect(prompts.none).not.toContain('record-digest');
    expect(toolNames.none).not.toContain('read_skill');
    expect(catalogBytes.none).toBe(0);
    expect(prompts.catalog).toContain('record-digest');
    expect(prompts.catalog).toContain('value-note');
    // 清单只含 name+description：正文标记与绝对路径都不得进提示。
    expect(prompts.catalog).not.toContain('核对摘要');
    expect(prompts.catalog).not.toContain(FIXTURE_ROOT);
    expect(toolNames.catalog).toContain('read_skill');
    expect(catalogBytes.catalog).toBeGreaterThan(0);
  });

  it('skill 两臂配对分组 + 逐用例 k/N', async () => {
    const root = freshRoot();
    const arms = expCases.filter((c) => c.kind === 'skill-arm');
    const items = expandExpItems(arms);
    const report = await runExpBatch({ kind: 'skill-arm', cases: arms, items, executor: fakeExec, outRoot: path.join(root, 'sa'), concurrency: 4 });
    const rows = summarizeSkillArms(report);
    expect(rows.find((r) => r.base === 'S-digest' && r.arm === 'none')?.n).toBe(3);
    expect(rows.find((r) => r.base === 'S-note' && r.arm === 'catalog')?.n).toBe(3);
    expect(rows.every((r) => r.arm !== 'inline')).toBe(true);
    expect(summarizeExp(report)).toHaveLength(4);
  });

  it('infra 门返回逐项检查与 blocking 布尔（模型钉 step-3.7-flash）', () => {
    const gate = checkExpInfraGate();
    expect(typeof gate.blocking).toBe('boolean');
    expect(gate.expectedModel).toBe('step-3.7-flash');
    expect(gate.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      '.env 存在（gitignored）', 'LLM_API_KEY 非空', 'LLM_MODEL 解析', 'LLM_MODEL === step-3.7-flash',
    ]));
  });

  it('infra 门两态：blocking = 任一检查失败；模型不符即阻塞（不烧样本）', () => {
    const saved = process.env['LLM_MODEL'];
    try {
      process.env['LLM_MODEL'] = 'step-5-preview';
      const wrong = checkExpInfraGate();
      expect(wrong.blocking).toBe(true);
      expect(wrong.checks.find((c) => c.name.includes('LLM_MODEL === step-3.7-flash'))?.ok, '模型不符该检查项必须失败').toBe(false);

      process.env['LLM_MODEL'] = 'step-3.7-flash';
      const right = checkExpInfraGate();
      expect(right.checks.find((c) => c.name.includes('LLM_MODEL === step-3.7-flash'))?.ok).toBe(true);
      // blocking 与「是否所有检查项皆 ok」恒等（.env 缺失时仍可阻塞，故不断言 false）。
      expect(right.blocking).toBe(right.checks.some((c) => !c.ok));
    } finally {
      if (saved === undefined) delete process.env['LLM_MODEL'];
      else process.env['LLM_MODEL'] = saved;
    }
  });
});

describe('⑨ #7 重设计：自然语料与「压缩触发」的机械捕获', () => {
  it('自然语料体量下界（仅用户文本 token；助手/工具输出叠加后接近/跨过压缩阈值）', () => {
    const all = [...NATURAL_CORPUS, ...RECOVERY_PROBES];
    expect(all.length, '自然语料回合数应充足（长会话）').toBeGreaterThanOrEqual(40);
    const tokens = estimateContextTokens(all.map((text, i) => ({ role: 'user', content: text, timestamp: i } as unknown as AgentMessage))).tokens;
    expect(tokens, '用户文本 token 下界（叠加助手/工具输出后推长转录）').toBeGreaterThanOrEqual(1000);
  });

  it('压缩触发可被机械捕获：驱动输出 context_emergency_compact → 证据/计数/触发行', async () => {
    const root = freshRoot();
    const emitOnce: TurnDriver = {
      async run(input) {
        console.warn(JSON.stringify({ event: 'context_emergency_compact', tokens: 9999, contextWindow: 6000, messages: 11 }));
        console.log(JSON.stringify({ event: 'context_compacted', tokensBefore: 9999, tokensAfter: 4000, contextWindow: 6000 }));
        const reply = '好的。';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    };
    const exec = createExpExecutor({
      createDrivers: () => ({ mainDriver: emitOnce, workerDriver: workerQuerier() }),
      createExecutionFace: async () => fakeFace(),
      env: FAKE_ENV,
    });
    const ev = await exec(itemFor(T01), T01, path.join(root, 'cap'));
    const turnCount = effectiveTurns(T01).length;
    const triggers = ev.meta.driverEvents.filter((e) => e['event'] === 'context_emergency_compact');
    expect(triggers.length, '每回合一次驱动事件应逐条落证据').toBe(turnCount);
    expect(triggers.every((e) => typeof e['turn'] === 'number'), '事件带样本回合归属').toBe(true);
    const verdict = judgeExp(ev);
    expect(verdict.counters.compactionTriggerEvents).toBe(turnCount);
    expect(verdict.counters.compactionTriggerTurns).toEqual(Array.from({ length: turnCount }, (_, i) => i + 1));
    // console.log 的 context_compacted（回合前压缩成功）也必须被捕获（pi-driver.ts:543）。
    expect(verdict.counters.compactionCompleted, 'context_compacted（console.log）应被捕获').toBe(turnCount);
  });

  it('并发归属：同批两样本各自只收自己的驱动事件（ALS 不串台）', async () => {
    const root = freshRoot();
    const mkMain = (): TurnDriver => ({
      async run(input) {
        console.warn(JSON.stringify({ event: 'context_emergency_compact', tokens: 1, contextWindow: 6000, messages: 1 }));
        const reply = '好的。';
        return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
      },
    });
    const exec = createExpExecutor({
      createDrivers: () => ({ mainDriver: mkMain(), workerDriver: workerQuerier() }),
      createExecutionFace: async () => fakeFace(),
      env: FAKE_ENV,
    });
    const items = expandExpItems([{ ...T01, trials: 2 }]);
    const report = await runExpBatch({ kind: 'task-surface', cases: [T01], items, executor: exec, outRoot: path.join(root, 'conc'), concurrency: 2 });
    const perSample = effectiveTurns(T01).length;
    for (const s of report.samples) {
      expect(s.verdict?.counters.compactionTriggerEvents, '每样本事件数应等于自身回合数（串台会翻倍）').toBe(perSample);
    }
  });
});
