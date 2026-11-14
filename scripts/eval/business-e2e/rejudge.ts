/**
 * 业务 E2E 探测基线：从**已落盘证据**重算判定（不调模型、不新增会话）。
 *
 * 用途：当判定投影（`./sample-from-run`）修 bug 后，用同一份原始模型证据（tool-calls/replies/tasks）
 * 重算机械/行为/UX 读数——模型样本只采一次（不重采样），只重算确定性分析面。
 * 写 `<runDir>/verdict.rejudged.json`（不覆盖原 verdict.json，全样本保留）并汇总
 * `report.rejudged.json`（逐场景 k/N + Wilson 95% CI）。
 *
 * 用法：node --import tsx scripts/eval/business-e2e/rejudge.ts [--out-dir <dir>] [--case B01,...]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bizCases } from '../exploration/bizprobe/cases';
import type { BizCase } from './scenarios';
import { judgeMechanical } from './judge';
import { buildSampleRecord } from './sample-from-run';
import type { ReplyLine, TaskRecordJson, ToolCallRecord } from '../convergence-r1/evidence';
import { wilson95 } from '../exploration/stats';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8').trim();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as T);
}

interface RejudgedSample {
  id: string;
  caseId: string;
  trial: number;
  scenario: number;
  mechanical: ReturnType<typeof judgeMechanical>;
  behavior: unknown;
  ux: unknown;
}

function rejudgeOne(caseDef: BizCase, outRoot: string, trial: number): RejudgedSample | undefined {
  const runDir = path.join(outRoot, caseDef.id, String(trial));
  if (!existsSync(path.join(runDir, 'verdict.json'))) return undefined;
  const toolCalls = (JSON.parse(readFileSync(path.join(runDir, 'tool-calls.json'), 'utf8')) as { toolCalls: ToolCallRecord[] }).toolCalls;
  const replies = readJsonl<ReplyLine>(path.join(runDir, 'replies.jsonl'));
  const tasks = (JSON.parse(readFileSync(path.join(runDir, 'tasks.json'), 'utf8')) as { tasks: TaskRecordJson[] }).tasks;
  const sample = buildSampleRecord({ caseDef, toolCalls, replies, taskCount: tasks.length });
  const verdict = {
    sampleId: caseDef.id,
    mechanical: judgeMechanical(sample),
    behavior: sample.behavior ?? null,
    ux: sample.ux ?? null,
    observations: sample.observations ?? null,
    rejudged: true,
    rejudgedAt: new Date().toISOString(),
    note: '由 rejudge.ts 从原始证据重算（投影修复后；原 verdict.json 保留）',
  };
  writeFileSync(path.join(runDir, 'verdict.rejudged.json'), JSON.stringify(verdict, null, 2) + '\n');
  return { id: `${caseDef.id}#${trial}`, caseId: caseDef.id, trial, scenario: caseDef.biz.scenario, mechanical: verdict.mechanical, behavior: verdict.behavior, ux: verdict.ux };
}

function main(): void {
  const argv = process.argv.slice(2);
  let outRoot = path.join(REPO_ROOT, '.runtime', 'bizprobe');
  let wanted: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--out-dir' || a === '--out') outRoot = path.resolve(REPO_ROOT, argv[++i] ?? outRoot);
    else if (a === '--case' || a === '--cases') wanted = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  const cases = bizCases.filter((c) => wanted.length === 0 || wanted.includes(c.id));
  const samples: RejudgedSample[] = [];
  for (const caseDef of cases) {
    for (let trial = 1; trial <= caseDef.biz.trials; trial += 1) {
      const r = rejudgeOne(caseDef, outRoot, trial);
      if (r !== undefined) samples.push(r);
    }
  }
  const byCase = new Map<string, RejudgedSample[]>();
  for (const s of samples) { const list = byCase.get(s.caseId) ?? []; list.push(s); byCase.set(s.caseId, list); }
  const summary = [...byCase].map(([caseId, list]) => {
    const n = list.length;
    const pass = list.filter((s) => s.mechanical.pass).length;
    return {
      caseId, scenario: list[0]!.scenario, n, pass,
      passRateCI: wilson95(pass, n),
      mechanicalFailures: list.filter((s) => !s.mechanical.pass).length,
      severe: list.filter((s) => s.mechanical.severity === 'severe').length,
      violationsTotals: {
        outOfScope: list.reduce((a, s) => a + s.mechanical.violations.outOfScope, 0),
        writeAttempts: list.reduce((a, s) => a + s.mechanical.violations.writeAttempts, 0),
        meaninglessDuplicates: list.reduce((a, s) => a + s.mechanical.violations.meaninglessDuplicates, 0),
        falseCompletion: list.reduce((a, s) => a + s.mechanical.violations.falseCompletion, 0),
        unauthorized: list.reduce((a, s) => a + s.mechanical.violations.unauthorized, 0),
      },
    };
  });
  writeFileSync(path.join(outRoot, 'report.rejudged.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'rejudge from stored evidence (no model calls)', summary, samples: samples.map((s) => ({ id: s.id, caseId: s.caseId, trial: s.trial, scenario: s.scenario, mechanical: s.mechanical, behavior: s.behavior, ux: s.ux })) }, null, 2) + '\n');
  for (const s of summary) {
    const v = s.violationsTotals;
    console.log(`${s.caseId}(#${s.scenario}) ${s.pass}/${s.n} pass  Wilson95=[${s.passRateCI.lower.toFixed(3)},${s.passRateCI.upper.toFixed(3)}]  sev=${s.severe}  viol(out/dup/unauth/false)=${v.outOfScope}/${v.meaninglessDuplicates}/${v.unauthorized}/${v.falseCompletion}  write=${v.writeAttempts}`);
  }
}

main();
