/**
 * C6 结构化调用通道回归测试（法域守卫）。
 *
 * 钉住两点：
 *   1. structured_call 工具已被注册进 worker 会话；
 *   2. 工具子进程环境含 EXECUTION_REQUIRE_PLAN=1（createPlanScopedWorkerEnv 法域）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';
import { createPlanScopedWorkerEnv, type PlanCliRunner } from './src/plan-runtime';
import type { PiCodingWorkerSessionOptions } from './src/pi-coding-driver';
import type { ServeGateEvent } from './src/serve-gate';
import type { AccessSemantics, OperationSemantics } from './src/operation-labels';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockMakeSession = vi.hoisted(() => {
  const state = {
    capturedCustomTools: [] as Array<Record<string, unknown>>,
    capturedAgent: {} as Record<string, unknown>,
  };
  return {
    state,
    makeSession: () => {
      const agent = {
        state: { messages: [] },
        beforeToolCall: undefined as unknown,
        shouldStopAfterTurn: undefined as unknown,
        abort: () => {},
        continue: async () => ({}),
      };
      state.capturedAgent = agent;
      return {
        session: {
          agent,
          subscribe: () => {},
          dispose: () => {},
        },
        dispose: () => {},
      };
    },
    setCustomTools: (tools: Array<Record<string, unknown>>) => {
      state.capturedCustomTools = tools;
    },
  };
});

const spawnCalls = vi.hoisted(() => [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>);

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    createAgentSession: async (options: { customTools?: Array<Record<string, unknown>> }) => {
      if (options.customTools) {
        mockMakeSession.setCustomTools(options.customTools);
      }
      return mockMakeSession.makeSession();
    },
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
      if (typeof command === 'string' && command.includes('example-gateway')) {
        spawnCalls.push({ args: args as string[], env: options?.env ?? {} });
      }
      return actual.spawn('echo', ['ok']);
    }),
  };
});

vi.mock('./src/operation-labels', async () => {
  // 平台 I/O 的 loader 全部以替身短路（本文件不 spawn 平台 CLI）；纯数据投影
  // serveModesOf 给真实现——2026-11-12（②）起 driver 消费它把清单的 serve 矩阵
  // 派生成执行模式词汇，假实现会把"词汇从平台数据来"这件事测没。
  const actual = await vi.importActual<typeof import('./src/operation-labels')>('./src/operation-labels');
  return {
    serveModesOf: actual.serveModesOf,
    isWriteAccess: vi.fn(),
    loadCapabilityManifest: vi.fn(async () => ({
      version: '1.0',
      operations: [
        { operation: 'finance.query-receivables', requiresPlan: false, effects: [], estSeconds: 10, label: 'Query', serveMatrix: [], argsSchema: ['--account', '--from', '--to'] },
      ],
    })),
    loadOperationArgSpecs: vi.fn(async () => new Map()),
    loadOperationArgStyles: vi.fn(async () => new Map()),
    loadOperationLabels: vi.fn(async () => new Map()),
    loadOperationProtocols: vi.fn(async () => new Map()),
    loadOperationSemantics: vi.fn(async () => new Map()),
  };
});

function baseOptions(overrides?: Partial<PiCodingWorkerSessionOptions>): PiCodingWorkerSessionOptions {
  return {
    cwd: '/tmp/fake-platform',
    agentDir: '/tmp/fake-agent',
    gateway: 'bin/example-gateway',
    skillRoots: [],
    systemPrompt: 'test',
    modelConfig: { runtime: {} as never, model: {} as never },
    ...overrides,
  };
}

describe('C6 structured_call 通道回归', () => {
  it('worker 会话注册 structured_call 工具', async () => {
    await createPiCodingWorkerSession(baseOptions());
    const names = mockMakeSession.state.capturedCustomTools.map((t) => t.name);
    expect(names).toContain('structured_call');
  });

  it('structured_call 未声明 operation 被 fail-closed', async () => {
    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [
          { operation: 'finance.query-receivables', requiresPlan: true, effects: [], estSeconds: 10, label: 'Query', serveMatrix: [] },
        ],
      },
    }));
    const session = mockMakeSession.state.capturedAgent as { beforeToolCall: (ctx: { toolCall: { id: string; type: string; name: string; arguments: Record<string, unknown> }; args: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined> };
    const toolCall = {
      id: 'call_1',
      type: 'toolCall',
      name: 'structured_call',
      arguments: { operation: 'unknown.operation', args: {} },
    };
    const verdict = await session.beforeToolCall({
      toolCall,
      args: toolCall.arguments,
    });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('未在能力清单中声明');
  });

  it('structured_call 未声明参数名被 fail-closed', async () => {
    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [
          { operation: 'finance.query-receivables', requiresPlan: false, effects: [], estSeconds: 10, label: 'Query', serveMatrix: [], argsSchema: ['--account', '--from', '--to'] },
        ],
      },
      // 语义表声明该 operation 是 scratch（plan 列 false）⇒ 计划门免前置，本条测试因此能
      // 隔离"参数名未声明"这一维。2026-11-09 起计划覆盖判据排在参数校验之前（四审
      // blocking：structured_call 原先完全不查覆盖），不给语义表时未登记形态按既有防线
      // 先要求"有激活计划"，拿到的是 SERVE_PLAN_NOT_ACTIVE 而不是参数名报错。
      operationSemantics: new Map([['finance.query-receivables', { plan: false, confirm: false, mock: true }]]),
    }));
    const session = mockMakeSession.state.capturedAgent as { beforeToolCall: (ctx: { toolCall: { id: string; type: string; name: string; arguments: Record<string, unknown> }; args: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined> };
    const toolCall = {
      id: 'call_1',
      type: 'toolCall',
      name: 'structured_call',
      arguments: { operation: 'finance.query-receivables', args: { '--account': 'A1', '--undeclared-flag': 'value' } },
    };
    const verdict = await session.beforeToolCall({
      toolCall,
      args: toolCall.arguments,
    });
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toContain('参数名未声明');
    expect(verdict?.reason).toContain('--undeclared-flag');
  });

  it('结构化写调用不再因 requiresPlan=false 绕过计划门（四审 blocking 的精确复现）', async () => {
    // 缺陷形态：manifest 声明 requiresPlan=false，旧代码就此放行——完全不看激活计划覆不覆盖。
    // 语义表说它是写类（confirm 列 true）⇒ 按三级判据必须先被计划某一步覆盖。
    // 本会话没有激活计划 ⇒ 必须拒。旧代码这里会返回 undefined（放行）。
    const semantics = new Map([['finance.post-voucher', { plan: true, confirm: true, mock: true }]]);
    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [
          { operation: 'finance.post-voucher', requiresPlan: false, effects: [], estSeconds: 10, label: 'Post', serveMatrix: [], argsSchema: ['--collection'] },
        ],
      },
      operationSemantics: semantics,
    }));
    const session = mockMakeSession.state.capturedAgent as { beforeToolCall: (ctx: { toolCall: { id: string; type: string; name: string; arguments: Record<string, unknown> }; args: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined> };
    const args = { operation: 'finance.post-voucher', args: { '--collection': 'alpha' } };
    const verdict = await session.beforeToolCall({ toolCall: { id: 'c', type: 'toolCall', name: 'structured_call', arguments: args }, args });
    expect(verdict?.block, '写类结构化调用无激活计划必须被拒').toBe(true);
    expect(verdict?.reason).toContain('计划');

    // 对照：同一个 operation 若语义表说它是 scratch（plan 列 false）⇒ 免计划前置，放行。
    // 证明判据真的按语义表分级，不是一律拒。
    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [
          { operation: 'finance.scratch-thing', requiresPlan: false, effects: [], estSeconds: 10, label: 'Scratch', serveMatrix: [], argsSchema: ['--name'] },
        ],
      },
      operationSemantics: new Map([['finance.scratch-thing', { plan: false, confirm: false, mock: true }]]),
    }));
    const session2 = mockMakeSession.state.capturedAgent as { beforeToolCall: (ctx: { toolCall: { id: string; type: string; name: string; arguments: Record<string, unknown> }; args: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined> };
    const scratchArgs = { operation: 'finance.scratch-thing', args: { '--name': 'x' } };
    const scratchVerdict = await session2.beforeToolCall({ toolCall: { id: 'c2', type: 'toolCall', name: 'structured_call', arguments: scratchArgs }, args: scratchArgs });
    expect(scratchVerdict?.block, 'scratch 类免计划前置，应放行').toBeUndefined();
  });

  it('createPlanScopedWorkerEnv 钉住 EXECUTION_REQUIRE_PLAN=1', () => {
    const env = createPlanScopedWorkerEnv({ FOO: 'bar' }, 'plan_123');
    expect(env.EXECUTION_REQUIRE_PLAN).toBe('1');
    expect(env.EXECUTION_PLAN_ID).toBe('plan_123');
    expect(env.FOO).toBe('bar');
  });

  it('structured_call execute 路径：spawn env 含 EXECUTION_REQUIRE_PLAN=1', async () => {
    spawnCalls.length = 0;

    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [
          { operation: 'finance.query-receivables', requiresPlan: false, effects: [], estSeconds: 10, label: 'Query', serveMatrix: [] },
          { operation: 'ballot.query', requiresPlan: false, effects: [], estSeconds: 10, label: 'Ballot Query', serveMatrix: [] },
        ],
      },
    }));

    // structured_call 工具在 capturedCustomTools 中
    const tools = mockMakeSession.state.capturedCustomTools as Array<Record<string, unknown>>;
    const structuredCall = tools.find((t) => t.name === 'structured_call');
    expect(structuredCall).toBeDefined();
    const execute = structuredCall!.execute as (toolCallId: string, params: { operation: string; args: Record<string, unknown> }, signal: AbortSignal | undefined, onUpdate: ((details: unknown) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<unknown>>;

    const result = await execute('call_1', { operation: 'ballot.query', args: { topic: 'alpha' } }, undefined, undefined, { cwd: baseOptions().cwd } as never);

    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const callEnv = spawnCalls[0]!.env;
    expect(callEnv.EXECUTION_REQUIRE_PLAN).toBe('1');
    // EXECUTION_PLAN_ID 仅在活跃计划存在时设置（createPlanScopedWorkerEnv 行为）；此处无 activePlan，故不断言该键。
  });

  it('T5：structured_call 超出当前已确认计划声明 → 第一跳即拒并留拒收记录', async () => {
    const events: ServeGateEvent[] = [];
    const semantics: OperationSemantics = new Map<string, AccessSemantics>([
      ['finance.query-receivables', { plan: true, confirm: false }],
    ]);
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      if (args[1] === 'current') {
        return { code: 0, stdout: JSON.stringify({ taskId: 'task_struct', planId: null, version: null, status: 'none' }), stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          planId: 'plan_struct',
          version: 1,
          decision: 'execute',
          estimate: { calls: 1, seconds: 10, weight: 2 },
          delta: { addedCalls: 1 },
          cumulative: {},
          reasonCode: 'WITHIN_AUTO_THRESHOLD',
          status: 'active',
        }),
        stderr: '',
      };
    };
    await createPiCodingWorkerSession(baseOptions({
      capabilityManifest: {
        version: '1.0',
        operations: [{
          operation: 'finance.query-receivables',
          requiresPlan: true,
          effects: [],
          estSeconds: 10,
          label: 'Query',
          serveMatrix: [],
          argsSchema: ['--account', '--from', '--to'],
        }],
      },
      operationSemantics: semantics,
      planCliRunner,
      serveGateAudit: (event) => { events.push(event); },
    }));
    type Verdict = { block?: boolean; reason?: string } | undefined;
    const session = mockMakeSession.state.capturedAgent as {
      beforeToolCall: (ctx: {
        toolCall: { id: string; type: string; name: string; arguments: Record<string, unknown> };
        args: Record<string, unknown>;
      }) => Promise<Verdict>;
    };
    // 激活一份只声明 alpha 的纯读计划。
    const planArgs = {
      command: 'bin/example-gateway plan {"calls":[{"operation":"finance.query-receivables","args":["--account","alpha","--from","202601","--to","202601"]}]}',
    };
    const activated = await session.beforeToolCall({ toolCall: { id: 'call_plan', type: 'toolCall', name: 'bash', arguments: planArgs }, args: planArgs });
    expect(activated?.reason).toContain('PLAN ACTIVE');

    const call = (id: string, account: string) => {
      const args = { operation: 'finance.query-receivables', args: { '--account': account, '--from': '202601', '--to': '202601' } };
      return session.beforeToolCall({ toolCall: { id, type: 'toolCall', name: 'structured_call', arguments: args }, args });
    };
    // 计划内的对象：放行。
    expect((await call('call_covered', 'alpha'))?.block).toBeUndefined();
    // 计划没声明的对象：第一跳即拒，并留一条拒收记录。
    const refused = await call('call_expansion', 'beta');
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain('超出');
    const record = events.filter((event) => event.allowed === false && event.tool === 'plan_scope_expansion');
    expect(record).toHaveLength(1);
    expect(record[0]?.reason).toBe(refused?.reason);
    expect(record[0]?.detail).toContain('beta');
  });

  it('C9 fallback：structured_call 含旧路径回退与 a2a-cutover 审计日志', () => {
    const src = readFileSync(join(__dirname, 'src', 'pi-coding-driver.ts'), 'utf8');
    expect(src).toContain("['operation', 'run', params.operation, tempFile]");
    expect(src).toContain("path.join(ctx.cwd, '.runtime', 'a2a-cutover.jsonl')");
    expect(src).toContain('fallback: true');
    expect(src).toContain('protocolVersion');
    expect(src).toContain('corpusVersion');
  });
});
