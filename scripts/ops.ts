/**
 * ops：本地运营快照生成器（P4，只读 + 静态生成）。
 *
 * 用法：
 *   npm run ops                       # 生成自包含 HTML 快照（缺省 .runtime/ops/index.html）
 *   npm run ops -- --out <dir>        # 指定输出目录：生成 <dir>/index.html
 *   （--config=<path> / AGENT_CONFIG_PATH 与 ask/tasks 同义；缺省读 <仓根>/.runtime/state.db）
 *
 * 边界（P4 运营后台 v1）：
 *   · 纯读：底账以只读打开（沿用 createSqliteTaskRegistry 的 readOnly 路径），不建库、不写库；
 *   · 静态生成：纯字符串模板 + inline CSS，无脚本、无外链、不联网，可离线用浏览器打开；
 *     HTML 动态文本一律经 escapeHtml 实体转义（安全不变式），动态值不进属性上下文；
 *   · 展示语义复用 scripts/tasks.ts 的既有导出（时间格式/摘要/状态词/原因行/底账行），
 *     不复制第二套渲染；最近任务序与 `npm run tasks` 列表口径一致（对账测试钉住）；
 *   · 产物恒为且仅为 <out>/index.html：目录缺失时创建，同名普通文件幂等覆盖，
 *     目录/符号链接占位一律拒绝；目录内其它文件不读、不删、不动；
 *   · 不新增依赖、不改 schema 与写语义、不加载模型、不 spawn 执行层。
 *
 * 限制与指针（页面固定文案，如实标注）：Main 最终回复当前不落库；执行步骤无时间戳；
 * 列表为全 principal 视图；running 行无自愈；质量与覆盖报告为文本指针
 * （scripts/eval/exploration/quality-report-v1.md；复跑 npm run eval:user）。
 */
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskRecord } from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry, type SqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import {
  TASK_STATUS_WORDS,
  formatLocalTime,
  renderTaskLedgerLine,
  resolveOutPath,
  resolveTaskDbPath,
  summarizeRequest,
  taskReasonLine,
} from './tasks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 缺省输出目录（仓根锚定；.runtime/ 已 gitignore）。 */
export const DEFAULT_OPS_DIR = path.join(REPO_ROOT, '.runtime', 'ops');
/** 最近任务表条数上限（与 `npm run tasks` 列表同口径）。 */
export const RECENT_LIMIT = 20;
/** 失败与未执行清单条数上限（页面有界；超出时标注「共 M 条」）。 */
export const FAILURE_LIMIT = 50;

const USAGE = '用法：npm run ops -- [--out <dir>] [--config=<path>]\n'
  + '  生成运营快照（自包含 HTML，只读消费任务底账；缺省 .runtime/ops/index.html）。';

export interface OpsCliArgs {
  outDir?: string;
}

/** 参数：仅 --out <dir> / --out=<dir>（至多一个）与 --config= 透传；不接受位置参数。 */
export function parseOpsArgs(argv: readonly string[]): OpsCliArgs | { usageError: string } {
  let outDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith('--config=')) continue;
    if (arg.startsWith('--out=')) {
      if (outDir !== undefined) return { usageError: '最多接受一个 --out。' };
      const value = arg.slice('--out='.length).trim();
      if (value === '') return { usageError: '--out 缺少目录路径。' };
      outDir = value;
      continue;
    }
    if (arg === '--out') {
      if (outDir !== undefined) return { usageError: '最多接受一个 --out。' };
      const next = argv[index + 1];
      // 值为空或以 -- 开头视为缺值（目录以 -- 开头请用 --out=<dir> 形态）。
      if (next === undefined || next.trim() === '' || next.startsWith('--')) {
        return { usageError: '--out 缺少目录路径。' };
      }
      outDir = next.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) return { usageError: `未知参数：${arg}` };
    return { usageError: `不接受位置参数：${arg}（本命令用法：npm run ops -- [--out <dir>]）。` };
  }
  return outDir === undefined ? {} : { outDir };
}

/** HTML 实体转义：所有动态文本进模板前必须经此函数（安全不变式；& 必须最先替换）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface OpsStatusCounts {
  total: number;
  completed: number;
  failed: number;
  unexecuted: number;
  running: number;
  other: number;
}

/** 统计：总数 + 四态计数；未识别的存储值进 other（只呈现，不重判）。 */
export function countOpsStatuses(records: readonly TaskRecord[]): OpsStatusCounts {
  const counts: OpsStatusCounts = {
    total: records.length, completed: 0, failed: 0, unexecuted: 0, running: 0, other: 0,
  };
  for (const task of records) {
    switch (task.status) {
      case 'completed': counts.completed += 1; break;
      case 'failed': counts.failed += 1; break;
      case 'unexecuted': counts.unexecuted += 1; break;
      case 'running': counts.running += 1; break;
      default: counts.other += 1; break;
    }
  }
  return counts;
}

/** stdout 统计行（成功时第二行）。 */
export function renderOpsCountsLine(counts: OpsStatusCounts): string {
  const other = counts.other > 0 ? ` / 其他 ${counts.other}` : '';
  return `任务：共 ${counts.total} 条（已完成 ${counts.completed} / 失败 ${counts.failed}`
    + ` / 未执行 ${counts.unexecuted} / 进行中 ${counts.running}${other}）`;
}

/** 状态展示词：已知四态复用 tasks 词表；未识别存储值 fail-open 显示「未知状态（原值）」。 */
function statusWord(status: TaskRecord['status']): string {
  const known = (TASK_STATUS_WORDS as Record<string, string | undefined>)[status];
  return known === undefined ? `未知状态（${String(status)}）` : known;
}

/** 最新在前：createdAt 降序、同刻 taskId 降序——与 tasks 列表（升序取末 N 再反序）同口径。 */
function compareNewestFirst(a: TaskRecord, b: TaskRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? 1 : -1;
  return 0;
}

/** 底账路径显示（与 tasks.ts displayDbPath 同规则）：仓内相对仓根，仓外/仓根自身显示绝对。 */
export function displayPath(dbPath: string, repoRoot: string): string {
  const relative = path.relative(repoRoot, dbPath);
  return relative !== '' && !relative.startsWith('..') ? relative : dbPath;
}

const isFailedOrUnexecuted = (task: TaskRecord): boolean =>
  task.status === 'failed' || task.status === 'unexecuted';

/** 表格数据行（cells 必须已转义——调用点一律 escapeHtml）。 */
function dataRow(cells: readonly string[]): string {
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

function statRow(label: string, count: number): string {
  return `<tr><th>${label}</th><td class="num">${count}</td></tr>`;
}

export interface OpsPageInput {
  records: readonly TaskRecord[];
  /** 生成时刻（ISO）；由调用方注入，渲染保持纯函数（可确定性测试）。 */
  generatedAt: string;
  dbPath: string;
  /** true = 底账文件不存在（空态快照；本命令不创建任何文件）。 */
  dbMissing?: boolean;
  recentLimit?: number;
  failureLimit?: number;
}

const CSS_LINES: readonly string[] = [
  ':root { color-scheme: light; }',
  'body { font-family: system-ui, sans-serif; margin: 24px auto; max-width: 1100px; padding: 0 16px; color: #1f2328; }',
  'h1 { font-size: 22px; margin: 0 0 8px 0; }',
  'h2 { font-size: 17px; margin: 28px 0 8px 0; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }',
  'p.meta { color: #57606a; margin: 4px 0; }',
  'p.banner { border: 1px solid #d4a72c; background: #fff8c5; padding: 8px 12px; border-radius: 6px; }',
  'p.empty { color: #57606a; }',
  'table { border-collapse: collapse; width: 100%; }',
  'th, td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; vertical-align: top; }',
  'th { background: #f6f8fa; white-space: nowrap; }',
  'td { word-break: break-word; }',
  'ul.limits li { margin: 4px 0; }',
  'code { background: #f6f8fa; padding: 0 4px; border-radius: 4px; }',
];

/** 限制与指针段（固定文案；含 P1/P2/P3 已登记口径与质量报告文本指针）。 */
const LIMIT_ITEMS: readonly string[] = [
  '本页为本地只读快照，由 <code>npm run ops</code> 从任务底账机械生成；状态与失败原因不重算（沿用 P1 口径）。',
  '「摘要」列是交办原文（空白折叠、截断至 60 字符），不是 Main 回复；Main 的最终回复当前不落库（P1/P2/P3 登记，待裁）。',
  '「未执行」= 已委派但零次向执行层发起调用；纯聊天不产生任务记录。',
  '执行步骤无时间戳（底账 schema 冻结）；时间均为本机时区（YYYY-MM-DD HH:mm）。',
  '本页是库内全 principal 视图（本地运维视角，不按用户过滤）；生成过程不写库。',
  '「进行中」为未收尾行；进程中断可能留下存量行（无自愈机制，如实显示）。',
  '只读打开 WAL 库可能出现 <code>-wal</code>/<code>-shm</code> 旁路文件（SQLite 固有；不删除以免干扰活跃写者）。',
  '单任务详情 / 交付件导出：<code>npm run tasks -- &lt;taskId&gt;</code>'
    + '（<code>--out &lt;path&gt;</code> 导出 Markdown）；重新交办：<code>npm run tasks -- &lt;taskId&gt; --redo</code>。',
  '失败与未执行清单收录终态非成功任务（失败/未执行），原因为底账持久化的机械判定原文。',
  '质量与覆盖报告（文本指针，非链接）：<code>scripts/eval/exploration/quality-report-v1.md</code>；'
    + '复跑用户级评测：<code>npm run eval:user</code>（缺省输出 <code>.runtime/eval-r1/</code>）。',
  '本页无脚本、无外链、可离线打开；刷新 = 重新运行 <code>npm run ops</code>。',
];

/**
 * 运营快照页面（HTML 字符串）。纯函数：无时钟、无 IO；一切动态文本经 escapeHtml。
 * 结构：头部（生成时间/底账/缺库横幅）→ 统计 → 最近任务 → 失败与未执行清单 → 限制与指针。
 */
export function renderOpsPage(input: OpsPageInput): string {
  const recentLimit = input.recentLimit ?? RECENT_LIMIT;
  const failureLimit = input.failureLimit ?? FAILURE_LIMIT;
  const newestFirst = [...input.records].sort(compareNewestFirst);
  const counts = countOpsStatuses(input.records);
  const recent = newestFirst.slice(0, recentLimit);
  const failures = newestFirst.filter(isFailedOrUnexecuted);
  const failuresShown = failures.slice(0, failureLimit);
  const ledgerLine = input.dbMissing === true
    ? `任务底账：${displayPath(input.dbPath, REPO_ROOT)}（不存在，未创建）`
    : renderTaskLedgerLine(input.dbPath);

  const recentHeader = counts.total > recentLimit
    ? `最近任务（共 ${counts.total} 条，仅显示最近 ${recentLimit} 条）`
    : `最近任务（共 ${counts.total} 条）`;
  const failureHeader = failures.length > failureLimit
    ? `失败与未执行清单（共 ${failures.length} 条，仅显示最近 ${failureLimit} 条）`
    : `失败与未执行清单（共 ${failures.length} 条）`;

  const lines: string[] = [];
  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="zh-CN">');
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">');
  lines.push('<title>fshine-agent 运营快照</title>');
  lines.push('<style>');
  lines.push(...CSS_LINES);
  lines.push('</style>');
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<h1>运营快照</h1>');
  lines.push(`<p class="meta">生成时间：${escapeHtml(formatLocalTime(input.generatedAt))}（本机时区）</p>`);
  lines.push(`<p class="meta">${escapeHtml(ledgerLine)}</p>`);
  lines.push('<p class="meta">本页由 <code>npm run ops</code> 机械生成（本地只读快照；刷新 = 重新运行命令）。</p>');
  if (input.dbMissing === true) {
    lines.push(
      `<p class="banner">任务底账不存在（尚未创建）：${escapeHtml(displayPath(input.dbPath, REPO_ROOT))}。`
      + '以下为空态快照；本命令未创建任何文件。</p>',
    );
  }

  lines.push('<section>');
  lines.push('<h2>统计</h2>');
  lines.push('<table class="stats">');
  lines.push('<tbody>');
  lines.push(statRow('任务总数', counts.total));
  lines.push(statRow('已完成', counts.completed));
  lines.push(statRow('失败', counts.failed));
  lines.push(statRow('未执行', counts.unexecuted));
  lines.push(statRow('进行中', counts.running));
  if (counts.other > 0) lines.push(statRow('其他（未知状态）', counts.other));
  lines.push('</tbody>');
  lines.push('</table>');
  lines.push('</section>');

  lines.push('<section>');
  lines.push(`<h2>${escapeHtml(recentHeader)}</h2>`);
  if (recent.length === 0) {
    lines.push('<p class="empty">（无任务记录）</p>');
  } else {
    lines.push('<table class="recent">');
    lines.push('<thead><tr><th>任务 ID</th><th>创建时间</th><th>状态</th><th>摘要</th></tr></thead>');
    lines.push('<tbody>');
    for (const task of recent) {
      lines.push(dataRow([
        escapeHtml(task.taskId),
        escapeHtml(formatLocalTime(task.createdAt)),
        escapeHtml(statusWord(task.status)),
        escapeHtml(summarizeRequest(task.request)),
      ]));
    }
    lines.push('</tbody>');
    lines.push('</table>');
  }
  lines.push('</section>');

  lines.push('<section>');
  lines.push(`<h2>${escapeHtml(failureHeader)}</h2>`);
  if (failures.length === 0) {
    lines.push('<p class="empty">（无）</p>');
  } else {
    lines.push('<table class="failures">');
    lines.push('<thead><tr><th>任务 ID</th><th>创建时间</th><th>机械原因</th></tr></thead>');
    lines.push('<tbody>');
    for (const task of failuresShown) {
      lines.push(dataRow([
        escapeHtml(task.taskId),
        escapeHtml(formatLocalTime(task.createdAt)),
        escapeHtml(taskReasonLine(task) ?? '（底账未记录原因）'),
      ]));
    }
    lines.push('</tbody>');
    lines.push('</table>');
  }
  lines.push('</section>');

  lines.push('<section>');
  lines.push('<h2>限制与指针</h2>');
  lines.push('<ul class="limits">');
  for (const item of LIMIT_ITEMS) lines.push(`<li>${item}</li>`);
  lines.push('</ul>');
  lines.push('</section>');

  lines.push('</body>');
  lines.push('</html>');
  return `${lines.join('\n')}\n`;
}

export type OpsWriteResult =
  | { ok: true; filePath: string }
  | { ok: false; exitCode: 2 | 1; message: string };

function lstatOrUndefined(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 写出快照（产物仅 <outDir>/index.html）：
 *   · 目录不存在 → 创建（recursive）；存在但不是目录 → 拒绝 exit 2；
 *   · index.html 已存在为普通文件 → 覆盖（幂等再生成）；为目录/符号链接（含悬空）→ 拒绝 exit 2，不跟随；
 *   · 目录内其它文件一概不读不删；IO 失败 exit 1。
 */
export function writeOpsPage(input: { outDir: string; text: string }): OpsWriteResult {
  const { outDir, text } = input;
  const filePath = path.join(outDir, 'index.html');

  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) {
      return { ok: false, exitCode: 2, message: `输出路径不是目录：${outDir}（请指定一个目录）。` };
    }
  } else {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (error) {
      return { ok: false, exitCode: 1, message: `无法创建输出目录：${outDir}（${errorText(error)}）。` };
    }
  }

  const existing = lstatOrUndefined(filePath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      return { ok: false, exitCode: 2, message: `拒绝写入符号链接：${filePath}（请先移除该链接）。` };
    }
    if (existing.isDirectory()) {
      return { ok: false, exitCode: 2, message: `输出路径无效：${filePath} 是目录（拒绝写入）。` };
    }
    if (!existing.isFile()) {
      return { ok: false, exitCode: 2, message: `输出路径无效：${filePath}（不是普通文件；拒绝写入）。` };
    }
  }

  try {
    writeFileSync(filePath, text, { encoding: 'utf8' });
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, exitCode: 1, message: `无法写入运营快照：${filePath}（${errorText(error)}）。` };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseOpsArgs(argv);
  if ('usageError' in parsed) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    process.exitCode = 2;
    return;
  }

  let dbPath: string;
  try {
    dbPath = resolveTaskDbPath({ argv, env: process.env, repoRoot: REPO_ROOT, cwd: process.cwd() }).dbPath;
  } catch (error) {
    console.error(`无法加载配置：${errorText(error)}`);
    process.exitCode = 2;
    return;
  }

  const outDir = resolveOutPath(parsed.outDir ?? DEFAULT_OPS_DIR, { env: process.env, cwd: process.cwd() });

  if (!existsSync(dbPath)) {
    const written = writeOpsPage({
      outDir,
      text: renderOpsPage({ records: [], generatedAt: new Date().toISOString(), dbPath, dbMissing: true }),
    });
    if (!written.ok) {
      console.error(written.message);
      process.exitCode = written.exitCode;
      return;
    }
    console.log(`已生成运营快照：${written.filePath}`);
    console.log(renderOpsCountsLine(countOpsStatuses([])));
    console.log(`任务底账：${displayPath(dbPath, REPO_ROOT)}（不存在，未创建）`);
    return;
  }

  let registry: SqliteTaskRegistry | undefined;
  try {
    registry = createSqliteTaskRegistry(dbPath, { readOnly: true });
    const tasks = registry.list();
    const written = writeOpsPage({
      outDir,
      text: renderOpsPage({ records: tasks, generatedAt: new Date().toISOString(), dbPath }),
    });
    if (!written.ok) {
      console.error(written.message);
      process.exitCode = written.exitCode;
      return;
    }
    console.log(`已生成运营快照：${written.filePath}`);
    console.log(renderOpsCountsLine(countOpsStatuses(tasks)));
    console.log(renderTaskLedgerLine(dbPath));
  } catch (error) {
    console.error(`任务底账不可读：${displayPath(dbPath, REPO_ROOT)}（${errorText(error)}）`);
    process.exitCode = 1;
  } finally {
    registry?.close();
  }
}

// 仅作为 CLI 直接运行时执行 main；被 import（测试、其它入口复用）时不触发任何副作用。
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error('ops 运行失败：', errorText(error));
    process.exitCode = 1;
  });
}
