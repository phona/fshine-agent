import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { Type } from 'typebox';

const kimiModel = {
  id: 'kimi-for-coding', name: 'Kimi for Coding', api: 'openai-completions' as const,
  provider: 'kimi', baseUrl: 'https://api.kimi.com/coding/v1', reasoning: false,
  input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 32000,
};
const kimi = createProvider({
  id: 'kimi', name: 'Kimi',
  baseUrl: 'https://api.kimi.com/coding/v1',
  auth: { apiKey: envApiKeyAuth('Kimi API key', ['LLM_API_KEY']) },
  models: [kimiModel], api: openAICompletionsApi(),
});
const models = createModels();
models.setProvider(kimi);
const model = models.getModel('kimi', 'kimi-for-coding')!;
const probeTool = {
  name: 'get_voucher_total',
  description: '查询指定会计期间的凭证总数,必须调用此工具。',
  parameters: Type.Object({ period: Type.String() }),
  execute: async (_id: string, p: { period: string }) => {
    console.log('[tool]', p.period);
    return { content: [{ type: 'text' as const, text: '共 45 张' }], details: {} };
  },
};
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const seed: AgentMessage[] = [
  { role: 'user', content: '查一下幻晟本期的凭证', timestamp: Date.now() },
  {
    role: 'assistant', timestamp: Date.now(),
    content: [{ type: 'text', text: '找到 2 个候选:1. 幻晟 2. 幻晟(深圳)' }],
    api: 'openai-completions', provider: 'kimi', model: 'kimi-for-coding',
    usage: zeroUsage, stopReason: 'stop',
  },
  { role: 'user', content: '1', timestamp: Date.now() },
];
const a = new Agent({ initialState: { systemPrompt: '用简体中文。必须用工具查数。', model, tools: [probeTool], messages: seed }, streamFn: models.streamSimple.bind(models) });
a.subscribe((e: any) => { if (e.type === 'tool_execution_start') console.log('[tool called]'); });
await a.continue();
const last = [...a.state.messages].reverse().find((m: any) => m.role === 'assistant');
console.log('errorMessage:', a.state.errorMessage ?? '(无)');
console.log('last assistant:', JSON.stringify(last?.content)?.slice(0, 260));
process.exit(0);
