import { describe, expect, it } from 'vitest';
import type { ToolOutcome } from '@fshine/contracts';
import { trimForRuntime } from './src/index';

function makeDocs(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: `doc_${i}`, number: String(i) }));
}

function okOutcome(data: unknown): Extract<ToolOutcome, { ok: true }> {
  return { ok: true, data, meta: { retrievedAt: '2026-09-16T10:00:00+08:00', source: 'api_cache' } };
}

describe('trimForRuntime(验收 #9)', () => {
  it('45 张凭证 → docs 保留前 10 项并附截断提示,total/nextCursor 原样保留', () => {
    const outcome = okOutcome({ total: 45, docs: makeDocs(45), nextCursor: 'eyJwYWdlTm8iOjF9' });
    const trimmed = trimForRuntime(outcome);
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) throw new Error('unreachable');
    const data = trimmed.data as Record<string, unknown>;
    expect(Array.isArray(data['docs'])).toBe(true);
    expect(data['docs']).toHaveLength(10);
    expect(data['_docsTruncated']).toBe('总数45');
    expect(data['total']).toBe(45);
    expect(data['nextCursor']).toBe('eyJwYWdlTm8iOjF9');
    expect(trimmed.meta).toEqual(outcome.meta);
  });

  it('≤10 项数组不裁剪、不加提示字段;原 outcome 不被修改', () => {
    const outcome = okOutcome({ docs: makeDocs(10) });
    const trimmed = trimForRuntime(outcome);
    if (!trimmed.ok) throw new Error('unreachable');
    const data = trimmed.data as Record<string, unknown>;
    expect(data['docs']).toHaveLength(10);
    expect(data['_docsTruncated']).toBeUndefined();
    expect((outcome.data as Record<string, unknown>)['_docsTruncated']).toBeUndefined();
    expect(trimmed).toBe(outcome); // 无变化时原样返回
  });

  it('JSON 串超长(无大数组)→ data 变为截断字符串并带 […已截断] 标记', () => {
    const outcome = okOutcome({ note: 'x'.repeat(5000) });
    const trimmed = trimForRuntime(outcome, 4000);
    if (!trimmed.ok) throw new Error('unreachable');
    expect(typeof trimmed.data).toBe('string');
    const text = trimmed.data as string;
    expect(text).toContain('[…已截断]');
    expect(text.length).toBeLessThanOrEqual(4000 + '[…已截断]'.length);
  });

  it('数组裁剪后仍超长 → 先裁数组再整体截断', () => {
    const outcome = okOutcome({ docs: makeDocs(11), blob: 'y'.repeat(4500) });
    const trimmed = trimForRuntime(outcome, 1000);
    if (!trimmed.ok) throw new Error('unreachable');
    expect(typeof trimmed.data).toBe('string');
    expect(trimmed.data as string).toContain('[…已截断]');
  });

  it('错误 outcome 原样透传,不做裁剪', () => {
    const outcome: ToolOutcome = {
      ok: false,
      error: { code: 'NEEDS_LOGIN', message: '登录失效', retryable: false },
    };
    expect(trimForRuntime(outcome)).toBe(outcome);
  });
});
