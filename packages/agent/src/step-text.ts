/** 工具调用阶段的进度模板:埋点事实渲染,开发者为每个工具维护一条。 */
import { hasServerPath } from './server-paths';

/**
 * 模型自填进度短语的长度上限：进度帧是流式通道的一条短消息，超长即截断。
 */
export const PROGRESS_PHRASE_LIMIT = 50;

/**
 * 内部协议特征（形状判定，不猜语义）：模型把工具结果/协议材料复读进 progress 时，
 * 命中任意一条就把整条短语丢弃——任务编号、协议信封字段、步骤前缀、英文 JSON
 * 结构都是确定性的，宁可丢一句话，也不把内部材料送上用户的屏幕。
 *
 * `route_current_turn` 词条随申报层正式删除（2026-11-12）：该工具与名字已不在任何
 * 生产代码里，词条失去对象，不留在名单里冒充防线。
 */
const PROGRESS_LEAK_MARKERS: readonly RegExp[] = [
  /\btask_[A-Za-z0-9_-]+/u, // 子任务编号
  /\bplan_[A-Za-z0-9_-]+/u, // 计划编号
  /\brecorded\b/u, // 协议信封字段
  /\bworker_[A-Za-z0-9_]+/u, // SDK 会话内部事件名
  /\bcontinueTaskId\b/u, // 续跑编号字段
  /第\s*\d+\s*\/\s*\d+\s*步/u, // 计划步骤协议前缀
  /[{}\[\]]/u, // JSON 容器
  /"[A-Za-z_][\w-]*"\s*:/u, // 英文 JSON 键值对
];

/**
 * 钳制模型自填的进度短语：命中内部协议特征 → 空串（整条丢弃，调用方回落默认帧或
 * 静默）；超长 → 截断到 PROGRESS_PHRASE_LIMIT。返回空串表示"这条短语不可用"。
 *
 * 服务器路径与协议材料同族（判据用宿主那把 `hasServerPath`，与终稿出口同一把尺）：
 * 短语是模型自己写的一句话，带上路径时整条丢而不是"删掉路径留着话"——后者只会给
 * 用户剩一句主语残缺的话。带 `task_` 的形状早被下面的协议特征拦下，补这条堵的是
 * 不带 `task_` 的路径（附件暂存 `tmp/attachments/<uuid>-文件名.xlsx`）。
 */
export function clampProgressPhrase(phrase: string): string {
  const text = phrase.trim();
  if (!text) return '';
  if (PROGRESS_LEAK_MARKERS.some((marker) => marker.test(text))) return '';
  if (hasServerPath(text)) return '';
  return text.length > PROGRESS_PHRASE_LIMIT ? `${text.slice(0, PROGRESS_PHRASE_LIMIT)}…` : text;
}

/**
 * 默认进度帧（L6 沉积清理 + 申报层删除后）：主 Agent 工具面只剩委派工具（缺省
 * run_task，实例名经 profile.toolName 声明）、read_skill、task_control、resend_artifact
 * ——直接平台工具已退役，其具名帧随之删除。剩余工具一律回退到通用工具名模板。
 */
export function defaultStepText(toolName: string): string {
  return `正在调用 ${toolName}…`;
}

/**
 * 工具调用进度帧的唯一入口（driver 的 onStep 调用处用它）：模型自填短语优先
 * （钳制之后），否则回落工具模板。申报层删除后工具面全部是"用户可见动作"类的工具，
 * 不再有整链路静默的内部工具——本函数恒返回一帧非空文本。
 */
export function renderToolStepText(toolName: string, phrase: string): string {
  return clampProgressPhrase(phrase) || defaultStepText(toolName);
}
