/**
 * 返回给 runtime 前的结果裁剪(17dz-mcp-spec §11.7)。
 * 只影响给 runtime 的视图:原始信封留在 host 内(审计另存),不被修改。
 */
import type { ToolOutcome } from '@fshine/contracts';
import { isRecord } from './utils';

const MAX_TOP_LEVEL_ARRAY_ITEMS = 10;
const TRUNCATION_MARKER = '[…已截断]';

export function trimForRuntime(outcome: ToolOutcome, maxChars = 4000): ToolOutcome {
  if (!outcome.ok) return outcome; // 错误信封体积小,原样透传
  const data = trimData(outcome.data, maxChars);
  if (data === outcome.data) return outcome;
  return { ok: true, data, meta: outcome.meta };
}

function trimData(data: unknown, maxChars: number): unknown {
  let current = data;
  if (isRecord(current)) {
    let trimmed = false;
    const copy: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(current)) {
      if (Array.isArray(value) && value.length > MAX_TOP_LEVEL_ARRAY_ITEMS) {
        copy[key] = value.slice(0, MAX_TOP_LEVEL_ARRAY_ITEMS);
        copy[`_${key}Truncated`] = `总数${value.length}`;
        trimmed = true;
      }
    }
    if (trimmed) current = copy;
  }
  let json: string;
  try {
    json = JSON.stringify(current) ?? String(current);
  } catch {
    json = String(current);
  }
  if (json.length > maxChars) {
    return `${json.slice(0, Math.max(0, maxChars))}${TRUNCATION_MARKER}`;
  }
  return current;
}
