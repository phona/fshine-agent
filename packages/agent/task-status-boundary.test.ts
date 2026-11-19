/**
 * R2 判定语义边界（task.status 的内部口径，2026-11-13）；2026-11-19 按「末次决定性结果」修订。
 *
 * 背景：M4 的 judgeReportedTask 曾以「首个非 completed 执行」判定任务状态，因此
 *   · 中间失败后恢复成功（[failed, completed]）→ 任务记 failed；
 *   · 执行层要求补充输入（needs_input）→ 任务记 failed。
 *
 * R2 核查结论（2026-11-13）：这两个口径当时**没有用户可见消费面**，本轮不修改语义，
 * 以表征测试钉住；**复评触发条件**（出现任一）：ask 打印任务状态 / 状态查询切片 /
 * 后台投递 / 判定器改用 task.status。
 *
 * 复评记录：
 *   · 2026-11-14（P1 任务查看切片）：触发条件之一达成，裁定「保持既有语义」（`npm run tasks`
 *     只读消费写入时的判定，不在读时重算）；
 *   · 2026-11-19（owner 修法；真模型写闭环实跑缺陷）：确认回合里「先参数错、后改对成功」的写
 *     被整体判 failed——数据已落库（句柄被消耗）却告知「没办成」并引导重试（重复写风险；
 *     5 次实跑复现 2 次），且后台完成投递按这个终态走。裁定改为**末次决定性结果为准**：
 *     末条执行事实 completed → completed（前序失败仍逐条留在 executions 里，不改写终局）；
 *     末条非 completed → failed（原因取末条原文）。「只要有一次成功过就算成功」不成立。
 *     后台单回合执行器同改（且它有只读集合，以「末条非只读」为准）；
 *     反向绊线：用例见 `packages/agent/write-outcome-last-attempt.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { judgeReportedTask, type ExecutionRecord } from './src/task-registry';

function execution(
  status: ExecutionRecord['status'],
  message?: string,
  operation = 'dummy.query',
): ExecutionRecord {
  return {
    requestId: 'req_00000000-0000-4000-8000-000000000000',
    operation,
    status,
    ...(message === undefined ? {} : { error: { code: 'TEST_CODE', message } }),
  };
}

describe('task.status 语义边界（R2 表征测试；2026-11-19 按末次决定性结果修订）', () => {
  it('零执行 → unexecuted（reason 说明没有实际办理）', () => {
    const judged = judgeReportedTask([]);
    expect(judged.status).toBe('unexecuted');
    expect(judged.failureReason).toContain('没有实际办理');
  });

  it('单条成功 → completed', () => {
    expect(judgeReportedTask([execution('completed')])).toEqual({ status: 'completed' });
  });

  it('单条 failed → failed（reason 引用执行层 message 原文）', () => {
    const judged = judgeReportedTask([execution('failed', '执行层调用超时。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('执行层调用超时');
  });

  it('单条 refused → failed（拒绝并入失败；执行行仍如实保留 refused）', () => {
    const judged = judgeReportedTask([execution('refused', '执行层策略拒绝。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('执行层策略拒绝');
  });

  it('单条 needs_input → failed（needs_input 不作成功；执行行如实保留该状态）', () => {
    const judged = judgeReportedTask([execution('needs_input')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('needs_input');
  });

  it('中间失败后恢复成功（[failed, completed]）→ completed（2026-11-19 修订：末次决定性结果为准；两行执行事实都保留）', () => {
    const judged = judgeReportedTask([
      execution('failed', '第一次参数错误。'),
      execution('completed'),
    ]);
    expect(judged.status).toBe('completed');
    expect(judged.failureReason).toBeUndefined();
  });

  it('先成功后失败（[completed, failed]）→ failed（末次失败不得被前序成功掩盖）', () => {
    const judged = judgeReportedTask([execution('completed'), execution('failed', '第二次超时。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('第二次超时');
  });

  it('needs_input 后恢复成功（[needs_input, completed]）→ completed（2026-11-19 修订：末条是成功即成功）', () => {
    expect(judgeReportedTask([execution('needs_input'), execution('completed')]).status).toBe('completed');
  });
});
