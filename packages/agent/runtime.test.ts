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
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from './testing/task-facts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createPiTurnDriver } from './src/pi-driver';
import { createScriptedModelRuntime } from './testing/scripted-model-runtime';
import { WAKE_TURN_MS, createSession } from './src/execution-runtime';
import type { TurnDriver, WakeResult, WakeToolFace } from './src/driver-contract';
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

/**
 * 执行期前进系统时间的假客户端（issue #69：起止时刻确定性可分）。
 * 只假 Date（budget-metering 同款），真实执行期间走 1500ms——started_at 应取调用前一刻、
 * finished_at 应取回执到达一刻，两者不得相等、不得伪造。
 */
class ClockAdvancingClient implements ExecutionClient {
  readonly requests: ExecutionRequest[] = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.requests.push(request);
    vi.setSystemTime(Date.now() + 1500);
    return { status: 'completed', data: { collection: 'documents', count: 3 } };
  }
}

function toolCallAssistant(name: string, args: Record<string, unknown>, id: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'test-model',
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
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
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

async function driverFor(responses: AgentMessage[]) {
  const scripted = await createScriptedModelRuntime({
    contextWindow: 40_000,
    script: (index) => responses[index],
  });
  return createPiTurnDriver({ env: { LLM_MODEL: 'test-model' }, modelRuntime: scripted.runtime });
}

async function sessionFor(client: ExecutionClient, options: {
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
    mainDriver: await driverFor(options.mainResponses),
    workerDriver: await driverFor(options.workerResponses),
    mainSystemPrompt: '你是测试主 Agent。',
    ...(options.taskRegistry ? { taskRegistry: options.taskRegistry } : {}),
  });
}

describe('运行时链路（假客户端 + 假模型）', () => {
  it('Main→Worker→结构化请求→结果回到 Main；requestId 宿主生成；快照只取一次', async () => {
    const client = new FakeClient();
    const session = await sessionFor(client, {
      mainResponses: [
        toolCallAssistant('task_run', { task: '查询 documents 窗口 W202611' }, 'call_main_1'),
        textAssistant('documents 窗口 W202611 共 3 条。'),
        toolCallAssistant('task_run', { task: '查询 documents 窗口 W202610' }, 'call_main_2'),
        textAssistant('documents 窗口 W202610 已查询。'),
      ],
      workerResponses: [
        toolCallAssistant('op_dummy_query', { 'collection': 'documents', 'window': 'W202611' }, 'call_worker_1'),
        textAssistant('已查询 documents W202611：3 条。'),
        toolCallAssistant('op_dummy_query', { 'collection': 'documents', 'window': 'W202610' }, 'call_worker_2'),
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
      expect(lastExecutionOf(task)?.status).toBe('completed');
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
        toolCallAssistant('task_run', { task: '写入一条数据' }, 'call_main_1'),
        textAssistant('本轮未执行写入。'),
      ],
      workerResponses: [
        toolCallAssistant('op_dummy_commit', { 'collection': 'documents' }, 'call_worker_1'),
        textAssistant('该操作未被执行。'),
      ],
    });
    const turn = await session.send('请写入一条数据');
    expect(client.requests).toHaveLength(0);
    expect(turn.reply.trim()).not.toBe('');
    const task = session.tasks()[0]!;
    expect(task.executions).toHaveLength(0);
    // M4-B：宿主在发起执行前拒收 = 零执行事实 → unexecuted，不得记 completed。
    expect(executionsOf(task)).toEqual([]);
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
        toolCallAssistant('task_run', { task: '查询 documents' }, 'call_main_1'),
        textAssistant('已查询。'),
      ],
      workerResponses: [
        toolCallAssistant('op_dummy_query', { 'collection': 'documents' }, 'call_worker_1'),
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
        toolCallAssistant('task_run', { task: '查询 documents' }, 'call_main_1'),
        textAssistant('documents 共 3 条。'),
      ],
      workerResponses: [
        toolCallAssistant('op_dummy_query', { 'collection': 'documents' }, 'call_worker_1'),
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
    expect(lastExecutionOf(task)?.status).toBe('completed');
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
    toolCallAssistant('task_run', { task: '查询 documents' }, 'call_main_1'),
    textAssistant(reply),
  ];
  const queryCall = (id = 'call_worker_1'): AgentMessage =>
    toolCallAssistant('op_dummy_query', { 'collection': 'documents' }, id);

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
    expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
    expect(lastExecutionOf(task)?.status).not.toBe('completed');
    expect(task.resultText).toContain('超时');
    expect(lastFailureOf(task)?.error?.message).toContain('执行层调用超时');
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
    expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
    expect(lastExecutionOf(task)?.status).not.toBe('completed');
    expect(lastFailureOf(task)?.error?.message).toContain('执行层策略拒绝');
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
    expect(executionsOf(task)).toEqual([]);
    expect(lastExecutionOf(task)?.status).not.toBe('completed');
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
    expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
    expect(lastExecutionOf(task)?.status).not.toBe('completed');
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
    expect(lastExecutionOf(task)?.status).toBe('completed');
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
    expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
    expect(lastExecutionOf(task)?.status).not.toBe('completed');
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
    registry.setResultText('task_forged', '任务圆满完成，共 3 条数据，已确认无误。');
    expect(['failed', 'refused']).toContain(lastExecutionOf(registry.get('task_forged', scope))?.status);
  });

  it('⑤b 反向绊线：零执行 + 声称成功的汇报文本 → 不产生任何执行行（只认执行事实，不嗅探文本）', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'wecom:test-user', sessionId: 'sess_1' };
    registry.begin({ taskId: 'task_forged_2', ...scope, request: '查询 documents' });
    registry.setResultText('task_forged_2', '查询成功，共 3 条数据。');
    expect(executionsOf(registry.get('task_forged_2', scope))).toEqual([]);
  });

  it('⑧ 执行行落真实执行的起止时刻（issue #69）：起于调用前一刻、止于回执到达一刻（假时钟）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T10:00:00.000Z'));
    try {
      const session = await sessionFor(new ClockAdvancingClient(), {
        mainResponses: mainTurn('documents 共 3 条。'),
        workerResponses: [queryCall(), textAssistant('已查询 documents：3 条。')],
      });
      const turn = await session.send('查一下 documents');
      const task = session.getTask(turn.taskIds[0]!);
      expect(task.executions).toHaveLength(1);
      // 起止时刻夹住真实执行（执行中系统时间前进 1500ms）：调用前一刻 / 回执到达一刻。
      expect(task.executions[0]!.startedAt).toBe('2026-11-24T10:00:00.000Z');
      expect(task.executions[0]!.finishedAt).toBe('2026-11-24T10:00:01.500Z');
      expect(task.executions[0]!.startedAt).not.toBe(task.executions[0]!.finishedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('唤醒回合的界（2026-11-19 复核 F1）', () => {
  it('wake 授予只读工具面（task_status/task_result）：exec 读真实底账，执行层零调用；执行类工具被拒', async () => {
    const scope = { principalId: 'wecom:test-user', sessionId: 'sess_wake_face' };
    const registry = createTaskRegistry();
    registry.begin({ taskId: 'task_wake_face', ...scope, request: '汇总那件事' });
    registry.setResultText('task_wake_face', '共 7 条，已确认无误。');

    const client = new FakeClient();

    let seenToolFace: WakeToolFace | undefined;
    const capture: TurnDriver = {
      async run() { throw new Error('（测试）唤醒用例不应起业务回合'); },
      async wake(_factText: string, options?: { deadline?: number; toolFace?: WakeToolFace }): Promise<WakeResult> {
        seenToolFace = options?.toolFace;
        return { outcome: 'woken', text: '那件事办完了，共 7 条。' };
      },
    };
    const session = await createSession({
      ...scope,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver: capture,
      workerDriver: capture,
      mainSystemPrompt: '你是测试主 Agent。',
      taskRegistry: registry,
    });

    const woke = await session.wake('[任务完成]「汇总那件事」办完了。');
    expect(woke.outcome).toBe('woken');
    // 请求面：只读工具集（名字集合恰好 task_status/task_result，且不含执行类）。
    expect(seenToolFace).toBeDefined();
    expect([...seenToolFace!.names].sort()).toEqual(['task_result', 'task_status']);
    // 只读执行面：task_status 读真实底账（拿到刚建的任务），task_result 拿结果存档。
    const status = await seenToolFace!.exec('task_status', {}) as { tasks: Array<{ name: string }> };
    expect(status.tasks[0]!.name, 'task_status 读到真实底账').toBe('汇总那件事');
    // 2026-11-20：数字 ref 退役，按真实 taskId 读结果（断言不变）。
    const result = await seenToolFace!.exec('task_result', { ref: 'task_wake_face' }) as { resultText: string | null };
    expect(result.resultText, 'task_result 读到真实结果存档').toBe('共 7 条，已确认无误。');
    // 执行类工具（含集合外任何名字）被只读闭包确定性拒绝，执行层零调用。
    await expect(seenToolFace!.exec('execute_operation', {})).rejects.toThrow('唤醒回合不允许调用工具');
    await expect(seenToolFace!.exec('task_run', {})).rejects.toThrow('唤醒回合不允许调用工具');
    expect(client.requests, '只读工具面不得触执行层').toHaveLength(0);
  });

  it('Session.wake 传给驱动的截止 = 单次调用量级（WAKE_TURN_MS），不是业务回合的 mainTurnMs(300s)', async () => {
    let observedDeadline: number | undefined;
    const fakeMain: TurnDriver = {
      async run() {
        throw new Error('（测试）唤醒用例不应起业务回合');
      },
      async wake(_factText: string, options?: { deadline?: number }): Promise<WakeResult> {
        observedDeadline = options?.deadline;
        return { outcome: 'woken', text: '好。' };
      },
    };
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wake_bound',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: fakeMain,
      workerDriver: fakeMain,
      mainSystemPrompt: '你是测试主 Agent。',
      // 业务回合的界照旧是 300s：唤醒不能用它当界（一次卡住的唤醒按住会话链 5 分钟）。
      mainTurnMs: 300_000,
    });
    const woke = await session.wake('[任务完成] 测试事实：已完成。');
    expect(woke.outcome).toBe('woken');
    expect(observedDeadline).toBeDefined();
    const after = Date.now();
    // deadline = 调用时刻 + WAKE_TURN_MS；用 after 收边（调用时刻 ≤ after）。
    expect(observedDeadline! - after).toBeLessThanOrEqual(WAKE_TURN_MS);
    expect(observedDeadline! - after).toBeGreaterThan(0);
  });

  it('冷会话（驱动可唤醒但实例级会话还没建）→ 补一次**零工具**单回合（重启对账的形状）', async () => {
    // 2026-11-19 唤醒切片：重启后第一次状态变化（重启对账）时，驱动实例级会话还没建——
    // 驱动侧 wake 只能回 unavailable。本层按与 send 同一份装配参数补一次零工具单回合，
    // 否则「用户以为在办、实际说不清」这件事永远说不出话。
    let observedTools: readonly unknown[] | undefined;
    let observedMessages: readonly unknown[] | undefined;
    let observedDeadline: number | undefined;
    let observedExec: ((tool: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const cold: TurnDriver = {
      async run(input) {
        observedTools = input.tools;
        observedMessages = input.messages;
        observedDeadline = input.deadline;
        observedExec = input.exec;
        return { text: '我这边重启过，这件事的状态说不清了。', messages: [...input.messages] };
      },
      async wake(): Promise<WakeResult> {
        return { outcome: 'unavailable' };
      },
    };
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wake_cold',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: cold,
      workerDriver: cold,
      mainSystemPrompt: '你是测试主 Agent。',
      mainTurnMs: 300_000,
    });
    const woke = await session.wake('[重启对账] 测试事实：状态说不清。');
    expect(woke).toEqual({ outcome: 'woken', text: '我这边重启过，这件事的状态说不清了。' });
    // 零工具（唤醒回合不得碰执行层——与驱动侧 wake 同一条纪律）。
    expect(observedTools).toEqual([]);
    // 本轮输入 = 事实（最后一条 user）。
    expect(observedMessages?.at(-1)).toMatchObject({
      role: 'user',
      content: '[重启对账] 测试事实：状态说不清。',
    });
    expect(observedDeadline! - Date.now()).toBeLessThanOrEqual(WAKE_TURN_MS);
    // 零工具下模型真去调工具也只拿到一句安全话术（不是执行面）。
    await expect(observedExec!('task_run', {})).rejects.toThrow('唤醒回合不提供工具。');
  });

  it('冷唤醒说不出话（空正文）→ failed（不冒充已说）；驱动没有唤醒能力 → unavailable（语义不变）', async () => {
    const silent: TurnDriver = {
      async run(input) {
        return { text: '', messages: [...input.messages] };
      },
      async wake(): Promise<WakeResult> {
        return { outcome: 'unavailable' };
      },
    };
    const session = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wake_cold_silent',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: silent,
      workerDriver: silent,
      mainSystemPrompt: '你是测试主 Agent。',
      mainTurnMs: 300_000,
    });
    await expect(session.wake('[重启对账] 测试事实。')).resolves.toEqual({ outcome: 'failed' });

    const noWake: TurnDriver = {
      async run() {
        throw new Error('（测试）没有唤醒能力的驱动不应起回合');
      },
    };
    const plain = await createSession({
      principalId: 'wecom:test-user',
      sessionId: 'sess_wake_nowake',
      client: new FakeClient(),
      allowedOperations: ['dummy.query'],
      mainDriver: noWake,
      workerDriver: noWake,
      mainSystemPrompt: '你是测试主 Agent。',
      mainTurnMs: 300_000,
    });
    await expect(plain.wake('[重启对账] 测试事实。')).resolves.toEqual({ outcome: 'unavailable' });
  });
});
