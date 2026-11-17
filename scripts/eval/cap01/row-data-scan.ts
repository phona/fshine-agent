/**
 * S3 行数据泄漏扫描（CAP-01 R2 S3 ④）。
 *
 * 判据口径（2026-11-17 收窄）：**只判 Main 面**——行数据不进 Main 上下文。
 *   · Main 面 = `call.agent === 'main'` 的工具调用参数/结果 + `run.agent === 'main'`
 *     的驱动回合输入（systemPrompt/messages/injections）与输出转录；
 *   · Worker 经 run_js 读行数据是设计行为，Worker 面的命中只计数作信息（detail 里
 *     「worker 面命中 N 处，按设计不计入」），不参与通过判定；
 *   · 覆盖下限 `MIN_MAIN_SURFACES`：Main 面过少 = 证据面缺失，检查本身不可信，判红
 *     （收窄后不许变成空扫描假绿）。
 *
 * 命中定义：alnum 边界包裹的原值才算命中——ID/时间戳的子串碰撞不算。金额是 6 位数字，
 * fileId/runId/时间戳等机械十六进制或连续数字里可能出现同样数字串；真实泄漏（自然文本/
 * JSON 值/代码字面量）一定带边界，ID 碰撞一定不带。
 */

export interface LeakScanSurface {
  name: string;
  text: string;
}

export interface LeakScanToolCall {
  agent: 'main' | 'worker';
  seq: number;
  tool: string;
  args: unknown;
  result?: unknown;
}

export interface LeakScanDriverRun {
  agent: 'main' | 'worker';
  systemPrompt: string;
  messages: readonly unknown[];
  injections: readonly string[];
  resultMessages: readonly unknown[];
}

export interface RowDataLeakScan {
  /** 通过 = Main 面零命中且 Main 面覆盖 >= MIN_MAIN_SURFACES。 */
  pass: boolean;
  mainSurfaceCount: number;
  mainHits: string[];
  workerHits: string[];
}

/** Main 面覆盖下限：低于此数判证据面不足（原口径即 >= 4，收窄后保留）。 */
export const MIN_MAIN_SURFACES = 4;

/** 行数据泄漏 grep：alnum 边界包裹的值才算命中——ID/时间戳的子串碰撞不算。 */
export function findDataLeaks(values: readonly string[], surfaces: ReadonlyArray<LeakScanSurface>): string[] {
  const hits: string[] = [];
  for (const value of values) {
    const pattern = new RegExp(`(?<![0-9A-Za-z])${value}(?![0-9A-Za-z])`);
    for (const surface of surfaces) {
      if (pattern.test(surface.text)) {
        hits.push(`${surface.name} 含原值 ${value}`);
      }
    }
  }
  return hits;
}

function serializeSurface(value: unknown): string {
  return JSON.stringify(value);
}

/** 收窄后的 S3 ④ 判定：Main 面命中判红；Worker 面命中只计数。 */
export function scanRowDataLeakage(
  calls: readonly LeakScanToolCall[],
  runs: readonly LeakScanDriverRun[],
  values: readonly string[],
): RowDataLeakScan {
  const main: LeakScanSurface[] = [];
  const worker: LeakScanSurface[] = [];
  for (const call of calls) {
    const surfaces = call.agent === 'main' ? main : worker;
    surfaces.push({ name: `tool-args(${call.agent}#${call.seq}:${call.tool})`, text: serializeSurface(call.args) });
    surfaces.push({ name: `tool-result(${call.agent}#${call.seq}:${call.tool})`, text: serializeSurface(call.result) });
  }
  for (const run of runs) {
    const surfaces = run.agent === 'main' ? main : worker;
    surfaces.push({ name: `driver-run-input(${run.agent})`, text: serializeSurface({ systemPrompt: run.systemPrompt, messages: run.messages, injections: run.injections }) });
    surfaces.push({ name: `driver-run-transcript(${run.agent})`, text: serializeSurface(run.resultMessages) });
  }
  const mainHits = findDataLeaks(values, main);
  const workerHits = findDataLeaks(values, worker);
  return {
    pass: mainHits.length === 0 && main.length >= MIN_MAIN_SURFACES,
    mainSurfaceCount: main.length,
    mainHits,
    workerHits,
  };
}

/** 检查 detail：Main 命中/覆盖不足优先；Worker 面命中数始终保留作信息。 */
export function rowDataLeakDetail(scan: RowDataLeakScan, valueCount: number): string {
  const workerNote = `worker 面命中 ${scan.workerHits.length} 处，按设计不计入`;
  if (scan.mainHits.length > 0) return `${scan.mainHits.slice(0, 10).join('；')}；${workerNote}`;
  if (scan.mainSurfaceCount < MIN_MAIN_SURFACES) {
    return `Main 面仅 ${scan.mainSurfaceCount} 个（<${MIN_MAIN_SURFACES}），覆盖不足，证据面不可信；${workerNote}`;
  }
  return `已扫 ${scan.mainSurfaceCount} 个 Main 面（工具参数/结果 + 驱动输入/转录），${valueCount} 个销售额原值零命中；${workerNote}`;
}
