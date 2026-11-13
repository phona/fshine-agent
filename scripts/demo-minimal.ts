/**
 * Minimal Rewrite M1 最小演示入口（`npm run demo:minimal [-- --trials=1]`）：
 * 用户 → Pi Main →（必要时）Pi Worker → Execution Contract（结构化请求）→ 仓内 dummy 执行层
 * → 状态与结果回到 Main → 交付用户。本轮只做读路径。
 *
 * · 执行层 = scripts/eval/fixtures/dummy-platform（仓内夹具，不触网、不碰真实平台）；
 *   每次调用都是真实子进程（bin/dummy），审计行由夹具自己落 `<state>/audit.jsonl`。
 * · 装配入口只依赖最小运行时与执行契约；不经过 V0 的 runtime / plan-runtime / serve-gate /
 *   handler 等治理模块（import 图由 packages/agent/minimal-import-boundary.test.ts 静态检查）。
 * · 读路径作用域：允许集合从执行层自述的 access=read 派生；集合外 operation 在通用运行时
 *   里于发起执行前被拒（不依赖模型遵守提示词）。
 * · 任务底账走 SQLite（`.runtime/minimal/state.db`，B 类持久化）：跨进程仍在，归属校验
 *   跨重启仍成立（实现与表见 packages/core/src/minimal-task-store.ts）。
 * · 产物落 `.runtime/minimal/trial-N/`：turns.jsonl（逐轮事实）/ requests.jsonl（结构化请求）
 *   / transcript.md / state/audit.jsonl（执行层审计）。失败样本同样保留，不重跑掩盖。
 * · V0 的 `npm run demo` 保持原样（回退点）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { applyExecutorLabel, loadAgentProfile } from '../packages/agent/src/agent-profile';
import { createPiTurnDriver } from '../packages/agent/src/pi-driver';
import { createDummyCliClient, readOnlyOperationNames } from '../packages/agent/src/minimal/dummy-cli-client';
import { MAIN_PROTOCOL_NOTE, createMinimalSession } from '../packages/agent/src/minimal/execution-runtime';
import { createSqliteTaskRegistry } from '../packages/agent/src/minimal/task-registry-sqlite';
import { loadWorkerSkills } from '../packages/agent/src/minimal/worker-skills';
import { assessEvalIsolation, assertEvalIsolation } from './eval/safety-gate';
import { materializeEvalConfig } from './resolve-config-path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEMO_CONFIG = path.join(REPO_ROOT, 'config', 'agent.demo.yaml');
const MINIMAL_ROOT = path.join(REPO_ROOT, '.runtime', 'minimal');
const CONFIG_COPY = path.join(MINIMAL_ROOT, 'agent-config.yaml');

/** 冻结语料（读路径两轮；不得为跑绿改写）。 */
const TURNS: readonly string[] = [
  '帮我查一下执行层里 documents 这个集合、窗口 W202611 的数据，把查到的内容如实汇总给我。',
  '再把 documents 集合、窗口 W202610 的数据也查一遍，并和刚才那个窗口对比一下。',
];

/**
 * 执行层治理变量（已删除的部署开关残留）：demo:minimal 进程环境里一律清掉——
 * 本路径只允许配置声明的 dummy 夹具，也不允许任何环境变量把计划门/执行器改道。
 */
const EXECUTION_GOVERNANCE_VARS = [
  'EXECUTION_EXECUTOR',
  'EXECUTION_REQUIRE_PLAN',
  'EXECUTION_PLAN_ID',
  'DZ_EXECUTOR',
  'DZ_ALLOW_REAL',
  'FSHINE_REAL_COMMIT',
] as const;

interface ProfileConfig {
  root?: string;
  gateway?: string;
  skillRoots?: string[];
  executorLabel?: string;
}

interface MinimalConfig {
  principals?: Record<string, unknown>;
  contextProfiles?: Record<string, ProfileConfig>;
}

interface ExecutionFact {
  taskId: string;
  requestId: string;
  operation: string;
  status: string;
  error?: unknown;
}

interface TurnReport {
  index: number;
  text: string;
  reply: string;
  error: string | null;
  durationMs: number;
  progress: readonly string[];
  taskIds: readonly string[];
  executions: ExecutionFact[];
  auditRows: number;
  auditLines: string[];
}

interface TrialReport {
  trial: number;
  startedAt: string;
  totalMs: number;
  sessionId: string;
  turns: TurnReport[];
  passed: boolean;
  fatalError: string | null;
}

interface TrialInput {
  principalId: string;
  platformRoot: string;
  gateway: string;
  skillRoots: readonly string[];
  executorLabel?: string;
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function rel(target: string): string {
  return path.relative(REPO_ROOT, target);
}

async function runTrial(trial: number, input: TrialInput): Promise<TrialReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const trialDir = path.join(MINIMAL_ROOT, `trial-${trial}`);
  const stateDir = path.join(trialDir, 'state');
  const auditPath = path.join(stateDir, 'audit.jsonl');
  const sessionId = `minimal-${new Date().toISOString().slice(0, 10)}-trial-${trial}`;
  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of EXECUTION_GOVERNANCE_VARS) {
    delete env[key];
    delete process.env[key];
  }
  env['EXECUTION_AUDIT_PATH'] = auditPath;
  process.env['EXECUTION_AUDIT_PATH'] = auditPath;

  const reports: TurnReport[] = [];
  let fatalError: string | null = null;
  // B 类持久化：任务底账落 SQLite（缺省 .runtime/minimal/state.db）；本轮收尾关库。
  const taskRegistry = createSqliteTaskRegistry(path.join(MINIMAL_ROOT, 'state.db'));

  try {
    // fail-closed 隔离门：活跃 profile 必须在仓内夹具目录、网关可达、审计通道可写读。
    assertEvalIsolation(assessEvalIsolation({
      env,
      platformRoot: input.platformRoot,
      gateway: input.gateway,
    }), 'demo:minimal（最小切片演示）');

    const client = createDummyCliClient({
      root: input.platformRoot,
      gateway: input.gateway,
      stateDir,
      env,
    });
    const operations = await client.listOperations();
    const allowedOperations = readOnlyOperationNames(operations);
    if (allowedOperations.length === 0) {
      throw new Error('执行层没有声明任何只读 operation——最小切片拒绝以空允许集合运行。');
    }
    const profile = await loadAgentProfile();
    const workerSkills = await loadWorkerSkills(input.platformRoot, input.skillRoots);
    const session = await createMinimalSession({
      principalId: input.principalId,
      sessionId,
      client,
      allowedOperations,
      mainDriver: createPiTurnDriver({ env }),
      workerDriver: createPiTurnDriver({ env }),
      mainSystemPrompt: `${applyExecutorLabel(profile.instructions, input.executorLabel)}\n\n${MAIN_PROTOCOL_NOTE}`,
      workerSkills,
      taskRegistry,
    });

    for (const [index, text] of TURNS.entries()) {
      const turnLabel = `第 ${index + 1} 轮`;
      console.log(`\n===== [trial-${trial}] ${turnLabel} · 用户 =====\n${text}`);
      const auditBefore = readLines(auditPath).length;
      const startedTurn = Date.now();
      let turn: Awaited<ReturnType<typeof session.send>> | null = null;
      let turnError: string | null = null;
      try {
        turn = await session.send(text);
      } catch (error) {
        turnError = error instanceof Error ? error.message : String(error);
      }
      const durationMs = Date.now() - startedTurn;
      const auditLines = readLines(auditPath).slice(auditBefore);
      const taskIds = turn?.taskIds ?? [];
      const tasks = session.tasks().filter((task) => taskIds.includes(task.taskId));
      const executions: ExecutionFact[] = tasks.flatMap((task) => task.executions.map((execution) => ({
        taskId: task.taskId,
        requestId: execution.requestId,
        operation: execution.operation,
        status: execution.status,
        ...(execution.error !== undefined ? { error: execution.error } : {}),
      })));
      const report: TurnReport = {
        index: index + 1,
        text,
        reply: turn?.reply ?? '',
        error: turnError,
        durationMs,
        progress: turn?.progress ?? [],
        taskIds,
        executions,
        auditRows: auditLines.length,
        auditLines,
      };
      reports.push(report);

      console.log(`\n===== [trial-${trial}] ${turnLabel} · 回复 =====\n${report.error !== null ? `（回合失败：${report.error}）` : report.reply}`);
      console.log(
        `\n===== [trial-${trial}] ${turnLabel} · 机械证据 =====\n`
        + `taskId=${taskIds[0] ?? '（无委派）'} 委派=${taskIds.length > 0 ? '是' : '否'} `
        + `结构化执行=${executions.length} 次（完成 ${executions.filter((fact) => fact.status === 'completed').length}） `
        + `dummy 审计=${report.auditRows} 行 用时=${(durationMs / 1000).toFixed(1)}s`,
      );
      for (const fact of executions) {
        console.log(JSON.stringify({ event: 'minimal_execution', ...fact }));
      }
    }

    // ── 落盘：逐轮事实 + 结构化请求 + 人读转录（失败样本同样保留） ──
    writeFileSync(
      path.join(trialDir, 'turns.jsonl'),
      reports.map((report) => JSON.stringify(report)).join('\n') + '\n',
    );
    writeFileSync(
      path.join(trialDir, 'requests.jsonl'),
      reports.flatMap((report) => report.executions.map((fact) => JSON.stringify(fact))).join('\n') + (reports.length > 0 ? '\n' : ''),
    );
    writeFileSync(path.join(trialDir, 'transcript.md'), [
      `# Minimal 切片演示记录 · trial-${trial}（npm run demo:minimal）`,
      '',
      `- 会话：${sessionId} · 用户：${input.principalId}`,
      `- 执行层：${rel(input.platformRoot)}（仓内夹具；原始审计 ${rel(auditPath)}）`,
      '',
      ...reports.flatMap((report) => [
        `## 第 ${report.index} 轮`,
        '',
        `**用户**：${report.text}`,
        '',
        `**回复**：${report.error !== null ? `（回合失败：${report.error}）` : report.reply}`,
        '',
        `**机械证据**：委派 ${report.taskIds.length} 个任务 · 结构化执行 ${report.executions.length} 次 · dummy 审计 ${report.auditRows} 行 · 用时 ${(report.durationMs / 1000).toFixed(1)}s`,
        '',
      ]),
    ].join('\n'));
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    console.error(`[trial-${trial}] 运行失败：${fatalError}`);
  } finally {
    // 本轮结束关库：底账数据已落盘，下一轮/下次进程重开同一库仍可读。
    taskRegistry.close();
  }

  const passed = fatalError === null
    && reports.length === TURNS.length
    && reports.every((report) => (
      report.error === null
      && report.reply.trim() !== ''
      && report.taskIds.length > 0
      && report.executions.length > 0
      && report.executions.every((fact) => fact.status === 'completed')
      && report.auditRows > 0
    ));

  const trialReport: TrialReport = {
    trial,
    startedAt,
    totalMs: Date.now() - startedMs,
    sessionId,
    turns: reports,
    passed,
    fatalError,
  };
  console.log([
    `\n===== [trial-${trial}] 汇总 =====`,
    `- 轮数：${reports.length} · 委派轮数：${reports.filter((report) => report.taskIds.length > 0).length}`
    + ` · 结构化执行合计：${reports.reduce((sum, report) => sum + report.executions.length, 0)} 次`
    + `（dummy 审计合计 ${reports.reduce((sum, report) => sum + report.auditRows, 0)} 行）`,
    `- 产物：${rel(trialDir)}/{turns.jsonl,requests.jsonl,transcript.md,state/audit.jsonl}`,
    `- 运行结论：${passed ? '本轮达标（逐轮有委派、有结构化执行、有真实审计行）' : '未达标——如实记录，不重跑掩盖'}`,
  ].join('\n'));
  return trialReport;
}

function parseTrials(argv: readonly string[]): { trials: number; usageError: boolean } {
  const flag = argv.find((arg) => arg.startsWith('--trials='));
  if (flag === undefined) return { trials: 1, usageError: false };
  const value = Number(flag.slice('--trials='.length));
  if (!Number.isInteger(value) || value < 1 || value > 5) return { trials: 1, usageError: true };
  return { trials: value, usageError: false };
}

async function main(): Promise<void> {
  const { trials, usageError } = parseTrials(process.argv.slice(2));
  if (usageError) {
    console.error('用法：npm run demo:minimal [-- --trials=<1..5>]（缺省 1 次）');
    process.exitCode = 2;
    return;
  }
  if (!process.env['LLM_API_KEY'] || process.env['LLM_API_KEY'].trim() === '') {
    console.error('未检测到 LLM_API_KEY——demo:minimal 需要真实模型（密钥只在 .env）。');
    process.exitCode = 2;
    return;
  }

  rmSync(MINIMAL_ROOT, { recursive: true, force: true });
  mkdirSync(MINIMAL_ROOT, { recursive: true });
  // 配置物化：profile.root 相对路径 → 绝对，副本落 .runtime/minimal（不把主目录写进仓库）。
  const configPath = materializeEvalConfig(DEMO_CONFIG, CONFIG_COPY);
  const config = parseYaml(readFileSync(configPath, 'utf8')) as MinimalConfig;
  const profileIds = Object.keys(config.contextProfiles ?? {});
  if (profileIds.length !== 1) {
    console.error(`demo:minimal 需要单一 contextProfile（当前 ${profileIds.length} 个）——最小切片不做多 profile 选择。`);
    process.exitCode = 2;
    return;
  }
  const profile = config.contextProfiles![profileIds[0]!]!;
  const principalId = Object.keys(config.principals ?? {})[0];
  if (!principalId) {
    console.error('配置里没有 principal——最小切片需要可信身份来源（fail-closed，不回落写死值）。');
    process.exitCode = 2;
    return;
  }
  if (!profile.root || !profile.gateway) {
    console.error('profile 缺少 root 或 gateway——最小切片需要执行层挂载声明。');
    process.exitCode = 2;
    return;
  }

  const effectiveModel = process.env['LLM_MODEL']?.trim() || '(未声明)';
  const results: TrialReport[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    console.log(`\n################ trial-${trial} / ${trials} ################`);
    results.push(await runTrial(trial, {
      principalId,
      platformRoot: profile.root,
      gateway: profile.gateway,
      skillRoots: profile.skillRoots ?? [],
      ...(profile.executorLabel ? { executorLabel: profile.executorLabel } : {}),
    }));
  }

  const passedCount = results.filter((result) => result.passed).length;
  console.log([
    '',
    '===== 全部试用汇总 =====',
    `- 模型：${effectiveModel}（密钥只在 .env，不落盘）`,
    `- 试用次数：${results.length} · 会话 id：${results.map((result) => result.sessionId).join('、')}`,
    `- 总耗时：${(results.reduce((sum, result) => sum + result.totalMs, 0) / 1000).toFixed(1)}s`,
    ...results.map((result) => `- trial-${result.trial}：${result.passed ? '达标' : '未达标'}`
      + `（委派 ${result.turns.filter((turn) => turn.taskIds.length > 0).length} 轮`
      + `，结构化执行 ${result.turns.reduce((sum, turn) => sum + turn.executions.length, 0)} 次`
      + `${result.fatalError !== null ? `，失败：${result.fatalError}` : ''}）`),
  ].join('\n'));

  if (passedCount !== results.length) {
    console.error(`\n最小切片演示未全部达标（${passedCount}/${results.length}）：原始记录保留，不重跑掩盖。`);
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error('demo:minimal 运行失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
