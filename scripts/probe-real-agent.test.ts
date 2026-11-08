/**
 * 探针侧纯函数单测（PR #21 八审 major 的回归锁）。
 *
 * 覆盖 caseReportInputOf：intents / gateRows / delegations 必须按**全部轮次**累积。
 * 旧写法 `intents: turns.at(-1)?.intents` 只取最后一轮，而 report.ts 的
 * countInterventionPoints 只数 status=pending——提案等用户确认后提交成功时最终态是
 * committed，那个"用户必须确认"的停点就从干预指标里消失，完整写链被报成零次干预。
 */
import { describe, expect, it } from 'vitest';
import { caseReportInputOf } from './probe-real-agent';
import { buildCaseReport } from './eval/report';

const turn = (messageId: string, intents: Array<{ intentId: string; status: 'pending' | 'committed' }>) => ({
  text: '录入',
  reply: 'r',
  ms: 10,
  notices: [],
  messageId,
  calls: 1,
  refusedCalls: 0,
  taskIds: [],
  execution: [],
  gateRows: [],
  intents: intents.map((i) => ({ intentId: i.intentId, status: i.status, hasReadback: i.status === 'committed' })),
  delegations: [],
  ladder: [],
  ladderRung: 'completed' as const,
});

const item = { id: 'probe-5.1', group: 'acceptance 写链', intent: '录入' };

describe('caseReportInputOf：宿主事实按全部轮次累积（八审 major）', () => {
  it('intents 累积全部轮次，而非只取最后一轮', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }]),
      turn('m2', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    expect(input.intents.map((i) => `${i.intentId}:${i.status}`)).toEqual(['i1:pending', 'i1:committed']);
  });

  it('提案等确认后提交成功，干预停点仍计入 1（旧写法会报 0）', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }]),
      turn('m2', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    const line = buildCaseReport(input);
    expect(line.interventionPoints).toBe(1);
  });

  it('从未 pending 的意图不计停点', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'committed' }]),
    ], { ok: true, notes: [] });
    expect(buildCaseReport(input).interventionPoints).toBe(0);
  });

  it('多个不同意图各自计一次（不因同 status 合并）', () => {
    const input = caseReportInputOf(item, [
      turn('m1', [{ intentId: 'i1', status: 'pending' }, { intentId: 'i2', status: 'pending' }]),
    ], { ok: true, notes: [] });
    expect(buildCaseInput_safe(input)).toBe(2);
  });
});

// 小工具：避免在本文件里再引一次 aggregateMetrics 的类型噪音。
function buildCaseInput_safe(input: ReturnType<typeof caseReportInputOf>): number {
  return buildCaseReport(input).interventionPoints;
}
