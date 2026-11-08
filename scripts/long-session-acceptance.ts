/**
 * 长会话实测（两条从未实弹的路径）：
 *   --mode=ttl   40 轮历史 + updated_at 过期 25h → 软着陆强制压缩 + 记忆探针
 *   --mode=auto  自校准种子到超过自动压缩阈值(111,616 tokens) → 非强制触发
 * 都用真 LLM：compact 摘要与探针回复全部真实产出。
 * 用法: node --env-file=.env --import tsx scripts/long-session-acceptance.ts --mode=ttl|auto
 *
 * 【夹具声明（D-006 显式决策，登记于 docs/debt-ledger.md）】
 * 本文件是**验收夹具**：round() 里的账套名/期间/张数/金额/游标全部是按索引算术生成的
 * **编造数据**，用于给压缩与记忆探针提供"真实感"的输入材料。这些数字**不得作为期望值
 * 引用**（不是任何平台查询的结果，也不构成对平台口径的陈述）；L1 的业务词预算把
 * scripts/ 显式排除在扫描范围外正是基于这一条（领域词在夹具里是测试数据，不是宿主替
 * 平台说话）。若要把其中任何数字当断言用，先换成平台真实规范名与真实返回值。
 */
import { randomUUID } from 'node:crypto';
import { closeStore, createSqliteStore, firstEnabledPrincipalId, loadConfig, principalScopeRecords, newId } from '@fshine/core';
import { turnBudgetMsFor, resolveActiveProfileId } from '@fshine/contracts';
import { createContextTaskRunner, createPiCodingTurnDriver, createPiTurnDriver, createTaxAgentRuntime } from '@fshine/agent';
import { estimateContextTokens, type AgentMessage } from '@earendil-works/pi-agent-core';

const mode = process.argv.includes('--mode=auto') ? 'auto' : 'ttl';
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

/** 一轮真实感问答（含账套 id、期间、翻页游标、结论——压缩摘要的保留目标） */
function round(i: number): { user: string; assistant: string } {
  const sets = ['幻晟', '幻海升', '幻辰', '幻骥达', '幻跃'];
  const name = sets[i % sets.length]!;
  const id = `as_${(i + 1001).toString().padStart(6, '0')}`;
  const period = `2026${String((i % 12) + 1).padStart(2, '0')}`;
  const cursor = `cur_${randomUUID().slice(0, 8)}`;
  const topics = [
    `查询${name}（${id}）${period} 期凭证`,
    `${name} ${period} 应收账款余额与客户辅助明细`,
    `${name} ${period} 管理费用按明细科目汇总`,
    `${name} ${period} 银行存款日记账核对`,
    `${name} ${period} 进项税额与销项税额勾稽`,
  ];
  return {
    user: `${topics[i % topics.length]}，一共大概多少张凭证？`,
    assistant: `已完成 ${name}（${id}）${period} 期查询：凭证共 ${(i * 7 + 13) % 90 + 5} 张，借贷合计各 ${((i * 3517) % 900000 + 1000).toLocaleString()} 元，全部借贷平衡。`
      + `期间状态：${period} 已结账。分页游标：nextCursor=${cursor}（如需下一页请携带此值）。`
      + `结论：往来款集中在前三大客户，建议关注账龄超过 90 天的部分。`,
  };
}

function buildTranscript(rounds: number, opts?: { lastUsageInput?: number }): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const r = round(i);
    out.push({ role: 'user', content: [{ type: 'text', text: r.user }], timestamp: Date.now() - (rounds - i) * 60_000 } as unknown as AgentMessage);
    out.push({ role: 'assistant', content: [{ type: 'text', text: r.assistant }], timestamp: Date.now() - (rounds - i) * 60_000 + 30_000 } as unknown as AgentMessage);
  }
  if (opts?.lastUsageInput) {
    // 驱动 estimateContextTokens：真实转录的最后一条 assistant 带真实 API usage
    const last = out[out.length - 1] as { usage?: unknown };
    last.usage = { input: opts.lastUsageInput, output: 800, cacheRead: 0, cacheWrite: 0 };
  }
  return out;
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env });
  // 执行层 profile id 无关派生（W1 C5 规矩）：单 profile 取其键，0/多个 -> undefined，消费方 fail-closed；宿主不把实例名当缺省。
  const profileId = resolveActiveProfileId(config.contextProfiles);
  // 授权用户 = config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）首个
  // enabled principal。null = 没人可用：明确报错退出，不回落写死值（真实 UserID 曾是
  // 这里的硬编码）。
  const USER = firstEnabledPrincipalId(config);
  if (!USER) {
    console.error('config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）里没有 enabled 的 principal——长会话实测脚本无法派生授权用户（fail-closed，不回落写死值）');
    process.exit(1);
  }
  const SESSION = `wecom:${USER}:ls-${mode}`;
  const store = createSqliteStore(`data/acceptance-ls-${mode}-${runId}.db`);
  for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);

  const platformTask = createContextTaskRunner({
    profiles: config.contextProfiles,
    tasks: store.platformTasks!,
    workerDriver: createPiCodingTurnDriver({ env: process.env }),
    profileId,
    // 长会话实测不写任何数据：落账后端不注入（proposalCommitRunner 缺省 = 未接线），
    // 确认码只会到达"执行失败：落账执行器未配置"——这是宿主如实说自己没做到，
    // 不是对"这个部署允不允许写"的判断（2026-11-08 裁定后没有 commit 授权位）。
    changeIntents: store.changeIntents,
  });
  const runtime = createTaxAgentRuntime({
    driver: createPiTurnDriver({ env: process.env }),
    sessions: store.sessions,
    sessionTtlMs: config.sessionTtlMs,
    turnBudgetMs: turnBudgetMsFor(config.contextProfiles[profileId ?? '']),
    platformTask,
  });

  if (mode === 'ttl') {
    // 40 轮历史 + 过期 25h → 软着陆强制压缩
    const messages = buildTranscript(40);
    const est = estimateContextTokens(messages).tokens;
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await store.sessions.upsert({
      sessionId: SESSION, principalId: `wecom:${USER}`, channelConversationId: SESSION,
      updatedAt: stale, state: messages,
    });
    console.log(JSON.stringify({ event: 'seed_done', mode, rounds: 40, estTokens: est, updatedAt: stale }));
    const lastRound = round(39);
    const reply = await runtime.handleTurn({
      requestId: newId('req'), principalId: `wecom:${USER}`,
      allowedAccountSetIds: [], sessionId: SESSION, capabilities: ['read', 'write'],
    }, '我们之前一共查过哪些账套？把最后一个账套的名字和它最后一次翻页用的 nextCursor 原值告诉我。');
    console.log(JSON.stringify({ event: 'probe_reply', text: reply.text.slice(0, 600) }));
    console.log(`探针期望参考（最后一条历史）：账套=${lastRound.assistant.slice(0, 20)}…`);
  } else {
    // auto：自校准种子，直到估算超过阈值 111,616（128k - 16k reserve）
    let rounds = 100;
    let est = 0;
    let messages: AgentMessage[] = [];
    for (;;) {
      messages = buildTranscript(rounds, { lastUsageInput: 130_000 });
      est = estimateContextTokens(messages).tokens;
      if (est > 111_616) break;
      rounds += 60;
      if (rounds > 1200) break;
    }
    await store.sessions.upsert({
      sessionId: SESSION, principalId: `wecom:${USER}`, channelConversationId: SESSION,
      updatedAt: new Date().toISOString(), state: messages,
    });
    console.log(JSON.stringify({ event: 'seed_done', mode, rounds, estTokens: est, threshold: 111_616 }));
    const reply = await runtime.handleTurn({
      requestId: newId('req'), principalId: `wecom:${USER}`,
      allowedAccountSetIds: [], sessionId: SESSION, capabilities: ['read', 'write'],
    }, '这个会话里我们主要在查什么？最近几次查询围绕哪些账套？');
    console.log(JSON.stringify({ event: 'probe_reply', text: reply.text.slice(0, 600) }));
  }

  const saved = store.sessions.get ? await store.sessions.get(SESSION) : null;
  const savedLen = saved && Array.isArray(saved.state) ? (saved.state as unknown[]).length : -1;
  console.log(JSON.stringify({ event: 'done', mode, savedTranscriptMessages: savedLen }));
  closeStore(store);
}

main().catch((e) => {
  console.error('LONG_SESSION_FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
