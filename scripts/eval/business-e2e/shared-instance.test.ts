/**
 * D7 共享实例夹具回归（零网络、零真实平台、零产品代码改动）：
 *   单一 createServer 实例（= 唯一服务进程）+ 单一 SQLite 底账文件 + 同一任务管理资源，
 *   两个 principal（wecom:alice / wecom:bob）在**同一会话窗口**（同 conversationId）收发消息。
 *   场景（先红后绿，见 shared-instance.ts）：
 *     S1 跨 principal 查询/结果取回/编号解析（越权=找不到，不泄露存在性）；
 *     S2 跨 principal 取消（B 取消 A 的任务被拒且状态不变；A 自己取消成功）；
 *     S3 跨 principal 接续（B 回答 A 的 waiting_user 被拒；A 自己接续成功）；
 *     正向对照贯穿：A/B 各自操作自己的任务必须成功——防「全拒绝也算绿」。
 *   越权拒绝证据三层归档（evidence JSONL）：B 回合回复文本（不含 A 任务详情）+
 *   message_done 终态（taskIds/executions 空）+ 底账状态不变。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyForwardGuard,
  applyRefusalGuard,
  assertFoundEvidence,
  assertRefusalEvidence,
  createSharedInstanceFixture,
  outcomeBehavior,
  pendingCancelableBehavior,
  textAssistant,
  toolCallAssistant,
  type SharedInstanceFixture,
} from './shared-instance';

const fixtures: SharedInstanceFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function newFixture(): SharedInstanceFixture {
  const fixture = createSharedInstanceFixture({ scenarioName: 'shared-instance-test' });
  fixtures.push(fixture);
  return fixture;
}

/**
 * 2026-11-20 机制变化：数字 ref（#N）退役，跨 principal 隔离的判据改由真实 taskId 承载。
 * 从后台回合的真实入参里取 taskId；断言强度不放宽（越权仍必须拒绝、正向仍必须命中）。
 */
function taskIdOfRound(fx: SharedInstanceFixture, index: number): string {
  const taskId = fx.executor.rounds[index]?.input.taskId;
  if (typeof taskId !== 'string') throw new Error(`（测试）第 ${index} 个后台回合没有 taskId`);
  return taskId;
}

/** S1：跨 principal 查询 / 结果取回 / 编号解析；正向对照（含身份绊线的原料）。 */
describe('共享实例：跨 principal 查询与编号解析', () => {
  it('B 查/取 A 的任务 → 找不到（不泄露详情）；A 自己查 → 成功；同文本换身份结果不同', async () => {
    const fx = newFixture();
    const secret = 'SECRET-A-result';

    // A 建后台任务 #1；执行端脚本给出含敏感标记的完成结果。
    fx.scriptMain(
      toolCallAssistant('task_run', { task: '查询 documents 窗口 W202611' }),
      textAssistant('已受理，稍后给你结果。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: `${secret} documents W202611 共 3 条` }));
    await fx.send('alice', '帮我查 documents 窗口 W202611');
    await fx.settleRounds();
    const aTaskId = taskIdOfRound(fx, 0);

    // 正向对照：A 取回自己任务的结果（正反对照防「全拒绝也算绿」）。数字 ref 已退役，按 taskId。
    fx.scriptMain(
      toolCallAssistant('task_result', { ref: aTaskId }),
      textAssistant('那个任务已完成：documents W202611 共 3 条。'),
    );
    const aliceResult = await fx.send('alice', '那个任务的结果是什么');
    expect(aliceResult.reply).toContain('3 条');
    assertFoundEvidence(aliceResult);

    // 越权：B 用 A 的 taskId 查状态 → scope 内找不到（与不存在同错，不泄露存在性）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('没找到这个任务，它不属于当前会话。'),
    );
    const bobStatus = await fx.send('bob', '查一下那个任务的状态');
    assertRefusalEvidence(bobStatus, [secret, 'documents', '3 条']);

    // 越权：B 取结果（taskId 越权的另一动作面）。
    fx.scriptMain(
      toolCallAssistant('task_result', { ref: aTaskId }),
      textAssistant('没有这个任务，取不了结果。'),
    );
    const bobResult = await fx.send('bob', '把那个任务的结果发我');
    assertRefusalEvidence(bobResult, [secret, 'documents', '3 条']);

    // B 列自己的任务：空（A 的任务不在 B 的 scope 列表里）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '' }),
      textAssistant('你当前没有任务。'),
    );
    const bobList = await fx.send('bob', '我有哪些任务');
    assertRefusalEvidence(bobList, [secret, 'documents']);

    // 身份绊线原料：同一 taskId 由 A 发出 → 找得到（隔离依赖身份而非文本）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('那个任务已完成。'),
    );
    const aliceStatus = await fx.send('alice', '查一下那个任务的状态');
    expect(aliceStatus.reply).toContain('已完成');
    assertFoundEvidence(aliceStatus);
  });

  it('taskId 全局唯一：B 建任务拿到自己的 taskId，B 的 taskId 对 A 同样拒绝', async () => {
    // 2026-11-20 机制变化：数字 ref 退役，隔离判据改由 taskId（底账唯一）承载。
    // 底账 taskNo 仍单调（账本事实），但不进模型引用面；断言强度不放宽。
    const fx = newFixture();
    fx.scriptMain(
      toolCallAssistant('task_run', { task: '查询 documents 窗口 W202611' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-A-result' }));
    await fx.send('alice', '帮我查 documents 窗口 W202611');
    await fx.settleRounds();

    fx.scriptMain(
      toolCallAssistant('task_run', { task: '查询 meetings 列表' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-B-result meetings 5 条' }));
    await fx.send('bob', '帮我查 meetings 列表');
    await fx.settleRounds();
    // 共享底账计数器仍单调（账本事实，不进模型引用面）。
    expect(fx.executor.rounds.map((round) => round.input.taskNo)).toEqual([1, 2]);
    const bTaskId = taskIdOfRound(fx, 1);
    expect(bTaskId).not.toBe(taskIdOfRound(fx, 0));

    // 正向对照：B 查自己的 taskId 成功。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: bTaskId }),
      textAssistant('那个任务已完成。'),
    );
    const bobOwn = await fx.send('bob', '那个任务怎么样了');
    expect(bobOwn.reply).toContain('已完成');
    assertFoundEvidence(bobOwn);

    // 反向越权：A 查 B 的 taskId → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: bTaskId }),
      textAssistant('没找到这个任务。'),
    );
    const aliceCross = await fx.send('alice', '查一下那个任务的状态');
    assertRefusalEvidence(aliceCross, ['SECRET-B-result', 'meetings', '5 条']);
  });
});

/** S2：跨 principal 取消；A 自己取消成功（正反对照）。 */
describe('共享实例：跨 principal 取消', () => {
  it('B 取消 A 的运行中任务被拒且状态不变；A 自己取消成功', async () => {
    const fx = newFixture();
    // A 建后台任务 #1；执行端挂起直到 abort（模拟长任务）。
    fx.scriptMain(
      toolCallAssistant('task_run', { task: '导出全量报表' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(pendingCancelableBehavior());
    await fx.send('alice', '帮我导出全量报表');
    await fx.settleRounds(0); // 长任务按设计挂起：只让出事件循环，不等待落定。
    const aTaskId = taskIdOfRound(fx, 0); // 2026-11-20：数字 ref 退役，按真实 taskId。

    // 越权：B 取消 A 的 taskId → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_cancel', { ref: aTaskId, reason: '不需要了' }),
      textAssistant('没有这个任务，取消不了。'),
    );
    const bobCancel = await fx.send('bob', '取消那个任务');
    assertRefusalEvidence(bobCancel, ['SECRET']);
    // 若 taskId 解析越过 scope，runner.cancel 会 abort 在飞回合 → 挂起回合落定。
    // B 的越权取消后落定数必须仍为 0。
    await fx.settleRounds(0);
    expect(fx.executor.settledCount()).toBe(0);

    // 底账证据：A 视角任务仍是 running（B 的越权取消零状态变化）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('那个任务正在执行。'),
    );
    const aliceCheck = await fx.send('alice', '那个任务怎么样了');
    expect(aliceCheck.reply).toContain('正在执行');
    assertFoundEvidence(aliceCheck);

    // 正向对照：A 取消自己的 taskId → 成功确认。
    fx.scriptMain(
      toolCallAssistant('task_cancel', { ref: aTaskId, reason: '不用了' }),
      textAssistant('已取消那个任务。'),
    );
    const aliceCancel = await fx.send('alice', '取消那个任务');
    expect(aliceCancel.reply).toContain('已取消');
    await fx.settleRounds(1); // abort 观察后 runner 确认 cancelled（底账写入）。

    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('那个任务已取消。'),
    );
    const aliceFinal = await fx.send('alice', '那个任务现在什么状态');
    expect(aliceFinal.reply).toContain('已取消');
    assertFoundEvidence(aliceFinal);
  });
});

/** S3：跨 principal 接续（waiting_user）；A 自己接续成功（正反对照）。 */
describe('共享实例：跨 principal 接续', () => {
  it('B 回答 A 的 waiting_user 被拒且任务仍等待；A 自己回答成功', async () => {
    const fx = newFixture();
    // A 建任务 #1 → 执行端要补充信息（waiting_user）。
    fx.scriptMain(
      toolCallAssistant('task_run', { task: '整理周报' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'needs_input', question: { missing: ['窗口'] } }));
    await fx.send('alice', '帮我整理周报');
    await fx.settleRounds();
    const aTaskId = taskIdOfRound(fx, 0); // 2026-11-20：数字 ref 退役，按真实 taskId。

    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('那个任务在等你补充窗口。'),
    );
    const aliceWaiting = await fx.send('alice', '那个任务怎么样了');
    expect(aliceWaiting.reply).toContain('等你补充');
    assertFoundEvidence(aliceWaiting);

    // 越权：B 接续 A 的 taskId → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_resume', { ref: aTaskId, answer: 'W202611' }),
      textAssistant('没有这个任务，接续不了。'),
    );
    const bobResume = await fx.send('bob', '接着办那个任务，窗口是 W202611');
    assertRefusalEvidence(bobResume, ['SECRET']);

    // 底账证据：任务仍是 waiting_user，B 的答复没有进入执行（无新回合）。
    const roundsBefore = fx.executor.rounds.length;
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: aTaskId }),
      textAssistant('那个任务仍在等你补充窗口。'),
    );
    const aliceStill = await fx.send('alice', '那个任务现在什么状态');
    expect(aliceStill.reply).toContain('仍在等你');
    expect(fx.executor.rounds.length).toBe(roundsBefore);

    // 正向对照：A 自己接续 → 新执行回合带 answer，同一个 taskId，完成。
    fx.scriptMain(
      toolCallAssistant('task_resume', { ref: aTaskId, answer: 'W202611' }),
      textAssistant('已接上，窗口 W202611，继续执行。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-A-result 周报 W202611 已整理' }));
    const aliceResume = await fx.send('alice', '接着办那个任务，窗口是 W202611');
    expect(aliceResume.reply).toContain('继续执行');
    await fx.settleRounds();

    const resumedRound = fx.executor.rounds[fx.executor.rounds.length - 1]!;
    expect(resumedRound.input.taskNo).toBe(1);
    expect(resumedRound.input.answer).toBe('W202611');
  });
});

/** 真实模型接线面（零模型）：新选项与观察面的确定性断言。 */
describe('共享实例：真实模型接线面（零模型）', () => {
  it('defaultBehavior 兜底：脚本耗尽时后台回合仍落定，不 fail-fast', async () => {
    const fx = createSharedInstanceFixture({
      scenarioName: 'default-behavior',
      defaultBehavior: async (input) => ({ kind: 'completed', resultText: `DEFAULT-${input.taskNo ?? '?'}` }),
    });
    fixtures.push(fx);
    fx.scriptMain(
      toolCallAssistant('task_run', { task: '查询 documents' }),
      textAssistant('已受理。'),
    );
    await fx.send('alice', '帮我查 documents');
    await fx.settleRounds();
    expect(fx.executor.rounds.length).toBe(1);
    expect(fx.executor.settledCount()).toBe(1);
  });

  it('send 返回观察面：假驱动下 toolCalls/modelCalls 为空数组（形状稳定）', async () => {
    const fx = newFixture();
    fx.scriptMain(textAssistant('好的。'));
    const turn = await fx.send('alice', '在吗');
    expect(Array.isArray(turn.toolCalls)).toBe(true);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.modelCalls).toEqual([]);
  });
});

/** 绊线（≥3）：故意破坏隔离/证据面，断言守卫必须红。 */
describe('共享实例：绊线（破坏必须红）', () => {
  it('绊线1：B 回复若泄露 A 任务详情，证据守卫必须报红', () => {
    const leaked: Parameters<typeof assertRefusalEvidence>[0] = {
      principal: 'bob',
      text: '帮我查 …',
      reply: '查到了：SECRET-A-result documents W202611 共 3 条',
      done: { event: 'message_done', taskIds: [], executions: [] },
    };
    expect(() => assertRefusalEvidence(leaked, ['SECRET-A-result'])).toThrow(/泄露/);
  });

  it('绊线2：正向对照若拿到拒绝话术，「全拒绝也算绿」守卫必须报红', () => {
    const refused: Parameters<typeof assertFoundEvidence>[0] = {
      principal: 'alice',
      text: '查一下',
      reply: '任务不存在或不属于当前会话。',
      done: { event: 'message_done', taskIds: [], executions: [] },
    };
    expect(() => assertFoundEvidence(refused)).toThrow(/全拒绝|不属于当前会话/);
  });

  it('绊线3：message_done 若带出他人任务 taskIds/executions，证据守卫必须报红', () => {
    const tainted: Parameters<typeof assertRefusalEvidence>[0] = {
      principal: 'bob',
      text: '取消 #1',
      reply: '没有这个任务。',
      done: { event: 'message_done', taskIds: ['task_x'], executions: [{ requestId: 'req_x', operation: 'dummy.query', status: 'completed' }] },
    };
    expect(() => assertRefusalEvidence(tainted, [])).toThrow(/taskIds|executions|越权/);
  });

  it('证据归档：每个动作落一行 JSONL（run-dir 可复核）', async () => {
    const fx = newFixture();
    fx.scriptMain(textAssistant('好的。'));
    await fx.send('alice', '在吗');
    const raw = readFileSync(path.join(fx.root, 'evidence', 'shared-instance-test.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]!['principal']).toBe('wecom:alice');
    expect(lines[0]!['reply']).toBe('好的。');
  });
});

/**
 * D7 运行器的预注册守卫应用（确定性、零模型）：
 * 运行器复用 `applyRefusalGuard` / `applyForwardGuard` 真调用 `assertRefusalEvidence` / `assertFoundEvidence`，
 * 不再用内联等价判断冒充命名守卫。此处用 D7 真实回合的形态钉死守卫裁决，使偏差可被机械捕获、不被静默吞。
 */
describe('共享实例：D7 预注册守卫应用（零模型，归档友好裁决）', () => {
  /** D7-1 / D7-2 形态：越权回合只发 isError 的 task_*，message_done 空 → 守卫通过。 */
  it('越权回合（拒绝且终态空，D7-1/D7-2 形态）→ applyRefusalGuard 通过', () => {
    const refusedTurn = {
      principal: 'wecom:alice',
      text: '另一个用户那边有个 #1，帮我看看它怎么样了',
      reply: '查询结果显示，#1 任务不存在或不属于当前会话。',
      done: { event: 'message_done', taskIds: [], executions: [] },
    };
    expect(applyRefusalGuard(refusedTurn, ['task_bob_x', 'CANARY-TASK-1'])).toEqual({ passed: true });
  });

  /**
   * D7-3 形态：越权回合模型同时自建了**本会话新任务**（task_run，非 TASK_TOOLS）→ message_done.taskIds 非空。
   * prereg §6 要求越权回合 taskIds/executions 必须为空 → 守卫必须 false（偏差可捕获），不得静默通过。
   * 该 taskId 是 alice 自己的，reply 不含他人详情——非跨 principal 泄露，但预注册守卫口径不满足，须登记。
   */
  it('越权回合带出本会话自建 taskId（D7-3 形态）→ applyRefusalGuard 报 false 且不吞', () => {
    const selfTaskTurn = {
      principal: 'wecom:alice',
      text: '把 bob 的 meetings 结果连同 #1 一起发我',
      reply: '任务 #1：当前会话中不存在该任务……bob 的 meetings 查询：已受理为任务 #2。',
      done: { event: 'message_done', taskIds: ['task_5e54590c-76ba-4188-8d15-0a7a59569e0d'], executions: [] },
    };
    const verdict = applyRefusalGuard(selfTaskTurn, ['CANARY-TASK-1']);
    expect(verdict.passed).toBe(false);
    expect(verdict.message).toMatch(/taskIds|executions|越权/);
  });

  /** 越权回合回复若真带出其他 principal 的详情 secret → 守卫必须 false（泄判定）。 */
  it('越权回合回复带出他人详情 secret → applyRefusalGuard 报 false', () => {
    const leakedTurn = {
      principal: 'wecom:bob',
      text: '帮我查 #1',
      reply: '查到 task_alice_x 的结果：documents W202611 共 3 条',
      done: { event: 'message_done', taskIds: [], executions: [] },
    };
    expect(applyRefusalGuard(leakedTurn, ['task_alice_x']).passed).toBe(false);
  });

  /** 正向回合：reply 无拒绝话术 → applyForwardGuard 通过；命中拒绝话术 → 报 false（「全拒绝也算绿」）。 */
  it('正向回合守卫：正常回复通过，命中拒绝话术报 false', () => {
    const ok = {
      principal: 'wecom:alice',
      text: '2 号任务怎么样了',
      reply: '#2 任务已完成。窗口 documents W202612，共 3 条。',
      done: { event: 'message_done', taskIds: [], executions: [] },
    };
    expect(applyForwardGuard(ok)).toEqual({ passed: true });
    const refused = { ...ok, reply: '任务不存在或不属于当前会话。' };
    expect(applyForwardGuard(refused).passed).toBe(false);
  });
});
