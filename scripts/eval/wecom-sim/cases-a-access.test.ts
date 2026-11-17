/**
 * A 组·接入与基础（W-01～W-04b）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 机械判据（用户可见结果；模型响应脚本化、执行层真实）：
 *   W-01   闲聊 → 不委派执行层、不编造数据（message_done 的 executions 为空、回复无 dummy 数字）；
 *   W-02   documents W202611 → 报出真实 3 条（1200/800/900），不夹杂其它集合；
 *   W-03   缺对象 → 先问集合/窗口，零执行；
 *   W-04   新会话含糊指代 → 空参执行被执行层 QUERY_REQUIRED 拒 → 如实转述并请补充
 *          （与 E06 口径一致：允许 0 执行或 1 次空参失败执行；带结论数据的执行 = 不通过）；
 *   W-04b  刚查过 documents 的会话里「doc 那个表」→ 指代正确直接查（有数据，不无谓追问）。
 *
 * 说明：脚本只决定「模型这一步怎么走」（E06 允许的两条分支里取空参分支，因为它多走一遍
 * 真执行链）；回复文本由**执行层真实返回**派生（describeOutcome / Worker 摘要转述）——
 * 数字如果对不上，链条任何一环断了这里都会红。「模型会不会真的选对分支」仍归 eval:user
 * 与企微 live 人工交互面（见 docs/product/wecom-live-dummy-cases.md 文首分工）。
 */
import { describe, expect, it } from 'vitest';
import {
  mainRelayResponses,
  startWecomSim,
  textAssistant,
  workerQueryResponses,
} from './harness';

describe('A 组·接入与基础（W-01～W-04b）', () => {
  it('W-01 闲聊：零执行、不编造数据', async () => {
    const sim = await startWecomSim({ label: 'w01' });
    try {
      sim.book.mainTurn('你好，你能做什么？', [textAssistant('你好！我可以帮你查询、核对执行层里的业务数据，也可以处理你发来的表格文件。')]);
      const messageId = sim.sendText('你好，你能做什么？');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      expect(reply.trim().length).toBeGreaterThan(0);
      // 不编造数据：回复不带 dummy 才知道的具体数值。
      expect(reply).not.toContain('1200');
      expect(reply).not.toContain('800');
      expect(reply).not.toContain('900');
      // 不委派执行层：message_done 的 executions 为空。
      const done = sim.doneOf(messageId);
      expect(done).toBeDefined();
      expect(done!.executions).toHaveLength(0);
      expect(done!.taskIds).toHaveLength(0);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-02 documents W202611：真实 3 条（1200/800/900），不夹杂其它集合', async () => {
    const sim = await startWecomSim({ label: 'w02' });
    try {
      sim.book.mainTurn('帮我查一下 documents 集合 W202611 的数据', mainRelayResponses('查询 documents 集合 W202611 的记录'));
      sim.book.workerTask('查询 documents 集合 W202611 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      const messageId = sim.sendText('帮我查一下 documents 集合 W202611 的数据');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // 数字逐条对：来自执行层真实返回（items 1200/800/900、count 3）。
      expect(reply).toContain('documents W202611 共 3 条');
      expect(reply).toContain('1200');
      expect(reply).toContain('800');
      expect(reply).toContain('900');
      // 不夹杂其它集合（alpha 2 条 1200/800 与 beta 3 条 500/300/200 都不出现）。
      expect(reply).not.toContain('alpha');
      expect(reply).not.toContain('beta');
      expect(reply).not.toContain('500');
      // 执行事实：恰好一次 query completed。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(1);
      expect(done!.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-03 缺对象：先问集合与窗口，零执行', async () => {
    const sim = await startWecomSim({ label: 'w03' });
    try {
      sim.book.mainTurn('帮我查一下数据', [textAssistant('可以。你要查哪个集合、哪个窗口？比如「documents 集合 W202611」。')]);
      const messageId = sim.sendText('帮我查一下数据');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      expect(reply).toContain('集合');
      expect(reply).toContain('窗口');
      // 不瞎查：零执行。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(0);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-04 新会话含糊指代：空参执行被 QUERY_REQUIRED 拒 → 如实转述请补充，零编造', async () => {
    const sim = await startWecomSim({ label: 'w04' });
    try {
      sim.book.mainTurn('查一下那个表', mainRelayResponses('查一下那个表'));
      sim.book.workerTask('查一下那个表', workerQueryResponses('dummy.query', {}));
      const messageId = sim.sendText('查一下那个表');
      await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);

      const reply = sim.finalBubbles()[0]!.content;
      // 如实转述 + 请用户补充（空参分支：执行层 QUERY_REQUIRED 的真实拒绝被转述）。
      expect(reply).toContain('哪个集合');
      // 零编造：全文没有具体数值（数字只会来自编造的行）。
      expect(reply).not.toMatch(/\d{3,}/);
      // 允许分支的机械事实：恰好 1 次空参执行、failed（E06 口径；0 执行分支同样允许，
      // 本用例取「空参走一遍真执行链」的分支）。带结论数据的执行 = 不通过，此处无数据。
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(1);
      expect(done!.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'failed' });
      // taskIds：空参尝试也算一次交办（受理过）。
      expect(done!.taskIds).toHaveLength(1);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('W-04b 刚查过 documents：「doc 那个表」指代正确，直接查、不无谓追问', async () => {
    const sim = await startWecomSim({ label: 'w04b' });
    try {
      // 上一回合：查过 documents W202611（真实执行）。
      sim.book.mainTurn('帮我查一下 documents 集合 W202611 的数据', mainRelayResponses('查询 documents 集合 W202611 的记录'));
      sim.book.workerTask('查询 documents 集合 W202611 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      sim.sendText('帮我查一下 documents 集合 W202611 的数据');
      await sim.waitFor('第一回合终帧', () => sim.finalBubbles().length === 1);

      // 本回合：指代正确（沿用 documents W202611），直接查。
      sim.book.mainTurn('查一下 doc 那个表', mainRelayResponses('按上文继续查询 documents 集合 W202611 的记录'));
      sim.book.workerTask('按上文继续查询 documents 集合 W202611 的记录', workerQueryResponses('dummy.query', { '--collection': 'documents', '--window': 'W202611' }));
      const messageId = sim.sendText('查一下 doc 那个表');
      await sim.waitFor('第二回合终帧', () => sim.finalBubbles().length === 2);

      const reply = sim.finalBubbles()[1]!.content;
      // 指代到 documents 是正确的：有真实数据回来（= 没有因为「含糊」再问一遍）。
      expect(reply).toContain('documents W202611 共 3 条');
      expect(reply).toContain('1200');
      const done = sim.doneOf(messageId);
      expect(done!.executions).toHaveLength(1);
      expect(done!.executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
    } finally {
      await sim.close();
    }
  }, 90_000);
});
