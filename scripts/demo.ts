/**
 * V0 本地试用演示（`npm run demo`）：真实 Main Pi Agent + 真实 Worker Pi Agent + 仓内 dummy
 * 测试平台，四轮业务对话全链留痕。
 *
 * 目标读者是**业务人员视角的可复制路径**，不是评测：
 *   · 执行层 = scripts/eval/fixtures/dummy-platform（仓内夹具，不触网、不碰真实 SaaS）；
 *     每次平台调用都是真实子进程（worker/宿主 spawn `bin/dummy`），审计行由夹具自己写。
 *   · 会话入口 = createAskSession（生产装配黑盒入口，同 apps/server/main.ts 的装配，
 *     不另拼 driver/runtime/计划门）。
 *   · 模型 = .env 的 LLM_*（或 config/agent.demo.yaml 的地址/模型名；密钥只在 .env）。
 *
 * 四轮冻结语料（不得为跑绿而改写——行为四类：委派 / 对比 / 指代纠错 / 交付）：
 *   1) 核对本月单据：应委派到 worker，并识别 `documents` 里同名不同值的重复条目
 *      （document-2 出现两次，800 / 900）；
 *   2) 上月对比：再委派一次（W202610 / W202611）；
 *   3) 指代式纠错/复核：必须引用上文并**重新执行查询**（机械判据 = 本轮又有审计行）；
 *   4) 交付表达：用业务人员看得懂的话汇总两个月。
 *
 * 每次试用（trial）独立起跑：自有 SQLite 库、夹具状态目录、Pi 会话目录，并清空夹具根的
 * worker scratch（`tmp/`——它是相对夹具根的固定路径，不清会让本试用的 worker 读到上一次
 * 试用的 handover）。所有状态都在 `.runtime/demo/trials/trial-N/` 与夹具 `tmp/` 内，
 * 可整体删除、不污染仓库与其它 run。
 * 默认连跑 3 次（`--trials=<n>` 可调）；失败样本同样落盘、不重跑掩盖。
 *
 * 状态目录依据（按实际代码，不沿用过时变量）：
 *   · 夹具 `bin/dummy` 只认 `--state-dir`；它把测试桥变量
 *     `FSHINE_EVAL_FIXTURE_STATE_DIR` 翻译成该 flag（bin/dummy 的 shell 分支）。
 *   · worker 的 bash 工具基境来自 `getShellEnv()`（即宿主进程 process.env，见
 *     pi-coding-agent 的 resolveSpawnContext），宿主侧计划评估子进程同样以
 *     process.env 为基境——因此这里直接写 process.env，再整份传给装配。
 *   · `EXECUTION_AUDIT_PATH` 是**宿主证据读取口**（ask-session/eval 读审计行），夹具
 *     不读它；这里与 `--state-dir` 指向同一份 `audit.jsonl`，两边对齐不产生第二事实源。
 *   · 本脚本不设置 EXECUTION_EXECUTOR 或任何执行层治理变量；执行层只由
 *     config/agent.demo.yaml 的 profile（root + gateway）选择，并由 requireIsolatedFixture
 *     安全门兜底（root 必须在仓内夹具目录、gateway 可达、审计通道可写读）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { AuditStore, PlatformTaskRecord } from '@fshine/contracts';
import { createAskSession, type MessageTurn } from './ask-session';
import { materializeEvalConfig } from './resolve-config-path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEMO_CONFIG = path.join(REPO_ROOT, 'config', 'agent.demo.yaml');
const DEMO_ROOT = path.join(REPO_ROOT, '.runtime', 'demo');
const TRIALS_ROOT = path.join(DEMO_ROOT, 'trials');
const CONFIG_COPY = path.join(DEMO_ROOT, 'agent-config.yaml');
/** 仓内 dummy 夹具根（scratch 清理的安全边界：只允许碰这个目录下的 tmp）。 */
const DEMO_FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');

/**
 * 执行层治理变量（mock 执行器等已删除的部署开关）：demo 进程环境里一律清掉——
 * 本路径只允许 profile 声明的 dummy 夹具，不允许任何环境变量把执行层改道/降级。
 */
const EXECUTION_GOVERNANCE_VARS = [
  'EXECUTION_EXECUTOR',
  'DZ_EXECUTOR',
  'DZ_ALLOW_REAL',
  'FSHINE_REAL_COMMIT',
] as const;

/** 仓内相对路径（打印与落盘用，不泄漏运行机绝对路径）。 */
const rel = (target: string): string => path.relative(REPO_ROOT, target);

/** 四轮自然业务语料（业务诉求，不带集合名/窗口号/期望结论）。冻结，不随运行调整。 */
const TURNS: readonly string[] = [
  '现在是 2026 年 11 月。帮我把这个月的单据全部核对一遍：有同名重复的、金额对不上的，都挑出来告诉我。',
  '上个月（2026 年 10 月）的也按同样的口径全部核一遍，再和这个月对比一下。',
  '你刚才提到有两笔同名的记录，我不太放心。麻烦你重新查一遍原始记录，把这两笔的明细讲清楚。',
  '好，那你用业务人员能听得懂的话，把这两个月的情况一起说给我听听。',
];

interface TaskFact {
  taskId: string;
  label?: string;
  outcome?: string;
  scopeValues?: string[];
  calls?: number;
  createdAt: string;
  updatedAt: string;
}

interface TurnReport {
  index: number;
  text: string;
  reply: string;
  error: string | null;
  notices: string[];
  progressFrames: number;
  messageId: string;
  requestId: string | null;
  /** 本轮新出现的委派任务（platform_tasks 台账差分；直连路径的委派记录在这里）。 */
  newTasks: TaskFact[];
  taskIds: string[];
  delegated: boolean;
  /** 合并后的平台调用数（ask-session 证据链口径：同 callId 的 start/result 合并）。 */
  platformCalls: number;
  /** 本轮的 dummy 原始审计行数（audit.jsonl 窗口；含 start/result 两相）。 */
  auditRows: number;
  /** 本轮窗口内的原始审计行（逐字保留，不解析不裁剪）。 */
  auditLines: string[];
  refusedCalls: number;
  ladderRung: string;
  ms: number;
  /** 文本启发式（非机械判据）：回复是否同时点到 document-2 与 800/900。 */
  anomalyMentionedHeuristically: boolean;
}

interface TrialReport {
  trial: number;
  startedAt: string;
  totalMs: number;
  conversationId: string;
  turns: TurnReport[];
  /** 机械达标：t1/t2/t3 均发生委派且均有真实审计行（查询真正执行过）。 */
  passed: boolean;
  fatalError: string | null;
}

function readRawLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function taskFactOf(record: PlatformTaskRecord): TaskFact {
  return {
    taskId: record.taskId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.scopeValues && record.scopeValues.length > 0 ? { scopeValues: record.scopeValues } : {}),
    ...(record.calls && record.calls.length > 0 ? { calls: record.calls.length } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function renderTurnBlock(report: TurnReport): string {
  const lines: string[] = [];
  lines.push(`### 第 ${report.index} 轮`, '');
  lines.push(`**用户**：${report.text}`, '');
  if (report.notices.length > 0) {
    lines.push(`**计划通知**（${report.notices.length} 条，经计划门 onNotice 送达）：`, '');
    for (const notice of report.notices) lines.push(`> ${notice.replace(/\n/g, '\n> ')}`, '');
  }
  lines.push('**回复**：', '', report.error !== null ? `（回合失败：${report.error}）` : report.reply, '');
  const taskPart = report.newTasks.length > 0
    ? report.newTasks.map((task) => `${task.taskId}${task.label ? `（${task.label}）` : ''}`).join('、')
    : '（无委派）';
  lines.push(
    `**机械证据**：requestId=${report.requestId ?? '（缺席）'} · taskId=${taskPart}`
    + ` · 平台调用=${report.platformCalls} 次（dummy 审计 ${report.auditRows} 行，被拒 ${report.refusedCalls}）`
    + ` · 阶梯=${report.ladderRung} · 用时=${(report.ms / 1000).toFixed(1)}s`,
    '',
  );
  if (report.auditLines.length > 0) {
    lines.push('**dummy 审计行**（本轮窗口内，逐字）：', '', '```jsonl');
    for (const line of report.auditLines) lines.push(line);
    lines.push('```', '');
  }
  return lines.join('\n');
}

/**
 * 清掉仓内夹具根的 worker 工作区（`tmp/task_*`）——各试用必须互不可见。
 *
 * 为什么必须做：worker 的 scratch 是 `<profile.root>/tmp/<taskId>`（相对夹具根，非配置项），
 * 试用 N 的 worker 能读到最后一次试用（乃至更早手工 run）留下的 handover/脚本，独立性
 * 被破坏。清理只落在这个仓内夹具目录内，安全边界硬校验，绝不扩大到别处。
 */
function resetFixtureScratch(): void {
  const fixtureRoot = path.resolve(DEMO_FIXTURE_ROOT);
  const expected = path.resolve(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
  if (fixtureRoot !== expected) {
    throw new Error(`夹具 scratch 清理边界校验失败：${fixtureRoot} ≠ ${expected}`);
  }
  rmSync(path.join(fixtureRoot, 'tmp'), { recursive: true, force: true });
}

async function listSessionTasks(
  store: AuditStore,
  principalId: string,
  sessionKey: string,
): Promise<PlatformTaskRecord[]> {
  const repo = store.platformTasks;
  if (!repo) return [];
  try {
    return await repo.listBySession(principalId, sessionKey);
  } catch {
    return [];
  }
}

async function runTrial(trial: number, conversationId: string): Promise<TrialReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const trialDir = path.join(TRIALS_ROOT, `trial-${trial}`);
  const stateDir = path.join(trialDir, 'state');
  const auditPath = path.join(stateDir, 'audit.jsonl');
  const dbPath = path.join(trialDir, 'demo.db');
  const piAgentDir = path.join(trialDir, 'pi-agent');
  rmSync(trialDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  // 夹具 worker 工作区同样每次试用清空（否则本试用的 worker 能读到上一试用的 handover）。
  resetFixtureScratch();

  // 状态/审计/会话目录进 process.env：worker 的 bash 基境与宿主计划评估子进程都以
  // process.env 为准（见文件头「状态目录依据」），只传 env 对象会漏穿。
  for (const key of EXECUTION_GOVERNANCE_VARS) delete process.env[key];
  process.env['AGENT_CONFIG_PATH'] = CONFIG_COPY;
  process.env['FSHINE_EVAL_FIXTURE_STATE_DIR'] = stateDir;
  process.env['EXECUTION_AUDIT_PATH'] = auditPath;
  process.env['FSHINE_INBOUND_DEBOUNCE_MS'] = '0';
  process.env['FSHINE_PI_AGENT_DIR'] = piAgentDir;

  const env: NodeJS.ProcessEnv = { ...process.env };
  const reports: TurnReport[] = [];
  const seenTaskIds = new Set<string>();
  let fatalError: string | null = null;

  try {
    const session = await createAskSession({
      env,
      dbPath,
      conversationId,
      // fail-closed 隔离门：活跃 profile 必须是仓内夹具 + gateway 可达 + 审计通道可写读，
      // 否则拒绝建会话（防"配置漂移后 demo 悄悄打到真实执行层"）。
      requireIsolatedFixture: true,
    });
    try {
      for (const [index, text] of TURNS.entries()) {
        const turnLabel = `第 ${index + 1} 轮`;
        console.log(`\n===== [trial-${trial}] ${turnLabel} · 用户 =====\n${text}`);
        const auditBefore = readRawLines(auditPath).length;
        const startedTurn = Date.now();
        const turn: MessageTurn = await session.sendMessage(text);
        const ms = Date.now() - startedTurn;
        const auditAfter = readRawLines(auditPath);
        const auditLines = auditAfter.slice(auditBefore);

        // 委派台账（platform_tasks）：直连工具面下 Main 的委派记录在这里；本轮新出现的
        // taskId = 本轮的委派事件（逐轮串行、单会话，差分不会错配）。
        const requestRow = await session.assembly.store.requests
          .findByWecomMessageId(turn.messageId)
          .catch(() => null);
        const principalId = requestRow?.principalId ?? `wecom:${session.userId}`;
        const sep = principalId.indexOf(':');
        const channel = sep > 0 ? principalId.slice(0, sep) : 'wecom';
        const allTasks = await listSessionTasks(session.assembly.store, principalId, `${channel}:${conversationId}`);
        const newTasks = allTasks.filter((record) => !seenTaskIds.has(record.taskId));
        for (const record of allTasks) seenTaskIds.add(record.taskId);

        const report: TurnReport = {
          index: index + 1,
          text: turn.text,
          reply: turn.reply,
          error: turn.error,
          notices: [...turn.notices],
          progressFrames: turn.progress.length,
          messageId: turn.messageId,
          requestId: turn.evidence.requestId,
          newTasks: newTasks.map(taskFactOf),
          taskIds: newTasks.map((record) => record.taskId),
          delegated: newTasks.length > 0,
          platformCalls: turn.evidence.executionRows.length,
          auditRows: auditLines.length,
          auditLines,
          refusedCalls: turn.evidence.executionRows.filter((row) => row.refused !== undefined).length,
          ladderRung: turn.ladderRung,
          ms,
          anomalyMentionedHeuristically: turn.reply.includes('document-2') && turn.reply.includes('800') && turn.reply.includes('900'),
        };
        reports.push(report);
        for (const notice of report.notices) {
          console.log(`\n===== [trial-${trial}] ${turnLabel} · 计划通知 =====\n${notice}`);
        }
        console.log(`\n===== [trial-${trial}] ${turnLabel} · 回复 =====\n${report.error !== null ? `（回合失败：${report.error}）` : report.reply}`);
        console.log(
          `\n===== [trial-${trial}] ${turnLabel} · 机械证据 =====\n`
          + `requestId=${report.requestId ?? '（缺席）'} taskId=${report.taskIds[0] ?? '（无委派）'} `
          + `委派=${report.delegated ? '是' : '否'} 平台调用=${report.platformCalls} 次 `
          + `（dummy 审计 ${report.auditRows} 行，被拒 ${report.refusedCalls}） `
          + `阶梯=${report.ladderRung} 用时=${(report.ms / 1000).toFixed(1)}s`,
        );
      }
    } finally {
      await session.close();
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    console.error(`[trial-${trial}] 运行失败：${fatalError}`);
  }

  const auditTotal = readRawLines(auditPath).length;
  const t1 = reports[0];
  const t2 = reports[1];
  const t3 = reports[2];
  const passed = fatalError === null
    && reports.length === TURNS.length
    && (t1?.delegated ?? false) && (t1?.auditRows ?? 0) > 0
    && (t2?.delegated ?? false) && (t2?.auditRows ?? 0) > 0
    && (t3?.delegated ?? false) && (t3?.auditRows ?? 0) > 0
    && auditTotal > 0;

  const trialReport: TrialReport = {
    trial,
    startedAt,
    totalMs: Date.now() - startedMs,
    conversationId,
    turns: reports,
    passed,
    fatalError,
  };

  // ── 落盘：每次试用一套完整产物（失败也写，不丢样本） ──
  const summaryLines: string[] = [
    '## 汇总（机械事实）',
    '',
    `- 试用：trial-${trial} · 开始 ${startedAt}（总耗时 ${(trialReport.totalMs / 1000).toFixed(1)}s）`,
    `- 会话：${conversationId} · 库：${rel(dbPath)}`,
    `- 轮数：${reports.length} · 委派轮数：${reports.filter((report) => report.delegated).length}`
    + ` · 平台调用合计：${reports.reduce((sum, report) => sum + report.platformCalls, 0)} 次`
    + `（dummy 审计合计 ${auditTotal} 行，被拒 ${reports.reduce((sum, report) => sum + report.refusedCalls, 0)}）`,
    `- 执行层原始审计：${rel(auditPath)}（${auditTotal} 行，含每次调用的执行事实）`,
    `- t1 异常识别（文本启发式：同时点到 document-2 与 800/900）：${t1?.anomalyMentionedHeuristically ? '命中' : '未命中（需人读回复确认）'}`,
    `- t3 指代复核重新执行（机械）：${(t3?.auditRows ?? 0) > 0 ? `命中（本轮 dummy 审计 ${t3?.auditRows} 行）` : '未命中（本轮无审计行）'}`,
    `- 产品：${rel(path.join(trialDir, 'transcript.md'))} · ${rel(path.join(trialDir, 'turns.jsonl'))}`,
    '',
    `运行结论：${passed ? '本次试用达标（t1/t2/t3 均有真实委派与平台执行留痕）' : '未达标——如实记录，不重跑掩盖，不伪造结果'}`,
  ];
  const transcript = [
    `# V0 本地试用演示记录 · 第 ${trial} 次（npm run demo）`,
    '',
    '> 本记录由 scripts/demo.ts 自动生成；内容 = 逐轮原文（用户语料 / 计划通知 / 回复）',
    '> + 机械证据（requestId / taskId / 平台调用 / dummy 审计行）。回复全文未经改写。',
    '> 执行层 = 仓内 dummy 夹具（scripts/eval/fixtures/dummy-platform），每次调用都是真实子进程。',
    '',
    ...reports.flatMap((report) => [renderTurnBlock(report), '']),
    ...summaryLines,
    '',
  ].join('\n');
  writeFileSync(path.join(trialDir, 'transcript.md'), transcript);
  writeFileSync(
    path.join(trialDir, 'turns.jsonl'),
    reports.map((report) => JSON.stringify(report)).join('\n') + '\n',
  );

  console.log(`\n===== [trial-${trial}] 汇总 =====\n${summaryLines.join('\n')}`);
  return trialReport;
}

function parseTrials(argv: readonly string[]): { trials: number; usageError: boolean } {
  const flag = argv.find((arg) => arg.startsWith('--trials='));
  if (flag === undefined) return { trials: 3, usageError: false };
  const value = Number(flag.slice('--trials='.length));
  if (!Number.isInteger(value) || value < 1 || value > 5) return { trials: 3, usageError: true };
  return { trials: value, usageError: false };
}

async function main(): Promise<void> {
  const { trials, usageError } = parseTrials(process.argv.slice(2));
  if (usageError) {
    console.error('用法：npm run demo [-- --trials=<1..5>]（缺省 3 次独立试用）');
    process.exitCode = 2;
    return;
  }

  // ── 前置：LLM 配置（密钥只在环境里，本脚本不写、不打印任何密钥） ──
  if (!process.env['LLM_API_KEY'] || process.env['LLM_API_KEY'].trim() === '') {
    console.error([
      '未检测到 LLM_API_KEY——demo 需要真实模型。',
      '请把仓根 .env.example 复制为 .env（或直接 export LLM_API_KEY=...），再运行 npm run demo。',
    ].join('\n'));
    process.exitCode = 2;
    return;
  }

  // ── 每次运行重置演示目录（各 trial 的库/状态/审计/产物都在里面） ──
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  mkdirSync(TRIALS_ROOT, { recursive: true });

  // ── 配置物化：demo 配置的 profile root 相对路径 → 绝对，副本落 .runtime/demo ──
  const configPath = materializeEvalConfig(DEMO_CONFIG, CONFIG_COPY);
  const demoConfig = parseYaml(readFileSync(DEMO_CONFIG, 'utf8')) as { llm?: { model?: unknown } };
  const effectiveModel = process.env['LLM_MODEL']?.trim() || String(demoConfig.llm?.model ?? '(未声明)');

  const date = new Date().toISOString().slice(0, 10);
  const conversationId = `demo-业务闭环-${date}`;
  const startedMs = Date.now();
  const results: TrialReport[] = [];
  for (let trial = 1; trial <= trials; trial += 1) {
    console.log(`\n################ trial-${trial} / ${trials} ################`);
    results.push(await runTrial(trial, conversationId));
  }

  const passedCount = results.filter((result) => result.passed).length;
  const overall = [
    '',
    '===== 全部试用汇总 =====',
    `- 模型：${effectiveModel}（密钥只在 .env，不落盘）`,
    `- 试用次数：${results.length}（独立起跑：各自库 / 夹具状态 / Pi 会话目录）`,
    `- 总耗时：${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
    ...results.map((result) => `- trial-${result.trial}：${result.passed ? '达标' : '未达标'}`
      + `（委派 ${result.turns.filter((turn) => turn.delegated).length} 轮，`
      + `dummy 审计 ${result.turns.reduce((sum, turn) => sum + turn.auditRows, 0)} 行`
      + `${result.fatalError !== null ? `，失败：${result.fatalError}` : ''}）`),
    `- 产物保留：${rel(TRIALS_ROOT)}/trial-1..${results.length}/{transcript.md,turns.jsonl,state/audit.jsonl}`,
  ].join('\n');
  console.log(overall);

  if (passedCount !== results.length) {
    console.error([
      '',
      `演示未全部达标（${passedCount}/${results.length}）：未达标的试用原始记录同样保留（不丢弃、不美化）：`,
      `  ${rel(TRIALS_ROOT)}/trial-N/（逐次）`,
    ].join('\n'));
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error('demo 运行失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
