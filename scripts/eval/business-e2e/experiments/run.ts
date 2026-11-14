/**
 * bizbatch3/bizbatch2 实验运行入口——真实模型走 .env；执行层一律仓内 dummy 夹具。
 *
 * 装配链：infra 门 → `expandExpItems`（用例 × N）→ `runExpBatch`（batch 并行 + collect 证据 +
 * judge 判定）→ 报告（逐用例 k/N + Wilson 95% CI；机械/行为分离）。缺省 `--infra-gate`（先验门、
 * 不烧样本）；`--run` 才调真实模型。
 *
 * CLI：
 *   node --env-file-if-exists=.env --import tsx scripts/eval/business-e2e/experiments/run.ts \
 *     [--kind task-surface|compaction|skill-arm|all] [--case T01,C01 | all] [--trials 3]
 *     [--concurrency 4] [--out-dir <dir>] [--infra-gate | --run]
 *   缺省 --kind all；--infra-gate 只验门不调模型。退出码：0=跑完无判负；1=有判负；2=门失败/用法错误。
 *   inline only：本入口不设 background（用例 canary 用 withTaskRunner 注入 runner）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expCases } from './cases';
import { expandExpItems, EXP_HARD_LIMITS, type ExpCase, type ExperimentKind } from './model';
import { createExpExecutor } from './executor';
import { runExpBatch, summarizeExp, summarizeSkillArms, type ExpReport } from './harness';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ENV_FILE = path.join(REPO_ROOT, '.env');
const DEFAULT_OUT = path.join(REPO_ROOT, '.runtime', 'bizbatch3');
const EXPECTED_MODEL = 'step-3.7-flash';

const KINDS: ExperimentKind[] = ['task-surface', 'compaction', 'skill-arm'];

interface CliArgs {
  kind: ExperimentKind | 'all';
  cases: string[];
  trials?: number;
  concurrency: number;
  outDir: string;
  mode: 'infra-gate' | 'run';
}

function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = {
    kind: 'all',
    cases: [],
    concurrency: EXP_HARD_LIMITS.concurrency,
    outDir: DEFAULT_OUT,
    mode: 'infra-gate',
  };
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
    if (flag === '--kind') {
      const v = val();
      if (v !== 'all' && !KINDS.includes(v as ExperimentKind)) return { error: `--kind 需要 ${KINDS.join('|')}|all（收到 ${String(v)}）` };
      args.kind = v as ExperimentKind | 'all';
    } else if (flag === '--case' || flag === '--cases') {
      const v = val();
      if (v === undefined) return { error: '--case 需要值' };
      args.cases.push(...v.split(',').map((s) => s.trim()).filter((s) => s !== ''));
    } else if (flag === '--trials') { const v = val(); const n = int(v, '--trials'); if (typeof n !== 'number') return n; args.trials = n; }
    else if (flag === '--concurrency') { const v = val(); const n = int(v, '--concurrency'); if (typeof n !== 'number') return n; args.concurrency = n; }
    else if (flag === '--out-dir' || flag === '--out') { const v = val(); if (v === undefined) return { error: '--out-dir 需要值' }; args.outDir = path.resolve(REPO_ROOT, v); }
    else if (flag === '--infra-gate') args.mode = 'infra-gate';
    else if (flag === '--run') args.mode = 'run';
    else return { error: `未知参数：${arg}` };
  }
  return args;
}

export interface ExpInfraGate {
  blocking: boolean;
  checks: Array<{ name: string; ok: boolean; note: string }>;
  model: string | null;
  expectedModel: string;
}

/**
 * infra 门：.env 存在 + LLM_API_KEY 非空 + LLM_MODEL === step-3.7-flash（本批钉模型）。
 * 缺一 blocking=true、不烧样本。模型可用性无法离线证明，故只验「已解析且等于目标模型」。
 */
export function checkExpInfraGate(expectedModel = EXPECTED_MODEL): ExpInfraGate {
  const checks: ExpInfraGate['checks'] = [];
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

function selectCases(wanted: readonly string[], kind: ExperimentKind | 'all'): ExpCase[] {
  const pool = kind === 'all' ? expCases : expCases.filter((c) => c.kind === kind);
  if (wanted.length === 0 || wanted.some((w) => w.toLowerCase() === 'all')) return [...pool];
  const byId = new Map(pool.map((c) => [c.id.toLowerCase(), c]));
  return wanted.map((w) => {
    const hit = byId.get(w.toLowerCase());
    if (hit === undefined) throw new Error(`无法识别的用例 id：${w}（可用：${pool.map((c) => c.id).join('、')}）`);
    return hit;
  });
}

function reportJson(report: ExpReport): Record<string, unknown> {
  return {
    experiment: report.kind,
    policy: report.policy,
    hardLimits: report.hardLimits,
    batch: { caseCount: report.batch.caseCount, observedMaxConcurrency: report.batch.observedMaxConcurrency, wallMs: report.batch.wallMs, throughputPerSec: report.batch.throughputPerSec, resources: report.batch.resources },
    experimentSummary: report.experiment,
    summary: summarizeExp(report),
    ...(report.kind === 'skill-arm' ? { arms: summarizeSkillArms(report) } : {}),
    samples: report.samples.map((s) => ({ id: s.id, caseId: s.caseId, kind: s.kind, arm: s.arm, trial: s.trial, runDir: s.runDir, failed: s.failed, error: s.error, verdict: s.verdict, modelCalls: s.modelCalls, seedTaskNos: s.seedTaskNos })),
  };
}

async function runOne(args: CliArgs, kind: ExperimentKind, outRoot: string): Promise<boolean> {
  const cases = selectCases(args.cases, kind);
  if (cases.length === 0) throw new Error(`实验 ${kind} 没有匹配用例`);
  const items = expandExpItems(cases, args.trials);
  const dir = path.join(outRoot, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'hardlimits.json'), JSON.stringify({ experiment: kind, registration: EXP_HARD_LIMITS }, null, 2) + '\n');
  const report = await runExpBatch({ kind, cases, items, executor: createExpExecutor(), outRoot: dir, concurrency: args.concurrency });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(reportJson(report), null, 2) + '\n');
  for (const s of summarizeExp(report)) {
    console.log(`[${kind}] ${s.caseId}（臂 ${s.arm ?? '-'}）：${s.pass}/${s.n}，Wilson95=[${s.passRateCI.lower.toFixed(3)}, ${s.passRateCI.upper.toFixed(3)}]，severe ${s.severe}，taskToolCalls ${s.counters.taskToolCalls}，skillReads ${s.counters.skillReads}，compactionRounds ${s.counters.compactionRounds}，compactTriggerEvents ${s.counters.compactionTriggerEvents}，compactCompleted ${s.counters.compactionCompleted}`);
  }
  if (kind === 'skill-arm') for (const a of summarizeSkillArms(report)) console.log(`[skill-arm] ${a.base} × ${a.arm}：${a.pass}/${a.n}，read_skill 命中 ${a.skillReads}`);
  return report.samples.some((s) => s.failed);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) { console.error(parsed.error); process.exitCode = 2; return; }
  const args = parsed;
  mkdirSync(args.outDir, { recursive: true });

  const gate = checkExpInfraGate();
  writeFileSync(path.join(args.outDir, 'infra-gate.json'), JSON.stringify({ ...gate, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  if (gate.blocking) {
    console.error('infra 门失败（blocking=true，不烧样本）：');
    for (const c of gate.checks) console.error(`  - [${c.ok ? 'ok' : 'FAIL'}] ${c.name}：${c.note}`);
    process.exitCode = 2;
    return;
  }
  console.log(`infra 门通过（模型 ${gate.model}）；实验 ${args.kind}；并发 ${args.concurrency}。`);
  if (args.mode === 'infra-gate') { console.log('--infra-gate 模式：只验门，不调模型。加 --run 才跑真实模型。'); return; }

  const kinds: ExperimentKind[] = args.kind === 'all' ? KINDS : [args.kind];
  let anyFail = false;
  for (const kind of kinds) anyFail = (await runOne(args, kind, args.outDir)) || anyFail;
  process.exitCode = anyFail ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
