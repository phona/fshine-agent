const NEEDS_TOOL_RESULT_PREFIX = '{"recorded":"delegate"';

/** route 申报的工具名（XML 形，大小写不敏感；eval14 实测泄漏形态）。 */
const ROUTE_DECLARATION_TOOL = /<function=route_current_turn>/i;
/** 申报 XML 的标签族（与 execution-language.ts 删除集同族；这里只用于整段形状判定）。 */
const PROTOCOL_TAG = /<\/?(?:tool_call|tool_result|function|parameter)[^>]*>/gi;
/** `<parameter=名>值</parameter>` 整块（含参数值——申报的中文参数全部住在块内，不算正文）。 */
const PARAMETER_BLOCK = /<parameter=[^>]*>[\s\S]*?<\/parameter>/gi;
/** JSON 形申报的整段前导（`"kind"` 必须是首个键）。 */
const JSON_DECLARATION_HEAD = /^\s*\{\s*"kind"\s*:/;

/**
 * 整段就是 route 申报（D-144，eval14 实测 2026-10-31）：确认续跑轮的整理模型把
 * `<function=route_current_turn>` 申报原文写成正文——continueTaskId/request 的参数值本身
 * 是中文自然语言，删除式判据（删标签后"剩余非 ASCII<4"）对它失明，必须整段识别、整段替换。
 *
 * 只认两种**整段**形态，宁可窄勿宽（误伤=把正常回复整段扔掉）：
 *   · XML 形：含 `<function=route_current_turn>`（大小写不敏感），且标签与参数块之外
 *     一无所有——标签混在自然语言里的形态（D-138 第一形态）因此不命中，那由 reply-exit
 *     的删除支管，不整段替换；
 *   · JSON 形：`"kind"` 首键前导，且整段解析成一个带 request/continueTaskId 申报键的
 *     对象——正文里引用一小段 JSON 的正常回复解析必败，天然不误伤。
 *
 * 返回命中形态（供事件记账），未命中返回 null。纯形状判据，不嗅探内容。
 */
export function isWholeReplyRouteDeclaration(text: string): 'xml' | 'json' | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (ROUTE_DECLARATION_TOOL.test(trimmed)) {
    const outside = trimmed.replace(PARAMETER_BLOCK, '').replace(PROTOCOL_TAG, '');
    return outside.trim() === '' ? 'xml' : null;
  }
  if (JSON_DECLARATION_HEAD.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record['kind'] !== 'string') return null;
      return typeof record['request'] === 'string' || typeof record['continueTaskId'] === 'string'
        ? 'json'
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Shape-only detector for host/worker protocol material that must not be emitted as a reply. */
export function looksLikeProtocolMaterial(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(NEEDS_TOOL_RESULT_PREFIX)
    || /^\{\s*"(?:recorded|step|next)"\s*:/.test(trimmed)
    || /^\{\s*"v"\s*:\s*1\s*,\s*"op"\s*:/.test(trimmed)
    || isWholeReplyRouteDeclaration(text) !== null;
}
