/**
 * 从 `npm run eval:user` 的 `summary.json` 生成 eval-real PR 评论正文。
 *
 * 背景（事故）：旧评论只贴 `summary.txt` 的最后 60 行，逐用例结果表被截掉，
 * E01–E05 完全不可见，审查者无法核对「通过转失败」。本脚本把评论拆成三块：
 *   1) 逐用例表：从 `summary.matrix` 全量生成，用例一个不少、failureCodes 一个不丢；
 *      trial 列 = matrix 内 trial ∪ `trialsPlanned`，缺记录显示「—（缺失）」而不是省略；
 *   2) 失败/未决样本证据目录：逐条列出 `<evidence-root>/runs/<case>/trial-N`；
 *   3) 日志尾部：固定最后 `LOG_TAIL_LINES` 行，只作附录，并明示「完整结果以上表为准」。
 *
 * `summary.json` 缺失/不可解析时**不伪造结果**：写一份明确说「无法生成逐用例表」的
 * 评论正文并退出 1，让 workflow 照实发布。
 *
 * CLI（workflow 逐字调用）：
 *   node --import tsx scripts/eval/user-eval-comment.ts \
 *     --summary <summary.json> [--log <run.log>] [--out <comment.md>] \
 *     [--evidence-root <label>] [--artifact <name>] [--commit <sha>] \
 *     [--run-url <url>] [--event <name>]
 *   缺省 --summary = .runtime/eval-user/summary.json；不传 --out 时写到 stdout。
 *
 * 退出码：0=生成成功；1=summary 缺失/不可解析（仍写出说明正文）；2=参数错误。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LOG_TAIL_LINES = 60;
export const DEFAULT_ARTIFACT_NAME = 'user-eval-report';
export const DEFAULT_EVIDENCE_ROOT = '.runtime/eval-user';
const DEFAULT_SUMMARY_PATH = '.runtime/eval-user/summary.json';
const TITLE = '## Real-model eval (user-level, mechanical exit code)';
const BOUNDARY =
  'Boundary: this workflow is NOT a required check yet. Judge conclusions are advisory only.';

export interface TrialVerdictEntry {
  verdict: string;
  failureCodes?: string[];
}

export interface EvalSummary {
  runId?: string;
  generatedAt?: string;
  criteriaVersion?: string;
  counts?: Partial<Record<'PASS' | 'FAIL' | 'INCONCLUSIVE', number>>;
  matrix: Record<string, Record<string, TrialVerdictEntry>>;
  failureCodeHistogram?: Record<string, number>;
  dimensionHistogram?: Record<string, Record<string, number>>;
  trialsPlanned?: number[];
  samples?: number;
  suite?: { id?: string; casesCount?: number };
}

export interface EvalCommentMeta {
  commit?: string;
  runUrl?: string;
  event?: string;
  artifactName?: string;
  evidenceRoot?: string;
}

export interface EvalCommentInput {
  summary: EvalSummary;
  /** 运行日志全文（只取最后 LOG_TAIL_LINES 行）或已切好的行。 */
  logTail?: string | readonly string[];
  meta?: EvalCommentMeta;
}

/** 按用例号自然排序（E2 < E10；未知 id 按字典序兜底）。 */
function compareCaseIds(left: string, right: string): number {
  const leftNumber = /(\d+)$/.exec(left);
  const rightNumber = /(\d+)$/.exec(right);
  if (leftNumber !== null && rightNumber !== null) return Number(leftNumber[1]) - Number(rightNumber[1]);
  return left.localeCompare(right);
}

function normalizeLogTail(logTail: string | readonly string[] | undefined): { lines: string[]; total: number } {
  if (logTail === undefined) return { lines: [], total: 0 };
  if (typeof logTail !== 'string') return { lines: [...logTail], total: logTail.length };
  const normalized = logTail.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (normalized === '') return { lines: [], total: 0 };
  const lines = normalized.split('\n');
  return { lines, total: lines.length };
}

/** 选一个比日志内最长反引号串更长的围栏，避免日志内容提前闭合代码块。 */
function fenceFor(lines: readonly string[]): string {
  let longest = 0;
  for (const line of lines) {
    for (const match of line.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderVerdictCell(entry: TrialVerdictEntry | undefined): string {
  if (entry === undefined) return '—';
  const codes = (entry.failureCodes ?? []).map((code) => `\`${code}\``);
  return codes.length > 0 ? `${entry.verdict} (${codes.join(', ')})` : entry.verdict;
}

function trialNumbersOf(summary: EvalSummary): number[] {
  const numbers = new Set<number>();
  for (const trials of Object.values(summary.matrix ?? {})) {
    for (const key of Object.keys(trials)) {
      const match = /^trial-(\d+)$/.exec(key);
      if (match !== null) numbers.add(Number(match[1]));
    }
  }
  for (const planned of summary.trialsPlanned ?? []) numbers.add(planned);
  return [...numbers].sort((left, right) => left - right);
}

function summarizeCounts(summary: EvalSummary): {
  computed: { PASS: number; FAIL: number; INCONCLUSIVE: number };
  mismatched: boolean;
} {
  const computed = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const trials of Object.values(summary.matrix ?? {})) {
    for (const entry of Object.values(trials)) {
      if (entry.verdict === 'PASS' || entry.verdict === 'FAIL' || entry.verdict === 'INCONCLUSIVE') {
        computed[entry.verdict] += 1;
      }
    }
  }
  const declared = summary.counts;
  const mismatched =
    declared !== undefined &&
    (['PASS', 'FAIL', 'INCONCLUSIVE'] as const).some((verdict) => (declared[verdict] ?? 0) !== computed[verdict]);
  return { computed, mismatched };
}

function renderHeaderLines(meta: EvalCommentMeta, summary?: EvalSummary): string[] {
  const artifact = meta.artifactName ?? DEFAULT_ARTIFACT_NAME;
  const evidenceRoot = meta.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT;
  const lines = [
    TITLE,
    '',
    `- Commit: \`${meta.commit ?? '（未提供）'}\` (PR head at run time)`,
    `- Run: ${meta.runUrl ?? '（未提供）'}`,
    `- Event: ${meta.event ?? '（未提供）'}`,
  ];
  if (summary?.runId !== undefined) lines.push(`- runId: \`${summary.runId}\``);
  if (summary?.criteriaVersion !== undefined) lines.push(`- criteriaVersion: \`${summary.criteriaVersion}\``);
  if (summary !== undefined) {
    const { computed } = summarizeCounts(summary);
    lines.push(`- 样本：${computed.PASS + computed.FAIL + computed.INCONCLUSIVE}（PASS ${computed.PASS} / FAIL ${computed.FAIL} / INCONCLUSIVE ${computed.INCONCLUSIVE}）`);
  }
  lines.push(`- Artifact: \`${artifact}\`（含 \`${evidenceRoot}/\` 全量逐样本证据与 summary.json；从上面 Run 链接 → Artifacts 下载）`);
  lines.push('', BOUNDARY, '');
  return lines;
}

function renderTail(lines: string[], total: number, emptyText: string): string[] {
  const tail = lines.slice(-LOG_TAIL_LINES);
  const fence = fenceFor(tail);
  const rendered = [
    `### 日志尾部（最后 ${LOG_TAIL_LINES} 行，附录）`,
    '',
  ];
  if (total > tail.length) rendered.push(`（日志共 ${total} 行，仅显示最后 ${LOG_TAIL_LINES} 行）`, '');
  rendered.push(fence, ...(tail.length > 0 ? tail : [emptyText]), fence, '');
  rendered.push(`> 完整结果以上表为准；日志尾部仅作附录（固定最后 ${LOG_TAIL_LINES} 行，可能缺少上下文）。`);
  return rendered;
}

/** 从 summary.json 生成完整评论正文（纯函数，便于本地/单测直接调用）。 */
export function buildEvalComment(input: EvalCommentInput): string {
  const { summary, meta = {} } = input;
  if (summary.matrix === undefined || summary.matrix === null || typeof summary.matrix !== 'object') {
    throw new Error('summary.json 缺少 matrix 对象');
  }
  const evidenceRoot = meta.evidenceRoot ?? DEFAULT_EVIDENCE_ROOT;
  const caseIds = Object.keys(summary.matrix).sort(compareCaseIds);
  const trialNumbers = trialNumbersOf(summary);
  const { computed, mismatched } = summarizeCounts(summary);

  const lines = renderHeaderLines(meta, summary);
  if (mismatched) {
    lines.push(
      `- ⚠️ \`summary.counts\` 与 \`matrix\` 复核不一致（counts: PASS ${summary.counts?.PASS ?? 0} / FAIL ${summary.counts?.FAIL ?? 0} / INCONCLUSIVE ${summary.counts?.INCONCLUSIVE ?? 0}；matrix: PASS ${computed.PASS} / FAIL ${computed.FAIL} / INCONCLUSIVE ${computed.INCONCLUSIVE}）；本表以 matrix 为准。`,
      '',
    );
  }

  lines.push('### 逐用例结果（完整，不截断）', '');
  if (caseIds.length === 0) {
    lines.push('> matrix 为空——summary.json 里没有任何 trial 结果（未伪造通过）。', '');
  } else {
    lines.push(`| 用例 | ${trialNumbers.map((number) => `trial-${number}`).join(' | ')} |`);
    lines.push(`| --- | ${trialNumbers.map(() => '---').join(' | ')} |`);
    const missing: string[] = [];
    for (const caseId of caseIds) {
      const trials = summary.matrix[caseId] ?? {};
      const cells = trialNumbers.map((number) => {
        const entry = trials[`trial-${number}`];
        if (entry === undefined) {
          if ((summary.trialsPlanned ?? []).includes(number)) {
            missing.push(`${caseId} trial-${number}`);
            return '—（缺失）';
          }
          return '—';
        }
        return renderVerdictCell(entry);
      });
      lines.push(`| ${caseId} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('> 完整结果以上表为准：本表由 `summary.json` 的 `matrix` 逐项生成，未截断、未筛绿。');
    if (missing.length > 0) {
      lines.push('', `- ⚠️ matrix 缺少计划 trial：${missing.join(', ')}（上表以「—（缺失）」标出，未用其他结果顶替）。`);
    }
    lines.push('');
  }

  lines.push('### 失败/未决样本证据目录', '');
  const failedTrials: string[] = [];
  for (const caseId of caseIds) {
    const trials = summary.matrix[caseId] ?? {};
    const numbers = Object.keys(trials)
      .map((key) => /^trial-(\d+)$/.exec(key))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
    for (const number of numbers) {
      const entry = trials[`trial-${number}`]!;
      if (entry.verdict === 'PASS') continue;
      const codes = (entry.failureCodes ?? []).map((code) => `\`${code}\``).join(', ');
      failedTrials.push(
        `- \`${caseId}\` / \`trial-${number}\`：${entry.verdict}${codes.length > 0 ? `（${codes}）` : ''} → \`${evidenceRoot}/runs/${caseId}/trial-${number}/\``,
      );
    }
  }
  if (failedTrials.length === 0) {
    lines.push('- 无（全部 trial 为 PASS）。', '');
  } else {
    lines.push(...failedTrials, '');
    lines.push(`- 以上路径均在 artifact \`${meta.artifactName ?? DEFAULT_ARTIFACT_NAME}\` 内（\`${evidenceRoot}/runs/<case>/trial-N/\`）。`, '');
  }

  const { lines: logLines, total } = normalizeLogTail(input.logTail);
  lines.push(...renderTail(logLines, total, '（日志为空或缺失）'));
  return `${lines.join('\n')}\n`;
}

/** summary.json 缺失/不可解析时的如实说明正文（绝不伪造逐用例表）。 */
export function buildUnavailableComment(input: {
  reason: string;
  logTail?: string | readonly string[];
  meta?: EvalCommentMeta;
}): string {
  const { lines: logLines, total } = normalizeLogTail(input.logTail);
  const lines = [
    ...renderHeaderLines(input.meta ?? {}),
    '> ⚠️ 无法生成逐用例表：summary.json 缺失或不可解析（' + input.reason + '）。不要用日志尾部推断逐用例结果。',
    '',
    ...renderTail(logLines, total, '（日志为空或缺失）'),
  ];
  return `${lines.join('\n')}\n`;
}

export interface CommentCliArgs {
  summaryPath: string;
  logPath?: string;
  outPath?: string;
  meta: EvalCommentMeta;
}

export function parseCommentArgs(argv: readonly string[]): CommentCliArgs | { usageError: string } {
  const args: CommentCliArgs = { summaryPath: DEFAULT_SUMMARY_PATH, meta: {} };
  const readValue = (index: number, flag: string): string | { error: string } => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} 需要一个值` };
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | { error: string } => (inline !== undefined ? inline : readValue(index, flag));
    if (flag === '--summary' || flag === '--log' || flag === '--out' || flag === '--evidence-root'
      || flag === '--artifact' || flag === '--commit' || flag === '--run-url' || flag === '--event') {
      const got = value();
      if (typeof got !== 'string') return { usageError: got.error };
      if (inline === undefined) index += 1;
      switch (flag) {
        case '--summary': args.summaryPath = got; break;
        case '--log': args.logPath = got; break;
        case '--out': args.outPath = got; break;
        case '--evidence-root': args.meta.evidenceRoot = got; break;
        case '--artifact': args.meta.artifactName = got; break;
        case '--commit': args.meta.commit = got; break;
        case '--run-url': args.meta.runUrl = got; break;
        case '--event': args.meta.event = got; break;
        default: break;
      }
    } else {
      return { usageError: `未知参数：${arg}` };
    }
  }
  return args;
}

export function runCommentCli(argv: readonly string[]): number {
  const parsed = parseCommentArgs(argv);
  if ('usageError' in parsed) {
    console.error(parsed.usageError);
    return 2;
  }
  const logText = parsed.logPath !== undefined && existsSync(parsed.logPath)
    ? readFileSync(parsed.logPath, 'utf8')
    : parsed.logPath !== undefined
      ? `（日志缺失：${parsed.logPath}）`
      : undefined;

  let body: string;
  let exitCode = 0;
  try {
    if (!existsSync(parsed.summaryPath)) throw new Error(`找不到 ${parsed.summaryPath}`);
    const summary = JSON.parse(readFileSync(parsed.summaryPath, 'utf8')) as EvalSummary;
    body = buildEvalComment({ summary, ...(logText !== undefined ? { logTail: logText } : {}), meta: parsed.meta });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    body = buildUnavailableComment({
      reason,
      ...(logText !== undefined ? { logTail: logText } : {}),
      meta: parsed.meta,
    });
    exitCode = 1;
  }

  if (parsed.outPath !== undefined) {
    mkdirSync(path.dirname(parsed.outPath), { recursive: true });
    writeFileSync(parsed.outPath, body);
  } else {
    process.stdout.write(body);
  }
  return exitCode;
}

if (import.meta.main) {
  process.exitCode = runCommentCli(process.argv.slice(2));
}
