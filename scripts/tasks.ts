/**
 * tasks：本地任务底账入口——查看（列表/详情）、交付件导出与终态任务重新推进。
 *
 * 用法：
 *   npm run tasks                    # 最近任务列表（时间/状态/摘要/id，最多 20 条）
 *   npm run tasks -- <taskId>        # 单任务详情（状态/原因/执行步骤/任务结果）
 *   npm run tasks -- <taskId> --out <path>   # 导出任务交付件（Markdown；拒绝覆盖既有文件）
 *   npm run tasks -- <taskId> --redo         # 以存储的交办原文逐字重新交办一个新任务（仅终态）
 *   （--config=<path> / AGENT_CONFIG_PATH 与 ask 同义；缺省读 <仓根>/.runtime/state.db）
 *
 * 边界（P1 任务查看 + P2 结果交付 + P3 人工接管切片）：
 *   · 只读（列表/详情/--out）：SQLite 以 readonly 打开（不写、不锁写；库不存在不创建）；
 *     导出只把交付件写到用户指定的那一个文件，不写库、不建目录；
 *   · 状态与原因不做二次判定——直接消费任务注册表里由 judgeReportedTask 写入的终态
 *     （completed/failed/unexecuted）与 failureReason；本文件只做中文词表映射，
 *     「读时重算」会把 fail() 路径（零执行 + failed）与 running 行错报，故不重算；
 *   · 交付件与详情消费同一组字段行渲染函数（见下方渲染构建函数），不维护第二套渲染；
 *   · --redo（唯一写路径）：只对终态任务生效；输入=存储的委派原文逐字（不拼接原任务的
 *     回复/执行台账/摘要），经 scripts/ask-runtime.ts 与 ask 同源的装配重新交办为新任务；
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
  judgeReportedTask,
  type TaskRecord,
  type TaskStatus,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import type { AskRuntimeInput } from './ask-runtime';
import { explicitConfigFrom } from './resolve-config-path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, '.runtime', 'state.db');
const REDO_ROOT = path.join(REPO_ROOT, '.runtime', 'redo');
const TASK_LIST_LIMIT = 20;
const SUMMARY_MAX = 60;

const USAGE = '用法：npm run tasks [-- <taskId>] [--out <path>] [--redo] [--config=<path>]\n'
  + '  不带参数：最近任务列表；带 taskId：该任务详情；带 taskId 与 --out：导出任务交付件（Markdown）；\n'
  + '  带 taskId 与 --redo：以该任务存储的交办原文逐字重新交办一个新任务（仅终态任务）。';

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

type JudgedStatus = ReturnType<typeof judgeReportedTask>['status'];

/** judgeReportedTask 的每个终态 → 用户词（键类型与同一实现的返回类型绑定）。 */
export const JUDGED_STATUS_WORDS: Record<JudgedStatus, string> = {
  completed: '已完成',
  failed: '失败',
  unexecuted: '未执行',
};

/** TaskStatus → 用户词；终态词来自 JUDGED_STATUS_WORDS，未收尾单独给词。 */
export const TASK_STATUS_WORDS: Record<TaskStatus, string> = {
  running: '进行中',
  ...JUDGED_STATUS_WORDS,
};

/** 执行步骤状态 → 用户词（契约四态，原值不动只做呈现）。 */
export const EXECUTION_STATUS_WORDS: Record<ExecutionStatus, string> = {
  completed: '完成',
  failed: '失败',
  refused: '已拒绝',
  needs_input: '待补充信息',
};

export function taskStatusWord(status: TaskStatus): string {
  return TASK_STATUS_WORDS[status];
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
    lines.push(`${formatLocalTime(task.createdAt)}  ${taskStatusWord(task.status)}  ${summarizeRequest(task.request)}`);
    lines.push(`  id: ${task.taskId}`);
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
  return `任务 ${task.taskId}`;
}

export function taskStatusLine(task: TaskRecord): string {
  return `状态：${taskStatusWord(task.status)}`;
}

export function taskTimeline(task: TaskRecord): string {
  return `创建：${formatLocalTime(task.createdAt)}  更新：${formatLocalTime(task.updatedAt)}`;
}

export function taskRequestLine(task: TaskRecord): string {
  return `交办：${task.request}`;
}

/** 失败/未执行原因行（标签按终态选词；无原因返回 undefined）——原样消费底账，不重判。 */
export function taskReasonLine(task: TaskRecord): string | undefined {
  if (task.failureReason === undefined) return undefined;
  return `${task.status === 'unexecuted' ? '未执行原因' : '失败原因'}：${task.failureReason}`;
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

/** 单任务详情（P1 输出逐字节不变）：消费上面的同一组字段行。 */
export function renderTaskDetail(task: TaskRecord): string {
  const lines = [taskIdentityLine(task), taskStatusLine(task), taskTimeline(task), taskRequestLine(task)];
  const reason = taskReasonLine(task);
  if (reason !== undefined) lines.push('', reason);
  lines.push('', ...taskExecutionLines(task));
  lines.push('', ...taskResultLines(task));
  return lines.join('\n');
}

/** 交付件固定限制与说明（如实标注；Main 最终回复当前不落库属 owner 待裁项，登记不实施）。 */
const DELIVERABLE_LIMITS = [
  '- 本交付件由 `npm run tasks` 的导出模式从本地任务底账机械导出（只读），内容未经模型润色或二次判定。',
  '- 「任务结果」是任务底账持久化的执行层汇报原文；Main 的最终回复当前不落库，本交付件不含 Main 最终回复。',
  '- 状态与失败原因来自任务收尾时的机械判定（judgeReportedTask）；导出只读不重算。',
  '- 执行步骤无时间戳（底账 schema 冻结）；时间以本机时区显示。',
];

const DELIVERABLE_RUNNING_NOTE = '- 该任务尚未收尾（当前状态「进行中」）：交付件反映导出时的底账状态。';

/**
 * 任务交付件（Markdown）：标题 + 任务信息/状态/执行步骤/任务结果/限制与说明。
 * 纯函数、无时钟依赖；段内字段行全部来自上面的共享构建函数——详情每一行都逐字在此出现。
 * 不含详情末行的运行时底账提示；末尾恰好一个换行；字段行不做 Markdown 转义（保真优先）。
 */
export function renderTaskDeliverable(task: TaskRecord): string {
  const lines = [
    `# 任务交付件：${task.taskId}（${taskStatusWord(task.status)}）`,
    '', '## 任务信息', '',
    taskIdentityLine(task),
    taskTimeline(task),
    taskRequestLine(task),
    '', '## 状态', '',
    taskStatusLine(task),
  ];
  const reason = taskReasonLine(task);
  if (reason !== undefined) lines.push(reason);
  lines.push('', '## 执行步骤', '', ...taskExecutionLines(task));
  lines.push('', '## 任务结果', '', ...taskResultLines(task));
  lines.push('', '## 限制与说明', '', ...DELIVERABLE_LIMITS);
  if (task.status === 'running') lines.push(DELIVERABLE_RUNNING_NOTE);
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

/** 可重新推进的存储终态：只有这三态（running/未知态 fail-closed 拒绝；不读时重算）。 */
const REDOABLE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'failed', 'unexecuted']);

/** 配对行（输出逐字形状）：`原任务 <old> → 新任务 <new>（状态：<词>）`。 */
export function renderRedoPairLine(oldTaskId: string, newTaskId: string, status: TaskStatus): string {
  return `原任务 ${oldTaskId} → 新任务 ${newTaskId}（状态：${taskStatusWord(status)}）`;
}

async function defaultRedoAssembler(input: AskRuntimeInput): Promise<RedoAssembly> {
  const { assembleAskRuntime } = await import('./ask-runtime');
  return assembleAskRuntime(input);
}

async function defaultIsAssemblyRefusal(error: unknown): Promise<boolean> {
  const { isAssemblyRefusal } = await import('./ask-runtime');
  return isAssemblyRefusal(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  // 终态判定：直接消费存储值（与 P1 状态呈现同一口径，不读时重算）。
  if (task.status === 'running') {
    return refuse(`任务正在进行中，不能重新推进：${task.taskId}（仅已完成、失败或未执行的任务可以重新推进）。`);
  }
  if (!REDOABLE_TASK_STATUSES.has(task.status)) {
    return refuse(`任务状态无法识别（${String(task.status)}），拒绝重新推进：${task.taskId}。`);
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
        : `${created.map((record) => renderRedoPairLine(task.taskId, record.taskId, record.status)).join('\n')}\n`;
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
    const stdout = `${head}${newTasks.map((record) => renderRedoPairLine(task.taskId, record.taskId, record.status)).join('\n')}\n`
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
    const task = tasks.find((candidate) => candidate.taskId === parsed.taskId);
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
      console.log(`${renderTaskDetail(task)}\n${renderTaskLedgerLine(dbPath)}`);
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

await main().catch((error: unknown) => {
  console.error('tasks 运行失败：', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
