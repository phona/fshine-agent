/**
 * D 轴（执行扩散）运行入口——真实模型走 .env（显式 `LLM_MODEL=step-3.7-flash` 钉模型）。
 *
 * 装配链：infra 门（.env/密钥/钉模型）→ 硬上限先验（D 轴本批 ≤5 会话、并发 4）→
 * runBatch（并发编排 + 逐样本证据落盘 collect）→ 轨2 四档分级（spread-judge）+
 * d6-metrics 指标 → 报告（逐 D 类目覆盖 + 判负统计 + Wilson 95% CI）。
 *
 * CLI：
 *   node --env-file-if-exists=.env --import tsx scripts/eval/business-e2e/spread-axis/run.ts \
 *     [--case DS-1,DS-2,DS-3] [--trials N] [--concurrency 4] [--out-dir <dir>] \
 *     [--infra-gate | --run | --smoke | --regrade]
 *   缺省 --infra-gate（只验门、不烧样本）；--run 才调真实模型；--smoke 用确定性假件
 *   （零模型）验证执行链；--regrade 从已落盘证据重判（零模型）。
 * 退出码：0=跑完无判负；1=有判负/有指标缺失；2=门失败/用法错误。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBatch, type BatchReport } from '../batch';
import { writeSampleRun } from '../collect';
import { wilson95 } from '../../exploration/stats';
import {
  assertWithinDAxisHardLimits,
  D_AXIS_HARD_LIMITS,
  dAxisHardLimitRegistration,
  dsCases,
  expandDsItems,
  type DsCase,
  type DsItem,
} from './cases';
import { createDsExecutor, type DsExecutor, type DsEvidence } from './executor';
import { createSmokeExecutor } from './fakes';
import { buildCoverage, gradeDsEvidence, regradeFromRunDir, type DsGrade } from './grade';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const CASES_FILE = path.join(REPO_ROOT, 'scripts', 'eval', 'business-e2e', 'spread-axis', 'cases.ts');
const DEFAULT_OUT = path.join(REPO_ROOT, '.runtime', 'r5phase2', 'd-axis');
const EXPECTED_MODEL = 'step-3.7-flash';

interface CliArgs {
  cases: string[];
  trials?: number;
  concurrency: number;
  outDir: string;
  mode: 'infra-gate' | 'run' | 'smoke' | 'regrade';
}

function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { cases: [], concurrency: D_AXIS_HARD_LIMITS.concurrency, outDir: DEFAULT_OUT, mode: 'infra-gate' };
  const int = (raw: string | undefined, flag: string): number | { error: string } => {
    const n = Number.parseInt(raw ?? '', 10);
    if (!Number.isSafeInteger(n) || n < 1) return { error: `${flag} 需要正整数：${String(raw)}` };
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const val = (): string | undefined => (inlineVal !== undefined ? inlineVal : argv[++i]);
    if (flag === '--case' || flag === '--cases') {
      const v = val();
      if (v === undefined) return { error: '--case 需要值' };
      args.cases.push(...v.split(',').map((s) => s.trim()).filter((s) => s !== ''));
    } else if (flag === '--trials') { const n = int(val(), '--trials'); if (typeof n !== 'number') return n; args.trials = n; }
    else if (flag === '--concurrency') { const n = int(val(), '--concurrency'); if (typeof n !== 'number') return n; args.concurrency = n; }
    else if (flag === '--out-dir' || flag === '--out') { const v = val(); if (v === undefined) return { error: '--out-dir 需要值' }; args.outDir = path.resolve(REPO_ROOT, v); }
    else if (flag === '--infra-gate') args.mode = 'infra-gate';
    else if (flag === '--run') args.mode = 'run';
    else if (flag === '--smoke') args.mode = 'smoke';
    else if (flag === '--regrade') args.mode = 'regrade';
    else return { error: `未知参数：${arg}` };
  }
  return args;
}

function selectCases(wanted: readonly string[]): DsCase[] {
  if (wanted.length === 0 || wanted.some((w) => w.toLowerCase() === 'all')) return [...dsCases];
  const byId = new Map(dsCases.map((c) => [c.id.toLowerCase(), c]));
  return wanted.map((w) => {
    const hit = byId.get(w.toLowerCase());
    if (hit === undefined) throw new Error(`无法识别的用例 id：${w}（可用：${dsCases.map((c) => c.id).join('、')}）`);
    return hit;
  });
}

export interface DsInfraGate {
  blocking: boolean;
  checks: Array<{ name: string; ok: boolean; note: string }>;
  model: string | null;
  expectedModel: string;
}

/** infra 门：.env 存在 + LLM_API_KEY 非空 + LLM_MODEL === step-3.7-flash（本批钉模型）。 */
export function checkDsInfraGate(expectedModel = EXPECTED_MODEL): DsInfraGate {
  const checks: DsInfraGate['checks'] = [];
  const envFilePresent = existsSync(ENV_FILE);
  checks.push({ name: '.env 存在（gitignored）', ok: envFilePresent, note: envFilePresent ? '已就绪（只读复制）' : '缺 .env——真实模型不可跑' });
  const keyPresent = (process.env['LLM_API_KEY'] ?? '').trim() !== '';
  checks.push({ name: 'LLM_API_KEY 非空', ok: keyPresent, note: keyPresent ? '进程环境可见（值不入证据/不 echo）' : '未从 .env 注入——用 --env-file-if-exists=.env 启动' });
  const model = (process.env['LLM_MODEL'] ?? '').trim();
  checks.push({ name: 'LLM_MODEL 解析', ok: model !== '', note: model !== '' ? `已解析（${model}）` : '未解析——检查 .env' });
  const matches = model === expectedModel;
  checks.push({ name: `LLM_MODEL === ${expectedModel}`, ok: matches, note: matches ? '本批钉模型一致' : `当前 ${model || '(空)'} ≠ ${expectedModel}（跑批须显式 LLM_MODEL=${expectedModel}）` });
  return { blocking: checks.some((c) => !c.ok), checks, model: model === '' ? null : model, expectedModel };
}

/** 用例文本哈希（先于运行冻结的凭证）。 */
function casesSha256(): string {
  return createHash('sha256').update(readFileSync(CASES_FILE, 'utf8'), 'utf8').digest('hex');
}

function readJsonIfExists<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

interface DsSampleOutcome {
  id: string;
  caseId: string;
  trial: number;
  runDir: string;
  ok: boolean;
  error?: string;
  grade?: DsGrade;
}

interface DsBatchState {
  modelCallsTotal: number;
  stopped: boolean;
}

function outcomeFromEvidence(input: { item: DsItem; caseDef: DsCase; evidence: DsEvidence; outRoot: string }): DsSampleOutcome {
  const { item, caseDef, evidence, outRoot } = input;
  const runDir = writeSampleRun(outRoot, {
    inputs: evidence.inputs,
    toolCalls: evidence.toolCalls,
    tasks: evidence.tasks,
    replies: evidence.replies,
    meta: evidence.meta,
    taskFacts: evidence.taskFacts,
    notifications: evidence.notifications,
    auditLines: evidence.auditLines,
    sample: evidence.sample,
  });
  const grade = gradeDsEvidence({
    caseDef,
    item: { id: item.id, trial: item.trial },
    sample: evidence.sample,
    toolCalls: evidence.toolCalls,
    tasks: evidence.tasks,
    replies: evidence.replies,
    meta: evidence.meta,
    runDir,
  });
  writeFileSync(path.join(runDir, 'spread.json'), JSON.stringify(grade, null, 2) + '\n');
  if (grade.d6 !== undefined) writeFileSync(path.join(runDir, 'd6.json'), JSON.stringify(grade.d6, null, 2) + '\n');
  return { id: item.id, caseId: caseDef.id, trial: item.trial, runDir, ok: true, grade };
}

/** 跑一批 D 轴样本：每样本独立工作目录 + 逐样本证据落盘 + 四档分级 + D6 抽取。 */
export async function runDsBatch(input: {
  cases: readonly DsCase[];
  items: readonly DsItem[];
  executor: DsExecutor;
  outRoot: string;
  concurrency: number;
}): Promise<{ batch: BatchReport; samples: DsSampleOutcome[]; state: DsBatchState }> {
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  const state: DsBatchState = { modelCallsTotal: 0, stopped: false };
  const batch = await runBatch<DsItem>(
    input.items,
    async (item, ctx) => {
      const caseDef = byId.get(item.caseId);
      if (caseDef === undefined) throw new Error(`未知用例 id：${item.caseId}`);
      if (ctx.workDir === undefined) throw new Error('D 轴样本需要每样本工作目录（batch 的 workRoot）');
      if (state.stopped) return { skipped: true, id: item.id };
      const evidence = await input.executor(item, caseDef, ctx.workDir);
      const outcome = outcomeFromEvidence({ item, caseDef, evidence, outRoot: input.outRoot });
      state.modelCallsTotal += outcome.grade?.modelCalls ?? 0;
      if (state.modelCallsTotal > D_AXIS_HARD_LIMITS.maxModelCalls) {
        // 硬上限触达：置停止位（后续样本不再开跑；run 结束后落 hardlimits 停止记录）。
        state.stopped = true;
      }
      return outcome;
    },
    { concurrency: input.concurrency, workRoot: path.join(input.outRoot, 'work') },
  );
  const samples: DsSampleOutcome[] = [];
  batch.outcomes.forEach((outcome, index) => {
    const item = input.items[index];
    if (item === undefined) return;
    if (outcome.ok) {
      const out = outcome.output as DsSampleOutcome | { skipped?: boolean; id?: string };
      if (out !== undefined && out !== null && (out as DsSampleOutcome).runDir !== undefined) {
        samples.push(out as DsSampleOutcome);
        return;
      }
      samples.push({ id: item.id, caseId: item.caseId, trial: item.trial, runDir: '', ok: false, error: '硬上限触达后未开跑（stops-at-limit，不重采样）' });
      return;
    }
    samples.push({ id: item.id, caseId: item.caseId, trial: item.trial, runDir: '', ok: false, error: outcome.error ?? '样本执行未产出结果' });
  });
  return { batch, samples, state };
}

// ── smoke：确定性假件（零模型）验证执行链 ─────────────────────────────────────
// 假件在 `./fakes`（与自测共用；注入面 = createDrivers/createExecutionFace 覆盖）。

async function runSmoke(args: CliArgs): Promise<boolean> {
  const cases = selectCases(args.cases.length === 0 ? ['DS-1', 'DS-3'] : args.cases);
  const items = expandDsItems(cases, args.trials ?? 1);
  assertWithinDAxisHardLimits({ sessions: items.length, concurrency: args.concurrency, maxModelCalls: D_AXIS_HARD_LIMITS.maxModelCalls, maxWallMs: D_AXIS_HARD_LIMITS.maxWallMs });
  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(path.join(args.outDir, 'hardlimits.json'), JSON.stringify({ ...dAxisHardLimitRegistration(), mode: 'smoke（零模型）' }, null, 2) + '\n');
  console.log(`smoke（确定性假件、零模型）：${items.map((i) => i.id).join('、')}；并发 ${args.concurrency}。`);
  let failed = false;
  for (const caseDef of cases) {
    for (const item of items.filter((i) => i.caseId === caseDef.id)) {
      const dir = path.join(args.outDir, 'work', item.id);
      mkdirSync(dir, { recursive: true });
      const evidence = await createSmokeExecutor(caseDef)(item, caseDef, dir);
      const outcome = outcomeFromEvidence({ item, caseDef, evidence, outRoot: args.outDir });
      const g = outcome.grade!;
      console.log(`  [${item.id}] tasks=${g.indicators.d3.tasks} spread=${g.spread.worst} fail=${g.spread.fail} checks=${g.mechanical.pass} d6.activeTasksPeak=${JSON.stringify(g.d6?.activeTasksPeak.value ?? null)} postCancelResidue=${JSON.stringify(g.d6?.postCancelResidue.value ?? null)}`);
      if (caseDef.id === 'DS-1' && (g.indicators.d3.tasks < 2 || g.spread.fail)) failed = true;
      if (caseDef.id === 'DS-2') {
        if (g.spread.fail) failed = true; // B（白名单发现）不应判负
        if (g.spread.counts.B < 1) failed = true; // 口语窗口 → B 档 observation
        if (g.indicators.d4.failedOrRefused < 1) failed = true; // 故障面被覆盖
      }
      if (caseDef.id === 'DS-3') {
        if (g.indicators.d3.tasks < 3) failed = true;
        if (g.indicators.d3.taskFacts.cancelled !== 1) failed = true;
        if (g.d6?.postCancelResidue.available !== true) failed = true; // 取消事实进入 d6（残留读数按工具口径另注）
      }
    }
  }
  console.log(failed ? 'smoke 失败：断言未满足（详见上方与落盘证据）' : 'smoke 通过：执行器 / 四档分级 / d6 抽取端到端可用（零模型）');
  writeFileSync(path.join(args.outDir, 'smoke-result.json'), JSON.stringify({ ok: !failed, generatedAt: new Date().toISOString(), cases: cases.map((c) => c.id) }, null, 2) + '\n');
  return failed;
}

// ── regrade：从已落盘证据重判（零模型）───────────────────────────────────────

interface RegradeReport {
  generatedAt: string;
  source: string;
  casesSha256: string;
  samples: Array<{ id: string; runDir: string; grade: DsGrade }>;
  coverage: ReturnType<typeof buildCoverage>;
}

function runRegrade(args: CliArgs): boolean {
  const cases = selectCases(args.cases);
  const items = expandDsItems(cases, args.trials);
  const samples: RegradeReport['samples'] = [];
  for (const item of items) {
    const caseDef = cases.find((c) => c.id === item.caseId)!;
    const runDir = path.join(args.outDir, item.caseId, String(item.trial));
    const grade = regradeFromRunDir(caseDef, runDir);
    if (grade === undefined) { console.error(`  跳过（证据不齐）：${runDir}`); continue; }
    writeFileSync(path.join(runDir, 'spread.json'), JSON.stringify(grade, null, 2) + '\n');
    if (grade.d6 !== undefined) writeFileSync(path.join(runDir, 'd6.json'), JSON.stringify(grade.d6, null, 2) + '\n');
    samples.push({ id: item.id, runDir, grade });
    console.log(`  [${item.id}] spread=${grade.spread.worst} fail=${grade.spread.fail} counts=${JSON.stringify(grade.spread.counts)}`);
  }
  const d7 = readJsonIfExists<{ summary?: string }>(path.join(args.outDir, 'd7-fixture.json'));
  const coverage = buildCoverage(samples.map((s) => s.grade), d7?.summary);
  writeFileSync(path.join(args.outDir, 'report.regraded.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'regrade from stored evidence (no model calls)', casesSha256: casesSha256(), samples: samples.map((s) => ({ id: s.id, runDir: s.runDir, grade: s.grade })), coverage } satisfies RegradeReport, null, 2) + '\n');
  return false;
}

// ── 真实跑批 ─────────────────────────────────────────────────────────────────

interface DsReport {
  batch: string;
  generatedAt: string;
  casesSha256: string;
  policy: BatchReport['policy'];
  hardLimits: Record<string, unknown>;
  infraGate: DsInfraGate & { generatedAt: string };
  experiment: { sessions: number; ranSessions: number; modelCallsTotal: number; wallMs: number; stoppedAtModelCallLimit: boolean };
  batchInfo: { caseCount: number; observedMaxConcurrency: number; wallMs: number; throughputPerSec: number; resources: BatchReport['resources'] };
  samples: Array<{
    id: string; caseId: string; trial: number; runDir: string; ok: boolean; error?: string;
    modelCalls?: number; tokensTotal?: number | null;
    mechanical?: DsGrade['mechanical'];
    spread?: DsGrade['spread'];
    behavior?: DsGrade['behavior'];
    ux?: DsGrade['ux'];
    indicators?: DsGrade['indicators'];
    amplification?: DsGrade['amplification'];
    d6?: DsGrade['d6'];
  }>;
  coverage: ReturnType<typeof buildCoverage>;
}

async function runReal(args: CliArgs, gate: DsInfraGate): Promise<boolean> {
  const cases = selectCases(args.cases);
  const items = expandDsItems(cases, args.trials);
  assertWithinDAxisHardLimits({ sessions: items.length, concurrency: args.concurrency, maxModelCalls: D_AXIS_HARD_LIMITS.maxModelCalls, maxWallMs: D_AXIS_HARD_LIMITS.maxWallMs });
  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(path.join(args.outDir, 'hardlimits.json'), JSON.stringify(dAxisHardLimitRegistration(), null, 2) + '\n');
  console.log(`infra 门通过（模型 ${gate.model}）；用例 ${cases.map((c) => c.id).join('、')} × N=${args.trials ?? '(各用例自带)'} = ${items.length} 样本；并发 ${args.concurrency}。`);
  const started = Date.now();
  const { batch, samples, state } = await runDsBatch({ cases, items, executor: createDsExecutor(), outRoot: args.outDir, concurrency: args.concurrency });
  const wallMs = Date.now() - started;
  if (state.stopped) {
    writeFileSync(path.join(args.outDir, 'hardlimits.json'), JSON.stringify({ ...dAxisHardLimitRegistration(), stopped: true, stopReason: `模型调用累计 ${state.modelCallsTotal} 超过 maxModelCalls=${D_AXIS_HARD_LIMITS.maxModelCalls}（达限即停，不续跑/不换批）`, stoppedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  const d7 = readJsonIfExists<{ summary?: string }>(path.join(args.outDir, 'd7-fixture.json'));
  const coverage = buildCoverage(samples.flatMap((s) => (s.grade === undefined ? [] : [s.grade])), d7?.summary);
  const report: DsReport = {
    batch: 'r5-phase2-d-axis',
    generatedAt: new Date().toISOString(),
    casesSha256: casesSha256(),
    policy: batch.policy,
    hardLimits: dAxisHardLimitRegistration(),
    infraGate: { ...gate, generatedAt: new Date().toISOString() },
    experiment: { sessions: items.length, ranSessions: samples.filter((s) => s.ok).length, modelCallsTotal: state.modelCallsTotal, wallMs, stoppedAtModelCallLimit: state.stopped },
    batchInfo: { caseCount: batch.caseCount, observedMaxConcurrency: batch.observedMaxConcurrency, wallMs: batch.wallMs, throughputPerSec: batch.throughputPerSec, resources: batch.resources },
    samples: samples.map((s) => ({
      id: s.id, caseId: s.caseId, trial: s.trial, runDir: s.runDir, ok: s.ok,
      ...(s.error === undefined ? {} : { error: s.error }),
      ...(s.grade === undefined ? {} : {
        modelCalls: s.grade.modelCalls,
        tokensTotal: s.grade.tokensTotal,
        mechanical: s.grade.mechanical,
        spread: s.grade.spread,
        behavior: s.grade.behavior,
        ux: s.grade.ux,
        indicators: s.grade.indicators,
        amplification: s.grade.amplification,
        ...(s.grade.d6 === undefined ? {} : { d6: s.grade.d6 }),
      }),
    })),
    coverage,
  };
  writeFileSync(path.join(args.outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  for (const s of samples) {
    if (s.grade === undefined) { console.log(`${s.id}：未产出证据（${s.error ?? 'unknown'}）`); continue; }
    const g = s.grade;
    console.log(`${s.id}：四档 worst=${g.spread.worst} fail=${g.spread.fail} severity=${g.spread.severity} counts=${JSON.stringify(g.spread.counts)} 机械pass=${g.mechanical.pass} modelCalls=${g.modelCalls}`);
  }
  console.log('覆盖矩阵：');
  for (const row of coverage) console.log(`  ${row.category}：${row.status}（${row.samples.join('、') || '-'}）${Object.keys(row.indicators).length > 0 ? ` ${JSON.stringify(row.indicators)}` : ''}`);
  // D 轴判负口径 = 四档分级（C/D 任一命中即 fail；B 只记 observation）；机械面读数一并报告。
  const anyBad = samples.some((s) => s.grade === undefined || s.grade.spread.fail);
  return anyBad;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) { console.error(parsed.error); process.exitCode = 2; return; }
  const args = parsed;

  if (args.mode === 'smoke') {
    const failed = await runSmoke(args);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (args.mode === 'regrade') {
    runRegrade(args);
    process.exitCode = 0;
    return;
  }

  mkdirSync(args.outDir, { recursive: true });
  const gate = checkDsInfraGate();
  writeFileSync(path.join(args.outDir, 'infra-gate.json'), JSON.stringify({ ...gate, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  if (gate.blocking) {
    console.error('infra 门失败（blocking=true，不烧样本）：');
    for (const c of gate.checks) console.error(`  - [${c.ok ? 'ok' : 'FAIL'}] ${c.name}：${c.note}`);
    process.exitCode = 2;
    return;
  }
  if (args.mode === 'infra-gate') {
    console.log(`infra 门通过（模型 ${gate.model}）；用例 ${selectCases(args.cases).map((c) => c.id).join('、')}；--infra-gate 模式：只验门，不调模型。加 --run 才跑真实模型。`);
    return;
  }
  const anyBad = await runReal(args, gate);
  process.exitCode = anyBad ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
