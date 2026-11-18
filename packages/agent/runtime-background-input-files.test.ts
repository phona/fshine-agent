/**
 * background 派发 + task_run.inputFiles（附件交办）· 确定性验证（2026-11-18 A 决策第 1 片）。
 *
 * 口径：
 *   · 交办复制在 **submit 之前**完成（同一个 task_run 调用内）——任务一受理就已有绑定到
 *     该 taskId 的任务副本（file_refs.task_id），任一 fileId 不可用 → 整次拒绝（零任务行、
 *     零副本、不部分执行）；background 不再因为「带文件」而被拒；
 *   · 后台 Worker 文件面沿用既有 materializeInputs（任务副本 → 任务目录 in/）：Worker 委派
 *     携带任务文件清单（副本 fileId/name/bytes），execute_operation 经文件桥把声明参数替换
 *     为任务目录内的物化路径——Worker 从不读 Main 侧原文件；
 *   · 既有边界不放宽：不存在/未激活/过期/跨 principal 的 fileId 都解析不到（同码话术，
 *     机械 reason 只进日志）。
 *
 * 零网络：脚本化 Main/Worker 驱动 + 真实 runner / 真实底账 + 真实 fileStore（临时
 * workspace），执行层客户端用脚本化假件；run_js 不在本切片。
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
import { openTaskStore } from '@fshine/core';
import { createFileStore, FILE_REF_TTL_MS, type FileStore } from './src/file-store';
import {
  createSession,
  createTaskExecutor,
  type Session,
  type TaskInputCopier,
} from './src/execution-runtime';
import { createResourcePolicy } from './src/resource-policy';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { createTaskExecutionBridge } from './src/task-file-bridge';
import { createTaskRunner, type TaskExecutor, type TaskRunner } from './src/task-runner';
import type { DriverMessage, TurnDriver } from './src/driver-contract';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:bg-user', sessionId: 'sess_bg_files' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

interface FaceCall {
  operation: string;
  args: Record<string, unknown>;
  /** 桥替换后的输入参数值（文件路径/目录；未声明则等于 args 原值）。 */
  inputPath?: string;
  /** 假执行层从该路径读到的内容（证明文件真的可用）。 */
  content?: string;
}

/** 脚本化执行层：把 `--input` 当作宿主物化后的文件路径读出来（不触网）。 */
function faceClient(calls: FaceCall[]): ExecutionClient {
  return {
    async capabilities(): Promise<CapabilityManifest> {
      return MANIFEST;
    },
    async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
      const inputPath = typeof request.args['--input'] === 'string' ? request.args['--input'] : undefined;
      let content: string | undefined;
      if (inputPath !== undefined) {
        content = readFileSync(inputPath, 'utf8');
      }
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

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
};

interface WorkerCapture {
  delegationTexts: string[];
  toolNames: string[][];
}

/** 后台 Worker：从委派清单里取任务副本 fileId（机械事实），经 execute_operation 处理一次。 */
function backgroundWorker(capture: WorkerCapture): TurnDriver {
  return {
    async run(input) {
      const last = input.messages.at(-1) as unknown as { content?: unknown } | undefined;
      const delegation = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      capture.delegationTexts.push(delegation);
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      if (input.tools.every((tool) => tool.name !== 'execute_operation')) {
        throw new Error('（测试）后台 Worker 缺少 execute_operation');
      }
      await input.exec('execute_operation', {
        operation: 'dummy.query',
        args: { '--input': '占位（宿主替换为任务目录内的物化路径）', '--collection': 'documents' },
      });
      return { text: '已按任务文件完成处理。', messages: [] as unknown as DriverMessage[] };
    },
  };
}

interface MainStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface MainCapture {
  results: unknown[];
  toolErrors: string[];
}

function queueMainDriver(capture: MainCapture): { driver: TurnDriver; push(step: MainStep): void } {
  const pending: MainStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Main 驱动步骤');
      for (const call of step.execCalls ?? []) {
        try {
          capture.results.push(await input.exec(call.tool, call.args));
        } catch (error) {
          capture.toolErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { text: step.text, messages: [] as unknown as DriverMessage[] };
    },
  };
  return { driver, push: (step) => pending.push(step) };
}

interface SubmitSnapshot {
  taskId: string;
  /** submit 调用发生的那一刻，底账里已绑定到本任务的副本 fileId。 */
  copyFileIds: string[];
}

interface Fixture {
  dir: string;
  platformRoot: string;
  session: Session;
  main: MainCapture;
  mainPush(step: MainStep): void;
  worker: WorkerCapture;
  fileStore: FileStore;
  calls: FaceCall[];
  store: ReturnType<typeof openTaskStore>;
  ro: ReturnType<typeof openTaskStore>;
  runner: TaskRunner;
  /** submit 时刻的副本快照（证明复制发生在任务受理之前）。 */
  submitSnapshots: SubmitSnapshot[];
  reasons: string[];
  close(): void;
}

async function makeFixture(input: {
  worker?: TurnDriver;
  /** 不注入文件桥（对照：零变化缺省）。 */
  withoutBridge?: boolean;
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-bg-input-files-'));
  tempDirs.push(dir);
  const platformRoot = path.join(dir, 'platform');
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const calls: FaceCall[] = [];
  const client = faceClient(calls);
  const workerCapture: WorkerCapture = { delegationTexts: [], toolNames: [] };
  const reasons: string[] = [];

  const executor: TaskExecutor = await createTaskExecutor({
    client,
    allowedOperations: ['dummy.query'],
    readOnlyOperations: ['dummy.query'],
    workerDriver: input.worker ?? backgroundWorker(workerCapture),
    registry,
    workerWorkspaceRoot: platformRoot,
    ...(input.withoutBridge === true
      ? {}
      : {
          backgroundTaskBridge: ({ principalId, sessionId, taskId }) => createTaskExecutionBridge({
            platformRoot,
            fileStore,
            scope: { principalId, sessionId },
            inner: client,
            fileParams: { input: '--input' },
          })(taskId),
        }),
    onFileRefUnavailable: (reason) => reasons.push(reason),
  });

  const realRunner = createTaskRunner({ registry, policy: createResourcePolicy(), executor });
  const submitSnapshots: SubmitSnapshot[] = [];
  // submit 包装：在任务行创建的同一瞬间拍下底账里已绑定的副本——这是「复制先于受理」的黑盒判据。
  const runner: TaskRunner = {
    submit(taskInput) {
      submitSnapshots.push({
        taskId: taskInput.taskId,
        copyFileIds: registry.store
          .listFileRefs(SCOPE)
          .filter((row) => row.taskId === taskInput.taskId)
          .map((row) => row.fileId),
      });
      return realRunner.submit(taskInput);
    },
    pump: () => realRunner.pump(),
    whenIdle: () => realRunner.whenIdle(),
    cancel: (taskId, scope) => realRunner.cancel(taskId, scope),
    resume: (taskId, options) => realRunner.resume(taskId, options),
    inFlight: () => realRunner.inFlight(),
  };

  const mainCapture: MainCapture = { results: [], toolErrors: [] };
  const main = queueMainDriver(mainCapture);
  const copier: TaskInputCopier = fileStore;
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client,
    allowedOperations: ['dummy.query'],
    mainDriver: main.driver,
    workerDriver: input.worker ?? workerNeverCalled,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    dispatchMode: 'background',
    taskRunner: runner,
    taskRunWaitMs: 0,
    taskInputCopier: copier,
    onFileRefUnavailable: (reason) => reasons.push(reason),
  });

  return {
    dir,
    platformRoot,
    session,
    main: mainCapture,
    mainPush: main.push,
    worker: workerCapture,
    fileStore,
    calls,
    store: registry.store,
    ro: openTaskStore(dbPath, { readOnly: true }),
    runner,
    submitSnapshots,
    reasons,
    close: () => {
      registry.close();
    },
  };
}

function putActiveSource(fx: Fixture, name: string, bytes: Buffer) {
  return fx.fileStore.putFile({ scope: SCOPE, name, bytes, activatedAt: Date.now() - 1_000 });
}

describe('background 派发 + inputFiles（第 1 片）', () => {
  it('① 交办复制先于 submit；后台 Worker 从任务副本物化并读到内容（副本在任务目录、字节一致）', async () => {
    const fx = await makeFixture();
    try {
      const sourceBytes = Buffer.from('id,name\n1,甲\n2,乙\n');
      const source = putActiveSource(fx, '名册.csv', sourceBytes);
      fx.mainPush({
        execCalls: [{ tool: 'task_run', args: { task: '按名册核对', inputFiles: [source.fileId] } }],
        text: '已交办，后台办理中。',
      });
      await fx.session.send('把这份名册交给后台处理');
      await fx.runner.whenIdle();

      // 受理事实：background 不再拒绝带文件的任务。
      const receipt = fx.main.results[0] as Record<string, unknown>;
      expect(receipt['accepted']).toBe(true);
      const taskId = String(receipt['taskId']);
      const task = fx.session.getTask(taskId);
      expect(task.status).toBe('completed');

      // ①-1 复制先于 submit：submit 那一刻底账里已有绑定本任务的副本。
      expect(fx.submitSnapshots).toHaveLength(1);
      expect(fx.submitSnapshots[0]!.taskId).toBe(taskId);
      expect(fx.submitSnapshots[0]!.copyFileIds).toHaveLength(1);

      // ①-2 副本事实：task_id 绑定、sha256/bytes 与原件一致、原件行不动。
      const rows = fx.ro.listFileRefs(SCOPE);
      const copyRows = rows.filter((row) => row.taskId === taskId);
      expect(copyRows).toHaveLength(1);
      expect(copyRows[0]!.sha256).toBe(source.sha256);
      expect(copyRows[0]!.bytes).toBe(sourceBytes.length);
      expect(copyRows[0]!.name).toBe('名册.csv');
      expect(copyRows[0]!.fileId).not.toBe(source.fileId);
      expect(rows.filter((row) => row.taskId === undefined).map((row) => row.fileId)).toEqual([source.fileId]);

      // ①-3 Worker 收到任务文件清单（副本 fileId；Main 源 fileId 不进 Worker 转录）。
      expect(fx.worker.delegationTexts).toHaveLength(1);
      const delegation = fx.worker.delegationTexts[0]!;
      expect(delegation).toContain(copyRows[0]!.fileId);
      expect(delegation).not.toContain(source.fileId);

      // ①-4 Worker 侧从任务副本物化到任务目录，字节一致，执行层读到内容。
      expect(fx.calls).toHaveLength(1);
      const taskDir = path.join(fx.platformRoot, 'tmp', `task_${taskId}`);
      const materializedPath = path.join(taskDir, 'in', `${copyRows[0]!.fileId}.csv`);
      expect(fx.calls[0]!.inputPath).toBe(materializedPath);
      expect(readFileSync(materializedPath)).toEqual(sourceBytes);
      expect(fx.calls[0]!.content).toBe(sourceBytes.toString('utf8'));
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('② 非法 fileId（不存在/未激活/已过期）→ 整次拒绝：零任务行、零副本、不进 Worker', async () => {
    const fx = await makeFixture();
    try {
      const good = putActiveSource(fx, '好.csv', Buffer.from('good'));
      const pending = fx.fileStore.putFile({ scope: SCOPE, name: '待激活.csv', bytes: Buffer.from('pending') });
      const expired = fx.fileStore.putFile({
        scope: SCOPE,
        name: '过期.csv',
        bytes: Buffer.from('expired'),
        activatedAt: Date.now() - FILE_REF_TTL_MS - 1_000,
      });

      fx.mainPush({
        execCalls: [
          { tool: 'task_run', args: { task: '不存在的文件', inputFiles: ['file_absent'] } },
          { tool: 'task_run', args: { task: '未激活的文件', inputFiles: [pending.fileId] } },
          { tool: 'task_run', args: { task: '已过期的文件', inputFiles: [expired.fileId] } },
          // 混入可用文件：仍然整次拒绝（不部分执行、不部分复制）。
          { tool: 'task_run', args: { task: '好文件混坏文件', inputFiles: [good.fileId, 'file_absent'] } },
        ],
        text: '收到。',
      });
      await fx.session.send('交办几个带文件的任务');
      await fx.runner.whenIdle();

      // 四次都确定性拒绝，统一话术（不泄露存在性/状态差异）。
      expect(fx.main.toolErrors).toHaveLength(4);
      for (const message of fx.main.toolErrors) {
        expect(message).toContain('输入文件不可用');
        expect(message).toContain('不存在、未激活或已过期');
        expect(message).not.toContain('missing_or_foreign');
      }
      // 零任务行、零副本（含可用源文件也不复制）；源行仍只有那 3 条（good/pending/expired）。
      expect(fx.session.tasks()).toHaveLength(0);
      const rows = fx.ro.listFileRefs(SCOPE);
      expect(rows.filter((row) => row.taskId !== undefined)).toHaveLength(0);
      expect(rows.map((row) => row.fileId).sort()).toEqual([good.fileId, pending.fileId, expired.fileId].sort());
      // 机械 reason 只进日志面（不存在/未激活/过期各自机械原因；话术已统一）。
      expect(fx.reasons.length).toBeGreaterThanOrEqual(3);
      expect(fx.reasons.every((reason) => /^(missing_or_foreign|pending|expired):/.test(reason))).toBe(true);
      // 没进 Worker、没进执行层。
      expect(fx.worker.delegationTexts).toHaveLength(0);
      expect(fx.calls).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('③ 跨 principal 的 fileId → 与不存在同错（拒绝；零任务行、零副本）', async () => {
    const fx = await makeFixture();
    try {
      const foreign = fx.fileStore.putFile({
        scope: { principalId: 'wecom:other-user', sessionId: 'sess_other' },
        name: '别人的.xlsx',
        bytes: Buffer.from('foreign'),
        activatedAt: Date.now(),
      });
      fx.mainPush({
        execCalls: [{ tool: 'task_run', args: { task: '处理别人的文件', inputFiles: [foreign.fileId] } }],
        text: '收到。',
      });
      await fx.session.send('交办跨身份文件');
      await fx.runner.whenIdle();

      expect(fx.main.toolErrors).toHaveLength(1);
      expect(fx.main.toolErrors[0]).toContain('输入文件不可用');
      expect(fx.main.toolErrors[0]).not.toContain(foreign.fileId);
      expect(fx.session.tasks()).toHaveLength(0);
      expect(fx.ro.listFileRefs(SCOPE)).toHaveLength(0);
      // 对方作用域的文件行原样（未被读取/复制/删除）。
      expect(fx.store.getFileRef(foreign.fileId, { principalId: 'wecom:other-user', sessionId: 'sess_other' }, { side: 'main' }))
        .toMatchObject({ fileId: foreign.fileId, name: '别人的.xlsx' });
      expect(fx.reasons).toEqual([`missing_or_foreign:${foreign.fileId}`]);
      expect(fx.worker.delegationTexts).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('零变化缺省：未注入文件桥时 background 带文件任务照常受理（Worker 拿不到文件面，但不静默丢任务）', async () => {
    // 本用例只钉住「受理」不再因 mode 被拒；文件面注入是装配决定（缺省零变化）。
    const fx = await makeFixture({ withoutBridge: true, worker: workerNeverCalled });
    try {
      const source = putActiveSource(fx, '名册.csv', Buffer.from('id,name\n1,甲\n'));
      fx.mainPush({
        execCalls: [{ tool: 'task_run', args: { task: '处理名册', inputFiles: [source.fileId] } }],
        text: '已交办。',
      });
      await fx.session.send('后台交办带文件任务');
      await fx.runner.whenIdle();
      const receipt = fx.main.results[0] as Record<string, unknown>;
      expect(receipt['accepted']).toBe(true);
      // 交办副本仍已建立（宿主侧事实）；Worker 面因未注入桥而零文件（不冒充已交付）。
      const copyRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId !== undefined);
      expect(copyRows).toHaveLength(1);
      expect(fx.worker.delegationTexts).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
