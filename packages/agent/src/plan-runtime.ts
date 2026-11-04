import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { decideBudgetTier } from './budget-policy';
import { errorFor } from './error-codes';
import { isWriteAccess, operationLabel, type OperationArgsSpecs, type OperationLabels, type OperationSemantics } from './operation-labels';
import { gatewayTextPatterns, resolveGatewayText } from './platform-contract';

export interface PlanCall {
  operation: string;
  /** Operation-specific JSON args. fshine validates JSON shape and forwards unchanged. */
  args: unknown[];
}

/**
 * worker 一次计划提交的两种形态：
 *   · `inline`——现状：`<gateway> plan {…}` 单行裸 JSON；
 *   · `file`——`<gateway> plan --file <工作区路径>`，宿主读文件后走同一份校验。
 *
 * 为什么需要 file 通道（2026-10-23 实测）：worker 无法稳定一次写对裸 JSON——
 * 本能给 JSON 加 shell 引号、命令尾部跟 `2>&1` / `; echo`，而宿主解析的是原始
 * 命令字符串，引号与尾巴原样进 JSON.parse。req_368b68b3 因此 11 连撞空转
 * 4 分 11 秒 / 657k tokens，最后靠黑盒探针才摸到规则。而"宿主 absorbing 格式
 * 波动"是被事故否决的路（见 locatePlanSubmission 注释：absorbing 曾把模型误导
 * 成把方案 JSON 打印成助手文本，12 步全空转）。给一条不经过命令行的精确通道，
 * 模型才能用本地 lint 廉价迭代，而不是拿门当校验器黑盒试探。
 */
export type PlanSubmission =
  | { kind: 'inline'; calls: PlanCall[]; userConfirmed?: boolean }
  | { kind: 'file'; path: string };

export interface PlanEvaluation {
  planId: string;
  version: number;
  decision: 'execute' | 'notify' | 'confirm' | 'stop';
  /** 本张计划的声明总权重（接口文档 §4 必填；缺失/非法时宿主 fail-closed，不激活）。 */
  estimate: { calls: number; seconds: number; weight?: number };
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
  /** Profile 声明的网关调用形式；未声明时默认 runner 回退遗留常量（过渡期）。 */
  gateway?: string;
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
  /** Profile 声明的网关调用形式，透传给默认 runner（注入 runner 时由 runner 自行决定）。 */
  gateway?: string;
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

const defaultCliRunner: PlanCliRunner = ({ platformRoot, args, input, env, gateway }) => new Promise((resolve, reject) => {
  // 第二处硬编码网关 spawn：与 context 提案网关同理，profile.gateway 优先，
  // 未声明时回退旧值。调用方在 plan-runtime 外注入 runner 时应把 profile.gateway
  // 带进 PlanCliRequest.gateway；直接调 evaluateAndActivatePlan 的调用方见
  // EvaluateAndActivatePlanOptions.gateway。
  const child = spawn(gateway ? path.join(platformRoot, ...gateway.split('/')) : path.join(platformRoot, 'bin', '17dz'), args, {
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
  const rawEvaluation = await runPlanEvaluation(runCli, {
    platformRoot: options.platformRoot,
    args: ['plan', 'evaluate', '--task-id', options.taskId, '--stdin'],
    input: JSON.stringify({ calls: options.calls, ...(options.requestId ? { requestId: options.requestId } : {}) }),
    env: options.env,
    ...(options.gateway ? { gateway: options.gateway } : {}),
  });
  // 预算接入（接口文档 §4）：平台已下发 estimate.weight 时，宿主用通用策略
  // 算出宿主档，与平台 decision 取更严一档；平台档始终保留作防线，宿主档
  // 只做叠加，绝不放宽。注意不对称性：宿主这里只看本张计划的 weight，
  // 平台 decision 已计入任务累计 weight——更严为准保证宿主叠加只收紧不放松。
  // weight 缺失/非有限数/为负 → fail-closed：不激活、不降级为仅 calls/seconds 裁档。
  const weight = rawEvaluation.estimate.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
    throw new Error('plan evaluate 未下发合法 weight：宿主预算叠加无法裁档，已拒绝激活（接口文档 §4）。');
  }
  const host = decideBudgetTier({ calls: rawEvaluation.estimate.calls, seconds: rawEvaluation.estimate.seconds, weight });
  const RANK: Record<string, number> = { execute: 0, notify: 1, confirm: 2, stop: 3 };
  const evaluation = RANK[host.tier] > RANK[rawEvaluation.decision]
    ? { ...rawEvaluation, decision: host.tier, reasonCode: host.reasonCode }
    : rawEvaluation;

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
      ...(options.gateway ? { gateway: options.gateway } : {}),
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
  gateway?: string;
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
    ...(options.gateway ? { gateway: options.gateway } : {}),
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

/**
 * 平台 args 规格里我们机械提取的两个声明名（D-065）：accountSet/period。
 *
 * 为什么是这两个：召回事实要回答"本会话迄今对哪个对象、哪个时间窗执行过什么"——这两个
 * 是平台自己在 args 规格里声明的参数名（voucher.query-saved 的位置参数、finance 的
 * --period），取它们是查表不是猜。flag 的声明名按平台自己的 kebab→camel 归一推导
 * （--period → period；平台 flag-guard 同一套归一），--query 推导出的 query **不是**
 * accountSet（那是检索关键词，不一定等于规范名）——宁缺勿猜。
 */
const STRUCTURED_ARG_NAMES: ReadonlySet<string> = new Set(['accountSet', 'period']);

/** flag → 声明名（平台 kebab→camel 归一：--subject-code → subjectCode）。 */
function flagArgName(flag: string): string {
  return flag.replace(/^--/, '').replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** 单个取值的卫生：剥引号、截断（结构化事实是短字段，不是长文）。 */
function cleanArgValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/^["']+|["']+$/g, '').trim().slice(0, 40);
  return text || undefined;
}

/**
 * 从计划调用机械提取结构化事实（D-065）：accountSet / period / 首个 operation 的中文标签。
 *
 * 全部是**宿主可见的机械事实**：calls 是宿主自己从 worker 提交的计划命令解析出来的，
 * 取值按平台 args 规格的声明名逐位对应（位置参数按序、flag 按 kebab→camel 声明名），
 * label 是平台清单第 5 列。**绝不从 worker 文本解析**——转录里"提过"不等于"执行过"，
 * 模糊匹配正是 execution-facts 要替代的东西。规格缺失 / 声明名对不上 → 该字段不出项
 * （宁缺勿猜），调用方据此降级渲染。
 */
export function planCallFacts(
  calls: readonly PlanCall[],
  specs: OperationArgsSpecs | undefined,
  labels: OperationLabels | undefined,
): { accountSet?: string; period?: string; label?: string } {
  const facts: { accountSet?: string; period?: string; label?: string } = {};
  for (const call of calls) {
    const spec = specs?.get(call.operation);
    const args = call.args.map((value) => (typeof value === 'string' ? value : String(value)));
    const declared: Array<{ name: string; value: string }> = [];
    let positionalIndex = 0;
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (token.startsWith('--')) {
        const name = flagArgName(token);
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          declared.push({ name, value: next });
          index += 1;
        }
        continue;
      }
      // 位置参数按序对应规格的 positionalNames（第几个位置参数就是第几个声明名）
      declared.push({ name: spec?.positionalNames[positionalIndex] ?? '', value: token });
      positionalIndex += 1;
    }
    for (const { name, value } of declared) {
      if (!STRUCTURED_ARG_NAMES.has(name)) continue;
      const cleaned = cleanArgValue(value);
      if (!cleaned) continue;
      if (name === 'accountSet' && !facts.accountSet) facts.accountSet = cleaned;
      if (name === 'period' && !facts.period) facts.period = cleaned;
    }
  }
  const label = operationLabel(labels, calls[0]?.operation);
  if (label) facts.label = label;
  return facts;
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

/**
 * 写关闭判据（D-075）：计划里出现写类 operation，而平台侧声明本部署写未开放。
 *
 * 为什么必须是机械判据（而不是等模型走到提案步）：2026-09-29 真实平台 T7 事故——用户
 * 发起录入请求，模型走了完整的"录入准备"流程（行为优秀），然后停在准备阶段，承诺"即可
 * 产出录入提案"却永不抵达提案步。WRITE_NOT_ENABLED 原先只挂在提案路径的 capability
 * 检查（context.ts 的 createProposalViaGateway）与平台计划门拒绝上，模型不走到那儿，用户就永远
 * 不知道写权限是关闭的。计划成形时（宿主已机械解析出 calls 的 operation 名）就能判：
 * 这份计划注定跑不完，因为部署没开放写。
 *
 * 三个输入全是宿主/平台已有的确定性材料，没有一个字节从 worker 文本解析：
 *   · calls：宿主自己从计划命令解析出来的（parsePlanCallsCommand）；
 *   · semantics：平台 `operation list --json` 的 access 语义表（operation-labels 派生，
 *     判据是平台声明的 confirm 列——要不要用户确认）；
 *   · writeEnabled：平台侧的写开放声明（部署层经 isCommitEnabled() 从平台状态派生，
 *     变更项 ⑧——不再是委托主体自持的能力布尔）。缺省（false）视为只读。
 *
 * 宁缺勿猜：语义表缺失（CLI 派生失败 / 平台还没下发 accessSemantics）或 operation 查不到
 * 语义时，该 operation 不算写类——不触发布防，平台计划门与提案路径的既有拒绝照旧兜底。
 */
export function planWriteClosed(
  calls: readonly PlanCall[],
  semantics: OperationSemantics | undefined,
  writeEnabled: boolean,
): boolean {
  if (writeEnabled) return false;
  if (!semantics || semantics.size === 0) return false;
  return calls.some((call) => isWriteAccess(semantics.get(call.operation)));
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
/**
 * `--file` 取值形态：等号或空白分隔，路径是单个 token 且必须到行尾。
 * 行尾硬边界是这条通道的价值本身——裸 JSON 通道的病根之一就是命令尾巴
 * （`2>&1` / `; echo`），不带进新通道。
 */
const PLAN_FILE_FLAG_RE = /^--file(?:=|\s+)(\S+)$/;
/** `--file` 旗标出现的前缀形态：= 或任意空白（tab 也是模型的常见发射形态）取值都算；裸旗标（无值）也归本分支，由取值正则给出 PLAN_FILE_FLAG_INVALID。 */
const PLAN_FILE_PREFIX_RE = /^--file(?=[=\s]|$)/;
/** 网关 plan 之前允许出现的内容：空 / bash|sh / 路径前缀，以及 bash|sh + 路径前缀。 */
const ALLOWED_PLAN_PREFIX_RE = /^(?:(?:bash|sh)\s+)?(?:[^\s]+\/)?$/;
/** 报错里回显"多出来的内容"时的截断长度：够模型认出自己加了什么，又不把消息撑爆。 */
const EXTRA_PREFIX_MAX_CHARS = 120;

/**
 * 在命令里结构定位网关 plan 令牌：返回网关名之前的原始前缀与 plan 之后的 payload。
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
/**
 * plan 令牌定位：网关名由调用方注入（profile.gateway），未注入时走
 * 遗留缺省（接口文档 §2/§10）。与 serve-gate 共用 gatewayTextPatterns
 * 的网关名来源，不存在第二份抄写。
 */
function locatePlanSubmission(command: string, gateway?: string): { prefix: string; payload: string } | null {
  const resolved = resolveGatewayText(gateway);
  let from = 0;
  for (;;) {
    const at = command.indexOf(resolved, from);
    if (at < 0) return null;
    from = at + resolved.length;
    // 该网关名必须紧跟 plan 子命令（空白分隔，且 plan 自身是一个完整令牌）才算计划提交；
    // 否则只是别处提到了网关（如网关 query），继续找下一个位置。
    const plan = /^\s+plan(?=\s|$)/.exec(command.slice(from));
    if (!plan) continue;
    return { prefix: command.slice(0, at), payload: command.slice(from + plan[0].length).trim() };
  }
}

/** 把"多出来的内容"压成一行可读文本：折叠空白 + 截断。 */
function collapseExtra(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, EXTRA_PREFIX_MAX_CHARS);
}

/** Parse the worker's intercepted gateway plan submission: inline JSON or `--file <path>`. */
export function parsePlanCallsCommand(command: string, gateway?: string): PlanSubmission | null {
  const trimmed = command.trim();
  // 三态分辨，不能一律返回 null：
  //   ① 没有 plan 令牌 → 真不是计划命令（null，交 serve-gate 的常规 CLI 检查）；
  //   ② 有令牌但形状不符 → 这是解析错误，必须响亮抛出。
  // 此前②也返回 null，控制流落进 serve-gate 的 plan 拒绝分支，门的理由是
  // "计划管理命令由宿主控制"——用权限话术答复格式问题，worker 收到的答非所问，
  // 无从自愈（真实平台实测：被误导到把方案 JSON 打印成助手文本，12 步全空转）。
  // throw 在 beforeToolCall 里变成 PLAN DECLINED：<可行动消息>——正确的诊断
  // 本身就是自愈通道：说清形状哪里不对、正确形状长什么样，worker 下一轮就能改。
  const located = locatePlanSubmission(trimmed, gateway);
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
  // ── --file 通道（先于 JSON 分支）──────────────────────────────────────────
  // payload 以 --file 开头时它不是 JSON，落进 JSON.parse 只会得到一句答非所问的
  // PLAN_JSON_PARSE——那正是 2026-10-23 实测里 worker 无路可走时的形态。路径取值
  // 必须到行尾：尾巴（2>&1 / ; echo）是裸 JSON 通道的病根，不带进新通道。
  if (PLAN_FILE_PREFIX_RE.test(payload)) {
    const file = PLAN_FILE_FLAG_RE.exec(payload);
    if (!file) throw errorFor('PLAN_FILE_FLAG_INVALID', payload);
    return { kind: 'file', path: file[1]! };
  }
  // ── 旗标形态 payload（C4）────────────────────────────────────────────────
  // `--` 开头的旗标（--file 已在上面分流）与元数据别名 `schema`：宿主不当成计划
  // 提交，返回 null 交 serve-gate 裁决——元数据出口（plan --schema / plan schema）
  // 在门里有白名单（SERVE_METADATA_COMMANDS），放行到平台 CLI 逐字打印
  // plan-schema.json；其余旗标落在门的计划教学分支（PLAN_SHAPE_GATE_TEACHING，
  // C2 起已教两种提交形态）。判据不在此处写第二份名单。
  //
  // 2026-10-23 实证：这套白名单一直存在，但 driver 的计划解析把 `plan ` 之后任何
  // 东西当 JSON 草案，--schema 直接 PLAN_JSON_PARSE——门里的元数据分支因 driver
  // 先行拦截而不可达，执行层 SKILL 教的是个死命令。返回 null 让两条路都活：
  // 元数据放行到平台；未知旗标拿到教学话术（而不是"JSON 位置 1 处有个 -"）。
  if (payload === 'schema' || payload.startsWith('--')) return null;
  return { kind: 'inline', ...parsePlanCallsPayload(payload) };
}

/**
 * 计划草案 payload 的纯校验：inline 与 --file 两条通道共用的唯一一份判据。
 *
 * 宿主读文件后原样交给它——文件内容与命令行 payload 过同一套校验，不存在
 * "文件通道宽松一点"的第二标准（宽容面 = 攻击面，与 ALLOWED_PLAN_PREFIX_RE
 * 不 absorbing 格式波动是同一条纪律）。
 */
export function parsePlanCallsPayload(payload: string): { calls: PlanCall[]; userConfirmed?: boolean } {
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

/**
 * 平台 `plan evaluate` 的退出码承载两种语义（平台 src/cli/index.js）：
 *   · stdout 是带 `decision` 字段的合法 PlanEvaluation JSON —— 无论 exit 0（execute/notify/
 *     confirm）还是 exit 3（stop 裁决：HARD_LIMIT / REPLAN_LIMIT），都是结构化结果；
 *   · exit 非零且 stdout 拿不出结构化裁决 —— 拒绝/失败形态（如写关闭
 *     PLAN_OPERATION_NOT_READ_ONLY：stderr PLAN_REFUSE，stdout 为空），维持既有抛错，
 *     由驱动 catch 分支按平台确定性错误码映射（e2e 闸③钉住该映射）。
 * 若对 exit 3 一律抛错，stop 分支（plan-runtime 结构化 stop 消息）在真实 CLI 下不可达。
 */
async function runPlanEvaluation(runCli: PlanCliRunner, request: PlanCliRequest): Promise<PlanEvaluation> {
  const result = await runCli(request);
  if (result.code !== 0) {
    const evaluation = tryParseEvaluation(result.stdout);
    if (evaluation) return evaluation;
    throw new Error(`17dz plan CLI 失败（${request.args.slice(0, 2).join(' ')}）：${result.stderr.trim() || `exit ${result.code}`}`);
  }
  try { return JSON.parse(result.stdout) as PlanEvaluation; } catch { throw new Error('17dz plan CLI 返回了无效 JSON。'); }
}

/** exit 非零时区分"stop 裁决"与"拒绝/失败"的唯一判据：stdout 能解析出带合法 decision 的 JSON。 */
function tryParseEvaluation(stdout: string): PlanEvaluation | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const decision = (parsed as Record<string, unknown>).decision;
  return decision === 'execute' || decision === 'notify' || decision === 'confirm' || decision === 'stop'
    ? parsed as PlanEvaluation
    : null;
}

async function runJson<T = unknown>(runCli: PlanCliRunner, request: PlanCliRequest): Promise<T> {
  const result = await runCli(request);
  if (result.code !== 0) throw new Error(`17dz plan CLI 失败（${request.args.slice(0, 2).join(' ')}）：${result.stderr.trim() || `exit ${result.code}`}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error('17dz plan CLI 返回了无效 JSON。'); }
}
