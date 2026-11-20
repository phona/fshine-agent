/**
 * J 组·后台任务并存（J-1～J-3）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 补的缺口：仓内 52 条后台任务用例已覆盖单任务受理/落定、短等待窗口、队列上限、
 * 文件回程、等待补充接续、长任务 accepted/wait/abort、写确认底账、跨主体隔离、重启恢复；
 * **没覆盖**同一主体并行多个后台任务时的用户可见行为。本组钉的用户感受：
 *
 *   J-1  同一次会话里交办了两件事，两件都该办、各回各的结果，谁先办完谁先说，
 *        不会把 A 的结果安到 B 头上（用户：交办多件时不用自己记编号对账）。
 *   J-2  在群里交办的事，办好后结果发回**这个群**（不是私聊）；等的过程里不刷存在感；
 *        别的会话（私聊）收不到这份结果（用户：在群里办事，结果别跑到私聊去）。
 *   J-3  后台任务在跑时用户说一句别的事，那句马上有答复、不被任务完成消息打断或污染
 *        （各自独立成条、顺序可见）；随后问「刚才那个办完了吗」能拿到底账事实、
 *        不发起新执行（用户：后台跑着的时候聊天不卡，想知道结果随时能问）。
 *
 * 装配差异：任务派发 `taskDispatch: 'async'`（server 恒 async）+ `runtime.taskRunWaitMs`
 * 短等待窗口 1500ms（与 W-28 同一确定性口径：快查询落在窗口内同回合给结果、慢任务
 * 超窗进后台）。三条都用 `allowWriteOperations: true`（dummy.longtask 是 write 面）。
 *
 * 记录一个**真实产品行为**（不是缺陷，是 design）：任务受理回合的模型文本原样投递
 * （owner 2026-11-19：宿主不再按回合类型静默/替换）。因此本组一律按「交办回合可能有
 * 一条模型文本」写断言：内容扫描、不数固定下标/零长度，避免慢机器上窗口边界抖动。
 *
 * 机械判据（用户可见结果 + 底账事实；模型响应脚本化、执行层真实）：
 *   · 完成消息的身份区分来自**真实执行面**：快任务是 dummy.query 的真实返回
 *     （beta W1 共 3 条、500/300/200——集合名与数字都是执行层给的），慢任务是
 *     dummy.longtask 的 wait 终态 + Worker 汇报（凭证 42 张）。断言只对集合名/数字/
 *     业务词这类机械事实，不做语义词表判定。
 *   · J-1 ② 的「各自带自己的任务身份（交办原文片段）」依赖另一条在飞的轨
 *     （feat/failure-text 的身份注入）：本 HEAD 上 `TaskCompletionFact` 只带
 *     resultText、投递面逐字转述，**尚未在宿主侧拼交办原文**（0 commits ahead 的是
 *     失败话术封闭表，不是完成消息身份）。因此本文件把「互不串」写成硬断言（当前
 *     宿主能保证的：同会话两条任务各自的结果正文不交叉、投递对象不串），把「完成消息
 *     逐条携带交办原文片段」登记为 it.todo，待身份轨合流后收紧，不为了变绿发明断言。
 */
import { describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { LONG_RUNNING_NOTICE_FALLBACK_TEXT } from '../../../packages/agent/src/task-runner';
import {
  internalOperationCall,
  lastToolResultJsonOf,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  workerQueryResponses,
  type SimResponse,
} from './harness';

/** 宿主任务 scope：单聊 conversationId 就是 userid（适配器口径），会话键 = 用户键。 */
const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;
/** 群任务 scope：群会话 = `wecom:group-w`，主体 = `wecom:group:group-w`（同群共享）。 */
const GROUP_SCOPE = { principalId: 'wecom:group:group-w', sessionId: 'wecom:group-w' } as const;

/** 收集某会话的所有气泡文本（按内容找，不数下标）。 */
function bubbleTexts(fixture: ReturnType<typeof startWecomSim> extends Promise<infer T> ? T : never): string[] {
  return fixture.finalBubbles().map((bubble) => bubble.content);
}

/** 收集某会话的主动投递文本（sendMessage 通道：完成追投 / 主动提醒）。 */
function proactiveTexts(fixture: ReturnType<typeof startWecomSim> extends Promise<infer T> ? T : never): string[] {
  return fixture.sdk.proactiveTexts.map((entry) => entry.content);
}

/** 慢任务：真实发起 dummy.longtask，accepted 后由 runner 的 wait 端口推进，完成后续跑汇报。 */
function longTaskWorkerResponses(seconds: number, doneText: string): readonly SimResponse[] {
  return [
    // 夹具注入 --seconds 走内部 exec 路由（op_* 工具面只收业务字段）。
    internalOperationCall('dummy.longtask', { '--seconds': seconds }),
    textAssistant('已发起长任务，等它跑完。'),
    textAssistant(doneText),
  ];
}

/** 慢任务交办的 Main 脚本：task_run → 只交办（无 summary 的受理回执）。 */
function slowTaskMainTurn(task: string): readonly SimResponse[] {
  return [
    toolCallAssistant('task_run', { task }),
    (call) => {
      const result = lastToolResultJsonOf(call.messages);
      if (result?.['accepted'] !== true) throw new Error('task_run 没有回受理事实（accepted:true）。');
      return textAssistant('好的，这件事我交给后台去办，办好就发给你。');
    },
  ];
}

/** Main 快查询脚本：task_run 窗口内完成 → 同回合转述真实 summary（零追投）。 */
function fastQueryMainTurn(task: string): readonly SimResponse[] {
  return [
    toolCallAssistant('task_run', { task }),
    (call) => {
      const result = lastToolResultJsonOf(call.messages);
      const summary = typeof result?.['summary'] === 'string' ? result['summary'] : '';
      if (summary === '') throw new Error('快查询没有同回合返回 summary（短等待窗口被破坏？）。');
      return textAssistant(summary);
    },
  ];
}

describe('J 组·后台任务并存（J-1～J-3）', () => {
  it('J-1 同会话两个后台任务并存：快的先交付、慢的单独追投；完成消息互不串；任务数=2、执行事实各 1 条', async () => {
    // 钉的用户感受：一次会话交办两件事，各办各的、谁先办完谁先说，不会把 A 的结果
    // 安到 B 头上（不用用户自己记编号对账）。
    const sim: Awaited<ReturnType<typeof startWecomSim>> = await startWecomSim({
      label: 'j1',
      taskDispatch: 'async',
      taskRunWaitMs: 1_500,
      allowWriteOperations: true,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      // 慢任务：dummy.longtask --seconds 3（超 1.5s 窗口 → 进后台，完成后追投）。
      const slowTaskText = '跑一个三秒的导出';
      sim.book.mainTurn('帮我把上个月的凭证导出来，做完发我', slowTaskMainTurn(slowTaskText));
      sim.book.workerTask(slowTaskText, longTaskWorkerResponses(3, '导出完成：上个月全部凭证共 42 张。'));
      // 快任务：真实 dummy.query beta（窗口内完成 → 同回合给结果，零追投）。
      const fastTaskText = '查一下 beta 集合 W1 的记录';
      sim.book.mainTurn('顺便查一下 beta 集合 W1 的数据，尽快', fastQueryMainTurn(fastTaskText));
      sim.book.workerTask(fastTaskText, workerQueryResponses('dummy.query', { '--collection': 'beta', '--window': 'W1' }));

      // ── ① 连发两条交办 → 两条都受理 ──────────────────────────────────────
      const slowId = sim.sendText('帮我把上个月的凭证导出来，做完发我');
      await sim.waitFor('J-1 慢任务交办回合落定', () => sim.doneOf(slowId) !== undefined, 10_000);
      const slowTaskId = sim.doneOf(slowId)!.taskIds[0]!;
      // 慢任务已后台推进（running、租约已释放——长任务让出槽位/租约）。
      await sim.waitFor('J-1 慢任务 accepted（running 无租约）', () => {
        const task = registry.get(slowTaskId, TASK_SCOPE);
        return task.status === 'running' && task.leaseUntil === undefined;
      }, 10_000);

      const fastId = sim.sendText('顺便查一下 beta 集合 W1 的数据，尽快');
      // 快的那条**先**交付（窗口内同回合气泡，真实 beta 数字）。
      await sim.waitFor('J-1 快任务结果气泡', () =>
        bubbleTexts(sim).some((text) => text.includes('beta W1 共 3 条')), 15_000);
      const fastBubble = bubbleTexts(sim).find((text) => text.includes('beta W1 共 3 条'))!;
      expect(fastBubble).toContain('500、300、200');
      expect(fastBubble).not.toContain('1200、800'); // alpha 的数字（W1=1200/800）
      // ② 互不串（正向半边）：快任务的结果里不出现慢任务的业务词/数字。
      expect(fastBubble).not.toContain('凭证');
      expect(fastBubble).not.toContain('42');
      const fastTaskId = sim.doneOf(fastId)!.taskIds[0]!;
      // 两个任务都受理了（底账 taskIds 各一）。
      expect(slowTaskId).not.toBe(fastTaskId);

      // ── 慢的完成后**再**单独投递一条（不是两条挤在一个气泡里）────────────
      await sim.waitFor('J-1 慢任务追投完成消息', () => proactiveTexts(sim).length === 1, 30_000);
      const slowDelivery = proactiveTexts(sim)[0]!;
      expect(slowDelivery).toContain('凭证');
      expect(slowDelivery).toContain('42');
      // ② 互不串（反向半边）：慢任务的结果里不出现快任务的对象名/数字。
      expect(slowDelivery).not.toContain('beta');
      expect(slowDelivery).not.toContain('500');
      // 追投只有一条：快任务已同回合交付，不得再重复发一遍。
      expect(proactiveTexts(sim)).toHaveLength(1);

      // ③ 底账事实：任务数 == 2、每任务执行事实各 1 条（长任务 accepted 一笔 + 查询 completed 一笔）。
      await sim.waitFor('J-1 两条任务都 completed', () => {
        const tasks = registry.list(TASK_SCOPE);
        return tasks.length === 2 && tasks.every((task) => task.status === 'completed');
      }, 20_000);
      const tasks = registry.list(TASK_SCOPE);
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => task.executions.map((execution) => execution.operation).sort()))
        .toEqual(expect.arrayContaining([['dummy.longtask'], ['dummy.query']]));
      for (const task of tasks) {
        expect(task.executions).toHaveLength(1);
      }
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);

  it.todo('J-1b 完成投递逐条携带各自交办原文片段（等身份轨合流后收紧）——'
    + '本 HEAD 上 TaskCompletionFact/deliverTaskResult 只逐字转述 resultText，宿主侧尚未在'
    + '完成消息里拼「交办原文片段」；等 feat/failure-text 的身份注入合流后，把 J-1 ② 收紧为'
    + '慢任务追投消息逐字包含「上个月的凭证导出」、快任务同回合回复逐字包含「查 beta 集合」。');

  it('J-2 群聊后台任务：结果投递到群会话（非私聊）、期间零主动提醒、另一条私聊会话收不到', async () => {
    // 钉的用户感受：在群里交办的事，办好后结果发回**这个群**（不是私聊）；等的过程里
    // 不被「比预计久了」刷屏；另一条私聊会话收不到这份结果（跨会话不串）。
    const sim: Awaited<ReturnType<typeof startWecomSim>> = await startWecomSim({
      label: 'j2',
      taskDispatch: 'async',
      taskRunWaitMs: 1_500,
      allowWriteOperations: true,
      groupRole: 'operator',
      // 首档提醒阈值压到 200ms：群任务的久无动静提醒（2026-11-19 #9 起群里也发）会在任务
      // 跑着的时候到达——本轮恰落在交办回合的忙窗口内（busy 交回当前回合，见 ②），
      // 这是真实绊线，不只是长任务顺带。
      longRunningNoticeMs: 200,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      // 先让一条私聊会话活起来（user-a 私聊，快查询）——断言的对照侧必须真实存在，
      // 不是「那条会话没开通过所以没收到」冒充。
      const privateTaskText = '查一下 alpha 集合 W1 的记录';
      sim.book.mainTurn('帮我查一下 alpha 集合 W1 的数据', fastQueryMainTurn(privateTaskText));
      sim.book.workerTask(privateTaskText, workerQueryResponses('dummy.query', { '--collection': 'alpha', '--window': 'W1' }));
      sim.sendText('帮我查一下 alpha 集合 W1 的数据');
      await sim.waitFor('J-2 私聊查询有回复', () =>
        bubbleTexts(sim).some((text) => text.includes('alpha W1 共 2 条')), 15_000);
      expect(bubbleTexts(sim).find((text) => text.includes('alpha W1 共 2 条'))!).toContain('1200、800');

      // 群聊交办长任务（`--seconds 3`，超窗 → 后台；完成后宿主主动投递到群会话）。
      const groupTaskText = '群里跑一个三秒的导出';
      sim.book.mainTurn('群里跑一个三秒的导出，做完发群里', slowTaskMainTurn(groupTaskText));
      sim.book.workerTask(groupTaskText, longTaskWorkerResponses(3, '群里导出完成：上个月凭证共 42 张。'));
      const groupId = sim.sendText('群里跑一个三秒的导出，做完发群里', { chatType: 'group' });
      await sim.waitFor('J-2 群交办回合落定', () => sim.doneOf(groupId) !== undefined, 10_000);
      const groupTaskId = sim.doneOf(groupId)!.taskIds[0]!;

      // ① 完成后结果**投递到群会话**（sendMessage 通道 chatId = group-w），不是私聊。
      await sim.waitFor('J-2 群任务完成追投到群', () =>
        sim.sdk.proactiveTexts.some((entry) => entry.content.includes('凭证')), 30_000);
      const completion = sim.sdk.proactiveTexts.filter((entry) => entry.content.includes('凭证'));
      expect(completion).toHaveLength(1);
      expect(completion[0]!.chatId).toBe('group-w');
      // 任务在群里真实跑完了（不是「没开通所以安静」冒充）。
      await sim.waitFor('J-2 群任务 completed', () => registry.get(groupTaskId, GROUP_SCOPE).status === 'completed', 15_000);

      // ② 群聊的久无动静提醒**指向这个群**（owner 2026-11-19 #9 迁移；旧口径「群聊零提醒」已
      // 作废）：本轮的提醒恰好落在交办回合还在跑的窗口内 → 唤醒出口按 busy 把事实交回当前
      // 回合（既不另发一条、也绝不串到私聊）；送达时同样只发群、且不带业务名（隐私口径）。
      const noticeWake = sim.logs.filter((line) => line['event'] === 'task_long_running_wake'
        && line['taskId'] === groupTaskId);
      expect(noticeWake).toHaveLength(1);
      expect(noticeWake[0]).toMatchObject({ principalId: 'wecom:group:group-w', sessionId: 'wecom:group-w' });
      expect(noticeWake[0]!['outcome']).toMatch(/^(woken|busy)$/);
      for (const notice of sim.sdk.proactiveTexts.filter((entry) => entry.content.includes('比预计久'))) {
        expect(notice.chatId).toBe('group-w');
        expect(notice.content).not.toContain(groupTaskText);
      }
      expect(proactiveTexts(sim).filter((text) => text === LONG_RUNNING_NOTICE_FALLBACK_TEXT)).toHaveLength(0);
      // ③ 另一条私聊会话收不到这份结果：全部主动消息只发给 group-w，从不发给 user-a。
      expect(sim.sdk.proactiveTexts.every((entry) => entry.chatId === 'group-w')).toBe(true);
      expect(sim.sdk.proactiveTexts.filter((entry) => entry.chatId === 'user-a')).toHaveLength(0);
      // 私聊的气泡也只回私聊自己的内容，不含群任务的业务词。
      expect(bubbleTexts(sim).filter((text) => text.includes('alpha W1 共 2 条'))[0]!).not.toContain('凭证');
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);

  it('J-3 完成后投递与用户新回合交错：无关查询立即答复、完成消息独立一条不塞进同一气泡、追问拿底账不新执行', async () => {
    // 钉的用户感受：后台任务在跑时，用户说一句别的事——那句马上有答复，任务完成消息
    // 是**独立的一条**（不会被塞进那一句的同一气泡里，顺序可见）；随后问「刚才那个
    // 办完了吗」能拿到底账事实（task_status），**不发起新执行**。
    const sim: Awaited<ReturnType<typeof startWecomSim>> = await startWecomSim({
      label: 'j3',
      taskDispatch: 'async',
      taskRunWaitMs: 1_500,
      allowWriteOperations: true,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      // 慢任务先交办（--seconds 3 超窗 → 后台，交办回合可能带受理卡片气泡——见文件头注）。
      const slowTaskText = '跑一个三秒的导出';
      sim.book.mainTurn('帮我把上个月的凭证导出来，做完发我', slowTaskMainTurn(slowTaskText));
      sim.book.workerTask(slowTaskText, longTaskWorkerResponses(3, '导出完成：上个月全部凭证共 42 张。'));
      const slowId = sim.sendText('帮我把上个月的凭证导出来，做完发我');
      await sim.waitFor('J-3 慢任务交办回合落定', () => sim.doneOf(slowId) !== undefined, 10_000);
      const slowTaskId = sim.doneOf(slowId)!.taskIds[0]!;
      await sim.waitFor('J-3 慢任务 running 无租约（真在后台飞）', () => {
        const task = registry.get(slowTaskId, TASK_SCOPE);
        return task.status === 'running' && task.leaseUntil === undefined;
      }, 10_000);

      // ① 任务在跑时，用户发一句无关查询 → **立即**得到答复（窗口内快活，同回合气泡）。
      const queryTaskText = '查一下 alpha 集合 W1 的记录';
      sim.book.mainTurn('顺便问一句：alpha 集合 W1 现在有多少条？', fastQueryMainTurn(queryTaskText));
      sim.book.workerTask(queryTaskText, workerQueryResponses('dummy.query', { '--collection': 'alpha', '--window': 'W1' }));
      sim.sendText('顺便问一句：alpha 集合 W1 现在有多少条？');
      await sim.waitFor('J-3 无关查询立即答复', () =>
        bubbleTexts(sim).some((text) => text.includes('alpha W1 共 2 条')), 15_000);
      const queryBubble = bubbleTexts(sim).find((text) => text.includes('alpha W1 共 2 条'))!;
      expect(queryBubble).toContain('1200、800');
      // ② 完成消息不被塞进那一句的同一气泡：此刻慢任务还没完成，这一气泡里没有慢任务的
      //    业务词；完成后追投的是**独立一条 sendMessage**，不进气泡。
      expect(queryBubble).not.toContain('凭证');
      expect(queryBubble).not.toContain('42');
      await sim.waitFor('J-3 慢任务完成追投', () => proactiveTexts(sim).length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.chatId).toBe('user-a');
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('凭证');
      // 完成消息是主动投递（sendMessage 通道），不是气泡：所有气泡合起来仍不含凭证/42。
      expect(bubbleTexts(sim).join('\n')).not.toContain('凭证');
      expect(bubbleTexts(sim).join('\n')).not.toContain('42');

      // ③ 用户下一句「刚才那个办完了吗」→ 拿底账事实（task_status），不发起新执行。
      sim.book.mainTurn('刚才那个办完了吗？', [
        toolCallAssistant('task_status', {}),
        (call) => {
          const listed = lastToolResultJsonOf(call.messages) as {
            tasks?: ReadonlyArray<{ name?: string; status?: string }>;
          } | undefined;
          const task = listed?.tasks?.find((entry) => (entry.name ?? '').includes('导出'));
          if (task?.status === undefined) throw new Error('J-3 task_status 没有返回导出任务的底账事实。');
          return textAssistant(task.status === 'completed' ? '刚才那个导出已经完成了。' : `刚才那个导出的状态是 ${task.status}。`);
        },
      ]);
      const askId = sim.sendText('刚才那个办完了吗？');
      await sim.waitFor('J-3 追问终帧', () =>
        bubbleTexts(sim).some((text) => text.includes('导出已经完成')), 15_000);
      // 纯查询：零新执行、零新任务。
      const askDone = sim.doneOf(askId)!;
      expect(askDone.executions).toHaveLength(0);
      expect(askDone.taskIds).toHaveLength(0);
      // 底账事实来自 task_status 的真实返回（不是模型编的）。
      await sim.waitFor('J-3 慢任务最终 completed', () => registry.get(slowTaskId, TASK_SCOPE).status === 'completed', 15_000);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);
});