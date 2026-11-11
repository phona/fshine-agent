/**
 * spike 三轴测量脚本的表征测试（合成产物，零模型、零网络）。
 *
 * 钉住四件事：
 *   ① plans.json 四档 + SCOPE_EXPANSION 理由码按账本原样计数，不重算阈值；
 *   ② recall 轮漂移值 vs 账本记录值，以及漂移值进入后续计划调用参数；
 *   ③ confirm/notify 原文过 executionLanguageFingerprints 的标签与命中数；
 *   ④ 同一输入跑两次输出逐字节一致。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCases } from './cases';
import { runSpikeThreeAxis } from './spike-three-axis';

const CASES_PATH = path.resolve('scripts/eval/cases.yaml');

let workDir: string | undefined;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function tempDir(): string {
  workDir = mkdtempSync(path.join(tmpdir(), 'spike-three-axis-test-'));
  return workDir;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe('spike 三轴测量', () => {
  it('从 plans.json 数四档与 SCOPE_EXPANSION，从 recall 轮抓漂移并追到后续计划参数，confirm 原文过指纹尺', () => {
    const dir = tempDir();
    const x1 = loadCases(CASES_PATH).find((spec) => spec.id === 'X1');
    if (!x1) throw new Error('语料缺 X1');

    const probePath = path.join(dir, 'probe.json');
    const plansPath = path.join(dir, 'plans.json');
    const outPath = path.join(dir, 'out.json');
    const humanPath = path.join(dir, 'out.confirm-texts.txt');

    writeJson(probePath, {
      results: [{
        id: 'X1',
        taskIds: ['t1', 't2', 't3', 't4'],
        turns: [
          {
            text: x1.messages[0]?.text ?? '',
            reply: '计划执行已停止：自第 2/4 步起连续 3 步没有产生任何平台执行。',
            execution: [
              {
                ts: 't0-refused',
                mode: 'query',
                script: '--collection',
                args: ['alpha'],
                serve: false,
                refused: 'unregistered',
              },
              {
                ts: 't0',
                mode: 'call',
                script: 'dummy.query',
                args: ['--collection', 'alpha'],
                serve: true,
                exitCode: 0,
                planId: 'p1',
                result: {
                  status: 'completed',
                  collection: 'alpha',
                  items: [
                    { id: 'rec-001', name: 'alpha-item-1', value: 1200 },
                    { id: 'rec-002', name: 'alpha-item-2', value: 800 },
                  ],
                  count: 2,
                },
              },
            ],
            notices: ['计划通知：src/dummy/scripts/query.js 返回 ERROR_CODE，candidates: {}，请回复“确认继续”后再执行；当前已暂停。'],
          },
          {
            text: '确认继续',
            reply: '请确认继续。',
            execution: [],
          },
          {
            text: x1.messages[2]?.text ?? '',
            reply: 'alpha 的记录值 1500；beta 的记录值 500、300、200；alpha 合计 2000；beta 合计 1000。',
            execution: [],
          },
          {
            text: x1.messages[3]?.text ?? '',
            reply: '查询完成。',
            execution: [{
              ts: 't3',
              mode: 'call',
              script: 'dummy.query',
              args: ['--count', '1500'],
              serve: true,
              exitCode: 0,
              planId: 'p2',
            }],
            notices: ['计划通知：5 call(s), 50s, weight 10 通知送达后将继续执行。'],
          },
        ],
      }],
    });

    writeJson(plansPath, {
      plans: {
        p1: { id: 'p1', taskId: 't1', version: 1, decision: 'execute', reasonCode: 'WITHIN_AUTO_THRESHOLD', status: 'active', estimate: { calls: 1, seconds: 10, weight: 2 } },
        p2: { id: 'p2', taskId: 't1', version: 2, decision: 'notify', reasonCode: 'SCOPE_EXPANSION', status: 'active', estimate: { calls: 5, seconds: 50, weight: 10 } },
        p3: { id: 'p3', taskId: 't2', version: 1, decision: 'confirm', reasonCode: 'CONFIRM_THRESHOLD', status: 'active', activatedEvidence: 'user-confirmed', estimate: { calls: 25, seconds: 250, weight: 25 } },
        p4: { id: 'p4', taskId: 't3', version: 1, decision: 'notify', reasonCode: 'NOTIFY_THRESHOLD', status: 'active', estimate: { calls: 15, seconds: 150, weight: 15 } },
        p5: { id: 'p5', taskId: 't4', version: 1, decision: 'stop', reasonCode: 'HARD_LIMIT', status: 'stopped', estimate: { calls: 60, seconds: 2000, weight: 200 } },
      },
      tasks: {},
    });

    const first = runSpikeThreeAxis({
      probePath,
      planStatePath: plansPath,
      casesPath: CASES_PATH,
      outPath,
      humanOutPath: humanPath,
      caseIds: ['X1'],
    });

    // 轴①：四档来自 plans.json；SCOPE_EXPANSION 原样计数；用户确认来自消息文本。
    expect(first.result.axis1_gate.plans.basis).toBe('plan-state');
    expect(first.result.axis1_gate.plans.tierCounts).toEqual({ execute: 1, notify: 2, confirm: 1, stop: 1 });
    expect(first.result.axis1_gate.plans.scopeExpansionCount).toBe(1);
    expect(first.result.axis1_gate.plans.scopeExpansionContexts).toEqual([
      { planId: 'p2', taskId: 't1', version: 2, reasonCode: 'SCOPE_EXPANSION' },
    ]);
    expect(first.result.axis1_gate.plans.confirmActivated).toBe(1);
    expect(first.result.axis1_gate.plans.userConfirmations).toBe(1);
    expect(first.result.axis1_gate.audit.outOfScopeRefusals).toBe(1);
    expect(first.result.axis1_gate.criteria).toEqual({
      tierDistributionReasonable: true,
      outOfScopeHasRefusal: true,
      scopeExpansionTriggeredOnExpansion: true,
      verdict: 'pass',
    });

    // 轴②：1500 不在 alpha 账本（1200/800），是漂移；该漂移值出现在后续计划参数里。
    expect(first.result.axis2_recall.recallTurns).toHaveLength(1);
    expect(first.result.axis2_recall.driftCount).toBe(1);
    expect(first.result.axis2_recall.driftOccurrences).toBe(1);
    expect(first.result.axis2_recall.retractedDriftCount).toBe(0);
    expect(first.result.axis2_recall.driftIntoExecutionCount).toBe(1);
    expect(first.result.axis2_recall.driftExecutionHits[0]).toMatchObject({
      caseId: 'X1',
      turnIndex: 2,
      value: 1500,
      laterTurnIndex: 3,
      planId: 'p2',
    });
    expect(first.result.axis2_recall.recallTurns[0]?.amounts.find((amount) => amount.value === 2000)?.status).toBe('derived');
    expect(first.result.axis2_recall.recallTurns[0]?.amounts.find((amount) => amount.value === 1000)?.status).toBe('derived');

    // 轴③：confirm 通知原文命中三类指纹；原文另存。
    expect(first.result.axis3_confirm_language.messages).toBe(3);
    expect(first.result.axis3_confirm_language.messageHitCount).toBe(1);
    expect(first.result.axis3_confirm_language.fingerprintHitCount).toBe(3);
    expect(first.result.axis3_confirm_language.labelCounts).toEqual({
      'JSON 片段': 1,
      '脚本路径': 1,
      '错误码': 1,
    });
    expect(readFileSync(humanPath, 'utf8')).toContain('src/dummy/scripts/query.js 返回 ERROR_CODE');

    // 确定性：同一输入（含同一输出路径）跑两次，JSON 与原文逐字节一致。
    const firstJson = readFileSync(outPath, 'utf8');
    const firstHuman = readFileSync(humanPath, 'utf8');
    runSpikeThreeAxis({
      probePath,
      planStatePath: plansPath,
      casesPath: CASES_PATH,
      outPath,
      humanOutPath: humanPath,
      caseIds: ['X1'],
    });
    expect(readFileSync(outPath, 'utf8')).toBe(firstJson);
    expect(readFileSync(humanPath, 'utf8')).toBe(firstHuman);
  });
});
