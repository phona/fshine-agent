/**
 * bizbatch2 三实验执行器（装配与证据采集）——真实模型驱动器；本文件在装配自检阶段**不调真实模型**
 * （selftest 注入确定性假 driver / 假执行面）。
 *
 * 与探测基线驱动器（`../model-executor`）的差异（本实验面专属）：
 *   · 每用例可选 **inline + 直接注入 TaskRunner**（缺口 1 四工具同源门控；缺口 1 设计 §3.3 的合法装配）
 *     或 background 派发（本批不用）；
 *   · 每用例可选 **Main 技能臂**：经装配参数 `mainSkillsDir` 指向夹具技能目录（catalog 唯一形态；不写配置键）；
 *   · 每用例可选 **小 LLM_CONTEXT_WINDOW**（缺口 3）：经 env 走 `effectiveDeploymentEnv` → 装配层
 *     `contextWindowFrom` → 驱动 contextWindow；
 *   · 逐回合记录 Main 工具面、逐回合模型调用数（压缩触发点）、read_skill 命中、预置任务编号；
 *   · 多轮会话：存在 runner 时每回合后 `whenIdle()`（等待后台/接续回合落定）。
 *
 * 纪律：源码/装配路径与生产同源（复用 `assembleSessionCore` / `resolveExecutionFace` /
 * `createBackgroundDispatch`），不建影子运行时；证据只读事实，不判（判归 `../judge`）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput } from '../../../../packages/agent/src/driver-contract';
import { createResourcePolicy } from '../../../../packages/agent/src/resource-policy';
import { createSqliteTaskRegistry } from '../../../../packages/agent/src/task-registry-sqlite';
import type { TaskScope } from '../../../../packages/agent/src/task-registry';
import type { TaskRunner } from '../../../../packages/agent/src/task-runner';
import { defaultMainSkillsDir, loadMainSkillDelivery } from '../../../../packages/agent/src/worker-skills';
import { materializeEvalConfig } from '../../../resolve-config-path';
import { assembleSessionCore, contextWindowFrom, createBackgroundDispatch, resolveExecutionFace } from '../../../ask-runtime';
import type { DriverFactory, ExecutionFaceFactory } from '../../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../../safety-gate';
import { claimsCompletionHeuristic, executionFactsFromToolCalls } from '../sample-from-run';
import type { SampleRecord } from '../judge';
import type { ExpCase, ExpItem } from './model';
import { effectiveTurns, EXP_HARD_LIMITS } from './model';
import type { ExpEvidence } from './judge';
import type { InputsFile, MetaFile, MetaTurn, ReplyLine, TaskRecordJson, ToolCallRecord } from '../../convergence-r1/evidence';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

/** 会话墙钟兜底：超过 ms 即 reject（底层 send 仍在跑但样本落 failed，防止无限挂起）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error(`${label}：已超出墙钟预算`));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}：超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 执行一个（用例×trial）样本，产出实验证据。真实/假件同签名。 */
export type ExpExecutor = (item: ExpItem, caseDef: ExpCase, workDir: string) => Promise<ExpEvidence>;

// ── 压缩触发/驱动事件的**机械捕获**（并发安全）────────────────────────────────────
//
// pi 驱动以 `console.warn/info/error(JSON.stringify({ event, ... }))` 输出结构化日志——
// 压缩触发的机械证据即 `pi-driver.ts:596-601` 的 `context_emergency_compact`（回合内应急压缩）、
// `:543` 的 `context_compacted`（回合前压缩成功）、`:502/:513/:460` 的失败/降级变体；
// 另有 `:715` 的 `pi_driver_empty_reply`、`:627` 的 `pi_driver_model_error` 等病态/失败形状。
//
// 跑批并发 = 4，**不能**用全局 console 打补丁后按「此刻在跑哪个样本」归属（会串台）——
// 故用 `AsyncLocalStorage` 给每条日志打**样本归属**：只有落在某个样本 async 上下文里的日志
// 才被该样本收走；未命中样本上下文时原样转发（不改日志语义）。
// 补丁按**引用计数**装/卸：并发样本重叠时保持装载，全部结束后还原原 `console`。
const DRIVER_EVENT_NAMES: ReadonlySet<string> = new Set([
  'context_emergency_compact', 'context_compacted', 'context_compact_failed',
  'context_compact_no_cut', 'context_compact_degraded', 'context_compact_trimmed',
  'pi_driver_empty_reply', 'pi_driver_model_error', 'pi_driver_error',
  'pi_driver_failed_assistant', 'pi_driver_context_overflow_recovered', 'pi_driver_final_text_nudge',
]);

const driverEventStore = new AsyncLocalStorage<Array<Record<string, unknown>>>();

let consoleCaptureDepth = 0;
let savedConsole: { warn: typeof console.warn; info: typeof console.info; error: typeof console.error; log: typeof console.log } | undefined;

/** 装载 console 捕获（幂等、引用计数）；返回 restore，全部样本结束后还原原 console。 */
function installConsoleCapture(): () => void {
  if (consoleCaptureDepth === 0) {
    const saved = { warn: console.warn, info: console.info, error: console.error, log: console.log };
    savedConsole = saved;
    const wrap = (orig: (...args: unknown[]) => void) => (...args: unknown[]): void => {
      const store = driverEventStore.getStore();
      if (store !== undefined) {
        const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ').trim();
        if (text.startsWith('{')) {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (parsed !== null && typeof parsed === 'object' && typeof parsed['event'] === 'string' && DRIVER_EVENT_NAMES.has(parsed['event'])) {
              store.push(parsed);
            }
          } catch { /* 非 JSON 日志，忽略 */ }
        }
      }
      orig(...args);
    };
    console.warn = wrap(saved.warn.bind(console)) as typeof console.warn;
    console.info = wrap(saved.info.bind(console)) as typeof console.info;
    console.error = wrap(saved.error.bind(console)) as typeof console.error;
    // `context_compacted`（回合前压缩成功）走 console.log（pi-driver.ts:543）——必须一并捕获，
    // 否则「回合前压缩」这条机械证据会漏（`context_emergency_compact` 走 warn，:596）。
    console.log = wrap(saved.log.bind(console)) as typeof console.log;
  }
  consoleCaptureDepth += 1;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    consoleCaptureDepth -= 1;
    if (consoleCaptureDepth === 0 && savedConsole !== undefined) {
      console.warn = savedConsole.warn;
      console.info = savedConsole.info;
      console.error = savedConsole.error;
      console.log = savedConsole.log;
      savedConsole = undefined;
    }
  };
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

interface Sink {
  turn: number;
  calls: ToolCallRecord[];
  perTurnMainTools: string[][];
}

/** 记录包装器：透传不改语义，采 T2 工具调用 + 每回合 Main 工具面。 */
function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: Sink): TurnDriver {
  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput) {
      let seq = 0;
      if (agent === 'main') sink.perTurnMainTools[sink.turn - 1] = input.tools.map((t) => t.name);
      const wrappedInput: TurnDriverInput = {
        ...input,
        exec: async (tool, args, signal) => {
          seq += 1;
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          try {
            const result = await input.exec(tool, args, signal);
            sink.calls.push({ turn: sink.turn, agent, seq, tool, args: jsonSafe(args), result: jsonSafe(result), resultSummary: summarize(result), startedAt, elapsedMs: Date.now() - startedMs });
            return result;
          } catch (error) {
            sink.calls.push({ turn: sink.turn, agent, seq, tool, args: jsonSafe(args), isError: true, resultSummary: error instanceof Error ? error.message : String(error), startedAt, elapsedMs: Date.now() - startedMs });
            throw error;
          }
        },
      };
      return await inner.run(wrappedInput);
    },
    ...(inner.synthesizeAssistant ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
  return wrapped;
}

function summarize(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return text.length <= 500 ? text : `${text.slice(0, 500)}…`;
  } catch {
    return String(result);
  }
}

function usageOf(message: unknown): { input?: number; output?: number; cacheRead?: number; total?: number } | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const rec = usage as Record<string, unknown>;
  const pick = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const picked = { input: pick(rec['input']), output: pick(rec['output']), cacheRead: pick(rec['cacheRead']), total: pick(rec['totalTokens']) };
  return Object.values(picked).some((v) => v !== undefined) ? picked : undefined;
}

/**
 * 物化每样本独立配置副本：root 绝对 + store.dbPath 指入本样本。
 * Main 技能臂不写配置（固定目录是唯一机制；实验经装配参数 `mainSkillsDir` 指夹具目录）。
 */
function materializeConfig(configCopy: string, dbPath: string): void {
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const doc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(doc));
}

export interface ExpExecutorOptions {
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 额外进程环境（自测注入 LLM_API_KEY 占位；生产为空，走 .env）。 */
  env?: NodeJS.ProcessEnv;
}

/** 真实/假件执行器：一个（用例×trial）样本 → 完整实验证据。inline-only；per-样本独立目录。 */
export function createExpExecutor(options: ExpExecutorOptions = {}): ExpExecutor {
  // 缺省真实驱动必须显式带上压缩窗口（缺口 3 装配接线）：assembleSessionCore 只在**缺省驱动**分支
  // 施加 `...contextWindowFrom(input.env)`（ask-runtime.ts:406-408）；本执行器总是提供 createDrivers
  // （为记录工具调用），故由本执行器自己施加该接线，否则 LLM_CONTEXT_WINDOW 不生效（此前 #7 首跑
  // 即因此未触发压缩——驱动按 128k 缺省跑）。
  const baseDrivers = options.createDrivers ?? ((driverEnv: NodeJS.ProcessEnv) => ({
    mainDriver: createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv) }),
    workerDriver: createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv) }),
  }));
  return async (item, caseDef, workDir): Promise<ExpEvidence> => {
    const stateDir = path.join(workDir, 'state');
    const dbDir = path.join(workDir, 'db');
    const configDir = path.join(workDir, 'config');
    for (const dir of [stateDir, dbDir, configDir]) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.db');
    const configCopy = path.join(configDir, 'agent-config.yaml');
    materializeConfig(configCopy, dbPath);

    const config: AppConfig = loadConfig({ yamlPath: configCopy });
    const env = effectiveDeploymentEnv(config, { ...process.env, ...(options.env ?? {}), ...(caseDef.env ?? {}) });
    if ((env['LLM_API_KEY'] ?? '').trim() === '') {
      throw new Error('未检测到 LLM_API_KEY——真实模型探测需要密钥只在 .env（不落地、不落跟踪文件）。');
    }
    const profileIds = Object.keys(config.contextProfiles);
    if (profileIds.length !== 1) throw new Error(`需要单一 contextProfile（当前 ${profileIds.length} 个）`);
    const profile = config.contextProfiles[profileIds[0]!]!;
    if (!profile.gateway) throw new Error('profile 缺少 gateway——执行层挂载声明缺失');
    const principalId = Object.entries(config.principals).find(([, p]) => p.enabled)?.[0];
    if (principalId === undefined) throw new Error('配置里没有 enabled principal（fail-closed）');
    const sessionId = item.sessionId;
    const scope: TaskScope = { principalId, sessionId };

    // catalog 臂常驻提示字节（装配期事实；目录来自装配参数，缺省 = 生产固定目录；none 臂 = 0）。
    const delivery = await loadMainSkillDelivery(caseDef.mainSkillsDir ?? defaultMainSkillsDir());
    const skillBlockBytes = delivery.catalogBytes;

    const sink: Sink = { turn: 0, calls: [], perTurnMainTools: [] };
    const registry = createSqliteTaskRegistry(dbPath);
    const policy = createResourcePolicy();
    const seedTaskNos: { waiting?: number; foreign?: number } = {};
    try {
      const face = await resolveExecutionFace({
        profile,
        env,
        stateDir,
        emptyOperationsMessage: '执行层没有声明任何只读 operation——实验拒绝以空允许集合运行',
        ...(options.createExecutionFace === undefined ? {} : { createExecutionFace: options.createExecutionFace }),
      });
      const base = await baseDrivers(env);
      const drivers = {
        mainDriver: recordingDriver(base.mainDriver, 'main', sink),
        workerDriver: recordingDriver(base.workerDriver, 'worker', sink),
      };
      // 缺口 1 四工具同源门控 taskRunner：async 天然有；sync 由用例 withTaskRunner 直接注入。
      let runner: TaskRunner | undefined;
      if (caseDef.taskDispatch === 'async' || caseDef.withTaskRunner === true) {
        runner = (await createBackgroundDispatch({
          env,
          profile,
          stateDir,
          registry,
          policy,
          emptyOperationsMessage: '执行层没有声明任何只读 operation——实验拒绝以空允许集合运行',
          face,
          workerDriver: drivers.workerDriver,
        })).runner;
      }

      const assembled = await assembleSessionCore({
        env,
        profile,
        principalId,
        sessionId,
        dbPath,
        stateDir,
        setAuditPath: true,
        assertIsolation: () => {
          const isolation = assessEvalIsolation({ env, platformRoot: profile.root, gateway: profile.gateway });
          assertEvalIsolation(isolation, `bizbatch2 ${item.id}`);
        },
        emptyOperationsMessage: '执行层没有声明任何只读 operation——实验拒绝以空允许集合运行',
        taskRegistry: registry,
        policy,
        createDrivers: () => ({ mainDriver: drivers.mainDriver, workerDriver: drivers.workerDriver }),
        createExecutionFace: async () => face,
        ...(runner === undefined ? {} : { taskRunner: runner }),
        ...(caseDef.taskDispatch === undefined ? {} : { taskDispatch: caseDef.taskDispatch }),
        ...(caseDef.mainSkillsDir === undefined ? {} : { mainSkillsDir: caseDef.mainSkillsDir }),
      });

      // 确定性预置任务（越权/挂起探针）——在会话首回合前写入本会话底账。
      if (caseDef.seed?.foreign !== undefined) {
        const rec = registry.begin({
          taskId: `seed_foreign_${randomUUID()}`,
          principalId: caseDef.seed.foreign.principalId,
          sessionId: caseDef.seed.foreign.sessionId,
          request: caseDef.seed.foreign.request,
        });
        if (rec.taskNo !== undefined) seedTaskNos.foreign = rec.taskNo;
      }
      if (caseDef.seed?.waitingQuestion !== undefined) {
        const taskId = `seed_waiting_${randomUUID()}`;
        const rec = registry.begin({ taskId, principalId, sessionId, request: caseDef.seed.waitingQuestion.request });
        registry.waitForUser(taskId, { missing: [...caseDef.seed.waitingQuestion.missing] });
        const after = registry.get(taskId, scope);
        if (after.taskNo !== undefined) seedTaskNos.waiting = after.taskNo;
      }

      const turns = effectiveTurns(caseDef);
      const replies: ReplyLine[] = [];
      const metaTurns: MetaTurn[] = [];
      const compactions: Array<{ turn: number; compacted: boolean; before: number; after: number }> = [];
      const driverEvents: Array<Record<string, unknown>> = [];
      let previousTranscriptLength = 0;
      let prevHasSummaryMarker = false;
      const wallStart = Date.now();
      const session = assembled.session;
      const restoreCapture = installConsoleCapture();
      try {
        for (let index = 0; index < turns.length; index += 1) {
          const turn = index + 1;
          sink.turn = turn;
          const startedMs = Date.now();
          const remainingWall = EXP_HARD_LIMITS.maxWallMsPerSession - (Date.now() - wallStart);
          // 本回合的驱动事件缓冲（ALS 归属本样本本回合；并发下不串台）。
          const turnEvents: Array<Record<string, unknown>> = [];
          const result = await withTimeout(
            driverEventStore.run(turnEvents, () => session.send(turns[index]!)),
            remainingWall,
            '会话墙钟上限（maxWallMsPerSession）',
          );
          if (runner !== undefined) await runner.whenIdle();
          driverEvents.push(...turnEvents.map((event) => ({ turn, ...event })));
          const durationMs = Date.now() - startedMs;
          const transcript = [...session.transcript()];
          const delta = transcript.slice(previousTranscriptLength);
          // 压缩触发点（转录侧标记，与驱动事件互为独立证据）：转录里出现压缩摘要标记
          // （pi-driver.ts:526 `【此前会话摘要】`）即为压缩发生过；标记一旦出现常驻，故只记首次出现的轮。
          const hasSummaryMarker = JSON.stringify(transcript).includes('此前会话摘要');
          compactions.push({ turn, compacted: hasSummaryMarker && !prevHasSummaryMarker, before: previousTranscriptLength, after: transcript.length });
          prevHasSummaryMarker = hasSummaryMarker;
          previousTranscriptLength = transcript.length;
          const assistantMessages = delta.filter((m) => (m as { role?: unknown }).role === 'assistant');
          const usages = assistantMessages.map((m) => usageOf(m)).filter((u): u is NonNullable<typeof u> => u !== undefined);
          const tokens = usages.length > 0
            ? { available: true, input: usages.reduce((s, u) => s + (u.input ?? 0), 0), output: usages.reduce((s, u) => s + (u.output ?? 0), 0), cacheRead: usages.reduce((s, u) => s + (u.cacheRead ?? 0), 0), total: usages.reduce((s, u) => s + (u.total ?? 0), 0), source: 'assistant.usage' }
            : { available: false, source: 'assistant.usage 缺失（本轮未采集到 usage 数值）' };
          metaTurns.push({ index: turn, durationMs, modelCalls: assistantMessages.length, taskIds: [...(result?.taskIds ?? [])], tokens, retries: 0, notes: [] });
          replies.push({ turn, text: result?.reply ?? '', sha256: '' });
        }
      } finally {
        restoreCapture();
      }
      const tasks = jsonSafe(session.tasks()) as TaskRecordJson[];
      assembled.close();

      const toolCalls = sink.calls;
      const executions = executionFactsFromToolCalls(toolCalls);
      const sample: SampleRecord = {
        id: caseDef.id,
        granted: caseDef.granted,
        executions,
        reply: { claimsCompletion: claimsCompletionHeuristic(replies) },
      };
      const inputs: InputsFile = {
        caseId: caseDef.id,
        trial: item.trial,
        principalId,
        sessionId,
        turns: turns.map((text, i) => ({ index: i + 1, text, sha256: '' })),
        configPath: configCopy,
        profileRoot: profile.root,
        gateway: profile.gateway,
        dbPath,
      };
      const meta: MetaFile = { turns: metaTurns, driverEvents, notes: [] };
      return { caseDef, inputs, toolCalls, tasks, replies, meta, perTurnMainTools: sink.perTurnMainTools, skillBlockBytes, seedTaskNos, compaction: compactions, sample };
    } finally {
      registry.close();
    }
  };
}
