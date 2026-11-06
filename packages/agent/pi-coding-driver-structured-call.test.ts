/**
 * C6 结构化调用通道回归测试（法域守卫）。
 *
 * 钉住两点：
 *   1. structured_call 工具已被注册进 worker 会话；
 *   2. 工具子进程环境含 EXECUTION_REQUIRE_PLAN=1（createPlanScopedWorkerEnv 法域）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createPiCodingWorkerSession } from './src/pi-coding-driver';
import { createPlanScopedWorkerEnv } from './src/plan-runtime';
import type { PiCodingWorkerSessionOptions } from './src/pi-coding-driver';
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

vi.mock('./src/operation-labels', () => {
  return {
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

  it('C9 fallback：structured_call 含旧路径回退与 a2a-cutover 审计日志', () => {
    const src = readFileSync(join(__dirname, 'src', 'pi-coding-driver.ts'), 'utf8');
    expect(src).toContain("['operation', 'run', params.operation, tempFile]");
    expect(src).toContain("path.join(ctx.cwd, '.runtime', 'a2a-cutover.jsonl')");
    expect(src).toContain('fallback: true');
    expect(src).toContain('protocolVersion');
    expect(src).toContain('corpusVersion');
  });
});
