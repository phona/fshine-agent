// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：并发多线程会话里的多步计划中断/恢复/跳过/确认门（覆盖增强）。共享替身见 ./harness.ts。
 *
 * 现有计划模式用例（turn-loop-plan-steps.test.ts）全是"一个回合内跑完的多步拆解"；
 * turn-loop-interleaved.test.ts 是两个单步任务交替。这里补真实会话里最常见的四种形状：
 *   ① 多步计划跑一半被别的事情打断，过几轮再回来续跑（跨回合恢复）；
 *   ② 计划进行中插入一轮探索对话，探索不得污染计划投影；
 *   ③ 某一步真执行了但平台没查到（not_found）——宿主把信封数据机械组装成澄清问题直接问
 *      用户，该步在账本里记 needs（缺"用户选哪个"）；用户跳过后，后续步骤接回同一计划；
 *   ④ 计划步骤撞上用户确认门后，该步与剩余步骤的实际去留（characterization）。
 *
 * 与手工企微测试的差别同样只有模型与平台执行器是假的；e2e 的 store 是真 SQLite
 * （boot 走 createServerAssembly），TaskPlanRepo 因此是真库路径，不是 mock。
 *
 * 夹具口径（Wave 1 收尾）：除 7.3 这一例**主旨就是"平台说没有"**（保留捏造名幻东建材，
 * 断言改成宿主组装澄清的形态）之外，账套名一律用 mock 种子状态里真实存在的规范名
 * （`fictional-execution-layer/src/execution/mocks/fixtures/seed.json`）。捏造名会撞上平台 not_found
 * 信封（带 data.query）→ 宿主结构化澄清收口，把本来要测的中断/恢复主线掐断。
 */
import { describe, expect, it, vi } from 'vitest';
import { executionLanguageFingerprints } from '../../packages/agent/src/runtime';
import { clarificationTextFor } from '../../packages/agent/src/error-codes';
import {
  LAST_TASK_ID_TOKEN,
  balanceCalls,
  boot,
  gatedWorker,
  heavyPlan,
  mainDriver,
  platformCorrectForm,
  totalActualCalls,
  type WorkerStep,
} from './harness';

/**
 * 计划重通知上限（EXECUTION_PLAN_MAX_NOTIFY）是执行层自己的策略参数：值源在执行层
 * 配置层（2026-11 env 治理 v2 起 env 不再是通道），宿主 e2e 不设。本用例的计划都
 * 申报即执行、无「磨大」差额，不会触发 NOTIFY_REPEAT_LIMIT；confirm 门槛本身由累计
 * 重量触发（EXECUTION_PLAN_CONFIRM_CALLS=20），不受此上限影响，用例 4 的确认门
 * 因此照旧能观察到。
 */

/** 企微单聊：conversationId 回落为 userid（channel-wecom adapter），principal 由 userid 解析。 */
const PRINCIPAL_ID = 'wecom:e2e_user';
const SESSION_ID = 'wecom:e2e_user';

/** 三个期间的查询计划：3 次调用，越过 harness 的 EXECUTION_PLAN_AUTO_CALLS=2 触发通知。 */
function threePeriodPlan(account: string) {
  return [1, 2, 3].map((month) => ({ operation: 'finance.query-receivables', args: ['--query', account, '--period', `20260${month}`] }));
}

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
  planSteps?: number;
  needsRounds?: number;
}

/**
 * 侦测宿主计划模式的结构化日志（console.info 上是 JSON 行，写法参考 runtime.test.ts 的
 * console 告警侦测）。宿主在两个时刻打点：planId 归属（task_plan_started / task_plan_resumed）
 * 与步骤事实（task_plan_step × started / 终态）。planId 形如 `plan_${requestId}`，requestId
 * 每回合随机，因此不可预知——只能从日志里读出来，再拿去读真库投影。
 */
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
    /** planId 归属事件：跨回合恢复走 task_plan_resumed，新开计划走 task_plan_started。 */
    ownership: () => events.filter((entry) => entry.event === 'task_plan_resumed' || entry.event === 'task_plan_started'),
    steps: () => events.filter((entry) => entry.event === 'task_plan_step'),
    restore: () => spy.mockRestore(),
  };
}

describe('[L4 集成] 离线全链 e2e：并发会话里的多步计划中断/恢复/跳过/确认门', () => {
  it('7.1 多步计划被打断后跨回合恢复：同任务续跑、步号接得上、账本跨回合累计', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步（第 1 回合）：3 次调用的计划越过自动档 → 先通知用户，然后执行成功
      // 202601–202603 在 mock 里都没有余额键 → 平台回 PERIOD_NO_DATA，不是"余额为 0"
      { plan: threePeriodPlan('幻辰财税') },
      { text: '幻辰财税 202601、202602、202603 平台均未返回该期间数据。' },
      { end: true },
      // 第 2 步（第 3 回合）：用户插过一轮无关对话后回来续跑
      // 新兴五金 1122 只有 current 键 → 202609 无数据。错误态快路径 v2 对齐：单调用
      // 计划撞终局信封，替身镜像在本跳以宿主话术收束（步结果照旧经 stepLabel 交还链，
      // 不终结整轮）——脚本里不再有"贴无数据文本"的一步；镜像 break 后脚本游标停在
      // 第 3 步段，由下一次委派继续消费（见 harness terminalMirror 的注释）。
      { plan: balanceCalls('新兴五金', '202609') },
      // 第 3 步（同一回合内继续派）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      {
        kind: 'delegate',
        request: '第1/3步：查幻辰财税账套 202601 至 202603 的应收余额',
        // 计划步的结果不 terminate 整轮；模型在这里自行收嘴，回合停在"第 1 步做完"
        text: '第 1 步查完了：幻辰财税 202601–202603 平台都未返回该期间数据。共 3 步，先停在这，你说继续我再接着查。',
      },
      // 第 2 回合：用户插入的无关对话——零平台调用、零委派
      { kind: 'conversation', text: '好，下周三之前交报表这件事我记下了。' },
      { kind: 'delegate', request: '第2/3步：查新兴五金账套 202609 的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
      { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
      { kind: 'conversation', text: '三个账套核对完成：幻辰财税 202601–202603 平台均未返回该期间数据；新兴五金 202609 也未返回；新兴建材当前期间为 700 元。' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    const log = capturePlanLog();
    try {
      const first = await send('逐个核对这三个账套的应收余额：幻辰财税、新兴五金、新兴建材');
      expect(first).toContain('未返回该期间数据');
      expect(first).not.toContain('不应外发');

      // 插入轮：宿主不因计划未完成就拒绝普通对话——这一轮零调用、零新通知、worker 未被再叫
      const noticesBeforeInterruption = sdk.noticeTexts().length;
      const interrupted = await send('提醒我一下，下周三之前要交报表');
      expect(interrupted).toContain('下周三');
      expect(worker.taskIds).toHaveLength(1);
      expect(sdk.noticeTexts()).toHaveLength(noticesBeforeInterruption);
      expect(totalActualCalls()).toBe(before + 3);

      // 用户回来续跑：Main Agent 申报第 2 步并带上一步的 taskId
      const resumed = await send('继续刚才的核对');
      expect(resumed).toContain('700 元');
      expect(resumed).not.toContain('不应外发');

      // 三次委派都续跑同一个子任务（跨回合也接得上）
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
      expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
      // 协议前缀不透传给子 Agent
      expect(worker.requests[1]).toContain('新兴五金');
      expect(worker.requests[1]).not.toContain('第2/3步');
      expect(worker.requests[2]).toContain('新兴建材');
      // 账本调用数跨回合累计：3 + 1 + 1
      expect(totalActualCalls()).toBe(before + 5);
      // 第 1 步的计划通知仍然只属于它自己那一轮
      expect(sdk.noticeTexts().some((notice) => notice.includes('第 1/3 步'))).toBe(true);

      // 步号连续：宿主账本里第 2 步接在第 1 步之后、第 3 步接在第 2 步之后，没有从头再来
      const started = log.steps().filter((entry) => entry.status === 'started');
      expect(started.map((entry) => entry.step)).toEqual(['1/3', '2/3', '3/3']);
      // 三个 started 步都写了终态（第 1 步 done、第 2/3 步 done）
      expect(log.steps().filter((entry) => entry.status !== 'started').map((entry) => entry.step))
        .toEqual(['1/3', '2/3', '3/3']);

      // ── 计划恢复：跨回合接回同一 planId（latestOpenPlan 按"步号未接满"判定未完成） ──
      // 第 1 步写了 done 后计划依然开着（1/3 未接满），第 3 回合申报「第2/3步」时
      // 走 task_plan_resumed 而非新开——planId 全程不变，投影不裂。
      expect(log.ownership().map((entry) => entry.event)).toEqual(['task_plan_started', 'task_plan_resumed']);
      const planIdOf = (step: string) => started.find((entry) => entry.step === step)?.planId ?? '';
      expect(planIdOf('2/3')).toBe(planIdOf('1/3'));
      expect(planIdOf('3/3')).toBe(planIdOf('1/3'));

      // 真 SQLite 库路径上的投影：三步同属一个计划，全部 done
      const plan = await assembly.store.taskPlans.project(PRINCIPAL_ID, SESSION_ID, planIdOf('1/3'));
      expect(plan?.totalSteps).toBe(3);
      expect(plan?.steps.map((entry) => entry.stepIndex)).toEqual([1, 2, 3]);
      expect(plan?.steps.every((entry) => entry.status === 'done')).toBe(true);
      expect(plan?.steps.every((entry) => entry.taskId === worker.taskIds[0])).toBe(true);
      // 计划接满后 latestOpenPlan 不再返回它（不会无限续跑旧计划）
      expect(await assembly.store.taskPlans.latestOpenPlan(PRINCIPAL_ID, SESSION_ID)).toBeNull();
    } finally {
      log.restore();
    }
    await assembly.close();
  });

  it('7.2 计划进行中插入探索轮：零调用澄清、探索落地点是新任务、不污染计划投影', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步（第 1 回合）：执行成功
      // 202601–202603 无余额键 → PERIOD_NO_DATA，不是"余额为 0"
      { plan: threePeriodPlan('幻辰财税') },
      { text: '幻辰财税 202601、202602、202603 平台均未返回该期间数据。' },
      { end: true },
      // 探索的落地点（第 3 回合）：无前缀的单步委派——不是计划步
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
      { text: '幻辰财税本期应收账款余额为 86000 元。' },
      { end: true },
      // 第 2 步（第 4 回合）：回到计划续跑。新兴五金 1122 只有 current 键 → 202609 无数据。
      // 错误态快路径 v2 对齐（与 7.1 第 2 步同因）：单调用计划撞终局信封，替身镜像在本跳
      // 以宿主话术收束（步结果照旧经 stepLabel 交还链，不终结整轮）——脚本里不再有
      // "贴无数据文本"的一步；镜像 break 后本用例再无委派，脚本到此耗尽。
      { plan: balanceCalls('新兴五金', '202609') },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      {
        kind: 'delegate',
        request: '第1/3步：查幻辰财税账套 202601 至 202603 的应收余额',
        text: '第 1 步查完了：幻辰财税 202601–202603 平台都未返回该期间数据。共 3 步，先停在这。',
      },
      // 探索轮：目标不明，申报 conversation 澄清，不强行委派
      { kind: 'conversation', text: '要查哪个账套、哪个期间的应收欠款？告诉我账套和期间，我就去查。' },
      // 用户补齐后落地：无前缀 = 单步委派，另起一个与计划无关的新子任务
      { kind: 'delegate', request: '查询幻辰财税账套本月的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    const log = capturePlanLog();
    try {
      await send('逐个核对这三个账套的应收余额：幻辰财税、新兴五金、新兴建材');
      expect(worker.taskIds).toHaveLength(1);
      expect(totalActualCalls()).toBe(before + 3);

      // 探索轮：澄清问句即本轮回复——零平台调用、零新通知、worker 未被再叫
      const noticesBeforeExplore = sdk.noticeTexts().length;
      const asked = await send('哪个客户欠款最多？');
      expect(asked).toContain('账套');
      expect(asked).toContain('期间');
      expect(asked).not.toContain('没有产生任何平台查询');
      expect(sdk.noticeTexts()).toHaveLength(noticesBeforeExplore);
      expect(worker.requests).toHaveLength(1);
      expect(totalActualCalls()).toBe(before + 3);

      // 探索落地：一次无前缀单步委派，用的是新子任务
      const explored = await send('幻辰财税的');
      expect(worker.requests).toHaveLength(2);
      expect(worker.requests[1]).toContain('幻辰财税');
      expect(worker.requests[1]).not.toContain('第2/3步');
      expect(worker.taskIds[1]).not.toBe(worker.taskIds[0]);
      expect(explored).toContain('86000 元');

      // 回到计划：申报第 2 步并显式带回第 1 步的 taskId（不是最近那个探索任务）
      declarations.push({
        kind: 'delegate',
        request: '第2/3步：查新兴五金账套 202609 的应收余额',
        continueTaskId: worker.taskIds[0],
      });
      declarations.push({ kind: 'conversation', text: '核对继续：幻辰财税 202601–202603 平台均未返回该期间数据；新兴五金 202609 也未返回。' });
      const backOnPlan = await send('继续核对');
      expect(backOnPlan).toContain('新兴五金');
      expect(backOnPlan).not.toContain('不应外发');

      // 计划步的 taskId 与第 1 步相同；探索那个新任务没有混进计划
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.taskIds[2]).toBe(worker.taskIds[0]);

      // 计划投影里只有 2 个 started 步：探索轮不记入 task_plan_steps
      const started = log.steps().filter((entry) => entry.status === 'started');
      expect(started.map((entry) => entry.step)).toEqual(['1/3', '2/3']);
      expect(log.steps()).toHaveLength(4);
      // 探索轮之后回到计划：第 2 步经 latestOpenPlan 接回同一 planId（1/3 未接满→计划仍开），
      // 投影只有一份、两步都属计划任务；探索那个新任务没有混进计划
      const planIdOf = (step: string) => started.find((entry) => entry.step === step)?.planId ?? '';
      expect(planIdOf('2/3')).toBe(planIdOf('1/3'));
      const plan = await assembly.store.taskPlans.project(PRINCIPAL_ID, SESSION_ID, planIdOf('1/3'));
      expect(plan?.steps.map((entry) => entry.stepIndex)).toEqual([1, 2]);
      expect(plan?.steps.map((entry) => entry.taskId)).toEqual([worker.taskIds[0], worker.taskIds[0]]);
      // 探索那个子任务的编号在计划投影里不出现
      expect((plan?.steps ?? []).map((entry) => entry.taskId)).not.toContain(worker.taskIds[1]);

      // 汇总不含计划污染：脚本只走到第 2 步，回复里不该冒出"第 3 步"
      expect(backOnPlan).not.toContain('第 3 步');
      expect(totalActualCalls()).toBe(before + 5);
    } finally {
      log.restore();
    }
    await assembly.close();
  });

  it('7.3 计划步骤真执行但平台没找到：宿主组装澄清收口（步记 needs），用户跳过后后续步骤接回同一计划', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步：执行成功
      // 202601–202603 无余额键 → PERIOD_NO_DATA，不是"余额为 0"
      { plan: threePeriodPlan('幻辰财税') },
      { text: '幻辰财税 202601、202602、202603 平台均未返回该期间数据。' },
      { end: true },
      // 第 2 步：真执行了，但平台对这个对象返回 not_found——有执行痕迹的错误结果。
      // mock 目录里没有「幻东建材」，not_found 信封带 data.query（执行层 517d952）→ 激活宿主的
      // 结构化澄清：这正是本例的主旨，夹具因此刻意保留这个 mock 里不存在的名字。
      { plan: balanceCalls('幻东建材', '202609') },
      { text: '平台未找到「幻东建材」对应的账套（ACCOUNT_SET_NOT_FOUND），这一步没有查到数据。' },
      { end: true },
      // 第 3 步：用户跳过后执行成功
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '第1/3步：查幻辰财税账套 202601 至 202603 的应收余额' },
      { kind: 'delegate', request: '第2/3步：查幻东建材账套 202609 的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
      // 澄清收口后模型仍想接着拆第 3 步：宿主在委派入口拦住（用户要先回答"查哪个"），
      // 抛出的就是已组装好的澄清问题——它经 terminate 语义成为本轮最终回复
      { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
      // 用户说"跳过它"（没有补名称）：模型不再重派失败的那一步，直接申报最后一步
      { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
      {
        kind: 'conversation',
        text: '三个账套核对完成：幻辰财税 202601–202603 平台均未返回该期间数据；幻东建材平台未找到对应账套，这一步没查到；新兴建材当前期间应收余额为 700 元。',
      },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    const log = capturePlanLog();
    try {
      // 第 1 回合：前两步都真执行了，第 2 步撞 not_found → 宿主澄清收口，第 3 步没派出去
      const first = await send('逐个核对这三个账套的应收余额：幻辰财税、幻东建材、新兴建材');
      // 用户看到的是宿主持信封数据机械组装的那一份：零候选 + 平台 correctForm 数据
      // （Wave 2 L2：宿主只拼结构，"该怎么改"由平台信封携带，宿主兜底仅在信封没带时用）
      expect(first).toBe(clarificationTextFor('ACCOUNT_SET_NOT_FOUND', {
        query: '幻东建材', candidates: [], correctForm: platformCorrectForm('ACCOUNT_SET_NOT_FOUND'),
      }));
      expect(first).toContain('没有找到匹配“幻东建材”的对象');
      expect(first).toContain(platformCorrectForm('ACCOUNT_SET_NOT_FOUND'));
      expect(first).toContain('我再查');
      // 反向断言：worker 那条捏造文本（连原始错误码一起）与后续步骤的数字一个都不上屏
      expect(first).not.toContain('ACCOUNT_SET_NOT_FOUND');
      expect(first).not.toContain('平台未找到');
      expect(first).not.toContain('这一步没有查到数据');
      expect(first).not.toContain('700 元');
      expect(first).not.toContain('不应外发');
      // 守卫恢复（D-102 已在平台侧修掉）——同 C3：这条 correctForm 曾含裸 operation 名
      // search-account-sets，经宿主 L2 原样渲染后就是给终端用户看内部协议文本；执行层已改成
      // 不含 operation 名的可行动措辞，所以这里回到零命中。尺子本身没动（D-098）。
      expect(executionLanguageFingerprints(first)).toEqual([]);
      // 两步都委派了（第 2 步真调了平台），第 3 步被委派入口的守卫拦住
      expect(worker.taskIds).toHaveLength(2);

      // 用户说"跳过它"：不再重派失败的那一步，直接续下一步
      const reply = await send('这个查不到就算了，跳过它');
      expect(reply).toContain('700 元');
      expect(reply).not.toContain('不应外发');

      // 三次委派都发生了，且续跑同一个子任务
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
      expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
      // 汇总同时含成功步结果与失败步的如实表述，不粉藏
      expect(reply).toContain('平台均未返回该期间数据');
      expect(reply).toContain('没查到');
      // 账本累计：3 + 1 + 1
      expect(totalActualCalls()).toBe(before + 5);

      // 第 2 步的宿主记账是 needs 而不是 failed：worker 真调用了、平台真回答了
      // （ACCOUNT_SET_NOT_FOUND 是平台的确定性应答，不是没执行），这一步缺的是"用户选哪个"，
      // 与缺参数同族（rule-landing.md C26 / §8 取舍 3）。业务成败由汇总如实呈现，宿主不猜。
      const stepTwo = log.steps().filter((entry) => entry.step === '2/3');
      expect(stepTwo.map((entry) => entry.status)).toEqual(['started', 'needs']);
      const planIdOfStepTwo = stepTwo[0]?.planId ?? '';
      const plan = await assembly.store.taskPlans.project(PRINCIPAL_ID, SESSION_ID, planIdOfStepTwo);
      // 同一 planId 贯穿三个步骤
      // 用户说"跳过"之后的第 3 步也经 latestOpenPlan 接回同一计划（2/3 未接满→仍开），投影一份
      expect(plan?.steps.map((entry) => [entry.stepIndex, entry.status])).toEqual([[1, 'done'], [2, 'needs'], [3, 'done']]);
    } finally {
      log.restore();
    }
    await assembly.close();
  });

  it('7.4（characterization）计划步骤撞用户确认门：该步等确认后由宿主续跑，剩余步骤不自动继续', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步：1 次调用，落在自动档内，直接执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 第 2 步：21 次调用的高重量计划越过 confirm 门槛 → 停在用户确认门
      { plan: heavyPlan(), stopAtConfirm: true },
      // 用户确认后：宿主激活计划并续跑原任务，worker 按 active 计划执行
      { execute: heavyPlan() },
      { text: '已按你确认的范围查完 1 至 9 月。' },
      { end: true },
      // 第 3 步：用户再说"继续"后，Main Agent 才续派最后一步。
      // 它自己也会撞上 confirm 门槛——第 2 步确认后真跑了 21 次，累计重量早已越过
      // EXECUTION_PLAN_CONFIRM_CALLS=20，"闸口做全局预算"在这条链上的形状就是每一步都要再问一次。
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }], stopAtConfirm: true },
      { execute: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
      { end: true },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      {
        kind: 'delegate',
        request: '第1/3步：查幻辰财税账套 202606 的应收账款余额',
        text: '第 1 步查完了：幻辰财税 202606 应收账款余额为 61000 元。共 3 步，先停在这。',
      },
      { kind: 'delegate', request: '第2/3步：查幻辰财税账套 1 至 9 月的应收账款', continueTaskId: LAST_TASK_ID_TOKEN },
      { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收账款', continueTaskId: LAST_TASK_ID_TOKEN },
      { kind: 'conversation', text: '三个账套核对完成：幻辰财税 202606 为 61000 元；1 至 9 月已按你确认的范围查完；新兴建材当前期间为 700 元。' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    const log = capturePlanLog();
    try {
      await send('逐个核对这三个账套的应收余额：幻辰财税、幻东建材、新兴建材');
      expect(worker.taskIds).toHaveLength(1);
      expect(totalActualCalls()).toBe(before + 1);

      // 第 2 步越过 confirm 门槛：宿主暂停等确认，回复是确认询问，这一步零执行落账
      const asked = await send('继续核对第 2 步');
      expect(asked).toContain('确认继续');
      expect(asked).not.toContain('query-receivables');
      expect(totalActualCalls()).toBe(before + 1);
      // 这一步确实委派了（同一个子任务），但一次平台调用都没落账
      expect(worker.taskIds).toHaveLength(2);
      expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
      // 确认门这一步在宿主账本里只有 started，没有终态（跨回合可续）
      const stepTwo = log.steps().filter((entry) => entry.step === '2/3');
      expect(stepTwo.map((entry) => entry.status)).toEqual(['started']);

      // 用户确认：宿主走 resumeTaskId 路径激活计划并续跑原任务（不再问模型）
      const confirmed = await send('确认继续');
      expect(confirmed).toContain('整理完成');
      expect(confirmed).not.toContain('确认继续');
      expect(totalActualCalls()).toBe(before + 22);
      // 确认轮只跑那一个子任务，Main Agent 没有借机扩范围
      expect(worker.taskIds).toHaveLength(3);
      expect(worker.taskIds[2]).toBe(worker.taskIds[0]);

      // ── characterization ①：确认后剩余步骤不自动继续，要用户再说"继续" ──
      // 实测（2026-09）：确认轮的回复只整理那一个已执行步骤（宿主拼装 + 模型转述），
      // 第 3 步不会自己跑；用户再说一句"继续"后 Main Agent 申报第 3 步才派出去。
      // 派得出去但立刻又停在同一道门前：第 2 步确认后真跑了 21 次，累计重量早已越过
      // EXECUTION_PLAN_CONFIRM_CALLS=20，"闸口做全局预算"在这条链上的形状就是每一步都要再问一次。
      const askedAgain = await send('继续核对最后一步');
      expect(askedAgain).toContain('确认继续');
      expect(askedAgain).not.toContain('700 元');
      expect(totalActualCalls()).toBe(before + 22);
      expect(worker.taskIds).toHaveLength(4);
      expect(worker.taskIds[3]).toBe(worker.taskIds[0]);

      // 再确认一次：第 3 步这才真执行，宿主同样只整理这一步
      const finished = await send('确认继续');
      expect(finished).toContain('整理完成');
      expect(totalActualCalls()).toBe(before + 23);
      expect(worker.taskIds).toHaveLength(5);
      expect(worker.taskIds[4]).toBe(worker.taskIds[0]);

      // 步号连续，且三步同属一个计划：第 1 步 done 后计划仍开着（1/3 未接满），
      // 第 2 步经 latestOpenPlan 接回同一 planId（修复后不再裂开）
      const started = log.steps().filter((entry) => entry.status === 'started');
      expect(started.map((entry) => entry.step)).toEqual(['1/3', '2/3', '3/3']);
      const planIdOf = (step: string) => started.find((entry) => entry.step === step)?.planId ?? '';
      expect(planIdOf('2/3')).toBe(planIdOf('1/3'));
      expect(planIdOf('3/3')).toBe(planIdOf('1/3'));
      expect(log.ownership().map((entry) => entry.event)).toEqual(['task_plan_started', 'task_plan_resumed', 'task_plan_resumed']);
      const plan = await assembly.store.taskPlans.project(PRINCIPAL_ID, SESSION_ID, planIdOf('1/3'));
      expect(plan?.totalSteps).toBe(3);
      // ── characterization：确认门的恢复路径不写步骤终态 ──
      // 第 2/3 步都是用户确认后由宿主 resumeTaskId 续跑的，那条路径不经 Main 的委派工具，
      // 因此投影里它们保持 started——第 3 步打点后 maxStep 接满 totalSteps，计划关闭
      // （latestOpenPlan 不再返回它；待确认的步骤由 pendingPlan/确认码机制继续兜）。
      expect(plan?.steps.map((entry) => [entry.stepIndex, entry.status])).toEqual([[1, 'done'], [2, 'started'], [3, 'started']]);
      expect(await assembly.store.taskPlans.latestOpenPlan(PRINCIPAL_ID, SESSION_ID)).toBeNull();
      // 两步的计划通知都带上了各自的步骤标签
      expect(sdk.noticeTexts().some((notice) => notice.includes('第 2/3 步'))).toBe(true);
      expect(sdk.noticeTexts().some((notice) => notice.includes('第 3/3 步'))).toBe(true);
    } finally {
      log.restore();
    }
    await assembly.close();
  });
});
