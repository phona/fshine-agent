/**
 * tasks 任务查看 CLI（P1）：
 *   · 用户视角：最近任务列表（时间/状态中文词/摘要/id）与单任务详情（状态/原因/执行步骤/任务结果）；
 *   · 状态与失败原因必须与 judgeReportedTask 同语义（词表键绑定其返回类型，测试逐组比对）；
 *   · 只读：库文件哈希不变、缺库不创建；缺库空态、未知 id 错误态；
 *   · e2e 用真实子进程跑 `scripts/tasks.ts`（仓内 dummy 面，不触网、不碰真实平台）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@fshine/core';
import {
  createTaskRegistry,
  judgeReportedTask,
  type ExecutionRecord,
  type TaskRecord,
} from '../packages/agent/src/task-registry';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { materializeEvalConfig } from './resolve-config-path';
import {
  JUDGED_STATUS_WORDS,
  formatLocalTime,
  parseTaskArgs,
  renderTaskDetail,
  renderTaskList,
  resolveTaskDbPath,
  summarizeRequest,
  taskStatusWord,
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
    status: 'completed',
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

describe('tasks：状态词表与 judgeReportedTask 一致', () => {
  it('执行事实矩阵 → 词表与 judgeReportedTask 输出一一对应', () => {
    const matrix: Array<[readonly ExecutionRecord[], string]> = [
      [[], '未执行'],
      [[execution('completed')], '已完成'],
      [[execution('failed', '执行层调用超时。')], '失败'],
      [[execution('refused', '执行层策略拒绝。')], '失败'],
      [[execution('needs_input')], '失败'],
      [[execution('failed', '第一次参数错误。'), execution('completed')], '失败'],
      [[execution('completed'), execution('failed', '第二次超时。')], '失败'],
    ];
    for (const [executions, expected] of matrix) {
      const judged = judgeReportedTask(executions);
      expect(taskStatusWord(judged.status)).toBe(expected);
      expect(JUDGED_STATUS_WORDS[judged.status]).toBe(expected);
    }
    expect(taskStatusWord('running')).toBe('进行中');
  });

  it('注册表终态 → 展示词：正常路径与 fail 路径；fail 路径零执行仍是「失败」', () => {
    const registry = createTaskRegistry();
    const scope = { principalId: 'p', sessionId: 's' };
    registry.begin({ taskId: 't_done', ...scope, request: '查 beta' });
    registry.noteExecution('t_done', { requestId: 'r1', operation: 'dummy.query', status: 'completed' });
    registry.complete('t_done', '已查询 beta：3 条。');
    registry.begin({ taskId: 't_none', ...scope, request: '看看' });
    registry.complete('t_none', '本轮未发起调用。');
    registry.begin({ taskId: 't_fail', ...scope, request: '查 faulty-one' });
    registry.noteExecution('t_fail', {
      requestId: 'r2',
      operation: 'dummy.query',
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: '读取故障。' },
    });
    registry.complete('t_fail', '执行层报错。');
    registry.begin({ taskId: 't_worker', ...scope, request: '查 documents' });
    registry.fail('t_worker', '执行层 Worker 未产出有效汇报，本次任务未完成。');

    expect(registry.list().map((task) => taskStatusWord(task.status)))
      .toEqual(['已完成', '未执行', '失败', '失败']);
    // 读存储值（fail 路径零执行不重算成「未执行」）。
    expect(taskStatusWord(registry.get('t_worker', scope).status)).toBe('失败');
  });
});

describe('tasks：列表与详情渲染', () => {
  it('列表：最新在前；超过 20 条只显示最近 20 条并提示总数', () => {
    const records = Array.from({ length: 25 }, (_, index) => record({
      taskId: `task_${String(index).padStart(2, '0')}`,
      request: `任务 ${index}`,
      createdAt: `2026-11-13T16:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const text = renderTaskList(records);
    expect(text).toContain('最近任务（共 25 条，仅显示最近 20 条）');
    expect(text.match(/^ {2}id: /gm)?.length).toBe(20);
    const rows = text.split('\n').filter((line) => line.startsWith('2026-'));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain('任务 24');
    expect(rows[19]).toContain('任务 5');
    expect(text).not.toMatch(/任务 4\n/);
    expect(text).toContain('已完成');
  });

  it('详情：完成/失败/未执行/worker 失败四形态字段齐全', () => {
    const okText = renderTaskDetail(record({
      taskId: 'task_ok',
      status: 'completed',
      resultText: '已查询 beta：3 条。',
      executions: [execution('completed')],
    }));
    expect(okText).toContain('任务 task_ok');
    expect(okText).toContain('状态：已完成');
    expect(okText).toContain('交办：帮我查一下 beta 集合、窗口 W1 的数据');
    expect(okText).toContain('1. dummy.query  完成');
    expect(okText).toContain('任务结果：\n已查询 beta：3 条。');
    expect(okText).not.toContain('失败原因：');

    const badText = renderTaskDetail(record({
      taskId: 'task_bad',
      status: 'failed',
      failureReason: '执行层未成功：dummy.query 返回 failed：读取故障。',
      resultText: '执行层报告读取故障。',
      executions: [execution('failed', '读取故障。')],
    }));
    expect(badText).toContain('状态：失败');
    expect(badText).toContain('失败原因：执行层未成功：dummy.query 返回 failed：读取故障。');
    expect(badText).toContain('1. dummy.query  失败  读取故障。');

    const noneText = renderTaskDetail(record({
      taskId: 'task_none',
      status: 'unexecuted',
      failureReason: '未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。',
      resultText: '本轮未发起调用。',
      executions: [],
    }));
    expect(noneText).toContain('状态：未执行');
    expect(noneText).toContain('未执行原因：未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。');
    expect(noneText).toContain('（无：本次任务未向执行层发起任何调用）');

    const workerText = renderTaskDetail(record({
      taskId: 'task_worker',
      status: 'failed',
      failureReason: '执行层 Worker 未产出有效汇报，本次任务未完成。',
      executions: [],
    }));
    expect(workerText).toContain('失败原因：执行层 Worker 未产出有效汇报，本次任务未完成。');
    expect(workerText).toContain('任务结果：\n（无）');
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

/** e2e：真实子进程跑 CLI（与 `npm run tasks` 同 flag 形态）。 */
function runTasks(args: string[], env: Record<string, string | undefined> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_CONFIG_PATH: '' };
  delete childEnv['DB_PATH'];
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

describe('tasks：CLI 端到端（真实子进程）', () => {
  it('列表：三类状态以中文呈现，含摘要与 id', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const run = runTasks([], { DB_PATH: dbPath });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('最近任务（共 4 条）');
    expect(run.stdout).toContain('已完成');
    expect(run.stdout).toContain('失败');
    expect(run.stdout).toContain('未执行');
    expect(run.stdout).toContain('帮我查一下 beta 集合、窗口 W1 的数据');
    expect(run.stdout).toContain('id: task_completed');
    expect(run.stdout).toContain('任务底账：');
  });

  it('详情：失败原因与 judgeReportedTask 同文本；未执行有零执行提示；完成无失败原因', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);

    const ok = runTasks(['task_completed'], { DB_PATH: dbPath });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('状态：已完成');
    expect(ok.stdout).toContain('1. dummy.query  完成');
    expect(ok.stdout).toContain('任务结果：\n已查询 beta 集合（窗口 W1）：3 条记录。');
    expect(ok.stdout).not.toContain('失败原因：');

    const bad = runTasks(['task_failed'], { DB_PATH: dbPath });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toContain('状态：失败');
    const judged = judgeReportedTask([{
      operation: 'dummy.query',
      status: 'failed',
      error: { code: 'COLLECTION_FAULT', message: 'Collection faulty-one cannot be read in its current state' },
    }]);
    expect(judged.failureReason).toBeDefined();
    expect(bad.stdout).toContain(`失败原因：${judged.failureReason ?? ''}`);
    expect(bad.stdout).toContain('1. dummy.query  失败  Collection faulty-one cannot be read in its current state');
    expect(bad.stdout).not.toContain('未执行原因');

    const none = runTasks(['task_unexecuted'], { DB_PATH: dbPath });
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('状态：未执行');
    expect(none.stdout).toContain('未执行原因：未发起执行：Worker 已汇报，但本次委派没有向执行层发起任何调用。');
    expect(none.stdout).toContain('（无：本次任务未向执行层发起任何调用）');

    const worker = runTasks(['task_worker_failed'], { DB_PATH: dbPath });
    expect(worker.stdout).toContain('状态：失败');
    expect(worker.stdout).toContain('失败原因：执行层 Worker 未产出有效汇报，本次任务未完成。');
    expect(worker.stdout).toContain('任务结果：\n（无）');
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

  it('--config：显式配置的 store.dbPath 生效；用法错误 exit 2', () => {
    const dir = tempDir();
    const dbPath = seedDb(dir);
    const configPath = path.join(dir, 'agent.yaml');
    writeFileSync(configPath, `principals: {}\ncontextProfiles: {}\nstore:\n  dbPath: ${dbPath}\n`);
    const run = runTasks([`--config=${configPath}`], {});
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('id: task_completed');

    const usage = runTasks(['a', 'b'], {});
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('用法');
  });
});
