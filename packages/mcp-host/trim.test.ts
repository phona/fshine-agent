import { describe, expect, it } from 'vitest';
import type { ToolOutcome } from '@fshine/contracts';
import { RESULT_BUDGET_CHARS, trimForRuntime } from './src/index';

function makeDocs(n: number): unknown[] {
  // 每条 ~130 字符:贴近真实凭证(多行分录+客户明细)的重量,确保 45 条必超 4000 预算
  return Array.from({ length: n }, (_, i) => ({ id: `doc_${i}`, number: String(i), note: 'x'.repeat(100) }));
}

function okOutcome(data: unknown): Extract<ToolOutcome, { ok: true }> {
  return { ok: true, data, meta: { retrievedAt: '2026-09-16T10:00:00+08:00', source: 'api_cache' } };
}

describe('trimForRuntime(契约:超预算 fail-loud,不静默裁剪)', () => {
  it('预算内的结果原样透传(total/nextCursor/docs 不动),不复制对象', () => {
    const outcome = okOutcome({ total: 15, docs: makeDocs(4), pageNo: 0, nextCursor: 'eyJwYWdlTm8iOjF9' });
    const trimmed = trimForRuntime(outcome);
    expect(trimmed.ok).toBe(true);
    expect(trimmed).toBe(outcome); // 无变化时原样返回
  });

  it('超预算 → fail-loud:ok=false + 指引分页的中文错误,原始数据不进入上下文', () => {
    const outcome = okOutcome({ total: 45, docs: makeDocs(45) });
    const trimmed = trimForRuntime(outcome, 4000);
    expect(trimmed.ok).toBe(false);
    if (trimmed.ok) throw new Error('unreachable');
    expect(trimmed.error.code).toBe('INTERNAL');
    expect(trimmed.error.retryable).toBe(false);
    expect(trimmed.error.message).toContain('分页');
    expect(trimmed.error.message).toContain('cursor');
    expect(trimmed.meta).toEqual(outcome.meta); // meta 保留,模型可引用来源
    // 原始 outcome 不被修改(审计/上层仍可见完整结果)
    expect((outcome.data as Record<string, unknown>)['docs']).toHaveLength(45);
  });

  it('恰好等于预算 → 通过(只拦超限)', () => {
    // JSON.stringify({note}) 本身占 12 字符,3988+12 = 4000 恰好达标
    const outcome = okOutcome({ note: 'x'.repeat(RESULT_BUDGET_CHARS - 12) });
    const trimmed = trimForRuntime(outcome);
    expect(trimmed.ok).toBe(true);
  });

  it('自定义预算生效', () => {
    const outcome = okOutcome({ note: 'x'.repeat(500) });
    const trimmed = trimForRuntime(outcome, 300);
    expect(trimmed.ok).toBe(false);
  });

  it('错误 outcome 原样透传,不做预算检查', () => {
    const outcome: ToolOutcome = {
      ok: false,
      error: { code: 'NEEDS_LOGIN', message: '登录失效', retryable: false },
    };
    expect(trimForRuntime(outcome)).toBe(outcome);
  });
});
