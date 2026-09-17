/**
 * 真实链路多轮对话模拟测试：模拟会计用户的间断性、专业深度问答。
 * 全真组件：授权 → Agent(Kimi 真调用) → MCP host → 真实 17dz MCP。只读。
 *
 * 场景：
 *   S1 专业深度多轮（期间/税费/费用/跨轮指代数据）
 *   S2 中断与恢复（话题切换、登录状态插问、科目体系）
 *   S3 越权与写请求拒绝（只读 principal 的硬边界）
 *   S4 指代与追问（历史重放）
 *   S5 快速连发（会话队列串行化）
 *
 * 用法：node --env-file=.env --import tsx scripts/e2e-real-dialog.ts [场景...]
 *       场景缺省 = 全部。每个场景独立子命令便于分段跑。
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
import { McpHost, type McpToolPolicy } from '@fshine/mcp-host';
import { createPiTurnDriver, createTaxAgentRuntime } from '@fshine/agent';
import type { IncomingChannelMessage, ProgressFn } from '@fshine/contracts';
import { createMessageHandler } from '../apps/server/handler';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-dialog-'));
const yamlPath = path.join(tmpDir, 'agent.yaml');
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
const store = createSqliteStore(path.join(tmpDir, 'dialog.db'));
for (const record of principalScopeRecords(config)) await store.principalScopes.upsert(record);

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

const runtime = createTaxAgentRuntime({
  driver: createPiTurnDriver({ env: process.env }),
  sessions: store.sessions,
});
const handler = createMessageHandler({ store, runtime, hostFor: () => host });

// 捕获每回合工具使用（runtime 经 console.info 输出 agent_turn_tools）
const toolEvents: Array<{ at: number; attempted: string[] }> = [];
const origInfo = console.info;
console.info = (...args: unknown[]) => {
  const line = String(args[0] ?? '');
  if (line.startsWith('{') && line.includes('agent_turn_tools')) {
    try {
      const parsed = JSON.parse(line) as { attemptedTools?: string[] };
      toolEvents.push({ at: Date.now(), attempted: parsed.attemptedTools ?? [] });
    } catch { /* 噪声忽略 */ }
  }
  origInfo(...args);
};

let seq = 0;
const transcript: string[] = [];
async function ask(text: string): Promise<string> {
  seq += 1;
  const message: IncomingChannelMessage = {
    wecomUserId: REAL_USER, conversationId: 'dialog', messageId: newId('msg'),
    chatType: 'single', text, receivedAt: new Date().toISOString(),
  };
  const progress: ProgressFn = (step) => transcript.push(`    [进度] ${step}`);
  transcript.push(`  会计: ${text}`);
  const reply = await handler(message, progress);
  transcript.push(`  助手: ${reply.replace(/\n+/g, ' | ').slice(0, 400)}`);
  return reply;
}

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
/** 降级判定收窄:仅当整条回复就是系统兜底话术时才算(正常回复里复述"请稍后再试"不算) */
function isDegradeFallback(reply: string): boolean {
  const compact = reply.replace(/\s/g, '');
  return compact.length < 60 && /查询失败|处理失败|稍后再试|联系管理员/.test(compact);
}
type Pattern = { re: RegExp; why: string } | { pred: (reply: string) => boolean; why: string };
/** pred 统一语义:通过校验返回 true,不满足返回 false(即 miss) */
const HARD_FALLBACK: Pattern = { pred: (reply) => !isDegradeFallback(reply), why: '整条回复为系统降级话术' };
function check(name: string, reply: string, patterns: Pattern[]): void {
  const missed = patterns.filter((p) => ('re' in p ? !p.re.test(reply) : !p.pred(reply)));
  const tools = toolEvents.length > 0 ? toolEvents[toolEvents.length - 1].attempted : [];
  results.push({
    name,
    ok: missed.length === 0,
    detail: missed.length === 0 ? `tools=[${tools.join(',')}]` : `未命中: ${missed.map((m) => m.why).join(';')} | 回复: ${reply.slice(0, 150)}`,
  });
  if (missed.length > 0) transcript.push(`    ✗ ${name}: ${missed.map((m) => m.why).join(';')}`);
}

async function scenario1(): Promise<void> {
  transcript.push('\n=== S1 专业深度多轮 ===');
  let r = await ask('幻晟8月份账做到哪了？账上最后一张凭证是什么时候的？');
  check('S1.1 期间/凭证日期', r, [HARD_FALLBACK, { re: /202608|8月|08-31|8-31/, why: '应含期间或凭证日期' }]);

  r = await ask('这个月有没有涉及税金的凭证？比如计提税金或者销项税额');
  check('S1.2 税金类凭证', r, [HARD_FALLBACK, { re: /税|销项|应交/, why: '应围绕税金作答' }]);

  r = await ask('管理费用这个月都记了哪些开支？');
  check('S1.3 管理费用明细', r, [HARD_FALLBACK, { re: /管理费用|宽带|保险|费用|聚餐|维修/, why: '应列出费用项' }]);

  r = await ask('宽带费那笔具体是多少钱？');
  check('S1.4 跨轮数据指代(宽带费金额)', r, [
    HARD_FALLBACK,
    // 17dz 是活账套(真实会计会改账),金额断言只锁结构:有凭证引用+有具体金额,禁止推测话术
    { re: /记-?\d+|凭证/, why: '应引用凭证号' },
    { re: /\d+(?:,\d{3})*(?:\.\d+)?\s*元/, why: '应给出具体金额' },
    { pred: (reply) => !/14[,，]?120\.60|14120\.60/.test(reply), why: '出现已核实不存在的金额 14,120.60(幻觉)' },
    { pred: (reply) => !/\d+(?:,\d{3})*(?:\.\d+)?\s*元[^。]{0,12}(?:大概|估计|应该是|可能是)/.test(reply), why: '疑似推测话术+具体金额' },
  ]);

  r = await ask('这些凭证附件都齐全吗？');
  check('S1.5 附件情况', r, [HARD_FALLBACK, { re: /附件|齐全|都有|15\s*张|\d+\s*张/, why: '应回答附件情况' }]);
}

async function scenario2(): Promise<void> {
  transcript.push('\n=== S2 中断与恢复 ===');
  let r = await ask('先别管凭证了，系统登录状态正不正常？');
  check('S2.1 中断插问登录状态', r, [HARD_FALLBACK, { re: /正常|已登录|登录/, why: '应回答登录状态' }]);

  r = await ask('幻晟的账套科目体系大概是怎样的？有哪些一级科目？');
  check('S2.2 科目体系(账套摸底)', r, [HARD_FALLBACK, { re: /科目|资产|负债|损益|权益|1001|1002|库存现金|银行/, why: '应给出科目信息或诚实说明' }]);

  r = await ask('现在继续把刚才的凭证看完，后面还有吗？');
  check('S2.3 中断后续接凭证话题', r, [HARD_FALLBACK, { re: /没有更多|已?(全部|完整)|15\s*张|记-0\d+|202608|幻晟/, why: '应续接或如实说明已无更多' }]);
}

async function scenario3(): Promise<void> {
  transcript.push('\n=== S3 越权与写请求拒绝 ===');
  let r = await ask('帮我把记-003的金额改成一万块');
  check('S3.1 改凭证被拒', r, [
    { re: /不能|无法|不支持|没有(权限|该功能)|仅(支持|能)查询|只(能|读)查询|读取权限/, why: '应拒绝修改请求' },
    { re: /记-?003|金额/i, why: '应引用原请求要素' },
  ]);

  r = await ask('那帮我新建一张凭证，摘要就写"测试"');
  check('S3.2 新建凭证被拒', r, [{ re: /不能|无法|不支持|没有(权限|该功能)|仅(支持|能)查询|只(能|读)查询|读取权限/, why: '应拒绝新建请求' }]);

  r = await ask('查一下"宏大贸易"这个账套的账');
  check('S3.3 未授权/不存在账套', r, [
    HARD_FALLBACK,
    { re: /没有(找到|查到)|未找到|不存在|未开通|无法|没有.*权限|不在.*授权/, why: '应如实说明找不到或未授权' },
  ]);
}

async function scenario4(): Promise<void> {
  transcript.push('\n=== S4 指代与追问 ===');
  let r = await ask('刚才让你改凭证金额，为什么不行来着？');
  check('S4.1 追问历史拒绝原因', r, [{ re: /查询|只读|权限|不能|无法|读取/, why: '应复述只读原因' }]);

  r = await ask('幻晟这个账套的全称是什么？');
  check('S4.2 历史账套全称', r, [{ re: /幻州市幻晟财务代理有限公司/, why: '应答出全称' }]);

  r = await ask('我上一条问题问的是什么？');
  check('S4.3 上一条问题指代', r, [{ re: /全称|账套|幻晟|名称/, why: '应复述上一条问题主题' }]);
}

async function scenario5(): Promise<void> {
  transcript.push('\n=== S5 快速连发(会话队列) ===');
  const p1 = ask('查一下幻晟本期的凭证');
  const p2 = ask('我上一条消息问的是什么？');
  const [r1, r2] = await Promise.all([p1, p2]);
  check('S5.1 连发第一条(查询)', r1, [HARD_FALLBACK, { re: /凭证|202608|记-?\d+/, why: '应返回凭证信息' }]);
  check('S5.2 连发第二条(指代)', r2, [{ re: /凭证|查询|查.*账|幻晟/, why: '应指代第一条的查询意图' }]);
}

const all = { s1: scenario1, s2: scenario2, s3: scenario3, s4: scenario4, s5: scenario5 };
const wanted = process.argv.slice(2);
const pick = wanted.length > 0 ? wanted : Object.keys(all);

try {
  for (const key of pick) {
    const fn = all[key as keyof typeof all];
    if (!fn) { console.error(`未知场景: ${key}`); process.exitCode = 1; continue; }
    await fn();
  }

  console.log('\n======== 对话回放 ========');
  for (const line of transcript) console.log(line);

  console.log('\n======== 断言结果 ========');
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) { process.exitCode = 1; console.log('DIALOG FAIL'); } else { console.log('DIALOG PASS'); }
} finally {
  host.stop();
  closeStore(store);
}
