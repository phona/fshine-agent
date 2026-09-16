/**
 * 端到端能力验证(不经企微线路,其余全真):
 * 合成消息 → 授权 → Agent(Kimi 真调用)→ MCP host → Fake17dzMcpServer → 回复。
 * 用法:node --env-file=.env --import tsx scripts/e2e-turn.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeStore,
  createSqliteStore,
  loadConfig,
  newId,
  principalScopeRecords,
} from '@fshine/core';
import { McpHost } from '@fshine/mcp-host';
import { createTaxAgentRuntime, OpenAICompatibleChatModel } from '@fshine/agent';
import type { IncomingChannelMessage, McpProfileConfig, ProgressFn } from '@fshine/contracts';
import { createMessageHandler } from '../apps/server/handler';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-e2e-'));
const yamlPath = path.join(tmpDir, 'agent.yaml');

writeFileSync(yamlPath, `
principals:
  "wecom:smoke_test_user":
    mcpProfile: read-default
    accountSetIds: ["as_001"]
    enabled: true
mcpProfiles:
  read-default:
    command: node
    args: ["automation/mcp/src/server-read.js"]
    cwd: /tmp/unused-in-fake-mode
    requestTimeoutMs: 60000
    maxRetries: 2
`);

const config = loadConfig({ env: process.env, yamlPath });
const store = createSqliteStore(path.join(tmpDir, 'e2e.db'));
for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);

const fakeProfile: McpProfileConfig = {
  command: process.execPath,
  args: ['--import', 'tsx', path.join(repoRoot, 'packages/mcp-fake/src/main.ts')],
  cwd: repoRoot,
  requestTimeoutMs: 60_000,
  maxRetries: 2,
};
const host = new McpHost({ profile: fakeProfile });
await host.ensureReady();

const runtime = createTaxAgentRuntime({
  model: OpenAICompatibleChatModel({ env: process.env }),
  sessions: store.sessions,
});
// 观测用代理:打印模型每步动作(不影响行为)
const loggingRuntime = createTaxAgentRuntime({
  model: {
    complete: async (req) => {
      const out = await OpenAICompatibleChatModel({ env: process.env }).complete(req);
      console.log(`[model] ${out.replace(/\s+/g, ' ').slice(0, 200)}`);
      return out;
    },
  },
  sessions: store.sessions,
});
const handler = createMessageHandler({ store, runtime: loggingRuntime, hostFor: () => host });

let seq = 0;
const progressLog: string[] = [];
function send(wecomUserId: string, text: string): Promise<string> {
  seq += 1;
  const message: IncomingChannelMessage = {
    wecomUserId,
    conversationId: 'e2e',
    messageId: newId('msg'),
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
  console.log(`\n===== [${seq}] ${wecomUserId}: ${text}`);
  const progress: ProgressFn = (step) => {
    progressLog.push(`[${seq}] ${step}`);
    console.log(`[progress] ${step}`);
  };
  return handler(message, progress).then(async (reply) => {
    console.log(`----- 回复:\n${reply}`);
    const saved = await store.sessions.get('smoke_test_user:e2e');
    console.log(`[state] ${JSON.stringify(saved?.state)}`);
    return reply;
  });
}

try {
  const denied = await send('stranger_404', '查一下幻晟本期的凭证');
  if (!denied.includes('未开通查询权限')) {
    throw new Error(`未授权用户未被拒绝,回复:${denied}`);
  }
  console.log('✓ 未授权用户被正确拒绝');

  const clarify = await send('smoke_test_user', '查一下幻晟本期的凭证');
  if (!clarify.includes('幻晟')) {
    throw new Error(`澄清回复异常:${clarify}`);
  }
  const isClarify = clarify.includes('请选择') || clarify.includes('请回复') || clarify.includes('1.');
  console.log(isClarify
    ? '✓ 多候选触发澄清(验收 #4,真 Kimi)'
    : 'ℹ 未触发澄清,直接返回了数据(候选恰好唯一时属正常)');

  const picked = isClarify ? await send('smoke_test_user', '1') : clarify;
  if (!picked.includes('幻晟') || picked.includes('未开通')) {
    throw new Error(`选定账套后未返回数据:${picked}`);
  }
  console.log('✓ 选定账套后返回凭证数据(真 Kimi + 真 host + 真 Fake server)');

  const next = await send('smoke_test_user', '下一页');
  const nextOk = !next.includes('请选择') && !next.includes('无法确定') && !next.includes('没有理解');
  if (!nextOk) throw new Error(`翻页未能续上:${next}`);
  console.log('✓ 下一页续查成功');

  const followUp = await send('smoke_test_user', '刚才查的是哪个账套?');
  if (!followUp.includes('幻晟')) {
    throw new Error(`历史追问失败(历史重放未生效):${followUp}`);
  }
  console.log('✓ 历史追问命中上一轮账套(有界历史重放生效)');

  if (progressLog.length === 0) {
    throw new Error('整个会话未产生任何进度事件');
  }
  console.log(`✓ 进度播报共 ${progressLog.length} 条(埋点/意图短语经节流前)`);

  console.log('\nE2E PASS');
} finally {
  host.stop();
  closeStore(store);
}
