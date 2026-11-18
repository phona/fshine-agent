/**
 * 批量写逐条结果（契约 v4；owner 2026-11-19）：completed.items 是安全相关事实——
 * 「部分完成」不得被宿主/模型说成单纯成功。
 *
 * dummy 的写是「全量校验后一次落盘」的原子实现（不为造 items 改成部分写）：
 *   · 成功 → items 逐条 ok（长度 = 本次写入条数）；
 *   · 注入失败（--fail-index N）→ 整批原子失败：零写入、整体 failed、不携带 items。
 * 真实执行层若支持部分写，再逐条给出 failed/unknown——宿主只转述，不改语义。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import { createDummyCliClient } from './src/dummy-cli-client';
import { createTaskExecutor } from './src/execution-runtime';
import type { TurnDriver } from './src/driver-contract';
import type { ResourcePermit, ResourcePolicyPort, TaskRunner } from './src/task-runner';
import { createTaskRunner } from './src/task-runner';
import { createTaskRegistry, type TaskRegistry } from './src/task-registry';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'p', sessionId: 's' } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function adapter(stateDir: string) {
  return createDummyCliClient({
    root: FIXTURE_ROOT,
    gateway: 'bin/dummy',
    stateDir,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
  });
}

const RECORDS = [
  { name: 'alpha-item-1', value: 1 },
  { name: 'alpha-item-2', value: 2 },
  { name: 'alpha-item-3', value: 3 },
];

/** prepare → 拿句柄 → commit（同一批 records）→ 返回 commit 的 outcome。 */
async function prepareAndCommit(
  client: ReturnType<typeof adapter>,
  commitExtra: Record<string, unknown> = {},
): Promise<ExecutionOutcome> {
  const prepared = await client.execute({
    requestId: 'req_prep',
    dispatchKey: 'dk_prep',
    operation: 'dummy.prepare',
    args: { collection: 'documents', window: 'W202611', records: RECORDS },
  });
  expect(prepared.status).toBe('needs_confirmation');
  const handle = (prepared as { confirmation: { handle: string } }).confirmation.handle;
  return client.execute({
    requestId: 'req_commit',
    dispatchKey: 'dk_commit',
    operation: 'dummy.commit',
    args: { collection: 'documents', window: 'W202611', records: RECORDS, ...commitExtra },
    confirmation: { handle, userText: '确认' },
  });
}

async function countOf(client: ReturnType<typeof adapter>): Promise<number> {
  const outcome = await client.execute({
    requestId: 'req_query',
    dispatchKey: 'dk_query',
    operation: 'dummy.query',
    args: { collection: 'documents', window: 'W202611' },
  });
  expect(outcome.status).toBe('completed');
  return (outcome as { data?: { count?: number } }).data?.count ?? 0;
}

describe('批量写逐条结果（契约 v4）', () => {
  it('① 全成功：items 逐条 ok，长度 = 记录数；数据确实写入', async () => {
    const client = adapter(tempDir('batch-items-ok-'));
    const before = await countOf(client);
    const outcome = await prepareAndCommit(client);
    expect(outcome.status).toBe('completed');
    const items = (outcome as { items?: Array<{ index: number; status: string }> }).items;
    expect(items).toHaveLength(RECORDS.length);
    expect(items?.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(items?.every((item) => item.status === 'ok')).toBe(true);
    expect(await countOf(client)).toBe(before + RECORDS.length);
  }, 20_000);

  it('② 注入一条写失败（--fail-index）→ dummy 原子拒绝：整体 failed、零写入、不携带 items', async () => {
    const client = adapter(tempDir('batch-items-fail-'));
    const before = await countOf(client);
    const outcome = await prepareAndCommit(client, { '--fail-index': 2 });
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: { code: string } }).error.code).toBe('RECORDS_WRITE_FAILED');
    expect((outcome as { items?: unknown }).items).toBeUndefined();
    // 「部分完成不得说成成功」的机械面：一条都没写。
    expect(await countOf(client)).toBe(before);
  }, 20_000);

  it('③ 运行时：completed.items 原样交给 Worker，任务结局仍是 completed（不因 partial 判失败）', async () => {
    const manifest: CapabilityManifest = {
      contractVersion: 4,
      operations: [{ name: 'dummy.commit', label: 'commit', args: [] }],
    };
    const client: ExecutionClient = {
      async capabilities() {
        return manifest;
      },
      async execute(_request: ExecutionRequest): Promise<ExecutionOutcome> {
        return {
          status: 'completed',
          data: { verified: true, count: 2 },
          items: [
            { index: 0, status: 'ok' },
            { index: 1, status: 'failed', reason: '第 2 条被执行层拒绝' },
          ],
        };
      },
    };
    const captured: unknown[] = [];
    const driver: TurnDriver = {
      async run(input) {
        captured.push(await input.exec('execute_operation', { operation: 'dummy.commit', args: {} }));
        return { text: '已完成 1 条，未完成 1 条（第 2 条被拒绝）。', messages: input.messages };
      },
    };
    class Policy implements ResourcePolicyPort {
      acquire(kind: 'foreground' | 'background'): ResourcePermit {
        return { kind, state: 'active' };
      }
      release(): void {}
      cancelQueued(): void {}
    }
    const registry: TaskRegistry = createTaskRegistry();
    const executor = await createTaskExecutor({
      client,
      allowedOperations: ['dummy.commit'],
      workerDriver: driver,
      registry,
    });
    const runner: TaskRunner = createTaskRunner({
      registry,
      policy: new Policy(),
      executor,
      now: () => new Date(1_000_000),
    });
    runner.submit({ taskId: 'T', principalId: SCOPE.principalId, sessionId: SCOPE.sessionId, request: '批量写' });
    runner.pump();
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await runner.whenIdle();

    const task = registry.get('T', SCOPE);
    expect(task.status).toBe('completed');
    expect(task.replyText).toContain('未完成 1 条');
    // 逐条结果原样保留在 Worker 的工具结果里（模型据此如实说「完成 X、未完成 Y」）。
    const result = captured[0] as { items?: Array<{ index: number; status: string; reason?: string }> };
    expect(result.items).toEqual([
      { index: 0, status: 'ok' },
      { index: 1, status: 'failed', reason: '第 2 条被执行层拒绝' },
    ]);
  });
});
