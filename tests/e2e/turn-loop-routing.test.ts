/**
 * 离线全链 e2e：申报路由与安全边界。共享替身见 ./harness.ts。
 *
 * 覆盖：缺账套先追问、申报夹带历史账套降级澄清、未授权用户安全拒绝、
 * 群聊 @ 剥离、跳过申报时失败关闭。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, mainDriver, silentDriver, totalActualCalls } from './harness';

describe('离线全链 e2e：申报路由与安全边界', () => {
  it('1.6 不问账套的实时余额问题先追问，不调用平台', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'missing', accountQueries: [], question: '要查哪个账套？' }]),
      worker: gatedWorker([{ text: '不应执行' }]),
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');
    expect(reply).toContain('账套');
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('1.6/5.4 申报夹带历史账套时降级为澄清，不委派', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻东'] }]),
      worker: gatedWorker([{ text: '幻东应收 42 元。' }]),
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');
    expect(reply).toContain('账套');
    expect(reply).not.toContain('幻东');
    expect(reply).not.toContain('42 元');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('1.4 未授权用户被安全拒绝，不泄露其他用户或账套信息', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'conversation' }]),
      worker: gatedWorker([{ text: '不应执行' }]),
    });
    const reply = await send('查一下幻辰财税的应收账款', { userid: 'stranger' });

    expect(reply).toContain('未开通查询权限');
    expect(reply).not.toContain('幻辰');
    await assembly.close();
  });

  it('5.x 群聊消息剥离开头 @机器人 后照常处理', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'account_search', searchQuery: '幻辰' }]),
      worker: gatedWorker([
        { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '幻辰'] }] },
        { text: '账套目录中没有"幻辰"。' },
      ]),
    });
    // 适配器只剥离开头 @ 段；@ 之后的正文才是用户请求
    const reply = await send('只查账套目录，看看有没有幻辰这个帐套', { group: true });

    expect(reply).toContain('幻辰');
    expect(reply).not.toContain('@');
    await assembly.close();
  });

  it('宿主保证 Main Agent 跳过申报时失败关闭，不外发其文本（无对手工用例）', async () => {
    const { send, assembly } = await boot({ main: silentDriver(), worker: gatedWorker([{ text: '不应执行' }]) });
    const reply = await send('查一下幻辰财税的应收账款');
    expect(reply).toContain('没有产生任何平台查询');
    expect(reply).not.toContain('42 元');
    await assembly.close();
  });
});
