import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  classifyPlanReject,
  planRejectsOf,
  renderPlanRejectLines,
  renderPlanRejectSummary,
} from './plan-reject-report';

/**
 * 计划门拒绝明细（D-087）：报告要把审计库里已经记着的东西带到人眼前。
 *
 * 行形状按验收阶段真实库文件钉过（原 data/acceptance-202610131453.db 的
 * DECLINED_PLAN_LIMIT 一行、…202610131112.db 的 ENTITY_OUT_OF_SCOPE 一行，现场核实过；
 * 验收库随旧脚手架于 2026-11-13 M2 波次 1 退役）：
 * 每个计划门出口都落一行，`status='error'`、`error_code='GATE_BLOCKED'`，理由住在
 * `safe_arguments.reason` 的 JSON 里。
 */

const SCHEMA = [
  'CREATE TABLE tool_calls (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  request_id TEXT NOT NULL,',
  '  trace_id TEXT,',
  '  tool_name TEXT NOT NULL,',
  '  safe_arguments TEXT NOT NULL,',
  '  source TEXT,',
  '  started_at TEXT NOT NULL,',
  '  finished_at TEXT,',
  '  status TEXT NOT NULL,',
  '  error_code TEXT,',
  '  artifact_id TEXT',
  ');',
  'CREATE INDEX idx_tool_calls_request_id ON tool_calls (request_id);',
].join('\n');

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function db(): Database.Database {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fshine-plan-reject-'));
  roots.push(root);
  const handle = new Database(path.join(root, 'audit.db'));
  handle.exec(SCHEMA);
  return handle;
}

function insert(handle: Database.Database, row: {
  requestId: string; tool: string; status: string; errorCode?: string; safe: Record<string, unknown>;
}): void {
  handle.prepare(
    'INSERT INTO tool_calls (request_id, tool_name, safe_arguments, started_at, status, error_code) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.requestId, row.tool, JSON.stringify(row.safe), '2026-10-14T00:00:00.000Z', row.status, row.errorCode ?? null);
}

const DECLINED_LIMIT = {
  detail: 'finance.query-receivables --query 幻辰财税 --customer 幻电设备有限公司',
  reason: 'PLAN STOP：DECLINED_PLAN_LIMIT: 期望 同一任务的计划提交逐次通过形状与实体来源校验；实际 已被连续拒绝 8 次；正确形态 停止重新提交计划，直接用自然语言向用户说明缺什么、建议提供什么',
};

const ENTITY_SCOPE = {
  detail: 'voucher.subject-list 幻辰财税 ; voucher.proposal prepare tmp/req_8a90b45c/proposal.json',
  reason: 'PLAN DECLINED：ENTITY_OUT_OF_SCOPE: 期望 计划的每个参数都能在当前请求、检索证据、平台响应或本会话已确立实体里逐字找到；实际 计划包含未在…中出现的参数：tmp/req_8a90b45c/proposal.json；正确形态 严格按本轮请求的范围执行，或向用户澄清',
};

describe('计划门拒绝明细：分类只认宿主自己的协议前缀', () => {
  it('DECLINED / STOP 归 declined，ACTIVE / NEEDS_USER_CONFIRM / PAUSED 各归其位', () => {
    expect(classifyPlanReject('PLAN DECLINED：ENTITY_OUT_OF_SCOPE: …')).toBe('declined');
    expect(classifyPlanReject('PLAN STOP：DECLINED_PLAN_LIMIT: …')).toBe('declined');
    expect(classifyPlanReject('PLAN STOP\nWRITE_NOT_ENABLED: …')).toBe('declined');
    expect(classifyPlanReject('PLAN ACTIVE（plan_new v1）：按已提交 calls 执行；平台会逐次校验本计划。')).toBe('active');
    expect(classifyPlanReject('PLAN NEEDS_USER_CONFIRM\n计划需要用户确认')).toBe('confirm');
    expect(classifyPlanReject('PLAN PAUSED：计划评估失败；未执行平台操作。')).toBe('paused');
  });

  it('空前提 / 空前缀 / 缺理由都归 other（不猜）', () => {
    expect(classifyPlanReject(null)).toBe('other');
    expect(classifyPlanReject('')).toBe('other');
    expect(classifyPlanReject('example-gateway plan CLI 失败：PLAN_REFUSE')).toBe('other');
  });
});

describe('计划门拒绝明细：按 request 取，彼此隔离', () => {
  it('只取本 request 的 serve_gate:plan_submit 行，别的门与别的 request 不混进来', () => {
    const handle = db();
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: ENTITY_SCOPE });
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: DECLINED_LIMIT });
    // 同一个 request 上的普通门拦截（不是计划提交）
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:bash', status: 'error', errorCode: 'GATE_BLOCKED', safe: { reason: 'bash 只准网关调用' } });
    // 别的 request 上的计划提交
    insert(handle, { requestId: 'req_2', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: DECLINED_LIMIT });

    const rows = planRejectsOf(handle, 'req_1');

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.reason)).toEqual([ENTITY_SCOPE.reason, DECLINED_LIMIT.reason]);
    expect(rows[0]?.detail).toBe(ENTITY_SCOPE.detail);
    expect(rows.every((row) => row.status === 'error' && row.errorCode === 'GATE_BLOCKED')).toBe(true);
    handle.close();
  });

  it('空结果：没有任何计划门裁决的 request', () => {
    const handle = db();
    expect(planRejectsOf(handle, 'req_none')).toEqual([]);
    handle.close();
  });

  it('safe_arguments 缺 reason 键时不炸，reason 为 null', () => {
    const handle = db();
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: { detail: '只有摘要没有理由' } });
    const rows = planRejectsOf(handle, 'req_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBeNull();
    expect(rows[0]?.detail).toBe('只有摘要没有理由');
    handle.close();
  });
});

describe('计划门拒绝明细：报告行', () => {
  it('空结果走「无」约定', () => {
    expect(renderPlanRejectLines([])).toEqual(['- 计划门拒绝明细:无']);
    expect(renderPlanRejectSummary([])).toBe('- 计划门裁决:0 次');
  });

  it('declined 排在前，其余按库里顺序跟在后面；每条裁决带一行摘要', () => {
    const handle = db();
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: { reason: 'PLAN ACTIVE（plan_new v1）：按已提交 calls 执行', detail: 'voucher.subject-list 幻辰财税' } });
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: ENTITY_SCOPE });
    const rows = planRejectsOf(handle, 'req_1');

    const lines = renderPlanRejectLines(rows);

    expect(lines[0]).toContain('（declined）');
    expect(lines[0]).toContain('ENTITY_OUT_OF_SCOPE');
    expect(lines[1]).toBe(`- 计划门摘要#${rows[1]?.id}:${ENTITY_SCOPE.detail}`);
    expect(lines[2]).toContain('（active）');
    expect(lines[3]).toBe(`- 计划门摘要#${rows[0]?.id}:voucher.subject-list 幻辰财税`);
    handle.close();
  });

  it('汇总行按分类计数，declined 是"把 worker 挡回来"的次数', () => {
    const handle = db();
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: ENTITY_SCOPE });
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: DECLINED_LIMIT });
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: { reason: 'PLAN ACTIVE（plan_new v1）' } });
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: { reason: 'PLAN PAUSED：x' } });

    expect(renderPlanRejectSummary(planRejectsOf(handle, 'req_1')))
      .toBe('- 计划门裁决:4 次（declined 2 / active 1 / confirm 0 / paused 1 / other 0）');
    handle.close();
  });

  it('超长理由截断，不把 worker 协议文本整段铺进报告', () => {
    const handle = db();
    insert(handle, { requestId: 'req_1', tool: 'serve_gate:plan_submit', status: 'error', errorCode: 'GATE_BLOCKED', safe: { reason: `PLAN DECLINED：${'理由'.repeat(300)}`, detail: 'd' } });
    const lines = renderPlanRejectLines(planRejectsOf(handle, 'req_1'));
    expect(lines[0]?.length).toBeLessThan(260);
    expect(lines[0]).toContain('…(截断)');
    handle.close();
  });
});
