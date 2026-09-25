import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

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

export function formatPlanMessage(evaluation: PlanEvaluation): string {
  const minutes = Math.round((evaluation.estimate.seconds / 60) * 10) / 10;
  const addedCalls = typeof evaluation.delta.addedCalls === 'number' ? evaluation.delta.addedCalls : evaluation.estimate.calls;
  const platformSummary = evaluation.noticeText ?? evaluation.summary ?? evaluation.scopeSummary;
  const scope = platformSummary
    ? `${sanitizeSummary(platformSummary)} `
    : `本次需新增 ${addedCalls} 次查询，预计约 ${minutes} 分钟。`;
  const confirm = evaluation.decision === 'confirm' ? '请回复“确认继续”后再执行；当前已暂停。' : '通知送达后将继续执行。';
  // 前缀让用户在企微里能把"系统通知"和普通进度区分开，也让宿主/测试能稳定识别这条帧。
  return `计划通知：${scope}${confirm}`;
}

export function validateCalls(calls: readonly PlanCall[]): void {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error('计划 calls 必须至少包含一个操作。');
  for (const [index, call] of calls.entries()) {
    if (!call || typeof call.operation !== 'string' || !call.operation.trim()) {
      throw new Error(`计划 calls[${index}].operation 必须是非空字符串。`);
    }
    if (!Array.isArray(call.args)) throw new Error(`计划 calls[${index}].args 必须是数组。`);
    try { JSON.stringify(call.args); } catch { throw new Error(`计划 calls[${index}].args 必须是 JSON 值。`); }
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

/** Parse the worker's intercepted `bin/17dz plan { ... }` JSON command. */
export function parsePlanCallsCommand(command: string): { calls: PlanCall[]; userConfirmed?: boolean } | null {
  const match = command.trim().match(/^(?:(?:bash|sh)\s+)?(?:[^\s]+\/)?bin\/17dz\s+plan(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  let body: unknown;
  try { body = JSON.parse(match[1] ?? ''); } catch { throw new Error('plan 命令只接受由宿主截获的 JSON calls 方案；不得直接调用 evaluate/activate。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('计划 JSON 顶层必须是对象。');
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.calls)) throw new Error('计划必须声明精确 calls 数组。');
  const calls = value.calls.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`计划 calls[${index}] 必须是对象。`);
    const call = raw as Record<string, unknown>;
    if (typeof call.operation !== 'string' || !('args' in call)) throw new Error(`计划 calls[${index}] 必须包含 operation 和 args。`);
    if (!Array.isArray(call.args)) throw new Error(`计划 calls[${index}].args 必须是数组。`);
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
