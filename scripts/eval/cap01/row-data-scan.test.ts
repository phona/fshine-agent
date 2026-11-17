/**
 * S3 行数据泄漏判据（2026-11-17 口径收窄）单元测试——**零真实模型**。
 *
 * 设计口径：行数据不进 **Main** 上下文。Worker 经 run_js 读行数据是设计行为，
 * Worker 面的命中只作信息写进 detail（数量），不参与通过判定；Main 面（工具参数/结果 +
 * 驱动输入/转录）出现原值仍判红。覆盖下限 Main 面 >= 4 保留：收窄后 Main 面过少
 * 必须判红，不许变成空扫描假绿。
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_MAIN_SURFACES,
  rowDataLeakDetail,
  scanRowDataLeakage,
  type LeakScanDriverRun,
  type LeakScanToolCall,
} from './row-data-scan';

const RAW_VALUES = ['214073', '158262'];

const mainCall = (seq: number, tool: string, args: unknown, result?: unknown): LeakScanToolCall =>
  ({ agent: 'main', seq, tool, args, result });
const workerCall = (seq: number, tool: string, args: unknown, result?: unknown): LeakScanToolCall =>
  ({ agent: 'worker', seq, tool, args, result });

const mainRun = (systemPrompt: string, messages: readonly unknown[], resultMessages: readonly unknown[] = []): LeakScanDriverRun =>
  ({ agent: 'main', systemPrompt, messages, injections: [], resultMessages });
const workerRun = (systemPrompt: string, messages: readonly unknown[], resultMessages: readonly unknown[] = []): LeakScanDriverRun =>
  ({ agent: 'worker', systemPrompt, messages, injections: [], resultMessages });

describe('scanRowDataLeakage：只判 Main 面，Worker 面命中只作信息', () => {
  it('Worker 工具结果/转录含行数据：不判红，命中数进入 detail', () => {
    const calls = [
      mainCall(1, 'task_run', { task: '按月汇总', inputFiles: ['file_0123'] }, { taskId: 'task_1', status: 'completed' }),
      workerCall(1, 'run_js', { code: '...' }, '1月：214073 + 158262'),
    ];
    const runs = [
      mainRun('已交办执行层，见附件。', [], []),
      workerRun('读入明细并汇总。', ['读到的原值：214073'], ['读到的原值：158262']),
    ];
    const scan = scanRowDataLeakage(calls, runs, RAW_VALUES);

    expect(scan.mainSurfaceCount).toBeGreaterThanOrEqual(MIN_MAIN_SURFACES);
    expect(scan.mainHits).toEqual([]);
    expect(scan.workerHits.length).toBeGreaterThan(0);
    expect(scan.pass).toBe(true);
    const detail = rowDataLeakDetail(scan, RAW_VALUES.length);
    expect(detail).toContain(`worker 面命中 ${scan.workerHits.length} 处，按设计不计入`);
    expect(detail).toContain('Main 面');
  });

  it('Main 工具参数出现原值：仍判红', () => {
    const calls = [
      mainCall(1, 'task_run', { task: '汇总 214073' }, { taskId: 'task_1' }),
    ];
    const runs = [mainRun('已交办。', [], []), workerRun('已汇总。', [], [])];
    const scan = scanRowDataLeakage(calls, runs, RAW_VALUES);

    expect(scan.mainHits.some((hit) => hit.includes('tool-args(main#1:task_run)') && hit.includes('214073'))).toBe(true);
    expect(scan.pass).toBe(false);
    expect(rowDataLeakDetail(scan, RAW_VALUES.length)).toContain('214073');
  });

  it('Main 驱动转录出现原值：仍判红', () => {
    const calls = [mainCall(1, 'task_run', { task: '摘要' }, { taskId: 'task_1' })];
    const runs = [
      mainRun('已交办。', [], [{ role: 'assistant', content: '1月合计 158262' }]),
      workerRun('已汇总。', [], []),
    ];
    const scan = scanRowDataLeakage(calls, runs, RAW_VALUES);

    expect(scan.mainHits.some((hit) => hit.includes('driver-run-transcript(main)') && hit.includes('158262'))).toBe(true);
    expect(scan.pass).toBe(false);
  });

  it('只有 Worker 面（Main 面 < 4）：判红并注明覆盖不足，不许空扫描假绿', () => {
    const calls = [workerCall(1, 'run_js', { code: '...' }, '214073')];
    const runs = [workerRun('已生成。', ['158262'], [])];
    const scan = scanRowDataLeakage(calls, runs, RAW_VALUES);

    expect(scan.mainSurfaceCount).toBe(0);
    expect(scan.mainHits).toEqual([]);
    expect(scan.pass).toBe(false);
    expect(rowDataLeakDetail(scan, RAW_VALUES.length)).toContain('覆盖不足');
  });

  it('Main 与 Worker 都干净：通过，detail 仍写明 Worker 面 0 命中', () => {
    const calls = [mainCall(1, 'task_run', { task: '按月汇总' }, { taskId: 'task_1' })];
    const runs = [mainRun('已交办。', [], []), workerRun('已汇总。', [], [])];
    const scan = scanRowDataLeakage(calls, runs, RAW_VALUES);

    expect(scan.pass).toBe(true);
    expect(scan.mainSurfaceCount).toBeGreaterThanOrEqual(MIN_MAIN_SURFACES);
    expect(rowDataLeakDetail(scan, RAW_VALUES.length)).toContain('worker 面命中 0 处，按设计不计入');
  });
});
