/**
 * 性能评测 · 连续跑套件：把全量测试连跑 N 轮，落日志到 .runtime/perf/，供 analyze.ts 出
 * 耗时分布与 flake 报告。用途有两个：
 *   1. 稳定性背书——套件里有真实时钟等待（超时窗、冷却夹具），单轮绿不算数，连跑零 flake 才算；
 *   2. 耗时基线——三轮均值做分母，改测试基建（如 handler.test 的真实 sleep 换 fake timers）
 *      前后各跑一次，收益有数字。
 *
 * 为什么不带 --env-file=.env：性能跑的是离线套件，vitest.setup 会抹掉泄漏的 LLM_/EXECUTION_ 变量，
 * 显式加载 .env 反而把秘密送进测试环境——这里刻意不加载（与 eval:* 脚本相反，那组要真模型）。
 *
 * 用法：node --import tsx scripts/perf/run-suite.ts [轮数=3]
 * 日志：.runtime/perf/suite-r{N}.log（.runtime 已 gitignore，日志不进版本库）。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PERF_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '.runtime', 'perf');
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const rounds = Number(process.argv[2] ?? '') || 3;

mkdirSync(PERF_DIR, { recursive: true });
let failed = 0;
for (let i = 1; i <= rounds; i++) {
  const logPath = path.join(PERF_DIR, `suite-r${i}.log`);
  const start = Date.now();
  const child = spawnSync('npx', ['vitest', 'run'], { cwd: repoRoot, encoding: 'utf8', timeout: 10 * 60_000 });
  const wall = ((Date.now() - start) / 1000).toFixed(1);
  writeFileSync(logPath, child.stdout ?? '', 'utf8');
  const filesLine = (child.stdout ?? '').match(/Test Files\s+(\S+)\s+\((\d+)\)/)?.[0] ?? '?';
  const testsLine = (child.stdout ?? '').match(/Tests\s+(\S+)\s+\((\d+)\)/)?.[0] ?? '?';
  const ok = child.status === 0;
  if (!ok) failed++;
  console.log(`第 ${i}/${rounds} 轮  ${ok ? '✓' : '✗'}  wall ${wall}s  ${filesLine}  ${testsLine}  日志 ${logPath}`);
}
console.log(failed === 0 ? `\n${rounds} 轮全绿，零 flake。` : `\n${failed}/${rounds} 轮有红——先查 flake 再谈性能。`);
process.exit(failed === 0 ? 0 : 1);
