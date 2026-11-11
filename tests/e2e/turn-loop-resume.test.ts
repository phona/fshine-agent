// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：计划恢复路径（resumeTaskId）的两个缺口。共享替身见 ./harness.ts。
 *
 * 这条路径绕过 route_current_turn：用户确认码 → 宿主激活计划 → worker 重跑 → 整理模型
 * 转述。正常 delegate 路径的出口校验它一条都没继承，两个缺口都在这里补：
 *   F5 整理模型停嘴时回落 worker 文本，不过滤执行面注脚 → 内部注脚上屏并进 durable log；
 *   F8 确认后重跑仍是零平台调用时无任何检测 → 整理模型把零执行总结成"整理完成"。
 *
 * 链路的保真度：真 SQLite、真 assembly、真计划门与确认码流程、真 ContextTaskRunner；
 * 假的只有两处——脚本化 Main Agent，以及执行面注脚的合成（注脚真实由 pi-coding-driver
 * 按放行的网关调用数生成，gatedWorker 替身不产 footprint，所以这里按同形状补上）。
 */
import { describe, expect, it } from 'vitest';
import { boot, GATEWAY, gatedWorker, heavyPlan, mainDriver, totalActualCalls, type WorkerStep } from './harness';
import { RESUMED_PLAN_NOT_EXECUTED } from '../../packages/agent/src/runtime';

/**
 * 给 gatedWorker 的执行面包上执行面注脚（真实 worker 的 footprint 由 pi-coding-driver
 * 合成、context.ts 拼在文本尾部）。测试要盯的正是"宿主拿到带注脚的 resumed.text 之后
 * 怎么处理"，所以注脚必须出现在这条链上。
 */
function receiptWorker(script: WorkerStep[], receipt = `3 次 ${GATEWAY} 调用`) {
  const inner = gatedWorker(script);
  return {
    driver: {
      run: async (input: { sessionId?: string; messages: unknown[] }) => {
        const out = (await inner.run(input as never)) as { text: string } & Record<string, unknown>;
        return { ...out, text: `${out.text}\n\n〔本轮执行面：${receipt}〕` };
      },
    },
  };
}

/**
 * Main Agent 替身：委派回合用 harness 的标准脚本；恢复回合（tools 为空）返回给定文本
 * ——`''` 用来复现"整理模型停嘴"，一句总结用来复现"把零执行说成已完成"。
 */
function resumeMainDriver(request: string, organizeText: string) {
  const inner = mainDriver([{ kind: 'delegate', request }]);
  return {
    run: async (input: { tools: unknown[]; messages: unknown[] }) => (
      input.tools.length === 0
        ? { text: organizeText, messages: input.messages }
        : inner.run(input as never)
    ),
  };
}

/**
 * ③-1 替身：第一次委派（计划停在确认门）照常走真实计划门；第二次 run 是确认后的
 * 重跑——抛出带 auth 错误码的错误（平台登录态失效）。真实链路上 context.ts 的
 * catch 按码分类成 auth，抛出 ToolUserError（DELEGATION_AUTH_FAILURE）。
 */
function authFailingOnResume(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  let runs = 0;
  return {
    driver: {
      run: async (input: { sessionId?: string; messages: unknown[] }) => {
        runs += 1;
        if (runs >= 2) throw Object.assign(new Error('平台登录态已失效'), { code: 'AUTH_EXPIRED' });
        return inner.run(input as never);
      },
    },
  };
}

describe('[L4 集成] 离线全链 e2e：计划恢复路径（注脚剥离 + 执行痕迹判据）', () => {
  it('F5 整理模型停嘴：回落 worker 文本，执行面注脚不上屏', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: resumeMainDriver('查一下幻辰财税账套 1 至 9 月的应收账款', ''),
      // 21 次调用越过 confirm 门槛 → 停在用户确认门；确认后按 active 计划真跑完
      worker: receiptWorker([
        { plan: heavyPlan(), stopAtConfirm: true },
        { execute: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] }] },
        { text: '已按你确认的范围查完 1 至 9 月。' },
        { end: true },
      ]).driver,
    });

    await send('查一下幻辰财税账套 1 至 9 月的应收账款');
    // 确认后宿主走 resumeTaskId 续跑：整理模型什么都没说 → 回落 worker 文本
    const confirmed = await send('确认继续');

    // 回落的就是 worker 原文（不是整理模型的总结），且注脚被剥干净
    expect(confirmed).toContain('已按你确认的范围查完 1 至 9 月。');
    expect(confirmed).not.toContain('本轮执行面');
    expect(GATEWAY, '泄漏断言的尺子是配置派生的网关名').not.toBe('');
    expect(confirmed).not.toContain(GATEWAY);
    // 确认后真的执行了（回落的是有执行痕迹的那一轮）
    expect(totalActualCalls()).toBe(before + 1);    await assembly.close();
  });

  it('F8 确认后重跑零执行：整理模型的"整理完成"不上屏，用户收到诚实状态', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      // 整理模型最典型的误判形状：把"批准了但没执行"总结成"整理完成"
      main: resumeMainDriver('查一下幻辰财税账套 1 至 9 月的应收账款', '已按你确认的范围整理完成。'),
      worker: gatedWorker([
        { plan: heavyPlan(), stopAtConfirm: true },
        // 确认后 worker 收手：没有计划提交、没有调用、没有 needs
        { text: '计划已批准，但平台侧连接被拒，本轮没有发起查询。' },
        { end: true },
      ]),
    });

    await send('查一下幻辰财税账套 1 至 9 月的应收账款');
    const confirmed = await send('确认继续');

    expect(confirmed).not.toContain('整理完成');
    expect(confirmed).not.toContain('已完成');
    // ③-5b：resume 零执行（无 activatedPlan）的专用话术——不再问"要查询的对象和范围"
    expect(confirmed).toBe(`${RESUMED_PLAN_NOT_EXECUTED}\n\n计划已批准，但平台侧连接被拒，本轮没有发起查询。`);
    expect(confirmed).not.toContain('请告诉我要查询的对象和范围');
    // worker 留下的无数字说明按"子 Agent 说明 + 注脚"模式附上
    expect(confirmed).toContain('平台侧连接被拒');
    // 确认后一次平台调用都没发生：诚实状态不是客气话
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('F8 补：worker 只留下带数字的说明时不附注，只给诚实状态', async () => {
    const { send, assembly } = await boot({
      main: resumeMainDriver('查一下幻辰财税账套 1 至 9 月的应收账款', '已按你确认的范围整理完成。'),
      worker: gatedWorker([
        { plan: heavyPlan(), stopAtConfirm: true },
        { text: '大概是 42 元。' },
        { end: true },
      ]),
    });

    await send('查一下幻辰财税账套 1 至 9 月的应收账款');
    const confirmed = await send('确认继续');

    expect(confirmed).not.toContain('42 元');
    expect(confirmed).not.toContain('整理完成');
    expect(confirmed).toBe(RESUMED_PLAN_NOT_EXECUTED);
    expect(confirmed).not.toContain('请告诉我要查询的对象和范围');
    await assembly.close();
  });

  it('③-1 确认后重跑遇登录态过期：用户收到"需要重新登录"，不是"处理失败"', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: resumeMainDriver('查一下幻辰财税账套 1 至 9 月的应收账款', '已按你确认的范围整理完成。'),
      worker: authFailingOnResume([
        { plan: heavyPlan(), stopAtConfirm: true },
        // 确认后的重跑根本走不到这一步：worker 驱动先抛了 auth 类错误
        { execute: [{ operation: 'finance.query-receivables', args: ['--query', '幻辰财税', '--period', '202601'] }] },
        { end: true },
      ]).driver,
    });

    await send('查一下幻辰财税账套 1 至 9 月的应收账款');
    const confirmed = await send('确认继续');

    // 修复前：ToolUserError 穿透到 handler 顶层 catch，被换成"处理失败，请稍后再试"
    // ——对 auth 类是错指令（重试多少次都没用）。现在精确直达。
    expect(confirmed).toBe('平台登录态过期，需要重新登录后才能继续查询。');
    expect(confirmed).not.toContain('处理失败');
    expect(confirmed).not.toContain('稍后');
    // 重跑没有发生：确认后一次平台调用都没多
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });
});
