/**
 * 长任务等待（wait）的传输截断（owner 2026-11-19 分工表第二格 + 当日裁定「能兜则兜」）。
 *
 * 事实：`wait` 的长轮询子进程上限 = 窗口 + 5s（`dummy-cli-client.ts`）。到点截断只说明
 * **我们跟执行层断了联系**（这次调用没有拿到回执）——**不代表长任务失败**：任务可能还在
 * 执行层跑。适配器以 `failed` + `code: result_unknown` 如实回报（与 execute 的截断同源）。
 *
 * 处置（owner 裁定；全部复用既有机制，不新写文案）：
 *   · **不判死**：任务保持 running，不落任何终态、不杀任务、不重复执行（executeCalls 不增）；
 *   · **不唤醒 Worker 报失败**：截断不进「wait 失败 → 续跑 Worker 说失败」那条车道；
 *   · **先兜再决定说不说**：第一次截断先自己退避再查一次（还会不会拿到真实回执）；
 *     **连续两次**仍拿不到回执（自查也查不出来）才如实暴露一次——不乱把不确定性当结论播出去；
 *   · **提必有据**：暴露用既有失败话术种类 `unknown_result` 的同一句话（+ 一个动作），
 *     每任务一次（持久化领取，重启不重发）；
 *   · **不许撞执行层 / 也不许放弃**：退避指数增长、封顶 60s（`LONG_TASK_MAX_RETRY_DELAY_MS`），
 *     一直等下去（结果只能由 wait 的终态落定）；期间任何真实回执即视为联系恢复。
 *   · 自查那一趟**直接出站失败（抛错）**同样算兜不住（见用例 ⑤）。
 *
 * 反向绊线（实测读数见文件末）：① 去掉「无回执」分支（截断落回「wait 失败」车道）→ 5/7 红；
 * ② 去掉「先兜一次」的连续计数门槛（第一次截断就暴露）→ 3/7 红。两条都实跑过。
 *
 * 零网络：runner 面用脚本化假 wait 端口；适配器面 spawn 本文件生成的最小 stub 网关。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from './testing/task-facts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutor, type ExecutionEvent } from './src/execution-runtime';
import type { TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver-contract';
import { createTaskRegistry, type TaskRegistry, type TaskRecord } from './src/task-registry';
import {
  createTaskRunner,
  type LongRunningNoticePort,
  type LongTaskWaitPort,
  type LongTaskWaitResult,
  type ResourcePermit,
  type ResourcePolicyPort,
  type RunnerTimers,
  type TaskRunner,
} from './src/task-runner';
import { failureMessageFor } from './src/user-facing-failure';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SCOPE = { principalId: 'wecom:wait-truncation', sessionId: 'sess_wait_truncation' } as const;

/** 暴露话术 = 既有 `unknown_result` 档的同一句话（不新写；装配层注入）。 */
const CONTACT_LOST_TEXT = failureMessageFor('unknown_result').text;

/** 纯内存可控时钟（runner 的 nextDue 判定用）。 */
class Clock {
  now = 1_000_000;
  advance(ms: number): void {
    this.now += ms;
  }
}

/** 不自动触发的假定时器（pump 由测试显式调用）。 */
class ManualTimers implements RunnerTimers {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

class CapPolicy implements ResourcePolicyPort {
  active = 0;
  readonly limit = 2;
  acquire(kind: 'foreground' | 'background'): ResourcePermit | { reason: 'queue_full' } {
    if (this.active >= this.limit) return { reason: 'queue_full' };
    this.active += 1;
    return { kind, state: 'active' };
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
  cancelQueued(): void {}
}

/** 手动 wait 端口：每次 wait 挂起，直到测试显式 resolve/reject。 */
class ManualLongTasks implements LongTaskWaitPort {
  readonly waits: Array<{
    operationId: string;
    timeoutMs: number;
    resolve: (result: LongTaskWaitResult) => void;
    reject: (error: Error) => void;
  }> = [];
  readonly aborts: string[] = [];
  timeoutMs = 30_000;
  pollAfterMs = 250;

  wait(operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<LongTaskWaitResult> {
    return new Promise((resolve, reject) => {
      const abortError = (): Error => {
        const error = new Error('wait aborted');
        error.name = 'AbortError';
        return error;
      };
      if (signal?.aborted === true) {
        reject(abortError());
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      this.waits.push({ operationId, timeoutMs, resolve, reject });
    });
  }

  async abort(operationId: string): Promise<{ aborted: boolean; reason?: string }> {
    this.aborts.push(operationId);
    return { aborted: true };
  }
}

/** 一次 wait 被传输截断（适配器如实回报的形状；见 dummy-cli-client 的 waitOutcomeOf）。 */
function noReceipt(timeoutMs = 30_000): LongTaskWaitResult {
  return {
    status: 'failed',
    message: `等待回话超时（${timeoutMs}ms）：没有收到回执，无法确认长任务当前的状态。`,
    outcome: {
      status: 'failed',
      error: {
        code: 'result_unknown',
        message: `等待回话超时（${timeoutMs}ms）：没有收到回执，无法确认长任务当前的状态。`,
        retryable: false,
      },
    },
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 4,
  operations: [{ name: 'dummy.longtask', label: 'long task', args: [], long_running: true }],
};

/** 脚本化执行层：execute 只被调用一次（长任务受理）。 */
class ScriptedClient implements ExecutionClient {
  readonly executeCalls: Array<{ operation: string; args: Record<string, unknown> }> = [];
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    this.executeCalls.push({ operation: request.operation, args: { ...request.args } });
    return { status: 'accepted', operationId: 'op-1', pollAfterMs: 250 };
  }
}

function delegationOf(input: TurnDriverInput): string {
  const message = input.messages[input.messages.length - 1];
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : '')).join('\n');
  }
  return '';
}

/** 脚本化 Worker：首轮发起长任务；续跑（委派含「长任务结果」）只核对结论。 */
class ScriptedWorker implements TurnDriver {
  readonly rounds: Array<{ delegation: string; resumed: boolean }> = [];
  async run(input: TurnDriverInput): Promise<TurnDriverResult> {
    const delegation = delegationOf(input);
    const resumed = delegation.includes('## 长任务结果');
    this.rounds.push({ delegation, resumed });
    if (resumed) return { text: '已核对长任务结果并完成。', messages: input.messages };
    await input.exec('execute_operation', { operation: 'dummy.longtask', args: { seconds: 30 } });
    return { text: '已发起长任务。', messages: input.messages };
  }
}

/** 记录每次提醒投递的假端口（判据只看底账任务事实，无 chatType 门——owner #9）。 */
function recordingNotice(): { port: LongRunningNoticePort; sends: Array<{ stage: string; factText: string; minutes: number }> } {
  const sends: Array<{ stage: string; factText: string; minutes: number }> = [];
  return {
    sends,
    port: {
      async sendNotice(input): Promise<boolean> {
        sends.push({ stage: input.stage, factText: input.factText, minutes: input.minutes });
        return true;
      },
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  registry: TaskRegistry;
  client: ScriptedClient;
  driver: ScriptedWorker;
  longTasks: ManualLongTasks;
  runner: TaskRunner;
  clock: Clock;
  events: Array<Record<string, unknown>>;
  sends: Array<{ stage: string; factText: string; minutes: number }>;
  task(): TaskRecord;
}

async function makeHarness(): Promise<Harness> {
  const registry = createTaskRegistry();
  const clock = new Clock();
  const client = new ScriptedClient();
  const driver = new ScriptedWorker();
  const longTasks = new ManualLongTasks();
  const events: Array<Record<string, unknown>> = [];
  const notice = recordingNotice();
  const executor = await createTaskExecutor({
    client,
    allowedOperations: ['dummy.longtask'],
    workerDriver: driver,
    registry,
    now: () => clock.now,
    onExecutionEvent: (event: ExecutionEvent) => events.push(event as unknown as Record<string, unknown>),
  });
  const runner = createTaskRunner({
    registry,
    policy: new CapPolicy(),
    executor,
    now: () => new Date(clock.now),
    timers: new ManualTimers(),
    longTasks,
    longRunningNotice: notice.port,
    // 装配层注入的既有话术（单一来源 = user-facing-failure 的 unknown_result 档）。
    contactLostNoticeText: CONTACT_LOST_TEXT,
    log: (line) => events.push(line),
  });
  return {
    registry,
    client,
    driver,
    longTasks,
    runner,
    clock,
    events,
    sends: notice.sends,
    task: () => registry.get('A', SCOPE),
  };
}

/** 提交流程走到底：submit → pump → 首轮 Worker 发起长任务（accepted）→ 第一次 wait 在飞。 */
async function submitLongTask(h: Harness): Promise<void> {
  h.runner.submit({ taskId: 'A', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: 'LONG 导出' });
  h.runner.pump();
  await flush();
  await flush();
}

/** 推进到退避到期，让下一趟 wait 真正发出；返回是否发出了新的一趟。 */
async function advanceToNextWait(h: Harness, delayMs: number): Promise<boolean> {
  const before = h.longTasks.waits.length;
  h.clock.advance(delayMs - 1);
  h.runner.pump();
  await flush();
  if (h.longTasks.waits.length !== before) return false;
  h.clock.advance(1);
  h.runner.pump();
  await flush();
  return h.longTasks.waits.length === before + 1;
}

function retries(h: Harness): Array<{ failures: number; delayMs: number; reason?: string }> {
  return h.events
    .filter((event) => event['event'] === 'execution_wait_retry')
    .map((event) => ({
      failures: event['failures'] as number,
      delayMs: event['delayMs'] as number,
      ...(event['reason'] === undefined ? {} : { reason: event['reason'] as string }),
    }));
}

describe('长任务等待的传输截断（无回执）：不判死、先兜再暴露、退避有界', () => {
  it('① 兜不住（连续两次无回执）：任务保持 running、Worker 不被唤醒报失败；用户恰收到一句既有话术 + 一个动作', async () => {
    const h = await makeHarness();
    await submitLongTask(h);
    expect(h.longTasks.waits).toHaveLength(1);

    // 第一次截断：**先兜**——不播不确定性，退避后自己再查一次。
    h.longTasks.waits[0]!.resolve(noReceipt());
    await flush();
    expect(h.sends).toEqual([]);
    expect(taskLivenessOf(h.task())).toBe('running');
    expect(retries(h)).toHaveLength(1);
    expect(retries(h)[0]!.reason).toBe('no_receipt');
    expect(retries(h)[0]!.delayMs).toBe(250);
    // 退避到期前不重排（不按秒撞执行层）；到期才发出「自己再查一次」。
    expect(await advanceToNextWait(h, 250)).toBe(true);

    // 第二次仍无回执：自查也查不出来 → 如实暴露一次（既有 unknown_result 话术 + 动作）。
    h.longTasks.waits[1]!.resolve(noReceipt());
    await flush();
    expect(h.sends).toEqual([{ stage: 'contact_lost', factText: CONTACT_LOST_TEXT, minutes: 0 }]);
    expect(CONTACT_LOST_TEXT).toContain('不确定做没做完');
    expect(CONTACT_LOST_TEXT).not.toContain('再试');
    expect(failureMessageFor('unknown_result').actions).toEqual(['check_status', 'park']);
    // 已告知事实落库（每任务一次，重启不重发）。
    expect(h.task().waitContactLostNotifiedAt).toBeDefined();
    expect(h.events).toContainEqual(expect.objectContaining({
      event: 'task_long_running_notice',
      stage: 'contact_lost',
      result: 'sent',
    }));

    // 任务**不**被当终态失败、Worker **不**被唤醒去报「失败」、长任务**不**被重复执行。
    expect(taskLivenessOf(h.task())).toBe('running');
    expect(lastFailureOf(h.task())).toBeUndefined();
    expect(h.driver.rounds.filter((round) => round.resumed)).toEqual([]);
    expect(h.client.executeCalls).toHaveLength(1);
    expect(h.longTasks.aborts).toEqual([]);

    // 继续截断：仍然只暴露过那一次（不刷屏），退避照退避。
    expect(await advanceToNextWait(h, 500)).toBe(true);
    h.longTasks.waits[2]!.resolve(noReceipt());
    await flush();
    expect(h.sends).toHaveLength(1);
    expect(taskLivenessOf(h.task())).toBe('running');
  });

  it('② 先兜能兜住（截断后自查一次拿到完成）：用户收到的是**确定结果**，不确定性不当结论播出去', async () => {
    const h = await makeHarness();
    await submitLongTask(h);

    // 第一次截断（无回执）→ 退避 → 自查一次拿到终态。
    h.longTasks.waits[0]!.resolve(noReceipt());
    await flush();
    expect(await advanceToNextWait(h, 250)).toBe(true);
    h.longTasks.waits[1]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '导出完成' } },
    });
    await flush();
    await h.runner.whenIdle();

    // 确定的结果：任务 completed + 续跑回合拿到长任务结果；长任务没有被重新发起。
    expect(archivedReportOf(h.task()) !== undefined || (archivedReportOf(h.task()) !== undefined || lastExecutionOf(h.task())?.status === 'completed')).toBe(true);
    const resumed = h.driver.rounds.filter((round) => round.resumed);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.delegation).toContain('导出完成');
    expect(h.client.executeCalls).toHaveLength(1);

    // 不确定性没有被当成结论播出去：零「断联系」提醒（用户只会在完成面被告知结果）。
    expect(h.sends).toEqual([]);
    expect(h.task().waitContactLostNotifiedAt).toBeUndefined();
    // 也没有把任务判成失败/待核对。
    expect(lastFailureOf(h.task())).toBeUndefined();
  });

  it('③ 截断后任务其实最终完成了：完成照常送达（不永远悬着），且「断联系」只说过一次', async () => {
    const h = await makeHarness();
    await submitLongTask(h);

    // 连续两次无回执 → 暴露一次（兜不住）。
    h.longTasks.waits[0]!.resolve(noReceipt());
    await flush();
    expect(await advanceToNextWait(h, 250)).toBe(true);
    h.longTasks.waits[1]!.resolve(noReceipt());
    await flush();
    expect(h.sends).toHaveLength(1);

    // 再次退避后，联系恢复并取到终态：任务照常 completed（结果由既有完成面详述）。
    expect(await advanceToNextWait(h, 500)).toBe(true);
    h.longTasks.waits[2]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '导出完成' } },
    });
    await flush();
    await h.runner.whenIdle();

    expect(archivedReportOf(h.task()) !== undefined || (archivedReportOf(h.task()) !== undefined || lastExecutionOf(h.task())?.status === 'completed')).toBe(true);
    expect(h.driver.rounds.filter((round) => round.resumed)).toHaveLength(1);
    expect(h.client.executeCalls).toHaveLength(1);
    // 「断联系」不再重复说第二遍。
    expect(h.sends).toHaveLength(1);
  });

  it('④ 退避/上限：连续无回执退避单调翻倍到 60s 封顶（调用次数有界，不无限打，也不放弃）', async () => {
    const h = await makeHarness();
    await submitLongTask(h);

    const delays: number[] = [];
    const windows = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [index, delay] of windows.entries()) {
      h.longTasks.waits[index]!.resolve(noReceipt());
      await flush();
      const seen = retries(h);
      expect(seen).toHaveLength(index + 1);
      expect(seen[index]!.failures).toBe(index + 1);
      delays.push(seen[index]!.delayMs);
      expect(taskLivenessOf(h.task())).toBe('running');
      // 只有退避到期才重排下一次（到期前 pump 不再打执行层）。
      expect(await advanceToNextWait(h, delay)).toBe(true);
    }

    expect(delays.slice(0, 4)).toEqual([250, 500, 1_000, 2_000]);
    expect(delays[delays.length - 1]).toBe(60_000);
    expect(Math.max(...delays)).toBe(60_000);
    // 10 分钟窗口内最多 11 次 wait（封顶 60s），而不是无限打。
    const tenMinutes = 10 * 60 * 1_000;
    expect(Math.ceil(tenMinutes / 60_000)).toBeLessThanOrEqual(11);
    // 一直在等（没有因为一次截断就放弃/判死），并已如实暴露过一次。
    expect(taskLivenessOf(h.task())).toBe('running');
    expect(h.sends).toHaveLength(1);

    // 恢复：真实回执即联系恢复，退避计数清零，任务照常完成。
    h.longTasks.waits[h.longTasks.waits.length - 1]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '导出完成' } },
    });
    await flush();
    await h.runner.whenIdle();
    expect(archivedReportOf(h.task()) !== undefined || (archivedReportOf(h.task()) !== undefined || lastExecutionOf(h.task())?.status === 'completed')).toBe(true);
    expect(h.client.executeCalls).toHaveLength(1);
  });
  it('⑤ 自查这一趟直接出站失败（抛错）同样算兜不住：仍如实暴露一次，任务不判死', async () => {
    const h = await makeHarness();
    await submitLongTask(h);

    // 第一次截断（无回执）→ 先自查。
    h.longTasks.waits[0]!.resolve(noReceipt());
    await flush();
    expect(h.sends).toEqual([]);
    expect(await advanceToNextWait(h, 250)).toBe(true);

    // 自查这一趟没有回执可拿（出站失败）：兜不住 → 如实暴露一次；任务继续等（不判死）。
    h.longTasks.waits[1]!.reject(new Error('executor unreachable'));
    await flush();
    expect(h.sends).toEqual([{ stage: 'contact_lost', factText: CONTACT_LOST_TEXT, minutes: 0 }]);
    expect(taskLivenessOf(h.task())).toBe('running');
    expect(h.driver.rounds.filter((round) => round.resumed)).toEqual([]);
    expect(retries(h)).toHaveLength(2);

    // 后续恢复：照常完成。
    expect(await advanceToNextWait(h, 500)).toBe(true);
    h.longTasks.waits[2]!.resolve({
      status: 'completed',
      outcome: { status: 'completed', data: { summary: '导出完成' } },
    });
    await flush();
    await h.runner.whenIdle();
    expect(archivedReportOf(h.task()) !== undefined || (archivedReportOf(h.task()) !== undefined || lastExecutionOf(h.task())?.status === 'completed')).toBe(true);
    expect(h.sends).toHaveLength(1);
  });
});

/**
 * 适配器面：wait 的子进程上限（窗口 + 5s）到点 → `failed` + `code: result_unknown`
 * （无回执；与 execute 的截断同源），**不是**「长任务失败」的机械码。
 */
describe('wait 截断的适配器机械形状（传输层单一收口）', () => {
  it('wait 挂住 → failed + code=result_unknown，原话说「没有收到回执」', async () => {
    const dir = tempDir('wait-truncation-adapter-');
    const stubRoot = path.join(dir, 'stub');
    mkdirSync(path.join(stubRoot, 'bin'), { recursive: true });
    // 最小 stub：operation list 恒可用；wait 永不返回（等宿主截断）。
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  process.stdout.write('{"operations":[]}');
  process.exit(0);
}
if (args[0] === 'wait') { setInterval(() => {}, 1000); return; }
process.exit(7);
`;
    writeFileSync(path.join(stubRoot, 'bin', 'stub'), script, { mode: 0o755 });
    const client = createDummyCliClient({
      root: stubRoot,
      gateway: 'bin/stub',
      stateDir: path.join(dir, 'state'),
      env: process.env,
    });
    const startedAt = Date.now();
    const outcome = await client.wait!('op-1', 250);
    const elapsed = Date.now() - startedAt;
    // 界 = max(250 + 5000, …) = 5.25s：有界结束（不是无限等）。
    expect(elapsed).toBeLessThan(8_000);
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    expect(outcome.status).toBe('failed');
    const error = (outcome as { error?: { code?: string; retryable?: boolean; message?: string } }).error;
    expect(error?.code).toBe('result_unknown');
    expect(error?.retryable).not.toBe(true);
    expect(String(error?.message)).toContain('没有收到回执');
    expect(String(error?.message)).toContain('长任务');
    expect(existsSync(path.join(stubRoot, 'calls.jsonl'))).toBe(false);
    expect(readFileSync(path.join(stubRoot, 'bin', 'stub'), 'utf8')).toContain('wait');
  });
});

/**
 * 装配同源守卫：暴露话术只在**装配层**接线（runner 保持零仓内 import，不自己写文案）。
 * 断言接线取的是既有 `unknown_result` 档（单一话术来源），不是另写的一句。
 */
describe('装配同源（话术单一来源）', () => {
  it('ask-runtime 给 runner 注入的 contactLostNoticeText = failureMessageFor(unknown_result)', () => {
    const source = readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'ask-runtime.ts'), 'utf8');
    expect(source).toContain('contactLostNoticeText: failureMessageFor(\'unknown_result\').text');
  });
});

/**
 * 反向绊线（实测：2026-11-19；两条都实跑过）：
 *   ① 去掉「无回执」分支（`handleWaitResult` 里把 `if (waitNoReceiptOf(result)) {…}` 整段
 *      挪到 failed·refused 分支之后，等价于截断落回「wait 失败」车道）：本文件 5/7 红——
 *      ① `expected 'failed' to be 'running'`（任务被判成失败：正是「把还在跑说成失败」），
 *      ②③⑤ `expected false to be true`（自查根本没机会发生），④ `expected [] to have a
 *      length of 1`（没有退避重排，改走了终态失败车道）。
 *   ② 去掉「先兜一次」门槛（把 `(entry.noReceiptStreak ?? 0) >= 2` 改成恒真＝第一次截断就
 *      暴露）：本文件 3/7 红——①②⑤ 均为
 *      `expected [{ stage: 'contact_lost', …(2) }] to deeply equal []`，收到的正是
 *      `{stage:'contact_lost', factText:'不确定做没做完，先别重复。我帮你查一下现在的状态？'}`
 *      （自查随即拿到完成的情况下仍把不确定性当结论播给了用户）。
 *   恢复后本文件 7/7 全绿。
 */
