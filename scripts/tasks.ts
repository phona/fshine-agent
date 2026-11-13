/**
 * tasks：本地只读查看任务底账——最近任务列表与单任务详情。
 *
 * 用法：
 *   npm run tasks                    # 最近任务列表（时间/状态/摘要/id，最多 20 条）
 *   npm run tasks -- <taskId>        # 单任务详情（状态/原因/执行步骤/任务结果）
 *   （--config=<path> / AGENT_CONFIG_PATH 与 ask 同义；缺省读 <仓根>/.runtime/state.db）
 *
 * 边界（P1 任务查看切片）：
 *   · 只读：SQLite 以 readonly 打开（不写、不锁写；库不存在不创建），命令零磁盘写；
 *   · 状态与原因不做二次判定——直接消费任务注册表里由 judgeReportedTask 写入的终态
 *     （completed/failed/unexecuted）与 failureReason；本文件只做中文词表映射，
 *     「读时重算」会把 fail() 路径（零执行 + failed）与 running 行错报，故不重算；
 *   · 不联网、不加载模型、不 spawn 执行层。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionStatus } from '@fshine/contracts/execution-contract';
import { loadConfig } from '@fshine/core';
import {
  judgeReportedTask,
  type TaskRecord,
  type TaskStatus,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { explicitConfigFrom } from './resolve-config-path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, '.runtime', 'state.db');
const TASK_LIST_LIMIT = 20;
const SUMMARY_MAX = 60;

const USAGE = '用法：npm run tasks [-- <taskId>] [--config=<path>]\n'
  + '  不带参数：最近任务列表；带 taskId：该任务详情。';

export const EMPTY_TASKS_MESSAGE = '还没有任务记录。用 npm run ask -- "…" 交办一项任务后，这里会列出最近的任务。';

export interface TaskCliArgs {
  taskId?: string;
}

/** 参数：可选且仅一个位置参数（taskId）；--config= 由 explicitConfigFrom 统一解析。 */
export function parseTaskArgs(argv: readonly string[]): TaskCliArgs | { usageError: string } {
  let taskId: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--config=')) continue;
    if (arg.startsWith('--')) return { usageError: `未知参数：${arg}` };
    const value = arg.trim();
    if (value === '') return { usageError: 'taskId 不能为空。' };
    if (taskId !== undefined) return { usageError: '最多接受一个 taskId。' };
    taskId = value;
  }
  return taskId === undefined ? {} : { taskId };
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

export function renderTaskDetail(task: TaskRecord): string {
  const lines = [
    `任务 ${task.taskId}`,
    `状态：${taskStatusWord(task.status)}`,
    `创建：${formatLocalTime(task.createdAt)}  更新：${formatLocalTime(task.updatedAt)}`,
    `交办：${task.request}`,
  ];
  if (task.failureReason !== undefined) {
    lines.push('', `${task.status === 'unexecuted' ? '未执行原因' : '失败原因'}：${task.failureReason}`);
  }
  lines.push('', '执行步骤：');
  if (task.executions.length === 0) {
    lines.push('  （无：本次任务未向执行层发起任何调用）');
  } else {
    task.executions.forEach((execution, index) => {
      const message = executionErrorText(execution.error);
      lines.push(`  ${index + 1}. ${execution.operation}  ${EXECUTION_STATUS_WORDS[execution.status]}`
        + (message === undefined ? '' : `  ${message}`));
    });
  }
  lines.push('', '任务结果：');
  lines.push(task.resultText !== undefined && task.resultText.trim() !== '' ? task.resultText : '（无）');
  return lines.join('\n');
}

function displayDbPath(dbPath: string): string {
  const relative = path.relative(REPO_ROOT, dbPath);
  return relative !== '' && !relative.startsWith('..') ? relative : dbPath;
}

/** 输出末行：读的是哪个库（只读）。 */
export function renderTaskLedgerLine(dbPath: string): string {
  return `任务底账：${displayDbPath(dbPath)}（只读）`;
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
    console.log(`${renderTaskDetail(task)}\n${renderTaskLedgerLine(dbPath)}`);
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
