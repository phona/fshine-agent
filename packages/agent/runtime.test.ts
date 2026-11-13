/**
 * 运行时链路的契约测试（零网络）：
 *   · 以假客户端（Fake ExecutionClient）替换真实客户端，Main/Worker 通用代码零修改跑通；
 *   · 模型侧同样用注入的假模型运行时（既有 pi-driver 测试同款手法），不起真实请求。
 *
 * 覆盖：
 *   ① 全链路 Main→Worker→execute_operation→客户端→结果回到 Main；
 *   ② requestId 宿主生成（模型不能提供身份）；
 *   ③ 允许集合外的 operation 在**发起执行前**被拒（拒绝路径，不依赖提示词）；
 *   ④ 能力快照与允许集合不一致 / 允许集合为空 → 构造即失败（fail-closed）；
 *   ⑤ 任务归属：越权 scope 取任务被拒（TaskOwnershipError）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { MutableModels } from '@earendil-works/pi-ai';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createPiTurnDriver, type PiModelRuntime } from './src/pi-driver';
import { createSession } from './src/execution-runtime';
import { TaskOwnershipError, createTaskRegistry, type TaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [
    {
      name: 'dummy.query',
      label: 'query items',
      args: [
        { name: '--collection', required: true },
        { name: '--window', required: false },
      ],
    },
    {
      name: 'dummy.commit',
      label: 'commit item',
      args: [{ name: '--collection', required: true }],
    },
  ],
};

class FakeClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  capabilityCalls = 0;
  constructor(private readonly manifest: CapabilityManifest = MANIFEST) {}
  async capabilities(): Promise<CapabilityManifest> {
    this.capabilityCalls += 1;
    return this.manifest;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    return {
      status: 'completed',
      data: { collection: 'documents', window: 'W202611', items: ['document-1', 'document-2', 'document-2'], count: 3 },
    };
  }
}

/** 按预设序列返回结果的假客户端（零网络）：完成判定测试用。 */
class ScenarioClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  private readonly outcomes: ExecutionOutcome[];
  constructor(outcomes: readonly ExecutionOutcome[]) {
    this.outcomes = [...outcomes];
  }
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('ScenarioClient 没有更多预设结果');
    return outcome;
  }
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function textAssistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

function streamOf(message: AgentMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      yield { type: 'done', reason: (message as { stopReason?: string }).stopReason, message };
    },
    result: async () => message,
  };
}

function fakeRuntime(responses: AgentMessage[]): { runtime: PiModelRuntime; calls: () => number } {
  let calls = 0;
  const runtime: PiModelRuntime = {
    model: {
      id: 'test-model',
      name: 'test-model',
      api: 'openai-completions',
      provider: 'llm',
      baseUrl: 'http://127.0.0.1:9',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 40_000,
      maxTokens: 32_000,
    } as unknown as PiModelRuntime['model'],
    models: {
      streamSimple: async () => {
        calls += 1;
        const response = responses.shift();
        if (!response) throw new Error('假模型运行时没有更多响应');
        return streamOf(response);
      },
      completeSimple: async () => textAssistant('【夹具摘要】'),
    } as unknown as MutableModels,
  };
  return { runtime, calls: () => calls };
}

function driverFor(responses: AgentMessage[]) {
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, runtime: fakeRuntime(responses).runtime });
}

function sessionFor(client: ExecutionClient, options: {
  mainResponses: AgentMessage[];
  workerResponses: AgentMessage[];
  allowedOperations?: readonly string[];
  taskRegistry?: TaskRegistry;
}) {
  return createSession({
    principalId: 'wecom:test-user',
    sessionId: 'sess_1',
    client,
    allowedOperations: options.allowedOperations ?? ['dummy.query'],
    mainDriver: driverFor(options.mainResponses),
    workerDriver: driverFor(options.workerResponses),
    mainSystemPrompt: '你是测试主 Agent。',
    ...(options.taskRegistry ? { taskRegistry: options.taskRegistry } : {}),
  });
}

describe('运行时链路（假客户端 + 假模型）', () => {
  it('Main→Worker→结构化请求→结果回到 Main；requestId 宿主生成；快照只取一次', async () => {
    const client = new FakeClient();
    const session = await sessionFor(client, {
      mainResponses: [
        toolCallAssistant('run_task', { task: '查询 documents 窗口 W202611' }, 'call_main_1'),
        textAssistant('documents 窗口 W202611 共 3 条。'),
        toolCallAssistant('run_task', { task: '查询 documents 窗口 W202610' }, 'call_main_2'),
        textAssistant('documents 窗口 W202610 已查询。'),
      ],
      workerResponses: [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'documents', '--window': 'W202611' },
        }, 'call_worker_1'),
        textAssistant('已查询 documents W202611：3 条。'),
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'documents', '--window': 'W202610' },
        }, 'call_worker_2'),
        textAssistant('已查询 documents W202610：2 条。'),
      ],
    });

    const first = await session.send('查一下 documents W202611');
    expect(first.reply).toContain('3 条');
    expect(first.taskIds).toHaveLength(1);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.operation).toBe('dummy.query');
    expect(client.requests[0]!.requestId).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(client.requests[0]!.args).toEqual({ '--collection': 'documents', '--window': 'W202611' });

    const second = await session.send('再查 W202610');
    expect(second.taskIds).toHaveLength(1);
    expect(client.requests).toHaveLength(2);
    // 单次快照：两个回合、两次委派，capabilities() 只被调用一次。
    expect(client.capabilityCalls).toBe(1);

    const tasks = session.tasks();
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.principalId).toBe('wecom:test-user');
      expect(task.sessionId).toBe('sess_1');
      expect(task.status).toBe('completed');
      expect(task.executions).toHaveLength(1);
      expect(task.executions[0]!.status).toBe('completed');
    }
    // 转录跨回合增长：第二轮请求带着第一轮的用户消息与工具结果。
    expect(session.transcript().length).toBeGreaterThan(4);
    expect(session.getTask(tasks[0]!.taskId).resultText).toContain('documents');
  });

  it('允许集合外的 operation 在发起执行前被拒：客户端一次都没收到请求', async () => {
    const client = new FakeClient();
    const session = await sessionFor(client, {
      mainResponses: [
        toolCallAssistant('run_task', { task: '写入一条数据' }, 'call_main_1'),
        textAssistant('本轮未执行写入。'),
      ],
      workerResponses: [
        toolCallAssistant('execute_operation', { operation: 'dummy.commit', args: { '--collection': 'documents' } }, 'call_worker_1'),
        textAssistant('该操作未被执行。'),
      ],
    });
    const turn = await session.send('请写入一条数据');
    expect(client.requests).toHaveLength(0);
    expect(turn.reply.trim()).not.toBe('');
    const task = session.tasks()[0]!;
    expect(task.executions).toHaveLength(0);
    // M4-B：宿主在发起执行前拒收 = 零执行事实 → unexecuted，不得记 completed。
    expect(task.status).toBe('unexecuted');
  });

  it('允许集合不在能力快照里 → 构造即失败（fail-closed）', async () => {
    const client = new FakeClient();
    await expect(sessionFor(client, {
      mainResponses: [],
      workerResponses: [],
      allowedOperations: ['dummy.missing'],
    })).rejects.toThrow(/不在能力快照/);
  });

  it('允许集合为空 → 构造即失败（fail-closed）', async () => {
    const client = new FakeClient();
    await expect(sessionFor(client, {
      mainResponses: [],
      workerResponses: [],
      allowedOperations: [],
    })).rejects.toThrow(/允许集合为空/);
  });

  it('任务归属：换 principal 或换 session 取任务被拒', async () => {
    const client = new FakeClient();
    const session = await sessionFor(client, {
      mainResponses: [
        toolCallAssistant('run_task', { task: '查询 documents' }, 'call_main_1'),
        textAssistant('已查询。'),
      ],
      workerResponses: [
        toolCallAssistant('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } }, 'call_worker_1'),
        textAssistant('已查询 documents。'),
      ],
    });
    const turn = await session.send('查一下 documents');
    const taskId = turn.taskIds[0]!;
    expect(session.getTask(taskId).taskId).toBe(taskId);

    // 底账层直接验：越权与不存在同一拒绝形态（不泄漏存在性）。
    const registry = createTaskRegistry();
    registry.begin({ taskId: 'task_x', principalId: 'p1', sessionId: 's1', request: 'r' });
    expect(() => registry.get('task_x', { principalId: 'p2', sessionId: 's1' })).toThrow(TaskOwnershipError);
    expect(() => registry.get('task_x', { principalId: 'p1', sessionId: 's2' })).toThrow(TaskOwnershipError);
    expect(() => registry.get('task_absent', { principalId: 'p1', sessionId: 's1' })).toThrow(TaskOwnershipError);
    expect(() => session.getTask('task_absent')).toThrow(TaskOwnershipError);
  });

  it('注入的 SQLite 底账：关库重开任务仍在；越权取任务仍拒；list 按 scope 隔离', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'state.db');
    const client = new FakeClient();
    const registry = createSqliteTaskRegistry(dbPath);
    const session = await sessionFor(client, {
      mainResponses: [
        toolCallAssistant('run_task', { task: '查询 documents' }, 'call_main_1'),
        textAssistant('documents 共 3 条。'),
      ],
      workerResponses: [
        toolCallAssistant('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } }, 'call_worker_1'),
        textAssistant('已查询 documents。'),
      ],
      taskRegistry: registry,
    });
    const turn = await session.send('查一下 documents');
    const taskId = turn.taskIds[0]!;
    registry.close();

    // 重启连续性：新开同一库，任务与执行记录仍在。
    const reopened = createSqliteTaskRegistry(dbPath);
    const task = reopened.get(taskId, { principalId: 'wecom:test-user', sessionId: 'sess_1' });
    expect(task.status).toBe('completed');
    expect(task.resultText).toContain('documents');
    expect(task.executions).toHaveLength(1);
    expect(task.executions[0]!.requestId).toBe(turn.executions[0]!.requestId);

    // 归属校验跨重启仍生效：换 principal / 换 session 一律同一拒绝形态。
    expect(() => reopened.get(taskId, { principalId: 'wecom:other', sessionId: 'sess_1' })).toThrow(TaskOwnershipError);
    expect(() => reopened.get(taskId, { principalId: 'wecom:test-user', sessionId: 'sess_other' })).toThrow(TaskOwnershipError);
    // list 按 scope 隔离：另一个会话看不到本任务。
    expect(reopened.list({ principalId: 'wecom:test-user', sessionId: 'sess_other' })).toEqual([]);
    expect(reopened.list({ principalId: 'wecom:test-user', sessionId: 'sess_1' }).map((item) => item.taskId)).toEqual([taskId]);
    reopened.close();
  });
});

describe('任务完成判定：只看已记录执行事实（M4-B）', () => {
  const mainTurn = (reply: string): AgentMessage[] => [
    toolCallAssistant('run_task', { task: '查询 documents' }, 'call_main_1'),
    textAssistant(reply),
  ];
  const queryCall = (id = 'call_worker_1'): AgentMessage =>
    toolCallAssistant('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } }, id);

  it('① 执行层 failed：任务记 failed（不是 completed）；汇报原文保留；failureReason 取执行层 message', async () => {
    const client = new ScenarioClient([{ status: 'failed', error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' } }]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('查询失败：执行层调用超时。'),
      workerResponses: [queryCall(), textAssistant('执行层报告本次调用超时，未返回数据。')],
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.executions[0]!.status).toBe('failed');
    // 执行事实落账：error 原样记录（execution-runtime 的 failed/refused 分支）。
    expect(task.executions[0]!.error).toMatchObject({ code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' });
    expect(task.status).toBe('failed');
    expect(task.status).not.toBe('completed');
    expect(task.resultText).toContain('超时');
    expect(task.failureReason).toContain('执行层调用超时');
  });

  it('② 执行层 refused：任务记 failed；failureReason 取执行层 message', async () => {
    const client = new ScenarioClient([{ status: 'refused', error: { code: 'POLICY_REFUSED', message: '执行层策略拒绝。' } }]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('本次调用被执行层拒绝。'),
      workerResponses: [queryCall(), textAssistant('执行层拒绝了本次调用。')],
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.executions[0]!.status).toBe('refused');
    expect(task.executions[0]!.error).toMatchObject({ code: 'POLICY_REFUSED', message: '执行层策略拒绝。' });
    expect(task.status).toBe('failed');
    expect(task.status).not.toBe('completed');
    expect(task.failureReason).toContain('执行层策略拒绝');
  });

  it('③ 零执行（Worker 未发起任何调用）：任务记 unexecuted；汇报原文保留', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: {} }]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('本轮没有可执行的查询。'),
      workerResponses: [textAssistant('本轮能力快照里没有可执行的查询，未发起任何调用。')],
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(client.requests).toHaveLength(0);
    expect(task.executions).toHaveLength(0);
    expect(task.status).toBe('unexecuted');
    expect(task.status).not.toBe('completed');
    expect(task.resultText).toContain('未发起任何调用');
  });

  it('⑧ 混合（先 completed 后 failed）：非全 completed 记 failed', async () => {
    const client = new ScenarioClient([
      { status: 'completed', data: { count: 1 } },
      { status: 'failed', error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' } },
    ]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('第二次调用失败。'),
      workerResponses: [
        queryCall('call_worker_1'),
        queryCall('call_worker_2'),
        textAssistant('第一次成功，第二次超时。'),
      ],
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.executions.map((execution) => execution.status)).toEqual(['completed', 'failed']);
    expect(task.status).toBe('failed');
    expect(task.status).not.toBe('completed');
  });

  it('⑥ 成功孪生（与①同场景、仅执行结果不同）：全 completed 才记 completed', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: { count: 3 } }]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('documents 共 3 条。'),
      workerResponses: [queryCall(), textAssistant('已查询 documents：3 条。')],
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.executions[0]!.status).toBe('completed');
    expect(task.status).toBe('completed');
  });

  it('⑦ SQLite 底账（生产缺省实现）同一 failed 场景：任务记 failed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-judge-'));
    tempDirs.push(dir);
    const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
    const client = new ScenarioClient([{ status: 'failed', error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' } }]);
    const session = await sessionFor(client, {
      mainResponses: mainTurn('查询失败：执行层调用超时。'),
      workerResponses: [queryCall(), textAssistant('执行层报告本次调用超时，未返回数据。')],
      taskRegistry: registry,
    });
    const turn = await session.send('查一下 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.status).toBe('failed');
    expect(task.status).not.toBe('completed');
    registry.close();
  });

  it('④ 纯聊天（零委派）：回合正常完成，不产生任务记录（判定不改变纯聊天语义）', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: {} }]);
    const session = await sessionFor(client, {
      mainResponses: [textAssistant('你好，我可以帮你查平台数据。')],
      workerResponses: [],
    });
    const turn = await session.send('你好');
    expect(turn.reply).toContain('你好');
    expect(turn.taskIds).toHaveLength(0);
    expect(session.tasks()).toHaveLength(0);
  });

  it('⑤ 反向绊线：failed 执行事实 + 声称成功的汇报文本 → 仍记 failed（不嗅探文本）', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'wecom:test-user', sessionId: 'sess_1' };
    registry.begin({ taskId: 'task_forged', ...scope, request: '查询 documents' });
    registry.noteExecution('task_forged', {
      requestId: 'req_failed_1',
      operation: 'dummy.query',
      status: 'failed',
      error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' },
    });
    registry.complete('task_forged', '任务圆满完成，共 3 条数据，已确认无误。');
    expect(registry.get('task_forged', scope).status).toBe('failed');
  });

  it('⑤b 反向绊线：零执行 + 声称成功的汇报文本 → 仍记 unexecuted（不嗅探文本）', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'wecom:test-user', sessionId: 'sess_1' };
    registry.begin({ taskId: 'task_forged_2', ...scope, request: '查询 documents' });
    registry.complete('task_forged_2', '查询成功，共 3 条数据。');
    expect(registry.get('task_forged_2', scope).status).toBe('unexecuted');
  });
});
