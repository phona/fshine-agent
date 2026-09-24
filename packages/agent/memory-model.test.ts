import { describe, expect, it } from 'vitest';
import type { TurnDriver, TurnDriverInput } from './src/driver';
import { createMemoryCandidateModel } from './src/memory-model';

describe('createMemoryCandidateModel', () => {
  it('runs an isolated no-tools turn with only the candidate batch, then returns model text', async () => {
    let seen: TurnDriverInput | undefined;
    const driver: TurnDriver = {
      run: async (input) => {
        seen = input;
        return { text: '{"candidates":[]}', messages: input.messages };
      },
    };
    const model = createMemoryCandidateModel(driver, { timeoutMs: 5_000 });

    await expect(model.generateStructured({
      systemPrompt: 'extract',
      userPrompt: '{"sourceEvents":[{"eventId":"e1"}]}',
    })).resolves.toBe('{"candidates":[]}');

    expect(seen?.tools).toEqual([]);
    expect(seen?.messages).toHaveLength(1);
    expect(JSON.stringify(seen?.messages)).toContain('e1');
    expect(seen?.deadline).toBeGreaterThan(Date.now() - 5_000);
  });

  it('fails closed on empty model output and never gives the extractor tool access', async () => {
    const driver: TurnDriver = { run: async (input) => ({ text: '', messages: input.messages }) };
    const model = createMemoryCandidateModel(driver);
    await expect(model.generateStructured({ systemPrompt: 'extract', userPrompt: '{}' })).rejects.toThrow('空结果');
  });
});
