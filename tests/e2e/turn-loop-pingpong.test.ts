/**
 * 离线全链 e2e：多任务乒乓路由与探索线程延续（覆盖增强）。共享替身见 ./harness.ts。
 *
 * 与已有两份"并发/交织"用例的分工：
 *   - turn-loop-interleaved.test.ts：两个委派任务交替一次，回到旧任务即收尾；
 *   - turn-loop-concurrent.test.ts：单条计划线的跨回合中断/恢复。
 * 这里补真实会话里更耗人的两种形状：
 *   ① 乒乓路由：三个以上委派任务跨多回合来回切换（A→B→C→A→B→C）。宿主按申报的
 *      continueTaskId 把执行续回指名的旧子任务——不被最近的新任务卡住，worker 拿到
 *      的转录也只带那个任务的历史；编号拿错时按边界处理：越权（别人的任务）拒绝执行，
 *      本轮零调用、不外发任何数字；不存在的编号（模型幻觉）在会话恰一个开放任务时被
 *      兜底接回那个任务续跑，零个开放任务才报错——两种都不会把会话卡死（原样再问即可）。
 *   ② 探索线程延续：目标不明的请求先澄清；用户只答一半（有账套没期间）时线程不断——
 *      模型再澄清一轮（仍是零平台调用），补齐后才委派；澄清线程被别的话题打断后回来，
 *      线程开头仍在最近轮次窗口里、落地的是新子任务而不是续跑旧任务（问句原文被窗口
 *      挤出后仍在 Conversation Log，可经宿主提供的历史工具召回——characterization）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ServerAssembly } from '../../apps/server/assembly';
import { balanceCalls, boot, gatedWorker, ledger, mainDriver, totalActualCalls, type WorkerStep } from './harness';

/** 企微单聊：conversationId 回落为 userid（channel-wecom adapter），principal 由 userid 解析。 */
const PRINCIPAL_ID = 'wecom:e2e_user';
const SESSION_ID = 'wecom:e2e_user:e2e_user';

/**
 * Context State 的落库是回合内 fire-and-forget（runtime.ts 的 enqueueContextStateUpdate）：
 * 断言"下一轮模型还看得见线程"之前先等状态真写进库，不赌时序。
 */
async function awaitContextState(assembly: ServerAssembly, expected: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = await assembly.store.contextStates.get(PRINCIPAL_ID, SESSION_ID);
    if (record && JSON.stringify(record.state).includes(expected)) return;
    if (Date.now() >= deadline) throw new Error(`等待 Context State 落库超时（未出现：${expected}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 侦测 C2 兜底留痕（写法同 turn-loop-disambiguation 的 capturePlanLog）。 */
function captureTaskFallbackLog() {
  const events: Array<{ event: string; requestId?: string; requestedTaskId?: string; boundTaskId?: string }> = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as { event?: string };
      if (parsed?.event === 'task_id_fallback_bound') events.push(parsed as never);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
}

/** 记录 worker 每次实际收到的委派请求、taskId 与完整转录（路由对不对要看转录串不串台）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  const taskIds: string[] = [];
  const transcripts: string[] = [];
  return {
    requests,
    taskIds,
    transcripts,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        taskIds.push(String(input.sessionId ?? ''));
        transcripts.push(JSON.stringify(input.messages));
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

describe('离线全链 e2e：多任务乒乓路由与探索线程延续', () => {
  it('8.1 三个任务来回乒乓：每回合按 continueTaskId 续回指名的旧任务，worker 转录不串台', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 任务 A（第 1 回合）：幻辰财税 202606 应收
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // 任务 B（第 2 回合）：新兴五金 202609 已保存凭证
      { plan: [{ operation: 'voucher.query-saved', args: ['新兴五金', '202609'] }] },
      { text: '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。' },
      { end: true },
      // 任务 C（第 3 回合）：新兴建材当前期间应收
      { plan: [{ operation: 'finance.query-receivables', args: ['--query', '新兴建材'] }] },
      { text: '新兴建材当前期间应收账款余额为 700 元。' },
      { end: true },
      // A 续跑（第 4 回合）：同一子任务换期间——是重新执行，不是重放旧答复
      { plan: balanceCalls('幻辰财税', '202609') },
      { text: '幻辰财税 202609 应收账款余额为 0 元。' },
      { end: true },
      // B 续跑（第 5 回合）
      { plan: [{ operation: 'voucher.query-saved', args: ['新兴五金', '202606'] }] },
      { text: '新兴五金 202606 也没有已保存的凭证（平台返回 0 条）。' },
      { end: true },
      // C 续跑（第 6 回合）
      { plan: balanceCalls('新兴建材', '202606') },
      { text: '新兴建材 202606 应收账款余额为 0 元。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
      { kind: 'delegate', request: '查询新兴五金账套 202609 已保存的凭证' },
      { kind: 'delegate', request: '查询新兴建材账套当前期间的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });

    await send('查一下幻辰财税 202606 的应收账款余额');
    await send('再查一下新兴五金 202609 保存的凭证');
    await send('还有新兴建材当前的应收账款');
    // 三个互不相干的新子任务
    expect(new Set(worker.taskIds).size).toBe(3);

    // 用户回到 A：申报显式带上 A 的编号——最近的任务是 C，宿主不能按"最近"猜
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202609 的应收账款余额', continueTaskId: worker.taskIds[0] });
    const backToA = await send('幻辰财税按 202609 再查一次应收');
    declarations.push({ kind: 'delegate', request: '查询新兴五金账套 202606 已保存的凭证', continueTaskId: worker.taskIds[1] });
    const backToB = await send('新兴五金的凭证按 202606 再查');
    declarations.push({ kind: 'delegate', request: '查询新兴建材账套 202606 的应收账款余额', continueTaskId: worker.taskIds[2] });
    const backToC = await send('新兴建材按 202606 查应收');

    // 六次委派的 taskId 序列是 A B C A B C：每次回来都续回指名的那个旧任务
    expect(worker.taskIds).toHaveLength(6);
    expect(worker.taskIds[3]).toBe(worker.taskIds[0]);
    expect(worker.taskIds[4]).toBe(worker.taskIds[1]);
    expect(worker.taskIds[5]).toBe(worker.taskIds[2]);

    // 每次委派的请求只含本轮任务的实体，不掺入别的任务
    expect(worker.requests[3]).toContain('幻辰财税');
    expect(worker.requests[3]).not.toContain('新兴五金');
    expect(worker.requests[3]).not.toContain('新兴建材');
    expect(worker.requests[4]).toContain('新兴五金');
    expect(worker.requests[4]).not.toContain('幻辰财税');
    expect(worker.requests[4]).not.toContain('新兴建材');
    expect(worker.requests[5]).toContain('新兴建材');
    expect(worker.requests[5]).not.toContain('幻辰财税');
    expect(worker.requests[5]).not.toContain('新兴五金');

    // 路由正确的另一半证据在转录里：续跑 A 时 worker 只带着 A 的历史（旧请求 +
    // 旧答复），看不到 B/C 的任何内容——续跑不是把几个任务混成一锅
    expect(worker.transcripts[3]).toContain('查询幻辰财税账套 202606 的应收账款余额');
    expect(worker.transcripts[3]).toContain('61000 元');
    expect(worker.transcripts[3]).not.toContain('新兴五金');
    expect(worker.transcripts[3]).not.toContain('新兴建材');
    expect(worker.transcripts[4]).toContain('新兴五金');
    expect(worker.transcripts[4]).not.toContain('幻辰财税');
    expect(worker.transcripts[4]).not.toContain('新兴建材');
    expect(worker.transcripts[5]).toContain('新兴建材');
    expect(worker.transcripts[5]).not.toContain('幻辰财税');
    expect(worker.transcripts[5]).not.toContain('新兴五金');

    // 回到旧任务是重新执行：A 的 202609 答复是 0 元，不是把 61000 重放一遍；
    // C 的 202606 是 0 元，也不是重放当前期间的 700
    expect(backToA).toContain('0 元');
    expect(backToA).toContain('202609');
    expect(backToA).not.toContain('61000');
    expect(backToB).toContain('0 条');
    expect(backToC).toContain('0 元');
    expect(backToC).not.toContain('700');

    // 平台账本按子任务累计：每个任务各跑 2 次，六回合共 6 次调用
    expect(totalActualCalls()).toBe(before + 6);
    const tasks = ledger().tasks ?? {};
    expect(tasks[worker.taskIds[0]]?.actual?.calls).toBe(2);
    expect(tasks[worker.taskIds[1]]?.actual?.calls).toBe(2);
    expect(tasks[worker.taskIds[2]]?.actual?.calls).toBe(2);
    // 全是单次调用的轻量委派：乒乓切换不该凭空触发计划通知
    expect(sdk.noticeTexts()).toHaveLength(0);
    await assembly.close();
  });

  it('8.2 续跑编号拿错：越权与多候选仍被拒，唯一开放任务被兜底接回，会话不被卡死', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
      { end: true },
      // C2 兜底把失效编号接回唯一的开放任务：同一个子任务重新执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额仍是 61000 元（兜底续跑重新查的）。' },
      { end: true },
      // 兜底之后用户原样再问：全新子任务照常执行
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额仍是 61000 元（这次是重新查的）。' },
    ]);
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({ main: mainDriver(declarations), worker: worker.driver });
    // 第二个企微用户同样开通权限：他的会话里出现第一个用户的 taskId（模型侧串台或
    // 泄漏）时，宿主必须按 principal+session 归属拒绝，而不是把执行送进别人的子任务
    await assembly.store.principalScopes.upsert({ wecomUserId: 'e2e_user2', accountSetIds: [], accountSetScope: 'all', enabled: true });
    // 第三个用户什么任务都没开过：用来验证"零个开放任务"时兜底不放行
    await assembly.store.principalScopes.upsert({ wecomUserId: 'e2e_user3', accountSetIds: [], accountSetScope: 'all', enabled: true });

    await send('查一下幻辰财税 202606 的应收账款余额');
    expect(worker.taskIds).toHaveLength(1);
    const afterFirst = totalActualCalls();
    expect(afterFirst).toBe(before + 1);

    // 越权续跑：拿着 A 的编号在别人的会话里申报 delegate
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额', continueTaskId: worker.taskIds[0] });
    const crossUser = await send('查一下幻辰财税 202606 的应收账款余额', { userid: 'e2e_user2' });
    expect(crossUser).toContain('无权继续');
    expect(crossUser).not.toContain('61000');
    // 零执行：worker 未被再叫、账本没有新增、没有计划通知
    expect(worker.taskIds).toHaveLength(1);
    expect(totalActualCalls()).toBe(afterFirst);
    expect(sdk.noticeTexts()).toHaveLength(0);

    // C2 兜底（2026-09-26 真实平台战斗测试实测）：模型幻觉出一个不存在的编号填进
    // continueTaskId。这个会话恰好只有一个开放任务 → 宿主绑定它从断点续跑，流程不断。
    const fallback = captureTaskFallbackLog();
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额', continueTaskId: 'task_ghost_404' });
    const ghost = await send('查一下幻辰财税 202606 的应收账款余额');
    try {
      // 续的是原来那个子任务（不是新开任务），查询真的又跑了一次
      expect(ghost).toContain('61000 元');
      expect(worker.taskIds).toHaveLength(2);
      expect(worker.taskIds[1]).toBe(worker.taskIds[0]);
      expect(totalActualCalls()).toBe(afterFirst + 1);
      // 留痕：requestId + 原（幻觉）编号 + 绑定到的编号
      expect(fallback.events).toHaveLength(1);
      expect(fallback.events[0]).toMatchObject({
        event: 'task_id_fallback_bound',
        requestedTaskId: 'task_ghost_404',
        boundTaskId: worker.taskIds[0],
      });
      expect(fallback.events[0]?.requestId).toMatch(/^req_/);
    } finally {
      fallback.restore();
    }

    // 零个开放任务：失效编号依旧被拒，绝不悄悄按新任务放行——
    // 那会让"续跑"悄无声息地换了子任务（兜底只在"恰一个"时生效）
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额', continueTaskId: 'task_ghost_404' });
    const noOpenTask = await send('查一下幻辰财税 202606 的应收账款余额', { userid: 'e2e_user3' });
    expect(noOpenTask).toContain('未找到可继续');
    expect(noOpenTask).not.toContain('61000');
    expect(totalActualCalls()).toBe(afterFirst + 1);

    // 会话不被卡死：用户原样再问，宿主按新任务正常执行
    declarations.push({ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' });
    const retried = await send('查一下幻辰财税 202606 的应收账款余额');
    expect(retried).toContain('61000 元');
    // 三次委派：第一次、兜底续跑（同一子任务）、重问（新子任务）
    expect(worker.taskIds).toHaveLength(3);
    expect(worker.taskIds[2]).not.toBe(worker.taskIds[0]);
    expect(totalActualCalls()).toBe(afterFirst + 2);
    await assembly.close();
  });

  it('8.3 探索线程跨两轮澄清：用户只答一半时再澄清（仍零调用），补齐后才委派', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
    ]);
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'conversation', text: '要查哪个账套、哪个期间的应收欠款？告诉我账套和期间，我就去查。' },
      // 用户只答了账套：线程不断，模型接着问期间——仍然不强行委派
      { kind: 'conversation', text: '账套幻辰财税收到了。期间呢？要查哪个月份（YYYYMM）的应收？' },
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: worker.driver,
    });

    // 第一轮澄清：问句即本轮回复——零平台调用、零通知、worker 未被叫
    const asked = await send('看下我们这个月的应收情况');
    expect(asked).toContain('账套');
    expect(asked).not.toContain('没有产生任何平台查询');
    expect(worker.requests).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    expect(sdk.noticeTexts()).toHaveLength(0);
    // 澄清问句登记进 Context State 的未决问题：线程"开到哪了"有据可查
    await awaitContextState(assembly, '要查哪个账套、哪个期间的应收欠款');

    // 用户只答一半（有账套没期间）：第二轮澄清照旧零执行
    const askedAgain = await send('幻辰财税');
    expect(askedAgain).toContain('期间');
    expect(askedAgain).not.toContain('没有产生任何平台查询');
    expect(worker.requests).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    expect(sdk.noticeTexts()).toHaveLength(0);
    // 第二轮看得见第一轮的问句与用户的半截答复：线程在宿主侧延续，没有断
    expect(observed[1]).toContain('看下我们这个月的应收情况');
    expect(observed[1]).toContain('unresolvedQuestions');
    expect(observed[1]).toContain('要查哪个账套、哪个期间的应收欠款');
    await awaitContextState(assembly, '要查哪个月份（YYYYMM）的应收？');

    // 补齐期间：这才委派，一次真实执行
    const done = await send('202606');
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toContain('幻辰财税');
    expect(worker.requests[0]).toContain('202606');
    expect(done).toContain('61000 元');
    expect(done).not.toContain('不应外发');
    expect(totalActualCalls()).toBe(before + 1);
    // 第三轮申报前，模型上下文里同时有：新一轮的未决问题（期间）、用户两轮答复的原文
    // （账套 + 期间）——线程的三段都在，补齐后的请求才可能同时带上账套与期间
    expect(observed[2]).toContain('unresolvedQuestions');
    expect(observed[2]).toContain('要查哪个月份（YYYYMM）的应收？');
    expect(observed[2]).toContain('期间呢');
    expect(observed[2]).toContain('幻辰财税');
    expect(observed[2]).toContain('202606');
    await assembly.close();
  });

  it('8.4 探索线程被别的话题打断后回来：线程开头仍在窗口，落地的是新子任务', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 打断轮的真实执行：与探索线程无关的凭证查询
      { plan: [{ operation: 'voucher.query-saved', args: ['新兴五金', '202609'] }] },
      { text: '新兴五金 202609 没有已保存的凭证（平台返回 0 条）。' },
      { end: true },
      // 探索线程补齐后的真实执行：幻辰财税 202606 应收
      { plan: balanceCalls('幻辰财税', '202606') },
      { text: '幻辰财税 202606 应收账款余额为 61000 元。' },
    ]);
    const observed: Array<{ messages: string; tools: string[] }> = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'conversation', text: '要查哪个账套、哪个期间的应收欠款？告诉我账套和期间，我就去查。' },
      { kind: 'delegate', request: '查询新兴五金账套 202609 已保存的凭证' },
      { kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' },
    ];
    const { send, sdk, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push({
        messages: JSON.stringify(input.messages),
        tools: ((input as { tools?: Array<{ name?: string }> }).tools ?? []).map((tool) => String(tool.name)),
      })),
      worker: worker.driver,
    });

    // 澄清轮：零执行
    const asked = await send('看下我们这个月的应收情况');
    expect(asked).toContain('账套');
    expect(worker.requests).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    expect(sdk.noticeTexts()).toHaveLength(0);
    await awaitContextState(assembly, '要查哪个账套、哪个期间的应收欠款');

    // 用户中途换话题：一次与探索线程无关的委派，另起子任务
    const interrupted = await send('先别管应收，查一下新兴五金 202609 保存的凭证');
    expect(interrupted).toContain('0 条');
    expect(worker.taskIds).toHaveLength(1);
    // characterization：归约器把"用户开了新话题"当作上一个澄清已回答——未决问题被清空，
    // 问句原文不在第 3 轮的最近窗口里；线程没有丢，它仍在 Conversation Log，模型可经
    // 宿主提供的历史检索工具找回（断的是窗口，不是线程）。
    await awaitContextState(assembly, '先别管应收，查一下新兴五金 202609 保存的凭证');
    const state = await assembly.store.contextStates.get(PRINCIPAL_ID, SESSION_ID);
    expect((state?.state as { unresolvedQuestions?: unknown[] } | undefined)?.unresolvedQuestions ?? []).toHaveLength(0);

    // 用户回到探索线程：最近轮次窗口仍留着线程的开头（第 1 轮用户消息原文）
    const back = await send('就查幻辰财税 202606 的应收');
    expect(observed[2].messages).toContain('看下我们这个月的应收情况');
    expect(observed[2].messages).not.toContain('要查哪个账套、哪个期间的应收欠款');
    // 宿主同时给出历史检索工具：被窗口挤掉的澄清问句仍可召回
    expect(observed[2].tools).toContain('search_history');
    expect(observed[2].tools).toContain('get_messages');
    // 探索落地是新子任务：不续跑刚才那个凭证任务，也不把凭证对象带进请求
    expect(worker.taskIds).toHaveLength(2);
    expect(worker.taskIds[1]).not.toBe(worker.taskIds[0]);
    expect(worker.requests[1]).toContain('幻辰财税');
    expect(worker.requests[1]).toContain('202606');
    expect(worker.requests[1]).not.toContain('新兴五金');
    expect(back).toContain('61000 元');
    expect(back).not.toContain('不应外发');
    expect(totalActualCalls()).toBe(before + 2);
    await assembly.close();
  });
});
