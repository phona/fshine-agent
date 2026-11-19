/**
 * 载荷型参数：宿主装信封（owner 2026-11-19 拍板的设计）。
 *
 * 判据：Worker 只关心「要执行什么」，不关心「怎么装信封」——模型只给业务**值**（对象/数组），
 * 宿主负责 lint → 序列化落盘 → 把路径翻译进参数 → 才提交执行层。lint 不通过：绝不得到执行面，
 * 返回业务话术让模型一轮改对，并落结构化事件；同一回合同一 operation 连续失败超过上限即
 * 确定性停下。
 *
 * 本套件两段：
 *   A. materializer 单测（纯函数）：合法 / 缺字段 / 未知字段 / 非对象 / 超大；
 *   B. 端到端（**真装配**：createSession + 真 dummy CLI 子进程 + 真任务文件桥）：
 *      ① 模型给合法值 → 宿主落盘 → 执行层读到文件并完成（断言执行层收到的参数是路径、
 *         文件内容等于模型给的值）；
 *      ② 模型给未知字段 → 零执行事实、话术含「内容不行」且不含内部术语、事件落一条；
 *      ③ 连续 3 次同样错误 → 第 3 次被确定性停下（执行层仍零调用）。
 *
 * 反向绊线（人工实测后还原，见提交说明）：把 lint 挪到「调用之后」→ ② 红；去掉 ≤2 次上限 → ③ 红。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failureMessageFor, internalTermIn } from './src/user-facing-failure';
import { lintPayload, materializePayload } from './src/payload-materializer';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutionBridge } from './src/task-file-bridge';
import { createFileStore, type FileScope } from './src/file-store';
import { createSession, type ExecutionEvent, type Session } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';

const FIXTURE_ROOT = path.resolve(__dirname, '../../scripts/eval/fixtures/dummy-platform');
const SCOPE: FileScope = { principalId: 'wecom:payload-user', sessionId: 'sess_payload' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. materializer 单测（纯函数，零装配）
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'object',
  required: ['collection', 'window', 'records'],
  additionalProperties: false,
  properties: {
    collection: { type: 'string' },
    window: { type: 'string' },
    records: { type: 'array' },
  },
};

describe('A. 载荷 materializer（窄结构校验 + 原子落盘）', () => {
  it('合法值：lint 通过，落盘到 <taskDir>/in/<label>.json，内容就是给出的值', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-mat-'));
    dirs.push(dir);
    const value = { collection: 'alpha', window: 'W1', records: [{ name: 'a', value: 1 }] };
    const result = materializePayload({ taskDir: dir, label: 'payload', value, schema: SCHEMA });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('应物化成功');
    expect(result.path).toBe(path.join(dir, 'in', 'payload.json'));
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual(value);
  });

  it('缺必填字段：missing 非空、unknown 为空，不落盘', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-mat-'));
    dirs.push(dir);
    const result = materializePayload({ taskDir: dir, label: 'payload', value: { collection: 'alpha' }, schema: SCHEMA });
    expect(result).toEqual({ ok: false, missing: ['window', 'records'], unknown: [] });
    expect(existsSync(path.join(dir, 'in', 'payload.json'))).toBe(false);
  });

  it('未知字段：unknown 非空、missing 为空，不落盘', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-mat-'));
    dirs.push(dir);
    const result = materializePayload({
      taskDir: dir,
      label: 'payload',
      value: { collection: 'alpha', window: 'W1', records: [], bump: 1 },
      schema: SCHEMA,
    });
    expect(result).toEqual({ ok: false, missing: [], unknown: ['bump'] });
    expect(existsSync(path.join(dir, 'in', 'payload.json'))).toBe(false);
  });

  it('非对象：必填视为全缺、unknown 为空，不落盘', () => {
    expect(lintPayload('not-an-object', SCHEMA)).toEqual({ missing: ['collection', 'window', 'records'], unknown: [] });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-mat-'));
    dirs.push(dir);
    expect(materializePayload({ taskDir: dir, label: 'payload', value: 42, schema: SCHEMA }).ok).toBe(false);
  });

  it('值类型不符（records 不是数组）：落 unknown、不落盘', () => {
    expect(lintPayload({ collection: 'a', window: 'W1', records: 'x' }, SCHEMA)).toEqual({ missing: [], unknown: ['records'] });
  });

  it('超大：超过 maxBytes 即拒（missing/unknown 都为空），不落盘', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-mat-'));
    dirs.push(dir);
    const value = { collection: 'alpha', window: 'W1', records: [{ name: 'x'.repeat(500), value: 1 }] };
    const result = materializePayload({ taskDir: dir, label: 'payload', value, schema: SCHEMA, maxBytes: 64 });
    expect(result).toEqual({ ok: false, missing: [], unknown: [] });
    expect(existsSync(path.join(dir, 'in', 'payload.json'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 端到端（真装配）
// ─────────────────────────────────────────────────────────────────────────────

interface ExecError {
  tool: string;
  message: string;
  name?: string;
}

interface WorkerFx {
  results: unknown[];
  errors: ExecError[];
}

function workerDriver(calls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>): { driver: TurnDriver; fx: WorkerFx } {
  const fx: WorkerFx = { results: [], errors: [] };
  const driver: TurnDriver = {
    async run(input) {
      for (const call of calls) {
        try {
          fx.results.push(await input.exec(call.tool, call.args));
        } catch (error) {
          fx.errors.push({
            tool: call.tool,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error ? { name: error.name } : {}),
          });
        }
      }
      const message = { role: 'assistant', content: [{ type: 'text', text: '完成' }], timestamp: Date.now() } as unknown as DriverMessage;
      return { text: '完成', messages: [message] } as unknown as TurnDriverResult;
    },
  };
  return { driver, fx };
}

function mainDriver(): TurnDriver {
  return {
    async run(input) {
      await input.exec('task_run', { task: '创建变更提案' });
      const message = { role: 'assistant', content: [{ type: 'text', text: '已交办。' }], timestamp: Date.now() } as unknown as DriverMessage;
      return { text: '已交办。', messages: [message] } as unknown as TurnDriverResult;
    },
  };
}

interface Fixture {
  dir: string;
  stateDir: string;
  session: Session;
  worker: WorkerFx;
  events: ExecutionEvent[];
  auditRows(): Array<Record<string, unknown>>;
}

async function makeFixture(workerCalls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-lint-'));
  dirs.push(dir);
  const platformRoot = path.join(dir, 'platform');
  mkdirSync(platformRoot, { recursive: true });
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const client = createDummyCliClient({
    root: FIXTURE_ROOT,
    gateway: 'bin/dummy',
    stateDir,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
  });
  const bridgeFactory = createTaskExecutionBridge({ platformRoot, fileStore, scope: SCOPE, inner: client });
  const worker = workerDriver(workerCalls);
  const events: ExecutionEvent[] = [];
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client,
    allowedOperations: ['dummy.proposal'],
    mainDriver: mainDriver(),
    workerDriver: worker.driver,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    taskExecutionBridge: bridgeFactory,
    onExecutionEvent: (event) => events.push(event),
  });
  const auditPath = path.join(stateDir, 'audit.jsonl');
  return {
    dir,
    stateDir,
    session,
    worker: worker.fx,
    events,
    auditRows: () => {
      if (!existsSync(auditPath)) return [];
      return readFileSync(auditPath, 'utf8')
        .trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

const VALID_PAYLOAD = { collection: 'alpha', window: 'W1', records: [{ name: 'rec-a', value: 11 }] };

describe('B. 载荷型参数端到端（真 dummy 装配）', () => {
  it('① 合法值：执行层收到的是路径；文件内容等于模型给的值；执行完成', async () => {
    const fx = await makeFixture([
      { tool: 'execute_operation', args: { operation: 'dummy.proposal', args: { payload: VALID_PAYLOAD } } },
    ]);
    await fx.session.send('创建变更提案');

    // 执行完成（不是被拦）。
    expect(fx.worker.errors).toEqual([]);
    const outcome = fx.worker.results[0] as Record<string, unknown>;
    expect(outcome['status']).toBe('completed');
    expect((outcome['data'] as { count?: number }).count).toBe(1);

    // 执行层收到的参数是**路径**（不是模型给的对象）：审计行里的 args.payload。
    const rows = fx.auditRows().filter((row) => row['script'] === 'dummy.proposal');
    expect(rows.length).toBeGreaterThan(0);
    const received = rows[rows.length - 1]!['args'] as { payload?: unknown };
    expect(typeof received.payload).toBe('string');
    const receivedPath = received.payload as string;
    expect(receivedPath).toContain(path.join('tmp', 'task_'));
    expect(path.basename(receivedPath)).toBe('payload.json');
    // 文件内容等于模型给的值。
    expect(JSON.parse(readFileSync(receivedPath, 'utf8'))).toEqual(VALID_PAYLOAD);

    // 真的写入了执行事实（一次调用）。
    expect(fx.session.tasks()[0]?.executions).toHaveLength(1);
  }, 60_000);

  it('② 未知字段：零执行事实、话术含「内容不行」且不含内部术语、事件落一条', async () => {
    const fx = await makeFixture([
      {
        tool: 'execute_operation',
        args: { operation: 'dummy.proposal', args: { payload: { ...VALID_PAYLOAD, bogus: 1 } } },
      },
    ]);
    await fx.session.send('创建变更提案');

    // 模型收到业务话术：含「内容不行」，且过内部术语闸。
    expect(fx.worker.errors).toHaveLength(1);
    const message = fx.worker.errors[0]!.message;
    expect(message).toContain('内容不行');
    expect(internalTermIn(message), message).toBeUndefined();
    expect(message).toBe(failureMessageFor('invalid_input').text);

    // 零执行事实：执行层从未被调用（无审计），底账无执行行。
    expect(fx.auditRows()).toEqual([]);
    expect(fx.session.tasks()[0]?.executions ?? []).toHaveLength(0);

    // 事件落一条（结构化 missing/unknown 只进日志）。
    expect(fx.events).toHaveLength(1);
    expect(fx.events[0]).toMatchObject({
      event: 'payload_lint_rejected',
      operation: 'dummy.proposal',
      missing: [],
      unknown: ['bogus'],
    });
  }, 60_000);

  it('③ 连续 3 次同样错误：第 3 次被确定性停下，执行层仍零调用', async () => {
    const bad = { tool: 'execute_operation', args: { operation: 'dummy.proposal', args: { payload: { ...VALID_PAYLOAD, bogus: 1 } } } };
    const fx = await makeFixture([bad, bad, bad]);
    await fx.session.send('创建变更提案');

    // 三次都被拦（模型收到了错误），但第 3 次是「先停下来看看」的确定性话术。
    expect(fx.worker.errors).toHaveLength(3);
    expect(fx.worker.errors[0]!.message).toContain('内容不行');
    expect(fx.worker.errors[1]!.message).toContain('内容不行');
    expect(fx.worker.errors[2]!.name).toBe('ToolUserError');
    expect(fx.worker.errors[2]!.message).toContain('停下来');

    // 前两次 lint 失败各落一条事件；第 3 次确定性停下不再 lint（不再落事件）。
    expect(fx.events.map((event) => event.event)).toEqual(['payload_lint_rejected', 'payload_lint_rejected']);

    // 执行层仍零调用。
    expect(fx.auditRows()).toEqual([]);
    expect(fx.session.tasks()[0]?.executions ?? []).toHaveLength(0);
  }, 60_000);
});
