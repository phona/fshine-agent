/**
 * R4 · 稳定性加固 · 浸泡 harness（假 executor/sink/渠道/时钟；预注册 §三 S1/S2）。
 *
 * 场景：多 cycle × perCycle 交办，每 cycle `whenIdle` 排空；可选通知间歇失败注入。
 * 读数：终态计数、开放态残留、每任务执行次数、重复副作用、未送达通知、RSS 增长。
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

const REQUEST = '（stab 浸泡）查询 W202611 窗口数据';

export interface SoakScenario {
  cycles: number;
  perCycle: number;
  concurrency: number;
  queueCapacity: number;
  /** 每 N 条通知首次投递失败一次（缺省=恒成功）。 */
  sinkFailureEvery?: number;
}

export interface SoakReport {
  scenario: string;
  cycles: number;
  perCycle: number;
  submitted: number;
  accepted: number;
  rejected: number;
  terminalCounts: Record<string, number>;
  openOnDrain: number;
  executorCallsPerTask: Record<string, number>;
  duplicateSideEffectTasks: string[];
  undeliveredNotifications: number;
  sinkDeliveredPerNotification: Record<string, number>;
  rssGrowthRatio: number;
  hung: boolean;
}

function receiptAccepted(turn: RecordedTurn | undefined): boolean {
  const first = turn?.execResults[0] as Record<string, unknown> | undefined;
  return first?.['accepted'] === true;
}

export async function runSoakScenario(scenario: SoakScenario): Promise<SoakReport> {
  const dir = makeStabTempDir('stab-soak-');
  const dbPath = path.join(dir, 'state.db');
  const stateDir = path.join(dir, 'state');
  const clock = new ControllableClock();
  const registry = createStabRegistry(dbPath);
  const sink = new InjectingSink({
    ...(scenario.sinkFailureEvery === undefined ? {} : { failureEvery: scenario.sinkFailureEvery }),
  });
  const outbox = attachStabOutbox(registry, dbPath, sink, clock);
  const gated = createGatedExecutor({ gateAfter: 0 });
  gated.release(); // 浸泡：executor 恒即时完成（门立即放行）
  const records: RecordedTurn[] = [];
  const principalId = 'stab:soak';
  const sessionId = 'stab-soak-1';
  const scope = stabScope(principalId, sessionId);
  const runtime: StabRuntimeConfig = {
    dispatchMode: 'background',
    backgroundConcurrency: scenario.concurrency,
    queueCapacity: scenario.queueCapacity,
  };
  let submitted = 0;
  let accepted = 0;
  let rejected = 0;
  let hung = false;
  let rssBase = 0;
  let rssEnd = 0;
  try {
    const assembled = await assembleStabSession({
      dbPath,
      stateDir,
      sessionId,
      principalId,
      mainDriver: createFakeMainDriver(() => ({ delegates: [REQUEST] }), records),
      workerDriver: unreachableWorkerDriver(),
      taskExecutor: gated.executor,
      registry,
      runtime,
    });
    try {
      // RSS 基线取「预热后」＝前半程 cycles（稳态起点，剔除非稳态增长/懒分配；预注册 §四 I5）。
      const warmupCycles = Math.max(1, Math.floor(scenario.cycles / 2));
      for (let cycle = 1; cycle <= scenario.cycles; cycle += 1) {
        for (let i = 0; i < scenario.perCycle; i += 1) {
          await assembled.session.send(REQUEST);
          submitted += 1;
          if (receiptAccepted(records[records.length - 1])) accepted += 1;
          else rejected += 1;
        }
        const idleOk = await waitIdleWithTimeout(assembled);
        if (!idleOk) {
          hung = true;
          break;
        }
        if (cycle === warmupCycles) rssBase = sampleRssMedian();
      }
      rssEnd = sampleRssMedian();
      await driveDeliveries(outbox, clock);
    } finally {
      assembled.close();
    }
    const tasks = registry.list(scope);
    const summary = summarizeTasks(tasks, gated.calls);
    const notifications = notificationSummary(outbox);
    const report: SoakReport = {
      scenario: scenario.sinkFailureEvery === undefined ? 'S1' : 'S2',
      cycles: scenario.cycles,
      perCycle: scenario.perCycle,
      submitted,
      accepted,
      rejected,
      terminalCounts: summary.terminalCounts,
      openOnDrain: summary.openOnDrain,
      executorCallsPerTask: summary.executorCallsPerTask,
      duplicateSideEffectTasks: summary.duplicateSideEffectTasks,
      undeliveredNotifications: notifications.undelivered,
      sinkDeliveredPerNotification: deliveredToObject(sink.deliveredCounts),
      rssGrowthRatio: rssGrowth(rssBase, rssEnd),
      hung,
    };
    return report;
  } finally {
    outbox.close();
    registry.close();
    removeStabTempDir(dir);
  }
}
