/**
 * 离线全链 e2e：凭证写链路（两步确认完整闭环，B 组）。共享替身见 ./harness.ts。
 *
 * 全链（待迁移的遗留实现）：worker 产出 change_proposal → 宿主 extractChangeProposal
 * 结构校验 → finalizeProposal（capability 检查 → 服务端 prepare dry-run 预检 → 旧
 * pending 置 superseded → 建 ChangeIntentRecord，确认码只存哈希）→ 预览+确认码回复
 * 用户 → 用户「确认 码」由 matchConfirmation 机械匹配（CONFIRM_RE，绕过模型，先于
 * 模型路由）→ 服务端 commit（HMAC 令牌 + --save）→ 读回校验（after-before ≥ 提案
 * 张数）→ 用户拿到成功话术。
 *
 * 只在 mock 执行器下跑（harness beforeAll 固定 DZ_EXECUTOR=mock，落的是假状态文件），
 * 数据瞄准 seed.json：幻辰财税 + 202609（未结账、无存量凭证）。
 *
 * worker 提案前的检索调用是刻意的：与真实 worker 同形状（提案前先经平台核实对象，
 * 留下执行痕迹）；提案本身包在 ```json 围栏里——extractChangeProposal 只认围栏或
 * 整段纯 JSON。
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, gatedWorker, mainDriver, type WorkerStep } from './harness';

// harness 全局设 DZ_REQUIRE_PLAN=1 是为 worker 侧计划绑定保真；但服务端 commit 执行器
// （apps/server/commit.ts 的 runGate 继承进程 env）在生产进程里并不带这个 mandate——
// acceptance.ts 与 mock-commit-smoke.ts 同形态（只设 DZ_SERVE），09-22 全链验收正是在
// 此形态下 committed 成功。worker 的计划执行 spawn 由 gatedWorker 显式自带
// DZ_REQUIRE_PLAN=1（harness.ts 两处 execute env），不受这里删除影响。
beforeAll(() => {
  delete process.env['DZ_REQUIRE_PLAN'];
});

const ACCOUNT = '幻辰财税';
const PERIOD = '202609';
const PRINCIPAL = 'wecom:e2e_user';
/** 单聊会话：adapter 的 conversationId = chatid ?? userid。 */
const SESSION = 'wecom:e2e_user:e2e_user';
const CONFIRM_RE = /确认\s*([A-Z0-9]{6})/;

/** mock 状态文件（DZ_MOCK_STATE）里账套期内的凭证张数；文件未播种时视为 0。 */
function mockVoucherCount(accountSet: string, period: string): number {
  const statePath = process.env['DZ_MOCK_STATE'];
  if (!statePath || !existsSync(statePath)) return 0;
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    accountSets: Record<string, { vouchers?: Record<string, unknown[]> }>;
  };
  return (state.accountSets[accountSet]?.vouchers?.[period] ?? []).length;
}

/** 合法提案：2 张凭证，借贷各 1500，科目/辅助核算都命中 seed（mock fill 会真校验）。 */
function validProposal(): object {
  const contracts = [
    {
      accountSet: ACCOUNT,
      date: '2026-09-15',
      entries: [
        { summary: '收到幻电设备有限公司货款', subjectCode: '1002', debit: 1000 },
        { summary: '收到幻电设备有限公司货款', subjectCode: '1122', credit: 1000, assistantName: '幻电设备有限公司' },
      ],
    },
    {
      accountSet: ACCOUNT,
      date: '2026-09-16',
      entries: [
        { summary: '支付恒信钢铁货款', subjectCode: '2202', credit: 500, assistantName: '恒信钢铁' },
        { summary: '支付恒信钢铁货款', subjectCode: '1002', debit: 500 },
      ],
    },
  ];
  return {
    type: 'change_proposal', domain: 'voucher', accountSet: ACCOUNT, period: PERIOD,
    contracts, summary: { count: 2, debit: 1500, credit: 1500 },
  };
}

/** 单张合法提案（B3/B6 用）：借贷各 800。 */
function singleValidProposal(): object {
  return {
    type: 'change_proposal', domain: 'voucher', accountSet: ACCOUNT, period: PERIOD,
    contracts: [
      {
        accountSet: ACCOUNT,
        date: '2026-09-18',
        entries: [
          { summary: '收到恒信钢铁货款', subjectCode: '1002', debit: 800 },
          { summary: '收到恒信钢铁货款', subjectCode: '1122', credit: 800, assistantName: '恒信钢铁' },
        ],
      },
    ],
    summary: { count: 1, debit: 800, credit: 800 },
  };
}

/** 预检必败提案：科目 9999 不在账套科目表里，mock fill 在 dry-run 即 RESOLVE_INVALID。 */
function invalidSubjectProposal(): object {
  return {
    type: 'change_proposal', domain: 'voucher', accountSet: ACCOUNT, period: PERIOD,
    contracts: [
      {
        accountSet: ACCOUNT,
        date: '2026-09-17',
        entries: [
          { summary: '预检必败分录', subjectCode: '9999', debit: 100 },
          { summary: '预检必败分录', subjectCode: '1002', credit: 100 },
        ],
      },
    ],
    summary: { count: 1, debit: 100, credit: 100 },
  };
}

/**
 * 提案 worker 替身：每次委派先真跑一笔平台检索（与真实 worker 同形状——提案前核实
 * 对象，同时给委派留下执行痕迹），随后把提案包在 ```json 围栏里作为最终文本。
 */
function proposalWorker(...proposals: object[]) {
  const steps: WorkerStep[] = [];
  for (const proposal of proposals) {
    steps.push({ plan: [{ operation: 'finance.search-account-sets', args: ['--query', ACCOUNT] }] });
    steps.push({ text: `已核实账套、科目与辅助核算。\n\`\`\`json\n${JSON.stringify(proposal, null, 2)}\n\`\`\`` });
    steps.push({ end: true });
  }
  return gatedWorker(steps);
}

/** 放开写能力：harness boot 默认只读（与 config/agent.yaml 的 capabilities: ["read"] 同形态）。 */
async function grantWrite(assembly: Awaited<ReturnType<typeof boot>>['assembly']) {
  await assembly.store.principalScopes.upsert({
    wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true,
    capabilities: ['read', 'validate', 'write'],
  });
}

/** 提案回合的 Main Agent 脚本：delegate + 可选的后续申报（攻击面用例里模型"会说话"）。 */
function writeChainMain(declarations: Array<Record<string, unknown>>) {
  return mainDriver(declarations);
}

describe('离线全链 e2e：凭证写链路（两步确认闭环）', () => {
  it('B1 提案→确认→落账→读回全链：mock 状态按提案新增凭证，意图 committed', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([{ kind: 'delegate', request: '把两笔往来款录入幻辰财税 2026 年 9 月' }]),
      worker: proposalWorker(validProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const preview = await send('把两笔往来款录入幻辰财税 2026 年 9 月');

    // 预览 + 确认码（码明文只出现在这条回复里，库里存的是哈希）
    expect(preview).toContain('已收到录入提案并通过预检（dry-run）');
    expect(preview).toContain('- 对象：幻辰财税');
    expect(preview).toContain('- 时间：202609');
    expect(preview).toContain('- 条目：2 条，借贷合计各 1500 元');
    expect(preview).toContain('回复「确认');
    const code = preview.match(CONFIRM_RE)?.[1];
    expect(code).toBeTruthy();

    const pending = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
    expect(pending?.status).toBe('pending');
    expect(pending?.summary).toEqual({ count: 2, debit: 1500, credit: 1500 });
    expect(pending?.confirmCodeHash).not.toContain(code!);

    const done = await send(`确认 ${code}`);
    expect(done).toContain('已完成：2 条已录入（幻辰财税 202609），读回校验通过。');

    // mock 状态文件里该期间实际新增了 2 张凭证；意图 committed 且带读回校验留痕
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 2);
    const committed = await assembly.store.changeIntents!.get(pending!.intentId);
    expect(committed?.status).toBe('committed');
    expect(JSON.stringify(committed?.result ?? '')).toContain('VERIFY before=0 after=2 expected>=2');
    await assembly.close();
  });

  it('B2 dry-run 预检失败：不建 intent，用户收到 proposal_precheck_failed 话术', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([{ kind: 'delegate', request: '录入一笔 9 月凭证' }]),
      worker: proposalWorker(invalidSubjectProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const reply = await send('录入一笔 9 月凭证');

    expect(reply).toContain('变更提案未通过预检（dry-run），未创建待确认任务。');
    expect(reply).toContain('科目不存在: 9999');
    // 无 intent 落库（会话里没有任何 pending），mock 状态零变化
    expect(await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION)).toBeNull();
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    await assembly.close();
  });

  describe('B3 确认码攻击面：错误码 / 过期 / 跨 session / 跨 principal 都不放行', () => {
    /**
     * 每个用例共用的开局：开写 → 提案回合拿到码与 intentId。
     * 脚本里多备一条 conversation 申报：码没拦住而走到模型时，替身会"自由回答"——
     * 这本身就是要观察的行为（未知码按契约走模型，不执行任何写）。
     */
    async function bootWithPendingProposal() {
      const booted = await boot({
        main: writeChainMain([
          { kind: 'delegate', request: '录入一笔 9 月凭证' },
          { kind: 'conversation', text: '模型自由回答：我没有这个确认码的记录，未执行任何操作。' },
        ]),
        worker: proposalWorker(singleValidProposal()),
      });
      await grantWrite(booted.assembly);
      const preview = await booted.send('录入一笔 9 月凭证');
      const code = preview.match(CONFIRM_RE)?.[1];
      expect(code).toBeTruthy();
      const pending = await booted.assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
      expect(pending?.status).toBe('pending');
      return { ...booted, code: code!, intentId: pending!.intentId };
    }

    it('错误码（库里无此哈希）：不落账、意图保持 pending，消息按普通对话走模型', async () => {
      const { send, assembly, intentId } = await bootWithPendingProposal();
      const before = mockVoucherCount(ACCOUNT, PERIOD);

      const reply = await send('确认 ZZZ999');

      // 未知码命中不了任何 intent → matchConfirmation 返回 null → 模型正常应答
      expect(reply).toBe('模型自由回答：我没有这个确认码的记录，未执行任何操作。');
      expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('pending');
      expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
      await assembly.close();
    });

    it('过期（TTL 10 分钟）：confirm_stale 确定性话术，意图就地置 expired，不落账', async () => {
      const { send, assembly, code, intentId } = await bootWithPendingProposal();
      const before = mockVoucherCount(ACCOUNT, PERIOD);

      // assembly 不注入 intentTtlMs（生产默认 10 分钟）：只假推进 Date（不动定时器），
      // 让 matchConfirmation 里的 now 落在 expiresAt 之后。
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
        const reply = await send(`确认 ${code}`);
        expect(reply).toContain('该确认码对应的提案已过期（超过有效期），请重新发起录入。');
      } finally {
        vi.useRealTimers();
      }
      expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('expired');
      expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
      await assembly.close();
    });

    it('跨 session 复用（群聊里贴单聊的码）：不放行、意图 pending，走模型', async () => {
      const { send, assembly, code, intentId } = await bootWithPendingProposal();
      const before = mockVoucherCount(ACCOUNT, PERIOD);

      // 同一 principal、不同会话（群聊 chatid=grp_e2e）：码哈希按 (principal, session) 绑定
      const reply = await send(`确认 ${code}`, { group: true });

      expect(reply).toBe('模型自由回答：我没有这个确认码的记录，未执行任何操作。');
      expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('pending');
      expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
      await assembly.close();
    });

    it('跨 principal 复用（另一个用户贴别人的码）：不放行、意图 pending，走模型', async () => {
      const { send, assembly, code, intentId } = await bootWithPendingProposal();
      await assembly.store.principalScopes.upsert({
        wecomUserId: 'e2e_user_2', accountSetIds: [], accountSetScope: 'all', enabled: true,
        capabilities: ['read', 'validate', 'write'],
      });
      const before = mockVoucherCount(ACCOUNT, PERIOD);

      const reply = await send(`确认 ${code}`, { userid: 'e2e_user_2' });

      expect(reply).toBe('模型自由回答：我没有这个确认码的记录，未执行任何操作。');
      expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('pending');
      expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
      await assembly.close();
    });
  });

  it('B4 同会话连提两案：旧码 stale、旧意图 superseded，新码仍可完成落账', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '第一笔：录入 9 月收款凭证' },
        { kind: 'delegate', request: '第二笔：改为录入 9 月付款凭证' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: proposalWorker(validProposal(), singleValidProposal()),
    });
    await grantWrite(assembly);

    const preview1 = await send('第一笔：录入 9 月收款凭证');
    const code1 = preview1.match(CONFIRM_RE)?.[1]!;
    const intent1 = (await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION))!.intentId;

    const preview2 = await send('第二笔：改为录入 9 月付款凭证');
    const code2 = preview2.match(CONFIRM_RE)?.[1]!;
    expect(code2).not.toBe(code1);
    // 新提案使旧 pending 作废（superseded），会话里 pending 已是第二张
    expect((await assembly.store.changeIntents!.get(intent1))?.status).toBe('superseded');
    const pending2 = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
    expect(pending2?.intentId).not.toBe(intent1);
    expect(pending2?.status).toBe('pending');

    // 用第一个码确认：确定性 stale 解释，无状态变化、无落账
    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const stale = await send(`确认 ${code1}`);
    expect(stale).toContain('该确认码对应的提案已被更新的提案取代，确认最新的提案即可。');
    expect((await assembly.store.changeIntents!.get(intent1))?.status).toBe('superseded');
    expect((await assembly.store.changeIntents!.get(pending2!.intentId))?.status).toBe('pending');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);

    // 新码确认：正常走完整 commit 链（第二张提案是 1 张凭证）
    const done = await send(`确认 ${code2}`);
    expect(done).toContain('已完成：1 条已录入（幻辰财税 202609），读回校验通过。');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 1);
    expect((await assembly.store.changeIntents!.get(pending2!.intentId))?.status).toBe('committed');
    await assembly.close();
  });

  it('B6 模型试图把「确认 码」当普通 conversation 申报：机械匹配优先，commit 照样发生', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '录入一笔 9 月凭证' },
        // 收到「确认 码」后模型试图自答（而非放行给机械匹配）——替身若被叫到就会申报这条
        { kind: 'conversation', text: '模型自答：我把这句当作普通对话处理，不执行任何写入。' },
      ]),
      worker: proposalWorker(singleValidProposal()),
    });
    await grantWrite(assembly);

    const preview = await send('录入一笔 9 月凭证');
    const code = preview.match(CONFIRM_RE)?.[1]!;
    const intentId = (await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION))!.intentId;
    const before = mockVoucherCount(ACCOUNT, PERIOD);

    const done = await send(`确认 ${code}`);

    // matchConfirmation 在模型路由之前执行（runtime.ts 的 handleTurn 入口）：
    // 模型的 conversation 申报根本没被叫到，回复是宿主的成功话术
    expect(done).toContain('已完成：1 条已录入（幻辰财税 202609），读回校验通过。');
    expect(done).not.toContain('模型自答');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 1);
    expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('committed');
    await assembly.close();
  });
});
