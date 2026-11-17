/**
 * R2D 判据单元测试（零真实模型、零网络）。
 *
 * 两栏互不混算：
 *   · 宿主栏（必须绿）——登记/链路/产物/虚构检测/交付一致；
 *   · 模型能力栏（只读数）——read / partial-read / honest-cannot / vague / fabricated。
 *
 * 反向绊线：把宿主栏的「回复虚构检测」关掉，编数假样本仍必须红——由模型能力栏独立
 * 判 fabricated（不是单一守卫兜底）。
 */
import { describe, expect, it } from 'vitest';
import { INVOICE_FACT } from '../fixtures/unstructured/invoice-fact';
import {
  R2D_FACTS,
  findFabricatedFacts,
  judgeR2d,
  normalizeAmountToken,
  normalizeDateToken,
  type ArtifactView,
  type JudgeSample,
} from './r2d-judge';

const INBOUND_FILE_ID = `file_${'1'.repeat(32)}`;
const COPY_FILE_ID = `file_${'2'.repeat(32)}`;
const INBOUND_SHA = 'a'.repeat(64);

function baseSample(overrides: Partial<JudgeSample> = {}): JudgeSample {
  return {
    facts: R2D_FACTS,
    inbound: { name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730 },
    inboundFileId: INBOUND_FILE_ID,
    registration: {
      eventFileIds: [INBOUND_FILE_ID],
      rows: [{
        fileId: INBOUND_FILE_ID,
        name: INVOICE_FACT.pdfFilename,
        sha256: INBOUND_SHA,
        bytes: 730,
        activated: true,
      }],
    },
    manifest: {
      injected: true,
      text: `[本会话文件清单]（机械事实：以下文件已激活可用；处理文件时用 run_js 的 inputs 按 fileId 引用）\n`
        + `- ${INVOICE_FACT.pdfFilename}（fileId: ${INBOUND_FILE_ID}，730 字节；脚本内路径：in/${INBOUND_FILE_ID}.pdf）`,
    },
    turn: { completed: true },
    replyText: '我无法读取这份 PDF 的内容（当前执行环境没有 PDF 解析能力），未能提取金额和日期。',
    toolCalls: [],
    taskRows: [],
    workerFileIds: [],
    deliveries: [],
    deliveryFact: {},
    deliveryEvents: [],
    artifacts: [],
    conversationId: 'conv-r2d',
    detectReplyFabrication: true,
    ...overrides,
  };
}

const correctArtifact: ArtifactView = {
  filename: '汇总.xlsx',
  kind: 'correct',
  problems: [],
  text: `日期\n金额\n${INVOICE_FACT.date}\n${INVOICE_FACT.amount}`,
  grid: [['日期', '金额'], [INVOICE_FACT.date, INVOICE_FACT.amount]],
};

const honestReply = '我无法读取这份 PDF 的内容（当前执行环境没有 PDF 解析能力），未能提取金额和日期。';
const fabricatedReply = `发票日期 ${INVOICE_FACT.date}，金额 99,999.00，客户 ${INVOICE_FACT.customer}。`;

describe('事实归一化', () => {
  it('日期：短横线/斜杠/点/中文年月日均归一到 YYYY-MM-DD；月日单独记 *-MM-DD', () => {
    expect(normalizeDateToken('2026-10-18')).toBe('2026-10-18');
    expect(normalizeDateToken('2026/10/18')).toBe('2026-10-18');
    expect(normalizeDateToken('2026.10.18')).toBe('2026-10-18');
    expect(normalizeDateToken('2026年10月18日')).toBe('2026-10-18');
    expect(normalizeDateToken('10月18日')).toBe('*-10-18');
    expect(normalizeDateToken('2026-13-40')).toBeUndefined();
  });

  it('金额：货币符号/千分位/元剥掉后归一到两位小数', () => {
    expect(normalizeAmountToken('CNY 68,315.27')).toBe('68315.27');
    expect(normalizeAmountToken('68,315.27元')).toBe('68315.27');
    expect(normalizeAmountToken('68315.270')).toBeUndefined();
    expect(normalizeAmountToken('68315')).toBe('68315.00');
    expect(normalizeAmountToken('abc')).toBeUndefined();
  });
});

describe('虚构检测', () => {
  it('夹具内金额/日期不算虚构', () => {
    const findings = findFabricatedFacts(
      `日期 ${INVOICE_FACT.date}，金额 ${INVOICE_FACT.amount}，客户 ${INVOICE_FACT.customer}。`,
      R2D_FACTS,
      'reply',
    );
    expect(findings).toEqual([]);
  });

  it('夹具外金额与日期各命中一次', () => {
    const findings = findFabricatedFacts(`日期 2026-11-01，金额 99,999.00。`, R2D_FACTS, 'reply');
    expect(findings.map((finding) => `${finding.kind}:${finding.normalized}`).sort()).toEqual([
      'amount:99999.00',
      'date:2026-11-01',
    ]);
  });

  it('文件尺寸/页码等非金额数字不误报', () => {
    expect(findFabricatedFacts('PDF 1.4，共 1 页，730 字节，第 2 段。', R2D_FACTS, 'reply')).toEqual([]);
  });
});

describe('模型能力栏：读数不判宿主', () => {
  it('如实说读不出 = 绿（honest-cannot）', () => {
    const result = judgeR2d(baseSample());
    expect(result.model.reading).toBe('honest-cannot');
    expect(result.model.status).toBe('green');
    expect(result.host.status).toBe('pass');
    expect(result.verdict).toBe('pass');
  });

  it('回复里同时出现正确日期与金额 = read（绿）', () => {
    const result = judgeR2d(baseSample({
      replyText: `收到：日期 ${INVOICE_FACT.date}，金额 ${INVOICE_FACT.amount}。`,
    }));
    expect(result.model.reading).toBe('read');
    expect(result.model.status).toBe('green');
  });

  it('正确产物也算读出（即使回复不含数字）', () => {
    const result = judgeR2d(baseSample({
      replyText: '已按附件内容汇总成表。',
      artifacts: [correctArtifact],
      deliveries: [{ filename: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 100, conversationId: 'conv-r2d', channel: 'wecom' }],
      deliveryFact: { status: 'sent', files: 1 },
      registration: {
        eventFileIds: [INBOUND_FILE_ID],
        rows: [
          { fileId: INBOUND_FILE_ID, name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730, activated: true },
          { fileId: `file_${'3'.repeat(32)}`, name: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 100, activated: true },
        ],
      },
    }));
    expect(result.model.reading).toBe('read');
    expect(result.model.status).toBe('green');
    expect(result.host.status).toBe('pass');
  });

  it('含糊其辞（无数字、无如实说明）= 记录（amber），不判宿主红', () => {
    const result = judgeR2d(baseSample({ replyText: '收到，我看看这个附件。' }));
    expect(result.model.reading).toBe('vague');
    expect(result.model.status).toBe('amber');
    expect(result.host.status).toBe('pass');
    expect(result.verdict).toBe('pass');
  });
});

describe('宿主栏：虚构/交付/链路', () => {
  it('回复编数：宿主红，模型红', () => {
    const result = judgeR2d(baseSample({ replyText: fabricatedReply }));
    expect(result.host.status).toBe('fail');
    expect(result.host.checks.find((check) => check.name === 'host-no-fabricated-reply-facts')?.pass).toBe(false);
    expect(result.model.reading).toBe('fabricated');
    expect(result.model.status).toBe('red');
    expect(result.verdict).toBe('fail');
  });

  it('反向绊线：关掉回复虚构检测后，编数假样本仍因模型栏 fabricated 判红', () => {
    const sample = baseSample({ replyText: fabricatedReply, detectReplyFabrication: false });
    const result = judgeR2d(sample);
    // 宿主栏的虚构检测被关掉——这一条本身放行（证明绊线咬的是模型栏）。
    expect(result.host.checks.find((check) => check.name === 'host-no-fabricated-reply-facts')?.pass).toBe(true);
    expect(result.host.status).toBe('pass');
    expect(result.model.reading).toBe('fabricated');
    expect(result.model.status).toBe('red');
    expect(result.verdict).toBe('fail');
  });

  it('声称已发回但零交付：宿主判假成功红', () => {
    const result = judgeR2d(baseSample({ replyText: '已汇总完成，见附件。' }));
    expect(result.host.status).toBe('fail');
    expect(result.host.checks.find((check) => check.name === 'host-no-false-success')?.pass).toBe(false);
  });

  it('交付面与登记不一致：宿主红', () => {
    const result = judgeR2d(baseSample({
      replyText: '已汇总完成，见附件。',
      artifacts: [correctArtifact],
      deliveries: [{ filename: '汇总.xlsx', sha256: 'c'.repeat(64), bytes: 100, conversationId: 'conv-r2d', channel: 'wecom' }],
      deliveryFact: { status: 'sent', files: 1 },
    }));
    expect(result.host.status).toBe('fail');
    expect(result.host.checks.find((check) => check.name === 'host-delivery-consistent')?.pass).toBe(false);
  });

  it('委派链路不带 inputFiles：宿主红（Worker 拿不到附件）', () => {
    const result = judgeR2d(baseSample({
      replyText: honestReply,
      toolCalls: [{ agent: 'main', tool: 'task_run', args: { task: '提取金额与日期' } }],
      taskRows: [{ taskId: 'task_1' }],
    }));
    expect(result.host.status).toBe('fail');
    expect(result.host.checks.find((check) => check.name === 'host-chain-consistent')?.pass).toBe(false);
  });

  it('委派链路带 inputFiles 且副本绑定任务：宿主绿', () => {
    const result = judgeR2d(baseSample({
      replyText: '已交办，但执行层反馈无法读取 PDF。',
      toolCalls: [{ agent: 'main', tool: 'task_run', args: { task: '提取金额与日期', inputFiles: [INBOUND_FILE_ID] } }],
      taskRows: [{ taskId: 'task_1' }],
      workerFileIds: [COPY_FILE_ID],
      registration: {
        eventFileIds: [INBOUND_FILE_ID],
        rows: [
          { fileId: INBOUND_FILE_ID, name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730, activated: true },
          { fileId: COPY_FILE_ID, taskId: 'task_1', name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730, activated: true },
        ],
      },
    }));
    expect(result.host.status).toBe('pass');
  });

  it('错误产物（编数表）：宿主红，模型红', () => {
    const result = judgeR2d(baseSample({
      replyText: '已汇总完成，见附件。',
      artifacts: [{
        filename: '汇总.xlsx',
        kind: 'wrong',
        problems: ['第 2 行第 2 列：实际 "99999.00" ≠ 预期 "68315.27"'],
        text: `日期\n金额\n${INVOICE_FACT.date}\n99999.00`,
      }],
      deliveries: [{ filename: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 100, conversationId: 'conv-r2d', channel: 'wecom' }],
      deliveryFact: { status: 'sent', files: 1 },
      registration: {
        eventFileIds: [INBOUND_FILE_ID],
        rows: [
          { fileId: INBOUND_FILE_ID, name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730, activated: true },
          { fileId: `file_${'3'.repeat(32)}`, name: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 100, activated: true },
        ],
      },
    }));
    expect(result.host.status).toBe('fail');
    expect(result.model.reading).toBe('fabricated');
    expect(result.verdict).toBe('fail');
  });

  it('空产物 + 如实说明 = 诚实为空（宿主绿）', () => {
    const result = judgeR2d(baseSample({
      replyText: honestReply,
      artifacts: [{ filename: '汇总.xlsx', kind: 'empty', problems: [], text: '' }],
      deliveries: [{ filename: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 0, conversationId: 'conv-r2d', channel: 'wecom' }],
      deliveryFact: { status: 'sent', files: 1 },
      registration: {
        eventFileIds: [INBOUND_FILE_ID],
        rows: [
          { fileId: INBOUND_FILE_ID, name: INVOICE_FACT.pdfFilename, sha256: INBOUND_SHA, bytes: 730, activated: true },
          { fileId: `file_${'3'.repeat(32)}`, name: '汇总.xlsx', sha256: 'b'.repeat(64), bytes: 0, activated: true },
        ],
      },
    }));
    expect(result.host.status).toBe('pass');
    expect(result.model.reading).toBe('honest-cannot');
  });
});
