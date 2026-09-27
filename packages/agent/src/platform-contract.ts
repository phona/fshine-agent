/**
 * 17dz-platform 公共契约适配层。
 *
 * 本文件是 fshine 仓库中【唯一】允许出现平台实现细节的模块（泄漏 lint 白名单）。
 * 平台输出契约 = RESULT 单行 JSON 信封（schema v1，E2；行协议已随 E2 退役，解析仅认信封）；
 * 操作调用统一使用 operations.json 注册名（E1），不引用脚本文件路径。
 */

export const PLATFORM_OPERATIONS = {
  financeSearchAccountSets: 'finance.search-account-sets',
  voucherPrepare: 'voucher.prepare',
  voucherCommit: 'voucher.commit',
  voucherQuerySaved: 'voucher.query-saved',
  voucherVerifySaved: 'voucher.verify-saved',
  voucherFill: 'voucher.fill',
} as const;

export interface PlatformEnvelope {
  v: 1;
  op: string;
  status: 'completed' | 'failed' | 'needs_input' | 'not_found';
  data: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

/** 解析 stdout 末行 RESULT 信封（v2）；缺席或非法返回 null。 */
export function parseEnvelope(stdout: string): PlatformEnvelope | null {
  const m = stdout.match(/^RESULT (\{.*\})\s*$/m);
  if (!m) return null;
  try {
    const e = JSON.parse(m[1]!) as PlatformEnvelope;
    return e.v === 1 && typeof e.op === 'string' && typeof e.status === 'string' ? e : null;
  } catch {
    return null;
  }
}

export interface PrepareOutcome {
  ok: boolean;
  dryRun: boolean;
}

/** prepare（fill.js 别名操作）结果：仅认 RESULT 信封。 */
export function parsePrepareOutcome(stdout: string): PrepareOutcome {
  const env = parseEnvelope(stdout);
  if (!env || env.op !== PLATFORM_OPERATIONS.voucherFill) return { ok: false, dryRun: false };
  const mode = (env.data as { mode?: unknown } | null)?.mode;
  return { ok: env.status === 'completed', dryRun: mode === 'dry-run' };
}

/** verify-saved 读回的期内记录条数：仅认 RESULT 信封。 */
export function parseVerifyCount(stdout: string): number | null {
  const env = parseEnvelope(stdout);
  if (!env || env.op !== PLATFORM_OPERATIONS.voucherVerifySaved) return null;
  const count = (env.data as { count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : null;
}

/**
 * 平台登录态类错误码集合（17dz `src/lib/error-codes.js` 的 AUTH_* 四档 + 脚本层
 * 归一码 NEEDS_LOGIN）。**码是数据，消息文案不是**——平台改文案不影响判定，
 * 新增登录态失败模式时往这里加码（收口在唯一适配层）。
 *
 *   · AUTH_EXPIRED：未登录或登录已过期（runWithAuth 自动重登录也失败）；
 *   · AUTH_REDIRECTED_TO_LOGIN：导航后被踢到登录页，会话已过期；
 *   · AUTH_WORKBENCH_NOT_READY：工作台 20s 内没渲染出搜索框，会话可能已过期；
 *   · AUTH_UNKNOWN：无会话 cookie，视为未登录；
 *   · NEEDS_LOGIN：领域脚本对上述 AuthExpiredError 的归一（errorCodeOf）。
 */
export const PLATFORM_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'AUTH_EXPIRED',
  'AUTH_REDIRECTED_TO_LOGIN',
  'AUTH_WORKBENCH_NOT_READY',
  'AUTH_UNKNOWN',
  'NEEDS_LOGIN',
]);

/**
 * 从错误对象提取平台错误码。两个来源都是**码级**判据（不是自然语言嗅探）：
 *   ① error.code 挂码（17dz errorFor / 信封 error.code 的宿主侧载体）；
 *   ② 消息开头的 `CODE:` 前缀——17dz 错误码表的渲染格式就是 `<CODE>: 期望 …`，
 *      前缀由 messageFor 保证，是契约的一部分。
 */
export function platformErrorCodeOf(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  const message = error instanceof Error ? error.message : '';
  const prefixed = /^\s*([A-Z][A-Z0-9_]+)\s*:/.exec(message);
  return prefixed ? prefixed[1]! : null;
}

/** 是否登录态类失败：信封/挂码/码前缀判定，不依赖任何中文文案。 */
export function isPlatformAuthError(error: unknown): boolean {
  const code = platformErrorCodeOf(error);
  return code !== null && PLATFORM_AUTH_ERROR_CODES.has(code);
}
