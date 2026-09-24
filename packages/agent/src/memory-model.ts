import type { TurnDriver } from './driver';
import type { MemoryCandidateModel } from './memory-candidate-extractor';

export interface MemoryModelOptions {
  timeoutMs?: number;
  now?: () => number;
}

/** Runs memory extraction in an isolated, tool-free model turn. */
export function createMemoryCandidateModel(
  driver: TurnDriver,
  options: MemoryModelOptions = {},
): MemoryCandidateModel {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);
  const now = options.now ?? Date.now;
  return {
    async generateStructured(request) {
      const userMessage = { role: 'user', content: request.userPrompt, timestamp: now() } as never;
      const deadline = now() + timeoutMs;
      const result = await driver.run({
        systemPrompt: request.systemPrompt,
        tools: [],
        messages: [userMessage],
        onStep: () => {},
        exec: async () => { throw new Error('Memory extraction has no tools.'); },
        deadline,
      });
      if (!result.text.trim()) throw new Error('长期记忆抽取返回空结果。');
      return result.text;
    },
  };
}
