/**
 * 等待用户两条文本的行为绊线（2026-11-24 owner 裁定 + grok major ①）。
 *
 * 钉住三件事：
 *   ① **不写有效期**（owner：「模型可以说什么时候之前答复，不过也挺傻的，默认可以提示」）——
 *      截止时刻仍由底账机械持有（等待超时走既有 sweep → deadline_reached 通知），用户确认晚了
 *      执行层会拒、Worker 见原始拒绝自行重新提案，都不需要把时刻念给用户听；
 *   ② **沉默兜底必须带 worker 汇报原文**——提案之后执行层拒绝（GATE_REFUSE 等）时回合按
 *      「有提案且没有已完成的业务写」落等待事实（删容忍码表的直接后果，用例已冻），拒绝原因
 *      **只存在于 Worker 的汇报里**；模型醒着会转述，模型沉默时兜底文本是用户唯一能看见
 *      「为什么」的地方（grok major：此前只有提案摘要，用户可能对已被拒绝的写回「确认」）；
 *   ③ 事实文本（给模型读）与兜底文本（用户读）都不含 handle / taskId / 内部码。
 */
import { describe, expect, it } from 'vitest';
import { taskWaitingUserFactText, waitingUserFallbackText } from './task-completion-delivery';

const SUMMARY = '给 alpha 集合 W1 追加 2 条记录';
const REFUSAL_REPORT = '执行层拒绝了这次写入：当前权限不允许往 alpha 写。';
const MISSING = ['截止日', '往来单位'];

describe('等待用户两条文本', () => {
  it('不写有效期：事实文本与兜底文本都不出现「前有效」', () => {
    const fact = taskWaitingUserFactText({ missing: [], summary: SUMMARY });
    const fallback = waitingUserFallbackText({ summary: SUMMARY });
    expect(fact).not.toContain('前有效');
    expect(fallback).not.toContain('前有效');
    expect(fallback).toBe(SUMMARY);
  });

  it('旧形状调用方（JS 里多带一个 expiresAt）也渲染不出有效期', () => {
    // 编译期已禁止传 expiresAt（ excess property ）；这条守住运行期：万一有 JS 调用方或回退
    // 路径仍按旧形状多带一个字段，也不得把时刻念给用户听。
    const staleCallerShape = { summary: SUMMARY, expiresAt: '2026-11-24T09:00:00Z' } as unknown as { summary: string };
    expect(waitingUserFallbackText(staleCallerShape)).not.toContain('前有效');
    expect(waitingUserFallbackText(staleCallerShape)).toBe(SUMMARY);
  });

  it('提案被拒 + 模型沉默：兜底文本带上汇报原文（拒绝原因不再丢）', () => {
    const fallback = waitingUserFallbackText({ summary: SUMMARY, report: REFUSAL_REPORT });
    expect(fallback).toContain(SUMMARY);
    expect(fallback).toContain(REFUSAL_REPORT);
  });

  it('提案被拒：给模型的事实文本同样带上汇报原文', () => {
    const fact = taskWaitingUserFactText({ missing: [], summary: SUMMARY, report: REFUSAL_REPORT });
    expect(fact).toContain(SUMMARY);
    expect(fact).toContain(REFUSAL_REPORT);
  });

  it('缺信息类等待：没有「将写入」句，缺什么照实说', () => {
    const fact = taskWaitingUserFactText({ missing: MISSING, summary: undefined });
    expect(fact).toContain('还缺：截止日、往来单位。');
    expect(fact).not.toContain('将写入');
  });

  it('两条文本都不含句柄 / taskId / 内部码', () => {
    const fact = taskWaitingUserFactText({ missing: [], summary: SUMMARY, report: REFUSAL_REPORT });
    const fallback = waitingUserFallbackText({ summary: SUMMARY, report: REFUSAL_REPORT });
    for (const text of [fact, fallback]) {
      expect(text).not.toMatch(/task_[A-Za-z0-9-]{8,}/);
      expect(text).not.toMatch(/cfm_|cf_/);
    }
  });
});
