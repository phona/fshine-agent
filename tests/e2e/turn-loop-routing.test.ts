// [L4 集成] fshine + 17dz 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：申报路由与安全边界。共享替身见 ./harness.ts。
 *
 * 覆盖：缺账套先追问（申报 conversation，模型文本即回复）、申报夹带历史账套时
 * 按 delegate 申报委派并透传加工后的请求、未授权用户、群聊 @ 剥离、跳过申报时失败关闭。
 */
import { describe, expect, it } from 'vitest';
import { A2A_PROTOCOL_VERSION } from '../../packages/contracts/src/a2a-protocol';
import { boot, gatedWorker, mainDriver, silentDriver, totalActualCalls } from './harness';

/** 记录 worker 实际收到的委派请求（宿主透传 intent.request，不做二次加工）。 */
function recordingWorker(script: Parameters<typeof gatedWorker>[0]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  return {
    requests,
    driver: {
      run: async (input: { messages: Array<{ role: string; content: string }> }) => {
        const last = input.messages.at(-1);
        requests.push(String(last?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

describe('[L4 集成] 离线全链 e2e：申报路由与安全边界', () => {
  it('1.6 不问账套的实时余额问题先追问，不调用平台', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      // 澄清能力边界时申报 conversation，模型文本即回复
      main: mainDriver([{ kind: 'conversation', text: '要查哪个账套？' }]),
      worker: gatedWorker([{ text: '不应执行' }]),
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');
    expect(reply).toContain('账套');
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('1.6/5.4 申报夹带历史账套时按 delegate 申报委派，worker 收到加工后的请求', async () => {
    const worker = recordingWorker([
      { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '猫一杯'] }] },
      { text: '账套目录里没有"猫一杯"，请确认对象名称。' },
    ]);
    const { send, assembly } = await boot({
      // 申报层证据校验（C1/C2）已取消：delegate 申报即委派；实体范围守卫在计划层 C20
      // （packages/agent/pi-coding-driver.test.ts 与 turn-contract.test.ts 的 validatePlanEntities 用例）。
      main: mainDriver([{ kind: 'delegate', request: '查询猫一杯的应收账款余额' }]),
      worker: worker.driver,
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');

    // 宿主据申报直接委派，request 逐字透传进 DelegationBlock JSON（②：载荷走消息通道）
    expect(worker.requests).toHaveLength(1);
    const delegationBlock = JSON.parse(worker.requests[0] as string) as Record<string, unknown>;
    expect(delegationBlock.request).toBe('查询猫一杯的应收账款余额');
    expect(delegationBlock.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(reply).toContain('猫一杯');
    expect(reply).not.toContain('不应外发');
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
      main: mainDriver([{ kind: 'delegate', request: '只查账套目录，看看有没有幻辰这个帐套' }]),
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