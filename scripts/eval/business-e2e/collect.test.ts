/**
 * 逐样本 run-dir 证据采集器测试（业务 E2E 阶段 1，TDD 先红）。
 * 复用 runner 证据 schema（scripts/eval/convergence-r1/evidence.ts）：
 * ToolCallRecord / TaskRecordJson / ExecutionsExport / ReplyLine / MetaFile / InputsFile。
 * 模型调用数/token 若驱动面不可得 → manifest 如实标注不可得，不编造。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeSampleRun } from './collect';
import { judgeMechanical } from './judge';
import type { SampleRecord } from './judge';
import type { ToolCallRecord, TaskRecordJson, ReplyLine, MetaFile, InputsFile } from '../convergence-r1/evidence';

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-collect-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

const TOOL_CALLS: ToolCallRecord[] = [
  { turn: 0, agent: 'main', seq: 0, tool: 'delegate', args: { task: 'query alpha' }, startedAt: '2026-11-14T00:00:00Z', elapsedMs: 100 },
  { turn: 0, agent: 'worker', seq: 0, tool: 'execute_operation', args: { operation: 'dummy.query', args: { collection: 'alpha' } }, result: { status: 'completed' }, startedAt: '2026-11-14T00:00:01Z', elapsedMs: 50 },
];
const TASK: TaskRecordJson = {
  taskId: 'task-1', principalId: 'p1', sessionId: 's1', request: 'query alpha W1', status: 'completed',
  executions: [{ requestId: 'req-1', operation: 'dummy.query', status: 'completed' }],
  createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:02Z',
};
const REPLIES: ReplyLine[] = [{ turn: 0, text: 'done: 2 records', sha256: createHash('sha256').update('done: 2 records').digest('hex') }];
const META: MetaFile = { turns: [{ index: 0, durationMs: 2000, modelCalls: 1, taskIds: ['task-1'], tokens: { available: false, source: 'driver' }, retries: 0, notes: [] }], driverEvents: [], notes: [] };
const INPUTS: InputsFile = { caseId: 'B01', trial: 1, principalId: 'p1', sessionId: 's1', turns: [{ index: 0, text: 'query alpha W1', sha256: 'x' }], configPath: 'cfg', profileRoot: 'prof', gateway: 'dummy', dbPath: 'db' };
const SAMPLE: SampleRecord = {
  id: 'B01',
  granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
  executions: [{ requestId: 'req-1', operation: 'dummy.query', access: 'read', object: { collection: 'alpha', window: 'W1' }, status: 'completed' }],
  reply: { claimsCompletion: true },
  behavior: { partialFailureReportedHonestly: null, clarificationNecessary: null },
  ux: { needlessClarifications: 0, userInterventions: 0, notifications: 1, deliveryQuality: null },
  observations: { taskSplitCount: 1, toolCallOrder: ['delegate', 'execute_operation'], planReportedFirst: true },
};
const TASK_FACTS = [
  { ts: '2026-11-14T00:00:00Z', taskId: 'task-1', from: 'created', to: 'running' },
  { ts: '2026-11-14T00:00:02Z', taskId: 'task-1', from: 'running', to: 'completed' },
];
const NOTIFICATIONS = [{ ts: '2026-11-14T00:00:02Z', taskId: 'task-1', kind: 'task-completed' }];
const AUDIT_LINES = ['{"mode":"query","script":"dummy.query","exitCode":0}'];

function writeAll(root: string, trial = 1) {
  return writeSampleRun(root, {
    inputs: { ...INPUTS, trial },
    toolCalls: TOOL_CALLS,
    tasks: [TASK],
    replies: REPLIES,
    meta: META,
    taskFacts: TASK_FACTS,
    notifications: NOTIFICATIONS,
    auditLines: AUDIT_LINES,
    sample: SAMPLE,
  });
}

describe('writeSampleRun 逐样本证据采集', () => {
  it('落 run-dir：<root>/<caseId>/<trial>/，八类证据齐全（trace/工具调用/任务状态流/执行记录/通知/审计/回复/meta）', () => {
    const root = freshRoot();
    const runDir = writeAll(root);
    expect(runDir).toBe(path.join(root, 'B01', '1'));
    for (const f of ['inputs.json', 'meta.json', 'tool-calls.json', 'tasks.json', 'replies.jsonl', 'task-facts.jsonl', 'notifications.jsonl', 'audit.jsonl']) {
      expect(existsSync(path.join(runDir, f)), f).toBe(true);
    }
  });

  it('tasks.json 与 runner schema 同构（ExecutionsExport：tasks[].executions[].requestId/operation/status）', () => {
    const root = freshRoot();
    const runDir = writeAll(root);
    const tasks = JSON.parse(readFileSync(path.join(runDir, 'tasks.json'), 'utf8'));
    expect(tasks.tasks[0].taskId).toBe('task-1');
    expect(tasks.tasks[0].executions[0]).toMatchObject({ requestId: 'req-1', operation: 'dummy.query', status: 'completed' });
  });

  it('verdict.json 落判定器输出：机械与行为、UX 分开字段', () => {
    const root = freshRoot();
    const runDir = writeAll(root);
    const verdict = JSON.parse(readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
    expect(verdict.mechanical).toEqual(judgeMechanical(SAMPLE));
    expect(verdict.behavior).toEqual(SAMPLE.behavior);
    expect(verdict.ux).toEqual(SAMPLE.ux);
    expect(verdict.observations).toEqual(SAMPLE.observations);
  });

  it('manifest.json 列全部文件 + sha256 逐文件可复核；模型调用/token 不可得时如实标注（不编造）', () => {
    const root = freshRoot();
    const runDir = writeAll(root);
    const manifest = JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    expect(manifest.sampleId).toBe('B01');
    for (const entry of manifest.files) {
      const hash = createHash('sha256').update(readFileSync(path.join(runDir, entry.name))).digest('hex');
      expect(hash).toBe(entry.sha256);
    }
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['tool-calls.json', 'tasks.json', 'verdict.json']));
    // 驱动面未给 token → available:false + source 标注，不出现编造数字。
    expect(manifest.modelUsage.available).toBe(false);
    expect(typeof manifest.modelUsage.note).toBe('string');
  });

  it('同一样本第二次 trial 落 <caseId>/2/，不覆盖 trial 1', () => {
    const root = freshRoot();
    writeAll(root, 1);
    const second = writeAll(root, 2);
    expect(second).toBe(path.join(root, 'B01', '2'));
    expect(existsSync(path.join(root, 'B01', '1', 'tasks.json'))).toBe(true);
    expect(existsSync(path.join(root, 'B01', '2', 'tasks.json'))).toBe(true);
  });
});
