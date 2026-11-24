/**
 * C 组·失败与边界（W-08～W-12）· 自动用例（真装配链，见 ./harness.ts）。
 *
 * 这一组最能看出「会不会编」——判据全部钉在**执行层真实失败**的如实转述上：
 *   W-08  empty-one W1 → 真实 count=0 → 如实「没有记录」，不编造行；
 *   W-09  contract-archive → 真实 COLLECTION_NOT_FOUND → 如实「不存在」，零编造；
 *   W-10  faulty-one → 真实 COLLECTION_FAULT（exit 2）→ 如实报失败，不假装成功、不给数；
 *   W-11  denied-one → 真实 GATE_REFUSE（exit 3）→ 如实转述「没有权限」，不猜数据；
 *   W-12  finance-invoices + 窗口 → 真实 WHERE_INVALID → 如实说明只能按客户筛
 *         （可筛值来自执行层真实报错里的维度声明），不硬编一个数。
 *
 * 回复文本由执行层真实返回派生（workerQueryResponses + describeOutcome）——如果执行层
 * 没有真的失败/拒绝，或者转述环节把失败说成成功，这里都会红。
 */
import { describe, expect, it } from 'vitest';
import { internalTermIn } from '../../../packages/agent/src/user-facing-failure';
import {
  mainRelayResponses,
  startWecomSim,
  workerQueryResponses,
} from './harness';

/** 一条「委派 → 真实执行 → 如实转述」的查询用例骨架。 */
async function runQueryCase(input: {
  label: string;
  userText: string;
  task: string;
  args: Record<string, string>;
  assert: (reply: string, executions: ReadonlyArray<{ operation: string; status: string }>) => void;
}): Promise<void> {
  const sim = await startWecomSim({ label: input.label });
  try {
    sim.book.mainTurn(input.userText, mainRelayResponses(input.task));
    sim.book.workerTask(input.task, workerQueryResponses('dummy.query', input.args));
    const messageId = sim.sendText(input.userText);
    await sim.waitFor('终帧出现', () => sim.finalBubbles().length === 1);
    const reply = sim.finalBubbles()[0]!.content;
    const done = sim.doneOf(messageId);
    expect(done).toBeDefined();
    input.assert(reply, done!.executions);
  } finally {
    await sim.close();
  }
}

describe('C 组·失败与边界（W-08～W-12）', () => {
  it('W-08 empty-one W1：如实「没有记录」，不编造行', async () => {
    await runQueryCase({
      label: 'w08',
      userText: 'empty-one 集合 W1 有什么数据？',
      task: '查询 empty-one 集合 W1 的记录',
      args: { '--collection': 'empty-one', '--window': 'W1' },
      assert(reply, executions) {
        expect(reply).toContain('没有记录');
        expect(reply).toContain('0 条');
        // 不编造行：dummy 已知的其它数值一个都不出现。
        expect(reply).not.toContain('1200');
        expect(reply).not.toContain('800');
        expect(reply).not.toContain('900');
        // 真实执行且 completed（空集合是确定性答案，不是失败）。
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
      },
    });
  }, 60_000);

  it('W-09 contract-archive：如实「不存在」，零编造', async () => {
    await runQueryCase({
      label: 'w09',
      userText: '查一下 contract-archive 集合 W1',
      task: '查询 contract-archive 集合 W1 的记录',
      args: { '--collection': 'contract-archive', '--window': 'W1' },
      assert(reply, executions) {
        expect(reply).toContain('contract-archive 这个集合不存在');
        // 零编造：不给任何数值行。
        expect(reply).not.toMatch(/\d{3,}/);
        // 执行层真实返回 not_found（宿主按确定性答案落地为 completed）。
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ operation: 'dummy.query', status: 'completed' });
      },
    });
  }, 60_000);

  it('W-10 faulty-one：真实 COLLECTION_FAULT → 如实报失败，不假装成功、不给数', async () => {
    await runQueryCase({
      label: 'w10',
      userText: '查一下 faulty-one 集合 W1',
      task: '查询 faulty-one 集合 W1 的记录',
      args: { '--collection': 'faulty-one', '--window': 'W1' },
      assert(reply, executions) {
        // 口径变更（2026-11-24 失败事实原样进模型面）：COLLECTION_FAULT 与原文照实给脚本
        // 模型，由它选措辞——脚本说「没办成」（如实、不假装成功），技术码不进用户文本。
        expect(reply).toContain('没办成');
        expect(reply).not.toContain('COLLECTION_FAULT');
        // 不假装成功：没有「共 N 条」式结论，没有具体数值。
        expect(reply).not.toMatch(/共 \d+ 条/);
        expect(reply).not.toMatch(/\d{3,}/);
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ operation: 'dummy.query', status: 'failed' });
      },
    });
  }, 60_000);

  it('W-11 denied-one：真实 GATE_REFUSE → 如实转述「没权限」，不猜数据', async () => {
    await runQueryCase({
      label: 'w11',
      userText: '查一下 denied-one 集合 W1',
      task: '查询 denied-one 集合 W1 的记录',
      args: { '--collection': 'denied-one', '--window': 'W1' },
      assert(reply, executions) {
        // 口径变更（2026-11-24 失败事实原样进模型面）：GATE_REFUSE 与原文照实给脚本模型，
        // 由它选措辞——脚本如实说「没权限」，原始码不进用户文本。
        expect(reply).toContain('没权限');
        expect(reply).not.toContain('GATE_REFUSE');
        expect(reply).not.toMatch(/\d{3,}/);
        // 真实拒绝（refused），不是 failed 也不是 completed。
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ operation: 'dummy.query', status: 'refused' });
      },
    });
  }, 60_000);

  it('W-12 finance-invoices 给窗口：真实 WHERE_INVALID → 如实转述条件不行，不硬编数', async () => {
    await runQueryCase({
      label: 'w12',
      userText: 'finance-invoices 集合 2026-10 窗口的数据给我',
      task: '查询 finance-invoices 集合 2026-10 窗口的数据',
      args: { '--collection': 'finance-invoices', '--window': '2026-10' },
      assert(reply, executions) {
        // 口径变更（2026-11-24 失败事实原样进模型面）：可筛值（华远/明达/新程）与英文原文
        // 现在随原始失败事实（code=WHERE_INVALID + 清洗后 message）一起进脚本模型面，由它
        // 选措辞——业务语言说清「筛选条件用不了」；技术码/英文原文/可筛值都不进用户气泡。
        expect(reply).toContain('筛');
        expect(internalTermIn(reply)).toBeUndefined();
        expect(reply).not.toContain('华远');
        expect(reply).not.toContain('明达');
        expect(reply).not.toContain('新程');
        // 不硬编一个数：去掉用户给的窗口值后，正文没有其它多位数字。
        expect(reply).not.toMatch(/共 \d+ 条/);
        expect(reply.replace('2026-10', '')).not.toMatch(/\d{3,}/);
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({ operation: 'dummy.query', status: 'failed' });
      },
    });
  }, 60_000);
});
