/**
 * 单次执行层调用的传输超时（owner 2026-11-19 分工表第一格）。
 *
 * 归属：**执行层调用挂住** → 单次调用的传输超时（缺省 60s）→ 一次明确的结束（有界），
 * 但语义是「结果未知」——截断后我们**不知道**执行层那边做没做完（写操作可能已经生效），
 * 所以不冒充「失败已确认」、不自动重试，交用户核对。不是任务总时长/回合总时长/到点杀任务。
 *
 * 界在哪（调研结论）：唯一的界在传输适配器 `dummy-cli-client.ts` 的 `runGateway` 定时器
 * （`DummyCliClientOptions.timeoutMs ?? EXECUTION_CALL_TIMEOUT_MS`，缺省 60s；2026-11-19 前
 * 即为既有旋钮，见 docs/product/real-read-readiness.md「单次适配器调用缺省 60s」）。
 * 本切片不新增配置键、不新增第二个定时器，只把「截断」的语义从「已确认失败（且声明可重试）」
 * 改成宿主既有的「结果未知」（账行 unknown / 任务 reason=result_unknown / 不重试）。
 *
 * 覆盖（每条配反向绊线；实测读数见文件末）：
 *   ① 执行层永不返回 → 调用在有界时间内结束；账行落 unknown（不是 failed）、任务落
 *      failed+reason=result_unknown、结构化事件 `execution_result_unknown`、用户拿到
 *      unknown_result 一句话 + 动作（check_status，不是「再试一次」）；
 *   ② 正常返回不受影响：缺省界（60s）下 2s 的慢调用**不被截断**；缺省界常量 = 60s；
 *   ③ 超时后的语义不是「失败已确认」：code=result_unknown / retryable 非 true，
 *      同回合同对象第二次调用被 A2b 拦下（零二次发起，gateway 只收到一次）；
 *   ①b 后台单回合执行器（TaskExecutor）走同一条语义与同一条事件（前台/后台同出口）；
 *   ④ 反向绊线：把 `runGateway` 的界去掉 → ① 必红（vitest 超时），实测见文件末。
 *
 * 零网络：spawn 的是本文件生成的最小 stub 网关（只认 `operation list` 与 `call`）。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from './testing/task-facts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionClient, ExecutionRequest } from '@fshine/contracts/execution-contract';
import { createDummyCliClient, EXECUTION_CALL_TIMEOUT_MS } from './src/dummy-cli-client';
import {
  EXECUTE_OPERATION_TOOL,
  createSession,
  createTaskExecutor,
  type ExecutionEvent,
  type Session,
} from './src/execution-runtime';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';
import { classifyFailure, failureMessageFor } from './src/user-facing-failure';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 写操作（对象参数取 --collection；A2b 锁键用它）。执行层永不返回时它就是「可能已生效」的那个。 */
const WRITE_OP = 'stub.commit';
const WRITE_ARGS = { operation: WRITE_OP, args: { '--collection': 'docs' } };
/** 测试用的传输界（真实缺省见 EXECUTION_CALL_TIMEOUT_MS = 60s；注入只为用例快）。 */
const TEST_TIMEOUT_MS = 250;

/**
 * 最小 stub 网关：`operation list --json` 恒可用；`call` 按 mode 决定
 *   · 'hang'   —— 永不返回（执行层挂住），宿主截断后收到 SIGTERM 时落 `terminated.txt`；
 *   · 'slow'   —— 延迟后返回 completed（正常但慢的调用）。
 * 每次 call 追加一行到 `<stubRoot>/calls.jsonl`（计数「真正到达执行层的次数」）。
 */
function writeStubGateway(stubRoot: string, mode: 'hang' | 'slow', slowDelayMs = 2_000): void {
  mkdirSync(path.join(stubRoot, 'bin'), { recursive: true });
  const operations = [
    { name: WRITE_OP, access: 'write', args: { flags: [{ flag: '--collection', required: false, style: 'name' }] } },
  ];
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args[0] === 'operation' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(${JSON.stringify({ operations })}));
  process.exit(0);
}
if (args[0] === 'call') {
  const file = args[args.indexOf('--file') + 1];
  const call = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.appendFileSync(path.join(__dirname, '..', 'calls.jsonl'), JSON.stringify({ operation: call.operation }) + '\\n');
  if (mode === 'hang') {
    process.on('SIGTERM', () => { fs.writeFileSync(path.join(__dirname, '..', 'terminated.txt'), 'sigterm'); process.exit(0); });
    setInterval(() => {}, 1000);  // 永不返回（等宿主截断）
  } else {
    setTimeout(() => { process.stdout.write('RESULT {"status":"completed","data":{"ok":true}}\\n'); process.exit(0); }, ${slowDelayMs});
  }
  return;
}
process.exit(7);
`;
  writeFileSync(path.join(stubRoot, 'bin', 'stub'), script, { mode: 0o755 });
}

function callsLogged(stubRoot: string): number {
  const logPath = path.join(stubRoot, 'calls.jsonl');
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
}

interface TimeoutFixture {
  session: Session;
  registry: TaskRegistry;
  events: ExecutionEvent[];
  /** Worker 面 execute_operation 的成功返回（超时用例里应为空）。 */
  workerResults: unknown[];
  /** Worker 面 execute_operation 的抛错原文（按发生顺序）。 */
  workerErrors: string[];
  /** Main 面 task_run 的工具返回（即交办回执）。 */
  taskReceipts: unknown[];
  /** 到达适配器的请求（断言只发起过一次、拿 dispatchKey 读账行）。 */
  requests: ExecutionRequest[];
  stubRoot: string;
  close(): void;
}

async function makeFixture(input: { mode: 'hang' | 'slow'; timeoutMs?: number }): Promise<TimeoutFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'call-timeout-'));
  tempDirs.push(dir);
  const stubRoot = path.join(dir, 'stub');
  writeStubGateway(stubRoot, input.mode);
  const registry = createTaskRegistry();
  const requests: ExecutionRequest[] = [];
  const inner = createDummyCliClient({
    root: stubRoot,
    gateway: 'bin/stub',
    stateDir: path.join(dir, 'state'),
    env: process.env,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const client: ExecutionClient = {
    ...inner,
    execute: async (request, options) => {
      requests.push(request);
      return await inner.execute(request, options);
    },
  };
  const events: ExecutionEvent[] = [];
  const workerResults: unknown[] = [];
  const workerErrors: string[] = [];
  const taskReceipts: unknown[] = [];
  // Worker 回合：同一对象连发两次（第二次应被 A2b 同对象失败锁拦在发起前）。
  const workerDriver: TurnDriver = {
    async run(driverInput): Promise<TurnDriverResult> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          workerResults.push(await driverInput.exec(EXECUTE_OPERATION_TOOL, WRITE_ARGS));
        } catch (error) {
          workerErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const text = '这件事没办成。';
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text, messages: [message] } as unknown as TurnDriverResult;
    },
  };
  const mainDriver: TurnDriver = {
    async run(driverInput): Promise<TurnDriverResult> {
      taskReceipts.push(await driverInput.exec('task_run', { task: '把 docs 提交到生产' }));
      const text = '交办完了。';
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text, messages: [...driverInput.messages, message] } as unknown as TurnDriverResult;
    },
  };
  const session = await createSession({
    principalId: 'wecom:call-timeout',
    sessionId: 'sess_call_timeout',
    client,
    allowedOperations: [WRITE_OP],
    mainDriver,
    workerDriver,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    onExecutionEvent: (event) => events.push(event),
  });
  return {
    session,
    registry,
    events,
    workerResults,
    workerErrors,
    taskReceipts,
    requests,
    stubRoot,
    close: () => {},
  };
}

describe('单次执行层调用的传输超时（有界 + 结果未知）', () => {
  it('① 执行层永不返回：调用在有界时间内结束，账行 unknown / 任务 result_unknown / 事件 / 用户一句话 + 动作', async () => {
    const fx = await makeFixture({ mode: 'hang', timeoutMs: TEST_TIMEOUT_MS });
    try {
      const startedAt = Date.now();
      await fx.session.send('把 docs 提交到生产');
      const elapsed = Date.now() - startedAt;
      // 有界：界 250ms；整回合（两次 Worker 工具调用 + 收尾）远小于「无限等」。
      expect(elapsed).toBeLessThan(5_000);
      // 被截断的传输工作真的收掉了（挂住的子进程等到 SIGTERM），不是只在宿主侧放弃等待。
      await vi.waitFor(() => {
        expect(existsSync(path.join(fx.stubRoot, 'terminated.txt'))).toBe(true);
      });

      // 交办回执：不是成功、也不是「已确认失败」——结果待核对。
      const receipt = fx.taskReceipts[0] as Record<string, unknown>;
      expect(receipt['resultUnknown']).toBe(true);
      expect(String(receipt['summary'])).toContain('待核对');
      expect(String(receipt['notice'])).toContain('核对');

      // 任务底账：failed + reason=result_unknown（不是 failed_confirmed）。
      const task = fx.session.tasks()[0]!;
      const scope = { principalId: 'wecom:call-timeout', sessionId: 'sess_call_timeout' };
      const record = fx.registry.get(task.taskId, scope);
      expect(['failed', 'refused']).toContain(lastExecutionOf(record)?.status);
      expect((lastFailureOf(record)?.error?.code === 'result_unknown' || record.diedAt !== undefined)).toBe(true);

      // 逻辑操作账行：unknown（不冒充 failed），且 outcome 里留着超时原话。
      expect(fx.requests).toHaveLength(1);
      const dispatchKey = fx.requests[0]!.dispatchKey;
      const operationRow = fx.registry.getOperation(dispatchKey)!;
      expect(operationRow.status).toBe('unknown');
      expect(operationRow.reason).toBe('result_unknown');
      expect((operationRow.outcome as { error?: { message?: string } }).error?.message).toContain('超时');

      // 结构化事件：一次真实发起的调用以结果未知收尾，必须有记录（只进日志）。
      expect(fx.events).toContainEqual({
        event: 'execution_result_unknown',
        taskId: task.taskId,
        operation: WRITE_OP,
      });

      // 用户话术：既有 unknown_result 模板（不新写）+ 一个可做的动作；不得出现「再试一次」。
      const kind = classifyFailure({ code: 'result_unknown', status: 'failed' });
      expect(kind).toBe('unknown_result');
      const message = failureMessageFor(kind);
      expect(message.text).toContain('不确定做没做完');
      expect(message.text).toContain('先别重复');
      expect(message.text).not.toContain('再试');
      expect(message.actions).toEqual(['check_status', 'park']);
    } finally {
      fx.close();
    }
  });

  it('② 正常返回不受影响：缺省界（60s）下 2s 的慢调用不被截断；缺省界常量 = 60s', async () => {
    // 缺省界本身（模块常量，复用既有旋钮缺省；不新增配置键）。
    expect(EXECUTION_CALL_TIMEOUT_MS).toBe(60_000);

    // 不注入 timeoutMs = 生产缺省界；stub 延迟 2s（正常但慢的调用）→ 必须完整返回。
    const fx = await makeFixture({ mode: 'slow' });
    try {
      const startedAt = Date.now();
      await fx.session.send('把 docs 提交到生产');
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(2_000);
      expect(fx.workerErrors).toEqual([]);
      // 两次调用都完整返回（正常但慢 = 等它跑完，不截断）。
      expect(fx.workerResults).toEqual([
        { status: 'completed', data: { ok: true } },
        { status: 'completed', data: { ok: true } },
      ]);
      expect(lastExecutionOf(fx.session.tasks()[0]!)?.status).toBe('completed');
    } finally {
      fx.close();
    }
  });

  it('③ 超时后的语义不是「失败已确认」：code=result_unknown / retryable 非 true；同对象第二次调用零发起', async () => {
    const fx = await makeFixture({ mode: 'hang', timeoutMs: TEST_TIMEOUT_MS });
    try {
      await fx.session.send('把 docs 提交到生产');

      // 任务底账里的执行事实：如实是 result_unknown（不是某个「已确认失败」码），
      // 且适配器没有声明可重试（retryable 非 true = 不导向同对象重试）。
      const task = fx.session.tasks()[0]!;
      const scope = { principalId: 'wecom:call-timeout', sessionId: 'sess_call_timeout' };
      const execution = fx.registry.get(task.taskId, scope).executions[0]!;
      expect(execution.status).toBe('failed');
      expect(execution.error?.code).toBe('result_unknown');
      expect(execution.error?.retryable).not.toBe(true);

      // A2b 同对象失败锁照旧生效：同回合第二次（同对象）调用在发起前被拦下——
      // 只有一次请求到达适配器，gateway 也只收到一次调用（calls.jsonl 一行）。
      expect(fx.requests).toHaveLength(1);
      expect(callsLogged(fx.stubRoot)).toBe(1);
      expect(fx.workerResults).toEqual([]);
      expect(fx.workerErrors).toHaveLength(2);
      expect(fx.workerErrors[1]).toContain('不要再换参数重试');
    } finally {
      fx.close();
    }
  });
  it('①b 后台单回合执行器（TaskExecutor）：同一条语义、同一条事件（与前台同出口）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'call-timeout-bg-'));
    tempDirs.push(dir);
    const stubRoot = path.join(dir, 'stub');
    writeStubGateway(stubRoot, 'hang');
    const registry = createTaskRegistry();
    const events: ExecutionEvent[] = [];
    const client = createDummyCliClient({
      root: stubRoot,
      gateway: 'bin/stub',
      stateDir: path.join(dir, 'state'),
      env: process.env,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const workerDriver: TurnDriver = {
      async run(driverInput): Promise<TurnDriverResult> {
        try {
          await driverInput.exec(EXECUTE_OPERATION_TOOL, WRITE_ARGS);
        } catch {
          // ToolUserError：待核对确定性终结本次工具调用。
        }
        const text = '这件事没办成。';
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp: Date.now(),
        } as unknown as DriverMessage;
        return { text, messages: [message] } as unknown as TurnDriverResult;
      },
    };
    const executor = await createTaskExecutor({
      client,
      allowedOperations: [WRITE_OP],
      workerDriver,
      registry,
      workerTurnMs: 30_000,
      onExecutionEvent: (event) => events.push(event),
    });
    const startedAt = Date.now();
    // 后台行的创建归 runner；本用例直测执行器，手动落 running 行。
    registry.begin({
      taskId: 't_timeout',
      principalId: 'wecom:call-timeout',
      sessionId: 'sess_call_timeout',
      request: '把 docs 提交到生产',
    });
    const outcome = await executor.execute({
      taskId: 't_timeout',
      request: '把 docs 提交到生产',
      principalId: 'wecom:call-timeout',
      sessionId: 'sess_call_timeout',
    }, { signal: new AbortController().signal });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.kind).toBe('result_unknown');
    expect(events).toContainEqual({ event: 'execution_result_unknown', taskId: 't_timeout', operation: WRITE_OP });
    expect(registry.get('t_timeout', { principalId: 'wecom:call-timeout', sessionId: 'sess_call_timeout' })
      .executions[0]?.error?.code).toBe('result_unknown');
  });
});

describe('适配器结局的机械形状（传输层单一收口）', () => {
  it('execute 超时 → failed + code=result_unknown + 超时原话，且不声明 retryable:true', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'call-timeout-adapter-'));
    tempDirs.push(dir);
    const stubRoot = path.join(dir, 'stub');
    writeStubGateway(stubRoot, 'hang');
    const client = createDummyCliClient({
      root: stubRoot,
      gateway: 'bin/stub',
      stateDir: path.join(dir, 'state'),
      env: process.env,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const startedAt = Date.now();
    const outcome = await client.execute({
      requestId: 'req_timeout',
      dispatchKey: 'dk_test_timeout',
      operation: WRITE_OP,
      args: { '--collection': 'docs' },
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.status).toBe('failed');
    const error = (outcome as { error?: { code?: string; retryable?: boolean; message?: string } }).error;
    expect(error?.code).toBe('result_unknown');
    expect(error?.retryable).not.toBe(true);
    expect(String(error?.message)).toContain('超时');
  });
});

/**
 * ④ 反向绊线（实测：2026-11-19）：
 *   把 `packages/agent/src/dummy-cli-client.ts` 的 `runGateway` 定时器去掉（删掉
 *   `timer = setTimeout(...)` 与 `if (timer !== undefined) clearTimeout(timer)`——
 *   `timedOut` 分支即不可达），本文件挂住相关的 4 条用例必然红：`session.send` / `execute`
 *   等一个永不返回的 stub，实测四条均为 `Test timed out in 30000ms`（用例断言一字未改）；
 *   ②（2s 慢调用正常返回）仍绿——它证明的正是「界没有误伤正常调用」，不构成对 ① 的替代。
 *   恢复定时器后本文件 5/5 全绿。
 */
