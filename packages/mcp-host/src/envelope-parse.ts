/**
 * content[0].text → v0.5 信封解析(17dz-mcp-spec §6.1/§9)。
 * 纯函数:JSON.parse 成功且形状符合信封(有 data 或 error)才算通过。
 */
import type { Envelope } from '@fshine/contracts';
import { isRecord } from './utils';

export type EnvelopeParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: string };

export function parseEnvelope(text: string): EnvelopeParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'content[0].text 不是合法 JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: '信封必须是 JSON 对象' };
  const hasData = 'data' in parsed;
  const hasError = 'error' in parsed;
  if (hasData === hasError) return { ok: false, reason: '信封必须且只能包含 data 或 error 之一' };
  if (!isRecord(parsed['meta'])) return { ok: false, reason: '信封缺少 meta 对象' };
  if (hasError) {
    const error = parsed['error'];
    if (
      !isRecord(error) ||
      typeof error['code'] !== 'string' ||
      typeof error['message'] !== 'string' ||
      typeof error['retryable'] !== 'boolean'
    ) {
      return { ok: false, reason: 'error 信封缺少 code/message/retryable' };
    }
  }
  return { ok: true, envelope: parsed as unknown as Envelope };
}
