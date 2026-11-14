/**
 * bizbatch2 三实验执行器（装配与证据采集）——真实模型驱动器；本文件在装配自检阶段**不调真实模型**
 * （selftest 注入确定性假 driver / 假执行面）。
 *
 * 与探测基线驱动器（`../model-executor`）的差异（本实验面专属）：
 *   · 每用例可选 **inline + 直接注入 TaskRunner**（缺口 1 四工具同源门控；缺口 1 设计 §3.3 的合法装配）
 *     或 background 派发（本批不用）；
 *   · 每用例可选 **Main 技能臂**（缺口 2）：把 mainSkillRoots/mainSkillMode 写进物化配置副本；
 *   · 每用例可选 **小 LLM_CONTEXT_WINDOW**（缺口 3）：经 env 走 `effectiveDeploymentEnv` → 装配层
 *     `contextWindowFrom` → 驱动 contextWindow；
 *   · 逐回合记录 Main 工具面、逐回合模型调用数（压缩触发点）、read_skill 命中、预置任务编号；
 *   · 多轮会话：存在 runner 时每回合后 `whenIdle()`（等待后台/接续回合落定）。
 *
 * 纪律：源码/装配路径与生产同源（复用 `assembleSessionCore` / `resolveExecutionFace` /
 * `createBackgroundDispatch`），不建影子运行时；证据只读事实，不判（判归 `../judge`）。
 */
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
import { loadMainSkillDelivery } from '../../../../packages/agent/src/worker-skills';
import { materializeEvalConfig } from '../../../resolve-config-path';
import { assembleSessionCore, createBackgroundDispatch, resolveExecutionFace } from '../../../ask-runtime';
import type { DriverFactory, ExecutionFaceFactory } from '../../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../../safety-gate';
import { claimsCompletionHeuristic, executionFactsFromToolCalls } from '../sample-from-run';
import type { SampleRecord } from '../judge';
import type { ExpCase, ExpItem } from './model';
import { effectiveTurns } from './model';
import type { ExpEvidence } from './judge';
import type { InputsFile, MetaFile, MetaTurn, ReplyLine, TaskRecordJson, ToolCallRecord } from '../../convergence-r1/evidence';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

/** 执行一个（用例×trial）样本，产出实验证据。真实/假件同签名。 */
export type ExpExecutor = (item: ExpItem, caseDef: ExpCase, workDir: string) => Promise<ExpEvidence>;

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
    ...(inner.compact ? { compact: inner.compact.bind(inner) } : {}),
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

/** 物化每样本独立配置副本：root 绝对 + store.dbPath 指入本样本 + Main 技能臂（缺口 2）。 */
function materializeConfig(caseDef: ExpCase, configCopy: string, dbPath: string): void {
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const doc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  if (caseDef.mainSkillRoots !== undefined || caseDef.mainSkillMode !== undefined) {
    const profiles = doc['contextProfiles'] as Record<string, Record<string, unknown>> | undefined;
    const key = profiles === undefined ? undefined : Object.keys(profiles)[0];
    if (profiles !== undefined && key !== undefined) {
      const profile = profiles[key]!;
      if (caseDef.mainSkillRoots !== undefined) profile['mainSkillRoots'] = [...caseDef.mainSkillRoots];
      if (caseDef.mainSkillMode !== undefined) profile['mainSkillMode'] = caseDef.mainSkillMode;
    }
  }
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
  const baseDrivers = options.createDrivers ?? ((driverEnv: NodeJS.ProcessEnv) => ({
    mainDriver: createPiTurnDriver({ env: driverEnv }),
    workerDriver: createPiTurnDriver({ env: driverEnv }),
  }));
  return async (item, caseDef, workDir): Promise<ExpEvidence> => {
    const stateDir = path.join(workDir, 'state');
    const dbDir = path.join(workDir, 'db');
    const configDir = path.join(workDir, 'config');
    for (const dir of [stateDir, dbDir, configDir]) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.db');
    const configCopy = path.join(configDir, 'agent-config.yaml');
    materializeConfig(caseDef, configCopy, dbPath);

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

    // 臂 A 常驻技能块字节（装配期事实；缺省臂 = 0）。
    const delivery = await loadMainSkillDelivery(profile.root, profile.mainSkillRoots ?? [], profile.mainSkillMode ?? 'inline');
    const skillBlockBytes = Buffer.byteLength(delivery.promptBlock, 'utf8');

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
      const base = baseDrivers(env);
      const drivers = {
        mainDriver: recordingDriver(base.mainDriver, 'main', sink),
        workerDriver: recordingDriver(base.workerDriver, 'worker', sink),
      };
      // 缺口 1 四工具同源门控 taskRunner：background 天然有；inline 由用例 withTaskRunner 直接注入。
      let runner: TaskRunner | undefined;
      if (caseDef.dispatchMode === 'background' || caseDef.withTaskRunner === true) {
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
        ...(caseDef.dispatchMode === undefined ? {} : { dispatchMode: caseDef.dispatchMode }),
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
        const rec = registry.begin({ taskId, principalId, sessionId, request: caseDef.seed.waitingQuestion.request, status: 'running' });
        registry.waitForUser(taskId, { missing: [...caseDef.seed.waitingQuestion.missing] });
        const after = registry.get(taskId, scope);
        if (after.taskNo !== undefined) seedTaskNos.waiting = after.taskNo;
      }

      const turns = effectiveTurns(caseDef);
      const replies: ReplyLine[] = [];
      const metaTurns: MetaTurn[] = [];
      const compactions: Array<{ turn: number; compacted: boolean; before: number; after: number }> = [];
      let previousTranscriptLength = 0;
      let prevHasSummaryMarker = false;
      const session = assembled.session;
      for (let index = 0; index < turns.length; index += 1) {
        const turn = index + 1;
        sink.turn = turn;
        const startedMs = Date.now();
        const result = await session.send(turns[index]!);
        if (runner !== undefined) await runner.whenIdle();
        const durationMs = Date.now() - startedMs;
        const transcript = [...session.transcript()];
        const delta = transcript.slice(previousTranscriptLength);
        // 压缩触发点（并发安全，不用全局 console）：转录里出现压缩摘要标记
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
      const meta: MetaFile = { turns: metaTurns, driverEvents: [], notes: [] };
      return { caseDef, inputs, toolCalls, tasks, replies, meta, perTurnMainTools: sink.perTurnMainTools, skillBlockBytes, seedTaskNos, compaction: compactions, sample };
    } finally {
      registry.close();
    }
  };
}
