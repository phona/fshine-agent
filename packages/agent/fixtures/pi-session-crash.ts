/**
 * A1 异常退出夹具（子进程）：建实例级 Pi 会话 → 完成一回合 → 不 dispose 直接 SIGKILL。
 *
 * 用法：node --import tsx packages/agent/fixtures/pi-session-crash.ts <sessionDir> <markerFile>
 * 父进程（pi-agent-session.test.ts）随后用 SessionManager.open 恢复同一会话继续。
 */
import { writeFileSync } from 'node:fs';
import { createPiTurnDriver } from '../src/pi-driver';
import { createScriptedModelRuntime } from '../testing/scripted-model-runtime';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const [sessionDir, markerFile] = process.argv.slice(2);
if (sessionDir === undefined || markerFile === undefined) throw new Error('缺 sessionDir/markerFile');

const asst = (text: string): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-completions',
  provider: 'llm',
  model: 'test-model',
  usage: {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
} as unknown as AgentMessage);

const scripted = await createScriptedModelRuntime({
  contextWindow: 40_000,
  script: () => asst('崩溃前的第一轮回复。'),
});
const driver = createPiTurnDriver({
  env: { LLM_MODEL: 'test-model' },
  modelRuntime: scripted.runtime,
  reuseConversation: true,
  sessionDir,
});
const result = await driver.run({
  systemPrompt: '你是 fshine 业务助手。',
  tools: [],
  messages: [{ role: 'user', content: '崩溃前的第一轮问题', timestamp: 1 } as unknown as AgentMessage],
  onStep: () => {},
  exec: async () => undefined,
  deadline: Date.now() + 60_000,
});
const info = driver.sessionInfo?.();
writeFileSync(markerFile, JSON.stringify({
  sessionFile: info?.sessionFile,
  reply: result.text,
  transcriptRoles: result.messages.map((message) => (message as { role?: string }).role),
}), 'utf8');
// 模拟异常退出：不 dispose、不 flush，直接 SIGKILL。
process.kill(process.pid, 'SIGKILL');
