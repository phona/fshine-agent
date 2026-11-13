/**
 * 宿主 ↔ 执行层最小运行时契约（Minimal Reset 后的存活面）。
 *
 * 本文件只保留被生产闭包消费的类型：`DiscoveredTool`（模型可见工具定义，由
 * driver-contract / execution-runtime / pi-driver 使用）。旧 runtime 契约的
 * TrustedContext / AgentRuntime / AgentReply / TurnInputContext /
 * PendingPlanConfirmationContext 等全符号零消费，随 2026-11-13 R1 清理删除
 * （登记见 docs/decision-log.md §十四）。
 */

/** Model-visible tool definition. */
export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
