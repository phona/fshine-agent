/**
 * Shadow 双源对照 harness（测试层入口；**double 仅测试夹具**，不连接真实企微/执行层）。
 *
 * 双源（说话人的两种实现）：
 *   · 源 A = `dummy`：仓内 dummy fixture + 生产适配器（真实 spawn / --state-dir / audit.jsonl）；
 *   · 源 B = `fake-real`：测试用进程内 ExecutionClient（可配四态/错误信封/能力快照形状）。
 *   执行源与替身实现见 ./fixtures/execution-sources.ts（放 fixtures/ 以保持 P0 单一装配点守卫
 *   原判：装配链符号只出现在唯一生产装配模块；本文件不含任何装配链符号直呼）。
 *
 * 对照面（全部来自双源机械事实，不靠自述）：
 *   ① 任务链语义等价：受理（queued/编号/名称/notice）→ 执行记录（operation/status/error code）
 *      → 终态（status/reason/pendingMissing/failureReason/replyText）→ 存档（archiveReply 逐字）
 *      → 通知意图（outbox 行 + 假 sink 实收）；
 *   ② 只读路径哈希不变：数据面指纹读前=读后 + 同一只读调用复读两次结果摘要同哈希；
 *   ③ 失败 fail-closed：failed/refused/needs_input 绝不投影为 completed；
 *   ④ 回退开关：dummy 缺省、未知值 fail-closed；
 *   ⑤ 证据落盘可复跑：规范化 digest（无时间戳/随机 id）。
 *
 * 运行链路（两源同一宿主装配，零模型/零渠道）：
 *   assembleSessionCore(background) → session.send(委派) → 受理 → TaskRunner pump
 *   → 真实 createTaskExecutor →（假 Worker driver 门闩卡住 running 观测）→ execute_operation
 *   → client.execute（A=spawn 夹具 / B=进程内）→ 终态 + archiveReply → 通知 outbox → 假 sink。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContextProfileConfig } from '@fshine/contracts';
import type { ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { createNotificationReader, type Notification, type NotificationSink } from '../../packages/agent/src/notifications';
import { assembleSessionCore } from '../ask-runtime';
import {
  canonicalDigest,
  createShadowSource,
  DEFAULT_FIXTURE_ROOT,
  defaultEnv,
  type FakeRealConfig,
  type ShadowSourceKind,
  type ShadowSourceName,
} from './fixtures/execution-sources';

export * from './fixtures/execution-sources';

/** 双源各一次的假 sink：记录实收通知（投递口径与集成套件同形）。 */
class RecordingSink implements NotificationSink {
  readonly sent: Notification[] = [];
  async send(notification: Notification): Promise<{ delivered: boolean }> {
    this.sent.push(notification);
    return { delivered: true };
  }
}

// ---------------------------------------------------------------------------
// 任务链事实（每源一次运行的原样读数）
// ---------------------------------------------------------------------------

export interface ChainScenario {
  /** 委派任务原文（两源必须同一条）。 */
  request: string;
  /** Worker 发起的唯一一次结构化调用。 */
  operation: string;
  args: Readonly<Record<string, unknown>>;
  /** Main 的受理回复（缺省固定文案）。 */
  mainReply?: string;
}

export interface ChainRunOptions {
  source: ShadowSourceName;
  scenario: ChainScenario;
  /** 每次运行的隔离工作目录（db/state 都在下面；调用方建/清）。 */
  workDir: string;
  fixtureRoot?: string;
  /** 源 B 的结果脚本/快照形状（source='fake-real' 时使用）。 */
  fakeReal?: FakeRealConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ShadowAcceptance {
  taskNo: number;
  name: string;
  status: string;
  accepted: boolean;
  notice: string;
}

export interface ShadowExecutionFact {
  operation: string;
  status: string;
  errorCode: string | null;
}

export interface ShadowTerminalFact {
  status: string;
  reason?: string;
  pendingMissing?: readonly string[];
  failureReason?: string;
  replyText?: string;
}

export interface ShadowNotificationFact {
  kind: string;
  delivered: boolean;
}

export interface ShadowSourceRun {
  source: ShadowSourceName;
  kind: ShadowSourceKind;
  acceptance: ShadowAcceptance;
  afterAcceptStatus: string;
  executions: readonly ShadowExecutionFact[];
  terminal: ShadowTerminalFact;
  notifications: readonly ShadowNotificationFact[];
  sinkKinds: readonly string[];
  readOnly: { allowedOperations: readonly string[]; capabilitiesDigest: string };
  mechanical: { executions: number; auditLines: number; calls: number; spawnedGateway: boolean };
  artifacts: { dbPath: string; stateDir: string; auditPath: string };
}

function toAcceptance(value: unknown): ShadowAcceptance {
  if (value === null || typeof value !== 'object') {
    throw new Error('（shadow harness）受理事实不是对象：无法收集任务链事实。');
  }
  const record = value as Record<string, unknown>;
  return {
    taskNo: typeof record['taskNo'] === 'number' ? record['taskNo'] : 0,
    name: typeof record['name'] === 'string' ? record['name'] : '',
    status: typeof record['status'] === 'string' ? record['status'] : '',
    accepted: record['accepted'] === true,
    notice: typeof record['notice'] === 'string' ? record['notice'] : '',
  };
}

/** Worker 汇报的规范化合成：只依赖 operation 与执行层四态（两源可比；失败/拒绝不会被存档）。 */
function summariseOutcome(operation: string, outcome: ExecutionOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return `已完成：${operation}。`;
    case 'needs_input':
      return `需要补充信息：${operation}。`;
    case 'failed':
      return `未能完成：${operation}（failed）。`;
    case 'refused':
      return `未能完成：${operation}（refused）。`;
  }
}

/**
 * 在指定源上跑一条完整任务链（background 装配 + 假 driver/假 sink），收集机械事实。
 * Worker driver 由内部门闩卡住，保证「受理后 running」观测确定（与源快慢无关）。
 */
export async function runChainOnSource(options: ChainRunOptions): Promise<ShadowSourceRun> {
  const scenario = options.scenario;
  const env = { ...(options.env ?? defaultEnv()) };
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  mkdirSync(options.workDir, { recursive: true });
  const stateDir = path.join(options.workDir, 'state');
  const dbPath = path.join(options.workDir, 'state.db');

  const source = createShadowSource(options.source, {
    fixtureRoot,
    env,
    ...(options.fakeReal === undefined ? {} : { fakeReal: options.fakeReal }),
  });
  const face = await source.createFace(stateDir);
  const capabilities = await face.client.capabilities();

  const sink = new RecordingSink();
  let acceptance: ShadowAcceptance | undefined;
  let released = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const release = (): void => {
    if (released) return;
    released = true;
    releaseGate();
  };

  const mainReply = scenario.mainReply ?? '已受理。';
  const mainDriver: TurnDriver = {
    async run(input) {
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('（shadow harness）Main 无工具面。');
      acceptance = toAcceptance(await input.exec(tool.name, { task: scenario.request }));
      return {
        text: mainReply,
        messages: [...input.messages, { role: 'assistant', content: mainReply } as never],
      };
    },
  };
  const workerDriver: TurnDriver = {
    async run(input) {
      await gate;
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('（shadow harness）Worker 无工具面。');
      const outcome = await input.exec(tool.name, { operation: scenario.operation, args: scenario.args });
      return {
        text: summariseOutcome(scenario.operation, outcome as ExecutionOutcome),
        messages: [...input.messages],
      };
    },
  };

  const profile: ContextProfileConfig = { root: fixtureRoot, gateway: 'bin/dummy', skillRoots: [] };
  const principalId = 'shadow:user';
  const sessionId = `shadow-${options.source}`;
  const scope = { principalId, sessionId };

  const assembled = await assembleSessionCore({
    env,
    profile,
    principalId,
    sessionId,
    dbPath,
    stateDir,
    setAuditPath: true,
    emptyOperationsMessage: 'shadow harness：执行面没有声明任何只读 operation（空允许集合 fail-closed）。',
    mainSystemPrompt: '（shadow harness）Main 系统提示',
    workerSkills: [],
    createDrivers: () => ({ mainDriver, workerDriver }),
    createExecutionFace: async () => ({ client: face.client, allowedOperations: face.allowedOperations }),
    runtime: { dispatchMode: 'background' },
    notificationSink: sink,
  });
  const runner = assembled.runner;
  const notifications = assembled.notifications;
  if (runner === undefined || notifications === undefined) {
    assembled.close();
    throw new Error('（shadow harness）background 装配缺少 runner/notifications：无法收集任务链事实。');
  }

  try {
    const turn = await assembled.session.send(scenario.request);
    const taskId = turn.taskIds[0];
    if (taskId === undefined) throw new Error('（shadow harness）回合未委派任何任务。');
    const afterAcceptStatus = assembled.taskRegistry.get(taskId, scope).status;
    release();
    await runner.whenIdle();
    await notifications.deliverPending();
    if (acceptance === undefined) throw new Error('（shadow harness）未捕获受理事实。');

    const reader = createNotificationReader(dbPath);
    try {
      const rows = reader.listNotifications(taskId);
      const task = assembled.taskRegistry.get(taskId, scope);
      const mechanical = face.mechanical(stateDir);
      return {
        source: options.source,
        kind: source.kind,
        acceptance,
        afterAcceptStatus,
        executions: task.executions.map((record) => ({
          operation: record.operation,
          status: record.status,
          errorCode: record.error === undefined ? null : record.error.code,
        })),
        terminal: {
          status: task.status,
          ...(task.reason === undefined ? {} : { reason: task.reason }),
          ...(task.pendingQuestion === undefined ? {} : { pendingMissing: task.pendingQuestion.missing.map(String) }),
          ...(task.failureReason === undefined ? {} : { failureReason: task.failureReason }),
          ...(task.replyText === undefined ? {} : { replyText: task.replyText }),
        },
        notifications: rows.map((notification) => ({
          kind: notification.kind,
          delivered: notification.deliveredAt !== undefined,
        })),
        sinkKinds: sink.sent.map((notification) => notification.kind),
        readOnly: { allowedOperations: face.allowedOperations, capabilitiesDigest: canonicalDigest(capabilities) },
        mechanical: {
          executions: task.executions.length,
          auditLines: mechanical.auditLines,
          calls: mechanical.calls,
          spawnedGateway: mechanical.spawnedGateway,
        },
        artifacts: { dbPath, stateDir, auditPath: path.join(stateDir, 'audit.jsonl') },
      };
    } finally {
      reader.close();
    }
  } finally {
    release();
    try {
      await runner.whenIdle();
    } catch {
      // 收尾静默：测试结论由断言决定（与集成套件同规）。
    }
    assembled.close();
  }
}

// ---------------------------------------------------------------------------
// 投影 / 对照 / 判定
// ---------------------------------------------------------------------------

export interface ChainProjection {
  accepted: ShadowAcceptance;
  afterAcceptStatus: string;
  executions: readonly ShadowExecutionFact[];
  terminal: ShadowTerminalFact;
  notifications: readonly ShadowNotificationFact[];
}

export interface ChainComparison {
  equivalent: boolean;
  diffs: readonly string[];
}

/** 任务链投影（对照的语义面；不含 requestId/taskId/时间戳等实例噪声）。 */
export function projectChain(run: ShadowSourceRun): ChainProjection {
  return {
    accepted: run.acceptance,
    afterAcceptStatus: run.afterAcceptStatus,
    executions: run.executions,
    terminal: run.terminal,
    notifications: run.notifications,
  };
}

/**
 * 双源对照（fail-closed）：
 *   · provenance 校验：源 A 必须是仓内夹具（真实 spawn + 执行层审计行 + 零进程内 calls）；
 *     源 B 必须是进程内夹具（零 spawn + 有 calls + 零审计行）；两源 execution 记录必须 ≥1。
 *     任一不满足 → 判不等价（单源事实冒充双源成功在此被拒）；
 *   · 投影逐键规范化比较；不等价的键名进入 diffs（含 'accepted'/'executions'/'terminal'/'notifications'）。
 */
export function compareChains(a: ShadowSourceRun, b: ShadowSourceRun): ChainComparison {
  const diffs: string[] = [];
  const bySource = new Map<ShadowSourceName, ShadowSourceRun>();
  for (const run of [a, b]) {
    if (bySource.has(run.source)) diffs.push(`provenance: 对照位重复出现来源「${run.source}」`);
    bySource.set(run.source, run);
  }
  for (const name of ['dummy', 'fake-real'] as const) {
    const run = bySource.get(name);
    if (run === undefined) {
      diffs.push(`provenance: 缺少来源「${name}」的证据`);
      continue;
    }
    if (name === 'dummy') {
      if (run.kind !== 'repo-dummy-fixture') diffs.push('provenance: 源 A 不是仓内 dummy fixture');
      if (run.mechanical.spawnedGateway !== true) diffs.push('provenance: 源 A 无真实网关 spawn 证据');
      if (run.mechanical.auditLines <= 0) diffs.push('provenance: 源 A 无执行层审计行（读/调用未经执行层留痕）');
      if (run.mechanical.calls !== 0) diffs.push('provenance: 源 A 出现进程内 calls（来源标记被污染）');
    } else {
      if (run.kind !== 'test-fake-real') diffs.push('provenance: 源 B 不是进程内 fake-real 夹具');
      if (run.mechanical.spawnedGateway !== false) diffs.push('provenance: 源 B 不应 spawn 网关');
      if (run.mechanical.calls <= 0) diffs.push('provenance: 源 B 无进程内调用记录（执行未经替身）');
      if (run.mechanical.auditLines !== 0) diffs.push('provenance: 源 B 不应有执行层审计行');
    }
    if (run.mechanical.executions <= 0) {
      diffs.push(`executions: 来源「${name}」零执行记录（不得据此宣称任务链成功）`);
    }
  }
  const projectionA = projectChain(a);
  const projectionB = projectChain(b);
  for (const key of Object.keys(projectionA) as (keyof ChainProjection)[]) {
    if (canonicalDigest(projectionA[key]) !== canonicalDigest(projectionB[key])) diffs.push(key);
  }
  return { equivalent: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// 只读路径稳定性探针
// ---------------------------------------------------------------------------

export interface ReadOnlyProbeOptions {
  source: ShadowSourceName;
  workDir: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
  fixtureRoot?: string;
  fakeReal?: FakeRealConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ReadOnlyProbe {
  source: ShadowSourceName;
  kind: ShadowSourceKind;
  stateDir: string;
  allowedOperations: readonly string[];
  /** 数据面指纹（读前/读后必须相等）。 */
  before: string;
  after: string;
  /** 同一只读调用复读两次的结果摘要（必须同哈希）。 */
  readDigests: readonly [string, string];
}

export interface ReadOnlyVerdict {
  ok: boolean;
  violations: readonly string[];
}

/** 只读稳定性探针：同一只读调用连做两次，比较数据面指纹与结果摘要（不触写面）。 */
export async function probeReadOnlyStability(options: ReadOnlyProbeOptions): Promise<ReadOnlyProbe> {
  mkdirSync(options.workDir, { recursive: true });
  const stateDir = path.join(options.workDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const source = createShadowSource(options.source, {
    fixtureRoot: options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT,
    env: options.env ?? defaultEnv(),
    ...(options.fakeReal === undefined ? {} : { fakeReal: options.fakeReal }),
  });
  const face = await source.createFace(stateDir);
  const before = face.dataFingerprint();
  const first = await face.client.execute({ requestId: 'shadow_probe_1', operation: options.operation, args: options.args });
  const second = await face.client.execute({ requestId: 'shadow_probe_2', operation: options.operation, args: options.args });
  const after = face.dataFingerprint();
  const readDigests: readonly [string, string] = [canonicalDigest(first), canonicalDigest(second)];
  return {
    source: options.source,
    kind: source.kind,
    stateDir,
    allowedOperations: face.allowedOperations,
    before,
    after,
    readDigests,
  };
}

/** 只读判定：数据面漂移或复读结果漂移都算违例（fail-closed，不静默通过）。 */
export function verifyReadOnlyStable(probe: ReadOnlyProbe): ReadOnlyVerdict {
  const violations: string[] = [];
  if (probe.before !== probe.after) {
    violations.push(`只读数据面指纹漂移：before=${probe.before} after=${probe.after}`);
  }
  if (probe.readDigests[0] !== probe.readDigests[1]) {
    violations.push('同一只读调用复读结果摘要不一致（结果漂移）');
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 证据落盘（可复跑）
// ---------------------------------------------------------------------------

export interface ShadowComparisonOptions {
  label: string;
  scenario: ChainScenario;
  /** 证据目录（runbook 用 .runtime/shadow；测试用临时目录）。 */
  evidenceDir: string;
  fixtureRoot?: string;
  fakeReal?: FakeRealConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ShadowRunResult {
  label: string;
  comparison: ChainComparison;
  readOnly: { dummy: ReadOnlyProbe; 'fake-real': ReadOnlyProbe };
  readOnlyStable: { dummy: ReadOnlyVerdict; 'fake-real': ReadOnlyVerdict };
  sources: { dummy: ShadowSourceRun; 'fake-real': ShadowSourceRun };
  evidenceFiles: readonly string[];
  digest: string;
}

/**
 * 双源对照全跑（链 + 只读探针）+ 证据落盘 evidenceDir/<label>/{summary,dummy,fake-real}.json。
 * digest 只含规范化事实（无时间戳/随机 id）——同场景复跑必须同 digest（可复跑判据）。
 */
export async function runShadowComparison(options: ShadowComparisonOptions): Promise<ShadowRunResult> {
  const runDir = path.join(options.evidenceDir, options.label);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const workRoot = mkdtempSync(path.join(os.tmpdir(), `shadow-harness-${options.label}-`));
  try {
    const shared = {
      scenario: options.scenario,
      ...(options.fixtureRoot === undefined ? {} : { fixtureRoot: options.fixtureRoot }),
      ...(options.fakeReal === undefined ? {} : { fakeReal: options.fakeReal }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    const dummyRun = await runChainOnSource({
      source: 'dummy',
      workDir: path.join(workRoot, 'chain-dummy'),
      ...shared,
    });
    const fakeRealRun = await runChainOnSource({
      source: 'fake-real',
      workDir: path.join(workRoot, 'chain-fake-real'),
      ...shared,
    });
    const dummyProbe = await probeReadOnlyStability({
      source: 'dummy',
      workDir: path.join(workRoot, 'probe-dummy'),
      operation: options.scenario.operation,
      args: options.scenario.args,
      ...(options.fixtureRoot === undefined ? {} : { fixtureRoot: options.fixtureRoot }),
      ...(options.fakeReal === undefined ? {} : { fakeReal: options.fakeReal }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const fakeRealProbe = await probeReadOnlyStability({
      source: 'fake-real',
      workDir: path.join(workRoot, 'probe-fake-real'),
      operation: options.scenario.operation,
      args: options.scenario.args,
      ...(options.fixtureRoot === undefined ? {} : { fixtureRoot: options.fixtureRoot }),
      ...(options.fakeReal === undefined ? {} : { fakeReal: options.fakeReal }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const comparison = compareChains(dummyRun, fakeRealRun);
    const readOnlyStable: ShadowRunResult['readOnlyStable'] = {
      dummy: verifyReadOnlyStable(dummyProbe),
      'fake-real': verifyReadOnlyStable(fakeRealProbe),
    };
    const digest = canonicalDigest({
      label: options.label,
      scenario: {
        request: options.scenario.request,
        operation: options.scenario.operation,
        args: options.scenario.args,
      },
      comparison,
      readOnlyStable,
      projection: { dummy: projectChain(dummyRun), 'fake-real': projectChain(fakeRealRun) },
      allowedOperations: { dummy: dummyProbe.allowedOperations, 'fake-real': fakeRealProbe.allowedOperations },
      readOnlyDigests: {
        dummy: { before: dummyProbe.before, after: dummyProbe.after, reads: dummyProbe.readDigests },
        'fake-real': { before: fakeRealProbe.before, after: fakeRealProbe.after, reads: fakeRealProbe.readDigests },
      },
    });

    const summaryPath = path.join(runDir, 'summary.json');
    const dummyPath = path.join(runDir, 'dummy.json');
    const fakeRealPath = path.join(runDir, 'fake-real.json');
    writeFileSync(summaryPath, `${JSON.stringify({
      label: options.label,
      digest,
      realConnection: false,
      boundary: 'double 仅测试夹具层级；未连接真实企微/执行层（真实连接需 owner 授权）。',
      comparison,
      readOnlyStable,
    }, null, 2)}\n`);
    writeFileSync(dummyPath, `${JSON.stringify({ run: dummyRun, readOnlyProbe: dummyProbe }, null, 2)}\n`);
    writeFileSync(fakeRealPath, `${JSON.stringify({ run: fakeRealRun, readOnlyProbe: fakeRealProbe }, null, 2)}\n`);

    return {
      label: options.label,
      comparison,
      readOnly: { dummy: dummyProbe, 'fake-real': fakeRealProbe },
      readOnlyStable,
      sources: { dummy: dummyRun, 'fake-real': fakeRealRun },
      evidenceFiles: [summaryPath, dummyPath, fakeRealPath],
      digest,
    };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}
