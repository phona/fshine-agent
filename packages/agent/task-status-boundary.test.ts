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
import { RUN_JS_TOOL } from './src/execution-runtime';
import { judgeReportedTask, RUN_JS_OPERATION, type ExecutionRecord } from './src/task-registry';

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

  it('执行层失败后脚本成功（[failed, run_js completed]）→ failed（2026-11-21 修：宿主脚本不是业务决定，不得把没办成收成办成）', () => {
    // Grok 审查 blocking 的同形缺口（inline 面）：run_js 是宿主脚本执行，不是执行层业务写。
    // 末条是成功脚本时，旧实现把前面的执行层失败整体收成 completed（用户侧把没办成看成办成）。
    const judged = judgeReportedTask([
      execution('failed', '写失败原文。'),
      execution('completed', undefined, 'run_js'),
    ]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('写失败原文');
  });

  it('needs_input 后脚本成功（[needs_input, run_js completed]）→ failed（reason 保留 needs_input 机械事实，不被脚本盖住）', () => {
    const judged = judgeReportedTask([
      execution('needs_input'),
      execution('completed', undefined, 'run_js'),
    ]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('needs_input');
  });

  it('纯脚本重试（[run_js failed, run_js completed]）→ completed（脚本之间仍按末条决定，不误伤重试）', () => {
    const judged = judgeReportedTask([
      execution('failed', '第一次脚本报错。', 'run_js'),
      execution('completed', undefined, 'run_js'),
    ]);
    expect(judged.status).toBe('completed');
  });

  it('脚本自我决定（[run_js completed]→completed、[run_js failed]→failed）：纯脚本回合语义不变', () => {
    expect(judgeReportedTask([execution('completed', undefined, 'run_js')]).status).toBe('completed');
    const failed = judgeReportedTask([execution('failed', '脚本非零退出。', 'run_js')]);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('脚本非零退出');
  });

  it('业务成功后脚本失败（[completed, run_js failed]）→ failed（inline 拿不到读写集合的已登记局限；与后台执行器的分类差不同，保持既有口径）', () => {
    // inline 只有执行事实投影，无法区分「completed 是只读查询还是写」——查询成功 + 脚本失败
    // 必须判 failed（runtime-worker-run-js 的「不再假绿」冻结用例）。因此本修复在 inline
    // 只收「成功脚本盖住前面失败」这一个方向；「写成功 + 脚本失败」的收窄只在知道只读集合的
    // 后台执行器里发生（同文件上方注释「局限（如实登记）」）。
    const judged = judgeReportedTask([
      execution('completed'),
      execution('failed', '脚本非零退出。', 'run_js'),
    ]);
    expect(judged.status).toBe('failed');
    expect(judged.failureReason).toContain('脚本非零退出');
  });

  it('run_js 操作名两个模块同值的机械钉子（下层模块不反向 import，靠此测试防漂移）', () => {
    // task-registry 的 RUN_JS_OPERATION 与 execution-runtime 的 RUN_JS_TOOL 必须同值：
    // 任一侧改名/换字面量而另一侧没跟 → 本用例必红（上面所有 run_js 判定都建立在这个同值上）。
    expect(RUN_JS_OPERATION).toBe(RUN_JS_TOOL);
    expect(RUN_JS_TOOL).toBe('run_js');
  });
});
