/**
 * `resend_artifact`（W4 重发路由的直连工具形态）：红先证用例。
 *
 * 在直连改造后的基线上，重发链路处于「读端在、写端断」的死亡状态（工具面只剩委派工具 +
 * read_skill + task_control，`turn.resendRefs` 无写入点），本文件第一组用例在接线前整组红：
 *   R1 工具面注册：装配注入开关 → resend_artifact 在场；不注入 → 不在场（缺产物库的部署
 *      不被给一个假工具）；
 *   R2 合法引用：只记账（resendRefs → AgentReply.artifactRefs）、终止本回合（零委派）、
 *      留 turn_resend_declared 审计；`#1` 与 `1` 等价、去重保序；
 *   R3 非法引用：可恢复工具错误（返回 error、不抛、零平台调用、零 artifactRefs），
 *      话术固定可行动；文件名/路径/URL/额外字段/空数组/超上限一律拒；
 *   R4 终止语义：resend 之后同一回合不可能再委派（ToolUserError 终止）。
 *
 * 判定边界（与审计 A 一致）：runtime 不 import 产物库——存在性/淘汰/字节/摘要由 handler
 * 的 resolveResendRefs 确定性回答，本文件不替它断言。
 */
import { describe, expect, it, vi } from 'vitest';
import type { TrustedContext } from '@fshine/contracts';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, type ContextTaskRunner, type SubagentTaskResult } from './src/context';
import { ScriptedTurnDriver, ToolUserError, type TurnDriver } from './src/driver';
import { createTaxAgentRuntime } from './src/runtime';
import { RESEND_DELEGATION_EXCLUSIVE } from './src/runtime-messages';
import {
  MAX_RESEND_REFS,
  RESEND_ARTIFACT_TOOL,
  RESEND_ARTIFACT_TOOL_NAME,
  RESEND_REF_SHAPE_ERROR,
  parseResendRefs,
  resendRefCapError,
} from './src/resend-tool';
import { FakeSessionRepo } from './test-helpers';

function makeCtx(overrides: Partial<TrustedContext> = {}): TrustedContext {
  return { requestId: 'req_resend', principalId: 'wecom:user_a', sessionId: 'sess_1', ...overrides };
}

function subagent(run?: ContextTaskRunner['run']): ContextTaskRunner {
  return {
    tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
    run: run ?? (async (): Promise<SubagentTaskResult> => ({ taskId: 'task_1', text: '子 Agent 完成。' })),
  };
}

function captureInfoEvents(eventName: string): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    const line = args[0];
    if (typeof line !== 'string') return;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed['event'] === eventName) events.push(parsed);
    } catch { /* 非 JSON 行忽略 */ }
  });
  return { events, restore: () => spy.mockRestore() };
}

describe('parseResendRefs：宿主侧引用形状复检（不信任 schema）', () => {
  it('合法编号：纯十进制、允许一个前导 #、trim、去重保序', () => {
    expect(parseResendRefs({ refs: ['1'] })).toEqual({ ok: true, refs: ['1'] });
    expect(parseResendRefs({ refs: ['#3'] })).toEqual({ ok: true, refs: ['3'] });
    expect(parseResendRefs({ refs: [' 2 '] })).toEqual({ ok: true, refs: ['2'] });
    expect(parseResendRefs({ refs: ['2', '#2', '1', '2'] })).toEqual({ ok: true, refs: ['2', '1'] });
    expect(parseResendRefs({ refs: ['1', '2', '3'] })).toEqual({ ok: true, refs: ['1', '2', '3'] });
  });

  it('非编号字符串一律拒：文件名 / 路径 / URL / 空串 / 双 # / 非字符串元素', () => {
    for (const args of [
      { refs: ['工资表.xlsx'] },
      { refs: ['/tmp/x.xlsx'] },
      { refs: ['https://example.com/a.xlsx'] },
      { refs: [''] },
      { refs: ['##1'] },
      { refs: ['1a'] },
      { refs: [1] },
      { refs: [null] },
      { refs: [{ ref: '1' }] },
    ]) {
      expect(parseResendRefs(args), JSON.stringify(args)).toEqual({ ok: false, error: RESEND_REF_SHAPE_ERROR });
    }
  });

  it('容器形状错误：空数组 / 非数组 / 非对象 / 额外字段（身份、payload）', () => {
    for (const args of [
      { refs: [] },
      { refs: '1' },
      { refs: { 0: '1' } },
      {},
      '1',
      null,
      { refs: ['1'], principalId: 'wecom:someone_else' },
      { refs: ['1'], path: '/tmp/x.xlsx' },
    ]) {
      expect(parseResendRefs(args), JSON.stringify(args)).toEqual({ ok: false, error: RESEND_REF_SHAPE_ERROR });
    }
  });

  it('去重后仍超上限才拒：上限内重复项折叠，超过上限给独立可行动话术', () => {
    expect(parseResendRefs({ refs: ['1', '1', '1', '1'] })).toEqual({ ok: true, refs: ['1'] });
    const over = Array.from({ length: MAX_RESEND_REFS + 1 }, (_, index) => String(index + 1));
    expect(parseResendRefs({ refs: over })).toEqual({ ok: false, error: resendRefCapError(MAX_RESEND_REFS + 1) });
  });
});

describe('resend_artifact：runtime 工具面与回合语义', () => {
  it('R1 工具面注册由装配注入决定：注入在场、不注入不在场（缺产物库的部署不给假工具）', async () => {
    const surfaces: string[][] = [];
    const driver: TurnDriver = {
      run: async (input) => {
        surfaces.push(input.tools.map((tool) => tool.name));
        return { text: '你好。', messages: input.messages };
      },
    };
    const base = { driver, sessions: new FakeSessionRepo(), platformTask: subagent() };

    await createTaxAgentRuntime({ ...base }).handleTurn(makeCtx({ requestId: 'req_without' }), '你好');
    await createTaxAgentRuntime({ ...base, resendArtifactTool: RESEND_ARTIFACT_TOOL }).handleTurn(makeCtx({ requestId: 'req_with' }), '你好');

    expect(surfaces[0]).not.toContain(RESEND_ARTIFACT_TOOL_NAME);
    expect(surfaces[1]).toContain(RESEND_ARTIFACT_TOOL_NAME);
  });

  it('R2 合法引用：只记账零委派、终止回合、留审计事件，#N 与 N 等价且去重保序', async () => {
    const run = vi.fn(async (): Promise<SubagentTaskResult> => ({ taskId: 'task_never', text: '不应被调用' }));
    const audit = captureInfoEvents('turn_resend_declared');
    try {
      const runtime = createTaxAgentRuntime({
        driver: ScriptedTurnDriver([{ toolCalls: [{ tool: RESEND_ARTIFACT_TOOL_NAME, args: { refs: ['2', '#2', '1'] } }] }]),
        sessions: new FakeSessionRepo(),
        platformTask: subagent(run),
        resendArtifactTool: RESEND_ARTIFACT_TOOL,
      });

      const reply = await runtime.handleTurn(makeCtx(), '把那个表再发一次');

      expect(run).not.toHaveBeenCalled();                              // 零委派：重发不触平台
      expect(reply.artifactRefs).toEqual(['2', '1']);                  // 去重保序
      expect(reply.text).toBe('重发产物 #2、#1。');                    // terminate：占位文本，由 handler 合成正式回复
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({ requestId: 'req_resend', refs: ['2', '1'] });
    } finally {
      audit.restore();
    }
  });

  it('R2b 落库文本即终止文本（转录不夹带模型续写）', async () => {
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: RESEND_ARTIFACT_TOOL_NAME, args: { refs: ['1'] } }] }, { text: '不应到达' }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      resendArtifactTool: RESEND_ARTIFACT_TOOL,
    });

    const reply = await runtime.handleTurn(makeCtx(), '重发 1 号');

    expect(reply.text).toBe('重发产物 #1。');
    expect(reply.text).not.toContain('不应到达');
  });

  it('R3 非法引用：可恢复工具错误（返回 error 不抛），零平台调用、零 artifactRefs', async () => {
    for (const refs of [['工资表.xlsx'], ['/tmp/x.xlsx'], [], ['1', 'a']]) {
      const run = vi.fn(async (): Promise<SubagentTaskResult> => ({ taskId: 'task_never', text: '不应被调用' }));
      const outcomes: unknown[] = [];
      const driver: TurnDriver = {
        run: async (input) => {
          outcomes.push(await input.exec(RESEND_ARTIFACT_TOOL_NAME, { refs }));
          return { text: '知道了。', messages: input.messages };
        },
      };
      const runtime = createTaxAgentRuntime({
        driver,
        sessions: new FakeSessionRepo(),
        platformTask: subagent(run),
        resendArtifactTool: RESEND_ARTIFACT_TOOL,
      });

      const reply = await runtime.handleTurn(makeCtx(), '把表再发一次');

      expect(outcomes[0], JSON.stringify(refs)).toEqual({ error: RESEND_REF_SHAPE_ERROR });
      expect(run).not.toHaveBeenCalled();
      expect(reply.artifactRefs ?? []).toEqual([]);
      expect(reply.text).toBe('知道了。');
    }
  });

  it('R3c 超过上限：同样可恢复，话术独立（元素合法、只是给多了）', async () => {
    const outcomes: unknown[] = [];
    const driver: TurnDriver = {
      run: async (input) => {
        outcomes.push(await input.exec(RESEND_ARTIFACT_TOOL_NAME, { refs: ['1', '2', '3', '4'] }));
        return { text: '知道了。', messages: input.messages };
      },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      resendArtifactTool: RESEND_ARTIFACT_TOOL,
    });

    const reply = await runtime.handleTurn(makeCtx(), '把四个表都再发一次');

    expect(outcomes[0]).toEqual({ error: resendRefCapError(4) });
    expect(reply.artifactRefs).toBeUndefined();
  });

  it('R3b 额外字段与身份字段一律拒（模型不能借参数夹带 principal/session）', async () => {
    const outcomes: unknown[] = [];
    const driver: TurnDriver = {
      run: async (input) => {
        outcomes.push(await input.exec(RESEND_ARTIFACT_TOOL_NAME, { refs: ['1'], principalId: 'wecom:other' }));
        return { text: '好。', messages: input.messages };
      },
    };
    const runtime = createTaxAgentRuntime({
      driver,
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      resendArtifactTool: RESEND_ARTIFACT_TOOL,
    });

    const reply = await runtime.handleTurn(makeCtx(), '重发 1 号');

    expect(outcomes[0]).toEqual({ error: RESEND_REF_SHAPE_ERROR });
    expect(reply.artifactRefs).toBeUndefined();
  });

  it('R5 会话已有在册任务时重发仍可用：RR1 重复提问门不吞 artifactRefs', async () => {
    const platformTasks = {
      listBySession: async () => [{
        taskId: 'task_existing', parentSessionId: 'sess_1', principalId: 'wecom:user_a',
        workerMessages: [], createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
      }],
    };
    const runtime = createTaxAgentRuntime({
      driver: ScriptedTurnDriver([{ toolCalls: [{ tool: RESEND_ARTIFACT_TOOL_NAME, args: { refs: ['1'] } }] }]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(),
      platformTasks: platformTasks as never,
      resendArtifactTool: RESEND_ARTIFACT_TOOL,
    });

    const reply = await runtime.handleTurn(makeCtx(), '把刚才那个表再发一次');

    // 重发终止文本不含数字结论：重复提问门不命中，refs 照常交回 handler。
    expect(reply.text).toBe('重发产物 #1。');
    expect(reply.artifactRefs).toEqual(['1']);
  });

  // ── R4 同回合互斥（2026-11-12 用户裁定 4）：两种顺序都不许出现"已委派却报告成零委派" ──
  // 机制只用现有回合状态：turn.intent（宿主持有的委派事实）= 本回合已发生委派的瞬时标记。
  // 不新增状态存储、不假装执行可撤销；副作用（worker 调用、审计事件）如实保留。

  it('R4a resend_artifact → run_task：重发终止本回合，委派不可能执行（零平台调用）', async () => {
    const run = vi.fn(async (): Promise<SubagentTaskResult> => ({ taskId: 'task_never', text: '不应被调用' }));
    const runtime = createTaxAgentRuntime({
      // 模型脚本：先重发、再想委派——生产驱动在重发的 ToolUserError 上终止回合，
      // 第二步根本不会被执行。任何一步真到达 worker 都说明互斥被破坏。
      driver: ScriptedTurnDriver([
        { toolCalls: [{ tool: RESEND_ARTIFACT_TOOL_NAME, args: { refs: ['1'] } }] },
        { toolCalls: [{ tool: 'run_task', args: { request: '查询幻东的应收账款余额' } }] },
      ]),
      sessions: new FakeSessionRepo(),
      platformTask: subagent(run),
      resendArtifactTool: RESEND_ARTIFACT_TOOL,
    });

    const reply = await runtime.handleTurn(makeCtx(), '把那个表再发一次，顺便也查一下幻东');

    expect(run).not.toHaveBeenCalled();
    expect(reply.text).toBe('重发产物 #1。');
    expect(reply.artifactRefs).toEqual(['1']);
  });

  it('R4b run_task → resend_artifact：重发被拒、refs 不记账，委派副作用如实保留', async () => {
    const run = vi.fn(async (): Promise<SubagentTaskResult> => ({
      taskId: 'task_delegated',
      text: '还缺少查询范围。',
      needs: { missing: ['查询范围'], reason: '请求里没有给出范围' },
    }));
    const resendAudit = captureInfoEvents('turn_resend_declared');
    const delegationAudit = captureInfoEvents('turn_delegation');
    const outcomes: unknown[] = [];
    try {
      const driver: TurnDriver = {
        run: async (input) => {
          // 第一步委派（needs 交还，回合继续）；第二步模型尝试重发。
          outcomes.push(await input.exec('run_task', { request: '查询幻东的应收账款' }));
          outcomes.push(await input.exec(RESEND_ARTIFACT_TOOL_NAME, { refs: ['1'] }));
          return { text: '先补范围；要重发就下一轮单独说。', messages: input.messages };
        },
      };
      const runtime = createTaxAgentRuntime({
        driver,
        sessions: new FakeSessionRepo(),
        platformTask: subagent(run),
        resendArtifactTool: RESEND_ARTIFACT_TOOL,
      });

      const reply = await runtime.handleTurn(makeCtx(), '查一下幻东的应收，并把上次的表再发一次');

      // 委派真实发生（副作用与审计如实保留，不假装可撤销）
      expect(run).toHaveBeenCalledTimes(1);
      expect(delegationAudit.events).toHaveLength(1);
      // 重发被拒（可恢复工具错误）：不记账、不终止、不复述占用整轮
      expect(outcomes[1]).toEqual({ error: RESEND_DELEGATION_EXCLUSIVE });
      expect(resendAudit.events).toHaveLength(0);
      // 已发生委派的回合不得报告成零委派：不返回 artifactRefs（那会走纯重发回执路径）
      expect(reply.artifactRefs).toBeUndefined();
      expect(reply.text).toBe('先补范围；要重发就下一轮单独说。');
    } finally {
      resendAudit.restore();
      delegationAudit.restore();
    }
  });
});
