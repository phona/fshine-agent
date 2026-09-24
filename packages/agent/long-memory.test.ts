import { describe, expect, it } from 'vitest';
import { reduceLongMemory, type LongMemoryCandidate } from './src/long-memory';
import type { ConversationEventRecord } from '@fshine/contracts';

const event = (eventId: string, content: string, kind: ConversationEventRecord['kind'] = 'user_message'): ConversationEventRecord => ({
  eventId, principalId: 'p1', sessionId: 's1', kind, content, createdAt: `2026-01-01T00:00:0${eventId.slice(-1)}.000Z`,
});

const candidate = (overrides: Partial<LongMemoryCandidate> = {}): LongMemoryCandidate => ({
  candidateId: 'mem-style-v1', principalId: 'p1', key: 'response_style', type: 'preference',
  content: '用中文简洁回答', sourceEventIds: ['e1'], action: 'assert',
  ...overrides,
});

describe('long memory reducer', () => {
  it('creates a versioned memory record only from cited source events and renders a rebuildable projection', () => {
    const result = reduceLongMemory({ current: [], sourceEvents: [event('e1', '以后请用中文简洁回答')], candidates: [candidate()], now: '2026-01-02T00:00:00.000Z' });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ sourceEventIds: ['e1'], type: 'preference', status: 'active', version: 1, updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(result.memoryMarkdown).toContain('用中文简洁回答');
    expect(result.memoryMarkdown).toContain('e1');
  });

  it('rejects hallucinated, foreign-principal, and assistant-only evidence', () => {
    expect(() => reduceLongMemory({ current: [], sourceEvents: [event('e1', '建议用中文', 'assistant_message')], candidates: [candidate()], now: '2026-01-02T00:00:00.000Z' })).toThrow(/user source event/i);
    expect(() => reduceLongMemory({ current: [], sourceEvents: [event('e1', '以后请用中文回答')], candidates: [candidate({ sourceEventIds: ['missing'] })], now: '2026-01-02T00:00:00.000Z' })).toThrow(/source event/i);
    expect(() => reduceLongMemory({ current: [], sourceEvents: [event('e1', '以后请用中文回答')], candidates: [candidate({ principalId: 'p2' })], now: '2026-01-02T00:00:00.000Z' })).toThrow(/principal/i);
  });

  it('does not derive new facts from a previous MEMORY.md projection', () => {
    const input = { current: [], sourceEvents: [], candidates: [candidate()], now: '2026-01-02T00:00:00.000Z' };
    expect(() => reduceLongMemory(input)).toThrow(/source event/i);
    expect(Object.keys(input)).not.toContain('memoryMarkdown');
  });

  it('keeps corrections, conflicts, and deletions traceable as versioned records', () => {
    const first = reduceLongMemory({ current: [], sourceEvents: [event('e1', '以后请用中文简洁回答')], candidates: [candidate()], now: '2026-01-02T00:00:00.000Z' });
    const conflict = reduceLongMemory({
      current: first.records,
      sourceEvents: [event('e2', '我改主意了，以后请详细回答')],
      candidates: [candidate({ candidateId: 'mem-style-v2', content: '详细回答', sourceEventIds: ['e2'] })],
      now: '2026-01-03T00:00:00.000Z',
    });
    expect(conflict.records.map((r) => r.status)).toEqual(['conflicted', 'conflicted']);
    expect(conflict.records.every((r) => r.sourceEventIds.length > 0)).toBe(true);
    const corrected = reduceLongMemory({
      current: conflict.records,
      sourceEvents: [event('e3', '更正：请默认简洁回答')],
      candidates: [candidate({ candidateId: 'mem-style-v3', content: '默认简洁回答', sourceEventIds: ['e3'], action: 'correct', supersedesMemoryIds: ['mem-style-v1', 'mem-style-v2'] })],
      now: '2026-01-04T00:00:00.000Z',
    });
    expect(corrected.records.filter((r) => r.status === 'active').map((r) => r.memoryId)).toEqual(['mem-style-v3']);
    expect(corrected.records.find((r) => r.memoryId === 'mem-style-v1')?.sourceEventIds).toContain('e1');
    const deleted = reduceLongMemory({
      current: corrected.records,
      sourceEvents: [event('e4', '删除关于回答风格的记忆')],
      candidates: [candidate({ candidateId: 'delete-style', sourceEventIds: ['e4'], action: 'delete', supersedesMemoryIds: ['mem-style-v3'] })],
      now: '2026-01-05T00:00:00.000Z',
    });
    expect(deleted.records.find((r) => r.memoryId === 'mem-style-v3')).toMatchObject({ status: 'deleted', version: 2, sourceEventIds: ['e3', 'e4'] });
    expect(deleted.memoryMarkdown).not.toContain('默认简洁回答');
  });

  it('is idempotent for already applied source evidence', () => {
    const input = { current: [], sourceEvents: [event('e1', '以后请用中文简洁回答')], candidates: [candidate()], now: '2026-01-02T00:00:00.000Z' };
    const first = reduceLongMemory(input);
    expect(reduceLongMemory({ ...input, current: first.records, now: '2026-01-09T00:00:00.000Z' }).records).toEqual(first.records);
  });
});
