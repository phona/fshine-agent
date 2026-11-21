/**
 * 企微 × dummy 自动联调 · 一条命令跑全组：
 *
 *   node --import tsx scripts/eval/wecom-sim/run.ts
 *
 * 做什么：以 vitest JSON reporter 跑 `scripts/eval/wecom-sim` 全部用例（与
 * `vitest run scripts/eval/wecom-sim` 同一套、同一 vitest 配置——用例同样进全量门），
 * 然后输出逐条 PASS/FAIL（中文用例名 + 耗时）与 summary；任一失败退出码非 0，
 * 并打印失败详情（message 首段）。
 *
 * 不做什么：不另起装配、不改判据——判定全部来自 vitest 的用例结果；本文件只是
 * 「一条命令」的入口与读数汇总面。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface JsonAssertionResult {
  readonly title: string;
  readonly fullName: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo' | 'disabled' | 'pending';
  readonly duration?: number;
  readonly failureMessages?: readonly string[];
}

interface JsonReport {
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly success: boolean;
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly assertionResults: readonly JsonAssertionResult[];
  }>;
}

function firstLineOf(message: string): string {
  return message.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? '';
}

function main(): number {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'wecom-sim-run-'));
  const reportPath = path.join(workDir, 'wecom-sim-report.json');
  try {
    console.log('== 企微 × dummy 自动联调（真 createServer 装配 + 仓内 dummy 执行层 + 假企微 SDK；零网络零真实凭据）');
    console.log('== 用例面：W-01～W-04b / W-05～W-07 / W-08～W-12 / W-13～W-18 / W-19～W-21 / W-22～W-25（写确认） / W-26～W-28（任务面） / W-42～W-44（长任务·提醒·权限） / I-1～I-8（体验交互契约）；判据见 docs/product/wecom-live-dummy-cases.md 与 docs/product/interaction-contract.md');
    const vitestEntry = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const run = spawnSync(
      process.execPath,
      [vitestEntry, 'run', 'scripts/eval/wecom-sim', '--reporter=json', `--outputFile=${reportPath}`],
      { stdio: ['ignore', 'inherit', 'inherit'], cwd: REPO_ROOT, env: process.env },
    );

    let report: JsonReport | undefined;
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport;
    } catch {
      console.error('!! 未能读取 vitest JSON 报告（可能整个 suite 加载失败）；以上为原始输出。');
      return run.status ?? 1;
    }

    console.log('\n== 逐条结果');
    let failed = 0;
    let passed = 0;
    for (const file of report.testResults) {
      for (const assertion of file.assertionResults) {
        const ms = assertion.duration === undefined ? '' : `（${assertion.duration}ms）`;
        if (assertion.status === 'passed') {
          passed += 1;
          console.log(`  PASS  ${assertion.fullName}${ms}`);
        } else if (assertion.status === 'failed') {
          failed += 1;
          console.log(`  FAIL  ${assertion.fullName}${ms}`);
          for (const message of assertion.failureMessages ?? []) {
            const line = firstLineOf(message);
            if (line !== '') console.log(`        ↳ ${line}`);
          }
        } else {
          console.log(`  SKIP  ${assertion.fullName}`);
        }
      }
    }

    console.log('\n== summary');
    console.log(`  通过 ${passed} / 共 ${report.numTotalTests}；失败 ${failed}`);
    if (failed > 0) {
      console.log('  结论：不通过——先把上面的 FAIL 逐条看完再谈其它。');
      return 1;
    }
    console.log('  结论：全绿（自动化兜功能与不变量；观感/措辞/真网络时序仍归企微 live 人工交互面）。');
    return (run.status ?? 0) === 0 ? 0 : 1;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

process.exit(main());
