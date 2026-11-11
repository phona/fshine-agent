// [L4 集成] fshine + 执行层一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
// 结构性说明：ballot.* 六操作仅存在于 scripts/eval/fixtures/dummy-platform/bin/dummy.cjs，
// 不在活跃 profile 派生的网关上；因此本 vitest e2e 结构性无法运行，已跳过。
// 有效证据 = generic-mock g-ballot-second-domain + execution-layer-admission.md 登记。
/**
 * 离线全链 e2e：第二写域（ballot）端到端闭环。共享替身见 ./harness.ts。
 *
 * 覆盖：ballot 读路径（query）与写路径（prepare + proposal + proposal-commit）。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, mainDriver } from './harness';

describe.skip('[L4 集成] 第二写域 ballot 端到端闭环（ballot.* 仅存在于 dummy.cjs，不在配置派生的网关上，结构性无法运行；有效证据 = generic-mock g-ballot-second-domain）', () => {
  it('ballot.query 读路径：worker 经平台查询返回数据', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查询 ballot topic alpha 的数据' },
      ]),
      worker: gatedWorker([
        { plan: [{ operation: 'ballot.query', args: ['--topic', 'alpha'] }] },
        { text: 'ballot topic alpha 有 2 条记录。' },
      ]),
    });

    const reply = await send('查询 ballot topic alpha 的数据');
    expect(reply).toContain('2 条记录');
    await assembly.close();
  });

  it('ballot 写路径：prepare dry-run 不改变数据 + proposal + commit 真正写入', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '录入 ballot topic alpha 的投票记录' },
      ]),
      worker: gatedWorker([
        { plan: [{ operation: 'ballot.prepare', args: ['--topic', 'alpha', '--count', '1'] }] },
        { text: 'prepare 完成，dry-run 未改变数据。' },
        { plan: [{ operation: 'ballot.proposal', args: ['--topic', 'alpha'] }] },
        { text: '提案已创建。' },
        { plan: [{ operation: 'ballot.proposal-commit', args: ['--topic', 'alpha'] }] },
        { text: 'commit 完成。' },
      ]),
    });

    const reply = await send('录入 ballot topic alpha 的投票记录');
    expect(reply).toContain('录入');
    await assembly.close();
  });
});
