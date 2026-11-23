/**
 * tasks 任务查看 CLI（P1 查看 + P2 结果交付 + P1 底账演化：数字编号/业务名称/最终回复；S1 事实模型）：
 *   · 用户视角：最近任务列表（时间/机械事实词/#编号+业务名称）、单任务详情（事实/机械时刻/执行步骤/
 *     任务结果/最终回复）、交付件导出（`--out`，Markdown）与 `#编号` 引用解析；
 *   · 展示只映射机械事实（S1：底账没有 status/reason/failureReason 结论字段），词表口径与
 *     scripts/tasks.ts 的事实标签同源（测试逐项比对）；
 *   · 交付件与详情逐行一致（同一组字段渲染函数）；导出拒绝覆盖、缺目录不自动创建、只读不写库；
 *   · 最终回复：有存档逐字呈现；无存档（历史行）标注「该任务无最终回复存档」，不用汇报冒充；
 *   · 只读：库文件哈希不变、缺库不创建；缺库空态、未知 id 错误态；
 *   · e2e 用真实子进程跑 `scripts/tasks.ts`（仓内 dummy 面，不触网、不碰真实平台）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@fshine/core';
import {
  createTaskRegistry,
  type ExecutionRecord,
  type TaskRecord,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { materializeEvalConfig } from './resolve-config-path';
import {
  EXECUTION_STATUS_WORDS,
  findTaskRef,
  formatLocalTime,
  parseTaskArgs,
  renderTaskDeliverable,
  renderTaskDetail,
  renderTaskList,
  resolveOutPath,
  resolveTaskDbPath,
  summarizeRequest,
  taskLabel,
  taskMechanicalFactLine,
  taskNoLabel,
  taskFactLabelsOf,
  taskFactSummaryOf,
  writeDeliverable,
} from './tasks';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_CONFIG = path.join(REPO_ROOT, 'config', 'agent.fixture.yaml');

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tasks-cli-'));
  dirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function execution(
  status: ExecutionRecord['status'],
  message?: string,
): ExecutionRecord {
  return {
    requestId: 'req_x',
    operation: 'dummy.query',
    status,
    ...(message === undefined ? {} : { error: { code: 'TEST_CODE', message } }),
  };
}

let recordSeq = 0;
function record(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  recordSeq += 1;
  return {
    principalId: 'wecom:fixture-user',
    sessionId: 'ask-2026-11-14',
    request: '帮我查一下 beta 集合、窗口 W1 的数据',
    taskNo: 1,
    createdAt: '2026-11-13T16:00:00.000Z',
    updatedAt: '2026-11-13T16:00:00.000Z',
    executions: [],
    ...overrides,
  };
}

describe('tasks：参数与库路径解析', () => {
  it('参数：空=列表；一个位置参数=详情；--config 透传；未知参数与多参数是用法错误', () => {
    expect(parseTaskArgs([])).toEqual({});
    expect(parseTaskArgs(['task_x'])).toEqual({ taskId: 'task_x' });
    expect(parseTaskArgs(['--config=/tmp/x.yaml', 'task_x'])).toEqual({ taskId: 'task_x' });
    expect(parseTaskArgs(['--bogus'])).toMatchObject({ usageError: expect.stringContaining('--bogus') });
    expect(parseTaskArgs(['a', 'b'])).toMatchObject({ usageError: expect.any(String) });
  });

  it('--out：两种形态、位置无关；缺值/空值/重复/无 taskId 是用法错误（P2）', () => {
    expect(parseTaskArgs(['task_x', '--out', 'a.md'])).toEqual({ taskId: 'task_x', outPath: 'a.md' });
    expect(parseTaskArgs(['--out=a.md', 'task_x'])).toEqual({ taskId: 'task_x', outPath: 'a.md' });
    expect(parseTaskArgs(['--out', 'a.md', 'task_x'])).toEqual({ taskId: 'task_x', outPath: 'a.md' });
    expect(parseTaskArgs(['task_x', '--out'])).toMatchObject({ usageError: expect.stringContaining('--out 缺少文件路径') });
    expect(parseTaskArgs(['task_x', '--out='])).toMatchObject({ usageError: expect.stringContaining('--out 缺少文件路径') });
    expect(parseTaskArgs(['task_x', '--out', '--config=/tmp/x.yaml']))
      .toMatchObject({ usageError: expect.stringContaining('--out 缺少文件路径') });
    expect(parseTaskArgs(['task_x', '--out', 'a.md', '--out', 'b.md']))
      .toMatchObject({ usageError: expect.stringContaining('最多接受一个 --out') });
    expect(parseTaskArgs(['--out', 'a.md'])).toMatchObject({ usageError: expect.stringContaining('taskId') });
  });

  it('库路径解析与 ask 链同解（fixture 无 store 段 + DB_PATH / --config 变体）', () => {
    const dir = tempDir();
    const fixtureCopy = materializeEvalConfig(FIXTURE_CONFIG, path.join(dir, 'agent-config.yaml'));
    const askChain = (env: NodeJS.ProcessEnv, configPath: string): string => {
      const config = loadConfig({ yamlPath: configPath, env });
      return config.store?.dbPath !== undefined
        ? path.resolve(REPO_ROOT, config.store.dbPath)
        : path.join(REPO_ROOT, '.runtime', 'state.db');
    };
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv['DB_PATH'];

    // 缺省：与 ask 物化 fixture 链同解（<repo>/.runtime/state.db）
    expect(resolveTaskDbPath({ argv: [], env: cleanEnv, repoRoot: REPO_ROOT, cwd: REPO_ROOT }).dbPath)
      .toBe(askChain(cleanEnv, fixtureCopy));

    // 非空 DB_PATH env：与 ask 链同解
    const customDb = path.join(dir, 'custom.db');
    const withEnv: NodeJS.ProcessEnv = { ...cleanEnv, DB_PATH: customDb };
    expect(resolveTaskDbPath({ argv: [], env: withEnv, repoRoot: REPO_ROOT, cwd: REPO_ROOT }).dbPath)
      .toBe(askChain(withEnv, fixtureCopy));
    expect(resolveTaskDbPath({ argv: [], env: withEnv, repoRoot: REPO_ROOT, cwd: REPO_ROOT }).dbPath)
      .toBe(customDb);

    // 显式 --config：loadConfig 同源；非空 DB_PATH env 依旧覆盖 yaml
    const explicitDb = path.join(dir, 'explicit.db');
    const explicitConfig = path.join(dir, 'explicit.yaml');
    writeFileSync(explicitConfig, `principals: {}\ncontextProfiles: {}\nstore:\n  dbPath: ${explicitDb}\n`);
    expect(resolveTaskDbPath({ argv: [`--config=${explicitConfig}`], env: cleanEnv, repoRoot: REPO_ROOT, cwd: REPO_ROOT }).dbPath)
      .toBe(askChain(cleanEnv, explicitConfig));
    expect(resolveTaskDbPath({ argv: [`--config=${explicitConfig}`], env: withEnv, repoRoot: REPO_ROOT, cwd: REPO_ROOT }).dbPath)
      .toBe(customDb);
  });
});

describe('tasks：机械事实 → 展示词（S1）', () => {
  it('执行步骤状态词表金样（契约状态原值呈现）', () => {
    expect(EXECUTION_STATUS_WORDS).toEqual({
      completed: '完成',
      needs_confirmation: '待确认',
      failed: '失败',
      refused: '已拒绝',
      needs_input: '待补充信息',
      accepted: '已受理（长任务进行中）',
    });
  });

  it('注册表机械事实 → 展示词：汇报/无汇报/取消/结果未知', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'p', sessionId: 's' };
    registry.begin({ taskId: 't_reported', ...scope, request: '查 beta' });
    registry.noteExecution('t_reported', { requestId: 'r1', operation: 'dummy.query', status: 'completed' });
    registry.setResultText('t_reported', '已查询 beta：3 条。');
    registry.begin({ taskId: 't_no_report', ...scope, request: '看看' });
    registry.begin({ taskId: 't_cancelled', ...scope, request: '取消我' });
    registry.markCancelled('t_cancelled', { scope });
    registry.begin({ taskId: 't_died', ...scope, request: '查 faulty-one' });
    registry.markDied('t_died');

    expect(registry.list().map((task) => taskFactSummaryOf(task)))
      .toEqual(['已汇报', '结果未知', '已取消', '结果未知']);
  });
});

describe('tasks：机械时刻行与详情渲染（S1）', () => {
  it('机械时刻行：一次性事实逐词；无事实返回 undefined（不伪造）', () => {
    expect(taskMechanicalFactLine(record({ taskId: 't_cancel', termination: { kind: 'cancelled', at: '2026-11-13T16:10:00.000Z' } })))
      .toBe('机械事实：用户已取消（2026-11-13T16:10:00.000Z）');
    expect(taskMechanicalFactLine(record({ taskId: 't_timeout', termination: { kind: 'timed_out', at: '2026-11-13T16:10:00.000Z' } })))
      .toBe('机械事实：机械超时（2026-11-13T16:10:00.000Z）');
    expect(taskMechanicalFactLine(record({ taskId: 't_limited', termination: { kind: 'resource_limited', at: '2026-11-13T16:10:00.000Z' } })))
      .toBe('机械事实：资源拒绝（2026-11-13T16:10:00.000Z）');
    expect(taskMechanicalFactLine(record({ taskId: 't_died', termination: { kind: 'died', at: '2026-11-13T16:10:00.000Z' } })))
      .toBe('机械事实：租约过期/进程中断，结果未知（2026-11-13T16:10:00.000Z）');
    expect(taskMechanicalFactLine(record({ taskId: 't_none' }))).toBeUndefined();
  });

  it('详情：事实行 + 机械时刻；历史行不出现机械事实行', () => {
    const cancelled = record({ taskId: 't_cancelled', taskNo: 7, termination: { kind: 'cancelled', at: '2026-11-13T16:10:00.000Z' }, resultText: '已按用户请求取消。' });
    const detail = renderTaskDetail(cancelled);
    expect(detail).toContain('事实：已取消');
    expect(detail).toContain('机械事实：用户已取消（2026-11-13T16:10:00.000Z）');
    expect(renderTaskDetail(record({ taskId: 't_plain' }))).not.toContain('机械事实：');
  });

  it('执行步骤：完成/失败逐行呈现执行层状态与错误原文；零执行给机械提示', () => {
    const withExec = record({
      taskId: 't_exec',
      resultText: '已查询。',
      executions: [
        execution('completed'),
        { requestId: 'r2', operation: 'dummy.query', status: 'failed', error: { code: 'X', message: '读取故障。' } },
      ],
    });
    const text = renderTaskDetail(withExec);
    expect(text).toContain('1. dummy.query  完成');
    expect(text).toContain('2. dummy.query  失败  读取故障。');
    expect(renderTaskDetail(record({ taskId: 't_zero', resultText: '本轮没有可执行的查询。' })))
      .toContain('（无：本次任务未向执行层发起任何调用）');
  });
});

describe('tasks：列表与详情渲染', () => {
  it('列表：最新在前；超过 20 条只显示最近 20 条并提示总数；业务展示位只有 #编号+名称', () => {
    const records = Array.from({ length: 25 }, (_, index) => record({
      taskId: `task_${String(index).padStart(2, '0')}`,
      taskNo: index + 1,
      request: `任务 ${index}`,
      createdAt: `2026-11-13T16:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const text = renderTaskList(records);
    expect(text).toContain('最近任务（共 25 条，仅显示最近 20 条）');
    const rows = text.split('\n').filter((line) => line.startsWith('2026-'));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain('#25 任务 24');
    expect(rows[19]).toContain('#6 任务 5');
    expect(text).not.toMatch(/任务 4\n/);
    expect(text).toContain('排队中');
    // UUID（task_*）不出现在业务展示位；旧的 id: 行已移除。
    expect(text).not.toContain('task_');
    expect(text).not.toMatch(/^ {2}id: /m);
  });

  it('详情：汇报/无汇报/取消形态字段齐全；无存档回复给机械标注', () => {
    const okText = renderTaskDetail(record({
      taskId: 'task_ok',
      taskNo: 12,
      resultText: '已查询 beta：3 条。',
      executions: [execution('completed')],
    }));
    expect(okText).toContain('任务 #12 帮我查一下 beta 集合、窗口 W1 的数据');
    expect(okText).toContain('事实：已汇报');
    expect(okText).toContain('交办：帮我查一下 beta 集合、窗口 W1 的数据');
    expect(okText).toContain('1. dummy.query  完成');
    expect(okText).toContain('任务结果：\n已查询 beta：3 条。');
    expect(okText).toContain('最终回复：\n该任务无最终回复存档（历史任务，Main 最终回复未持久化；不以执行层汇报冒充）。');
    expect(okText).not.toContain('task_ok');

    const noneText = renderTaskDetail(record({
      taskId: 'task_none',
      resultText: '本轮未发起调用。',
      executions: [],
    }));
    expect(noneText).toContain('事实：已汇报');
    expect(noneText).toContain('（无：本次任务未向执行层发起任何调用）');

    const noReportText = renderTaskDetail(record({ taskId: 'task_no_report', runningSince: '2026-11-13T16:00:01.000Z', executions: [] }));
    expect(noReportText).toContain('事实：结果未知');
    expect(noReportText).toContain('任务结果：\n（无）');
  });

  it('最终回复：有存档逐字呈现；缺存档标注「该任务无最终回复存档」，不用任务结果冒充', () => {
    const withReply = record({
      taskId: 'task_reply',
      taskNo: 7,
      resultText: '执行层汇报原文：查到 beta 3 条。',
      replyText: '已查到 beta 集合 3 条记录，这是给你的最终回复。',
    });
    const detail = renderTaskDetail(withReply);
    expect(detail).toContain('最终回复：\n已查到 beta 集合 3 条记录，这是给你的最终回复。');
    expect(detail).toContain('任务结果：\n执行层汇报原文：查到 beta 3 条。');

    const noReply = record({
      taskId: 'task_noreply',
      taskNo: 8,
      resultText: '执行层汇报原文：查到 beta 3 条。',
    });
    const second = renderTaskDetail(noReply);
    expect(second).toContain('最终回复：\n该任务无最终回复存档（历史任务，Main 最终回复未持久化；不以执行层汇报冒充）。');
    expect(second).not.toContain('最终回复：\n执行层汇报原文');
  });

  it('摘要单行化并截断；时间按本机时区格式化', () => {
    expect(summarizeRequest('帮'.repeat(80))).toBe(`${'帮'.repeat(60)}…`);
    expect(summarizeRequest('第一行\n第二行')).toBe('第一行 第二行');

    const iso = '2026-11-13T16:05:00.000Z';
    const local = new Date(iso);
    const pad = (value: number): string => String(value).padStart(2, '0');
    const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
      + ` ${pad(local.getHours())}:${pad(local.getMinutes())}`;
    expect(formatLocalTime(iso)).toBe(expected);
    expect(formatLocalTime('not-a-date')).toBe('not-a-date');
  });
});

describe('tasks：#编号引用解析（数字 ID 稳定简短）', () => {
  const tasks = [
    record({ taskId: 'task_one', taskNo: 1, request: '查 alpha' }),
    record({ taskId: 'task_two', taskNo: 2, request: '查 beta' }),
  ];

  it('接受 taskId 原样（兼容）与 #编号/纯数字两种业务引用', () => {
    expect(findTaskRef(tasks, 'task_two')?.taskId).toBe('task_two');
    expect(findTaskRef(tasks, '#2')?.taskId).toBe('task_two');
    expect(findTaskRef(tasks, '2')?.taskId).toBe('task_two');
    expect(findTaskRef(tasks, '#99')).toBeUndefined();
    expect(findTaskRef(tasks, 'task_absent')).toBeUndefined();
    expect(findTaskRef(tasks, '#x')).toBeUndefined();
  });

  it('taskLabel/taskNoLabel：编号+名称（名称优先存储值，缺失机械回落原文首段）；缺编号不崩溃', () => {
    expect(taskLabel(tasks[1]!)).toBe('#2 查 beta');
    expect(taskNoLabel(tasks[1]!)).toBe('#2');
    expect(taskLabel({ taskNo: 3, name: '业务名称', request: '原文' })).toBe('#3 业务名称');
    expect(taskLabel({ taskNo: undefined, name: undefined, request: '历史原文' })).toBe('（无编号） 历史原文');
    expect(taskNoLabel({ taskNo: undefined })).toBe('（无编号）');
  });
});

describe('tasks：任务交付件渲染与写出（P2）', () => {
  const reported = record({
    taskId: 'task_ok',
    resultText: '已查询 beta：3 条。',
    executions: [execution('completed')],
  });
  const failed = record({
    taskId: 'task_bad',
    resultText: '执行层报告读取故障。',
    executions: [execution('failed', '读取故障。')],
  });
  const unexecuted = record({
    taskId: 'task_none',
    resultText: '本轮未发起调用。',
    executions: [],
  });
  const noReport = record({
    taskId: 'task_no_report',
    runningSince: '2026-11-13T16:00:01.000Z',
    executions: [],
  });
  const cancelled = record({
    taskId: 'task_cancelled',
    termination: { kind: 'cancelled', at: '2026-11-13T16:10:00.000Z' },
    resultText: '已取消。',
  });
  const running = record({ taskId: 'task_running', leaseUntil: '2099-01-01T00:00:00.000Z' });

  it('结构：标题/任务信息/状态/执行步骤/任务结果/最终回复/限制与说明逐段齐全；已汇报态无机械时刻行', () => {
    const text = renderTaskDeliverable(reported);
    const time = formatLocalTime(reported.createdAt);
    expect(text.startsWith('# 任务交付件：#1 帮我查一下 beta 集合、窗口 W1 的数据（已汇报）\n')).toBe(true);
    expect(text).toContain('## 任务信息\n\n任务 #1 帮我查一下 beta 集合、窗口 W1 的数据');
    expect(text).toContain(`创建：${time}  更新：${formatLocalTime(reported.updatedAt)}\n交办：${reported.request}`);
    expect(text).toContain('## 状态\n\n事实：已汇报');
    expect(text).toContain('## 执行步骤\n\n执行步骤：\n  1. dummy.query  完成');
    expect(text).toContain('## 任务结果\n\n任务结果：\n已查询 beta：3 条。');
    expect(text).toContain('## 最终回复\n\n最终回复：\n该任务无最终回复存档');
    expect(text).toContain('## 限制与说明');
    expect(text).toContain('- 本交付件由 `npm run tasks` 的导出模式从本地任务底账机械导出（只读），内容未经模型润色或二次判定。');
    expect(text).toContain('- 「任务结果」是任务底账持久化的执行层汇报原文；「最终回复」是 Main 在回合收尾时实际发送给用户的回复全文（逐字存档）。');
    expect(text).toContain('- 历史任务没有最终回复存档（显示「该任务无最终回复存档」），交付件不以执行层汇报冒充 Main 回复。');
    expect(text).toContain('- 事实行只映射机械事实（等待/租约/机械时刻/汇报存档/执行行原值），不做任务结论；做没做成读执行步骤与任务结果原文。');
    expect(text).toContain('- 时间以本机时区显示；执行步骤无时间戳。');
    expect(text).not.toContain('机械事实：');
    expect(text).not.toContain('task_ok');
  });

  it('最终回复存档在场：交付件含逐字回复全文与任务结果分列', () => {
    const text = renderTaskDeliverable(record({
      taskId: 'task_reply',
      taskNo: 9,
      resultText: '执行层汇报原文：查到 beta 3 条。',
      replyText: '已查到 beta 集合 3 条记录，这是给你的最终回复。',
    }));
    const replySection = text.split('## 最终回复')[1]!.split('## 限制与说明')[0]!;
    expect(replySection).toContain('最终回复：\n已查到 beta 集合 3 条记录，这是给你的最终回复。\n');
    expect(replySection).not.toContain('该任务无最终回复存档');
    expect(text).toContain('## 任务结果\n\n任务结果：\n执行层汇报原文：查到 beta 3 条。');
  });

  it('失败/零执行：执行步骤与结果原样；取消态含机械时刻行', () => {
    const bad = renderTaskDeliverable(failed);
    expect(bad).toContain('## 状态\n\n事实：已汇报');
    expect(bad).toContain('1. dummy.query  失败  读取故障。');
    expect(bad).toContain('任务结果：\n执行层报告读取故障。');

    const none = renderTaskDeliverable(unexecuted);
    expect(none).toContain('事实：已汇报');
    expect(none).toContain('执行步骤：\n  （无：本次任务未向执行层发起任何调用）');

    const plain = renderTaskDeliverable(noReport);
    expect(plain).toContain('事实：结果未知');
    expect(plain).toContain('任务结果：\n（无）');

    const cancelDoc = renderTaskDeliverable(cancelled);
    expect(cancelDoc).toContain('事实：已取消、已汇报\n机械事实：用户已取消（2026-11-13T16:10:00.000Z）');
  });

  it('进行中：无机械时刻行，限制段追加未收尾提示', () => {
    const text = renderTaskDeliverable(running);
    expect(text.startsWith('# 任务交付件：#1 帮我查一下 beta 集合、窗口 W1 的数据（进行中）\n')).toBe(true);
    expect(text).toContain('## 状态\n\n事实：进行中');
    expect(text).not.toContain('机械事实：');
    expect(text).toContain('- 该任务尚未收尾（在跑）：交付件反映导出时的底账事实。');
  });

  it('格式：LF、末尾恰一个换行；同输入两次渲染逐字节一致（无生成时间）', () => {
    const first = renderTaskDeliverable(failed);
    const second = renderTaskDeliverable(failed);
    expect(first).toBe(second);
    expect(first.includes('\r')).toBe(false);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });

  it('一致性：详情正文每个非空行逐字出现在交付件（同一组渲染函数）', () => {
    for (const task of [reported, failed, unexecuted, noReport, cancelled, running]) {
      const detailLines = renderTaskDetail(task).split('\n').filter((line) => line.trim() !== '');
      const deliverableLines = renderTaskDeliverable(task).split('\n');
      for (const line of detailLines) expect(deliverableLines).toContain(line);
    }
  });

  it('金样：renderTaskDetail 输出逐字节稳定（含 #编号/名称与最终回复段）', () => {
    const text = renderTaskDetail(record({
      taskId: 'task_golden',
      taskNo: 1,
      resultText: '执行层报告读取故障。',
      executions: [execution('failed', '读取故障。')],
    }));
    const time = formatLocalTime('2026-11-13T16:00:00.000Z');
    expect(text).toBe([
      '任务 #1 帮我查一下 beta 集合、窗口 W1 的数据',
      '事实：已汇报',
      `创建：${time}  更新：${time}`,
      '交办：帮我查一下 beta 集合、窗口 W1 的数据',
      '',
      '执行步骤：',
      '  1. dummy.query  失败  读取故障。',
      '',
      '任务结果：',
      '执行层报告读取故障。',
      '',
      '最终回复：',
      '该任务无最终回复存档（历史任务，Main 最终回复未持久化；不以执行层汇报冒充）。',
    ].join('\n'));
  });

  it('--out 路径：绝对原样；相对以 INIT_CWD 为调用点，其次 cwd', () => {
    expect(resolveOutPath('/abs/x.md', { env: {}, cwd: '/cwd' })).toBe('/abs/x.md');
    expect(resolveOutPath('x.md', { env: { INIT_CWD: '/from-npm' }, cwd: '/cwd' })).toBe(path.join('/from-npm', 'x.md'));
    expect(resolveOutPath('sub/x.md', { env: { INIT_CWD: '/from-npm' }, cwd: '/cwd' }))
      .toBe(path.join('/from-npm', 'sub', 'x.md'));
    expect(resolveOutPath('x.md', { env: {}, cwd: '/cwd' })).toBe(path.join('/cwd', 'x.md'));
    expect(resolveOutPath('x.md', { env: { INIT_CWD: '  ' }, cwd: '/cwd' })).toBe(path.join('/cwd', 'x.md'));
  });

  it('写出：独占创建；目标已存在拒绝且原文件不动；父目录缺失拒绝且不创建', () => {
    const dir = tempDir();
    const target = path.join(dir, 'deliverable.md');
    expect(writeDeliverable({ filePath: target, text: 'A\n' })).toEqual({ ok: true });
    expect(readFileSync(target, 'utf8')).toBe('A\n');

    const second = writeDeliverable({ filePath: target, text: 'B\n' });
    expect(second).toMatchObject({ ok: false, exitCode: 2 });
    if (!second.ok) expect(second.message).toContain('已存在');
    expect(readFileSync(target, 'utf8')).toBe('A\n');

    const nested = path.join(dir, 'nested', 'deliverable.md');
    const missing = writeDeliverable({ filePath: nested, text: 'B\n' });
    expect(missing).toMatchObject({ ok: false, exitCode: 2 });
    if (!missing.ok) expect(missing.message).toContain('输出目录不存在');
    expect(existsSync(path.join(dir, 'nested'))).toBe(false);
  });
});

/** e2e：真实子进程跑 CLI（与 `npm run tasks` 同 flag 形态）。 */
function runTasks(args: string[], env: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_CONFIG_PATH: '' };
  delete childEnv['DB_PATH'];
  // 清掉 npm 注入的调用点目录：相对 --out 的解析基准测试必须可控（需要时用例显式给值）。
  delete childEnv['INIT_CWD'];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', '--import', 'tsx', 'scripts/tasks.ts', ...args],
    { cwd: REPO_ROOT, env: childEnv, encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 造 4 条覆盖汇报/无汇报的任务，走真实 SQLite 注册表；汇报任务带 Main 回复存档。 */
function seedDb(dir: string): string {
  const dbPath = path.join(dir, 'state.db');
  const scope = { principalId: 'wecom:fixture-user', sessionId: 'ask-2026-11-14' };
  const registry = createSqliteTaskRegistry(dbPath);
  registry.begin({ taskId: 'task_completed', ...scope, request: '帮我查一下 beta 集合、窗口 W1 的数据' });
  registry.noteExecution('task_completed', { requestId: 'req_ok', operation: 'dummy.query', status: 'completed' });
  registry.setResultText('task_completed', '已查询 beta 集合（窗口 W1）：3 条记录。');
  registry.archiveReply(['task_completed'], '已查到 beta 集合（窗口 W1）共 3 条记录，需要明细我再继续。');

  registry.begin({ taskId: 'task_failed', ...scope, request: '帮我查一下 faulty-one 集合的数据' });
  registry.noteExecution('task_failed', {
    requestId: 'req_bad',
    operation: 'dummy.query',
    status: 'failed',
    error: { code: 'COLLECTION_FAULT', message: 'Collection faulty-one cannot be read in its current state' },
  });
  registry.setResultText('task_failed', '执行层报告 faulty-one 读取故障，未能返回数据。');

  registry.begin({ taskId: 'task_unexecuted', ...scope, request: '帮我看看那边的情况' });
  registry.setResultText('task_unexecuted', '本轮没有可执行的查询。');

  registry.begin({ taskId: 'task_no_report', ...scope, request: '帮我查一下 documents' });
  registry.noteRoundFailed('task_no_report');
  registry.close();
  return dbPath;
}

/**
 * 升级前（v5）形状的任务库：tasks 仍带六个终态列、没有 task_events（零状态 v6 之前）。
 * CLI 固定只读打开；数据写入用原始连接（只构造历史库，不经过现行写入面）。
 */
function seedV5Db(dir: string): string {
  const dbPath = path.join(dir, 'state-v5.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request TEXT NOT NULL,
      result_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_no INTEGER,
      name TEXT,
      reply_text TEXT,
      pending_question TEXT,
      waiting_since TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      died_at TEXT,
      cancelled_at TEXT,
      timed_out_at TEXT,
      resource_limited_at TEXT,
      cancel_requested_at TEXT,
      long_running_notified_at TEXT,
      running_since TEXT,
      round_failed_at TEXT,
      wait_contact_lost_notified_at TEXT
    );
    CREATE TABLE task_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE executions (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      dispatch_key TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO tasks (task_id, principal_id, session_id, request, result_text, created_at, updated_at,
      task_no, name, reply_text, running_since, cancelled_at, died_at)
    VALUES (@taskId, 'wecom:fixture-user', 'ask-legacy', @request, NULL, '2026-11-20T08:00:00.000Z',
      '2026-11-20T09:00:00.000Z', @taskNo, @name, NULL, @runningSince, @cancelledAt, @diedAt)
  `);
  // updated_at 全是 09:00；真实终态时刻只在旧终态列上（08:11 / 08:21）——display 必须用后者。
  insert.run({
    taskId: 'task_v5_cancelled',
    request: '帮我查一下 alpha 集合',
    taskNo: 11,
    name: '查 alpha 集合',
    runningSince: '2026-11-20T08:10:00.000Z',
    cancelledAt: '2026-11-20T08:11:00.000Z',
    diedAt: null,
  });
  insert.run({
    taskId: 'task_v5_died',
    request: '帮我查一下 beta 集合',
    taskNo: 12,
    name: '查 beta 集合',
    runningSince: '2026-11-20T08:20:00.000Z',
    cancelledAt: null,
    diedAt: '2026-11-20T08:21:00.000Z',
  });
  db.prepare("INSERT INTO task_sequences (name, value) VALUES ('task_no', 11)").run();
  db.pragma('user_version = 5');
  db.close();
  return dbPath;
}

describe('tasks：CLI 端到端（真实子进程）', () => {
  it('列表：机械事实以中文呈现，含 #编号与业务名称（不出现内部 taskId）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const run = runTasks([], { DB_PATH: dbPath });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('最近任务（共 4 条）');
    expect(run.stdout).toContain('已汇报');
    expect(run.stdout).toContain('无汇报');
    expect(run.stdout).toContain('#1 帮我查一下 beta 集合、窗口 W1 的数据');
    expect(run.stdout).toContain('#2 帮我查一下 faulty-one 集合的数据');
    expect(run.stdout).not.toContain('task_completed');
    expect(run.stdout).toContain('任务底账：');
  });

  it('#编号引用：详情/导出可用 #编号 与纯数字（兼容 taskId 原样）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const byHash = runTasks(['#1'], { DB_PATH: dbPath });
    expect(byHash.status).toBe(0);
    expect(byHash.stdout).toContain('任务 #1 帮我查一下 beta 集合、窗口 W1 的数据');

    const byNumber = runTasks(['3'], { DB_PATH: dbPath });
    expect(byNumber.status).toBe(0);
    expect(byNumber.stdout).toContain('任务 #3 帮我看看那边的情况');

    const byInternalId = runTasks(['task_completed'], { DB_PATH: dbPath });
    expect(byInternalId.status).toBe(0);
    expect(byInternalId.stdout).toContain('任务 #1 帮我查一下 beta 集合、窗口 W1 的数据');

    const absent = runTasks(['#99'], { DB_PATH: dbPath });
    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain('找不到任务：#99');
  });

  it('详情：机械事实词 + 执行行原值；无最终回复存档给机械标注', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const ok = runTasks(['task_completed'], { DB_PATH: dbPath });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('事实：已汇报');
    expect(ok.stdout).toContain('1. dummy.query  完成');
    expect(ok.stdout).toContain('任务结果：\n已查询 beta 集合（窗口 W1）：3 条记录。');
    expect(ok.stdout).toContain('最终回复：\n已查到 beta 集合（窗口 W1）共 3 条记录，需要明细我再继续。');

    const bad = runTasks(['task_failed'], { DB_PATH: dbPath });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toContain('事实：已汇报');
    expect(bad.stdout).toContain('1. dummy.query  失败  Collection faulty-one cannot be read in its current state');
    expect(bad.stdout).toContain('任务结果：\n执行层报告 faulty-one 读取故障，未能返回数据。');
    expect(bad.stdout).not.toContain('失败原因：');

    const none = runTasks(['task_unexecuted'], { DB_PATH: dbPath });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('事实：已汇报');
    expect(none.stdout).toContain('（无：本次任务未向执行层发起任何调用）');
    expect(none.stdout).toContain('该任务无最终回复存档');

    const noReport = runTasks(['task_no_report'], { DB_PATH: dbPath });
    expect(noReport.stdout).toContain('事实：无汇报收尾');
    expect(noReport.stdout).toContain('任务结果：\n（无）');
  });

  it('错误态：未知 id exit 2；缺库空态 exit 0 且不创建文件/目录；0 字节库报不可读', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const unknown = runTasks(['task_absent'], { DB_PATH: dbPath });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('找不到任务：task_absent');

    const missing = path.join(dir, 'nested', 'state.db');
    const empty = runTasks([], { DB_PATH: missing });
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain('还没有任务记录');
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(path.dirname(missing))).toBe(false);

    const emptyDetail = runTasks(['task_x'], { DB_PATH: missing });
    expect(emptyDetail.status).toBe(2);
    expect(emptyDetail.stderr).toContain('找不到任务');

    const zeroByte = path.join(dir, 'zero.db');
    writeFileSync(zeroByte, '');
    const broken = runTasks([], { DB_PATH: zeroByte });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('任务底账不可读');
  });

  it('只读：列表/详情前后主库哈希不变', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const before = sha256(dbPath);
    expect(runTasks([], { DB_PATH: dbPath }).status).toBe(0);
    expect(runTasks(['task_failed'], { DB_PATH: dbPath }).status).toBe(0);
    expect(sha256(dbPath)).toBe(before);
  });

  it('只读打开升级前的 v5 库：已取消行按已取消显示（不标结果未知），旧列原时刻可读，不写库', () => {
    const dir = tempDir();
    const dbPath = seedV5Db(dir);
    const before = sha256(dbPath);

    // 反向绊线：只读投影忽略旧终态列 → cancelled 行按「已启动无汇报」判 died，列表/详情出现「结果未知」。
    const list = runTasks([], { DB_PATH: dbPath });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('已取消');
    const detail = runTasks(['task_v5_cancelled'], { DB_PATH: dbPath });
    expect(detail.status).toBe(0);
    expect(detail.stdout).toContain('事实：已取消');
    expect(detail.stdout).toContain('机械事实：用户已取消（2026-11-20T08:11:00.000Z）');
    expect(detail.stdout).not.toContain('结果未知');

    // died 行仍按真实种类显示（不是把旧列一律当 cancelled）。
    const died = runTasks(['task_v5_died'], { DB_PATH: dbPath });
    expect(died.status).toBe(0);
    expect(died.stdout).toContain('结果未知');

    // 只读：不迁移、不写库。
    expect(sha256(dbPath)).toBe(before);
  });

  it('--config：显式配置的 store.dbPath 生效；用法错误 exit 2', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const configPath = path.join(dir, 'agent.yaml');
    writeFileSync(configPath, `principals: {}\ncontextProfiles: {}\nstore:\n  dbPath: ${dbPath}\n`);
    const run = runTasks([`--config=${configPath}`], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('#1 帮我查一下 beta 集合、窗口 W1 的数据');

    const usage = runTasks(['a', 'b'], {});
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('用法');
  });

  it('导出用法：--out 无值 / 无 taskId → exit 2 明确用法提示，不产生文件（P2）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const noValue = runTasks(['task_completed', '--out'], { DB_PATH: dbPath });
    expect(noValue.status).toBe(2);
    expect(noValue.stderr).toContain('--out 缺少文件路径');

    const orphan = runTasks(['--out', path.join(dir, 'orphan.md')], { DB_PATH: dbPath });
    expect(orphan.status).toBe(2);
    expect(orphan.stderr).toContain('taskId');
    expect(existsSync(path.join(dir, 'orphan.md'))).toBe(false);
  });

  it('导出：生成交付件；详情正文逐行在场；重复导出逐字节一致；主库哈希不变（P2）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const before = sha256(dbPath);
    const out1 = path.join(dir, 'deliverable-1.md');
    const out2 = path.join(dir, 'deliverable-2.md');

    const detail = runTasks(['task_failed'], { DB_PATH: dbPath });
    expect(detail.status).toBe(0);

    const run = runTasks(['task_failed', '--out', out1], { DB_PATH: dbPath });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`已导出任务交付件：${out1}`);
    expect(run.stdout).toContain('任务底账：');

    const text = readFileSync(out1, 'utf8');
    expect(text.startsWith('# 任务交付件：#2 帮我查一下 faulty-one 集合的数据（已汇报）\n')).toBe(true);
    expect(text).toContain('1. dummy.query  失败  Collection faulty-one cannot be read in its current state');
    expect(text).toContain('任务结果：\n执行层报告 faulty-one 读取故障，未能返回数据。');
    const detailLines = detail.stdout.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('任务底账：'));
    const textLines = text.split('\n');
    for (const line of detailLines) expect(textLines).toContain(line);

    const again = runTasks(['task_failed', '--out', out2], { DB_PATH: dbPath });
    expect(again.status).toBe(0);
    expect(readFileSync(out2, 'utf8')).toBe(text);

    expect(sha256(dbPath)).toBe(before);
  });

  it('导出边界：未知 id / 缺库 / 目标已存在（文件与目录）/ 父目录缺失 → exit 2 且不产生或不动文件（P2）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const unknownOut = path.join(dir, 'unknown.md');
    const unknown = runTasks(['task_absent', '--out', unknownOut], { DB_PATH: dbPath });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('找不到任务：task_absent');
    expect(existsSync(unknownOut)).toBe(false);

    const missingDb = path.join(dir, 'nope', 'state.db');
    const missingOut = path.join(dir, 'missing-db.md');
    const missing = runTasks(['task_x', '--out', missingOut], { DB_PATH: missingDb });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('找不到任务');
    expect(existsSync(missingOut)).toBe(false);
    expect(existsSync(path.dirname(missingDb))).toBe(false);

    const existing = path.join(dir, 'existing.md');
    writeFileSync(existing, '原有内容\n');
    const existsRun = runTasks(['task_completed', '--out', existing], { DB_PATH: dbPath });
    expect(existsRun.status).toBe(2);
    expect(existsRun.stderr).toContain('输出文件已存在');
    expect(readFileSync(existing, 'utf8')).toBe('原有内容\n');

    const dirTarget = path.join(dir, 'dir-target');
    mkdirSync(dirTarget);
    const dirRun = runTasks(['task_completed', '--out', dirTarget], { DB_PATH: dbPath });
    expect(dirRun.status).toBe(2);
    expect(dirRun.stderr).toContain('输出文件已存在');
    expect(existsSync(dirTarget)).toBe(true);

    const nested = path.join(dir, 'nested', 'out.md');
    const noDir = runTasks(['task_completed', '--out', nested], { DB_PATH: dbPath });
    expect(noDir.status).toBe(2);
    expect(noDir.stderr).toContain('输出目录不存在');
    expect(existsSync(path.join(dir, 'nested'))).toBe(false);
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('导出边界：目录不可写 → exit 1，无半成品文件（P2）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const locked = path.join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const out = path.join(locked, 'out.md');
      const run = runTasks(['task_completed', '--out', out], { DB_PATH: dbPath });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('无法写入输出文件');
      expect(existsSync(out)).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('导出：相对路径以 INIT_CWD（调用点目录）为基准，不落在进程 cwd（P2）', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const invocation = path.join(dir, 'invocation');
    mkdirSync(invocation);

    const run = runTasks(['task_completed', '--out', 'rel.md'], { DB_PATH: dbPath, INIT_CWD: invocation });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`已导出任务交付件：${path.join(invocation, 'rel.md')}`);
    const exported = readFileSync(path.join(invocation, 'rel.md'), 'utf8');
    expect(exported).toContain('任务 #1 帮我查一下 beta 集合、窗口 W1 的数据');
    expect(exported).toContain('最终回复：\n已查到 beta 集合（窗口 W1）共 3 条记录，需要明细我再继续。');
  });
});
