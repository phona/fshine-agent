// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
// **fallback 覆盖**：本文件头部显式标注 fallback 覆盖用例——结构化调用通道（call --file）
// 的 fallback 事件并非被计数器口径显式排除；计数器本身无域过滤，对 .runtime/a2a-cutover.jsonl
// 全局数 fallback===true 行。本文件不触发 fallback，其排除语义由 harness 的 mock 执行层 + call 新路径直接覆盖。
/**
 * 离线全链 e2e：凭证写链路（两步确认完整闭环，B 组）。共享替身见 ./harness.ts。
 *
 * **C 波（删旧文本写路径）后只剩网关提案路径**：worker 不把提案 JSON 贴进终稿，而是 write
 * 进本轮 `tmp/<requestId>/proposal.json` 再发 `bin/example-gateway prepare <proposal.create 角色的
 * operation> <文件>`；宿主在 beforeToolCall 拦下这条命令，自己办调平台 create（mock
 * executor），拿回**平台渲染的摘要** + 一个取物单 proposalId。宿主持有的只剩 proposalId
 * + 确认码：零业务字段、零 payload（W8 的 L4 机械守卫）。
 *
 * 于是完整链是：create → 用户文本（平台 summaryText 原样 + 通用确认行）→「确认 码」由
 * matchConfirmation 机械匹配（绕过模型，先于模型路由）→ 服务端直调平台 commit（HMAC 令牌
 * + 提案状态取问 + --save 式落账）→ 平台读回校验 → `platform_tasks` 终态回写。
 *
 * 影子期（B 波）并存过的旧文本路径——worker 贴提案 JSON、宿主 extractChangeProposal 结构
 * 校验、服务端 prepare dry-run 预检、按文件路径落账——已整体删除；apps/server/commit.ts
 * 与 scripts/mock-commit-smoke.ts 的 legacy 冒烟同批退场，提案/落账执行器自身的覆盖改由
 * tests/e2e/turn-loop-write-chain.test.ts（本文件）+ packages/agent/proposal-flow.test.ts
 * + apps/server/proposal-commit.test.ts 承担。
 *
 * **D 波（两个写流程开关退役）后本文件不设任何 env 开关**：B 波的
 * `FSHINE_PROPOSAL_VIA_GATEWAY` / `FSHINE_PROPOSAL_COMMIT` 已删，宿主恒定拦截提案命令、
 * 落账后端恒接，默认部署就走完整链——"不设开关也走网关路径"由本文件每条用例直接钉住。
 *
 * **2026-11-08 架构裁定后进一步没有任何写授权位可设**：原 writeEnabled /
 * proposalCommitEnabled 两位（由部署 env 经 isCommitEnabled 派生）整支删除——宿主不再判
 * "这个部署允不允许写 / 落账"，提案与确认都照常走到平台，执行层自己的拒绝 / warning /
 * dryrun 提示由平台信封给出并走既有失败链路上行。原"部署关写 ⇒ 宿主当场合成写关闭话术"
 * 与"落账声明关闭 ⇒ 确认被确定性拒绝"两条 e2e 随之退役（见下方替换后的用例）。
 *
 * 只在 mock 执行器下跑（harness beforeAll 固定 EXECUTION_EXECUTOR=mock，落的是假状态文件），
 * 数据瞄准 seed.json：幻辰财税 + 202609（未结账、无存量凭证）。
 *
 * worker 提案前的检索调用是刻意的：与真实 worker 同形状（提案前先经平台核实对象，
 * 留下执行痕迹）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, gatewayProposalWorker, gatedWorker, mainDriver, type WorkerStep } from './harness';

// harness 全局设 EXECUTION_REQUIRE_PLAN=1 是为 worker 侧计划绑定保真；服务进程自己并不带这个
// mandate。宿主持有的两条直调（提案创建、提案落账）都经 hostGatewayEnv() **显式剥**它
// （D-081），所以这里删掉只为还原"生产进程 env"的形态——真正的保证在 env 纪律本身，
// 由下面 D-081 那条（显式把它设回来仍全链绿）钉住。worker 的计划执行 spawn 由
// gatedWorker 显式自带 EXECUTION_REQUIRE_PLAN=1（harness.ts 两处 execute env），不受这里删除影响。
beforeAll(() => {
  delete process.env['EXECUTION_REQUIRE_PLAN'];
});

const ACCOUNT = '幻辰财税';
const PERIOD = '202609';
const PRINCIPAL = 'wecom:e2e_user';
/** 单聊会话：adapter 的 conversationId = chatid ?? userid。 */
const SESSION = 'wecom:e2e_user';
const CONFIRM_RE = /确认\s*([A-Z0-9]{6})/;

/** mock 状态文件（EXECUTION_MOCK_STATE）里账套期内的凭证张数；文件未播种时视为 0。 */
function mockVoucherCount(accountSet: string, period: string): number {
  const statePath = process.env['EXECUTION_MOCK_STATE'];
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

/** 单张合法提案：借贷各 800。 */
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

/**
 * 提案 worker 替身（旧文本路径形状，只为影子不一致用例保留）：每次委派先真跑一笔平台
 * 检索，随后把提案包在 ```json 围栏里作为最终文本。C 波后这条形状不再被宿主解析——
 * 这里留着是为了钉住"只记录、不生效、不落库"的字面语义。
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

/**
 * 放开写能力：harness boot 默认只读（与 config/agent.yaml 的 capabilities: ["read"] 同形态）。
 * 2026-11-08 后 principal capabilities 是纯遗留数据位（执法路径不读它），本函数保留只是
 * 为了维持"合法 principal"的夹具形状。
 */
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

describe('[L4 集成] 网关提案路径 · 提案创建（无开关，默认部署）：平台摘要 + 确认码，宿主持有取物单', () => {
  it('create → 用户文本含平台 summaryText 与确认码；意图条目只持取物单（零业务字段）', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '把两笔往来款录入幻辰财税 2026 年 9 月' },
        { kind: 'conversation', text: '模型自由回答：确认码未知，未执行任何操作。' },
      ]),
      worker: gatewayProposalWorker(validProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const preview = await send('把两笔往来款录入幻辰财税 2026 年 9 月');

    // ① 平台渲染的摘要原样上屏（不含宿主拼的对象/时间/条目/借贷合计那几行）
    expect(preview).toContain('待确认提案 prop_');
    expect(preview).toContain('共 2 张凭证');
    // 旧文本路径的宿主摘要渲染在新路径上一行不出现
    expect(preview).not.toContain('已收到录入提案并通过预检');
    expect(preview).not.toContain('- 对象：');
    expect(preview).not.toContain('借贷合计各');
    // ② 宿主通用确认行（协议文本）：码明文只在这一条回复里
    expect(preview).toContain('回复「确认');
    const code = preview.match(CONFIRM_RE)?.[1];
    expect(code).toBeTruthy();

    // ③ 意图条目：proposalId（取物单）+ taskId + 通用确认字段，零业务字段、零 payload
    const pending = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
    expect(pending?.status).toBe('pending');
    expect(pending?.proposalId).toMatch(/^prop_/);
    expect(pending?.confirmCodeHash).not.toContain(code!);
    for (const field of ['kind', 'accountSet', 'period', 'payload', 'summary']) {
      expect(field in pending!).toBe(false);
    }
    // create 只跑 dry-run：零写入
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    await assembly.close();
  });

  it('mock 之下落账恒放行：一个开关都不设，确认码也直接走到落账（零 fail-closed 停留）', async () => {
    // B 波那两个开关（FSHINE_PROPOSAL_VIA_GATEWAY / FSHINE_PROPOSAL_COMMIT）与 D 波的写授权位
    // （writeEnabled / proposalCommitEnabled）都已退役：默认部署 = 完整链，没有任何 env 能让
    // 确认停留在"不写"。执行层自己的拒绝走 commit 信封的 unavailable / !ok 分支上行。
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '录入一笔 9 月凭证' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: gatewayProposalWorker(singleValidProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const preview = await send('录入一笔 9 月凭证');
    const code = preview.match(CONFIRM_RE)?.[1]!;
    const intentId = (await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION))!.intentId;

    const reply = await send(`确认 ${code}`);

    // 落账真的发生：mock 状态 +1（不是"确认收到但不写"）
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 1);
    expect(reply).toContain('已执行');
    expect(reply).not.toContain('当前落账执行未启用');
    // 意图 committed：确认码被核销，而不是留在 pending 等一个永不到来的放行
    expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('committed');
    await assembly.close();
  });

  it('提案创建没有办调前复核：能力声明只读也照常登记并给出确认码', async () => {
    // 2026-11-08 裁定前这一条钉"能力不含 write ⇒ 宿主当场合成写关闭话术、平台一次都没被
    // 办调"。裁定后宿主不再持那个布尔，办调照常发生；执行层自己的拒绝走 failed 分支上行。
    const { send, assembly } = await boot({
      main: writeChainMain([{ kind: 'delegate', request: '录入一笔 9 月凭证' }]),
      worker: gatewayProposalWorker(singleValidProposal()),
    });
    // 不调 grantWrite：principal 保持只读的遗留数据位（执法路径不读它）

    const reply = await send('录入一笔 9 月凭证');

    // 提案真被登记：确认码出现在确定性回复里，没有 intent 条目"不存在"那一支
    expect(reply).toMatch(CONFIRM_RE);
    expect(reply).not.toContain('未开放写入权限');
    expect(await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION)).not.toBeNull();
    await assembly.close();
  });

  it('worker 仍贴旧形态提案 JSON：宿主不再解析 worker 文本，提案这一步不发生', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([{ kind: 'delegate', request: '录入一笔 9 月凭证' }]),
      // 旧文本路径的 worker 形状：提案 JSON 包在围栏里作为终稿
      worker: proposalWorker(singleValidProposal()),
    });
    await grantWrite(assembly);
    const before = mockVoucherCount(ACCOUNT, PERIOD);

    const reply = await send('录入一笔 9 月凭证');

    // C 波后宿主压根不解析 worker 终稿（extractChangeProposal 与影子留痕分支一并删除：
    // 解析 worker 文本正是 L4 要禁的那件事）。于是旧形状不再被识别成提案——没有意图
    // 条目、没有确认码、零写入，用户看到的就是 worker 原文。
    expect(await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION)).toBeNull();
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    expect(reply).toContain('change_proposal');
    expect(reply).not.toContain('待确认提案');
    expect(reply).not.toContain('回复「确认');
    await assembly.close();
  });
});

describe('[L4 集成] 网关提案路径 · 完整落账链（默认部署，无开关）', () => {
  /** 已结账期提案（seed 的 scenarios.closedPeriods=202606）：dry-run 过、commit 被平台拒。 */
  function closedPeriodProposal(): object {
    return {
      type: 'change_proposal', domain: 'voucher', accountSet: ACCOUNT, period: '202606',
      contracts: [
        {
          accountSet: ACCOUNT,
          date: '2026-06-20',
          entries: [
            { summary: '收到恒信钢铁货款', subjectCode: '1002', debit: 600 },
            { summary: '收到恒信钢铁货款', subjectCode: '1122', credit: 600, assistantName: '恒信钢铁' },
          ],
        },
      ],
      summary: { count: 1, debit: 600, credit: 600 },
    };
  }

  it('create → 确认 → commit → 读回：平台摘要上屏、mock 状态 +2、任务终态 done', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '把两笔往来款录入幻辰财税 2026 年 9 月' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: gatewayProposalWorker(validProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const preview = await send('把两笔往来款录入幻辰财税 2026 年 9 月');
    const code = preview.match(CONFIRM_RE)?.[1];
    expect(code).toBeTruthy();
    const pending = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
    expect(pending?.proposalId).toMatch(/^prop_/);
    const taskId = pending?.taskId;
    expect(taskId).toBeTruthy();

    const done = await send(`确认 ${code}`);

    // ① 平台渲染的落账摘要原样上屏 + 宿主通用状态行（宿主不拼业务摘要）
    expect(done).toContain('已执行');
    expect(done).toContain('读回校验通过');
    expect(done).toContain('确认码已核销，落账已完成。');
    // ② 落账真的发生：mock 状态按提案张数增长（平台的读回校验证据）
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 2);
    // ③ 意图 committed，读回留痕可查
    const committed = await assembly.store.changeIntents!.get(pending!.intentId);
    expect(committed?.status).toBe('committed');
    expect(JSON.stringify(committed?.result ?? {})).toContain('VERIFY');
    // D-082：originating 任务终态回写（不再有"写成功但任务悬挂"的例外）
    const task = (await assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION)).find((t) => t.taskId === taskId);
    expect(task?.outcome).toBe('done');
    await assembly.close();
  });

  it('D-081：server 进程带着 EXECUTION_REQUIRE_PLAN=1，commit 全链仍绿（宿主直调显式剥它）', async () => {
    // 复刻"部署里 worker 的计划门 mandate 泄漏进服务进程"的形态：宿主持有的两条直调
    // （创建、落账）都必须自己剥掉它，否则同一份部署里服务端调不动、worker 调得动。
    process.env['EXECUTION_REQUIRE_PLAN'] = '1';
    try {
      const { send, assembly } = await boot({
        main: writeChainMain([
          { kind: 'delegate', request: '录入一笔 9 月凭证' },
          { kind: 'conversation', text: '模型自由回答。' },
        ]),
        worker: gatewayProposalWorker(singleValidProposal()),
      });
      await grantWrite(assembly);

      const before = mockVoucherCount(ACCOUNT, PERIOD);
      const preview = await send('录入一笔 9 月凭证');
      const code = preview.match(CONFIRM_RE)?.[1];
      expect(code).toBeTruthy();

      const done = await send(`确认 ${code}`);

      expect(done).toContain('读回校验通过');
      expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 1);
      await assembly.close();
    } finally {
      delete process.env['EXECUTION_REQUIRE_PLAN'];
    }
  });

  it('commit 被平台拒绝（已结账期）：confirm_failed + 意图 failed + 任务终态 failed + 零增量', async () => {
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '补录一笔 6 月凭证' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: gatewayProposalWorker(closedPeriodProposal()),
    });
    await grantWrite(assembly);

    // 基线取在确认之前：创建那一步只跑 dry-run（不写状态），但会把 mock 状态文件从
    // "不存在"播种成 seed——取在上面会把"播种"误读成"多了一张"。
    const preview = await send('补录一笔 6 月凭证');
    const before = mockVoucherCount(ACCOUNT, '202606');
    const code = preview.match(CONFIRM_RE)?.[1];
    expect(code).toBeTruthy();
    const pending = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);
    expect(pending?.status).toBe('pending');

    const done = await send(`确认 ${code}`);

    // 通用失败话术：只说事实与下一步，不把平台错误码/内部状态带上屏
    expect(done).toBe('执行失败：落账未完成，系统已停止并留痕。请联系管理员核对平台实际状态后，再重新发起录入。');
    // 零增量：域落账被拒，mock 状态一张都没多
    expect(mockVoucherCount(ACCOUNT, '202606')).toBe(before);
    // 意图 failed + D-082：originating 任务终态回写 failed
    expect((await assembly.store.changeIntents!.get(pending!.intentId))?.status).toBe('failed');
    const task = (await assembly.store.platformTasks!.listBySession(PRINCIPAL, SESSION)).find((t) => t.taskId === pending?.taskId);
    expect(task?.outcome).toBe('failed');
    await assembly.close();
  });

  it('平台说落账未完成：确认如实报失败，零增量、意图 failed、任务终态回写', async () => {
    // 2026-11-08 裁定前这一条钉"落账声明关闭 ⇒ 确认被宿主确定性拒绝、提案保持 pending"
    // （D-080 的双声明时点纪律）。裁定后确认时点没有宿主侧复核：commit 照常办调，执行层
    // 自己的拒绝走 !ok 分支上行——零写入、意图 failed、任务终态回写 failed（D-082）。
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '录入一笔 9 月凭证' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: gatewayProposalWorker(singleValidProposal()),
    });
    await grantWrite(assembly);

    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const preview = await send('录入一笔 9 月凭证');
    const code = preview.match(CONFIRM_RE)?.[1];
    expect(code).toBeTruthy();
    const pending = await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION);

    const done = await send(`确认 ${code}`);

    // 通用失败话术：只说事实与下一步，不把平台错误码/内部状态带上屏
    expect(done).toContain('执行失败');
    expect(done).not.toContain('已执行');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    expect((await assembly.store.changeIntents!.get(pending!.intentId))?.status).toBe('failed');
    await assembly.close();
  });
});

/**
 * 确认码攻击面（原 B 波旧文本路径的同名一组，C 波改写为网关路径）：判据全部与提案载荷
 * 无关——确认码哈希按 (principal, session) 绑定、TTL 过期就地置 expired、新提案作废旧码。
 * 这些是**宿主持有的通用确认状态机**，不随提案归平台而改变，所以覆盖要跟着搬过来而不是
 * 随旧路径一起删。
 */
describe('[L4 集成] 网关提案路径 · 确认码攻击面：错误码 / 过期 / 跨 session / 跨 principal / 取消 / 被新提案取代', () => {
  /**
   * 每个用例共用的开局：开写 → 提案回合拿到码与 intentId（落账后端默认就接着，
   * 无需再开任何开关）。
   * 脚本里多备一条 conversation 申报：码没拦住而走到模型时，替身会"自由回答"——
   * 这本身就是要观察的行为（未知码按契约走模型，不执行任何写）。
   */
  async function bootWithPendingProposal() {
    const booted = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '录入一笔 9 月凭证' },
        { kind: 'conversation', text: '模型自由回答：我没有这个确认码的记录，未执行任何操作。' },
      ]),
      worker: gatewayProposalWorker(singleValidProposal()),
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

  it('同会话连提两案（D-117 I2：一任务一码）：两意图并存，各码各落账', async () => {
    // 两轮委派各带一次网关提案调用。注意**不能**照 legacy 夹具那样在提案步后补
    // `{end:true}`：harness 的 proposal 步一旦 completed 就整段返回，`end` 步会原样
    // 留给下一轮并把下一轮直接终结（worker 交白卷 → 宿主判"未返回可用结果"）。
    //
    // D-117（2026-10-26 拍板 I2）：supersede 只作用于**同任务**。本用例两案是两次
    // 独立委派（不同 taskId）——旧意图不再被新提案机械作废，用户两个码各自有效，
    // 确认哪个落账哪个（改前 inline 枝 supersede 全会话，旧码 stale——期望随政策
    // 决定翻转）。"改为"类替换语义由模型在提案文本里向用户说明，宿主不越权作废。
    const twoProposalWorker = gatedWorker([
      { plan: [{ operation: 'finance.search-account-sets', args: ['--query', ACCOUNT] }] },
      { proposal: singleValidProposal() },
      { plan: [{ operation: 'finance.search-account-sets', args: ['--query', ACCOUNT] }] },
      { proposal: singleValidProposal() },
    ]);
    const { send, assembly } = await boot({
      main: writeChainMain([
        { kind: 'delegate', request: '第一笔：录入 9 月收款凭证' },
        { kind: 'delegate', request: '第二笔：改为录入 9 月付款凭证' },
        { kind: 'conversation', text: '模型自由回答。' },
      ]),
      worker: twoProposalWorker,
    });
    await grantWrite(assembly);

    const preview1 = await send('第一笔：录入 9 月收款凭证');
    const code1 = preview1.match(CONFIRM_RE)?.[1]!;
    const intent1 = (await assembly.store.changeIntents!.findPendingBySession(PRINCIPAL, SESSION))!.intentId;

    const preview2 = await send('第二笔：改为录入 9 月付款凭证');
    const code2 = preview2.match(CONFIRM_RE)?.[1]!;
    expect(code2).not.toBe(code1);
    // I2：跨任务 pending 并存——第一张意图存活，会话里有两张待确认。
    expect((await assembly.store.changeIntents!.get(intent1))?.status).toBe('pending');

    // 用第一个码确认：第一案照常落账（不再是 stale——旧码绑定的是仍存活的意图）。
    const before = mockVoucherCount(ACCOUNT, PERIOD);
    const done1 = await send(`确认 ${code1}`);
    expect(done1).toContain('确认码已核销，落账已完成。');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 1);
    expect((await assembly.store.changeIntents!.get(intent1))?.status).toBe('committed');

    // 新码确认第二案：同样走完整落账链，两案各落各的账。
    const done2 = await send(`确认 ${code2}`);
    expect(done2).toContain('确认码已核销，落账已完成。');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before + 2);
    await assembly.close();
  });

  it('取消码作废 pending：中性标签的确定性答复 + 意图 cancelled + 零写入', async () => {
    const { send, assembly, code, intentId } = await bootWithPendingProposal();
    const before = mockVoucherCount(ACCOUNT, PERIOD);

    const reply = await send(`取消 ${code}`);

    // R1：取消分支是新旧路径**共用**的代码，C 波后它只服务网关路径。业务字段不在宿主库
    // 往返，标签一律降级成中性表述——不渲染 undefined，也不为"更具体"去解析 worker 文本。
    expect(reply).toBe('已作废：本次录入提案未执行。');
    expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('cancelled');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    await assembly.close();
  });

  it('取消一个已作废的码 → confirm_stale（那一轮没有任何状态变化）', async () => {
    const { send, assembly, code, intentId } = await bootWithPendingProposal();
    const before = mockVoucherCount(ACCOUNT, PERIOD);

    await send(`取消 ${code}`);
    expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('cancelled');

    const stale = await send(`取消 ${code}`);
    expect(stale?.length).toBeGreaterThan(0);
    expect(stale).toContain('该确认码对应的提案已作废，无需取消。');
    // 第二发取消码：提案早已终结，这一轮没有任何状态变化、零写入
    expect((await assembly.store.changeIntents!.get(intentId))?.status).toBe('cancelled');
    expect(mockVoucherCount(ACCOUNT, PERIOD)).toBe(before);
    await assembly.close();
  });
});
