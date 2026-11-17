/**
 * ops 运营快照 CLI（P4；P1 底账演化后任务列改为 #编号+业务名称）：
 *   · 用户视角：一条命令生成自包含 HTML 快照（生成时间 / 统计 / 最近任务 / 未成功终态清单 / 限制与指针）；
 *   · 安全不变式：一切动态文本经 escapeHtml 实体转义；整页无脚本、无外链、可离线打开；
 *   · 口径不复制：最近任务序 / 状态词 / 摘要 / 失败原因 / 底账行复用 tasks.ts 既有导出，测试对账 renderTaskList；
 *   · 业务展示位只有 #编号+名称（内部 taskId/UUID 不出现在页面）；
 *   · 只读：库哈希不变、缺库不创建；产物仅 <out>/index.html，重复生成幂等覆盖且不碰目录内其它文件；
 *   · e2e 用真实子进程跑 `scripts/ops.ts`（仓内 dummy 面，不触网、不碰真实平台）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTaskRegistry,
  type TaskRecord,
  type TaskStatus,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import {
  formatLocalTime,
  renderTaskLedgerLine,
  renderTaskList,
  summarizeRequest,
  taskLabel,
  taskOutcomeReasonLine,
  taskReasonLine,
  taskStatusWord,
} from './tasks';
import {
  FAILURE_LIMIT,
  RECENT_LIMIT,
  countOpsStatuses,
  displayPath,
  escapeHtml,
  parseOpsArgs,
  renderOpsCountsLine,
  renderOpsPage,
  writeOpsPage,
} from './ops';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXED_TIME = '2026-11-14T02:33:00.000Z';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-cli-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let recordSeq = 0;
function record(overrides: Partial<TaskRecord> & { taskId: string; createdAt: string }): TaskRecord {
  recordSeq += 1;
  return {
    principalId: 'wecom:fixture-user',
    sessionId: 'ask-2026-11-14',
    request: `帮我查一下 beta 集合、窗口 W1 的数据（${recordSeq}）`,
    status: 'completed',
    taskNo: recordSeq,
    executions: [],
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

/** 截取某个 class 的 table 片段（页内两表靠 class 区分）。 */
function tableSlice(html: string, tableClass: string): string {
  const start = html.indexOf(`<table class="${tableClass}">`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</table>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function rowIds(html: string, tableClass: string): string[] {
  return [...tableSlice(html, tableClass).matchAll(/<tr><td>([^<]*)<\/td>/g)].map((match) => match[1]!);
}

function rowCount(html: string, tableClass: string): number {
  return (tableSlice(html, tableClass).match(/<tr><td>/g) ?? []).length;
}

describe('ops：参数解析', () => {
  it('空 = 缺省目录；--out 与 --out= 两种形态；--config= 透传', () => {
    expect(parseOpsArgs([])).toEqual({});
    expect(parseOpsArgs(['--out', 'site'])).toEqual({ outDir: 'site' });
    expect(parseOpsArgs(['--out=site'])).toEqual({ outDir: 'site' });
    expect(parseOpsArgs(['--config=/tmp/x.yaml', '--out', 'site'])).toEqual({ outDir: 'site' });
  });

  it('--out 缺值/空值/后继以 -- 开头/重复 → 用法错误', () => {
    expect(parseOpsArgs(['--out'])).toMatchObject({ usageError: expect.stringContaining('--out 缺少目录路径') });
    expect(parseOpsArgs(['--out='])).toMatchObject({ usageError: expect.stringContaining('--out 缺少目录路径') });
    expect(parseOpsArgs(['--out', '--config=/tmp/x.yaml']))
      .toMatchObject({ usageError: expect.stringContaining('--out 缺少目录路径') });
    expect(parseOpsArgs(['--out', 'a', '--out', 'b']))
      .toMatchObject({ usageError: expect.stringContaining('最多接受一个 --out') });
  });

  it('未知参数与位置参数 → 用法错误', () => {
    expect(parseOpsArgs(['--bogus'])).toMatchObject({ usageError: expect.stringContaining('--bogus') });
    expect(parseOpsArgs(['site'])).toMatchObject({ usageError: expect.stringContaining('位置参数') });
  });
});

describe('ops：HTML 转义（安全不变式）', () => {
  it('escapeHtml：五字符与替换顺序（& 先替换，不二次转义别的实体的一部分）', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('plain 文本 ok')).toBe('plain 文本 ok');
  });

  it('恶意文本全字段：逐字段断言「原文不出现、转义实体出现」，整页无注入标签', () => {
    const XSS_REQUEST = `"><script>alert(1)</script><img src=x onerror=alert(1)>&'`;
    const XSS_REASON = `' onmouseover='alert(2)' & "quoted"`;
    const XSS_NAME = `</td></tr><svg onload=alert(3)>&"'`;
    const XSS_TIME = `not-a-date<b>bold</b>`;
    const XSS_STATUS = `mystery<script>`;
    const XSS_DB = `/tmp/odb<script>.db`;

    const evilFailed = record({
      taskId: 'task_evil_1', name: XSS_NAME, taskNo: 3, createdAt: XSS_TIME, status: 'failed', failureReason: XSS_REASON, request: XSS_REQUEST,
    });
    const evilUnknown = record({
      taskId: 'task_evil_2', taskNo: 4, createdAt: FIXED_TIME, status: XSS_STATUS as unknown as TaskStatus, request: '正常请求',
    });
    const page = renderOpsPage({ records: [evilFailed, evilUnknown], generatedAt: XSS_TIME, dbPath: XSS_DB });

    // 页面级：不允许出现任何可执行的注入面（本页本就没有 script/img/svg）。
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('<svg');
    expect(page).not.toContain('bold</b>');

    // 逐字段：原文不出现 + 转义实体出现。
    expect(page).toContain(escapeHtml(XSS_REQUEST));
    expect(page).not.toContain(XSS_REQUEST);
    expect(page).toContain(escapeHtml(XSS_REASON));
    expect(page).not.toContain(XSS_REASON);
    expect(page).toContain(escapeHtml(XSS_NAME));
    expect(page).not.toContain(XSS_NAME);
    expect(page).toContain(escapeHtml(XSS_TIME));
    expect(page).not.toContain(XSS_TIME);
    expect(page).toContain(escapeHtml(XSS_DB));
    expect(page).not.toContain(XSS_DB);
    // 内部 taskId 不出现在业务展示位。
    expect(page).not.toContain('task_evil_1');
    expect(page).not.toContain('task_evil_2');

    // 未知存储状态：fail-open 显示为「未知状态（原值）」且同样被转义；统计进「其他」。
    expect(page).toContain(escapeHtml(`未知状态（${XSS_STATUS}）`));
    expect(page).toContain('<tr><th>其他（未知状态）</th><td class="num">1</td></tr>');

    // 失败原因单元格按失败清单收录（failed 记录）。
    expect(page).toContain(`<td>${escapeHtml(taskReasonLine(evilFailed)!)}</td>`);
  });
});

describe('ops：快照事实（统计 / 排序 / 上限）', () => {
  it('统计：总数与四态计数；恒等式 总数 = 各态之和', () => {
    const records = [
      record({ taskId: 'task_a', createdAt: '2026-11-13T10:00:00.000Z' }),
      record({ taskId: 'task_b', createdAt: '2026-11-13T10:01:00.000Z', status: 'failed', failureReason: '失败原因甲。' }),
      record({ taskId: 'task_c', createdAt: '2026-11-13T10:02:00.000Z', status: 'unexecuted', failureReason: '未执行原因乙。' }),
      record({ taskId: 'task_d', createdAt: '2026-11-13T10:03:00.000Z', status: 'running' }),
    ];
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    expect(page).toContain('<tr><th>任务总数</th><td class="num">4</td></tr>');
    expect(page).toContain('<tr><th>已完成</th><td class="num">1</td></tr>');
    expect(page).toContain('<tr><th>失败</th><td class="num">1</td></tr>');
    expect(page).toContain('<tr><th>未执行</th><td class="num">1</td></tr>');
    expect(page).toContain('<tr><th>进行中</th><td class="num">1</td></tr>');
    expect(page).not.toContain('其他（未知状态）');

    const counts = countOpsStatuses(records);
    expect(counts.total).toBe(records.length);
    expect(
      counts.completed + counts.failed + counts.unexecuted + counts.running
      + counts.queued + counts.waitingUser + counts.cancelling + counts.cancelled + counts.timedOut + counts.other,
    ).toBe(counts.total);
  });

  it('最近任务：最新在前、同刻 taskId 降序，与 renderTaskList 的 #编号+名称序列逐条一致（口径对账）', () => {
    const records = [
      record({ taskId: 'task_a', createdAt: '2026-11-13T10:00:00.000Z' }),
      record({ taskId: 'task_b', createdAt: '2026-11-13T12:00:00.000Z' }),
      record({ taskId: 'task_c', createdAt: '2026-11-13T12:00:00.000Z' }),
      record({ taskId: 'task_d', createdAt: '2026-11-13T11:00:00.000Z' }),
    ];
    const byTaskId = new Map(records.map((task) => [task.taskId, task]));
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    const pageIds = rowIds(page, 'recent');
    expect(pageIds).toEqual(['task_c', 'task_b', 'task_d', 'task_a'].map((id) => taskLabel(byTaskId.get(id)!)));

    const listLabels = renderTaskList(records).split('\n')
      .filter((line) => line.startsWith('2026-'))
      .map((line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\S+ {2}(.+)$/.exec(line)![1]!);
    expect(pageIds).toEqual(listLabels);

    // 列口径：任务(#编号+名称) / 创建时间 / 状态 / 摘要 四列逐字复用 tasks 的同源函数。
    const newest = records[2]!;
    expect(page).toContain(
      `<tr><td>${escapeHtml(taskLabel(newest))}</td><td>${escapeHtml(formatLocalTime(newest.createdAt))}</td>`
      + `<td>${escapeHtml(taskStatusWord(newest.status))}</td><td>${escapeHtml(summarizeRequest(newest.request))}</td></tr>`,
    );
  });

  it(`最近任务上限 ${RECENT_LIMIT} 条：超出时截断并标注`, () => {
    const records: TaskRecord[] = [];
    for (let i = 1; i <= 25; i += 1) {
      records.push(record({
        taskId: `task_${String(i).padStart(2, '0')}`,
        taskNo: i,
        createdAt: `2026-11-13T10:${String(i).padStart(2, '0')}:00.000Z`,
      }));
    }
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    expect(page).toContain(`<h2>最近任务（共 25 条，仅显示最近 ${RECENT_LIMIT} 条）</h2>`);
    expect(rowCount(page, 'recent')).toBe(RECENT_LIMIT);
    const ids = rowIds(page, 'recent');
    expect(ids[0]).toBe(taskLabel(records[24]!));
    expect(ids[ids.length - 1]).toBe(taskLabel(records[5]!));
  });
});

describe('ops：未成功终态清单', () => {
  it('收录 failed/unexecuted/cancelled/timed_out；原因=taskOutcomeReasonLine；最新在前；完成的任务不在清单', () => {
    const failed = record({
      taskId: 'task_failed',
      createdAt: '2026-11-13T09:00:00.000Z',
      status: 'failed',
      failureReason: '执行层未成功：dummy.query 返回 failed：boom。',
    });
    const unexecuted = record({
      taskId: 'task_unexecuted',
      createdAt: '2026-11-13T09:05:00.000Z',
      status: 'unexecuted',
      failureReason: '未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。',
    });
    const done = record({ taskId: 'task_done', createdAt: '2026-11-13T09:10:00.000Z' });
    const page = renderOpsPage({ records: [failed, unexecuted, done], generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });

    expect(page).toContain('<h2>未成功终态清单（共 2 条）</h2>');
    expect(rowIds(page, 'failures')).toEqual([taskLabel(unexecuted), taskLabel(failed)]);
    expect(page).toContain(`<td>${escapeHtml(taskReasonLine(failed)!)}</td>`);
    expect(page).toContain(`<td>${escapeHtml(taskReasonLine(unexecuted)!)}</td>`);
    expect(tableSlice(page, 'failures')).not.toContain(taskLabel(done));
  });

  it('无失败记录时给空态；failed 但底账缺原因时给机械兜底文案', () => {
    const page = renderOpsPage({
      records: [record({ taskId: 'task_ok', createdAt: '2026-11-13T09:00:00.000Z' })],
      generatedAt: FIXED_TIME,
      dbPath: '/outside/state.db',
    });
    expect(page).toContain('<p class="empty">（无）</p>');

    const page2 = renderOpsPage({
      records: [record({ taskId: 'task_noreason', createdAt: '2026-11-13T09:00:00.000Z', status: 'failed' })],
      generatedAt: FIXED_TIME,
      dbPath: '/outside/state.db',
    });
    expect(page2).toContain('（底账未记录原因）');
  });

  it(`失败清单上限 ${FAILURE_LIMIT} 条：超出时截断并标注`, () => {
    const records: TaskRecord[] = [];
    for (let i = 1; i <= 55; i += 1) {
      records.push(record({
        taskId: `task_f${String(i).padStart(2, '0')}`,
        createdAt: `2026-11-13T10:${String(i % 60).padStart(2, '0')}:${String(i).padStart(2, '0')}.000Z`,
        status: 'failed',
        failureReason: `机械原因 ${i}。`,
      }));
    }
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    expect(page).toContain(`<h2>未成功终态清单（共 55 条，仅显示最近 ${FAILURE_LIMIT} 条）</h2>`);
    expect(rowCount(page, 'failures')).toBe(FAILURE_LIMIT);
    expect(RECENT_LIMIT).toBe(20);
    expect(FAILURE_LIMIT).toBe(50);
  });
});

describe('ops：P2 状态词与原因行金样（新状态/未知/历史行）', () => {
  /** 与 tasks 同源的 9 态金样（ops 只做呈现，不另立词表）。 */
  const STATUS_WORD_GOLDEN: ReadonlyArray<[TaskStatus, string]> = [
    ['queued', '排队中'],
    ['running', '进行中'],
    ['waiting_user', '等待用户'],
    ['cancelling', '取消中'],
    ['cancelled', '已取消'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['timed_out', '已超时'],
    ['unexecuted', '未执行'],
  ];

  it('最近任务：9 态逐词（与 tasks 列表同源对账）', () => {
    const records = STATUS_WORD_GOLDEN.map(([status], index) => record({
      taskId: `task_word_${status}`,
      createdAt: `2026-11-13T11:${String(index).padStart(2, '0')}:00.000Z`,
      status,
    }));
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    for (const [status, word] of STATUS_WORD_GOLDEN) {
      expect(page, status).toContain(`<td>${escapeHtml(word)}</td>`);
    }
    const listText = renderTaskList(records);
    for (const [, word] of STATUS_WORD_GOLDEN) expect(listText).toContain(`  ${word}  `);
  });

  it('统计：新状态非零时各成一词；零计数不出现；未知存储值仍进「其他（未知状态）」', () => {
    const records = [
      record({ taskId: 'task_q', createdAt: '2026-11-13T10:00:00.000Z', status: 'queued' }),
      record({ taskId: 'task_w', createdAt: '2026-11-13T10:01:00.000Z', status: 'waiting_user' }),
      record({ taskId: 'task_cg', createdAt: '2026-11-13T10:02:00.000Z', status: 'cancelling' }),
      record({ taskId: 'task_cd', createdAt: '2026-11-13T10:03:00.000Z', status: 'cancelled', reason: 'cancelled_by_user' }),
      record({ taskId: 'task_to', createdAt: '2026-11-13T10:04:00.000Z', status: 'timed_out', reason: 'timeout' }),
    ];
    const page = renderOpsPage({ records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    for (const word of ['排队中', '等待用户', '取消中', '已取消', '已超时']) {
      expect(page, word).toContain(`<tr><th>${word}</th><td class="num">1</td></tr>`);
    }
    expect(page).not.toContain('其他（未知状态）');

    const zeroPage = renderOpsPage({
      records: [record({ taskId: 'task_done', createdAt: '2026-11-13T10:00:00.000Z' })],
      generatedAt: FIXED_TIME,
      dbPath: '/outside/state.db',
    });
    expect(zeroPage).not.toContain('<tr><th>排队中</th>');
    expect(zeroPage).not.toContain('<tr><th>已取消</th>');
  });

  it('计数行金样：非零新状态追加；零计数不追加；「其他」照旧在末', () => {
    expect(renderOpsCountsLine({
      total: 12, completed: 3, failed: 2, unexecuted: 1, running: 1,
      queued: 1, waitingUser: 1, cancelling: 1, cancelled: 1, timedOut: 1, other: 0,
    })).toBe('任务：共 12 条（已完成 3 / 失败 2 / 未执行 1 / 进行中 1 / 排队中 1 / 等待用户 1 / 取消中 1 / 已取消 1 / 已超时 1）');
    expect(renderOpsCountsLine({
      total: 9, completed: 3, failed: 2, unexecuted: 1, running: 1,
      queued: 0, waitingUser: 0, cancelling: 0, cancelled: 0, timedOut: 0, other: 2,
    })).toBe('任务：共 9 条（已完成 3 / 失败 2 / 未执行 1 / 进行中 1 / 其他 2）');
  });

  it('未成功终态清单：取消/超时/结果未知取机械原因词；failed_confirmed 有原文用原文；历史行照旧', () => {
    const cancelled = record({ taskId: 'task_x_cancelled', createdAt: '2026-11-13T09:00:00.000Z', status: 'cancelled', reason: 'cancelled_by_user' });
    const timedOut = record({ taskId: 'task_x_timeout', createdAt: '2026-11-13T09:01:00.000Z', status: 'timed_out', reason: 'timeout' });
    const unknown = record({ taskId: 'task_x_unknown', createdAt: '2026-11-13T09:02:00.000Z', status: 'failed', reason: 'result_unknown' });
    const limited = record({ taskId: 'task_x_limited', createdAt: '2026-11-13T09:03:00.000Z', status: 'failed', reason: 'resource_limited' });
    const confirmed = record({ taskId: 'task_x_confirmed', createdAt: '2026-11-13T09:04:00.000Z', status: 'failed', reason: 'failed_confirmed' });
    const priorRow = record({ taskId: 'task_x_old', createdAt: '2026-11-13T09:05:00.000Z', status: 'failed', failureReason: '旧行失败原文。' });
    const page = renderOpsPage({
      records: [cancelled, timedOut, unknown, limited, confirmed, priorRow],
      generatedAt: FIXED_TIME,
      dbPath: '/outside/state.db',
    });
    expect(page).toContain('<h2>未成功终态清单（共 6 条）</h2>');
    for (const text of ['终止原因：用户取消', '终止原因：超时', '终止原因：结果未知', '终止原因：资源受限', '终止原因：执行层失败', taskReasonLine(priorRow)!]) {
      expect(page, text).toContain(`<td>${escapeHtml(text)}</td>`);
    }
    // 状态与机械原因字形一致：taskOutcomeReasonLine 是清单单元格的唯一口径。
    expect(page).toContain(`<td>${escapeHtml(taskOutcomeReasonLine(unknown)!)}</td>`);
  });
});

describe('ops：空态与自包含', () => {
  it('空库：统计全 0、两段空态文案、表头仍标 共 0 条', () => {
    const page = renderOpsPage({ records: [], generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    expect(page).toContain('<h2>最近任务（共 0 条）</h2>');
    expect(page).toContain('<p class="empty">（无任务记录）</p>');
    expect(page).toContain('<tr><th>任务总数</th><td class="num">0</td></tr>');
    expect(page).toContain('<p class="empty">（无）</p>');
  });

  it('缺库：空态横幅明示「尚未创建 / 未创建任何文件」，底账行不谎称只读', () => {
    const missing = path.join(os.tmpdir(), 'definitely-missing', 'state.db');
    const page = renderOpsPage({ records: [], generatedAt: FIXED_TIME, dbPath: missing, dbMissing: true });
    expect(page).toContain('任务底账不存在（尚未创建）');
    expect(page).toContain('本命令未创建任何文件');
    expect(page).toContain('（不存在，未创建）');
  });

  it('自包含：inline CSS、无脚本 / 无外链 / 无网络引用；以单个换行结尾', () => {
    const page = renderOpsPage({
      records: [record({ taskId: 'task_a', createdAt: '2026-11-13T10:00:00.000Z' })],
      generatedAt: FIXED_TIME,
      dbPath: '/outside/state.db',
    });
    expect(page.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(page).toContain('<style>');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).not.toContain('<link');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<img');
    expect(page).not.toContain('src=');
    expect(page).not.toContain('@import');
    expect(page).not.toContain('url(');
    expect(page).not.toContain('http://');
    expect(page).not.toContain('https://');
    expect(page.endsWith('</html>\n')).toBe(true);
  });

  it('限制与指针：Main 最终回复存档口径（不再声称不落库；历史任务标注无存档）', () => {
    const page = renderOpsPage({ records: [], generatedAt: FIXED_TIME, dbPath: '/outside/state.db' });
    expect(page).not.toContain('Main 的最终回复当前不落库');
    expect(page).toContain('该任务无最终回复存档');
  });

  it('生成时间/底账行：时间经 tasks 同源格式；底账行逐字复用 renderTaskLedgerLine（防分叉）', () => {
    const inside = path.join(REPO_ROOT, '.runtime', 'state.db');
    const outside = path.join(os.tmpdir(), 'somewhere', 'state.db');
    for (const dbPath of [inside, outside]) {
      const page = renderOpsPage({ records: [], generatedAt: FIXED_TIME, dbPath });
      expect(page).toContain(`生成时间：${escapeHtml(formatLocalTime(FIXED_TIME))}（本机时区）`);
      expect(page).toContain(escapeHtml(renderTaskLedgerLine(dbPath)));
    }
    expect(displayPath(inside, REPO_ROOT)).toBe(path.join('.runtime', 'state.db'));
    expect(displayPath(outside, REPO_ROOT)).toBe(outside);
  });

  it('确定性与隐私：同输入同字节；不渲染 principal/session', () => {
    const records = [record({
      taskId: 'task_a',
      createdAt: '2026-11-13T10:00:00.000Z',
      principalId: 'wecom:secret-user',
      sessionId: 'session-secret',
    })];
    const input = { records, generatedAt: FIXED_TIME, dbPath: '/outside/state.db' } as const;
    expect(renderOpsPage(input)).toBe(renderOpsPage(input));
    const page = renderOpsPage(input);
    expect(page).not.toContain('wecom:secret-user');
    expect(page).not.toContain('session-secret');
  });
});

describe('ops：写出与覆盖（仅覆盖自身产物）', () => {
  it('目录不存在自动创建；产物 = <dir>/index.html；重复写出覆盖自身且不碰其它文件', () => {
    const dir = tempDir();
    const outDir = path.join(dir, 'nested', 'site');
    const first = writeOpsPage({ outDir, text: '<html>v1</html>' });
    expect(first).toMatchObject({ ok: true });
    const filePath = path.join(outDir, 'index.html');
    expect(readFileSync(filePath, 'utf8')).toBe('<html>v1</html>');

    writeFileSync(path.join(outDir, 'keep.txt'), 'keep');
    const second = writeOpsPage({ outDir, text: '<html>v2</html>' });
    expect(second).toMatchObject({ ok: true });
    expect(readFileSync(filePath, 'utf8')).toBe('<html>v2</html>');
    expect(readFileSync(path.join(outDir, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('目录占位是普通文件 → exit 2 拒绝', () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker.txt');
    writeFileSync(blocker, 'x');
    const result = writeOpsPage({ outDir: blocker, text: 'x' });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    if (!result.ok) expect(result.message).toContain('不是目录');
  });

  it('index.html 是目录 → exit 2 拒绝', () => {
    const dir = tempDir();
    const outDir = path.join(dir, 'site');
    mkdirSync(path.join(outDir, 'index.html'), { recursive: true });
    const result = writeOpsPage({ outDir, text: 'x' });
    expect(result).toMatchObject({ ok: false, exitCode: 2 });
    if (!result.ok) expect(result.message).toContain('是目录');
  });

  it('index.html 是符号链接（含悬空）→ exit 2 拒绝、不跟随写入', () => {
    const dir = tempDir();
    const outDir = path.join(dir, 'site');
    mkdirSync(outDir, { recursive: true });

    const target = path.join(dir, 'target.html');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, path.join(outDir, 'index.html'));
    const linked = writeOpsPage({ outDir, text: 'x' });
    expect(linked).toMatchObject({ ok: false, exitCode: 2 });
    if (!linked.ok) expect(linked.message).toContain('符号链接');
    expect(readFileSync(target, 'utf8')).toBe('sentinel');

    // 悬空链接：existsSync 为 false，但 lstat 能看到，必须拒绝（否则会经链接创建目标文件）。
    const danglingDir = path.join(dir, 'dangling-site');
    mkdirSync(danglingDir, { recursive: true });
    const danglingTarget = path.join(dir, 'no-target.html');
    symlinkSync(danglingTarget, path.join(danglingDir, 'index.html'));
    const dangling = writeOpsPage({ outDir: danglingDir, text: 'x' });
    expect(dangling).toMatchObject({ ok: false, exitCode: 2 });
    expect(existsSync(danglingTarget)).toBe(false);
  });
});

describe('ops：复用前提（import 无 CLI 副作用）', () => {
  it('import scripts/tasks.ts 与 scripts/ops.ts 不执行任何 CLI 主体、不打任何输出', () => {
    const probe = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', "await import('./scripts/tasks.ts'); await import('./scripts/ops.ts'); console.log('IMPORT-DONE');"],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, AGENT_CONFIG_PATH: '' },
        encoding: 'utf8',
      },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe('IMPORT-DONE\n');
    expect(probe.stderr).toBe('');
  });
});

/** e2e：真实子进程跑 CLI（与 `npm run ops` 同 flag 形态）。 */
function runOps(args: string[], env: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_CONFIG_PATH: '' };
  delete childEnv['DB_PATH'];
  delete childEnv['INIT_CWD'];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', '--import', 'tsx', 'scripts/ops.ts', ...args],
    { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 造 4 条覆盖三态（含 fail 路径）的任务，走真实 SQLite 注册表。 */
function seedDb(dir: string): string {
  const dbPath = path.join(dir, 'state.db');
  const scope = { principalId: 'wecom:fixture-user', sessionId: 'ask-2026-11-14' };
  const registry = createSqliteTaskRegistry(dbPath);
  registry.begin({ taskId: 'task_completed', ...scope, request: '帮我查一下 beta 集合、窗口 W1 的数据' });
  registry.noteExecution('task_completed', { requestId: 'req_ok', operation: 'dummy.query', status: 'completed' });
  registry.complete('task_completed', '已查询 beta 集合（窗口 W1）：3 条记录。');

  registry.begin({ taskId: 'task_failed', ...scope, request: '帮我查一下 faulty-one 集合的数据' });
  registry.noteExecution('task_failed', {
    requestId: 'req_bad',
    operation: 'dummy.query',
    status: 'failed',
    error: { code: 'COLLECTION_FAULT', message: 'Collection faulty-one cannot be read in its current state' },
  });
  registry.complete('task_failed', '执行层报告 faulty-one 读取故障，未能返回数据。');

  registry.begin({ taskId: 'task_unexecuted', ...scope, request: '帮我看看那边的情况' });
  registry.complete('task_unexecuted', '本轮没有可执行的查询。');

  registry.begin({ taskId: 'task_worker_failed', ...scope, request: '帮我查一下 documents' });
  registry.fail('task_worker_failed', '执行层 Worker 未产出有效汇报，本次任务未完成。');
  registry.close();
  return dbPath;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('ops：CLI 端到端（真实子进程）', () => {
  it('生成页面：统计/两清单/转义面/只读哈希不变；重复生成幂等且旁路文件不动', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const before = sha256(dbPath);
    const outDir = path.join(dir, 'site');

    const run = runOps(['--out', outDir], { DB_PATH: dbPath });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`已生成运营快照：${path.join(outDir, 'index.html')}`);
    expect(run.stdout).toContain('任务：共 4 条（已完成 1 / 失败 2 / 未执行 1 / 进行中 0）');
    expect(run.stdout).toContain('任务底账：');

    const page = readFileSync(path.join(outDir, 'index.html'), 'utf8');
    expect(page).toContain('#1 帮我查一下 beta 集合、窗口 W1 的数据');
    expect(page).toContain('#2 帮我查一下 faulty-one 集合的数据');
    expect(page).not.toContain('task_completed');
    expect(page).toContain('已完成');
    expect(page).toContain('Collection faulty-one cannot be read in its current state');
    expect(page).toContain('未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。');
    expect(page).not.toContain('<script');
    expect(rowCount(page, 'recent')).toBe(4);
    expect(rowCount(page, 'failures')).toBe(3);

    const keep = path.join(outDir, 'keep.txt');
    writeFileSync(keep, 'keep');
    const again = runOps(['--out', outDir], { DB_PATH: dbPath });
    expect(again.status).toBe(0);
    expect(readFileSync(keep, 'utf8')).toBe('keep');
    expect(sha256(dbPath)).toBe(before);
  });

  it('缺库空态：exit 0、生成页面、绝不创建库文件', () => {
    const dir = tempDir();
    const missingDb = path.join(dir, 'missing.db');
    const outDir = path.join(dir, 'site');
    const run = runOps(['--out', outDir], { DB_PATH: missingDb });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('任务：共 0 条（已完成 0 / 失败 0 / 未执行 0 / 进行中 0）');
    expect(run.stdout).toContain('（不存在，未创建）');
    expect(existsSync(missingDb)).toBe(false);
    const page = readFileSync(path.join(outDir, 'index.html'), 'utf8');
    expect(page).toContain('任务底账不存在（尚未创建）');
    expect(page).toContain('（无任务记录）');
  });

  it('用法/路径边界：未知参数 exit 2；--out 缺值 exit 2；--out 指向普通文件 exit 2', () => {
    const dir = tempDir();
    expect(runOps(['--bogus']).status).toBe(2);
    expect(runOps(['--out']).status).toBe(2);

    const blocker = path.join(dir, 'blocker.txt');
    writeFileSync(blocker, 'x');
    const run = runOps(['--out', blocker], { DB_PATH: path.join(dir, 'missing.db') });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('不是目录');
  });
});
