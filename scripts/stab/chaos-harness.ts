/**
 * R4 · 稳定性加固 · 混沌 harness（假 executor/sink/渠道/时钟；预注册 §三 C1–C4）。
 *
 * 组合维度：
 *   · restart               —— 两阶段（关闭 → 同库新进程；过期租约→result_unknown 不重放 / queued 重领 /
 *                               completed 不重跑）；
 *   · notification_failure  —— 假 sink 失败注入（阶段内留未送达；恢复后未送达=0）；
 *   · duplicate_message     —— 假渠道经 `server.handler` 同 messageId 并发重投（回执幂等重放、
 *                              不新增任务/执行）；
 *   · cancel                —— 运行中任务 cancel（执行端 abort 观察确认 cancelled，非停留 cancelling）。
 *
 * 读数：重复副作用、重放、通知重复/未送达、取消确认、重启计数、RSS 增长、挂死。
 * 预注册 §九 blocked：跨重启 messageId 查重不保持 → 仅单进程内评查重；取消确认先于重启
 * （绕开 cancelling 孤儿恢复登记缺陷）。
 */
import path from 'node:path';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { NotificationOutbox } from '../../packages/agent/src/notifications';
import { createSqliteTaskRegistry } from '../../packages/agent/src/task-registry-sqlite';
import type { TaskRecordView, TaskScope } from '../../packages/agent/src/task-runner';
import { createServer } from '../../apps/server/server';
import {
  ControllableClock,
  FaceClient,
  createCancelableExecutor,
  createFakeMainDriver,
  createGatedExecutor,
  deliveredToObject,
  driveDeliveries,
  InjectingSink,
  makeStabTempDir,
  mergeCalls,
  notificationSummary,
  pollUntil,
  RecordedTurn,
  removeStabTempDir,
  rssGrowth,
  sampleRssMedian,
  STAB_PROFILE,
  summarizeTasks,
  unreachableWorkerDriver,
  assembleStabSession,
  attachStabOutbox,
  createStabRegistry,
  waitIdleWithTimeout,
  type StabRegistry,
  type StabRuntimeConfig,
} from './fakes';

const REQUEST = '（stab 混沌）查询 W202611 窗口数据';
const CANCEL_TASK_ID = 'task_stab_cancel';

export type ChaosCombination = 'restart' | 'notification_failure' | 'duplicate_message' | 'cancel';

export interface ChaosScenario {
  tasks: number;
  combination: readonly ChaosCombination[];
  concurrency?: number;
  queueCapacity?: number;
}

export interface ChaosReport {
  scenario: string;
  combination: readonly ChaosCombination[];
  submitted: number;
  terminalCounts: Record<string, number>;
  openOnDrain: number;
  duplicateSideEffectTasks: string[];
  replayedCompletedTasks: string[];
  leaseExpiredReplays: number;
  duplicateNotificationRows: number;
  undeliveredNotifications: number;
  sinkDeliveredPerNotification: Record<string, number>;
  receiptReplayIdentical: boolean | null;
  tasksCreatedByDuplicate: number | null;
  executionsByDuplicate: number | null;
  cancelledConfirmed: boolean | null;
  restartCount: number;
  rssGrowthRatio: number;
  hung: boolean;
}

function emptyReport(scenario: ChaosScenario): ChaosReport {
  return {
    scenario: scenario.combination.join('+'),
    combination: scenario.combination,
    submitted: 0,
    terminalCounts: {},
    openOnDrain: 0,
    duplicateSideEffectTasks: [],
    replayedCompletedTasks: [],
    leaseExpiredReplays: 0,
    duplicateNotificationRows: 0,
    undeliveredNotifications: 0,
    sinkDeliveredPerNotification: {},
    receiptReplayIdentical: null,
    tasksCreatedByDuplicate: null,
    executionsByDuplicate: null,
    cancelledConfirmed: null,
    restartCount: 0,
    rssGrowthRatio: 0,
    hung: false,
  };
}

function scopeOf(principalId: string, sessionId: string): TaskScope {
  return { principalId, sessionId };
}

function runtimeOf(scenario: ChaosScenario): StabRuntimeConfig {
  return {
    dispatchMode: 'background',
    backgroundConcurrency: scenario.concurrency ?? 1,
    queueCapacity: scenario.queueCapacity ?? 32,
  };
}

function findTask(tasks: readonly TaskRecordView[], taskId: string): TaskRecordView | undefined {
  return tasks.find((task) => task.taskId === taskId);
}

function statusOf(tasks: readonly TaskRecordView[], taskId: string): string | undefined {
  return findTask(tasks, taskId)?.status;
}

// ---------------------------------------------------------------------------
// C1：重启 × 通知失败
// ---------------------------------------------------------------------------

async function runRestartNotificationScenario(scenario: ChaosScenario): Promise<ChaosReport> {
  const report = emptyReport(scenario);
  report.restartCount = 1;
  const dir = makeStabTempDir('stab-chaos-c1-');
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const clock = new ControllableClock();
  clock.set(Date.now()); // 与真实时钟对齐：底账租约以系统时钟落库，注入时钟需在其之后才能判定过期
  const principalId = 'stab:chaos';
  const sessionId = 'stab-chaos-c1';
  const scope = scopeOf(principalId, sessionId);
  const rssBase = sampleRssMedian();
  let outbox1: NotificationOutbox | undefined;
  let outbox2: NotificationOutbox | undefined;
  let sink1: InjectingSink | undefined;
  let sink2: InjectingSink | undefined;
  let registry1: StabRegistry | undefined;
  let registry2: StabRegistry | undefined;
  try {
    // 阶段 1：部分完成后中断（sink 恒失败）。
    registry1 = createStabRegistry(dbPath);
    sink1 = new InjectingSink({ failAll: true });
    outbox1 = attachStabOutbox(registry1, dbPath, sink1, clock);
    const gated1 = createGatedExecutor({ gateAfter: 5 });
    const records1: RecordedTurn[] = [];
    const assembled1 = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId,
      principalId,
      mainDriver: createFakeMainDriver(() => ({ delegates: [REQUEST] }), records1),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: gated1.executor,
      registry: registry1,
      runtime: runtimeOf(scenario),
      runnerOptions: { leaseMs: 60_000, now: clock.now },
    });
    try {
      for (let i = 0; i < scenario.tasks; i += 1) {
        const turn = await assembled1.session.send(REQUEST);
        report.submitted += turn.taskIds.length;
      }
      await pollUntil(() => registry1!.list(scope).filter((task) => task.status === 'completed').length >= 5, 20_000);
      await outbox1.deliverPending(); // 恒失败：attempts=1，全部未送达
    } finally {
      assembled1.close();
    }
    const tasks1 = registry1.list(scope);
    const completedIds1 = tasks1.filter((task) => task.status === 'completed').map((task) => task.taskId);
    outbox1.close();
    registry1.close();

    // 重启：新进程 + 越过租约的时钟。
    clock.advance(3_600_000);
    registry2 = createStabRegistry(dbPath);
    sink2 = new InjectingSink();
    outbox2 = attachStabOutbox(registry2, dbPath, sink2, clock);
    const executor2 = createCancelableExecutor({ cancelTaskId: CANCEL_TASK_ID });
    const records2: RecordedTurn[] = [];
    const assembled2 = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId,
      principalId,
      mainDriver: createFakeMainDriver(() => ({ delegates: [REQUEST] }), records2),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: executor2.executor,
      registry: registry2,
      runtime: runtimeOf(scenario),
      runnerOptions: { leaseMs: 60_000, now: clock.now },
    });
    try {
      assembled2.runner!.pump();
      report.hung = !(await waitIdleWithTimeout(assembled2));
      await driveDeliveries(outbox2, clock);
    } finally {
      assembled2.close();
    }
    const tasks2 = registry2.list(scope);
    const summary = summarizeTasks(tasks2, mergeCalls(gated1.calls, executor2.calls));
    const notifications = notificationSummary(outbox2);
    report.terminalCounts = summary.terminalCounts;
    report.openOnDrain = summary.openOnDrain;
    report.duplicateSideEffectTasks = summary.duplicateSideEffectTasks;
    report.replayedCompletedTasks = executor2.calls
      .map((call) => call.taskId)
      .filter((taskId) => completedIds1.includes(taskId));
    report.leaseExpiredReplays = executor2.calls.filter((call) => {
      const task = findTask(tasks2, call.taskId);
      return task?.status === 'failed' && task.reason === 'result_unknown';
    }).length;
    report.duplicateNotificationRows = notifications.duplicateRows;
    report.undeliveredNotifications = notifications.undelivered;
    report.sinkDeliveredPerNotification = deliveredToObject(sink1.deliveredCounts, sink2.deliveredCounts);
    report.rssGrowthRatio = rssGrowth(rssBase, sampleRssMedian());
    return report;
  } finally {
    outbox1?.close();
    outbox2?.close();
    registry1?.close();
    registry2?.close();
    removeStabTempDir(dir);
  }
}

// ---------------------------------------------------------------------------
// C3：取消 × 通知失败
// ---------------------------------------------------------------------------

async function runCancelScenario(scenario: ChaosScenario): Promise<ChaosReport> {
  const report = emptyReport(scenario);
  report.restartCount = scenario.combination.includes('restart') ? 1 : 0;
  const dir = makeStabTempDir('stab-chaos-c3-');
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const clock = new ControllableClock();
  clock.set(Date.now()); // 与真实时钟对齐（同 C1：租约以系统时钟落库）
  const principalId = 'stab:chaos';
  const sessionId = 'stab-chaos-c3';
  const scope = scopeOf(principalId, sessionId);
  const rssBase = sampleRssMedian();
  const registry = createStabRegistry(dbPath);
  const sink = new InjectingSink({ failureEvery: 2 });
  const outbox = attachStabOutbox(registry, dbPath, sink, clock);
  const cancelable = createCancelableExecutor({ cancelTaskId: CANCEL_TASK_ID });
  try {
    const assembled = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId,
      principalId,
      mainDriver: createFakeMainDriver(() => ({ delegates: [REQUEST] }), [] as RecordedTurn[]),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: cancelable.executor,
      registry,
      runtime: runtimeOf(scenario),
      runnerOptions: { leaseMs: 60_000, now: clock.now },
    });
    try {
      const runner = assembled.runner!;
      for (let i = 0; i < scenario.tasks; i += 1) {
        const taskId = i === 0 ? CANCEL_TASK_ID : `task_stab_c3_${i}`;
        runner.submit({ taskId, principalId, sessionId, request: REQUEST });
        report.submitted += 1;
      }
      runner.pump();
      await pollUntil(() => statusOf(registry.list(scope), CANCEL_TASK_ID) === 'running', 10_000);
      runner.cancel(CANCEL_TASK_ID, scope);
      report.hung = !(await waitIdleWithTimeout(assembled));
      report.cancelledConfirmed = statusOf(registry.list(scope), CANCEL_TASK_ID) === 'cancelled';
      await driveDeliveries(outbox, clock);
    } finally {
      assembled.close();
    }
    const tasks = registry.list(scope);
    const summary = summarizeTasks(tasks, cancelable.calls);
    const notifications = notificationSummary(outbox);
    report.terminalCounts = summary.terminalCounts;
    report.openOnDrain = summary.openOnDrain;
    report.duplicateSideEffectTasks = summary.duplicateSideEffectTasks;
    report.duplicateNotificationRows = notifications.duplicateRows;
    report.undeliveredNotifications = notifications.undelivered;
    report.sinkDeliveredPerNotification = deliveredToObject(sink.deliveredCounts);
    report.rssGrowthRatio = rssGrowth(rssBase, sampleRssMedian());
    return report;
  } finally {
    outbox.close();
    registry.close();
    removeStabTempDir(dir);
  }
}

// ---------------------------------------------------------------------------
// C2/C4：含重复消息（server 渠道阶段 + 重启会话阶段）
// ---------------------------------------------------------------------------

function serverConfig(scenario: ChaosScenario): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: STAB_PROFILE.root, gateway: STAB_PROFILE.gateway, skillRoots: [...STAB_PROFILE.skillRoots] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    runtime: {
      dispatchMode: 'background',
      backgroundConcurrency: scenario.concurrency ?? 1,
      queueCapacity: scenario.queueCapacity ?? 32,
    },
  };
}

function incoming(messageId: string, text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

async function runCombinedWithDuplicate(scenario: ChaosScenario): Promise<ChaosReport> {
  const report = emptyReport(scenario);
  const hasCancel = scenario.combination.includes('cancel');
  const hasNotificationFailure = scenario.combination.includes('notification_failure');
  report.restartCount = scenario.combination.includes('restart') ? 1 : 0;
  const dir = makeStabTempDir('stab-chaos-dup-');
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const clock = new ControllableClock();
  clock.set(Date.now());
  const serverScope = scopeOf('wecom:user-a', 'wecom:conv-a');
  const rssBase = sampleRssMedian();
  const texts = Array.from({ length: scenario.tasks }, (_, index) => `（stab 混沌）请求-${index + 1}`);
  const duplicateText = texts[0]!;
  const gateAfter = Math.max(1, scenario.tasks - 5);
  const serverExecutor = createGatedExecutor({ gateAfter });
  const serverSink = new InjectingSink(hasNotificationFailure ? { failureEvery: 2 } : {});
  let phaseATasks: TaskRecordView[] = [];
  let completedIdsA: string[] = [];
  try {
    // 阶段 A：假渠道（真实 server.handler，含 messageId 幂等）。
    const server = await createServer({
      env: { LLM_MODEL: 'test-model', PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
      config: serverConfig(scenario),
      dbPath,
      stateDir,
      createDrivers: () => ({
        mainDriver: createFakeMainDriver((text) => ({ delegates: [text] }), [] as RecordedTurn[]),
        workerDriver: unreachableWorkerDriver(),
      }),
      createExecutionFace: async () => ({ client: new FaceClient(), allowedOperations: ['dummy.query'] }),
      taskExecutor: serverExecutor.executor,
      notificationSink: serverSink,
      logger: () => {},
    });
    const readerA = createSqliteTaskRegistry(dbPath, { readOnly: true });
    try {
      const [first, second] = await Promise.all([
        server.handler(incoming('dup-msg-1', duplicateText)),
        server.handler(incoming('dup-msg-1', duplicateText)),
      ]);
      report.receiptReplayIdentical = first === second;
      for (let i = 1; i < scenario.tasks; i += 1) {
        await server.handler(incoming(`msg-${i + 1}`, texts[i]!));
      }
      await pollUntil(() => readerA.list(serverScope).filter((task) => task.status === 'completed').length >= gateAfter, 20_000);
      phaseATasks = readerA.list(serverScope).map((task) => ({ ...task }));
      completedIdsA = phaseATasks.filter((task) => task.status === 'completed').map((task) => task.taskId);
    } finally {
      readerA.close();
      server.close();
    }
    report.tasksCreatedByDuplicate = Math.max(0, phaseATasks.filter((task) => task.request === duplicateText).length - 1);
    report.executionsByDuplicate = Math.max(
      0,
      serverExecutor.calls.filter((call) => call.request === duplicateText).length - 1,
    );

    // 阶段 B：重启（同库新进程）+ 取消。
    clock.advance(3_600_000);
    const registryB = createStabRegistry(dbPath);
    const sinkB = new InjectingSink();
    const outboxB = attachStabOutbox(registryB, dbPath, sinkB, clock);
    const executorB = createCancelableExecutor({ cancelTaskId: CANCEL_TASK_ID });
    const assembledB = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId: serverScope.sessionId,
      principalId: serverScope.principalId,
      mainDriver: createFakeMainDriver((text) => ({ delegates: [text] }), [] as RecordedTurn[]),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: executorB.executor,
      registry: registryB,
      runtime: runtimeOf(scenario),
      runnerOptions: { leaseMs: 60_000, now: clock.now },
    });
    try {
      const runner = assembledB.runner!;
      runner.pump();
      const idle1 = await waitIdleWithTimeout(assembledB);
      let idle2 = true;
      if (hasCancel) {
        runner.submit({ taskId: CANCEL_TASK_ID, principalId: serverScope.principalId, sessionId: serverScope.sessionId, request: REQUEST });
        report.submitted += 1;
        runner.pump();
        await pollUntil(() => statusOf(registryB.list(serverScope), CANCEL_TASK_ID) === 'running', 10_000);
        runner.cancel(CANCEL_TASK_ID, serverScope);
        idle2 = await waitIdleWithTimeout(assembledB);
        report.cancelledConfirmed = statusOf(registryB.list(serverScope), CANCEL_TASK_ID) === 'cancelled';
      }
      report.hung = !(idle1 && idle2);
      await driveDeliveries(outboxB, clock);
    } finally {
      assembledB.close();
    }
    const tasksB = registryB.list(serverScope);
    const summary = summarizeTasks(tasksB, mergeCalls(serverExecutor.calls, executorB.calls));
    const notifications = notificationSummary(outboxB);
    report.submitted = phaseATasks.length + (hasCancel ? 1 : 0);
    report.terminalCounts = summary.terminalCounts;
    report.openOnDrain = summary.openOnDrain;
    report.duplicateSideEffectTasks = summary.duplicateSideEffectTasks;
    report.replayedCompletedTasks = executorB.calls
      .map((call) => call.taskId)
      .filter((taskId) => completedIdsA.includes(taskId));
    report.leaseExpiredReplays = executorB.calls.filter((call) => {
      const task = findTask(tasksB, call.taskId);
      return task?.status === 'failed' && task.reason === 'result_unknown';
    }).length;
    report.duplicateNotificationRows = notifications.duplicateRows;
    report.undeliveredNotifications = notifications.undelivered;
    report.sinkDeliveredPerNotification = deliveredToObject(serverSink.deliveredCounts, sinkB.deliveredCounts);
    report.rssGrowthRatio = rssGrowth(rssBase, sampleRssMedian());
    outboxB.close();
    registryB.close();
    return report;
  } finally {
    removeStabTempDir(dir);
  }
}

export async function runChaosScenario(scenario: ChaosScenario): Promise<ChaosReport> {
  const combination = new Set(scenario.combination);
  if (combination.has('duplicate_message')) return await runCombinedWithDuplicate(scenario);
  if (combination.has('cancel')) return await runCancelScenario(scenario);
  return await runRestartNotificationScenario(scenario);
}
