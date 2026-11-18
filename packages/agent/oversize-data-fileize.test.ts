/**
 * 大响应文件化（2026-11-19）：Worker 的 `execute_operation` 结果超过
 * `runtime.oversizeDataBytes` 时，完整 `data` 落成任务作用域文件，模型只拿摘要 + fileId。
 *
 * 判据（owner 2026-11-19）：
 *   ① 小数据（约 1KB）→ 原样返回，无 fileId、无落盘；
 *   ② 大数据（> 64KiB）→ `{status, oversize, bytes, fileId, note}`；任务文件里能读回完整
 *      JSON，且字节与 data 的 JSON 编码一致；
 *   ③ 阈值可配（策略解析值注入）；0/负数在配置层 fail-fast（见 core/resource-policy 用例）；
 *   ④ 无文件桥 → 原样返回 + `execution_result_oversize_unhandled`（fail-open，不阻塞业务）；
 *   ⑤ needs_confirmation 不受影响：投影仍脱敏（无 handle）、不落盘（即便 data 很大）。
 *
 * 反向绊线：把 `projectWorkerOutcome` 的阈值判断短路成「永不超大」，本文件 ② 必须红。
 * 零网络：脚本化执行层 + 脚本化双驱动 + 真实 fileStore/任务文件桥（无 SaaS）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import { createFileStore, fileStoragePathOf, type FileScope, type FileStore } from './src/file-store';
import {
  createSession,
  type ExecutionResultFileizedEvent,
  type ExecutionResultOversizeUnhandledEvent,
  type Session,
} from './src/execution-runtime';
import { createResourcePolicy } from './src/resource-policy';
import { createTaskExecutionBridge, type TaskExecutionBridgeFactory } from './src/task-file-bridge';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE: FileScope = { principalId: 'wecom:oversize-user', sessionId: 'sess_oversize' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [{ name: 'dummy.query', label: '查询', args: [] }],
};

/** 脚本化执行层：按顺序返回固定 outcome（零网络、零 spawn）。 */
class StaticExecutionLayer implements ExecutionClient {
  private index = 0;

  constructor(private readonly outcomes: readonly ExecutionOutcome[]) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(_request: ExecutionRequest): Promise<ExecutionOutcome> {
    const outcome = this.outcomes[this.index];
    this.index += 1;
    if (outcome === undefined) throw new Error('（测试）执行层没有更多 outcome');
    return outcome;
  }
}

interface MainStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

function mainDriver(steps: MainStep[]): { driver: TurnDriver; push(step: MainStep): void } {
  const pending = [...steps];
  const driver: TurnDriver = {
    async run(input) {
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.execCalls ?? []) await input.exec(call.tool, call.args);
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: step.text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text: step.text, messages: [...input.messages, message] } as unknown as TurnDriverResult;
    },
  };
  return { driver, push: (step) => pending.push(step) };
}

interface WorkerStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

function workerDriver(steps: WorkerStep[]): { driver: TurnDriver; results: unknown[]; push(step: WorkerStep): void } {
  const pending = [...steps];
  const results: unknown[] = [];
  const driver: TurnDriver = {
    async run(input) {
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Worker 驱动步骤');
      for (const call of step.execCalls ?? []) results.push(await input.exec(call.tool, call.args));
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: step.text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text: step.text, messages: [message] } as unknown as TurnDriverResult;
    },
  };
  return { driver, results, push: (step) => pending.push(step) };
}

interface Fixture {
  dir: string;
  session: Session;
  fileStore: FileStore;
  ro: ReturnType<typeof openTaskStore>;
  workerResults: unknown[];
  fileized: ExecutionResultFileizedEvent[];
  unhandled: ExecutionResultOversizeUnhandledEvent[];
  close(): void;
}

async function makeFixture(input: {
  outcomes: readonly ExecutionOutcome[];
  withBridge?: boolean;
  oversizeDataBytes?: number;
}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oversize-fileize-'));
  tempDirs.push(dir);
  const platformRoot = path.join(dir, 'platform');
  mkdirSync(platformRoot, { recursive: true });
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const client = new StaticExecutionLayer(input.outcomes);
  const bridgeFactory: TaskExecutionBridgeFactory | undefined = input.withBridge === false
    ? undefined
    : createTaskExecutionBridge({
      platformRoot,
      fileStore,
      scope: SCOPE,
      inner: client,
    });
  const main = mainDriver([
    { execCalls: [{ tool: 'task_run', args: { task: '查询明细' } }], text: '查询已完成。' },
  ]);
  const worker = workerDriver([
    {
      execCalls: [{ tool: 'execute_operation', args: { operation: 'dummy.query', args: {} } }],
      text: '已完成查询。',
    },
  ]);
  const fileized: ExecutionResultFileizedEvent[] = [];
  const unhandled: ExecutionResultOversizeUnhandledEvent[] = [];
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client,
    allowedOperations: ['dummy.query'],
    mainDriver: main.driver,
    workerDriver: worker.driver,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    ...(input.oversizeDataBytes === undefined
      ? {}
      : { policy: createResourcePolicy({ oversizeDataBytes: input.oversizeDataBytes }) }),
    onExecutionResultFileized: (event) => fileized.push(event),
    onExecutionResultOversizeUnhandled: (event) => unhandled.push(event),
    ...(bridgeFactory === undefined ? {} : { taskExecutionBridge: bridgeFactory }),
  });
  return {
    dir,
    session,
    fileStore,
    ro: openTaskStore(dbPath, { readOnly: true }),
    workerResults: worker.results,
    fileized,
    unhandled,
    close: () => registry.close(),
  };
}

function taskRowsOf(fx: Fixture): ReturnType<ReturnType<typeof openTaskStore>['listFileRefs']> {
  const tasks = fx.session.tasks();
  const taskId = tasks[0]?.taskId;
  return taskId === undefined ? [] : fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === taskId);
}

describe('大响应文件化（Worker execute_operation 结果投影）', () => {
  it('① 1KB 结果原样返回：无 fileId、无落盘', async () => {
    const data = { rows: ['a'.repeat(1024)] };
    const fx = await makeFixture({ outcomes: [{ status: 'completed', data }] });
    try {
      await fx.session.send('查询明细');

      const result = fx.workerResults[0] as Record<string, unknown>;
      expect(result).toEqual({ status: 'completed', data });
      expect(result['oversize']).toBeUndefined();
      expect(result['fileId']).toBeUndefined();
      expect(taskRowsOf(fx)).toEqual([]);
      expect(fx.fileized).toEqual([]);
      expect(fx.unhandled).toEqual([]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('② >64KiB 结果落任务文件：返回 oversize/bytes/fileId；文件字节与完整 data 一致', async () => {
    const data = { rows: ['明细行,'.repeat(15_000)] };
    const expectedJson = JSON.stringify(data);
    expect(Buffer.byteLength(expectedJson, 'utf8')).toBeGreaterThan(64 * 1024);
    const fx = await makeFixture({ outcomes: [{ status: 'completed', data }] });
    try {
      await fx.session.send('查询明细');

      const result = fx.workerResults[0] as Record<string, unknown>;
      expect(result['status']).toBe('completed');
      expect(result['oversize']).toBe(true);
      expect(typeof result['fileId']).toBe('string');
      expect(result['bytes']).toBeGreaterThan(64 * 1024);
      expect(result['note']).toBe(
        '结果较大，已落为任务文件 result-dummy.query.json；需要明细请用 run_js 的 inputs 按 fileId 读取',
      );
      // 模型上下文里不再带明细本体。
      expect(JSON.stringify(result)).not.toContain('明细行');

      const rows = taskRowsOf(fx);
      expect(rows.map((row) => row.name)).toEqual(['result-dummy.query.json']);
      const row = rows[0]!;
      expect(result['fileId']).toBe(row.fileId);
      const stored = readFileSync(fileStoragePathOf(path.join(fx.dir, 'workspace'), SCOPE, row.fileId, row.name));
      expect(stored.equals(Buffer.from(expectedJson, 'utf8'))).toBe(true);
      expect(row.bytes).toBe(Buffer.byteLength(expectedJson, 'utf8'));

      expect(fx.fileized).toEqual([{
        taskId: row.taskId!,
        operation: 'dummy.query',
        bytes: Buffer.byteLength(JSON.stringify({ status: 'completed', data }), 'utf8'),
        fileId: row.fileId,
      }]);
      expect(fx.unhandled).toEqual([]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('③ 阈值可配：设 1024 时 2KB 也落盘', async () => {
    const data = { payload: 'x'.repeat(2048) };
    const fx = await makeFixture({ outcomes: [{ status: 'completed', data }], oversizeDataBytes: 1_024 });
    try {
      await fx.session.send('查询明细');

      const result = fx.workerResults[0] as Record<string, unknown>;
      expect(result['oversize']).toBe(true);
      expect(typeof result['fileId']).toBe('string');
      expect(taskRowsOf(fx).map((row) => row.name)).toEqual(['result-dummy.query.json']);
      expect(fx.fileized).toHaveLength(1);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('④ 无文件桥：原样返回 + execution_result_oversize_unhandled（fail-open）', async () => {
    const data = { rows: ['明细行,'.repeat(15_000)] };
    const fx = await makeFixture({ outcomes: [{ status: 'completed', data }], withBridge: false });
    try {
      await fx.session.send('查询明细');

      const result = fx.workerResults[0] as Record<string, unknown>;
      expect(result).toEqual({ status: 'completed', data });
      expect(result['oversize']).toBeUndefined();
      expect(taskRowsOf(fx)).toEqual([]);
      expect(fx.fileized).toEqual([]);
      expect(fx.unhandled).toHaveLength(1);
      expect(fx.unhandled[0]!.operation).toBe('dummy.query');
      expect(fx.unhandled[0]!.bytes).toBeGreaterThan(64 * 1024);
      expect(fx.unhandled[0]!.taskId).toEqual(expect.any(String));
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('⑤ needs_confirmation 不受影响：仍脱敏（无 handle）、不落盘（即便 data 很大）', async () => {
    const fx = await makeFixture({
      outcomes: [{
        status: 'needs_confirmation',
        confirmation: { handle: 'h_secret', summary: '确认写入 3000 行' },
        data: { rows: ['明细行,'.repeat(15_000)] },
      }],
    });
    try {
      await fx.session.send('确认写入');

      const result = fx.workerResults[0] as Record<string, unknown>;
      expect(result['status']).toBe('needs_confirmation');
      expect(result['summary']).toBe('确认写入 3000 行');
      expect(JSON.stringify(result)).not.toContain('h_secret');
      expect(result['oversize']).toBeUndefined();
      expect(result['fileId']).toBeUndefined();
      expect(taskRowsOf(fx)).toEqual([]);
      expect(fx.fileized).toEqual([]);
      expect(fx.unhandled).toEqual([]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
