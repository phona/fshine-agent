/**
 * 机械计数器：读取 .runtime/a2a-cutover.jsonl 并输出 fallback 行数。
 *
 * 用法：node --import tsx scripts/eval/count-a2a-fallback.ts [--dir <path>] [--threshold <N>] [--state-file <path>] [--archive-to <path>]
 *   --dir：指定包含 .runtime/a2a-cutover.jsonl 的目录，默认 = 当前工作目录
 *   --threshold：连续 fallback=0 的跑次阈值，默认 = 20
 *   --state-file：连续计数器持久化文件，默认 = <dir>/.runtime/a2a-fallback-state.json
 *   --archive-to：归档 fallback 行到指定文件（保留非 fallback 行在原文件），归档后再计数
 *
 * 退出码：0 = fallback=0（含已达阈值）；1 = fallback>0。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface State { consecutiveZeros: number }

function readState(stateFile: string): State {
  if (!existsSync(stateFile)) return { consecutiveZeros: 0 };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  } catch {
    return { consecutiveZeros: 0 };
  }
}

function writeState(stateFile: string, state: State): void {
  try {
    writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

function archiveFallbackLines(file: string, archiveTo: string): void {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const fallbackLines: string[] = [];
  const remainingLines: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      remainingLines.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.fallback === true) {
        fallbackLines.push(line);
      } else {
        remainingLines.push(line);
      }
    } catch {
      remainingLines.push(line);
    }
  }
  if (fallbackLines.length === 0) return;
  // Write remaining lines back to main file
  writeFileSync(file, remainingLines.join('\n'));
  // Append fallback lines to archive file
  try {
    writeFileSync(archiveTo, fallbackLines.join('\n') + '\n', { flag: 'a' });
  } catch {
    // best-effort
  }
}

function main(): number {
  const args = process.argv.slice(2);
  let dir = process.cwd();
  let threshold = 20;
  let stateFile = '';
  let archiveTo = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) { dir = args[i + 1]!; i += 1; }
    else if (args[i] === '--threshold' && args[i + 1]) { threshold = Number.parseInt(args[i + 1]!, 10); i += 1; }
    else if (args[i] === '--state-file' && args[i + 1]) { stateFile = args[i + 1]!; i += 1; }
    else if (args[i] === '--archive-to' && args[i + 1]) { archiveTo = args[i + 1]!; i += 1; }
  }
  if (!stateFile) stateFile = `${dir}/.runtime/a2a-fallback-state.json`;
  const file = `${dir}/.runtime/a2a-cutover.jsonl`;
  if (archiveTo) {
    archiveFallbackLines(file, archiveTo);
  }
  let fallbackLines = 0;
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    fallbackLines = lines.filter((l) => {
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        return obj.fallback === true;
      } catch {
        return false;
      }
    }).length;
  }
  const state = readState(stateFile);
  if (fallbackLines > 0) {
    state.consecutiveZeros = 0;
    writeState(stateFile, state);
    console.log(`a2a-cutover.jsonl: ${fallbackLines} fallback lines at ${file} (consecutive zeros reset)`);
    return 1;
  }
  state.consecutiveZeros += 1;
  const reached = state.consecutiveZeros >= threshold;
  writeState(stateFile, state);
  if (reached) {
    console.log(`a2a-cutover.jsonl: 0 fallback lines at ${file} (consecutive zeros = ${state.consecutiveZeros}, threshold = ${threshold} — retirement condition met)`);
  } else {
    console.log(`a2a-cutover.jsonl: 0 fallback lines at ${file} (consecutive zeros = ${state.consecutiveZeros}, threshold = ${threshold})`);
  }
  return 0;
}

process.exitCode = main();
