// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：方案已批准但查询没有执行（P1 收尾事实兜底）。共享替身见 ./harness.ts。
 *
 * 2026-09-26 真实平台实测（ask.ts 多轮脚本 T5r）：方案已批准、计划通知已送达用户，
 * worker 却零平台调用就结束了回合。那时的真实状态是"批准了没执行"——缺的是执行，
 * 不是用户早就给过的查询对象和期间。这里守住的正是收尾文案说真话。
 */
import { describe, expect, it } from 'vitest';
import { ACTIVATED_PLAN_NOT_EXECUTED } from '../../packages/agent/src/runtime';
import { boot, gatedWorker, growingPlan, mainDriver, totalActualCalls } from './harness';

describe('[L4 集成] 离线全链 e2e：批准了但没执行的收尾', () => {
  it('P1.1 计划通知已送达、查询零执行时，说清真实状态并给出下一步', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套 1 到 3 月的应收账款' }]),
      // 计划激活即收手：一个平台调用都不发起（真实 worker 是 driver 补一刀后仍零执行）
      worker: gatedWorker([
        { plan: growingPlan(3), stopAfterActivate: true },
        { text: '方案已批准，但这一步没有发起查询。' },
        { end: true },
      ]),
    });
    const reply = await send('查幻辰财税账套 1 到 3 月的应收账款');

    // 前半段与真实案例一致：通知帧确实送达过用户，计划确实激活了
    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    expect(reply).toBe(`${ACTIVATED_PLAN_NOT_EXECUTED}\n\n方案已批准，但这一步没有发起查询。`);
    // 不再是"请补充查询对象和范围"那种把原因丢回用户的误导兜底
    expect(reply).not.toContain('没有产生任何平台查询');
    expect(reply).not.toContain('请告诉我要查询的对象和范围');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('P1.2 worker 的说明带财务数字时不附注，只发确定性状态文案', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套 1 到 3 月的应收账款' }]),
      worker: gatedWorker([
        { plan: growingPlan(3), stopAfterActivate: true },
        { text: '幻辰财税 202601 应收余额大概是 42 元。' },
        { end: true },
      ]),
    });
    const reply = await send('查幻辰财税账套 1 到 3 月的应收账款');

    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    expect(reply).toBe(ACTIVATED_PLAN_NOT_EXECUTED);
    // 零执行轮次的编造数字绝不下发
    expect(reply).not.toContain('42 元');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('P1.3 用户回复"继续"后重新执行，执行闭环由此合上', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查幻辰财税账套 1 到 3 月的应收账款' },
        { kind: 'delegate', request: '查幻辰财税账套 1 到 3 月的应收账款' },
      ]),
      worker: gatedWorker([
        // 第一回合：方案批准即收手，零执行
        { plan: growingPlan(3), stopAfterActivate: true },
        { text: '方案已批准，但这一步没有发起查询。' },
        { end: true },
        // 用户回复"继续"：重新委派，同一方案重新评估激活后真执行
        { plan: growingPlan(3) },
        { text: '已按方案查完 1 至 3 月。' },
      ]),
    });
    const blocked = await send('查幻辰财税账套 1 到 3 月的应收账款');
    expect(blocked).toContain('请回复“继续”');
    expect(totalActualCalls()).toBe(before);

    const done = await send('继续');
    expect(done).toContain('已按方案查完 1 至 3 月。');
    expect(totalActualCalls()).toBeGreaterThan(before);
    await assembly.close();
  });
});
