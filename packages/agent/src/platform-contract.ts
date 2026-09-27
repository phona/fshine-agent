/**
 * 17dz-platform 公共契约适配层。
 *
 * 本文件是 fshine 仓库中【唯一】允许出现平台实现细节的模块（泄漏 lint 白名单）。
 * 平台输出契约 = RESULT 单行 JSON 信封（schema v1，E2；行协议已随 E2 退役，解析仅认信封）；
 * 操作调用统一使用 operations.json 注册名（E1），不引用脚本文件路径。
 *
 * 两类码级判定收口在这里：登录态失败（PLATFORM_AUTH_ERROR_CODES）与选择类澄清
 * （SELECTION_CLARIFICATION_CODES）——码是数据，消息文案不是，平台演进只改集合不改编排层。
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
 * 选择类结构化状态（平台把"选一个"交回给调用方）：错误码 + 用户查询词 + 平台候选名。
 *
 * 为什么由宿主持有并机械组装：模型的工作上下文全部泡在执行语言里（协议命令 / SKILL
 * 文档 / 信封错误码），它是执行语言与用户语言之间唯一的翻译器——压力下翻译退化，
 * 执行语言就原样漏进最终回复（2026-09-27 Stage 3 手机实测：一次结构化歧义被翻译成
 * 1201 字符技术报告，脚本路径、原始错误码、门的规则引述全上屏，甚至提到平台候选列表
 * 之外的对象名）。结构性修法是把模型对"状态转换"的发音权压到接近零：选择类状态由
 * 宿主从信封数据机械组装成用户消息，模型只为"数据答案"发音。
 */
export interface SelectionClarification {
  /** 平台错误码（数据判据，平台改文案不影响）。 */
  code: string;
  /** 用户的查询词（信封 data.query，原样回显，不做任何加工）。 */
  query: string;
  /** 平台返回的候选名（只取 data.candidates 的 name——列表外的名字由此绝迹）。 */
  candidates: string[];
}

/**
 * 选择类澄清码集合（可扩，先这两个）：平台请用户"选一个"的确定性状态。
 * 与 PLATFORM_AUTH_ERROR_CODES 同纪律——**码是数据，消息文案不是**，新增选择类
 * 失败模式往这里加码（收口在唯一适配层），不在编排层各处分身。
 */
export const SELECTION_CLARIFICATION_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_SET_AMBIGUOUS',
  'ACCOUNT_SET_NOT_FOUND',
]);

/**
 * 选择类状态的信封 status：平台把"选一个"作为**非终态**交回（needs_input 多候选 /
 * not_found 零候选）。completed / failed 不是选择类——前者是数据答案，后者是故障。
 */
const SELECTION_STATUSES: ReadonlySet<string> = new Set(['needs_input', 'not_found']);

/**
 * 信封 → 选择类状态。判据只有码与 status（都是契约数据），候选名只取平台返回的
 * `data.candidates[].name`；码不在集合内 / status 不是选择类 / 没有信封 → undefined。
 */
export function selectionClarificationOf(envelope: PlatformEnvelope | null): SelectionClarification | undefined {
  const code = envelope?.error?.code;
  if (!envelope || !code || !SELECTION_CLARIFICATION_CODES.has(code)) return undefined;
  if (!SELECTION_STATUSES.has(envelope.status)) return undefined;
  const data = envelope.data as { query?: unknown; candidates?: unknown } | null;
  const query = typeof data?.query === 'string' ? data.query.trim() : '';
  // 数据完整性前置：澄清问题必须点名"用户问的是什么"（模板第一句就是
  // 没有找到匹配"{query}"的对象）。信封没带 query 时（如 query-receivables 的
  // not_found 分支 data 为 null）组装不出这句问话——宁可不挂（行为零变化），
  // 也不给用户一句指代不清的占位问句。
  if (!query) return undefined;
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates
      .map((item) => ((item && typeof item === 'object') ? (item as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
  return { code, query, candidates };
}

/** 转录消息的结构判据（不依赖具体驱动类型：只要 role 与 content 两个键）。 */
interface TranscriptMessageLike {
  role?: unknown;
  content?: unknown;
}

/**
 * 从会话转录的 tool_result 里提取选择类状态：**本回合最后一条带信封的平台响应**决定
 * 收尾状态——它是选择类码才返回 `{code, query, candidates}`，其余（completed 数据答案、
 * 其他错误码、没有信封的自由文本、空转录）一律 undefined。
 *
 * 与 `needsFromPlatformResponses`（pi-coding-driver）的分工：那个扫全部历史取"最近一条
 * 命中"，产"缺什么"的纠错线索；这个只看收尾那一条，产"选择类澄清事实"。只看收尾是
 * 故意的——早先歧义、用户补全名称后重查成功（completed）的回合，绝不能被旧信封劫持
 * 成澄清问句；调用方再按需只传本回合新增的消息（见 pi-coding-driver 的 tail 切片），
 * 上一回合遗留的信封同样不会越权。
 */
export function selectionClarificationFromResponses(
  messages: readonly TranscriptMessageLike[],
): SelectionClarification | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'toolResult') continue;
    const envelope = parseEnvelope(textFromContent(message.content));
    if (!envelope) continue;
    return selectionClarificationOf(envelope);
  }
  return undefined;
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

/**
 * tool_result 正文取文本（原生 content 分段 → 纯文本）。编排层多处要读平台响应
 * （信封解析、选择类提取、实体来源收集），取文本的规则只有这一份。
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item): item is { type: 'text'; text: string } =>
    Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string'),
  ).map((item) => item.text).join('');
}
