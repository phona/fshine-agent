/**
 * R2 判定语义边界（task.status 的内部口径，2026-11-13）
 *
 * 背景：M4 的 judgeReportedTask 以「首个非 completed 执行」判定任务状态，因此：
 *   · 中间失败后恢复成功（[failed, completed]）→ 任务记 failed；
 *   · 执行层要求补充输入（needs_input）→ 任务记 failed。
 *
 * R2 核查结论（2026-11-13，先验证用户可见性再决定是否修改）：
 *   这两个口径当前**没有用户可见消费面**——
 *   · `npm run ask` 的机械证据只逐条打印 `execution.status`（scripts/ask.ts 打印 execution 事实，
 *     不打印 task.status）；
 *   · `apps/server/server.ts` 只记录逐执行状态；
 *   · M5 判定器（scripts/eval/convergence-r1/judge.ts）用执行行（T1 executions 与
 *     `executions.some(failed||refused)`）判「④任务状态一致性」，不读 task.status。
 *   因此本轮**不修改语义**（不为无消费者的字段新增宿主行为，见 decision-log §十七）。
 *
 * 本文件是**表征测试**：把当前口径钉住。未来的语义变更必须先出现用户可见消费面
 * （ask 打印任务状态 / 状态查询切片 / 后台投递 / 判定器改用 task.status），
 * 并同步更新本文件与 decision-log §十七 的裁定。
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

describe('task.status 语义边界（R2 表征测试；无用户可见消费面，暂不修改）', () => {
  it('零执行 → unexecuted（reason 说明未发起执行）', () => {
    const judged = judgeReportedTask([]);
    expect(judged.status).toBe('unexecuted');
    expect(judged.failureReason).toContain('未发起执行');
  });

  it('单条成功 → completed', () => {
    expect(judgeReportedTask([execution('completed')])).toEqual({ status: 'completed' });
  });

  it('单条 failed → failed（reason 引用执行层 message 原文）', () => {
    const judged = judgeReportedTask([execution('failed', '执行层调用超时。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('执行层调用超时');
  });

  it('单条 refused → failed（当前口径：拒绝并入失败；判定器 ④ 用执行行判拒绝，不读 task.status）', () => {
    const judged = judgeReportedTask([execution('refused', '执行层策略拒绝。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('执行层策略拒绝');
  });

  it('单条 needs_input → failed（当前口径；契约四态在 executions[].status 中如实保留）', () => {
    const judged = judgeReportedTask([execution('needs_input')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('needs_input');
  });

  it('中间失败后恢复成功（[failed, completed]）→ failed（当前口径：首个非 completed 判负；两行执行事实都保留）', () => {
    const judged = judgeReportedTask([
      execution('failed', '第一次参数错误。'),
      execution('completed'),
    ]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('第一次参数错误');
  });

  it('先成功后失败（[completed, failed]）→ failed（末次失败不得被前序成功掩盖）', () => {
    const judged = judgeReportedTask([execution('completed'), execution('failed', '第二次超时。')]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('第二次超时');
  });

  it('needs_input 后恢复成功（[needs_input, completed]）→ failed（当前口径；同上，无可见消费面）', () => {
    expect(judgeReportedTask([execution('needs_input'), execution('completed')]).status).toBe('failed');
  });
});
