#!/usr/bin/env node
/**
 * SimCase · A/B 两臂真实跑批入口（Main 技能面开关；同模型 / 同 fixture / 同用例 /
 * 同 Oracle / 同预算 / 同并发）。
 *
 * 复用：每臂一次 `./run` 的 `runSimSuite`（批次、样本级并发 5、逐 trial 独立目录、
 * 五类终态、Oracle 判定全部复用）——**不新建跑批器**；`./arms` 只负责每臂配置物化、
 * 装配探针与 `arm` 标签。
 *
 * 批次策略 = **分两批**（A 臂一次、B 臂一次，串行）。理由：
 *   · 同批混跑要把 arm 塞进 `./run` 的样本展开与汇总/终态口径，等于改判定路径；
 *   · 分两批时两臂各自跑同一套 `runSimSuite`，输入对象（cases/oracles/simulator/预算）
 *     完全相同，唯一差异是 `createSystem` 的 profile；每批并发仍为 5；
 *   · 逐臂独立 outRoot（含 session/state.db/evidence），互不共享目录，便于逐臂复核。
 *
 * 纪律（同 run-real）：429/限流不自动重试；失败样本全留不筛绿；模拟用户与系统分开记账；
 * 两臂 `pass` 只由 Oracle 决定，本入口不得改判。
 *
 * 用法（仓库根）：
 *   TMPDIR=/tmp/sim-eval-tmp node --env-file-if-exists=.env --import tsx scripts/eval/sim/run-arms.ts
 * 选样：`SIM_CASES_ONLY`（逗号分隔用例 id），样本硬停见 `./selection`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_CASE_ORACLES, SIM_READ_CASES } from './cases';
import type { SimCase } from './case';
import {
  createArmAskRuntimeSystem, probeArmPair, runSimArmSuite, SIM_ARM_IDS, SIM_ARMS,
  type SimArm, type SimArmProbe, type SimArmSuiteResult, type SimArmTrialResult,
} from './arms';
import type { AskRuntimeSystem } from './ask-adapter';
import { SIM_ATTRIBUTION_EXPECTATIONS } from './attribution-expectations';
import { buildArmAttributionTable, renderArmAttributionTable } from './attribution';
import { createChatModel } from './real-model';
import { assertSampleCap, selectSimCases } from './selection';
import type { SimModel } from './simulator';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_ROOT_BASE = path.join(REPO_ROOT, '.runtime', process.env.SIM_RUN_ROOT ?? 'sim-arms');
/** 每臂并发（与 `./run` 缺省一致，且 ≤ batch 硬上限 8）。 */
const CONCURRENCY = 5;
/** 单臂安全停（墙钟，只停跑批，不作任何注入锚点）。 */
const ARM_WALL_MS = 45 * 60_000;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface ArmRun {
  readonly result: SimArmSuiteResult;
  readonly wallMs: number;
}

function trialsOf(arm: SimArmSuiteResult, caseId: string): readonly SimArmTrialResult[] {
  return arm.trials.filter((trial) => trial.caseId === caseId).sort((a, b) => a.trial - b.trial);
}

function terminalsOf(trials: readonly SimArmTrialResult[]): Record<string, number> {
  const terminals: Record<string, number> = {};
  for (const trial of trials) {
    const key = trial.terminal ?? 'harness_error';
    terminals[key] = (terminals[key] ?? 0) + 1;
  }
  return terminals;
}

function trialLine(trial: SimArmTrialResult): string {
  const checks = trial.oracle?.verdict.detail['checks'];
  const checksText = checks !== null && typeof checks === 'object'
    ? Object.entries(checks as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`).join(', ')
    : '';
  const parts = [
    `- trial ${trial.trial}: terminal=${trial.terminal ?? 'null'} pass=${trial.pass}`,
    `oracle=${trial.oracle?.id ?? 'null'}`,
    `用户消息=${trial.messages.filter((message) => message.action === 'say').length}`,
    `simulator calls=${trial.accounting.byKind.simulator.calls}`,
    `系统 calls=${trial.accounting.byKind.main.calls}`,
  ];
  if (trial.exhaustedBy !== null) parts.push(`耗尽=${trial.exhaustedBy}`);
  if (trial.protocol !== undefined) parts.push(`协议修复=${trial.protocol.repairs}`);
  if (trial.error !== undefined) parts.push(`error=${trial.error}`);
  if (checksText !== '') parts.push(`checks: ${checksText}`);
  return parts.join(' · ');
}

function buildReport(input: {
  readonly runId: string;
  readonly outRoot: string;
  readonly model: string;
  readonly cases: readonly SimCase[];
  readonly probes: { readonly a: SimArmProbe; readonly b: SimArmProbe };
  readonly runs: Readonly<Record<SimArm, ArmRun>>;
}): string {
  const { runId, outRoot, model, cases, probes, runs } = input;
  const lines: string[] = [];
  lines.push(`# SimCase A/B 两臂报告 · ${runId}`, '');
  lines.push(`- 被测系统模型: \`${model}\`（生产同源装配 + 仓内 dummy 执行层）`);
  lines.push(`- 模拟用户模型: \`${model}\`（两臂同一个模拟用户客户端实例，\`kind: simulator\` 独立记账）`);
  lines.push(`- 判官: 未启用（${SIM_CASE_ORACLES.length} 个确定性 Oracle；两臂同一注册表）`);
  lines.push(`- 用例: ${cases.map((caseDef) => `${caseDef.id}（trials=${caseDef.limits.trials}）`).join('、')}`);
  lines.push(`- 预算: 用例自带 limits（两臂同一 SimCase 对象）；并发每批 ${CONCURRENCY}`);
  lines.push(`- 批次策略: **分两批**（逐臂一次 \`runSimSuite\`，串行）。理由见文件头：同批混跑会改 \`./run\` 的样本展开与终态口径；分两批复用同一批次机制，唯一差异是每臂装配参数 \`mainSkillsDir\`。`);
  lines.push(`- 输出: \`${path.relative(REPO_ROOT, outRoot)}\``, '');
  lines.push('## 1. 两臂差异（装配探针，零模型）', '');
  lines.push('| 臂 | mainSkillsDir | catalog 字节 | 技能块字节 | catalog 技能 | read_skill 注册 | Main 工具面 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const probe of [probes.a, probes.b]) {
    lines.push(`| ${probe.arm} | \`${probe.delivery.mainSkillsDir}\` | ${probe.delivery.catalogBytes} | ${probe.delivery.promptBlockBytes} | ${probe.delivery.catalogSkillNames.join('、') || '（空）'} | ${probe.readSkillToolRegistered ? '是' : '否'} | ${probe.tools.join('、')} |`);
  }
  lines.push('', '装配探针走生产同源 `assembleSessionCore`（配置 → `loadMainSkillDelivery(mainSkillsDir)` → `createSession`），并断言：A catalog/技能块为空且无 read_skill；B catalog 含 `finance-business-basics` 且 read_skill 注册；B 的系统提示去掉技能块后逐字等于 A，工具面只差 `read_skill`。', '');
  lines.push('## 2. 每臂读数', '');
  lines.push('| 臂 | 样本 | 通过 | 有效样本 | 终态 | 并发 | 实际最大并发 | 墙钟 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of SIM_ARM_IDS) {
    const run = runs[arm];
    const summary = run.result.summary;
    lines.push(`| ${arm} | ${summary.n} | ${summary.passed} | ${summary.effectiveSamples} | ${JSON.stringify(summary.byTerminal)} | ${CONCURRENCY} | ${run.result.batch.observedMaxConcurrency} | ${(run.wallMs / 1000).toFixed(1)}s |`);
  }
  lines.push('', `**口径**：\`pass\` = 终态 \`satisfied\` **且** Oracle 判真值通过；gave_up / budget_exhausted / contaminated / protocol_error 永不算通过；有效样本 = 总数 − protocol_error。`, '');
  // 两维失败归因（只解释）：技能链路四项 × 业务链路五项，按臂计数；pass 原样来自 Oracle。
  const attributionTable = buildArmAttributionTable(
    SIM_ARM_IDS.map((arm) => ({ arm, trials: runs[arm].result.trials })),
    SIM_ATTRIBUTION_EXPECTATIONS,
  );
  lines.push('## 3. 两维失败归因（按臂计数；只解释，不改 pass）', '');
  lines.push(renderArmAttributionTable(attributionTable), '');
  lines.push('## 4. 逐用例两臂对照（pass^k，k=该用例 trials 数）', '');
  lines.push('| 用例 | A pass | A 终态 | B pass | B 终态 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const caseDef of cases) {
    const a = trialsOf(runs.A.result, caseDef.id);
    const b = trialsOf(runs.B.result, caseDef.id);
    const passText = (trials: readonly SimArmTrialResult[]): string =>
      `${trials.filter((trial) => trial.pass).length}/${trials.length}`;
    lines.push(`| ${caseDef.id} | ${passText(a)} | ${JSON.stringify(terminalsOf(a))} | ${passText(b)} | ${JSON.stringify(terminalsOf(b))} |`);
  }
  lines.push('', '## 5. 逐 trial 明细（两臂分开）', '');
  for (const arm of SIM_ARM_IDS) {
    lines.push(`### 臂 ${arm} · ${SIM_ARMS[arm].label}`, '');
    for (const caseDef of cases) {
      const trials = trialsOf(runs[arm].result, caseDef.id);
      if (trials.length === 0) continue;
      lines.push(`#### ${caseDef.id}`, '');
      for (const trial of trials) lines.push(trialLine(trial));
      lines.push('');
    }
  }
  lines.push('## 6. 结论', '');
  for (const arm of SIM_ARM_IDS) {
    const summary = runs[arm].result.summary;
    lines.push(`- 臂 ${arm}：${summary.n} 条全留（不筛绿）；通过 ${summary.passed}；有效样本 ${summary.effectiveSamples}；终态 ${JSON.stringify(summary.byTerminal)}。`);
  }
  lines.push('- 两臂判据完全相同：`pass` 只由 Oracle 决定；本入口不比较、不补判、不改判。技能是否有效需按预注册判据另行裁定。', '');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const baseUrl = (process.env.LLM_API_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY ?? '';
  const model = process.env.LLM_MODEL ?? 'step-3.7-flash';
  if (baseUrl === '' || apiKey === '') {
    throw new Error('缺少 LLM_API_BASE_URL / LLM_API_KEY（用 --env-file-if-exists=.env 运行）');
  }

  const runId = stamp();
  const selectedCases = selectSimCases(SIM_READ_CASES, process.env['SIM_CASES_ONLY']);
  assertSampleCap(selectedCases);
  const outRoot = path.join(OUT_ROOT_BASE, `run-${runId}`);
  mkdirSync(outRoot, { recursive: true });

  // 预注册：任何模型请求前落盘（两臂 / 用例 / 预算 / 并发 / 批次策略）。
  writeFileSync(path.join(outRoot, 'prereg.md'), [
    `# A/B 两臂预注册 · ${runId}`, '',
    `- 模型: ${model}`,
    `- 用例: ${selectedCases.map((caseDef) => caseDef.id).join('、')}`,
    `- 臂 A: ${SIM_ARMS.A.label}`,
    `- 臂 B: ${SIM_ARMS.B.label}（mainSkillsDir = 仓库 .agents/skills）`,
    `- 并发: 每批 ${CONCURRENCY}；批次策略：分两批（逐臂一次 runSimSuite）`,
    `- 预算: 用例 limits（两臂同一对象）`,
    `- 判据: pass 只由 Oracle 决定；失败样本全留，不筛绿`,
    '',
  ].join('\n'), 'utf8');

  // 装配探针先于任何模型请求：两臂除技能外必须逐字一致，否则不烧样本。
  const probes = await probeArmPair(path.join(outRoot, 'probe'), process.env);

  // 模拟用户：两臂共用同一模型配置（同一个实例；串行跑批，无并发争用）。
  const simulator: SimModel = createChatModel({ baseUrl, apiKey, model, label: 'simulator', timeoutMs: 120_000 });

  const systems = new Map<string, AskRuntimeSystem>();
  const runs = {} as Record<SimArm, ArmRun>;
  try {
    for (const arm of SIM_ARM_IDS) {
      const armRoot = path.join(outRoot, `arm-${arm}`);
      const startedAt = Date.now();
      const suitePromise = runSimArmSuite({
        arm,
        outRoot: armRoot,
        cases: selectedCases,
        concurrency: CONCURRENCY,
        oracles: SIM_CASE_ORACLES,
        simulator,
        probe: arm === 'A' ? probes.a : probes.b,
        env: process.env,
        createSystem: async (paths, caseDef) => {
          const system = await createArmAskRuntimeSystem({
            arm,
            runtimeDir: paths.root,
            sessionId: `sim-${arm}-${caseDef.id}-${paths.root.split(path.sep).slice(-2).join('-')}`,
            env: process.env,
            mainSkillsDir: (arm === 'A' ? probes.a : probes.b).delivery.mainSkillsDir,
          });
          systems.set(`${arm}:${caseDef.id}#${paths.root}`, system);
          return system;
        },
      });
      let wallTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(new Error(`臂 ${arm} 墙钟上限 ${ARM_WALL_MS}ms 触发`)), ARM_WALL_MS);
      });
      try {
        runs[arm] = { result: await Promise.race([suitePromise, timeout]), wallMs: Date.now() - startedAt };
      } finally {
        if (wallTimer !== undefined) clearTimeout(wallTimer);
      }
    }
  } finally {
    for (const system of systems.values()) {
      try {
        system.close();
      } catch {
        // 收尾失败不影响已落盘证据。
      }
    }
  }

  const report = buildReport({ runId, outRoot, model, cases: selectedCases, probes, runs });
  writeFileSync(path.join(outRoot, 'report.md'), report, 'utf8');
  const probeSummary = (probe: SimArmProbe) => ({
    tools: probe.tools,
    readSkillToolRegistered: probe.readSkillToolRegistered,
    delivery: {
      mainSkillsDir: probe.delivery.mainSkillsDir,
      catalogBytes: probe.delivery.catalogBytes,
      promptBlockBytes: probe.delivery.promptBlockBytes,
      catalogSkillNames: probe.delivery.catalogSkillNames,
      registryRegistered: probe.delivery.registryRegistered,
    },
  });
  const attributionTable = buildArmAttributionTable(
    SIM_ARM_IDS.map((arm) => ({ arm, trials: runs[arm].result.trials })),
    SIM_ATTRIBUTION_EXPECTATIONS,
  );
  const summary = {
    runId,
    model,
    concurrency: CONCURRENCY,
    batchStrategy: 'two-batches-one-per-arm',
    cases: selectedCases.map((caseDef) => caseDef.id),
    probes: { A: probeSummary(probes.a), B: probeSummary(probes.b) },
    // 两维失败归因：只解释；pass 原样来自各臂 Oracle 判定（passUnchanged 须为 true）。
    attribution: {
      rules: attributionTable.rules,
      passUnchanged: attributionTable.passUnchanged,
      arms: attributionTable.arms,
    },
    arms: Object.fromEntries(SIM_ARM_IDS.map((arm) => [arm, {
      spec: runs[arm].result.spec,
      wallMs: runs[arm].wallMs,
      n: runs[arm].result.summary.n,
      passed: runs[arm].result.summary.passed,
      effectiveSamples: runs[arm].result.summary.effectiveSamples,
      byTerminal: runs[arm].result.summary.byTerminal,
      isolation: runs[arm].result.summary.isolation,
      observedMaxConcurrency: runs[arm].result.batch.observedMaxConcurrency,
      trials: runs[arm].result.trials.map((trial) => ({
        arm: trial.arm,
        caseId: trial.caseId,
        trial: trial.trial,
        terminal: trial.terminal,
        pass: trial.pass,
        exhaustedBy: trial.exhaustedBy,
        oracle: trial.oracle,
        error: trial.error ?? null,
        protocol: trial.protocol ?? null,
        replies: trial.replies,
        actions: trial.messages.map((message) => ({
          action: message.action,
          text: message.text ?? null,
          reason: message.reason ?? null,
        })),
        accounting: trial.accounting,
      })),
    }])),
  };
  writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(outRoot, 'attribution.json'), JSON.stringify(attributionTable, null, 2) + '\n', 'utf8');
  console.log(report);
  console.log(`\nREPORT ${path.join(outRoot, 'report.md')}`);
  console.log(`SUMMARY ${path.join(outRoot, 'summary.json')}`);
  console.log(`ATTRIBUTION ${path.join(outRoot, 'attribution.json')}`);
}

main().catch((error) => {
  console.error('SIM A/B 两臂跑批失败：', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
