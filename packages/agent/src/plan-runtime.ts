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

/**
 * 剥掉模型给命令加的"包装"再交协议解析：markdown 代码围栏、外层成对引号。
 *
 * 为什么宿主侧必须兼容：计划 JSON 是机器解析的协议，而围栏/引号是模型的格式习惯、
 * 不是内容。真实平台 12 步计划实测里，worker 把 `bin/17dz plan {…}` 用 ```json 围栏
 * 包起来（甚至多行美化），协议正则只认行首裸命令 → 解析落空 → 控制流掉进 serve-gate
 * 的 plan 拒绝分支，每一步都空转。格式习惯会波动，宿主不能指望模型永远守规矩，
 * 因此在协议解析前确定性剥包装。
 *
 * 边界：剥包装只改包装、不放宽任何协议语义——剥完仍走原正则与原 calls 结构校验，
 * JSON 残缺/结构非法一律维持现有 throw；剥不动（围栏未闭合、引号不成对）原样返回，
 * 由调用方维持现有解析失败行为。
 */
function stripCommandWrapping(command: string): string {
  let text = command.trim();
  // 模型可能套两层（围栏里再裹引号）：每轮只剥一层最外包装，不再变化即收敛
  for (let round = 0; round < 4; round += 1) {
    const before = text;
    const fence = text.match(/^```[^\n`]*\n?([\s\S]*?)\n?```$/);
    if (fence) text = fence[1]!.trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
      text = text.slice(1, -1).trim();
    }
    if (text === before) break;
  }
  return text;
}

/** 计划管理子命令：worker 不得直达，只由宿主调用。 */
const PLAN_SUBCOMMANDS = ['evaluate', 'activate', 'current', 'status'];

/**
 * 计划命令形状不符时的诊断：说清检测到的形状问题 + 正确形状。
 * 只描述"怎么提交"这一件机械事实，不猜业务、不放宽协议。
 */
function describePlanShapeProblem(command: string): string {
  const problems: string[] = [];
  if (command.includes('```')) problems.push('markdown 代码围栏');
  if (/^\s*["']/.test(command)) problems.push('外层引号');
  if (/\n/.test(command)) problems.push('拆成了多行');
  // 命令不是以 bin/17dz plan 开头却含着它：前后加了别的内容（"请提交这个计划：…谢谢"）
  if (!/^\s*(?:(?:bash|sh)\s+)?(?:[^\s]+\/)?bin\/17dz\s+plan(?:\s|$)/.test(command)) problems.push('前后有多余内容');
  const detail = problems.length > 0 ? `（检测到：${problems.join('、')}）` : '';
  return `命令里有 bin/17dz plan 但不符合提交形状${detail}。方案必须作为 bash 工具的单行原始命令提交：bin/17dz plan {"goal":"…","calls":[…]}，JSON 原样放在这一行里，前后不要加别的内容。`;
}

/** Parse the worker's intercepted `bin/17dz plan { ... }` JSON command. */
export function parsePlanCallsCommand(command: string): { calls: PlanCall[]; userConfirmed?: boolean } | null {
  // 先剥模型包装（代码围栏/外层引号）再按原协议解析：JSON 允许多行，现有正则的
  // `[\s\S]+` 本就接得住多行 body，这里只是让围栏版命令能走到它面前。
  const normalized = stripCommandWrapping(command.trim());
  const match = normalized.match(/^(?:(?:bash|sh)\s+)?(?:[^\s]+\/)?bin\/17dz\s+plan(?:\s+([\s\S]+))?$/);
  if (!match) {
    // 三态分辨，不能一律返回 null：
    //   ① 没有 plan 令牌 → 真不是计划命令（null，交 serve-gate 的常规 CLI 检查）；
    //   ② 有令牌却匹配不上协议形状 → 这是解析错误，必须响亮抛出。
    // 此前②也返回 null，控制流落进 serve-gate 的 plan 拒绝分支，门的理由是
    // "计划管理命令由宿主控制"——用权限话术答复格式问题，worker 收到的答非所问，
    // 无从自愈（真实平台实测：被误导到把方案 JSON 打印成助手文本，12 步全空转）。
    // throw 在 beforeToolCall 里变成 PLAN DECLINED：<可行动消息>——正确的诊断
    // 本身就是自愈通道：说清形状哪里不对、正确形状长什么样，worker 下一轮就能改。
    if (/(?:^|[\s:：，,。.、；;！!？?])(?:[^\s]+\/)?bin\/17dz\s+plan(?:\s|$)/.test(normalized)) {
      throw new Error(describePlanShapeProblem(normalized));
    }
    return null;
  }
  const body = match[1] ?? '';
  const subcommand = body.trim().split(/\s+/)[0] ?? '';
  if (PLAN_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(`plan ${subcommand} 由宿主调用，worker 不得直接调用 evaluate/activate；只提交 JSON calls 方案——单行原始命令：bin/17dz plan {"goal":"…","calls":[…]}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch (error) {
    // JSON 坏了要说 JSON 哪坏了：带解析器原文（截断）+ 正确形状。旧消息只说
    // "不得直接调用 evaluate/activate"——那是隔壁问题的答案，答非所问。
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 120);
    throw new Error(`计划 JSON 解析失败：${reason}。方案是单行原始命令：bin/17dz plan {"goal":"…","calls":[…]}，JSON 原样放进行命，不要代码块/引号/多行拆分。`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('计划 JSON 顶层必须是对象。');
  const value = parsed as Record<string, unknown>;
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
