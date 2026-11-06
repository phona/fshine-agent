// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：Subagent 报错回路（roadmap Phase 5，架构 §3 纠错环）。共享替身见 ./harness.ts。
 *
 * 覆盖两条链：
 *   ① worker 回报"缺什么" → ② Main Agent 转达用户 → ③ 用户补充 → ④ 申报 delegate +
 *      continueTaskId + 补齐的 request → ⑤ worker 执行，最终回复含真实结果；
 *   以及 Main Agent 自己从 Log 证据补齐后直接重派（不问用户）的分支。
 */
import { describe, expect, it } from 'vitest';
import { balanceCalls, boot, gatedWorker, mainDriver, totalActualCalls, withoutPlatformEnvelope, type WorkerStep } from './harness';

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

  it('5.2 Main Agent 自己从 Log 证据补齐后直接重派，不问用户', async () => {
    const worker = recordingWorker([
      // 首轮查 202609（无余额键）：错误态快路径 v2 后，单调用计划撞 PERIOD_NO_DATA 即以
      // 宿主终局话术收束本跳——用户首轮看到的不再是贴出来的"51 元"；底账里留下的 calls
      // 快照（含 202609）正是后面指代轮 Log 证据的来源（对齐后断言不变）。
      { plan: balanceCalls('幻辰财税', '202609') },
      // 指代轮：宿主注入了 Log 证据，worker 仍然执行不了
      { need: NEEDS_PERIOD },
      // 重派段查 202606（有余额键）：终稿断言钉"数据答案 + 不含'期间'字样"——若查
      // 无数据期间，终稿是宿主话术（可改查清单含"平台当前期间"），这条断言即失效。
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收余额为 52 元。' },
    ]);
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额' },
      { kind: 'conversation', text: '不客气。' },
      { kind: 'conversation', text: '好的。' },
    ];
    const { send, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: worker.driver,
    });

    await send('查一下幻辰财税 202609 的应收账款');
    await send('谢谢');
    await send('好的');
    // 两轮对话之后，上一轮查询已被挤出最近轮次窗口：实体与期间只存在于 Conversation Log
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套的应收账款余额', continueTaskId: worker.taskIds[0]! });
    // 期间因果对齐（2026-10-16 评审）：重派申报的期间与用户补的期间、脚本查的期间、
    // 答案同期（202606）——此前申报写 202609、答案却是 202606 的 52 元，三处不同期。
    // 首轮的 202609（无数据）原样保留：它是 Log 证据与"宿主主动回溯"断言的来源。
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额', continueTaskId: worker.taskIds[0]! });

    const done = await send('那个账套 202606 那期呢');

    // 宿主注入了 Log 证据（含期间），Main Agent 自己补齐后重派——用户没有被问任何问题
    expect(observed[3]).toContain('宿主主动回溯');
    expect(observed[3]).toContain('202609');
    expect(worker.requests[2]).toContain('202606');
    expect(worker.taskIds[2]).toBe(worker.taskIds[0]);
    expect(withoutPlatformEnvelope(done)).toContain('52 元');
    // 同剥信封：平台 correctForm「该期间平台无数据，请确认期间编码…」自带"期间"二字，
    // 不是宿主在问用户要期间（harness 已知保真度边界，见 withoutPlatformEnvelope）。
    expect(withoutPlatformEnvelope(done)).not.toContain('期间');
    expect(totalActualCalls()).toBeGreaterThan(0);
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
