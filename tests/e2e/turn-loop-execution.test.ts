// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：执行凭证与查询范围。共享替身见 ./harness.ts。
 *
 * 覆盖：重复提问必须重查、子 Agent 零执行不外发财务结论、
 * 账套不存在时只走目录搜索。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, gatedWorker, ledger, mainDriver, platformCorrectForm, totalActualCalls } from './harness';

describe('[L4 集成] 离线全链 e2e：执行凭证与查询范围', () => {
  it('1.3/5.4 重复提问实时数据必须产生本轮平台执行，不能重放旧答复', async () => {
    // 查 202606（mock 有余额键）：错误态快路径 v2 后，单调用计划查无数据期间
    // （如 202609）会以宿主终局话术终结，不再是"贴成功文本"的形状——本用例的意图是
    // "重复提问必须重新执行并给出数据答案"，因此瞄准有数据的期间。
    const worker = () => gatedWorker([
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收余额为 51 元。' },
    ]);
    const main = () => mainDriver([
      { kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' },
    ]);

    const first = await boot({ main: main(), worker: worker() });
    const firstReply = await first.send('查一下幻辰财税的应收账款');
    expect(firstReply).toContain('51 元');
    expect(firstReply).not.toContain('不应外发');
    const callsAfterFirst = totalActualCalls();
    expect(callsAfterFirst).toBeGreaterThan(0);
    await first.assembly.close();

    // 同一问题重问：宿主会话里已经有旧答复，但仍必须重新查询
    const second = await boot({ main: main(), worker: worker() });
    const secondReply = await second.send('查一下幻辰财税的应收账款');
    expect(secondReply).toContain('51 元');
    expect(totalActualCalls()).toBeGreaterThan(callsAfterFirst);
    await second.assembly.close();
  });

  it('2.6 申报实时查询但子 Agent 零执行时，不外发其财务结论', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' }]),
      // 子 Agent 直接给结论，没有任何计划激活与平台调用
      worker: gatedWorker([{ text: '幻辰财税 202609 应收余额大概是 42 元。' }]),
    });
    const reply = await send('查一下幻辰财税的应收账款');
    expect(reply).toContain('没有产生任何平台查询');
    expect(reply).not.toContain('42 元');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('1.5 账套不存在时只走目录搜索，不用余额或凭证接口探测', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '只查账套目录，看看有没有胜利这个帐套' }]),
      worker: gatedWorker([
        { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }] },
        { text: '现有接口没有账套目录搜索能力返回"胜利"，我无法确认这个账套是否存在。' },
      ]),
    });
    const reply = await send('只查账套目录，看看有没有胜利这个帐套');

    // 平台确定性应答 not_found（ACCOUNT_SET_NOT_FOUND）由宿主持信封数据机械组装成
    // 用户消息（2026-09-27 Stage 3 根治包 + Wave 2 L2 退化）：点名查不到的对象 + 平台
    // correctForm 数据（"该怎么改"由平台拥有，宿主不镜像措辞；信封没带时才用宿主兜底）。
    // 旧实现让模型把信封翻译成技术报告（脚本路径/错误码/candidates: [] 全上屏），
    // 那句话本身还是错的（"没有目录搜索能力"）——行为全对、呈现全错，正是要根治的形状。
    expect(reply).toContain('没有找到匹配“胜利”的对象');
    expect(reply).toContain(platformCorrectForm('ACCOUNT_SET_NOT_FOUND'));
    expect(reply).toContain('我再查');
    // 平台账本里这个任务只登记了目录搜索，没有余额/凭证调用
    const tasks = Object.values(ledger().tasks ?? {});
    const last = tasks.at(-1) as { actual?: { calls?: number } } | undefined;
    expect(last?.actual?.calls ?? 0).toBe(1);
    await assembly.close();
  });
});