/**
 * I 组·体验交互（I-1～I-6、I-8；I-7 未立编号）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 这组把「交互契约」（docs/product/interaction-contract.md 五条：①不打扰 ②有预期
 * ③可查可接管 ④结论有据 ⑤分工透明）里**能机械钉住**的部分变成确定性断言；
 * 观感/措辞/真网络时序仍归 eval:user 与企微 live 人工面（见文末登记）。
 *
 * 装配：真渠道适配（WecomBotChannel/live）+ 真 server（createServer）+ 仓内 dummy CLI
 * 真子进程 + 脚本化模型；每条同时断言**用户可见面**（终帧气泡 / 主动投递文本）与
 * **结构化事件**（message_done / attachment_nudge_sent / 底账）；用户看到的话永远是模型说的
 * （宿主不再按回合类型静默/替换）。
 *
 * 长任务的两种时钟口径（都不写固定 sleep 充当判据）：
 *   · `dummy.query --delay-ms`：读操作真实墙钟延迟（起一眼「短活/慢活」边界）；
 *   · `dummy.longtask --seconds`：契约 v4 长任务，受理即 accepted 并让出租约/槽位，
 *     由出站 wait 轮询收尾（W-42 同源）——这是「长任务不占会话、期间还能插话」的真实模型。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from '../../../packages/agent/testing/task-facts';
import { LONG_RUNNING_NOTICE_FALLBACK_TEXT } from '../../../packages/agent/src/task-runner';
import {
  classifyFailure,
  failureMessageFor,
  internalTermIn,
} from '../../../packages/agent/src/user-facing-failure';
import {
  internalOperationCall,
  lastToolResultJsonOf,
  mainRelayResponses,
  NUDGE_AFTER_MS,
  salesSampleXlsxAsync,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  workerQueryResponses,
  type SimResponse,
} from './harness';

/** 宿主任务 scope：单聊 conversationId = userid（适配器口径），故会话键 = 用户键。 */
const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;
/** 群 = 独立主体（owner 2026-11-18）：principal = `wecom:group:<群id>`。 */
const GROUP_SCOPE = { principalId: 'wecom:group:group-w', sessionId: 'wecom:group-w' } as const;

/**
 * 交办回合模型会自行编的受理卡片（owner 2026-11-19：这段原样投递，宿主不再静默）。
 * 顺带绊线：task_run 的受理事实**不得**再带回执话术（notice）——带了立即红。
 */
function acceptCard(call: { messages: readonly unknown[] }): AgentMessage {
  const result = lastToolResultJsonOf(call.messages);
  if (result?.['accepted'] !== true) throw new Error('task_run 没有回受理事实（accepted:true）。');
  if (result !== undefined && 'notice' in result) throw new Error('受理事实不应再带受理回执话术（notice）。');
  return textAssistant('好的，这件事我交给后台去办，办好就发给你。');
}

/**
 * 长任务 Worker 脚本（dummy.longtask，契约 v4）：首回合发起真实 longtask（执行层立即
 * accepted → 让出租约/槽位、回合结束），续跑回合（宿主 wait 完成后唤醒）汇报结果。
 * resultText 由真实终态派生，用来验证「完成投递带的是这个任务自己的结果」。
 */
function longTaskWorker(resultText: string, seconds: number): readonly SimResponse[] {
  return [
    // 夹具注入 --seconds 走内部 exec 路由（op_* 工具面只收业务字段）。
    internalOperationCall('dummy.longtask', { '--seconds': String(seconds) }),
    textAssistant('已发起长任务，我盯着，好了发你。'),
    textAssistant(resultText),
  ];
}

/** 文本里是否出现某个**独立**整数（按数字边界匹配；避免「1200」被「200」误命中）。 */
function hasWholeNumber(text: string, value: string): boolean {
  return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(text);
}

describe('I 组·体验交互（I-1～I-6、I-8，自动；I-7 未立编号）', () => {
  it('I-1 一条气泡：短活同回合给结果，零受理回执（钉：①不打扰 / ②有预期）', async () => {
    // async 装配 + 缺省窗口（8000ms）：快查询在窗口内落定 → 同回合把结果交给用户。
    const sim = await startWecomSim({ label: 'i1', taskDispatch: 'async' });
    try {
      const taskText = '查一下 documents 集合 W202611 有多少条';
      sim.book.mainTurn(taskText, mainRelayResponses(taskText));
      sim.book.workerTask(taskText, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      const messageId = sim.sendText(taskText);
      await sim.waitFor('I-1 终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // 一条终帧，内容就是真实结果（不是受理占位）。
      expect(reply).toContain('documents W202611 共 3 条');
      expect(reply).toContain('1200');
      // 无受理回执文案、无「正在处理…」这类空话。
      for (const phrase of ['这个我来办', '办完发你', '正在处理', '已收到']) {
        expect(reply).not.toContain(phrase);
      }
      // 快活：结果已在同回合交付 → 零主动投递。
      expect(sim.sdk.proactiveTexts).toHaveLength(0);
      expect(sim.doneOf(messageId)!.taskIds).toHaveLength(1);
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('I-2 插话不打断：长任务进行中发第二句，各自得到答复且不串台（钉：③可查可接管 / ①不打扰）', async () => {
    // 窗口 3000ms：长任务（5s）超窗留后台推进；快查询（<3s）在窗口内 → 同回合答复。
    const sim = await startWecomSim({
      label: 'i2',
      taskDispatch: 'async',
      taskRunWaitMs: 3_000,
      allowWriteOperations: true,
    });
    try {
      const taskA = '把 documents 集合 W202611 的数据导出，跑完发我';
      sim.book.mainTurn(taskA, [toolCallAssistant('task_run', { task: taskA }), acceptCard]);
      sim.book.workerTask(taskA, longTaskWorker('documents W202611 导出完成：共 3 条（1200、800、900）。', 5));
      const mA = sim.sendText(taskA);
      await sim.waitFor('I-2 长任务交办回合结束', () => sim.doneOf(mA) !== undefined, 15_000);

      // 长任务仍在进行中：发第二句独立查询。
      const taskB = '另外，beta 集合 W1 有多少条';
      sim.book.mainTurn(taskB, mainRelayResponses(taskB));
      sim.book.workerTask(taskB, workerQueryResponses('dummy.query', { '--collection': 'beta', '--window': 'W1' }));
      const mB = sim.sendText(taskB);
      // ① 第二句在规定时间内得到答复（快查询同回合落定）。
      await sim.waitFor('I-2 第二句得到答复', () =>
        sim.finalBubbles().some((bubble) => bubble.content.includes('beta W1')), 20_000);
      const replyB = sim.finalBubbles().find((bubble) => bubble.content.includes('beta W1'))!.content;
      expect(replyB).toContain('500');

      // 长任务随后完成 → 恰一条主动投递结果。
      await sim.waitFor('I-2 长任务完成主动投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      const resultA = sim.sdk.proactiveTexts[0]!.content;
      expect(resultA).toContain('W202611');
      expect(resultA).toContain('1200');

      // ② 不串台：两件事的答复互不含对方的数据（交办回合的气泡也不许夹带 B 的数据）。
      expect(replyB).not.toContain('W202611');
      expect(replyB).not.toContain('documents');
      for (const v of ['1200', '800', '900']) expect(hasWholeNumber(replyB, v)).toBe(false);
      expect(resultA).not.toContain('beta');
      for (const v of ['500', '300', '200']) expect(hasWholeNumber(resultA, v)).toBe(false);

      // ③ 任务数 == 2（各自一次真交办）。
      const taskIds = [...sim.doneOf(mA)!.taskIds, ...sim.doneOf(mB)!.taskIds];
      expect(taskIds).toHaveLength(2);
    } finally {
      await sim.close();
    }
  }, 120_000);

  it('I-3 长任务：交办回合照发模型的话，结果完成前不提前投递；完成后恰一条带任务身份的结果（钉：①不打扰 / ④结论有据）', async () => {
    // 窗口 1ms：受理回合立即结束（模型的话原样发出），任务留后台推进到完成。
    const sim = await startWecomSim({
      label: 'i3',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const taskText = '把 documents 集合 W202611 的数据导出成表，跑完发我';
      sim.book.mainTurn(taskText, [toolCallAssistant('task_run', { task: taskText }), acceptCard]);
      sim.book.workerTask(taskText, longTaskWorker('documents W202611 导出完成：共 3 条。', 5));
      const messageId = sim.sendText(taskText);
      await sim.waitFor('I-3 交办回合结束', () => sim.doneOf(messageId) !== undefined, 15_000);
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.finalBubbles()[0]!.content).toBe('好的，这件事我交给后台去办，办好就发给你。');

      // 期间（前 3 秒）不提前投递结果：终帧仍只有交办回合那一条、零主动消息。
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.sdk.proactiveTexts).toHaveLength(0);

      // 完成后恰一条结果消息，且带任务身份（含交办原文的关键片段）。
      await sim.waitFor('I-3 完成主动投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      const delivered = sim.sdk.proactiveTexts[0]!.content;
      expect(delivered).toContain('documents');
      expect(delivered).toContain('W202611');
      // 投递的就是该任务自己的结果（与底账存档一致），不是通用模板。
      const taskId = sim.doneOf(messageId)!.taskIds[0]!;
      const task = registry.get(taskId, TASK_SCOPE);
      expect(archivedReportOf(task) !== undefined || (archivedReportOf(task) !== undefined || lastExecutionOf(task)?.status === 'completed')).toBe(true);
      expect(task.replyText ?? task.resultText ?? '').toContain('W202611');
      // 恰一条：多等一拍仍是一条（不刷屏）。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sim.sdk.proactiveTexts).toHaveLength(1);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 120_000);

  it('I-4 失败话术：给错参数命中执行层确定性拒绝 → 短、无内部标识、带一个可做动作、不风暴（钉：④结论有据 / ⑤分工透明）', async () => {
    // 同步装配：失败在回合内落定，执行事实进本回合 message_done。
    const sim = await startWecomSim({ label: 'i4' });
    try {
      const taskText = '查一下 finance-invoices 集合 2026-10 这个窗口的发票';
      sim.book.mainTurn(taskText, mainRelayResponses(taskText));
      sim.book.workerTask(taskText, [
        toolCallAssistant('op_dummy_query', {
          // 窗口值不是执行层声明的维度值 → 真实 WHERE_INVALID（确定性拒绝）。
          'collection': 'finance-invoices', 'window': '2026-10',
        }),
        (call) => {
          const outcome = lastToolResultJsonOf(call.messages);
          if (outcome === undefined) throw new Error('Worker 没有拿到执行层真实返回。');
          const error = (outcome['error'] ?? {}) as { code?: string };
          const kind = classifyFailure({
            status: outcome['status'] as 'failed' | 'refused' | 'result_unknown' | undefined,
            code: error.code,
          });
          return textAssistant(failureMessageFor(kind).text);
        },
      ]);
      const messageId = sim.sendText(taskText);
      await sim.waitFor('I-4 终帧', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // ① 不含内部标识（operation 名 / 执行层码 / 路径 / 字段/参数 等）。
      expect(internalTermIn(reply)).toBeUndefined();
      expect(reply).not.toContain('WHERE_INVALID');
      expect(reply).not.toContain('dummy.query');
      // ② 短：≤ 60 字。
      expect(reply.length).toBeLessThanOrEqual(60);
      // ③ 含一个可执行动作。
      expect(['再试一次', '先放着', '换个写法', '补一句'].some((action) => reply.includes(action))).toBe(true);
      // ④ 同一任务执行事实 ≤ 2（不得风暴），且是真实失败。
      const done = sim.doneOf(messageId)!;
      expect(done.executions.length).toBeGreaterThanOrEqual(1);
      expect(done.executions.length).toBeLessThanOrEqual(2);
      expect(done.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'failed' });
    } finally {
      await sim.close();
    }
  }, 90_000);

  it('I-5 问进度：回答含真实状态事实、不含空话、本回合零执行（钉：③可查可接管 / ④结论有据）', async () => {
    const sim = await startWecomSim({
      label: 'i5',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const taskText = '把 documents 集合 W202611 的数据导出，跑完发我';
      sim.book.mainTurn(taskText, [toolCallAssistant('task_run', { task: taskText }), acceptCard]);
      sim.book.workerTask(taskText, longTaskWorker('documents W202611 导出完成：共 3 条。', 5));
      const mA = sim.sendText(taskText);
      await sim.waitFor('I-5 交办回合结束', () => sim.doneOf(mA) !== undefined, 15_000);
      const taskId = sim.doneOf(mA)!.taskIds[0]!;
      // 任务确实在跑（不是「没跑所以答得上」的假绿）。
      await sim.waitFor('I-5 任务在跑', () => taskLivenessOf(registry.get(taskId, TASK_SCOPE)) === 'running', 10_000);

      const ask = '刚才那个事，到哪了？';
      sim.book.mainTurn(ask, [
        toolCallAssistant('task_status', {}),
        (call) => {
          const listed = lastToolResultJsonOf(call.messages) as {
            tasks?: ReadonlyArray<{ liveness?: string; replyText?: string | null; resulted?: number }>;
          } | undefined;
          const task = listed?.tasks?.[0];
          if (task === undefined) throw new Error('task_status 没有返回真实状态（拿不到就不许回）。');
          const done = (task.replyText !== null && task.replyText !== undefined) || (task.resulted ?? 0) > 0;
          return textAssistant(done ? '那件事已经办完了。' : '那件事还在办，还没出结果。');
        },
      ]);
      const mAsk = sim.sendText(ask);
      // 交办回合已占一条气泡；进度答复是第二条。
      await sim.waitFor('I-5 进度答复', () => sim.finalBubbles().length === 2, 15_000);

      const reply = sim.finalBubbles().at(-1)!.content;
      // 含真实事实（来自底账状态）：任务在跑 → 如实说还在办。
      expect(reply).toContain('还在办');
      // 不含「正在处理 / 进度 / 步骤」这类空话。
      for (const empty of ['正在处理', '进度', '步骤']) expect(reply).not.toContain(empty);
      // 纯查询：本回合零执行事实（不发起新的执行）。
      expect(sim.doneOf(mAsk)!.executions).toHaveLength(0);
      // 收尾：等任务完成再关库。
      await sim.waitFor('I-5 任务完成', () => (archivedReportOf(registry.get(taskId, TASK_SCOPE)) !== undefined || lastExecutionOf(registry.get(taskId, TASK_SCOPE))?.status === 'completed'), 20_000);
    } finally {
      registry.close();
      await sim.close();
    }
  }, 90_000);

  it('I-6 群聊：查询正常答复、零主动提醒；纯附件不追问（钉：①不打扰 / ③可查可接管）', async () => {
    // 群主体 operator + 写面开放：群里的活真跑得起来（不是「没开通所以安静」冒充）。
    const sim = await startWecomSim({
      label: 'i6',
      taskDispatch: 'async',
      allowWriteOperations: true,
      groupRole: 'operator',
    });
    try {
      // 群里发一句查询（缺省窗口：快活同回合答复）。
      const query = '群里问一下 documents 集合 W202611 有多少条';
      sim.book.mainTurn(query, mainRelayResponses(query));
      sim.book.workerTask(query, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      sim.sendText(query, { chatType: 'group', conversationId: 'group-w' });
      await sim.waitFor('I-6 群查询答复', () => sim.finalBubbles().length === 1, 20_000);
      expect(sim.finalBubbles()[0]!.content).toContain('documents W202611 共 3 条');
      // 零主动提醒。
      expect(sim.sdk.proactiveTexts).toHaveLength(0);

      // 再发一条纯附件 → 不触发追问（与 W-16 同判据，防回归）。
      const sample = await salesSampleXlsxAsync();
      sim.sendFile('销售明细.xlsx', sample, { chatType: 'group', conversationId: 'group-w' });
      await sim.waitFor('I-6 群纯附件回合已发生', () =>
        sim.logs.some((line) => line['event'] === 'message_attachment_only'), 20_000);
      await sim.clock.advance(NUDGE_AFTER_MS);
      expect(sim.nudgeTexts()).toHaveLength(0);
      expect(sim.logs.some((line) => line['event'] === 'attachment_nudge_sent')).toBe(false);
    } finally {
      await sim.close();
    }

    // 群聊长任务：同条件真跑起来也不发主动提醒（跨 principal 泄漏面；1:1 对照见 W-43）。
    const group = await startWecomSim({
      label: 'i6-long',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
      groupRole: 'operator',
      longRunningNoticeMs: 200,
    });
    const groupRegistry = createSqliteTaskRegistry(group.dbPath, { readOnly: true });
    try {
      const t = '群里跑一个三秒的长任务';
      group.book.mainTurn(t, [toolCallAssistant('task_run', { task: t }), acceptCard]);
      group.book.workerTask(t, longTaskWorker('（群）导出完成。', 3));
      const mt = group.sendText(t, { chatType: 'group', conversationId: 'group-w' });
      await group.waitFor('I-6 群长任务受理', () => group.doneOf(mt) !== undefined, 15_000);
      const taskId = group.doneOf(mt)!.taskIds[0]!;
      await group.waitFor('I-6 群长任务在跑', () => taskLivenessOf(groupRegistry.get(taskId, GROUP_SCOPE)) === 'running', 10_000);
      // 群里也发（owner 2026-11-19 #9 迁移；旧口径「群聊零主动提醒」已作废）：群 = 独立主体，
      // 群任务的久无动静提醒回到群会话，话术走隐私口径（不带业务名）。
      await group.waitFor('I-6 群聊也有久无动静提醒', () => group.sdk.proactiveTexts.length >= 1, 10_000);
      const groupNotice = group.sdk.proactiveTexts[0]!;
      expect(groupNotice.chatId).toBe('group-w');
      expect(groupNotice.content).toContain('比预计久');
      expect(groupNotice.content).not.toContain(t);
      expect(group.sdk.proactiveTexts.filter((entry) => entry.content === LONG_RUNNING_NOTICE_FALLBACK_TEXT)).toHaveLength(0);
      // 收尾：等群长任务跑完再关库。
      await group.waitFor('I-6 群长任务完成', () => (archivedReportOf(groupRegistry.get(taskId, GROUP_SCOPE)) !== undefined || lastExecutionOf(groupRegistry.get(taskId, GROUP_SCOPE))?.status === 'completed'), 20_000);
    } finally {
      groupRegistry.close();
      await group.close();
    }
  }, 120_000);

  it.todo('I-8 重启重投（同 messageId 重投 → 回放同一句、零新执行）：'
    + '此 todo 理由仍成立——wecom-sim 每夹具 mkdtemp 新建独立底账、不暴露「同 dbPath 重建 server」'
    + '的缝，sim 面做不了（不硬凑）；跨重启入站幂等（底账 inbound_messages 为唯一判据）已由'
    + ' apps/server/server-inbound-idempotency.test.ts 4/4 单测覆盖（含关 server 同 dbPath 重建重投）。');

  it.todo('C 组·写确认（提案 → 确认 → 真写入 → 读回 4 条 + 不重复提案）：'
    + '原等待理由「确认句柄轨合流」已过期（句柄轨 7eb7cce5 已是本仓祖先）；写闭环已在'
    + ' cases-f-write.test.ts 的 F 组渠道级用例走完（W-22 提案零写入 / W-23 确认写入读回 4 条 /'
    + ' W-24 再确认确定性拒绝，含不重复提案与不重复写入）。本组不重复造第二套装配，'
    + '故保留 todo 作 C 组编号占位，实际判据以 F 组为准。');
});
