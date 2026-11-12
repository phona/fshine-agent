const NEEDS_TOOL_RESULT_PREFIX = '{"recorded":"delegate"';

/**
 * Shape-only detector for host/worker protocol material that must not be emitted as a reply.
 *
 * 覆盖三类仍在生产的协议材料：
 *   · `{"recorded":"delegate",…}` — 纠错环/计划步交还的工具结果信封；
 *   · `{"recorded|step|next":…}` — 计划步交还的其余字段形状；
 *   · `{"v":1,"op":…}` — 平台 RESULT 信封（D-069）。
 *
 * 整段=申报的专用替换支（isWholeReplyRouteDeclaration）随申报层正式删除（2026-11-12）：
 * 申报工具已不存在、提示词不再教它，旧形态若再现只剩 reply-exit 的通用删除臂兜底
 * （标签可删、中文参数值可能残留）——按 decision-log 2.8「再次出现确定性泄漏才加回」
 * 接受，不保留一个无对象的判据冒充防线。
 */
export function looksLikeProtocolMaterial(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(NEEDS_TOOL_RESULT_PREFIX)
    || /^\{\s*"(?:recorded|step|next)"\s*:/.test(trimmed)
    || /^\{\s*"v"\s*:\s*1\s*,\s*"op"\s*:/.test(trimmed);
}
