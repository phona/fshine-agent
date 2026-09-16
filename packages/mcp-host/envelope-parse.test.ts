import { describe, expect, it } from 'vitest';
import { isErrorEnvelope } from '@fshine/contracts';
import { parseEnvelope } from './src/index';

const meta = { traceId: 'trc_x', retrievedAt: '2026-09-16T10:00:00+08:00', source: 'api_cache' } as const;

describe('parseEnvelope(验收 #8:信封解析失败用解析函数单测覆盖)', () => {
  it('成功信封解析为 Envelope', () => {
    const result = parseEnvelope(JSON.stringify({ data: { period: '202607' }, meta }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toEqual({ data: { period: '202607' }, meta });
  });

  it('错误信封解析并可通过 isErrorEnvelope 收窄', () => {
    const result = parseEnvelope(
      JSON.stringify({ error: { code: 'NEEDS_LOGIN', message: '登录失效', retryable: false }, meta }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(isErrorEnvelope(result.envelope)).toBe(true);
  });

  it('非法 JSON → 解析失败(host 报"上游返回格式异常"的来源)', () => {
    expect(parseEnvelope('not-json{').ok).toBe(false);
    expect(parseEnvelope('').ok).toBe(false);
  });

  it('非对象 / data 与 error 并存 / 缺 meta / error 缺字段 / 空信封 → 全部拒绝', () => {
    expect(parseEnvelope('"纯文本"').ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ data: {}, error: {}, meta })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ data: {} })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ data: {}, meta: '不是对象' })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ error: { code: 'X' }, meta })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ meta })).ok).toBe(false);
  });

  it('meta 与 error 字段类型/枚举非法时拒绝', () => {
    expect(parseEnvelope(JSON.stringify({ data: {}, meta: { ...meta, source: 'unknown' } })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ data: {}, meta: { ...meta, retrievedAt: 42 } })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ data: {}, meta: { ...meta, traceId: 42 } })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ error: { code: 'NOT_A_CODE', message: 'x', retryable: false }, meta })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ error: { code: 'TIMEOUT', message: 'x', retryable: true, retryAfterMs: -1 }, meta })).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ error: { code: 'TIMEOUT', message: 'x', retryable: true, details: [] }, meta })).ok).toBe(false);
  });
});
