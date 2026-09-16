/**
 * content[0].text → v0.5 信封解析(17dz-mcp-spec §6.1/§9)。
 * 纯函数:JSON.parse 成功且形状符合信封(有 data 或 error)才算通过。
 */
import { ERROR_CODES, type Envelope } from '@fshine/contracts';
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
  const meta = parsed['meta'];
  if (typeof meta['retrievedAt'] !== 'string' || meta['retrievedAt'].trim() === '') {
    return { ok: false, reason: 'meta.retrievedAt 必须是非空字符串' };
  }
  if (typeof meta['source'] !== 'string' || !['api_cache', 'api_live', 'browser', 'cache'].includes(meta['source'])) {
    return { ok: false, reason: 'meta.source 无效' };
  }
  for (const key of ['traceId', 'accountSetId', 'accountSetName']) {
    if (key in meta && typeof meta[key] !== 'string') return { ok: false, reason: `meta.${key} 必须是字符串` };
  }
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
    if (!(ERROR_CODES as readonly string[]).includes(error['code'])) return { ok: false, reason: 'error.code 无效' };
    if ('retryAfterMs' in error && (typeof error['retryAfterMs'] !== 'number' || !Number.isFinite(error['retryAfterMs']) || error['retryAfterMs'] < 0)) {
      return { ok: false, reason: 'error.retryAfterMs 必须是非负有限数字' };
    }
    if ('details' in error && !isRecord(error['details'])) return { ok: false, reason: 'error.details 必须是对象' };
    if ('artifact' in error) {
      const artifact = error['artifact'];
      if (!isRecord(artifact) || typeof artifact['id'] !== 'string' || typeof artifact['kind'] !== 'string' || typeof artifact['contentType'] !== 'string') {
        return { ok: false, reason: 'error.artifact 无效' };
      }
    }
  }
  return { ok: true, envelope: parsed as unknown as Envelope };
}
