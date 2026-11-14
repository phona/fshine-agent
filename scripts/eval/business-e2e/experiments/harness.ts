/**
 * bizbatch2 三实验跑批装配——复用阶段 1 已交付的并行编排（`../batch`）与逐样本证据落盘
 * （`../collect`），判定走实验判定器（`./judge`）。真值来源：预注册 §五。
 *
 * 与探测基线装配（`../assembly`）的差异：判据是实验专属（工具调用真实发生 / 取消如实 /
 * 越权不可见 / 压缩触发计数 / 口径标记），机械面仍复用**冻结**的 `judgeMechanical`。
 * 每样本独立工作目录（config/db/state/session），单样本失败不中断其余样本。
 */
import path from 'node:path';
import { runBatch, compareSerialParallel, type BatchReport, type CaseContext, type ConsistencyReport } from '../batch';
import { writeSampleRun } from '../collect';
import { wilson95 } from '../../exploration/stats';
import { judgeExp, type ExpEvidence, type ExpVerdict, type ExpCaseSummary } from './judge';
import { assertWithinExpHardLimits, EXP_HARD_LIMITS, expHardLimitRegistration, type ExpCase, type ExpItem, type ExperimentKind } from './model';
import type { ExpExecutor } from './executor';

export interface ExpSampleOutcome {
  id: string;
  caseId: string;
  kind: ExperimentKind;
  arm: ExpCase['arm'] | null;
  trial: number;
  runDir: string;
  failed: boolean;
  error?: string;
  verdict: ExpVerdict | null;
  /** 本样本模型调用数（驱动面可得则记；不可得 null，不编造）。 */
  modelCalls: number | null;
  seedTaskNos?: { waiting?: number; foreign?: number };
}

export interface ExpReport {
  kind: ExperimentKind;
  policy: BatchReport['policy'];
  hardLimits: Record<string, unknown>;
  batch: BatchReport;
  samples: ExpSampleOutcome[];
  experiment: { sessions: number; modelCallsTotal: number | null; wallMs: number };
}

function outcomeFromOutput(output: unknown): ExpSampleOutcome | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const o = output as Partial<ExpSampleOutcome>;
  if (typeof o.runDir !== 'string' || o.verdict === null || o.verdict === undefined) return undefined;
  return o as ExpSampleOutcome;
}

function callsOf(ev: ExpEvidence): number {
  const calls = ev.meta.turns.reduce((sum, t) => sum + (t.modelCalls ?? 0), 0);
  const tokensMissing = ev.meta.turns.every((t) => t.tokens?.available === false);
  return tokensMissing && calls === 0 ? 0 : calls;
}

/** 跑一批实验样本：每样本独立工作目录 + 逐样本证据落盘 + 实验判定。 */
export async function runExpBatch(input: {
  kind: ExperimentKind;
  cases: readonly ExpCase[];
  items: readonly ExpItem[];
  executor: ExpExecutor;
  outRoot: string;
  concurrency: number;
}): Promise<ExpReport> {
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  assertWithinExpHardLimits({
    kind: input.kind,
    sessions: input.items.length,
    concurrency: input.concurrency,
    maxModelCalls: EXP_HARD_LIMITS.maxModelCallsPerExperiment[input.kind],
    maxWallMs: EXP_HARD_LIMITS.maxWallMsPerExperiment,
  });

  const batch = await runBatch<ExpItem>(
    input.items,
    async (item, ctx) => {
      const caseDef = byId.get(item.caseId);
      if (caseDef === undefined) throw new Error(`未知用例 id：${item.caseId}`);
      if (ctx.workDir === undefined) throw new Error('业务实验需要每样本工作目录（batch 的 workRoot）');
      const ev = await input.executor(item, caseDef, ctx.workDir);
      const runDir = writeSampleRun(input.outRoot, {
        inputs: ev.inputs,
        toolCalls: ev.toolCalls,
        tasks: ev.tasks,
        replies: ev.replies,
        meta: ev.meta,
        sample: ev.sample,
      });
      const verdict = judgeExp(ev);
      const outcome: ExpSampleOutcome = {
        id: item.id,
        caseId: item.caseId,
        kind: item.kind,
        arm: item.arm,
        trial: item.trial,
        runDir,
        failed: !verdict.pass,
        verdict,
        modelCalls: callsOf(ev),
        seedTaskNos: ev.seedTaskNos,
      };
      return outcome;
    },
    { concurrency: input.concurrency, workRoot: path.join(input.outRoot, 'work') },
  );

  const samples: ExpSampleOutcome[] = [];
  batch.outcomes.forEach((outcome, index) => {
    const item = input.items[index];
    if (item === undefined) return;
    if (outcome.ok) {
      const parsed = outcomeFromOutput(outcome.output);
      if (parsed !== undefined) { samples.push(parsed); return; }
    }
    samples.push({
      id: item.id,
      caseId: item.caseId,
      kind: item.kind,
      arm: item.arm,
      trial: item.trial,
      runDir: path.join(input.outRoot, item.caseId, String(item.trial)),
      failed: true,
      error: outcome.error ?? '样本执行未产出结果',
      verdict: null,
      modelCalls: null,
    });
  });

  const callTotals = samples.map((s) => s.modelCalls);
  const modelCallsTotal = callTotals.some((c) => c === null) ? null : callTotals.reduce<number>((a, b) => a + (b ?? 0), 0);
  return {
    kind: input.kind,
    policy: batch.policy,
    hardLimits: expHardLimitRegistration(input.kind),
    batch,
    samples,
    experiment: { sessions: input.items.length, modelCallsTotal, wallMs: batch.wallMs },
  };
}

/** 串并行各跑一遍同一样本集，比对逐样本判定（不一致以串行为准）。 */
export async function compareExpSerialParallel(input: {
  kind: ExperimentKind;
  cases: readonly ExpCase[];
  items: readonly ExpItem[];
  executor: ExpExecutor;
  outRoot: string;
  concurrency: number;
}): Promise<ConsistencyReport<ExpItem>> {
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  const execute = async (item: ExpItem, ctx: CaseContext): Promise<unknown> => {
    const caseDef = byId.get(item.caseId);
    if (caseDef === undefined) throw new Error(`未知用例 id：${item.caseId}`);
    if (ctx.workDir === undefined) throw new Error('业务实验需要每样本工作目录');
    const ev = await input.executor(item, caseDef, ctx.workDir);
    return { id: item.id, verdict: judgeExp(ev) };
  };
  return await compareSerialParallel(input.items, execute, {
    concurrency: input.concurrency,
    workRoot: path.join(input.outRoot, 'sp-work'),
  });
}

/** 逐用例 k/N + Wilson 95% CI（不得读作稳定概率）。 */
export function summarizeExp(report: ExpReport): ExpCaseSummary[] {
  const byCase = new Map<string, ExpSampleOutcome[]>();
  for (const s of report.samples) {
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  const out: ExpCaseSummary[] = [];
  for (const [caseId, samples] of byCase) {
    const n = samples.length;
    const pass = samples.filter((s) => s.verdict?.pass === true).length;
    out.push({
      caseId,
      kind: samples[0]!.kind,
      arm: samples[0]!.arm ?? null,
      n,
      pass,
      passRateCI: wilson95(pass, n),
      severe: samples.filter((s) => s.verdict?.severity === 'severe').length,
      counters: {
        taskToolCalls: samples.reduce((sum, s) => sum + (s.verdict?.counters.taskToolCalls ?? 0), 0),
        skillReads: samples.reduce((sum, s) => sum + (s.verdict?.counters.skillReads ?? 0), 0),
        compactionRounds: samples.reduce((sum, s) => sum + (s.verdict?.counters.compactionRounds ?? 0), 0),
        compactionTriggerEvents: samples.reduce((sum, s) => sum + (s.verdict?.counters.compactionTriggerEvents ?? 0), 0),
        compactionCompleted: samples.reduce((sum, s) => sum + (s.verdict?.counters.compactionCompleted ?? 0), 0),
        unauthorized: samples.reduce((sum, s) => sum + (s.verdict?.counters.unauthorized ?? 0), 0),
        falseCompletion: samples.reduce((sum, s) => sum + (s.verdict?.counters.falseCompletion ?? 0), 0),
      },
      skillBlockBytes: 0,
    });
  }
  return out;
}

/** Skill 三臂配对：按 base 用例（去掉臂后缀）× 臂汇总 k/N。 */
export function summarizeSkillArms(report: ExpReport): Array<{ base: string; arm: string; n: number; pass: number; skillReads: number }> {
  const rows: Array<{ base: string; arm: string; n: number; pass: number; skillReads: number }> = [];
  const groups = new Map<string, ExpSampleOutcome[]>();
  for (const s of report.samples) {
    const base = s.caseId.replace(/-(none|inline|catalog)$/, '');
    const key = `${base}|${s.arm ?? 'none'}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  for (const [key, samples] of groups) {
    const [base, arm] = key.split('|') as [string, string];
    rows.push({
      base,
      arm,
      n: samples.length,
      pass: samples.filter((s) => s.verdict?.pass === true).length,
      skillReads: samples.reduce((sum, s) => sum + (s.verdict?.counters.skillReads ?? 0), 0),
    });
  }
  return rows;
}
