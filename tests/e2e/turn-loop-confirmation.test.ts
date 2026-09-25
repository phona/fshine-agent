/**
 * 离线全链 e2e：跨轮确认语义。共享替身见 ./harness.ts。
 *
 * 覆盖：待确认计划被新计划取代后旧确认得到确定性解释、
 * 同一任务反复 notify 后升级为必须等用户确认。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, CURRENT_PERIOD, gatedWorker, growingPlan, heavyPlan, mainDriver } from './harness';

describe('离线全链 e2e：跨轮确认语义', () => {
  it('2.7 待确认计划被新计划取代后，旧确认得到确定性解释', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      ]),
      worker: gatedWorker([{ plan: heavyPlan() }, { plan: balanceCalls('幻辰财税', CURRENT_PERIOD) }]),
    });
    await send('查幻辰财税账套全年的应收账款');
    // 同一任务再提一个轻量计划：平台把旧计划标记为 superseded
    await send('只查本月幻辰财税的应收账款');
    const stale = await send('确认继续');

    expect(stale).toContain('已经被更新的计划取代');
    expect(stale).not.toContain('处理失败');
    await assembly.close();
  });

  it('2.8 同一任务内反复通知后升级为必须等用户确认', async () => {
    // 计数器按 taskId 记账：必须是同一个任务里连续改口径，才能观察到升级。
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      ]),
      worker: gatedWorker([{ plan: growingPlan(4) }, { plan: growingPlan(6) }, { plan: growingPlan(8) }]),
    });
    const reply = await send('查幻辰财税账套的应收账款');

    // 前两次是 notify 档通知，第三次是升级后的确认询问（confirm 也会先告知用户）
    expect(sdk.noticeTexts()).toHaveLength(3);
    expect(sdk.noticeTexts().at(-1)).toContain('确认继续');
    expect(reply).toContain('确认继续');
    await assembly.close();
  });
});
