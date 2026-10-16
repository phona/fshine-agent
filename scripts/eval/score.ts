/**
 * Tier-1 打分器（L7 / D-060）：把「可信度靠 eval 基线跑漂移，不靠审计轮次」变成一条命令。
 *
 * 取数面（都是本仓已落地的仪器，本模块零判定逻辑复制）：
 *   · 机械分量（四维违例数）← 探针报告 .runtime/probe-*.json（归维表 scripts/eval/dims.ts）
 *   · 写链三指标 ← acceptance 报告 JSON 的 writeChain 节（scripts/eval/write-chain.ts）
 *   · 评委分量（--judge）← scripts/eval/judge.ts（只吃转录，与机械分量独立）
 *
 * 判定口径（对 baseline.json 逐项比对）：
 *   · 机械分量：违例数 ≤ 基线（只增才算劣化——A2 的既有观察项用上限 1 表达"不劣化"）；
 *   · 评委分量：得分 ≥ 基线 − 容差（默认 1；基线 null = 未定，跳过并提示）；
 *   · 写链：布尔/下限逐项对照（提案尝试 ≥1、确认码已给出、意图已建、committed、读回在）；
 *   · 探针自身 ok（含任务行为类 note）：基线 okExpected 逐例对照（A2 按冻结表 = false）。
 *
 * 回归即 exit 1；输入缺失/语料-基线失配 exit 2。每轮向 .runtime/scores.jsonl 追加一行
 * （corpusVersion / judgePromptVersion / judgeModel 随行——三元组变了，分数不可比，须重定基线）。
 * 基线重定只走 --write-baseline（从当前轮实值生成），不手改文件。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIM_LABELS_ZH, NOTE_DIMS, type DimCounts, type NoteDim } from './dims';
import { judgeEnvReady, judgeModel, judgePromptVersion, judgeTranscript, type JudgeResult } from './judge';
import type { ConversationWriteChainFacts } from './write-chain';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, '..', '..');
const CORPUS_PATH = path.join(evalDir, 'corpus.jsonl');
const BASELINE_PATH = path.join(evalDir, 'baseline.json');
const SCORES_PATH = path.join(repoRoot, '.runtime', 'scores.jsonl');

// ── 数据形状 ──

export interface CorpusEntry {
  id: string;
  kind: 'probe' | 'acceptance';
  inBaseline: boolean;
  /** probe 用例 id（探针报告 results[].id）。 */
  case?: string;
  /** acceptance 会话 id（spec.conv）。 */
  conversation?: string;
  /** acceptance 组内用例（仅文档用；取数按会话）。 */
  cases?: string[];
  incidents: string[];
  expect: string;
}

export interface BaselineCase {
  /** 四维违例数上限（只增才算劣化）。 */
  dims?: DimCounts;
  /** 评委分基线；null = 未定（跳过并提示）。 */
  judge?: Partial<Record<NoteDim, number | null>>;
  judgeTolerance?: number;
  /** 探针自身 ok 的期望（缺省 true；A2 按冻结表 false）。 */
  okExpected?: boolean;
  note?: string;
}

export interface BaselineWriteChainGroup {
  proposalAttemptsAtLeast?: number;
  confirmCodeOffered?: boolean;
  intentCreated?: boolean;
  committed?: boolean;
  readbackVerified?: boolean;
}

export interface Baseline {
  version: number;
  generatedAt: string;
  note?: string;
  cases: Record<string, BaselineCase>;
  writeChain: Record<string, BaselineWriteChainGroup>;
}

export interface ProbeResultRow {
  id: string;
  ok: boolean;
  dims: DimCounts;
  unclassifiedNotes: number;
  notes: string[];
  turns: Array<{ text: string; reply: string; notices: string[] }>;
}

export interface ProbeReport { at: string; results: ProbeResultRow[] }

export interface Check { name: string; pass: boolean; expected: string; actual: string }
export interface CaseVerdict {
  id: string;
  kind: string;
  pass: boolean;
  checks: Check[];
  /** 评委原始结论（--judge 时），含引文证据，进 scores.jsonl 供人读。 */
  judge?: JudgeResult;
  note?: string;
}

// ── 加载与定位 ──

export function loadCorpus(corpusPath: string = CORPUS_PATH): CorpusEntry[] {
  const entries = readFileSync(corpusPath, 'utf8').split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .map((line, index) => {
      const entry = JSON.parse(line) as CorpusEntry;
      if (!entry.id || (entry.kind !== 'probe' && entry.kind !== 'acceptance')) {
        throw new Error(`语料第 ${index + 1} 行缺 id 或 kind 非法：${line.slice(0, 80)}`);
      }
      if (!Array.isArray(entry.incidents) || entry.incidents.length === 0) {
        throw new Error(`语料 ${entry.id} 缺 incidents（每条用例必须挂事故标签）`);
      }
      if (entry.kind === 'probe' && !entry.case) throw new Error(`语料 ${entry.id} 是 probe 但缺 case`);
      if (entry.kind === 'acceptance' && !entry.conversation) throw new Error(`语料 ${entry.id} 是 acceptance 但缺 conversation`);
      if (typeof entry.inBaseline !== 'boolean') throw new Error(`语料 ${entry.id} 缺 inBaseline`);
      return entry;
    });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`语料 id 重复：${entry.id}`);
    ids.add(entry.id);
  }
  return entries;
}

export function loadBaseline(baselinePath: string = BASELINE_PATH): Baseline {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  if (!baseline.cases || !baseline.writeChain) throw new Error('基线缺 cases/writeChain 节');
  return baseline;
}

export function corpusVersion(corpusPath: string = CORPUS_PATH): string {
  return createHash('sha256').update(readFileSync(corpusPath, 'utf8')).digest('hex').slice(0, 8);
}

/** 目录下最新一份报告（mtime 最大）。 */
export function latestReport(dir: string, prefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile());
  if (!candidates.length) return null;
  return candidates.reduce((latest, file) => (statSync(file).mtimeMs > statSync(latest).mtimeMs ? file : latest));
}

// ── 逐例判定（纯函数，单测面） ──

export function evaluateProbeCase(
  row: ProbeResultRow | undefined,
  baselineCase: BaselineCase | undefined,
  judge?: JudgeResult,
): CaseVerdict {
  const id = row?.id ?? '(未知用例)';
  if (!row) {
    return { id, kind: 'probe', pass: false, checks: [{ name: '探针报告含该用例', pass: false, expected: '在', actual: '缺' }] };
  }
  if (!baselineCase) {
    return { id, kind: 'probe', pass: false, checks: [{ name: '基线含该用例', pass: false, expected: '在', actual: '缺（进基线的语料必须有基线项）' }] };
  }
  const checks: Check[] = [];
  for (const dim of NOTE_DIMS) {
    const limit = baselineCase.dims?.[dim] ?? 0;
    const actual = row.dims[dim] ?? 0;
    checks.push({ name: `${DIM_LABELS_ZH[dim]}违例`, pass: actual <= limit, expected: `≤${limit}`, actual: String(actual) });
  }
  const okExpected = baselineCase.okExpected ?? true;
  checks.push({ name: '探针ok', pass: row.ok === okExpected, expected: String(okExpected), actual: String(row.ok) });
  const tolerance = baselineCase.judgeTolerance ?? 1;
  if (judge) {
    for (const dim of NOTE_DIMS) {
      const expected = baselineCase.judge?.[dim];
      if (expected === undefined) continue;
      if (expected === null) {
        checks.push({ name: `评委·${DIM_LABELS_ZH[dim]}`, pass: true, expected: '未定基线', actual: String(judge.scores[dim]) });
        continue;
      }
      const actual = judge.scores[dim];
      checks.push({ name: `评委·${DIM_LABELS_ZH[dim]}`, pass: actual >= expected - tolerance, expected: `≥${expected - tolerance}`, actual: String(actual) });
    }
  }
  return { id, kind: 'probe', pass: checks.every((check) => check.pass), checks, judge };
}

export function evaluateWriteChainCase(
  entry: CorpusEntry,
  facts: ConversationWriteChainFacts | undefined,
  group: BaselineWriteChainGroup | undefined,
): CaseVerdict {
  const expectedTrue = (name: string, expected: boolean | undefined, actual: boolean): Check => ({
    name,
    pass: expected === undefined ? true : actual === expected,
    expected: expected === undefined ? '（基线未定）' : String(expected),
    actual: String(actual),
  });
  if (!facts) {
    return { id: entry.id, kind: 'acceptance', pass: false, checks: [{ name: '验收报告含该会话', pass: false, expected: entry.conversation ?? '', actual: '缺' }] };
  }
  if (!group) {
    return { id: entry.id, kind: 'acceptance', pass: false, checks: [{ name: '基线含该会话', pass: false, expected: '在', actual: '缺（进基线的语料必须有基线项）' }] };
  }
  const committed = facts.intents.some((intent) => intent.status === 'committed');
  const checks: Check[] = [
    {
      name: '提案尝试',
      pass: facts.proposalAttempts >= (group.proposalAttemptsAtLeast ?? 1),
      expected: `≥${group.proposalAttemptsAtLeast ?? 1}`,
      actual: String(facts.proposalAttempts),
    },
    expectedTrue('确认码已给出', group.confirmCodeOffered ?? true, facts.confirmCodeOffered),
    expectedTrue('提案意图已建', group.intentCreated ?? true, facts.intents.length > 0),
    expectedTrue('落账 committed', group.committed ?? true, committed),
    expectedTrue('读回校验在', group.readbackVerified ?? true, committed && facts.intents.some((intent) => intent.status === 'committed' && intent.hasResult)),
  ];
  return { id: entry.id, kind: 'acceptance', pass: checks.every((check) => check.pass), checks };
}

// ── 主流程 ──

interface Args {
  probeReport?: string;
  acceptanceReport?: string;
  baselinePath?: string;
  judge: boolean;
  writeBaseline: boolean;
  forceBaseline: boolean;
}

function parseArgs(argv: string[]): Args {
  const take = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  return {
    probeReport: take('--probe-report'),
    acceptanceReport: take('--acceptance-report'),
    baselinePath: take('--baseline'),
    judge: argv.includes('--judge'),
    writeBaseline: argv.includes('--write-baseline'),
    forceBaseline: argv.includes('--force-baseline'),
  };
}

function fmtVerdict(verdict: CaseVerdict): string {
  const failed = verdict.checks.filter((check) => !check.pass);
  const head = `${verdict.pass ? '✓' : '✗'} ${verdict.id}`;
  if (verdict.pass) {
    const judgeScores = verdict.judge
      ? ` 评委 ${NOTE_DIMS.map((dim) => verdict.judge!.scores[dim]).join('/')}` : '';
    return `${head}  ${verdict.checks.map((check) => check.name).join('、')}${judgeScores}`;
  }
  return `${head}  ${failed.map((check) => `${check.name} 期望${check.expected} 实际${check.actual}`).join('; ')}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus(CORPUS_PATH);
  const baselinePath = args.baselinePath ?? BASELINE_PATH;
  const baseline = loadBaseline(baselinePath);
  const corpusVer = corpusVersion(CORPUS_PATH);
  const promptVer = judgePromptVersion();

  // 语料 ⊆ 基线锁：进基线的语料必须有基线项（反向多余项只提示不拦——删语料时基线项随 --write-baseline 清理）。
  const missingBaseline = corpus.filter((entry) => entry.inBaseline
    && (entry.kind === 'probe' ? !(entry.id in baseline.cases) : !(entry.conversation! in baseline.writeChain)));
  if (missingBaseline.length) {
    console.error(`语料-基线失配（exit 2）：${missingBaseline.map((entry) => entry.id).join('、')} 进基线但 baseline.json 无对应项`);
    process.exit(2);
  }

  const probePath = args.probeReport ?? latestReport(path.join(repoRoot, '.runtime'), 'probe-', '.json');
  const acceptancePath = args.acceptanceReport
    ?? latestReport(path.join(repoRoot, 'data'), 'acceptance-report-', '.json');
  const inBaseline = corpus.filter((entry) => entry.inBaseline);
  const needsProbe = inBaseline.some((entry) => entry.kind === 'probe');
  const needsAcceptance = inBaseline.some((entry) => entry.kind === 'acceptance');
  const missing: string[] = [];
  if (needsProbe && (!probePath || !existsSync(probePath))) missing.push('探针报告（.runtime/probe-*.json；先跑 npm run eval:probe）');
  if (needsAcceptance && (!acceptancePath || !existsSync(acceptancePath))) missing.push('验收报告（data/acceptance-report-*.json；先跑 npm run eval:acceptance）');
  if (missing.length) {
    console.error(`输入缺失（exit 2）：\n  - ${missing.join('\n  - ')}`);
    process.exit(2);
  }
  const probeReport = JSON.parse(readFileSync(probePath!, 'utf8')) as ProbeReport;
  // 格式守卫：L7 之前生成的探针报告没有 dims 字段，静默按零违例通过会制造假绿。
  const staleProbe = probeReport.results.find((result) => !result.dims);
  if (staleProbe) {
    console.error(`探针报告是旧格式（${path.basename(probePath!)} 的 ${staleProbe.id} 无 dims；L7 归维前的产物），打分须先重跑：npm run eval:probe（exit 2）`);
    process.exit(2);
  }
  const acceptanceJson = JSON.parse(readFileSync(acceptancePath!, 'utf8')) as {
    records: Array<{ id: string }>;
    writeChain: ConversationWriteChainFacts[];
  };
  console.log(`== L7 打分 == 语料 v${corpusVer} · 评委提示词 v${promptVer} · 基线 v${baseline.version}（${baseline.generatedAt}）`);
  console.log(`   探针报告 ${path.basename(probePath!)}（${probeReport.at}）· 验收报告 ${path.basename(acceptancePath!)}`);

  if (args.judge && !judgeEnvReady()) {
    console.error('评委缺环境变量（exit 2）：LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（--env-file=.env）');
    process.exit(2);
  }

  const verdicts: CaseVerdict[] = [];
  for (const entry of inBaseline) {
    if (entry.kind === 'probe') {
      const row = probeReport.results.find((result) => result.id === entry.case);
      let judgeResult: JudgeResult | undefined;
      if (args.judge && row) {
        judgeResult = await judgeTranscript({
          intent: entry.incidents.join('；'),
          expect: entry.expect,
          turns: row.turns.map((turn) => ({ user: turn.text, reply: turn.reply, notices: turn.notices })),
        });
      }
      verdicts.push(evaluateProbeCase(row, baseline.cases[entry.id], judgeResult));
    } else {
      const facts = acceptanceJson.writeChain.find((item) => item.conversationId === entry.conversation);
      verdicts.push(evaluateWriteChainCase(entry, facts, baseline.writeChain[entry.conversation!]));
    }
  }
  const skipped = corpus.filter((entry) => !entry.inBaseline);
  for (const entry of skipped) {
    verdicts.push({ id: entry.id, kind: entry.kind, pass: true, checks: [], note: '未进默认基线（--only 跑后用 --include 评分，或临时移入基线）' });
  }

  for (const verdict of verdicts) {
    console.log(fmtVerdict(verdict) + (verdict.note ? `  （${verdict.note}）` : ''));
    for (const item of verdict.judge?.evidence ?? []) {
      console.log(`      · [${DIM_LABELS_ZH[item.dim]}] "${item.quote.slice(0, 60)}" — ${item.why.slice(0, 80)}`);
    }
  }
  const judged = verdicts.filter((verdict) => verdict.pass && !verdict.note);
  const failed = verdicts.filter((verdict) => !verdict.pass);
  console.log(`\n汇总：${judged.length}/${inBaseline.length} 通过${failed.length ? `；回归：${failed.map((verdict) => verdict.id).join('、')}` : ''}`);

  // 记分台：每轮追加一行（含评委证据）。回归也落账——台账引用的是这里的轨迹。
  appendFileSync(SCORES_PATH, JSON.stringify({
    at: new Date().toISOString(),
    kind: 'eval',
    corpusVersion: corpusVer,
    judgePromptVersion: args.judge ? promptVer : undefined,
    judgeModel: args.judge ? judgeModel() : undefined,
    probeReport: path.basename(probePath!),
    acceptanceReport: path.basename(acceptancePath!),
    verdicts,
  }) + '\n');

  if (args.writeBaseline) {
    const factsByConversation = new Map(acceptanceJson.writeChain.map((facts) => [facts.conversationId, facts]));
    writeBaselineFrom(verdicts, baseline, baselinePath, args.forceBaseline, corpus, factsByConversation);
  }

  if (failed.length) process.exit(1);
}

/** 从当前轮实值重写基线（基线重定的唯一入口）。既有 okExpected=true 的用例转 ⚠ 时拒绝写入——那是要打回的回归，不许烤进基线。 */
function writeBaselineFrom(
  verdicts: CaseVerdict[],
  baseline: Baseline,
  baselinePath: string,
  force: boolean,
  corpus: CorpusEntry[],
  factsByConversation: Map<string, ConversationWriteChainFacts>,
): void {
  const next: Baseline = {
    version: baseline.version + 1,
    generatedAt: new Date().toISOString(),
    note: baseline.note,
    cases: {},
    writeChain: JSON.parse(JSON.stringify(baseline.writeChain)) as Baseline['writeChain'],
  };
  const refusals: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.note) continue; // 未进基线的用例不动
    if (verdict.kind === 'probe') {
      const row = verdict.checks.find((check) => check.name === '探针ok');
      const previous = baseline.cases[verdict.id];
      const previousOkExpected = previous?.okExpected ?? true;
      const actualOk = row?.actual === 'true';
      if (!actualOk && previousOkExpected && !force) {
        refusals.push(`${verdict.id}（ok 由 ${previousOkExpected} 转 ${actualOk}）`);
      }
      const dims = {} as DimCounts;
      for (const dim of NOTE_DIMS) {
        const check = verdict.checks.find((item) => item.name === `${DIM_LABELS_ZH[dim]}违例`);
        dims[dim] = Number(check?.actual ?? 0);
      }
      const judgeScores = verdict.judge
        ? Object.fromEntries(NOTE_DIMS.map((dim) => [dim, verdict.judge!.scores[dim]])) as BaselineCase['judge']
        : previous?.judge ?? null;
      next.cases[verdict.id] = {
        dims,
        ...(judgeScores ? { judge: judgeScores } : {}),
        ...(previous?.okExpected !== undefined ? { okExpected: previous.okExpected } : actualOk ? {} : { okExpected: false }),
        ...(previous?.note ? { note: previous.note } : {}),
      };
    } else {
      const entry = corpus.find((item) => item.id === verdict.id);
      const facts = entry?.conversation ? factsByConversation.get(entry.conversation) : undefined;
      if (entry?.conversation && facts) {
        next.writeChain[entry.conversation] = {
          // 尝试次数下限恒为设计目标 1（重试多几次是正常方差，不随单轮抬高门槛）；
          // 快照的是布尔面（意图/落账/读回/确认码）。
          proposalAttemptsAtLeast: 1,
          confirmCodeOffered: facts.confirmCodeOffered,
          intentCreated: facts.intents.length > 0,
          committed: facts.intents.some((intent) => intent.status === 'committed'),
          readbackVerified: facts.intents.some((intent) => intent.status === 'committed' && intent.hasResult),
        };
      }
    }
  }
  if (refusals.length && !force) {
    console.error(`拒绝重定基线（--force-baseline 可越过，须在台账留一行理由）：${refusals.join('、')}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`基线已重写：v${next.version}（${next.generatedAt}）→ ${path.relative(repoRoot, baselinePath)}`);
}

// 仅直接执行时运行（tsx 场景 process.argv[1] 即本文件）：vitest 会 import 本模块复用纯函数，
// 不加守卫会在加载时跑一轮打分并 process.exit，把测试进程带走。
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('打分器失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
