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
 *
 * 多步计划形态（D-075 残留修复）：写关闭只是拆解中的一步时，那一步的结果原本会走
 * 计划模式交还链（renderPlanStepToolResult → Main Agent 转述），用户拿到的是转述版
 * 而非宿主原句——机械保证只在单步成立。现在写关闭步骤在交还链之前就以宿主原句终结
 * 该轮：原句整体在前不被转述稀释，前序步骤的真实发生由宿主步骤事实汇总兜底。
 */
import { describe, expect, it } from 'vitest';
import { LAST_TASK_ID_TOKEN, boot, gatedWorker, ledger, mainDriver, totalActualCalls } from './harness';

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
      // ⑧：写关闭判据读平台侧声明（isCommitEnabled 派生）。mock 之下该声明恒真（写链路
      // 全放开），本用例经 assembly 覆盖显式钉"真平台未置 FSHINE_REAL_COMMIT"的部署——
      // mock 不可达的那一态，执法接线仍要可验（派生规则在 proposal-flow 单测钉住）。
      writeEnabled: false,
    });
    // 生产保真：principal 的能力声明显式为只读（遗留数据位，写关闭执法已不读它——⑧）
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

  it('多步计划：第 2 步写关闭由宿主原句终结，转述不稀释、前序步骤事实兜底', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '第1/2步：查幻辰财税账套当前期间的应收余额' },
        { kind: 'delegate', request: '第2/2步：为幻辰财税账套录入一笔办公费凭证', continueTaskId: LAST_TASK_ID_TOKEN },
        // 写关闭没被宿主终结时的转达形态：宿主必须让它不上屏（变异验证的探针）。
        { kind: 'conversation', text: '转述版：范围已核实，录入步骤暂时受阻，稍后继续处理。' },
      ]),
      worker: gatedWorker([
        // 第 1 步：读类计划真实执行（mock 当前期间应收余额 86000，seed 真实数据）
        { plan: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税'] }] },
        { text: '幻辰财税当前期间应收账款余额为 86000 元。' },
        { end: true },
        // 第 2 步：写类计划（voucher.prepare，access=write-flag）——宿主在 evaluate 前
        // 拦下（与真实驱动 beforeToolCall 同一把机械尺：calls × access 表 × 平台写开放声明）
        { plan: [{ operation: 'voucher.prepare', args: ['幻辰财税', '202609'] }] },
        { text: '已准备好录入提案，即可产出。' },
      ], { enforceWriteClosure: true }),
      // ⑧：同上——经 assembly 覆盖显式钉"平台声明写未开放"的部署形态。
      writeEnabled: false,
    });
    // 生产保真：principal 的能力声明显式为只读（遗留数据位，写关闭执法已不读它——⑧）
    await assembly.store.principalScopes.upsert({
      wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true, capabilities: ['read'],
    });

    const reply = await send('先查幻辰财税当前期间的应收余额，然后录入一笔办公费凭证');

    // ① 终稿含宿主原句（error-codes.ts 唯一来源），且原句优先——Main Agent 的转述版不上屏
    expect(reply).toContain('当前未开放写入权限，如有需要请联系管理员开通。');
    expect(reply.startsWith('当前未开放写入权限')).toBe(true);
    expect(reply).not.toContain('转述版');
    // ② worker 的"准备/承诺"文本不稀释原句（T7 形态的机械版）
    expect(reply).not.toContain('即可产出');
    // ③ 前序步骤的真实发生由宿主步骤事实兜底：第 1 步真执行过（只陈述步号与结局，
    // 不含业务数据因此也不含财务数字——出口校验的零执行数字拦截不会误伤它）；
    // 写关闭一步自身按机械事实记零执行，一并列出
    expect(reply).toContain('第 1/2 步');
    expect(reply).toContain('第 2/2 步');
    // ④ 零 write 调用：第 2 步的 evaluate 从未发生，平台只见过第 1 步那一次读调用
    expect(totalActualCalls()).toBe(before + 1);
    await assembly.close();
  });
});
