/**
 * 五类失败分类的宿主送达义务收口（C4）。
 *
 * 职责只有两件：
 *   1. 把 C3 的 runtime 五档（cancelled / timeout / model_transient / auth /
 *      executor_error）映射到协议五类（NEEDS_INPUT / CAPABILITY_UNAVAILABLE /
 *      PLATFORM_ERROR / RESOURCE_EXHAUSTED / HARD_REJECTED），本地五档保留为
 *      audit sub-reason，可归因。
 *   2. 按协议类选择用户话术——措辞仍取 error-codes.ts / resource-exhausted.ts
 *      的既有单一来源，本模块不产生第二份用户回复要求。
 *
 * 未分类（unclassified）不离网：记 unclassified 并走既有兜底话术。
 *
 * 当前生产者缺口（W5 尾程登记，待 worker 侧结构化失败上报通道落地后补齐）：
 *   · CAPABILITY_UNAVAILABLE / HARD_REJECTED：runtime 五档无对应生产者，error-codes.ts
 *     已补 DELEGATION_CAPABILITY_UNAVAILABLE / DELEGATION_HARD_REJECTED（cabadae），
 *     但生产路径仍不可达（worker 侧结构化失败上报通道尚不存在）。
 *   · NEEDS_INPUT 的 needs 分支：需调用方传入 needs 缺口，当前 context.ts 未传。
 *   · RESOURCE_EXHAUSTED 的 needsEnrichment 分支：需 platformTasks + principalId +
 *     sessionId 且 subReason 非 timeout，当前 failureClassFor 只把 timeout 映射到
 *     RESOURCE_EXHAUSTED，因此该分支不可达。
 *
 * auditFields 独立产物：deliverFailure 返回 auditFields（protocolClass / subReason /
 * code / needs / degraded / needsRecordLoad），调用方 context.ts 仅用 code 挂回
 * error.code；其余字段当前仅通过 delegation_span / subagent_task_failed 事件间接
 * 留档，未写入独立审计表。待 owner 确认是否追加独立审计产物。
 */

import type { FailureClass, FailureClassPolicy } from '@fshine/contracts';
import { FAILURE_CLASS_POLICIES } from '@fshine/contracts';
import { RESOURCE_EXHAUSTED_CLASS } from './resource-exhausted';
import { toolUserErrorFor } from './error-codes';
import { renderNeedsUserText } from './turn-relay';
import { renderResourceExhaustedReply } from './resource-exhausted';
import type { DelegationFailureClass } from './delegation-failure';
import type { PlatformTaskRepo, TrustedContext } from '@fshine/contracts';

/** 协议分类 + 本地 runtime 子原因（审计可归因）。 */
export interface ClassifiedFailure {
  protocolClass: FailureClass;
  subReason: DelegationFailureClass;
}

/**
 * 把 C3 的 runtime 五档映射到协议五类。
 *
 * 映射原则（来自 a2a-protocol.md 失败分类表 + 现行路径审计）：
 *   · cancelled     → NEEDS_INPUT（用户主动中止 = 需要用户重新提供输入/确认）
 *   · timeout       → RESOURCE_EXHAUSTED（时限/预算耗尽，现行路径已被 runtime.ts
 *                      的 DELEGATION_TIMEOUT_FAILURE 拦截并 enrich 为 RESOURCE_EXHAUSTED）
 *   · model_transient → PLATFORM_ERROR（模型侧瞬时失败，属平台层抖动）
 *   · auth          → PLATFORM_ERROR（平台登录态异常，属平台错误）
 *   · executor_error → PLATFORM_ERROR（执行器故障，属平台错误）
 *
 * 本地五档（cancelled / timeout / model_transient / auth / executor_error）
 * 作为 audit sub-reason 保留，不替换。
 */
export function failureClassFor(delegationFailure: DelegationFailureClass): ClassifiedFailure {
  switch (delegationFailure) {
    case 'cancelled':
      return { protocolClass: 'NEEDS_INPUT', subReason: 'cancelled' };
    case 'timeout':
      return { protocolClass: 'RESOURCE_EXHAUSTED', subReason: 'timeout' };
    case 'model_transient':
      return { protocolClass: 'PLATFORM_ERROR', subReason: 'model_transient' };
    case 'auth':
      return { protocolClass: 'PLATFORM_ERROR', subReason: 'auth' };
    case 'executor_error':
      return { protocolClass: 'PLATFORM_ERROR', subReason: 'executor_error' };
    default:
      // 未知不离网：记 unclassified 并走既有兜底话术。
      return { protocolClass: 'PLATFORM_ERROR', subReason: delegationFailure };
  }
}

/** 五类协议失败的送达义务（judgedBy / workerDuty / hostDelivery）。 */
export function policyOf(failureClass: FailureClass): FailureClassPolicy {
  return FAILURE_CLASS_POLICIES[failureClass];
}

/**
 * 按协议类与本地子原因组装用户话术 + 审计字段。
 *
 * 措辞来源：
 *   · NEEDS_INPUT：原样转达缺口（由调用方传入 needs，本模块不构造）；
 *   · CAPABILITY_UNAVAILABLE：能力边界消息（error-codes.ts 已有 DELEGATION_CAPABILITY_UNAVAILABLE 条目，cabadae 补档）；
 *   · PLATFORM_ERROR：按 sub-reason 选 error-codes.ts 既有话术（auth /
 *     model_transient / executor_error 各有一条）；
 *   · RESOURCE_EXHAUSTED：复用 renderResourceExhaustedReply（resource-exhausted.ts）；
 *   · HARD_REJECTED：拒绝结果消息（error-codes.ts 已有 DELEGATION_HARD_REJECTED 条目，cabadae 补档）。
 *
 * 本函数不产生第二份用户回复要求——所有措辞均来自上述单一来源。
 */
export interface DeliverFailureInput {
  classification: ClassifiedFailure;
  /** NEEDS_INPUT 的缺口内容（仅 NEEDS_INPUT 时使用）。 */
  needs?: { missing: string[]; reason: string; suggestion: string };
  /** 执行事实（仅 RESOURCE_EXHAUSTED 时使用）。 */
  platformTasks?: PlatformTaskRepo;
  principalId?: string;
  sessionId?: string;
  continueTaskId?: string;
  requestId?: string;
  doneSteps?: string[];
}

export interface DeliverFailureResult {
  /** 用户话术（ToolUserError.message 或结构化 needs）。 */
  userMessage: string;
  /** 审计字段（进 delegation_span / subagent_task_failed）。 */
  auditFields: Record<string, unknown>;
  /** 是否需要宿主继续 enrich（如 RESOURCE_EXHAUSTED 需 runtime.ts 补底账）。 */
  needsEnrichment: boolean;
}

export function deliverFailure(input: DeliverFailureInput): DeliverFailureResult {
  const { classification, needs, platformTasks, principalId, sessionId, continueTaskId, requestId, doneSteps } = input;
  const { protocolClass, subReason } = classification;

  switch (protocolClass) {
    case 'NEEDS_INPUT': {
      // cancelled 映射到 NEEDS_INPUT，但用户话术应是"已取消"而非"请补充信息"。
      if (subReason === 'cancelled' && !needs) {
        const userMessage = toolUserErrorFor('DELEGATION_CANCELLED').message;
        return {
          userMessage,
          auditFields: { protocolClass, subReason, code: 'DELEGATION_CANCELLED' },
          needsEnrichment: false,
        };
      }
      // 原样转达缺口，不改写、不折损——措辞取单一来源 renderNeedsUserText。
      const userMessage = needs
        ? renderNeedsUserText(needs, '')
        : '需要用户补充信息。';
      return {
        userMessage,
        auditFields: { protocolClass, subReason, needs: needs ?? null },
        needsEnrichment: false,
      };
    }
    case 'CAPABILITY_UNAVAILABLE': {
      const userMessage = toolUserErrorFor('DELEGATION_CAPABILITY_UNAVAILABLE').message;
      return {
        userMessage,
        auditFields: { protocolClass, subReason, code: 'DELEGATION_CAPABILITY_UNAVAILABLE' },
        needsEnrichment: false,
      };
    }
    case 'PLATFORM_ERROR': {
      // 按本地子原因选 error-codes.ts 既有话术。
      let message: string;
      let code: string;
      switch (subReason) {
        case 'auth':
          message = toolUserErrorFor('DELEGATION_AUTH_FAILURE').message;
          code = 'DELEGATION_AUTH_FAILURE';
          break;
        case 'model_transient':
          message = toolUserErrorFor('DELEGATION_MODEL_TRANSIENT_FAILURE').message;
          code = 'DELEGATION_MODEL_TRANSIENT_FAILURE';
          break;
        case 'executor_error':
          message = toolUserErrorFor('DELEGATION_EXECUTOR_FAILURE').message;
          code = 'DELEGATION_EXECUTOR_FAILURE';
          break;
        default:
          message = toolUserErrorFor('DELEGATION_EXECUTOR_FAILURE').message;
          code = 'DELEGATION_EXECUTOR_FAILURE';
      }
      return {
        userMessage: message,
        auditFields: { protocolClass, subReason, code },
        needsEnrichment: false,
      };
    }
    case 'RESOURCE_EXHAUSTED': {
      // timeout 子原因保持与 runtime.ts 的 DELEGATION_TIMEOUT_FAILURE 兼容：
      // runtime.ts 按该话术识别并 enrich 为 RESOURCE_EXHAUSTED 终稿（底账 + 续跑入口）。
      if (subReason === 'timeout') {
        const userMessage = toolUserErrorFor('DELEGATION_TIMEOUT_FAILURE').message;
        return {
          userMessage,
          auditFields: { protocolClass, subReason, code: 'DELEGATION_TIMEOUT_FAILURE' },
          needsEnrichment: false,
        };
      }
      // 复用 renderResourceExhaustedReply；若缺少底账，降级为无事实版本。
      if (!platformTasks || !principalId || !sessionId) {
        return {
          userMessage: renderResourceExhaustedReply({ record: null, doneSteps: doneSteps ?? [] }),
          auditFields: { protocolClass, subReason, degraded: true },
          needsEnrichment: false,
        };
      }
      // 需要宿主异步加载底账时标记 needsEnrichment，由 runtime.ts 补完。
      return {
        userMessage: renderResourceExhaustedReply({ record: null, doneSteps: doneSteps ?? [] }),
        auditFields: { protocolClass, subReason, needsRecordLoad: true },
        needsEnrichment: true,
      };
    }
    case 'HARD_REJECTED': {
      const userMessage = toolUserErrorFor('DELEGATION_HARD_REJECTED').message;
      return {
        userMessage,
        auditFields: { protocolClass, subReason, code: 'DELEGATION_HARD_REJECTED' },
        needsEnrichment: false,
      };
    }
    default:
      // 未知不离网：走既有兜底。
      return {
        userMessage: toolUserErrorFor('DELEGATION_EXECUTOR_FAILURE').message,
        auditFields: { protocolClass: 'PLATFORM_ERROR', subReason: 'unclassified' },
        needsEnrichment: false,
      };
  }
}
