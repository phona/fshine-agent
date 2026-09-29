/**
 * 离线全链 e2e：写关闭 disclosure（D-075 第 1 层机械兜底）。共享替身见 ./harness.ts。
 *
 * 真实平台 T7 事故形态：用户发起录入请求，worker 走了完整的"录入准备"流程（核实范围/
 * 日期/平衡，行为优秀），然后停在准备阶段、承诺"即可产出录入提案"，永不抵达提案步——
 * 全程未告知用户写权限是关闭的。根因：WRITE_NOT_ENABLED 原先只挂在提案路径的 capability
 * 检查与平台计划门拒绝上，模型不走到那儿，用户就永远不知道。
 *
 * 这里的机械版：宿主在计划成形后（calls 已机械解析出 operation 名）扫描 access 类别，
 * 计划含写类 operation 而部署未开放 write → 宿主当场合成写关闭话术终结该轮。断言三件事：
 *   ① 终稿是宿主合成的 WRITE_NOT_ENABLED（error-codes.ts 唯一来源，一字不差）；
 *   ② worker 的"准备/索要信息/承诺"文本没有成为终稿（T7 形态的机械版）；
 *   ③ 零平台调用：宿主拦在计划评估之前，平台计划门从未被咨询（账本无计划条目）。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, ledger, mainDriver, totalActualCalls } from './harness';

describe('离线全链 e2e：写关闭 disclosure（D-075）', () => {
  it('写关闭部署：含写类 operation 的计划在评估前被宿主拦下，终稿是写关闭话术', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'delegate', request: '帮我录入一笔办公费凭证' }]),
      worker: gatedWorker([
        { text: '我先核实一下范围、日期与借贷平衡。' },
        { plan: [{ operation: 'voucher.prepare', args: ['幻辰财税', '202609'] }] },
        { text: '已准备好录入提案，即可产出。' },
      ], { enforceWriteClosure: true }),
    });
    // 生产保真：principal 的能力声明显式为只读（与 config/agent.yaml 的 capabilities: ["read"] 同形态）
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('帮我录入一笔办公费凭证');

    // ① 终稿 = 宿主合成的 WRITE_NOT_ENABLED（error-codes.ts 唯一来源）
    expect(reply).toBe('当前未开放写入权限，如有需要请联系管理员开通。');
    // ② T7 形态的机械版：worker 的"准备/承诺"文本没有成为终稿
    expect(reply).not.toContain('即可产出');
    expect(reply).not.toContain('我先核实');
    // ③ 零平台调用：evaluate 从未发生（账本里没有任何计划条目），mock 执行面零触达
    expect(Object.keys(ledger().plans ?? {})).toEqual([]);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });
});
