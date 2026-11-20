/**
 * 慢/故障/待补答三条用户级路径的**确定性冒烟**（2026-11-18；真 server + 假企微 SDK）。
 *
 * 为什么放在 `scripts/eval/smoke/` 而不是并进 wecom-sim：
 *   · wecom-sim 的 W-01～W-28 是**渠道行为回归门**（合并窗、附件时序、写确认、任务面），
 *     编号与判据已被多份预注册引用；把新场景塞进去会把「夹具新能力是否可用」和
 *     「渠道旧行为是否退化」混成同一组红绿，失败定位变差。
 *   · 这三条是**用户可见路径的冒烟**（受理回执/如实失败/补答续跑），只依赖 harness
 *     的装配链，不新增渠道断言；独立目录可单独跑，也可随全量跑（include 覆盖 scripts/**）。
 *
 * 装配（与 wecom-sim 同一份 `startWecomSim`，不复制装配）：真 createServer + 真 dummy
 * 子进程 + 假企微 SDK + 脚本化模型；断言面是用户可见气泡、宿主底账与夹具审计。
 *
 * 三条路径：
 *   ① 长时执行：`--delay-ms 1200` → 1ms 短等待窗口必然超窗 → 交办回合**照发模型说的话**
 *      （owner 2026-11-19：宿主不再静默/替换），任务后台推进，最终 completed 并由宿主主动
 *      投递一次结果；
 *   ② 执行很久后异常：`slow-fault-one`（slow_fault，2500ms 后 exit 2）→ 任务终态 failed、
 *      失败原因机械可读、不谎报成功、零「完成」主动投递；用户追问时如实说明；
 *   ③ needs_input → 补答 → 同一任务完成；以及不补答 → 停在 waiting_user、不重复执行。
 *
 * 反向绊线（人工验证，读数见提交报告）：
 *   · 删掉 runtime/timing.cjs 的 sleepSync 调用 → ①的耗时下界红；
 *   · 删掉 runtime/read.cjs 的 slow_fault sleep → ②的耗时下界红；
 *   · 清空 requires 的 missing 名单 → ③的 pendingQuestion/缺失字段红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import {
  describeOutcome,
  lastToolResultJsonOf,
  messagesTextOf,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
} from '../wecom-sim/harness';

/** 宿主任务 scope：单聊 conversationId 就是 userid（与 W-26 同口径）。 */
const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;

/**
 * 交办回合模型会自行编的受理卡片（owner 2026-11-19：这段原样投递，宿主不再静默）。
 * 顺带绊线：task_run 的受理事实**不得**再带回执话术（notice）——带了立即红。
 */
const dispatchCard = (call: { messages: readonly unknown[] }) => {
  const result = lastToolResultJsonOf(call.messages);
  if (result?.['accepted'] !== true) throw new Error('task_run 没有回受理事实（accepted:true）。');
  if (result !== undefined && 'notice' in result) throw new Error('受理事实不应再带受理回执话术（notice）。');
  return textAssistant('好的，这件事我交给后台去办，办好就发给你。');
};

function auditRowsOf(stateDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('冒烟·长时执行（--delay-ms）', () => {
  it('交办回合照发模型说的话；任务后台推进到 completed 并主动投递一次结果', async () => {
    const sim = await startWecomSim({ label: 'smoke-slow', taskDispatch: 'async', taskRunWaitMs: 1 });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const userText = '把 documents 集合上月的明细跑出来';
      const taskText = '把 documents 集合上月的明细跑出来';
      sim.book.mainTurn(userText, [toolCallAssistant('task_run', { task: taskText }), dispatchCard]);
      sim.book.workerTask(taskText, [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'documents', '--window': 'W202611', '--delay-ms': '1200' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 execute_operation 的真实返回。');
          return textAssistant(describeOutcome(outcome));
        },
      ]);

      const startedAt = Date.now();
      const messageId = sim.sendText(userText);
      // 交办回合照发模型的话（逐字）；宿主不再有静默/受理卡替换机制。
      await sim.waitFor('交办回合结束', () => sim.doneOf(messageId) !== undefined);
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.finalBubbles()[0]!.content).toBe('好的，这件事我交给后台去办，办好就发给你。');

      const done = sim.doneOf(messageId)!;
      expect(done.taskIds).toHaveLength(1);
      const taskId = done.taskIds[0]!;

      // 回合结束时任务确实还在跑（不是「等到完成才回一句已受理」的假异步）。
      expect(registry.get(taskId, TASK_SCOPE).status).not.toBe('completed');

      await sim.waitFor('任务后台 completed', () => registry.get(taskId, TASK_SCOPE).status === 'completed', 30_000);
      // 延迟真实生效：整条任务至少跨越夹具声明的 1200ms（下界，负载只会更长）。
      expect(Date.now() - startedAt, '任务总耗时').toBeGreaterThanOrEqual(1_000);

      // 完成后宿主主动投递一次结果（用户不必再问）。
      await sim.waitFor('完成结果主动投递一次', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('documents W202611 共 3 条');
      expect(sim.logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);
});

describe('冒烟·执行很久后异常（slow_fault）', () => {
  it('跑了 2.5s 才失败：任务终态 failed、不谎报成功、零完成投递；用户追问得到如实原因', async () => {
    const sim = await startWecomSim({ label: 'smoke-fault', taskDispatch: 'async', taskRunWaitMs: 1 });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const userText = '把 slow-fault-one 的数据取出来';
      const taskText = '把 slow-fault-one 的数据取出来';
      sim.book.mainTurn(userText, [toolCallAssistant('task_run', { task: taskText }), dispatchCard]);
      sim.book.workerTask(taskText, [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'slow-fault-one' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 execute_operation 的真实返回。');
          return textAssistant(describeOutcome(outcome));
        },
      ]);

      const startedAt = Date.now();
      const messageId = sim.sendText(userText);
      await sim.waitFor('交办回合结束', () => sim.doneOf(messageId) !== undefined);
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.finalBubbles()[0]!.content).toBe('好的，这件事我交给后台去办，办好就发给你。');

      const taskId = sim.doneOf(messageId)!.taskIds[0]!;
      await sim.waitFor('任务落 failed', () => registry.get(taskId, TASK_SCOPE).status === 'failed', 30_000);
      // 「执行了很久才失败」：耗时下界证明失败发生在 delayMs 之后（不是立即失败）。
      expect(Date.now() - startedAt, '失败总耗时').toBeGreaterThanOrEqual(2_000);

      const failed = registry.get(taskId, TASK_SCOPE);
      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toContain('没办成：dummy.query 返回 failed');
      expect(failed.failureReason).toContain('cannot be read after a long run');

      // 不谎报成功：**零完成投递**（没有「办完了」正文）；失败走失败投递分支主动说一句人话
      // （2026-11-19 收口：failureMessageFor 模板，不含执行层原文；事件名与完成投递共用
      // task_result_delivery_sent——以正文形状区分，完成正文绝不出现）。
      await sim.waitFor('失败主动投递恰一条', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('没办成');
      expect(sim.sdk.proactiveTexts[0]!.content).not.toContain('办完了');
      expect(sim.sdk.proactiveTexts[0]!.content).not.toContain('cannot be read after a long run');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(sim.sdk.proactiveTexts).toHaveLength(1); // 没有第二条（非快活场景恰一条失败话术）
      expect(failed.replyText ?? failed.resultText ?? '').toBe('');

      // 用户追问：task_result 的真实失败原因被如实转述（不是「已完成」）。
      sim.book.mainTurn('刚才那个查 slow-fault-one 的任务怎么样了？', [
        toolCallAssistant('task_result', { ref: taskId }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          const status = result?.['status'];
          // 底账投影收口（2026-11-20）：拼装的 failureReason 自由文本已移除，
          // 改给清洗过的业务摘要（summary）——业务原话保留，内部词/技术码被剥掉。
          const reason = typeof result?.['summary'] === 'string' ? result['summary'] : '';
          if (status !== 'failed') throw new Error(`任务状态不是 failed：${String(status)}`);
          if (reason === '') throw new Error('task_result 没有返回失败摘要。');
          return textAssistant(`那个任务跑了很久，最后还是没办成：${reason}`);
        },
      ]);
      sim.sendText('刚才那个查 slow-fault-one 的任务怎么样了？');
      await sim.waitFor('追问终帧', () => sim.finalBubbles().length === 2);

      const reply = sim.finalBubbles().at(-1)!.content;
      expect(reply).toContain('没办成');
      expect(reply).toContain('cannot be read after a long run');
      expect(reply).not.toContain('办完了');
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);
});

describe('冒烟·needs_input → 用户补答 → 同一任务完成', () => {
  it('缺参 → waiting_user 且问题可见；补答后同一 taskId 续跑完成、结果投递一次', async () => {
    const sim = await startWecomSim({ label: 'smoke-input', taskDispatch: 'async', taskRunWaitMs: 1 });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const userText = '查一下 receivables-open 的明细';
      const taskText = '查一下 receivables-open 的明细';
      sim.book.mainTurn(userText, [toolCallAssistant('task_run', { task: taskText }), dispatchCard]);
      sim.book.workerTask(taskText, [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'receivables-open' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 execute_operation 的真实返回。');
          return textAssistant(describeOutcome(outcome));
        },
        // 第 2 回合（用户补答后续跑）：补答必须到达 Worker，再带着窗口重试同一次调用。
        (call) => {
          const delegation = messagesTextOf(call.messages);
          if (!delegation.includes('2026-10')) throw new Error('（测试）用户补答没有到达 Worker。');
          return toolCallAssistant('execute_operation', {
            operation: 'dummy.query',
            args: { '--collection': 'receivables-open', '--window': '2026-10' },
          });
        },
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 execute_operation 的真实返回。');
          return textAssistant(describeOutcome(outcome));
        },
      ]);

      const messageId = sim.sendText(userText);
      await sim.waitFor('交办回合结束', () => sim.doneOf(messageId) !== undefined);
      expect(sim.finalBubbles()).toHaveLength(1);
      const taskId = sim.doneOf(messageId)!.taskIds[0]!;
      const taskNo = registry.get(taskId, TASK_SCOPE).taskNo;

      // 第一次缺参：任务停在 waiting_user，缺什么机械可读（结构化字段名 window）。
      await sim.waitFor('任务落 waiting_user', () => registry.get(taskId, TASK_SCOPE).status === 'waiting_user', 30_000);
      const waiting = registry.get(taskId, TASK_SCOPE);
      expect(waiting.pendingQuestion?.missing.join(' ')).toContain('window');
      expect(waiting.executions.map((execution) => execution.status)).toEqual(['needs_input']);

      // 用户问「怎么样了」：问题对用户可见（同一任务、同一编号）。
      sim.book.mainTurn('刚才那个任务怎么样了？', [
        toolCallAssistant('task_status', { ref: `#${taskNo ?? 1}` }),
        (call) => {
          const status = lastToolResultJsonOf(call.messages);
          const missing = (status?.['pendingQuestion'] as { missing?: readonly string[] } | undefined)?.missing ?? [];
          if (status?.['status'] !== 'waiting_user') throw new Error(`任务不是 waiting_user：${String(status?.['status'])}`);
          return textAssistant(`任务还在等你补充：${missing.join('、')}`);
        },
      ]);
      sim.sendText('刚才那个任务怎么样了？');
      await sim.waitFor('状态追问终帧', () => sim.finalBubbles().length === 2);
      expect(sim.finalBubbles().at(-1)!.content).toContain('window');

      // 用户补答 → Main 用同一个 #编号接续（不是新 task_run）。
      sim.book.mainTurn('用 2026-10 这个窗口', [
        toolCallAssistant('task_resume', { ref: `#${taskNo ?? 1}`, answer: '2026-10' }),
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          if (result?.['outcome'] !== 'started') throw new Error(`接续结果不是 started：${JSON.stringify(result)}`);
          return textAssistant('收到，继续办理。');
        },
      ]);
      sim.sendText('用 2026-10 这个窗口');
      await sim.waitFor('补答回合终帧', () => sim.finalBubbles().length === 3);

      await sim.waitFor('接续后 completed', () => registry.get(taskId, TASK_SCOPE).status === 'completed', 30_000);
      const completed = registry.get(taskId, TASK_SCOPE);
      // 同一任务（编号不变），不是新建任务。
      expect(completed.taskId).toBe(taskId);
      expect(completed.taskNo).toBe(taskNo);
      expect(registry.list(TASK_SCOPE).map((row) => row.taskId)).toEqual([taskId]);
      // 两次执行事实：原执行 needs_input + 补答后 completed。
      expect(completed.executions.map((execution) => execution.status)).toEqual(['needs_input', 'completed']);

      // 完成后结果主动投递一次（补答真的变成了数据）。
      await sim.waitFor('完成结果投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('receivables-open 2026-10 共 3 条');
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);

  it('不补答：停在 waiting_user，不重复执行（夹具审计行数不变）', async () => {
    const sim = await startWecomSim({ label: 'smoke-input-idle', taskDispatch: 'async', taskRunWaitMs: 1 });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const userText = '查一下 receivables-open 的明细';
      const taskText = '查一下 receivables-open 的明细';
      sim.book.mainTurn(userText, [toolCallAssistant('task_run', { task: taskText }), dispatchCard]);
      sim.book.workerTask(taskText, [
        toolCallAssistant('execute_operation', {
          operation: 'dummy.query',
          args: { '--collection': 'receivables-open' },
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 脚本没有拿到 execute_operation 的真实返回。');
          return textAssistant(describeOutcome(outcome));
        },
      ]);

      const messageId = sim.sendText(userText);
      await sim.waitFor('交办回合结束', () => sim.doneOf(messageId) !== undefined);
      expect(sim.finalBubbles()).toHaveLength(1);
      const taskId = sim.doneOf(messageId)!.taskIds[0]!;
      await sim.waitFor('任务落 waiting_user', () => registry.get(taskId, TASK_SCOPE).status === 'waiting_user', 30_000);

      const rowsBefore = auditRowsOf(sim.execStateDir).length;
      const executionsBefore = registry.get(taskId, TASK_SCOPE).executions.length;

      // 再发一条消息（状态追问）：不得让等待中的任务重新执行。
      sim.book.mainTurn('还没好吗？', [
        toolCallAssistant('task_status', { ref: taskId }),
        (call) => {
          const status = lastToolResultJsonOf(call.messages);
          return textAssistant(`任务状态：${String(status?.['status'])}；还在等你补充。`);
        },
      ]);
      sim.sendText('还没好吗？');
      await sim.waitFor('追问终帧', () => sim.finalBubbles().length === 2);

      const after = registry.get(taskId, TASK_SCOPE);
      expect(after.status).toBe('waiting_user');
      expect(after.pendingQuestion?.missing.join(' ')).toContain('window');
      expect(after.executions).toHaveLength(executionsBefore);
      expect(auditRowsOf(sim.execStateDir)).toHaveLength(rowsBefore);
      expect(sim.sdk.proactiveTexts).toHaveLength(0);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);
});
