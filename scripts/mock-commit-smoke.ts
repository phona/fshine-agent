/**
 * mock 保护下的两步写链路冒烟（不经任何模型）：
 *   平台提案创建（`prepare <proposal.create 角色的 operation> <payload>`，serve 法域）
 *   → 签 HMAC 令牌 → 平台 commit（提案落账后端）→ 读回校验 → mock 状态断言
 *
 * 走的是**生产确认后的同一条服务端执行路径**：创建那一步与 context.ts 的
 * createProposalViaGateway 同一把尺（protocol 角色列寻址 + hostGatewayEnv 的 env 纪律 +
 * 只认 RESULT 信封），落账那一步直接调 apps/server/proposal-commit.ts 的
 * createProposalCommitRunner（assembly 注入的就是它）。
 *
 * **C 波改写**：本脚本原先直驱 apps/server/commit.ts 的 legacy prepare/commit runner
 * （按文件路径落账、宿主自己解提案自己物化契约）。那条路已整文件删除，冒烟随之改指新路径
 * ——W3 把"smoke:commit:mock + acceptance 5.x 写链路 mock 下全绿"定为波次唯一验收，
 * 门本身不能随实现一起退场（那等于悄悄删掉一半验收）。旧脚本自带的 mock 保险丝原样保留。
 *
 * 保险丝：检测不到 EXECUTION_EXECUTOR=mock 直接拒跑——本脚本会真实走落账，
 * 绝不允许误打真平台。
 * 用法：npm run smoke:commit:mock（=.env 需含 EXECUTION_EXECUTOR=mock）
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@fshine/core';
import {
  ensureMockStatePath,
  gatewayExecPath,
  hostGatewayEnv,
  isPlatformMock,
  loadOperationProtocols,
  newGateSecret,
  parseEnvelope,
  PROPOSAL_CREATE_PROTOCOL,
  type PlanCliRunner,
} from '@fshine/agent';
import { createProposalCommitRunner } from '../apps/server/proposal-commit';

/** CLI 超时：与 proposal-commit 的缺省 runner 同一量级（平台起不来不能吊住冒烟）。 */
const CLI_TIMEOUT_MS = 30_000;

// ── 夹具（scripts/ 显式排除在业务词预算外：领域词在这里是测试数据，不是宿主替平台说话）──
const ACCOUNT = '幻辰财税';
const PERIOD = '202607';
const contracts = [
  {
    accountSet: ACCOUNT,
    date: '2026-07-15',
    entries: [
      { summary: '冒烟·收货款', subjectCode: '1002', debit: 2000 },
      { summary: '冒烟·收货款', subjectCode: '1122', credit: 2000, assistantName: '幻电设备有限公司' },
    ],
  },
];

/** 与 proposal-commit / context.ts 的缺省 runner 同形状：spawn 网关 + 收 stdio + 超时 kill。 */
const runCli: PlanCliRunner = ({ platformRoot, args, env }) => new Promise((resolve, reject) => {
  const child = spawn(gatewayExecPath(platformRoot), args, {
    cwd: platformRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGTERM'), CLI_TIMEOUT_MS);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
  });
});

function voucherCount(statePath: string, account: string, period: string): number {
  // 首次运行时状态文件尚不存在（首次调用 respond.js 才从 seed 播种）——视为 0
  if (!existsSync(statePath)) return 0;
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    accountSets: Record<string, { vouchers: Record<string, unknown[]> }>;
  };
  return (state.accountSets[account]?.vouchers[period] ?? []).length;
}

/** 按 protocol 角色列解析"创建提案"的 operation 名；拿不到就拒绝（不回落硬编码网关名）。 */
async function proposalCreateOperation(platformRoot: string): Promise<string> {
  const protocols = await loadOperationProtocols(platformRoot).catch(() => new Map<string, string>());
  for (const [name, role] of protocols) {
    if (role === PROPOSAL_CREATE_PROTOCOL) return name;
  }
  throw new Error(`平台未声明 ${PROPOSAL_CREATE_PROTOCOL} 角色的 operation（protocol 列缺失），拒绝冒烟`);
}

async function main(): Promise<void> {
  if (!isPlatformMock()) {
    console.error('拒跑：EXECUTION_EXECUTOR=mock 未设置——本冒烟走真实落账流程，只允许在 mock 保护下执行。');
    process.exit(1);
  }
  const config = loadConfig({ env: process.env });
  const platformRoot = config.contextProfiles['17dz']?.root;
  if (!platformRoot) { console.error('拒跑：config/agent.yaml 缺少 contextProfiles.17dz.root'); process.exit(1); }

  const statePath = ensureMockStatePath(platformRoot)!;
  // 重置状态：每次冒烟从 seed 重新播种，断言才确定
  if (existsSync(statePath)) rmSync(statePath);

  const gateSecret = newGateSecret();
  const before = voucherCount(statePath, ACCOUNT, PERIOD);

  // ── [1/3] 平台提案创建（与生产同一把尺：角色列寻址 + serve 法域 + 只认 RESULT 信封）──
  const operation = await proposalCreateOperation(platformRoot);
  const payloadFile = path.join(platformRoot, 'tmp', `smoke-proposal-${randomUUID().slice(0, 8)}.json`);
  mkdirSync(path.dirname(payloadFile), { recursive: true });
  writeFileSync(payloadFile, JSON.stringify({
    type: 'change_proposal', domain: 'voucher', accountSet: ACCOUNT, period: PERIOD,
    contracts, summary: { count: contracts.length, debit: 2000, credit: 2000 },
  }, null, 2));

  const created = await runCli({
    platformRoot,
    args: ['prepare', operation, payloadFile],
    env: hostGatewayEnv(),
  });
  const envelope = parseEnvelope(created.stdout);
  const data = (envelope?.data ?? null) as { proposalId?: unknown; summaryText?: unknown } | null;
  const proposalId = typeof data?.proposalId === 'string' ? data.proposalId.trim() : '';
  const summaryText = typeof data?.summaryText === 'string' ? data.summaryText : '';
  console.log(`[1/3] 提案创建 ok=${envelope?.status === 'completed' && proposalId !== ''} proposalId=${proposalId || '(空)'}`);
  if (envelope?.status !== 'completed' || !proposalId || !summaryText) {
    console.error(`创建失败（exit ${created.code}）：${(created.stderr || created.stdout).trim().slice(-500)}`);
    process.exit(1);
  }

  // ── [2/3] 落账后端（生产注入的就是这一个）+ 平台读回校验 ─────────────────────────
  const commit = createProposalCommitRunner({ platformRoot, gateSecret });
  const com = await commit({ proposalId });
  console.log(`[2/3] 落账 ok=${com.ok} verified=${com.verified}`);
  console.log(com.output.split('\n').filter(Boolean).slice(-3).join('\n'));
  if (!com.ok) { console.error(com.error ?? ''); process.exit(1); }

  // ── [3/3] mock 状态：凭证数按提案张数增长 ───────────────────────────────────────
  const after = voucherCount(statePath, ACCOUNT, PERIOD);
  console.log(`[3/3] mock 状态 ${ACCOUNT} ${PERIOD} 凭证数 ${before} → ${after}`);
  if (after - before < contracts.length) {
    console.error('失败：mock 状态凭证数未按提案增加');
    process.exit(1);
  }

  console.log(`PASS：提案→落账→读回全链通过（mock 状态：${statePath}）`);
}

main().catch((error) => {
  console.error('冒烟脚本失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
