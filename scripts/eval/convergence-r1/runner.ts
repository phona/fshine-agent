/**
 * convergence-r1 用户级黑盒评测入口（真实模型走 .env；执行层一律仓内 dummy 夹具）。
 *
 * 与 scripts/ask.ts 同源装配（P0 单一装配点）：本文件保留评测入口的门与差异注入
 *   （materializeEvalConfig → loadConfig → effectiveDeploymentEnv → key/profile/gateway/principal
 *   门 → safety-gate），门之后走 scripts/ask-runtime.ts 的共享装配核心
 *   （执行面/底账/技能角色/驱动全部经 assembleSessionCore 构造；per-case 库与记录驱动按输入注入）。
 * 唯一允许插桩 = TurnDriver 记录包装器（透传不改语义，采 T2 工具调用 / Worker 转录 / 驱动日志）；
 * 禁止测试专用分支绕开模型或 Execution Contract。
 *
 * CLI（逐字契约，README 同文）：
 *   npm run eval:user -- [--case C01] [--trial 1] [--trials 1] [--out-dir <dir>] [--judge-existing <run-dir>]
 * 兼容别名：--cases（同 --case）、--out（同 --out-dir）、--judge-selftest、--with-llm-judge。
 * 外部套件（探索集）：--suite <dir>——加载 scripts/eval/exploration/<suite>/suite.ts 的用例与
 * 自己的 criteria.lock；不传时一切走 R1 缺省（用例/判据/锁/输出与既有行为逐字一致）。
 *
 * 退出码：0=全部 trial 判定完成且无 FAIL；1=存在 FAIL；2=infra/INCONCLUSIVE（证据缺失、哈希不符、隔离违反）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { AppConfig } from '@fshine/contracts';
import { createPiTurnDriver } from '../../../packages/agent/src/pi-driver';
import type { TurnDriver, TurnDriverInput } from '../../../packages/agent/src/driver-contract';
import { materializeEvalConfig } from '../../resolve-config-path';
import { assembleSessionCore } from '../../ask-runtime';
import { assessEvalIsolation, assertEvalIsolation } from '../safety-gate';
import { ALL_CASES, normalizeCaseId, type UserCase } from './cases';
import { buildCriteriaDocument, CRITERIA_VERSION, JUDGE_VERSION, RUNNER_VERSION } from './criteria';
import { judgeTrial, judgmentBodyHash, type Judgment } from './judge';
import type { AuditIndexTurn, MetaTurn, ToolCallRecord } from './evidence';
import { sha256Hex, stableStringify } from './hash';
import { runJudgeSelftest } from './selftest';
import { genericResolveCaseIds, loadSuite, type EvalSuite } from '../exploration/suite-contract';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.runtime', 'eval-r1');
const CRITERIA_LOCK = path.join(REPO_ROOT, 'scripts', 'eval', 'convergence-r1', 'criteria.lock');

const USAGE = [
  '用法：npm run eval:user -- [--case C01] [--trial 1] [--trials 1] [--out-dir <dir>] [--judge-existing <run-dir>] [--suite <dir>]',
  '  --case <id|all>        选择用例（缺省 R1 为 E01–E12；套件为其自身 id 集；逗号分隔；C01 形态同义；缺省 all）',
  '  --trial <n>            只跑第 n 次（1 起）',
  '  --trials <n>           每个用例的轮数（缺省 1）',
  '  --out-dir <dir>        输出根目录（缺省 .runtime/eval-r1；套件用自己的缺省）',
  '  --suite <dir>          外部用例集（scripts/eval/exploration/ 之下、含 suite.ts；缺省不启用，R1 行为不变）',
  '  --judge-existing <dir> 离线复判：只读该 run-dir 的冻结副本与证据，不跑模型',
  '  --judge-selftest       判定器自测：三类反例证据包 + 区分矩阵（不跑模型）',
  '  --with-llm-judge       接受但本轮不消费 LLM_JUDGE_MODEL（判据无 judge 面；assisted 留空）',
].join('\n');

interface CliArgs {
  cases: string[];
  trial?: number;
  trials: number;
  outDir?: string;
  suite?: string;
  judgeExisting?: string;
  judgeSelftest: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | { usageError: string } {
  const args: CliArgs = { cases: [], trials: 1, judgeSelftest: false };
  const readValue = (index: number, flag: string): string | { error: string } => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} 需要一个值` };
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | { error: string } => (inline !== undefined ? inline : readValue(index, flag));
    if (flag === '--case' || flag === '--cases') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      args.cases.push(...got.split(','));
    } else if (flag === '--trial') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      const parsed = Number.parseInt(got, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) return { usageError: `--trial 必须是正整数：${got}` };
      args.trial = parsed;
    } else if (flag === '--trials') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      const parsed = Number.parseInt(got, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) return { usageError: `--trials 必须是正整数：${got}` };
      args.trials = parsed;
    } else if (flag === '--out-dir' || flag === '--out') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      args.outDir = path.resolve(got);
    } else if (flag === '--suite') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      // 相对路径按仓根解析（与 npm run 的 cwd 无关，保证可复现）。
      args.suite = path.isAbsolute(got) ? path.resolve(got) : path.resolve(REPO_ROOT, got);
    } else if (flag === '--judge-existing') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      args.judgeExisting = path.resolve(got);
    } else if (flag === '--judge-selftest') {
      args.judgeSelftest = true;
    } else if (flag === '--with-llm-judge') {
      // 接受但本轮不消费（接口冻结项 d）；assisted 恒为空缺说明。
    } else {
      return { usageError: `未知参数：${arg}` };
    }
  }
  return args;
}

// ── 运行级工具 ────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + '\n';
}

function gitFacts(): { head: string; branch: string; dirty: boolean } {
  const run = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    return (result.stdout ?? '').trim();
  };
  return {
    head: run(['rev-parse', 'HEAD']),
    branch: run(['branch', '--show-current']),
    dirty: run(['status', '--porcelain']) !== '',
  };
}

function newRunId(): string {
  return `evalr1-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
}

interface FrozenRun {
  criteriaSha256: string;
  casesSha256: string;
  criteriaText: string;
  casesText: string;
}

/**
 * 运行上下文：R1 缺省 = 原常量；`--suite` = 外部套件的数据面。
 * 除 cases/lock/out/判据文档/版本标签外，其余全部复用本文件既有实现。
 */
interface SuiteContext {
  id: string;
  cases: readonly UserCase[];
  lockPath: string;
  defaultOutDir: string;
  resolveCaseIds: (raw: string) => string[];
  criteriaDocument: () => Record<string, unknown>;
  criteriaVersion: string;
}

function r1Context(): SuiteContext {
  return {
    id: 'convergence-r1',
    cases: ALL_CASES,
    lockPath: CRITERIA_LOCK,
    defaultOutDir: DEFAULT_OUT_DIR,
    resolveCaseIds: normalizeCaseId,
    criteriaDocument: buildCriteriaDocument,
    criteriaVersion: CRITERIA_VERSION,
  };
}

function suiteContext(suite: EvalSuite): SuiteContext {
  return {
    id: suite.id,
    cases: suite.cases,
    lockPath: suite.lockPath,
    defaultOutDir: suite.defaultOutDir,
    resolveCaseIds: suite.resolveCaseIds ?? ((raw: string) => genericResolveCaseIds(suite.cases, raw)),
    criteriaDocument: suite.criteriaDocument ?? buildCriteriaDocument,
    criteriaVersion: suite.criteriaVersion ?? CRITERIA_VERSION,
  };
}

function buildFrozenRun(ctx: SuiteContext): FrozenRun {
  const criteriaText = canonicalJson(ctx.criteriaDocument());
  const casesText = canonicalJson(ctx.cases);
  return {
    criteriaSha256: sha256Hex(criteriaText),
    casesSha256: sha256Hex(casesText),
    criteriaText,
    casesText,
  };
}

function verifyLock(frozen: FrozenRun, lockPath: string): string[] {
  if (!existsSync(lockPath)) return ['criteria.lock 不存在（smoke/首轮前允许；冻结后必须存在且一致）'];
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      criteriaSha256?: string;
      casesSha256?: string;
    };
    const problems: string[] = [];
    if (lock.criteriaSha256 !== frozen.criteriaSha256) problems.push(`criteria sha256 与 criteria.lock 不一致（期望 ${String(lock.criteriaSha256)}，实际 ${frozen.criteriaSha256}）——冻结后不得改判据`);
    if (lock.casesSha256 !== frozen.casesSha256) problems.push(`cases sha256 与 criteria.lock 不一致（期望 ${String(lock.casesSha256)}，实际 ${frozen.casesSha256}）——冻结后不得改用例`);
    return problems;
  } catch (error) {
    return [`criteria.lock 不可解析：${error instanceof Error ? error.message : String(error)}`];
  }
}

// ── 记录包装器（唯一允许插桩：透传不改语义） ─────────────────────────────────

interface RecordingSink {
  currentTurn: number;
  calls: ToolCallRecord[];
  mainTranscripts: Array<{ turn: number; messages: unknown }>;
  workerTranscripts: Array<{ turn: number; messages: unknown }>;
}

function safeValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function summarizeResult(result: unknown): string {
  if (result !== null && typeof result === 'object') {
    const record = result as { status?: unknown; error?: unknown; data?: unknown };
    const status = typeof record.status === 'string' ? record.status : 'unknown';
    const error = record.error !== null && typeof record.error === 'object' && typeof (record.error as { code?: unknown }).code === 'string'
      ? ` error=${(record.error as { code: string }).code}`
      : '';
    return `${status}${error}`;
  }
  return String(result).slice(0, 200);
}

function recordingDriver(inner: TurnDriver, agent: 'main' | 'worker', sink: RecordingSink): TurnDriver {
  const wrapped: TurnDriver = {
    async run(input: TurnDriverInput) {
      const turn = sink.currentTurn;
      let seq = 0;
      const wrappedInput: TurnDriverInput = {
        ...input,
        exec: async (tool, args, signal) => {
          seq += 1;
          const startedAt = new Date().toISOString();
          const startedMs = Date.now();
          try {
            const result = await input.exec(tool, args, signal);
            sink.calls.push({
              turn, agent, seq, tool,
              args: safeValue(args),
              result: safeValue(result),
              resultSummary: summarizeResult(result),
              startedAt,
              elapsedMs: Date.now() - startedMs,
            });
            return result;
          } catch (error) {
            sink.calls.push({
              turn, agent, seq, tool,
              args: safeValue(args),
              isError: true,
              resultSummary: error instanceof Error ? error.message : String(error),
              startedAt,
              elapsedMs: Date.now() - startedMs,
            });
            throw error;
          }
        },
      };
      const result = await inner.run(wrappedInput);
      if (agent === 'main') sink.mainTranscripts.push({ turn, messages: result.messages });
      else sink.workerTranscripts.push({ turn, messages: result.messages });
      return result;
    },
    ...(inner.compact ? { compact: inner.compact.bind(inner) } : {}),
    ...(inner.synthesizeAssistant ? { synthesizeAssistant: inner.synthesizeAssistant.bind(inner) } : {}),
  };
  return wrapped;
}

/** 捕获 pi 驱动结构化日志（重试/压缩事件）；转发原日志，不改语义。 */
function captureDriverEvents(buffer: Array<Record<string, unknown>>): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;
  const handler = (...args: unknown[]): void => {
    try {
      const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ').trim();
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed !== null && typeof parsed === 'object' && typeof parsed['event'] === 'string' && String(parsed['event']).startsWith('pi_driver')) {
          buffer.push(parsed);
        }
      }
    } catch { /* 日志解析失败不影响运行 */ }
    originalError(...args);
  };
  console.error = handler as typeof console.error;
  console.warn = handler as typeof console.warn;
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
}

function usageOfMessage(message: unknown): { input?: number; output?: number; cacheRead?: number; total?: number } | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown };
  const pick = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const picked = { input: pick(record.input), output: pick(record.output), cacheRead: pick(record.cacheRead), total: pick(record.totalTokens) };
  return Object.values(picked).some((value) => value !== undefined) ? picked : undefined;
}

// ── 单 trial 运行 ────────────────────────────────────────────────────────────

interface TrialOptions {
  caseDef: UserCase;
  trial: number;
  trialDir: string;
  runId: string;
  frozen: FrozenRun;
}

async function runTrial(options: TrialOptions): Promise<void> {
  const { caseDef, trial, trialDir, runId, frozen } = options;
  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(trialDir, { recursive: true });
  const stateDir = path.join(trialDir, 'state');
  const dbDir = path.join(trialDir, 'db');
  const configDir = path.join(trialDir, 'config');
  for (const dir of [stateDir, dbDir, configDir]) mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dbDir, 'state.db');
  const configCopy = path.join(configDir, 'agent-config.yaml');

  // 配置物化副本：同一份仓内 dummy 面配置（ask 同源 materialize），root 绝对、dbPath 指入本 case。
  materializeEvalConfig(FIXTURE_CONFIG, configCopy);
  const configDoc = parseYaml(readFileSync(configCopy, 'utf8')) as Record<string, unknown>;
  configDoc['store'] = { dbPath };
  writeFileSync(configCopy, stringifyYaml(configDoc));

  const config: AppConfig = loadConfig({ yamlPath: configCopy });
  const env = effectiveDeploymentEnv(config, process.env);
  if ((env['LLM_API_KEY'] ?? '').trim() === '') {
    throw new Error('未检测到 LLM_API_KEY——真实模型 eval 需要密钥只在 .env（不落地、不落跟踪文件）。');
  }
  const profileIds = Object.keys(config.contextProfiles);
  if (profileIds.length !== 1) throw new Error(`需要单一 contextProfile（当前 ${profileIds.length} 个）`);
  const profile = config.contextProfiles[profileIds[0]!]!;
  if (!profile.gateway) throw new Error('profile 缺少 gateway——执行层挂载声明缺失');
  const principalId = Object.entries(config.principals).find(([, principal]) => principal.enabled)?.[0];
  if (principalId === undefined) throw new Error('配置里没有 enabled principal（fail-closed）');
  const sessionId = `eval-r1-${caseDef.id}-trial-${trial}-${runId}`;
  const sink: RecordingSink = { currentTurn: 0, calls: [], mainTranscripts: [], workerTranscripts: [] };
  // 共享装配核心（P0 单一装配点）：per-case 配置/库、记录包装器、隔离门与审计路径按输入注入，
  // 其余（执行面/底账/技能角色/驱动基线）由核心与 ask/server 同源构造。
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
      assertEvalIsolation(isolation, `convergence-r1 ${caseDef.id} trial-${trial}`);
    },
    emptyOperationsMessage: '执行层没有声明任何只读 operation——拒绝以空允许集合运行',
    createDrivers: (driverEnv) => ({
      mainDriver: recordingDriver(createPiTurnDriver({ env: driverEnv }), 'main', sink),
      workerDriver: recordingDriver(createPiTurnDriver({ env: driverEnv }), 'worker', sink),
    }),
  });
  const auditPath = assembled.auditPath;
  const replies: Array<{ turn: number; text: string; sha256: string }> = [];
  const metaTurns: MetaTurn[] = [];
  const auditIndexTurns: AuditIndexTurn[] = [];
  const driverEvents: Array<Record<string, unknown>> = [];
  let auditLineCount = 0;
  let previousTranscriptLength = 0;
  let tasksSnapshot: unknown[] = [];

  try {
    const session = assembled.session;

    for (let index = 0; index < caseDef.turns.length; index += 1) {
      const turn = index + 1;
      sink.currentTurn = turn;
      const events: Array<Record<string, unknown>> = [];
      const restore = captureDriverEvents(events);
      const startedMs = Date.now();
      let turnError: string | undefined;
      let result: Awaited<ReturnType<typeof session.send>> | undefined;
      try {
        result = await session.send(caseDef.turns[index]!);
      } catch (error) {
        turnError = error instanceof Error ? error.message : String(error);
      } finally {
        restore();
      }
      const durationMs = Date.now() - startedMs;
      const allLines = readLinesSafe(auditPath);
      const fromLine = auditLineCount + 1;
      const toLine = allLines.length;
      const slice = allLines.slice(auditLineCount, allLines.length);
      auditIndexTurns.push({
        index: turn,
        fromLine,
        toLine,
        sha256: sha256Hex(slice.join('\n') + (slice.length > 0 ? '\n' : '')),
        structuredRows: slice.filter((line) => safeParse(line)?.via === 'structured').length,
        refusedRows: slice.filter((line) => typeof safeParse(line)?.refused === 'string').length,
      });
      auditLineCount = allLines.length;

      const transcript = [...session.transcript()];
      const delta = transcript.slice(previousTranscriptLength);
      previousTranscriptLength = transcript.length;
      const assistantMessages = delta.filter((message) => (message as { role?: unknown }).role === 'assistant');
      const usages = assistantMessages.map((message) => usageOfMessage(message)).filter((usage): usage is NonNullable<typeof usage> => usage !== undefined);
      const tokens = usages.length > 0
        ? {
            available: true,
            input: usages.reduce((sum, usage) => sum + (usage.input ?? 0), 0),
            output: usages.reduce((sum, usage) => sum + (usage.output ?? 0), 0),
            cacheRead: usages.reduce((sum, usage) => sum + (usage.cacheRead ?? 0), 0),
            total: usages.reduce((sum, usage) => sum + (usage.total ?? 0), 0),
            source: 'assistant.usage',
          }
        : { available: false, source: 'assistant.usage 缺失（本轮未采集到 usage 数值）' };
      const retries = events.filter((event) => event['event'] === 'pi_driver_model_error').length;
      const notes: string[] = [];
      if (turnError !== undefined) notes.push(`turn 执行异常：${turnError}`);
      metaTurns.push({
        index: turn,
        durationMs,
        modelCalls: assistantMessages.length,
        taskIds: [...(result?.taskIds ?? [])],
        tokens,
        retries,
        notes,
      });
      replies.push({ turn, text: result?.reply ?? '', sha256: sha256Hex(result?.reply ?? '') });
      driverEvents.push(...events.map((event) => ({ turn, ...event })));
      if (turnError !== undefined) {
        writeFileSync(path.join(trialDir, 'trial-error.json'), JSON.stringify({ turn, error: turnError }, null, 2) + '\n');
        break;
      }
    }
    tasksSnapshot = [...assembled.taskRegistry.list()];
  } finally {
    assembled.close();
  }

  // 证据落盘（全样本保留；audit 为 state/audit.jsonl 的字节副本）。
  const inputsJson = {
    caseId: caseDef.id,
    trial,
    principalId,
    sessionId,
    turns: caseDef.turns.map((text, index) => ({ index: index + 1, text, sha256: sha256Hex(text) })),
    configPath: configCopy,
    profileRoot: profile.root,
    gateway: profile.gateway,
    dbPath,
  };
  writeFileSync(path.join(trialDir, 'inputs.json'), JSON.stringify(inputsJson, null, 2) + '\n');
  const baseUrl = env['LLM_API_BASE_URL'] ?? '';
  let baseUrlHost = '';
  try {
    baseUrlHost = new URL(baseUrl).host;
  } catch { baseUrlHost = ''; }
  writeFileSync(path.join(trialDir, 'model.json'), JSON.stringify({
    modelId: env['LLM_MAIN_MODEL'] ?? env['LLM_MODEL'] ?? '',
    mainModel: env['LLM_MAIN_MODEL'] ?? env['LLM_MODEL'] ?? '',
    workerModel: env['LLM_MODEL'] ?? '',
    source: 'env（.env / 进程环境；不落密钥）',
    thinkingLevel: env['LLM_MAIN_THINKING_LEVEL'] ?? env['LLM_THINKING_LEVEL'] ?? null,
    baseUrlHost,
    keyPresent: (env['LLM_API_KEY'] ?? '').trim() !== '',
    retries: metaTurns.reduce((sum, turn) => sum + turn.retries, 0),
  }, null, 2) + '\n');
  writeFileSync(
    path.join(trialDir, 'toolcalls.jsonl'),
    sink.calls.map((call) => JSON.stringify(call)).join('\n') + (sink.calls.length > 0 ? '\n' : ''),
  );
  writeFileSync(path.join(trialDir, 'transcript.main.json'), JSON.stringify(
    sink.mainTranscripts.map((entry) => ({ turn: entry.turn, messages: entry.messages })),
    null,
    2,
  ) + '\n');
  writeFileSync(
    path.join(trialDir, 'transcript.worker.jsonl'),
    sink.workerTranscripts.map((entry) => JSON.stringify(entry)).join('\n') + (sink.workerTranscripts.length > 0 ? '\n' : ''),
  );
  writeFileSync(path.join(trialDir, 'audit.index.json'), JSON.stringify({ turns: auditIndexTurns, totalLines: auditLineCount }, null, 2) + '\n');
  if (existsSync(auditPath)) copyFileBytes(auditPath, path.join(trialDir, 'audit.jsonl'));
  else writeFileSync(path.join(trialDir, 'audit.jsonl'), '');
  writeFileSync(path.join(trialDir, 'executions.json'), JSON.stringify({
    tasks: tasksSnapshot,
  }, null, 2) + '\n');
  writeFileSync(
    path.join(trialDir, 'reply.jsonl'),
    replies.map((reply) => JSON.stringify(reply)).join('\n') + (replies.length > 0 ? '\n' : ''),
  );
  writeFileSync(path.join(trialDir, 'meta.json'), JSON.stringify({ turns: metaTurns, driverEvents, notes: [] }, null, 2) + '\n');

  const judgment = judgeTrial({
    trialDir,
    caseDef,
    trial,
    criteriaSha256: frozen.criteriaSha256,
    casesSha256: frozen.casesSha256,
  });
  writeFileSync(path.join(trialDir, 'judgment.json'), JSON.stringify(judgment, null, 2) + '\n');
}

function safeParse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 审计行读取：文件尚未创建（本轮零执行）返回空数组，不把缺文件当运行失败。 */
function readLinesSafe(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function copyFileBytes(source: string, target: string): void {
  writeFileSync(target, readFileSync(source));
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

interface RunTrialResult {
  caseId: string;
  trial: number;
  judgment: Judgment;
  infraError?: string;
}

function trialDirOf(outDir: string, caseId: string, trial: number): string {
  return path.join(outDir, 'runs', caseId, `trial-${trial}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('usageError' in parsed) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.judgeSelftest) {
    const code = runJudgeSelftest(parsed.outDir ?? DEFAULT_OUT_DIR);
    process.exitCode = code;
    return;
  }
  if (parsed.judgeExisting !== undefined) {
    process.exitCode = runJudgeExisting(parsed.judgeExisting);
    return;
  }

  // ── 套件上下文（缺省 = R1；--suite 时只替换数据面，其余实现全部复用） ─────────
  const suite = parsed.suite !== undefined ? await loadSuite(parsed.suite) : undefined;
  const ctx = suite !== undefined ? suiteContext(suite) : r1Context();

  const selectedIds = ctx.resolveCaseIds(parsed.cases.length > 0 ? parsed.cases.join(',') : 'all');
  const selected = ctx.cases.filter((caseDef) => selectedIds.includes(caseDef.id));
  if (selected.length === 0) {
    console.error(`没有匹配的用例：${parsed.cases.join(',')}`);
    process.exitCode = 2;
    return;
  }
  const trials = parsed.trial !== undefined ? [parsed.trial] : Array.from({ length: parsed.trials }, (_, index) => index + 1);

  const frozen = buildFrozenRun(ctx);
  const lockProblems = verifyLock(frozen, ctx.lockPath);
  for (const problem of lockProblems) console.warn(`[freeze] ${problem}`);
  if (lockProblems.some((problem) => !problem.includes('不存在'))) {
    console.error('判据/用例与 criteria.lock 不一致——冻结后不得修改；拒绝运行（fail-closed）。');
    process.exitCode = 2;
    return;
  }

  const outDir = parsed.outDir ?? ctx.defaultOutDir;
  const runId = newRunId();
  mkdirSync(path.join(outDir, 'criteria'), { recursive: true });
  writeFileSync(path.join(outDir, 'criteria', 'criteria.json'), frozen.criteriaText);
  writeFileSync(path.join(outDir, 'criteria', 'cases.json'), frozen.casesText);

  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null as string | null,
    git: gitFacts(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    model: {
      id: venvModelId(),
      baseUrlHost: venvBaseUrlHost(),
      thinkingLevel: null as string | null,
      keyPresent: (process.env['LLM_API_KEY'] ?? '').trim() !== '',
    },
    judge: { version: JUDGE_VERSION, llmJudgeModel: null as string | null },
    criteriaVersion: ctx.criteriaVersion,
    criteriaSha256: frozen.criteriaSha256,
    casesSha256: frozen.casesSha256,
    runMode: 'run',
    runnerVersion: RUNNER_VERSION,
    isolation: null as unknown,
    ...(suite !== undefined ? { suite: { id: ctx.id, lockPath: ctx.lockPath, casesCount: ctx.cases.length } } : {}),
  };
  const modelId = process.env['LLM_MODEL'] ?? '';
  manifest.model.id = process.env['LLM_MAIN_MODEL'] ?? modelId;
  manifest.model.thinkingLevel = process.env['LLM_MAIN_THINKING_LEVEL'] ?? process.env['LLM_THINKING_LEVEL'] ?? null;
  // 先落一次 manifest（中途崩溃也能离线复判/审计），结束再补 finishedAt 与 isolation。
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const results: RunTrialResult[] = [];
  for (const caseDef of selected) {
    for (const trial of trials) {
      const trialDir = trialDirOf(outDir, caseDef.id, trial);
      console.log(`[run] ${caseDef.id} trial-${trial} → ${path.relative(REPO_ROOT, trialDir)}`);
      try {
        await runTrial({ caseDef, trial, trialDir, runId, frozen });
        const judgment = JSON.parse(readFileSync(path.join(trialDir, 'judgment.json'), 'utf8')) as Judgment;
        results.push({ caseId: caseDef.id, trial, judgment });
        console.log(`[judge] ${caseDef.id} trial-${trial}: ${judgment.deterministic.verdict}${judgment.deterministic.failureCodes.length > 0 ? ` (${judgment.deterministic.failureCodes.join(', ')})` : ''}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[run] ${caseDef.id} trial-${trial} 失败：${message}`);
        mkdirSync(trialDir, { recursive: true });
        writeFileSync(path.join(trialDir, 'trial-error.json'), JSON.stringify({ error: message }, null, 2) + '\n');
        let judgment: Judgment;
        try {
          judgment = judgeTrial({ trialDir, caseDef, trial, criteriaSha256: frozen.criteriaSha256, casesSha256: frozen.casesSha256 });
          writeFileSync(path.join(trialDir, 'judgment.json'), JSON.stringify(judgment, null, 2) + '\n');
        } catch (judgeError) {
          judgment = fallbackJudgment(caseDef.id, trial, frozen, message, judgeError instanceof Error ? judgeError.message : String(judgeError));
          try {
            mkdirSync(trialDir, { recursive: true });
            writeFileSync(path.join(trialDir, 'judgment.json'), JSON.stringify(judgment, null, 2) + '\n');
          } catch { /* 证据目录不可写时仍按 infra 失败上报 */ }
        }
        results.push({ caseId: caseDef.id, trial, judgment, infraError: message });
      }
    }
  }

  manifest.finishedAt = new Date().toISOString();
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const isolatedProfile = readIsolationFromFirstTrial(outDir);
  if (isolatedProfile !== null) {
    manifest.isolation = isolatedProfile;
    writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  const exitCode = writeSummaryAndReport({
    outDir, results, selected, trials, frozen, runId,
    criteriaVersion: ctx.criteriaVersion,
    ...(suite !== undefined ? { suiteId: ctx.id } : {}),
  });
  console.log(`[summary] ${path.relative(REPO_ROOT, path.join(outDir, 'summary.json'))} / ${path.relative(REPO_ROOT, path.join(outDir, 'report.md'))}`);
  process.exitCode = exitCode;
}

function venvModelId(): string {
  return process.env['LLM_MAIN_MODEL'] ?? process.env['LLM_MODEL'] ?? '';
}

function venvBaseUrlHost(): string {
  try {
    return new URL(process.env['LLM_API_BASE_URL'] ?? '').host;
  } catch {
    return '';
  }
}

function readIsolationFromFirstTrial(outDir: string): unknown {
  const runsRoot = path.join(outDir, 'runs');
  if (!existsSync(runsRoot)) return null;
  for (const caseId of readdirSync(runsRoot)) {
    const caseDir = path.join(runsRoot, caseId);
    for (const trialName of readdirSync(caseDir)) {
      const inputsPath = path.join(caseDir, trialName, 'inputs.json');
      if (existsSync(inputsPath)) {
        const inputs = JSON.parse(readFileSync(inputsPath, 'utf8')) as { profileRoot: string; gateway: string; dbPath: string };
        return {
          profileRoot: inputs.profileRoot,
          gateway: inputs.gateway,
          auditPath: path.join(caseDir, trialName, 'state', 'audit.jsonl'),
          dbPath: inputs.dbPath,
          safetyGate: 'pass（assessEvalIsolation 全绿；fail-closed）',
        };
      }
    }
  }
  return null;
}

function fallbackJudgment(caseId: string, trial: number, frozen: FrozenRun, reason: string, judgeReason: string): Judgment {
  const body: Omit<Judgment, 'judgedAt' | 'judgmentSha256'> = {
    caseId,
    trial,
    criteriaSha256: frozen.criteriaSha256,
    casesSha256: frozen.casesSha256,
    judgeVersion: JUDGE_VERSION,
    deterministic: {
      verdict: 'INCONCLUSIVE',
      failureCodes: ['INCONCLUSIVE_JUDGE'],
      dimensions: Object.fromEntries(
        ['①用户级完成', '②执行真实性', '③数据正确性', '④任务状态一致性', '⑤用户干预', '⑥效率']
          .map((dim) => [dim, { status: 'inconclusive' as const, notes: [reason] }]),
      ),
    },
    weakNotices: [],
    assisted: { available: false, reason: 'judge 不可达（infra）' },
    evidenceRefs: [],
    inconclusiveReasons: [`trial 运行失败：${reason}`, `判定器不可用：${judgeReason}`],
  };
  return { ...body, judgedAt: new Date().toISOString(), judgmentSha256: sha256Hex(stableStringify(body)) };
}

// ── 汇总与报告 ────────────────────────────────────────────────────────────────

interface SummaryInput {
  outDir: string;
  results: RunTrialResult[];
  selected: readonly UserCase[];
  trials: number[];
  frozen: FrozenRun;
  runId: string;
  criteriaVersion: string;
  /** 仅套件运行时出现（报告标题/汇总里标注套装 id）。 */
  suiteId?: string;
}

function writeSummaryAndReport(input: SummaryInput): number {
  const { outDir, results } = input;
  const verdicts: Record<string, Record<string, { verdict: string; failureCodes: string[] }>> = {};
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  const codeHistogram: Record<string, number> = {};
  const dimensionHistogram: Record<string, Record<string, number>> = {};
  for (const result of results) {
    verdicts[result.caseId] ??= {};
    verdicts[result.caseId]![`trial-${result.trial}`] = {
      verdict: result.judgment.deterministic.verdict,
      failureCodes: result.judgment.deterministic.failureCodes,
    };
    counts[result.judgment.deterministic.verdict] += 1;
    for (const code of result.judgment.deterministic.failureCodes) codeHistogram[code] = (codeHistogram[code] ?? 0) + 1;
    for (const [dim, state] of Object.entries(result.judgment.deterministic.dimensions)) {
      dimensionHistogram[dim] ??= {};
      dimensionHistogram[dim]![state.status] = (dimensionHistogram[dim]![state.status] ?? 0) + 1;
    }
  }
  const summary = {
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    criteriaVersion: input.criteriaVersion,
    criteriaSha256: input.frozen.criteriaSha256,
    casesSha256: input.frozen.casesSha256,
    matrix: verdicts,
    counts,
    failureCodeHistogram: codeHistogram,
    dimensionHistogram,
    trialsPlanned: input.trials,
    samples: results.length,
    ...(input.suiteId !== undefined ? { suite: { id: input.suiteId, casesCount: input.selected.length } } : {}),
  };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  const lines: string[] = [
    `# ${input.suiteId ?? 'convergence-r1'} 用户级评测报告（全样本，不筛绿）`,
    '',
    `- runId：\`${input.runId}\``,
    `- criteriaSha256：\`${input.frozen.criteriaSha256}\`；casesSha256：\`${input.frozen.casesSha256}\``,
    `- 样本：${results.length}（PASS ${counts.PASS} / FAIL ${counts.FAIL} / INCONCLUSIVE ${counts.INCONCLUSIVE}）`,
    '',
    '## 矩阵',
    '',
    '| 用例 | trial | verdict | failureCodes |',
    '| --- | --- | --- | --- |',
  ];
  for (const result of results) {
    lines.push(`| ${result.caseId} | ${result.trial} | ${result.judgment.deterministic.verdict} | ${result.judgment.deterministic.failureCodes.join(', ') || '-'} |`);
  }
  lines.push('', '## 逐样本证据', '');
  for (const result of results) {
    const trialDir = trialDirOf(outDir, result.caseId, result.trial);
    const replies = readJsonlSafe(path.join(trialDir, 'reply.jsonl'));
    const executions = readJsonSafe<{ tasks: Array<{ taskId: string; status: string; executions: Array<{ operation: string; status: string }> }> }>(
      path.join(trialDir, 'executions.json'),
    );
    lines.push(`### ${result.caseId} trial-${result.trial} — ${result.judgment.deterministic.verdict}`);
    lines.push('');
    lines.push(`- 失败类别：${result.judgment.deterministic.failureCodes.join(', ') || '（无）'}`);
    if (result.judgment.inconclusiveReasons.length > 0) {
      lines.push(`- INCONCLUSIVE：${result.judgment.inconclusiveReasons.join('；')}`);
    }
    if (result.judgment.weakNotices.length > 0) {
      lines.push(`- 弱告警：${result.judgment.weakNotices.join('；')}`);
    }
    if (result.infraError !== undefined) lines.push(`- infra 失败：${result.infraError}`);
    lines.push('- 维度：');
    for (const [dim, state] of Object.entries(result.judgment.deterministic.dimensions)) {
      lines.push(`  - ${dim}：${state.status}${state.notes.length > 0 ? `（${state.notes.join('；')}）` : ''}`);
    }
    if (executions) {
      lines.push(`- T1：${executions.tasks.map((task) => `${task.status}[${task.executions.map((execution) => `${execution.operation}=${execution.status}`).join(' ')}]`).join('；') || '（无任务）'}`);
    }
    for (const reply of replies) {
      lines.push(`- turn-${reply.turn} 回复原文：`);
      lines.push('```');
      lines.push(reply.text);
      lines.push('```');
    }
    lines.push(`- 证据目录：\`${path.relative(REPO_ROOT, trialDir)}\``);
    lines.push('');
  }
  writeFileSync(path.join(outDir, 'report.md'), lines.join('\n') + '\n');

  if (counts.INCONCLUSIVE > 0 || results.some((result) => result.infraError !== undefined)) return 2;
  if (counts.FAIL > 0) return 1;
  return 0;
}

function readJsonlSafe(file: string): Array<{ turn: number; text: string }> {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { turn: number; text: string });
  } catch {
    return [];
  }
}

function readJsonSafe<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// ── 离线复判 ──────────────────────────────────────────────────────────────────

function runJudgeExisting(runDir: string): number {
  const manifestPath = path.join(runDir, 'manifest.json');
  const criteriaCopy = path.join(runDir, 'criteria', 'criteria.json');
  const casesCopy = path.join(runDir, 'criteria', 'cases.json');
  for (const file of [manifestPath, criteriaCopy, casesCopy]) {
    if (!existsSync(file)) {
      console.error(`[judge-existing] 缺少 ${file}`);
      return 2;
    }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    criteriaSha256?: string;
    casesSha256?: string;
    criteriaVersion?: string;
    suite?: { id?: string };
  };
  const criteriaText = readFileSync(criteriaCopy, 'utf8');
  const casesText = readFileSync(casesCopy, 'utf8');
  if (sha256Hex(criteriaText) !== manifest.criteriaSha256 || sha256Hex(casesText) !== manifest.casesSha256) {
    console.error('[judge-existing] 冻结副本哈希与 manifest 不符——拒绝复判（fail-closed）');
    return 2;
  }
  const cases = JSON.parse(casesText) as UserCase[];
  const caseById = new Map(cases.map((caseDef) => [caseDef.id, caseDef]));
  const runsRoot = path.join(runDir, 'runs');
  if (!existsSync(runsRoot)) {
    console.error('[judge-existing] 没有 runs/ 证据');
    return 2;
  }
  const results: RunTrialResult[] = [];
  let nondeterministic = false;
  for (const caseId of readdirSync(runsRoot).sort()) {
    const caseDir = path.join(runsRoot, caseId);
    for (const trialName of readdirSync(caseDir).sort()) {
      const match = /^trial-(\d+)$/.exec(trialName);
      if (!match) continue;
      const trial = Number.parseInt(match[1]!, 10);
      const trialDir = path.join(caseDir, trialName);
      const caseDef = caseById.get(caseId);
      if (!caseDef) {
        console.error(`[judge-existing] 证据目录 ${caseId} 不在冻结用例集内`);
        return 2;
      }
      const existingPath = path.join(trialDir, 'judgment.json');
      const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) as Judgment : undefined;
      const judgment = judgeTrial({ trialDir, caseDef, trial, criteriaSha256: manifest.criteriaSha256!, casesSha256: manifest.casesSha256! });
      if (existing && judgmentBodyHash(existing) !== judgment.judgmentSha256) {
        console.error(`[judge-existing] ${caseId} trial-${trial} 复判结果与既有 judgment 不一致（判定器非确定）`);
        nondeterministic = true;
        writeFileSync(path.join(trialDir, 'judgment.recheck.json'), JSON.stringify(judgment, null, 2) + '\n');
      } else {
        writeFileSync(existingPath, JSON.stringify(judgment, null, 2) + '\n');
      }
      results.push({ caseId, trial, judgment });
    }
  }
  const exitCode = writeSummaryAndReport({
    outDir: runDir,
    results,
    selected: cases,
    trials: [...new Set(results.map((result) => result.trial))].sort((a, b) => a - b),
    frozen: { criteriaSha256: manifest.criteriaSha256!, casesSha256: manifest.casesSha256!, criteriaText, casesText },
    runId: `judge-existing-${path.basename(runDir)}`,
    criteriaVersion: manifest.criteriaVersion ?? CRITERIA_VERSION,
    ...(manifest.suite?.id !== undefined ? { suiteId: manifest.suite.id } : {}),
  });
  return nondeterministic ? 2 : exitCode;
}

await main().catch((error: unknown) => {
  console.error('eval:user 运行失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
