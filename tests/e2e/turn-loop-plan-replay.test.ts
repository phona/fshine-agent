// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：计划模式的"复读"外发缺口（F4）。共享替身见 ./harness.ts。
 *
 * 真实平台 2026-09 实测形状：两步计划、两步都零执行无 needs（worker 把方案当文本打印），
 * 模型最后把上一条工具结果**原样**当回复。那段 JSON 是宿主与 Main Agent 之间的内部协议
 * 材料（子任务编号、「不要转述给用户」的 next 提示）——宿主必须用自己的步骤事实汇总顶上，
 * 一个字协议材料都不能到用户眼前。
 *
 * 这里的 Main Agent 替身因此不复刻"聪明模型"，只复刻那个坏习惯：脚本派完后把最后一条
 * 工具结果 JSON.stringify 之后当回复文本。
 */
import { describe, expect, it } from 'vitest';
import { boot, gatedWorker, resolveDelegateToolName, totalActualCalls, type WorkerStep } from './harness';

/** 记录 worker 实际收到的委派请求（宿主透传剥掉协议前缀的 request）。 */
function recordingWorker(script: WorkerStep[]) {
  const inner = gatedWorker(script);
  const requests: string[] = [];
  return {
    requests,
    driver: {
      run: async (input: { sessionId?: string; messages: Array<{ role: string; content: string }> }) => {
        requests.push(String(input.messages.at(-1)?.content ?? ''));
        return inner.run(input as never);
      },
    },
  };
}

/**
 * 复读型 Main Agent：按脚本逐步申报 delegate（第 2 步起带上一步的子任务编号），
 * 脚本派完后把最后一条工具结果原样当回复——不停在工具结果上再说话。
 */
function replayMainDriver(requests: readonly string[]) {
  let cursor = 0;
  let lastTaskId = '';
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      // 直连工具面：委派工具从 input.tools 动态解析（缺省 run_task，实例可改名）
      const delegateTool = resolveDelegateToolName(input.tools as Array<{ name: string }>);
      const transcript: unknown[] = [...input.messages];
      for (;;) {
        const request = requests[Math.min(cursor, requests.length - 1)]!;
        cursor += 1;
        const callId = `call_${cursor}`;
        const callArgs: Record<string, unknown> = { request };
        if (cursor > 1 && lastTaskId) callArgs['taskId'] = lastTaskId;
        transcript.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: delegateTool, arguments: callArgs }],
          timestamp: Date.now(),
        } as never);
        let outcome: unknown;
        try {
          outcome = await input.exec(delegateTool, callArgs);
        } catch (error) {
          transcript.push({
            role: 'toolResult', toolCallId: callId, toolName: delegateTool,
            content: [{ type: 'text', text: (error as Error).message }], timestamp: Date.now(),
          } as never);
          return { text: (error as Error).message, messages: transcript };
        }
        const observedTaskId = (outcome as { taskId?: unknown } | null)?.taskId;
        if (typeof observedTaskId === 'string') lastTaskId = observedTaskId;
        const serialized = JSON.stringify(outcome);
        transcript.push({
          role: 'toolResult', toolCallId: callId, toolName: delegateTool,
          content: [{ type: 'text', text: serialized }], timestamp: Date.now(),
        } as never);
        // 脚本耗尽：把最后一条工具结果原样当回复（复读）
        if (cursor >= requests.length) return { text: serialized, messages: transcript };
      }
    },
  };
}

describe('[L4 集成] 离线全链 e2e：计划模式复读的外发兜底', () => {
  it('F4 两步零执行后模型复读工具结果：协议 JSON 不外发，用户收到步骤事实汇总', async () => {
    const before = totalActualCalls();
    const worker = recordingWorker([
      // 两步都只打印文本：无计划提交、无平台调用、无 needs（真实平台实测的空转形状）
      { text: '这一步没有发起任何平台调用。' }, { end: true },
      { text: '这一步没有发起任何平台调用。' }, { end: true },
      { text: '这一步不应该再被派发。' }, { end: true },
    ]);
    const { send, assembly } = await boot({
      main: replayMainDriver([
        '第1/2步：查幻辰财税账套 202606 的应收账款余额',
        '第2/2步：查幻东建材账套 202609 的应收账款余额',
      ]),
      worker: worker.driver,
    });

    const reply = await send('逐个核对这两个账套的应收余额');

    // 两步都派了（第 2 步带 taskId 续跑同一个子任务），两步都零执行
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[0]).not.toContain('第1/2步');
    // 回复只说步骤事实与下一步：内部协议材料一个字都不外发
    expect(reply).toContain('本轮拆解的进度如下');
    expect(reply).toContain('本次拆解没有执行成功的步骤');
    expect(reply).toContain('没有产生平台执行的步骤：第 1/2 步、第 2/2 步');
    expect(reply).toContain('可以回复“继续”重跑未完成的步骤');
    expect(reply).not.toContain('recorded');
    expect(reply).not.toContain('task_');
    expect(reply).not.toContain('continueTaskId');
    expect(reply).not.toContain('不要转述给用户');
    expect(reply).not.toContain('"step"');
    // 平台侧一次调用都没发生：汇总陈述的是事实，不是查到的数据
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });
});
