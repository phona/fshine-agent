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
 *   · ExecutionOutcome   —— 执行状态与失败结果。四态互斥：completed / needs_input /
 *     failed / refused。**refused = 执行层策略拒绝，failed =
 *     执行失败，两者语义不得混用**；needs_input 必须携带「缺什么」的结构化描述
 *     （missing 非空）。
 *   · ExecutionClient    —— 能力快照 / 执行两个操作。
 *
 * 刻意不在这里的东西（后续切片再定，不在这里预造执行面）：
 *   · readback（副作用验证状态）：写切片再定——不得把「执行完成」当「业务生效」；
 *   · 确认接口：写切片采用独立 confirm(requestId, confirmationId, decision)：执行层
 *     冻结待确认操作，验可信身份 / 操作绑定 / 有效期 / 防重放；宿主只采集并传递用户
 *     决策，不是携 token 重发 execute；
 *   · effects / requiresConfirmation / 计划治理策略 / 授权策略 / 业务字段：契约不携带
 *     治理与业务语义，它们归执行层声明各自持有；计划门与预算梯子归执行层，不在这里
 *     开第二份裁决面。
 */

/** 契约语义版本：跨宿主/执行层的结构化语义集合版本（非某实例的版本，也不是 A2A）。 */
export const EXECUTION_CONTRACT_VERSION = 1;

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
}

/** 能力快照：单个会话开始时的执行面声明。 */
export interface CapabilityManifest {
  contractVersion: number;
  operations: readonly ExecutionOperationDeclaration[];
}

/** 结构化执行请求。args 对宿主不透明：形状归执行层声明与校验。 */
export interface ExecutionRequest {
  requestId: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
}

/** 执行结果四态（互斥）。 */
export type ExecutionStatus = 'completed' | 'needs_input' | 'failed' | 'refused';

/**
 * 「缺什么」的条目：needs_input 必须至少带一条。name 是执行层声明的输入名（若有），
 * description 是执行层给出的可转述说明（宿主不翻译、不改写）。
 */
export interface MissingInput {
  name?: string;
  description: string;
}

/** 失败/拒绝的结构化原因。code 与 message 由执行层给出，details 原样透传。 */
export interface ExecutionFailure {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

/**
 * 执行结果。
 *   · completed——执行完成（不代表业务副作用已验证生效：readback 归写切片）。
 *   · needs_input——执行层要求补充输入，missing 非空。
 *   · failed——执行失败。
 *   · refused——执行层策略拒绝（含门拒、请求形状拒绝）。
 */
export type ExecutionOutcome =
  | { status: 'completed'; data?: unknown }
  | { status: 'needs_input'; missing: readonly MissingInput[]; data?: unknown; error?: ExecutionFailure }
  | { status: 'failed'; error: ExecutionFailure }
  | { status: 'refused'; error: ExecutionFailure };

/** 执行层客户端：适配器实现本接口；通用运行时只依赖本接口。 */
export interface ExecutionClient {
  /** 能力快照：每个会话取一次，供装配使用。 */
  capabilities(): Promise<CapabilityManifest>;
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}
