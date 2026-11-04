// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：委派失败的用户话术分流（F7）。共享替身见 ./harness.ts。
 *
 * failureClass 原来只进日志：auth / timeout / executor_error / cancelled 四类失败，
 * 用户统一收到"17dz 子任务执行失败，请稍后再试"。于是唯一需要用户动手的一类
 * （平台登录态过期）被埋掉——用户只能盲目重试，重试多少次都不会好。
 *
 * 这里走真 assembly + 真 ContextTaskRunner 的 catch 分支，钉住 auth 类给出可行动话术。
 */
import { describe, expect, it } from 'vitest';
import { boot, mainDriver } from './harness';

/** 委派即失败的 worker 替身：真实 worker 的确定性拒绝原因由平台侧抛出。 */
function failingWorker(message: string) {
  return { run: async () => { throw new Error(message); } };
}

describe('[L4 集成] 离线全链 e2e：委派失败的用户话术', () => {
  it('F7 平台登录态过期：用户收到需要重新登录的可行动话术，而不是"稍后再试"', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' }]),
      worker: failingWorker('平台登录已过期，请重新登录'),
    });

    const reply = await send('查一下幻辰财税的应收账款');

    expect(reply).toBe('平台登录态过期，需要重新登录后才能继续查询。');
    // 错指令比没有指令更糟：这类失败不能伴随"稍后再试"
    expect(reply).not.toContain('稍后');
    expect(reply).not.toContain('执行失败');
    await assembly.close();
  });

  it('F7 补：执行器错误维持原话术，原始错误内容不透出', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' }]),
      worker: failingWorker('secret=/private/credentials'),
    });

    const reply = await send('查一下幻辰财税的应收账款');

    expect(reply).toBe('17dz 子任务执行失败，请稍后再试。');
    expect(reply).not.toContain('secret');
    await assembly.close();
  });
});
