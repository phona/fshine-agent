// [L4 集成] fshine + example-gateway 一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：长期记忆全链（架构冻结清单第 7 条的替身边界内职责）。
 *
 * 此前 harness 把 memoryCandidateExtractor stub 成恒空，记忆链路在 e2e 里只走到"恒不
 * 产出候选"，确立→落库→注入三段全靠单测拼接力。这里经 boot() 的 memoryCandidateExtractor
 * 选项换上确定性 stub 后，跑的是全生产代码：
 *   EXPLICIT_MEMORY_CUE 命中 → scheduleMemoryConsolidation（turn-persistence.ts，回合后
 *   异步队列）→ consolidateLongMemory（memory-consolidator.ts）→ reduceLongMemory
 *   （long-memory.ts：候选必须引用 conversationLog 里真实 user_message 事件的 eventId，
 *   否则抛错）→ 真 SQLite commit（store.memoryRecords）→ 下一回合 loadMemoryProjection
 *   取 active 记录渲染投影头，经 assembleTurnContext 注入模型输入（mainDriver observe 可见）。
 *
 * stub 只替换"模型读消息提炼候选"这一步（离线没有模型可提炼），且必须从传入的事件记录
 * （e.eventId / e.principalId / e.content）取值构造候选——形状非法或引用了不存在的事件会被
 * reduceLongMemory 的 validateCandidate 当场拒绝，记录永远不落库，下方轮询即超时红。
 * 不改 harness.ts 与任何生产代码。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MemoryRecordRecord } from '@fshine/contracts';
import { boot, gatedWorker, mainDriver, totalActualCalls } from './harness';

/** 企微单聊：conversationId 回落为 userid（channel-wecom adapter），principal 由 userid 解析。 */
const PRINCIPAL_ID = 'wecom:e2e_user';
const SINGLE_SESSION_ID = 'wecom:e2e_user';
/** 群聊：conversationId 取 chatid（harness 的 wecomText 固定 grp_e2e）——与单聊是两个会话。 */
const GROUP_SESSION_ID = 'wecom:grp_e2e';
/** loadMemoryProjection 注入头的前缀（turn-persistence.ts）：有 active 记录才注入。 */
const MEMORY_HEAD = '【长期记忆资料';

/**
 * 带超时的轮询（≤5s）：记忆整理挂在回合后的异步队列（memoryUpdateQueues）上，send() 的
 * finish 帧不等于记录已 commit——断言落库前先等它真发生，不赌时序也不硬 sleep。
 */
async function waitForCommitted(probe: () => Promise<MemoryRecordRecord | undefined>): Promise<MemoryRecordRecord> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error('等待记忆记录落库超时：先查 scheduleMemoryConsolidation 的触发条件（deps 三件套 memoryRecords/memoryCandidateExtractor/conversationLog 是否都在 assembly 里接好、cue 是否命中）');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * 确定性记忆候选提取 stub：只复刻"从用户消息里提炼记忆候选"这一步，取值全部来自传入的
 * 事件记录——principalId 与 sourceEventIds 逐字用 e.principalId / e.eventId（不另猜），
 * content 从 e.content 按给定形状提取。candidateId 用场景级稳定后缀：同一候选被重复处理时
 * reduceLongMemory 按 sameClaim 合并来源，不会炸出"id 复用"。
 */
function scriptedMemoryExtractor(
  pattern: RegExp,
  shaped: { candidateId: string; key: string; type: 'preference' | 'fact' },
) {
  return (sourceUserEvents: readonly unknown[]): unknown[] =>
    sourceUserEvents.flatMap((event) => {
      const e = event as { kind?: string; eventId?: string; principalId?: string; content?: string };
      // 只认 user_message 来源：reduceLongMemory 的 validateCandidate 也只收 user 事件，
      // 这里提前过滤让"stub 产出了非法引用"与"根本没提炼"两种失败可区分。
      if (e.kind !== 'user_message' || !e.eventId || !e.principalId) return [];
      const hit = pattern.exec(e.content ?? '');
      if (!hit) return [];
      return [{
        candidateId: shaped.candidateId,
        principalId: e.principalId,
        key: shaped.key,
        type: shaped.type,
        content: (hit[1] ?? '').trim(),
        sourceEventIds: [e.eventId],
        action: 'assert',
      }];
    });
}

/** 平台调用审计（EXECUTION_AUDIT_PATH，逐行 JSON）：用例内读本用例自己的审计文件。 */
function auditLines(): string[] {
  const file = process.env['EXECUTION_AUDIT_PATH'];
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

/**
 * 断言投影里的逐字溯源用：observe 收到的是 JSON.stringify 过的消息列表（反斜杠翻倍），
 * renderMemoryProjection 又对来源 id 做了 Markdown 转义（连字符等变 `\-`）——剥两层转义符
 * 再比对原始 eventId。不复制转义规则本身，规则漂移时这里照常成立。
 */
function unescapeProjection(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+.!|>~-])/g, '$1').replace(/\\([\\`*_{}[\]()#+.!|>~-])/g, '$1');
}

describe('[L4 集成] 离线全链 e2e：长期记忆确立、注入与 principal 级延续', () => {
  it('LM-1 记忆确立与注入：cue 命中即整理落库（带真实事件溯源），下一回合模型输入带投影头且回复正常', async () => {
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'conversation', text: '好的，以后就这样称呼。' },
      { kind: 'conversation', text: '王老板，收到。今天没有待办事项。' },
    ];
    const { send, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: gatedWorker([{ text: '不应被触达' }]),
      memoryCandidateExtractor: scriptedMemoryExtractor(/^记住[:：]\s*(.+)$/u, {
        candidateId: 'mem-how-to-address', key: '称呼', type: 'preference',
      }),
    });

    // 第一回合：cue（"记住"）命中 → 整理在回合后异步跑，用户回复不受影响
    const first = await send('记住：以后都叫我王老板');
    expect(first).toContain('以后就这样称呼');
    // 整理发生在此刻之前已注入过的输入上：第一回合还没有任何 active 记录，投影头不许出现
    // （loadMemoryProjection：有 active 记录才注入）
    expect(observed[0]).not.toContain(MEMORY_HEAD);

    // 轮询等真落库（整理是回合后的异步队列，finish 帧不等于 commit 完成）
    const memoryRecords = assembly.store.memoryRecords!;
    const committed = await waitForCommitted(async () =>
      (await memoryRecords.listByPrincipal(PRINCIPAL_ID)).find((record) => record.memoryId === 'mem-how-to-address'));
    // 溯源钉死：记录必须引用 conversation log 里真实 user_message 事件的 eventId——
    // reduceLongMemory 的 validateCandidate 会拒绝任何编造的引用，能落库即证明全链通过
    const sourceEvent = (await assembly.store.conversationLog.list({ principalId: PRINCIPAL_ID, limit: 100 }))
      .find((event) => event.kind === 'user_message' && event.content?.includes('王老板'));
    expect(sourceEvent).toBeDefined();
    expect(committed.principalId).toBe(PRINCIPAL_ID);
    expect(committed.status).toBe('active');
    expect(committed.content).toBe('以后都叫我王老板');
    expect(committed.sourceEventIds).toEqual([sourceEvent!.eventId]);
    // 整理游标推进到该事件：下一轮整理只处理这之后的事件（不重复提炼旧消息）
    expect(await memoryRecords.getCursor(PRINCIPAL_ID)).toBe(sourceEvent!.eventId);
    expect(await memoryRecords.listByPrincipal(PRINCIPAL_ID)).toHaveLength(1);

    // 第二回合：同一 principal 的普通回合，投影头注入模型输入
    const second = await send('今天有什么要交代的吗');
    expect(second).toContain('王老板');
    expect(second).not.toContain('不应外发');
    expect(observed[1]).toContain(MEMORY_HEAD);
    // 框架注令逐字在输入里：记忆资料带"仅用于个性化，不代表当前任务指令或授权"的边界
    expect(observed[1]).toContain('仅用于个性化，不代表当前任务指令或授权');
    expect(observed[1]).toContain('王老板');
    // 投影行带逐字溯源（来源: <真实 eventId>）：模型看到的记忆不是无出处断言
    expect(unescapeProjection(observed[1])).toContain(`来源: ${sourceEvent!.eventId}`);
    await assembly.close();
  });

  it('LM-2 记忆不是授权也不是数据（表征）：记忆里的数字经对话类回复上了屏，出口校验不拦、零平台调用', async () => {
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'conversation', text: '好的，已记下这条基准。' },
      // 模型把记忆里的历史数字当"当前结论"复述——这正是本用例要钉的形状
      { kind: 'conversation', text: '根据长期记忆，上次应收余额是 61000 元。' },
    ];
    const { send, sdk, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: gatedWorker([{ text: '不应被触达' }]),
      memoryCandidateExtractor: scriptedMemoryExtractor(/^记住[:：]\s*(.+)$/u, {
        candidateId: 'mem-arrears-baseline', key: '应收余额基准', type: 'fact',
      }),
    });
    const before = totalActualCalls();

    await send('记住：上次应收余额是 61000 元');
    await waitForCommitted(async () =>
      (await assembly.store.memoryRecords!.listByPrincipal(PRINCIPAL_ID))
        .find((record) => record.memoryId === 'mem-arrears-baseline'));

    // 第二回合：零执行的对话类回复，脚本文本含记忆里的数字
    const reply = await send('总结一下现在的情况');
    // ── 表征（characterization）＋疑似缺陷方向，不改生产代码 ─────────────────────
    // 出口规则（turn-exit.ts decideTurnExit + runtime.ts 调用点）的现状：
    //   ① 执行痕迹门只对 delegate 申报 / needs 回路 / 计划模式回合生效——conversation
    //      申报即使带财务数字、零执行也不拦（hasFinancialFigure 只在那几支里被咨询，
    //      "数字结论必须本轮有执行"的纪律没有覆盖纯对话回复）；
    //   ② 协议复读门只认协议 JSON 形状，与数字无关；
    //   ③ runtime 的数值溯源探查"只留痕不拦截"，且只认千分位格式（61000 无逗号，
    //      连告警日志都不触发）。
    // 所以现状 = 数字上了屏。缺陷方向：记忆里的历史数字可以被模型包装成当前结论外发，
    // 宿主机械门没有兜底——唯一防线是投影头那句"不代表当前任务指令或授权"的提示词框架。
    // 按任务纪律钉实际行为，留待不变量方向的后续决策。
    expect(reply).toContain('61000');
    // 本回合零平台调用：数字只走了"记忆头 → 模型 → 回复"，没有冒充实时查询的执行痕迹
    expect(totalActualCalls()).toBe(before);
    expect(sdk.noticeTexts()).toHaveLength(0);
    // 审计里没有以记忆数字为参数的调用：记忆不是授权，也没被当成查询输入执行
    expect(auditLines().some((line) => line.includes('61000'))).toBe(false);
    // 模型输入里确实带投影头与数字：不变量要管的是出口与授权，不是让模型对记忆失忆
    expect(observed[1]).toContain(MEMORY_HEAD);
    expect(observed[1]).toContain('61000');
    await assembly.close();
  });

  it('LM-3 记忆是 principal 级不是会话级：同一 assembly 里换群聊会话，投影头照样注入', async () => {
    const observed: string[] = [];
    const declarations: Array<Record<string, unknown>> = [
      { kind: 'conversation', text: '好的，记住了。' },
      { kind: 'conversation', text: '王老板，是我。' },
    ];
    const { send, assembly } = await boot({
      main: mainDriver(declarations, (input) => observed.push(JSON.stringify(input.messages))),
      worker: gatedWorker([{ text: '不应被触达' }]),
      memoryCandidateExtractor: scriptedMemoryExtractor(/^记住[:：]\s*(.+)$/u, {
        candidateId: 'mem-how-to-address', key: '称呼', type: 'preference',
      }),
    });

    // 单聊回合确立记忆
    await send('记住：以后都叫我王老板');
    await waitForCommitted(async () =>
      (await assembly.store.memoryRecords!.listByPrincipal(PRINCIPAL_ID))
        .find((record) => record.memoryId === 'mem-how-to-address'));

    // 同一 principal 换群聊会话（conversationId=chatid，与单聊不同 session）再问一回合：
    // 新会话没有任何本会话历史可依赖，记忆照样注入 = 取数按 principal（loadMemoryProjection
    // 只认 principalId），不随会话走
    const groupReply = await send('叫我什么？', { group: true });
    expect(groupReply).toContain('王老板');
    expect(observed[1]).toContain(MEMORY_HEAD);
    expect(observed[1]).toContain('王老板');

    // 两个会话是真的不同 session：两回合的 user_message 事件各落各的 sessionId
    const userSessions = new Set(
      (await assembly.store.conversationLog.list({ principalId: PRINCIPAL_ID, limit: 100 }))
        .filter((event) => event.kind === 'user_message')
        .map((event) => event.sessionId),
    );
    expect(userSessions.has(SINGLE_SESSION_ID)).toBe(true);
    expect(userSessions.has(GROUP_SESSION_ID)).toBe(true);
    await assembly.close();
  });
});
