/**
 * 结构化入参 payload：records（owner 2026-11-19）。
 *
 * 判据：模型只交**结构化值**（数组），宿主按执行层声明的 schema lint → 物化成文件 →
 * 把路径交给执行层；模型不再手写 JSON 字符串。任何形状不对都在**发起执行之前**被宿主
 * 拒绝（`payload_lint_rejected`），执行层一次都不会被调用。
 *
 * 本套件（真装配：createSession + 真 dummy CLI + 真任务文件桥）：
 *   ① 合法值：宿主 lint 通过、物化，执行层拿到解析后的数组（逐条相等，且不是字符串）；
 *   ② 交错形状：records 传 JSON 字符串 / 某条缺 value → 宿主 lint 拒绝 + 可修复话术 + 零执行；
 *   ③ 既有口径：501 条（执行层上限）与缺 collection 仍按原口径拒绝；
 *   ④ 反向绊线见文件尾注（人工实测：声明退回普通 flag → ①/②/守卫红；跳过 lint → ② 红）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { failureMessageFor, internalTermIn } from './src/user-facing-failure';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutionBridge } from './src/task-file-bridge';
import { createFileStore, type FileScope } from './src/file-store';
import { createSession, type ExecutionEvent, type Session } from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';

const FIXTURE_ROOT = path.resolve(__dirname, '../../scripts/eval/fixtures/dummy-platform');
const SCOPE: FileScope = { principalId: 'wecom:payload-records', sessionId: 'sess_payload_records' };
const RECORDS = [
  { name: 'alpha-item-3', value: 100 },
  { name: 'alpha-item-4', value: 200 },
  { name: 'alpha-item-5', value: 300 },
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
      await input.exec('task_run', { task: '新增两条记录' });
      const message = { role: 'assistant', content: [{ type: 'text', text: '已交办。' }], timestamp: Date.now() } as unknown as DriverMessage;
      return { text: '已交办。', messages: [message] } as unknown as TurnDriverResult;
    },
  };
}

interface CapturedCall {
  operation: string;
  /** 执行层实际收到的 records 参数（宿主替换后应为文件路径）。 */
  received: unknown;
  /** 从物化文件解析出来的数组（执行层读到的内容）。 */
  parsed?: unknown;
}

interface Fixture {
  dir: string;
  session: Session;
  worker: WorkerFx;
  events: ExecutionEvent[];
  captured: CapturedCall[];
  /** 执行层真实被调用次数（lint 失败必须为 0）。 */
  executeCalls(): number;
  auditRows(): Array<Record<string, unknown>>;
}

async function makeFixture(workerCalls: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-records-'));
  dirs.push(dir);
  const platformRoot = path.join(dir, 'platform');
  mkdirSync(platformRoot, { recursive: true });
  const stateDir = path.join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const rawClient = createDummyCliClient({
    root: FIXTURE_ROOT,
    gateway: 'bin/dummy',
    stateDir,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
  });
  const captured: CapturedCall[] = [];
  let executeCalls = 0;
  const client: ExecutionClient = {
    capabilities: (): Promise<CapabilityManifest> => rawClient.capabilities(),
    execute: async (request: ExecutionRequest, callOptions) => {
      executeCalls += 1;
      const received = request.args['records'];
      if (typeof received === 'string' && existsSync(received)) {
        captured.push({ operation: request.operation, received, parsed: JSON.parse(readFileSync(received, 'utf8')) });
      } else {
        captured.push({ operation: request.operation, received });
      }
      return rawClient.execute(request, callOptions);
    },
  };
  const bridgeFactory = createTaskExecutionBridge({ platformRoot, fileStore, scope: SCOPE, inner: client });
  const worker = workerDriver(workerCalls);
  const events: ExecutionEvent[] = [];
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client,
    allowedOperations: ['dummy.prepare', 'dummy.commit'],
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
    session,
    worker: worker.fx,
    events,
    captured,
    executeCalls: () => executeCalls,
    auditRows: () => {
      if (!existsSync(auditPath)) return [];
      return readFileSync(auditPath, 'utf8')
        .trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

const PREPARE_OP = 'dummy.prepare';

describe('① 模型交结构化值 → 宿主 lint + 物化 → 执行层读到解析后的数组', () => {
  it('执行层收到的 records 逐条等于模型给的值；载体是文件路径，不是字符串化数组', async () => {
    const fx = await makeFixture([
      { tool: 'execute_operation', args: { operation: PREPARE_OP, args: { collection: 'alpha', window: 'W1', records: RECORDS } } },
    ]);
    await fx.session.send('在 alpha 新增三条记录');

    expect(fx.worker.errors).toEqual([]);
    expect(fx.executeCalls()).toBe(1);
    // 执行层拿到的是宿主物化的**路径**，文件内容解析出来逐条等于模型给的值。
    expect(fx.captured).toHaveLength(1);
    const call = fx.captured[0]!;
    expect(typeof call.received).toBe('string');
    expect(Array.isArray(call.parsed)).toBe(true);
    expect(call.parsed).toEqual(RECORDS);
    // 执行层确实解析并逐条使用了数组：提案条数 = 记录数，摘要列出逐条 name=value。
    const outcome = fx.worker.results[0] as {
      status?: string;
      data?: { count?: number };
      summary?: string;
    };
    expect(outcome.status).toBe('needs_confirmation');
    expect(outcome.data?.count).toBe(RECORDS.length);
    expect(outcome.summary).toContain('alpha-item-3=100');
    expect(outcome.summary).toContain('alpha-item-4=200');
    expect(outcome.summary).toContain('alpha-item-5=300');
    // 审计行（执行层自己的账）记录的是路径，不是内联数组。
    const rows = fx.auditRows().filter((row) => row['script'] === PREPARE_OP);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof (rows[rows.length - 1]!['args'] as Record<string, unknown>)['records']).toBe('string');
    expect(fx.session.tasks()[0]?.executions).toHaveLength(1);
  }, 60_000);
});

describe('② 模型交错形状 → 宿主 lint 拒绝 + 可修复话术 + 零执行', () => {
  it('records 传 JSON 字符串 → 宿主拒绝（不是透传给执行层）', async () => {
    const fx = await makeFixture([
      {
        tool: 'execute_operation',
        args: { operation: PREPARE_OP, args: { collection: 'alpha', window: 'W1', records: JSON.stringify(RECORDS) } },
      },
    ]);
    await fx.session.send('在 alpha 新增三条记录');

    expect(fx.worker.errors).toHaveLength(1);
    const message = fx.worker.errors[0]!.message;
    expect(message).toBe(failureMessageFor('invalid_input').text);
    expect(message).toContain('内容不行');
    expect(internalTermIn(message), message).toBeUndefined();
    // 零执行事实：执行层一次都没被调用。
    expect(fx.executeCalls()).toBe(0);
    expect(fx.auditRows()).toEqual([]);
    expect(fx.session.tasks()[0]?.executions ?? []).toHaveLength(0);
    // 事件走既有通路，unknown 指到根值形态。
    expect(fx.events).toHaveLength(1);
    expect(fx.events[0]).toMatchObject({
      event: 'payload_lint_rejected',
      operation: PREPARE_OP,
      missing: [],
      unknown: ['(root)'],
    });
  }, 60_000);

  it('某条缺 value → 宿主拒绝并指到具体条目（missing 路径），执行层零调用', async () => {
    const fx = await makeFixture([
      {
        tool: 'execute_operation',
        args: {
          operation: PREPARE_OP,
          args: {
            collection: 'alpha',
            window: 'W1',
            records: [{ name: 'alpha-item-3', value: 1 }, { name: 'alpha-item-4' }],
          },
        },
      },
    ]);
    await fx.session.send('在 alpha 新增两条记录');

    expect(fx.worker.errors).toHaveLength(1);
    expect(fx.worker.errors[0]!.message).toBe(failureMessageFor('invalid_input').text);
    expect(fx.executeCalls()).toBe(0);
    expect(fx.auditRows()).toEqual([]);
    expect(fx.events).toHaveLength(1);
    expect(fx.events[0]).toMatchObject({
      event: 'payload_lint_rejected',
      operation: PREPARE_OP,
      missing: ['[1].value'],
      unknown: [],
    });
  }, 60_000);
});

describe('③ 既有口径不回归（执行层自己的门仍生效）', () => {
  function rawClient() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-records-raw-'));
    dirs.push(dir);
    const stateDir = path.join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    return createDummyCliClient({
      root: FIXTURE_ROOT,
      gateway: 'bin/dummy',
      stateDir,
      env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    });
  }

  function recordsPath(records: unknown): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'payload-records-file-'));
    dirs.push(dir);
    const file = path.join(dir, 'records.json');
    writeFileSync(file, JSON.stringify(records));
    return file;
  }

  it('501 条：执行层仍报「单次写入上限 500 条」，不教分批', async () => {
    const client = rawClient();
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ name: `limit-item-${index + 1}`, value: index + 1 }));
    const outcome = await client.execute({
      requestId: 'req_over_limit',
      dispatchKey: 'dk_over_limit',
      operation: PREPARE_OP,
      args: { collection: 'alpha', window: 'W1', records: recordsPath(tooMany) },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('INVALID_RECORDS');
      expect(outcome.error.message).toContain('超过执行层单次写入上限 500 条');
      expect(outcome.error.message).not.toContain('分批');
    }
  }, 20_000);

  it('缺 collection：执行层仍报 QUERY_REQUIRED（宿主不为执行层补业务校验）', async () => {
    const client = rawClient();
    const outcome = await client.execute({
      requestId: 'req_missing_collection',
      dispatchKey: 'dk_missing_collection',
      operation: PREPARE_OP,
      args: { window: 'W1', records: recordsPath(RECORDS) },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('QUERY_REQUIRED');
  }, 20_000);
});

/**
 * ④ 反向绊线（人工实测，已还原）：
 *   · 把 `dummy.prepare` 的 records 退回普通 `--records` flag（capabilities.json）→
 *     ① 红（宿主无 payload 声明、不 lint：执行层收到内联数组并报 INVALID_RECORDS）；
 *     ② 红（字符串直接到执行层，宿主零事件）；payload-declaration-guard ①/③ 红。
 *   · 让宿主跳过数组 lint（lintValue 对 type=array 直接 return）→ ② 两例红（字符串/缺 value
 *     都被物化进执行层，`payload_lint_rejected` 事件数为 0）。
 */
