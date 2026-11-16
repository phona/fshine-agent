/**
 * 阶段 C 重启夹具（子进程）：用新进程从已落盘会话继续一回合，回写模型请求上下文。
 *
 * 用法：node --import tsx .../stage-c-resume-turn.ts <sessionFile> <outFile> <question>
 */
import { writeFileSync } from 'node:fs';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../../packages/agent/testing/scripted-model-runtime';

const [sessionFile, outFile, question] = process.argv.slice(2);
if (!sessionFile || !outFile || !question) throw new Error('缺 sessionFile/outFile/question');

const SYSTEM_PROMPT = '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。';

function asst(text: string): AgentMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  } as unknown as AgentMessage;
}

const scripted = await createScriptedModelRuntime({
  contextWindow: 8_192,
  script: () => asst('重启后继续成功。'),
});
const driver = createPiTurnDriver({
  env: { LLM_MODEL: 'test-model' },
  modelRuntime: scripted.runtime,
  reuseConversation: true,
  resumeSessionFile: sessionFile,
});
const result = await driver.run({
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  messages: [{ role: 'user', content: question, timestamp: 2 } as unknown as AgentMessage],
  onStep: () => {},
  exec: async () => undefined,
  deadline: Date.now() + 60_000,
});
writeFileSync(outFile, JSON.stringify({
  text: result.text,
  sessionFile: driver.sessionInfo?.()?.sessionFile,
  requestMessages: scripted.requests()[0]?.messages ?? [],
}), 'utf8');
driver.close?.();
