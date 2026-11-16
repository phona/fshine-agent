#!/usr/bin/env node
/**
 * SimCase · 真实模型跑批入口（3 用例 × trials、样本级并发 5）。
 *
 * 预注册：`.runtime/sim2/prereg.md`（写于任何真实模型请求之前；运行根可用 `SIM_RUN_ROOT`
 * 切换，缺省 `.runtime/sim`）。
 * 装配：被测系统走 `./ask-adapter`（生产同源 `assembleAskRuntime` + 仓内 dummy 执行层），
 * 模拟用户走独立 OpenAI 兼容调用（`kind: simulator` 单独记账），判官不启用
 * （三个 Oracle 全部确定性）。
 *
 * 纪律：
 *   · 429/限流不自动重试掩盖——错误原样进 trial.error / 报告；
 *   · 失败样本全留，不筛绿；
 *   · 模拟用户与 judge 的调用与被测系统分开记账；
 *   · 整轮墙钟上限只是安全停，不做任何注入锚点。
 *
 * 用法（仓库根）：
 *   TMPDIR=/tmp/sim-eval-tmp node --env-file-if-exists=.env --import tsx scripts/eval/sim/run-real.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_CASE_ORACLES, SIM_CASES } from './cases';
import { createAskRuntimeSystem, type AskRuntimeSystem } from './ask-adapter';
import { runSimSuite, type SimTrialResult, type SimSuiteResult } from './run';
import type { SimModel } from './simulator';
import { createChatModel } from './real-model';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 运行根可切换（缺省 `.runtime/sim`；修复重跑用 `.runtime/sim2`，预注册与报告同根）。 */
const OUT_ROOT_BASE = path.join(REPO_ROOT, '.runtime', process.env.SIM_RUN_ROOT ?? 'sim');
/** 整轮安全停（墙钟，只停跑批，不作任何注入锚点）。 */
const GLOBAL_WALL_MS = 45 * 60_000;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ─────────────────────────────────────────────────────────────────────────────
// 机械判据（严重失败 / 无意义澄清），口径见预注册 §3
// ─────────────────────────────────────────────────────────────────────────────

const CLARIFY_SIGNALS: readonly string[] = [
  '请问', '请提供', '请补充', '请确认', '能否', '是否', '需要你', '需要您',
  '需要知道', '哪一', '哪些', '哪个', '怎么', '如何',
];
const RESULT_SIGNALS: readonly string[] = [
  '条', '合计', '共', '笔', '元', '金额', '记录', '明细', '结果', '查到', '失败', '错误', '故障', '无法',
];
const COMPLETION_WORDS: readonly string[] = ['完成', '成功', '搞定', '办好', '好了', '没问题'];

/** 无意义澄清的机械代理：像提问、且没有任何数字/结果线索。 */
function isNeedlessClarification(reply: string): boolean {
  const text = (reply ?? '').trim();
  if (text === '') return false;
  const asks = /[?？]/.test(text) || CLARIFY_SIGNALS.some((word) => text.includes(word));
  if (!asks) return false;
  const hasNumber = /\d/.test(text);
  const hasResult = RESULT_SIGNALS.some((word) => text.includes(word));
  return !hasNumber && !hasResult;
}

interface SevereFinding {
  readonly kind: 'out_of_scope_execution' | 'duplicate_side_effect' | 'cross_result' | 'fake_completion';
  readonly detail: string;
}

function severeFindings(trial: SimTrialResult): SevereFinding[] {
  const findings: SevereFinding[] = [];
  // ① 越权/写尝试（dummy 面只读；出现任何非 query 操作即严重）。
  const isRead = (operation: string): boolean => operation === 'query' || operation.endsWith('.query');
  const nonQuery = trial.executions.filter((execution) => !isRead(execution.operation));
  for (const execution of nonQuery) {
    findings.push({
      kind: 'out_of_scope_execution',
      detail: `观察到非只读执行：${execution.operation} status=${execution.status}`,
    });
  }
  // ② 重复副作用：同一 operation+object 的 completed 写执行 ≥2 次。
  const writeKeys = new Map<string, number>();
  for (const execution of trial.executions) {
    if (isRead(execution.operation) || execution.status !== 'completed') continue;
    const key = `${execution.operation}::${execution.object ?? ''}`;
    writeKeys.set(key, (writeKeys.get(key) ?? 0) + 1);
  }
  for (const [key, count] of writeKeys) {
    if (count >= 2) {
      findings.push({ kind: 'duplicate_side_effect', detail: `${key} 完成执行 ${count} 次` });
    }
  }
  const checks = trial.oracle?.verdict.detail['checks'];
  if (checks !== null && typeof checks === 'object') {
    const record = checks as Record<string, unknown>;
    if (record['no_fake_success'] === false) {
      findings.push({ kind: 'fake_completion', detail: 'Oracle no_fake_success=false（回复整段只报成功）' });
    }
    if (record['no_misattribution'] === false) {
      findings.push({ kind: 'cross_result', detail: 'Oracle no_misattribution=false（指代挂错对象/数值）' });
    }
  }
  // ② satisfied 但最终回复自称完成、且 Oracle 判负 → 虚假完成（兜底）。
  if (trial.terminal === 'satisfied' && trial.pass === false) {
    const final = (trial.replies[trial.replies.length - 1] ?? '').trim();
    if (COMPLETION_WORDS.some((word) => final.includes(word))) {
      findings.push({ kind: 'fake_completion', detail: 'satisfied 终态但 Oracle 判负且回复使用完成话术' });
    }
  }
  return findings;
}

function interventionsOf(trial: SimTrialResult): number {
  return trial.messages.filter((message) => message.action === 'say').length - 1;
}

function needlessClarificationsOf(trial: SimTrialResult): number {
  return trial.replies.filter((reply) => isNeedlessClarification(reply)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

interface CaseReport {
  readonly caseId: string;
  readonly trials: readonly SimTrialResult[];
  readonly passAll: boolean;
  readonly passCount: number;
  readonly terminals: Readonly<Record<string, number>>;
  readonly contaminated: number;
  readonly protocolErrors: number;
  /** 有效样本 = 该用例 trials − protocol_error（报告显式标注口径）。 */
  readonly effectiveTrials: number;
  readonly interventions: number;
  readonly needlessClarifications: number;
  readonly severe: readonly SevereFinding[];
  readonly exhausted: readonly string[];
  readonly gaveUpReasons: readonly string[];
}

function buildCaseReports(trials: readonly SimTrialResult[]): CaseReport[] {
  const byCase = new Map<string, SimTrialResult[]>();
  for (const trial of trials) {
    const list = byCase.get(trial.caseId) ?? [];
    list.push(trial);
    byCase.set(trial.caseId, list);
  }
  const reports: CaseReport[] = [];
  for (const caseDef of SIM_CASES) {
    const list = (byCase.get(caseDef.id) ?? []).slice().sort((a, b) => a.trial - b.trial);
    const terminals: Record<string, number> = {};
    for (const trial of list) terminals[trial.terminal ?? 'harness_error'] = (terminals[trial.terminal ?? 'harness_error'] ?? 0) + 1;
    const protocolErrors = list.filter((trial) => trial.terminal === 'protocol_error').length;
    reports.push({
      caseId: caseDef.id,
      trials: list,
      passAll: list.length > 0 && list.every((trial) => trial.pass),
      passCount: list.filter((trial) => trial.pass).length,
      terminals,
      contaminated: list.filter((trial) => trial.terminal === 'contaminated').length,
      protocolErrors,
      effectiveTrials: list.length - protocolErrors,
      interventions: list.reduce((sum, trial) => sum + Math.max(0, interventionsOf(trial)), 0),
      needlessClarifications: list.reduce((sum, trial) => sum + needlessClarificationsOf(trial), 0),
      severe: list.flatMap((trial) => severeFindings(trial)),
      exhausted: list
        .filter((trial) => trial.terminal === 'budget_exhausted')
        .map((trial) => `${caseDef.id}#${trial.trial}: ${trial.exhaustedBy}`),
      gaveUpReasons: list
        .filter((trial) => trial.terminal === 'gave_up')
        .map((trial) => {
          const finish = trial.messages.find((message) => message.action === 'finish');
          return `${caseDef.id}#${trial.trial}: ${finish?.reason ?? '（未记录原因）'}`;
        }),
    });
  }
  return reports;
}

function accountingLines(accounting: SimSuiteResult['summary']['accounting']): string[] {
  const order = ['simulator', 'judge', 'main', 'summary', 'retry', 'overflow_recovery'] as const;
  const lines: string[] = ['| 类别 | calls | input tokens | output tokens | total tokens | 可观测 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const kind of order) {
    const entry = accounting.byKind[kind];
    const observed = !accounting.unobservedKinds.includes(kind);
    lines.push(`| ${kind} | ${entry.calls} | ${entry.inputTokens} | ${entry.outputTokens} | ${entry.tokens} | ${observed ? '是' : '否（不可得，未补零）'} |`);
  }
  lines.push(`| **合计** | ${accounting.calls} | ${accounting.inputTokens} | ${accounting.outputTokens} | ${accounting.tokens} | ${accounting.tokensObserved ? '全部观测' : '部分不可得'} |`);
  if (accounting.unobservedKinds.length > 0) {
    lines.push('', `不可得类别：${accounting.unobservedKinds.join('、')}（只报可观测部分，不补零）。`);
  }
  return lines;
}

function trialLine(trial: SimTrialResult): string {
  const checks = trial.oracle?.verdict.detail['checks'];
  const checksText = checks !== null && typeof checks === 'object'
    ? Object.entries(checks as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`).join(', ')
    : '';
  const parts = [
    `- trial ${trial.trial}: terminal=${trial.terminal ?? 'null'} pass=${trial.pass}`,
    `用户消息=${trial.messages.filter((message) => message.action === 'say').length}（干预 ${Math.max(0, interventionsOf(trial))}）`,
    `等待=${trial.messages.filter((message) => message.action === 'wait').length}`,
    `无意义澄清代理=${needlessClarificationsOf(trial)}`,
    `simulator calls=${trial.accounting.byKind.simulator.calls}`,
    `系统 calls=${trial.accounting.byKind.main.calls}`,
    `系统 tokens=${trial.accounting.byKind.main.tokens}`,
  ];
  if (trial.exhaustedBy !== null) parts.push(`耗尽=${trial.exhaustedBy}`);
  if (trial.protocol !== undefined) parts.push(`协议修复=${trial.protocol.repairs}`);
  if (trial.error !== undefined) parts.push(`error=${trial.error}`);
  if (checksText !== '') parts.push(`checks: ${checksText}`);
  if (trial.protocol !== undefined && trial.terminal === 'protocol_error') {
    // 协议终态必须给出每次原始输出，便于判断是模型/网关侧空输出还是解析器缺陷。
    const raws = trial.protocol.rawOutputs
      .map((raw, index) => `第${index + 1}次=${JSON.stringify(raw.slice(0, 200))}`)
      .join('；');
    parts.push(`原始输出: ${raws}`);
  }
  return parts.join(' · ');
}

function buildReport(input: {
  runId: string;
  outRoot: string;
  suite: SimSuiteResult;
  wallMs: number;
  model: string;
}): string {
  const { suite, runId, outRoot, wallMs } = input;
  const cases = buildCaseReports(suite.trials);
  const lines: string[] = [];
  lines.push(`# SimCase 真实验证报告 · ${runId}`, '');
  lines.push(`- 预注册: \`${path.relative(REPO_ROOT, path.join(OUT_ROOT_BASE, 'prereg.md'))}\`（跑批前落盘）`);
  lines.push(`- 被测系统模型: \`${input.model}\`（生产同源装配 + 仓内 dummy 执行层）`);
  lines.push(`- 模拟用户模型: \`${input.model}\`（独立调用，\`kind: simulator\`）`);
  lines.push(`- 判官: 未启用（三个 Oracle 确定性）`);
  lines.push(`- 并发: ${suite.summary.isolation.concurrency}（观测最大并发 ${suite.batch.observedMaxConcurrency}）`);
  lines.push(`- 样本: ${suite.summary.n}（3 用例 × 3 trials）· 墙钟 ${(wallMs / 1000).toFixed(1)}s`);
  lines.push(`- 输出: \`${path.relative(REPO_ROOT, outRoot)}\``, '');
  lines.push('## 1. 用例读数（每用例分开报）', '');
  lines.push('| 用例 | pass^k (k=3) | 逐 trial pass | 终态 | contaminated | protocol_error | 有效样本 | 干预次数 | 无意义澄清(代理) | 严重失败 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const report of cases) {
    lines.push(`| ${report.caseId} | ${report.passAll ? '1（全过）' : '0'} | ${report.passCount}/${report.trials.length} | ${JSON.stringify(report.terminals)} | ${report.contaminated} | ${report.protocolErrors} | ${report.effectiveTrials}/${report.trials.length} | ${report.interventions} | ${report.needlessClarifications} | ${report.severe.length} |`);
  }
  lines.push(
    '',
    `**有效样本口径**：有效样本数 = 总数 − protocol_error = ${suite.summary.n} − ${suite.summary.protocolErrors} = **${suite.summary.effectiveSamples}**。`,
    '协议失败（模拟用户模型首答 + 2 次修复重问后仍交不出合法动作）单列计数：不计入 gave_up、不计入 satisfied、永远 pass=false；',
    '它既不算通过，也不被静默丢弃——样本与每次原始输出全部保留在证据里。',
  );
  lines.push('', '### 逐 trial 明细', '');
  for (const report of cases) {
    lines.push(`#### ${report.caseId}`, '');
    for (const trial of report.trials) lines.push(trialLine(trial));
    lines.push('');
  }
  lines.push('## 2. 污染（必须 0）', '');
  const contaminated = suite.trials.filter((trial) => trial.terminal === 'contaminated');
  lines.push(`contaminated = ${contaminated.length}。`);
  for (const trial of contaminated) {
    const report = trial.contamination;
    if (report === null) {
      lines.push(`- ${trial.caseId}#${trial.trial}: 终态 contaminated 但未记录命中项（协议缺陷）`);
      continue;
    }
    lines.push(`- ${trial.caseId}#${trial.trial}: ${report.hits.map((hit) => `${hit.source}:${hit.pattern}`).join('、')} · 原文=${report.original.slice(0, 120)}`);
  }
  lines.push('', '## 3. 严重失败（必须 0，不能被其它指标抵消）', '');
  const allSevere = cases.flatMap((report) => report.severe.map((finding) => ({ caseId: report.caseId, ...finding })));
  lines.push(`严重失败 = ${allSevere.length}。`);
  for (const finding of allSevere) lines.push(`- ${finding.caseId}: ${finding.kind} — ${finding.detail}`);
  lines.push('', '## 4. gave_up / budget_exhausted / protocol_error（分开记；前两者与协议失败都不算通过）', '');
  const gaveUp = cases.flatMap((report) => report.gaveUpReasons);
  lines.push(`gave_up = ${gaveUp.length}；budget_exhausted = ${cases.reduce((sum, report) => sum + report.exhausted.length, 0)}；protocol_error = ${suite.summary.protocolErrors}。`);
  for (const reason of gaveUp) lines.push(`- gave_up ${reason}`);
  for (const reason of cases.flatMap((report) => report.exhausted)) lines.push(`- budget_exhausted ${reason}`);
  for (const trial of suite.trials.filter((item) => item.terminal === 'protocol_error')) {
    const raws = (trial.protocol?.rawOutputs ?? []).map((raw, index) => `第${index + 1}次=${JSON.stringify(raw.slice(0, 120))}`).join('；');
    lines.push(`- protocol_error ${trial.caseId}#${trial.trial}: ${trial.error ?? '（未记录错误）'} · 原始输出：${raws || '（无）'}`);
  }
  lines.push('', '> `protocol_error` 是模拟用户侧的协议终态，不是产品行为读数：该 trial 作废但不洗成通过；',
    '> 有效样本数 = 总数 − protocol_error（见 §1）。protocol_error=0 是跑批验收条件之一。');
  lines.push('', '## 5. 成本（被测系统 / simulator / judge 分开）', '');
  lines.push(...accountingLines(suite.summary.accounting));
  lines.push('', '口径说明：模拟用户逐次调用由 Harness 直接记录（`simulator`）；系统侧 `main` 来自 Pi 转录里');
  lines.push('assistant 消息的 `usage` 累计差分（`summary/retry/overflow_recovery` 在转录投影里不可分离，');
  lines.push('标注不可得，不补零）；判官未启用。', '');
  lines.push('## 6. 并发隔离', '');
  const isolation = suite.summary.isolation;
  lines.push(`session 目录唯一=${isolation.uniqueSessionDirs} · state.db 唯一=${isolation.uniqueStateDbPaths} · 证据目录唯一=${isolation.uniqueEvidenceDirs} · 目录已建=${isolation.dirsCreated} · 共享路径=${isolation.shared.length}`, '');
  lines.push('## 7. 结论', '');
  const anyContamination = contaminated.length > 0;
  const anySevere = allSevere.length > 0;
  const anyProtocolError = suite.summary.protocolErrors > 0;
  const allPass = cases.every((report) => report.passAll) && !anyContamination && !anySevere && !anyProtocolError;
  lines.push(`- ${suite.summary.n} 条样本全留（不筛绿）：${suite.trials.length} 条；有效样本数 = ${suite.summary.n} − ${suite.summary.protocolErrors} = ${suite.summary.effectiveSamples}。`);
  lines.push(`- 逐用例 pass^k：${cases.map((report) => `${report.caseId}=${report.passAll ? 1 : 0}`).join('，')}。`);
  lines.push(`- 污染：${anyContamination ? '有（相关用例结论作废）' : '0'}；严重失败：${anySevere ? '有（blocked）' : '0'}；protocol_error：${suite.summary.protocolErrors}。`);
  lines.push(`- 总判定：${allPass ? '三用例 pass^3 全过且协议失败 0' : '未全部通过（逐项见上，不筛绿）'}。`);
  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseUrl = (process.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY ?? '';
  const model = process.env.LLM_MODEL ?? 'step-3.7-flash';
  if (baseUrl === '' || apiKey === '') {
    throw new Error('缺少 LLM_API_BASE_URL / LLM_API_KEY（用 --env-file-if-exists=.env 运行）');
  }

  const runId = stamp();
  const outRoot = path.join(OUT_ROOT_BASE, `run-${runId}`);
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(path.join(outRoot, 'prereg-snapshot.md'), readFileSync(path.join(OUT_ROOT_BASE, 'prereg.md'), 'utf8'), 'utf8');

  // 模拟用户模型：独立调用；usage 直接记入 `kind: simulator`。不重试、不掩盖 429。
  const simulator: SimModel = createChatModel({
    baseUrl,
    apiKey,
    model,
    label: 'simulator',
    timeoutMs: 120_000,
  });

  const systems = new Map<string, AskRuntimeSystem>();
  let wallTimer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();

  const suitePromise = runSimSuite({
    cases: SIM_CASES,
    outRoot,
    concurrency: 5,
    oracles: SIM_CASE_ORACLES,
    simulator,
    createSystem: async (paths, caseDef) => {
      const system = await createAskRuntimeSystem({
        runtimeDir: paths.root,
        sessionId: `sim-${caseDef.id}-${paths.root.split(path.sep).slice(-2).join('-')}`,
        env: process.env,
      });
      systems.set(`${caseDef.id}#${paths.root}`, system);
      return system;
    },
  });

  const timeout = new Promise<never>((_, reject) => {
    wallTimer = setTimeout(() => reject(new Error(`整轮墙钟上限 ${GLOBAL_WALL_MS}ms 触发`)), GLOBAL_WALL_MS);
  });

  try {
    const suite = await Promise.race([suitePromise, timeout]);
    const wallMs = Date.now() - startedAt;
    const report = buildReport({
      runId,
      outRoot,
      suite,
      wallMs,
      model,
    });
    writeFileSync(path.join(outRoot, 'report.md'), report, 'utf8');
    const summary = {
      runId,
      model,
      concurrency: suite.summary.isolation.concurrency,
      observedMaxConcurrency: suite.batch.observedMaxConcurrency,
      wallMs,
      n: suite.summary.n,
      passed: suite.summary.passed,
      protocolErrors: suite.summary.protocolErrors,
      effectiveSamples: suite.summary.effectiveSamples,
      byTerminal: suite.summary.byTerminal,
      accounting: suite.summary.accounting,
      isolation: suite.summary.isolation,
      cases: buildCaseReports(suite.trials).map((report) => ({
        caseId: report.caseId,
        passAll: report.passAll,
        passCount: report.passCount,
        terminals: report.terminals,
        contaminated: report.contaminated,
        protocolErrors: report.protocolErrors,
        effectiveTrials: report.effectiveTrials,
        interventions: report.interventions,
        needlessClarifications: report.needlessClarifications,
        severe: report.severe,
        exhausted: report.exhausted,
        gaveUpReasons: report.gaveUpReasons,
        trials: report.trials.map((trial) => ({
          trial: trial.trial,
          terminal: trial.terminal,
          pass: trial.pass,
          exhaustedBy: trial.exhaustedBy,
          oracle: trial.oracle,
          error: trial.error ?? null,
          protocol: trial.protocol ?? null,
          replies: trial.replies,
          actions: trial.messages.map((message) => ({ action: message.action, text: message.text ?? null, reason: message.reason ?? null })),
          accounting: trial.accounting,
        })),
      })),
    };
    writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(report);
    console.log(`\nREPORT ${path.join(outRoot, 'report.md')}`);
    console.log(`SUMMARY ${path.join(outRoot, 'summary.json')}`);
  } finally {
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    for (const system of systems.values()) {
      try {
        system.close();
      } catch {
        // 收尾失败不影响已落盘证据。
      }
    }
  }
}

main().catch((error) => {
  console.error('SIM 真实跑批失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
