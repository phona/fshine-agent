/** 工具调用阶段的进度模板:埋点事实渲染,开发者为每个工具维护一条。 */
import { ROUTE_CURRENT_TURN_TOOL_NAME } from './turn-contract';

/**
 * 宿主内部工具（回合契约 + 历史检索）：它们描述的是宿主自己的编排机制，不是
 * "用户即将看到什么"。进度帧对它们没有任何信息量，而工具名本身就是系统提示词
 * 明令不许出现的字样（"不许出现 route_current_turn…"）——所以一律不发帧，
 * 既不发默认帧，也不发模型自填短语：整条链路对内部工具静默。
 */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  ROUTE_CURRENT_TURN_TOOL_NAME,
  'search_history',
  'get_messages',
]);

/** 模型自填进度短语的长度上限：进度帧是流式通道的一条短消息，超长即截断。 */
export const PROGRESS_PHRASE_LIMIT = 50;

/**
 * 内部协议特征（形状判定，不猜语义）：模型把工具结果/协议材料复读进 progress 时，
 * 命中任意一条就把整条短语丢弃——任务编号、协议信封字段、步骤前缀、英文 JSON
 * 结构都是确定性的，宁可丢一句话，也不把内部材料送上用户的屏幕。
 */
const PROGRESS_LEAK_MARKERS: readonly RegExp[] = [
  /\btask_[A-Za-z0-9_-]+/u, // 子任务编号
  /\bplan_[A-Za-z0-9_-]+/u, // 计划编号
  /\brecorded\b/u, // 协议信封字段
  /\bworker_[A-Za-z0-9_]+/u, // SDK 会话内部事件名
  /\bcontinueTaskId\b/u, // 续跑编号字段
  /\broute_current_turn\b/u, // 宿主内部工具名
  /第\s*\d+\s*\/\s*\d+\s*步/u, // 计划步骤协议前缀
  /[{}\[\]]/u, // JSON 容器
  /"[A-Za-z_][\w-]*"\s*:/u, // 英文 JSON 键值对
];

/**
 * 钳制模型自填的进度短语：命中内部协议特征 → 空串（整条丢弃，调用方回落默认帧或
 * 静默）；超长 → 截断到 PROGRESS_PHRASE_LIMIT。返回空串表示"这条短语不可用"。
 */
export function clampProgressPhrase(phrase: string): string {
  const text = phrase.trim();
  if (!text) return '';
  if (PROGRESS_LEAK_MARKERS.some((marker) => marker.test(text))) return '';
  return text.length > PROGRESS_PHRASE_LIMIT ? `${text.slice(0, PROGRESS_PHRASE_LIMIT)}…` : text;
}

/**
 * 默认进度帧（L6 沉积清理后）：主 Agent 工具面早已只剩宿主内部工具
 * （route_current_turn / search_history / get_messages）与 run_17dz_task 委派——
 * 直接平台工具（search_account_sets 等）已退役，其具名帧与 accountSetId→名称
 * 查找（rememberAccountSets）随之删除。剩余工具一律回退到通用工具名模板；
 * 宿主内部工具仍静默（null）。帧文本仍由 renderToolStepText 一处合成。
 */
export function defaultStepText(toolName: string): string | null {
  // 宿主内部工具没有"用户可见动作"：静默，绝不回退成"正在调用 <内部工具名>…"
  // ——那正是系统提示词点名不许出现的字样。
  if (INTERNAL_TOOLS.has(toolName)) return null;
  return `正在调用 ${toolName}…`;
}

/**
 * 工具调用进度帧的唯一入口（driver 的 onStep 调用处用它）：模型自填短语优先
 * （钳制之后），否则回落工具模板；内部工具或短语不可用时返回 null。
 *
 * 返回 null 时 driver 必须跳过 onStep——空串进度帧会在渠道上投出一条空消息，
 * 比不发帧更糟（渠道侧只做节流与硬顶，不过滤空文本）。
 */
export function renderToolStepText(toolName: string, phrase: string): string | null {
  if (INTERNAL_TOOLS.has(toolName)) return null;
  return clampProgressPhrase(phrase) || defaultStepText(toolName);
}
