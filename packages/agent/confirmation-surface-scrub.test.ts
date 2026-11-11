/**
 * 确认面（计划通知 / pending 计划 userText）的执行语言删除（T8，2026-11-11）。
 *
 * 今天败状：删除集只作用于回复面（reply-exit），确认面此前**根本不走**——平台下发的
 * scopeSummary/noticeText 原样上屏，模型/平台一侧的执行语言（脚本路径、错误码、
 * operation 名、JSON 片段、内部控制词）在"请你确认"这条帧里同样会被用户看到。
 *
 * 判据与回复面同一把尺：**过 `executionLanguageFingerprints` 零命中**，且中文可读
 * 文案逐字保留（确认门要用户看懂并回复"确认继续"）。
 */
import { describe, expect, it } from 'vitest';
import { executionLanguageFingerprints } from './src/execution-language';
import { evaluateAndActivatePlan, formatPlanMessage, type PlanEvaluation } from './src/plan-runtime';

const evaluation = (over: Partial<PlanEvaluation> = {}): PlanEvaluation => ({
  planId: 'plan_confirm',
  version: 1,
  decision: 'confirm',
  estimate: { calls: 18, seconds: 180, weight: 36 },
  delta: { addedCalls: 18 },
  cumulative: {},
  reasonCode: 'CONFIRM_THRESHOLD',
  status: 'pending',
  ...over,
});

describe('确认面执行语言删除', () => {
  it('计划通知：平台 scopeSummary 里的执行语言不上屏，中文确认话术逐字保留', () => {
    const message = formatPlanMessage(evaluation({
      scopeSummary: '18 call(s) via src/dummy/scripts/query.js (not_found) 记录，约 3 分钟。',
    }));
    expect(executionLanguageFingerprints(message)).toEqual([]);
    expect(message).toContain('记录，约 3 分钟。');
    expect(message).toContain('请回复“确认继续”后再执行；当前已暂停。');
  });

  it('计划通知：operation 名与内部控词同样不上屏', () => {
    const message = formatPlanMessage(evaluation({ noticeText: '按 finance.query-receivables 的计划门额度执行。' }));
    expect(executionLanguageFingerprints(message)).toEqual([]);
    expect(message).toContain('执行。');
  });

  it('confirm 档经 evaluateAndActivatePlan 交出的 pending.userText 与 message 都已整理', async () => {
    const result = await evaluateAndActivatePlan({
      platformRoot: '/tmp/platform',
      taskId: 'task_confirm',
      calls: [{ operation: 'dummy.query', args: ['--collection', 'alpha'] }],
      onNotice: async () => {},
      runCli: async () => ({
        code: 0,
        stdout: `${JSON.stringify({
          planId: 'plan_confirm',
          version: 3,
          decision: 'confirm',
          estimate: { calls: 18, seconds: 180, weight: 36 },
          delta: { addedCalls: 18 },
          cumulative: {},
          reasonCode: 'CONFIRM_THRESHOLD',
          status: 'pending',
          scopeSummary: '18 call(s) via src/dummy/scripts/query.js',
        })}\n`,
        stderr: '',
      }),
    });
    expect(result.status).toBe('confirm');
    if (result.status !== 'confirm') return;
    expect(executionLanguageFingerprints(result.message)).toEqual([]);
    expect(executionLanguageFingerprints(result.pending.userText)).toEqual([]);
    expect(result.message).toContain('请回复“确认继续”后再执行；当前已暂停。');
  });
});
