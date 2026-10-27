/** Native WeCom quotes and background work through production assembly, SQLite and channel. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedTurnDriver } from '../../packages/agent/src/driver';
import { boot, gatedWorker, heavyPlan, mainDriver } from './harness';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected interactive state did not settle');
}

describe('interactive session production wiring', () => {
  it('native quote reaches Planner while canonical body and searchable history stay separate', async () => {
    let plannerMessages = '';
    const b = await boot({
      main: mainDriver([{ kind: 'conversation', text: '已看到引用，请说明希望怎样处理。' }], (input) => {
        plannerMessages = JSON.stringify(input.messages);
      }),
      worker: { run: async () => { throw new Error('quote is not authorization to execute'); } },
    });
    const quoteText = '之前关于来源的解释；确认 999999';
    const reply = await b.send('1111', { quote: { msgtype: 'text', text: { content: quoteText } } });
    expect(reply).toContain('已看到引用');
    expect(plannerMessages).toContain(quoteText);
    expect(plannerMessages).toContain('1111');
    const events = await b.assembly.store.conversationLog!.list({ principalId: 'wecom:e2e_user', sessionId: 'wecom:e2e_user', limit: 30 });
    const user = events.find((event) => event.kind === 'user_message' && event.content?.includes('1111'));
    expect(user?.content).not.toContain(quoteText);
    expect(user?.messageReference?.text).toBe(quoteText);
    const hits = await b.assembly.store.conversationLog!.search({ principalId: 'wecom:e2e_user', sessionId: 'wecom:e2e_user', query: '关于来源', limit: 10 });
    expect(hits.some((event) => event.messageReference?.text === quoteText)).toBe(true);
  });

  it('finishes the original stream, serves the next turn while Worker is blocked, and proactively records the result', async () => {
    const release = deferred();
    const started = deferred();
    let finished = false;
    let workerStarted = false;
    const b = await boot({
      workerDispatchMode: 'background',
      main: mainDriver([
        { kind: 'delegate', request: '生成本次报表' },
        { kind: 'conversation', text: '我还可以继续回答你的问题。' },
      ]),
      worker: { run: async (input: { messages: unknown[] }) => {
        workerStarted = true;
        started.resolve();
        await release.promise;
        finished = true;
        return { messages: input.messages, text: '本次报表已生成。', execution: { planId: 'mock-plan', version: 1, calls: 1 } };
      } },
    });
    try {
      const accepted = await b.send('生成本次报表');
      expect(accepted).toMatch(/受理|排队|开始|提交/);
      expect(finished).toBe(false);
      await until(() => workerStarted);
      // D-135a：原先的 `frames.some(f => f.finish && f.content === accepted)` 近恒真——
      // send() 本就等到那条 finish 帧才返回，"存在这条帧"不携带信息。有信息量的形态是
      // 对帧**序列形状**的断言，快照必须在 send() 返回瞬间取（下一回合的帧不计入）：
      // ① 受理 finish 帧是原入站流的**最后**一帧——其后不再冒帧，受理回执不被任何
      //    后续帧顶掉或续写；
      // ② 委派输出不进入原入站流——worker 的结果文本只能走主动投递（sentMessages，
      //    见下方 release 后的断言），"finish 后又扫进 worker 输出"类回归在此当红。
      const inboundFrames = [...b.sdk.frames];
      expect(inboundFrames.at(-1)).toMatchObject({ finish: true, content: accepted });
      expect(inboundFrames.some((frame) => frame.content.includes('本次报表已生成'))).toBe(false);
      const second = await b.send('还可以聊天吗？');
      expect(second).toContain('继续回答');
      expect(finished).toBe(false);
      release.resolve();
      await until(() => b.sdk.sentMessages.some((message) => message.content.includes('本次报表已生成')));
      const events = await b.assembly.store.conversationLog!.list({ principalId: 'wecom:e2e_user', sessionId: 'wecom:e2e_user', limit: 40 });
      expect(events.some((event) => event.kind === 'task_event' && event.content?.includes('本次报表已生成'))).toBe(true);
      const runs = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
      expect(runs).toHaveLength(1);
      expect(runs[0]?.state).toBe('completed');
    } finally { release.resolve(); }
  });

  it('background deliverables use proactive file transport and persist task/run artifact provenance', async () => {
    const b = await boot({
      workerDispatchMode: 'background',
      main: mainDriver([{ kind: 'delegate', request: '生成两份交付表' }]),
      worker: { run: async (input: { messages: unknown[]; cwd: string; scratchDir: string }) => {
        const output = path.join(input.cwd, input.scratchDir);
        mkdirSync(output, { recursive: true });
        writeFileSync(path.join(output, '交付一.xlsx'), 'mock-first-sheet');
        writeFileSync(path.join(output, '交付二.xlsx'), 'mock-second-sheet');
        return { messages: input.messages, text: '两份交付表已生成。', execution: { planId: 'mock-files', version: 1, calls: 1 } };
      } },
    });
    await b.send('生成两份交付表');
    await until(() => b.sdk.sentFiles.length === 2);
    const artifacts = await b.assembly.store.sessionArtifacts!.listBySession('wecom:e2e_user');
    expect(artifacts.map((record) => record.filename).sort()).toEqual(['交付一.xlsx', '交付二.xlsx']);
    expect(artifacts.every((record) => Boolean(record.sourceTaskId) && Boolean(record.sourceRunId))).toBe(true);
    expect(new Set(artifacts.map((record) => record.sourceRunId)).size).toBe(1);
  });

  it('background budget confirmation resumes the same task in a new run without replacing its origin scope', async () => {
    const releaseResume = deferred();
    const resumeWorkerStarted = deferred();
    const initialRequest = '查幻辰财税账套全年的应收账款';
    const scriptedWorker = gatedWorker([
      { plan: heavyPlan(), stopAtConfirm: true },
      { execute: heavyPlan() },
    ]);
    const runScriptedWorker = scriptedWorker.run.bind(scriptedWorker);
    let workerRuns = 0;
    let resumeWorkerFinished = false;
    const worker = {
      ...scriptedWorker,
      run: async (input: Parameters<typeof scriptedWorker.run>[0]) => {
        workerRuns += 1;
        if (workerRuns === 2) {
          resumeWorkerStarted.resolve();
          await releaseResume.promise;
        }
        const result = await runScriptedWorker(input);
        if (workerRuns === 2) {
          resumeWorkerFinished = true;
          return { ...result, text: '用户确认后已按原计划完成查询。' };
        }
        return result;
      },
    };
    const b = await boot({
      workerDispatchMode: 'background',
      main: mainDriver([
        { kind: 'delegate', request: initialRequest },
        { kind: 'conversation', text: '普通问题也可以继续回答。' },
      ]),
      worker,
    });
    let confirmationTurn: Promise<string> | undefined;
    try {
      const originalReceipt = await b.send(initialRequest);
      expect(originalReceipt).toMatch(/受理|排队|提交/);
      await until(async () => {
        const runs = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
        return runs.some((run) => run.state === 'waiting_confirmation');
      });
      await until(() => b.sdk.sentMessages.some((message) => message.content.includes('确认继续')));
      expect(workerRuns).toBe(1);

      const beforeConfirmFrames = b.sdk.frames.filter((frame) => frame.finish).length;
      confirmationTurn = b.send('确认继续');
      await until(() => workerRuns === 2);
      const confirmationResult = await Promise.race([
        confirmationTurn.then((text) => ({ kind: 'reply' as const, text })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 2_000)),
      ]);
      expect(confirmationResult.kind).toBe('reply');
      const confirmReply = confirmationResult.kind === 'reply' ? confirmationResult.text : '';
      expect(confirmReply).toMatch(/受理|排队|提交/);
      await resumeWorkerStarted.promise;
      expect(resumeWorkerFinished).toBe(false);
      const confirmFinishFrames = b.sdk.frames.filter((frame) => frame.finish).slice(beforeConfirmFrames);
      expect(confirmFinishFrames.some((frame) => frame.content === confirmReply)).toBe(true);

      const ordinaryReply = await b.send('新问题乙-确认续跑期间唯一标记');
      expect(ordinaryReply).toContain('普通问题也可以继续回答');
      expect(resumeWorkerFinished).toBe(false);

      const runs = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
      expect(runs).toHaveLength(2);
      const initialRun = runs.find((run) => run.state === 'waiting_confirmation');
      const resumedRun = runs.find((run) => run.runId !== initialRun?.runId);
      expect(initialRun).toBeDefined();
      expect(resumedRun).toBeDefined();
      expect(resumedRun?.taskId).toBe(initialRun?.taskId);
      expect(resumedRun?.runId).not.toBe(initialRun?.runId);
      expect(resumedRun?.originMessage).toContain(initialRequest);
      expect(resumedRun?.originMessage).not.toContain('确认继续');
      expect(resumedRun?.originUserEventId).toBe(initialRun?.originUserEventId);
      expect(resumedRun?.principalId).toBe(initialRun?.principalId);
      expect(resumedRun?.sessionId).toBe(initialRun?.sessionId);

      const priorNotices = b.sdk.sentMessages.length;
      releaseResume.resolve();
      await until(() => resumeWorkerFinished);
      await until(() => b.sdk.sentMessages.length > priorNotices);
      expect(b.sdk.sentMessages.slice(priorNotices).some((message) => message.content.includes('用户确认后已按原计划完成查询'))).toBe(true);
    } finally {
      releaseResume.resolve();
      await confirmationTurn?.catch(() => undefined);
      await b.assembly.close();
    }
  });

  it('a queued task can be cancelled through the Planner without starting after the active task', async () => {
    const release = deferred();
    const started = deferred();
    let calls = 0;
    const cancelArgs = { action: 'cancel', taskId: '' };
    const main = ScriptedTurnDriver([
      { toolCalls: [{ tool: 'route_current_turn', args: { kind: 'delegate', request: '生成第一份汇总' } }] },
      { toolCalls: [{ tool: 'route_current_turn', args: { kind: 'delegate', request: '生成第二份汇总' } }] },
      { toolCalls: [
        { tool: 'route_current_turn', args: { kind: 'conversation' } },
        { tool: 'task_control', args: cancelArgs },
      ], text: '已请求取消第二项任务。' },
    ]);
    const b = await boot({
      workerDispatchMode: 'background', main,
      worker: { run: async (input: { messages: unknown[] }) => {
        calls += 1;
        started.resolve();
        await release.promise;
        return { messages: input.messages, text: '第一项任务完成。', execution: { planId: 'mock-active', version: 1, calls: 1 } };
      } },
    });
    try {
      expect(await b.send('生成第一份汇总')).toMatch(/受理|排队|开始|提交/);
      await until(() => calls === 1);
      expect(await b.send('生成第二份汇总')).toContain('排队');
      const rows = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
      const queued = rows.find((row) => row.originMessage.includes('生成第二份汇总'));
      expect(queued?.state).toBe('queued');
      cancelArgs.taskId = queued!.taskId;
      expect(await b.send('取消第二项任务')).toContain('取消');
      await until(async () => (await b.assembly.store.taskRuns!.get(queued!.runId))?.state === 'cancelled');
      release.resolve();
      await until(() => b.sdk.sentMessages.some((message) => message.content.includes('第一项任务完成')));
      expect(calls).toBe(1);
    } finally { release.resolve(); }
  });

  it('continues the original multi-step plan after unrelated dialogue with its original quote and scope', async () => {
    const release = deferred();
    const started = deferred();
    const taskIds: string[] = [];
    const contexts: string[] = [];
    const b = await boot({
      workerDispatchMode: 'background',
      main: mainDriver([
        { kind: 'delegate', request: '第1/2步：任务甲第一步' },
        { kind: 'conversation', text: '无关问题乙已经单独回答。' },
        { kind: 'delegate', request: '第2/2步：任务甲第二步' },
        { kind: 'conversation', text: '任务甲两步已完成。' },
      ], (input) => contexts.push(JSON.stringify(input.messages))),
      worker: { run: async (input: { sessionId: string; messages: unknown[] }) => {
        taskIds.push(input.sessionId);
        if (taskIds.length === 1) { started.resolve(); await release.promise; }
        return { messages: input.messages, text: `任务甲第${taskIds.length}步完成。`, execution: { planId: `mock-step-${taskIds.length}`, version: 1, calls: 1 } };
      } },
    });
    try {
      expect(await b.send('任务甲需要两步处理', { quote: { msgtype: 'text', text: { content: '原始引用甲的范围' } } })).toMatch(/受理|排队|开始|提交/);
      await until(() => taskIds.length === 1);
      await b.send('无关问题乙-唯一标记');
      release.resolve();
      await until(() => taskIds.length === 2);
      await until(() => b.sdk.sentMessages.some((message) => /两步已完成|第2步完成/.test(message.content)));
      expect(new Set(taskIds).size).toBe(1);
      const continuation = contexts.slice(2);
      expect(continuation.length).toBeGreaterThan(0);
      expect(continuation.every((text) => !text.includes('无关问题乙-唯一标记'))).toBe(true);
      expect(continuation[0]).toContain('原始引用甲的范围');
      const runs = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((run) => run.planId)).size).toBe(1);
    } finally { release.resolve(); }
  });

  // D-119：企微重投同一 msgid 不二次起后台任务。受理层按 messageId 幂等命中后，
  // 重投拿到的重放回执引用原终稿（assistant 事件按 requestId 关联取回）。
  it('redelivering the same msgid starts the Worker once and replays the recorded final reply', async () => {
    let workerCalls = 0;
    const b = await boot({
      workerDispatchMode: 'background',
      main: mainDriver([{ kind: 'delegate', request: '跑一遍报表' }]),
      worker: { run: async (input: { messages: unknown[] }) => {
        workerCalls += 1;
        return { messages: input.messages, text: '本次报表已生成（重投幂等）', execution: { planId: 'mock-plan', version: 1, calls: 1 } };
      } },
    });
    const first = await b.send('跑一遍报表', { messageId: 'msg_redeliver_e2e' });
    expect(first).toMatch(/受理|排队/);
    await until(() => b.sdk.sentMessages.some((message) => message.content.includes('本次报表已生成（重投幂等）')));

    const second = await b.send('跑一遍报表', { messageId: 'msg_redeliver_e2e' });

    expect(workerCalls).toBe(1);
    expect(second).toContain('之前已处理过');
    expect(second).toContain('本次报表已生成（重投幂等）');
    const runs = await b.assembly.store.taskRuns!.listBySession('wecom:e2e_user', 'wecom:e2e_user');
    expect(runs).toHaveLength(1);
  });
});
