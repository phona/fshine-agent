/**
 * mock 保护下的两步写链路冒烟（不经任何模型）：
 *   prepare(dry-run) → 签 HMAC 令牌 → commit(--save) → verify-saved 读回 → mock 状态断言
 * 直驱 apps/server 的 createPrepareRunner/createCommitRunner，即生产确认后的同一条
 * 服务端执行路径（bin/17dz 网关 + mock 应答器）。
 *
 * 保险丝：检测不到 DZ_EXECUTOR=mock 直接拒跑——本脚本会真实走 commit，
 * 绝不允许误打真平台。
 * 用法：npm run smoke:commit:mock（=.env 需含 DZ_EXECUTOR=mock）
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { loadConfig } from '@fshine/core';
import { ensureMockStatePath, isPlatformMock, type CommitRequest, type PrepareRequest } from '@fshine/agent';
import { createCommitRunner, createPrepareRunner, newGateSecret } from '../apps/server/commit';

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

function voucherCount(statePath: string, account: string, period: string): number {
  // 首次运行时状态文件尚不存在（首次调用 respond.js 才从 seed 播种）——视为 0
  if (!existsSync(statePath)) return 0;
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    accountSets: Record<string, { vouchers: Record<string, unknown[]> }>;
  };
  return (state.accountSets[account]?.vouchers[period] ?? []).length;
}

async function main(): Promise<void> {
  if (!isPlatformMock()) {
    console.error('拒跑：DZ_EXECUTOR=mock 未设置——本冒烟走真实 commit 流程，只允许在 mock 保护下执行。');
    process.exit(1);
  }
  const config = loadConfig({ env: process.env });
  const platformRoot = config.contextProfiles['17dz']?.root;
  if (!platformRoot) { console.error('拒跑：config/agent.yaml 缺少 contextProfiles.17dz.root'); process.exit(1); }

  const statePath = ensureMockStatePath(platformRoot)!;
  // 重置状态：每次冒烟从 seed 重新播种，断言才确定
  if (existsSync(statePath)) rmSync(statePath);

  const gateSecret = newGateSecret();
  const prepare = createPrepareRunner({ platformRoot, gateSecret });
  const commit = createCommitRunner({ platformRoot, gateSecret });
  const intentId = `intent_smoke_${randomUUID()}`;
  const base: Omit<CommitRequest, 'intentId'> = { accountSet: ACCOUNT, period: PERIOD, contracts };

  const before = voucherCount(statePath, ACCOUNT, PERIOD);

  const prep = await prepare({ intentId, ...base } satisfies PrepareRequest);
  console.log(`[1/3] prepare(dry-run) ok=${prep.ok}`);
  if (!prep.ok) { console.error(prep.output); process.exit(1); }

  const com = await commit({ intentId, ...base } satisfies CommitRequest);
  console.log(`[2/3] commit(--save+读回) ok=${com.ok}`);
  console.log(com.output.split('\n').filter(Boolean).slice(-3).join('\n'));
  if (!com.ok) { console.error(com.error ?? ''); process.exit(1); }

  const after = voucherCount(statePath, ACCOUNT, PERIOD);
  console.log(`[3/3] mock 状态 ${ACCOUNT} ${PERIOD} 凭证数 ${before} → ${after}`);
  if (after - before < contracts.length) {
    console.error('失败：mock 状态凭证数未按提案增加');
    process.exit(1);
  }

  console.log(`PASS：提案→确认→落账→读回全链通过（mock 状态：${statePath}）`);
}

main().catch((error) => {
  console.error('冒烟脚本失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
