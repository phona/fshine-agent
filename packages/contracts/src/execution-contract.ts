/**
 * 执行契约（Execution Contract）：宿主与执行层之间的最小语义面。
 *
 * 本模块只定义**语义**：类型与接口，零传输实现——不 import 任何子进程 / CLI 适配器 /
 * wire 类型的实现面（模块内零 import 语句）。依赖方向单向：适配器依赖本模块，
 * 通用运行时只依赖 ExecutionClient 接口，契约不依赖两者中任何一个。
 *
 * M1 语义集（只实现最小链路用到的）：
 *   · CapabilityManifest —— 能力快照（一次取回，按它装配工具面；不落文件、不另立名单）。
 *   · ExecutionRequest   —— 结构化执行请求。**requestId 由宿主生成**：调用身份与去重
 *     语义归宿主，模型既不能生成可信身份，也不能携带确认凭据；副作用安全重试由执行层
 *     保证（宿主只承诺 requestId 的稳定与唯一）。
 *     **dispatchKey = 稳定逻辑操作身份**（U3，见字段注释）：它在宿主**首次创建这笔逻辑
 *     操作**时生成并持久化，重试/重新规划时只能读回同一条记录；toolCallId / requestId
 *     只是本次调用的追踪号，重试会换号。
 *   · ExecutionOutcome   —— 执行状态与失败结果。六态互斥：completed / needs_confirmation /
 *     needs_input / failed / refused / accepted。**refused = 执行层策略拒绝，failed =
 *     执行失败，两者语义不得混用**；needs_input 必须携带「缺什么」的结构化描述
 *     （missing 非空）；needs_confirmation 必须携带执行层发放的确认提示（handle 非空、
 *     summary 非空）；accepted 表示执行层已受理一笔**长任务**并立即返回（operationId 非空），
 *     只有声明 `long_running: true` 的 operation 才可以返回它（未声明却返回 = 协议违约，
 *     宿主 fail-closed）。
 *   · ExecutionClient    —— 能力快照 / 执行 / 长轮询等待 / 中止四个操作。
 *
 * 刻意不在这里的东西（后续切片再定，不在这里预造执行面）：
 *   · readback（副作用验证状态）：写切片再定——不得把「执行完成」当「业务生效」；
 *   · 确认面**不是第二套协议**：写切片只在同一次 execute 上做最小增量——
 *     ① 执行层预演后返回 needs_confirmation + confirmation{handle, summary, expiresAt?}；
 *     ② 下一回合宿主把该 handle 与本回合**用户原话**原样放进 ExecutionRequest.confirmation，
 *        仍走同一次 execute。handle 对宿主不透明；冻结、操作绑定、有效期、一次性/防重放
 *        与业务校验全部归执行层。宿主只做身份、确认事件传递与用户交互，**不判断用户是不是
 *        在确认**、不拦截工具调用等批准、不排队、不裁决。
 *   · effects / requiresConfirmation / 计划治理策略 / 授权策略 / 业务字段：契约不携带
 *     治理与业务语义，它们归执行层声明各自持有；计划门与预算梯子归执行层，不在这里
 *     开第二份裁决面。
 */

/** 契约语义版本：跨宿主/执行层的结构化语义集合版本（非某实例的版本，也不是 A2A）。 */
export const EXECUTION_CONTRACT_VERSION = 4;

/**
 * 参数声明：name 是执行层接受的参数名（CLI 形态可带前缀，如 `--collection`），
 * required 由执行层声明。宿主不做业务校验，只把声明交给模型并按声明装配工具描述。
 */
export interface ExecutionArgDeclaration {
  name: string;
  required: boolean;
  /** 可选类型提示（执行层声明，如 'name' / 'code'）：只作展示与装配参考，不参与业务判断。 */
  type?: string;
}

/** 单个可执行 operation 的声明。 */
export interface ExecutionOperationDeclaration {
  /** 执行层登记的 operation 名（唯一权威 = 执行层自己的清单）。 */
  name: string;
  /** 人类可读标签：只作展示，不参与宿主的任何业务判断。 */
  label?: string;
  args: readonly ExecutionArgDeclaration[];
  /**
   * 执行层自述的成本提示：单次执行的重量（weight）与估时秒数（estimatedSeconds）。
   * 宿主原样转述进能力快照，不解释、不裁决、不做阈值判定；执行层未声明时字段不出现。
   */
  weight?: number;
  estimatedSeconds?: number;
  /**
   * 长任务声明（可选）：true = 该 operation 可能执行 30 分钟级任务，执行层可以返回
   * `accepted` 并让调用方用 `wait` 长轮询、用 `abort` 中止。未声明（缺省）的 operation
   * **不得**返回 accepted——宿主按协议违约 fail-closed，不把它当成功或进行中。
   */
  long_running?: boolean;
}

/** 能力快照：单个会话开始时的执行面声明。 */
export interface CapabilityManifest {
  contractVersion: number;
  operations: readonly ExecutionOperationDeclaration[];
}

/** 结构化执行请求。args 对宿主不透明：形状归执行层声明与校验。 */
export interface ExecutionRequest {
  /** 本次调用的追踪号（宿主生成；重试/重发会换新号，不承载操作身份）。 */
  requestId: string;
  /**
   * 稳定逻辑操作身份：**由宿主在执行边界首次创建这笔逻辑操作时生成并持久化**，
   * 之后由宿主绑定到那条已持久化记录；重试、溢出恢复后的重新调用、重新规划都只能
   * 读回同一个值，不得重新生成。它随请求在副作用之前送达执行层，执行层可据此派生
   * 外部幂等键或做状态查询（宿主义务：能用就用，查不出如实回 result_unknown）。
   * 语义边界：宿主只承诺「同一 dispatchKey 至多一次自动执行 + 结果未知可核对」，
   * **不是**业务效果 exactly-once——外部幂等键、状态查询与回读归执行层。
   */
  dispatchKey: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
  /**
   * 确认引用（可选）：只在执行层先返回 needs_confirmation 之后，由宿主在**下一回合**
   * 原样带回。`handle` 是执行层发放的不透明句柄——宿主不解析、不比较、不生成；
   * `userText` 是本回合用户原话——宿主原样透传，不改写、不判定「这是不是在确认」。
   * 它不是第二套协议：仍是同一次 execute；句柄绑定、有效期与一次性由执行层校验。
   */
  confirmation?: { handle: string; userText?: string };
}

/** 执行结果六态（互斥）。 */
export type ExecutionStatus = 'completed' | 'needs_confirmation' | 'needs_input' | 'failed' | 'refused' | 'accepted';

/**
 * 执行层返回的确认提示（needs_confirmation 必带）。
 *   · handle —— 执行层发放的不透明句柄（宿主只存与透传）；
 *   · summary —— 人可读的**机械事实**（对象/窗口/影响条数/不可撤销等），宿主原样转述；
 *   · expiresAt —— 执行层给出的有效期（ISO 时间；缺省 = 执行层不声明）。
 * 这些字段只作传递：宿主不据此裁决操作能否做、也不自行构造确认语义。
 */
export interface ConfirmationPrompt {
  handle: string;
  summary: string;
  expiresAt?: string;
}

/**
 * 「缺什么」的条目：needs_input 必须至少带一条。name 是执行层声明的输入名（若有），
 * description 是执行层给出的可转述说明（宿主不翻译、不改写）。
 */
export interface MissingInput {
  name?: string;
  description: string;
}

/**
 * 失败/拒绝的结构化原因。code 与 message 由执行层给出，details 原样透传。
 *
 * `retryable` 的**缺省语义是「不可重试」**（owner 2026-11-18）：只有执行层显式给 `true`
 * （瞬时故障：超时、网关暂不可用、被中断）才允许同一对象在本回合继续尝试；`false` 与
 * **未声明**一律按不可重试处理，宿主随即锁住该 (operation, 对象) 并把话交还用户。
 * 宁可停下报错让人介入，也不在不确定时继续撞——打爆执行层就彻底没得用。
 */
export interface ExecutionFailure {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

/**
 * 批量写入的逐条结果（completed 可选携带；owner 2026-11-19）：
 * 「部分完成」是安全相关事实——用户必须知道哪几条真写进去了。
 *   · index —— 输入记录在本次批次里的 0 基序号（执行层原样给出，宿主不改写）；
 *   · status —— ok / failed / unknown（unknown = 执行层无法确认，不得当成功）；
 *   · reason —— failed/unknown 的机械原因（执行层原话，宿主只转述）。
 * 整批原子失败时执行层返回 failed（不写任何一条），此时不携带 items；
 * 执行层若支持部分写，必须逐条给出真实状态——宿主/模型不得把 partial 说成成功。
 */
export interface ExecutionItemResult {
  index: number;
  status: 'ok' | 'failed' | 'unknown';
  reason?: string;
}

/**
 * 执行结果。
 *   · completed——执行完成（不代表业务副作用已验证生效：readback 归写切片）。
 *     `items`（可选）= 批量写的逐条真实结果；只要有一条 failed/unknown，模型必须如实
 *     说明「完成 X、未完成 Y」，不得把整体说成单纯成功（任务结局仍是 completed）。
 *   · needs_confirmation——执行层已冻结一次待确认操作，confirmation 给出句柄与机械摘要；
 *     这不是「缺输入」，也不是宿主计划门：是否继续由用户在下一回合表态，执行层校验句柄。
 *   · needs_input——执行层要求补充输入，missing 非空。
 *   · failed——执行失败。
 *   · refused——执行层策略拒绝（含门拒、请求形状拒绝、确认句柄无效/过期/已用/绑定不符）。
 *   · accepted——执行层已受理一笔长任务（仅 `long_running: true` 的 operation 可返回）：
 *     operationId 是执行层发放的不透明任务句柄（宿主只存与转交 wait/abort，不解析）；
 *     pollAfterMs 是执行层建议的轮询间隔（缺省由宿主决定）。本轮工作已经结束——
 *     宿主不把它当失败，也不当成功：任务保持进行中，由 `wait` 长轮询取回终态。
 */
export type ExecutionOutcome =
  | { status: 'completed'; data?: unknown; items?: readonly ExecutionItemResult[] }
  | { status: 'needs_confirmation'; confirmation: ConfirmationPrompt; data?: unknown }
  | { status: 'needs_input'; missing: readonly MissingInput[]; data?: unknown; error?: ExecutionFailure }
  | { status: 'failed'; error: ExecutionFailure }
  | { status: 'refused'; error: ExecutionFailure }
  | { status: 'accepted'; operationId: string; pollAfterMs?: number };

/**
 * 单次执行调用的可选取消面（契约只带「必要的取消信息」，不是第二套协议）：
 * `signal` = 宿主的取消信号。适配器观察到中止后应停止执行层工作并尽快以
 * `AbortError` 拒绝；不支持中止的适配器可以忽略它——宿主不依赖执行层配合
 * 也能终结本次任务（读路径可安全放弃；写路径按结果未知处置，见运行时）。
 */
export interface ExecutionCallOptions {
  readonly signal?: AbortSignal;
}

/** 执行层客户端：适配器实现本接口；通用运行时只依赖本接口。 */
export interface ExecutionClient {
  /** 能力快照：每个会话取一次，供装配使用。 */
  capabilities(): Promise<CapabilityManifest>;
  execute(request: ExecutionRequest, options?: ExecutionCallOptions): Promise<ExecutionOutcome>;
  /**
   * 长轮询等待一笔已受理（accepted）的长任务，最长阻塞 timeoutMs：
   *   · 完成/失败/拒绝 → 返回对应终态；
   *   · 窗口内仍未完成 → 返回 `{status:'accepted', ...}`（`running` 复用同一形状），
   *     宿主按 pollAfterMs 重排；
   *   · 宿主取消（signal 中止）→ 适配器应尽快以 AbortError 拒绝。
   * 出站调用、不开入站端口——完成即返回，天然穿 NAT。
   *
   * 可选：不支持长任务的适配器可以不实现。**声明了 `long_running: true` 却实现不了
   * wait 是装配错误**——宿主在收到 accepted 后无法等待，必须 fail-closed（不留下
   * 无人推进的进行中任务）。
   */
  wait?(operationId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecutionOutcome>;
  /**
   * 请求执行层中止一笔长任务（用户取消）。
   * 返回 `aborted: true` = 执行层已确认中止；`false` = 停不下来（执行层拒绝/未知句柄/
   * 已经结束等），宿主必须如实转述，不得宣称已取消。
   *
   * 可选：缺省 = 适配器不支持中止（宿主按「停不下来」如实报，不宣称取消）。
   */
  abort?(operationId: string, options?: ExecutionCallOptions): Promise<ExecutionAbortResult>;
}

/** 中止请求的机械结果（只有 aborted=true 才算执行层确认停掉）。 */
export type ExecutionAbortResult =
  | { aborted: true }
  | { aborted: false; reason: string };
