import { describe, expect, it, vi } from 'vitest';
import type { ConversationEventRecord } from '@fshine/contracts';
import type { MemoryRecord } from '../core/src/memory-records';
import { consolidateLongMemory, type CandidateExtractor, type MemoryConsolidationInput } from './src/memory-consolidator';
import type { LongMemoryCandidate } from './src/long-memory';

const userEvent = (eventId: string, principalId = 'p1', content = eventId): ConversationEventRecord => ({
  eventId, principalId, sessionId: `s-${principalId}`, kind: 'user_message', content,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const assistantEvent = (eventId: string, principalId = 'p1'): ConversationEventRecord => ({
  eventId, principalId, sessionId: `s-${principalId}`, kind: 'assistant_message', content: '以后默认用简洁回答',
  createdAt: '2026-01-01T00:00:01.000Z',
});
const candidate = (eventId: string, value = `fact from ${eventId}`): LongMemoryCandidate => ({
  candidateId: `memory-${eventId}`, principalId: 'p1', key: 'style', type: 'preference', content: value,
  sourceEventIds: [eventId], action: 'assert',
});
const base = (patch: Partial<MemoryConsolidationInput> = {}): MemoryConsolidationInput => ({
  principalId: 'p1', sourceEvents: [], current: [], extractor: async () => [], now: '2026-01-02T00:00:00.000Z', ...patch,
});

describe('LongMemoryConsolidator', () => {
  it('extracts only raw user messages in the requested principal scope and advances cursor after success', async () => {
    const extractor = vi.fn<CandidateExtractor>(async (events) => [candidate(events[0]!.eventId)]);
    const result = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e1'), assistantEvent('e2'), userEvent('e3', 'p2')], extractor,
    }));
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(extractor.mock.calls[0]![0].map((event) => event.eventId)).toEqual(['e1']);
    expect(result).toMatchObject({ cursor: 'e1', ok: true, records: [{ principalId: 'p1', sourceEventIds: ['e1'] }] });
    expect(result.memoryMarkdown).toContain('fact from e1');
  });

  it('uses cursor to avoid re-extracting already processed events and retains stable records on repeated input', async () => {
    const extractor = vi.fn<CandidateExtractor>(async (events) => events.map((event) => candidate(event.eventId, 'stable fact')));
    const first = await consolidateLongMemory(base({ sourceEvents: [userEvent('e1')], extractor }));
    const second = await consolidateLongMemory(base({ sourceEvents: [userEvent('e1'), userEvent('e2')], current: first.records, cursor: first.cursor, extractor }));
    expect(second.cursor).toBe('e2');
    expect(extractor.mock.calls.map(([events]) => events.map((event) => event.eventId))).toEqual([['e1'], ['e2']]);
    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({ memoryId: 'memory-e1', sourceEventIds: ['e1', 'e2'], version: 2 });
  });

  it('records competing claims as traceable conflicts', async () => {
    const first = await consolidateLongMemory(base({ sourceEvents: [userEvent('e1')], extractor: async () => [candidate('e1', '简洁')] }));
    const second = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e2', 'p1', '改成详细回答')], current: first.records, cursor: first.cursor,
      extractor: async () => [candidate('e2', '详细')],
    }));
    expect(second.records.map((row) => row.status)).toEqual(['conflicted', 'conflicted']);
    expect(second.records.every((row) => row.sourceEventIds.length > 0)).toBe(true);
    expect(second.memoryMarkdown).not.toContain('详细');
  });

  it('does not consume events or mutate current records when extraction fails, so the batch can be retried', async () => {
    const current: MemoryRecord[] = [];
    const result = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e1')], current, cursor: 'prior-event',
      extractor: async () => { throw new Error('model unavailable'); },
    }));
    expect(result).toMatchObject({ ok: false, cursor: 'prior-event', records: [] });
    expect(result.error).toMatch(/model unavailable/);
    expect(current).toEqual([]);
  });

  it('fails closed on candidate source spoofing and principal leakage without advancing cursor', async () => {
    const invalid = candidate('missing');
    const result = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e1')], cursor: 'prior-event', extractor: async () => [invalid],
    }));
    expect(result.ok).toBe(false);
    expect(result.cursor).toBe('prior-event');
    expect(result.records).toEqual([]);

    const wrongPrincipal = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e1')], cursor: 'prior-event',
      extractor: async () => [{ ...candidate('e1', 'foreign'), principalId: 'p2' }],
    }));
    expect(wrongPrincipal.ok).toBe(false);
    expect(wrongPrincipal.cursor).toBe('prior-event');

    const duplicateId = await consolidateLongMemory(base({
      sourceEvents: [userEvent('e1', 'p1', 'first'), userEvent('e1', 'p1', 'different')], cursor: 'prior-event',
    }));
    expect(duplicateId.ok).toBe(false);
    expect(duplicateId.cursor).toBe('prior-event');

    const mixed = await consolidateLongMemory(base({
      current: [ { memoryId: 'm2', principalId: 'p2', key: 'k', type: 'fact', content: 'secret', status: 'active', sourceEventIds: ['e2'], version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } ],
      sourceEvents: [userEvent('e1')], extractor: async () => [candidate('e1')],
    }));
    expect(mixed.records.every((row) => row.principalId === 'p1')).toBe(true);
    expect(mixed.memoryMarkdown).not.toContain('secret');
  });

  it('does not call the extractor or move the cursor for a batch with no new user events', async () => {
    const extractor = vi.fn<CandidateExtractor>(async () => []);
    const result = await consolidateLongMemory(base({ sourceEvents: [assistantEvent('e2')], cursor: 'e1', extractor }));
    expect(extractor).not.toHaveBeenCalled();
    expect(result.cursor).toBe('e1');
    expect(result.ok).toBe(true);
  });
});
