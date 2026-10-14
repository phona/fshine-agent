/**
 * 17dz-platform 公共契约适配层。
 *
 * 本文件是 fshine 仓库中【唯一】允许出现平台实现细节的模块（泄漏 lint 白名单）。
 * 平台输出契约 = RESULT 单行 JSON 信封（schema v1，E2；行协议已随 E2 退役，解析仅认信封）；
 * 操作调用统一使用 operations.json 注册名（E1），不引用脚本文件路径。
 *
 * 两类码级判定收口在这里：平台不可用族（PLATFORM_AUTH_ERROR_CODES）与选择类澄清
 * （SELECTION_CLARIFICATION_CODES）——码是数据，消息文案不是，平台演进只改集合不改编排层。
 */
import path from 'node:path';

/**
 * L2（跨仓协议单一来源）：平台网关的调用形式（相对平台根路径）。
 *
 * 这是宿主侧**唯一**允许出现网关名字面量的地方——即"配置缺省值"：网关可执行文件
 * 固定在平台仓 bin/ 下，名字与 config/agent.yaml 的 contextProfiles['17dz'] profile id
 * 一致；其绝对路径 = platformRoot（来自该 profile 的 root）+ 本常量（见 gatewayExecPath）。
 * worker 的 cwd 即 platformRoot，故命令与消息里出现的都是本相对形式。
 *
 * 消息文本（error-codes 的 correctForm、worker 提示词、门的拒绝理由）与警职解析器
 * （plan 令牌定位、serve CLI 首词/拦截正则）全部从这里取值构造，不各自硬编码——平台若
 * 改名/迁移网关，只改这一处。泄漏 lint 把网关名字面量的预算压到只剩本常量这一处。
 */
export const GATEWAY_INVOCATION = 'bin/17dz';

/** 网关可执行文件的绝对路径 = platformRoot + GATEWAY_INVOCATION（供 spawn 用，配置派生）。 */
export function gatewayExecPath(platformRoot: string): string {
  return path.join(platformRoot, ...GATEWAY_INVOCATION.split('/'));
}

/**
 * 平台操作名（L2 消费不抄写：宿主只引用平台 `operations.json` 的注册名）。
 *
 * C 波后只剩 `financeSearchAccountSets` 一个消费者（error-codes.ts 的 correctForm 指引里
 * 给模型指一条"先做名称检索"的路）。原先这里还挂着旧文本写路径的四个操作名
 * （voucher.prepare / voucher.commit / voucher.query-saved / voucher.verify-saved）与
 * voucher.fill——它们的唯一消费者是 apps/server/commit.ts 那个 legacy 落账执行器，随
 * C 波整体删除，故一并从这里移除：留着就是给"第二份业务名单"留门。
 */
export const PLATFORM_OPERATIONS = {
  financeSearchAccountSets: 'finance.search-account-sets',
} as const;

export interface PlatformEnvelope {
  v: 1;
  op: string;
  status: 'completed' | 'failed' | 'needs_input' | 'not_found';
  data: Record<string, unknown> | null;
  /**
   * 平台错误（L2）：码 + 消息 + **平台拥有的正确形态指引**。correctForm 由平台
   * 错误码表静态列随信封出得去（17dz `lib/envelope.js` 的 emit 出口统一收口），
   * 宿主按字段原样渲染"该怎么改"，不在自己仓里镜像一份词表（镜像即分叉）。
   */
  error: { code: string; message: string; correctForm?: string } | null;
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
  /**
   * 平台正确形态指引（信封 error.correctForm，**平台下发**数据）：宿主渲染层据此
   * 把"该怎么改"说给用户，自己不持领域措辞（L2/D-002：选择类提示曾是宿主镜像的
   * 平台文案，现退化为"信封带了就渲染信封的，没带才用宿主兜底"）。可选：旧版平台
   * / 未登记码的信封不带这一字段。
   */
  correctForm?: string;
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

/** correctForm 的长度上限：它是进用户消息的数据，平台文案再长也不能撑爆澄清问题。 */
const CORRECT_FORM_MAX_CHARS = 200;

/** 信封 correctForm 的取用卫生：剥控制字符/折叠空白后截断；非字符串或空串 → undefined。 */
function correctFormOf(envelope: PlatformEnvelope): string | undefined {
  const raw = envelope.error?.correctForm;
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CORRECT_FORM_MAX_CHARS);
  return text || undefined;
}

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
  const correctForm = correctFormOf(envelope);
  return { code, query, candidates, ...(correctForm ? { correctForm } : {}) };
}

/**
 * 平台健康判据（Lane 2 治标补法）：本回合的平台交互是否以**平台侧不可用**收尾。
 *
 * 机械判据（不猜、不嗅探文案）：平台错误信封的 `error.code ∈ PLATFORM_AUTH_ERROR_CODES`。
 * 这一个判据同时覆盖两句话——
 *   ① "平台返回 AUTH_* 类错误码"：17dz 错误码表「登录态」一组的四档（AUTH_EXPIRED /
 *      AUTH_REDIRECTED_TO_LOGIN / AUTH_WORKBENCH_NOT_READY / AUTH_UNKNOWN，表源：
 *      17dz `src/lib/error-codes.js` 的登录态段）；
 *   ② "exit 非零且错误信封属平台不可用族"：领域脚本把 AuthExpiredError 归一为
 *      NEEDS_LOGIN（`query-receivables.js` 的 errorCodeOf），该信封随网关 exit 1 出得去
 *      （runner.js：信封非 ok 即 code 1）——码在信封里，"exit 非零"是同一事实的另一面，
 *      所以信封码判定即覆盖该分句，不需要在宿主侧重判退出码。
 * 码集合本身收口在 platform-contract（唯一适配层）：平台演进只改集合，不改编排层。
 *
 * 只看**收尾那一条**信封（与 selectionClarificationFromResponses 同一边界）：早先的
 * 平台抖动若随后成功（completed），平台健康已恢复，旧失败不得计入本轮——否则一次
 * runWithAuth 自动重登录自愈会把会话误判成"平台异常"，冷却也就失去了事实依据。
 */
export interface PlatformAuthFailure {
  /** 平台错误码（数据判据）：PLATFORM_AUTH_ERROR_CODES 集合（平台不可用族）内八码之一。 */
  code: string;
}

/** 信封 → 平台侧不可用事实；码不在集合内 / 没有信封 → undefined。 */
export function platformAuthFailureOf(envelope: PlatformEnvelope | null): PlatformAuthFailure | undefined {
  const code = envelope?.error?.code;
  if (!envelope || !code || !PLATFORM_AUTH_ERROR_CODES.has(code)) return undefined;
  return { code };
}

/**
 * tool_result 正文 → 平台侧不可用事实：**本回合最后一条带信封的平台响应**决定收尾
 * 状态（与 selectionClarificationFromResponses 同一把尺、同一边界）。收尾信封是 completed
 * （数据答案）或其他错误码 → undefined：那类回合平台健康没有坏到要冷却。
 */
export function platformAuthFailureFromResponses(
  messages: readonly TranscriptMessageLike[],
): PlatformAuthFailure | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'toolResult') continue;
    const envelope = parseEnvelope(textFromContent(message.content));
    if (!envelope) continue;
    return platformAuthFailureOf(envelope);
  }
  return undefined;
}

/**
 * 转录消息的结构判据（不依赖具体驱动类型：只要 role / content / toolCallId 三个键）。
 *
 * `toolCallId` 在这里是因为有一道判据必须按**身份**而不是按内容或错误标志认领一条
 * tool_result：宿主自己拦下的那一跳，SDK 会把拒绝理由合成一条 `isError:true` 的
 * tool_result 落进转录，与平台 CLI exit 3 的真错误信封在这一列上完全同形——只有 id
 * 能把两者分开（见 platform-entities.ts）。
 */
export interface TranscriptMessageLike {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
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
 * 平台**不可用族**错误码集合（17dz `src/lib/error-codes.js` 的 AUTH_* 四档 + 脚本层
 * 归一码 NEEDS_LOGIN + D-076 登录流程两码 + 平台页面响应超时 PLATFORM_TIMEOUT）。
 * **码是数据，消息文案不是**——平台改文案不影响判定，新增平台侧不可用模式时往这里
 * 加码（收口在唯一适配层）。
 *
 *   · AUTH_EXPIRED：未登录或登录已过期（runWithAuth 自动重登录也失败）；
 *   · AUTH_REDIRECTED_TO_LOGIN：导航后被踢到登录页，会话已过期；
 *   · AUTH_WORKBENCH_NOT_READY：工作台 20s 内没渲染出搜索框，会话可能已过期；
 *   · AUTH_UNKNOWN：无会话 cookie，视为未登录；
 *   · NEEDS_LOGIN：领域脚本对上述 AuthExpiredError 的归一（errorCodeOf）。
 *   · LOGIN_PAGE_CHANGED / AUTH_REJECTED：登录流程自身的两类失败（D-076：平台登录页
 *     改版后元素等不到 vs 元素在但凭据被拒）——都是"登录态拿不到"的收尾形态，计入平台
 *     健康；分因信息在消息里由平台错误码自带，宿主只判族。
 *   · PLATFORM_TIMEOUT：平台页面在 N 秒内没渲染出结果/空态（17dz 对 playwright
 *     Timeout Error 的码级映射，见 query-receivables 的 errorCodeOf）。
 *
 * 为什么超时与登录失效同族（进同一个集合、触发同一套冷却）：两者都是**平台侧不可用**
 * ——平台这一趟没给出可用答数，且原因在执行层之外（会话失效 / 页面不响应），调用方改
 * 自己的输入改不好。宿主可采取的动作也完全相同：暂停逐轮重试（每次重试都真发起一次
 * 浏览器自动化 + 一个限流令牌 + 用户 10-60s 等待，而结论早已确定），冷却期内由宿主合成
 * PLATFORM_UNAVAILABLE 消息（零内部控制词、零错误码），不把技术码漏给用户。
 * 2026-09-29 真实模式实测正是这条缺口：一次空等 25s 超时被包成 INTERNAL 兜底码，本族
 * 不认它 → 模型继续跑计划里的下一步 → 又超时一次 → 用户干等 3 分钟拿到一句归错因的
 * "平台侧环境问题"。纳入本族后，同类超时第二次即进冷却，回合级拦截。
 *
 * 与**不**进本族的码的边界（判据是"谁改得动"，不是消息长短）：
 *   · 输入类（INVALID_PERIOD / QUERY_REQUIRED / INVALID_FLAG…）：调用方改对参数就能成，
 *     重试有意义，冷却只会挡住本该成功的调用；
 *   · 数据三态（ACCOUNT_SET_NOT_FOUND / ACCOUNT_SET_AMBIGUOUS / SUBJECT_NOT_FOUND…）：
 *     平台答得又准又确定，是成功收尾不是故障；
 *   · 兜底码（INTERNAL 等）：无平台侧语义，既不该冷却也不该冒充平台不可用。
 */
export const PLATFORM_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'AUTH_EXPIRED',
  'AUTH_REDIRECTED_TO_LOGIN',
  'AUTH_WORKBENCH_NOT_READY',
  'AUTH_UNKNOWN',
  'NEEDS_LOGIN',
  'LOGIN_PAGE_CHANGED',
  'AUTH_REJECTED',
  'PLATFORM_TIMEOUT',
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

/** 是否平台不可用族失败：信封/挂码/码前缀判定，不依赖任何中文文案。 */
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
