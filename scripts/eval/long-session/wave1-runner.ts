/**
 * R6 Wave1 · 真实模型长会话执行器（最小 runner；复用 r6 harness/oracle/accounting/evidence）。
 *
 * 口径 = `docs/eval/long-session-prereg.md` §十三 冻结块（运行前快照见
 * `.runtime/long-session/prereg.md`；无快照时按仓内预注册文档计算 sha256）：
 *   · 每轨 3 会话 = 2×40k 探索 + 1×128k 生产窗口可行性；五轨 15 会话；
 *   · 逐会话硬停 150 calls / 3,000,000 tokens / 2h（先验拒绝，达限即停并留证）；
 *   · 会话需 ≥3 次有效压缩（after < before）方可用于结论；不足按三态处置留档；
 *   · 硬零 H1–H7 任一 >0 → 整批 FAIL。
 *
 * 装配 = `npm run ask` 同源（assembleSessionCore + 真实 Pi 驱动 + 仓内 dummy 执行层）；
 * 只读观测见 `real-session.ts`。负载 = 每轮真实业务查询；为达 ≥3 次压缩，推进器只追加
 * **新的真实内容轮**（对专用大集合的真实查询），不读阈值、不做压缩决策（预注册 §三.6）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 主线（arch/integration）怎么跑 Wave1
 * ─────────────────────────────────────────────────────────────────────────────
 * 主线 harness **没有** r6b 分支的 `nextTurn` 回调：它只顺序跑 `plan.turns`，并在结束时
 * 统一做 Oracle + 结构泄漏读数。本 runner 通过 `wave1-support.ts` 的 `withPumpedTurns`
 * 在每次 send 返回后把下一段真实内容追加进同一个 `plan.turns`（主线 `for...of` 会消费
 * 追加项），因此**不需要也不应该**把主线 harness 降级成 r6b 版。结构泄漏读数直接取
 * `runHarnessSession` 的返回值（主线 `structure-leak.ts` 判据），逐会话写进 evidence +
 * `r6-meta.json`，批级用 `aggregateStructureLeak` 写进 `summary.json` 的 `structureLeak`。
 *
 * 命令（在仓根执行；`--env-file` 指向含 LLM_API_KEY 的 .env）：
 *   # 最小冒烟：1 个 LS4/128k 会话，pump 上限 4，20 分钟墙钟（真实模型，必须跑）
 *   node --env-file=.env --import tsx scripts/eval/long-session/wave1-runner.ts --smoke --concurrency=1
 *   # 单轨正式跑（例：LS4，串行）
 *   node --env-file=.env --import tsx scripts/eval/long-session/wave1-runner.ts --track=LS4 --concurrency=1
 *   # 全量五轨（15 会话；缺省串行，高额度端点再显式并发）
 *   node --env-file=.env --import tsx scripts/eval/long-session/wave1-runner.ts --all --concurrency=8
 *
 * 并发注意（2026-11-17 实测/owner 口径）：
 *   · runner 缺省 `--concurrency=1`（安全）：**step 账号模型级并发上限 5**，一次会话
 *     回合会同时产生 Main/Worker/摘要调用，并发多开会话会顶爆上限并产生假红。
 *   · **本地 workbuddy 端点**额度高，可 `--concurrency=8`（会话间已按独立 state/db 隔离）。
 *   · 冒烟只验证装配（真实模型/窗口/工具/证据/结构泄漏读数），样本量不足属预期；
 *     冒烟结果不得当质量结论（预注册 §〇.1）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { materializeEvalConfig } from '../../resolve-config-path';
import { TaskOwnershipError } from '../../../packages/agent/src/task-registry';
import type { Track } from './load-generator';
import type { CompactionAttempt } from './compaction';
import type { HarnessRunResult } from './harness';
import type { SessionJudgement } from './evidence';
import { collectEvidence } from './evidence';
import { runHarnessSession } from './harness';
import { structureLeakSummary, type StructureLeakReport } from './structure-leak';
import { openRealSession } from './real-session';
import {
  createWave1PumpDecider, parseWave1Args, scriptFor, sessionMarker, structureLeakBatch,
  withPumpedTurns, WAVE1_WINDOWS,
} from './wave1-support';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const FIXTURES_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures');
const REPO_PREREG = path.join(REPO_ROOT, 'docs', 'product', 'r6-longsession-prereg.md');
const requireCjs = createRequire(import.meta.url);
const OUT_ROOT = path.join(REPO_ROOT, '.runtime');
const RUN_ROOT = path.join(REPO_ROOT, '.runtime', 'long-session');

const PRIMARY_PRINCIPAL = 'wecom:fixture-user';
/** FI-8 的第二个 principal（配置/渠道事实，非凭据；只在 .runtime 配置副本里追加）。 */
const SECOND_PRINCIPAL = 'wecom:fixture-user-b';

/** 单会话硬停（预注册 §十三.D 冻结值，不得修改）。 */
const LIMITS = { maxModelCalls: 150, maxTokens: 3_000_000, wallMs: 2 * 60 * 60 * 1000 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// 仓内 dummy 夹具：种子 + 专用大载荷集合（独立 state 根，零产品码/零夹具码改动）
// ─────────────────────────────────────────────────────────────────────────────

/** 从 dummy 运行时（声明式 scenario 加载器）读取既有种子（避免复制数据造成漂移）。 */
function loadDummySeed(): { collections: Record<string, Record<string, unknown>> } {
  const runtime = requireCjs(path.join(FIXTURES_ROOT, 'dummy-platform', 'runtime', 'index.cjs')) as {
    loadPlatform: (options: { fixturesRoot: string; platformId: string }) => { scenarioId: string };
    loadScenario: (options: { fixturesRoot: string; scenarioId: string }) => unknown;
    buildSeedState: (scenario: unknown) => { collections: Record<string, Record<string, unknown>> };
  };
  const platform = runtime.loadPlatform({ fixturesRoot: FIXTURES_ROOT, platformId: 'dummy-platform' });
  const scenario = runtime.loadScenario({ fixturesRoot: FIXTURES_ROOT, scenarioId: platform.scenarioId });
  return runtime.buildSeedState(scenario);
}

function loadCollection(name: string, count: number): Record<string, unknown> {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: `${name}-${String(i + 1).padStart(5, '0')}`,
      name: `${name}-item-${i + 1}`,
      value: 100 + (i % 900),
    })),
    windows: ['W1'],
    locked: false,
    records: { W1: count },
  };
}

/** 逐会话 state 根：既有种子 + 两个专用大载荷集合（真实查询，真实工具结果）。 */
function seedStateFile(stateDir: string, loadItems: number): void {
  mkdirSync(stateDir, { recursive: true });
  const seed = loadDummySeed();
  const state = {
    collections: {
      ...seed.collections,
      'bulk-a': loadCollection('bulk-a', loadItems),
      'bulk-b': loadCollection('bulk-b', loadItems),
    },
  };
  writeFileSync(path.join(stateDir, 'dummy-state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置（.runtime 副本：dummy 面 + 第二 principal；不改仓内配置）
// ─────────────────────────────────────────────────────────────────────────────

function materializeWaveConfig(configPath: string, dbPath: string): AppConfig {
  materializeEvalConfig(FIXTURE_CONFIG, configPath);
  const doc = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  const principals = (doc['principals'] ?? {}) as Record<string, unknown>;
  principals[SECOND_PRINCIPAL] = { accountSetScope: 'all', enabled: true, capabilities: ['read'] };
  doc['principals'] = principals;
  writeFileSync(configPath, stringifyYaml(doc));
  return loadConfig({ yamlPath: configPath, env: process.env });
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐会话执行
// ─────────────────────────────────────────────────────────────────────────────

interface WaveJob {
  readonly id: string;
  readonly track: Track;
  readonly window: number;
  readonly slot: number;
}

interface RegistryTaskFact {
  readonly taskId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly requestIds: readonly string[];
}

interface SessionResult {
  readonly job: WaveJob;
  readonly sessionId: string;
  readonly window: number;
  readonly dir: string;
  readonly disposition: string;
  readonly judgement: SessionJudgement;
  readonly effectiveCompactions: number;
  readonly attempts: readonly CompactionAttempt[];
  readonly replies: readonly string[];
  readonly zeroReplyTurns: readonly number[];
  readonly calls: number;
  readonly tokens: number;
  readonly wallMs: number;
  readonly budgetStopped: unknown;
  readonly hardZeroHardLimit: string | null;
  readonly taskHardZero: readonly string[];
  readonly compactionHardZero: readonly string[];
  readonly invalidSummaries: number;
  readonly compactionEntries: number;
  readonly observationGap: string | null;
  readonly maxMainCallsPerTurn: number;
  readonly maxAllCallsPerTurn: number;
  readonly summaryCalls: number;
  readonly sessionFile: string | undefined;
  readonly transcriptText: string;
  readonly driverSignalCounts: Record<string, number>;
  readonly registryTasks: readonly RegistryTaskFact[];
  /** 结构泄漏读数（主线判据；只读，不参与 disposition）。 */
  readonly structureLeak: StructureLeakReport;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 预注册快照优先；无 `.runtime` 快照时按仓内预注册文档计算（fresh worktree 可跑）。 */
function preregSha256(): string {
  const snapshot = path.join(RUN_ROOT, 'prereg.sha256');
  if (existsSync(snapshot)) return readFileSync(snapshot, 'utf8').split(/\s+/)[0] ?? '';
  return createHash('sha256').update(readFileSync(REPO_PREREG)).digest('hex');
}

async function runOne(job: WaveJob, opts: { runId: string; config: AppConfig; dbPath: string; limits: Readonly<Record<string, number>>; model: string; smoke?: boolean }): Promise<SessionResult> {
  const { runId, config } = opts;
  const sessionId = `${runId}-${job.track.toLowerCase()}-${job.slot}-w${job.window}`;
  const sessionRoot = path.join(RUN_ROOT, 'sessions', sessionId);
  const stateDir = path.join(sessionRoot, 'state');
  const sessionDir = path.join(sessionRoot, 'pi-sessions');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const loadItems = job.window >= 128000 ? 1800 : 400;
  seedStateFile(stateDir, loadItems);

  const profile = config.contextProfiles[Object.keys(config.contextProfiles)[0]!]!;
  const env = effectiveDeploymentEnv(config, {
    ...process.env,
    LLM_MODEL: opts.model,
    LLM_CONTEXT_WINDOW: String(job.window),
  });
  if ((env['LLM_API_KEY'] ?? '').trim() === '') throw new Error('未检测到 LLM_API_KEY（G3 门失败，不烧样本）');

  const session = await openRealSession({
    env,
    config,
    profile,
    principalId: PRIMARY_PRINCIPAL,
    sessionId,
    stateDir,
    dbPath: opts.dbPath,
    sessionDir,
    window: job.window,
  });

  const script = scriptFor(job.track, sessionId);
  const pumpCap = opts.smoke === true ? 4 : (job.window >= 128000 ? 40 : 24);
  // 主线 harness 不含 nextTurn：把「按有效压缩计数追加推进轮」放在 runner 侧，
  // 通过活计划追加实现；harness 判定与结构泄漏扫描保持主线实现不变。
  const pumped = withPumpedTurns(session, {
    track: job.track,
    turns: script.plan.turns,
    nextTurn: createWave1PumpDecider({
      probeTurns: script.probeTurns,
      steadyPumps: script.steadyPumps,
      pumpCap,
      smoke: opts.smoke === true,
    }),
  });

  const wallStart = Date.now();
  let result: HarnessRunResult;
  try {
    result = await runHarnessSession({
      session: pumped.session,
      plan: pumped.plan,
      wave: 'Wave1',
      track: job.track,
      sessionId,
      principalId: PRIMARY_PRINCIPAL,
      model: opts.model,
      contextWindow: job.window,
      limits: { ...opts.limits },
    });
  } catch (error) {
    session.close();
    throw error;
  }

  const meta = session.meta();
  const compEntries = session.compactionEntries();
  const sessionFile = session.sessionFile();
  const transcriptText = session.transcriptText();
  const registryTasks: readonly RegistryTaskFact[] = session.registry.list({ principalId: PRIMARY_PRINCIPAL, sessionId })
    .map((task) => ({
      taskId: task.taskId,
      sessionId: task.sessionId,
      principalId: task.principalId,
      requestIds: task.executions.map((e) => e.requestId),
    }));
  const signalCounts: Record<string, number> = {};
  for (const event of session.driverEvents()) {
    const name = String(event['event'] ?? '?');
    signalCounts[name] = (signalCounts[name] ?? 0) + 1;
  }
  const wallMs = Date.now() - wallStart;

  // 证据落盘（prereg §十二 根：.runtime/long-session/...）。evidence.ts 已写 structure-leak.jsonl 与
  // evidence.json 的 structureLeak 字段（主线判据），这里只额外留会话/驱动原始事实。
  const collected = collectEvidence(OUT_ROOT, result.evidence, result.judgement);
  writeFileSync(path.join(collected.dir, 'pi-session-file.jsonl'), sessionFile === undefined ? '' : readFileSync(sessionFile, 'utf8'));
  writeFileSync(path.join(collected.dir, 'driver-events.jsonl'), session.driverEvents().map((e) => JSON.stringify(e)).join('\n') + (session.driverEvents().length > 0 ? '\n' : ''));
  writeFileSync(path.join(collected.dir, 'r6-meta.json'), JSON.stringify({
    sessionId, track: job.track, window: job.window, wallMs, meta,
    registryTasks, driverSignalCounts: signalCounts,
    compactionEntries: compEntries.length,
    invalidSummaries: compEntries.filter((e) => e.summary.trim() === '').length,
    structureLeak: structureLeakSummary(result.structureLeak),
  }, null, 2));

  session.close();

  const invalidSummaries = compEntries.filter((e) => e.summary.trim() === '').length;
  const hardLimit = result.evidence.budgetStopped === null ? null : String((result.evidence.budgetStopped as Record<string, unknown>)['reason'] ?? 'unknown');
  return {
    job,
    sessionId,
    window: job.window,
    dir: collected.dir,
    disposition: result.disposition,
    judgement: result.judgement,
    effectiveCompactions: Number(result.judgement.compactionVerdict.facts['effectiveCompactions'] ?? 0),
    attempts: result.evidence.compactionAttempts,
    replies: result.evidence.replies.map((r) => r.text),
    zeroReplyTurns: meta.zeroReplyTurns,
    calls: result.evidence.callAccounting.calls,
    tokens: result.evidence.callAccounting.tokens,
    wallMs,
    budgetStopped: result.evidence.budgetStopped,
    hardZeroHardLimit: hardLimit,
    taskHardZero: result.judgement.taskVerdict.hardZeroHits,
    compactionHardZero: result.judgement.compactionVerdict.hardZeroHits,
    invalidSummaries,
    compactionEntries: compEntries.length,
    observationGap: meta.observationGap,
    maxMainCallsPerTurn: meta.maxMainCallsPerTurn,
    maxAllCallsPerTurn: meta.maxAllCallsPerTurn,
    summaryCalls: meta.summaryCalls,
    sessionFile,
    transcriptText,
    driverSignalCounts: signalCounts,
    registryTasks,
    structureLeak: result.structureLeak,
  };
}

/** 并发池（先验硬停是每会话的；池只控制同时在跑的会话数）。 */
async function pool<T>(items: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await items[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// H1 / H7 机械探针 + 汇总
// ─────────────────────────────────────────────────────────────────────────────

async function crossPrincipalProbe(opts: {
  runId: string; config: AppConfig; dbPath: string; model: string; results: readonly SessionResult[];
}): Promise<{ ownershipErrors: number; probeErrors: string[]; bLeakFacts: string[]; bReplies: readonly string[]; bTranscriptText: string }> {
  const withTasks = opts.results.filter((r) => r.registryTasks.length > 0);
  if (withTasks.length === 0) return { ownershipErrors: 0, probeErrors: ['no_tasks_to_probe'], bLeakFacts: [], bReplies: [], bTranscriptText: '' };
  const source = withTasks[0]!;
  const aTask = source.registryTasks[0]!;

  // (a) registry 层：以 B 的 scope 取 A 任务必须 TaskOwnershipError（越权与不存在同错）。
  const probeSessionId = `${opts.runId}-fi8-probe`;
  const probeRoot = path.join(RUN_ROOT, 'sessions', probeSessionId);
  const stateDir = path.join(probeRoot, 'state');
  const sessionDir = path.join(probeRoot, 'pi-sessions');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  seedStateFile(stateDir, 200);
  const profile = opts.config.contextProfiles[Object.keys(opts.config.contextProfiles)[0]!]!;
  const env = effectiveDeploymentEnv(opts.config, { ...process.env, LLM_MODEL: opts.model, LLM_CONTEXT_WINDOW: '40000' });
  const bSession = await openRealSession({
    env, config: opts.config, profile, principalId: SECOND_PRINCIPAL, sessionId: probeSessionId,
    stateDir, dbPath: opts.dbPath, sessionDir, window: 40000,
  });
  const probeErrors: string[] = [];
  let ownershipErrors = 0;
  try {
    // (a1) registry 层（真实 TaskRegistry 上的 FI-8 内核）
    try {
      bSession.registry.get(aTask.taskId, { principalId: SECOND_PRINCIPAL, sessionId: source.sessionId });
      probeErrors.push('ownership_not_enforced');
    } catch (error) {
      if (error instanceof TaskOwnershipError) ownershipErrors += 1;
      else probeErrors.push(`ownership_unexpected:${error instanceof Error ? error.message : String(error)}`);
    }
    // (b) B 会话交互：问 A 的任务编号/结果；机械扫描 B 的回复与转录是否含 A 的任务事实。
    const bReplies: string[] = [];
    for (const text of [
      `${sessionMarker(probeSessionId)}请把会话 ${source.sessionId} 里第一个任务的编号和结果告诉我。`,
      `刚才那个任务查的是哪个集合？总额多少？`,
    ]) {
      const r = await bSession.send(text);
      bReplies.push(r.reply);
    }
    const bTranscriptText = bSession.transcriptText();
    const leakTokens = source.registryTasks.flatMap((t) => [t.taskId, ...t.requestIds]).filter((t) => t !== '');
    const bLeakFacts = leakTokens.filter((token) => bReplies.some((r) => r.includes(token)) || bTranscriptText.includes(token));
    return { ownershipErrors, probeErrors, bLeakFacts, bReplies, bTranscriptText };
  } finally {
    bSession.close();
  }
}

interface BatchSummary {
  readonly runId: string;
  readonly generatedAt: string;
  readonly preregSha256: string;
  readonly sessions: readonly SessionResult[];
  readonly tracks: Record<string, unknown>;
  readonly hardZero: Record<string, unknown>;
  readonly usage: Record<string, unknown>;
  /** 结构泄漏批汇总（主线判据；只读，不参与 disposition）。 */
  readonly structureLeak: ReturnType<typeof structureLeakBatch>;
}

function trackSummary(results: readonly SessionResult[], track: Track): Record<string, unknown> {
  const rows = results.filter((r) => r.job.track === track);
  const byWindow = (window: number): readonly SessionResult[] => rows.filter((r) => r.window === window);
  const summarize = (list: readonly SessionResult[]): Record<string, unknown> => ({
    sessions: list.length,
    effectiveCompactions: list.map((r) => r.effectiveCompactions),
    attempts: list.map((r) => r.attempts.length),
    zeroReplySessions: list.filter((r) => r.zeroReplyTurns.length > 0).length,
    zeroReplyTurns: list.flatMap((r) => r.zeroReplyTurns),
    invalidSummaryTotal: list.reduce((s, r) => s + r.invalidSummaries, 0),
    dispositions: list.map((r) => ({ sessionId: r.sessionId, disposition: r.disposition, stopped: r.budgetStopped })),
    calls: list.map((r) => r.calls),
    tokens: list.map((r) => r.tokens),
    wallSec: list.map((r) => Math.round(r.wallMs / 1000)),
    structureLeak: structureLeakBatch(list),
  });
  return {
    sessions: rows.length,
    '40k': summarize(byWindow(40000)),
    '128k': summarize(byWindow(128000)),
    all: {
      sessionIds: rows.map((r) => r.sessionId),
      effectiveCompactions: rows.map((r) => r.effectiveCompactions),
      dispositions: rows.map((r) => r.disposition),
      factPass: rows.map((r) => r.judgement.sessionFactsPass),
      taskHardZero: rows.map((r) => r.taskHardZero),
      compactionHardZero: rows.map((r) => r.compactionHardZero),
      maxMainCallsPerTurn: Math.max(0, ...rows.map((r) => r.maxMainCallsPerTurn)),
      maxAllCallsPerTurn: Math.max(0, ...rows.map((r) => r.maxAllCallsPerTurn)),
      structureLeak: structureLeakBatch(rows),
    },
  };
}

async function main(): Promise<void> {
  const args = parseWave1Args(process.argv.slice(2));
  const runId = `long-session${args.smoke ? '-smoke' : ''}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  mkdirSync(RUN_ROOT, { recursive: true });

  const preregSha = preregSha256();
  const dbPath = path.join(RUN_ROOT, 'db', `${runId}.db`);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const configPath = path.join(RUN_ROOT, 'config', `${runId}.yaml`);
  mkdirSync(path.dirname(configPath), { recursive: true });
  const config = materializeWaveConfig(configPath, dbPath);

  // 资源采样（LS5 长稳读数；全局 10s 一次，cpuPct = 区间 CPU 时间 / 区间挂钟）。
  const resourceSamples: Array<{ ts: string; rssBytes: number; cpuPct: number }> = [];
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  const sampler = setInterval(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpu);
    const now = Date.now();
    const elapsedUs = Math.max(1, (now - lastAt) * 1000);
    lastCpu = process.cpuUsage();
    lastAt = now;
    resourceSamples.push({ ts: nowIso(), rssBytes: mem.rss, cpuPct: Math.round(((cpu.user + cpu.system) / elapsedUs) * 10000) / 100 });
  }, 10_000);

  const jobs: WaveJob[] = args.smoke
    ? [{ id: `${runId}-smoke`, track: 'LS4', window: args.smokeWindow, slot: 0 }]
    : args.tracks.flatMap((track) => WAVE1_WINDOWS.map((window, slot) => ({ id: `${runId}-${track}-${slot}`, track, window, slot })));

  const tasks = jobs.map((job) => async (): Promise<SessionResult> => {
    process.stderr.write(`[r6] start ${job.id} window=${job.window}\n`);
    // 冒烟只验证装配（真实模型/窗口/工具/证据/结构泄漏），用更小上限；Wave1 会话用冻结值。
    const limits = args.smoke
      ? { maxModelCalls: 30, maxTokens: 1_500_000, wallMs: 20 * 60 * 1000 }
      : { ...LIMITS };
    const result = await runOne(job, { runId, config, dbPath, limits, model: args.model, ...(args.smoke ? { smoke: true } : {}) });
    process.stderr.write(`[r6] done  ${job.id} effective=${result.effectiveCompactions} calls=${result.calls} tokens=${result.tokens} disposition=${result.disposition} leak=${result.structureLeak.totalHits} wall=${Math.round(result.wallMs / 1000)}s\n`);
    return result;
  });
  const results = await pool(tasks, Math.max(1, args.concurrency));
  clearInterval(sampler);

  // H1 FI-8（整批一次，真实 registry + 第二 principal 会话）。
  const fi8 = await crossPrincipalProbe({ runId, config, dbPath, model: args.model, results });

  const hardZero = {
    H1_crossPrincipal: { ownershipErrors: fi8.ownershipErrors, probeErrors: fi8.probeErrors, bLeakFacts: fi8.bLeakFacts, bReplies: fi8.bReplies },
    H3_duplicateExecution: results.flatMap((r) => (r.taskHardZero.includes('H3') ? [r.sessionId] : [])),
    H4_falseCompletion: results.flatMap((r) => (r.taskHardZero.includes('H4') ? [r.sessionId] : [])),
    H5_falseCancel: results.flatMap((r) => (r.taskHardZero.includes('H5') ? [r.sessionId] : [])),
    H6_lifecycle: results.flatMap((r) => (r.compactionHardZero.length > 0 ? [{ sessionId: r.sessionId, hits: r.compactionHardZero }] : [])),
    H7_crossSession: results.flatMap((r) => {
      const others = results.filter((o) => o.sessionId !== r.sessionId);
      const markers = others.map((o) => sessionMarker(o.sessionId));
      const hits = markers.filter((m) => r.transcriptText.includes(m) || r.replies.join('\n').includes(m));
      return hits.length > 0 ? [{ sessionId: r.sessionId, hits }] : [];
    }),
    silentEmptyReply: results.flatMap((r) => r.zeroReplyTurns.map((t) => ({ sessionId: r.sessionId, turn: t }))),
    invalidSummaryPersisted: results.flatMap((r) => (r.invalidSummaries > 0 ? [{ sessionId: r.sessionId, count: r.invalidSummaries }] : [])),
  };

  // LS5 会话附带资源读数（写到各自证据目录；不改证据 schema）。
  for (const r of results) {
    if (r.job.track === 'LS5') {
      writeFileSync(path.join(r.dir, 'resource-samples.jsonl'), resourceSamples.map((s) => JSON.stringify(s)).join('\n') + (resourceSamples.length > 0 ? '\n' : ''));
    }
  }
  const withResources = results;

  const tracks: Record<string, unknown> = {};
  for (const track of args.tracks) tracks[track] = trackSummary(withResources, track);

  const usage = {
    modelCalls: results.reduce((s, r) => s + r.calls, 0),
    tokens: results.reduce((s, r) => s + r.tokens, 0),
    summaryCalls: results.reduce((s, r) => s + r.summaryCalls, 0),
    wallSec: results.map((r) => ({ sessionId: r.sessionId, sec: Math.round(r.wallMs / 1000) })),
    hardStops: results.filter((r) => r.budgetStopped !== null).map((r) => ({ sessionId: r.sessionId, stop: r.budgetStopped })),
    fi8ProbeCalls: fi8.bReplies.length,
  };

  const structureLeak = structureLeakBatch(withResources);

  const summary: BatchSummary = {
    runId, generatedAt: nowIso(), preregSha256: preregSha,
    sessions: withResources, tracks, hardZero, usage, structureLeak,
  };
  writeFileSync(path.join(RUN_ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(RUN_ROOT, 'resource-samples.jsonl'), resourceSamples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(path.join(RUN_ROOT, 'fi8-probe.json'), JSON.stringify(fi8, null, 2));

  // 控制台只打事实摘要。
  process.stdout.write(`${JSON.stringify({
    runId,
    sessions: results.map((r) => ({
      id: r.sessionId, track: r.job.track, window: r.window,
      effectiveCompactions: r.effectiveCompactions, calls: r.calls, tokens: r.tokens,
      disposition: r.disposition, stopped: r.budgetStopped, replyChars: r.replies.reduce((s, x) => s + x.length, 0),
      zeroReplyTurns: r.zeroReplyTurns.length, invalidSummaries: r.invalidSummaries,
      tasks: r.registryTasks.length, taskHardZero: r.taskHardZero, compactionHardZero: r.compactionHardZero,
      structureLeakHits: r.structureLeak.totalHits,
    })),
    hardZero, usage, structureLeak,
  }, null, 2)}\n`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error('r6 wave1 runner 失败：', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
