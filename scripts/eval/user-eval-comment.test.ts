/**
 * eval-real PR 评论生成器（`scripts/eval/user-eval-comment.ts`）契约。
 *
 * 事故形状：评论只贴日志最后 60 行，逐用例表被截掉——E01–E05 完全不可见，
 * 审查者无法核对「通过转失败」。这里的用例钉住：
 *   · 逐用例表从 summary.json 的 matrix 全量生成（12 用例一个不少、failureCodes 一个不丢）；
 *   · trial 列取 matrix ∪ trialsPlanned，缺记录显示「—（缺失）」而不是静默省略；
 *   · 失败/未决样本的证据目录逐条列出（.runtime/eval-user/runs/<case>/trial-N）；
 *   · 日志尾部只作附录且固定 60 行，并明示「完整结果以上表为准」；
 *   · workflow 真正调用生成脚本、先生成再上传 artifact、评论读 comment.md（不再 slice(-60)）。
 *
 * 反向绊线：删掉任一行用例、丢任一 failureCode、把证据目录省略或恢复日志尾部截断，
 * 对应用例会红。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_TAIL_LINES, buildEvalComment, type EvalSummary } from './user-eval-comment';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CASE_IDS = Array.from({ length: 12 }, (_, index) => `E${String(index + 1).padStart(2, '0')}`);

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
interface TrialEntry {
  verdict: Verdict;
  failureCodes: string[];
}

/** 手工构造：12 用例 × 1–3 trials，PASS/FAIL/INCONCLUSIVE 混合，failureCodes 覆盖多条。 */
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

function countFromMatrix(matrix: EvalSummary['matrix']): { PASS: number; FAIL: number; INCONCLUSIVE: number } {
  const counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const trials of Object.values(matrix)) {
    for (const entry of Object.values(trials)) counts[entry.verdict as Verdict] += 1;
  }
  return counts;
}

function fixtureSummary(): EvalSummary {
  const matrix: EvalSummary['matrix'] = {};
  for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
    matrix[caseId] = {};
    entries.forEach((entry, index) => {
      matrix[caseId]![`trial-${index + 1}`] = { verdict: entry.verdict, failureCodes: [...entry.failureCodes] };
    });
  }
  return {
    runId: 'fixture-run-20261117',
    generatedAt: '2026-11-17T00:00:00.000Z',
    criteriaVersion: 'fixture-criteria',
    matrix,
    counts: countFromMatrix(matrix),
    failureCodeHistogram: {},
    dimensionHistogram: {},
    trialsPlanned: [1, 2, 3],
    samples: Object.values(CASE_TRIALS).reduce((total, entries) => total + entries.length, 0),
  };
}

const META = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  runUrl: 'https://example.invalid/actions/runs/42',
  event: 'pull_request',
  artifactName: 'user-eval-report',
  evidenceRoot: '.runtime/eval-user',
} as const;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'user-eval-comment-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tableRows(comment: string): string[] {
  return comment.split('\n').filter((line) => /^\| E\d{2} \|/.test(line));
}

function rowFor(comment: string, caseId: string): string {
  const row = tableRows(comment).find((line) => line.startsWith(`| ${caseId} |`));
  expect(row, `缺少 ${caseId} 的表格行`).toBeDefined();
  return row!;
}

describe('buildEvalComment：逐用例表全量、不截断', () => {
  it('全部用例按 CASE_IDS 顺序出现在表里', () => {
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: [], meta: META });
    const ids = tableRows(comment).map((line) => line.split('|')[1]!.trim());
    expect(ids).toEqual(CASE_IDS);
  });

  it('表头覆盖 matrix ∪ trialsPlanned 的全部 trial 列（trial-1..3）', () => {
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: [], meta: META });
    const header = comment.split('\n').find((line) => line.startsWith('| 用例 |'));
    expect(header).toBe('| 用例 | trial-1 | trial-2 | trial-3 |');
  });

  it('每个 trial 的 verdict 与 failureCodes 都原样出现在所属行（一个不丢）', () => {
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: [], meta: META });
    for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
      const row = rowFor(comment, caseId);
      for (const entry of entries) {
        expect(row, `${caseId} 缺 verdict ${entry.verdict}`).toContain(entry.verdict);
        for (const code of entry.failureCodes) {
          expect(row, `${caseId} 丢掉 failureCode ${code}`).toContain(code);
        }
      }
    }
  });

  it('计划内有、matrix 里缺的 trial 显示「—（缺失）」而不是省略列', () => {
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: [], meta: META });
    const row = rowFor(comment, 'E04');
    expect(row).toBe('| E04 | PASS | —（缺失） | —（缺失） |');
  });

  it('summary.counts 与 matrix 复核不一致时显式告警，并以 matrix 为准', () => {
    const summary = fixtureSummary();
    summary.counts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
    const comment = buildEvalComment({ summary, logTail: [], meta: META });
    expect(comment).toContain('summary.counts');
    expect(comment).toContain('不一致');
    expect(comment).toContain('本表以 matrix 为准');
  });
});

describe('buildEvalComment：证据目录与日志附录', () => {
  it('失败/未决样本逐个列出 .runtime/eval-user/runs/<case>/trial-N', () => {
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: [], meta: META });
    for (const [caseId, entries] of Object.entries(CASE_TRIALS)) {
      entries.forEach((entry, index) => {
        const evidenceDir = `.runtime/eval-user/runs/${caseId}/trial-${index + 1}`;
        if (entry.verdict === 'PASS') {
          expect(comment, `PASS 样本不应进入失败证据清单：${evidenceDir}`).not.toContain(evidenceDir);
        } else {
          expect(comment, `缺证据目录 ${evidenceDir}`).toContain(evidenceDir);
        }
      });
    }
    expect(comment).toContain('user-eval-report');
  });

  it('日志尾部固定最后 60 行，前文不出现，且明示「完整结果以上表为准」', () => {
    const logLines = Array.from({ length: 75 }, (_, index) => `log-line-${String(index + 1).padStart(2, '0')}`);
    const comment = buildEvalComment({ summary: fixtureSummary(), logTail: logLines.join('\n'), meta: META });
    expect(LOG_TAIL_LINES).toBe(60);
    for (let number = 16; number <= 75; number += 1) {
      expect(comment, `缺日志第 ${number} 行`).toContain(`log-line-${String(number).padStart(2, '0')}`);
    }
    for (let number = 1; number <= 15; number += 1) {
      expect(comment, `日志前 ${number} 行不应出现（只保留最后 60 行）`).not.toContain(
        `log-line-${String(number).padStart(2, '0')}`,
      );
    }
    expect(comment).toContain('完整结果以上表为准');
    expect(comment).toContain('最后 60 行');
  });
});

describe('CLI 与 workflow 接线', () => {
  it('验证脚本用 12×1–3 的手工 summary.json 跑生成脚本，全部用例与 failureCodes 保留', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval/user-eval-comment.verify.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('VERIFY OK');
    expect(result.stdout).toContain('cases=12');
  });

  it('summary.json 缺失时退出 1 并写「无法生成逐用例表」，不伪造表格', () => {
    const dir = tempDir();
    const out = path.join(dir, 'comment.md');
    const result = spawnSync(
      process.execPath,
      [
        '--import', 'tsx', 'scripts/eval/user-eval-comment.ts',
        '--summary', path.join(dir, 'missing-summary.json'),
        '--out', out,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const body = readFileSync(out, 'utf8');
    expect(body).toContain('无法生成逐用例表');
    expect(body).toContain('summary.json');
    expect(body).not.toMatch(/^\| 用例 \|/m);
  });

  it('eval-real.yml 真正调用生成脚本、先生成后上传 artifact、评论读 comment.md', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'eval-real.yml'), 'utf8');
    expect(workflow).toContain('scripts/eval/user-eval-comment.ts');
    expect(workflow).toContain('--summary .runtime/eval-user/summary.json');
    expect(workflow).toContain('--out .runtime/eval-user/comment.md');
    expect(workflow).toContain('--log .runtime/eval-user/run.log');
    expect(workflow).toContain('comment.md');
    expect(workflow).not.toContain('slice(-60)');
    expect(workflow).not.toContain('summary.txt');
    expect(workflow).toContain('name: user-eval-report');
    expect(workflow).toContain('path: .runtime/eval-user/');
    expect(workflow.indexOf('Upload eval report artifact')).toBeGreaterThan(
      workflow.indexOf('Generate PR eval comment'),
    );
    expect(workflow.indexOf('Comment PR with eval report')).toBeGreaterThan(
      workflow.indexOf('Upload eval report artifact'),
    );
  });
});
