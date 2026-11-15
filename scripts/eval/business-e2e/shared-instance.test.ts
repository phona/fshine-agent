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

/** S1：跨 principal 查询 / 结果取回 / 编号解析；正向对照（含身份绊线的原料）。 */
describe('共享实例：跨 principal 查询与编号解析', () => {
  it('B 查/取 A 的任务 → 找不到（不泄露详情）；A 自己查 → 成功；同文本换身份结果不同', async () => {
    const fx = newFixture();
    const secret = 'SECRET-A-result';

    // A 建后台任务 #1；执行端脚本给出含敏感标记的完成结果。
    fx.scriptMain(
      toolCallAssistant('run_task', { task: '查询 documents 窗口 W202611' }),
      textAssistant('已受理，稍后给你结果。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: `${secret} documents W202611 共 3 条` }));
    await fx.send('alice', '帮我查 documents 窗口 W202611');
    await fx.settleRounds();

    // 正向对照：A 取回 #1 结果（正反对照防「全拒绝也算绿」）。
    fx.scriptMain(
      toolCallAssistant('task_result', { ref: '#1' }),
      textAssistant('1 号任务已完成：documents W202611 共 3 条。'),
    );
    const aliceResult = await fx.send('alice', '1 号任务的结果是什么');
    expect(aliceResult.reply).toContain('3 条');
    assertFoundEvidence(aliceResult);

    // 越权：B 用 A 的编号查状态 → scope 内找不到（与不存在同错，不泄露存在性）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('没找到这个任务，它不属于当前会话。'),
    );
    const bobStatus = await fx.send('bob', '查一下 #1 的状态');
    assertRefusalEvidence(bobStatus, [secret, 'documents', '3 条']);

    // 越权：B 取结果（编号解析拒绝的另一动作面）。
    fx.scriptMain(
      toolCallAssistant('task_result', { ref: '#1' }),
      textAssistant('没有这个任务，取不了结果。'),
    );
    const bobResult = await fx.send('bob', '#1 的结果发我');
    assertRefusalEvidence(bobResult, [secret, 'documents', '3 条']);

    // B 列自己的任务：空（A 的任务不在 B 的 scope 列表里）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '' }),
      textAssistant('你当前没有任务。'),
    );
    const bobList = await fx.send('bob', '我有哪些任务');
    assertRefusalEvidence(bobList, [secret, 'documents']);

    // 身份绊线原料：同一句文本（含 A 的编号）由 A 发出 → 找得到（隔离依赖身份而非文本）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('1 号任务已完成。'),
    );
    const aliceStatus = await fx.send('alice', '查一下 #1 的状态');
    expect(aliceStatus.reply).toContain('1 号');
    assertFoundEvidence(aliceStatus);
  });

  it('编号全局唯一：B 建任务拿到下一编号，B 的编号对 A 同样拒绝', async () => {
    const fx = newFixture();
    fx.scriptMain(
      toolCallAssistant('run_task', { task: '查询 documents 窗口 W202611' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-A-result' }));
    await fx.send('alice', '帮我查 documents 窗口 W202611');
    await fx.settleRounds();

    fx.scriptMain(
      toolCallAssistant('run_task', { task: '查询 meetings 列表' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-B-result meetings 5 条' }));
    const bobCreate = await fx.send('bob', '帮我查 meetings 列表');
    await fx.settleRounds();
    // 共享底账计数器：B 的任务是 #2（不是 B 自己的 #1）。
    expect(fx.executor.rounds.map((round) => round.input.taskNo)).toEqual([1, 2]);

    // 正向对照：B 查自己的 #2 成功。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#2' }),
      textAssistant('2 号任务已完成。'),
    );
    const bobOwn = await fx.send('bob', '2 号任务怎么样了');
    expect(bobOwn.reply).toContain('2 号');
    assertFoundEvidence(bobOwn);

    // 反向越权：A 查 B 的 #2 → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#2' }),
      textAssistant('没找到这个任务。'),
    );
    const aliceCross = await fx.send('alice', '查一下 #2 的状态');
    assertRefusalEvidence(aliceCross, ['SECRET-B-result', 'meetings', '5 条']);
  });
});

/** S2：跨 principal 取消；A 自己取消成功（正反对照）。 */
describe('共享实例：跨 principal 取消', () => {
  it('B 取消 A 的运行中任务被拒且状态不变；A 自己取消成功', async () => {
    const fx = newFixture();
    // A 建后台任务 #1；执行端挂起直到 abort（模拟长任务）。
    fx.scriptMain(
      toolCallAssistant('run_task', { task: '导出全量报表' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(pendingCancelableBehavior());
    await fx.send('alice', '帮我导出全量报表');
    await fx.settleRounds(0); // 长任务按设计挂起：只让出事件循环，不等待落定。

    // 越权：B 取消 #1 → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_cancel', { ref: '#1', reason: '不需要了' }),
      textAssistant('没有这个任务，取消不了。'),
    );
    const bobCancel = await fx.send('bob', '取消 #1');
    assertRefusalEvidence(bobCancel, ['SECRET']);
    // 模型无关的产品级证据：若编号解析越过 scope，runner.cancel 会 abort 在飞回合 →
    // 挂起回合落定。B 的越权取消后落定数必须仍为 0。
    await fx.settleRounds(0);
    expect(fx.executor.settledCount()).toBe(0);

    // 底账证据：A 视角任务仍是 running（B 的越权取消零状态变化）。
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('1 号任务正在执行。'),
    );
    const aliceCheck = await fx.send('alice', '1 号任务怎么样了');
    expect(aliceCheck.reply).toContain('正在执行');
    assertFoundEvidence(aliceCheck);

    // 正向对照：A 取消自己的 #1 → 成功确认。
    fx.scriptMain(
      toolCallAssistant('task_cancel', { ref: '#1', reason: '不用了' }),
      textAssistant('已取消 1 号任务。'),
    );
    const aliceCancel = await fx.send('alice', '取消 #1');
    expect(aliceCancel.reply).toContain('已取消');
    await fx.settleRounds(1); // abort 观察后 runner 确认 cancelled（底账写入）。

    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('1 号任务已取消。'),
    );
    const aliceFinal = await fx.send('alice', '#1 现在什么状态');
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
      toolCallAssistant('run_task', { task: '整理周报' }),
      textAssistant('已受理。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'needs_input', question: { missing: ['窗口'] } }));
    await fx.send('alice', '帮我整理周报');
    await fx.settleRounds();

    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('1 号任务在等你补充窗口。'),
    );
    const aliceWaiting = await fx.send('alice', '1 号任务怎么样了');
    expect(aliceWaiting.reply).toContain('等你补充');
    assertFoundEvidence(aliceWaiting);

    // 越权：B 接续 #1 → 拒绝。
    fx.scriptMain(
      toolCallAssistant('task_resume', { ref: '#1', answer: 'W202611' }),
      textAssistant('没有这个任务，接续不了。'),
    );
    const bobResume = await fx.send('bob', '接着办 #1，窗口是 W202611');
    assertRefusalEvidence(bobResume, ['SECRET']);

    // 底账证据：任务仍是 waiting_user，B 的答复没有进入执行（无新回合）。
    const roundsBefore = fx.executor.rounds.length;
    fx.scriptMain(
      toolCallAssistant('task_status', { ref: '#1' }),
      textAssistant('1 号任务仍在等你补充窗口。'),
    );
    const aliceStill = await fx.send('alice', '#1 现在什么状态');
    expect(aliceStill.reply).toContain('仍在等你');
    expect(fx.executor.rounds.length).toBe(roundsBefore);

    // 正向对照：A 自己接续 → 新执行回合带 answer，编号不变，完成。
    fx.scriptMain(
      toolCallAssistant('task_resume', { ref: '#1', answer: 'W202611' }),
      textAssistant('已接上，窗口 W202611，继续执行。'),
    );
    fx.executor.behaviors.push(outcomeBehavior({ kind: 'completed', resultText: 'SECRET-A-result 周报 W202611 已整理' }));
    const aliceResume = await fx.send('alice', '接着办 #1，窗口是 W202611');
    expect(aliceResume.reply).toContain('继续执行');
    await fx.settleRounds();

    const resumedRound = fx.executor.rounds[fx.executor.rounds.length - 1]!;
    expect(resumedRound.input.taskNo).toBe(1);
    expect(resumedRound.input.answer).toBe('W202611');
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
