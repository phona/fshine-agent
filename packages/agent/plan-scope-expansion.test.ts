/**
 * T5 驱动层：有界扩张门（2026-11-11）。
 *
 * 今天败状：激活的计划只声明了 alpha，worker 转头把 9 个 collection 全查一遍——serve-gate
 * 对读档只问"有没有激活计划"（这一条按既有断言不动），于是范围渗入在**执行前没有任何一道
 * 对账**。本文件钉住新增的那道：超出计划声明的读调用在既有读类探测帽额度内放行（有界探索，
 * 与「探索性查询不锁死」同一条线），额度用尽即拒并留拒收记录（一条 tool_calls 行），
 * 要求重新计划（重计划因累积重量进确认档，由平台确认门停下并留下用户确认记录）。
 *
 * 条件与判据都是机械的：同一份命令、同一个假模型运行时装配、逐跳数放行/拒收。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession, DEFAULT_READ_PROBE_CAP, type PiCodingWorkerSession } from './src/pi-coding-driver';
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

describe('T5 驱动层 · 有界扩张门（读类网关调用超出已确认计划声明）', () => {
  it('额度内的扩张放行，超出额度即拒并留拒收记录；计划内调用不受影响', async () => {
    const { worker, events } = await workerWithPlanApproved();
    // 先激活一份只声明 alpha 的计划。
    const activated = await bash(worker, PLAN_COMMAND, 'call_plan');
    expect(activated?.block).toBe(true);
    expect(activated?.reason).toContain('PLAN ACTIVE');

    // 计划里的那一步（alpha）：覆盖，放行，不消耗额度。
    expect((await bash(worker, 'bin/example-gateway query dummy.query --collection alpha', 'call_covered'))?.block).toBeUndefined();

    // 计划没声明的对象：前 DEFAULT_READ_PROBE_CAP 次是有界探索，放行。
    for (let index = 0; index < DEFAULT_READ_PROBE_CAP; index += 1) {
      const verdict = await bash(worker, `bin/example-gateway query dummy.query --collection c${index}`, `call_expand_${index}`);
      expect(verdict?.block, `扩张第 ${index + 1} 次应在额度内放行`).toBeUndefined();
    }

    // 第 DEFAULT_READ_PROBE_CAP+1 次：拒收，并留下拒收记录（tool_calls 一行，allowed:false）。
    const refused = await bash(worker, 'bin/example-gateway query dummy.query --collection c_overflow', 'call_expand_overflow');
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain('超出');
    expect(refused?.reason).toContain('重新提交');
    const record = events.filter((event) => event.allowed === false && event.tool === 'plan_scope_expansion');
    expect(record).toHaveLength(1);
    expect(record[0]?.reason).toBe(refused?.reason);
    expect(record[0]?.detail).toContain('c_overflow');
    worker.session.dispose();
  });

  it('额度用尽后仍放行计划内的那一步（额度只约束扩张，不锁死已确认范围）', async () => {
    const { worker } = await workerWithPlanApproved();
    await bash(worker, PLAN_COMMAND, 'call_plan');
    for (let index = 0; index < DEFAULT_READ_PROBE_CAP + 1; index += 1) {
      await bash(worker, `bin/example-gateway query dummy.query --collection c${index}`, `call_expand_${index}`);
    }
    const covered = await bash(worker, 'bin/example-gateway query dummy.query --collection alpha', 'call_covered_again');
    expect(covered?.block).toBeUndefined();
    worker.session.dispose();
  });
});
