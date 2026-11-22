/**
 * B3 结构化原因码（task 重定义 S1 后的本模块残余面）。
 *
 * 旧五态机械分类器已删（S1：宿主不再把机械事实归成「答复五态」结论；
 * 做没做成由 Main 读执行事实自己判断，eval 判据改读 executions 逐条做机械对比）。这里只保留
 * 「没有这个能力」与「这次不允许」两个**可辨的事实 + 原因码**，供宿主/执行层传给唤醒面：
 *   · `unsupported`    = 目录里根本没有这件事（没有能力），零执行、非权限拒绝；
 *   · `not_permitted`  = 能力存在但本次不允许（权限/允许集合拒绝）。
 * 两个 reason code 是结构化事实，两个 message 是各自可辨的机械原因（不是对用户的话术，
 * 用户话术由 Main 按事实自己选）。既有工具调用拒绝话术保持原样（锚点不放宽）。
 */

export const OUTCOME_REASON_NOT_PERMITTED = 'not_permitted';
export const OUTCOME_REASON_UNSUPPORTED = 'unsupported';

/** 两种情形各自可辨的机械原因（只进事实/日志，不直接对用户说）。 */
export const OUTCOME_DETAIL_UNSUPPORTED = '没有对应能力：这件事不在可办范围内。';
export const OUTCOME_DETAIL_NOT_PERMITTED = '本次不允许：这件事需要的能力当前没有开放给你。';
