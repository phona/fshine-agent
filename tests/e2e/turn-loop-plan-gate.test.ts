// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：计划门（通知与确认门）。共享替身见 ./harness.ts。
 *
 * 覆盖：扩大范围先通知且送达后才执行、通知投递失败不激活不执行、
 * 高重量计划等用户确认后续跑原任务。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, heavyPlan, mainDriver, nineMonthPlan, totalActualCalls } from './harness';

describe('[L4 集成] 离线全链 e2e：计划门（通知与确认）', () => {
  it('2.6 扩大查询范围前用户先收到范围与耗时通知，通知送达后才执行', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套 1 到 9 月的应收账款' }]),
      worker: gatedWorker([{ plan: nineMonthPlan() }]),
    });
    const reply = await send('查幻辰财税账套 1 到 9 月的应收账款');

    const notices = sdk.noticeTexts();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join('\n')).toContain('2026年01月至2026年09月');
    // 通知帧必须早于最终回复帧
    const noticeIndex = sdk.frames.findIndex((frame) => frame.content.startsWith('计划通知：'));
    const finalIndex = sdk.frames.map((frame) => frame.finish).lastIndexOf(true);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(finalIndex);
    // 通知放行后，跨月查询真的执行了
    expect(reply).toContain('query-receivables');
    expect(totalActualCalls()).toBeGreaterThan(0);
    await assembly.close();
  });

  it('2.6 计划通知投递失败时不激活、不执行扩展查询', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查幻辰财税账套 1 到 9 月的应收账款' }]),
      worker: gatedWorker([{ plan: nineMonthPlan() }]),
    });
    sdk.failNotice = '2026年01月至2026年09月';
    const reply = await send('查幻辰财税账套 1 到 9 月的应收账款');

    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    expect(reply).not.toContain('query-receivables');
    expect(reply).toContain('失败');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('2.7 高重量计划等用户确认，确认后激活并续跑原任务', async () => {
    const resumeInputs: string[] = [];
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查幻辰财税账套全年的应收账款' },
        { kind: 'delegate', request: '查幻辰财税账套全年的应收账款' },
      ], (input) => resumeInputs.push(JSON.stringify(input.messages))),
      worker: gatedWorker([{ plan: heavyPlan(), stopAtConfirm: true }, { execute: heavyPlan() }, { text: '已按你确认的范围查完 1 至 9 月。' }]),
    });
    const asked = await send('查幻辰财税账套全年的应收账款');
    expect(asked).toContain('确认继续');
    expect(totalActualCalls()).toBe(0);

    const done = await send('确认继续');
    expect(done).toContain('整理完成');
    expect(resumeInputs.join('')).toContain('已按你确认的范围查完');
    expect(totalActualCalls()).toBeGreaterThan(0);
    await assembly.close();
  });
});