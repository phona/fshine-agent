/**
 * 业务 E2E 探测基线（阶段 2）跑批装配——把用例集接到阶段 1 已交付的三件基建：
 *   并行编排 `./batch`（显式并发上限、硬上限登记、串并行一致性）+ 证据采集 `./collect`
 *   （逐样本 run-dir、八类证据、manifest sha256）+ 判定 `./judge`（机械断言）。
 *
 * 本模块**不跑模型**：真实驱动器由 `./model-executor` 注入（run.ts），确定性假件由自测注入。
 * 装配只负责：逐样本独立工作目录（config/db/state/session 的落点）→ 执行 → 落证据 → 判定
 * → 汇总（机械 / 行为 / UX 三类字段分离；k/N 一律附 Wilson 95% CI，不读作稳定概率）。
 */
import path from 'node:path';
import { judgeMechanical, type MechanicalVerdict, type SampleRecord } from './judge';
import { writeSampleRun, type NotificationLine, type TaskFactLine } from './collect';
import { runBatch, compareSerialParallel, type BatchReport, type CaseContext, type ConsistencyReport } from './batch';
import type { InputsFile, MetaFile, ReplyLine, TaskRecordJson, ToolCallRecord } from '../convergence-r1/evidence';
import { assertWithinHardLimits, BIZ_HARD_LIMITS, hardLimitRegistration, type BizCase, type BizItem, type ScenarioClass } from './scenarios';
import { wilson95 } from '../exploration/stats';

/** 一次样本执行的完整证据（collect.ts 输入 + 判定器样本记录）。 */
export interface BizSampleEvidence {
  inputs: InputsFile;
  toolCalls: readonly ToolCallRecord[];
  tasks: readonly TaskRecordJson[];
  replies: readonly ReplyLine[];
  meta: MetaFile;
  taskFacts?: readonly TaskFactLine[];
  notifications?: readonly NotificationLine[];
  auditLines?: readonly string[];
  sample: SampleRecord;
}

/** 驱动器：由一个（用例×trial）样本产出完整证据。真实模型/假件实现同一签名。 */
export type BizExecutor = (item: BizItem, caseDef: BizCase, ctx: CaseContext) => Promise<BizSampleEvidence>;

/** 逐样本判定结果（机械 / 行为 / UX 分开字段）。 */
export interface BizSampleOutcome {
  id: string;
  caseId: string;
  trial: number;
  scenario: ScenarioClass;
  runDir: string;
  failed: boolean;
  error?: string;
  mechanical: MechanicalVerdict;
  behavior: SampleRecord['behavior'] | null;
  ux: SampleRecord['ux'] | null;
  /** 本样本模型调用数（驱动面可得则记数；不可得为 null，不编造）。 */
  modelCalls: number | null;
}

export interface BizprobeReport {
  policy: BatchReport['policy'];
  hardLimits: Record<string, unknown>;
  batch: BatchReport;
  samples: BizSampleOutcome[];
  /** 实验级读数：会话数 / 模型调用合计（不可得=null）/ 墙钟。 */
  experiment: { sessions: number; modelCallsTotal: number | null; wallMs: number };
}

function sampleOutcomeFromOutput(item: BizItem, output: unknown): BizSampleOutcome | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const o = output as Partial<BizSampleOutcome>;
  if (typeof o.runDir !== 'string' || o.mechanical === undefined) return undefined;
  return o as BizSampleOutcome;
}

/**
 * 跑一批业务样本：每样本独立工作目录（`<outRoot>/work/<item.id>`）+ 独立 run-dir 证据
 * （`<outRoot>/<caseId>/<trial>`）。单样本失败不中断其余样本（outcome 逐案标记）。
 */
export async function runBizprobeBatch(input: {
  cases: readonly BizCase[];
  items: readonly BizItem[];
  executor: BizExecutor;
  outRoot: string;
  concurrency: number;
}): Promise<BizprobeReport> {
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  assertWithinHardLimits({
    sessions: input.items.length,
    concurrency: input.concurrency,
    maxModelCalls: BIZ_HARD_LIMITS.maxModelCalls,
    maxWallMs: BIZ_HARD_LIMITS.maxWallMs,
  });

  const batch = await runBatch<BizItem>(
    input.items,
    async (item, ctx) => {
      const caseDef = byId.get(item.caseId);
      if (caseDef === undefined) throw new Error(`未知用例 id：${item.caseId}`);
      const evidence = await input.executor(item, caseDef, ctx);
      const runDir = writeSampleRun(input.outRoot, {
        inputs: evidence.inputs,
        toolCalls: evidence.toolCalls,
        tasks: evidence.tasks,
        replies: evidence.replies,
        meta: evidence.meta,
        ...(evidence.taskFacts === undefined ? {} : { taskFacts: evidence.taskFacts }),
        ...(evidence.notifications === undefined ? {} : { notifications: evidence.notifications }),
        ...(evidence.auditLines === undefined ? {} : { auditLines: evidence.auditLines }),
        sample: evidence.sample,
      });
      const verdict = judgeMechanical(evidence.sample);
      const calls = evidence.meta.turns.reduce((sum, t) => sum + (t.modelCalls ?? 0), 0);
      const outcome: BizSampleOutcome = {
        id: item.id,
        caseId: item.caseId,
        trial: item.trial,
        scenario: item.scenario,
        runDir,
        failed: !verdict.pass,
        mechanical: verdict,
        behavior: evidence.sample.behavior ?? null,
        ux: evidence.sample.ux ?? null,
        modelCalls: evidence.meta.turns.every((t) => t.tokens?.available === false) && calls === 0 ? null : calls,
      };
      return outcome;
    },
    { concurrency: input.concurrency, workRoot: path.join(input.outRoot, 'work') },
  );

  const samples: BizSampleOutcome[] = [];
  batch.outcomes.forEach((outcome, index) => {
    const item = input.items[index];
    if (item === undefined) return;
    if (outcome.ok) {
      const parsed = sampleOutcomeFromOutput(item, outcome.output);
      if (parsed !== undefined) {
        samples.push(parsed);
        return;
      }
    }
    // 执行异常：保留全样本（不筛绿），以 failed 记录，不伪造 verdict。
    samples.push({
      id: item.id,
      caseId: item.caseId,
      trial: item.trial,
      scenario: item.scenario,
      runDir: path.join(input.outRoot, item.caseId, String(item.trial)),
      failed: true,
      error: outcome.error ?? '样本执行未产出结果',
      mechanical: { sampleId: item.id, pass: false, severity: 'none', violations: { outOfScope: 0, writeAttempts: 0, meaninglessDuplicates: 0, falseCompletion: 0, unauthorized: 0 }, details: [outcome.error ?? '未产出结果'] },
      behavior: null,
      ux: null,
      modelCalls: null,
    });
  });

  const callTotals = samples.map((s) => s.modelCalls);
  const modelCallsTotal = callTotals.some((c) => c === null) ? null : callTotals.reduce<number>((a, b) => a + (b ?? 0), 0);

  return {
    policy: batch.policy,
    hardLimits: hardLimitRegistration(),
    batch,
    samples,
    experiment: { sessions: input.items.length, modelCallsTotal, wallMs: batch.wallMs },
  };
}

/** 串行与并行各跑一遍同一样本集，比对逐样本判定结果（不一致以串行为准并登记）。 */
export async function compareBizprobeSerialParallel(input: {
  cases: readonly BizCase[];
  items: readonly BizItem[];
  executor: BizExecutor;
  outRoot: string;
  concurrency: number;
}): Promise<ConsistencyReport<BizItem>> {
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  const execute = async (item: BizItem, ctx: CaseContext): Promise<unknown> => {
    const caseDef = byId.get(item.caseId);
    if (caseDef === undefined) throw new Error(`未知用例 id：${item.caseId}`);
    const evidence = await input.executor(item, caseDef, ctx);
    // 一致性对照的读数 = 判定器机械输出（确定性），与落盘证据文件无关（避免路径差异污染）。
    return { id: item.id, verdict: judgeMechanical(evidence.sample) };
  };
  return await compareSerialParallel(input.items, execute, {
    concurrency: input.concurrency,
    workRoot: path.join(input.outRoot, 'sp-work'),
  });
}

export interface BizScenarioSummary {
  scenario: ScenarioClass;
  caseId: string;
  n: number;
  pass: number;
  /** Wilson 95% CI（不得读作稳定概率）。 */
  passRateCI: { lower: number; upper: number };
  mechanicalFailures: number;
  severe: number;
  /** 行为面计数（只统计，不判）：部分失败如实报告 / 澄清必要。 */
  behavior: { honestPartial: number | null; clarificationNecessary: number | null };
  /** UX 指标（只统计）。 */
  ux: { needlessClarifications: number; userInterventions: number; notifications: number };
}

/** 汇总逐场景 k/N + Wilson 95% CI；机械/行为/UX 三类字段分离。 */
export function summarizeBizprobe(report: BizprobeReport): BizScenarioSummary[] {
  const byCase = new Map<string, BizSampleOutcome[]>();
  for (const s of report.samples) {
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  const out: BizScenarioSummary[] = [];
  for (const [caseId, samples] of byCase) {
    const n = samples.length;
    const pass = samples.filter((s) => s.mechanical.pass).length;
    const honestVals = samples.map((s) => s.behavior?.partialFailureReportedHonestly).filter((v) => v !== null && v !== undefined);
    const clarVals = samples.map((s) => s.behavior?.clarificationNecessary).filter((v) => v !== null && v !== undefined);
    out.push({
      scenario: samples[0]!.scenario,
      caseId,
      n,
      pass,
      passRateCI: wilson95(pass, n),
      mechanicalFailures: samples.filter((s) => !s.mechanical.pass).length,
      severe: samples.filter((s) => s.mechanical.severity === 'severe').length,
      behavior: {
        honestPartial: honestVals.length === 0 ? null : honestVals.filter((v) => v === true).length,
        clarificationNecessary: clarVals.length === 0 ? null : clarVals.filter((v) => v === true).length,
      },
      ux: {
        needlessClarifications: samples.reduce((sum, s) => sum + (s.ux?.needlessClarifications ?? 0), 0),
        userInterventions: samples.reduce((sum, s) => sum + (s.ux?.userInterventions ?? 0), 0),
        notifications: samples.reduce((sum, s) => sum + (s.ux?.notifications ?? 0), 0),
      },
    });
  }
  return out;
}
