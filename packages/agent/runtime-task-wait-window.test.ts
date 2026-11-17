/**
 * B 切片（工单回执收敛）· task_run 短等待窗口的运行时语义（确定性：注入时钟 + gate 假执行器）：
 *   a. 快活（窗口内执行端确认 completed）→ 同回合把结果交给模型（与 inline 同形状：summary），
 *      不走受理回执；窗口未走完即返回（机械事实：fake 时钟推进量 < 窗口）；
 *   b. 慢活（超窗口）→ 工具结果只给机械事实（已受理、在后台办理中），话术**不含 #、不含编号
 *      数字**，回执不带 taskNo（编号只在 npm run tasks / 任务查询详情面）；任务继续在后台
 *      推进并最终落定（结果逐字存档）；
 *   d. taskRunWaitMs=0 → 不等窗口立即走后台受理路径（快活也不再同回合返回；时钟零推进）；
 *   协议文本：Main 协议义务写明「不向用户提工单编号」，查询工具描述不再指向受理回执。
 *
 * 反向绊线：b 的「话术无 # / 无编号数字」断言即绊线——把 #编号 塞回受理话术必红（实验见提交说明）。
 * 零网络、零真实模型：假执行器 + 脚本化 Main 驱动 + 注入时钟（now/sleep 两原语，非定时器框架）。
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import {
  MAIN_PROTOCOL_NOTE,
  MAIN_PROTOCOL_NOTE_WITH_WRITES,
  TASK_RESULT_TOOL_SCHEMA,
  TASK_RUN_TOOL,
  TASK_STATUS_TOOL_DESCRIPTION,
  createSession,
  type RuntimeClock,
} from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry, type TaskScope } from './src/task-registry';
import { createResourcePolicy } from './src/resource-policy';
import { createTaskRunner, type TaskExecutionOutcome, type TaskExecutor } from './src/task-runner';

const SCOPE: TaskScope = { principalId: 'wecom:wait-user', sessionId: 'sess-wait-window' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

function faceClient(): ExecutionClient {
  return {
    async capabilities(): Promise<CapabilityManifest> {
      return MANIFEST;
    },
    async execute(): Promise<ExecutionOutcome> {
      return { status: 'completed', data: {} };
    },
  };
}

interface MainStep {
  calls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

/** 脚本化 Main：逐回合按步骤调工具（结果按调用顺序收集），零模型。 */
function scriptedMain(steps: MainStep[], results: unknown[]): TurnDriver {
  return {
    async run(input) {
      const step = steps.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.calls ?? []) results.push(await input.exec(call.tool, call.args));
      return { text: step.text, messages: [...input.messages] };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
  return { promise, resolve };
}

/**
 * 手动时钟（B 切片测试注入）：sleep 只推进假时间并让出微任务——快活的执行端结算
 * （微任务链）先于下一次轮询，轮询步进量因此机械确定。
 */
function manualClock(): RuntimeClock & { time(): number } {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms) => {
      current += ms;
      return Promise.resolve();
    },
    time: () => current,
  };
}

interface Stack {
  registry: TaskRegistry;
  runner: ReturnType<typeof createTaskRunner>;
}

function backgroundStack(executor: TaskExecutor): Stack {
  const registry = createTaskRegistry();
  const runner = createTaskRunner({ registry, policy: createResourcePolicy(), executor });
  return { registry, runner };
}

async function sessionFor(
  stack: Stack,
  steps: MainStep[],
  results: unknown[],
  options: { taskRunWaitMs: number; clock?: RuntimeClock },
) {
  return await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: faceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: scriptedMain(steps, results),
    workerDriver: {
      async run() {
        throw new Error('（测试）background 派发不应调用 createSession 的 workerDriver');
      },
    },
    mainSystemPrompt: '（测试）Main 系统提示',
    taskRegistry: stack.registry,
    dispatchMode: 'background',
    taskRunner: stack.runner,
    taskRunWaitMs: options.taskRunWaitMs,
    ...(options.clock === undefined ? {} : { taskRunClock: options.clock }),
  });
}

describe('B 切片：task_run 短等待窗口（工单回执收敛）', () => {
  it('a. 快活（窗口内确认完成）：同回合把结果交给模型，不走受理回执', async () => {
    const clock = manualClock();
    const stack = backgroundStack({
      async execute() {
        return { kind: 'completed', resultText: '报销单汇总：共 12 单，合计 3456 元。' };
      },
    });
    const results: unknown[] = [];
    const session = await sessionFor(stack, [
      { calls: [{ tool: TASK_RUN_TOOL, args: { task: '把上季度的报销单整理成汇总表' } }], text: '办完了：汇总表共 12 单，合计 3456 元。' },
    ], results, { taskRunWaitMs: 1500, clock });
    try {
      await session.send('把上季度的报销单整理成汇总表');
      const answer = results[0] as Record<string, unknown>;
      // 同回合拿到结果（与 inline 同形状：summary），不是受理回执
      expect(answer).toMatchObject({ summary: '报销单汇总：共 12 单，合计 3456 元。' });
      expect(answer).not.toHaveProperty('notice');
      expect(answer).not.toHaveProperty('accepted');
      // 任务已确认完成、结果逐字存档
      const task = stack.registry.get(String(answer['taskId']), SCOPE);
      expect(task.status).toBe('completed');
      expect(task.replyText).toBe('报销单汇总：共 12 单，合计 3456 元。');
      // 零等待窗口消耗：结果在窗口内到达（fake 时钟推进量 < 1500）
      expect(clock.time()).toBeLessThan(1500);
    } finally {
      await stack.runner.whenIdle();
    }
  });

  it('b. 慢活（超窗口）：回执话术不含 # 与编号数字；任务留后台并最终完成', async () => {
    const clock = manualClock();
    const gate = deferred<TaskExecutionOutcome>();
    const stack = backgroundStack({
      async execute() {
        return await gate.promise;
      },
    });
    const results: unknown[] = [];
    const session = await sessionFor(stack, [
      { calls: [{ tool: TASK_RUN_TOOL, args: { task: '交办一件要跑一阵的事' } }], text: '已交办，正在后台办，完成后发你。' },
    ], results, { taskRunWaitMs: 1500, clock });
    try {
      await session.send('交办一件要跑一阵的事');
      const receipt = results[0] as Record<string, unknown>;
      // 机械事实：已受理、在后台办理中
      expect(receipt['accepted']).toBe(true);
      expect(receipt['status']).toBe('running');
      const notice = String(receipt['notice']);
      expect(notice).toContain('已受理');
      // 回执去编号：话术不含 #、不含编号数字（本例 taskNo=1，任务名无数字）；回执不带 taskNo
      expect(notice).not.toContain('#');
      expect(notice).not.toContain('1');
      expect(receipt).not.toHaveProperty('taskNo');
      // 窗口走满才返回（fake 时钟推进量 ≥ 窗口）
      expect(clock.time()).toBeGreaterThanOrEqual(1500);
      // 任务继续在后台推进并最终完成（结果逐字存档）
      gate.resolve({ kind: 'completed', resultText: '长任务结果：核对完成，共 3 条。' });
      await stack.runner.whenIdle();
      const task = stack.registry.get(String(receipt['taskId']), SCOPE);
      expect(task.status).toBe('completed');
      // 后台结果逐字存档（runner settle 经 archiveReply 写 replyText）
      expect(task.replyText).toBe('长任务结果：核对完成，共 3 条。');
    } finally {
      gate.resolve({ kind: 'failed', reason: '（测试清理）' });
      await stack.runner.whenIdle();
    }
  });

  it('d. taskRunWaitMs=0：立即走后台受理路径（快活也不再同回合返回）', async () => {
    const clock = manualClock();
    const stack = backgroundStack({
      async execute() {
        return { kind: 'completed', resultText: '快活结果：已完成。' };
      },
    });
    const results: unknown[] = [];
    const session = await sessionFor(stack, [
      { calls: [{ tool: TASK_RUN_TOOL, args: { task: '办一件快事' } }], text: '已受理，稍后给你结果。' },
    ], results, { taskRunWaitMs: 0, clock });
    try {
      await session.send('办一件快事');
      const receipt = results[0] as Record<string, unknown>;
      // 快活也不再同回合返回：受理回执（机械事实），不是 summary
      expect(receipt['accepted']).toBe(true);
      expect(receipt).not.toHaveProperty('summary');
      expect(String(receipt['notice'])).toContain('已受理');
      // 零等待：时钟零推进
      expect(clock.time()).toBe(0);
      // 任务照常在后台落定
      await stack.runner.whenIdle();
      expect(stack.registry.get(String(receipt['taskId']), SCOPE).status).toBe('completed');
    } finally {
      await stack.runner.whenIdle();
    }
  });

  it('协议文本：不向用户提工单编号；查询工具描述不再指向受理回执', () => {
    expect(MAIN_PROTOCOL_NOTE).toContain('工单编号');
    expect(MAIN_PROTOCOL_NOTE_WITH_WRITES).toContain('工单编号');
    // 编号只保留在详情面：task_status 仍支持 #编号引用，但出处是任务列表，不再是受理回执
    expect(TASK_STATUS_TOOL_DESCRIPTION).not.toContain('受理回执');
    expect(String(TASK_RESULT_TOOL_SCHEMA.properties)).not.toContain('受理回执');
  });
});
