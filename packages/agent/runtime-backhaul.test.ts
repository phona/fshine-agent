/**
 * CAP-01 S2 ③④⑤：执行层回程登记与产物不丢（runtime 出口）· 确定性验证。
 *
 * 覆盖（ask ③④⑤ 对应的 runtime 侧断言）：
 *   ③ 执行层返回 data.files 带 path 与内联 base64 → runtime 出口登记成新 file_id（task 绑定），
 *      **登记后转录里 path 与 base64 都不存在**（工具返回只见登记事实 fileId/name/bytes）；
 *      产物随本回合 TurnResult.files 带出（交付面）；
 *   ④ 产物不丢（v8 §10-3）：
 *      · unexecuted（Worker 只 run_js、零执行调用）→ 产物仍被登记并进交付事实；
 *      · failed（执行层写了 out/ 产物但 outcome 没带回 data.files）→ 收尾兜底扫任务 out/
 *        登记，产物仍进交付事实；
 *   ⑤ 同 sha256 两次返回（两次执行调用同一字节）→ 复用同一 fileId、不重复落盘；
 *   · 零变化缺省：未注入文件桥时 data 原样透传（既有行为逐字节——登记/剥除只随桥开启）；
 *   · 交付事实按 fileId 去重：回程登记 + 兜底扫描同池去重后，同一产物不重复进交付面。
 *
 * 零网络：假客户端（脚本化执行层：写 out/ 产物、返回 data.files）+ 脚本化双驱动；
 * run_js 走真实受限执行器。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome, ExecutionRequest } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import { createFileStore, fileStoragePathOf, type FileScope, type FileStore } from './src/file-store';
import {
  createSession,
  type Session,
  type TaskInputCopier,
} from './src/execution-runtime';
import { createRunJsExecutor, type RunJsExecutor } from './src/run-js-executor';
import { createTaskExecutionBridge, type TaskExecutionBridgeFactory } from './src/task-file-bridge';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver, TurnDriverResult } from './src/driver-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE: FileScope = { principalId: 'wecom:test-user', sessionId: 'sess_s2b' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 2,
  operations: [
    { name: 'demo.aggregate', label: 'aggregate', args: [{ name: '--output-dir', required: true, type: 'dir' }, { name: '--input-dir', required: false, type: 'dir' }] },
    { name: 'dummy.query', label: 'query', args: [] },
  ],
};

/** 脚本化执行层：从替换后的 --output-dir 写产物，按脚本返回 data.files（path/base64）。 */
class ScriptedExecutionLayer implements ExecutionClient {
  constructor(
    private readonly outcomes: Array<{ status: 'completed' | 'failed'; productBytes?: Buffer; inlineBytes?: Buffer }>,
  ) {}

  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const step = this.outcomes.shift();
    if (step === undefined) throw new Error('（测试）执行层没有更多步骤');
    const outDir = request.args['--output-dir'];
    if (typeof outDir !== 'string') throw new Error('（测试）桥应已替换 --output-dir');
    mkdirSync(outDir, { recursive: true });
    if (step.status === 'failed') {
      // 失败前已写产物（部分产物的现实形状）：out/ 有文件、outcome 不带 data.files。
      writeFileSync(path.join(outDir, '部分产物.csv'), step.productBytes ?? Buffer.from('partial'));
      return { status: 'failed', error: { code: 'EXECUTION_FAILED', message: '执行失败（产物已留在输出目录）。' } };
    }
    const files: Array<Record<string, unknown>> = [];
    if (step.productBytes !== undefined) {
      writeFileSync(path.join(outDir, '执行层产物.csv'), step.productBytes);
      files.push({ name: '执行层产物.csv', path: path.join(outDir, '执行层产物.csv') });
    }
    if (step.inlineBytes !== undefined) {
      files.push({ name: '内联产物.csv', content: step.inlineBytes.toString('base64') });
    }
    return { status: 'completed', data: { files, note: '执行层备注' } };
  }
}

interface MainStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface MainCapture {
  toolNames: string[][];
  results: unknown[];
  toolErrors: string[];
}

function queueMainDriver(capture: MainCapture): { driver: TurnDriver; push(step: MainStep): void } {
  const pending: MainStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.execCalls ?? []) {
        try {
          capture.results.push(await input.exec(call.tool, call.args));
        } catch (error) {
          capture.toolErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
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

type WorkerArgSpec = Record<string, unknown> | ((delegation: string) => Record<string, unknown>);

interface WorkerStep {
  execCalls?: ReadonlyArray<{ tool: string; args: WorkerArgSpec }>;
  text: string;
}

interface WorkerCapture {
  toolNames: string[][];
  delegationTexts: string[];
  results: unknown[];
  toolErrors: string[];
}

function scriptedWorkerDriver(capture: WorkerCapture): { driver: TurnDriver; push(step: WorkerStep): void } {
  const pending: WorkerStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      const delegation = input.messages.at(-1) as unknown as { content?: unknown } | undefined;
      const delegationText = typeof delegation?.content === 'string' ? delegation.content : JSON.stringify(delegation?.content ?? '');
      capture.delegationTexts.push(delegationText);
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Worker 驱动步骤');
      for (const call of step.execCalls ?? []) {
        const args = typeof call.args === 'function' ? call.args(delegationText) : call.args;
        try {
          capture.results.push(await input.exec(call.tool, args));
        } catch (error) {
          capture.toolErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: step.text }],
        timestamp: Date.now(),
      } as unknown as DriverMessage;
      return { text: step.text, messages: [message] } as unknown as TurnDriverResult;
    },
  };
  return { driver, push: (step) => pending.push(step) };
}

/** Worker run_js 脚本：读 in/ 第一个文件、写 out/（不打印单元格数值）。 */
const WORKER_SCRIPT = [
  "const fs = require('node:fs');",
  "const src = fs.readdirSync('in')[0];",
  "fs.writeFileSync('out/汇总.csv', 'rows=1\\n');",
  "console.log('done');",
].join('\n');

interface Fixture {
  dir: string;
  platformRoot: string;
  taskDirOf(taskId: string): string;
  session: Session;
  main: MainCapture;
  mainPush(step: MainStep): void;
  worker: WorkerCapture;
  workerPush(step: WorkerStep): void;
  fileStore: FileStore;
  store: ReturnType<typeof openTaskStore>;
  ro: ReturnType<typeof openTaskStore>;
  close(): void;
}

async function makeFixture(input: {
  executionLayer?: ExecutionClient;
  withBridge?: boolean;
  dirParams?: { input?: string; output?: string };
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-backhaul-'));
  tempDirs.push(dir);
  const platformRoot = path.join(dir, 'platform');
  mkdirSync(platformRoot, { recursive: true });
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const runJsExecutor: RunJsExecutor = createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES, timeoutMs: 30_000 });
  const client = input.executionLayer ?? new ScriptedExecutionLayer([{ status: 'completed' }]);
  const mainCapture: MainCapture = { toolNames: [], results: [], toolErrors: [] };
  const main = queueMainDriver(mainCapture);
  const workerCapture: WorkerCapture = { toolNames: [], delegationTexts: [], results: [], toolErrors: [] };
  const worker = scriptedWorkerDriver(workerCapture);
  const bridgeFactory: TaskExecutionBridgeFactory | undefined = input.withBridge === false
    ? undefined
    : createTaskExecutionBridge({
      platformRoot,
      fileStore,
      scope: SCOPE,
      inner: client,
      dirParams: input.dirParams ?? { input: '--input-dir', output: '--output-dir' },
      maxOutputFileBytes: 4096,
      maxOutputCount: 10,
    });
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client,
    allowedOperations: ['demo.aggregate', 'dummy.query'],
    mainDriver: main.driver,
    workerDriver: worker.driver,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    taskInputCopier: fileStore as TaskInputCopier,
    runJsExecutor,
    ...(bridgeFactory === undefined ? {} : { taskExecutionBridge: bridgeFactory }),
  });
  return {
    dir,
    platformRoot,
    taskDirOf: (taskId: string) => path.join(platformRoot, 'tmp', `task_${taskId}`),
    session,
    main: mainCapture,
    mainPush: main.push,
    worker: workerCapture,
    workerPush: worker.push,
    fileStore,
    store: registry.store,
    ro: openTaskStore(dbPath, { readOnly: true }),
    close: () => {
      registry.close();
    },
  };
}

/** workspace files/ 落盘份数（「不重复落盘」的可观察面）。 */
function storedFileCount(fx: Fixture): number {
  return readdirSync(path.join(sessionDirOfSafe(fx), 'files')).length;
}

function sessionDirOfSafe(fx: Fixture): string {
  // sessionDirOf 是 file-store 的派生函数（principalHash/sessionHash，sha256 前 16 hex），
  // 这里按测试夹具同口径直接派生：workspace/<ph>/<sh>。
  const ph = createHash('sha256').update(SCOPE.principalId, 'utf8').digest('hex').slice(0, 16);
  const sh = createHash('sha256').update(SCOPE.sessionId, 'utf8').digest('hex').slice(0, 16);
  return path.join(fx.dir, 'workspace', ph, sh);
}

describe('CAP-01 S2 ③ 回程登记（runtime 出口）', () => {
  it('③ data.files 带 path 与 base64 → 登记后转录里两者都不存在；产物进交付事实', async () => {
    const productBytes = Buffer.from('平台汇总,v1\n合计,42\n');
    const inlineBytes = Buffer.from('平台明细,v2\n行,8\n');
    const fx = await makeFixture({
      executionLayer: new ScriptedExecutionLayer([{ status: 'completed', productBytes, inlineBytes }]),
    });
    try {
      const source = fx.fileStore.putFile({ scope: SCOPE, name: '输入.csv', bytes: Buffer.from('in'), activatedAt: Date.now() });
      fx.workerPush({
        execCalls: [{
          tool: 'execute_operation',
          args: { operation: 'demo.aggregate', args: { '--input-dir': '占位输入目录', '--output-dir': '占位输出目录' } },
        }],
        text: '执行层已完成聚合。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '聚合', inputFiles: [source.fileId] } }], text: '聚合完成。' });
      const turn = await fx.session.send('交办聚合任务');

      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(task.status).toBe('completed');

      // 两份产物都登记（+ 交办副本自身）：task 绑定、字节与执行层写出的一致。
      const taskRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId);
      expect(taskRows.map((row) => row.name).sort()).toEqual(['内联产物.csv', '执行层产物.csv', '输入.csv']);
      const pathRow = taskRows.find((row) => row.name === '执行层产物.csv')!;
      expect(pathRow.bytes).toBe(productBytes.length);
      expect(readFileSync(fileStoragePathOf(path.join(fx.dir, 'workspace'), SCOPE, pathRow.fileId, pathRow.name))).toEqual(productBytes);
      const inlineRow = taskRows.find((row) => row.name === '内联产物.csv')!;
      expect(inlineRow.bytes).toBe(inlineBytes.length);

      // 转录（工具返回）里 path 与 base64 都不存在——只见登记事实；交付面拿到两份产物。
      const workerResultJson = JSON.stringify(fx.worker.results[0]);
      expect(workerResultJson).not.toContain('base64');
      expect(workerResultJson).not.toContain(fx.platformRoot);
      expect(workerResultJson).not.toContain('占位');
      const files = (fx.worker.results[0] as { data?: { files?: Array<Record<string, unknown>> } }).data?.files ?? [];
      expect(files).toHaveLength(2);
      for (const fact of files) {
        expect(Object.keys(fact).sort()).toEqual(['bytes', 'fileId', 'name']);
      }
      expect(turn.files?.map((file) => file.fileId).sort()).toEqual([pathRow.fileId, inlineRow.fileId].sort());

      // 兜底扫描与回程登记同池去重：回合收尾后不产生重复行/重复落盘
      // （任务行 = 交办副本 1 + 产物 2；落盘 = Main 源 1 + 副本 1 + 产物 2）。
      expect(fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId)).toHaveLength(3);
      expect(storedFileCount(fx)).toBe(4);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('⑤ 同 sha256 两次返回 → 复用同一 fileId、不重复落盘', async () => {
    const sameBytes = Buffer.from('同一份平台产物');
    const fx = await makeFixture({
      executionLayer: new ScriptedExecutionLayer([
        { status: 'completed', productBytes: sameBytes },
        { status: 'completed', productBytes: sameBytes },
      ]),
    });
    try {
      fx.workerPush({
        execCalls: [
          { tool: 'execute_operation', args: { operation: 'demo.aggregate', args: { '--output-dir': '占位' } } },
          { tool: 'execute_operation', args: { operation: 'demo.aggregate', args: { '--output-dir': '占位' } } },
        ],
        text: '两次聚合完成（产物相同）。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '两次聚合' } }], text: '完成。' });
      const turn = await fx.session.send('交办两次聚合');

      const task = fx.session.getTask(turn.taskIds[0]!);
      const productRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId);
      expect(productRows).toHaveLength(1);
      // 两次工具返回的登记事实同一 fileId。
      const firstFiles = (fx.worker.results[0] as { data?: { files?: Array<{ fileId: string }> } }).data?.files ?? [];
      const secondFiles = (fx.worker.results[1] as { data?: { files?: Array<{ fileId: string }> } }).data?.files ?? [];
      expect(secondFiles[0]!.fileId).toBe(firstFiles[0]!.fileId);
      // 交付事实去重：同一 fileId 只出现一次；落盘只有产物 1 份。
      expect(turn.files).toHaveLength(1);
      expect(storedFileCount(fx)).toBe(1);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});

describe('CAP-01 S2 ④ 产物不丢（unexecuted / failed）', () => {
  it('④ unexecuted：Worker 只 run_js、零执行调用 → 产物仍被登记并进交付事实', async () => {
    const fx = await makeFixture();
    try {
      const source = fx.fileStore.putFile({ scope: SCOPE, name: '名单.csv', bytes: Buffer.from('a,b\n1,2\n'), activatedAt: Date.now() });
      fx.workerPush({
        execCalls: [{
          tool: 'run_js',
          args: (delegation: string) => ({
            code: WORKER_SCRIPT,
            inputs: [...delegation.matchAll(/fileId: (file_[0-9a-f]{32})/g)].map((match) => match[1]!),
          }),
        }],
        text: '已用本地文件生成汇总（未发起执行层调用）。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '本地汇总', inputFiles: [source.fileId] } }], text: '收到。' });
      const turn = await fx.session.send('交办本地汇总');

      // 零执行 → 任务 unexecuted（既有判定），但 run_js 产物已登记并进交付事实。
      expect(fx.session.getTask(turn.taskIds[0]!).status).toBe('unexecuted');
      const task = fx.session.getTask(turn.taskIds[0]!);
      const productRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId && row.name === '汇总.csv');
      expect(productRows).toHaveLength(1);
      expect(turn.files).toEqual([{ fileId: productRows[0]!.fileId, name: '汇总.csv', bytes: productRows[0]!.bytes }]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('④ failed：执行层写了 out/ 产物但 outcome 未带回 data.files → 收尾兜底扫描登记', async () => {
    const partialBytes = Buffer.from('部分产物,残留\n');
    const fx = await makeFixture({
      executionLayer: new ScriptedExecutionLayer([{ status: 'failed', productBytes: partialBytes }]),
    });
    try {
      fx.workerPush({
        execCalls: [{ tool: 'execute_operation', args: { operation: 'demo.aggregate', args: { '--output-dir': '占位' } } }],
        text: '执行层失败了。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '会失败的任务' } }], text: '如实转述：执行层失败。' });
      const turn = await fx.session.send('交办会失败的任务');

      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(task.status).toBe('failed');
      // 失败任务的 out/ 残留产物不丢：兜底扫描登记 + 进交付事实。
      const sweptRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId && row.name === '部分产物.csv');
      expect(sweptRows).toHaveLength(1);
      expect(readFileSync(fileStoragePathOf(path.join(fx.dir, 'workspace'), SCOPE, sweptRows[0]!.fileId, sweptRows[0]!.name))).toEqual(partialBytes);
      expect(turn.files).toEqual([{ fileId: sweptRows[0]!.fileId, name: '部分产物.csv', bytes: sweptRows[0]!.bytes }]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});

describe('零变化缺省：未注入文件桥时 data 原样透传', () => {
  it('data.files 原样进工具返回（path/base64 不登记、不剥除——既有行为逐字节）', async () => {
    const rawFiles = [{ name: 'x.csv', path: '/执行层自己的/位置/x.csv' }, { name: 'y.csv', content: Buffer.from('y').toString('base64') }];
    class RawLayer implements ExecutionClient {
      async capabilities(): Promise<CapabilityManifest> {
        return MANIFEST;
      }
      async execute(): Promise<ExecutionOutcome> {
        return { status: 'completed', data: { files: rawFiles } };
      }
    }
    const fx = await makeFixture({ withBridge: false, executionLayer: new RawLayer() });
    try {
      fx.workerPush({
        execCalls: [{ tool: 'execute_operation', args: { operation: 'demo.aggregate', args: {} } }],
        text: '完成。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '透传对照' } }], text: '完成。' });
      await fx.session.send('交办透传对照');

      const result = fx.worker.results[0] as { data?: { files?: unknown } };
      expect(result.data?.files).toEqual(rawFiles);
      expect(fx.ro.listFileRefs(SCOPE)).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
