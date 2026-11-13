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
 * 门本身不能随实现一起退场（那等于悄悄删掉一半验收）。acceptance 5.x 这一半已随旧脚手架
 * 于 2026-11-13（M2 波次 1）退役；本冒烟门保留。
 *
 * 保险丝（两道，都 fail-closed，见 main() 头一段）：
 *   ① EXECUTION_MOCK_STATE 已声明——本脚本要读它做凭证数断言；
 *   ② 活跃 profile 的 root 落在仓内夹具目录 scripts/eval/fixtures 之下（判据复用评测
 *      安全门 assessEvalIsolation）——这是**文件系统事实**：root 在仓内 ⇒ 执行层就是仓内
 *      应答器，不是任何真实平台。曾只有第 ① 道（2026-11-08 第一版把判据从
 *      EXECUTION_EXECUTOR 换成"路径已声明"），但"声明路径"不决定执行层用哪个执行器，
 *      留着 env 同时切真实执行器就会照常落账——PR #21 审查 blocking，补上第 ② 道。
 * 用法：EXECUTION_MOCK_STATE=<路径> npm run smoke:commit:mock
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@fshine/core';
import { resolveActiveProfileId } from '@fshine/contracts';
import { assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';
import {
  gatewayExecPathForProfile,
  hostDirectChildEnv,
  hostGatewayEnv,
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
const runCli: PlanCliRunner = ({ platformRoot, args, env, gateway }) => new Promise((resolve, reject) => {
  const cli = gatewayExecPathForProfile(platformRoot, { gateway });
  const child = spawn(cli, args, {
    cwd: platformRoot,
    // V0 安全收口（2026-11-12 建，2026-11-13 复核）：合并后剥宿主敏感族与宿主内部
    // 指针，见 packages/agent/src/child-env.ts。
    env: hostDirectChildEnv(env),
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
  // 保险丝（2026-11-08 二次收紧，PR #21 审查 blocking）：
  //
  // 第一版把判据从「宿主读 EXECUTION_EXECUTOR=mock」换成「EXECUTION_MOCK_STATE 已声明」。
  // 后者不成立：**声明一个状态文件路径并不能决定执行层用哪个执行器**——部署完全可能留着
  // 这个 env、同时把执行层切到真实执行器并放开实执行。此时本脚本仍会 rmSync 那个路径、
  // 照常走完整提案+落账，而后续的 mock 状态断言既撤销不了真实写入，也发现不了它。
  // 一个能 fail-open 的保险丝比没有更危险（D-076：全程只跑 mock 不碰真实平台）。
  //
  // 新判据 = 复用评测安全门（scripts/eval/safety-gate.ts）里那条**可证明**的隔离事实：
  // 活跃 profile 的 root 必须落在仓内夹具目录 scripts/eval/fixtures 之下、夹具与网关
  // 都在位、审计通道可写。root 在仓内 ⇒ 执行层就是仓内应答器（dummy/stock），不是任何
  // 真实平台——这是文件系统事实，不是部署约定。
  const statePath = process.env['EXECUTION_MOCK_STATE'];
  if (!statePath) {
    console.error('拒跑：未声明 EXECUTION_MOCK_STATE——本冒烟读 mock 状态断言凭证数增长，拿不到状态路径就无法确认跑在 mock 应答器上。');
    process.exit(1);
  }
  const config = loadConfig({ env: process.env });
  // 执行层 profile id 无关派生（W1 C5 规矩）：单 profile 取其键；0/多个 -> undefined，消费方 fail-closed；宿主不把实例名当缺省。
  const profileId = resolveActiveProfileId(config.contextProfiles);
  const profile = config.contextProfiles[profileId ?? ''];
  const platformRoot = profile?.root;
  const gateway = profile?.gateway;
  if (!platformRoot) { console.error('拒跑：config/agent.yaml 缺少 contextProfiles（active）.root'); process.exit(1); }
  if (!gateway) { console.error('拒跑：config/agent.yaml 的 contextProfiles（active） 未声明 gateway'); process.exit(1); }

  // 可证明的隔离判据（在原有两项存在性检查之上）：root 必须在仓内夹具目录之下。
  try {
    assertEvalIsolation(assessEvalIsolation({ env: process.env, platformRoot, gateway }), 'mock 写链冒烟');
  } catch (error) {
    console.error(`拒跑：${(error as Error).message}`);
    console.error('  本冒烟要真实走落账，只允许打在仓内夹具（scripts/eval/fixtures/*）上。');
    console.error('  真实平台落账路由执行层自己的上线门，不经本脚本。');
    process.exit(1);
  }

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
    gateway,
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
