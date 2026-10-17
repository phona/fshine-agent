/**
 * 离线全链 e2e：worker 执行超时路径（功能规格验收第 7 条）。
 *
 * 这条链此前零测试：worker 跑过 deadline → 宿主分类（context.ts 的 catch，取消先于
 * 超时先于 auth 先于 executor_error）→ 超时/失败也持久化中间转录（taskId 断点续跑的
 * 资本）→ 用户拿到 DELEGATION_TIMEOUT_FAILURE 话术。真实驱动对 deadline 的契约是
 * "到点即收、**返回**不抛"（pi-coding-driver.ts :714 起的 remaining/abortTimer，
 * :766-770 的超时返回形状：text 可能为空、转录照常带回），替身按同一契约复刻。
 *
 * 三个用例各开一个 boot（harness 的 counter 给每用例独立的平台状态文件）：
 *   WT-1 超时终稿与留痕：话术一字不差、delegation_span 记 failed/timeout、
 *        platform_tasks 条目 outcome=failed 且 workerMessages 非空；
 *   WT-2 超时后续跑：同一会话下一回合带 continueTaskId 重派，第二个 worker 收到的
 *        转录包含超时回合持久化的断点（不重付从零），回复含真实结果；
 *   WT-3 中止与超时同刻成立：分类必须判取消优先，用户收到 DELEGATION_CANCELLED。
 *
 * 替身边界（与 harness 同哲学，只假模型与平台执行器）：
 *   - Main Agent/worker 都是脚本化替身；handler、runtime 的回合契约、ContextTaskRunner、
 *     SQLite 底账全是生产代码。
 *   - WT-2 的编号接线：超时回合的失败话术（工具结果）里**没有** taskId——harness
 *     mainDriver 的 lastTaskId 只从成功结果学，断点续跑的编号事实只存在于宿主持有的
 *     platform_tasks 底账里。所以替身在两回合之间从底账取编号代填 continueTaskId
 *     （"模型怎么拿到失败任务的编号"是另一条路的事，本用例钉的是宿主的续跑契约本身）。
 *   - WT-3 的中止时机：生产里中止信号由主驱动按 runtime 的回合预算派生（runtime 把
 *     `deadline: turnDeadline` 交给驱动，pi-driver.ts :114 转 AbortSignal）。回合预算 =
 *     workerTimeoutMs + 固定 120s 收尾余量（turnBudgetMsFor，assembly.ts :250 接线），
 *     配置上**恒比 worker 截止长**——无法用 config 让预算先于 worker 截止到期。因此
 *     替身驱动在 60ms（≪250ms 截止）主动 abort 并把信号传进 exec：中止时机本来就是
 *     驱动侧策略，宿主链路（runtime 透传信号 → context.ts 分类 → 话术成为回复）原样
 *     走生产代码。worker 替身刻意**不响应**中止、睡到截止才返回——要钉的正是
 *     "signal.aborted 与超时同刻成立时，分类判取消优先"这个顺序。
 */
import { describe, expect, it } from 'vitest';
import { messageTextFor } from '../../packages/agent/src/error-codes';
import { LAST_TASK_ID_TOKEN, boot, mainDriver, type Boot } from './harness';

/** 企微单聊：principal 由 userid 解析，conversationId = chatid ?? userid（与 write-chain 同口径）。 */
const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user:e2e_user';

/** 第一回合（超时回合）的用户消息与 Main Agent 加工后的委派请求。 */
const USER_ASK = '查一下幻辰财税 202609 的应收账款余额';
const DELEGATE_ASK = '查询幻辰财税 202609 的应收账款余额';
/** 第二回合（续跑回合）：用户补充了新期间，模型带 continueTaskId 重派同一任务。 */
const RESUME_USER_ASK = '再查一次幻辰财税 202606';
const RESUME_DELEGATE_ASK = '查询幻辰财税 202606 的应收账款余额';

/** 超时替身留在转录里的部分进展：续跑断言靠它认出"断点不是从零开始"。 */
const PARTIAL_TRANSCRIPT = '（部分转录）已向平台发起 202609 期间的查询，等待返回中。';
/** 续跑回合 worker 替身的正常结果文本（用户最终看到的回复）。 */
const RESUMED_ANSWER = '幻辰财税 202606 的应收账款余额为 1,234.56 元。';

/** patchProfile 打进 contextProfiles['17dz'] 的 worker 超时（毫秒级，离线夹具不引入秒级等待）。 */
const WORKER_TIMEOUT_MS = 250;
/** 超时替身睡过截止多少毫秒才返回：模拟"驱动到点后收尾"的少量开销，ε 必须 > 0 否则 Date.now() 可能还压着 deadline。 */
const PAST_DEADLINE_EPSILON_MS = 15;
/** WT-3 里替身主驱动主动中止的时刻：早于 worker 截止，两个判据才能在分类时刻同时成立。 */
const ABORT_AFTER_MS = 60;

interface WorkerRunInput {
  messages: Array<{ role: string; content: unknown; timestamp?: number }>;
  deadline?: number;
  signal?: AbortSignal;
}

interface MainRunInput {
  tools: unknown[];
  messages: unknown[];
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/** worker 替身每次 run 留下的观察：deadline/信号到达证据与宿主交进来的完整转录。 */
interface WorkerRunObservation {
  deadline: number | undefined;
  signalGiven: boolean;
  signalAbortedAtReturn: boolean;
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * 按脚本走的 worker 替身。'timeout' 步复刻真实驱动的 deadline 契约：睡到 deadline+ε
 * 再**返回**（不是抛）空文本 + 部分转录；{ complete } 步正常完成。超时步刻意无视中止
 * 信号——WT-3 要的形状是"信号已中止、worker 仍跑到截止"，两类判据同刻成立。
 */
function scriptedWorker(steps: Array<'timeout' | { complete: string }>, partialTranscript: string) {
  const runs: WorkerRunObservation[] = [];
  let cursor = 0;
  return {
    runs,
    driver: {
      run: async (input: WorkerRunInput) => {
        const step = steps[Math.min(cursor, steps.length - 1)]!;
        cursor += 1;
        const observation: WorkerRunObservation = {
          deadline: input.deadline,
          signalGiven: Boolean(input.signal),
          signalAbortedAtReturn: false,
          messages: input.messages,
        };
        runs.push(observation);
        // 收尾时刻（不是进场时刻）才读中止状态：WT-3 要的就是"收尾那一刻信号已中止"
        // 的证据，进场时它还是 false。
        const noteAbort = () => { observation.signalAbortedAtReturn = input.signal?.aborted === true; };
        if (step === 'timeout') {
          const remain = (input.deadline ?? Date.now()) + PAST_DEADLINE_EPSILON_MS - Date.now();
          if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
          noteAbort();
          return {
            text: '',
            messages: [...input.messages, { role: 'assistant', content: partialTranscript, timestamp: Date.now() }],
          };
        }
        noteAbort();
        return {
          text: step.complete,
          // 执行面回执与真实 worker 同形状（激活过计划 + 真跑过调用才有）；没有它，
          // context.ts 会把这次有文本的完成记成 outcome=failed（零执行标注），任务条目
          // 的终态就说不通了。
          execution: { planId: 'plan_resume_e2e', version: 1, calls: 1 },
          messages: [...input.messages, { role: 'assistant', content: step.complete, timestamp: Date.now() }],
        };
      },
    },
  };
}

/** 捕获宿主审计事件（JSON 行的 event 字段），与 turn-loop-platform-health 同手法。 */
function captureEvents(): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (line: string) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed['event'] === 'string') events.push(parsed);
    } catch { /* 非 JSON 行 */ }
  };
  return { events, restore: () => { console.info = original; } };
}

/** 与 harness mainDriver 同形状的一条申报转录：assistant(toolCall) + toolResult。 */
function toolCallMessages(transcript: unknown[], callId: string, declaration: Record<string, unknown>): void {
  transcript.push({
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: declaration }],
    timestamp: Date.now(),
  } as never);
}

function toolResultMessages(transcript: unknown[], callId: string, text: string): void {
  transcript.push({
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'route_current_turn',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as never);
}

/**
 * WT-2 的 Main Agent 替身：第 1 回合申报委派（撞超时），第 2 回合申报同任务续跑。
 * continueTaskId 写 LAST_TASK_ID_TOKEN，代填来源是测试在两回合之间从 platform_tasks
 * 底账填进盒子的编号（理由见文件头注释）。
 */
function resumeMainDriver(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  taskIdBox: { value: string },
) {
  let turn = 0;
  return {
    run: async (input: MainRunInput) => {
      turn += 1;
      const source = turn === 1 ? first : second;
      const declaration: Record<string, unknown> = { ...source };
      if (declaration['continueTaskId'] === LAST_TASK_ID_TOKEN) declaration['continueTaskId'] = taskIdBox.value;
      const transcript: unknown[] = [...input.messages];
      const callId = `call_t${turn}`;
      toolCallMessages(transcript, callId, declaration);
      try {
        const outcome = await input.exec('route_current_turn', declaration);
        toolResultMessages(transcript, callId, JSON.stringify(outcome));
        return { text: '主 Agent 自由文本：不应外发', messages: transcript };
      } catch (error) {
        // 与 harness mainDriver 同一兜底：委派以安全话术终止时，那段文本就是模型这轮的
        // 回复（真实驱动里是 terminate 语义，模型不再说话）。
        toolResultMessages(transcript, callId, (error as Error).message);
        return { text: (error as Error).message, messages: transcript };
      }
    },
  };
}

/**
 * WT-3 的 Main Agent 替身：申报一次委派，并在 ABORT_AFTER_MS 后主动中止、把自持的
 * AbortSignal 传进 exec。契约与真实主驱动一致（deadline/预算到期 → abort → 信号随
 * 工具调用下传）；提前到的只是"预算到期"这件事本身（文件头注释：回合预算恒比 worker
 * 截止长，config 无法把生产的中止摆到截止之前）。
 */
function abortingMainDriver(declaration: Record<string, unknown>, abortAfterMs: number) {
  return {
    run: async (input: MainRunInput) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), abortAfterMs);
      const transcript: unknown[] = [...input.messages];
      const callId = 'call_abort';
      toolCallMessages(transcript, callId, declaration);
      try {
        const outcome = await input.exec('route_current_turn', declaration, controller.signal);
        toolResultMessages(transcript, callId, JSON.stringify(outcome));
        return { text: '主 Agent 自由文本：不应外发', messages: transcript };
      } catch (error) {
        toolResultMessages(transcript, callId, (error as Error).message);
        return { text: (error as Error).message, messages: transcript };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 任务底账读取（真 SQLite store）：listBySession(principal, 单聊会话)。 */
async function platformTasksOf(booted: Boot) {
  return booted.assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION);
}

describe('离线全链 e2e：worker 执行超时（功能规格验收第 7 条）', () => {
  it('WT-1 worker 跑过截止后返回空稿：用户收到超时话术，span 记 failed/timeout，任务留痕带部分转录', async () => {
    const worker = scriptedWorker(['timeout'], PARTIAL_TRANSCRIPT);
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: mainDriver([{ kind: 'delegate', request: DELEGATE_ASK }]),
        worker: worker.driver as never,
        patchProfile: { workerTimeoutMs: WORKER_TIMEOUT_MS },
      });

      const reply = await booted.send(USER_ASK);

      // ① 终稿一字不差 = error-codes 表的超时话术（唯一来源，不手抄第二份）
      expect(reply).toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));

      // ② 审计留痕：delegation_span 记 failed + timeout（失败的分类可行动：超时是
      // "稍后再试"，与执行器错误/登录态话术必须是不同的句子）
      const span = audit.events.find((event) => event['event'] === 'delegation_span');
      expect(span).toBeDefined();
      expect(span!['outcome']).toBe('failed');
      expect(span!['failureClass']).toBe('timeout');
      const taskId = span!['taskId'];
      expect(taskId).toMatch(/^task_/);

      // ③ 底账留痕：任务条目 outcome=failed，workerMessages 非空——超时也要持久化中间
      // 转录，taskId 断点续跑才有的续（长任务业务稳定性的关键，context.ts catch 里的
      // upsert 分支此前零覆盖）。
      const record = (await platformTasksOf(booted)).find((entry) => entry.taskId === taskId);
      expect(record).toBeDefined();
      expect(record!.outcome).toBe('failed');
      expect(record!.workerMessages.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(record!.workerMessages)).toContain(PARTIAL_TRANSCRIPT);
      expect(JSON.stringify(record!.workerMessages)).toContain(DELEGATE_ASK);

      // ④ 驱动契约证据：deadline 确实传给了 worker 驱动（真实链路里驱动靠它自断）
      expect(worker.runs[0]?.deadline).toBeDefined();
    } finally {
      audit.restore();
      await booted?.assembly.close();
    }
  });

  it('WT-2 超时后续跑：同一 taskId 从持久化断点继续，不新开任务也不从零重付', async () => {
    const worker = scriptedWorker(['timeout', { complete: RESUMED_ANSWER }], PARTIAL_TRANSCRIPT);
    const taskIdBox: { value: string } = { value: '' };
    let booted: Boot | null = null;
    try {
      booted = await boot({
        main: resumeMainDriver(
          { kind: 'delegate', request: DELEGATE_ASK },
          { kind: 'delegate', request: RESUME_DELEGATE_ASK, continueTaskId: LAST_TASK_ID_TOKEN },
          taskIdBox,
        ),
        worker: worker.driver as never,
        patchProfile: { workerTimeoutMs: WORKER_TIMEOUT_MS },
      });

      // 第一回合：撞超时（同 WT-1），拿到失败话术后从宿主底账取回任务编号
      const first = await booted.send(USER_ASK);
      expect(first).toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));
      const failedRecords = await platformTasksOf(booted);
      expect(failedRecords).toHaveLength(1);
      expect(failedRecords[0]!.outcome).toBe('failed');
      taskIdBox.value = failedRecords[0]!.taskId;
      expect(taskIdBox.value).toMatch(/^task_/);

      // 第二回合：同会话续跑，worker 正常完成
      const second = await booted.send(RESUME_USER_ASK);
      expect(second).toBe(RESUMED_ANSWER);

      // ① 断点续跑不是从零开始：第二个 worker 收到的转录里既有超时回合的原始委派请求、
      // 也有它留下的部分转录（持久化自 context.ts 的 catch upsert 分支）
      const resumed = worker.runs[1];
      expect(resumed).toBeDefined();
      expect(JSON.stringify(resumed!.messages)).toContain(DELEGATE_ASK);
      expect(JSON.stringify(resumed!.messages)).toContain(PARTIAL_TRANSCRIPT);
      // 末条是宿主为本回合新拼的用户请求（续跑请求原文，不是超时回合的旧请求）
      const last = resumed!.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(last?.content).toBe(RESUME_DELEGATE_ASK);

      // ② 续跑是同一任务的继续：底账里仍只有一条记录（continueTaskId 复用了 taskId），
      // 且这次真跑完了，终态从 failed 推到 done
      const records = await platformTasksOf(booted);
      expect(records).toHaveLength(1);
      expect(records[0]!.taskId).toBe(taskIdBox.value);
      expect(records[0]!.outcome).toBe('done');
      expect(JSON.stringify(records[0]!.workerMessages)).toContain(RESUMED_ANSWER);
    } finally {
      await booted?.assembly.close();
    }
  });

  it('WT-3 中止与超时同刻成立：分类判取消优先，用户收到取消话术而不是超时话术', async () => {
    const worker = scriptedWorker(['timeout'], PARTIAL_TRANSCRIPT);
    const audit = captureEvents();
    let booted: Boot | null = null;
    try {
      booted = await boot({
        // 替身主驱动在 60ms 主动中止并随 exec 下传信号；worker 替身照旧睡过 250ms 截止
        // ——分类时刻 signal.aborted 与 Date.now()>=deadline 同时成立
        main: abortingMainDriver({ kind: 'delegate', request: DELEGATE_ASK }, ABORT_AFTER_MS),
        worker: worker.driver as never,
        patchProfile: { workerTimeoutMs: WORKER_TIMEOUT_MS },
      });

      const reply = await booted.send(USER_ASK);

      // ① 取消优先于超时（context.ts 分支顺序即优先级）：话术必须是取消，不是超时
      expect(reply).toBe(messageTextFor('DELEGATION_CANCELLED'));
      expect(reply).not.toBe(messageTextFor('DELEGATION_TIMEOUT_FAILURE'));

      // ② 信号真的经宿主下传到了 worker 驱动（runtime 透传 → context.ts :812），且在
      // worker 返回前已中止——"同刻成立"不是构造出来的，两个判据都真实为真
      expect(worker.runs[0]?.signalGiven).toBe(true);
      expect(worker.runs[0]?.signalAbortedAtReturn).toBe(true);

      // ③ 审计与留痕同超时族：span 记 failed/cancelled，中间转录照常持久化（取消也是
      // 失败的一种，断点续跑的资本不因取消而丢）
      const span = audit.events.find((event) => event['event'] === 'delegation_span');
      expect(span?.['outcome']).toBe('failed');
      expect(span?.['failureClass']).toBe('cancelled');
      const taskId = span?.['taskId'];
      const record = (await platformTasksOf(booted)).find((entry) => entry.taskId === taskId);
      expect(record?.outcome).toBe('failed');
      expect(JSON.stringify(record?.workerMessages)).toContain(PARTIAL_TRANSCRIPT);
    } finally {
      audit.restore();
      await booted?.assembly.close();
    }
  });
});
