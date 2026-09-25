/**
 * 单条消息联调入口：把一条用户消息灌进与生产一致的 handler 链路
 * （store → runtime → handler，真 LLM + .env 声明的平台模式），打印最终回复。
 * 用法：npm run ask -- "查一下幻辰财税本期的凭证"
 * 独立验收库（data/ask-<ts>.db），不碰生产数据；写链路与验收相同（mock 下放开）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeStore, createSqliteStore, loadConfig, principalScopeRecords } from '@fshine/core';
import {
  createContextTaskRunner,
  createPiCodingTurnDriver,
  createPiTurnDriver,
  createTaxAgentRuntime,
  ensureMockStatePath,
  isCommitEnabled,
  isPlatformMock,
} from '@fshine/agent';
import { createCommitRunner, createPrepareRunner, newGateSecret } from '../apps/server/commit';
import { loadBusinessSkill } from '../apps/server/business-skill';
import { createMessageHandler } from '../apps/server/handler';
import type { ChannelReply, IncomingChannelMessage } from '@fshine/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 acceptance.ts 相同的验收主用户（config/agent.yaml 里 capabilities=read+write 的 principal）
const AUTHORIZED_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';

function replyText(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : (reply.text ?? '(图片回复)');
}

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('用法：npm run ask -- "要问的问题"');
    process.exit(2);
  }
  process.env.DZ_SERVE = '1'; // 平台 serve 法域
  const gateSecret = newGateSecret();
  const config = loadConfig({ env: process.env, yamlPath: process.env['AGENT_CONFIG_PATH'] || undefined });
  const platformRoot = config.contextProfiles['17dz']?.root;
  const mockStatePath = platformRoot ? ensureMockStatePath(platformRoot) : null;
  if (isPlatformMock()) {
    console.log(JSON.stringify({ event: 'platform_mock_enabled', state: mockStatePath, commitEnabled: true }));
  }

  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  const dbPath = path.join(repoRoot, 'data', `ask-${Date.now()}.db`);
  const store = createSqliteStore(dbPath);
  for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);
  const businessSkill = await loadBusinessSkill(process.env);
  console.log(JSON.stringify(businessSkill.text
    ? { event: 'business_skill_loaded', path: businessSkill.path, chars: businessSkill.text.length }
    : { event: 'business_skill_skipped', path: businessSkill.path }));
  const driver = createPiTurnDriver({ env: process.env });
  const workerDriver = createPiCodingTurnDriver({ env: process.env });
  const platformTask = createContextTaskRunner({
    profiles: config.contextProfiles,
    tasks: store.platformTasks ?? { async get() { return null; }, async upsert() { throw new Error('no store'); } },
    workerDriver,
    profileId: '17dz',
    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      prepareRunner: createPrepareRunner({ platformRoot, gateSecret }),
      commitRunner: createCommitRunner({ platformRoot, gateSecret }),
      commitEnabled: isCommitEnabled(),
    } : {}),
  });
  const runtime = createTaxAgentRuntime({
    driver,
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
    turnBudgetMs: (config.contextProfiles['17dz']?.workerTimeoutMs ?? 600_000) + 120_000,
    platformTask,
    // 与生产装配同一条加载链：业务 skill（架构 §5）存在才注入
    ...(businessSkill.text ? { businessSkill: businessSkill.text } : {}),
    ...(store.taskPlans ? { taskPlans: store.taskPlans } : {}),
  });
  const handler = createMessageHandler({ store, runtime });

  const message: IncomingChannelMessage = {
    wecomUserId: AUTHORIZED_USER,
    conversationId: `ask-${randomUUID().slice(0, 8)}`,
    messageId: `ask_${randomUUID()}`,
    chatType: 'single',
    text: question,
  };
  const started = Date.now();
  const reply = await handler(message, () => {});
  const text = replyText(reply);
  console.log('\n===== 回复 =====\n' + text);
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s · db: ${dbPath})`);
  closeStore(store);
}

main().catch((error) => {
  console.error('ask 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
