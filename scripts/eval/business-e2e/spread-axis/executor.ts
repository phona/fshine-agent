/**
 * D 轴执行器（真实模型驱动器；装配自检可注入确定性假件，不调真实模型）。
 *
 * 与既有两个执行器的差异（本实验面专属；产品代码零改动）：
 *   · 复用与 `npm run ask` / server 同源的装配核心（`assembleSessionCore` 等），按用例选择
 *     inline（可注入 TaskRunner 拿四工具）或 background 派发；
 *   · **同时采集**任务事实流（onTaskFact → task-facts.jsonl/notifications.jsonl）与工具调用
 *     （recording driver）——D6（d6-metrics）与 D3/D4（重试/任务数）需要这两面；
 *   · 退出不判（判归 `./grade` 的轨2 分级判官 + 冻结 judgeMechanical）。
 *
 * 诚实纪律：token/调用数驱动面不可得即如实标注；不编造。种子任务不设（D 轴不要求；
 * 跨 principal 由 D7 轨2 夹具覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig, RuntimeConfig } from '@fshine/contracts';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput } from '../../../../packages/agent/src/driver-contract';
import { createResourcePolicy } from '../../../../packages/agent/src/resource-policy';
import { createSqliteTaskRegistry } from '../../../../packages/agent/src/task-registry-sqlite';
import { defaultMainSkillsDir, loadMainSkillDelivery } from '../../../../packages/agent/src/worker-skills';
import { notificationKindForTransition } from '../../../../packages/agent/src/notifications';
import type { NotificationReason } from '../../../../packages/agent/src/notifications';
import { materializeEvalConfig } from '../../../resolve-config-path';
import {
  assembleSessionCore,
  contextWindowFrom,
  createBackgroundDispatch,
  resolveExecutionFace,
} from '../../../ask-runtime';
import type { DriverFactory, ExecutionFaceFactory } from '../../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../../safety-gate';
import type { SampleRecord } from '../judge';
import type { NotificationLine, TaskFactLine } from '../collect';
import type { InputsFile, MetaFile, MetaTurn, ReplyLine, TaskRecordJson, ToolCallRecord } from '../../convergence-r1/evidence';
import { buildDsSample } from './grade';
import { runtimeOverlayOf, type DsCase, type DsItem } from './cases';

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

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function summarize(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return text.length <= 500 ? text : `${text.slice(0, 500)}…`;
  } catch {
    return String(result);
  }
}

interface Sink {
  turn: number;
  calls: ToolCallRecord[];
}

/** 记录包装器：透传不改语义，采 T2 工具调用（main + worker 两面）。 */
function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: Sink): TurnDriver {
  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput) {
      let seq = 0;
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

function usageOf(message: unknown): { input?: number; output?: number; cacheRead?: number; total?: number } | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const rec = usage as Record<string, unknown>;
  const pick = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const picked = { input: pick(rec['input']), output: pick(rec['output']), cacheRead: pick(rec['cacheRead']), total: pick(rec['totalTokens']) };
  return Object.values(picked).some((v) => v !== undefined) ? picked : undefined;
}

/** 物化每样本独立配置副本：root 绝对 + store.dbPath 指入本样本 + 用例 runtime 覆盖。 */
function materializeConfig(configCopy: string, dbPath: string, runtime: object | undefined): void {
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const doc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  if (runtime !== undefined) doc['runtime'] = { ...runtime };
  writeFileSync(configCopy, stringifyYaml(doc));
}

function buildSample(
  caseDef: DsCase,
  id: string,
  toolCalls: readonly ToolCallRecord[],
  replies: readonly ReplyLine[],
  notifications: readonly NotificationLine[],
  taskFacts: readonly TaskFactLine[],
): SampleRecord {
  return buildDsSample({ caseDef, id, toolCalls, replies, notifications, taskFacts });
}

/** 一次 D 轴样本执行的完整证据（collect + 判定器样本记录）。 */
export interface DsEvidence {
  caseDef: DsCase;
  inputs: InputsFile;
  toolCalls: readonly ToolCallRecord[];
  tasks: readonly TaskRecordJson[];
  replies: readonly ReplyLine[];
  meta: MetaFile;
  taskFacts: readonly TaskFactLine[];
  notifications: readonly NotificationLine[];
  auditLines: readonly string[];
  sample: SampleRecord;
  /** 装配期事实：Main 提示里的技能块字节数（D 轴无技能臂，通常 0）。 */
  skillBlockBytes: number;
}

export type DsExecutor = (item: DsItem, caseDef: DsCase, workDir: string) => Promise<DsEvidence>;

export interface DsExecutorOptions {
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 额外进程环境（自测注入 LLM_API_KEY 占位；真实运行走 .env + 显式 LLM_MODEL）。 */
  env?: NodeJS.ProcessEnv;
  /** 单回合墙钟（毫秒；缺省 600000，与 experiments 批次一致）。 */
  maxWallMsPerSession?: number;
}

/** 真实/假件执行器：一个（用例×trial）样本 → 完整证据。 */
export function createDsExecutor(options: DsExecutorOptions = {}): DsExecutor {
  const baseDrivers = options.createDrivers ?? ((driverEnv: NodeJS.ProcessEnv) => ({
    mainDriver: createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv) }),
    workerDriver: createPiTurnDriver({ env: driverEnv, ...contextWindowFrom(driverEnv) }),
  }));
  const maxWallMsPerSession = options.maxWallMsPerSession ?? 600_000;
  return async (item, caseDef, workDir): Promise<DsEvidence> => {
    const stateDir = path.join(workDir, 'state');
    const dbDir = path.join(workDir, 'db');
    const configDir = path.join(workDir, 'config');
    for (const dir of [stateDir, dbDir, configDir]) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.db');
    const configCopy = path.join(configDir, 'agent-config.yaml');
    const runtime = runtimeOverlayOf(caseDef) as RuntimeConfig | undefined;
    materializeConfig(configCopy, dbPath, runtime);

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

    // Main 技能面唯一机制：固定 `<repo>/.agents/skills` → catalog；本实验无技能臂，字节 = 0
    // （目录为空）或生产目录的 catalog 字节（进证据）。
    const delivery = await loadMainSkillDelivery(defaultMainSkillsDir());
    const skillBlockBytes = delivery.catalogBytes;

    const sink: Sink = { turn: 0, calls: [] };
    const registry = createSqliteTaskRegistry(dbPath);
    // runtime 覆盖（用例预注册 JSON 数据；缺省 = 产品现行为）：资源策略与装配核心用同一份。
    const policy = createResourcePolicy(runtime);
    const taskFacts: TaskFactLine[] = [];
    const notifications: NotificationLine[] = [];
    registry.onTaskFact((fact) => {
      taskFacts.push({ ts: fact.at, taskId: fact.taskId, from: fact.from ?? '', to: fact.to, ...(fact.reason === undefined ? {} : { reason: fact.reason }) });
      const kind = notificationKindForTransition(fact.from, fact.to, fact.reason as NotificationReason | undefined);
      if (kind !== undefined) notifications.push({ ts: fact.at, taskId: fact.taskId, kind });
    });
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
      const useRunner = caseDef.taskDispatch === 'async' || caseDef.withTaskRunner === true;
      const runner = useRunner
        ? (await createBackgroundDispatch({
          env,
          profile,
          stateDir,
          registry,
          policy,
          ...(runtime === undefined ? {} : { runtime }),
          emptyOperationsMessage: '执行层没有声明任何只读 operation——实验拒绝以空允许集合运行',
          face,
          workerDriver: drivers.workerDriver,
        })).runner
        : undefined;

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
          assertEvalIsolation(isolation, `r5-d-axis ${item.id}`);
        },
        emptyOperationsMessage: '执行层没有声明任何只读 operation——实验拒绝以空允许集合运行',
        taskRegistry: registry,
        policy,
        ...(runtime === undefined ? {} : { runtime }),
        createDrivers: () => ({ mainDriver: drivers.mainDriver, workerDriver: drivers.workerDriver }),
        createExecutionFace: async () => face,
        ...(runner === undefined ? {} : { taskRunner: runner }),
        ...(caseDef.taskDispatch === undefined ? {} : { taskDispatch: caseDef.taskDispatch }),
      });

      const replies: ReplyLine[] = [];
      const metaTurns: MetaTurn[] = [];
      const wallStart = Date.now();
      let previousTranscriptLength = 0;
      const session = assembled.session;
      for (let index = 0; index < caseDef.turns.length; index += 1) {
        const turn = index + 1;
        sink.turn = turn;
        const startedMs = Date.now();
        const remainingWall = maxWallMsPerSession - (Date.now() - wallStart);
        const result = await withTimeout(session.send(caseDef.turns[index]!), remainingWall, '会话墙钟上限（maxWallMsPerSession）');
        if (runner !== undefined) await runner.whenIdle();
        const durationMs = Date.now() - startedMs;
        const transcript = [...session.transcript()];
        const delta = transcript.slice(previousTranscriptLength);
        previousTranscriptLength = transcript.length;
        // 逐轮 usage：本回合新增的 assistant 消息（驱动面 usage；不可得如实标 false）。
        const assistantMessages = delta.filter((m) => (m as { role?: unknown }).role === 'assistant');
        const usages = assistantMessages.map((m) => usageOf(m)).filter((u): u is NonNullable<typeof u> => u !== undefined);
        const tokens = usages.length > 0
          ? { available: true, input: usages.reduce((s, u) => s + (u.input ?? 0), 0), output: usages.reduce((s, u) => s + (u.output ?? 0), 0), cacheRead: usages.reduce((s, u) => s + (u.cacheRead ?? 0), 0), total: usages.reduce((s, u) => s + (u.total ?? 0), 0), source: 'assistant.usage' }
          : { available: false, source: 'assistant.usage 缺失（本轮未采集到 usage 数值）' };
        metaTurns.push({ index: turn, durationMs, modelCalls: assistantMessages.length, taskIds: [...(result?.taskIds ?? [])], tokens, retries: 0, notes: [] });
        replies.push({ turn, text: result?.reply ?? '', sha256: '' });
      }
      const tasks = jsonSafe(session.tasks()) as TaskRecordJson[];
      const auditLines = existsSync(assembled.auditPath)
        ? readFileSync(assembled.auditPath, 'utf8').trimEnd().split('\n').filter((l) => l !== '')
        : [];
      assembled.close();

      const sample = buildSample(caseDef, item.id, sink.calls, replies, notifications, taskFacts);
      const inputs: InputsFile = {
        caseId: caseDef.id,
        trial: item.trial,
        principalId,
        sessionId,
        turns: caseDef.turns.map((text, i) => ({ index: i + 1, text, sha256: '' })),
        configPath: configCopy,
        profileRoot: profile.root,
        gateway: profile.gateway,
        dbPath,
      };
      const meta: MetaFile = { turns: metaTurns, driverEvents: [], notes: [] };
      return { caseDef, inputs, toolCalls: sink.calls, tasks, replies, meta, taskFacts, notifications, auditLines, sample, skillBlockBytes };
    } finally {
      registry.close();
    }
  };
}
