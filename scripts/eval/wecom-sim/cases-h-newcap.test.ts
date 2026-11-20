/**
 * H 组·本轮新增能力（W-42～W-44）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 这三条原来登记成「人工抽查」，其实都能自动化——装配链完整（真渠道适配 + 真 server +
 * 真 dummy 子进程），所以判据全部落在用户可见结果与底账事实上：
 *   W-42 长任务（契约 v4）：交办回合照发模型的话、任务在后台挂起等结果、完成后主动投递一次；
 *        期间用户发下一句不被占住（同一会话第二回合照常回）。
 *   W-43 预期式提醒：任务超过首档阈值仍无事件 → **恰一条**「这件事比预计久了…」；
 *        群聊同条件**零**主动提醒（跨 principal 泄漏面）。长任务也要发（受理后租约被清，
 *        靠底账 running_since 算「跑了多久」——2026-11-19 修）。
 *   W-44 权限：viewer 调写 → 发起前确定性拒绝（话术不含内部 operation 名、零执行事实）；
 *        同一主体读查询照常。
 *
 * 时钟纪律：提醒阈值调到几百毫秒（配置注入，不改产品缺省）；长任务用 dummy 的
 * `--seconds` 真等待（1～3 秒），断言用事件驱动 waitFor，不写固定 sleep。
 */
import { describe, expect, it } from 'vitest';
import { deriveTaskName } from '../../../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../../../packages/agent/src/task-registry-sqlite';
import { LONG_RUNNING_NOTICE_FALLBACK_TEXT } from '../../../packages/agent/src/task-runner';
import {
  lastToolResultJsonOf,
  lastToolResultOf,
  longRunningWakeLine,
  mainRelayResponses,
  startWecomSim,
  textAssistant,
  toolCallAssistant,
  workerQueryResponses,
  type SimResponse,
} from './harness';

const TASK_SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:user-a' } as const;
const GROUP_SCOPE = { principalId: 'wecom:group:group-w', sessionId: 'wecom:group-w' } as const;

const PREPARE_ARGS = { '--collection': 'alpha', '--window': 'W1', '--count': 2 };

/**
 * 宽容的 Main 转述：task_run 可能返回摘要（快活完成）、受理回执（受理）或工具错误
 * （委派被拒/回合失败）——三种都如实转述，不替宿主编话。
 */
const relayWhatever = (call: { messages: readonly unknown[] }) => {
  const result = lastToolResultJsonOf(call.messages);
  const text = result?.['summary'] ?? result?.['notice'];
  if (typeof text === 'string' && text !== '') return textAssistant(text);
  const toolResult = lastToolResultOf(call.messages);
  if (toolResult !== undefined && toolResult.text !== '') return textAssistant(toolResult.text);
  throw new Error('Main 没有拿到任何可转述的结果。');
};

/**
 * 长任务 Worker 脚本：首回合发起真实 `dummy.longtask`（执行层返回 accepted → 回合结束、
 * 让出租约与槽位）；续跑回合（wait 完成后宿主唤醒）汇报结果。
 */
function longTaskWorkerResponses(seconds: number): readonly SimResponse[] {
  return [
    toolCallAssistant('execute_operation', { operation: 'dummy.longtask', args: { '--seconds': seconds } }),
    textAssistant('已发起长任务，等它跑完。'),
    textAssistant('导出完成：上个月全部凭证共 42 张。'),
  ];
}

describe('H 组·本轮新增能力（W-42～W-44，自动）', () => {
  it('W-42 长任务：交办回合照发模型的话、后台挂起不占会话、完成后主动投递；执行层只被调一次', async () => {
    const sim = await startWecomSim({
      label: 'w42',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const taskText = '让 dummy 跑一个要很久的导出';
      sim.book.mainTurn(taskText, [
        toolCallAssistant('task_run', { task: taskText }),
        // 交办回合模型会自己编一句受理卡片；owner 2026-11-19：这段原样投递（宿主不再静默）。
        // 顺带绊线：受理事实不得再带回执话术（notice）——带了立即红。
        (call) => {
          const result = lastToolResultJsonOf(call.messages);
          if (result?.['accepted'] !== true) throw new Error('Main 没有拿到受理事实（accepted:true）。');
          if (result !== undefined && 'notice' in result) throw new Error('受理事实不应再带受理回执话术（notice）。');
          return textAssistant('好的，这个导出我交给后台去跑，好了就发给你。');
        },
      ]);
      sim.book.workerTask(taskText, longTaskWorkerResponses(1));

      const messageId = sim.sendText(taskText);
      // 交办回合照发模型的话（逐字）；任务已在后台挂起。
      await sim.waitFor('W-42 交办回合结束', () => sim.doneOf(messageId) !== undefined, 10_000);
      expect(sim.finalBubbles()).toHaveLength(1);
      expect(sim.finalBubbles()[0]!.content).toBe('好的，这个导出我交给后台去跑，好了就发给你。');

      const taskId = sim.doneOf(messageId)!.taskIds[0]!;
      // 受理后：任务 running 但租约已释放（长任务让出槽位/租约，不该被当过期的执行中回合）。
      await sim.waitFor('长任务 accepted（租约释放）', () => {
        const task = registry.get(taskId, TASK_SCOPE);
        return task.status === 'running' && task.leaseUntil === undefined;
      }, 10_000);

      // 期间用户还能聊别的：同一会话第二回合照常拿到回复（不被长任务占住）。
      sim.book.mainTurn('顺便问一句：现在几点了？', [textAssistant('这个我查不了时间，但我在的，随时说。')]);
      sim.sendText('顺便问一句：现在几点了？');
      await sim.waitFor('W-42 期间第二回合有回复', () => sim.finalBubbles().length === 2, 10_000);

      // 长任务在后台跑完 → 宿主主动投递一次结果。
      await sim.waitFor('长任务完成并主动投递', () => sim.sdk.proactiveTexts.length === 1, 30_000);
      expect(sim.sdk.proactiveTexts[0]!.content).toContain('42');
      const done = registry.get(taskId, TASK_SCOPE);
      expect(done.status).toBe('completed');
      // 执行层只被发起一次（续跑不重复发起同一 operation）。
      expect(done.executions.filter((execution) => execution.operation === 'dummy.longtask')).toHaveLength(1);
    } finally {
      registry.close();
      await sim.close();
    }
  });

  it('W-43 预期式提醒：超阈值恰一条「比预计久了」；群聊也发（话术不带业务名；长任务也要发）', async () => {
    // 首档阈值调到 200ms；长任务 `--seconds 3` 保证触发时任务还在飞。
    const sim = await startWecomSim({
      label: 'w43',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
      longRunningNoticeMs: 200,
    });
    try {
      const taskText = '跑一个三秒的长任务';
      sim.book.mainTurn(taskText, [toolCallAssistant('task_run', { task: taskText }), relayWhatever]);
      sim.book.workerTask(taskText, longTaskWorkerResponses(3));
      sim.sendText(taskText);

      await sim.waitFor('W-43 超预期提醒', () => sim.sdk.proactiveTexts.length === 1, 10_000);
      // 用户可见文本 = 唤醒回合里模型说的那句（2026-11-19 唤醒切片；宿主只喂事实）——
      // 台词唯一来源 = harness 的模拟模型（不硬编、不比对宿主文案）。
      const noticeLine = longRunningWakeLine(deriveTaskName(taskText));
      expect(sim.sdk.proactiveTexts[0]!.content).toBe(noticeLine);
      // 恰一条：不会刷屏（宿主兜底文案一次都不该出现——模型说的出话）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sim.sdk.proactiveTexts.filter((entry) => entry.content === noticeLine)).toHaveLength(1);
      expect(sim.sdk.proactiveTexts.some((entry) => entry.content === LONG_RUNNING_NOTICE_FALLBACK_TEXT)).toBe(false);
    } finally {
      await sim.close();
    }

    // 群聊对照：同条件（群里任务真跑起来）→ 零主动提醒。
    const group = await startWecomSim({
      label: 'w43-group',
      taskDispatch: 'async',
      taskRunWaitMs: 1,
      allowWriteOperations: true,
      groupRole: 'operator',
      longRunningNoticeMs: 200,
    });
    const groupRegistry = createSqliteTaskRegistry(group.dbPath, { readOnly: true });
    try {
      const taskText = '群里跑一个三秒的长任务';
      group.book.mainTurn(taskText, [toolCallAssistant('task_run', { task: taskText }), relayWhatever]);
      group.book.workerTask(taskText, longTaskWorkerResponses(1));
      const messageId = group.sendText(taskText, { chatType: 'group' });
      // 任务确实在群里跑起来了（不是「没开通所以安静」冒充）。
      await group.waitFor('W-43 群聊回合终态', () => group.doneOf(messageId) !== undefined, 10_000);
      const taskId = group.doneOf(messageId)!.taskIds[0]!;
      await group.waitFor('群里长任务 accepted', () => {
        const task = groupRegistry.get(taskId, GROUP_SCOPE);
        return task.status === 'running';
      }, 10_000);
      // 群里也发（owner 2026-11-19 #9 迁移；旧口径「群聊零主动提醒」已作废）：
      // 群 = 独立主体，群里的任务就是这个群的事；话术走隐私口径 = **不带业务名**。
      //
      // 等「目标文本」本身出现，不是等「任意主动文本出现」再取 [0]：群里的长任务跑完
      // 也会主动投递（"导出完成…"），与久无动静提醒是两种合法来源，谁先到不确定——
      // 按内容筛出提醒再断言，不依赖 proactiveTexts 的数组顺序（排序竞态）。
      const NOTICE_MARK = '比预计久';
      const groupNoticesOf = () => group.sdk.proactiveTexts.filter((entry) => entry.content.includes(NOTICE_MARK));
      await group.waitFor('W-43 群聊也有久无动静提醒', () => groupNoticesOf().length >= 1, 10_000);
      const groupNotices = groupNoticesOf();
      expect(groupNotices).toHaveLength(1);
      const groupNotice = groupNotices[0]!;
      expect(groupNotice.chatId).toBe('group-w');
      expect(groupNotice.content).toBe(longRunningWakeLine(undefined));
      expect(groupNotice.content).toContain('比预计久');
      expect(groupNotice.content).not.toContain(taskText);
      expect(groupNotice.content).not.toContain(deriveTaskName(taskText));
      // 恰一条（不刷屏；也没有宿主兜底句——模型说得出话）。
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(group.sdk.proactiveTexts.filter((entry) => entry.content.includes('比预计久'))).toHaveLength(1);
      expect(group.sdk.proactiveTexts.filter((entry) => entry.content === LONG_RUNNING_NOTICE_FALLBACK_TEXT)).toHaveLength(0);
      // 让群里的长任务跑完再收尾（不在库里跑着就关库）。
      await group.waitFor('群里长任务终态', () => groupRegistry.get(taskId, GROUP_SCOPE).status === 'completed', 15_000);
    } finally {
      groupRegistry.close();
      await group.close();
    }
  });

  it('W-44 viewer 只读：写被发起前拒绝（不提 operation 名、零执行事实）；读查询照常', async () => {
    const sim = await startWecomSim({
      label: 'w44',
      taskDispatch: 'async',
      // 窗口用产品缺省（8000ms）：读写两回合都在窗口内落定（快活），用户话术由模型同回合转述。
      allowWriteOperations: true,
      userRole: 'viewer',
    });
    const registry = createSqliteTaskRegistry(sim.dbPath, { readOnly: true });
    try {
      const writeTask = '给 alpha 集合 W1 追加 2 条记录';
      sim.book.mainTurn(writeTask, [
        toolCallAssistant('task_run', { task: writeTask }),
        relayWhatever,
      ]);
      sim.book.workerTask(writeTask, [
        toolCallAssistant('execute_operation', { operation: 'dummy.prepare', args: PREPARE_ARGS }),
        (call) => {
          const result = lastToolResultOf(call.messages);
          if (result === undefined || !result.isError) {
            throw new Error('viewer 的写操作没有被宿主拒绝（这是权限缺陷）。');
          }
          return textAssistant(`没办成：${result.text}`);
        },
      ]);
      const messageId = sim.sendText(writeTask);
      await sim.waitFor('W-44 写请求终态', () => sim.doneOf(messageId) !== undefined, 10_000);

      const done = sim.doneOf(messageId)!;
      // 零执行事实：拒绝发生在发起之前（不是执行层拒绝）；底账里也没有跑起来/跑成功的任务。
      expect(done.executions).toHaveLength(0);
      const tasks = registry.list(TASK_SCOPE);
      expect(tasks.some((task) => task.status === 'running' || task.status === 'completed')).toBe(false);
      // 用户可见话术：说明没有权限，且不暴露内部 operation 名。
      const visible = sim.finalBubbles().map((bubble) => bubble.content).join('\n');
      expect(visible).toContain('当前权限不支持这个操作');
      expect(visible).not.toContain('dummy.prepare');

      // 同一主体读查询照常（只读权限没被误伤）。
      const readText = '帮我查一下 documents 集合 W202611 的数据';
      sim.book.mainTurn(readText, mainRelayResponses(readText));
      sim.book.workerTask(readText, workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      sim.sendText(readText);
      await sim.waitFor('W-44 读查询有回复', () => sim.finalBubbles().length === 2, 15_000);
      expect(sim.finalBubbles()[1]!.content).toContain('documents W202611');
    } finally {
      registry.close();
      await sim.close();
    }
  });
});
