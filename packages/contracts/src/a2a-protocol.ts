/**
 * A2A 私有协议契约（宿主 ↔ 执行层 agent）。
 *
 * 本文件只持有协议词汇：委派块、执行许可裁决状态、失败分类及各方的义务说明。
 * 定位是 fshine（宿主）与执行层 agent 之间的私有薄协议——宿主定约与执法，执行层
 * 声明与实现，worker 上下文是"协议义务 + 任务实例"的投影。全文见 docs/a2a-protocol.md
 * （设计冻结稿）。
 *
 * 边界：这里不含任何网关名、脚本路径或执行层业务字段。那些属于执行层适配边界
 * （迁移期收口在 packages/agent/src/platform-contract.ts），协议语义本身不依赖它们。
 */

/** 协议版本；随委派块下行，执行层据此识别契约，不认识的版本按协议拒绝。 */
export const A2A_PROTOCOL_VERSION = '1.0' as const;

/**
 * 执行许可裁决状态：宿主对 worker 提交计划（calls）的裁决结果集。
 *
 * 只把既有语义收窄为字面量类型，不引入新状态。各状态的回合义务见
 * docs/a2a-protocol.md 生命周期第③阶段；worker 不得自行把一个状态解释成另一个。
 */
export type PlanAdjudicationState =
  /** 计划获准：worker 按提交的单子执行；范围变化须重提完整 calls。 */
  | 'PLAN_ACTIVE'
  /** 计划被拒：worker 按拒绝原因修正后重提。 */
  | 'PLAN_DECLINED'
  /** 计划需真实用户确认：worker 立即结束回合，不轮询、不等待。 */
  | 'PLAN_NEEDS_USER_CONFIRM'
  /** 计划暂挂：worker 结束本回合，等待宿主后续唤醒。 */
  | 'PLAN_PAUSED'
  /** 计划终止：worker 停止执行并向宿主报告原因。 */
  | 'PLAN_STOP';

/**
 * 失败分类：报告阶段失败终稿的五类互斥词汇。
 *
 * worker 按逐类义务分类上报，宿主按逐类送达义务保证用户拿到可行动的反馈——
 * 失败也是终稿，不允许静默吞掉或无限试探。判定方与双方义务的权威口径见
 * FAILURE_CLASS_POLICIES 与 docs/a2a-protocol.md 的失败分类表。
 */
export type FailureClass =
  | 'NEEDS_INPUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PLATFORM_ERROR'
  | 'RESOURCE_EXHAUSTED'
  | 'HARD_REJECTED';

/** 单个失败分类的协议义务说明（判定方 + worker 义务 + 宿主送达义务）。 */
export interface FailureClassPolicy {
  /** 谁有权作出该分类的判定；其他参与方不得改判。 */
  readonly judgedBy: string;
  /** worker 报告该分类时的义务：要报什么、不许做什么。 */
  readonly workerDuty: string;
  /** 宿主收到该分类后对用户的送达义务（送达形态与附带入口）。 */
  readonly hostDelivery: string;
}

/**
 * 五类失败的判定方与双方义务（权威口径；docs/a2a-protocol.md 的失败分类表与本表同源）。
 *
 * 用 Record<FailureClass, …> 钉死穷举：新增分类必须同时补齐义务说明才能通过类型检查。
 */
export const FAILURE_CLASS_POLICIES: Readonly<Record<FailureClass, FailureClassPolicy>> = {
  NEEDS_INPUT: {
    judgedBy: 'worker 判定',
    workerDuty: '报出具体缺口（缺哪项输入、为什么必须由用户提供），不臆测、不代用户编造',
    hostDelivery: '把缺口原样送达用户，不改写、不折损',
  },
  CAPABILITY_UNAVAILABLE: {
    judgedBy: 'worker / 执行层门判定',
    workerDuty: '报清能力边界（做什么不在许可范围），不给绕行方案、不越界试探',
    hostDelivery: '把能力边界送达用户',
  },
  PLATFORM_ERROR: {
    judgedBy: '执行层判定',
    workerDuty: '如实转告执行层返回的错误，不换口径反复试探、不掩盖原因',
    hostDelivery: '送达错误说明，并附重试提示',
  },
  RESOURCE_EXHAUSTED: {
    judgedBy: '宿主判定（预算/时限耗尽）',
    workerDuty: '先交出已完成部分：产物引用 + 下一步的一句话，保证续跑接得上',
    hostDelivery: '送达已完成部分与下一步，并附续跑入口',
  },
  HARD_REJECTED: {
    judgedBy: '执行层判定（硬拒绝）',
    workerDuty: '立即停止执行，不重试、不变体重提',
    hostDelivery: '把拒绝结果送达用户',
  },
};

/**
 * 委派块：宿主 → worker 的任务载荷（生命周期第①阶段，走 user message 下行）。
 *
 * 逐任务的边界只随载荷走，不进系统提示词——系统提示词保持纯静态，只含协议规则
 * （其中包括"只执行委派块声明的范围"）。执行层按自己的实体授权对 entities 做复核，
 * 宿主不解释其中的业务语义。
 */
export interface DelegationBlock {
  /** 本步加工后的请求原文。 */
  readonly request: string;
  /** 本次委派声明的实体清单；执行层按自己的实体授权复核。 */
  readonly entities: readonly string[];
  /** 工作区标识，由执行层解析为具体执行环境。 */
  readonly workspace: string;
  /** 输入清单（附件/数据的位置或引用，逐项列出）。 */
  readonly inputs: readonly string[];
  /** 契约版本，取值为 A2A_PROTOCOL_VERSION。 */
  readonly protocolVersion: string;
}
