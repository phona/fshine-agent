import { describe, expect, it } from 'vitest';
import type { SubagentTaskResult } from './src/context';
import type { PlanStepLabel } from './src/plan-steps';
import type { SelectionClarification } from './src/platform-contract';
import {
  renderClarificationToolResult,
  renderNeedsToolResult,
  renderNeedsUserText,
  renderPlanStepToolResult,
} from './src/turn-relay';

/**
 * turn-relay 模块的 golden（R1：搬移前钉住当前输出）。
 *
 * 这些渲染器都是"事实进 → 文本出"的确定性函数：替身输入 → 断言完整输出字符串，
 * 不碰 driver harness（R3）。搬移进 src/turn-relay.ts 后，本文件只改 import 路径，
 * 断言一条不改。
 */

function step(overrides: Partial<PlanStepLabel> = {}): PlanStepLabel {
  return { stepIndex: 2, totalSteps: 3, label: '第 2/3 步', request: '查一下这个月的范围', ...overrides };
}

function result(overrides: Partial<SubagentTaskResult> = {}): SubagentTaskResult {
  return { taskId: 'task_9', text: '平台查完了。', ...overrides };
}

const AMBIGUOUS: SelectionClarification = {
  code: 'ACCOUNT_SET_AMBIGUOUS',
  query: '幻辰',
  candidates: ['幻辰财税', '幻辰科技'],
};

describe('renderClarificationToolResult', () => {
  it('内部协议材料：码 + 候选数 + 任务编号 + 不要复述', () => {
    expect(renderClarificationToolResult(AMBIGUOUS, 'task_42')).toBe([
      '平台返回选择类状态 ACCOUNT_SET_AMBIGUOUS（候选 2 个），宿主已把澄清问题直接发给用户。',
      '继续该子任务时使用这个编号：task_42（不要转述给用户）。用户回答后重新申报 delegate，把该编号填进 continueTaskId，request 写用户选定的对象。',
      '本轮不要再委派、不要自己复述澄清问题。',
    ].join('\n'));
  });
});

describe('renderNeedsToolResult', () => {
  it('缺什么 / 为什么 / 建议提供什么 + 任务编号 + 重派提示 + worker 说明', () => {
    expect(renderNeedsToolResult(
      { missing: ['查询范围'], reason: '平台要求必须指定范围', suggestion: '请补充具体月份' },
      'task_7',
      '子 Agent 的说明文本',
    )).toBe([
      '子 Agent 本轮没有执行平台查询，还缺少信息：查询范围。',
      '原因：平台要求必须指定范围',
      '建议用户提供：请补充具体月份',
      '继续该子任务时使用这个编号：task_7（不要转述给用户）。用户补充信息后，重新申报 delegate，把该编号填进 continueTaskId，request 写补充后的完整请求。',
      '能自己补齐就直接补齐后重派（实体只能从当前消息、宿主注入的检索证据或本轮平台响应里取），补不齐再申报 conversation 把问题转达给用户。',
      '子 Agent 的说明：子 Agent 的说明文本',
    ].join('\n'));
  });

  it('missing 为空记（未指明）；无 suggestion / 无 worker 说明时对应行不出现', () => {
    expect(renderNeedsToolResult({ missing: [], reason: '缺少必要信息' }, 'task_7', '')).toBe([
      '子 Agent 本轮没有执行平台查询，还缺少信息：（未指明）。',
      '原因：缺少必要信息',
      '继续该子任务时使用这个编号：task_7（不要转述给用户）。用户补充信息后，重新申报 delegate，把该编号填进 continueTaskId，request 写补充后的完整请求。',
      '能自己补齐就直接补齐后重派（实体只能从当前消息、宿主注入的检索证据或本轮平台响应里取），补不齐再申报 conversation 把问题转达给用户。',
    ].join('\n'));
  });
});

describe('renderNeedsUserText', () => {
  it('转达给用户：缺什么 / 为什么 / 建议提供什么，零内部机制字样', () => {
    expect(renderNeedsUserText(
      { missing: ['查询范围'], reason: '平台要求必须指定范围', suggestion: '请补充具体月份' },
      '补充说明。',
    )).toBe([
      '补充说明。',
      '',
      '还缺少：查询范围。',
      '原因：平台要求必须指定范围',
      '建议提供：请补充具体月份',
    ].join('\n'));
  });

  it('worker 文本纯空白时不留空段', () => {
    expect(renderNeedsUserText({ missing: ['查询范围'], reason: '平台要求必须指定范围' }, '  '))
      .toBe('还缺少：查询范围。\n原因：平台要求必须指定范围');
  });

  it('三个字段全空时返回空串', () => {
    expect(renderNeedsUserText({ missing: [], reason: '', suggestion: '' }, '')).toBe('');
  });
});

describe('renderPlanStepToolResult', () => {
  it('有执行痕迹的一步：outcome=ok，next 指向下一步', () => {
    expect(renderPlanStepToolResult(step(), result({
      text: '平台查完了。\n\n〔本轮执行面：finance.query-receivables〕',
      execution: { planId: 'plan_req_plan', version: 1, calls: 2 },
    }))).toEqual({
      recorded: 'delegate',
      step: '第 2/3 步',
      stepIndex: 2,
      totalSteps: 3,
      taskId: 'task_9',
      executed: true,
      text: '平台查完了。',
      outcome: 'ok',
      next: '继续申报下一步：request 以「第3/3步：」开头，continueTaskId 填 task_9（不要转述给用户）。任一步失败都不阻塞后续步骤。',
    });
  });

  it('needs 优先于 execution：outcome=needs 且带结构化线索', () => {
    const rendered = renderPlanStepToolResult(step(), result({
      needs: { missing: ['查询范围'], reason: '平台要求必须指定范围' },
      execution: { planId: 'plan_req_plan', version: 1, calls: 2 },
    }));
    expect(rendered.outcome).toBe('needs');
    expect(rendered.executed).toBe(true);
    expect(rendered.needs).toEqual({ missing: ['查询范围'], reason: '平台要求必须指定范围' });
  });

  it('选择类澄清记 needs（缺的是"用户选哪个"，与缺参数同族）', () => {
    expect(renderPlanStepToolResult(step(), result({ clarification: AMBIGUOUS })).outcome).toBe('needs');
  });

  it('停在用户确认门：outcome=pending_confirmation，executed=false', () => {
    const rendered = renderPlanStepToolResult(step(), result({
      pendingPlan: { planId: 'plan_req_plan', version: 1, taskId: 'task_9', decision: 'confirm', userText: '需要确认', evaluation: {} as never },
    }));
    expect(rendered.outcome).toBe('pending_confirmation');
    expect(rendered.executed).toBe(false);
  });

  it('零执行：outcome=no_execution', () => {
    expect(renderPlanStepToolResult(step(), result()).outcome).toBe('no_execution');
  });

  it('最后一步的 next 让模型输出汇总', () => {
    const rendered = renderPlanStepToolResult(step({ stepIndex: 3, totalSteps: 3, label: '第 3/3 步' }), result());
    expect(rendered.next).toBe('全部 3 步已派发完毕：申报 conversation 输出汇总。汇总必须覆盖每一步的结果；失败或缺信息的步骤如实报告，不要掩盖，也不要用估计值填充。');
  });
});
