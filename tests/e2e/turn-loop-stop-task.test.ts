// [L4 集成] 接管 · 「用户说停」的确定性复现（T11 的机制面，不花模型 token）。
/**
 * 为什么单独有这个文件：脚本化 e2e 能把「说停」的全链压成确定性两回合——脚本驱动的 Main
 * 替身在第二回合直接调 `task_control({action:'cancel'})`（真实模型走的是同一条生产路径：
 * runtime 的 TASK_CONTROL 分支 → executeTaskControl → BackgroundTaskManager.cancel）。
 * 探针（真实模型）负责「模型肯不肯说停」；这里负责「宿主收到说停后做对了没有」——
 * 两件事分开，各自都能红，互不冒充。
 *
 * 判据两半（2026-11-12 首建）：
 *   半 A（状态面，当前**绿**）：等待确认的后台任务被取消后，task_runs.state = cancelled，
 *     且同任务的待确认计划行作废（cancelled/superseded）——停机对象确实停住了；
 *   半 B（回合面，当前**红**）：用户说停的那一回合必须在有限时间内给出回复。实测（探针
 *     run3 2026-11-12：停机整轮 300s 零回复、零后续动作）与代码路径（task-manager.ts
 *     的 waiting_confirmation 分支 `await emitTerminal` → assembly 订阅的
 *     handler.enqueueTaskEvent 挂同一会话串行队列 queueKey=conversationId，
 *     而该队列此刻正被这一回合自己占着）一致：等待环 ⇒ 该回合永不返回，
 *     同会话后续消息全部排在它后面。
 *
 * 替身边界（与其它 e2e 同哲学）：只假模型与执行器（脚本化 Main/worker 替身）；runtime 回合
 * 契约、BackgroundTaskManager、SQLite 底账、handler 的会话串行队列、计划确认路由全是生产代码。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { boot, gatedWorker, heavyPlan } from './harness';

const PRINCIPAL = 'wecom:e2e_user';
const SESSION = 'wecom:e2e_user';
const ASK = '查幻辰财税全年的应收账款';

/** 说停回合的回复地平线：生产里这轮是秒级（一次工具调用 + 一段终稿），给足 5 秒仍没回复即判没回复。 */
const STOP_REPLY_BUDGET_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

interface DriverInput {
  tools: unknown[];
  messages: unknown[];
  exec: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * 两回合脚本化 Main 替身：① 申报委派并学回 taskId；② 用 task_control 取消那个 taskId。
 * 与 harness.mainDriver 同构（转录里留 assistant(toolCall) + toolResult），只是第二回合换工具
 * ——`task_control` 是宿主的控制工具，真实模型从任务清单（renderTaskRoster）拿到 taskId，
 * 这里从第①回合的委派回执里学（同一个值，来源不同不改变被测契约）。
 */
function stopMainDriver(taskIdBox: { value: string }) {
  let turn = 0;
  return {
    run: async (input: DriverInput) => {
      turn += 1;
      // 宿主续跑路径不带工具（只整理已有结果）：与本文件两回合无关，照 harness 惯例返回终稿。
      if (input.tools.length === 0) return { text: '已按你确认的范围整理完成。', messages: input.messages };
      const transcript: unknown[] = [...input.messages];
      const tool = turn === 1 ? 'route_current_turn' : 'task_control';
      const args: Record<string, unknown> = turn === 1
        ? { kind: 'delegate', request: ASK }
        : { action: 'cancel', taskId: taskIdBox.value };
      const callId = `call_stop_${turn}`;
      transcript.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: callId, name: tool, arguments: args }],
        timestamp: Date.now(),
      } as never);
      try {
        const outcome = await input.exec(tool, args);
        const observed = (outcome as { taskId?: unknown } | null)?.taskId;
        if (typeof observed === 'string') taskIdBox.value = observed;
        transcript.push({
          role: 'toolResult', toolCallId: callId, toolName: tool,
          content: [{ type: 'text', text: JSON.stringify(outcome) }], timestamp: Date.now(),
        } as never);
        return { text: '主 Agent 自由文本：不应外发', messages: transcript };
      } catch (error) {
        transcript.push({
          role: 'toolResult', toolCallId: callId, toolName: tool,
          content: [{ type: 'text', text: (error as Error).message }], timestamp: Date.now(),
        } as never);
        return { text: (error as Error).message, messages: transcript };
      }
    },
  };
}

/** 停在确认门的一次 boot + 说停前的现场（两半判据共用同一段构造）。 */
async function parkAtConfirmGate() {
  const taskIdBox = { value: '' };
  const b = await boot({
    workerDispatchMode: 'background',
    main: stopMainDriver(taskIdBox),
    // 第一步：重计划停在确认门（interactive 用例同款旋钮）；第二步留给确认后的续跑，本文件不用。
    worker: gatedWorker([{ plan: heavyPlan(), stopAtConfirm: true }, { execute: heavyPlan() }]),
  });
  const accepted = await b.send(ASK);
  const runs = () => b.assembly.store.taskRuns!.listBySession(PRINCIPAL, SESSION);
  const parked = await until(async () => (await runs()).some((run) => run.state === 'waiting_confirmation'));
  // taskId 的代填来源 = 宿主底账（WT-2 同款：替身在两回合之间从 platform 底账取编号代填，
  // 「模型怎么拿到编号」是另一条路的事——真实模型从 renderTaskRoster 的任务清单里读到同一个值）。
  if (taskIdBox.value === '') {
    taskIdBox.value = (await runs()).find((run) => run.state === 'waiting_confirmation')?.taskId ?? '';
  }
  return { b, taskIdBox, accepted, runs, parked };
}

describe('[L4 集成] 接管 · 用户说停（后台任务停在确认门）', () => {
  it('半 A（状态面）：取消后 task_runs 落 cancelled、待确认计划作废——停机对象真的停住了', async () => {
    const { b, taskIdBox, runs, parked } = await parkAtConfirmGate();
    try {
      expect(parked).toBe(true);
      expect(taskIdBox.value).not.toBe('');
      // 说停（不等回复：半 B 证明这一轮不返回；本半判状态面）。
      void b.send('先停，别做了').catch(() => undefined);
      const cancelled = await until(async () => (await runs()).some((run) => run.state === 'cancelled'));
      expect(cancelled).toBe(true);
      const cancelledRun = (await runs()).find((run) => run.state === 'cancelled');
      expect(cancelledRun?.taskId).toBe(taskIdBox.value);
      // 待确认计划作废：读宿主库的状态字段本身（与评测侧 evidence.ts 读 change_intents 同一条路）。
      // 停机后该任务的计划行必须非空且落在终态（cancelled/superseded）；仍 pending/processing
      // 或变 confirmed 都是「停得不干净」。
      const db = new Database(b.assembly.dbPath, { readonly: true, fileMustExist: true });
      try {
        const plans = db.prepare('SELECT plan_id, status FROM pending_plan_confirmations WHERE task_id = ?')
          .all(taskIdBox.value) as Array<{ plan_id: string; status: string }>;
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.map((plan) => plan.status).every((status) => ['cancelled', 'superseded'].includes(status))).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      await b.assembly.close();
    }
  }, 30_000);

  it('半 B（回合面）：说停那一回合必须在有限时间内回复——当前挂死，红在这里', async () => {
    const { b, taskIdBox, parked } = await parkAtConfirmGate();
    let stopTurn: Promise<string> | undefined;
    try {
      expect(parked).toBe(true);
      expect(taskIdBox.value).not.toBe('');
      stopTurn = b.send('先停，别做了');
      const outcome = await Promise.race([
        stopTurn.then((text) => ({ kind: 'reply' as const, text })),
        sleep(STOP_REPLY_BUDGET_MS).then(() => ({ kind: 'timeout' as const })),
      ]);
      // 期望形态：回合返回一段「已停」话术。当前实测：永不返回（见文件头等待环）。
      expect(outcome.kind).toBe('reply');
      if (outcome.kind === 'reply') expect(outcome.text).not.toBe('');
    } finally {
      // 挂死的回合不 await（await 会把这个测试文件一起挂住）：只做尽力收尾。
      void stopTurn?.catch(() => undefined);
      await b.assembly.close();
    }
  }, 30_000);
});
