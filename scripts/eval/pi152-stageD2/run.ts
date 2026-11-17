#!/usr/bin/env node
/**
 * 阶段 D2：Pi 原生压缩配置对照实验（16,384 窗口；仅 reserveTokens / keepRecentTokens 不同）。
 *
 * 预注册：`.runtime/pi152-stageD2/prereg.md`（写于任何真实模型请求之前）。
 * 场景：阶段 D A 组 22 回合（事实种子 / 中性填充 / 事实探针 / 纠错 / 重启），两组逐字相同。
 *
 * 用法：
 *   # 装配自检（零模型、零网络）
 *   node --import tsx scripts/eval/pi152-stageD2/run.ts --selftest
 *   # 真实运行（需 .env；预算见预注册）
 *   node --env-file-if-exists=.env --import tsx scripts/eval/pi152-stageD2/run.ts --run
 *
 * 只调 Pi 原生配置；不新增宿主触发/预算门、不改提示词、不改工具面。
 * 硬停：任一预算达限即停全部后续会话，保留已完成样本；不重采样、不筛绿。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskScope } from '../../../packages/agent/src/task-registry';
import type { TurnDriver } from '../../../packages/agent/src/driver-contract';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  buildSession,
  createBudgetMeter,
  finalizeRestart,
  prepareGroup,
  restartSession,
  sendTurn,
  type BudgetMeter,
  type ModelCallRecord,
  type RestartRecord,
  type SessionHandle,
  type SessionSink,
  type StageDSettingsOverride,
  type TurnRecord,
} from '../pi152-stageD/harness';
import { A_TURNS } from '../pi152-stageD/scenarios';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PREREG_PATH = path.join(REPO_ROOT, '.runtime', 'pi152-stageD2', 'prereg.md');
const DEFAULT_OUT = path.join(REPO_ROOT, '.runtime', 'pi152-stageD2');

type ArmId = 'control' | 'experiment';

export interface Arm {
  id: ArmId;
  label: string;
  settings: Required<StageDSettingsOverride>;
}

/** 与预注册 §1 逐字一致。 */
export const ARMS: Readonly<Record<ArmId, Arm>> = {
  control: {
    id: 'control',
    label: '对照组（原配置 reserve=4096 / keepRecent=4915）',
    settings: {
      contextWindow: 16_384,
      maxTokens: 4_096,
      compaction: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 4_915 },
    },
  },
  experiment: {
    id: 'experiment',
    label: '实验组（reserve=8192 / keepRecent=4096）',
    settings: {
      contextWindow: 16_384,
      maxTokens: 4_096,
      compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 4_096 },
    },
  },
};

export interface D2Budget {
  samplesPerArm: number;
  maxModelCalls: number;
  maxTokens: number;
  wallMs: number;
}

/** 预注册 §2 硬预算。 */
export const DEFAULT_BUDGET: D2Budget = { maxModelCalls: 300, maxTokens: 4_000_000, wallMs: 60 * 60_000, samplesPerArm: 3 };

const OVERFLOW_RE = /context[_ ]length|maximum context|too many tokens|reduce the length|prompt is too long|"status"\s*:\s*413/i;

export interface SampleEvidence {
  arm: ArmId;
  sample: number;
  settings: Required<StageDSettingsOverride>;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  error: string | null;
  sessions: SessionSink[];
  restarts: RestartRecord[];
}

export interface SampleReading {
  arm: ArmId;
  sample: number;
  turns: number;
  emptyReplies: number;
  turnErrors: number;
  modelCalls: number;
  mainCalls: number;
  summaryCalls: number;
  summaryFailures: number;
  compactionCommits: number;
  compactionTokensBefore: Array<number | null>;
  compactionEmptySummaries: number;
  mainCapDistribution: Record<string, number>;
  summaryCapDistribution: Record<string, number>;
  wireCapMissing: number;
  overflowCalls: number;
  errorCalls: number;
  /** provider 报的 totalTokens 超过本次声明窗口的主请求（≠ provider 拒绝；用于看声明窗口是否真的兜住）。 */
  mainCallsOverWindow: number;
  maxMainTotalTokens: number;
  factProbes: number;
  factPassed: number;
  tokens: number;
  wallMs: number;
  converges: boolean;
  convergenceNotes: string[];
}

export interface ArmReading {
  arm: ArmId;
  samples: number;
  turns: number;
  emptyReplies: number;
  modelCalls: number;
  mainCalls: number;
  overflowCalls: number;
  overflowRate: number;
  mainCallsOverWindow: number;
  maxMainTotalTokens: number;
  factProbes: number;
  factPassed: number;
  factRate: number;
  compactionCommits: number;
  summaryCalls: number;
  summaryFailures: number;
  tokens: number;
  wallMs: number;
  converges: boolean;
}

export interface Verdict {
  id: string;
  statement: string;
  reading: string;
  verdict: 'PASS' | 'FAIL' | 'NOT_MEASURED';
}

function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return String(value) as unknown as T;
  }
}

function distribution(values: ReadonlyArray<number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value === null ? 'null' : String(value);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function flattenSessions(sessions: readonly SessionSink[]): { calls: ModelCallRecord[]; turns: TurnRecord[]; compactions: SessionSink['compactions'] } {
  // 重启后新 sink 会重新读取同一份会话文件并把历史压缩条目再登记一次；按 file#index 去重，
  // 避免把一次压缩提交记成两次。
  const seen = new Set<string>();
  const compactions: SessionSink['compactions'] = [];
  for (const entry of sessions.flatMap((session) => session.compactions)) {
    const key = `${entry.file}#${entry.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compactions.push(entry);
  }
  return {
    calls: sessions.flatMap((session) => session.modelCalls),
    turns: sessions.flatMap((session) => session.turns),
    compactions,
  };
}

export function readSample(evidence: SampleEvidence): SampleReading {
  const { calls, turns, compactions } = flattenSessions(evidence.sessions);
  const main = calls.filter((call) => !call.isSummary);
  const summary = calls.filter((call) => call.isSummary);
  const summaryFailures = summary.filter((call) => call.stopReason === 'error' || call.stopReason === 'length' || call.error !== null);
  const overflowCalls = calls.filter((call) => call.error !== null && OVERFLOW_RE.test(call.error));
  const errorCalls = calls.filter((call) => call.stopReason === 'error' || call.error !== null);
  const probes = turns.flatMap((turn) => turn.probes);
  const tokens = calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0);

  const last3 = turns.slice(-3);
  const last3TurnNumbers = new Set(last3.map((turn) => turn.turn));
  const last3SummaryFailures = summaryFailures.filter((call) => last3TurnNumbers.has(call.turn));
  const notes: string[] = [];
  const nonEmptyCommits = compactions.filter((entry) => entry.summary.trim().length > 0);
  if (nonEmptyCommits.length === 0) notes.push('无有效压缩提交');
  if (compactions.length !== nonEmptyCommits.length) notes.push(`存在空摘要提交 ${compactions.length - nonEmptyCommits.length} 条`);
  if (last3.some((turn) => turn.reply.trim() === '')) notes.push('最后 3 回合存在空回复');
  if (last3SummaryFailures.length > 0) notes.push(`最后 3 回合内摘要失败 ${last3SummaryFailures.length} 次`);
  if (turns.some((turn) => turn.error !== null)) notes.push('存在回合异常');

  return {
    arm: evidence.arm,
    sample: evidence.sample,
    turns: turns.length,
    emptyReplies: turns.filter((turn) => turn.emptyReply).length,
    turnErrors: turns.filter((turn) => turn.error !== null).length,
    modelCalls: calls.length,
    mainCalls: main.length,
    summaryCalls: summary.length,
    summaryFailures: summaryFailures.length,
    compactionCommits: compactions.length,
    compactionTokensBefore: compactions.map((entry) => entry.tokensBefore),
    compactionEmptySummaries: compactions.length - nonEmptyCommits.length,
    mainCapDistribution: distribution(main.map((call) => call.wireMaxCompletionTokens)),
    summaryCapDistribution: distribution(summary.map((call) => call.wireMaxCompletionTokens)),
    wireCapMissing: calls.filter((call) => call.wireMaxCompletionTokens === null).length,
    overflowCalls: overflowCalls.length,
    errorCalls: errorCalls.length,
    mainCallsOverWindow: main.filter((call) => (call.usage?.totalTokens ?? 0) > evidence.settings.contextWindow).length,
    maxMainTotalTokens: main.reduce((max, call) => Math.max(max, call.usage?.totalTokens ?? 0), 0),
    factProbes: probes.length,
    factPassed: probes.filter((probe) => probe.passed).length,
    tokens,
    wallMs: evidence.wallMs,
    converges: notes.length === 0,
    convergenceNotes: notes,
  };
}

export function aggregate(readings: readonly SampleReading[]): ArmReading[] {
  const arms: ArmId[] = ['control', 'experiment'];
  return arms.map((arm) => {
    const rows = readings.filter((row) => row.arm === arm);
    const turns = rows.reduce((sum, row) => sum + row.turns, 0);
    const calls = rows.reduce((sum, row) => sum + row.modelCalls, 0);
    const overflow = rows.reduce((sum, row) => sum + row.overflowCalls, 0);
    const probes = rows.reduce((sum, row) => sum + row.factProbes, 0);
    const passed = rows.reduce((sum, row) => sum + row.factPassed, 0);
    return {
      arm,
      samples: rows.length,
      turns,
      emptyReplies: rows.reduce((sum, row) => sum + row.emptyReplies, 0),
      modelCalls: calls,
      mainCalls: rows.reduce((sum, row) => sum + row.mainCalls, 0),
      overflowCalls: overflow,
      overflowRate: calls === 0 ? 0 : overflow / calls,
      mainCallsOverWindow: rows.reduce((sum, row) => sum + row.mainCallsOverWindow, 0),
      maxMainTotalTokens: rows.reduce((max, row) => Math.max(max, row.maxMainTotalTokens), 0),
      factProbes: probes,
      factPassed: passed,
      factRate: probes === 0 ? 0 : passed / probes,
      compactionCommits: rows.reduce((sum, row) => sum + row.compactionCommits, 0),
      summaryCalls: rows.reduce((sum, row) => sum + row.summaryCalls, 0),
      summaryFailures: rows.reduce((sum, row) => sum + row.summaryFailures, 0),
      tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      wallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
      converges: rows.length > 0 && rows.every((row) => row.converges),
    };
  });
}

/** 判据（预注册 §4；跑后不改）。 */
export function judge(readings: readonly SampleReading[]): Verdict[] {
  const [control, experiment] = aggregate(readings);
  const expRows = readings.filter((row) => row.arm === 'experiment');
  const expectedSamples = new Set(expRows.map((row) => row.sample)).size;
  const j1 = expectedSamples >= DEFAULT_BUDGET.samplesPerArm && experiment !== undefined && experiment.emptyReplies === 0;
  const j2 = control !== undefined && experiment !== undefined
    && (control.modelCalls === 0 || experiment.overflowCalls * control.modelCalls <= control.overflowCalls * experiment.modelCalls);
  const j3 = control !== undefined && experiment !== undefined && experiment.factRate >= control.factRate;
  const j4 = experiment !== undefined && experiment.samples === DEFAULT_BUDGET.samplesPerArm && experiment.converges;
  return [
    {
      id: 'J1',
      statement: '实验组静默空回复数 = 0',
      reading: `${experiment?.emptyReplies ?? 0}/${experiment?.turns ?? 0} 回合（样本 ${experiment?.samples ?? 0}/${DEFAULT_BUDGET.samplesPerArm}）`,
      verdict: expectedSamples >= DEFAULT_BUDGET.samplesPerArm ? (j1 ? 'PASS' : 'FAIL') : 'NOT_MEASURED',
    },
    {
      id: 'J2',
      statement: '实验组实际超窗率 ≤ 对照组',
      reading: `provider 拒绝：control ${control?.overflowCalls ?? 0}/${control?.modelCalls ?? 0}；experiment ${experiment?.overflowCalls ?? 0}/${experiment?.modelCalls ?? 0}（辅：provider 报 totalTokens>声明窗口的主请求 control ${control?.mainCallsOverWindow ?? 0}/${control?.mainCalls ?? 0}、experiment ${experiment?.mainCallsOverWindow ?? 0}/${experiment?.mainCalls ?? 0}；maxTotal ${control?.maxMainTotalTokens ?? 0} / ${experiment?.maxMainTotalTokens ?? 0}）`,
      verdict: control === undefined || experiment === undefined ? 'NOT_MEASURED' : (j2 ? 'PASS' : 'FAIL'),
    },
    {
      id: 'J3',
      statement: '实验组关键事实保留率 ≥ 对照组',
      reading: `control ${control?.factPassed ?? 0}/${control?.factProbes ?? 0}；experiment ${experiment?.factPassed ?? 0}/${experiment?.factProbes ?? 0}`,
      verdict: control === undefined || experiment === undefined || control.factProbes === 0 ? 'NOT_MEASURED' : (j3 ? 'PASS' : 'FAIL'),
    },
    {
      id: 'J4',
      statement: '实验组原生压缩收敛（每会话有效压缩、末尾非空、末尾无摘要失败、无异常终止）',
      reading: experiment === undefined ? '无实验样本' : `${experiment.samples} 会话全部收敛=${experiment.converges}`,
      verdict: experiment === undefined ? 'NOT_MEASURED' : (j4 ? 'PASS' : 'FAIL'),
    },
  ];
}

function renderReport(input: { samples: SampleReading[]; arms: ArmReading[]; verdicts: Verdict[]; budget: typeof DEFAULT_BUDGET; hardStop: string | null; startedAt: string; endedAt: string }): string {
  const lines: string[] = [];
  lines.push('# 阶段 D2 · Pi 原生压缩配置对照（真实模型 step-3.7-flash）', '');
  lines.push(`- 运行窗口：${input.startedAt} → ${input.endedAt}`);
  lines.push(`- 预注册：\`.runtime/pi152-stageD2/prereg.md\`（N=${input.budget.samplesPerArm}/组，一次采样，全样本保留）`);
  lines.push(`- 硬预算：calls≤${input.budget.maxModelCalls}；tokens≤${input.budget.maxTokens}；wall≤${input.budget.wallMs}ms；hardStop=${input.hardStop ?? '无'}`);
  lines.push(`- 唯一变量：\`reserveTokens\`/\`keepRecentTokens\`（control 4096/4915 vs experiment 8192/4096）；窗口 16,384、maxTokens 4,096、thinkingLevel=off。`, '');
  lines.push('## 组级读数', '');
  lines.push('| 组 | 样本 | 回合 | 空回复 | 模型调用 | provider 拒绝超窗 | 主请求 total>声明窗口 | maxTotal | 事实探针 | 压缩提交 | 摘要调用/失败 | tokens | wall | 收敛 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of input.arms) {
    lines.push(`| ${arm.arm} | ${arm.samples} | ${arm.turns} | ${arm.emptyReplies} | ${arm.modelCalls} | ${arm.overflowCalls} | ${arm.mainCallsOverWindow}/${arm.mainCalls} | ${arm.maxMainTotalTokens} | ${arm.factPassed}/${arm.factProbes} | ${arm.compactionCommits} | ${arm.summaryCalls}/${arm.summaryFailures} | ${arm.tokens} | ${arm.wallMs}ms | ${arm.converges} |`);
  }
  lines.push('', '说明：`provider 拒绝超窗` 只统计 provider 返回上下文超限错误；`主请求 total>声明窗口` 是 provider 自己报的 `usage.totalTokens` 超过 16,384 的主请求数（provider 未拒绝——说明该端点真实窗口大于声明值，因此本实验中 provider 侧拒绝率结构性为 0，须以此列判断声明窗口是否真的兜住）。');
  lines.push('', '## 逐会话读数', '');
  lines.push('| 组 | 样本 | 回合 | 空回复 | 主请求 cap 分布 | 摘要 cap 分布 | 压缩提交 (tokensBefore) | 摘要失败 | 超窗 | 事实 | 收敛 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of input.samples) {
    lines.push(`| ${row.arm} | ${row.sample} | ${row.turns} | ${row.emptyReplies} | ${JSON.stringify(row.mainCapDistribution)} | ${JSON.stringify(row.summaryCapDistribution)} | ${row.compactionCommits} ${JSON.stringify(row.compactionTokensBefore)} | ${row.summaryFailures} | ${row.overflowCalls} | ${row.factPassed}/${row.factProbes} | ${row.converges ? '是' : row.convergenceNotes.join('；')} |`);
  }
  lines.push('', '## 判据', '');
  lines.push('| 判据 | 内容 | 读数 | 结论 |');
  lines.push('| --- | --- | --- | --- |');
  for (const verdict of input.verdicts) lines.push(`| ${verdict.id} | ${verdict.statement} | ${verdict.reading} | ${verdict.verdict} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- selftest

async function selftest(out: string): Promise<number> {
  const root = path.join(out, 'selftest');
  mkdirSync(root, { recursive: true });
  const meter = createBudgetMeter({ maxModelCalls: 5, maxTokens: 100_000, wallMs: 60_000 });
  const arm = ARMS.experiment;
  const prepared = await prepareGroup({
    group: 'A',
    root,
    meter,
    settings: arm.settings,
    envOverride: { LLM_API_KEY: 'selftest-placeholder', LLM_API_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'test-model' },
  });
  const model = prepared.baseRuntime.getModel('llm', 'step-3.7-flash');
  // Pi 侧：绝对 compaction 值被 SettingsManager 原样保留（驱动经 settingsManager 透传的同一入口）。
  const resolved = SettingsManager.inMemory({ compaction: arm.settings.compaction })
    .getCompactionSettings(model as never);
  const handle = await buildSession({
    group: 'A',
    prepared,
    key: 'selftest',
    principalId: 'wecom:selftest-d2',
    sessionId: 'selftest-d2-session',
    scope: { principalId: 'wecom:selftest-d2', sessionId: 'selftest-d2-session' } satisfies TaskScope,
    dispatchMode: 'inline',
    withRunner: false,
    settings: arm.settings,
    driverFactory: () => {
      const driver: TurnDriver = {
        async run(input) {
          return { text: '收到', messages: [...input.messages] };
        },
      };
      return { mainDriver: driver, workerDriver: driver };
    },
  });
  const turn = await sendTurn(handle, A_TURNS[0]!, 1, { afterRestart: false });
  const assertions = [
    ['runtime contextWindow override', model?.contextWindow === 16_384],
    ['runtime maxTokens override', model?.maxTokens === 4_096],
    ['Pi settings keep experiment reserveTokens', resolved.reserveTokens === 8_192],
    ['Pi settings keep experiment keepRecentTokens', resolved.keepRecentTokens === 4_096],
    ['turn reply non-empty', turn.reply.trim() !== ''],
  ] as const;
  handle.close();
  prepared.registry.close();
  const synthetic = readSample({
    arm: 'experiment', sample: 0, settings: arm.settings,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(), wallMs: 1, error: null, sessions: [], restarts: [],
  });
  const classification = [
    ['empty sample converges=false', synthetic.converges === false],
    ['overflow regex matches provider text', OVERFLOW_RE.test('{"status":400,"message":"This model\'s maximum context length is 16384 tokens."}')],
    ['overflow regex ignores length stop', !OVERFLOW_RE.test('length')],
    ['distribution counts cap', JSON.stringify(distribution([4096, 4096, null])) === JSON.stringify({ 4096: 2, null: 1 })],
  ] as const;
  const failed = [...assertions, ...classification].filter(([, ok]) => !ok);
  writeFileSync(path.join(root, 'selftest.json'), JSON.stringify({ assertions, classification }, null, 2));
  if (failed.length > 0) {
    console.error(`selftest FAIL：${failed.map(([name]) => name).join('、')}`);
    return 1;
  }
  console.log(`selftest PASS：${assertions.length + classification.length} 项`);
  return 0;
}

// ---------------------------------------------------------------- real run

interface MeterSnapshot { modelCalls: number; tokens: number; wallMs: number; tripped: string | null }

interface EmitInput {
  out: string;
  samples: SampleEvidence[];
  startedAt: string;
  endedAt: string;
  hardStop: string | null;
  budget: D2Budget;
  meter: MeterSnapshot;
}

/** 由原始样本产出 evidence/metrics/report/summary（run 与 recompute 共用，口径一致）。 */
function emitResults(input: EmitInput): number {
  const readings = input.samples.map(readSample);
  const arms = aggregate(readings);
  const verdicts = judge(readings);
  const blocked = input.hardStop !== null
    || verdicts.some((verdict) => verdict.verdict === 'FAIL')
    || verdicts.some((verdict) => verdict.verdict === 'NOT_MEASURED');
  const evidence = {
    stage: 'D2',
    prereg: '.runtime/pi152-stageD2/prereg.md',
    model: 'step-3.7-flash',
    thinkingLevel: 'off',
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    hardStop: input.hardStop,
    meter: input.meter,
    budget: input.budget,
    arms,
    verdicts,
    readings,
    samples: jsonSafe(input.samples),
  };
  writeFileSync(path.join(input.out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  writeFileSync(path.join(input.out, 'metrics.json'), JSON.stringify({ arms, verdicts, readings, hardStop: input.hardStop, budget: input.budget }, null, 2));
  writeFileSync(path.join(input.out, 'report.md'), renderReport({ samples: readings, arms, verdicts, budget: input.budget, hardStop: input.hardStop, startedAt: input.startedAt, endedAt: input.endedAt }));
  const summary = {
    blocked,
    hardStop: input.hardStop,
    samples: input.samples.length,
    arms: arms.map((arm) => ({ arm: arm.arm, samples: arm.samples, turns: arm.turns, emptyReplies: arm.emptyReplies, overflow: `${arm.overflowCalls}/${arm.modelCalls}`, mainCallsOverWindow: `${arm.mainCallsOverWindow}/${arm.mainCalls}`, maxMainTotalTokens: arm.maxMainTotalTokens, facts: `${arm.factPassed}/${arm.factProbes}`, compactions: arm.compactionCommits, summaryFailures: arm.summaryFailures, tokens: arm.tokens, wallMs: arm.wallMs, converges: arm.converges })),
    verdicts: verdicts.map((verdict) => ({ id: verdict.id, statement: verdict.statement, reading: verdict.reading, verdict: verdict.verdict })),
  };
  writeFileSync(path.join(input.out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return blocked ? 1 : 0;
}

/** 只重算读数与报告（不发起模型请求）：用于分析口径修正，原始 samples 原样保留。 */
function recompute(out: string): number {
  const evidencePath = path.join(out, 'evidence.json');
  if (!existsSync(evidencePath)) {
    console.error(`缺少 ${evidencePath}——recompute 只重算已有原始样本。`);
    return 2;
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    startedAt: string;
    endedAt: string;
    hardStop: string | null;
    budget?: D2Budget;
    meter?: MeterSnapshot;
    samples: SampleEvidence[];
  };
  return emitResults({
    out,
    samples: evidence.samples,
    startedAt: evidence.startedAt,
    endedAt: evidence.endedAt,
    hardStop: evidence.hardStop,
    budget: evidence.budget ?? DEFAULT_BUDGET,
    meter: evidence.meter ?? { modelCalls: 0, tokens: 0, wallMs: 0, tripped: null },
  });
}

function parseArgs(argv: string[]): { mode: 'selftest' | 'gate' | 'run' | 'recompute'; samples: number; out: string; arms: ArmId[]; maxModelCalls: number; maxTokens: number; wallMs: number } | { error: string } {
  const args = { mode: 'gate' as 'selftest' | 'gate' | 'run' | 'recompute', samples: DEFAULT_BUDGET.samplesPerArm, out: DEFAULT_OUT, arms: ['control', 'experiment'] as ArmId[], maxModelCalls: DEFAULT_BUDGET.maxModelCalls, maxTokens: DEFAULT_BUDGET.maxTokens, wallMs: DEFAULT_BUDGET.wallMs };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--run') args.mode = 'run';
    else if (arg === '--selftest') args.mode = 'selftest';
    else if (arg === '--gate') args.mode = 'gate';
    else if (arg === '--recompute') args.mode = 'recompute';
    else if (arg.startsWith('--samples=')) args.samples = Number(arg.slice(10));
    else if (arg.startsWith('--out=')) args.out = path.resolve(arg.slice(6));
    else if (arg.startsWith('--arms=')) args.arms = arg.slice(7).split(',').map((item) => item.trim()) as ArmId[];
    else if (arg.startsWith('--max-calls=')) args.maxModelCalls = Number(arg.slice(12));
    else if (arg.startsWith('--max-tokens=')) args.maxTokens = Number(arg.slice(13));
    else if (arg.startsWith('--wall-ms=')) args.wallMs = Number(arg.slice(10));
    else return { error: `未知参数：${arg}` };
  }
  if (!Number.isSafeInteger(args.samples) || args.samples <= 0) return { error: `--samples 无效：${args.samples}` };
  if (args.arms.some((arm) => !(arm in ARMS))) return { error: `--arms 含未知组：${args.arms.join(',')}` };
  return args;
}

async function runSample(input: { arm: Arm; sample: number; root: string; meter: BudgetMeter }): Promise<SampleEvidence> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const sampleRoot = path.join(input.root, input.arm.id, `s${input.sample}`);
  const prepared = await prepareGroup({ group: 'A', root: sampleRoot, meter: input.meter, settings: input.arm.settings });
  const scope: TaskScope = { principalId: `wecom:stage-d2-${input.arm.id}-${input.sample}`, sessionId: `stage-d2-${input.arm.id}-${input.sample}` };
  const build = (resumeFile?: string) => buildSession({
    group: 'A',
    prepared,
    key: 'a',
    principalId: scope.principalId,
    sessionId: scope.sessionId,
    scope,
    dispatchMode: 'inline',
    withRunner: false,
    settings: input.arm.settings,
    ...(resumeFile === undefined ? {} : { resumeFile }),
  });
  let handle: SessionHandle = await build();
  const sessions = [handle.sink];
  const restarts: RestartRecord[] = [];
  let error: string | null = null;
  try {
    for (let index = 0; index < A_TURNS.length; index += 1) {
      if (input.meter.reached() !== null) break;
      const turn = A_TURNS[index]!;
      const afterRestart = index > 0 && A_TURNS[index - 1]!.restartAfter === true;
      await sendTurn(handle, turn, index + 1, { afterRestart });
      if (afterRestart && restarts.length > 0) finalizeRestart(restarts[restarts.length - 1]!, handle, '蓝鲸-42');
      if (turn.restartAfter === true) {
        const resumeFile = handle.sessionFile();
        if (resumeFile === undefined) throw new Error('A 重启前没有落盘会话文件');
        const restarted = await restartSession({ handle, build: () => build(resumeFile), priorMarker: '蓝鲸-42' });
        handle = restarted.handle;
        sessions.push(handle.sink);
        restarts.push(restarted.record);
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    handle.close();
    prepared.registry.close();
  }
  return {
    arm: input.arm.id,
    sample: input.sample,
    settings: input.arm.settings,
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs: Date.now() - started,
    error,
    sessions,
    restarts,
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  if (parsed.mode === 'selftest') return selftest(parsed.out);
  if (parsed.mode === 'recompute') return recompute(parsed.out);
  if (parsed.mode === 'gate') {
    console.log(JSON.stringify({
      mode: 'd2-gate',
      preregPresent: existsSync(PREREG_PATH),
      preregPath: '.runtime/pi152-stageD2/prereg.md',
      model: 'step-3.7-flash',
      arms: Object.fromEntries(Object.values(ARMS).map((arm) => [arm.id, arm.settings])),
      samplesPerArm: DEFAULT_BUDGET.samplesPerArm,
      note: '未发起任何真实模型请求；--run 才执行。',
    }, null, 2));
    return existsSync(PREREG_PATH) ? 0 : 2;
  }
  if (!existsSync(PREREG_PATH)) {
    console.error('缺少预注册 .runtime/pi152-stageD2/prereg.md——拒绝在未预注册的情况下运行真实模型。');
    return 2;
  }
  if ((process.env.LLM_API_KEY ?? '').trim() === '') {
    console.error('未检测到 LLM_API_KEY（用 --env-file-if-exists=.env 运行）——拒绝空跑真实模型。');
    return 2;
  }
  mkdirSync(parsed.out, { recursive: true });
  const meter = createBudgetMeter({ maxModelCalls: parsed.maxModelCalls, maxTokens: parsed.maxTokens, wallMs: parsed.wallMs });
  const startedAt = new Date().toISOString();
  const samples: SampleEvidence[] = [];
  let hardStop: string | null = null;

  for (const armId of parsed.arms) {
    const arm = ARMS[armId];
    for (let sample = 1; sample <= parsed.samples; sample += 1) {
      if (meter.reached() !== null) { hardStop = meter.reached(); break; }
      console.log(`[${arm.id} s${sample}] 开始`);
      const evidence = await runSample({ arm, sample, root: parsed.out, meter });
      samples.push(evidence);
      const reading = readSample(evidence);
      console.log(`[${arm.id} s${sample}] turns=${reading.turns} calls=${reading.modelCalls} empty=${reading.emptyReplies} compactions=${reading.compactionCommits} summaryFail=${reading.summaryFailures} overflow=${reading.overflowCalls} facts=${reading.factPassed}/${reading.factProbes} tokens=${reading.tokens} wall=${reading.wallMs}ms${evidence.error === null ? '' : ` error=${evidence.error}`}`);
      writeFileSync(path.join(parsed.out, 'evidence.json'), JSON.stringify({ startedAt, hardStop, meter: { modelCalls: meter.modelCalls, tokens: meter.tokens }, samples }, null, 2));
      if (meter.reached() !== null) { hardStop = meter.reached(); break; }
    }
    if (meter.reached() !== null) break;
  }

  const endedAt = new Date().toISOString();
  const budget = { ...DEFAULT_BUDGET, samplesPerArm: parsed.samples };
  return emitResults({
    out: parsed.out,
    samples,
    startedAt,
    endedAt,
    hardStop,
    budget,
    meter: { modelCalls: meter.modelCalls, tokens: meter.tokens, wallMs: Date.now() - meter.startedAt, tripped: meter.tripped },
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main, selftest };
