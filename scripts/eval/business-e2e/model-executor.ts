/**
 * 业务 E2E 探测基线（阶段 2）真实模型驱动器——消费 `runner` 的装配接缝，**不改冻结面**。
 *
 * 复用与 convergence-r1 runner 同源的共享装配核心（`scripts/ask-runtime.ts` 的
 * `assembleSessionCore`）：per-样本独立 config/db/state/session、隔离门、审计路径、
 * 真实 Pi 驱动（`.env` 经调用方注入，绝不入证据/不提交）。
 *
 * 与 runner 的差异（本驱动器专属）：记录包装器只采业务 E2E 需要的面（T2 工具调用、
 * 逐轮 meta）；判定走 `./judge`（机械/行为/UX 三类分离），证据落 `./collect`。
 * inline only：不设 background（装配核心缺省 inline）；后台模式在本轮预算接通前禁用。
 *
 * ⚠️ 本文件在「装配与自检」阶段**未对真实模型运行**（预注册纪律：不烧样本）；其正确性
 * 由 `./bizprobe.test.ts` 的确定性假件覆盖机械投影与装配，真实模型读数待 run 阶段实测。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import { materializeEvalConfig } from '../../resolve-config-path';
import { assembleSessionCore } from '../../ask-runtime';
import type { DriverFactory, ExecutionFaceFactory } from '../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../safety-gate';
import type { CaseContext } from './batch';
import type { BizCase, BizItem } from './scenarios';
import type { BizExecutor, BizSampleEvidence } from './assembly';
import { buildSampleRecord } from './sample-from-run';
import type { MetaFile, MetaTurn, ReplyLine, TaskRecordJson, ToolCallRecord } from '../convergence-r1/evidence';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

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
}

/** 记录包装器：透传不改语义，只采 T2 工具调用（与 convergence-r1 runner 同形）。 */
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

/** 逐轮 assistant.usage 汇总（token 不可得时 available=false，不编造）。 */
function usageOf(message: unknown): { input?: number; output?: number; cacheRead?: number; total?: number } | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const rec = usage as Record<string, unknown>;
  const pick = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const picked = { input: pick(rec['input']), output: pick(rec['output']), cacheRead: pick(rec['cacheRead']), total: pick(rec['totalTokens']) };
  return Object.values(picked).some((v) => v !== undefined) ? picked : undefined;
}

/** 物化每样本独立配置副本：root 绝对 + store.dbPath 指入本样本 + 可选追加 principal。 */
function materializeConfig(item: BizItem, caseDef: BizCase, configCopy: string, dbPath: string): void {
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const doc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  doc['store'] = { dbPath };
  if (caseDef.biz.extraPrincipals !== undefined) {
    const principals = { ...(doc['principals'] as Record<string, unknown> ?? {}) };
    const template = Object.values(principals)[0] as Record<string, unknown> | undefined;
    for (const id of caseDef.biz.extraPrincipals) {
      principals[id] = { ...(template ?? { accountSetScope: 'all' }), enabled: true };
    }
    doc['principals'] = principals;
  }
  writeFileSync(configCopy, stringifyYaml(doc));
}

/**
 * 驱动器注入覆盖（自测用确定性假 driver/假执行面，零模型；生产不传 = 真实 Pi + 仓内 dummy）。
 * 注入只替换「驱动/执行面」两处接线，装配/证据/判定代码路径逐字不变。
 */
export interface ModelExecutorOptions {
  createDrivers?: DriverFactory;
  createExecutionFace?: ExecutionFaceFactory;
  /** 额外进程环境（自测注入 LLM_API_KEY 占位；生产为空，走 .env）。 */
  env?: NodeJS.ProcessEnv;
}

/** 真实模型驱动器：一个（用例×trial）样本 → 完整证据。inline only；per-样本独立目录。 */
export function createModelExecutor(options: ModelExecutorOptions = {}): BizExecutor {
  const drivers = options.createDrivers ?? ((driverEnv: NodeJS.ProcessEnv) => ({
    mainDriver: createPiTurnDriver({ env: driverEnv }),
    workerDriver: createPiTurnDriver({ env: driverEnv }),
  }));
  return async (item: BizItem, caseDef: BizCase, ctx: CaseContext): Promise<BizSampleEvidence> => {
    if (ctx.workDir === undefined) throw new Error('业务 E2E 需要每样本工作目录（batch 的 workRoot）');
    const stateDir = path.join(ctx.workDir, 'state');
    const dbDir = path.join(ctx.workDir, 'db');
    const configDir = path.join(ctx.workDir, 'config');
    for (const dir of [stateDir, dbDir, configDir]) mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dbDir, 'state.db');
    const configCopy = path.join(configDir, 'agent-config.yaml');
    materializeConfig(item, caseDef, configCopy, dbPath);

    const config: AppConfig = loadConfig({ yamlPath: configCopy });
    const env = effectiveDeploymentEnv(config, { ...process.env, ...(options.env ?? {}), ...(caseDef.biz.env ?? {}) });
    if ((env['LLM_API_KEY'] ?? '').trim() === '') {
      throw new Error('未检测到 LLM_API_KEY——真实模型探测需要密钥只在 .env（不落地、不落跟踪文件）。');
    }
    const profileIds = Object.keys(config.contextProfiles);
    if (profileIds.length !== 1) throw new Error(`需要单一 contextProfile（当前 ${profileIds.length} 个）`);
    const profile = config.contextProfiles[profileIds[0]!]!;
    if (!profile.gateway) throw new Error('profile 缺少 gateway——执行层挂载声明缺失');
    const principalId = caseDef.biz.principalId
      ?? Object.entries(config.principals).find(([, p]) => p.enabled)?.[0];
    if (principalId === undefined) throw new Error('配置里没有 enabled principal（fail-closed）');
    const sessionId = item.sessionId;
    const sink: Sink = { turn: 0, calls: [] };
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
        assertEvalIsolation(isolation, `bizprobe ${item.id}`);
      },
      emptyOperationsMessage: '执行层没有声明任何只读 operation——拒绝以空允许集合运行',
      createDrivers: (driverEnv) => {
        const base = drivers(driverEnv);
        return {
          mainDriver: recordingDriver(base.mainDriver, 'main', sink),
          workerDriver: recordingDriver(base.workerDriver, 'worker', sink),
        };
      },
      ...(options.createExecutionFace === undefined ? {} : { createExecutionFace: options.createExecutionFace }),
    });

    const replies: ReplyLine[] = [];
    const metaTurns: MetaTurn[] = [];
    let previousTranscriptLength = 0;
    let tasksSnapshot: TaskRecordJson[] = [];
    const auditPath = assembled.auditPath;
    try {
      const session = assembled.session;
      for (let index = 0; index < caseDef.turns.length; index += 1) {
        const turn = index + 1;
        sink.turn = turn;
        const startedMs = Date.now();
        const result = await session.send(caseDef.turns[index]!);
        const durationMs = Date.now() - startedMs;
        const transcript = [...session.transcript()];
        const delta = transcript.slice(previousTranscriptLength);
        previousTranscriptLength = transcript.length;
        const assistantMessages = delta.filter((m) => (m as { role?: unknown }).role === 'assistant');
        const usages = assistantMessages.map((m) => usageOf(m)).filter((u): u is NonNullable<typeof u> => u !== undefined);
        const tokens = usages.length > 0
          ? { available: true, input: usages.reduce((s, u) => s + (u.input ?? 0), 0), output: usages.reduce((s, u) => s + (u.output ?? 0), 0), cacheRead: usages.reduce((s, u) => s + (u.cacheRead ?? 0), 0), total: usages.reduce((s, u) => s + (u.total ?? 0), 0), source: 'assistant.usage' }
          : { available: false, source: 'assistant.usage 缺失（本轮未采集到 usage 数值）' };
        metaTurns.push({ index: turn, durationMs, modelCalls: assistantMessages.length, taskIds: [...(result?.taskIds ?? [])], tokens, retries: 0, notes: [] });
        replies.push({ turn, text: result?.reply ?? '', sha256: '' });
      }
      tasksSnapshot = jsonSafe(assembled.taskRegistry.list()) as TaskRecordJson[];
      // #8 会话隔离断言：底账任务必须全归本样本 principal（不串台）。
      const foreign = tasksSnapshot.filter((t) => t.principalId !== principalId);
      if (foreign.length > 0) throw new Error(`会话隔离违反：底账出现非本样本 principal 的任务 ${foreign.map((t) => t.taskId).join(',')}`);
    } finally {
      assembled.close();
    }

    const auditLines = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trimEnd().split('\n').filter((l) => l !== '') : [];
    const meta: MetaFile = { turns: metaTurns, driverEvents: [], notes: [] };
    const sample = buildSampleRecord({ caseDef, toolCalls: sink.calls, replies, taskCount: tasksSnapshot.length });
    return {
      inputs: {
        caseId: caseDef.id,
        trial: item.trial,
        principalId,
        sessionId,
        turns: caseDef.turns.map((text, i) => ({ index: i + 1, text, sha256: '' })),
        configPath: configCopy,
        profileRoot: profile.root,
        gateway: profile.gateway,
        dbPath,
      },
      toolCalls: sink.calls,
      tasks: tasksSnapshot,
      replies,
      meta,
      auditLines,
      sample,
    };
  };
}
