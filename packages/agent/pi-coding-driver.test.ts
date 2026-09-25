import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai/compat';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';
import type { PlanCliRunner } from './src/plan-runtime';

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

describe('pi-coding-agent context worker', () => {
  it('creates a headless cwd-bound session, loads skills, enables workspace tools, and restores messages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-coding-'));
    roots.push(root);
    const skillRoot = path.join(root, '.agents', 'skills');
    await mkdir(path.join(skillRoot, '17dz'), { recursive: true });
    await writeFile(path.join(skillRoot, '17dz', 'SKILL.md'), [
      '---',
      'name: 17dz-platform',
      'description: 幻账平台工作规范',
      '---',
      '只读查询必须给出可复核证据。',
    ].join('\n'));
    const modelConfig = await fakeModelRuntime();
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [skillRoot],
      systemPrompt: 'worker-system-prompt',
      sessionId: 'task_test_001',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
    });
    expect(worker.session.sessionManager.getCwd()).toBe(root);
    expect(worker.session.getActiveToolNames()).toEqual(['read', 'ls', 'bash']);
    expect(worker.skills.map((skill) => skill.name)).toContain('17dz-platform');
    expect(worker.session.systemPrompt).toContain('worker-system-prompt');
    worker.session.agent.state.messages = [{ role: 'user', content: '恢复任务', timestamp: Date.now() } as never];
    expect(worker.session.messages).toHaveLength(1);
    expect(worker.session.sessionManager.getSessionId()).toBe('task_test_001');
    worker.session.dispose();
  });

  it('restores the host active plan for a resumed task before allowing native CLI use', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-resume-plan-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const calls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ taskId: 'task_saved', planId: 'plan_saved', version: 4, status: 'active' }),
        stderr: '',
      };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'resume plan test',
      sessionId: 'task_saved',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const command = 'bin/17dz query voucher.query-saved A 202609';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_1', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    expect(calls).toEqual([['plan', 'current', '--task-id', 'task_saved']]);
    expect(verdict?.block).toBeUndefined();
    worker.session.dispose();
  });

  it('a stop decision preserves the previous active plan restored for this task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-stop-plan-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_saved', planId: 'plan_previous', version: 1, status: 'active' }), stderr: '' };
      if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
        planId: 'plan_stopped', version: 2, decision: 'stop', estimate: { calls: 60, seconds: 3600 },
        delta: { addedCalls: 60, addedSeconds: 3600 }, cumulative: { calls: 0, seconds: 0 }, reasonCode: 'hard_limit', status: 'stopped',
      }), stderr: '' };
      throw new Error('unexpected CLI call');
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'stop plan test',
      sessionId: 'task_saved',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const call = async (command: string) => worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_1', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });
    const stopped = await call('bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]}]}');
    expect(stopped?.reason).toContain('PLAN STOP');
    const existingScope = await call('bin/17dz query voucher.query-saved A 202609');
    expect(existingScope?.block).toBeUndefined();
    worker.session.dispose();
  });

  it('blocks a platform plan whose entities appear in none of the three sources before calling the CLI evaluator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-intent-scope-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const calls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: null, version: null, status: 'none' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'intent scope test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: {
        currentMessage: '查一下幻辰财税账套里猫一杯的应收',
        referenceEvidence: '【宿主主动回溯】tool_result：幻东 202609 余额 51 元',
      },
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻州幻东制造有限公司","--customer","猫一杯"]},{"operation":"voucher.query-saved","args":["幻州幻东制造有限公司","202609"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('未在当前请求、检索证据或平台响应中出现的参数');
    expect(calls).toEqual([['plan', 'current', '--task-id', 'task_scope']]);
    worker.session.dispose();
  });

  it('lets a plan through when its entities come from this task\'s platform responses (search→query)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-intent-scope-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      evaluated.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_active', version: 1, status: 'active' }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'intent scope test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
      entitySources: { currentMessage: '只查有没有胜利这个帐套' },
    });
    // 本任务此前的目录查询响应：唯一候选名逐字来自平台，宿主不懂业务也必须放行
    worker.session.agent.state.messages = [{
      role: 'toolResult',
      toolCallId: 'call_search',
      content: [{ type: 'text', text: 'RESULT {"op":"finance.search-account-sets","data":{"accountSets":[{"id":"as_1","name":"胜利五金有限责任公司"}]}}' }],
      timestamp: 1,
    } as never];
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","胜利五金有限责任公司"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

  it('skips entity validation when the host injects no sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-no-sources-'));
    roots.push(root);
    const modelConfig = await fakeModelRuntime();
    const evaluated: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      evaluated.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_active', version: 1, status: 'active' }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ taskId: 'task_scope', planId: 'plan_new', version: 1, status: 'active' }), stderr: '' };
    };
    const worker = await createPiCodingWorkerSession({
      cwd: root,
      skillRoots: [],
      systemPrompt: 'no sources test',
      sessionId: 'task_scope',
      agentDir: path.join(root, '.fshine-agent'),
      modelConfig,
      planCliRunner,
    });
    const command = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","任何名称"]}]}';
    const verdict = await worker.session.agent.beforeToolCall?.({
      assistantMessage: {} as never,
      toolCall: { id: 'call_scope', type: 'toolCall', name: 'bash', arguments: { command } } as never,
      args: { command },
      context: {} as never,
    });

    // 宿主没有注入来源（老路径）→ 不做实体校验，计划照常进平台评估
    expect(verdict?.reason).toContain('PLAN ACTIVE');
    expect(verdict?.reason).not.toContain('未在当前请求');
    expect(evaluated.some((args) => args[1] === 'evaluate')).toBe(true);
    worker.session.dispose();
  });

});
