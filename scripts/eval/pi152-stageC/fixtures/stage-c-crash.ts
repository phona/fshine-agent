/**
 * 阶段 C 异常退出夹具（子进程）：业务会话跑一回合（含一次 task_run 委派）→ 写计数/marker → SIGKILL。
 *
 * 用法：node --import tsx .../stage-c-crash.ts <sessionDir> <counterFile> <markerFile>
 * 父进程随后用 SessionManager / 驱动恢复同一会话，核验「假执行层计数不增加」。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { DiscoveredTool } from '@fshine/contracts';
import { TASK_RUN_TOOL, TASK_RUN_TOOL_DESCRIPTION, TASK_RUN_TOOL_SCHEMA } from '../../../../packages/agent/src/execution-runtime';
import { createPiTurnDriver } from '../../../../packages/agent/src/pi-driver';
import { createScriptedModelRuntime } from '../../../../packages/agent/testing/scripted-model-runtime';

const [sessionDir, counterFile, markerFile] = process.argv.slice(2);
if (!sessionDir || !counterFile || !markerFile) throw new Error('缺 sessionDir/counterFile/markerFile');

const SYSTEM_PROMPT = '你是 fshine 业务助手：把业务请求转成任务，按事实如实回复。';

function asst(content: unknown[], stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant', content, api: 'openai-completions', provider: 'llm', model: 'test-model',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  } as unknown as AgentMessage;
}
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 1 } as unknown as AgentMessage);
const toolCall = (id: string, args: Record<string, unknown>): AgentMessage =>
  asst([{ type: 'toolCall', id, name: TASK_RUN_TOOL, arguments: args }], 'toolUse');

const runTask: DiscoveredTool = {
  name: TASK_RUN_TOOL,
  description: TASK_RUN_TOOL_DESCRIPTION,
  inputSchema: TASK_RUN_TOOL_SCHEMA,
};

const scripted = await createScriptedModelRuntime({
  contextWindow: 40_000,
  script: (index) => {
    if (index === 0) return toolCall('call_1', { task: '查询 W1 账套', progress: '交办查询' });
    return asst([{ type: 'text', text: '已交办 #1，后台执行中。' }]);
  },
});

let execCount = 0;
const driver = createPiTurnDriver({
  env: { LLM_MODEL: 'test-model' },
  modelRuntime: scripted.runtime,
  reuseConversation: true,
  sessionDir,
});
const result = await driver.run({
  systemPrompt: SYSTEM_PROMPT,
  tools: [runTask],
  messages: [user('请查询 W1 账套')],
  onStep: () => {},
  exec: async () => {
    execCount += 1;
    appendFileSync(counterFile, `${execCount}\n`, 'utf8');
    return { taskId: 'task_1', taskNo: 1, accepted: true, notice: '已受理 #1' };
  },
  deadline: Date.now() + 60_000,
});
const info = driver.sessionInfo?.();
writeFileSync(markerFile, JSON.stringify({
  sessionFile: info?.sessionFile,
  reply: result.text,
  execCount,
  counterLines: execCount,
}), 'utf8');
// 模拟异常退出：不 dispose、不 flush，直接 SIGKILL。
process.kill(process.pid, 'SIGKILL');
