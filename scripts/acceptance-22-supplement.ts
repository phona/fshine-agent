/**
 * 补充验收 2.2:2.1 主流程中子代理自选了「幻海升」,未产生编号候选。
 * 本脚本在同一会话(acc-multi)中追问切换账套,验证多轮继续与重新委派。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { closeStore, createSqliteStore, firstEnabledPrincipalId, loadConfig, principalScopeRecords } from '@fshine/core';
import {
  createContextTaskRunner,
  createPiCodingTurnDriver,
  createPiTurnDriver,
  createTaxAgentRuntime,
  PLAN_SUBMIT_STEP,
} from '@fshine/agent';
import { createMessageHandler } from '../apps/server/handler';
import { turnBudgetMsFor, resolveActiveProfileId } from '@fshine/contracts';
import type { ChannelReply, IncomingChannelMessage } from '@fshine/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const CONV = 'acc-multi';

function replyText(reply: ChannelReply): string {
  return typeof reply === 'string' ? reply : (reply.text ?? '(图片回复)');
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env });
  // 执行层 profile id 无关派生（W1 C5 规矩）：单 profile 取其键，0/多个 -> undefined，消费方 fail-closed；宿主不把实例名当缺省。
  const profileId = resolveActiveProfileId(config.contextProfiles);
  // 授权用户 = config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）首个
  // enabled principal（与 acceptance.ts 同一来源）。null = 没人可用：明确报错退出，
  // 不回落写死值（真实 UserID 曾是这里的硬编码）。
  const AUTHORIZED_USER = firstEnabledPrincipalId(config);
  if (!AUTHORIZED_USER) {
    console.error('config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）里没有 enabled 的 principal——补充验收脚本无法派生授权用户（fail-closed，不回落写死值）');
    process.exit(1);
  }
  const dataDir = path.join(repoRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  // 复用主流程验收库,保证 acc-multi 会话里 2.1/2.3 的历史在场,才是真正的多轮继续。
  const dbPath = process.env['ACCEPTANCE_DB_PATH']
    ?? path.join(dataDir, 'acceptance-202609181621.db');
  const store = createSqliteStore(dbPath);
  for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);

  const runtime = createTaxAgentRuntime({
    driver: createPiTurnDriver({ env: process.env }),
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
    turnBudgetMs: turnBudgetMsFor(config.contextProfiles[profileId ?? '']),
    platformTask: createContextTaskRunner({
      profiles: config.contextProfiles,
      tasks: store.platformTasks!,
      workerDriver: createPiCodingTurnDriver({ env: process.env }),
      profileId,
    }),
  });
  const handler = createMessageHandler({ store, runtime });
  const auditDb = new Database(dbPath);

  const message: IncomingChannelMessage = {
    wecomUserId: AUTHORIZED_USER,
    conversationId: CONV,
    messageId: `accmsg_${randomUUID()}`,
    chatType: 'single',
    text: '那不查幻海升了，换成幻晟，帮我查幻晟本期的凭证',
    receivedAt: new Date().toISOString(),
  };
  const steps: string[] = [];
  const started = Date.now();
  const reply = await handler(message, (step) => {
    if (!steps.includes(step)) steps.push(step);
  });
  const durationMs = Date.now() - started;
  const request = await store.requests.findByWecomMessageId(message.messageId);
  const taskRow = auditDb.prepare(
    'SELECT task_id, worker_messages FROM platform_tasks WHERE parent_session_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get(`wecom:${AUTHORIZED_USER}:${CONV}`) as { task_id: string; worker_messages: string } | undefined;
  closeStore(store);
  auditDb.close();

  const reportPath = path.join(dataDir, `acceptance-report-${runId}-22.md`);
  writeFileSync(reportPath, [
    `# 验收记录(补充 2.2 · ${runId})`,
    '',
    `- messageId:${message.messageId}`,
    `- requestId:${request?.requestId ?? '无'}`,
    `- 主会话:wecom:${AUTHORIZED_USER}:${CONV}`,
    `- taskId:${taskRow?.task_id ?? '无'}`,
    `- 进度事件:${steps.join(' → ') || '无'}`,
    `- 耗时:${(durationMs / 1000).toFixed(1)}s`,
    '',
    '## 最终回复:',
    '',
    replyText(reply),
    '',
  ].join('\n'));
  console.log(JSON.stringify({
    event: 'acceptance_case_done', case: '2.2-supplement', durationMs,
    delegated: steps.includes(PLAN_SUBMIT_STEP) || Boolean(taskRow),
    report: reportPath,
  }));
}

main().catch((error) => {
  console.error('补充验收失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
