// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：多任务回溯歧义——宿主把"继续哪个任务"抛给用户（编号消歧）。共享替身见 ./harness.ts。
 *
 * turn-loop-concurrent.test.ts 覆盖的是单条计划线的中断/恢复；这里覆盖两条计划都开着、
 * 申报的步骤与两条都接得上时的宿主行为：
 *   ① 宿主不猜——直接发编号消歧问题（选项由计划事实机械生成），零委派零新事实；
 *   ② 紧跟问题的编号回复绑定所选计划，后续事实记在正确的 planId 上；
 *   ③ 非编号回复按新请求正常处理，不产生绑定。
 *
 * 绑定合法性全在宿主侧：preferredPlanId 由宿主持有，模型申报只提供"做什么"，
 * 提供"继续哪个"的编号语义只有紧跟宿主问题时才成立（中间插过任何回合即失效）。
 *
 * 夹具口径（Wave 1 收尾）：账套名一律用 mock 种子状态里**真实存在**的规范名
 * （`fictional-execution-layer/src/execution/mocks/fixtures/seed.json`：幻辰财税 / 新兴五金 /
 * 新兴建材 / 幻辰实业有限公司）。本文件的主旨是编号消歧，不是"平台说没有"——用捏造名
 * （甲乙丙账套）时，平台 not_found 信封带 data.query 会激活宿主的结构化澄清
 * （selectionClarificationOf），澄清问题整体覆盖 worker 的捏造文本，消歧主线根本走不到。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  balanceCalls,
  boot,
  gatedWorker,
  mainDriver,
  totalActualCalls,
  type WorkerStep,
} from './harness';

/** 企微单聊：conversationId 回落为 userid（channel-wecom adapter），principal 由 userid 解析。 */
const PRINCIPAL_ID = 'wecom:e2e_user';
const SESSION_ID = 'wecom:e2e_user';

/** 记录 worker 实际收到的委派请求与 taskId（宿主透传剥掉协议前缀的 request）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  const taskIds: string[] = [];
  return {
    requests,
    taskIds,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        taskIds.push(String(input.sessionId ?? ''));
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

interface PlanLogEvent {
  event: string;
  requestId?: string;
  planId?: string;
  step?: string;
  status?: string;
}

/** 侦测宿主计划模式的结构化日志（写法同 turn-loop-concurrent 的 capturePlanLog）。 */
function capturePlanLog() {
  const events: PlanLogEvent[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as PlanLogEvent;
      if (typeof parsed?.event === 'string' && parsed.event.startsWith('task_plan')) events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return {
    events,
    ownership: () => events.filter((entry) => entry.event === 'task_plan_resumed' || entry.event === 'task_plan_started'),
    restore: () => spy.mockRestore(),
  };
}

describe('[L4 集成] 离线全链 e2e：多任务回溯歧义的编号消歧', () => {
  it('9.1 两个未完成计划形状撞车 → 宿主出题；编号"2"绑定较旧的那个计划续跑', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 幻辰财税（第 1 回合，计划 A 的第 1 步；202609 无余额键 → PERIOD_NO_DATA）。
      // 错误态快路径 v2 对齐：单调用计划撞终局信封，替身镜像在本跳以宿主话术收束
      // （步结果照旧经 stepLabel 交还链）——不再有"贴无数据文本"段，脚本游标经镜像
      // break 直落下一段（见 harness terminalMirror 注释）。
      { plan: balanceCalls('幻辰财税', '202609') },
      // 新兴五金（第 2 回合，计划 B 的第 1 步；202609 同样无余额键）
      { plan: balanceCalls('新兴五金', '202609') },
      // 新兴建材（第 4 回合，用户选"2"后计划 A 的第 2 步；mock 当前期间应收余额 700）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '第1/3步：查幻辰财税 202609 的应收余额', text: '第 1 步完成：幻辰财税 202609 平台未返回该期间数据。共 3 步，先停在这。' },
      { kind: 'delegate', request: '第1/3步：查新兴五金 202609 的应收余额', text: '第 1 步完成：新兴五金 202609 平台未返回该期间数据。共 3 步，先停在这。' },
      // 与两条计划都接得上 → 宿主 ToolUserError 出消歧问题，回合在此结束
      { kind: 'delegate', request: '第2/3步：继续核对' },
      // 用户选"2"（较旧的计划 A）：宿主注入消歧结果，模型重新申报本步
      { kind: 'delegate', request: '第2/3步：查新兴建材账套当前期间的应收余额' },
      { kind: 'conversation', text: '幻辰财税和新兴建材这两项核对完了，新兴五金还差两步。' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    const log = capturePlanLog();
    try {
      const first = await send('逐个核对这三个账套的应收余额：幻辰财税、新兴五金、新兴建材');
      expect(first).toContain('幻辰财税 202609 平台未返回该期间数据');

      const second = await send('再核对这三个账套的应收余额：新兴五金、幻辰实业有限公司、新兴建材');
      expect(second).toContain('新兴五金 202609 平台未返回该期间数据');
      expect(worker.taskIds).toHaveLength(2);
      expect(totalActualCalls()).toBe(before + 2);

      // 「继续」撞上两个 1/3 的未完成计划：宿主不猜，出编号题，零委派
      const noticesBeforeAsk = sdk.noticeTexts().length;
      const asked = await send('继续');
      expect(asked).toContain('【任务消歧】');
      expect(asked).toContain('1. 查新兴五金 202609 的应收余额（1/3 步已完成）');
      expect(asked).toContain('2. 查幻辰财税 202609 的应收余额（1/3 步已完成）');
      expect(asked).not.toContain('不应外发');
      expect(worker.taskIds).toHaveLength(2);
      expect(totalActualCalls()).toBe(before + 2);
      expect(sdk.noticeTexts()).toHaveLength(noticesBeforeAsk);

      // 紧跟问题的"2"：绑定较旧的计划 A（选项 2），第 2 步照常委派
      const picked = await send('2');
      expect(picked).toContain('幻辰财税和新兴建材这两项核对完了');
      expect(picked).not.toContain('不应外发');
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.requests[2]).toContain('新兴建材');
      expect(worker.requests[2]).not.toContain('第2/3步');
      expect(totalActualCalls()).toBe(before + 3);

      // planId 归属：A、B 各开一次，第 4 回合续跑的是 A（用户选的那个），不是最近的 B
      const ownership = log.ownership();
      expect(ownership.map((entry) => entry.event)).toEqual(['task_plan_started', 'task_plan_started', 'task_plan_resumed']);
      const planA = ownership[0]?.planId ?? '';
      const planB = ownership[1]?.planId ?? '';
      expect(planA).not.toBe(planB);
      expect(ownership[2]?.planId).toBe(planA);

      // 事实归属：第 2 步记在计划 A 上；两个计划都仍开着（A 2/3、B 1/3）
      const open = await assembly.store.taskPlans.openPlans(PRINCIPAL_ID, SESSION_ID);
      expect(open.map((plan) => plan.planId)).toEqual([planA, planB]);
      expect(open[0]).toEqual(expect.objectContaining({ maxRecordedStep: 2, done: 2, totalSteps: 3 }));
      expect(open[1]).toEqual(expect.objectContaining({ maxRecordedStep: 1, done: 1, totalSteps: 3 }));
      // 选项标签来自计划事实：消歧问题里的"查幻辰财税…"就是计划 A 第 1 步的 request
      expect(open[0]?.firstRequest).toContain('幻辰财税');
      expect(await assembly.store.taskPlans.latestOpenPlan(PRINCIPAL_ID, SESSION_ID)).toBe(planA);
    } finally {
      log.restore();
    }
    await assembly.close();
  });

  it('9.2 消歧问题后的非编号回复按新请求处理：正常单步委派，不产生绑定', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 202609 两个账套都无余额键 → PERIOD_NO_DATA，不是"余额为 0"（快路径 v2 对齐：
      // 两段单调用撞终局由镜像以宿主话术收束，无贴文本段，游标直落下一段）
      { plan: balanceCalls('幻辰财税', '202609') },
      { plan: balanceCalls('新兴五金', '202609') },
      // 非编号回复落地成单步委派（无前缀）：新任务、不绑任何计划
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '第1/3步：查幻辰财税 202609 的应收余额', text: '第 1 步完成：幻辰财税 202609 平台未返回该期间数据。共 3 步，先停在这。' },
      { kind: 'delegate', request: '第1/3步：查新兴五金 202609 的应收余额', text: '第 1 步完成：新兴五金 202609 平台未返回该期间数据。共 3 步，先停在这。' },
      { kind: 'delegate', request: '第2/3步：继续核对' },
      // 用户没答编号，换了个新查询：单步委派照常，两个旧计划不受影响
      { kind: 'delegate', request: '查询新兴建材账套当前期间的应收余额' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    try {
      await send('逐个核对这三个账套的应收余额：幻辰财税、新兴五金、新兴建材');
      await send('再核对这三个账套的应收余额：新兴五金、幻辰实业有限公司、新兴建材');
      const asked = await send('继续');
      expect(asked).toContain('【任务消歧】');

      const answered = await send('先查新兴建材的吧');
      expect(answered).toContain('700 元');
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.requests[2]).toContain('新兴建材');
      expect(worker.requests[2]).not.toContain('第2/3步');
      expect(totalActualCalls()).toBe(before + 3);

      // 两个旧计划原封不动：仍然各是 1/3，没有多出第 2 步事实
      const open = await assembly.store.taskPlans.openPlans(PRINCIPAL_ID, SESSION_ID);
      expect(open).toHaveLength(2);
      expect(open.every((plan) => plan.maxRecordedStep === 1 && plan.totalSteps === 3)).toBe(true);
    } finally {
      await assembly.close();
    }
  });
});
