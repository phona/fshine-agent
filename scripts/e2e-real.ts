/**
 * 真实 17dz MCP 端到端只读验证(不经企微线路,其余全真):
 * 合成消息 → 授权 → Agent(Kimi 真调用)→ MCP host → 真实 17dz MCP server → 回复。
 * 只读保证:principal 默认 capabilities=['read'],host 不传 toolPolicy 时仅暴露 READ_TOOLS 白名单。
 * 用法:node --env-file=.env --import tsx scripts/e2e-real.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  closeStore,
  createSqliteStore,
  loadConfig,
  newId,
  principalScopeRecords,
} from '@fshine/core';
import { McpHost, type McpToolPolicy } from '@fshine/mcp-host';
import { createPiTurnDriver, createTaxAgentRuntime } from '@fshine/agent';
import type { IncomingChannelMessage, ProgressFn } from '@fshine/contracts';
import { createMessageHandler } from '../apps/server/handler';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-e2e-real-'));
const yamlPath = path.join(tmpDir, 'agent.yaml');

// 与 config/agent.yaml 的 read-default profile 和 principals 授权保持一致;
// 不读原 yaml 是为了让测试对原配置的临时改动免疫(测试即产物,可复跑)。
const REAL_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';
writeFileSync(yamlPath, `
principals:
  "wecom:${REAL_USER}":
    mcpProfile: read-default
    accountSetIds: ["as_001"]
    enabled: true
mcpProfiles:
  read-default:
    command: npm
    args: ["run", "mcp"]
    cwd: /home/fictional-user/fictional-projects/fictional-execution-layer
    requestTimeoutMs: 60000
    maxRetries: 2
    env:
      ALLOWED_ACCOUNT_SETS: ""
`);

const config = loadConfig({ env: process.env, yamlPath });
const store = createSqliteStore(path.join(tmpDir, 'e2e-real.db'));
for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);

// 与 apps/server/main.ts 的 combinedToolPolicy 一致:连接层接受全部声明工具,
// 只读性由 principal capabilities=['read'] → clientFor 仅暴露 read 类工具保证。
const toolPolicy: McpToolPolicy = {
  allowedTools: [
    'get_login_status', 'search_account_sets', 'get_current_accounting_period', 'list_vouchers', 'inspect_account_set',
    'validate_voucher', 'submit_voucher', 'submit_voucher_batch', 'get_submission_status',
  ],
  categories: {
    get_login_status: 'read', search_account_sets: 'read', get_current_accounting_period: 'read',
    list_vouchers: 'read', inspect_account_set: 'read', validate_voucher: 'validate',
    submit_voucher: 'write', submit_voucher_batch: 'write', get_submission_status: 'status',
  },
};
const host = new McpHost({ profile: config.mcpProfiles['read-default']!, toolPolicy });
await host.ensureReady();
console.log(`[host] 真实 MCP 已就绪,工具: ${host.discoveredTools.map((t) => t.name).join(', ')}`);

const runtime = createTaxAgentRuntime({
  driver: createPiTurnDriver({ env: process.env }),
  sessions: store.sessions,
});
const handler = createMessageHandler({ store, runtime, hostFor: () => host });

let seq = 0;
const progressLog: string[] = [];
function send(wecomUserId: string, text: string): Promise<string> {
  seq += 1;
  const message: IncomingChannelMessage = {
    wecomUserId,
    conversationId: 'e2e-real',
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
  return handler(message, progress).then((reply) => {
    console.log(`----- 回复:\n${reply}`);
    return reply;
  });
}

try {
  const denied = await send('stranger_404', '查一下幻晟本期的凭证');
  if (!denied.includes('未开通查询权限')) {
    throw new Error(`未授权用户未被拒绝,回复:${denied}`);
  }
  console.log('✓ 未授权用户被正确拒绝');

  const first = await send(REAL_USER, '查一下幻晟本期的凭证');
  if (!first.includes('幻晟')) throw new Error(`首轮查询异常:${first}`);
  const gotData = first.includes('凭证') || /\d{4,}/.test(first);
  console.log(gotData
    ? '✓ 首轮查询返回真实凭证数据(真 Kimi + 真 host + 真 17dz MCP)'
    : 'ℹ 首轮未直接返回凭证(可能进入澄清或多步追问)');
  const picked = first.includes('请选择') || first.includes('请回复') || first.includes('1.')
    ? await send(REAL_USER, '1')
    : first;
  if (picked.includes('未开通')) throw new Error(`选定账套后被拒:${picked}`);

  const next = await send(REAL_USER, '下一页');
  const nextOk = !next.includes('请选择') && !next.includes('无法确定');
  console.log(nextOk ? '✓ 下一页续查成功(游标跨回合生效)' : `ℹ 翻页回复存疑:${next.slice(0, 80)}`);

  const followUp = await send(REAL_USER, '刚才查的是哪个账套?');
  if (!followUp.includes('幻晟')) {
    throw new Error(`历史追问失败(历史重放未生效):${followUp}`);
  }
  console.log('✓ 历史追问命中上一轮账套(有界历史重放生效)');

  if (progressLog.length === 0) throw new Error('整个会话未产生任何进度事件');

  const calls = new Database(path.join(tmpDir, 'e2e-real.db'))
    .prepare('SELECT tool_name, status, source, trace_id, error_code FROM tool_calls ORDER BY id')
    .all() as Array<{ tool_name: string; status: string; source: string | null; trace_id: string | null; error_code: string | null }>;
  console.log('\n[审计 tool_calls]');
  for (const c of calls) {
    console.log(`  ${c.tool_name} status=${c.status} source=${c.source ?? '-'} trace=${c.trace_id ?? '-'} err=${c.error_code ?? '-'}`);
  }
  const failed = calls.filter((c) => c.status === 'error');
  if (failed.length > 0) throw new Error(`存在失败的工具调用:${failed.map((c) => c.tool_name).join(',')}`);

  console.log('\nE2E-REAL PASS');
} finally {
  host.stop();
  closeStore(store);
}
