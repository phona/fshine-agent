/**
 * 跑批报告落盘形状测试（业务 E2E 阶段 2·R2 修复 ③，TDD 先红）——**零真实模型**（确定性假件）。
 *
 * R1 本批 `report.json` 顶层缺 `batch`（RSS/CPU/observedMaxConcurrency/throughput 未落盘 →
 * 不可得）；本批把落盘投影抽成纯函数 `buildRunReportJson` 并钉住形状：batch 资源读数必在。
 * 同时验证 UX/行为抽取器经跑批装配（buildSampleRecord）确实进入落盘样本（修复 ② 接线）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bizCases } from '../exploration/bizprobe/cases';
import { expandBizprobeItems } from './scenarios';
import { runBizprobeBatch, summarizeBizprobe, type BizExecutor } from './assembly';
import { buildSampleRecord } from './sample-from-run';
import { buildRunReportJson } from './run';
import type { MetaFile, ReplyLine, ToolCallRecord } from '../convergence-r1/evidence';

let tmpRoots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'biz-e2e-runreport-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

/** 假件：按用例授权集合做一次只读查询，回复为如实陈述（由 buildSampleRecord 抽 UX/行为）。 */
const fakeExecutor: BizExecutor = async (item, caseDef) => {
  const first = caseDef.biz.granted[0]!;
  const calls: ToolCallRecord[] = [{
    turn: 1, agent: 'worker', seq: 1, tool: 'execute_operation',
    args: { operation: 'dummy.query', args: { collection: first.object.collection, ...(first.object.window === undefined ? {} : { window: first.object.window }) } },
    result: { status: 'completed' }, startedAt: '2026-11-14T00:00:00Z', elapsedMs: 1,
  }];
  const replies: ReplyLine[] = [{ turn: 1, text: '已完成核对。', sha256: '' }];
  const meta: MetaFile = { turns: [{ index: 1, durationMs: 5, modelCalls: 1, taskIds: [], tokens: { available: false, source: 'fake' }, retries: 0, notes: [] }], driverEvents: [], notes: [] };
  return {
    inputs: { caseId: caseDef.id, trial: item.trial, principalId: 'p', sessionId: item.sessionId, turns: [], configPath: 'cfg', profileRoot: 'root', gateway: 'bin/dummy', dbPath: 'db' },
    toolCalls: calls,
    tasks: [],
    replies,
    meta,
    sample: buildSampleRecord({ caseDef, toolCalls: calls, replies }),
  };
};

describe('③ 落盘报告含 batch 资源读数（R1 缺失 → 本批补）', () => {
  it('buildRunReportJson：batch 带 caseCount/observedMaxConcurrency/throughputPerSec/resources(RSS/CPU)', async () => {
    const outRoot = path.join(freshRoot(), 'out');
    const items = expandBizprobeItems(bizCases);
    const report = await runBizprobeBatch({ cases: bizCases, items, executor: fakeExecutor, outRoot, concurrency: 4 });
    const json = buildRunReportJson({ suiteId: 'bizprobe', report, summary: summarizeBizprobe(report) });

    expect(json['suite']).toBe('bizprobe');
    const batch = json['batch'] as Record<string, unknown>;
    expect(batch['caseCount']).toBe(18);
    expect(batch['observedMaxConcurrency']).toBe(4);
    expect(typeof batch['wallMs']).toBe('number');
    const throughput = batch['throughputPerSec'] as number;
    expect(typeof throughput).toBe('number');
    expect(throughput).toBeGreaterThan(0);
    const resources = batch['resources'] as Record<string, unknown>;
    expect(typeof resources['rssDeltaBytes']).toBe('number');
    expect(typeof resources['cpuUserMs']).toBe('number');
    expect(typeof resources['cpuSystemMs']).toBe('number');
    expect(json['samples']).toHaveLength(18);
  });

  it('落盘样本带 UX/行为读数（buildSampleRecord 接线；R1 全 null → 本批可测）', async () => {
    const outRoot = path.join(freshRoot(), 'out');
    const items = expandBizprobeItems([bizCases[0]!]); // B01：无失败、禁止澄清
    const report = await runBizprobeBatch({ cases: [bizCases[0]!], items, executor: fakeExecutor, outRoot, concurrency: 1 });
    const json = buildRunReportJson({ suiteId: 'bizprobe', report, summary: summarizeBizprobe(report) });
    const sample = (json['samples'] as Array<Record<string, any>>)[0]!;
    expect(sample['ux']).toMatchObject({ needlessClarifications: 0, userInterventions: 0, notifications: 0 });
    expect(sample['behavior']).toMatchObject({ partialFailureReportedHonestly: null, clarificationNecessary: false });
  });
});
