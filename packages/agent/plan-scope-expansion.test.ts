/**
 * T5 驱动层：执行集合 ⊆ 已确认计划（2026-11-11）。
 *
 * 今天败状：激活的计划只声明了 alpha，worker 转头把 9 个 collection 全查一遍——serve-gate
 * 对读档只问"有没有激活计划"（这一条按既有断言不动），于是范围渗入在**执行前没有任何一道
 * 对账**。本文件钉住新增的那道：对不上已确认计划声明的网关调用**第一跳即拒**（没有额度、
 * 不是警告），并在审计里留拒收记录（一条 tool_calls 行，allowed:false）；计划内的调用
 * 不受影响。拒收理由指向正路：把要查的对象补进计划重新提交（重计划因累积重量进确认档，
 * 由平台确认门停下并留下用户确认记录）。
 *
 * 条件与判据都是机械的：同一份命令、同一个假模型运行时装配、逐跳数放行/拒收。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession, type PiCodingWorkerSession } from './src/pi-coding-driver';
import type { ServeGateEvent } from './src/serve-gate';
import type { PlanCliRunner } from './src/plan-runtime';
import type { AccessSemantics, OperationSemantics } from './src/operation-labels';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

const SEMANTICS: OperationSemantics = new Map<string, AccessSemantics>([
  ['dummy.query', { plan: true, confirm: false }],
]);

const PLAN_COMMAND = 'bin/example-gateway plan {"calls":[{"operation":"dummy.query","args":["--collection","alpha"]}]}';

async function workerWithPlanApproved(): Promise<{ worker: PiCodingWorkerSession; events: ServeGateEvent[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-scope-expansion-'));
  roots.push(root);
  const modelConfig = await fakeModelRuntime();
  const events: ServeGateEvent[] = [];
  const planCliRunner: PlanCliRunner = async ({ args }) => {
    if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '' };
    return {
      code: 0,
      stdout: `${JSON.stringify({
        planId: 'plan_scope',
        version: 1,
        decision: 'execute',
        estimate: { calls: 1, seconds: 10, weight: 2 },
        delta: { addedCalls: 1 },
        cumulative: {},
        reasonCode: 'WITHIN_AUTO_THRESHOLD',
        status: 'active',
      })}\n`,
      stderr: '',
    };
  };
  const worker = await createPiCodingWorkerSession({
    gateway: 'bin/example-gateway',
    cwd: root,
    skillRoots: [],
    systemPrompt: 'scope expansion test',
    sessionId: 'task_scope',
    agentDir: path.join(root, '.fshine-agent'),
    modelConfig,
    planCliRunner,
    operationSemantics: SEMANTICS,
    serveGateAudit: (event) => { events.push(event); },
  });
  return { worker, events };
}

function bash(worker: PiCodingWorkerSession, command: string, id: string) {
  return worker.session.agent.beforeToolCall?.({
    assistantMessage: {} as never,
    toolCall: { id, type: 'toolCall', name: 'bash', arguments: { command } } as never,
    args: { command },
    context: {} as never,
  });
}

describe('T5 驱动层 · 执行前对账（读类网关调用超出已确认计划声明）', () => {
  it('第一次未声明调用即拒并留拒收记录；计划内调用不受影响', async () => {
    const { worker, events } = await workerWithPlanApproved();
    // 先激活一份只声明 alpha 的计划。
    const activated = await bash(worker, PLAN_COMMAND, 'call_plan');
    expect(activated?.block).toBe(true);
    expect(activated?.reason).toContain('PLAN ACTIVE');

    // 计划里的那一步（alpha）：覆盖，放行。
    expect((await bash(worker, 'bin/example-gateway query dummy.query --collection alpha', 'call_covered'))?.block).toBeUndefined();

    // 计划没声明的对象：**第一跳即拒**（不是警告，也没有探索额度）。
    const refused = await bash(worker, 'bin/example-gateway query dummy.query --collection c_first', 'call_expand_first');
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain('超出');
    expect(refused?.reason).toContain('重新提交');
    const record = events.filter((event) => event.allowed === false && event.tool === 'plan_scope_expansion');
    expect(record).toHaveLength(1);
    expect(record[0]?.reason).toBe(refused?.reason);
    expect(record[0]?.detail).toContain('c_first');

    // 再来一次未声明调用：仍然拒，每次都留拒收记录（不因"第一次已拒"而静默）。
    const refusedAgain = await bash(worker, 'bin/example-gateway query dummy.query --collection c_second', 'call_expand_second');
    expect(refusedAgain?.block).toBe(true);
    expect(events.filter((event) => event.allowed === false && event.tool === 'plan_scope_expansion')).toHaveLength(2);
    // 拒收不得留下 allowed:true 的假执行痕迹：审计里 allowed 的 bash 行只该有 alpha 那一次。
    expect(events.filter((event) => event.allowed && event.tool === 'bash')).toHaveLength(1);

    // 计划内那一步依旧放行（拒收不锁死已确认范围）。
    expect((await bash(worker, 'bin/example-gateway query dummy.query --collection alpha', 'call_covered_again'))?.block).toBeUndefined();
    worker.session.dispose();
  });

  it('同 operation 不同关键参数值也算超出（张冠李戴的 C1 形状）', async () => {
    const { worker } = await workerWithPlanApproved();
    await bash(worker, PLAN_COMMAND, 'call_plan');
    const wrongTarget = await bash(worker, 'bin/example-gateway query dummy.query --collection alpha --window W2', 'call_covered_window');
    // 计划只声明了 collection，没声明 window：更精确的写法仍覆盖（计划 ⊆ 调用）。
    expect(wrongTarget?.block).toBeUndefined();
    const otherCollection = await bash(worker, 'bin/example-gateway query dummy.query --collection beta --window W2', 'call_wrong_collection');
    expect(otherCollection?.block).toBe(true);
    worker.session.dispose();
  });
});
