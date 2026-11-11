// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：多任务交织与探索型会话（覆盖增强）。共享替身见 ./harness.ts。
 *
 * 现有 turn-loop-* 用例全是单任务直筒（一个问题一次委派一轮结束）；这里补真实会话里
 * 最常见的两种形状：
 *   ① 两个委派任务交织后，用户回到旧话题——宿主按 continueTaskId 找回第一个子任务，
 *      不被最近的新任务卡住；
 *   ② 目标不明的探索请求——先申报 conversation 澄清（零平台调用），用户补齐账套/期间后
 *      才委派；平台没有的能力如实说明边界，不编造数字。
 * 另测召回与重查的路由边界："刚才查出来多少"走对话零调用，"再查一次"才重新委派。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, CURRENT_PERIOD, gatedWorker, mainDriver, totalActualCalls, type WorkerStep } from './harness';

/** 记录 worker 实际收到的委派请求与 taskId（宿主透传 intent.request，不做二次加工）。 */
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

describe('[L4 集成] 离线全链 e2e：多任务交织与探索型会话', () => {
  it('2.3 两个委派任务交织后，按 continueTaskId 回到第一个任务', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 任务 A（第 1 轮）：真实执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 任务 B（第 2 轮）：用户换话题，另起一个与 A 无关的新子任务
      { plan: [{ operation: 'voucher.query-saved', args: ['新兴五金', CURRENT_PERIOD] }] },
      { text: '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。' },
      { end: true },
      // 任务 A 续跑（第 3 轮）：宿主按 continueTaskId 找回 A 的会话再执行
      // 202609 在 mock 里没有余额键（幻辰财税 1122 只有 202606/current）→ 单调用计划撞
      // not_found + PERIOD_NO_DATA，不是"余额为 0"。错误态快路径 v2 后镜像以宿主话术
      // 收束本跳（无贴文本段，逐字断言见下方 third）。
      { plan: balanceCalls('幻辰财税', CURRENT_PERIOD) },
    ]);
    // 前两条申报先入脚本；第三条（带 continueTaskId）要等 A 的 taskId 真跑出来才知道
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
      { kind: 'delegate', request: '查询新兴五金账套 202609 已保存的凭证' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const first = await send('查一下幻辰财税 202606 的应收账款余额');
    expect(first).toContain('61000 元');
    expect(first).not.toContain('不应外发');

    const second = await send('再查一下新兴五金 202609 保存的凭证');
    expect(second).toContain('新兴五金');
    expect(worker.taskIds[1]).not.toBe(worker.taskIds[0]);

    // 用户回到旧话题：申报 delegate + continueTaskId = A 的 taskId（不是最近的 B）
    declarations.push({
      kind: 'delegate',
      request: '查询幻辰财税账套 202609 的应收账款余额',
      continueTaskId: worker.taskIds[0],
    });
    const third = await send('继续查幻辰财税的应收，按 202609');

    // 第三次委派回到 A 的会话：taskId 与第一个相同、与第二个不同
    expect(worker.taskIds).toHaveLength(3);
    expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
    expect(worker.taskIds[2]).not.toBe(worker.taskIds[1]);
    // worker 收到的是恢复 A 的请求（带用户新给的期间），不掺入 B 的对象
    expect(worker.requests[2]).toContain('幻辰财税');
    expect(worker.requests[2]).toContain('202609');
    expect(worker.requests[2]).not.toContain('新兴五金');
    // 最终回复是本轮真实执行的结果，不是把 A 的旧答复重放一遍。错误态快路径 v2 后，
    // 单调用计划撞无数据终局的收稿是宿主模板话术（不再有替身贴的叙述体），逐字对齐。
    expect(third).toBe('没有查到“幻辰财税”在 202609 的数据。平台上有数据的是：202606、平台当前期间。要改查的话，告诉我查哪一项即可。');
    expect(third).not.toContain('61000');
    expect(third).not.toContain('不应外发');
    // 账本按子任务累计：A 两次 + B 一次
    expect(totalActualCalls()).toBe(before + 3);
    await assembly.close();
  });

  it('1.3 召回旧结果走对话零平台调用，"再查一次"才重新委派', async () => {
    const worker = recordingWorker([
      // 第 1 轮：真实执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 第 3 轮：重新查询——同一问题重问仍是新查询，不是重放旧答复
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额仍是 61000 元（本次重新查询）。' },
    ]);
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
      // 召回轮：申报 conversation，文本复述刚才的真实结果
      { kind: 'conversation', text: '刚才查到：幻辰财税 202606 的应收账款余额是 61000 元。' },
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: worker.driver,
    });

    await send('查一下幻辰财税 202606 的应收账款余额');
    const afterFirst = totalActualCalls();
    expect(afterFirst).toBeGreaterThan(0);
    expect(worker.requests).toHaveLength(1);

    // 召回轮：宿主注入了指代回溯证据供模型复述，但路由停在 conversation——
    // 零新增平台调用、零通知，worker 一次都没被再叫
    const recalled = await send('幻辰财税刚才查出来余额是多少？');
    expect(recalled).toContain('61000 元');
    expect(recalled).not.toContain('没有产生任何平台查询');
    expect(observed[1]).toContain('宿主主动回溯');
    expect(totalActualCalls()).toBe(afterFirst);
    expect(worker.requests).toHaveLength(1);
    expect(sdk.noticeTexts()).toHaveLength(0);

    // 重查轮：申报 delegate，真的一次新委派（新子任务，不是续跑旧任务）
    const requeried = await send('再查一次');
    expect(requeried).toContain('61000 元');
    expect(worker.requests).toHaveLength(2);
    expect(worker.taskIds[1]).not.toBe(worker.taskIds[0]);
    expect(totalActualCalls()).toBe(afterFirst + 1);
    await assembly.close();
  });

  it('1.6 目标不明的探索请求先澄清，用户补齐账套和期间后才委派', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 用户补齐后的一次真实执行：不传 --period，按平台当前期间（=本月）
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
      { text: '幻辰财税本期应收账款余额为 86000 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      // 没给账套也没给期间：申报 conversation 澄清，不强行委派
      { kind: 'conversation', text: '要查哪个账套、哪个期间的应收欠款？告诉我账套和期间，我就去查。' },
      { kind: 'delegate', request: '查询幻辰财税账套本月的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    // 第一轮：澄清问句即本轮回复——零平台调用、零通知
    const asked = await send('哪个客户欠款最多？');
    expect(asked).toContain('账套');
    expect(asked).toContain('期间');
    expect(asked).not.toContain('没有产生任何平台查询');
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(worker.requests).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);

    // 用户补齐：委派请求里带上账套与期间，worker 真实执行
    const done = await send('幻辰财税，本月');
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toContain('幻辰财税');
    expect(worker.requests[0]).toContain('本月');
    expect(done).toContain('86000 元');
    expect(done).not.toContain('不应外发');
    expect(totalActualCalls()).toBe(before + 1);
    await assembly.close();
  });

  it('4.4 平台没有的分析能力如实说明边界，不编造任何金额', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([{ text: '不应执行' }]);
    const declarations: Array<Record<string, unknown>> = [
      // 选 conversation 而不是 delegate：平台没有"按客户欠款排序"的汇总能力，
      // 强行委派只会逼子 Agent 换口径试探；如实说明边界并告诉用户能怎么做。
      { kind: 'conversation', text: '目前平台只有按账套、科目、单个客户的余额与凭证查询，没有按客户欠款排序的汇总分析能力，我不能凭猜测给你排名。你告诉我要哪个账套、哪个期间，我可以逐个客户查余额后按查到的数字排序；也可以先给你这个账套的应收总额。' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    const reply = await send('帮我分析下应收情况，按客户排个序');

    // 边界说得清楚：没有这个能力 + 需要用户补什么 + 可以怎么做
    expect(reply).toContain('没有');
    expect(reply).toContain('排序');
    expect(reply).toContain('账套');
    // 诚实边界不含编造金额：本轮零执行，一个数字结论都不该出现
    expect(reply).not.toMatch(/\d+\s*[元万亿]/);
    // 宿主没有把澄清当失败：没有兜底话术、没有通知、零平台调用、worker 未被叫
    expect(reply).not.toContain('没有产生任何平台查询');
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(worker.requests).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });
});
