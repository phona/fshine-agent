/**
 * CAP-01 确定性验收一键入口（零真实模型、零网络、零真实渠道）。
 *
 *   npm run eval:cap01                # 全部面，串行（确定性优先）
 *   npm run eval:cap01 -- --only r8   # 只跑某一面
 *
 * 面清单与顺序固定；**串行执行**——并行跑这些面会 spawn 一堆 CLI 子进程，
 * 30s 超时的老测试会假红（2026-11-17 实测过，别再并行）。
 *
 * 退出码：0 = 全部通过；1 = 任一面非 0；2 = 装配/参数错误。
 * 证据落在 .runtime/eval-cap01-all/<时间戳>/（不进 git）。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Face {
  /** 面标识（--only 用）。 */
  readonly key: string;
  /** 脚本相对路径。 */
  readonly script: string;
  /** 固定参数。 */
  readonly args: readonly string[];
  /** 这一面在验什么（给人看的一句话）。 */
  readonly what: string;
}

/** 顺序即台账顺序：功能面 → 攻击面 → 资源面 → 生命周期 → 故障面 → 并发面。 */
const FACES: readonly Face[] = [
  { key: 'r2', script: 'scripts/eval/cap01/r2-functional.ts', args: ['--scripted'], what: 'S1/S2/S3 功能面（脚本化）' },
  { key: 'r3', script: 'scripts/eval/cap01/r3-core.ts', args: [], what: '核心攻击面' },
  { key: 'r3b', script: 'scripts/eval/cap01/r3b-attacks.ts', args: [], what: '攻击加厚' },
  { key: 'r5', script: 'scripts/eval/cap01/r5-resources.ts', args: [], what: '资源与内存墙' },
  { key: 'r6', script: 'scripts/eval/cap01/r6-lifecycle.ts', args: [], what: '任务生命周期（取消/续跑）' },
  { key: 'r7', script: 'scripts/eval/cap01/r7-faults.ts', args: [], what: '故障注入' },
  { key: 'r8', script: 'scripts/eval/cap01/r8-concurrency.ts', args: [], what: '并发与隔离' },
];

function parseOnly(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--only');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error('--only 需要面标识（如 --only r8）');
  return value;
}

const only = parseOnly(process.argv.slice(2));
const selected = only === undefined ? FACES : FACES.filter((face) => face.key === only);
if (selected.length === 0) {
  console.error(`[cap01-all] 未知面：${only ?? '(none)'}（可选：${FACES.map((f) => f.key).join('/')}）`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(REPO_ROOT, '.runtime', 'eval-cap01-all', stamp);
mkdirSync(outDir, { recursive: true });

interface FaceResult {
  key: string;
  what: string;
  exitCode: number;
  durationMs: number;
  log: string;
}

const results: FaceResult[] = [];
for (const face of selected) {
  const logPath = path.join(outDir, `${face.key}.log`);
  console.log(`[cap01-all] ▶ ${face.key} · ${face.what}`);
  const startedAt = Date.now();
  const run = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', '--import', 'tsx', path.join(REPO_ROOT, face.script), ...face.args],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, TMPDIR: process.env['TMPDIR'] ?? '/home/tao/.tmp' } },
  );
  const durationMs = Date.now() - startedAt;
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  writeFileSync(logPath, log);
  const exitCode = run.status ?? 1;
  results.push({ key: face.key, what: face.what, exitCode, durationMs, log: path.relative(REPO_ROOT, logPath) });
  console.log(`[cap01-all] ${exitCode === 0 ? '✔' : '✘'} ${face.key} exit=${exitCode} ${Math.round(durationMs / 1000)}s → ${path.relative(REPO_ROOT, logPath)}`);
}

const failed = results.filter((result) => result.exitCode !== 0);
const summary = {
  generatedAt: new Date().toISOString(),
  outDir: path.relative(REPO_ROOT, outDir),
  passed: results.length - failed.length,
  total: results.length,
  results,
};
const summaryPath = path.join(outDir, 'summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`[cap01-all] ${summary.passed}/${summary.total} 面通过；summary=${path.relative(REPO_ROOT, summaryPath)}`);
process.exit(failed.length === 0 ? 0 : 1);
