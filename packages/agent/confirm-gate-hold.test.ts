/**
 * T6 驱动层：任务级预算账本 → 确认门兜底（2026-11-11）。
 *
 * 今天败状（D2 两臂）：高重量任务被切成多张**都在确认线以下**的小计划逐张提交，平台
 * 每张都只裁 notify（通知送达后继续执行），任务总重量却一路放行——确认门一次也没到，
 * 用户从未看到「请你确认」。本文件钉住新增的那道**任务级**兜底：宿主自己按已激活计划
 * 累计 estimate，累计进 confirm 档时不再激活，停在确认门等真实用户确认；确认记录之前
 * 零执行，确认之后才放行（顺序判据见 `task-budget.ts` 的 `confirmGateOrdering`）。
 *
 * 机械判据两条（都可机判）：
 *   ① 累计进 confirm 档的那次提交：不激活、给 pending 确认记录、其后网关调用被拒；
 *   ② 审计流里"被放行的网关调用"时间戳全部早于 hold，或晚于确认记录——确认前零执行。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession, type PiCodingWorkerSession } from './src/pi-coding-driver';
import { activatePendingPlan, type PendingPlanConfirmation, type PlanCliRunner } from './src/plan-runtime';
import { confirmGateOrdering } from './src/task-budget';
import type { ServeGateEvent } from './src/serve-gate';
import type { AccessSemantics, OperationSemantics } from './src/operation-labels';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const SECRET = 't6-confirm-gate-test-secret';
const SEMANTICS: OperationSemantics = new Map<string, AccessSemantics>([
  ['dummy.query', { plan: true, confirm: false }],
]);

/** 每张切片计划：8 个 collection（单张档位 notify；三张累计 24 call / 66 weight → confirm）。 */
function slicePlanCalls(slice: number): Array<{ operation: string; args: string[] }> {
  return Array.from({ length: 8 }, (_, index) => ({ operation: 'dummy.query', args: ['--collection', `slice${slice}-c${index}`] }));
}

function planCommand(slice: number): string {
  return `bin/example-gateway plan ${JSON.stringify({ calls: slicePlanCalls(slice) })}`;
}

/** 假平台：每张计划都只裁 notify，确认门完全交给宿主累计档兜底。 */
function createPlatformStub() {
  const state = {
    evaluations: 0,
    activations: [] as Array<{ planId: string; evidence: string }>,
    activePlan: null as { planId: string; version: number } | null,
  };
  const runner: PlanCliRunner = async ({ args, input }) => {
    const sub = args[1];
    if (sub === 'current') {
      return {
        code: 0,
        stdout: JSON.stringify(state.activePlan
          ? { taskId: 'task_t6', planId: state.activePlan.planId, version: state.activePlan.version, status: 'active' }
          : { taskId: 'task_t6', planId: null, version: null, status: 'none' }),
        stderr: '',
      };
    }
    if (sub === 'evaluate') {
      state.evaluations += 1;
      const version = state.evaluations;
      return {
        code: 0,
        stdout: `${JSON.stringify({
          planId: `plan_slice_${version}`,
          version,
          decision: 'notify',
          estimate: { calls: 8, seconds: 80, weight: 22 },
          delta: { addedCalls: 8 },
          cumulative: {},
          reasonCode: 'INITIAL_SCOPE_THRESHOLD',
          status: 'pending',
          scopeSummary: '8 call(s), 80s',
        })}\n`,
        stderr: '',
      };
    }
    if (sub === 'activate') {
      const payload = JSON.parse(String(input ?? '{}')) as { planId: string; token: string };
      const body = payload.token.split('.')[0] ?? '';
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { planId: string; evidence: string };
      state.activations.push({ planId: payload.planId, evidence: decoded.evidence });
      state.activePlan = { planId: payload.planId, version: state.evaluations };
      return { code: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    return { code: 0, stdout: '{"ok":true}\n', stderr: '' };
  };
  return { state, runner };
}

async function fakeModelRuntime(): Promise<{ runtime: ModelRuntime; model: Model<any> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('test', {
    name: 'Test',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test-key',
    models: [{
      id: 'worker-test',
      name: 'worker-test',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
  });
  const model = runtime.getModel('test', 'worker-test');
  if (!model) throw new Error('test model was not registered');
  return { runtime, model };
}

function bash(worker: PiCodingWorkerSession, command: string, id: string) {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id, type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  });
}

interface Timeline {
  clock: () => string;
  events: ServeGateEvent[];
  pending: PendingPlanConfirmation[];
  /** 被放行的网关调用（= 执行痕迹）。 */
  executions: Array<{ ts: string }>;
}

async function makeSession(platform: ReturnType<typeof createPlatformStub>, timeline: Timeline): Promise<PiCodingWorkerSession> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-confirm-gate-'));
  roots.push(root);
  const modelConfig = await fakeModelRuntime();
  return createPiCodingWorkerSession({
    gateway: 'bin/example-gateway',
    cwd: root,
    skillRoots: [],
    systemPrompt: 'confirm gate backstop test',
    sessionId: 'task_t6',
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    planCliRunner: platform.runner,
    planActivationSecret: SECRET,
    operationSemantics: SEMANTICS,
    onNotice: async () => {},
    onPendingPlan: (plan) => { timeline.pending.push(plan); },
    serveGateAudit: (event) => { timeline.events.push(event); },
  });
}

/** 记一次"执行"：门没拦才算执行痕迹。 */
function noteExecution(verdict: { block?: boolean } | undefined, timeline: Timeline): void {
  if (verdict?.block) return;
  timeline.executions.push({ ts: timeline.clock() });
}

describe('T6 驱动层 · 任务级累计进 confirm 档 → 停在确认门', () => {
  it('切片计划累计越线即停在确认门；确认记录前零执行，确认后才放行', async () => {
    let tick = 0;
    const timeline: Timeline = {
      clock: () => new Date(Date.UTC(2026, 10, 11, 10, 0, tick++)).toISOString(),
      events: [],
      pending: [],
      executions: [],
    };
    const platform = createPlatformStub();
    const worker = await makeSession(platform, timeline);

    // 第 1、2 张切片：单张都在确认线以下 → 通知后激活。
    for (const slice of [1, 2]) {
      const verdict = await bash(worker, planCommand(slice), `call_plan_${slice}`);
      expect(verdict?.block).toBe(true);
      expect(verdict?.reason).toContain('PLAN ACTIVE');
    }
    // 计划内的一次真实执行（读档，计划激活即放行）。
    noteExecution(await bash(worker, 'bin/example-gateway query dummy.query --collection slice1-c0', 'call_exec_1'), timeline);
    expect(timeline.executions).toHaveLength(1);

    // 第 3 张：单张仍是 notify，但累计 24 call / 66 weight 越过宿主确认线 → 停在确认门。
    const holdVerdict = await bash(worker, planCommand(3), 'call_plan_3');
    const holdAt = timeline.clock();
    expect(holdVerdict?.block).toBe(true);
    expect(holdVerdict?.reason).toContain('PLAN NEEDS_USER_CONFIRM');
    expect(platform.state.activations.filter((entry) => entry.planId === 'plan_slice_3')).toEqual([]);
    expect(timeline.pending).toHaveLength(1);
    expect(timeline.pending[0]?.decision).toBe('confirm');
    expect(timeline.pending[0]?.planId).toBe('plan_slice_3');

    // 确认前零执行：其后任何网关调用都被拒（无激活计划），执行痕迹不增加。
    const afterHold = await bash(worker, 'bin/example-gateway query dummy.query --collection slice3-c0', 'call_exec_after_hold');
    expect(afterHold?.block).toBe(true);
    noteExecution(afterHold, timeline);
    expect(timeline.executions).toHaveLength(1);

    // 顺序判据①：进档后、确认记录缺席 → held。
    expect(confirmGateOrdering({ holdAt, confirmations: [], executions: timeline.executions })).toBe('held');

    // 用户真实确认（宿主侧激活，evidence=user-confirmed）→ 计划在平台侧激活。
    const confirmed = timeline.pending[0]!;
    await activatePendingPlan({
      platformRoot: '/tmp/fshine-t6-platform',
      planId: confirmed.planId,
      evidence: 'user-confirmed',
      runCli: platform.runner,
      activationSecret: SECRET,
    });
    const confirmationAt = timeline.clock();
    expect(platform.state.activations.filter((entry) => entry.planId === confirmed.planId && entry.evidence === 'user-confirmed')).toHaveLength(1);

    // 确认后才放行：新回合（新会话）拾取已激活计划，同一调用放行。
    const nextTurn = await makeSession(platform, timeline);
    noteExecution(await bash(nextTurn, 'bin/example-gateway query dummy.query --collection slice3-c0', 'call_exec_after_confirm'), timeline);
    expect(timeline.executions).toHaveLength(2);

    // 顺序判据②：确认记录之后才出现的执行 → released；把执行挪进确认前 → 判红。
    expect(confirmGateOrdering({
      holdAt,
      confirmations: [{ at: confirmationAt, planId: confirmed.planId }],
      executions: timeline.executions,
    })).toBe('released');
    expect(confirmGateOrdering({
      holdAt,
      confirmations: [{ at: confirmationAt, planId: confirmed.planId }],
      executions: [...timeline.executions, { ts: holdAt }],
    })).toBe('executed_before_confirmation');

    worker.session.dispose();
    nextTurn.session.dispose();
  });
});
