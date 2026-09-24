import { describe, expect, it } from 'vitest';
import { createHistoryTools } from './src/history-tools';

describe('createHistoryTools', () => {
  it('searches and fetches history only within trusted principal/session', async () => {
    const calls: unknown[] = [];
    const repo = {
      search: async (query: unknown) => { calls.push(query); return [{ eventId: 'e1', principalId: 'p1', sessionId: 's1', kind: 'user_message' as const, content: '之前选了三月', createdAt: '2026-09-01T00:00:00.000Z' }]; },
      list: async (query: unknown) => { calls.push(query); return []; },
      append: async () => {},
    };
    const tools = createHistoryTools(repo, { principalId: 'p1', sessionId: 's1' });
    expect(tools.map((tool) => tool.name)).toEqual(['search_history', 'get_messages']);
    const found = await tools[0]!.execute({ query: '三月', limit: 5 });
    expect(found).toContain('之前选了三月');
    await tools[1]!.execute({ limit: 10 });
    expect(calls).toEqual([
      { principalId: 'p1', sessionId: 's1', query: '三月', limit: 5 },
      { principalId: 'p1', sessionId: 's1', limit: 10 },
    ]);
  });

  it('rejects empty, oversized, or unbounded inputs', async () => {
    const repo = { search: async () => [], list: async () => [], append: async () => {} };
    const [search, get] = createHistoryTools(repo, { principalId: 'p1', sessionId: 's1' });
    await expect(search!.execute({ query: ' ', limit: 5 })).rejects.toThrow();
    await expect(search!.execute({ query: 'q', limit: 1000 })).rejects.toThrow();
    await expect(get!.execute({ limit: 0 })).rejects.toThrow();
  });
});
