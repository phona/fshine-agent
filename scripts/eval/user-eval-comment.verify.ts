/**
 * 生成脚本的本地验证（可独立运行）：
 *   node --import tsx scripts/eval/user-eval-comment.verify.ts
 *
 * 手工构造 `summary.json`（12 用例 × 1–3 trials，PASS/FAIL/INCONCLUSIVE 混合，
 * failureCodes 多条），写入临时目录，**实际 spawn 生成脚本 CLI**，然后断言：
 *   · 12 个用例全部出现在逐用例表（一个不截）；
 *   · 所有 verdict 与 failureCodes 原样保留（一个不丢）；
 *   · 失败/未决样本的证据目录逐个列出；
 *   · 日志尾部固定最后 LOG_TAIL_LINES 行，且明示「完整结果以上表为准」。
 *
 * 任一断言失败 → 退出 1；全部通过 → 打印 `VERIFY OK: cases=12 trials=... failureCodes=... tail=60`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOG_TAIL_LINES } from './user-eval-comment';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMENT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'eval', 'user-eval-comment.ts');
const EVIDENCE_ROOT = '.runtime/eval-user';

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
interface TrialEntry {
  verdict: Verdict;
  failureCodes: string[];
}

const CASE_IDS = Array.from({ length: 12 }, (_, index) => `E${String(index + 1).padStart(2, '0')}`);

/** 手工构造的期望矩阵：每例 1–3 trials；FAIL/INCONCLUSIVE 覆盖多条 failureCodes。 */
const CASE_TRIALS: Record<string, TrialEntry[]> = {
  E01: [
    { verdict: 'FAIL', failureCodes: ['FAIL_NO_DELEGATION'] },
    { verdict: 'PASS', failureCodes: [] },
    { verdict: 'INCONCLUSIVE', failureCodes: ['INCONCLUSIVE_JUDGE'] },
  ],
  E02: [
    { verdict: 'PASS', failureCodes: [] },
    { verdict: 'FAIL', failureCodes: ['FAIL_WRONG_OBJECT'] },
    { verdict: 'FAIL', failureCodes: ['FAIL_PHANTOM_SUCCESS'] },
  ],
  E03: [
    { verdict: 'FAIL', failureCodes: ['FAIL_FABRICATED_DATA', 'FAIL_MISSING_EXECUTION_FACTS'] },
    { verdict: 'PASS', failureCodes: [] },
  ],
  E04: [{ verdict: 'PASS', failureCodes: [] }],
  E05: [{ verdict: 'FAIL', failureCodes: ['FAIL_ZERO_EXECUTION'] }],
  E06: [{ verdict: 'INCONCLUSIVE', failureCodes: ['INCONCLUSIVE_JUDGE'] }],
  E07: [{ verdict: 'PASS', failureCodes: [] }],
  E08: [{ verdict: 'FAIL', failureCodes: ['FAIL_UNNECESSARY_DELEGATION'] }],
  E09: [{ verdict: 'INCONCLUSIVE', failureCodes: ['INCONCLUSIVE_JUDGE'] }],
  E10: [{ verdict: 'PASS', failureCodes: [] }],
  E11: [{ verdict: 'FAIL', failureCodes: ['FAIL_STATE_INCONSISTENCY'] }],
  E12: [
    { verdict: 'INCONCLUSIVE', failureCodes: ['INCONCLUSIVE_JUDGE'] },
    { verdict: 'FAIL', failureCodes: ['FAIL_NEEDLESS_CLARIFICATION'] },
  ],
};

function buildFixtureSummary(): Record<string, unknown> {
  const matrix: Record<string, Record<string, { verdict: string; failureCodes: string[] }>> = {};
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
    matrix[caseId] = {};
    entries.forEach((entry, index) => {
      matrix[caseId]![`trial-${index + 1}`] = { verdict: entry.verdict, failureCodes: [...entry.failureCodes] };
      counts[entry.verdict] += 1;
    });
  }
  return {
    runId: 'verify-run-20261117',
    generatedAt: '2026-11-17T00:00:00.000Z',
    criteriaVersion: 'verify-criteria',
    matrix,
    counts,
    failureCodeHistogram: {},
    dimensionHistogram: {},
    trialsPlanned: [1, 2, 3],
    samples: Object.values(CASE_TRIALS).reduce((total, entries) => total + entries.length, 0),
  };
}

interface VerificationResult {
  caseCount: number;
  trialCount: number;
  failureCodeCount: number;
  tailLines: number;
}

export function runVerification(): VerificationResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'user-eval-comment-verify-'));
  try {
    const summaryPath = path.join(dir, 'summary.json');
    const logPath = path.join(dir, 'run.log');
    const outPath = path.join(dir, 'comment.md');
    writeFileSync(summaryPath, `${JSON.stringify(buildFixtureSummary(), null, 2)}\n`);

    const logLines = Array.from({ length: 75 }, (_, index) => `log-line-${String(index + 1).padStart(2, '0')}`);
    writeFileSync(logPath, `${logLines.join('\n')}\n`);

    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', COMMENT_SCRIPT,
        '--summary', summaryPath,
        '--log', logPath,
        '--out', outPath,
        '--evidence-root', EVIDENCE_ROOT,
        '--artifact', 'user-eval-report',
        '--commit', '0123456789abcdef0123456789abcdef01234567',
        '--run-url', 'https://example.invalid/actions/runs/42',
        '--event', 'pull_request',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `生成脚本退出 ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const comment = readFileSync(outPath, 'utf8');

    const rows = comment.split('\n').filter((line) => /^\| E\d{2} \|/.test(line));
    assert.equal(rows.length, CASE_IDS.length, `逐用例表行数 ${rows.length} != ${CASE_IDS.length}`);
    const rowIds = rows.map((line) => line.split('|')[1]!.trim());
    assert.deepEqual(rowIds, CASE_IDS, `用例顺序/集合不符：${rowIds.join(',')}`);

    const failureCodes = new Set<string>();
    let trialCount = 0;
    for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
      const row = rows.find((line) => line.startsWith(`| ${caseId} |`));
      assert.ok(row !== undefined, `缺少 ${caseId} 的表格行`);
      for (const entry of entries) {
        trialCount += 1;
        assert.ok(row.includes(entry.verdict), `${caseId} 行缺 verdict ${entry.verdict}`);
        for (const code of entry.failureCodes) {
          failureCodes.add(code);
          assert.ok(row.includes(code), `${caseId} 行丢掉 failureCode ${code}`);
        }
      }
    }
    assert.equal(failureCodes.size, 10, `failureCode 覆盖数 ${failureCodes.size} != 10`);

    for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
      entries.forEach((entry, index) => {
        const evidenceDir = `${EVIDENCE_ROOT}/runs/${caseId}/trial-${index + 1}`;
        if (entry.verdict === 'PASS') {
          assert.ok(!comment.includes(evidenceDir), `PASS 样本不应出现在失败证据清单：${evidenceDir}`);
        } else {
          assert.ok(comment.includes(evidenceDir), `缺证据目录 ${evidenceDir}`);
        }
      });
    }

    assert.equal(LOG_TAIL_LINES, 60, `日志尾部行数常量 ${LOG_TAIL_LINES} != 60`);
    for (let number = 76 - LOG_TAIL_LINES; number <= 75; number += 1) {
      const line = `log-line-${String(number).padStart(2, '0')}`;
      assert.ok(comment.includes(line), `缺日志尾部行 ${line}`);
    }
    for (let number = 1; number < 76 - LOG_TAIL_LINES; number += 1) {
      const line = `log-line-${String(number).padStart(2, '0')}`;
      assert.ok(!comment.includes(line), `日志前部行 ${line} 不应出现（只保留最后 ${LOG_TAIL_LINES} 行）`);
    }
    assert.ok(comment.includes('完整结果以上表为准'), '缺「完整结果以上表为准」声明');
    assert.ok(comment.includes('user-eval-report'), '缺 artifact 名');
    assert.ok(comment.includes('pull_request'), '缺 event 元信息');

    return { caseCount: rowIds.length, trialCount, failureCodeCount: failureCodes.size, tailLines: LOG_TAIL_LINES };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const result = runVerification();
    console.log(
      `VERIFY OK: cases=${result.caseCount} trials=${result.trialCount} failureCodes=${result.failureCodeCount} tail=${result.tailLines}`,
    );
  } catch (error) {
    console.error(`VERIFY FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
