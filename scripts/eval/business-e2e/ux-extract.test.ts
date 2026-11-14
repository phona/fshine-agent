/**
 * UX/行为抽取器测试（业务 E2E 阶段 2·R2 修复 ②，TDD 先红）——**零真实模型**。
 *
 * R1 本批这些字段全 null=不可得（报告 §3.4）；本批从证据机械抽取并可测：
 *   · needlessClarifications / userInterventions / notifications 计数（UX，只统计）；
 *   · partialFailureReportedHonestly（行为，证据启发式）；
 *   · clarificationNecessary（行为：场景必要性 × 证据是否澄清）。
 * 纪律：回复面启发式标 `heuristic:true`（observations），不冒充确定性结论。
 */
import { describe, expect, it } from 'vitest';
import { bizCases } from '../exploration/bizprobe/cases';
import { asksClarificationHeuristic, buildSampleRecord, clarificationTurns } from './sample-from-run';
import type { NotificationLine } from './collect';
import type { ReplyLine, ToolCallRecord } from '../convergence-r1/evidence';

const B01 = bizCases[0]!; // 单集合，clarification='forbidden'
const B03 = bizCases[2]!; // 历史范围扩展，clarification='expected'
const B04 = bizCases[3]!; // 限流与部分完成，clarification='forbidden'

const reply = (text: string): ReplyLine => ({ turn: 1, text, sha256: '' });
const queryCall = (collection: string, window: string): ToolCallRecord => ({
  turn: 1, agent: 'worker', seq: 1, tool: 'execute_operation',
  args: { operation: 'dummy.query', args: { collection, window } },
  result: { status: 'completed' }, startedAt: '2026-11-14T00:00:00Z', elapsedMs: 1,
});

describe('asksClarificationHeuristic（回复面启发式）', () => {
  it('问号 / 澄清措辞 → true；纯陈述 → false', () => {
    expect(asksClarificationHeuristic('请问你要核对哪个集合？')).toBe(true);
    expect(asksClarificationHeuristic('你是想看 alpha 还是 beta？')).toBe(true);
    expect(asksClarificationHeuristic('需要我核对上月吗')).toBe(true);
    expect(asksClarificationHeuristic('已核对 alpha 的 W1：共 2 条记录。')).toBe(false);
    expect(asksClarificationHeuristic('')).toBe(false);
  });

  it('clarificationTurns 按轮计数', () => {
    expect(clarificationTurns([reply('已核对完成。'), reply('要哪个？')])).toHaveLength(1);
  });
});

describe('buildSampleRecord：行为/UX 从证据抽取（R1 全 null → 本批可测）', () => {
  it('禁止澄清场景里澄清 → needlessClarifications=1、userInterventions≥1、clarificationNecessary=false', () => {
    const sample = buildSampleRecord({ caseDef: B01, toolCalls: [queryCall('alpha', 'W1')], replies: [reply('请问你要核对哪个窗口？')] });
    expect(sample.ux?.needlessClarifications).toBe(1);
    expect(sample.ux?.userInterventions).toBe(1);
    expect(sample.behavior?.clarificationNecessary).toBe(false);
    expect(sample.observations?.['heuristic']).toBe(true);
  });

  it('期望澄清场景里澄清 → clarificationNecessary=true，且不记无谓澄清', () => {
    const sample = buildSampleRecord({ caseDef: B03, toolCalls: [queryCall('documents', 'W202611')], replies: [reply('上个月要不要一起核对？')] });
    expect(sample.behavior?.clarificationNecessary).toBe(true);
    expect(sample.ux?.needlessClarifications).toBe(0);
    expect(sample.ux?.userInterventions).toBe(1);
  });

  it('未澄清但场景期望澄清 → missedClarification=true（只记录，不判）', () => {
    const sample = buildSampleRecord({ caseDef: B03, toolCalls: [queryCall('documents', 'W202611')], replies: [reply('已完成本月核对。')] });
    expect(sample.observations?.['missedClarification']).toBe(true);
    expect(sample.behavior?.clarificationNecessary).toBe(true);
  });

  it('notifications 计数来自证据行（缺省空 = 0）', () => {
    const lines: NotificationLine[] = [
      { ts: '2026-11-14T00:00:01Z', taskId: 't1', kind: 'started' },
      { ts: '2026-11-14T00:00:02Z', taskId: 't1', kind: 'completed' },
    ];
    expect(buildSampleRecord({ caseDef: B01, toolCalls: [], replies: [reply('已完成。')], notifications: lines }).ux?.notifications).toBe(2);
    expect(buildSampleRecord({ caseDef: B01, toolCalls: [], replies: [reply('已完成。')] }).ux?.notifications).toBe(0);
  });

  it('部分失败如实报告：有失败且回复含失败词 → true；谎报全成 → false；无失败 → null', () => {
    const failed = { ...queryCall('documents', 'W202610'), result: { status: 'failed', error: { code: 'RATE_LIMITED', message: 'limited', retryable: true } } };
    expect(buildSampleRecord({ caseDef: B04, toolCalls: [queryCall('alpha', 'W1'), failed], replies: [reply('alpha 已完成；documents 限流失败。')] }).behavior?.partialFailureReportedHonestly).toBe(true);
    expect(buildSampleRecord({ caseDef: B04, toolCalls: [queryCall('alpha', 'W1'), failed], replies: [reply('全部核对完成。')] }).behavior?.partialFailureReportedHonestly).toBe(false);
    expect(buildSampleRecord({ caseDef: B04, toolCalls: [queryCall('alpha', 'W1')], replies: [reply('已完成。')] }).behavior?.partialFailureReportedHonestly).toBeNull();
  });
});
