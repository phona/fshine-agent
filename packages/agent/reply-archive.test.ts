/**
 * P1-T04 Main 最终回复存档（S1）与机械命名口径（P1-T03 的名称来源）。
 *
 * 覆盖（r4-acceptance.md P1-T04；决策问题 #4/#12）：
 *   · completed / failed / unexecuted 三场景各一轮：回复在回合收尾后逐字存入本回合各任务行
 *     （同回合多任务同值），详情与交付件含回复全文（SHA 与当次实际发送一致）；
 *   · 历史行（reply_text 为 NULL）：详情/交付件明确标注「该任务无最终回复存档」，
 *     不以执行层汇报冒充（回复段与任务结果段是两回事）；
 *   · 反向绊线：跨回合不串写（第 1 回合任务保持第 1 回合回复）；回合无最终文本不伪造存档；
 *     内存底账与 SQLite 底账同口径（编号自增 + 回复同值落行）；
 *   · 机械命名：首段、空白折叠、超长截断；零模型、确定性（名称来源=任务交办原文）。
 *
 * 全程假驱动器 + 假执行客户端（零网络、零模型）；库路径用临时目录（mkdtemp）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import { createSession, type Session } from './src/execution-runtime';
import { createTaskRegistry, deriveTaskName, type TaskRegistry } from './src/task-registry';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { renderTaskDeliverable, renderTaskDetail } from '../../scripts/tasks';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reply-archive-'));
  dirs.push(dir);
  return dir;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query items', args: [] }],
};

/** 按预设序列返回结果的假客户端（零网络）。 */
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

/** 脚本化 Main 假驱动器：逐回合委派若干任务并产出最终文本；脚本用尽即抛错（模拟回合失败）。 */
function scriptedMain(script: ReadonlyArray<{ tasks?: readonly string[]; text?: string }>): TurnDriver {
  let index = 0;
  return {
    async run(input) {
      const step = script[index];
      index += 1;
      if (step === undefined) throw new Error('scriptedMain 没有更多回合脚本');
      for (const task of step.tasks ?? []) await input.exec('run_task', { task });
      return { text: step.text ?? '', messages: [...input.messages] };
    },
  };
}

/** 委派后抛错的 Main 假驱动器：任务已产生，但回合没有最终回复（收尾失败）。 */
function failingMain(task: string): TurnDriver {
  return {
    async run(input) {
      await input.exec('run_task', { task });
      throw new Error('模型回合爆炸（测试注入）');
    },
  };
}

/** Worker 假驱动器：query=true 时发起一次结构化执行；否则零执行直接汇报。 */
function fakeWorker(query: boolean, report = 'Worker 汇报：已处理。'): TurnDriver {
  return {
    async run(input) {
      if (query) await input.exec('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } });
      return { text: report, messages: [...input.messages] };
    },
  };
}

async function sessionFor(client: ExecutionClient, options: {
  main: TurnDriver;
  worker: TurnDriver;
  dbPath?: string;
}): Promise<{ session: Session; registry: TaskRegistry & { close(): void } }> {
  const registry: TaskRegistry & { close(): void } = options.dbPath === undefined
    ? (() => {
        const memory = createTaskRegistry();
        return { ...memory, close: () => {} };
      })()
    : createSqliteTaskRegistry(options.dbPath);
  const session = await createSession({
    principalId: 'wecom:fixture-user',
    sessionId: 'ask-p1-reply',
    client,
    allowedOperations: ['dummy.query'],
    mainDriver: options.main,
    workerDriver: options.worker,
    mainSystemPrompt: '测试主 Agent。',
    taskRegistry: registry,
  });
  return { session, registry };
}

const scope = { principalId: 'wecom:fixture-user', sessionId: 'ask-p1-reply' };

describe('P1-T03 机械命名口径（零模型、确定性）', () => {
  it('首段 + 空白折叠 + 40 字符截断；空原文给机械占位', () => {
    expect(deriveTaskName('帮我查一下 beta 集合、窗口 W1 的数据')).toBe('帮我查一下 beta 集合、窗口 W1 的数据');
    expect(deriveTaskName('第一段。\n\n第二段。')).toBe('第一段。');
    expect(deriveTaskName('第一行\n第二行')).toBe('第一行 第二行');
    expect(deriveTaskName(`  ${'帮'.repeat(60)}  `)).toBe(`${'帮'.repeat(40)}…`);
    expect(deriveTaskName('')).toBe('未命名任务');
    expect(deriveTaskName('   \n  ')).toBe('未命名任务');
  });
});

describe('P1-T04 Main 回复存档（S1）', () => {
  it('completed/failed/unexecuted 三场景：回合收尾后回复逐字存档（SHA 一致），详情/交付件含全文', async () => {
    const scenarios: Array<{ name: string; outcomes: ExecutionOutcome[]; query: boolean; reply: string }> = [
      {
        name: 'completed',
        outcomes: [{ status: 'completed', data: { count: 3 } }],
        query: true,
        reply: 'documents 窗口 W202611 共 3 条，已拿到结果。',
      },
      {
        name: 'failed',
        outcomes: [{ status: 'failed', error: { code: 'EXECUTION_TIMEOUT', message: '执行层调用超时。' } }],
        query: true,
        reply: '这次查询超时了，没有拿到数据，可以稍后再试。',
      },
      {
        name: 'unexecuted',
        outcomes: [{ status: 'completed', data: {} }],
        query: false,
        reply: '本轮没有可执行的查询，我没有向平台发起调用。',
      },
    ];
    for (const scenario of scenarios) {
      const dbPath = path.join(tempDir(), `${scenario.name}.db`);
      const client = new ScenarioClient(scenario.outcomes);
      const { session, registry } = await sessionFor(client, {
        main: scriptedMain([{ tasks: ['查询 documents 窗口 W202611'], text: scenario.reply }]),
        worker: fakeWorker(scenario.query),
        dbPath,
      });
      const turn = await session.send('帮我查一下 documents');
      expect(turn.reply).toBe(scenario.reply);

      const task = session.getTask(turn.taskIds[0]!);
      expect(task.taskNo).toBe(1);
      expect(task.name).toBe('查询 documents 窗口 W202611');
      expect(task.replyText).toBe(scenario.reply);
      // 与当次实际发送逐字一致（SHA 比对）。
      expect(sha256Hex(task.replyText!)).toBe(sha256Hex(turn.reply));

      const detail = renderTaskDetail(task);
      expect(detail).toContain(`最终回复：\n${scenario.reply}`);
      expect(detail).not.toContain('该任务无最终回复存档');
      const deliverable = renderTaskDeliverable(task);
      expect(deliverable).toContain(`## 最终回复\n\n最终回复：\n${scenario.reply}\n`);
      registry.close();
    }
  }, 30_000);

  it('同一回合多个任务：各任务行存同一回复文本（同值），编号独立', async () => {
    const client = new ScenarioClient([
      { status: 'completed', data: { count: 3 } },
      { status: 'completed', data: { count: 2 } },
    ]);
    const { session, registry } = await sessionFor(client, {
      main: scriptedMain([{ tasks: ['查 beta 集合', '查 alpha 集合'], text: '两件事都办好了：beta 3 条、alpha 2 条。' }]),
      worker: fakeWorker(true),
      dbPath: path.join(tempDir(), 'state.db'),
    });
    const turn = await session.send('帮我查两个集合');
    expect(turn.taskIds).toHaveLength(2);
    const first = session.getTask(turn.taskIds[0]!);
    const second = session.getTask(turn.taskIds[1]!);
    expect(first.replyText).toBe(turn.reply);
    expect(second.replyText).toBe(turn.reply);
    expect(first.taskNo).toBe(1);
    expect(second.taskNo).toBe(2);
    registry.close();
  });

  it('内存底账（缺省实现）与 SQLite 同口径：编号自增、回复同值落行、名称机械生成', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: { count: 3 } }]);
    const { session } = await sessionFor(client, {
      main: scriptedMain([{ tasks: ['查询 documents'], text: '查询完成：3 条。' }]),
      worker: fakeWorker(true),
    });
    const turn = await session.send('查 documents');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.taskNo).toBe(1);
    expect(task.name).toBe('查询 documents');
    expect(task.replyText).toBe('查询完成：3 条。');
    expect(session.tasks()[0]!.replyText).toBe('查询完成：3 条。');
  });

  it('历史行无存档：详情/交付件标注「该任务无最终回复存档」，不用执行层汇报冒充', () => {
    const registry = createTaskRegistry();
    registry.begin({ taskId: 'task_history', ...scope, request: '历史任务：查 beta' });
    registry.noteExecution('task_history', { requestId: 'req_history', operation: 'dummy.query', status: 'completed' });
    registry.complete('task_history', '执行层汇报：查到 beta 3 条。');
    const task = registry.get('task_history', scope);
    expect(task.replyText).toBeUndefined();

    const detail = renderTaskDetail(task);
    expect(detail).toContain('最终回复：\n该任务无最终回复存档');
    // 回复段 ≠ 执行层汇报（不冒充）。
    const replySection = detail.split('最终回复：')[1] ?? '';
    expect(replySection).not.toContain(task.resultText!);
    expect(renderTaskDeliverable(task)).toContain('该任务无最终回复存档');
  });

  it('反向绊线：回复不跨回合串写——第 1 回合任务保持第 1 回合回复', async () => {
    const client = new ScenarioClient([
      { status: 'completed', data: { count: 3 } },
      { status: 'completed', data: { count: 2 } },
    ]);
    const { session, registry } = await sessionFor(client, {
      main: scriptedMain([
        { tasks: ['查第一次'], text: '第一次结果：3 条。' },
        { tasks: ['查第二次'], text: '第二次结果：2 条。' },
      ]),
      worker: fakeWorker(true),
      dbPath: path.join(tempDir(), 'state.db'),
    });
    const firstTurn = await session.send('第一件事');
    const secondTurn = await session.send('第二件事');
    expect(session.getTask(firstTurn.taskIds[0]!).replyText).toBe('第一次结果：3 条。');
    expect(session.getTask(secondTurn.taskIds[0]!).replyText).toBe('第二次结果：2 条。');
    registry.close();
  });

  it('反向绊线：回合失败（驱动器抛错）→ 不落回复、不用执行层汇报冒充', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: { count: 3 } }]);
    const { session, registry } = await sessionFor(client, {
      main: failingMain('查 documents'),
      worker: fakeWorker(true, '执行层汇报：查到 3 条。'),
      dbPath: path.join(tempDir(), 'state.db'),
    });
    await expect(session.send('查 documents')).rejects.toThrow();
    const task = session.tasks()[0]!;
    expect(task.resultText).toBe('执行层汇报：查到 3 条。');
    expect(task.replyText).toBeUndefined();
    const detail = renderTaskDetail(task);
    expect(detail).toContain('该任务无最终回复存档');
    expect(detail.split('最终回复：')[1] ?? '').not.toContain(task.resultText!);
    registry.close();
  });

  it('反向绊线：回合最终文本为空（模型空回复）→ 不落存档', async () => {
    const client = new ScenarioClient([{ status: 'completed', data: { count: 3 } }]);
    const { session, registry } = await sessionFor(client, {
      main: scriptedMain([{ tasks: ['查 documents'], text: '   ' }]),
      worker: fakeWorker(true),
      dbPath: path.join(tempDir(), 'state.db'),
    });
    const turn = await session.send('查 documents');
    expect(turn.reply.trim()).toBe('');
    const task = session.getTask(turn.taskIds[0]!);
    expect(task.replyText).toBeUndefined();
    expect(renderTaskDetail(task)).toContain('该任务无最终回复存档');
    registry.close();
  });
});
