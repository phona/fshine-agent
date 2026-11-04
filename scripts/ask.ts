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
  newGateSecret,
} from '@fshine/agent';
import { createProposalCommitRunner } from '../apps/server/proposal-commit';
import { createPlanConfirmationWiring } from '../apps/server/plan-confirmation-route';
import { loadBusinessSkill } from '../apps/server/business-skill';
import { createMessageHandler } from '../apps/server/handler';
import { turnBudgetMsFor } from '@fshine/contracts';
import type { ChannelReply, IncomingChannelMessage } from '@fshine/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 与 acceptance.ts 相同的验收主用户（config/agent.yaml 里 capabilities=read+write 的 principal）
const AUTHORIZED_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';

function replyText(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : (reply.text ?? '(图片回复)');
}

async function main(): Promise<void> {
  // --conversation <id>：固定会话 id 供多轮脚本复用同一会话（指代/召回测试）；缺省随机。
  const convIdx = process.argv.indexOf('--conversation');
  const conversationId = convIdx >= 0 && process.argv[convIdx + 1]
    ? process.argv[convIdx + 1]!
    : `ask-${randomUUID().slice(0, 8)}`;
  const questionArgs = process.argv.slice(2).filter((arg, i, arr) => {
    if (arg === '--conversation' || arg === '--db') return false;
    const prev = arr[i - 1];
    return prev !== '--conversation' && prev !== '--db';
  });
  const question = questionArgs.join(' ').trim();
  if (!question) {
    console.error('用法：npm run ask -- "要问的问题"');
    process.exit(2);
  }
  process.env.EXECUTION_SERVE = '1'; // 平台 serve 法域
  const gateSecret = newGateSecret();
  const config = loadConfig({ env: process.env, yamlPath: process.env['AGENT_CONFIG_PATH'] || undefined });
  const platformRoot = config.contextProfiles['17dz']?.root;
  const mockStatePath = platformRoot ? ensureMockStatePath(platformRoot) : null;
  if (isPlatformMock()) {
    console.log(JSON.stringify({ event: 'platform_mock_enabled', state: mockStatePath, commitEnabled: true }));
  }

  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  // --db <path>：固定库文件供多轮脚本跨进程复用会话历史；缺省独立时间戳库。
  const dbIdx = process.argv.indexOf('--db');
  const dbPath = dbIdx >= 0 && process.argv[dbIdx + 1]
    ? path.resolve(process.argv[dbIdx + 1]!)
    : path.join(repoRoot, 'data', `ask-${Date.now()}.db`);
  const store = createSqliteStore(dbPath);
  for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);
  const businessSkill = await loadBusinessSkill(process.env);
  console.log(JSON.stringify(businessSkill.text
    ? { event: 'business_skill_loaded', path: businessSkill.path, chars: businessSkill.text.length }
    : { event: 'business_skill_skipped', path: businessSkill.path }));
  const driver = createPiTurnDriver({ env: process.env });
  // 与生产装配同构：计划激活密钥进 worker 驱动，确认门（confirm 档）的待确认计划
  // 经 SQLite 持久化——否则真实平台上一触到 confirm 门就抛"宿主未配置安全持久化
  // 回调"，冒烟链路覆盖不到计划门最关键的等待确认路径。
  const planActivationSecret = newGateSecret();
  const workerDriver = createPiCodingTurnDriver({ env: process.env, planActivationSecret });
  const platformTask = createContextTaskRunner({
    profiles: config.contextProfiles,
    tasks: store.platformTasks ?? {
      async get() { return null; },
      async upsert() { throw new Error('no store'); },
      async listBySession() { return []; },
    },
    workerDriver,
    profileId: '17dz',
    ...(platformRoot ? {
      changeIntents: store.changeIntents,
      // 与生产装配同一份接线（assembly.ts）：落账后端恒接，放行由 isCommitEnabled 单独
      // 派生（mock ⇒ 真；真平台 ⇒ 需 FSHINE_REAL_COMMIT=1，否则确认码只到 confirm_held）。
      proposalCommitRunner: createProposalCommitRunner({ platformRoot, gateSecret }),
      proposalCommitEnabled: isCommitEnabled(process.env),
    } : {}),
  });
  const runtime = createTaxAgentRuntime({
    driver,
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
    turnBudgetMs: turnBudgetMsFor(config.contextProfiles['17dz']),
    platformTask,
    ...(store.platformTasks ? { platformTasks: store.platformTasks } : {}),
    // 与生产装配同一条加载链：业务 skill（架构 §5）存在才注入
    ...(businessSkill.text ? { businessSkill: businessSkill.text } : {}),
    ...(store.taskPlans ? { taskPlans: store.taskPlans } : {}),
  });
  // 计划确认门（与生产装配同一个工厂：D-013 后不再逐字复刻接线）：待确认计划落 SQLite，
  // 用户下一条消息带"确认继续"即激活续跑——单进程 CLI 因此也能覆盖 confirm 档。
  const planConfirmation = createPlanConfirmationWiring({ dbPath, platformRoot, planActivationSecret });
  const handler = createMessageHandler({
    store,
    runtime,
    planConfirmation,
  });

  const message: IncomingChannelMessage = {
    wecomUserId: AUTHORIZED_USER,
    conversationId,
    messageId: `ask_${randomUUID()}`,
    chatType: 'single',
    text: question,
    receivedAt: new Date().toISOString(),
  };
  const started = Date.now();
  // notice 与生产渠道语义一致：送达后才继续执行；ask.ts 无渠道，打印即"送达"。
  // progress 同义：打印平台调用进度帧（生产中经企微流式帧送达）。
  const reply = await handler(message, (text) => {
    console.log('\n===== 进度 =====\n' + text);
  }, async (text) => {
    console.log('\n===== 计划通知 =====\n' + text + '\n');
  });
  const text = replyText(reply);
  console.log('\n===== 回复 =====\n' + text);
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s · db: ${dbPath})`);
  planConfirmation.close();
  closeStore(store);
}

main().catch((error) => {
  console.error('ask 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
