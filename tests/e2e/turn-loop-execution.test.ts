/**
 * 离线全链 e2e：执行凭证与查询范围。共享替身见 ./harness.ts。
 *
 * 覆盖：重复提问必须重查、子 Agent 零执行不外发财务结论、
 * 账套不存在时只走目录搜索。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, CURRENT_PERIOD, gatedWorker, ledger, mainDriver, totalActualCalls } from './harness';

describe('离线全链 e2e：执行凭证与查询范围', () => {
  it('1.3/5.4 重复提问实时数据必须产生本轮平台执行，不能重放旧答复', async () => {
    const worker = () => gatedWorker([
      { plan: balanceCalls('幻辰财税', CURRENT_PERIOD) },
      { text: '幻辰财税 202609 应收余额为 51 元。' },
    ]);
    const main = () => mainDriver([
      { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
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
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] }]),
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
      main: mainDriver([{ kind: 'platform_query', taskType: 'account_search', searchQuery: '胜利' }]),
      worker: gatedWorker([
        { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }] },
        { text: '现有接口没有账套目录搜索能力返回"胜利"，我无法确认这个账套是否存在。' },
      ]),
    });
    const reply = await send('只查账套目录，看看有没有胜利这个帐套');

    expect(reply).toContain('无法确认');
    // 平台账本里这个任务只登记了目录搜索，没有余额/凭证调用
    const tasks = Object.values(ledger().tasks ?? {});
    const last = tasks.at(-1) as { actual?: { calls?: number } } | undefined;
    expect(last?.actual?.calls ?? 0).toBe(1);
    await assembly.close();
  });
});
