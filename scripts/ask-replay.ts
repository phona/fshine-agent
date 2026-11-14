/**
 * P7a 脚本化回放（`npm run ask -- --script <file> [--trace <dir>]`）。
 *
 * 依据：R4 验收设计 §3/§3.1（脚本格式 P7a 子集）与 P7-T02/T03；owner 裁定 P7a 只做前置能力，
 * 依赖 P4（通知）/P5（资源）/P6（异步/重启）的注入种类与断言种类一律 blocked（fail-closed）。
 *
 * 设计（冻结于 scripts/ask-replay.test.ts）：
 *   · 脚本=数据（YAML，import 不执行）；session.principal/session 为可信身份显式声明；
 *     可选 sessions 映射 + turn.session 选择（多会话/多 principal，底账按 scope 隔离）；
 *   · config 相对脚本目录解析（缺省仓内 dummy 面配置），物化副本进 run/runtime/config，
 *     隔离门 fail-closed（root 必须在仓内夹具目录之下）；
 *   · 模型面=脚本内确定性计划（model.reply + model.delegate[].worker），假 driver 零模型、
 *     零网络、不要求 LLM 密钥；Runtime 仍是共享装配核心（assembleSessionCore，生产唯一
 *     createSession 调用点）+ 记录包装器（只插桩、透传不改语义）；
 *   · 退出码：0 全过 / 1 断言失败或回合执行异常 / 2 脚本、参数或门拒绝 / 3 blocked
 *     （未就绪依赖；不静默通过、blocked 后回合不执行、未到断言时点的不判定）；
 *   · trace：证据文件落 `--trace <dir>` 根（runner 11 类适用子集 + assertions.json +
 *     evidence.manifest.json），runtime/ 为运行态；script 模式全证据逐字可复现
 *     （标识归一 task@n/req@n、剔时钟与耗时）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { effectiveDeploymentEnv, loadConfig } from '@fshine/core';
import type { ContextProfileConfig } from '@fshine/contracts';
import { AssemblyRefusedError, assembleSessionCore, type AssembledSession } from './ask-runtime';
import { evaluateAssertion, parseAssertionSpec, type AssertionFacts, type AssertionResult, type AssertionSpec } from './ask-assert';
import { createTraceRecorder, type BlockedFact, type TraceTurnRecord } from './ask-trace';
import type { TurnDriver, TurnDriverInput } from '../packages/agent/src/driver-contract';
import type { Session } from '../packages/agent/src/execution-runtime';
import type { ExecutionRecord, TaskRegistry } from '../packages/agent/src/task-registry';
import { materializeEvalConfig } from './resolve-config-path';
import { EvalIsolationRefused, assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

// ── 脚本模型（§3.1 的 P7a 子集） ──────────────────────────────────────────────

interface ReplaySessionSpec {
  principal: string;
  session: string;
}

interface ReplayWorkerStep {
  operation?: string;
  args?: Record<string, unknown>;
  /** 内部携带位：该委派的汇报文本（来自 delegate.summary），供假 Worker driver 使用。 */
  summary?: string;
}

interface ReplayDelegate {
  request: string;
  worker?: ReplayWorkerStep;
  summary?: string;
}

interface ReplayModelPlan {
  reply: string;
  delegate?: ReplayDelegate[];
}

interface ReplayMessageTurn {
  kind: 'message';
  text: string;
  session: string;
  model: ReplayModelPlan;
}

interface ReplayInjectTurn {
  kind: 'inject';
  event: string;
}

type ReplayTurn = ReplayMessageTurn | ReplayInjectTurn;

interface ReplayScript {
  scenario: string;
  sessions: Array<{ name: string; principal: string; session: string }>;
  configPath?: string;
  threshold: string;
  turns: ReplayTurn[];
  expect: AssertionSpec[];
  evidence: string[];
  baselineHashes: Array<{ specValue: string; absolutePath: string; sha256: string }>;
}

/** 已知注入事件：一律 blocked（未就绪依赖，fail-closed）；未登记者按脚本错误拒绝。 */
const BLOCKED_EVENTS: Readonly<Record<string, string>> = {
  task_completed: '依赖 P4（通知 outbox）与 P2（任务生命周期），未合入',
  task_failed: '依赖 P2（任务生命周期）与 P4（通知 outbox），未合入',
  task_cancelled: '依赖 P2（任务生命周期），未合入',
  task_timeout: '依赖 P2（任务生命周期），未合入',
  notification_delivered: '依赖 P4（通知 outbox），未合入',
  notification_failed: '依赖 P4（通知 outbox），未合入',
  restart: '依赖 P6（后台执行/重启恢复），未合入',
  pool_full: '依赖 P5（资源强制），未合入',
  queue_full: '依赖 P5（资源强制），未合入',
  resource_shortage: '依赖 P5（资源强制），未合入',
  resource_released: '依赖 P5（资源强制），未合入',
  wait_user_timeout: '依赖 P2/P5（等待语义/超时），未合入',
};

const SUPPORTED_EVIDENCE = new Set([
  'replies', 'reply', 'executions', 'task_rows', 'audit', 'audit_index',
  'transcripts', 'transcript_main', 'transcript_worker', 'toolcalls', 'inputs', 'model', 'meta',
]);

const BLOCKED_EVIDENCE: Readonly<Record<string, string>> = {
  notifications: '依赖 P4（通知 outbox），未合入',
  resources: '依赖 P5（资源强制），未合入',
  resource_usage: '依赖 P5（资源强制），未合入',
  judgment: 'P7a 不产 convergence-r1 判定；本片断言报告见 assertions.json',
};

const BLOCKED_THRESHOLDS: Readonly<Record<string, string>> = {
  blackbox: '真实模型黑盒层（P7-E01）未授权落地；P7a 只跑确定性层',
  'black-box': '同 blackbox',
};

// ── 解析与校验（任何问题 → 脚本级拒绝 exit 2） ───────────────────────────────

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function parseSessionSpec(raw: unknown): ReplaySessionSpec | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const principal = typeof record['principal'] === 'string' ? record['principal'].trim() : '';
  const session = typeof record['session'] === 'string' ? record['session'].trim() : '';
  if (principal === '' || session === '') return undefined;
  return { principal, session };
}

function parseModelPlan(raw: unknown, where: string, errors: string[]): ReplayModelPlan | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${where}.model 需要对象（reply/delegate）`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const reply = typeof record['reply'] === 'string' ? record['reply'].trim() : '';
  if (reply === '') errors.push(`${where}.model.reply 需要非空字符串`);
  const delegate: ReplayDelegate[] = [];
  const delegateRaw = record['delegate'];
  if (delegateRaw !== undefined) {
    if (!Array.isArray(delegateRaw)) {
      errors.push(`${where}.model.delegate 需要数组`);
    } else {
      delegateRaw.forEach((item, index) => {
        const itemWhere = `${where}.model.delegate[${index + 1}]`;
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`${itemWhere} 需要对象`);
          return;
        }
        const delegateRecord = item as Record<string, unknown>;
        const request = typeof delegateRecord['request'] === 'string' ? delegateRecord['request'].trim() : '';
        if (request === '') errors.push(`${itemWhere}.request 需要非空字符串`);
        let worker: ReplayWorkerStep | undefined;
        const workerRaw = delegateRecord['worker'];
        if (workerRaw !== undefined) {
          if (workerRaw === null || typeof workerRaw !== 'object' || Array.isArray(workerRaw)) {
            errors.push(`${itemWhere}.worker 需要对象（operation/args）`);
          } else {
            const workerRecord = workerRaw as Record<string, unknown>;
            const operation = typeof workerRecord['operation'] === 'string' ? workerRecord['operation'].trim() : '';
            if (operation === '') errors.push(`${itemWhere}.worker.operation 需要非空字符串`);
            let args: Record<string, unknown> | undefined;
            const argsRaw = workerRecord['args'];
            if (argsRaw !== undefined) {
              if (argsRaw === null || typeof argsRaw !== 'object' || Array.isArray(argsRaw)) {
                errors.push(`${itemWhere}.worker.args 需要对象`);
              } else {
                args = argsRaw as Record<string, unknown>;
              }
            }
            worker = { ...(operation === '' ? {} : { operation }), ...(args === undefined ? {} : { args }) };
          }
        }
        const summary = typeof delegateRecord['summary'] === 'string' && delegateRecord['summary'].trim() !== ''
          ? delegateRecord['summary']
          : undefined;
        delegate.push({ request: request === '' ? '（无效 request）' : request, ...(worker === undefined ? {} : { worker }), ...(summary === undefined ? {} : { summary }) });
      });
    }
  }
  return { reply: reply === '' ? '（无效 reply）' : reply, ...(delegate.length > 0 ? { delegate } : {}) };
}

interface ParsedScript {
  script?: ReplayScript;
  errors: string[];
}

function parseScript(text: string, scriptDir: string): ParsedScript {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { errors: [`脚本 YAML 解析失败：${messageOf(error)}`] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { errors: ['脚本根需要对象（scenario/session/threshold/turns/expect）'] };
  }
  const root = doc as Record<string, unknown>;
  const errors: string[] = [];

  const scenario = typeof root['scenario'] === 'string' ? root['scenario'].trim() : '';
  if (scenario === '') errors.push('缺少 scenario（场景 ID）');

  const defaultSession = root['session'] === undefined ? undefined : parseSessionSpec(root['session']);
  if (root['session'] !== undefined && defaultSession === undefined) {
    errors.push('session 需要 principal 与 session（非空字符串）');
  }
  const namedSessions = new Map<string, ReplaySessionSpec>();
  const sessionsRaw = root['sessions'];
  if (sessionsRaw !== undefined) {
    if (sessionsRaw === null || typeof sessionsRaw !== 'object' || Array.isArray(sessionsRaw)) {
      errors.push('sessions 需要对象映射（名 → {principal, session}）');
    } else {
      for (const [name, raw] of Object.entries(sessionsRaw as Record<string, unknown>)) {
        if (name.trim() === '') {
          errors.push('sessions 存在空名称');
          continue;
        }
        const spec = parseSessionSpec(raw);
        if (spec === undefined) errors.push(`sessions.${name} 需要 principal 与 session（非空字符串）`);
        else namedSessions.set(name, spec);
      }
    }
  }
  if (defaultSession === undefined && namedSessions.size === 0) {
    errors.push('缺少 session（默认会话）且未提供 sessions');
  }
  const sessions: ReplayScript['sessions'] = [];
  if (defaultSession !== undefined) sessions.push({ name: 'default', ...defaultSession });
  for (const [name, spec] of namedSessions) sessions.push({ name, ...spec });

  const threshold = typeof root['threshold'] === 'string' ? root['threshold'].trim() : '';
  if (threshold === '') errors.push('缺少 threshold（确定性层写 deterministic）');

  let configPath: string | undefined;
  const configRaw = root['config'];
  if (typeof configRaw === 'string' && configRaw.trim() !== '') {
    configPath = path.resolve(scriptDir, configRaw.trim());
  } else if (configRaw !== undefined && configRaw !== null) {
    errors.push('config 需要路径字符串');
  }

  const turnsRaw = root['turns'];
  const turns: ReplayTurn[] = [];
  if (!Array.isArray(turnsRaw) || turnsRaw.length === 0) {
    errors.push('turns 需要非空数组');
  } else {
    turnsRaw.forEach((rawTurn, index) => {
      const where = `turn[${index + 1}]`;
      if (rawTurn === null || typeof rawTurn !== 'object' || Array.isArray(rawTurn)) {
        errors.push(`${where} 需要对象`);
        return;
      }
      const record = rawTurn as Record<string, unknown>;
      const kind = record['kind'];
      if (kind === 'inject') {
        const event = typeof record['event'] === 'string' ? record['event'].trim() : '';
        if (event === '') {
          errors.push(`${where}.event 需要非空字符串`);
        } else if (BLOCKED_EVENTS[event] === undefined) {
          errors.push(`${where}.event 未知（P7a 未登记的事件）：${event}`);
        } else {
          turns.push({ kind: 'inject', event });
        }
        return;
      }
      if (kind !== 'message') {
        errors.push(`${where}.kind 未知：${String(kind)}`);
        return;
      }
      const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
      if (text === '') errors.push(`${where}.text 需要非空字符串`);
      const sessionName = typeof record['session'] === 'string' && record['session'].trim() !== ''
        ? record['session'].trim()
        : (defaultSession !== undefined ? 'default' : '');
      if (sessionName === '') errors.push(`${where}.session 缺失（无默认会话）`);
      else if (!sessions.some((spec) => spec.name === sessionName)) {
        errors.push(`${where}.session 引用了未知会话：${sessionName}`);
      }
      const model = parseModelPlan(record['model'], where, errors);
      turns.push({
        kind: 'message',
        text: text === '' ? '（无效 text）' : text,
        session: sessionName === '' ? 'default' : sessionName,
        model: model ?? { reply: '（无效模型计划）' },
      });
    });
  }

  const expectRaw = root['expect'];
  const specs: AssertionSpec[] = [];
  if (expectRaw !== undefined) {
    if (!Array.isArray(expectRaw)) {
      errors.push('expect 需要数组');
    } else {
      expectRaw.forEach((raw, index) => {
        try {
          specs.push(parseAssertionSpec(raw));
        } catch (error) {
          errors.push(`expect[${index + 1}]：${messageOf(error)}`);
        }
      });
    }
  }
  for (const [index, spec] of specs.entries()) {
    if (typeof spec.after === 'number' && spec.after > turns.length) {
      errors.push(`expect[${index + 1}].after=${spec.after} 超出 turns 数量 ${turns.length}`);
    }
  }

  const evidenceRaw = root['evidence'];
  const evidence: string[] = [];
  if (evidenceRaw !== undefined) {
    if (!Array.isArray(evidenceRaw)) {
      errors.push('evidence 需要数组');
    } else {
      for (const item of evidenceRaw) {
        if (typeof item !== 'string' || item.trim() === '') {
          errors.push('evidence 条目需要非空字符串');
          continue;
        }
        evidence.push(item.trim());
      }
    }
  }
  for (const name of evidence) {
    if (!SUPPORTED_EVIDENCE.has(name) && BLOCKED_EVIDENCE[name] === undefined) {
      errors.push(`evidence 含未知类别：${name}`);
    }
  }

  const baselineHashes: ReplayScript['baselineHashes'] = [];
  for (const spec of specs) {
    if (spec.assert !== 'hash_unchanged') continue;
    const value = String(spec.value);
    const absolutePath = path.resolve(scriptDir, value);
    if (!existsSync(absolutePath)) {
      errors.push(`hash_unchanged 目标文件不存在：${value}`);
      continue;
    }
    baselineHashes.push({ specValue: value, absolutePath, sha256: sha256File(absolutePath) });
  }

  if (errors.length > 0) return { errors };
  return {
    errors: [],
    script: {
      scenario,
      sessions,
      ...(configPath === undefined ? {} : { configPath }),
      threshold,
      turns,
      expect: specs,
      evidence,
      baselineHashes,
    },
  };
}

// ── 脚本计划假 driver（确定性模型面；零模型、零网络） ─────────────────────────

interface TurnSink {
  toolcalls: Array<{ driver: 'main' | 'worker'; tool: string; args: unknown }>;
  workerMessages: unknown[][];
}

interface ScriptedController {
  beginTurn(plan: ReplayModelPlan): void;
  createDrivers(): { mainDriver: TurnDriver; workerDriver: TurnDriver };
  sink(): TurnSink;
}

function createScriptedController(): ScriptedController {
  let plan: ReplayModelPlan | undefined;
  let pendingWorkers: ReplayWorkerStep[] = [];
  let sink: TurnSink = { toolcalls: [], workerMessages: [] };

  const mainDriver: TurnDriver = {
    async run(input: TurnDriverInput) {
      const current = plan ?? { reply: '' };
      const messages = [...input.messages];
      for (const step of current.delegate ?? []) {
        const tool = input.tools[0];
        if (tool === undefined) throw new Error('回放假 driver：Main 工具面缺失');
        await input.exec(tool.name, { task: step.request });
      }
      messages.push({ role: 'assistant', content: current.reply } as never);
      return { text: current.reply, messages };
    },
  };
  const workerDriver: TurnDriver = {
    async run(input: TurnDriverInput) {
      const step = pendingWorkers.shift() ?? {};
      if (step.operation !== undefined) {
        const tool = input.tools[0];
        if (tool === undefined) throw new Error('回放假 driver：Worker 工具面缺失');
        await input.exec(tool.name, {
          operation: step.operation,
          ...(step.args === undefined ? {} : { args: step.args }),
        });
      }
      const summary = step.summary ?? '回放汇报（未配置 summary）。';
      const messages = [...input.messages, { role: 'assistant', content: summary } as never];
      return { text: summary, messages };
    },
  };
  const wrap = (inner: TurnDriver, agent: 'main' | 'worker'): TurnDriver => ({
    async run(input: TurnDriverInput) {
      const wrapped: TurnDriverInput = {
        ...input,
        exec: async (tool, args, signal) => {
          sink.toolcalls.push({ driver: agent, tool, args: jsonSafe(args) });
          return input.exec(tool, args, signal);
        },
      };
      const result = await inner.run(wrapped);
      if (agent === 'worker') sink.workerMessages.push(jsonSafe(result.messages) as unknown[]);
      return result;
    },
  });
  return {
    beginTurn(next: ReplayModelPlan) {
      plan = next;
      pendingWorkers = (next.delegate ?? []).map((step) => ({
        ...(step.worker ?? {}),
        ...(step.summary === undefined ? {} : { summary: step.summary }),
      }));
      sink = { toolcalls: [], workerMessages: [] };
    },
    createDrivers() {
      return { mainDriver: wrap(mainDriver, 'main'), workerDriver: wrap(workerDriver, 'worker') };
    },
    sink() {
      return sink;
    },
  };
}

// ── CLI 主流程 ───────────────────────────────────────────────────────────────

export interface ReplayCliInput {
  scriptPath: string;
  traceDir?: string;
  /** 显式配置覆盖（CLI --config；缺省用脚本 config 或仓内 dummy 面）。 */
  configPath?: string;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function safeSlug(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
  return slug === '' ? 'scenario' : slug;
}

function readLinesSafe(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function printHeader(input: ReplayCliInput, script: ReplayScript, traceDir: string | undefined): void {
  input.stdout('===== 回放 =====');
  input.stdout(`scenario=${script.scenario} threshold=${script.threshold} 会话=${script.sessions.length} 回合=${script.turns.length} 断言=${script.expect.length}`);
  if (traceDir !== undefined) input.stdout(`trace=${traceDir}`);
}

function printBlockedFact(input: ReplayCliInput, fact: BlockedFact): void {
  if (fact.kind === 'turn') {
    input.stdout(`[blocked] kind=inject event=${fact.name ?? ''}（回合 ${fact.index ?? '?'}）——${fact.reason}；后续回合未执行（fail-closed）`);
  } else {
    input.stdout(`[blocked] ${fact.kind}=${fact.name ?? ''}——${fact.reason}`);
  }
}

function printResults(input: ReplayCliInput, results: readonly AssertionResult[], blockedFacts: readonly BlockedFact[], exitCode: number): void {
  for (const result of results) {
    const where = `after=${result.after}`;
    if (result.status === 'pass') input.stdout(`[pass] ${where} ${result.assert}：${result.detail}`);
    else if (result.status === 'fail') input.stdout(`[fail] ${where} ${result.assert}：${result.detail}`);
    else input.stdout(`[blocked] ${where} ${result.assert}——${result.detail}`);
  }
  for (const fact of blockedFacts) printBlockedFact(input, fact);
  input.stdout('===== 结果 =====');
  input.stdout(`pass=${results.filter((r) => r.status === 'pass').length} fail=${results.filter((r) => r.status === 'fail').length} blocked=${results.filter((r) => r.status === 'blocked').length + blockedFacts.length} exit=${exitCode}`);
}

export async function runReplayCli(input: ReplayCliInput): Promise<number> {
  const refuse = (message: string): number => {
    input.stderr(`回放脚本拒绝：${message}`);
    return 2;
  };

  let text: string;
  try {
    text = readFileSync(input.scriptPath, 'utf8');
  } catch {
    return refuse(`脚本文件不存在或不可读：${input.scriptPath}`);
  }
  const scriptDir = path.dirname(path.resolve(input.scriptPath));
  const parsed = parseScript(text, scriptDir);
  if (parsed.script === undefined || parsed.errors.length > 0) {
    return refuse(parsed.errors.join('；'));
  }
  const script = parsed.script;

  // 未就绪声明（证据类/threshold）：装配与执行之前 fail-closed 报 blocked。
  const blockedFacts: BlockedFact[] = [];
  for (const name of script.evidence) {
    const reason = BLOCKED_EVIDENCE[name];
    if (reason !== undefined) blockedFacts.push({ kind: 'evidence', name, reason });
  }
  const thresholdReason = BLOCKED_THRESHOLDS[script.threshold];
  if (thresholdReason !== undefined) blockedFacts.push({ kind: 'threshold', name: script.threshold, reason: thresholdReason });
  if (blockedFacts.length > 0) {
    printHeader(input, script, input.traceDir);
    printResults(input, [], blockedFacts, 3);
    return 3;
  }

  const traceDir = input.traceDir === undefined ? undefined : path.resolve(input.traceDir);
  const runRoot = traceDir ?? path.join(REPO_ROOT, '.runtime', 'ask-replay', safeSlug(script.scenario));
  const runtimeDir = path.join(runRoot, 'runtime');
  rmSync(runtimeDir, { recursive: true, force: true });
  if (traceDir === undefined) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(path.join(runtimeDir, 'config'), { recursive: true });
  mkdirSync(path.join(runtimeDir, 'db'), { recursive: true });
  const configTarget = path.join(runtimeDir, 'config', 'agent-config.yaml');
  const explicitConfig = input.configPath ?? script.configPath;
  try {
    materializeEvalConfig(explicitConfig ?? FIXTURE_CONFIG, configTarget);
  } catch (error) {
    return refuse(`配置物化失败：${messageOf(error)}`);
  }

  let env: NodeJS.ProcessEnv;
  let profile: ContextProfileConfig;
  try {
    const config = loadConfig({ yamlPath: configTarget, env: input.env });
    env = effectiveDeploymentEnv(config, input.env);
    const profileIds = Object.keys(config.contextProfiles);
    if (profileIds.length !== 1) {
      return refuse(`配置需要单一 contextProfile（当前 ${profileIds.length} 个）——回放不做多 profile 选择`);
    }
    const selected = config.contextProfiles[profileIds[0]!]!;
    if (!selected.gateway) return refuse('profile 缺少 gateway——回放需要执行层挂载声明');
    profile = selected;
  } catch (error) {
    return refuse(`配置加载失败：${messageOf(error)}`);
  }

  const dbPath = path.join(runtimeDir, 'db', 'state.db');
  const stateDir = path.join(runtimeDir, 'state');
  const auditPath = path.join(stateDir, 'audit.jsonl');
  const controller = createScriptedController();
  const assembledSessions: AssembledSession[] = [];
  const sessionsByName = new Map<string, Session>();
  let sharedRegistry: TaskRegistry | undefined;
  try {
    for (const spec of script.sessions) {
      const assembled = await assembleSessionCore({
        env,
        profile,
        principalId: spec.principal,
        sessionId: spec.session,
        dbPath,
        stateDir,
        setAuditPath: true,
        assertIsolation: () => assertEvalIsolation(assessEvalIsolation({
          env,
          platformRoot: profile.root,
          gateway: profile.gateway!,
        }), `回放 ${script.scenario}`),
        emptyOperationsMessage: '执行层没有声明任何只读 operation——回放拒绝以空允许集合运行。',
        emptyOperationsError: (message) => new AssemblyRefusedError(message),
        createDrivers: () => controller.createDrivers(),
        ...(sharedRegistry === undefined ? {} : { taskRegistry: sharedRegistry }),
      });
      sharedRegistry ??= assembled.taskRegistry;
      assembledSessions.push(assembled);
      sessionsByName.set(spec.name, assembled.session);
    }
  } catch (error) {
    for (const assembled of assembledSessions) assembled.close();
    if (error instanceof AssemblyRefusedError || error instanceof EvalIsolationRefused) return refuse(error.message);
    return refuse(`装配失败：${messageOf(error)}`);
  }
  const registry = sharedRegistry!;

  try {
    printHeader(input, script, traceDir);
    const replies: string[] = [''];
    const messages: string[] = [''];
    const auditByTurn: string[][] = [[]];
    const results: AssertionResult[] = [];
    const turnRecords: TraceTurnRecord[] = [];
    const previousTranscriptLength = new Map<string, number>();
    const evaluated = new Set<number>();
    let blockedAt: number | undefined;
    let runError = false;

    const factsFor = (): AssertionFacts => ({
      replies,
      messages,
      auditLinesByTurn: auditByTurn,
      tasks: [...registry.list()],
      hashBaselines: Object.fromEntries(script.baselineHashes.map((item) => [item.specValue, item.sha256])),
      hashNow: (target: string) => sha256File(path.resolve(scriptDir, target)),
    });
    const evaluateAt = (point: number | 'all'): void => {
      script.expect.forEach((spec, index) => {
        if (evaluated.has(index) || spec.after !== point) return;
        results.push(evaluateAssertion(spec, factsFor(), index));
        evaluated.add(index);
      });
    };

    for (let i = 0; i < script.turns.length; i += 1) {
      const index = i + 1;
      const turn = script.turns[i]!;
      if (turn.kind === 'inject') {
        const fact: BlockedFact = { kind: 'turn', index, name: turn.event, reason: BLOCKED_EVENTS[turn.event]! };
        blockedFacts.push(fact);
        input.stdout(`===== 回合 ${index}（注入） =====`);
        printBlockedFact(input, fact);
        blockedAt = index;
        break;
      }
      const session = sessionsByName.get(turn.session)!;
      controller.beginTurn(turn.model);
      const auditBefore = readLinesSafe(auditPath).length;
      input.stdout(`===== 回合 ${index} =====`);
      let reply = '';
      let taskIds: readonly string[] = [];
      let executions: readonly ExecutionRecord[] = [];
      try {
        const result = await session.send(turn.text);
        reply = result.reply;
        taskIds = result.taskIds;
        executions = result.executions;
      } catch (error) {
        runError = true;
        input.stdout(`[失败] 回合执行异常：${messageOf(error)}`);
      }
      const auditDelta = readLinesSafe(auditPath).slice(auditBefore);
      replies[index] = reply;
      messages[index] = turn.text;
      auditByTurn[index] = auditDelta;
      const transcript = [...session.transcript()];
      const previousLength = previousTranscriptLength.get(turn.session) ?? 0;
      const mainDelta = transcript.slice(previousLength);
      previousTranscriptLength.set(turn.session, transcript.length);
      turnRecords.push({
        index,
        session: turn.session,
        kind: 'message',
        text: turn.text,
        reply,
        taskIds: [...taskIds],
        executionCount: executions.length,
        auditLines: auditDelta,
        mainMessages: mainDelta,
        workerMessages: controller.sink().workerMessages,
        toolcalls: controller.sink().toolcalls,
      });
      input.stdout(`[回复] ${reply}`);
      input.stdout(`[机械证据] 委派=${taskIds.length} 执行=${executions.length}（完成 ${executions.filter((execution) => execution.status === 'completed').length}）审计=${auditDelta.length} 行`);
      evaluateAt(index);
    }

    if (blockedAt === undefined) {
      evaluateAt('all');
    } else {
      script.expect.forEach((spec, index) => {
        if (evaluated.has(index)) return;
        results.push({
          index,
          after: spec.after,
          assert: spec.assert,
          status: 'blocked',
          detail: '未执行到断言时点（上游注入 blocked，fail-closed 不判定）',
        });
        evaluated.add(index);
      });
    }

    if (traceDir !== undefined) {
      const recorder = createTraceRecorder({
        dir: traceDir,
        mode: 'script',
        principalId: '(multi-session)',
        sessionId: '(multi-session)',
        sessions: script.sessions,
        scriptPath: path.resolve(input.scriptPath),
        scriptSha256: sha256Hex(text),
        configPath: configTarget,
        dbPath,
      });
      for (const record of turnRecords) recorder.recordTurn(record);
      recorder.finish({
        scenario: script.scenario,
        threshold: script.threshold,
        assertions: results,
        blocked: blockedFacts,
        finalTasks: [...registry.list()],
      });
    }

    const failCount = results.filter((result) => result.status === 'fail').length;
    const blockedCount = results.filter((result) => result.status === 'blocked').length;
    const exitCode = failCount > 0
      ? 1
      : (blockedCount > 0 || blockedFacts.length > 0 ? 3 : (runError ? 1 : 0));
    printResults(input, results, blockedFacts, exitCode);
    return exitCode;
  } finally {
    for (const assembled of assembledSessions) assembled.close();
  }
}
