import { describe, expect, it, vi } from 'vitest';
import type { ConversationEventRecord } from '@fshine/contracts';
import type { TurnDriver, TurnDriverInput, TurnDriverResult } from './src/driver';
import type { ContextState } from './src/context-state';
import { extractContextWithTurnDriver, type ContextModelClock } from './src/context-model';

const event = (eventId: string, content: string, kind: ConversationEventRecord['kind']): ConversationEventRecord => ({
  eventId, principalId: 'p1', sessionId: 's1', kind, content, createdAt: '2026-09-24T00:00:00.000Z',
});

const previous: ContextState = {
  reducerVersion: 1,
  throughEventId: 'e2',
  recentTopic: { text: '用户问当前期间查不到时是否扩大到一至九月。', sourceEventId: 'e2' },
  userDecisions: [], agentAssumptions: [], unresolvedQuestions: [],
  recentEvents: [
    { eventId: 'e1', sourceEventId: 'e1', kind: 'user_message', text: '先查当前期间，缺失再查一至九月。' },
    { eventId: 'e2', sourceEventId: 'e2', kind: 'assistant_message', text: '当前期间查不到，需要扩大至一至九月吗？' },
  ],
};

function driverWith(run: (input: TurnDriverInput) => Promise<TurnDriverResult>): TurnDriver {
  return { run };
}

const nowClock = (): ContextModelClock => ({
  now: () => 100,
  setTimeout: (callback, _delay) => setTimeout(callback, 0),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

describe('TurnDriver context model adapter', () => {
  it('uses an isolated no-tool turn and validates a colloquial approval against the actual source event', async () => {
    let observed: TurnDriverInput | undefined;
    const patch = {
      recentTopic: { text: '用户同意扩大至一至九月，并继续查询。', sourceEventId: 'e3', evidenceQuote: '这个可以，继续刚才那个' },
      userDecisions: [{ text: '同意扩大至一至九月并继续查询', sourceEventId: 'e3', evidenceQuote: '这个可以，继续刚才那个' }],
      unresolvedQuestions: [],
    };
    const driver = driverWith(async (input) => {
      observed = input;
      return { text: JSON.stringify(patch), messages: input.messages };
    });
    const result = await extractContextWithTurnDriver({
      principalId: 'p1', sessionId: 's1', previous,
      incoming: [event('e3', '这个可以，继续刚才那个', 'user_message')],
      driver, clock: nowClock(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.userDecisions).toEqual([{ text: patch.userDecisions[0]!.text, sourceEventId: 'e3' }]);
    expect(observed?.tools).toEqual([]);
    expect(observed?.messages).toHaveLength(1);
    const userPrompt = observed?.messages[0] as { role: string; content: string } | undefined;
    expect(userPrompt).toMatchObject({ role: 'user' });
    expect(userPrompt?.content).toContain('e1');
    expect(userPrompt?.content).toContain('e2');
    expect(userPrompt?.content).toContain('一至九月');
    expect(observed?.systemPrompt).toContain('JSON');
    expect(observed?.signal?.aborted).toBe(false);
  });

  it('returns an explicit fallback signal without calling the model when scoped input exceeds its byte limit', async () => {
    const run = vi.fn(async (input: TurnDriverInput) => ({ text: '{}', messages: input.messages }));
    const result = await extractContextWithTurnDriver({
      principalId: 'p1', sessionId: 's1', incoming: [event('e1', '很长'.repeat(200), 'user_message')],
      driver: driverWith(run), clock: nowClock(), maxInputBytes: 100,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'model_failure' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects overlong and non-JSON output so callers use the deterministic fallback', async () => {
    const outputDriver = (text: string) => driverWith(async (input) => ({ text, messages: input.messages }));
    const input = { principalId: 'p1', sessionId: 's1', incoming: [event('e1', '继续', 'user_message')], clock: nowClock() };
    const oversized = await extractContextWithTurnDriver({ ...input, driver: outputDriver('{"x":"'.concat('x'.repeat(100), '"}')), maxOutputBytes: 20 });
    const invalidJson = await extractContextWithTurnDriver({ ...input, driver: outputDriver('```json\n{}\n```') });

    expect(oversized).toMatchObject({ ok: false, error: { code: 'model_failure' } });
    expect(invalidJson).toMatchObject({ ok: false, error: { code: 'model_failure' } });
  });

  it('aborts a stalled isolated model turn at the configured timeout', async () => {
    let timer: (() => void) | undefined;
    let aborted = false;
    const clock: ContextModelClock = {
      now: () => 100,
      setTimeout: (callback) => { timer = callback; return 1; },
      clearTimeout: () => undefined,
    };
    const driver = driverWith((input) => new Promise((_resolve) => {
      input.signal?.addEventListener('abort', () => { aborted = true; });
    }));
    const resultPromise = extractContextWithTurnDriver({
      principalId: 'p1', sessionId: 's1', incoming: [event('e1', '继续', 'user_message')],
      driver, clock, timeoutMs: 30,
    });
    await Promise.resolve();
    timer?.();
    const result = await resultPromise;

    expect(result).toMatchObject({ ok: false, error: { code: 'model_failure' } });
    expect(aborted).toBe(true);
  });
});
