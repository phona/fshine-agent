import { describe, expect, it } from 'vitest';
import { reduceContextState } from './src/context-state';

describe('reduceContextState', () => {
  it('keeps source-linked topic, explicit user decisions, assumptions and unresolved questions', () => {
    const events = [
      { eventId: 'e1', principalId: 'p1', sessionId: 's1', kind: 'user_message' as const, content: '查一下三月凭证', createdAt: '2026-09-01T00:00:00.000Z' },
      { eventId: 'e2', principalId: 'p1', sessionId: 's1', kind: 'assistant_message' as const, content: '假设：你指的是幻晟账套。请确认是三月吗？', createdAt: '2026-09-01T00:00:01.000Z' },
      { eventId: 'e3', principalId: 'p1', sessionId: 's1', kind: 'user_message' as const, content: '就按三月查，不要扩大到其他月份。', createdAt: '2026-09-01T00:00:02.000Z' },
    ];
    const state = reduceContextState(undefined, events);
    expect(state.recentTopic).toEqual({ text: '就按三月查，不要扩大到其他月份。', sourceEventId: 'e3' });
    expect(state.userDecisions).toEqual([{ text: '就按三月查，不要扩大到其他月份。', sourceEventId: 'e3' }]);
    expect(state.agentAssumptions).toEqual([{ text: '你指的是幻晟账套。', sourceEventId: 'e2' }]);
    expect(state.unresolvedQuestions).toEqual([]);
    expect(state.throughEventId).toBe('e3');
  });

  it('is idempotent when replaying throughEventId and bounds recent evidence', () => {
    const first = { eventId: 'e1', principalId: 'p1', sessionId: 's1', kind: 'user_message' as const, content: '查一月', createdAt: '2026-09-01T00:00:00.000Z' };
    const state = reduceContextState(undefined, [first]);
    expect(reduceContextState(state, [first])).toEqual(state);
    const many = Array.from({ length: 20 }, (_, i) => ({ ...first, eventId: `e${i + 2}`, content: `消息${i + 2}` }));
    const bounded = reduceContextState(state, many);
    expect(bounded.recentEvents).toHaveLength(12);
    expect(bounded.throughEventId).toBe('e21');
  });
});
