/**
 * CAP-01 R8 并发与隔离验评（脚本化、零真模型、零网络、零真实渠道）。
 *
 * 口径（CAP-01 并发切片验收指令 ①-④）：
 *   ① active 上限：5 个会话同时发一条回合；每回合的假驱动占槽 2s。按驱动起止墙钟
 *      算**最大同时 active 数**（应为缺省 mainConcurrency=4）与第 5 个会话的等待时长。
 *   ② transcript 隔离：每个会话的假驱动只能观察到自己的消息；跑完用生产同源的
 *      SessionPersistence 导出每个会话的 Pi 转录文本，断言不含其它会话的哨兵词。
 *   ③ SQLite 写竞争：20 个并发写（每笔 = 1 条 task 行 + 1 条 file_refs 行）。
 *      两条口径都记录：
 *        · 生产同连接路径（server/ask 共用一条 TaskStore 连接，同一进程 20 个逻辑并发写）；
 *        · 20 连接竞争路径（20 个 worker 各自打开生产 openTaskStore 连接、闸门同时起跑），
 *          直接观察 SQLITE_BUSY 与总耗时。
 *   ④ 内存：记录进程 RSS 基线（createServer 前）与 5 会话并发回合的峰值（10ms 采样），
 *      给出「每会话增量」推算（峰值 − 预热后 / 5，另附含装配开销的上界口径）。
 *
 * 装配与生产同源：apps/server/server.ts 的 createServer（缺省 inline 路径），只注入
 * 测试替身 createDrivers（脚本化 TurnDriver）与 createExecutionFace（假 ExecutionClient）。
 * 不触真实 Pi、不 spawn dummy CLI、不触网。缺省 runtime 段 = mainConcurrency 4 /
 * queueCapacity 16（resource-policy.ts 的 DEFAULT_RUNTIME_CONFIG）。
 *
 * 运行（零模型、零网络、零密钥）：
 *   TMPDIR=<可用临时目录> node --import tsx scripts/eval/cap01/r8-concurrency.ts [--out-dir <dir>] [--hold-ms 2000]
 * 缺省 out-dir = .runtime/eval-cap01-r8-concurrency/<时间戳>（.runtime 不进 git）。
 * 退出码：0 = 全部断言通过；1 = 任一断言失败或装配异常。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  AppConfig,
  ChannelReply,
  IncomingChannelMessage,
} from '@fshine/contracts';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import type { MainSessionLocation } from '../../../packages/agent/src/session-persistence';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { createServer } from '../../../apps/server/server';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DUMMY_PLATFORM_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
/** worker 侧动态加载生产 TaskStore（只依赖 node:fs/node:path/better-sqlite3，不拉 server 模块图）。 */
const TASK_STORE_MODULE_URL = new URL('../../../packages/core/src/task-store.ts', import.meta.url).href;

const PRINCIPAL_ID = 'wecom:user-a';
const PRINCIPAL_USER = 'user-a';
/** 缺省前台并发（与 resource-policy DEFAULT_RUNTIME_CONFIG 一致）；`--main-concurrency` 可改。 */
const DEFAULT_MAIN_CONCURRENCY = 4;
let mainConcurrency = DEFAULT_MAIN_CONCURRENCY;
const SQLITE_WRITES = 20;
const DEFAULT_HOLD_MS = 2_000;
const RSS_SAMPLE_INTERVAL_MS = 10;

interface SessionSpec {
  readonly conversationId: string;
  readonly sentinel: string;
}
function buildSessionSpecs(count: number): readonly SessionSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    conversationId: `conv-${index + 1}`,
    sentinel: `CAP01-R8-SENTINEL-CONV-${index + 1}`,
  }));
}
/** 并发 n 时报 n+1 个会话：多出来的那个必须排队，用来证明上限真的生效。 */
let SESSION_SPECS: readonly SessionSpec[] = buildSessionSpecs(DEFAULT_MAIN_CONCURRENCY + 1);

function sessionIdOf(spec: SessionSpec): string {
  return `wecom:${spec.conversationId}`;
}

// ── 观测与工具 ─────────────────────────────────────────────────────────────

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

function pushCheck(checks: Check[], name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return 'UNKNOWN';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSqliteBusy(code: string, message: string): boolean {
  return code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(message);
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 把 Pi 原生 message 投影成可检索文本（content 可为 string / 文本块数组）。 */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.map(messageText).filter((text) => text !== '').join('\n');
  }
  if (message !== null && typeof message === 'object') {
    const record = message as Record<string, unknown>;
    if (typeof record['text'] === 'string') return record['text'];
    if (record['content'] !== undefined) return messageText(record['content']);
  }
  return '';
}

function sentinelFoundIn(text: string, spec: SessionSpec): boolean {
  return text.includes(spec.sentinel);
}

function round(value: number): number {
  return Math.round(value);
}

// ── ① active 上限 / ② transcript 隔离：生产 server 装配 + 假驱动 ─────────────

interface Span {
  readonly sentinel: string;
  readonly turnText: string;
  readonly startMonoMs: number;
  readonly endMonoMs: number;
  readonly startEpochMs: number;
  readonly endEpochMs: number;
}

interface DriverView {
  readonly viewIndex: number;
  /** 本驱动实例每次 run 看到的全部 message 文本（含历史种子）。 */
  readonly observedTexts: string[];
  /** 装配层交给本会话的 Pi 会话位置（隔离断言的机械事实；脚本化驱动不写盘）。 */
  readonly location?: MainSessionLocation;
  readonly spans: Span[];
}

/** 区间最大重叠数（同一时刻先算结束再算开始：首尾相接不算同时 active）。 */
function maxOverlap(spans: readonly Span[]): number {
  const events: Array<[number, number]> = [];
  for (const span of spans) events.push([span.startMonoMs, 1], [span.endMonoMs, -1]);
  events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

function scriptedDriver(view: DriverView, holdMs: number): TurnDriver {
  return {
    async run(input: TurnDriverInput) {
      const observed = input.messages.map(messageText).filter((text) => text.trim() !== '');
      view.observedTexts.push(...observed);
      // 本轮输入 = 最后一条 user 消息；哨兵词由该会话自己携带。
      const last = [...observed].reverse().find((text) => text.trim() !== '') ?? '';
      const spec = SESSION_SPECS.find((candidate) => sentinelFoundIn(last, candidate));
      const turnText = last.split(/\s+/)[0] ?? '';
      const startMonoMs = performance.now();
      const startEpochMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      const endMonoMs = performance.now();
      const endEpochMs = Date.now();
      const reply = `reply:${last}`;
      if (spec !== undefined && turnText.startsWith('turn-')) {
        view.spans.push({
          sentinel: spec.sentinel,
          turnText,
          startMonoMs,
          endMonoMs,
          startEpochMs,
          endEpochMs,
        });
      }
      return {
        text: reply,
        // 与仓内既有脚本化驱动同形：把本回合快照原样交回（runtime 只追加新增消息）。
        messages: [...input.messages, { role: 'assistant', content: reply } as never] as DriverMessage[],
      };
    },
  };
}

const neverWorkerDriver: TurnDriver = {
  async run(): Promise<never> {
    throw new Error('（r8-concurrency）inline 模式不调用 worker 驱动');
  },
};

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

function testConfig(): AppConfig {
  return {
    principals: { [PRINCIPAL_ID]: { enabled: true } },
    contextProfiles: {
      dummy: {
        root: DUMMY_PLATFORM_ROOT,
        gateway: 'bin/dummy',
        skillRoots: ['.agents/skills-serve'],
      },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // runtime 段显式给并发档位（缺省 4 = DEFAULT_RUNTIME_CONFIG 同值；8 档用于对比读数）。
    runtime: { mainConcurrency, queueCapacity: 16 },
  };
}

function messageFor(spec: SessionSpec, text: string, messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: PRINCIPAL_USER,
    channel: 'wecom',
    conversationId: spec.conversationId,
    messageId,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

function channelReplyText(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : JSON.stringify(reply);
}

interface RssSampler {
  readonly samples: number[];
  stop(): void;
}

function startRssSampler(): RssSampler {
  const samples: number[] = [process.memoryUsage().rss];
  const timer = setInterval(() => {
    samples.push(process.memoryUsage().rss);
  }, RSS_SAMPLE_INTERVAL_MS);
  return {
    samples,
    stop() {
      clearInterval(timer);
    },
  };
}

interface ActiveSessionRecord {
  readonly conversationId: string;
  readonly sentinel: string;
  readonly turnText: string;
  readonly startEpochMs: number;
  readonly endEpochMs: number;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly waitMs: number;
  readonly activeMs: number;
}

interface ActiveReport {
  readonly maxActive: number;
  readonly expectedMaxActive: number;
  readonly queuedSessions: number;
  readonly fifthWaitMs: number;
  readonly burstWallMs: number;
  readonly sessions: readonly ActiveSessionRecord[];
  readonly replies: readonly string[];
}

interface IsolationSessionRecord {
  readonly conversationId: string;
  /** 装配层解析的 Pi 会话位置（脚本化驱动不写盘，隔离证据 = 位置 + 驱动输入面）。 */
  readonly sessionDir: string;
  readonly piSessionId: string;
  readonly observedSentinels: readonly string[];
  readonly observationChars: number;
  readonly observationExcerpt: string;
}

interface IsolationReport {
  readonly driverViews: number;
  readonly perViewSentinels: ReadonlyArray<{ readonly viewIndex: number; readonly sentinels: readonly string[] }>;
  readonly sessions: readonly IsolationSessionRecord[];
}

interface RssReport {
  readonly baselineBytes: number;
  readonly afterWarmupBytes: number;
  readonly peakBurstBytes: number;
  readonly endBurstBytes: number;
  readonly perSessionFromWarmupBytes: number;
  readonly perSessionFromBaselineBytes: number;
  readonly samplesDuringBurst: number;
}

async function runConcurrencyScenario(
  workDir: string,
  holdMs: number,
  checks: Check[],
  overallRssSamples: number[],
): Promise<{ active: ActiveReport; isolation: IsolationReport; rss: RssReport }> {
  const runDir = path.join(workDir, 'server-run');
  const dbPath = path.join(runDir, 'state.db');
  const sessionStoreDir = path.join(runDir, 'sessions');
  mkdirSync(runDir, { recursive: true });

  const views: DriverView[] = [];
  const rssBaseline = process.memoryUsage().rss;

  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath,
    sessionStoreDir,
    createDrivers: (_driverEnv, mainSession) => {
      const view: DriverView = {
        viewIndex: views.length + 1,
        observedTexts: [],
        spans: [],
        ...(mainSession === undefined ? {} : { location: mainSession }),
      };
      views.push(view);
      return { mainDriver: scriptedDriver(view, holdMs), workerDriver: neverWorkerDriver };
    },
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    logger: () => undefined,
  });

  let replies: string[] = [];
  let spans: Span[] = [];
  let burstMonoStart = 0;
  let burstMonoEnd = 0;
  let rssAfterWarmup = rssBaseline;
  let rssPeakBurst = rssBaseline;
  let rssEndBurst = rssBaseline;
  let rssSamplesInBurst = 0;
  let settled: PromiseSettledResult<ChannelReply>[] = [];

  try {
    // 预热：顺序跑一轮，让 5 个会话对象/转录句柄先建立，突发只测准入与并发本身。
    for (const spec of SESSION_SPECS) {
      const warmReply = await server.handler(
        messageFor(spec, `warm ${spec.sentinel}`, `r8-warm-${spec.conversationId}`),
      );
      pushCheck(
        checks,
        `active/warm-${spec.conversationId}`,
        channelReplyText(warmReply).includes(`reply:warm ${spec.sentinel}`),
        `预热回执=${channelReplyText(warmReply).slice(0, 120)}`,
      );
    }

    rssAfterWarmup = process.memoryUsage().rss;
    const sampler = startRssSampler();
    burstMonoStart = performance.now();
    try {
      settled = await Promise.allSettled(
        SESSION_SPECS.map((spec, index) =>
          server.handler(
            messageFor(spec, `turn-${index + 1} ${spec.sentinel}`, `r8-burst-${spec.conversationId}`),
          ),
        ),
      );
    } finally {
      burstMonoEnd = performance.now();
      sampler.stop();
      rssSamplesInBurst = sampler.samples.length;
      rssPeakBurst = Math.max(rssAfterWarmup, ...sampler.samples);
      rssEndBurst = process.memoryUsage().rss;
      overallRssSamples.push(...sampler.samples);
    }
  } finally {
    await server.close();
  }

  spans = views.flatMap((view) => view.spans);
  replies = settled.map((result) => {
    if (result.status === 'fulfilled') return channelReplyText(result.value);
    return `REJECTED: ${errorMessageOf(result.reason)}`;
  });

  const rejections = settled
    .map((result, index) => (result.status === 'rejected' ? `conv-${index + 1}: ${errorMessageOf(result.reason)}` : undefined))
    .filter((detail): detail is string => detail !== undefined);
  pushCheck(
    checks,
    'active/all-settled-fulfilled',
    rejections.length === 0,
    rejections.length === 0 ? '5/5 fulfilled' : `rejections=${rejections.join(' | ')}`,
  );
  pushCheck(
    checks,
    'active/replies-match',
    SESSION_SPECS.every((spec, index) => replies[index]?.includes(`reply:turn-${index + 1} ${spec.sentinel}`) === true),
    `replies=${replies.map((reply) => reply.slice(0, 80)).join(' | ')}`,
  );

  const spanBySentinel = new Map(spans.map((span) => [span.sentinel, span]));
  pushCheck(
    checks,
    'active/five-burst-spans-recorded',
    spans.length === SESSION_SPECS.length && spanBySentinel.size === SESSION_SPECS.length,
    `spans=${spans.length} distinctSentinels=${spanBySentinel.size}`,
  );

  const activeSessions: ActiveSessionRecord[] = SESSION_SPECS.map((spec) => {
    const span = spanBySentinel.get(spec.sentinel);
    if (span === undefined) {
      return {
        conversationId: spec.conversationId,
        sentinel: spec.sentinel,
        turnText: '(missing)',
        startEpochMs: 0,
        endEpochMs: 0,
        startOffsetMs: -1,
        endOffsetMs: -1,
        waitMs: -1,
        activeMs: -1,
      };
    }
    return {
      conversationId: spec.conversationId,
      sentinel: spec.sentinel,
      turnText: span.turnText,
      startEpochMs: span.startEpochMs,
      endEpochMs: span.endEpochMs,
      startOffsetMs: round(span.startMonoMs - burstMonoStart),
      endOffsetMs: round(span.endMonoMs - burstMonoStart),
      waitMs: round(span.startMonoMs - burstMonoStart),
      activeMs: round(span.endMonoMs - span.startMonoMs),
    };
  });

  const maxActive = maxOverlap(spans);
  // 等待超过半槽 = 真实经历过排队（不是并发噪声）。
  const queuedSessions = activeSessions.filter((record) => record.waitMs > holdMs / 2).length;
  const fifthWaitMs = Math.max(0, ...activeSessions.map((record) => record.waitMs));

  pushCheck(
    checks,
    `active/max-active-is-${mainConcurrency}`,
    maxActive === mainConcurrency,
    `maxOverlap=${maxActive}（期望 mainConcurrency=${mainConcurrency}）`,
  );
  pushCheck(
    checks,
    'active/exactly-one-queued',
    queuedSessions === 1,
    `queued(>${holdMs / 2}ms)=${queuedSessions}`,
  );
  pushCheck(
    checks,
    'active/fifth-waited-about-one-hold',
    fifthWaitMs >= holdMs * 0.5 && fifthWaitMs <= holdMs * 3,
    `最长等待=${fifthWaitMs}ms（hold=${holdMs}ms）`,
  );
  pushCheck(
    checks,
    'active/burst-wall-about-two-batches',
    burstMonoEnd - burstMonoStart >= holdMs && burstMonoEnd - burstMonoStart <= holdMs * 3,
    `突发墙钟=${round(burstMonoEnd - burstMonoStart)}ms`,
  );

  // ② 会话位置隔离（脚本化驱动不写盘）：装配层为每个会话解析的 Pi 会话位置必须互不相同，
  //    同一 principal 落在同一 principal 子树、子会话 id 互不重复；轨迹隔离证据在驱动输入面
  //    （下面 perViewSentinels）——装配层不再导出/搬运任何转录。
  const perViewSentinels = views.map((view) => {
    const found = new Set<string>();
    for (const text of view.observedTexts) {
      for (const spec of SESSION_SPECS) {
        if (sentinelFoundIn(text, spec)) found.add(spec.sentinel);
      }
    }
    return { viewIndex: view.viewIndex, sentinels: [...found] };
  });
  const locationOf = (view: DriverView): MainSessionLocation | undefined => view.location;
  const located = views.filter((view) => locationOf(view) !== undefined);
  const piSessionIds = new Set(located.map((view) => locationOf(view)!.piSessionId));
  const sessionDirs = new Set(located.map((view) => locationOf(view)!.sessionDir));
  const resumed = located.filter((view) => locationOf(view)!.resumeSessionFile !== undefined);
  pushCheck(
    checks,
    'isolation/session-location-present',
    located.length === views.length,
    `带位置的主驱动=${located.length}/${views.length}`,
  );
  pushCheck(
    checks,
    'isolation/session-locations-distinct',
    piSessionIds.size === views.length && sessionDirs.size === 1,
    `piSessionIds=${piSessionIds.size}/${views.length}，principal 子树数=${sessionDirs.size}（期望 1）`,
  );
  pushCheck(
    checks,
    'isolation/session-files-not-yet-written',
    resumed.length === 0,
    `已有落盘文件的会话=${resumed.length}（脚本化驱动不写盘，期望 0）`,
  );

  const isolationSessions: IsolationSessionRecord[] = views.map((view) => {
    const observed = view.observedTexts.join('\n');
    return {
      conversationId: SESSION_SPECS[view.viewIndex - 1]?.conversationId ?? `view-${view.viewIndex}`,
      sessionDir: view.location?.sessionDir ?? '',
      piSessionId: view.location?.piSessionId ?? '',
      observedSentinels: perViewSentinels[view.viewIndex - 1]?.sentinels ?? [],
      observationChars: observed.length,
      observationExcerpt: observed.slice(0, 300),
    };
  });

  const viewsWithExactlyOneSentinel = perViewSentinels.filter((view) => view.sentinels.length === 1).length;
  const coveredSentinels = new Set(perViewSentinels.flatMap((view) => view.sentinels));
  pushCheck(
    checks,
    'isolation/driver-views-count',
    views.length === SESSION_SPECS.length,
    `driverViews=${views.length}（期望 ${SESSION_SPECS.length}，每会话一个主驱动实例）`,
  );
  pushCheck(
    checks,
    'isolation/driver-each-sees-only-own',
    viewsWithExactlyOneSentinel === views.length && coveredSentinels.size === SESSION_SPECS.length,
    `每视图恰含 1 个哨兵的视图数=${viewsWithExactlyOneSentinel}/${views.length}，覆盖哨兵=${coveredSentinels.size}/${SESSION_SPECS.length}`,
  );

  const rss: RssReport = {
    baselineBytes: rssBaseline,
    afterWarmupBytes: rssAfterWarmup,
    peakBurstBytes: rssPeakBurst,
    endBurstBytes: rssEndBurst,
    perSessionFromWarmupBytes: round((rssPeakBurst - rssAfterWarmup) / SESSION_SPECS.length),
    perSessionFromBaselineBytes: round((rssPeakBurst - rssBaseline) / SESSION_SPECS.length),
    samplesDuringBurst: rssSamplesInBurst,
  };
  pushCheck(
    checks,
    'rss/baseline-and-peak-recorded',
    rssBaseline > 0 && rssPeakBurst > 0 && rssPeakBurst >= rssBaseline * 0.5,
    `baseline=${rssBaseline} peakBurst=${rssPeakBurst} samples=${rssSamplesInBurst}`,
  );

  return {
    active: {
      maxActive,
      expectedMaxActive: mainConcurrency,
      queuedSessions,
      fifthWaitMs,
      burstWallMs: round(burstMonoEnd - burstMonoStart),
      sessions: activeSessions,
      replies,
    },
    isolation: {
      driverViews: views.length,
      perViewSentinels,
      sessions: isolationSessions,
    },
    rss,
  };
}

// ── ③ SQLite 写竞争 ────────────────────────────────────────────────────────

interface SqliteWriteResult {
  readonly index: number;
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly ms: number;
}

interface SqliteTrack {
  readonly mode: 'single-connection' | 'worker-connections';
  readonly connections: number;
  readonly writes: number;
  readonly okWrites: number;
  readonly busyCount: number;
  readonly otherErrors: readonly string[];
  readonly totalMs: number;
  readonly tasks: number;
  readonly fileRefs: number;
  readonly distinctTaskNos: number;
  readonly workerMsMin?: number;
  readonly workerMsMax?: number;
  readonly workerMsAvg?: number;
}

const SQLITE_PRINCIPAL = 'r8:principal';
const SQLITE_SESSION = 'r8:session';

function taskRowFor(prefix: string, index: number, now: string) {
  return {
    taskId: `${prefix}-task-${index}`,
    principalId: SQLITE_PRINCIPAL,
    sessionId: SQLITE_SESSION,
    request: `r8 sqlite write ${index}`,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
}

function fileRefRowFor(prefix: string, index: number) {
  return {
    fileId: `${prefix}-file-${index}`,
    principalId: SQLITE_PRINCIPAL,
    sessionId: SQLITE_SESSION,
    taskId: `${prefix}-task-${index}`,
    name: `r8-${prefix}-${index}.txt`,
    sha256: sha256Of(`${prefix}-${index}`),
    bytes: 1,
    createdAt: Date.now(),
  };
}

async function runSqliteSingleConnection(dbPath: string): Promise<SqliteTrack> {
  const registry = createSqliteTaskRegistry(dbPath);
  const results: SqliteWriteResult[] = [];
  const started = performance.now();
  try {
    await Promise.all(
      Array.from({ length: SQLITE_WRITES }, async (_, index) => {
        // 先让出事件循环，让 20 笔写真实交错（仍共用生产同一条 better-sqlite3 连接）。
        await new Promise<void>((resolve) => setImmediate(resolve));
        const writeStarted = performance.now();
        try {
          const now = new Date().toISOString();
          registry.store.transaction(() => {
            registry.store.insertTask(taskRowFor('r8-single', index, now));
            registry.store.insertFileRef(fileRefRowFor('r8-single', index));
          });
          results.push({ index, ok: true, code: '', message: '', ms: round(performance.now() - writeStarted) });
        } catch (error) {
          results.push({
            index,
            ok: false,
            code: errorCodeOf(error),
            message: errorMessageOf(error),
            ms: round(performance.now() - writeStarted),
          });
        }
      }),
    );
    const totalMs = round(performance.now() - started);
    const tasks = registry.store.listTasks({ principalId: SQLITE_PRINCIPAL, sessionId: SQLITE_SESSION });
    const fileRefs = registry.store.listFileRefs({ principalId: SQLITE_PRINCIPAL, sessionId: SQLITE_SESSION });
    const taskNos = tasks
      .map((stored) => stored.task.taskNo)
      .filter((taskNo): taskNo is number => typeof taskNo === 'number');
    return {
      mode: 'single-connection',
      connections: 1,
      writes: SQLITE_WRITES,
      okWrites: results.filter((result) => result.ok).length,
      busyCount: results.filter((result) => isSqliteBusy(result.code, result.message)).length,
      otherErrors: results
        .filter((result) => !result.ok && !isSqliteBusy(result.code, result.message))
        .map((result) => `${result.code}: ${result.message}`),
      totalMs,
      tasks: tasks.length,
      fileRefs: fileRefs.length,
      distinctTaskNos: new Set(taskNos).size,
    };
  } finally {
    registry.close();
  }
}

interface SqliteWorkerMessage {
  readonly type: 'ready' | 'done' | 'fatal';
  readonly index?: number;
  readonly ok?: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly ms?: number;
}

interface WorkerHandle {
  readonly worker: Worker;
  next(): Promise<SqliteWorkerMessage>;
}

/**
 * worker 侧（eval 执行，CommonJS）：动态加载生产 TaskStore，只拉起 task-store 模块图
 * （node:fs/path + better-sqlite3），不加载 server/Pi。所有连接就绪后等共享闸门同时开写。
 */
const SQLITE_WRITER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let store;
  try {
    const { openTaskStore } = await import(workerData.storeUrl);
    store = openTaskStore(workerData.dbPath);
    const gate = new Int32Array(workerData.gate);
    parentPort.postMessage({ type: 'ready', index: workerData.index });
    const waited = Atomics.wait(gate, 0, 0, 30000);
    if (waited === 'timed-out') {
      parentPort.postMessage({ type: 'done', index: workerData.index, ok: false, code: 'GATE_TIMEOUT', message: 'gate timed out', ms: 0 });
      return;
    }
    const started = performance.now();
    try {
      const now = new Date().toISOString();
      store.transaction(() => {
        store.insertTask(workerData.task);
        store.insertFileRef(workerData.fileRef);
      });
      parentPort.postMessage({ type: 'done', index: workerData.index, ok: true, ms: performance.now() - started });
    } catch (error) {
      parentPort.postMessage({
        type: 'done',
        index: workerData.index,
        ok: false,
        code: (error && error.code) || 'UNKNOWN',
        message: String(error),
        ms: performance.now() - started,
      });
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'fatal',
      index: workerData.index,
      code: (error && error.code) || 'UNKNOWN',
      message: String(error),
    });
  } finally {
    if (store) {
      try { store.close(); } catch {}
    }
  }
})();
`;

function launchSqliteWriter(workerData: Record<string, unknown>): WorkerHandle {
  const queue: SqliteWorkerMessage[] = [];
  const waiters: Array<(message: SqliteWorkerMessage) => void> = [];
  const push = (message: SqliteWorkerMessage): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(message);
    else queue.push(message);
  };
  const worker = new Worker(SQLITE_WRITER_SOURCE, { eval: true, workerData });
  worker.on('message', (message) => push(message as SqliteWorkerMessage));
  worker.on('error', (error) =>
    push({ type: 'fatal', code: errorCodeOf(error), message: errorMessageOf(error) }),
  );
  worker.on('exit', (code) =>
    push({ type: 'fatal', code: 'WORKER_EXIT', message: `worker exited with code ${code}` }),
  );
  const next = (): Promise<SqliteWorkerMessage> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { worker, next };
}

async function runSqliteWorkerConnections(dbPath: string): Promise<SqliteTrack> {
  // 先以生产入口建 schema 再关闭：把建表/迁移排除在写竞争窗口之外。
  createSqliteTaskRegistry(dbPath).close();

  const gateBuffer = new SharedArrayBuffer(4);
  const gate = new Int32Array(gateBuffer);
  const handles = Array.from({ length: SQLITE_WRITES }, (_, index) =>
    launchSqliteWriter({
      storeUrl: TASK_STORE_MODULE_URL,
      dbPath,
      gate: gateBuffer,
      index,
      task: taskRowFor('r8-multi', index, new Date().toISOString()),
      fileRef: fileRefRowFor('r8-multi', index),
    }),
  );

  let earlyFailures: SqliteWorkerMessage[] = [];
  let doneMessages: SqliteWorkerMessage[] = [];
  let totalMs = 0;
  try {
    const readyMessages = await Promise.all(handles.map((handle) => handle.next()));
    earlyFailures = readyMessages.filter((message) => message.type !== 'ready');

    const started = performance.now();
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, SQLITE_WRITES);
    doneMessages = await Promise.all(handles.map((handle) => handle.next()));
    totalMs = round(performance.now() - started);
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.worker.terminate()));
  }

  const results: SqliteWriteResult[] = doneMessages
    .filter((message) => message.type === 'done')
    .map((message) => ({
      index: message.index ?? -1,
      ok: message.ok === true,
      code: message.code ?? '',
      message: message.message ?? '',
      ms: round(message.ms ?? 0),
    }));
  for (const failure of earlyFailures) {
    results.push({
      index: failure.index ?? -1,
      ok: false,
      code: failure.code ?? 'EARLY_FAILURE',
      message: failure.message ?? 'worker failed before gate',
      ms: 0,
    });
  }

  const workerTimes = results.map((result) => result.ms).filter((ms) => ms > 0);
  const registry = createSqliteTaskRegistry(dbPath);
  let tasks = 0;
  let fileRefs = 0;
  let distinctTaskNos = 0;
  try {
    const stored = registry.store.listTasks({ principalId: SQLITE_PRINCIPAL, sessionId: SQLITE_SESSION });
    const refs = registry.store.listFileRefs({ principalId: SQLITE_PRINCIPAL, sessionId: SQLITE_SESSION });
    tasks = stored.length;
    fileRefs = refs.length;
    distinctTaskNos = new Set(
      stored
        .map((entry) => entry.task.taskNo)
        .filter((taskNo): taskNo is number => typeof taskNo === 'number'),
    ).size;
  } finally {
    registry.close();
  }

  return {
    mode: 'worker-connections',
    connections: SQLITE_WRITES,
    writes: SQLITE_WRITES,
    okWrites: results.filter((result) => result.ok).length,
    busyCount: results.filter((result) => isSqliteBusy(result.code, result.message)).length,
    otherErrors: results
      .filter((result) => !result.ok && !isSqliteBusy(result.code, result.message))
      .map((result) => `${result.code}: ${result.message}`),
    totalMs,
    tasks,
    fileRefs,
    distinctTaskNos,
    ...(workerTimes.length === 0
      ? {}
      : {
          workerMsMin: Math.min(...workerTimes),
          workerMsMax: Math.max(...workerTimes),
          workerMsAvg: round(workerTimes.reduce((sum, ms) => sum + ms, 0) / workerTimes.length),
        }),
  };
}

function sqliteChecks(track: SqliteTrack, checks: Check[]): void {
  pushCheck(
    checks,
    `sqlite/${track.mode}/all-writes-ok`,
    track.okWrites === track.writes,
    `ok=${track.okWrites}/${track.writes} busy=${track.busyCount} other=${track.otherErrors.length}`,
  );
  pushCheck(
    checks,
    `sqlite/${track.mode}/rows-landed`,
    track.tasks === track.writes && track.fileRefs === track.writes && track.distinctTaskNos === track.writes,
    `tasks=${track.tasks} fileRefs=${track.fileRefs} distinctTaskNos=${track.distinctTaskNos}`,
  );
}

// ── CLI / main ─────────────────────────────────────────────────────────────

interface CliOptions {
  outDir?: string;
  holdMs: number;
  /** 前台并发档位（缺省 4；用于对比 4 vs 8 的 active 上限与每会话内存增量）。 */
  mainConcurrency: number;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = { holdMs: DEFAULT_HOLD_MS, mainConcurrency: DEFAULT_MAIN_CONCURRENCY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--out-dir 需要值');
      options.outDir = path.resolve(value);
      index += 1;
    } else if (arg === '--hold-ms') {
      const value = argv[index + 1];
      if (value === undefined || !Number.isSafeInteger(Number(value)) || Number(value) < 100) {
        throw new Error('--hold-ms 需要 ≥100 的整数');
      }
      options.holdMs = Number(value);
      index += 1;
    } else if (arg === '--main-concurrency') {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
        throw new Error('--main-concurrency 需要 1–32 的整数');
      }
      options.mainConcurrency = parsed;
      index += 1;
    } else {
      throw new Error(`未知参数：${arg}（支持 --out-dir / --hold-ms / --main-concurrency）`);
    }
  }
  return options;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  mainConcurrency = cli.mainConcurrency;
  SESSION_SPECS = buildSessionSpecs(mainConcurrency + 1);
  const outDir = cli.outDir ?? path.join(REPO_ROOT, '.runtime', 'eval-cap01-r8-concurrency', timestamp());
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'cap01-r8-concurrency-'));
  const checks: Check[] = [];
  const overallRssSamples: number[] = [];
  const overallSampler = setInterval(() => {
    overallRssSamples.push(process.memoryUsage().rss);
  }, 50);
  overallSampler.unref();

  console.log(`[cap01-r8] mode=scripted（零真模型）sessions=${SESSION_SPECS.length} holdMs=${cli.holdMs} sqliteWrites=${SQLITE_WRITES}`);
  console.log(`[cap01-r8] workDir=${workDir} outDir=${outDir}`);

  let active: ActiveReport | undefined;
  let isolation: IsolationReport | undefined;
  let rss: RssReport | undefined;
  let sqliteSingle: SqliteTrack | undefined;
  let sqliteWorkers: SqliteTrack | undefined;

  try {
    console.log('[cap01-r8] ── ① active 上限 + ② transcript 隔离（server 生产装配 · 假驱动）──');
    const scenario = await runConcurrencyScenario(workDir, cli.holdMs, checks, overallRssSamples);
    active = scenario.active;
    isolation = scenario.isolation;
    rss = scenario.rss;

    console.log('[cap01-r8] ── ③ SQLite 写竞争（20 笔 = task 行 + file_refs 行）──');
    const sqliteDir = path.join(workDir, 'sqlite');
    mkdirSync(sqliteDir, { recursive: true });
    sqliteSingle = await runSqliteSingleConnection(path.join(sqliteDir, 'single-connection.db'));
    sqliteChecks(sqliteSingle, checks);
    sqliteWorkers = await runSqliteWorkerConnections(path.join(sqliteDir, 'worker-connections.db'));
    sqliteChecks(sqliteWorkers, checks);

    // ③ 不是「要么有 BUSY 要么失败」：无 BUSY 也是有效读数；总耗时照实记录，不设人为上限。
    pushCheck(
      checks,
      'sqlite/no-busy',
      sqliteSingle.busyCount === 0 && sqliteWorkers.busyCount === 0,
      `busy single=${sqliteSingle.busyCount} workers=${sqliteWorkers.busyCount}；totalMs single=${sqliteSingle.totalMs} workers=${sqliteWorkers.totalMs}`,
    );
  } finally {
    clearInterval(overallSampler);
    rmSync(workDir, { recursive: true, force: true });
  }

  const peakOverallBytes = Math.max(...overallRssSamples, rss?.peakBurstBytes ?? 0);
  const sqlite = {
    singleConnection: sqliteSingle,
    workerConnections: sqliteWorkers,
    note: 'single-connection = 生产同连接（server/ask 共用一条 TaskStore 连接）20 个逻辑并发写；worker-connections = 20 个独立生产连接经共享闸门同时开写。SQLITE_BUSY 计数来自 better-sqlite3 error.code / message。',
  };

  const summary = {
    mode: 'scripted' as const,
    model: 'scripted（零真模型调用）',
    generatedAt: new Date().toISOString(),
    config: {
      sessions: SESSION_SPECS.length,
      holdMs: cli.holdMs,
      sqliteWrites: SQLITE_WRITES,
      expectedMaxActive: mainConcurrency,
      queueCapacity: 16,
    },
    active,
    isolation,
    sqlite,
    rss: {
      ...rss,
      peakOverallBytes,
      perSessionFormula: 'perSessionFromWarmupBytes = (peakBurstBytes - afterWarmupBytes) / 5；perSessionFromBaselineBytes 另含 server/装配/预热开销，作上界。',
    },
    checks,
    allPass: checks.every((check) => check.pass),
  };

  const summaryPath = path.join(outDir, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  for (const check of checks) {
    console.log(`[cap01-r8] ${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`);
  }
  if (active !== undefined) {
    console.log(
      `[cap01-r8] active: max=${active.maxActive} queued=${active.queuedSessions} fifthWait=${active.fifthWaitMs}ms wall=${active.burstWallMs}ms`,
    );
    for (const session of active.sessions) {
      console.log(
        `[cap01-r8]   ${session.conversationId} ${session.turnText}: start=+${session.startOffsetMs}ms end=+${session.endOffsetMs}ms wait=${session.waitMs}ms active=${session.activeMs}ms`,
      );
    }
  }
  if (isolation !== undefined) {
    console.log(
      `[cap01-r8] isolation: driverViews=${isolation.driverViews} sessions=${isolation.sessions.length} foreignHits=${isolation.sessions.reduce((sum, session) => sum + session.observedSentinels.filter((sentinel) => sentinel !== session.observedSentinels[0]).length, 0)}`,
    );
  }
  if (sqliteSingle !== undefined && sqliteWorkers !== undefined) {
    console.log(
      `[cap01-r8] sqlite single: ok=${sqliteSingle.okWrites}/${sqliteSingle.writes} busy=${sqliteSingle.busyCount} total=${sqliteSingle.totalMs}ms rows=${sqliteSingle.tasks}/${sqliteSingle.fileRefs}`,
    );
    console.log(
      `[cap01-r8] sqlite workers: ok=${sqliteWorkers.okWrites}/${sqliteWorkers.writes} busy=${sqliteWorkers.busyCount} total=${sqliteWorkers.totalMs}ms rows=${sqliteWorkers.tasks}/${sqliteWorkers.fileRefs} perWrite=${sqliteWorkers.workerMsMin ?? '-'}~${sqliteWorkers.workerMsMax ?? '-'}ms`,
    );
  }
  if (rss !== undefined) {
    console.log(
      `[cap01-r8] rss: baseline=${rss.baselineBytes} afterWarmup=${rss.afterWarmupBytes} peakBurst=${rss.peakBurstBytes} peakOverall=${peakOverallBytes} perSession(warmup)=${rss.perSessionFromWarmupBytes} perSession(baseline)=${rss.perSessionFromBaselineBytes}`,
    );
  }
  console.log(`[cap01-r8] 汇总=${summaryPath} allPass=${summary.allPass}`);
  console.log(`[cap01-r8] RESULT ${JSON.stringify({ allPass: summary.allPass, summaryPath })}`);
  if (!summary.allPass) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error('[cap01-r8] 入口失败：', error);
    process.exitCode = 1;
  });
}
