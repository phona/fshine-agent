import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentReply,
  AgentRuntime,
  AuditStore,
  BackgroundTaskEvent,
  ChannelReply,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  TaskRunRecord,
  TrustedContext,
} from '@fshine/contracts';
import { createMessageHandler, type HandlerDeps } from './handler';
import { sweepUndeliveredTaskRuns } from './background-delivery';

const USER = 'user_a';
const NOW = '2026-10-23T00:00:00.000Z';

function run(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    runId: 'run_a',
    taskId: 'task_a',
    dispatchKey: 'dispatch_a',
    principalId: `wecom:${USER}`,
    sessionId: 'wecom:chat_a',
    originRequestId: 'req_a',
    originUserEventId: 'message_a',
    request: 'prepare report',
    originMessage: 'prepare report',
    createdAt: NOW,
    updatedAt: NOW,
    revision: 0,
    state: 'completed',
    deliveryState: 'pending',
    deliveryRoute: { channel: 'wecom', conversationId: 'chat_a' },
    ...overrides,
  };
}

function storeWithRun(initial = run()): { store: AuditStore; saved: TaskRunRecord[]; seedRun(record: TaskRunRecord): void; artifacts: Map<string, import('@fshine/contracts').SessionArtifactRecord> } {
  const records = new Map([[initial.runId, initial]]);
  const saved: TaskRunRecord[] = [];
  const artifacts = new Map<string, import('@fshine/contracts').SessionArtifactRecord>();
  const base = {
    principalScopes: {
      get: async (userId: string) => userId === USER ? { wecomUserId: USER, accountSetIds: [], enabled: true } : null,
      list: async () => [],
      upsert: async () => {},
    },
    requests: { insert: async () => {}, get: async () => null, findByWecomMessageId: async () => null, setOutcome: async () => {} },
    toolCalls: { insert: async () => {}, finish: async () => {}, listByRequest: async () => [] },
    sessions: { get: async () => null, upsert: async () => {} },
    conversationLog: { append: async () => {}, list: async () => [], search: async () => [] },
    taskRuns: {
      createOrGetByDispatchKey: async (record: TaskRunRecord) => record,
      get: async (runId: string) => records.get(runId) ?? null,
      getByDispatchKey: async (dispatchKey: string) => [...records.values()].find((record) => record.dispatchKey === dispatchKey) ?? null,
      listBySession: async (principalId: string, sessionId: string) => [...records.values()].filter((record) => record.principalId === principalId && record.sessionId === sessionId),
      listTerminalUnsettledDeliveries: async () => [...records.values()].filter((record) =>
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(record.state)
        && (record.deliveryState === 'pending' || record.resultHandlingState === 'processing')),
      transition: async (runId: string, _expected: readonly string[], patch: Partial<TaskRunRecord>, expectedRevision?: number) => {
        const current = records.get(runId);
        if (!current) return false;
        if (expectedRevision !== undefined && expectedRevision !== current.revision) return false;
        const next = { ...current, ...patch, revision: (current.revision ?? 0) + 1 };
        records.set(runId, next);
        saved.push(next);
        return true;
      },
      interruptActive: async () => 0,
    },
    sessionArtifacts: {
      insert: async (record: import('@fshine/contracts').SessionArtifactRecord) => { artifacts.set(`${record.sessionId}:${record.ref}`, record); },
      listBySession: async (sessionId: string) => [...artifacts.values()].filter((record) => record.sessionId === sessionId).sort((a, b) => Number(a.ref) - Number(b.ref)),
      get: async (sessionId: string, ref: string) => artifacts.get(`${sessionId}:${ref}`) ?? null,
      setStatus: async (sessionId: string, ref: string, status: 'available' | 'evicted') => {
        const found = artifacts.get(`${sessionId}:${ref}`);
        if (found) artifacts.set(`${sessionId}:${ref}`, { ...found, status });
      },
    },
  };
  return {
    store: base as unknown as AuditStore,
    saved,
    seedRun(record) { records.set(record.runId, record); },
    artifacts,
  };
}

type EventReplyHandler = ReturnType<typeof createMessageHandler> & {
  enqueueTaskEvent(event: BackgroundTaskEvent): Promise<void>;
};

function message(overrides: Partial<IncomingChannelMessage> = {}): IncomingChannelMessage {
  return {
    wecomUserId: USER,
    conversationId: 'chat_a',
    messageId: `message_${Math.random().toString(36).slice(2)}`,
    text: '请处理',
    receivedAt: NOW,
    ...overrides,
  };
}

describe('background task server delivery', () => {
  const tempRoots: string[] = [];
  afterAll(() => { for (const root of tempRoots) rmSync(root, { recursive: true, force: true }); });

  it('completion is serialized behind the current user turn and delivered without an inbound stream', async () => {    const { store, saved } = storeWithRun();
    const order: string[] = [];
    let finishUser!: () => void;
    const userBlocked = new Promise<void>((resolve) => { finishUser = resolve; });
    const delivered: Array<{ route: unknown; reply: ChannelReply }> = [];
    const runtime: AgentRuntime = {
      handleTurn: async () => {
        order.push('user:start');
        await userBlocked;
        order.push('user:end');
        return { text: '前台回复' };
      },
      handleTaskEvent: async (_ctx, event): Promise<AgentReply> => {
        order.push(`event:${event.eventId}`);
        return { text: '后台结果' };
      },
    };
    const pushToConversation = async (route: { channel: string; conversationId: string }, reply: ChannelReply): Promise<DeliveryReceipt> => {
      delivered.push({ route, reply });
      return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation,
    } as HandlerDeps) as EventReplyHandler;

    const userTurn = handler(message());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const completion = handler.enqueueTaskEvent({ eventId: 'result-event-a', run: run() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(['user:start']);
    finishUser();
    await Promise.all([userTurn, completion]);

    expect(order).toEqual(['user:start', 'user:end', 'event:result-event-a']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.route).toEqual({ channel: 'wecom', conversationId: 'chat_a' });
    expect(delivered[0]?.reply).toBe('后台结果');
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'sent' });
  });

  it('旧形态 sessionId（三段 channel:principal:conversation、无 deliveryRoute）的事件与现行用户回合同队列串行（D-133）', async () => {
    const { store } = storeWithRun();
    const order: string[] = [];
    let finishUser!: () => void;
    const userBlocked = new Promise<void>((resolve) => { finishUser = resolve; });
    const runtime: AgentRuntime = {
      handleTurn: async () => {
        order.push('user:start');
        await userBlocked;
        order.push('user:end');
        return { text: '前台回复' };
      },
      handleTaskEvent: async (_ctx, event): Promise<AgentReply> => {
        order.push(`event:${event.eventId}`);
        return { text: '后台结果' };
      },
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => ({ route, parts: [{ kind: 'text', index: 0, status: 'sent' }] }),
    } as HandlerDeps) as EventReplyHandler;

    // 现行用户回合：conversationId 'chat_a' → 会话队列键 'chat_a'。
    const userTurn = handler(message());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 过渡期数据：W1 之前的 run，sessionId 三段形态且无 deliveryRoute。
    // 剥首段的旧算法会得出 'user_a:chat_a'——事件绕过会话串行队列立即处理（红形态）。
    const legacyRun = run({ sessionId: 'wecom:user_a:chat_a', deliveryRoute: undefined });
    const completion = handler.enqueueTaskEvent({ eventId: 'legacy-event', run: legacyRun });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toEqual(['user:start']);
    finishUser();
    await Promise.all([userTurn, completion]);

    expect(order).toEqual(['user:start', 'user:end', 'event:legacy-event']);
  });

  it('only stages this run output and aggregates earlier staged task outputs at final delivery', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'background-task-output-'));
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'background-task-data-'));
    tempRoots.push(root, dataRoot);
    const taskId = `task_${randomUUID()}`;
    const otherTaskId = `task_${randomUUID()}`;
    const taskDir = path.join(root, 'tmp', taskId);
    const otherTaskDir = path.join(root, 'tmp', otherTaskId);
    mkdirSync(taskDir, { recursive: true });
    mkdirSync(otherTaskDir, { recursive: true });
    const outputA = path.join(taskDir, 'step-one.xlsx');
    const outputB = path.join(taskDir, 'final.xlsx');
    const unrelated = path.join(otherTaskDir, 'private.xlsx');
    writeFileSync(outputA, 'STEP-ONE');
    writeFileSync(outputB, 'FINAL');
    writeFileSync(unrelated, 'OTHER-TASK');
    const outputManifest = (file: string, content: string) => ({
      path: file,
      relativePath: path.basename(file),
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    const firstRun = run({
      runId: 'run_a1',
      dispatchKey: 'dispatch_a1',
      taskId,
      metadata: { workspaceDir: `tmp/${taskId}`, outputFiles: [outputManifest(outputA, 'STEP-ONE')] },
    });
    const finalRun = run({
      runId: 'run_a2',
      dispatchKey: 'dispatch_a2',
      taskId,
      metadata: { workspaceDir: `tmp/${taskId}`, outputFiles: [outputManifest(outputB, 'FINAL')] },
    });
    const previouslyDelivered = run({
      runId: 'run_old',
      dispatchKey: 'dispatch_old',
      taskId,
      deliveryState: 'sent',
      metadata: { resultHandling: { eventId: 'event_old', state: 'handled', requestId: 'req_old' } },
    });
    const { store, saved, seedRun, artifacts } = storeWithRun(firstRun);
    seedRun(finalRun);
    seedRun(previouslyDelivered);
    const oldData = Buffer.from('ALREADY-SENT');
    const oldPath = path.join(taskDir, 'already-sent.xlsx');
    writeFileSync(oldPath, oldData);
    await store.sessionArtifacts?.insert({
      ref: '1',
      sessionId: 'wecom:chat_a',
      filename: 'already-sent.xlsx',
      sha256: createHash('sha256').update(oldData).digest('hex'),
      size: oldData.length,
      sourceTaskId: taskId,
      sourceRunId: 'run_old',
      createdAt: NOW,
      status: 'available',
      path: oldPath,
    });
    const sent: ChannelReply[] = [];
    let runtimeCalls = 0;
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ++runtimeCalls === 1 ? null : { text: '计划已完成' },
    };
    const pushToConversation = async (route: { channel: string; conversationId: string }, reply: ChannelReply): Promise<DeliveryReceipt> => {
      sent.push(reply);
      return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }, ...(typeof reply === 'string' ? [] : (reply.files ?? []).map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })))] };
    };
    const handler = createMessageHandler({
      store,
      runtime,
      platformRoot: root,
      dataRoot,
      inboundDebounceMs: 0,
      pushToConversation,
    } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'event_a1', run: firstRun });

    expect(sent).toHaveLength(0); // continuation accepted: stage, do not publish an intermediate result
    const stagedStepOne = [...artifacts.values()].find((record) => record.sourceRunId === 'run_a1');
    expect(stagedStepOne?.filename).toBe('step-one.xlsx');
    expect(stagedStepOne?.sourceTaskId).toBe(taskId);
    expect(stagedStepOne?.sourceRunId).toBe('run_a1');

    await handler.enqueueTaskEvent({ eventId: 'event_a2', run: finalRun });

    expect(sent).toHaveLength(1);
    expect(typeof sent[0]).not.toBe('string');
    if (typeof sent[0] !== 'string') {
      expect(sent[0]?.files?.map((file) => file.filename)).toEqual(['step-one.xlsx', 'final.xlsx']);
      expect(sent[0]?.files?.map((file) => file.data.toString())).toEqual(['STEP-ONE', 'FINAL']);
      expect(sent[0]?.files?.some((file) => file.filename === 'private.xlsx')).toBe(false);
    }
    expect(saved.some((record) => record.metadata?.resultHandling && (record.metadata.resultHandling as { state?: string }).state === 'handled')).toBe(true);
    await handler.enqueueTaskEvent({ eventId: 'event_a2', run: finalRun });
    expect(sent).toHaveLength(1); // duplicate event does not rerun the LLM or resend files
  });

  it('artifact-store write failure still delivers the exact task-run file without rerunning the Worker', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'background-artifact-fallback-'));
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'background-artifact-fallback-data-'));
    tempRoots.push(root, dataRoot);
    const taskId = `task_${randomUUID()}`;
    const taskDir = path.join(root, 'tmp', taskId);
    mkdirSync(taskDir, { recursive: true });
    const output = path.join(taskDir, 'result.xlsx');
    const bytes = Buffer.from('RESULT');
    writeFileSync(output, bytes);
    const current = run({
      taskId,
      metadata: {
        workspaceDir: `tmp/${taskId}`,
        outputFiles: [{ path: output, relativePath: 'result.xlsx', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
      },
    });
    const { store, saved } = storeWithRun(current);
    store.sessionArtifacts!.insert = async () => { throw new Error('artifact database unavailable'); };
    const sent: ChannelReply[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '已完成' }),
    };
    const handler = createMessageHandler({
      store,
      runtime,
      platformRoot: root,
      dataRoot,
      inboundDebounceMs: 0,
      pushToConversation: async (route, reply) => {
        sent.push(reply);
        return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }, { kind: 'file', index: 0, status: 'sent' }] };
      },
    } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'fallback-delivery', run: current });

    expect(sent).toHaveLength(1);
    expect(typeof sent[0]).not.toBe('string');
    if (typeof sent[0] !== 'string') {
      expect(sent[0]?.files?.map((file) => file.data.toString())).toEqual(['RESULT']);
      expect(sent[0]?.text).toContain('result.xlsx');
    }
    expect(saved.at(-1)).toMatchObject({ state: 'completed', deliveryState: 'sent', metadata: { resultHandling: { state: 'handled' } } });
  });

  it('partial channel failure stores acknowledged parts and does not rewrite the Worker terminal state', async () => {
    const { store, saved } = storeWithRun();
    const receipt = { route: { channel: 'wecom', conversationId: 'chat_a' }, parts: [{ kind: 'text' as const, index: 0, status: 'sent' as const }] };
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '结果有文件', artifactRefs: [] }),
    };
    const pushToConversation = async (): Promise<DeliveryReceipt> => {
      throw Object.assign(new Error('upload failed'), {
        code: 'CHANNEL_TRANSPORT_FAILED',
        route: receipt.route,
        failedPart: { kind: 'file', index: 0, stage: 'upload' },
        receipt,
      });
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps) as EventReplyHandler;

    await expect(handler.enqueueTaskEvent({ eventId: 'result-event-a', run: run() })).resolves.toBeUndefined();

    expect(saved.at(-1)).toMatchObject({
      state: 'completed',
      deliveryState: 'failed',
      delivery: expect.objectContaining({
        receipt: expect.objectContaining({ parts: [{ kind: 'text', index: 0, status: 'sent' }] }),
        failedPart: { kind: 'file', index: 0, stage: 'upload' },
      }),
    });
  });

  it('empty final result has no delivery items and cannot become a vacuously sent receipt', async () => {
    const { store, saved } = storeWithRun();
    let sends = 0;
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '' }),
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => {
        sends += 1;
        return { route, parts: [] };
      },
    } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'empty-result', run: run() });

    expect(sends).toBe(0);
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'not_required', delivery: { state: 'not_required', items: [] } });
  });

  it('send-stage transport failure is unknown because the channel may have accepted the message', async () => {
    const { store, saved } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '后台结果' }),
    };
    const pushToConversation = async (route: { channel: string; conversationId: string }): Promise<DeliveryReceipt> => {
      throw Object.assign(new Error('send ACK timed out'), {
        code: 'CHANNEL_TRANSPORT_FAILED',
        route,
        failedPart: { kind: 'text', index: 0, stage: 'send' },
        receipt: { route, parts: [] },
      });
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'send-unknown', run: run() });

    expect(saved.at(-1)).toMatchObject({
      deliveryState: 'unknown',
      delivery: { state: 'unknown', items: [{ kind: 'text', index: 0, status: 'unknown' }] },
    });
  });

  it('background notice uses the host proactive route even when the inbound notice callback is absent', async () => {
    const { store } = storeWithRun();
    const sent: Array<{ route: unknown; reply: ChannelReply }> = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx: TrustedContext) => {
        await ctx.onBackgroundNotice?.('计划已确认，开始执行');
        return { text: '已受理' };
      },
    };
    const pushToConversation = async (route: { channel: string; conversationId: string }, reply: ChannelReply): Promise<DeliveryReceipt> => {
      sent.push({ route, reply });
      return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps);

    await handler(message({ channel: 'wecom' }));

    expect(sent).toEqual([{
      route: { channel: 'wecom', conversationId: 'chat_a' },
      reply: '计划已确认，开始执行',
    }]);
  });

  // ── D-131：任务事件通知（onBackgroundNotice）的传输瞬断不再让整个任务失败 ──────
  // 旧形态：createBackgroundNoticeSender 直 push 一次，渠道瞬断 → onNotice 抛 →
  // task-manager 记 executionError → run 标 failed——而 Worker 可能已产生平台副作用。
  // 重试策略与结果交付同一条（pushWithBoundedRetry：3 次 × 750ms，只重试传输类错误）。
  it('后台计划通知遇传输瞬断：有界重试吸收，通知送达且回合不失败（D-131）', async () => {
    const { store } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async (ctx: TrustedContext) => {
        await ctx.onBackgroundNotice?.('计划已确认，开始执行');   // 瞬断必须被吸收：这里不能抛
        return { text: '已受理' };
      },
    };
    let calls = 0;
    const delivered: ChannelReply[] = [];
    const pushToConversation = async (route: { channel: string; conversationId: string }, reply: ChannelReply): Promise<DeliveryReceipt> => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('send ACK timed out'), {
          code: 'CHANNEL_TRANSPORT_FAILED',
          route,
          failedPart: { kind: 'text', index: 0, stage: 'send' },
          receipt: { route, parts: [] },
        });
      }
      delivered.push(reply);
      return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps);

    const reply = await handler(message());

    expect(reply).toBe('已受理');                              // 通知瞬断不再把回合炸成失败
    expect(calls).toBe(2);                                     // 1 次失败 + 1 次重试成功，有界
    expect(delivered).toEqual(['计划已确认，开始执行']);        // 恰好送达一次、内容原样
  });

  it('后台计划通知持续传输失败：3 次尝试耗尽后按既有语义失败（run 语义不回归）', async () => {
    const { store } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async (ctx: TrustedContext) => {
        await ctx.onBackgroundNotice?.('计划已确认，开始执行');
        return { text: '已受理' };
      },
    };
    let calls = 0;
    const pushToConversation = async (route: { channel: string; conversationId: string }): Promise<DeliveryReceipt> => {
      calls += 1;
      throw Object.assign(new Error('send ACK timed out'), {
        code: 'CHANNEL_TRANSPORT_FAILED',
        route,
        failedPart: { kind: 'text', index: 0, stage: 'send' },
        receipt: { route, parts: [] },
      });
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reply = await handler(message());

      expect(reply).toBe('处理失败,请稍后再试。');              // 持续失败仍按既有语义失败
      expect(calls).toBe(3);                                    // 有界：初始 + 2 重试，不无限
    } finally {
      error.mockRestore();
    }
  });

  it('后台计划通知的确定性错误不重试：首次即原样抛（与结果交付同判据）', async () => {
    const { store } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async (ctx: TrustedContext) => {
        await ctx.onBackgroundNotice?.('计划已确认，开始执行');
        return { text: '已受理' };
      },
    };
    let calls = 0;
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => {
        calls += 1;
        throw new Error('企微渠道未提供主动交付能力');           // 非 ChannelDeliveryError：重试也不会好
      },
    } as HandlerDeps);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reply = await handler(message());

      expect(reply).toBe('处理失败,请稍后再试。');
      expect(calls).toBe(1);                                    // 确定性错误零重试
    } finally {
      error.mockRestore();
    }
  });

  it('background acceptance response never scans a Worker output into the original inbound receipt', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'background-receipt-'));
    tempRoots.push(root);
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
    const generated = path.join(root, 'tmp', 'result.xlsx');
    const { store } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async () => {
        writeFileSync(generated, 'LATER');
        const future = new Date(Date.now() + 5_000);
        utimesSync(generated, future, future);
        return { text: '任务已受理' };
      },
    };
    const handler = createMessageHandler({
      store,
      runtime,
      platformRoot: root,
      workerDispatchMode: 'background',
      inboundDebounceMs: 0,
    } as HandlerDeps);

    const reply = await handler(message());

    expect(reply).toBe('任务已受理');
  });

  it('quote context reaches both normal and confirmed resume calls while confirmation matches raw body text', async () => {
    const { store } = storeWithRun();
    const confirmations: string[] = [];
    const calls: Array<{ resumeTaskId?: string; reference?: TrustedContext; inputReference?: string }> = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx, _text, inputContext) => {
        calls.push({ resumeTaskId: ctx.resumeTaskId, reference: ctx, inputReference: inputContext?.messageReference?.text });
        return { text: 'ok' };
      },
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      planConfirmation: {
        handle: async (input) => {
          confirmations.push(input.text);
          return { status: input.text === '确认继续' ? 'activated' : 'ignored', taskId: input.text === '确认继续' ? 'task_resume' : undefined };
        },
      },
    });
    const quote = { kind: 'text' as const, text: '确认继续' };

    await handler(message({ text: '解释一下这段', messageReference: quote }));
    await handler(message({ text: '确认继续', messageReference: quote }));

    expect(confirmations).toEqual(['解释一下这段', '确认继续']);
    expect(calls.map((call) => call.inputReference)).toEqual(['确认继续', '确认继续']);
    expect(calls[0]?.resumeTaskId).toBeUndefined();
    expect(calls[1]?.resumeTaskId).toBe('task_resume');
  });

  // D-135b：反方向形态——真实待确认文本出现在**引用**里、正文无关 → 确认匹配器只读
  // 正文，不消费引用（"引用不是授权"）。e2e 需先造 pending 提案再以引用消息进 handler，
  // 成本超限；在此钉同一判据，e2e 留缝（debt-ledger D-135）。
  it('confirmation matcher never reads quoted text: real confirm code in quote, unrelated body stays a normal turn', async () => {
    const { store } = storeWithRun();
    const confirmations: string[] = [];
    const calls: Array<{ resumeTaskId?: string }> = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => {
        calls.push({ resumeTaskId: ctx.resumeTaskId });
        return { text: 'ok' };
      },
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      planConfirmation: {
        handle: async (input) => {
          confirmations.push(input.text);
          return { status: 'ignored' };
        },
      },
    });

    await handler(message({ text: '这段说什么', messageReference: { kind: 'text' as const, text: '确认 999999' } }));

    // 确认器只见过正文——若匹配器错喂引用文本，confirmations 里会是 '确认 999999'。
    expect(confirmations).toEqual(['这段说什么']);
    // 正文不命中 → 普通回合，无 resume。
    expect(calls).toEqual([{ resumeTaskId: undefined }]);
  });

  it('trusted task input files are the exact restored attachment selection for this message', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'background-input-selection-'));
    tempRoots.push(temp);
    const inputPath = path.join(temp, 'selected.xlsx');
    writeFileSync(inputPath, 'INPUT');
    const selected: IncomingAttachment = { filename: 'selected.xlsx', path: inputPath, bytes: 5 };
    const { store } = storeWithRun();
    const contexts: TrustedContext[] = [];
    const runtime: AgentRuntime = {
      handleTurn: async (ctx) => { contexts.push(ctx); return { text: 'ok' }; },
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0 });

    await handler(message({ text: '处理附件', attachments: [selected] }));

    expect(contexts[0]?.inputFiles).toEqual([selected]);
  });

  it('resultHandling 状态机每次转移同步写 resultHandlingState（pin 判据的权威列）', async () => {
    const { store, saved } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '后台结果' }),
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => ({ route, parts: [{ kind: 'text', index: 0, status: 'sent' }] }),
    } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'evt-state-sync', run: run() });

    // 认领 → processing；交付登记起 → handled（后续 delivery 翻转沿用，绝不回退）。
    const states = saved.map((record) => record.resultHandlingState).filter((state) => state !== undefined);
    expect(states[0]).toBe('processing');
    expect(states.slice(1).every((state) => state === 'handled')).toBe(true);
    expect(saved.at(-1)).toMatchObject({ resultHandlingState: 'handled', deliveryState: 'sent' });
    // 镜像仍在 metadata 里（其余细节保留），但列是唯一权威。
    expect(saved.at(-1)?.metadata?.resultHandling).toMatchObject({ state: 'handled', requestId: expect.any(String) });
  });

  it('运行前处理失败把 resultHandlingState 写成 failed（不只是 metadata）', async () => {
    const { store, saved } = storeWithRun();
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => { throw new Error('runtime 拒绝'); },
    };
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => ({ route, parts: [] }),
    } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'evt-handling-failed', run: run() });

    expect(saved.at(-1)).toMatchObject({ resultHandlingState: 'failed' });
    expect(saved.at(-1)?.metadata?.resultHandling).toMatchObject({ state: 'failed', error: expect.any(String) });
  });

  it('显式投递失败有界重试，耗尽后向用户发可行动的失败通知（沿真实重发能力措辞）', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'delivery-retry-'));
    tempRoots.push(temp);
    const artifactPath = path.join(temp, '汇总.xlsx');
    const bytes = Buffer.from('RETRY-XLSX');
    writeFileSync(artifactPath, bytes);
    const { store, saved } = storeWithRun();
    await store.sessionArtifacts!.insert({
      ref: '1', sessionId: 'wecom:chat_a', filename: '汇总.xlsx',
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      sourceTaskId: 'task_a', sourceRunId: 'run_a', createdAt: NOW, status: 'available', path: artifactPath,
    });
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '后台结果' }),
    };
    let calls = 0;
    const notices: ChannelReply[] = [];
    const pushToConversation = async (route: { channel: string; conversationId: string }, reply: ChannelReply): Promise<DeliveryReceipt> => {
      calls += 1;
      if (calls <= 3) {
        // 投递尝试全部以渠道明确报告的传输失败告终（upload 阶段）。
        throw Object.assign(new Error('upload failed'), {
          code: 'CHANNEL_TRANSPORT_FAILED',
          route,
          failedPart: { kind: 'file', index: 0, stage: 'upload' },
          receipt: { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] },
        });
      }
      notices.push(reply);                                     // 渠道恢复：失败通知送达
      return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
    };
    const handler = createMessageHandler({ store, runtime, inboundDebounceMs: 0, pushToConversation } as HandlerDeps) as EventReplyHandler;

    await handler.enqueueTaskEvent({ eventId: 'evt-delivery-retry', run: run() });

    expect(calls).toBe(4);                                      // 1 次初始 + 2 次重试 + 1 次通知，有界
    expect(notices).toHaveLength(1);
    const noticeText = typeof notices[0] === 'string' ? notices[0] : notices[0]?.text ?? '';
    expect(noticeText).toContain('投递失败');
    expect(noticeText).toContain('重发');                       // 有产物在库 → 指引沿真实重发能力
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'failed', resultHandlingState: 'handled' });
  });

  it('认领抢锁 4 次全部失败不无声丢事件：留痕且零投递', async () => {
    const { store } = storeWithRun();
    (store.taskRuns as { transition: unknown }).transition = async () => false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime: AgentRuntime = {
      handleTurn: async () => ({ text: 'unused' }),
      handleTaskEvent: async () => ({ text: '后台结果' }),
    };
    let pushes = 0;
    const handler = createMessageHandler({
      store,
      runtime,
      inboundDebounceMs: 0,
      pushToConversation: async (route) => { pushes += 1; return { route, parts: [] }; },
    } as HandlerDeps) as EventReplyHandler;
    try {
      await handler.enqueueTaskEvent({ eventId: 'evt-claim-exhausted', run: run() });

      const abandoned = warn.mock.calls
        .map(([line]) => { try { return JSON.parse(String(line)) as { event?: string }; } catch { return undefined; } })
        .filter((entry) => entry?.event === 'background_result_claim_abandoned');
      expect(abandoned).toHaveLength(1);
      expect(pushes).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('清扫（可重投）：产物在库且 sha256 校验过 → 重投成功，状态翻转为 sent', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'sweep-recover-'));
    tempRoots.push(temp);
    const artifactPath = path.join(temp, '汇总.xlsx');
    const bytes = Buffer.from('SWEEP-XLSX');
    writeFileSync(artifactPath, bytes);
    // 崩溃形状：交付已登记（pending + handled），send 从未发生——事件只活在死掉的内存链上。
    const crashed = run({
      runId: 'run_sweep_a', taskId: 'task_sweep_a', dispatchKey: 'sweep_a',
      state: 'completed', deliveryState: 'pending', resultHandlingState: 'handled', resultText: '汇总已完成',
      metadata: { resultHandling: { eventId: 'evt_sweep_a', requestId: 'req_sweep_a', state: 'handled', replyText: '汇总已完成' } },
    });
    const { store, saved } = storeWithRun(crashed);
    await store.sessionArtifacts!.insert({
      ref: '1', sessionId: 'wecom:chat_a', filename: '汇总.xlsx',
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      sourceTaskId: 'task_sweep_a', sourceRunId: 'run_sweep_a', createdAt: NOW, status: 'available', path: artifactPath,
    });
    const pushed: ChannelReply[] = [];
    const count = await sweepUndeliveredTaskRuns({
      store,
      pushToConversation: async (route, reply) => {
        pushed.push(reply);
        return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }, { kind: 'file', index: 0, status: 'sent' }] };
      },
    });

    expect(count).toBe(1);
    expect(pushed).toHaveLength(1);
    if (typeof pushed[0] !== 'string') {
      expect(pushed[0]?.text).toContain('汇总已完成');
      expect(pushed[0]?.files?.map((file) => file.data.toString())).toEqual(['SWEEP-XLSX']);
      expect(pushed[0]?.text).toContain('汇总.xlsx');                 // 点名行
    }
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'sent', resultHandlingState: 'handled', state: 'completed' });
    expect(await store.taskRuns!.listTerminalUnsettledDeliveries!()).toEqual([]);  // 收尾后不再残留
  });

  it('清扫（不可重投）：无结果文本无产物 → 标 failed 并给用户可行动通知', async () => {
    // 崩溃形状：认领后（processing）、任何结果写出前进程死亡。
    const crashed = run({
      runId: 'run_sweep_b', taskId: 'task_sweep_b', dispatchKey: 'sweep_b',
      state: 'completed', deliveryState: undefined, resultHandlingState: 'processing',
      metadata: { resultHandling: { eventId: 'evt_sweep_b', requestId: 'req_sweep_b', state: 'processing' } },
    });
    const { store, saved } = storeWithRun(crashed);
    const notices: string[] = [];
    const count = await sweepUndeliveredTaskRuns({
      store,
      pushToConversation: async (route, reply) => {
        notices.push(typeof reply === 'string' ? reply : reply.text ?? '');
        return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
      },
    });

    expect(count).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('因服务中断未能送达');
    expect(notices[0]).toContain('重新执行');                          // 无产物时的可行动指引
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'failed', resultHandlingState: 'failed' });
    expect(await store.taskRuns!.listTerminalUnsettledDeliveries!()).toEqual([]);
  });

  it('清扫（重投仍失败）：恢复投递耗尽重试 → 标 failed，通知沿重发口径', async () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'sweep-retry-'));
    tempRoots.push(temp);
    const artifactPath = path.join(temp, '工资表.xlsx');
    const bytes = Buffer.from('SWEEP-RETRY');
    writeFileSync(artifactPath, bytes);
    const crashed = run({
      runId: 'run_sweep_c', taskId: 'task_sweep_c', dispatchKey: 'sweep_c',
      state: 'completed', deliveryState: 'pending', resultHandlingState: 'handled', resultText: '工资表已生成',
      metadata: { resultHandling: { eventId: 'evt_sweep_c', requestId: 'req_sweep_c', state: 'handled', replyText: '工资表已生成' } },
    });
    const { store, saved } = storeWithRun(crashed);
    await store.sessionArtifacts!.insert({
      ref: '1', sessionId: 'wecom:chat_a', filename: '工资表.xlsx',
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      sourceTaskId: 'task_sweep_c', sourceRunId: 'run_sweep_c', createdAt: NOW, status: 'available', path: artifactPath,
    });
    let calls = 0;
    const notices: string[] = [];
    const count = await sweepUndeliveredTaskRuns({
      store,
      pushToConversation: async (route, reply) => {
        calls += 1;
        if (calls <= 3) {
          throw Object.assign(new Error('upload failed'), {
            code: 'CHANNEL_TRANSPORT_FAILED',
            route,
            failedPart: { kind: 'file', index: 0, stage: 'upload' },
            receipt: { route, parts: [] },
          });
        }
        notices.push(typeof reply === 'string' ? reply : reply.text ?? '');
        return { route, parts: [{ kind: 'text', index: 0, status: 'sent' }] };
      },
    });

    expect(count).toBe(1);
    expect(calls).toBe(4);                                            // 重投 3 连败 + 通知 1 次
    expect(notices[0]).toContain('重发');                             // 产物在库 → 通知沿真实重发能力
    expect(saved.at(-1)).toMatchObject({ deliveryState: 'failed', resultHandlingState: 'failed' });
  });
});
