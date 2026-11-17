/**
 * 业务 E2E 探测基线（阶段 2）运行入口——真实模型走 .env；执行层一律仓内 dummy 夹具。
 *
 * 装配链：`loadSuite`（suite-contract）→ `expandBizprobeItems`（用例 × N）→ infra 门
 * （.env / LLM_MODEL / verifyLock）→ `runBizprobeBatch`（batch 并行 + collect 证据 + judge 判定）
 * → 报告（逐场景 k/N + Wilson 95% CI，机械/行为/UX 三类分离）。
 *
 * CLI：
 *   node --env-file-if-exists=.env --import tsx scripts/eval/business-e2e/run.ts \
 *     [--case B01,B02 | all] [--trials 3] [--concurrency 4] [--out-dir <dir>]
 *     [--max-model-calls N] [--max-wall-ms N] [--infra-gate | --run]
 *     缺省 --infra-gate（先验门、不烧样本）；--run 才调真实模型。
 *
 * 退出码：0=跑完且无机械判负；1=存在机械判负；2=infra 门失败或用法错误（不烧样本）。
 * inline only：后台模式在后台预算接通前禁用（本入口不设 background）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCriteriaDocument } from '../convergence-r1/criteria';
import { sha256Hex, stableStringify } from '../convergence-r1/hash';
import { loadSuite } from '../exploration/suite-contract';
import { bizCases } from '../exploration/bizprobe/cases';
import type { BizCase } from './scenarios';
import { assertWithinHardLimits, BIZ_HARD_LIMITS, expandBizprobeItems, hardLimitRegistration } from './scenarios';
import { runBizprobeBatch, summarizeBizprobe } from './assembly';
import type { BizprobeReport, BizScenarioSummary } from './assembly';
import { createModelExecutor } from './model-executor';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_SUITE = path.join(REPO_ROOT, 'scripts', 'eval', 'exploration', 'bizprobe');
const ENV_FILE = path.join(REPO_ROOT, '.env');

interface CliArgs {
  suiteDir: string;
  cases: string[];
  trials?: number;
  concurrency: number;
  outDir: string;
  maxModelCalls: number;
  maxWallMs: number;
  mode: 'infra-gate' | 'run';
}

function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = {
    suiteDir: DEFAULT_SUITE,
    cases: [],
    concurrency: BIZ_HARD_LIMITS.concurrency,
    outDir: path.join(REPO_ROOT, '.runtime', 'bizprobe'),
    maxModelCalls: BIZ_HARD_LIMITS.maxModelCalls,
    maxWallMs: BIZ_HARD_LIMITS.maxWallMs,
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
    if (flag === '--suite') { const v = val(); if (v === undefined) return { error: '--suite 需要值' }; args.suiteDir = path.resolve(REPO_ROOT, v); }
    else if (flag === '--case' || flag === '--cases') { const v = val(); if (v === undefined) return { error: '--case 需要值' }; args.cases.push(...v.split(',').map((s) => s.trim()).filter((s) => s !== '')); }
    else if (flag === '--trials') { const v = val(); const n = int(v, '--trials'); if (typeof n !== 'number') return n; args.trials = n; }
    else if (flag === '--concurrency') { const v = val(); const n = int(v, '--concurrency'); if (typeof n !== 'number') return n; args.concurrency = n; }
    else if (flag === '--out-dir' || flag === '--out') { const v = val(); if (v === undefined) return { error: '--out-dir 需要值' }; args.outDir = path.resolve(REPO_ROOT, v); }
    else if (flag === '--max-model-calls') { const v = val(); const n = int(v, '--max-model-calls'); if (typeof n !== 'number') return n; args.maxModelCalls = n; }
    else if (flag === '--max-wall-ms') { const v = val(); const n = int(v, '--max-wall-ms'); if (typeof n !== 'number') return n; args.maxWallMs = n; }
    else if (flag === '--infra-gate') args.mode = 'infra-gate';
    else if (flag === '--run') args.mode = 'run';
    else return { error: `未知参数：${arg}` };
  }
  return args;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(stableStringify(value)), null, 2) + '\n';
}

/** verifyLock 等价物（不改冻结面）：重算聚合哈希与套件 criteria.lock 比对，返回问题清单（空=一致）。 */
export function verifySuiteLock(suiteDir: string): string[] {
  const lockPath = path.join(suiteDir, 'criteria.lock');
  if (!existsSync(lockPath)) return ['criteria.lock 不存在（首轮前允许；冻结后必须存在且一致）'];
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { criteriaSha256?: string; casesSha256?: string };
    const problems: string[] = [];
    const criteriaSha256 = sha256Hex(canonicalJson(buildCriteriaDocument()));
    // 动态加载套件用例文本；与 freeze.ts 同一 canonicalJson 口径。
    const casesSha256 = sha256Hex(canonicalJson(bizCases));
    if (lock.criteriaSha256 !== criteriaSha256) problems.push('criteria sha256 与 criteria.lock 不一致——冻结后不得改判据');
    if (lock.casesSha256 !== casesSha256) problems.push('cases sha256 与 criteria.lock 不一致——冻结后不得改用例');
    return problems;
  } catch (error) {
    return [`criteria.lock 不可解析：${error instanceof Error ? error.message : String(error)}`];
  }
}

interface InfraGate {
  blocking: boolean;
  checks: Array<{ name: string; ok: boolean; note: string }>;
  model: string | null;
}

/** infra 门：.env 存在且含非空 LLM_API_KEY、LLM_MODEL 解析、verifyLock 一致——缺一 blocking=true。 */
export function checkInfraGate(): InfraGate {
  const checks: InfraGate['checks'] = [];
  const envFilePresent = existsSync(ENV_FILE);
  checks.push({ name: '.env 存在（gitignored）', ok: envFilePresent, note: envFilePresent ? '已就绪（只读复制）' : '缺 .env——真实模型不可跑' });
  const keyPresent = (process.env['LLM_API_KEY'] ?? '').trim() !== '';
  checks.push({ name: 'LLM_API_KEY 非空', ok: keyPresent, note: keyPresent ? '进程环境可见（值不入证据/不 echo）' : '未从 .env 注入——用 --env-file-if-exists=.env 启动' });
  const model = (process.env['LLM_MODEL'] ?? '').trim();
  checks.push({ name: 'LLM_MODEL 解析', ok: model !== '', note: model !== '' ? `已解析（${model}）` : '未解析——检查 .env' });
  const lockProblems = verifySuiteLock(DEFAULT_SUITE);
  checks.push({ name: 'verifyLock 可用且一致', ok: lockProblems.length === 0, note: lockProblems.length === 0 ? '套件 criteria.lock 与用例/判据一致' : lockProblems.join('；') });
  return { blocking: checks.some((c) => !c.ok), checks, model: model === '' ? null : model };
}

function selectCases(all: readonly BizCase[], wanted: readonly string[]): BizCase[] {
  if (wanted.length === 0 || wanted.some((w) => w.toLowerCase() === 'all')) return [...all];
  const byId = new Map(all.map((c) => [c.id.toLowerCase(), c]));
  return wanted.map((w) => {
    const hit = byId.get(w.toLowerCase());
    if (hit === undefined) throw new Error(`无法识别的用例 id：${w}（可用：${all.map((c) => c.id).join('、')}）`);
    return hit;
  });
}

/**
 * 落盘报告对象（R2 修复 ③）：把跑批报告投影成 `report.json` 形状。**必须含 batch 资源读数**
 * （RSS/CPU 粗读数 + observedMaxConcurrency + throughputPerSec）——R1 本批该键缺失（run.ts
 * 当时只写子集），真实批资源读数因此不可得。抽成纯函数以便确定性自测钉住形状。
 */
export function buildRunReportJson(input: {
  suiteId: string;
  report: BizprobeReport;
  summary: readonly BizScenarioSummary[];
}): Record<string, unknown> {
  const { report } = input;
  return {
    suite: input.suiteId,
    policy: report.policy,
    hardLimits: report.hardLimits,
    experiment: report.experiment,
    batch: {
      caseCount: report.batch.caseCount,
      observedMaxConcurrency: report.batch.observedMaxConcurrency,
      wallMs: report.batch.wallMs,
      throughputPerSec: report.batch.throughputPerSec,
      resources: report.batch.resources,
    },
    summary: input.summary,
    samples: report.samples.map((s) => ({
      id: s.id,
      caseId: s.caseId,
      trial: s.trial,
      scenario: s.scenario,
      runDir: s.runDir,
      failed: s.failed,
      mechanical: s.mechanical,
      behavior: s.behavior,
      ux: s.ux,
      modelCalls: s.modelCalls,
    })),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) { console.error(parsed.error); process.exitCode = 2; return; }
  const args = parsed;

  mkdirSync(args.outDir, { recursive: true });
  // 硬上限登记始终落盘（缺一不跑）。
  writeFileSync(path.join(args.outDir, 'hardlimits.json'), JSON.stringify(hardLimitRegistration(), null, 2) + '\n');

  // 套件接缝校验（fail-closed：目录须在 exploration/ 之下、含 suite.ts）。
  const suite = await loadSuite(args.suiteDir);
  const cases = selectCases(suite.cases as readonly BizCase[], args.cases);
  const items = expandBizprobeItems(cases, args.trials);
  assertWithinHardLimits({ sessions: items.length, concurrency: args.concurrency, maxModelCalls: args.maxModelCalls, maxWallMs: args.maxWallMs });

  const gate = checkInfraGate();
  writeFileSync(path.join(args.outDir, 'infra-gate.json'), JSON.stringify({ ...gate, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  if (gate.blocking) {
    console.error('infra 门失败（blocking=true，不烧样本）：');
    for (const c of gate.checks) console.error(`  - [${c.ok ? 'ok' : 'FAIL'}] ${c.name}：${c.note}`);
    process.exitCode = 2;
    return;
  }
  console.log(`infra 门通过（模型 ${gate.model}）；套件 ${suite.id}；用例 ${cases.length} × N=${args.trials ?? '(各用例自带)'} = ${items.length} 样本；并发 ${args.concurrency}。`);
  if (args.mode === 'infra-gate') {
    console.log('--infra-gate 模式：只验门，不调模型。加 --run 才跑真实模型。');
    return;
  }

  const report = await runBizprobeBatch({ cases, items, executor: createModelExecutor(), outRoot: args.outDir, concurrency: args.concurrency });
  const summary = summarizeBizprobe(report);
  writeFileSync(path.join(args.outDir, 'report.json'), JSON.stringify(buildRunReportJson({ suiteId: suite.id, report, summary }), null, 2) + '\n');
  for (const s of summary) {
    console.log(`${s.caseId}（场景#${s.scenario}）：${s.pass}/${s.n} 通过，Wilson95=[${s.passRateCI.lower.toFixed(3)}, ${s.passRateCI.upper.toFixed(3)}]，机械判负 ${s.mechanicalFailures}，severe ${s.severe}`);
  }
  const anyFail = report.samples.some((s) => s.failed);
  process.exitCode = anyFail ? 1 : 0;
}

// 仅在被直接执行时跑 main（被 import 时只暴露函数，供自测/其它入口复用）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
