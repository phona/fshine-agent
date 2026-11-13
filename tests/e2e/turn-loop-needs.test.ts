// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：Subagent 报错回路（roadmap Phase 5，架构 §3 纠错环）。共享替身见 ./harness.ts。
 *
 * 覆盖一条链：① worker 回报"缺什么" → ② Main Agent 转达用户 → ③ 用户补充 →
 * ④ 申报 delegate + continueTaskId + 补齐的 request → ⑤ worker 执行，最终回复含真实结果。
 *
 * 原第二条链（Main 自己从宿主注入的 Log 证据补齐后直接重派）依赖的宿主主动回溯/台账
 * 注入机制已随 15f50d7 裁删，该用例（原 5.2）随之删除；「隔轮后按 continueTaskId 续跑
 * 原任务」的回归改由 turn-loop-direct-lifecycle.test.ts 的 L5 承接（dummy 域，不引用
 * 已删机制标记）。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, gatedWorker, mainDriver, totalActualCalls, type WorkerStep } from './harness';

/** 记录 worker 实际收到的委派请求与 taskId（宿主透传 intent.request，不做二次加工）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  const taskIds: string[] = [];
  return {
    requests,
    taskIds,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        taskIds.push(String(input.sessionId ?? ''));
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

/** 期间缺失：worker 执行不了，如实回报缺什么 / 为什么 / 建议用户提供什么。 */
const NEEDS_PERIOD = {
  missing: ['期间'],
  reason: '平台要求查询必须显式给出期间，不接受缺省',
  suggestion: '请告诉我要查的具体期间',
};

describe('[L4 集成] 离线全链 e2e：Subagent 报错回路', () => {
  it('5.1 缺期间 → 转达用户 → 用户补上 → 带 continueTaskId 续跑原任务', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // ① 执行不了：回报结构化线索，不产生任何平台调用
      { need: NEEDS_PERIOD },
      // ⑤ 用户补充后续跑原任务：真实执行。查 202606（mock 有余额键）——错误态快路径
      // v2 后，单调用计划查无数据期间会以宿主终局话术终结，不再是"贴成功文本"的形状；
      // 本用例的意图是纠错环机制，续跑段必须给出数据答案。
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收余额为 51 元。' },
    ]);
    // ② 与 ④ 的申报脚本：第二条在用户补充后才 push 进来（taskId 此时才已知）
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' },
      { kind: 'conversation', text: '要查哪个期间的应收账款？告诉我期间我就接着查。' },
    ];
    const { send, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    // ①②：宿主不 terminate 整轮，Main Agent 把"缺什么"转达给用户
    const asked = await send('查一下幻辰财税的应收账款');
    expect(asked).toContain('期间');
    expect(asked).not.toContain('没有产生任何平台查询');
    expect(asked).not.toContain('本轮执行面');
    expect(totalActualCalls()).toBe(before);

    // ③④：用户补充后，Main Agent 申报 delegate + continueTaskId + 补齐后的完整 request
    // 期间因果对齐（2026-10-16 评审）：用户补哪个期间，申报/执行/答案就是哪个期间——
    // 此前用户说"9月"、申报写 202609，脚本却查 202606 答 51 元，三处不同期。
    declarations.push({
      kind: 'delegate',
      request: '查询幻辰财税账套 202606 的应收账款余额',
      continueTaskId: worker.taskIds[0],
    });
    const done = await send('202606 那期');

    // ⑤：续跑的是同一个子任务，最终回复含真实执行结果
    expect(done).toContain('51 元');
    expect(done).not.toContain('不应外发');
    expect(worker.taskIds).toHaveLength(2);
    expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
    expect(worker.requests[1]).toContain('202606');
    expect(totalActualCalls()).toBeGreaterThan(before);
    await assembly.close();
  });

  it('5.3 纠错回路里拿数字结论充数仍被出口校验挡住（回路不是执行凭证）', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'delegate', request: '查询幻辰财税账套的应收账款余额' },
        // 回路进行中，Main Agent 却直接抛出一个没有执行凭证的数字结论
        { kind: 'conversation', text: '幻辰财税 202609 应收余额大概是 42 元。' },
      ]),
      worker: gatedWorker([{ need: NEEDS_PERIOD }]),
    });
    const reply = await send('查一下幻辰财税的应收账款');

    expect(reply).not.toContain('42 元');
    expect(reply).toContain('没有产生任何平台查询');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });
});
