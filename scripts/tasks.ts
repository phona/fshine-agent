/**
 * tasks：本地任务底账入口——查看（列表/详情）、交付件导出与终态任务重新推进。
 *
 * 用法：
 *   npm run tasks                    # 最近任务列表（时间/状态/#编号 业务名称，最多 20 条）
 *   npm run tasks -- <#编号|taskId>  # 单任务详情（状态/原因/执行步骤/任务结果/最终回复）
 *   npm run tasks -- <#编号|taskId> --out <path>   # 导出任务交付件（Markdown；拒绝覆盖既有文件）
 *   npm run tasks -- <#编号|taskId> --redo         # 以存储的交办原文逐字重新交办一个新任务（仅终态）
 *   （--config=<path> / AGENT_CONFIG_PATH 与 ask 同义；缺省读 <仓根>/.runtime/state.db）
 *
 * 边界（P1 任务查看 + P2 结果交付 + P3 人工接管 + P1 底账演化）：
 *   · 只读（列表/详情/--out）：SQLite 以 readonly 打开（不写、不锁写；库不存在不创建）；
 *     导出只把交付件写到用户指定的那一个文件，不写库、不建目录；
 *   · 任务引用：`#编号` 或纯数字（业务展示位只出 #编号+名称，不出 UUID）；内部 taskId
 *     原样兼容（审计/脚本既有用法）；解析失败与不存在同一措辞；
 *   · 展示不做二次判定（事实模型：底账没有 status/reason/failureReason 结论字段，也没有
 *     任务级生命周期枚举）——标签由原始事实就地算（启动/结束时刻/汇报/提问/租约）；
 *     做没做成由用户读详情里的执行步骤与任务结果原文，CLI 不替它下结论；
 *   · 「最终回复」= 底账持久化的 Main 回合回复全文（P1/S1 存档）；历史行无存档时显示
 *     「该任务无最终回复存档」，不以「任务结果」（执行层汇报）冒充；
 *   · 交付件与详情消费同一组字段行渲染函数（见下方渲染构建函数），不维护第二套渲染；
 *   · --redo（唯一写路径）：只对已停（未在推进）的任务生效；输入=存储的委派原文逐字
 *     （不拼接原任务的回复/执行台账/摘要），经 scripts/ask-runtime.ts 与 ask 同源的装配
 *     重新交办为新任务；
 *     原任务记录零改动；关联只由 CLI 输出打印（schema 冻结，无关联列/表）；
 *   · 列表/详情/--out 不联网、不加载模型、不 spawn 执行层（--redo 按需动态加载装配）。
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionStatus } from '@fshine/contracts/execution-contract';
import { loadConfig } from '@fshine/core';
import type { Session } from '../packages/agent/src/execution-runtime';
import {
  deriveTaskName,
  stillProgressingOf,
  taskMayBeRunningOf,
  taskReportedOf,
  taskStartedOf,
  taskUnstartedOf,
  taskWaitingOf,
  type TaskRecord,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
// 机械原因原文取全仓唯一一份（issue #72 合并；归属理由见 run-dir-cleanup.ts 的 errorText）。
import { errorText } from '../packages/agent/src/run-dir-cleanup';
import { createNotificationReader, type Notification, type NotificationKind } from '../packages/agent/src/notifications';
import type { AskRuntimeInput } from './ask-runtime';
import { explicitConfigFrom } from './resolve-config-path';

// 再转出口给 ops 等姊妹 CLI：本模块已是 CLI 面共享语义的既有出处（时间格式/摘要/事实标签…），
// 从这里取可避免每个入口各抄一份，也不必让 ops 直接引用清理执行器模块
// （`scripts/cleanup-runs.test.ts` 的接线边界：ops 不得直接引用 run-dir-cleanup）。
export { errorText };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REDO_ROOT = path.join(REPO_ROOT, '.runtime', 'redo');
const TASK_LIST_LIMIT = 20;
const SUMMARY_MAX = 60;

const USAGE = '用法：npm run tasks [-- <#编号|taskId>] [--out <path>] [--redo] [--config=<path>]\n'
  + '  不带参数：最近任务列表；带 #编号（或 taskId）：该任务详情；带 --out：导出任务交付件（Markdown）；\n'
  + '  带 --redo：以该任务存储的交办原文逐字重新交办一个新任务（仅终态任务）。';

export const EMPTY_TASKS_MESSAGE = '还没有任务记录。用 npm run ask -- "…" 交办一项任务后，这里会列出最近的任务。';

export interface TaskCliArgs {
  taskId?: string;
  outPath?: string;
  /** --redo：仅终态任务可重新推进（redo 输入=存储的交办原文逐字）。 */
  redo?: boolean;
}

/** 参数：可选且仅一个位置参数（taskId）；--out / --out= 给出导出路径；--redo 开关；--config= 由 explicitConfigFrom 统一解析。 */
export function parseTaskArgs(argv: readonly string[]): TaskCliArgs | { usageError: string } {
  let taskId: string | undefined;
  let outPath: string | undefined;
  let redo = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--config=')) continue;
    if (arg.startsWith('--out=')) {
      if (outPath !== undefined) return { usageError: '最多接受一个 --out。' };
      const value = arg.slice('--out='.length).trim();
      if (value === '') return { usageError: '--out 缺少文件路径。' };
      outPath = value;
      continue;
    }
    if (arg === '--out') {
      if (outPath !== undefined) return { usageError: '最多接受一个 --out。' };
      const next = argv[index + 1];
      // 值为空或以 -- 开头视为缺值（路径以 -- 开头请用 --out=<path> 形态）。
      if (next === undefined || next.trim() === '' || next.startsWith('--')) {
        return { usageError: '--out 缺少文件路径。' };
      }
      outPath = next.trim();
      index += 1;
      continue;
    }
    if (arg === '--redo') {
      if (redo) return { usageError: '最多接受一个 --redo。' };
      redo = true;
      continue;
    }
    if (arg.startsWith('--')) return { usageError: `未知参数：${arg}` };
    const value = arg.trim();
    if (value === '') return { usageError: 'taskId 不能为空。' };
    if (taskId !== undefined) return { usageError: '最多接受一个 taskId。' };
    taskId = value;
  }
  if (redo && outPath !== undefined) {
    return { usageError: '--redo 与 --out 不能同时使用。' };
  }
  if (outPath !== undefined && taskId === undefined) {
    return { usageError: '--out 需要与 taskId 一起使用（导出单个任务的交付件）。' };
  }
  if (redo && taskId === undefined) {
    return { usageError: '--redo 需要与 taskId 一起使用（重新推进一个任务）。' };
  }
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(outPath === undefined ? {} : { outPath }),
    ...(redo ? { redo: true } : {}),
  };
}

/**
 * 底账路径解析（与 ask 同链，保证读的是同一库）：
 *   ① 显式 --config / AGENT_CONFIG_PATH → loadConfig → store.dbPath（非空 DB_PATH env
 *      已覆盖 yaml）→ path.resolve；缺 store 段 → <仓根>/.runtime/state.db；
 *   ② 无显式配置 → 非空 DB_PATH env → path.resolve；否则 <仓根>/.runtime/state.db。
 * 不物化 fixture 配置副本：本命令磁盘零写；一致性由测试比对 ask 物化链钉住。
 */
export function resolveTaskDbPath(input: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  cwd: string;
}): { dbPath: string; source: 'explicit-config' | 'db-path-env' | 'default' } {
  const fallback = path.join(input.repoRoot, '.runtime', 'state.db');
  const explicit = explicitConfigFrom([...input.argv], input.env);
  if (explicit !== undefined) {
    const config = loadConfig({ yamlPath: explicit, env: input.env });
    return config.store?.dbPath !== undefined
      ? { dbPath: path.resolve(input.cwd, config.store.dbPath), source: 'explicit-config' }
      : { dbPath: fallback, source: 'explicit-config' };
  }
  const fromEnv = (input.env['DB_PATH'] ?? '').trim();
  if (fromEnv !== '') return { dbPath: path.resolve(input.cwd, fromEnv), source: 'db-path-env' };
  return { dbPath: fallback, source: 'default' };
}

/**
 * 任务行的机械事实标签（可多项并存；消费方**就地读原始事实算**，不共享「怎么结束」类型）：
 *   · 有汇报存档 → 「已汇报」；
 *   · 等待形状 → 「等待用户」；
 *   · 未启动 → 「排队中」/「未启动即已停」（有结束事实）；
 *   · 已启动、无汇报 → 可能还在跑（跨进程代理）→ 「进行中」；已停 → 「无汇报收尾」；
 *     都没有 → 「结果未知」（进程没了、也没写结束事实）。
 * 做没做成读详情里的执行步骤与任务结果原文，CLI 不在词上判结论。
 */
export function taskFactLabelsOf(task: TaskRecord): string[] {
  const labels: string[] = [];
  const reported = taskReportedOf(task);
  const waiting = taskWaitingOf(task);
  const started = taskStartedOf(task);
  if (reported) labels.push('已汇报');
  if (waiting) labels.push('等待用户');
  if (!reported && !waiting) {
    if (!started) labels.push(task.endedAt === undefined ? '排队中' : '未启动即已停');
    else if (task.endedAt !== undefined) labels.push('无汇报收尾');
    else if (taskMayBeRunningOf(task)) labels.push('进行中');
    else labels.push('结果未知');
  }
  if (labels.length === 0) labels.push('无汇报');
  return labels;
}

/** 事实摘要（多项以「、」并列；不是单一结论词）。 */
export function taskFactSummaryOf(task: TaskRecord): string {
  return taskFactLabelsOf(task).join('、');
}

/** 执行步骤状态 → 用户词（契约状态，原值不动只做呈现）。 */
export const EXECUTION_STATUS_WORDS: Record<ExecutionStatus, string> = {
  completed: '完成',
  needs_confirmation: '待确认',
  failed: '失败',
  refused: '已拒绝',
  needs_input: '待补充信息',
  accepted: '已受理（长任务进行中）',
};

/** 事件/通知意图（7 类）→ 用户词（展示层唯一词表；web 与 ops 复用；无完成/失败结论词）。 */
export const NOTIFICATION_KIND_WORDS: Record<NotificationKind, string> = {
  accepted: '已受理',
  started: '已开始',
  waiting_user: '等待用户',
  resumed: '已恢复',
  user_stop: '已取消',
  deadline_reached: '已超时',
  capacity_blocked: '资源受限',
};

export function notificationKindWord(kind: NotificationKind): string {
  // 未知存储值 fail-open：显示原值（词表演进的向前兼容）。
  return (NOTIFICATION_KIND_WORDS as Record<string, string | undefined>)[kind] ?? `未知通知（${String(kind)}）`;
}

/**
 * 通知投递行（只读最小展示；P4 §4 冻结口径——不注入对话历史，只按需读取）：
 *   · 已送达 → 「已送达」；未送达 → 「未送达（重试 n/max）」；重试上限已停 → 「未送达（已停止重试）」；
 *   · 无通知行返回空数组（历史行零变化，不显示该段）。
 */
export function taskNotificationLines(
  notifications: readonly Notification[],
  options: { maxAttempts?: number } = {},
): string[] {
  if (notifications.length === 0) return [];
  const maxAttempts = options.maxAttempts ?? 5;
  const lines = ['通知投递：'];
  for (const notification of notifications) {
    const status = notification.deliveredAt !== undefined
      ? '已送达'
      : notification.exhausted
        ? '未送达（已停止重试）'
        : `未送达（重试 ${notification.attempts}/${maxAttempts}）`;
    lines.push(`- ${notificationKindWord(notification.kind)}：${status}`);
  }
  return lines;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** ISO 时间 → 本机时区 `YYYY-MM-DD HH:mm`；非法值原样返回（不伪造时间）。 */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 委派原文 → 单行摘要（空白折叠，超长截断加省略号）。 */
export function summarizeRequest(request: string, max: number = SUMMARY_MAX): string {
  const single = request.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** 业务编号标签：`#<no>`；缺编号（旧库只读/未迁移）显示「（无编号）」，回退项不冒充。 */
export function taskNoLabel(task: Pick<TaskRecord, 'taskNo'>): string {
  return task.taskNo === undefined ? '（无编号）' : `#${task.taskNo}`;
}

/**
 * 业务展示标签：`#<no> <name>`。名称优先存储值；缺省（历史行）用同一机械规则
 * deriveTaskName(request) 回落——零模型、确定性；UUID 不进业务展示位。
 */
export function taskLabel(task: Pick<TaskRecord, 'taskNo' | 'name' | 'request'>): string {
  return `${taskNoLabel(task)} ${task.name ?? deriveTaskName(task.request)}`;
}

/**
 * 任务引用解析（详情/导出/redo 同一入口）：
 *   · taskId 原样（内部/脚本既有用法兼容）；
 *   · `#编号` 或纯数字（业务引用；用户复制的就是 #编号）。
 * 解析不到返回 undefined（调用方按「找不到任务」处理，与不存在同一措辞）。
 */
export function findTaskRef(records: readonly TaskRecord[], ref: string): TaskRecord | undefined {
  const trimmed = ref.trim();
  const direct = records.find((task) => task.taskId === trimmed);
  if (direct !== undefined) return direct;
  const match = /^#?(\d+)$/.exec(trimmed);
  if (match === null) return undefined;
  const taskNo = Number(match[1]);
  return records.find((task) => task.taskNo === taskNo);
}

/** 与底账读序一致：created_at 升序、同刻按 task_id 稳定。 */
function compareAscending(a: TaskRecord, b: TaskRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
  return 0;
}

export function renderTaskList(records: readonly TaskRecord[], options: { limit?: number } = {}): string {
  const limit = options.limit ?? TASK_LIST_LIMIT;
  const ascending = [...records].sort(compareAscending);
  const shown = ascending.slice(-limit).reverse();
  const total = ascending.length;
  const header = total > limit
    ? `最近任务（共 ${total} 条，仅显示最近 ${limit} 条）`
    : `最近任务（共 ${total} 条）`;
  const lines = [header];
  for (const task of shown) {
    // 业务展示位只有 #编号+名称（UUID 只在底账/审计证据里，不出现在这里）。
    lines.push(`${formatLocalTime(task.createdAt)}  ${taskFactSummaryOf(task)}  ${taskLabel(task)}`);
  }
  return lines.join('\n');
}

function executionErrorText(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/** —— 字段行构建函数：详情与交付件共用同一来源（唯一渲染口径，不另起第二套）。 —— */

export function taskIdentityLine(task: TaskRecord): string {
  return `任务 ${taskLabel(task)}`;
}

export function taskStatusLine(task: TaskRecord): string {
  return `事实：${taskFactSummaryOf(task)}`;
}

export function taskTimeline(task: TaskRecord): string {
  return `创建：${formatLocalTime(task.createdAt)}  更新：${formatLocalTime(task.updatedAt)}`;
}

export function taskRequestLine(task: TaskRecord): string {
  return `交办：${task.request}`;
}

/** 机械时刻行：这一轮在 T 停下（事实；**不分类**）；没有结束事实返回 undefined。 */
export function taskMechanicalFactLine(task: TaskRecord): string | undefined {
  if (task.endedAt === undefined) return undefined;
  return `机械事实：这一轮停止于 ${formatLocalTime(task.endedAt)}`;
}

/** 执行步骤段（含「执行步骤：」标题行；零执行给机械提示）。 */
export function taskExecutionLines(task: TaskRecord): string[] {
  const lines = ['执行步骤：'];
  if (task.executions.length === 0) {
    lines.push('  （无：本次任务未向执行层发起任何调用）');
  } else {
    task.executions.forEach((execution, index) => {
      const message = executionErrorText(execution.error);
      lines.push(`  ${index + 1}. ${execution.operation}  ${EXECUTION_STATUS_WORDS[execution.status]}`
        + (message === undefined ? '' : `  ${message}`));
    });
  }
  return lines;
}

/** 任务结果段（含「任务结果：」标题行；缺失/空白文本给「（无）」）。 */
export function taskResultLines(task: TaskRecord): string[] {
  return ['任务结果：', task.resultText !== undefined && task.resultText.trim() !== '' ? task.resultText : '（无）'];
}

/**
 * 最终回复段（含「最终回复：」标题行）：P1/S1 存档的 Main 回合并合回复全文；
 * 缺省（历史行/未产生最终回复）给机械标注，**不用任务结果（执行层汇报）冒充**。
 */
export function taskReplyLines(task: TaskRecord): string[] {
  const reply = task.replyText;
  return ['最终回复：', reply === undefined || reply.trim() === ''
    ? '该任务无最终回复存档（历史任务，Main 最终回复未持久化；不以执行层汇报冒充）。'
    : reply];
}

/** 单任务详情：消费上面的同一组字段行（状态 → 机械原因 → 失败/未执行原文 → 执行 → 结果 → 回复）。 */
export function renderTaskDetail(task: TaskRecord, options: { notifications?: readonly Notification[] } = {}): string {
  const lines = [taskIdentityLine(task), taskStatusLine(task), taskTimeline(task), taskRequestLine(task)];
  const factLine = taskMechanicalFactLine(task);
  if (factLine !== undefined) lines.push('', factLine);
  lines.push('', ...taskExecutionLines(task));
  lines.push('', ...taskResultLines(task));
  lines.push('', ...taskReplyLines(task));
  const notificationLines = taskNotificationLines(options.notifications ?? []);
  if (notificationLines.length > 0) lines.push('', ...notificationLines);
  return lines.join('\n');
}

/** 交付件固定限制与说明（如实标注）。 */
const DELIVERABLE_LIMITS = [
  '- 本交付件由 `npm run tasks` 的导出模式从本地任务底账机械导出（只读），内容未经模型润色或二次判定。',
  '- 「任务结果」是任务底账持久化的执行层汇报原文；「最终回复」是 Main 在回合收尾时实际发送给用户的回复全文（逐字存档）。',
  '- 历史任务没有最终回复存档（显示「该任务无最终回复存档」），交付件不以执行层汇报冒充 Main 回复。',
  '- 事实行只映射机械事实（等待/租约/机械时刻/汇报存档/执行行原值），不做任务结论；做没做成读执行步骤与任务结果原文。',
  '- 时间以本机时区显示；执行步骤无时间戳。',
];

const DELIVERABLE_RUNNING_NOTE = '- 该任务尚未收尾（在跑）：交付件反映导出时的底账事实。';

/**
 * 任务交付件（Markdown）：标题 + 任务信息/状态/执行步骤/任务结果/最终回复/限制与说明。
 * 纯函数、无时钟依赖；段内字段行全部来自上面的共享构建函数——详情每一行都逐字在此出现。
 * 不含详情末行的运行时底账提示；末尾恰好一个换行；字段行不做 Markdown 转义（保真优先）。
 */
export function renderTaskDeliverable(task: TaskRecord): string {
  const lines = [
    `# 任务交付件：${taskLabel(task)}（${taskFactSummaryOf(task)}）`,
    '', '## 任务信息', '',
    taskIdentityLine(task),
    taskTimeline(task),
    taskRequestLine(task),
    '', '## 状态', '',
    taskStatusLine(task),
  ];
  const factLine = taskMechanicalFactLine(task);
  if (factLine !== undefined) lines.push(factLine);
  lines.push('', '## 执行步骤', '', ...taskExecutionLines(task));
  lines.push('', '## 任务结果', '', ...taskResultLines(task));
  lines.push('', '## 最终回复', '', ...taskReplyLines(task));
  lines.push('', '## 限制与说明', '', ...DELIVERABLE_LIMITS);
  if (taskMayBeRunningOf(task)) lines.push(DELIVERABLE_RUNNING_NOTE);
  return `${lines.join('\n')}\n`;
}

function displayDbPath(dbPath: string): string {
  const relative = path.relative(REPO_ROOT, dbPath);
  return relative !== '' && !relative.startsWith('..') ? relative : dbPath;
}

/** 输出末行：读的是哪个库（只读）。 */
export function renderTaskLedgerLine(dbPath: string): string {
  return `任务底账：${displayDbPath(dbPath)}（只读）`;
}

/**
 * --out 路径解析：绝对路径原样；相对路径以「调用点目录」为基准——
 * npm 生命周期会把敲命令的目录注入 INIT_CWD（此时 process.cwd() 是包根），
 * 非空则用之；直接 node 调用没有该变量时回落进程 cwd。
 */
export function resolveOutPath(outPath: string, input: { env: NodeJS.ProcessEnv; cwd: string }): string {
  const initCwd = (input.env['INIT_CWD'] ?? '').trim();
  return path.resolve(initCwd === '' ? input.cwd : initCwd, outPath);
}

export type DeliverableWriteResult =
  | { ok: true }
  | { ok: false; exitCode: 2 | 1; message: string };

/**
 * 写出交付件：不建目录、不覆盖——
 *   · 目标已存在（文件/目录/符号链接）→ 拒绝覆盖 exit 2；
 *   · 父目录缺失 → 拒绝（不自动创建）exit 2；父路径非目录 → exit 2；
 *   · 实际写出用 flag: 'wx'（原子独占创建）兜底竞态，EEXIST/ENOENT/ENOTDIR 映射同一提示；
 *   · 其余写出失败（权限/磁盘等）→ exit 1。
 */
export function writeDeliverable(input: { filePath: string; text: string }): DeliverableWriteResult {
  const { filePath, text } = input;
  if (existsSync(filePath)) {
    return { ok: false, exitCode: 2, message: `输出文件已存在：${filePath}（拒绝覆盖；请换一个路径，或先移走原文件）。` };
  }
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    return { ok: false, exitCode: 2, message: `输出目录不存在：${dir}（不会自动创建；请先创建目录或换路径）。` };
  }
  try {
    writeFileSync(filePath, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return { ok: false, exitCode: 2, message: `输出文件已存在：${filePath}（拒绝覆盖；请换一个路径，或先移走原文件）。` };
    }
    if (code === 'ENOENT') {
      return { ok: false, exitCode: 2, message: `输出目录不存在：${dir}（不会自动创建；请先创建目录或换路径）。` };
    }
    if (code === 'ENOTDIR') {
      return { ok: false, exitCode: 2, message: `输出路径无效：${dir} 不是目录。` };
    }
    return { ok: false, exitCode: 1, message: `无法写入输出文件：${filePath}（${error instanceof Error ? error.message : String(error)}）。` };
  }
}

/** —— P3 人工接管：`--redo` 以存储的交办原文逐字重新交办（与 ask 同源装配，不复制第二套）。 —— */

/** redo 的装配结果面：redo 只需要会话与收尾口（assembleAskRuntime 的返回结构满足它）。 */
export interface RedoAssembly {
  session: Session;
  close(): void;
}

/** 装配函数：生产缺省 = 动态导入 ./ask-runtime 的 assembleAskRuntime（同一函数，不复制）。 */
export type RedoAssembler = (input: AskRuntimeInput) => Promise<RedoAssembly>;

export interface RedoDeps {
  /** 测试注入：缺省动态导入 scripts/ask-runtime（保持只读路径不加载模型栈）。 */
  assemble?: RedoAssembler;
  /** 前置拒绝判定；缺省动态导入 scripts/ask-runtime 的 isAssemblyRefusal。 */
  isAssemblyRefusal?: (error: unknown) => boolean;
}

export interface RedoOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 配对行（输出逐字形状）：`原任务 #<no> → 新任务 #<no>（事实：<词>）`（业务编号引用）。 */
export function renderRedoPairLine(oldTask: TaskRecord, newTask: TaskRecord): string {
  return `原任务 ${taskNoLabel(oldTask)} → 新任务 ${taskNoLabel(newTask)}（事实：${taskFactSummaryOf(newTask)}）`;
}

async function defaultRedoAssembler(input: AskRuntimeInput): Promise<RedoAssembly> {
  const { assembleAskRuntime } = await import('./ask-runtime');
  return assembleAskRuntime(input);
}

async function defaultIsAssemblyRefusal(error: unknown): Promise<boolean> {
  const { isAssemblyRefusal } = await import('./ask-runtime');
  return isAssemblyRefusal(error);
}

async function capture<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 重新推进一个终态任务：输入=task.request 逐字（唯一消息源，不拼接任何回复/台账/摘要），
 * 经生产同源装配（与 ask 同一函数）重新交办为新任务；原任务记录零改动（只写新 taskId）。
 * 纯函数式返回 outcome（stdout/stderr/exitCode），由 main 统一打印——测试可直测。
 */
export async function runRedo(
  input: {
    task: TaskRecord;
    dbPath: string;
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    runtimeDir: string;
  },
  deps: RedoDeps = {},
): Promise<RedoOutcome> {
  const { task } = input;
  const refuse = (message: string): RedoOutcome => ({ exitCode: 2, stdout: '', stderr: `${message}\n` });

  // 可重新推进 = 任务已到停点（读原始事实，不读任何「怎么结束」种类）：
  //   · 仍在推进（布尔谓词 stillProgressingOf，含租约过期但回合未收尾）：没看到收尾事实就
  //     重推可能双发写；
  //   · 可能还在跑（跨进程事实代理：租约未过期 / accepted 在途）：按「进行中」拒；
  //   · 等待用户：先答复或取消。
  if (stillProgressingOf(task)) {
    if (taskMayBeRunningOf(task)) {
      return refuse(`任务正在进行中，不能重新推进：${task.taskId}（仅在跑已停的任务可以重新推进）。`);
    }
    // 已启动但无结束事实/汇报：不能确定它是不是还在执行（结果未明），
    // 按「未收尾」拒，等它收尾或先取消——不猜「已经停了」。
    return refuse(`任务尚未收尾，不能重新推进：${task.taskId}（等它收尾或先取消）。`);
  }
  if (taskWaitingOf(task)) {
    return refuse(`任务在等待用户表态，不能重新推进：${task.taskId}（先答复或取消该任务）。`);
  }
  if (taskUnstartedOf(task)) {
    return refuse(`任务尚未开始执行，不能重新推进：${task.taskId}（等它开始或先取消）。`);
  }
  if (task.request.trim() === '') {
    return refuse(`任务缺少交办原文，无法重新推进：${task.taskId}。`);
  }

  // 生产同源装配：与 ask 同一函数、同一配置链；身份取存储事实（原任务创建时已由配置/渠道事实写入）。
  const assemblyInput: AskRuntimeInput = {
    purpose: '重新推进',
    argv: input.argv,
    env: input.env,
    runtimeDir: input.runtimeDir,
    sessionId: task.sessionId,
    principalId: task.principalId,
    dbPath: input.dbPath,
  };
  const assembled = await capture(() => (deps.assemble ?? defaultRedoAssembler)(assemblyInput));
  if (!assembled.ok) {
    const refused = deps.isAssemblyRefusal !== undefined
      ? deps.isAssemblyRefusal(assembled.error)
      : await defaultIsAssemblyRefusal(assembled.error);
    return refused
      ? refuse(errorText(assembled.error))
      : { exitCode: 1, stdout: '', stderr: `重新推进未完成：${errorText(assembled.error)}\n` };
  }
  const runtime = assembled.value;

  try {
    const before = new Set(runtime.session.tasks().map((record) => record.taskId));
    const sent = await capture(() => runtime.session.send(task.request));
    if (!sent.ok) {
      // 如实交付：send 失败前可能已创建新任务（半成品），尽力报告其 id 与状态。
      const created = runtime.session.tasks()
        .filter((record) => !before.has(record.taskId) && record.taskId !== task.taskId);
      const stdout = created.length === 0
        ? ''
        : `${created.map((record) => renderRedoPairLine(task, record)).join('\n')}\n`;
      return { exitCode: 1, stdout, stderr: `重新推进未完成：${errorText(sent.error)}\n` };
    }
    const turn = sent.value;
    if (turn.taskIds.length === 0) {
      return {
        exitCode: 1,
        stdout: turn.reply.trim() === '' ? '' : `${turn.reply}\n`,
        stderr: '未达标：本轮没有产生新任务（重新推进未生效）。\n',
      };
    }
    const newTasks = turn.taskIds.map((taskId) => runtime.session.getTask(taskId));
    const head = turn.reply.trim() === '' ? '' : `${turn.reply}\n\n`;
    const stdout = `${head}${newTasks.map((record) => renderRedoPairLine(task, record)).join('\n')}\n`
      + `任务底账：${displayDbPath(input.dbPath)}（新任务已写入）\n`;
    return { exitCode: 0, stdout, stderr: '' };
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseTaskArgs(argv);
  if ('usageError' in parsed) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    process.exitCode = 2;
    return;
  }

  let dbPath: string;
  try {
    dbPath = resolveTaskDbPath({ argv, env: process.env, repoRoot: REPO_ROOT, cwd: process.cwd() }).dbPath;
  } catch (error) {
    console.error(`无法加载配置：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  if (!existsSync(dbPath)) {
    if (parsed.taskId !== undefined) {
      console.error(`找不到任务：${parsed.taskId}（任务底账还没有记录）。`);
      process.exitCode = 2;
      return;
    }
    console.log(`${EMPTY_TASKS_MESSAGE}\n${renderTaskLedgerLine(dbPath)}`);
    return;
  }

  let registry: SqliteTaskRegistry | undefined;
  try {
    registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
    const tasks = registry.list();
    if (parsed.taskId === undefined) {
      console.log(`${renderTaskList(tasks)}\n${renderTaskLedgerLine(dbPath)}`);
      return;
    }
    const task = findTaskRef(tasks, parsed.taskId);
    if (task === undefined) {
      console.error(`找不到任务：${parsed.taskId}（任务底账中没有这条记录）。`);
      process.exitCode = 2;
      return;
    }
    if (parsed.redo === true) {
      // redo 要写新任务：先关只读连接，再用 ask 同源装配读同一库重新交办（原任务零改动）。
      registry.close();
      registry = undefined;
      const outcome = await runRedo({ task, dbPath, argv, env: process.env, runtimeDir: REDO_ROOT });
      if (outcome.stdout !== '') process.stdout.write(outcome.stdout);
      if (outcome.stderr !== '') process.stderr.write(outcome.stderr);
      process.exitCode = outcome.exitCode;
      return;
    }
    if (parsed.outPath === undefined) {
      // 只读展示通知投递状态（表不存在/无行给空集合，不建表不写字节；历史行零变化）。
      const notificationReader = createNotificationReader(dbPath);
      let notifications: readonly Notification[];
      try {
        notifications = notificationReader.listNotifications(task.taskId);
      } finally {
        notificationReader.close();
      }
      console.log(`${renderTaskDetail(task, { notifications })}\n${renderTaskLedgerLine(dbPath)}`);
      return;
    }
    // 导出：先渲染（纯内存），再独占写出用户指定的那一个文件；底账只读，不写库、不建目录。
    const filePath = resolveOutPath(parsed.outPath, { env: process.env, cwd: process.cwd() });
    const written = writeDeliverable({ filePath, text: renderTaskDeliverable(task) });
    if (!written.ok) {
      console.error(written.message);
      process.exitCode = written.exitCode;
      return;
    }
    console.log(`已导出任务交付件：${filePath}\n${renderTaskLedgerLine(dbPath)}`);
  } catch (error) {
    console.error(`任务底账不可读：${displayDbPath(dbPath)}（${error instanceof Error ? error.message : String(error)}）`);
    process.exitCode = 1;
  } finally {
    registry?.close();
  }
}

// 仅作为 CLI 直接运行时执行 main：被 import（scripts/ops.ts 复用本文件的只读渲染函数、
// 测试导入）时不触发任何 CLI 副作用（不读库、不打印）。Node >=24 提供 import.meta.main。
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error('tasks 运行失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
