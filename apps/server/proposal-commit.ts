/**
 * 提案落账后端（方案 1 · B 波 B4，薄执行器：服务端直调平台 commit，不经任何模型）。
 *
 * 与 apps/server 下 `commit.ts`（legacy runner）的分工：那个按文件路径落账——宿主自己解提案、
 * 自己物化契约、自己拿冻结参数；这个**只持有一个不透明提案号**——payload 全程住在执行层
 * 自己的状态库里，宿主连"这次提交的是什么业务"都不知道（L4：宿主不该知道自己在提交什么）。
 * 两条路由由 `change_intents` 的条目形状分流（带 proposalId → 本后端；不带 → legacy），
 * C 波删 legacy 时这个分流自然塌掉，本文件不受影响。
 *
 * 四条边界：
 *   ① **operation 名不硬编码**：按平台 `operation list --json` 的 `protocol` 列解析出扮演
 *      "提交提案"角色的那个 operation。拿不到表（CLI 派生失败 / 旧版平台 / 平台还没下发
 *      这一列）= 空表 = **拒绝落账**，绝不回落硬编码网关名——回落等于在宿主持第二份业务
 *      名单（L2 禁的那件事）。
 *   ② **令牌只绑提案与有效期**：HMAC-SHA256 over `{proposalId, expiresAt}`，不绑脚本名、
 *      不绑任何业务字段。密钥进程内生成（assembly 的 newGateSecret），仅经 env 传给这
 *      一个子进程，不进 worker env（W7）。
 *   ③ **env 显式剥 `DZ_REQUIRE_PLAN`**（D-081）：宿主直调是"服务端替 worker 办一件事"，
 *      不该被 worker 的计划门拦——那把尺与提案创建路径同一份（hostGatewayEnv）。
 *   ④ **用户可见文本只有两个来源**：平台 `summaryText` 原样 + 宿主通用状态行。本文件不拼
 *      任何业务摘要，只把平台信封的字段搬进 `CommitResult`。
 *
 * 落账前先向平台取问一次提案状态（平台 designated 的"宿主持有 proposalId 后的唯一取问"）：
 * 令牌必须绑提案自己的有效期，而那个值只存在于平台侧；同一问也把"已过期 / 已终结 / 读不到"
 * 在办调之前现形——否则用户要等一次注定被拒的调用才拿到解释。
 */
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  hostGatewayEnv,
  loadOperationProtocols,
  parseEnvelope,
  gatewayExecPath,
  PROPOSAL_COMMIT_PROTOCOL,
  type OperationProtocols,
  type PlanCliRunner,
  type ProposalCommitRequest,
  type ProposalCommitResult,
  type ProposalUnavailableKind,
} from '@fshine/agent';

/** CLI 超时：与 plan-runtime / 提案创建的缺省 runner 同一量级（平台起不来不能吊住回合）。 */
const CLI_TIMEOUT_MS = 30_000;

export interface ProposalCommitRunnerOptions {
  /** 平台仓库根（网关可执行文件所在，路径由 gatewayExecPath 派生）。 */
  platformRoot: string;
  /** HMAC 密钥：进程内生成，仅经 env 传给 commit 子进程。 */
  gateSecret: string;
  /** 协议角色表（测试替身注入点）；缺省经平台 CLI 派生一次。 */
  operationProtocols?: OperationProtocols;
  /** CLI 运行器（测试替身注入点）；缺省 spawn 真网关。 */
  runCli?: PlanCliRunner;
}

/** 缺省 CLI runner：spawn 网关 + 收 stdio + 超时kill（与 plan-runtime 的 defaultCliRunner 同形状）。 */
const defaultRunCli: PlanCliRunner = ({ platformRoot, args, env }) => new Promise((resolve, reject) => {
  const child = spawn(gatewayExecPath(platformRoot), args, {
    cwd: platformRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
});

/** 平台 `protocol` 列 → operation 名。表同时收注册名与裸名，注册名先插入，故首个命中即注册名。 */
function operationForProtocol(protocols: OperationProtocols, role: string): string | undefined {
  for (const [name, declared] of protocols) {
    if (declared === role) return name;
  }
  return undefined;
}

/**
 * 令牌 = base64url(payload) + '.' + HMAC_SHA256(secret, base64url(payload))，
 * payload = `{proposalId, expiresAt}`。
 *
 * 与 legacy commit 令牌（`commit.ts` 的 signCommitToken）同族同密钥，但**绑不同的东西**：
 * 那个绑"这次调用落在哪个脚本上"，这个绑"这次落账对应哪一份提案、在哪之前有效"。所以不
 * 复用 verifyToken——它硬校验 payload.script，拿提案令牌去过必被拒；两处各验各的那一半。
 */
function signProposalToken(proposalId: string, expiresAt: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ proposalId, expiresAt })).toString('base64url');
  const signature = Buffer.from(createHmac('sha256', secret).update(body).digest()).toString('base64url');
  return `${body}.${signature}`;
}

/** stdout 末行（平台状态取问只写一行 JSON；多行时取最后一条非空行，不猜前面的输出）。 */
function lastLine(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? '';
}

/** 读回计数行（审计留痕用）：只搬平台信封的计数字段，不解释、不汇总。 */
function verifyLineOf(readBack: unknown): string {
  const row = (readBack && typeof readBack === 'object' ? readBack : null) as {
    before?: unknown; after?: unknown; delta?: unknown; required?: unknown;
  } | null;
  if (!row) return '';
  const num = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知');
  return `VERIFY before=${num(row.before)} after=${num(row.after)} delta=${num(row.delta)} required=${num(row.required)}`;
}

interface ProposalCommitEnvelopeData {
  ok?: unknown;
  verified?: unknown;
  summaryText?: unknown;
  readBack?: unknown;
}

type ProposalStatusOutcome =
  | { usable: true; expiresAt: string }
  | { usable: false; kind: ProposalUnavailableKind; detail: string };

/**
 * 向平台取问提案状态（`proposal status --proposal-id`，本地状态文件，不经矩阵/令牌/计划门）。
 *
 * 三态结论全部来自平台 JSON 的结构字段（status / expired / expiresAt），不嗅探任何消息文案：
 *   · status !== 'pending' → 已终结（不能对同一个提案二次落账）；
 *   · expired / 有效期不在未来 → 已过期（令牌绑的就是它，签了也过不了验签）；
 *   · 取问本身失败或输出不是约定形状 → 读不到（fail-closed，不猜平台内部状态）。
 */
async function proposalStatusOf(runCli: PlanCliRunner, platformRoot: string, proposalId: string): Promise<ProposalStatusOutcome> {
  const result = await runCli({
    platformRoot,
    args: ['proposal', 'status', '--proposal-id', proposalId],
    env: hostGatewayEnv(),
  });
  const unreadable = (detail: string): ProposalStatusOutcome => ({ usable: false, kind: 'unreadable', detail });
  if (result.code !== 0) {
    return unreadable(`平台取问失败（exit ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(lastLine(result.stdout)); } catch { return unreadable('平台取问输出不是 JSON'); }
  const row = (parsed && typeof parsed === 'object' ? parsed : null) as {
    proposalId?: unknown; status?: unknown; expired?: unknown; expiresAt?: unknown;
  } | null;
  if (!row) return unreadable('平台取问输出形状不符');
  if (row.proposalId !== proposalId) return unreadable('平台取问返回的提案号与请求不符');
  if (row.status !== 'pending') return { usable: false, kind: 'not_pending', detail: `平台侧状态=${String(row.status)}` };
  const expiresAt = typeof row.expiresAt === 'string' ? row.expiresAt : '';
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (row.expired === true || !Number.isFinite(expiry) || expiry < Date.now()) {
    return { usable: false, kind: 'expired', detail: `平台侧有效期至 ${expiresAt || '（缺失）'}` };
  }
  return { usable: true, expiresAt };
}

/**
 * 造一个"拒绝落账"的结局：不办调、不猜、不回落硬编码。
 * 与执行失败同形（ok=false）但不带 unavailable——调用方据此给出配置故障类解释。
 */
function refuseCommit(error: string): ProposalCommitResult {
  return { ok: false, verified: false, summaryText: '', output: '', error };
}

export function createProposalCommitRunner(
  options: ProposalCommitRunnerOptions,
): (req: ProposalCommitRequest) => Promise<ProposalCommitResult> {
  const runCli = options.runCli ?? defaultRunCli;
  let table: Promise<OperationProtocols> | undefined;
  const protocolsFor = (): Promise<OperationProtocols> => {
    if (options.operationProtocols) return Promise.resolve(options.operationProtocols);
    // 按进程缓存一次（与 label/规格/语义/角色四张表同一手法）：协议列是启动期事实，
    // 绝不每次确认都 spawn 一遍 CLI。派生失败 = 空表 = 拒绝落账。
    table ??= loadOperationProtocols(options.platformRoot).catch(() => new Map<string, string>());
    return table;
  };

  return async (req: ProposalCommitRequest): Promise<ProposalCommitResult> => {
    const proposalId = req.proposalId.trim();
    if (!proposalId) return refuseCommit('（未提供提案号）');

    // ① operation 名按 protocol 角色列解析（拿不到表 → 拒绝，不回落硬编码）。
    const operation = operationForProtocol(await protocolsFor(), PROPOSAL_COMMIT_PROTOCOL);
    if (!operation) {
      return refuseCommit(`平台未声明 ${PROPOSAL_COMMIT_PROTOCOL} 角色的 operation（protocol 列缺失），拒绝落账`);
    }

    // ② 落账前取问：令牌要绑提案自己的有效期（只存在于平台侧），并把不可用形态前置现形。
    const status = await proposalStatusOf(runCli, options.platformRoot, proposalId);
    if (!status.usable) {
      return {
        ok: false,
        verified: false,
        summaryText: '',
        output: '',
        error: status.detail,
        unavailable: status.kind,
      };
    }

    // ③ 令牌 + serve 法域直调（env 只多带密钥与令牌，且剥 DZ_REQUIRE_PLAN——D-081）。
    const token = signProposalToken(proposalId, status.expiresAt, options.gateSecret);
    const result = await runCli({
      platformRoot: options.platformRoot,
      args: ['commit', operation, '--proposal-id', proposalId],
      env: { ...hostGatewayEnv(), DZ_GATE_SECRET: options.gateSecret, DZ_COMMIT_TOKEN: token },
    });

    // ④ 只认 RESULT 信封：成败由平台说（ok / verified / summaryText 全是信封字段）。
    const envelope = parseEnvelope(result.stdout);
    const data = (envelope?.data ?? null) as ProposalCommitEnvelopeData | null;
    const ok = result.code === 0 && envelope?.status === 'completed' && data?.ok === true;
    const verified = data?.verified === true;
    const summaryText = typeof data?.summaryText === 'string' ? data.summaryText : '';
    const output = [
      `${result.stdout}\n${result.stderr}`.trim(),
      verifyLineOf(data?.readBack),
    ].filter(Boolean).join('\n').slice(-2000);
    if (!ok) {
      const detail = envelope
        ? [envelope.error?.code, envelope.error?.message].filter((part) => typeof part === 'string' && part).join('：')
        : (result.stderr || result.stdout).trim().slice(0, 300);
      return { ok: false, verified, summaryText, output, error: detail || `落账命令失败（exit ${result.code}）` };
    }
    return { ok: true, verified, summaryText, output };
  };
}
