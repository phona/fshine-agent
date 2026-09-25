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
