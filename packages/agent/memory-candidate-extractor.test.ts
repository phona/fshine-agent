import { describe, expect, it, vi } from 'vitest';
import type { ConversationEventRecord } from '@fshine/contracts';
import { createLongMemoryCandidateExtractor, type MemoryCandidateModel, type MemoryCandidateModelRequest } from './src/memory-candidate-extractor';
import { consolidateLongMemory } from './src/memory-consolidator';

const event = (eventId: string, content: string, principalId = 'p1', kind: ConversationEventRecord['kind'] = 'user_message'): ConversationEventRecord => ({
  eventId, principalId, sessionId: `s-${principalId}`, kind, content, createdAt: '2026-01-01T00:00:00.000Z',
});
const candidateOutput = (patch: Record<string, unknown> = {}) => ({
  key: 'response_style', type: 'preference', content: '用中文简洁回答', sourceEventIds: ['e1'], action: 'assert', ...patch,
});
const model = (generateStructured: MemoryCandidateModel['generateStructured']): MemoryCandidateModel => ({ generateStructured });

describe('production long memory candidate extractor', () => {
  it('asks the injected model to extract only from original user event text and derives stable IDs itself', async () => {
    const requests: MemoryCandidateModelRequest[] = [];
    const generateStructured = vi.fn(async (request: MemoryCandidateModelRequest) => {
      requests.push(request);
      return { candidates: [candidateOutput()] };
    });
    const extractor = createLongMemoryCandidateExtractor(model(generateStructured));
    const events = [event('e1', '以后请用中文简洁回答'), event('e2', 'assistant response', 'p1', 'assistant_message')];
    const first = await extractor(events);
    const second = await extractor(events);
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(requests[0]!.userPrompt).toContain('以后请用中文简洁回答');
    expect(requests[0]!.userPrompt).not.toContain('assistant response');
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ principalId: 'p1', sourceEventIds: ['e1'], type: 'preference', action: 'assert' });
    expect(first[0]!.candidateId).toMatch(/^mem_[a-f0-9]{32}$/);
  });

  it('filters period, temporary account-set, and concrete balance facts from long-term candidates', async () => {
    const extractor = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [
      candidateOutput({ key: 'current_balance', type: 'fact', content: '2025年9月账套A余额为12800元', sourceEventIds: ['e1'] }),
      candidateOutput({ key: 'response_language', type: 'preference', content: '用中文简洁回答', sourceEventIds: ['e2'] }),
      candidateOutput({ key: 'period_result', type: 'fact', content: '2025-Q2 营业收入为 3,200,000 元', sourceEventIds: ['e1'] }),
      candidateOutput({ key: 'report_period', type: 'fact', content: '用户在 2025-Q2 处理季度报表', sourceEventIds: ['e1'] }),
      candidateOutput({ key: 'default_query_scope', type: 'preference', content: '默认查询账套A的202609期间', sourceEventIds: ['e1'] }),
      candidateOutput({ key: 'current_period_query', type: 'preference', content: '默认查询幻辰公司的202609数据', sourceEventIds: ['e1'] }),
    ] })));
    const result = await extractor([event('e1', '查询2025年9月账套A余额'), event('e2', '以后请用中文简洁回答')]);
    expect(result.map((item) => item.key)).toEqual(['response_language']);
  });

  it('preserves explicit user corrections and deletions with source IDs and target record IDs', async () => {
    const extractor = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [
      candidateOutput({ key: 'response_style', type: 'preference', content: '回答尽量详细', action: 'correct', sourceEventIds: ['e2'], supersedesMemoryIds: ['mem_old'] }),
      candidateOutput({ key: 'response_style', type: 'preference', content: '回答风格记忆', action: 'delete', sourceEventIds: ['e3'], supersedesMemoryIds: ['mem_new'] }),
    ] })));
    const result = await extractor([event('e2', '更正：以后请回答尽量详细'), event('e3', '删除回答风格记忆')]);
    expect(result.map(({ action, sourceEventIds, supersedesMemoryIds }) => ({ action, sourceEventIds, supersedesMemoryIds }))).toEqual([
      { action: 'correct', sourceEventIds: ['e2'], supersedesMemoryIds: ['mem_old'] },
      { action: 'delete', sourceEventIds: ['e3'], supersedesMemoryIds: ['mem_new'] },
    ]);
  });

  it('passes current record IDs only as correction targets, while new evidence still cites raw user events', async () => {
    let prompt = '';
    const extractor = createLongMemoryCandidateExtractor(model(async (request) => {
      prompt = request.userPrompt;
      return { candidates: [] };
    }));
    await extractor([event('e4', '更正：以后不要使用英文')], [{
      memoryId: 'mem_old', principalId: 'p1', key: 'answer_language', type: 'preference', content: '偏好英文',
      status: 'active', sourceEventIds: ['e1'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]);
    expect(prompt).toContain('mem_old');
    expect(prompt).toContain('不是事实证据');
    expect(prompt).toContain('e4');
  });

  it('rejects missing, foreign, non-user, or unknown event citations instead of trusting model claims', async () => {
    const missing = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput({ sourceEventIds: [] })] })));
    await expect(missing([event('e1', '以后用中文')])).rejects.toThrow(/sourceEventIds/i);
    const foreign = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput({ sourceEventIds: ['e2'] })] })));
    await expect(foreign([event('e1', '以后用中文')])).rejects.toThrow(/unknown source event/i);
    const mixed = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput({ sourceEventIds: ['e2'] })] })));
    await expect(mixed([event('e1', '以后用中文'), event('e2', '另一位用户消息', 'p2')])).rejects.toThrow(/one principal/i);
    const assistant = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput({ sourceEventIds: ['e2'] })] })));
    await expect(assistant([event('e1', '以后用中文'), event('e2', '建议用英文', 'p1', 'assistant_message')])).rejects.toThrow(/unknown source event/i);
  });

  it('deduplicates exact model repeats and rejects an incomplete correction or deletion', async () => {
    const duplicate = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput(), candidateOutput()] })));
    expect(await duplicate([event('e1', '以后用中文')])).toHaveLength(1);
    const incomplete = createLongMemoryCandidateExtractor(model(async () => ({ candidates: [candidateOutput({ action: 'delete', supersedesMemoryIds: [] })] })));
    await expect(incomplete([event('e1', '删除偏好')])).rejects.toThrow(/supersedesMemoryIds/i);
  });

  it('propagates model failure so consolidation retains records and does not advance its cursor', async () => {
    const extractor = createLongMemoryCandidateExtractor(model(async () => { throw new Error('model unavailable'); }));
    const result = await consolidateLongMemory({
      principalId: 'p1', sourceEvents: [event('e1', '以后请用中文')], current: [], cursor: 'prior', now: '2026-01-02T00:00:00.000Z', extractor,
    });
    expect(result).toMatchObject({ ok: false, cursor: 'prior', records: [] });
    expect(result.error).toContain('model unavailable');
  });
});
