const NEEDS_TOOL_RESULT_PREFIX = '{"recorded":"delegate"';

/** Shape-only detector for host/worker protocol material that must not be emitted as a reply. */
export function looksLikeProtocolMaterial(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(NEEDS_TOOL_RESULT_PREFIX)
    || /^\{\s*"(?:recorded|step|next)"\s*:/.test(trimmed)
    || /^\{\s*"v"\s*:\s*1\s*,\s*"op"\s*:/.test(trimmed);
}
