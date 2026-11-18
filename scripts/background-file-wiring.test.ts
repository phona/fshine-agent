/**
 * background 文件面**生产装配接线** · 确定性验证（2026-11-18 第 2 片）。
 *
 * 上一片把能力做进了 runtime：`createTaskExecutor` 认 `backgroundTaskBridge`（按任务懒建
 * 文件桥：任务副本物化 + Worker 任务文件清单）。本片把生产装配接上：
 *   · `assembleSessionCore` / `createBackgroundDispatch`：用同一 fileStore 实例、同一
 *     `taskExecutionBridge` 参数（profile.root / face.client 由装配层填）构造注入；
 *   · server：`createBackgroundDispatch` 调用点同样注入（server 级用例见
 *     `apps/server/server-background-file-handoff.test.ts`）。
 *
 * 本套件只走装配核心（不手搓 createTaskExecutor）：真底账、真 fileStore、真 TaskRunner，
 * 只有 Main/Worker 驱动与执行层客户端是假件（零网络、零真实模型）。
 *
 * 反向绊线（ttl 手工验证）：把 `createBackgroundDispatch` 里的 `backgroundTaskBridge`
 * 注入删掉，① 用例必须红——Worker 拿不到任务副本、执行层收到占位值。套件里保留
 * 「不注入 = 零变化」的对照用例，说明文件面完全来自这条接线。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
  ExecutionRequest,
} from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../packages/agent/src/driver-contract';
import { createFileStore, type FileStore } from '../packages/agent/src/file-store';
import { createSqliteTaskRegistry } from '../packages/agent/src/task-registry-sqlite';
import { assembleSessionCore } from './ask-runtime';

const SCOPE = { principalId: 'wecom:bg-files', sessionId: 'conv-bg-files' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'background-file-wiring-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FaceCall {
  operation: string;
  args: Record<string, unknown>;
  inputPath?: string;
  content?: string;
}

/** 假执行层：把 `--input` 当宿主物化后的文件路径读出来（不触网）。 */
function faceClient(calls: FaceCall[]): ExecutionClient {
  return {
    async capabilities(): Promise<CapabilityManifest> {
      return MANIFEST;
    },
    async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
      const inputPath = typeof request.args['--input'] === 'string' ? request.args['--input'] : undefined;
      const content = inputPath === undefined ? undefined : readFileSync(inputPath, 'utf8');
      calls.push({
        operation: request.operation,
        args: { ...request.args },
        ...(inputPath === undefined ? {} : { inputPath }),
        ...(content === undefined ? {} : { content }),
      });
      return { status: 'completed', data: {} };
    },
  };
}

interface WorkerCapture {
  delegations: string[];
  toolNames: string[][];
}

/** 后台 Worker：取任务副本 fileId（机械事实），经 execute_operation 处理一次。 */
function backgroundWorker(capture: WorkerCapture): TurnDriver {
  return {
    async run(input) {
      const first = input.messages[0] as unknown as { content?: unknown } | undefined;
      capture.delegations.push(typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content ?? ''));
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      if (input.tools.every((tool) => tool.name !== 'execute_operation')) {
        throw new Error('（测试）后台 Worker 缺少 execute_operation');
      }
      await input.exec('execute_operation', {
        operation: 'dummy.query',
        args: { '--input': '占位（宿主替换为任务目录内的物化路径）' },
      });
      return { text: '已按任务文件完成处理。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

interface MainCall {
  tool: string;
  args: Record<string, unknown>;
}

interface MainStep {
  calls: readonly MainCall[];
  reply: string;
}

interface MainCapture {
  results: Array<{ ok: true; value: unknown } | { ok: false; error: string }>;
}

function scriptedMain(steps: MainStep[], capture: MainCapture): TurnDriver {
  return {
    async run(input) {
      const step = steps.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 步骤');
      for (const call of step.calls) {
        try {
          capture.results.push({ ok: true, value: await input.exec(call.tool, call.args) });
        } catch (error) {
          capture.results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { text: step.reply, messages: [] as unknown as DriverMessage[] };
    },
  };
}

interface Fixture {
  platformRoot: string;
  fileStore: FileStore;
  registry: ReturnType<typeof createSqliteTaskRegistry>;
  calls: FaceCall[];
  main: MainCapture;
  worker: WorkerCapture;
  steps: MainStep[];
  assembled: Awaited<ReturnType<typeof assembleSessionCore>>;
  close(): void;
}

async function makeFixture(options: { withBridge: boolean }): Promise<Fixture> {
  const dir = tempDir();
  // platformRoot = 临时目录（桥的 tmp/task_<id>/in 落这里，不进仓）。
  const platformRoot = path.join(dir, 'platform');
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const calls: FaceCall[] = [];
  const client = faceClient(calls);
  const worker: WorkerCapture = { delegations: [], toolNames: [] };
  const main: MainCapture = { results: [] };
  const steps: MainStep[] = [];
  const assembled = await assembleSessionCore({
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TMPDIR: process.env['TMPDIR'] },
    profile: { root: platformRoot, skillRoots: [] },
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    dbPath,
    stateDir: path.join(dir, 'state'),
    emptyOperationsMessage: '（测试）执行层没有声明任何只读 operation',
    mainSystemPrompt: '（测试）Main 系统提示',
    workerSkills: [],
    taskRegistry: registry,
    createDrivers: () => ({ mainDriver: scriptedMain(steps, main), workerDriver: backgroundWorker(worker) }),
    createExecutionFace: async () => ({
      client,
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    taskDispatch: 'async',
    runtime: { backgroundConcurrency: 1, queueCapacity: 0, taskRunWaitMs: 0 },
    // 生产装配同一条注入：交办复制端口与文件桥同一 fileStore 实例。
    taskInputCopier: fileStore,
    ...(options.withBridge
      ? { taskExecutionBridge: { store: fileStore, fileParams: { input: '--input' } } }
      : {}),
  });
  return {
    platformRoot,
    fileStore,
    registry,
    calls,
    main,
    worker,
    steps,
    assembled,
    close: () => assembled.close(),
  };
}

function taskReceipt(fx: Fixture): Record<string, unknown> {
  const result = fx.main.results[0];
  if (result === undefined || !result.ok) throw new Error('（测试）缺少 task_run 回执');
  return result.value as Record<string, unknown>;
}

describe('background 文件面生产装配接线', () => {
  it('① 装配核心 → createBackgroundDispatch → 执行器：Worker 拿任务副本、执行层收到物化路径', async () => {
    const fx = await makeFixture({ withBridge: true });
    try {
      const bytes = Buffer.from('id,name\n1,甲\n2,乙\n');
      const source = fx.fileStore.putFile({
        scope: SCOPE,
        name: '名册.csv',
        bytes,
        activatedAt: Date.now() - 1_000,
      });
      fx.steps.push({
        calls: [{ tool: 'task_run', args: { task: '按名册核对', inputFiles: [source.fileId] } }],
        reply: '已受理，后台办理中。',
      });
      await fx.assembled.session.send('把这份名册交给后台处理');
      await fx.assembled.runner!.whenIdle();

      const receipt = taskReceipt(fx);
      expect(receipt['accepted']).toBe(true);
      const taskId = String(receipt['taskId']);
      expect(fx.assembled.taskRegistry.get(taskId, SCOPE).status).toBe('completed');

      // 交办副本：task_id 绑定、字节一致、fileId 与源不同。
      const rows = fx.registry.store.listFileRefs(SCOPE);
      const copy = rows.find((row) => row.taskId === taskId);
      expect(copy).toBeDefined();
      expect(copy!.fileId).not.toBe(source.fileId);
      expect(copy!.sha256).toBe(source.sha256);
      expect(copy!.name).toBe('名册.csv');

      // ① Worker 转录：含任务副本 fileId，不含 Main 源 fileId（清单来自任务文件面）。
      expect(fx.worker.delegations).toHaveLength(1);
      expect(fx.worker.delegations[0]).toContain(copy!.fileId);
      expect(fx.worker.delegations[0]).toContain('[本任务文件清单]');
      expect(fx.worker.delegations[0]).not.toContain(source.fileId);

      // ② 执行层收到的是任务目录内的物化路径（不是占位值、不是源文件路径），字节一致。
      expect(fx.calls).toHaveLength(1);
      const materialized = path.join(fx.platformRoot, 'tmp', `task_${taskId}`, 'in', `${copy!.fileId}.csv`);
      expect(fx.calls[0]!.inputPath).toBe(materialized);
      expect(readFileSync(materialized)).toEqual(bytes);
      expect(fx.calls[0]!.content).toBe(bytes.toString('utf8'));
    } finally {
      fx.close();
    }
  });

  it('零变化对照：装配不注入文件桥 → 任务照常受理，但 Worker 无文件面（文件面完全来自接线）', async () => {
    const fx = await makeFixture({ withBridge: false });
    try {
      const source = fx.fileStore.putFile({
        scope: SCOPE,
        name: '名册.csv',
        bytes: Buffer.from('id,name\n1,甲\n'),
        activatedAt: Date.now() - 1_000,
      });
      fx.steps.push({
        calls: [{ tool: 'task_run', args: { task: '按名册核对', inputFiles: [source.fileId] } }],
        reply: '已受理，后台办理中。',
      });
      await fx.assembled.session.send('把这份名册交给后台处理');
      await fx.assembled.runner!.whenIdle();

      expect(taskReceipt(fx)['accepted']).toBe(true);
      // 交接副本仍存在（宿主受理事实），但未接线 → Worker 委派没有任务文件清单。
      const copy = fx.registry.store
        .listFileRefs(SCOPE)
        .find((row) => row.taskId !== undefined);
      expect(copy).toBeDefined();
      expect(fx.worker.delegations).toHaveLength(1);
      expect(fx.worker.delegations[0]).not.toContain('[本任务文件清单]');
      expect(fx.worker.delegations[0]).not.toContain(copy!.fileId);
      // 执行层拿到的是 Worker 传的占位值（桥未接线 → 不做参数替换）：假客户端读占位路径
      // 直接失败，执行调用没有一次成功落地——文件面完全来自接线。
      expect(fx.calls).toHaveLength(0);
    } finally {
      fx.close();
    }
  });
});
