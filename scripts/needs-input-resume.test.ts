/**
 * 业务级用例：执行层在本次执行中返回 needs_input → 用户补答 → **同一任务**续跑到完成。
 *
 * 之前这条业务链没有用例：E05 只到「澄清即止」，T02 是预置 waiting_user 行再 task_resume；
 * task-runner 单测只验证「answerResumes + 新回合」，没有验证补答**内容**真的到达 Worker、
 * 也没有在真实装配链上验证同一 #编号的两次执行事实。
 *
 * 本套件走生产装配链（assembleSessionCore：底账/资源策略/TaskRunner/真实 TaskExecutor/
 * 通知 outbox 全部真实，只有 Main/Worker 驱动与执行层客户端是假件——仓内纪律：测试不接
 * 真实模型/真实平台）。假执行层第一次按原交办查询返回 needs_input（歧义），用户补一句
 * 指定集合后，第二次必须带着补答执行并完成。
 *
 * 业务判据（对应用户交办 → 系统做成什么样）：
 *   ① 委派 → 执行层 needs_input → 用户可见的待办问题与受理时的 #编号对得上
 *      （task_status 同一 taskNo + pendingQuestion；通知同一条 taskNo/name/missing）；
 *   ② 用户补答 → **同一 taskId/taskNo** 继续执行（不新建任务）→ completed；底账能看到
 *      「原执行（needs_input）+ 补答后执行（completed）」两条事实；补答原文到达 Worker；
 *   ③ 用户不补答 → 任务停在 waiting_user（不是 failed/unexecuted），再次 pump 也不重复执行。
 */
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
import type { DriverMessage, TurnDriver } from '../packages/agent/src/driver-contract';
import type { Notification, NotificationSink } from '../packages/agent/src/notifications';
import { renderNotification } from '../packages/agent/src/notification-render';
import { assembleSessionCore } from './ask-runtime';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-needs-input', sessionId: 'conv-needs-input' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'needs-input-resume-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function messageText(message: DriverMessage | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * 假执行层：`contoso` 有多个候选 → needs_input（带「缺什么」原文）；
 * 用户补答指定 `documents` 后 → completed。记录每次调用（重复执行绊线）。
 */
class NeedsInputClient implements ExecutionClient {
  readonly calls: Array<{ operation: string; args: Readonly<Record<string, unknown>> }> = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.calls.push({ operation: request.operation, args: request.args });
    if (request.args['--collection'] !== 'documents') {
      return {
        status: 'needs_input',
        missing: [{ name: 'collection', description: 'collection "contoso" 有多个候选：contracts / documents' }],
        error: { code: 'COLLECTION_AMBIGUOUS', message: 'More than one collection matches "contoso"' },
      };
    }
    return { status: 'completed', data: { rows: 12 } };
  }
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface MainStep {
  calls: readonly ToolCall[];
  reply: string;
}

type ExecResult = { ok: true; value: unknown } | { ok: false; error: string };

interface MainRecord {
  userText: string;
  results: ExecResult[];
}

/** 假 Main：按用户文本顺序消费步骤，逐一调用工具并记录结果（零模型）。 */
function scriptedMain(steps: MainStep[], records: MainRecord[]): TurnDriver {
  return {
    async run(input) {
      const userText = messageText(input.messages[input.messages.length - 1]);
      const step = steps.shift();
      if (step === undefined) throw new Error(`（测试）没有更多 Main 步骤：${userText}`);
      const results: ExecResult[] = [];
      for (const call of step.calls) {
        try {
          results.push({ ok: true, value: await input.exec(call.tool, call.args) });
        } catch (error) {
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      records.push({ userText, results });
      return {
        text: step.reply,
        messages: [...input.messages, { role: 'assistant', content: step.reply } as never],
      };
    },
  };
}

/**
 * 假 Worker：第 1 回合按原交办查询（contoso）→ 执行层 needs_input；
 * 第 2 回合必须从宿主委派文本里读到用户补答（"用 documents 这个集合"），
 * 用补上的集合再查一次 → completed。补答未到达 Worker 时无法完成（确定性红）。
 */
class ScriptedWorker implements TurnDriver {
  readonly delegations: string[] = [];
  async run(input: {
    messages: readonly DriverMessage[];
    exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  }): Promise<{ text: string; messages: DriverMessage[] }> {
    const delegation = messageText(input.messages[0]);
    this.delegations.push(delegation);
    if (this.delegations.length === 1) {
      await input.exec('execute_operation', { operation: 'dummy.query', args: { '--collection': 'contoso' } });
      return { text: '执行层要求补充：contoso 是哪个集合。', messages: [] };
    }
    const answered = /用\s*([a-z]+)\s*这个集合/.exec(delegation);
    if (answered === null) {
      throw new Error('（测试）用户补答没有到达 Worker，无法带着补答继续执行。');
    }
    await input.exec('execute_operation', { operation: 'dummy.query', args: { '--collection': answered[1] } });
    return { text: '合同清单已经整理好，共 12 份。', messages: [] };
  }
}

class FakeSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

interface Fixture {
  main: ReturnType<typeof scriptedMain>;
  records: MainRecord[];
  steps: MainStep[];
  worker: ScriptedWorker;
  client: NeedsInputClient;
  sink: FakeSink;
  assembled: Awaited<ReturnType<typeof assembleSessionCore>>;
  /** 推入下一条 Main 步骤（工具参数可引用前一步回执里的 taskNo）。 */
  push(step: MainStep): void;
  close(): void;
}

async function makeFixture(): Promise<Fixture> {
  const dir = tempDir();
  const steps: MainStep[] = [];
  const records: MainRecord[] = [];
  const main = scriptedMain(steps, records);
  const worker = new ScriptedWorker();
  const client = new NeedsInputClient();
  const sink = new FakeSink();
  const assembled = await assembleSessionCore({
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    profile: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    dbPath: path.join(dir, 'state.db'),
    stateDir: path.join(dir, 'state'),
    setAuditPath: true,
    emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
    mainSystemPrompt: '（测试）Main 系统提示',
    workerSkills: [],
    createDrivers: () => ({ mainDriver: main, workerDriver: worker }),
    createExecutionFace: async () => ({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    // B 切片：钉 0 窗口（本套件测 needs_input/接续机制；窗口行为由专测覆盖）。
    taskDispatch: 'async',
    runtime: { backgroundConcurrency: 1, queueCapacity: 0, taskRunWaitMs: 0 },
    notificationSink: sink,
  });
  return {
    main,
    records,
    steps,
    worker,
    client,
    sink,
    assembled,
    push: (step) => steps.push(step),
    close: () => assembled.close(),
  };
}

function receiptOf(record: MainRecord, index = 0): Record<string, unknown> {
  const result = record.results[index];
  if (result === undefined || !result.ok) throw new Error('（测试）缺少工具结果');
  return result.value as Record<string, unknown>;
}

/** 跑第 1 回合：用户交办 → 受理 → 后台执行回合落定（等待用户或终态）。 */
async function delegateFirstTurn(fixture: Fixture): Promise<{ taskId: string; taskNo: number }> {
  fixture.push({
    calls: [{ tool: 'task_run', args: { task: '把上个月的合同清单整理出来' } }],
    reply: '已受理，正在后台办理。',
  });
  await fixture.assembled.session.send('把上个月的合同清单整理出来');
  await fixture.assembled.runner!.whenIdle();
  const receipt = receiptOf(fixture.records[0]!);
  const taskId = String(receipt['taskId']);
  // B 切片回执去编号：受理回执不再携带工单编号，编号从底账事实读（与详情面同源）。
  const taskNo = fixture.assembled.taskRegistry.get(taskId, SCOPE).taskNo ?? 0;
  return { taskId, taskNo };
}

describe('业务：执行层 needs_input → 用户补答 → 同一任务完成', () => {
  it('① 执行层要补输入：待办问题与受理时的 #编号对得上，任务停在 waiting_user', async () => {
    const fixture = await makeFixture();
    try {
      const { taskId, taskNo } = await delegateFirstTurn(fixture);
      // 受理事实（owner 2026-11-19：交办不再给固定回执话术）：只回机械事实（accepted/status +
      // taskId/name），无 notice、无编号；编号只在详情面（task_status 查询结果）与底账。
      const receipt = receiptOf(fixture.records[0]!);
      expect(receipt['accepted']).toBe(true);
      expect(receipt).not.toHaveProperty('notice');
      expect(receipt).not.toHaveProperty('taskNo');

      // 用户问「那个任务怎么样了」：Main 用回执里的 taskId 查，拿到同一任务 + 待办问题。
      // 2026-11-20：任务编号不进投影，ref 与断言锚点从 #编号/taskNo 改成 taskId（原断言断的是可见面出现编号）。
      fixture.push({
        calls: [{ tool: 'task_status', args: { ref: taskId } }],
        reply: '刚才交办的那件事需要你补充信息。',
      });
      await fixture.assembled.session.send('刚才那个任务怎么样了？');
      const status = receiptOf(fixture.records[1]!);
      expect(status['taskId']).toBe(taskId);
      expect(status).not.toHaveProperty('taskNo');
      expect(status['status']).toBe('waiting_user');
      expect(status['pendingQuestion']).toEqual({
        missing: ['collection "contoso" 有多个候选：contracts / documents'],
      });

      // 底账：同一个 taskId、waiting_user（不是 failed/unexecuted）、无失败原因。
      const task = fixture.assembled.taskRegistry.get(taskId, SCOPE);
      expect(task.status).toBe('waiting_user');
      expect(task.failureReason).toBeUndefined();
      expect(task.pendingQuestion).toEqual({
        missing: ['collection "contoso" 有多个候选：contracts / documents'],
      });

      // 用户可见的通知（渠道面文案）：同一条任务编号、名字与「缺什么」。
      const rows = fixture.assembled.notifications!.listNotifications(taskId);
      const waiting = rows.find((row) => row.kind === 'waiting_user');
      expect(waiting).toBeDefined();
      expect(waiting!.payload.taskNo).toBe(taskNo);
      expect(waiting!.payload.missing).toEqual(['collection "contoso" 有多个候选：contracts / documents']);
      const rendered = renderNotification({ kind: waiting!.kind, payload: waiting!.payload });
      expect(rendered).toContain(task.name!);
      expect(rendered).toContain('contracts / documents');
    } finally {
      fixture.close();
    }
  });

  it('② 用户补答 → 同一 taskId/taskNo 续跑到 completed；底账两条执行事实、不新建任务', async () => {
    const fixture = await makeFixture();
    try {
      const { taskId, taskNo } = await delegateFirstTurn(fixture);

      // 用户补一句 → Main 用同一 #编号 task_resume（不是新 task_run）。
      fixture.push({
        calls: [
          {
            tool: 'task_resume',
            args: { ref: `#${taskNo}`, answer: '用 documents 这个集合' },
          },
        ],
        reply: '收到，继续办理。',
      });
      const resumeTurn = await fixture.assembled.session.send('用 documents 这个集合');
      expect(receiptOf(fixture.records[1]!).outcome).toBe('started');
      expect(resumeTurn.taskIds).toEqual([]); // 本回合没有新建任务
      await fixture.assembled.runner!.whenIdle();

      // 同一任务：taskId/taskNo 不变，任务列表里只有这一个（不是新建任务）。
      const task = fixture.assembled.taskRegistry.get(taskId, SCOPE);
      expect(task.taskNo).toBe(taskNo);
      expect(task.status).toBe('completed');
      expect(task.failureReason).toBeUndefined();
      expect(fixture.assembled.taskRegistry.list(SCOPE).map((row) => row.taskId)).toEqual([taskId]);
      expect(fixture.client.calls.map((call) => call.args['--collection'])).toEqual(['contoso', 'documents']);

      // 补答原文到达了 Worker（不是只存在底账里）：第 2 回合委派文本含用户答复。
      expect(fixture.worker.delegations).toHaveLength(2);
      expect(fixture.worker.delegations[1]).toContain('用 documents 这个集合');

      // 底账两条执行事实：原执行（needs_input）+ 补答后执行（completed）。
      expect(task.executions.map((execution) => execution.status)).toEqual(['needs_input', 'completed']);

      // 结果可见：task_result 的 replyText 是 Worker 最终汇报（逐字存档）。
      fixture.push({
        calls: [{ tool: 'task_result', args: { ref: `#${taskNo}` } }],
        reply: '合同清单已经整理好。',
      });
      await fixture.assembled.session.send('结果发我一下');
      const result = receiptOf(fixture.records[2]!);
      expect(result['status']).toBe('completed');
      expect(result['replyText']).toBe('合同清单已经整理好，共 12 份。');
    } finally {
      fixture.close();
    }
  });

  it('③ 用户不补答：停在 waiting_user，再次 pump 也不重复执行（不降级 failed/unexecuted）', async () => {
    const fixture = await makeFixture();
    try {
      const { taskId } = await delegateFirstTurn(fixture);

      // 没有补答：底账保持等待；执行层只被调用过一次，Worker 只跑过一个回合。
      const before = fixture.assembled.taskRegistry.get(taskId, SCOPE);
      expect(before.status).toBe('waiting_user');
      expect(before.failureReason).toBeUndefined();
      expect(fixture.client.calls).toHaveLength(1);
      expect(fixture.worker.delegations).toHaveLength(1);

      // 其它触发（排队泵/重启恢复的 pump）不得把等待中的任务重新执行。
      fixture.assembled.runner!.pump();
      await fixture.assembled.runner!.whenIdle();
      const after = fixture.assembled.taskRegistry.get(taskId, SCOPE);
      expect(after.status).toBe('waiting_user');
      expect(after.pendingQuestion?.missing).toHaveLength(1);
      expect(fixture.client.calls).toHaveLength(1);
      expect(fixture.worker.delegations).toHaveLength(1);

      // 通知底账不得出现 failed（needs_input 不得被静默降级成失败）。
      const kinds = fixture.assembled.notifications!.listNotifications(taskId).map((row) => row.kind);
      expect(kinds).toContain('waiting_user');
      expect(kinds).not.toContain('failed');
    } finally {
      fixture.close();
    }
  });
});
