/**
 * 长任务异步（契约 v4）· 装配接线端到端（2026-11-19）。
 *
 * L-1 的协议与 runner 已在 `packages/agent/long-task-async.test.ts` 逐条验证；本套件只验证
 * **生产装配链**把端口接对了：`assembleSessionCore` 从执行面客户端的 `wait` 派生等待端口、
 * 把 `onExecutionEvent` 接到装配方，Worker 首回合交办 → accepted → 任务保持 running（租约与
 * 并发槽释放）→ wait 完成 → Worker 续跑（带「不要重复发起」注记）→ completed，且执行层只被
 * 调用一次。
 *
 * 判据缺一即红：端口没接 → 任务落 failed（accepted fail-closed）；事件没接 → 断言缺
 * `execution_accepted`；重复发起 → execute 调用次数 2。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionAbortResult,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../packages/agent/src/driver-contract';
import type { ExecutionEvent } from '../packages/agent/src/execution-runtime';
import { assembleSessionCore } from './ask-runtime';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskMayBeRunningOf, taskReportedOf, taskUnstartedOf, taskWaitingOf } from '../packages/agent/testing/task-facts';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-long', sessionId: 'conv-long' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [
    { name: 'dummy.longtask', label: 'long task', args: [], long_running: true },
    { name: 'dummy.query', label: 'query', args: [] },
  ],
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'long-task-assembly-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function messageText(message: DriverMessage | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  return '';
}

/**
 * 假执行层：execute 只允许被调一次（accepted）——重复发起即业务缺陷。
 * wait 挂起到测试显式 resolve，保证能观察到 accepted 后的中间态。
 */
class LongTaskClient implements ExecutionClient {
  readonly executeCalls: Array<{ operation: string }> = [];
  readonly waitCalls: string[] = [];
  private pending: ((outcome: ExecutionOutcome) => void) | undefined;

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.executeCalls.push({ operation: request.operation });
    return { status: 'accepted', operationId: 'op-1', pollAfterMs: 25 };
  }

  wait(operationId: string): Promise<ExecutionOutcome> {
    this.waitCalls.push(operationId);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  async abort(): Promise<ExecutionAbortResult> {
    return { aborted: true };
  }

  /** 测试推进：执行层报告完成。 */
  finish(): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({ status: 'completed', data: { summary: '导出完成，共 42 行' } });
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

/** 假 Main：只做交办与回执转述（零模型）。 */
function scriptedMain(steps: MainStep[], replies: string[]): TurnDriver {
  return {
    async run(input) {
      const step = steps.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 步骤');
      for (const call of step.calls) await input.exec(call.tool, call.args);
      replies.push(step.reply);
      return { text: step.reply, messages: [...input.messages, { role: 'assistant', content: step.reply } as never] };
    },
  };
}

/** 假 Worker：首回合发起长任务；续跑回合必须看到 host 的续跑注记并如实收尾。 */
class ScriptedWorker implements TurnDriver {
  readonly delegations: string[] = [];
  async run(input: {
    messages: readonly DriverMessage[];
    exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  }): Promise<{ text: string; messages: DriverMessage[] }> {
    const delegation = messageText(input.messages[0]);
    this.delegations.push(delegation);
    if (this.delegations.length === 1) {
      await input.exec('execute_operation', { operation: 'dummy.longtask', args: {} });
      return { text: '已发起长任务，等待结果。', messages: [] };
    }
    if (!delegation.includes('[续跑]')) {
      throw new Error('（测试）续跑注记没有到达 Worker');
    }
    if (!delegation.includes('不要重复发起同一操作')) {
      throw new Error('（测试）续跑注记缺少「不要重复发起」约束');
    }
    if (!delegation.includes('导出完成，共 42 行')) {
      throw new Error('（测试）wait 结果没有到达 Worker');
    }
    return { text: '导出完成，共 42 行。', messages: [] };
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
  // 等待项的重排走 runner 的有界定时器（真实 setTimeout，不是 setImmediate）：给它一拍。
  await new Promise((resolve) => setTimeout(resolve, 20));
}

interface Fixture {
  assembled: Awaited<ReturnType<typeof assembleSessionCore>>;
  client: LongTaskClient;
  worker: ScriptedWorker;
  events: ExecutionEvent[];
  close(): void;
}

async function makeFixture(): Promise<Fixture> {
  const dir = tempDir();
  const client = new LongTaskClient();
  const worker = new ScriptedWorker();
  const events: ExecutionEvent[] = [];
  const main = scriptedMain(
    [{ calls: [{ tool: 'task_run', args: { task: '导出上个月全部凭证' } }], reply: '这个我来办，办完发你。' }],
    [],
  );
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
      allowedOperations: ['dummy.longtask', 'dummy.query'],
      // 长任务是写面操作（夹具声明 access=write）：不进只读集合。
      readOnlyOperations: ['dummy.query'],
    }),
    taskDispatch: 'async',
    runtime: { backgroundConcurrency: 1, queueCapacity: 0, taskRunWaitMs: 0, allowWriteOperations: true },
    // 长任务是写面操作：夹具声明 access=write，需要角色含 write 且部署总闸打开。
    allowWriteOperations: true,
    allowedPermissions: ['read', 'write'],
    onExecutionEvent: (event) => events.push(event),
  });
  return { assembled, client, worker, events, close: () => assembled.close() };
}

describe('长任务异步·装配接线', () => {
  it('accepted → 任务仍在推进且槽位/租约释放；wait 完成 → Worker 续跑 → 汇报存档，执行层只调一次', async () => {
    const fx = await makeFixture();
    try {
      await fx.assembled.session.send('导出上个月全部凭证');
      await flush();
      await fx.assembled.runner!.whenIdle();

      const taskId = fx.assembled.taskRegistry.list({ principalId: SCOPE.principalId, sessionId: SCOPE.sessionId })[0]!.taskId;
      const accepted = fx.assembled.taskRegistry.get(taskId, SCOPE);
      // accepted 不是失败：任务仍在飞，但租约已清（等待期间不得被 expireLeases 判 result_unknown）。
      expect(taskMayBeRunningOf(accepted)).toBe(true);
      expect(accepted.leaseUntil).toBeUndefined();
      expect(fx.client.executeCalls).toHaveLength(1);
      expect(fx.client.waitCalls).toEqual(['op-1']);
      // 事件接上了（只进日志；不要求用户可见话术）。
      expect(fx.events.map((event) => event['event'])).toContain('execution_accepted');
      expect(fx.worker.delegations).toHaveLength(1);

      // 执行层报告完成 → 宿主唤醒 Worker 续跑 → 任务 completed，且不重复发起同一操作。
      fx.client.finish();
      await flush();
      await fx.assembled.runner!.whenIdle();

      const done = fx.assembled.taskRegistry.get(taskId, SCOPE);
      expect(archivedReportOf(done) !== undefined || (archivedReportOf(done) !== undefined || lastExecutionOf(done)?.status === 'completed')).toBe(true);
      expect(fx.client.executeCalls).toHaveLength(1);
      expect(fx.worker.delegations).toHaveLength(2);
      expect(done.replyText).toContain('导出完成，共 42 行');
    } finally {
      fx.close();
    }
  });
});
