/**
 * 旧 B1 格式产物生成器（一次性；只用 0.85.1 公开子路径）。
 *
 * 由父进程拷入一个临时目录运行，该临时目录只含
 * `node_modules/@earendil-works/pi-agent-core` → 主仓 0.85.1 包的符号链接。
 * 产物写到本次实验的临时根，不触碰主仓、不复制 Pi 源码。
 *
 * 用法：node old-b1-record.mjs <sessionsRoot> <sessionId> <outFile>
 */
import { writeFileSync } from 'node:fs';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

const [sessionsRoot, sessionId, outFile] = process.argv.slice(2);
if (!sessionsRoot || !sessionId || !outFile) throw new Error('缺 sessionsRoot/sessionId/outFile');

const env = new NodeExecutionEnv({ cwd: sessionsRoot });
const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
const session = await repo.create({ id: sessionId, cwd: '/tmp/fshine-ws' }, BACKGROUND_CONTEXT);
const branch = await session.createBranch('main', null, BACKGROUND_CONTEXT);

await branch.appendMessage({ role: 'user', content: '旧 B1 记录：查询 W1 账套', timestamp: 1 }, BACKGROUND_CONTEXT);
await branch.appendMessage({
  role: 'assistant',
  content: [{ type: 'text', text: '旧 B1 助手回复' }],
  api: 'openai-completions',
  provider: 'llm',
  model: 'test-model',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: Date.now(),
}, BACKGROUND_CONTEXT);

const messageCount = (await branch.findEntries({ order: 'oldestFirst' }, BACKGROUND_CONTEXT))
  .filter((entry) => entry.type === 'message').length;
const file = session.metadata.path;
await session.close(BACKGROUND_CONTEXT);
await repo.close(BACKGROUND_CONTEXT);
await env.cleanup(BACKGROUND_CONTEXT);
writeFileSync(outFile, JSON.stringify({ file, messageCount }), 'utf8');
