/**
 * R6 测试基建 · 结构泄漏判据（确定性、零模型）。
 *
 * 正反例夹具是本判据可信的最低要求：
 *   · 正例 = 真实 Wave1 转录里出现过的「裸任务信封 + 内部 task_/req_ id + 400 行整包明细」形状；
 *   · 反例 = 普通业务回复（含任务编号 #1 等用户可见编号，但无内部标识/信封/整包）。
 * 另钉住：阈值可调且缺省不是永不命中；工具参数/工具结果的扫描面差异；只增读数
 * （`affectsDisposition=false`）与逐会话/总命中汇总。
 */
import { describe, it, expect } from 'vitest';
import {
  R6_STRUCTURE_LEAK_BOUNDS,
  aggregateStructureLeak,
  scanStructureLeak,
  structureLeakSummary,
  type StructureLeakBounds,
} from './structure-leak';
import type { ToolCallRecord } from './evidence';

const TASK_ID = 'task_e6296844-5e6a-4ed2-95c4-d0b24efc00c0';
const REQ_ID = 'req_c6c800b7-17fe-4760-80c5-b98460164d25';

const reply = (index: number, text: string): { index: number; text: string } => ({ index, text });

const tool = (turn: number, args: unknown, resultSummary = ''): ToolCallRecord => ({
  turn, agent: 'main', seq: 1, tool: 'task_result', args, resultSummary, elapsedMs: 0,
});

/** 正例：真实 Wave1 转录形状——信封 JSON + 400 行明细（>缺省行/字节阈值）。 */
function leakyReply(): string {
  const rows = Array.from({ length: 400 }, (_, i) => `${i + 1}. r6-load-a-item-${i + 1} — ${100 + i}`);
  return `{"taskId":"${TASK_ID}","taskNo":16,"status":"completed","requestIds":["${REQ_ID}"],"createdAt":"2026-11-17T02:39:37.050Z"}\n${rows.join('\n')}`;
}

describe('结构泄漏判据 · 正反例夹具', () => {
  it('含裸任务信封 / 内部 id / 整包明细的样本：红', () => {
    const report = scanStructureLeak({ replies: [reply(1, leakyReply())] });

    expect(report.criterion).toBe('structure_leak');
    expect(report.affectsDisposition).toBe(false);
    expect(report.scannedTurns).toBe(1);
    expect(report.hitTurns).toBe(1);
    expect(report.byCode.bare_task_envelope).toBe(1);
    expect(report.byCode.internal_task_id).toBe(1);
    expect(report.byCode.internal_request_id).toBe(1);
    expect(report.byCode.bulk_detail_package).toBe(1);
    expect(report.totalHits).toBeGreaterThanOrEqual(4);
    expect(report.hits.every((hit) => hit.surface === 'reply')).toBe(true);
    // 证据摘要不倾倒 400 行原文。
    expect(report.hits.every((hit) => hit.evidence.length <= 180)).toBe(true);
  });

  it('干净业务样本：绿（零命中）', () => {
    const report = scanStructureLeak({
      replies: [reply(1, 'alpha 集合 W1 共 2 条，总金额 2000 元。'), reply(2, '那个汇总任务 #3 还未完成。')],
      toolCalls: [tool(1, { ref: '#1' }, '{"status":"completed","data":{"count":2}}')],
    });

    expect(report.totalHits).toBe(0);
    expect(report.hitTurns).toBe(0);
    expect(report.scannedTurns).toBe(2);
    expect(report.byCode).toEqual({
      bare_task_envelope: 0, internal_task_id: 0, internal_request_id: 0, bulk_detail_package: 0,
    });
  });
});

describe('结构泄漏判据 · 阈值可调且缺省不空转', () => {
  it('缺省阈值下 201 行即命中整包明细；抬高阈值后同一样本不再命中', () => {
    const text = '逐条明细：\n' + Array.from({ length: 201 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const base = scanStructureLeak({ replies: [reply(1, text)] });
    expect(base.byCode.bulk_detail_package).toBe(1);

    const raised: StructureLeakBounds = { ...R6_STRUCTURE_LEAK_BOUNDS, maxBulkLines: 10_000, maxBulkBytes: 10_000_000 };
    const tuned = scanStructureLeak({ replies: [reply(1, text)] }, raised);
    expect(tuned.byCode.bulk_detail_package).toBe(0);
  });

  it('字节阈值独立生效：单行超 16 KiB 也命中', () => {
    const text = '字'.repeat(6_000); // UTF-8 18,000 字节，单行
    const report = scanStructureLeak({ replies: [reply(1, text)] });
    expect(report.byCode.bulk_detail_package).toBe(1);
    expect(report.hits.find((hit) => hit.code === 'bulk_detail_package')?.evidence).toContain('18000 字节');
  });

  it('缩进信封（键跨行）仍识别为裸任务信封', () => {
    const text = `查询回执：\n{\n  "taskId": "${TASK_ID}",\n  "requestIds": ["${REQ_ID}"]\n}`;
    const report = scanStructureLeak({ replies: [reply(1, text)] });
    expect(report.byCode.bare_task_envelope).toBe(1);
  });
});

describe('结构泄漏判据 · 扫描面', () => {
  it('工具参数出现 task_/req_ 内部标识：命中 tool_args', () => {
    const report = scanStructureLeak({
      replies: [],
      toolCalls: [tool(3, { ref: TASK_ID, q: REQ_ID })],
    });
    const taskHits = report.hits.filter((hit) => hit.code === 'internal_task_id');
    const reqHits = report.hits.filter((hit) => hit.code === 'internal_request_id');
    expect(taskHits.map((hit) => hit.surface)).toEqual(['tool_args']);
    expect(reqHits.map((hit) => hit.surface)).toEqual(['tool_args']);
    expect(report.scannedTurns).toBe(1);
  });

  it('工具结果里的内部 id 不按 id 规则计（正常回执字段），信封另计', () => {
    const report = scanStructureLeak({
      replies: [],
      toolCalls: [tool(4, { ref: '#2' }, `{"taskId":"${TASK_ID}","requestIds":["${REQ_ID}"]}`)],
    });
    expect(report.hits.some((hit) => hit.code === 'internal_task_id')).toBe(false);
    expect(report.hits.some((hit) => hit.code === 'internal_request_id')).toBe(false);
    expect(report.hits.filter((hit) => hit.code === 'bare_task_envelope').map((hit) => hit.surface)).toEqual(['tool_result']);
  });

  it('scanToolResults=false 时工具结果面整体不扫', () => {
    const bounds: StructureLeakBounds = { ...R6_STRUCTURE_LEAK_BOUNDS, scanToolResults: false };
    const report = scanStructureLeak({
      replies: [],
      toolCalls: [tool(4, { ref: '#2' }, `{"taskId":"${TASK_ID}"}`)],
    }, bounds);
    expect(report.totalHits).toBe(0);
  });

  it('可选原始转录面：信封命中标 transcript（不改逐回合回复读数）', () => {
    const report = scanStructureLeak({
      replies: [reply(1, '正常回复。')],
      transcriptText: `{"tasks":[{"taskId":"${TASK_ID}"}]}`,
    });
    expect(report.hits.filter((hit) => hit.surface === 'transcript').length).toBeGreaterThan(0);
  });
});

describe('结构泄漏判据 · 逐会话计数 + 总命中', () => {
  it('汇总两会话：perSession 计数与总命中可复核', () => {
    const s1 = scanStructureLeak({ replies: [reply(1, `{"taskId":"${TASK_ID}"}`)] });
    const s2 = scanStructureLeak({ replies: [reply(1, '干净。'), reply(2, `任务编号 ${TASK_ID}`)] });
    const batch = aggregateStructureLeak([{ sessionId: 's1', report: s1 }, { sessionId: 's2', report: s2 }]);

    expect(batch.affectsDisposition).toBe(false);
    expect(batch.sessions).toBe(2);
    expect(batch.perSession).toEqual([
      { sessionId: 's1', scannedTurns: 1, hitTurns: 1, totalHits: s1.totalHits, byCode: s1.byCode },
      { sessionId: 's2', scannedTurns: 2, hitTurns: 1, totalHits: s2.totalHits, byCode: s2.byCode },
    ]);
    expect(batch.totalHits).toBe(s1.totalHits + s2.totalHits);
    expect(batch.hitTurns).toBe(2);
    expect(batch.byCode.internal_task_id).toBe(2);
  });

  it('summary 字段只含读数与阈值，不改 disposition', () => {
    const report = scanStructureLeak({ replies: [reply(1, leakyReply())] });
    const field = structureLeakSummary(report) as unknown as Record<string, unknown>;
    expect(field['criterion']).toBe('structure_leak');
    expect(field['affectsDisposition']).toBe(false);
    expect(field['totalHits']).toBe(report.totalHits);
    expect(field['bounds']).toEqual(R6_STRUCTURE_LEAK_BOUNDS);
    expect(field['disposition']).toBeUndefined();
  });
});
