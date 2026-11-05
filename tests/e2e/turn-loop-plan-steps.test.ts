// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：长任务拆解（roadmap Phase 6，架构 §3 规划者/执行者分工）。共享替身见 ./harness.ts。
 *
 * Main Agent 拆解 → 逐步派单 → 汇总；任一步失败不阻塞其他步骤；用户通知带「第 N/M 步」。
 * 三步续跑同一个 17dz 子任务（continueTaskId），平台累计账本因此跨步累积——闸口看到的是
 * 全局重量，这是"闸口能做全局预算"的落地。
 *
 * 夹具口径（Wave 1 收尾）：账套名一律用 mock 种子状态里**真实存在**的规范名
 * （`17dz-platform/src/execution/mocks/fixtures/seed.json`）。本文件的主旨是长任务拆解
 * 本身（逐步派单 / 同任务续跑 / 步号接续），不是"平台说没有"——用捏造名时，平台 not_found
 * 信封带 data.query 会激活宿主的结构化澄清（selectionClarificationOf），澄清问题把回合
 * 收口，后续步骤根本派不出去。计划步骤的失败面由 6.2（needs）、7.3（平台没找到→宿主澄清）
 * 与 turn-loop-clarification 的 C2 覆盖，不靠 6.1 顺带覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanCall } from '@fshine/agent';
import {
  LAST_TASK_ID_TOKEN,
  balanceCalls,
  boot,
  gatedWorker,
  mainDriver,
  totalActualCalls,
  type WorkerStep,
} from './harness';

/**
 * 三步拆解会让累计调用数一直越过高 weight 自动档：每一步重提计划都是 notify。
 * 这里把同一任务的 notify 上限放宽（平台侧默认 2），否则第 3 步会被升级成"必须等用户
 * 确认"——那是单步试探收口的规则，不是长任务拆解该有的形状。
 */
beforeAll(() => { process.env['EXECUTION_PLAN_MAX_NOTIFY'] = '6'; });
afterAll(() => { delete process.env['EXECUTION_PLAN_MAX_NOTIFY']; });

/** 三个期间的查询计划：3 次调用，越过 harness 的 EXECUTION_PLAN_AUTO_CALLS=2 触发通知。 */
function threePeriodPlan(account: string): PlanCall[] {
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

/** 缺期间：worker 执行不了，如实回报缺什么 / 为什么 / 建议用户提供什么。 */
const NEEDS_PERIOD = {
  missing: ['期间'],
  reason: '平台要求查询必须显式给出期间，不接受缺省',
  suggestion: '请告诉我要查的具体期间',
};

describe('[L4 集成] 离线全链 e2e：长任务拆解（计划模式）', () => {
  it('6.1 「核对 3 个账套」全链：逐步派单、同任务续跑、每步结果如实进汇总', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步：3 次调用的计划（越过自动档 → 先通知用户），执行成功
      // 202601–202603 在 mock 里都没有余额键 → 平台回 PERIOD_NO_DATA，不是"余额为 0"
      { plan: threePeriodPlan('幻辰财税') },
      { text: '幻辰财税 202601、202602、202603 平台均未返回该期间数据。' },
      { end: true },
      // 第 2 步：真执行了，mock 当前期间应收余额 500（seed 真实数据）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴五金'] }] },
      { text: '新兴五金当前期间应收余额为 500 元。' },
      { end: true },
      // 第 3 步：执行成功
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '第1/3步：查幻辰财税账套 202601 至 202603 的应收余额' },
        { kind: 'delegate', request: '第2/3步：查新兴五金账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'conversation', text: '三个账套核对完成：幻辰财税 202601–202603 平台均未返回该期间数据；新兴五金当前期间为 500 元；新兴建材当前期间应收余额为 700 元。' },
      ]),
      worker: worker.driver,
    });

    const reply = await send('逐个核对这三个账套的应收余额：幻辰财税、新兴五金、新兴建材');

    // 三次委派都发生了，且第 2/3 步起续跑同一个子任务（累计账本跨步累积）
    expect(worker.taskIds).toHaveLength(3);
    expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
    expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
    // 协议前缀不透传给子 Agent：worker 只看到加工后的请求
    expect(worker.requests[0]).toContain('幻辰财税');
    expect(worker.requests[0]).not.toContain('第1/3步');
    expect(worker.requests[1]).not.toContain('第2/3步');
    // 汇总覆盖三个账套，三步结果一条不落
    expect(reply).toContain('幻辰财税');
    expect(reply).toContain('新兴五金');
    expect(reply).toContain('500 元');
    expect(reply).toContain('700 元');
    expect(reply).not.toContain('不应外发');
    // 用户收到的计划通知带「第 N/M 步」
    const notices = sdk.noticeTexts();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.some((notice) => notice.includes('第 1/3 步'))).toBe(true);
    // 账本调用数跨步累积：3 + 1 + 1
    expect(totalActualCalls()).toBeGreaterThanOrEqual(before + 4);
    await assembly.close();
  });

  it('6.2 任一步失败不阻塞：第 2 步回报缺信息，Main Agent 继续第 3 步并如实汇总', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 第 1 步：执行成功（202601–202603 无余额键 → PERIOD_NO_DATA，不是"余额为 0"）
      { plan: threePeriodPlan('幻辰财税') },
      { text: '幻辰财税 202601、202602、202603 平台均未返回该期间数据。' },
      { end: true },
      // 第 2 步：执行不了，回报结构化线索（Phase 5 纠错环），不产生任何平台调用
      { need: NEEDS_PERIOD },
      // 第 3 步：照常执行
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收余额为 700 元。' },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '第1/3步：查幻辰财税账套 202601 至 202603 的应收余额' },
        { kind: 'delegate', request: '第2/3步：查幻东建材账套的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'delegate', request: '第3/3步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'conversation', text: '三个账套核对完成：幻辰财税 202601–202603 平台均未返回该期间数据；幻东建材需要你补充要查的期间，这一步没查；新兴建材当前期间应收余额为 700 元。' },
      ]),
      worker: worker.driver,
    });

    const reply = await send('逐个核对这三个账套的应收余额：幻辰财税、幻东建材、新兴建材');

    // 三步都发生过：第 2 步的缺信息没有把回合掐掉，也没有阻塞第 3 步
    expect(worker.requests).toHaveLength(3);
    expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
    expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
    expect(worker.requests[1]).toContain('幻东建材');
    expect(worker.requests[2]).toContain('新兴建材');
    // 汇总如实报告第 2 步缺信息，最终回复有真实执行痕迹
    expect(reply).toContain('补充');
    expect(reply).toContain('700 元');
    expect(reply).not.toContain('不应外发');
    expect(totalActualCalls()).toBeGreaterThan(before);
    await assembly.close();
  });

  it('6.3 连续 3 步零执行熔断：第 3 步后停止派发，用户收到计划事实汇总', async () => {
    const worker = recordingWorker([
      // 三步都只打印文本：无计划提交、无平台调用、无 needs（真实平台 12 步实测的空转形状）
      { text: '这一步没有发起任何平台调用。' }, { end: true },
      { text: '这一步没有发起任何平台调用。' }, { end: true },
      { text: '这一步没有发起任何平台调用。' }, { end: true },
      { text: '这一步不应该再被派发。' }, { end: true },
    ]);
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '第1/4步：查幻辰财税账套 202601 的应收余额' },
        { kind: 'delegate', request: '第2/4步：查幻东建材账套 202609 的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'delegate', request: '第3/4步：查新兴建材账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'delegate', request: '第4/4步：查丁账套当前期间的应收余额', continueTaskId: LAST_TASK_ID_TOKEN },
        { kind: 'conversation', text: '主 Agent 自由文本：不应外发' },
      ]),
      worker: worker.driver,
    });

    const reply = await send('逐个核对这四个账套的应收余额：幻辰财税、幻东建材、新兴建材、丁');

    // 第 3 步后熔断：第 4 步没有再派，模型汇总被宿主的熔断汇总顶上
    expect(worker.requests).toHaveLength(3);
    expect(reply).toContain('第 1/4 步');
    expect(reply).toContain('连续 3 步');
    expect(reply).toContain('没有产生任何平台执行');
    expect(reply).not.toContain('不应外发');
    // 三步都没真执行：平台侧一次调用都没发生
    expect(totalActualCalls()).toBe(0);
    await assembly.close();
  });
});
