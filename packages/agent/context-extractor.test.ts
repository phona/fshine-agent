import { describe, expect, it, vi } from 'vitest';
import type { ConversationEventRecord } from '@fshine/contracts';
import { extractSemanticContext, type ContextSemanticPatch } from './src/context-extractor';
import type { ContextState } from './src/context-state';

const event = (eventId: string, content: string, kind: ConversationEventRecord['kind'] = 'user_message', principalId = 'p1'): ConversationEventRecord => ({
  eventId, principalId, sessionId: 's1', kind, content, createdAt: '2026-09-01T00:00:00.000Z',
});

const oldState: ContextState = {
  reducerVersion: 1, throughEventId: 'e1',
  recentTopic: { text: '请先查当前期间，如果缺失再查一至九月。', sourceEventId: 'e1' },
  userDecisions: [], agentAssumptions: [], unresolvedQuestions: [],
  recentEvents: [{ eventId: 'e1', sourceEventId: 'e1', kind: 'user_message', text: '请先查当前期间，如果缺失再查一至九月。' }],
};

const patch = (changes: Partial<ContextSemanticPatch> = {}): ContextSemanticPatch => ({
  recentTopic: { text: '用户认可扩大至一至九月查询', sourceEventId: 'e2', evidenceQuote: '这个可以' },
  userDecisions: [{ text: '认可扩大至一至九月查询', sourceEventId: 'e2', evidenceQuote: '这个可以' }],
  agentAssumptions: [], unresolvedQuestions: [],
  ...changes,
});

describe('extractSemanticContext', () => {
  it('passes prior state to the model so short replies like “这个可以” retain their referent', async () => {
    const invokeModel = vi.fn(async (input: { previous?: ContextState; incoming: readonly ConversationEventRecord[] }) => {
      expect(input.previous?.recentTopic?.text).toContain('一至九月');
      expect(input.incoming[0]?.content).toBe('这个可以');
      return patch();
    });
    const result = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '这个可以')], principalId: 'p1', sessionId: 's1', invokeModel });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.userDecisions).toEqual([{ text: '认可扩大至一至九月查询', sourceEventId: 'e2' }]);
      expect(result.state.recentTopic?.text).toBe('用户认可扩大至一至九月查询');
    }
  });

  it('rejects unknown evidence ids and quotes that are not present in their cited event', async () => {
    const unknown = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '这个可以')], principalId: 'p1', sessionId: 's1', invokeModel: async () => patch({ userDecisions: [{ text: '同意另一项安排', sourceEventId: 'ghost', evidenceQuote: '这个可以' }] }) });
    const fabricated = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '这个可以')], principalId: 'p1', sessionId: 's1', invokeModel: async () => patch({ userDecisions: [{ text: '同意扩大', sourceEventId: 'e2', evidenceQuote: '扩大到十二个月' }] }) });

    expect(unknown).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
    expect(fabricated).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
  });

  it('does not treat assistant text as evidence of a user decision and rejects malformed model output distinctly', async () => {
    const assistantOnly = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '我建议扩大查询范围。', 'assistant_message')], principalId: 'p1', sessionId: 's1', invokeModel: async () => patch({
      recentTopic: null,
      userDecisions: [{ text: '用户同意扩大查询', sourceEventId: 'e2', evidenceQuote: '扩大查询范围' }],
    }) });
    const malformed = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '继续')], principalId: 'p1', sessionId: 's1', invokeModel: async () => ({ userDecisions: '不是数组' }) });

    expect(assistantOnly).toMatchObject({ ok: false, error: { code: 'invalid_evidence' } });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_patch' } });
  });

  it('rejects events from another principal or session before invoking the model', async () => {
    const invokeModel = vi.fn(async () => patch());
    const result = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '这个可以', 'user_message', 'p2')], principalId: 'p1', sessionId: 's1', invokeModel });

    expect(result).toMatchObject({ ok: false, error: { code: 'scope_mismatch' } });
    expect(invokeModel).not.toHaveBeenCalled();
  });

  it('rejects duplicate and contradictory notes rather than silently choosing one', async () => {
    const duplicate = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '简洁回答，也可以详细回答')], principalId: 'p1', sessionId: 's1', invokeModel: async () => patch({
      recentTopic: null,
      userDecisions: [
        { text: '默认简洁回答', sourceEventId: 'e2', evidenceQuote: '简洁回答' },
        { text: '默认简洁回答', sourceEventId: 'e2', evidenceQuote: '简洁回答' },
      ],
    }) });
    const contradictory = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '简洁回答，也可以详细回答')], principalId: 'p1', sessionId: 's1', invokeModel: async () => patch({
      recentTopic: null,
      userDecisions: [
        { text: '默认简洁回答', sourceEventId: 'e2', evidenceQuote: '简洁回答' },
        { text: '默认详细回答', sourceEventId: 'e2', evidenceQuote: '详细回答' },
      ],
    }) });

    expect(duplicate).toMatchObject({ ok: false, error: { code: 'duplicate_note' } });
    expect(contradictory).toMatchObject({ ok: false, error: { code: 'conflicting_notes' } });
  });

  it('returns explicit model failure and leaves deterministic fallback to the caller', async () => {
    const result = await extractSemanticContext({ previous: oldState, incoming: [event('e2', '继续')], principalId: 'p1', sessionId: 's1', invokeModel: async () => { throw new Error('offline'); } });
    expect(result).toMatchObject({ ok: false, error: { code: 'model_failure' } });
    expect(result.ok).toBe(false);
  });
});
