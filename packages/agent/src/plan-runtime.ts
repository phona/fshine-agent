import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { errorFor } from './error-codes';

export interface PlanCall {
  operation: string;
  /** Operation-specific JSON args. fshine validates JSON shape and forwards unchanged. */
  args: unknown[];
}

export interface PlanEvaluation {
  planId: string;
  version: number;
  decision: 'execute' | 'notify' | 'confirm' | 'stop';
  estimate: { calls: number; seconds: number };
  delta: { calls?: unknown[]; [key: string]: unknown };
  cumulative: Record<string, unknown>;
  reasonCode: string;
  status: string;
  /** Safe user-facing scope summary supplied by the platform. */
  summary?: string;
  noticeText?: string;
  scopeSummary?: string;
}

export interface PlanCliRequest {
  platformRoot: string;
  args: string[];
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export type PlanCliRunner = (request: PlanCliRequest) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface PendingPlanConfirmation {
  planId: string;
  version: number;
  taskId: string;
  principalId?: string;
  sessionId?: string;
  requestId?: string;
  decision: 'confirm';
  userText: string;
  evaluation: PlanEvaluation;
}

export type PlanRuntimeResult =
  | { status: 'active'; planId: string; version: number; evaluation: PlanEvaluation }
  | { status: 'confirm'; pending: PendingPlanConfirmation; message: string }
  | { status: 'stop'; evaluation: PlanEvaluation; message: string };

export interface EvaluateAndActivatePlanOptions {
  platformRoot: string;
  taskId: string;
  calls: readonly PlanCall[];
  requestId?: string;
  onNotice?: (message: string) => Promise<void>;
  /** Model claims are intentionally ignored. A host confirmation needs a distinct host-only call. */
  userConfirmed?: boolean;
  runCli?: PlanCliRunner;
  env?: NodeJS.ProcessEnv;
  activationSecret?: string;
}

export async function loadCurrentActivePlan(options: {
  platformRoot: string;
  taskId: string;
  runCli?: PlanCliRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<{ planId: string; version: number } | null> {
  const current = await runJson<{ taskId: string; planId: string | null; version: number | null; status: string }>(
    options.runCli ?? defaultCliRunner,
    { platformRoot: options.platformRoot, args: ['plan', 'current', '--task-id', options.taskId], env: options.env },
  );
  if (current.taskId !== options.taskId || current.status !== 'active' || typeof current.planId !== 'string' || !current.planId) return null;
  return { planId: current.planId, version: typeof current.version === 'number' ? current.version : 0 };
}

/** Current platform-side status of one specific plan, used to detect stale confirmations. */
export async function loadPlanStatus(options: {
  platformRoot: string;
  planId: string;
  runCli?: PlanCliRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<{ planId: string; version: number | null; status: string } | null> {
  const result = await runJson<{ planId: string; version: number | null; status: string }>(
    options.runCli ?? defaultCliRunner,
    { platformRoot: options.platformRoot, args: ['plan', 'status', '--plan-id', options.planId], env: options.env },
  );
  return result && typeof result.status === 'string' ? result : null;
}

const defaultCliRunner: PlanCliRunner = ({ platformRoot, args, input, env }) => new Promise((resolve, reject) => {
  const child = spawn(path.join(platformRoot, 'bin', '17dz'), args, {
    cwd: platformRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
  child.stdin.end(input);
});

export async function evaluateAndActivatePlan(options: EvaluateAndActivatePlanOptions): Promise<PlanRuntimeResult> {
  const runCli = options.runCli ?? defaultCliRunner;
  validateCalls(options.calls);
  const evaluation = await runJson<PlanEvaluation>(runCli, {
    platformRoot: options.platformRoot,
    args: ['plan', 'evaluate', '--task-id', options.taskId, '--stdin'],
    input: JSON.stringify({ calls: options.calls, ...(options.requestId ? { requestId: options.requestId } : {}) }),
    env: options.env,
  });

  if (evaluation.decision === 'stop') {
    return { status: 'stop', evaluation, message: formatPlanMessage(evaluation) };
  }
  if (evaluation.decision === 'confirm') {
    const message = formatPlanMessage(evaluation);
    if (!options.onNotice) throw new Error('本次计划需要用户确认，但 trusted.onNotice 未配置；已暂停执行。');
    await options.onNotice(message);
    return {
      status: 'confirm',
      message,
      pending: {
        planId: evaluation.planId,
        version: evaluation.version,
        taskId: options.taskId,
        decision: 'confirm',
        userText: message,
        evaluation,
      },
    };
  }
  if (evaluation.decision === 'notify') {
    const message = formatPlanMessage(evaluation);
    if (!options.onNotice) throw new Error('本次计划需要通知用户，但 trusted.onNotice 未配置；已暂停执行。');
    // Notification delivery is part of activation authorization: never activate before it resolves.
    await options.onNotice(message);
    await activatePendingPlan({
      platformRoot: options.platformRoot,
      planId: evaluation.planId,
      evidence: 'notification-delivered',
      runCli,
      env: options.env,
      activationSecret: options.activationSecret,
    });
  }
  return { status: 'active', planId: evaluation.planId, version: evaluation.version, evaluation };
}

/** Host-only helper. Never expose this to the worker tool or pass the secret into worker env. */
export async function activatePendingPlan(options: {
  platformRoot: string;
  planId: string;
  evidence: 'notification-delivered' | 'user-confirmed';
  runCli?: PlanCliRunner;
  env?: NodeJS.ProcessEnv;
  activationSecret?: string;
  now?: number;
}): Promise<unknown> {
  const secret = options.activationSecret;
  if (!secret) throw new Error('缺少宿主计划激活密钥 DZ_PLAN_ACTIVATION_SECRET。');
  const expires = (options.now ?? Date.now()) + 60_000;
  const token = createActivationToken(options.planId, options.evidence, expires, secret);
  return runJson((options.runCli ?? defaultCliRunner), {
    platformRoot: options.platformRoot,
    args: ['plan', 'activate', '--stdin'],
    input: JSON.stringify({ planId: options.planId, evidence: options.evidence, token }),
    env: { ...options.env, DZ_PLAN_ACTIVATION_SECRET: secret },
  });
}

export function createActivationToken(
  planId: string,
  evidence: 'notification-delivered' | 'user-confirmed',
  expires: number,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify({ planId, evidence, expires }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
  return `${body}.${signature}`;
}

/**
 * 计划门通知的固定前缀：让用户在企微里能把"系统通知"和普通进度区分开，
 * 也让宿主/测试能稳定识别这条帧（渠道适配器与 e2e 替身都按它过滤）。
 */
export const PLAN_NOTICE_PREFIX = '计划通知：';

export function formatPlanMessage(evaluation: PlanEvaluation): string {  const minutes = Math.round((evaluation.estimate.seconds / 60) * 10) / 10;
  const addedCalls = typeof evaluation.delta.addedCalls === 'number' ? evaluation.delta.addedCalls : evaluation.estimate.calls;
  const platformSummary = evaluation.noticeText ?? evaluation.summary ?? evaluation.scopeSummary;
  const scope = platformSummary
    ? `${sanitizeSummary(platformSummary)} `
    : `本次需新增 ${addedCalls} 次查询，预计约 ${minutes} 分钟。`;
  const confirm = evaluation.decision === 'confirm' ? '请回复“确认继续”后再执行；当前已暂停。' : '通知送达后将继续执行。';
  // 前缀让用户在企微里能把"系统通知"和普通进度区分开，也让宿主/测试能稳定识别这条帧。
  return `${PLAN_NOTICE_PREFIX}${scope}${confirm}`;
}

export function validateCalls(calls: readonly PlanCall[]): void {
  if (!Array.isArray(calls) || calls.length === 0) throw errorFor('PLAN_CALLS_EMPTY');
  for (const [index, call] of calls.entries()) {
    if (!call || typeof call.operation !== 'string' || !call.operation.trim()) {
      throw errorFor('PLAN_CALL_OPERATION_EMPTY', index);
    }
    if (!Array.isArray(call.args)) throw errorFor('PLAN_CALL_ARGS_NOT_ARRAY', index);
    try { JSON.stringify(call.args); } catch { throw errorFor('PLAN_CALL_ARGS_NOT_JSON', index); }
  }
}

/** Build the per-command environment for a worker bash subprocess. */
export function createPlanScopedWorkerEnv(inherited: NodeJS.ProcessEnv, activePlanId: string | null): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.DZ_PLAN_ACTIVATION_SECRET;
  delete env.DZ_PLAN_ID;
  env.DZ_REQUIRE_PLAN = '1';
  if (activePlanId) env.DZ_PLAN_ID = activePlanId;
  return env;
}

/** 计划管理子命令：worker 不得直达，只由宿主调用。 */
const PLAN_SUBCOMMANDS = ['evaluate', 'activate', 'current', 'status'];

/** `bin/17dz plan` 之前允许出现的内容：空 / bash|sh / 路径前缀，以及 bash|sh + 路径前缀。 */
const ALLOWED_PLAN_PREFIX_RE = /^(?:(?:bash|sh)\s+)?(?:[^\s]+\/)?$/;

/** 报错里回显"多出来的内容"时的截断长度：够模型认出自己加了什么，又不把消息撑爆。 */
const EXTRA_PREFIX_MAX_CHARS = 120;

/**
 * 在命令里结构定位 `bin/17dz plan` 令牌：返回 bin/17dz 之前的原始前缀与 plan 之后的 payload。
 * 找不到该令牌返回 null（真不是计划命令）。
 *
 * 为什么用定位而不是一条大正则 + 症状嗅探：宿主只保证两件事——错误永远诚实可行动、
 * 爆炸永远有界。格式波动（markdown 围栏、外层引号、前后加客套话、多行拆分）是模型的
 * 习惯，不是内容；替它猜"这其实是同一个命令"就是在建容忍层，而猜错的代价是模型收到
 * 一句答非所问的话，于是它开始瞎试（真实平台实测：被误导到把方案 JSON 打印成助手文本，
 * 12 步全空转）。因此这里只做确定性定位：令牌在哪、前面剩什么、后面剩什么——剩下的
 * 一律算形状不符，抛一条说清"期望什么、实际什么"的结构错误，让模型下一轮自己改。
 * 重试是模型的职责，宿主不替它 absorbing。
 */
function locatePlanSubmission(command: string): { prefix: string; payload: string } | null {
  let from = 0;
  for (;;) {
    const at = command.indexOf('bin/17dz', from);
    if (at < 0) return null;
    from = at + 'bin/17dz'.length;
    // 该 bin/17dz 必须紧跟 plan 子命令（空白分隔，且 plan 自身是一个完整令牌）才算计划提交；
    // 否则只是别处提到了 bin/17dz（如 bin/17dz query），继续找下一个位置。
    const plan = /^\s+plan(?=\s|$)/.exec(command.slice(from));
    if (!plan) continue;
    return { prefix: command.slice(0, at), payload: command.slice(from + plan[0].length).trim() };
  }
}

/** 把"多出来的内容"压成一行可读文本：折叠空白 + 截断。 */
function collapseExtra(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, EXTRA_PREFIX_MAX_CHARS);
}

/** Parse the worker's intercepted `bin/17dz plan { ... }` JSON command. */
export function parsePlanCallsCommand(command: string): { calls: PlanCall[]; userConfirmed?: boolean } | null {
  const trimmed = command.trim();
  // 三态分辨，不能一律返回 null：
  //   ① 没有 plan 令牌 → 真不是计划命令（null，交 serve-gate 的常规 CLI 检查）；
  //   ② 有令牌但形状不符 → 这是解析错误，必须响亮抛出。
  // 此前②也返回 null，控制流落进 serve-gate 的 plan 拒绝分支，门的理由是
  // "计划管理命令由宿主控制"——用权限话术答复格式问题，worker 收到的答非所问，
  // 无从自愈（真实平台实测：被误导到把方案 JSON 打印成助手文本，12 步全空转）。
  // throw 在 beforeToolCall 里变成 PLAN DECLINED：<可行动消息>——正确的诊断
  // 本身就是自愈通道：说清形状哪里不对、正确形状长什么样，worker 下一轮就能改。
  const located = locatePlanSubmission(trimmed);
  if (!located) return null;
  const { prefix, payload } = located;

  // 前缀只允许 bash/sh 与路径前缀。围栏、外层引号、"请提交这个计划：…谢谢"这类包装
  // 一律不算合法前缀——宿主不 absorbing 格式波动，直接说清前面多了什么。
  if (!ALLOWED_PLAN_PREFIX_RE.test(prefix)) {
    throw errorFor('PLAN_SHAPE_PREFIX', collapseExtra(prefix));
  }
  if (!payload) {
    throw errorFor('PLAN_SHAPE_PAYLOAD');
  }
  const subcommand = payload.split(/\s+/)[0] ?? '';
  if (PLAN_SUBCOMMANDS.includes(subcommand)) {
    throw errorFor('PLAN_SUBCOMMAND_RESERVED', subcommand);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(payload); }
  catch (error) {
    // JSON 坏了要说 JSON 哪坏了：带解析器原文（截断）+ 正确形状。
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120);
    throw errorFor('PLAN_JSON_PARSE', reason);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw errorFor('PLAN_JSON_NOT_OBJECT');
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.calls)) throw errorFor('PLAN_CALLS_NOT_ARRAY');
  const calls = value.calls.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errorFor('PLAN_CALL_NOT_OBJECT', index);
    const call = raw as Record<string, unknown>;
    if (typeof call.operation !== 'string' || !('args' in call)) throw errorFor('PLAN_CALL_FIELDS', index);
    if (!Array.isArray(call.args)) throw errorFor('PLAN_CALL_ARGS_NOT_ARRAY', index);
    return { operation: call.operation, args: call.args };
  });
  validateCalls(calls);
  // Preserve the field for audit only. The runtime never treats this model claim as authorization.
  return { calls, ...(value.user_confirmed === true ? { userConfirmed: true } : {}) };
}

function sanitizeSummary(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function runJson<T = unknown>(runCli: PlanCliRunner, request: PlanCliRequest): Promise<T> {
  const result = await runCli(request);
  if (result.code !== 0) throw new Error(`17dz plan CLI 失败（${request.args.slice(0, 2).join(' ')}）：${result.stderr.trim() || `exit ${result.code}`}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error('17dz plan CLI 返回了无效 JSON。'); }
}
