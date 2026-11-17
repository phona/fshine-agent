/**
 * R4 · 稳定性加固 · 压力 harness（假 executor/sink/渠道/时钟；预注册 §三 P1–P3）。
 *
 * P1 积压 N（受控排队）：一次性提交 backlog，executor 门控制造真实积压，放行后 `whenIdle` 排空。
 * P2 池满持续：concurrency=1 + queueCapacity=0，满员后确定性拒绝 resource_limited；holdFirstTask
 *    时在池满期间探前台可用（前后台配额独立）。
 * 读数：终态/原因计数、开放态残留、每任务执行次数、重复副作用、未送达通知、队列深度（只读）、RSS。
 */
import path from 'node:path';
import {
  ControllableClock,
  createFakeMainDriver,
  createGatedExecutor,
  deliveredToObject,
  driveDeliveries,
  InjectingSink,
  makeStabTempDir,
  notificationSummary,
  RecordedTurn,
  removeStabTempDir,
  rssGrowth,
  sampleRssMedian,
  stabScope,
  summarizeTasks,
  unreachableWorkerDriver,
  assembleStabSession,
  attachStabOutbox,
  createStabRegistry,
  waitIdleWithTimeout,
  type StabRuntimeConfig,
} from './fakes';

const REQUEST = '（stab 压力）查询 W202611 窗口数据';
const FOREGROUND_TEXT = '（stab 前台探针）现在方便吗';
const FOREGROUND_REPLY = '（stab 前台）可用';

export interface PressureScenario {
  backlog: number;
  concurrency: number;
  queueCapacity: number;
  /** 池满期间探前台可用（P2）。 */
  holdFirstTask?: boolean;
  /** 每 N 条通知首次投递失败一次（缺省=恒成功）。 */
  sinkFailureEvery?: number;
}

export interface PressureReport {
  scenario: string;
  submitted: number;
  accepted: number;
  rejected: number;
  terminalCounts: Record<string, number>;
  terminalReasonCounts: Record<string, number>;
  openOnDrain: number;
  executorCallsPerTask: Record<string, number>;
  duplicateSideEffectTasks: string[];
  undeliveredNotifications: number;
  sinkDeliveredPerNotification: Record<string, number>;
  foregroundRoundTrips: number;
  queueObservations: { policyQueueMax: number; ledgerQueuedMax: number };
  rssGrowthRatio: number;
  hung: boolean;
}

function receiptAccepted(turn: RecordedTurn | undefined): boolean {
  const first = turn?.execResults[0] as Record<string, unknown> | undefined;
  return first?.['accepted'] === true;
}

function scenarioName(scenario: PressureScenario): string {
  if (scenario.queueCapacity === 0 && scenario.backlog > scenario.concurrency) return 'P2';
  if (scenario.sinkFailureEvery !== undefined) return 'P3';
  return 'P1';
}

export async function runPressureScenario(scenario: PressureScenario): Promise<PressureReport> {
  const dir = makeStabTempDir('stab-pressure-');
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const clock = new ControllableClock();
  const registry = createStabRegistry(dbPath);
  const sink = new InjectingSink({
    ...(scenario.sinkFailureEvery === undefined ? {} : { failureEvery: scenario.sinkFailureEvery }),
  });
  const outbox = attachStabOutbox(registry, dbPath, sink, clock);
  const gated = createGatedExecutor({ gateAfter: 0 }); // 全部门控：提交期形成真实积压
  const records: RecordedTurn[] = [];
  const principalId = 'stab:pressure';
  const sessionId = 'stab-pressure-1';
  const scope = stabScope(principalId, sessionId);
  const runtime: StabRuntimeConfig = {
    dispatchMode: 'background',
    backgroundConcurrency: scenario.concurrency,
    queueCapacity: scenario.queueCapacity,
  };
  let submitted = 0;
  let accepted = 0;
  let rejected = 0;
  let foregroundRoundTrips = 0;
  let ledgerQueuedMax = 0;
  let policyQueueMax = 0;
  let rssBase = 0;
  let rssEnd = 0;
  try {
    const assembled = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId,
      principalId,
      mainDriver: createFakeMainDriver(
        (text) => (text === FOREGROUND_TEXT ? { reply: FOREGROUND_REPLY } : { delegates: [REQUEST] }),
        records,
      ),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: gated.executor,
      registry,
      runtime,
    });
    let hung = false;
    try {
      for (let i = 0; i < scenario.backlog; i += 1) {
        await assembled.session.send(REQUEST);
        submitted += 1;
        if (receiptAccepted(records[records.length - 1])) accepted += 1;
        else rejected += 1;
      }
      ledgerQueuedMax = registry.list(scope).filter((task) => task.status === 'queued').length;
      policyQueueMax = assembled.policy.snapshot().background.queued;
      rssBase = sampleRssMedian();
      if (scenario.holdFirstTask === true) {
        const front = await assembled.session.send(FOREGROUND_TEXT);
        if (front.reply === FOREGROUND_REPLY) foregroundRoundTrips += 1;
      }
      gated.release();
      hung = !(await waitIdleWithTimeout(assembled));
      rssEnd = sampleRssMedian();
      await driveDeliveries(outbox, clock);
    } finally {
      assembled.close();
    }
    const tasks = registry.list(scope);
    const summary = summarizeTasks(tasks, gated.calls);
    const notifications = notificationSummary(outbox);
    return {
      scenario: scenarioName(scenario),
      submitted,
      accepted,
      rejected,
      terminalCounts: summary.terminalCounts,
      terminalReasonCounts: summary.terminalReasonCounts,
      openOnDrain: summary.openOnDrain,
      executorCallsPerTask: summary.executorCallsPerTask,
      duplicateSideEffectTasks: summary.duplicateSideEffectTasks,
      undeliveredNotifications: notifications.undelivered,
      sinkDeliveredPerNotification: deliveredToObject(sink.deliveredCounts),
      foregroundRoundTrips,
      queueObservations: { policyQueueMax, ledgerQueuedMax },
      rssGrowthRatio: rssGrowth(rssBase, rssEnd),
      hung,
    };
  } finally {
    outbox.close();
    registry.close();
    removeStabTempDir(dir);
  }
}
