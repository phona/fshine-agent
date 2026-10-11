/**
 * fshine 侧错误码表（镜像 17dz `src/lib/error-codes.js` 的结构与纪律：错误即数据）。
 *
 * 为什么收口：fshine 的拒绝/兜底消息曾是各出事点现场手拼——同一个"计划形状不符"
 * 在 plan-runtime 六个 throw 站点六种写法；"零执行"兜底在 runtime 三处各写一遍；
 * 委派失败的四档话术散在 context.ts 顶部。消息在出事点随手拼，拼出什么结构全看
 * 当时心情，缺"期望什么 / 实际收到什么 / 正确形态是什么"三要素时，调用方对不上
 * 就无从改起。现在消息模板只有这一张表：新失败模式 = 新错误码（往表里加一行），
 * 不在出事点加分支、不现场拼消息。
 *
 * 两类条目（一张表，两种形态）：
 *   · 错误类 `{expected, actual?, correctForm}`：参数问题 / 形状问题 / 配置故障。
 *     渲染 `<CODE>: 期望 <expected>；实际 <actual>；正确形态 <correctForm>`——
 *     必须说清差在哪，绝不让参数问题长得像权限问题（17dz 同款事故形态）。
 *   · 消息模板类 `{text}`：用户可见的"状态话术"（如 ACTIVATED_PLAN_NOT_EXECUTED）。
 *     它们**不是错误**，是宿主对真实状态的确定性陈述——码 → 文本一一对应，
 *     语义照旧，只是不再有第二份手抄本。个别条目带占位符（选择类澄清的
 *     `{query}`/`{n}`/`{list}` 由 `clarificationTextFor` 用平台信封数据填充，平台健康
 *     冷却的 `{minutes}` 由 `platformUnavailableTextFor` 用宿主时钟数据填充）——动态
 *     部分是数据不是措辞，模板本身仍然零业务词。
 *
 * 第三种形态（serve 门拒绝理由收口后新增）：**声明了 `params` 的参数化消息模板**
 * （`SERVE_*` 一族）。门的拒绝理由曾是十几处 inline 字符串散在 serve-gate.ts 各出事点，
 * 同一件事（"这是工作区外路径"）按工具分两种写法、按路径分无数种拼法——改一句措辞要
 * 全文搜，测试各写一遍中文字面量，泄漏 lint 也审不到它们（不在白名单，却出现在发给
 * worker 的消息里）。现在它们全在本表：码 → 文本一一对应，动态部分（动作动词 / 目标
 * 路径 / 字节数）是**数据**，经 `messageTextFor(code, params)` 的 `{name}` 占位符机械
 * 填充——不为每个路径拼一条消息。占位符名单必须在条目里声明：漏声明 = 调用方误用
 * （fail-loud），多给/少给参数同样 fail-loud（静默忽略会把"话术被悄悄加了动态部分"
 * 藏起来，与消息模板传 actual 同纪律）。
 *
 * 纪律（与 17dz 表相同）：
 *   - 错误码本身不变（测试与调用方认码）；本表只收口消息构造，不动任何裁决逻辑。
 *   - 未知码 fail-loud（UNKNOWN_ERROR_CODE）：绝不静默 fallback 到通用消息——那会把
 *     "忘了登记新码"伪装成"已知的普通失败"，正是本表要消灭的事故形态。误用
 *     （给消息模板传 actual / 给错误码少传动态实际值之外的参数）同样 fail-loud。
 *   - 措辞与业务无关（不出现任何领域词，业务词预算见 platform-leak-lint）：
 *     执行层持有领域词，这正是边界。
 *
 * 渲染格式：`<CODE>: 期望 <expected>；实际 <actual>；正确形态 <correctForm>`。
 * actual 绝大多数是拒绝点动态填（收到的脏输入 / 候选清单 / 第几项出错）；个别码
 * 有稳定实际形态，在条目里给 actual 缺省。correctForm 第三参仅用于需要调用方
 * 上下文的动态部分；静态措辞一律在表里。
 */
import { ToolUserError } from './driver';
import { GATEWAY_INVOCATION, PLATFORM_OPERATIONS } from './platform-contract';

export const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR_CODE';

/** 错误类条目：三要素（期望 / 实际 / 正确形态）。 */
interface ErrorCodeEntry {
  expected: string;
  /** 稳定的实际形态缺省；动态实际值由拒绝点传参覆盖。 */
  actual?: string;
  correctForm: string;
}

/** 消息模板类条目：用户可见的状态话术（不是错误，码 → 文本一一对应）。 */
interface MessageCodeEntry {
  text: string;
  /**
   * 参数化模板的占位符名单（`{name}` 形）：声明了它，`messageTextFor(code, params)` 才
   * 接受参数并机械填充；没声明而传参数 = 调用方误用（fail-loud）。名单即契约——少一个
   * 名字，模板里就会留下一个空泛占位符；多一个名字，参数就是白给（同样 fail-loud）。
   */
  params?: readonly string[];
  /**
   * 选择类澄清专用：模板里 `{hint}` 占位符的**兜底**取值（信封没带平台 correctForm 时用）。
   * 挂「遗留待清」——平台全域携带 correctForm 后，这两个兜底字符串即删（L2：宿主镜像表
   * 退化为渲染层，只存"信封没带时的兜底"，不持平台措辞的唯一真相）。
   */
  hintFallback?: string;
}

type CodeEntry = ErrorCodeEntry | MessageCodeEntry;

/**
 * 计划草案形状的**唯一教学源**（L2 / D-011：宿主侧 6 处散文副本收敛为这 1 处）。
 *
 * 内容与平台 `17dz-platform/src/execution/plan-schema.json` 的声明一致：`calls` 必填
 * （PlanCall 数组），`goal` / `requestId` 是**声明过的**可选元数据
 * （`additionalProperties:false`——未声明顶层字段平台以 PLAN_UNKNOWN_FIELD 响亮拒绝，
 * 绝不静默忽略后跑）。goal 收编为可选元数据而非否决：宿主历史上一直在教它，平台选择
 * "声明 + 校验"比"否决"更符合单一来源（见 plan-schema.json 的 description）。
 * `requestId` 由宿主在 evaluate 时自行填，不进教学示例。
 *
 * 纪律：错误码表（本文件 5 处）与 worker 系统提示词（context.ts 1 处）**全部**从这里
 * 派生，任何地方不得再手写第二种形状——同一张表给出两种互相矛盾的形状，正是「模型
 * 静默选一份信」的机制（D-011 根因）。机械锁：plan-teaching.test.ts 跨仓读平台 schema
 * 断言本示例合法，并断言两个源文件里除本函数外零第二种草案形状字面量。
 */
export function planDraftExample(): string {
  return `${GATEWAY_INVOCATION} plan {"goal":"…","calls":[{"operation":"…","args":[…]}]}`;
}

/** 计划提交的正确形状：形状类错误共用的 correctForm（静态词进表）。 */
const CORRECT_PLAN_SHAPE = `方案是单行原始命令：${planDraftExample()}，JSON 原样放在这一行命令里。`;

/**
 * shell 元字符拒绝理由的公共前缀：同一事实（放行这些字符 = 放行任意命令）只说一遍，
 * 三条 SERVE_BASH_METACHAR_* 只差收尾那句"该怎么拆"。分叉的那一侧就是攻击面——
 * 前缀若各写一份，补一条边界只补一处，另一侧静默腐烂。
 */
const SHELL_METACHAR_REASON = '命令含 shell 元字符（; & | < > ` $ ( ) 或换行），禁止命令拼接/替换/重定向';

const TABLE: Record<string, CodeEntry> = {
  // ── 门/计划类：worker 提交方案的形状与范围（PLAN DECLINED 的自愈通道）──
  // 措辞是给 worker 的诊断：说清期望什么、实际收到什么、正确形态是什么。正确的
  // 诊断本身就是自愈通道——真实平台实测里用权限话术答复格式问题，worker 被误导到
  // 把方案 JSON 打印成助手文本，12 步全空转；此后形状错误一律响亮抛出。
  PLAN_SHAPE_PREFIX: {
    expected: `${GATEWAY_INVOCATION} plan 之前只允许 bash/sh 与路径前缀（围栏、外层引号、客套话都算多出来的内容）`,
    correctForm: CORRECT_PLAN_SHAPE,
  },
  PLAN_SHAPE_PAYLOAD: {
    expected: `${GATEWAY_INVOCATION} plan 之后紧跟单行 JSON 方案`,
    actual: 'plan 之后没有任何内容',
    correctForm: CORRECT_PLAN_SHAPE,
  },
  PLAN_SUBCOMMAND_RESERVED: {
    expected: 'worker 只提交 JSON calls 方案；evaluate / activate / current / status 由宿主调用',
    correctForm: `${planDraftExample()}（单行原始命令）`,
  },
  PLAN_JSON_PARSE: {
    expected: '方案是合法 JSON',
    correctForm: CORRECT_PLAN_SHAPE,
  },
  PLAN_JSON_NOT_OBJECT: {
    expected: '方案 JSON 顶层是对象',
    correctForm: `${planDraftExample()}（顶层为对象，calls 是数组）`,
  },
  PLAN_CALLS_NOT_ARRAY: {
    expected: '方案声明 calls 数组',
    correctForm: planDraftExample(),
  },
  PLAN_CALLS_EMPTY: {
    expected: 'calls 至少包含一个操作',
    correctForm: '把本次要执行的 operation 逐项列进 calls，不空手提交',
  },
  PLAN_CALL_NOT_OBJECT: {
    expected: 'calls 的每一项是对象',
    correctForm: '{"operation":"…","args":[…]}',
  },
  PLAN_CALL_FIELDS: {
    expected: 'calls 的每一项都含 operation 和 args 两个字段',
    correctForm: '{"operation":"…","args":[…]}',
  },
  PLAN_CALL_OPERATION_EMPTY: {
    expected: 'operation 是非空字符串',
    correctForm: '平台清单注册名（operation list 可查），不猜名称',
  },
  PLAN_CALL_ARGS_NOT_ARRAY: {
    expected: 'args 是数组',
    correctForm: 'args 为字符串数组，即命令行原样参数（如 ["--query","某名称","--period","202609"]）',
  },
  PLAN_CALL_ARGS_NOT_JSON: {
    expected: 'args 是 JSON 值',
    correctForm: '字符串 / 数字 / 布尔 / null；不含函数、循环引用等不可序列化值',
  },
  // 计划实体来源校验（宿主侧 C20）的拒绝原因：实际 = 校验器点名的越权参数，
  // 由 pi-coding-driver 以 PLAN DECLINED 协议前缀交付 worker。
  //
  // correctForm 的正路径（任务 1 补）：原来只有负指令（"严格按本轮请求的范围执行，或向
  // 用户澄清"），被拦方（worker）没有可执行的自愈动作——2026-09-27 事故里它反复重提
  // 同一请求直到收敛上限。正路径两条：① 先执行一次名称检索让平台响应携带规范名，再按
  // 响应里的名字提交（"名称检索拿唯一候选 → 按候选名查"天然放行正是这条）；② 本会话
  // 早前用户亲自提供/确认过的实体同样是合法来源（第四来源 sessionEntities，见
  // turn-contract.ts）。检索操作名取平台契约常量（PLATFORM_OPERATIONS，L2 消费不抄写）。
  ENTITY_OUT_OF_SCOPE: {
    expected: '计划的每个参数都能在当前请求、检索证据、平台响应或本会话已确立实体里逐字找到',
    correctForm: `严格按本轮请求的范围执行，或向用户澄清——不把计划外实体塞进 calls；可先执行一次名称检索（如 ${PLATFORM_OPERATIONS.financeSearchAccountSets}）使名称进入平台响应后再提交查询；用户在本会话早前提供或确认过的实体同样有效`,
  },
  // 同任务内计划被连续拒绝的收敛（PLAN STOP）：实际 = 已拒绝次数。
  DECLINED_PLAN_LIMIT: {
    expected: '同一任务的计划提交逐次通过形状与实体来源校验',
    correctForm: '停止重新提交计划，直接用自然语言向用户说明缺什么、建议提供什么',
  },

  // ── 任务类：委派入口的参数卫生（参数问题，绝不报成权限问题）──
  TASK_REQUEST_EMPTY: {
    expected: 'request 为非空字符串（把用户请求加工成自包含的一句话）',
    correctForm: '写明做什么、对谁、什么范围，再委派',
  },
  TASK_ID_INVALID: {
    expected: 'taskId 为非空字符串',
    actual: 'taskId 为空或不是字符串',
    correctForm: '继续此前的子任务才传 taskId；新任务不传',
  },
  TASK_NOT_FOUND: {
    expected: 'taskId 是本会话里未完成、未过期的子任务编号',
    actual: '该编号查不到对应任务（编号无效或已过期）',
    correctForm: '直接告诉我要查什么，我重新查一次',
  },
  TASK_FORBIDDEN: {
    expected: '子任务属于当前用户与当前会话',
    actual: '任务归属不匹配（用户或会话对不上）',
    correctForm: '改用本会话产生的任务编号，或直接告诉我要查什么',
  },

  // ── 配置类：宿主部署故障（话术指向管理员/部署方，用户无需操作）──
  // 计划停在用户确认门却没人接盘：这是部署漏配，不是用户能重试好的事——说成
  // "执行失败请稍后再试"是把部署故障伪装成平台抖动（③-3）。
  PLAN_PENDING_PERSIST_MISSING: {
    text: '平台计划待确认，但宿主未配置安全持久化回调，请联系管理员。',
  },

  // ── 选择类澄清：结构化歧义/未找到（2026-09-27 Stage 3 事故根治包）──────────
  // 模型是执行语言与用户语言之间唯一的翻译器，压力下翻译退化，脚本路径/错误码/门的
  // 规则就漏进最终回复。这两条模板让宿主直接持信封数据机械组装澄清问题——模板零业务词
  // （候选名是数据不是措辞，泄漏 lint 同款预算守这条），领域换了域一个字都不用改。
  //
  // Wave 2（L2，D-002/D-012 一族）：宿主镜像表退化为**渲染层**——"该怎么改"的领域
  // 措辞由平台信封的 error.correctForm 作为**数据**携带（platform-contract 解析），
  // 宿主只拼结构。NOT_FOUND_SELECTION 因此只有 `{hint}` 一个措辞槽位：信封带了就
  // 原样渲染平台的，没带才用下面的宿主兜底（hintFallback，挂「遗留待清」）。
  // AMBIGUOUS_SELECTION 不设措辞槽位：它的用户可见事实（查询词/候选名/个数）已经
  // 全部来自信封，平台给它的 correctForm 是给**解析方**的行动规则（"绝不代选、绝不
  // 点第一行"），不是给用户的问句——渲染它只会把内部规则念给用户听。
  // {list} 后句号（2026-09-27 第三波）：候选清单与问句之间必须断句，否则渲染成
  // "…等 25 个你要查哪个？"——清单尾巴和问句粘成一句，用户读起来像病句。
  AMBIGUOUS_SELECTION: {
    text: '没有找到唯一匹配“{query}”的对象。平台上有 {n} 个名字相近的：{list}。你要查哪个？告诉我名称或序号即可。',
  },
  NOT_FOUND_SELECTION: {
    // {hint} = 平台 correctForm（数据）；宿主兜底挂「遗留待清」：平台全量携带后即删。
    text: '没有找到匹配“{query}”的对象。{hint}我再查。',
    hintFallback: '请确认准确名称后',
  },

  // ── 平台健康类：连续登录/环境异常后的冷却期话术（Lane 2 治标补法）──────────
  // 与 DELEGATION_AUTH_FAILURE 的分工：那句说"这一轮失败了、要重新登录"（一次性、
  // 可行动）；这句说"宿主已暂停自动重试、约 N 分钟后自动恢复"（连续失败后的状态）。
  // {minutes} 占位符由 platformUnavailableTextFor 用宿主时钟数据填充（与选择类澄清的
  // {query}/{n}/{list} 同族：动态部分是数据不是措辞，因此不经 messageFor 的 actual
  // 通道——消息模板给它传 actual 会 fail-loud，纪律不变）。
  // 措辞纪律：只陈述平台侧异常与下一步动作——不出现任何内部控制词（额度/配额/熔断/
  // 计划门/拒绝上限/重试上限是宿主机制，用户不需要知道），也不编造原因（登录页改版、
  // 凭据过期这类归因平台登录层都判不准，宿主更不该猜；"与你的查询内容无关"是唯一
  // 被陈述的归因边界）。零业务词（泄漏 lint 同款预算）：领域换了域一个字都不用改。
  PLATFORM_UNAVAILABLE: {
    text: '平台侧登录或环境异常，与你的查询内容无关。已暂停自动重试，约 {minutes} 分钟后自动恢复尝试；持续异常请联系管理员。',
  },

  // ── 收尾类：用户可见的状态话术（不是错误——码 → 文本一一对应，语义照旧）──
  NO_EXECUTION_CLARIFICATION: {
    text: '我需要实际查询平台才能回答这个问题，但本轮没有产生任何平台查询。请告诉我要查询的对象和范围，我重新查一次。',
  },
  ACTIVATED_PLAN_NOT_EXECUTED: {
    text: '执行方案已获批准（通知已送达），但查询没有执行。请回复“继续”，我按已批准的计划重新执行；如想改查询范围，直接告诉我。',
  },
  // 恢复路径（resumeTaskId）零执行的专用话术（③-5b）：与 ACTIVATED_PLAN_NOT_EXECUTED
  // 的区别是事实本身——用户刚确认过操作，缺的是执行不是 specification，再让用户
  // "告诉我要查询的对象和范围"（NO_EXECUTION_CLARIFICATION）就是问一个早就答过的问题。
  RESUMED_PLAN_NOT_EXECUTED: {
    text: '按您刚才确认的操作没有产生任何平台执行。请回复“继续”重跑，或直接告诉我要调整的范围。',
  },
  FALLBACK_TIMEOUT: { text: '查询超时,请稍后再试' },
  FALLBACK_FAILURE: { text: '查询失败,请稍后再试或联系管理员' },
  // 委派失败四档（按 failureClass 分流，2026-09 审计 F7）：auth 是唯一需要用户
  // 动手的一类，不说"稍后再试"（那是错指令，重试多少次都没用）。
  DELEGATION_AUTH_FAILURE: { text: '平台登录态过期，需要重新登录后才能继续查询。' },
  DELEGATION_TIMEOUT_FAILURE: { text: '平台响应超时，请稍后重试。' },
  DELEGATION_EXECUTOR_FAILURE: { text: '17dz 子任务执行失败，请稍后再试。' },
  DELEGATION_CANCELLED: { text: '17dz 子任务已取消。' },

  // ── 能力类：写未开放（capability 声明，用户可行动）──────────────────────────
  // 唯一来源纪律：写关闭话术只有这一份。两个消费方共用——提案落账前的 capability 检查
  // （context.ts finalizeProposal）与计划门对"计划里含非 read operation"的拒绝
  // （pi-coding-driver 的计划 evaluate 失败分支：平台 canonicalCall 抛
  // PLAN_OPERATION_NOT_READ_ONLY，CLI exit 3）。第三波实测：写尝试被计划门挡下时，
  // 汇报里只有卡点没有"未开放写入权限"，用户不知道该找谁——那句话必须到达用户。
  // 与 DELEGATION_* 同族（消息模板类，码 → 文本一一对应），不新造第二份手抄本。
  WRITE_NOT_ENABLED: { text: '当前未开放写入权限，如有需要请联系管理员开通。' },
  // 同一次平台拒绝（PLAN_OPERATION_NOT_READ_ONLY）的另一种真相：**这个调用不该进计划**。
  // 为什么必须分开：平台按"是不是只读"拒绝计划，而拒绝名单里混着两类调用——要用户确认的
  // 写类调用（部署没开放写 → WRITE_NOT_ENABLED）与根本不需要计划的本地处理（曾经被用户
  // 看到"请联系管理员开通写入权限"，已实证的误导）。判据是平台 access 语义表的 confirm 列
  // （要不要用户确认），不是错误码名——宿主不按码名猜语义。措辞只说该怎么做，不出现平台
  // 实现形状（类名/路径/脚本名一律不进消息）。
  PLAN_NOT_PLANNABLE: { text: '该调用不需要计划、也不要放进计划，直接调用即可。' },

  // ── 路由类：申报缺失时的重试指令（给模型，不上屏）──
  ROUTE_RETRY_NUDGE: {
    text: '你必须先调用 route_current_turn 申报本轮动作（conversation / delegate），再回答。',
  },

  // ── 门/计划类：serve-gate 的计划提交教学（唯一合法形式 + 三种常见错误包装）──
  PLAN_SHAPE_GATE_TEACHING: {
    text: `计划必须经 bash 工具作为单行原始命令提交：${planDraftExample()}，JSON 原样放在这一行命令里。不要用 markdown 代码块包裹，不要加外层引号，不要拆成多行。evaluate/activate 由宿主调用，worker 不得直接调用。`,
  },

  // ── serve 门类：G1 原生工具门的拒绝理由（唯一来源，原 serve-gate.ts 各出事点 inline）──
  //
  // 为什么收口：这些理由曾经是出事点现场手拼的字符串——同一个"工作区外路径"在 write 与
  // read 两条分支两种写法，措辞改动要全文搜，测试各写一遍中文字面量，而泄漏 lint 扫不到
  // 它们（不在白名单，却出现在发给 worker 的消息里）。收口后它们与 PLAN_SHAPE_* 同表：
  // 新失败模式 = 新错误码（往这里加一行），不在出事点拼消息。
  //
  // 两条纪律（与计划门同族）：
  //   ① 动态值是数据不是措辞：动词（写入/修改）、目标路径、字节数经 `{name}` 占位符由
  //      `messageTextFor` 填充——不为每个路径拼一条消息。
  //   ② **不复述平台调用形状**：宿主曾把网关可执行名与知识面名单（*.md、*.schema.json、
  //      .agents/、docs/）抄进拒绝理由，而那正是系统提示词刚清零的东西——worker 在**做错
  //      的那一刻**看到它，最把这句话当真相，于是照着一个可能已过期的形状去撞门。形状的
  //      唯一真来源是平台技能文档的「serve 运行态的调用形态」一节（四种 mode、local 用途、
  //      `operation list --json` 发现、禁止项都在那里）；宿主只给"去哪看"的指针。
  //      **复述即分叉**：平台改了暴露面而宿主这份抄写没同步，worker 拿到的就是假真相。
  //      措辞纪律照旧：零业务词、零平台实现细节（平台脚本名/路径/清单文件一律不出现）。

  // ── 写入类（write / edit 共用同一组边界，见 serve-gate 的 decideFileWrite）──
  // 没有 platformRoot 就无从判断落点，宁可不放（放在路径规范化之前）。
  SERVE_WRITE_NO_PLATFORM_ROOT: {
    text: '未配置平台工作目录，无法裁决写入位置',
  },
  SERVE_WRITE_PATH_MISSING: {
    text: 'write 需要非空的 path 参数',
  },
  SERVE_EDIT_PATH_MISSING: {
    text: 'edit 需要非空的 path 参数',
  },
  SERVE_EDIT_EDITS_MISSING: {
    text: 'edit 需要非空的 edits 数组（至少一处替换）',
  },
  // {verb} = 写入 / 修改：判据只有一份（write 与 edit 共用），但理由要说清模型刚才想干什么
  // ——它传的是 edits 而回答里说"写入"，模型会以为门没认出它的工具。
  SERVE_WRITE_OUTSIDE_WORKSPACE: {
    text: '运行态禁止{verb}工作区外路径（{target}）',
    params: ['verb', 'target'],
  },
  SERVE_WRITE_SENSITIVE_PATH: {
    text: '运行态禁止{verb}敏感路径（{target}）',
    params: ['verb', 'target'],
  },
  // tmp/ 是草稿不是系统：放整个工作区就等于给了改执行层的权限，那正是必须守住的线。
  SERVE_WRITE_OUTSIDE_DRAFT_ROOT: {
    text: '运行态只允许{verb} tmp/ 草稿区（契约、mapping、临时脚本）；{rel} 不在其内。执行层与配置不可由 worker {verb}',
    params: ['verb', 'rel'],
  },
  // 每请求一个子目录是机械边界不是约定：tmp/ 是共享草稿区，并发会话写同名产物会互相覆盖，
  // 而覆盖后的产物看不出被谁污染。{scratchDir} 由宿主按 requestId 派生（worker 无随机手段）。
  SERVE_WRITE_OUTSIDE_REQUEST_SCRATCH: {
    text: '本轮只允许{verb} {scratchDir}（每请求独立草稿区，避免并发会话互相覆盖）；{rel} 不在其内',
    params: ['verb', 'scratchDir', 'rel'],
  },
  // {limitKB} 是上限本身（数据），{bytes} 是这次实际带进来的字节数（脏输入要可辨认）。
  SERVE_WRITE_TOO_LARGE: {
    text: '{verb}内容超过 {limitKB}KB 上限（{bytes} 字节）',
    params: ['verb', 'limitKB', 'bytes'],
  },

  // ── 读取类（read 内容层限知识面；ls 只受 workspace 边界与敏感路径约束）──
  SERVE_READ_OUTSIDE_WORKSPACE: {
    text: '运行态禁止读取工作区外路径（{target}）',
    params: ['target'],
  },
  SERVE_READ_SENSITIVE_PATH: {
    text: '运行态禁止读取敏感路径（{target}）',
    params: ['target'],
  },
  // 知识面判据（*.md、*.schema.json、.agents/、docs/）是宿主实现细节：它随部署配置变，
  // 抄进消息就是第二份真相。只说"只能读知识面文档"，去哪看形状指平台技能文档。
  SERVE_READ_NOT_KNOWLEDGE: {
    text: `运行态只能读知识面文档，不可读实现源码或运行产物（{target}）。需要平台能力时，调用形态以运行态技能文档「serve 运行态的调用形态」一节为准`,
    params: ['target'],
  },

  // ── bash 类：shell 元字符白名单（放行拼接/替换/重定向 = 放行任意命令）──
  // 三条共一个前缀（同一次拒绝、三种收尾）：local 只陈述被拒事实；元数据查询与多次查询
  // 各自补一句"该怎么拆"——worker 被拒后要能直接改成合法形态，不需要猜。
  SERVE_BASH_METACHAR_LOCAL: { text: SHELL_METACHAR_REASON },
  SERVE_BASH_METACHAR_METADATA: { text: `${SHELL_METACHAR_REASON}。元数据查询请单独一次调用` },
  SERVE_BASH_METACHAR_QUERY: { text: `${SHELL_METACHAR_REASON}。多次查询请分多次调用` },
  // 不点网关可执行名（平台实现形状）：只陈述"平台能力走统一入口"，形状指技能文档。
  SERVE_BASH_NOT_GATEWAY: {
    text: `运行态 bash 只允许经统一入口调用平台能力；知识检索用 read 工具。调用形态以运行态技能文档「serve 运行态的调用形态」一节为准`,
  },
  // local 模式的目标不在本轮放行根内。为什么必须有这一条：local 打到根之外时，命令形状
  // 仍是合法网关调用，会落穿到通用分支（只问"是不是网关 + 有没有计划"）而被放行——
  // 2026-10-09 验收实证：planActive=true 时别人的 req_ 目录、tmp/ 散脚本、../ 穿越全部放行。
  // 文本不提路径名单（宿主实现细节，且随部署变），只说"本轮草稿目录或辅助技能面"。
  SERVE_LOCAL_OUTSIDE_SCRATCH: {
    text: '本地执行只允许跑本轮你自己的草稿目录、或辅助技能面暴露的脚本；其他位置一律不放行（跨会话与平台实现都不可触）。需要平台能力时走统一入口，形态以运行态技能文档「serve 运行态的调用形态」一节为准',
  },
  // 计划前置：worker 不得在宿主评估前直调平台执行入口。状态字（PLAN ACTIVE）在系统提示词。
  SERVE_PLAN_NOT_ACTIVE: {
    text: '尚无宿主激活的平台计划；先提交 JSON calls 方案等待宿主评估。',
  },
  // 形态解析不出 operation：缺 mode、缺脚本路径、或用了未注册的形式。门答不出"这是哪个
  // operation"，于是也答不出该不该计划、挂哪条 label——而这个形状恰恰是 worker **猜**出来
  // 的（A1 实测根因：平台清单的 command 与真实脚本名不一致，它无从机械构造命令，只能猜
  // `<网关> payroll.validate <路径>`，被连拦五次后放弃平台、自己包 wrapper 跑执行器）。
  //
  // 为什么旧理由不够用：它只说"形状不合法 / 尚无激活计划"，没告诉 worker 正确形状从哪来，
  // 于是它猜第二次、第三次，最后绕开平台。这里**只指路**——每个 operation 的脚本路径与开放
  // mode 都在平台清单的机器可读面（`operation list --json` 的 script / serve 字段），推导
  // 留给调用方做。
  //
  // 三条纪律（本表头部纪律②的延伸，缺一即第二份真相）：
  //   ① 不出现网关可执行名（唯一真相在平台契约常量与技能文档，不在拒绝理由里）；
  //   ② 不复述完整调用形状——抄进来的那一份随平台演进过期，而 worker 在**做错的那一刻**
  //      看到它，最把这句话当真相，于是照着一个过期形状撞门；
  //   ③ 零业务词、零平台实现细节（脚本名/路径/清单文件一律不进消息）。
  SERVE_INVOCATION_FORM_UNKNOWN: {
    text: '该调用形态解析不出 operation（缺 mode、缺脚本路径，或用了未注册的形式）。每个 operation 的脚本路径与可用 mode 以平台清单（operation list --json）的 script / serve 字段为准，据此组装后再调用',
  },
};

/** 码是否已登记。 */
export function has(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE, code);
}

/** 取条目；未知码 fail-loud（绝不静默 fallback 到通用消息）。 */
function entryOf(code: string): CodeEntry {
  const entry = TABLE[code];
  if (!entry) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 错误码未登记: ${code}——新失败模式先往 packages/agent/src/error-codes.ts 加码（错误类给 expected + correctForm，状态话术给 text），绝不在出事点拼消息、绝不静默 fallback 到通用消息`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: code },
    );
  }
  return entry;
}

/** 实际值渲染：字符串原样，其余 JSON 化（脏输入要可辨认）；缺省给（未提供）。 */
function show(value: unknown): string {
  if (value === undefined || value === null) return '（未提供）';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function render(code: string, actual?: unknown, correctForm?: string, params?: Readonly<Record<string, string | number>>): string {
  const entry = entryOf(code);
  if ('text' in entry) {
    // 消息模板不是错误：给它传 actual/correctForm 是调用方误用，fail-loud——
    // 静默忽略会把"话术被悄悄加了动态部分"藏起来。
    if (actual !== undefined || correctForm !== undefined) {
      throw Object.assign(
        new Error(`${UNKNOWN_ERROR_CODE}: 消息模板类码不接受 actual/correctForm（它不是错误，没有三要素）: ${code}`),
        { code: UNKNOWN_ERROR_CODE, unknownCode: code },
      );
    }
    // 声明了 params 的条目必须经参数出口渲染（漏传/多传/少传都 fail-loud，见 fillParams）；
    // 没声明的条目传参数同样是误用——它没有占位符，参数只会被静默丢掉。
    if (entry.params) return fillParams(code, entry, params);
    if (params !== undefined) {
      throw Object.assign(
        new Error(`${UNKNOWN_ERROR_CODE}: 该消息模板未声明占位符，不接受参数: ${code}（要加动态部分先在本表条目里声明 params）`),
        { code: UNKNOWN_ERROR_CODE, unknownCode: code },
      );
    }
    return entry.text;
  }
  const actualText = actual === undefined ? show(entry.actual) : show(actual);
  const form = correctForm === undefined ? entry.correctForm : correctForm;
  return `${code}: 期望 ${entry.expected}；实际 ${actualText}；正确形态 ${form}`;
}

/** `{name}` 占位符：声明过的名字一个不能少，没声明的名字给了也是误用。 */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * 参数化消息模板渲染（serve 门拒绝理由一族）：表内模板 + 调用方数据机械组装。
 *
 * 与选择类澄清（clarificationTextFor）/平台健康（platformUnavailableTextFor）同族——动态
 * 部分是**数据**不是措辞，因此不经 messageFor 的 actual 通道（消息模板传 actual 会 fail-loud）。
 * 差别只在通用性：那两条各有专用出口（信封数据 / 宿主时钟），这一条给门用，占位符名单
 * 声明在条目里，一个出口覆盖全部 SERVE_* 码——不为每个路径拼一条消息。
 *
 * fail-loud 三条（静默忽略会把"话术缺了动态部分"藏起来，而那正是拒不出理由的事故形态）：
 * 漏传参数对象、少给某个占位符、多给未声明的占位符。
 */
function fillParams(code: string, entry: MessageCodeEntry, params?: Readonly<Record<string, string | number>>): string {
  const declared = entry.params ?? [];
  if (!params) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 参数化消息模板必须带参数: ${code}（占位符：${declared.join(' / ')}）`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: code },
    );
  }
  const extra = Object.keys(params).filter((key) => !declared.includes(key));
  if (extra.length > 0) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 参数化消息模板收到未声明的参数: ${code}（未声明：${extra.join(' / ')}；已声明：${declared.join(' / ')}）`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: code },
    );
  }
  const missing = declared.filter((name) => params[name] === undefined);
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 参数化消息模板缺少参数: ${code}（缺：${missing.join(' / ')}）`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: code },
    );
  }
  // 函数式 replacement：路径里的 `$&` / `$1` 不会被当成替换 pattern（与澄清模板同一写法）
  return entry.text.replace(PLACEHOLDER_RE, (_match, name: string) => String(params[name]));
}

/** 统一入口（镜像 17dz 的 messageFor）：错误类走三要素，模板类走文本。 */
export function messageFor(code: string, actual?: unknown, correctForm?: string): string {
  return render(code, actual, correctForm);
}

/**
 * 消息模板类码的文本（错误类码误用此处同样 fail-loud，由 render 分流）。
 * 条目声明了 params 时才接受第二个参数：动态值（动词/路径/字节数）是数据，机械填充。
 */
export function messageTextFor(code: string, params?: Readonly<Record<string, string | number>>): string {
  return render(code, undefined, undefined, params);
}

/** 选择类澄清候选清单的渲染上限：平台一次可能返回很多相近名，全列会把澄清问题变成一张长清单。 */
const SELECTION_CANDIDATE_LIMIT = 8;
/** 单个候选名的长度上限：数据卫生（超长名字截断），不是措辞。 */
const SELECTION_CANDIDATE_NAME_LIMIT = 40;

/**
 * 平台选择类码 → 本表消息模板码。选择类码集合在 platform-contract.ts（唯一信封适配层），
 * 用户可见措辞在本表；这张索引是两者之间唯一的一条线。新增选择类模式时两处各加一行，
 * error-codes.test.ts 机械锁两条线覆盖一致——漏登记任何一侧都会红。
 */
const SELECTION_CLARIFICATION_TEMPLATES: Readonly<Record<string, string>> = {
  ACCOUNT_SET_AMBIGUOUS: 'AMBIGUOUS_SELECTION',
  ACCOUNT_SET_NOT_FOUND: 'NOT_FOUND_SELECTION',
};

/**
 * 选择类澄清消息：表内模板 + 平台信封数据机械组装（任务 1 的渲染出口）。
 *
 * 与 messageFor 的分流：动态部分是**数据**（用户查询词、平台候选名、平台 correctForm），
 * 不是三要素里的"实际值"——它们要进用户回复，因此不给消息模板传 actual（那会 fail-loud，
 * 见 render）。入参是**平台错误码**（信封里的那个），模板码经 SELECTION_CLARIFICATION_TEMPLATES
 * 解析；未登记的码 fail-loud（与未知码同纪律：绝不静默 fallback 到通用问句）。
 * 占位符替换用函数式 replacement：查询词里的 `$&` 之类序列不会被当成替换pattern。
 *
 * `{hint}` 槽位（L2 渲染层）：优先取信封携带的平台 correctForm（**平台下发**数据，
 * 宿主不持其措辞）；信封没带时才用表内 hintFallback（宿主兜底，挂「遗留待清」）。
 * 两者都缺（未登记兜底的码，如 AMBIGUOUS_SELECTION）→ 空串，模板其余部分照常成立，
 * 不出现空泛占位符。
 */
export function clarificationTextFor(code: string, data: { query: string; candidates: readonly string[]; correctForm?: string }): string {
  const templateCode = SELECTION_CLARIFICATION_TEMPLATES[code];
  if (!templateCode) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 未登记的选择类澄清码: ${code}——平台侧新增选择类模式时，往 packages/agent/src/platform-contract.ts 的 SELECTION_CLARIFICATION_CODES 加码，并往本表加对应消息模板`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: code },
    );
  }
  const entry = entryOf(templateCode);
  if (!('text' in entry)) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 选择类澄清只接受消息模板类码（它没有三要素）: ${templateCode}`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: templateCode },
    );
  }
  const names = data.candidates.slice(0, SELECTION_CANDIDATE_LIMIT).map((name, index) => {
    const shown = name.length > SELECTION_CANDIDATE_NAME_LIMIT ? `${name.slice(0, SELECTION_CANDIDATE_NAME_LIMIT)}…` : name;
    return `${index + 1}. ${shown}`;
  });
  if (data.candidates.length > SELECTION_CANDIDATE_LIMIT) names.push(`…等 ${data.candidates.length} 个`);
  const hint = data.correctForm?.trim() || entry.hintFallback || '';
  return entry.text
    .replace('{query}', () => data.query.trim() || '您指定的对象')
    .replace('{n}', () => String(data.candidates.length))
    .replace('{list}', () => names.join(' '))
    .replace('{hint}', () => hint);
}

/**
 * 平台健康冷却话术（Lane 2）：表内模板 + 剩余分钟数机械组装。
 *
 * 分钟数是**宿主时钟数据**（冷却剩余量），与澄清模板的信封数据同族——动态部分是数据
 * 不是措辞，因此不经 messageFor 的 actual 通道（消息模板传 actual 会 fail-loud，纪律
 * 不变）。取整规则：向上取整且至少 1（"约 0 分钟"不是人话）；非有限值按 1 兜底——
 * 宿主自己算的数不值得为此失败一个回合，但 NaN 也绝不能渲染给用户。
 */
export function platformUnavailableTextFor(minutes: number): string {
  const entry = entryOf('PLATFORM_UNAVAILABLE');
  if (!('text' in entry)) {
    throw Object.assign(
      new Error(`${UNKNOWN_ERROR_CODE}: 平台健康话术只接受消息模板类码（它没有三要素）: PLATFORM_UNAVAILABLE`),
      { code: UNKNOWN_ERROR_CODE, unknownCode: 'PLATFORM_UNAVAILABLE' },
    );
  }
  const shown = Number.isFinite(minutes) ? Math.max(1, Math.ceil(minutes)) : 1;
  // 函数式 replacement：分钟数是数字，没有 $& 之类的替换pattern 歧义（与澄清模板同一写法）
  return entry.text.replace('{minutes}', () => String(shown));
}

/** throw 站点专用：三要素消息 + 原码挂回 error.code（调用方继续认码）。 */
export function errorFor(code: string, actual?: unknown, correctForm?: string): Error {
  return Object.assign(new Error(messageFor(code, actual, correctForm)), { code });
}

/** ToolUserError 站点专用：消息来自表，原码挂回 error.code（语义 = 该文本成本轮回复）。 */
export function toolUserErrorFor(code: string, actual?: unknown, correctForm?: string): ToolUserError {
  return Object.assign(new ToolUserError(messageFor(code, actual, correctForm)), { code });
}
