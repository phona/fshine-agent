/**
 * CAP-01 S2 runtime 接线（run_task.inputFiles → 交办复制 → 作用域拒绝）· 确定性验证。
 *
 * 零网络：假客户端 + 脚本化主驱动（按步骤调 exec 的假 TurnDriver）；复制走真实
 * fileStore（:memory: 库 + 临时 workspace），Worker 驱动可脚本化（正路径）或钉死不调用。
 *
 * 覆盖（对应 ask ④⑤ 的 runtime 侧断言）：
 *   ④ inputFiles 混入他人 fileId → **整次 run_task 被拒**：统一话术回模型、机械 reason 只进
 *      onFileRefUnavailable、不建任务行、不进 Worker、零副本（不部分执行）；
 *   · 正路径：全部可用 → 交办时复制成任务私有副本（新 file_id、task_id 绑定、sha256 同原件、
 *     原件不动），任务照常受理与完成；inputFiles 不进 Worker 转录；
 *   ⑤ 不带 inputFiles 的 run_task 与改造前完全一致：未注入复制面时工具 schema 不含该属性
 *     （工具面逐字节不变）、任务照常；注入复制面后不带 inputFiles 也零副本、行为一致；
 *   · fail-closed：未注入复制面时模型传 inputFiles → 确定性拒绝；background 派发 + inputFiles
 *     → 确定性拒绝（本切片只做 inline）；Worker 的任务绑定 fileId 被 Main 引用 → 整次拒绝。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CapabilityManifest,
  ExecutionClient,
  ExecutionOutcome,
} from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import { createFileStore, type FileStore } from './src/file-store';
import {
  createSession,
  type Session,
  type TaskInputCopier,
} from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import type { TaskRunner } from './src/task-runner';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:test-user', sessionId: 'sess_1' };

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

class FaceClient implements ExecutionClient {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  }
}

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
};

/** Worker 发起一次结构化执行后汇报（inline 委派的正路径最小形状；零执行事实 → unexecuted）。 */
const workerExecutesOnce: TurnDriver = {
  async run(input) {
    await input.exec('execute_operation', { operation: 'dummy.query', args: { '--collection': 'documents' } });
    return { text: '已用任务输入文件完成处理。', messages: [] as unknown as DriverMessage[] };
  },
};

interface DriverStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface DriverCapture {
  toolNames: string[][];
  toolSchemas: Array<Record<string, unknown>>;
  results: unknown[];
  toolErrors: string[];
}

/** 按外部步骤队列驱动的假主驱动：exec 错误按真实驱动的语义记为工具结果消息（回合继续）。 */
function queueDriver(capture: DriverCapture): { driver: TurnDriver; push(step: DriverStep): void } {
  const pending: DriverStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      capture.toolSchemas.push(Object.fromEntries(input.tools.map((tool) => [tool.name, tool.inputSchema])));
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
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

interface Fixture {
  dir: string;
  session: Session;
  capture: DriverCapture;
  push(step: DriverStep): void;
  fileStore: FileStore;
  /** 可写底账（夹具播种用；与 fileStore 同一连接）。 */
  store: ReturnType<typeof openTaskStore>;
  ro: ReturnType<typeof openTaskStore>;
  reasons: string[];
  close(): void;
}

async function makeFixture(input: {
  withCopier?: boolean;
  worker?: TurnDriver;
  dispatchMode?: 'inline' | 'background';
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-run-task-files-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const copier: TaskInputCopier | undefined = input.withCopier === false ? undefined : fileStore;
  const capture: DriverCapture = { toolNames: [], toolSchemas: [], results: [], toolErrors: [] };
  const { driver, push } = queueDriver(capture);
  const reasons: string[] = [];
  const stubRunner: TaskRunner = {
    submit: () => {
      throw new Error('（测试）background 不应受理');
    },
    pump: () => {
      throw new Error('（测试）background 不应派发');
    },
    whenIdle: async () => {
      throw new Error('（测试）');
    },
    cancel: () => {
      throw new Error('（测试）');
    },
    resume: () => {
      throw new Error('（测试）');
    },
    inFlight: () => [],
  };
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: driver,
    workerDriver: input.worker ?? workerNeverCalled,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    ...(input.dispatchMode === undefined ? {} : { dispatchMode: input.dispatchMode }),
    ...(input.dispatchMode === 'background' ? { taskRunner: stubRunner } : {}),
    ...(copier === undefined ? {} : { taskInputCopier: copier }),
    onFileRefUnavailable: (reason) => reasons.push(reason),
  });
  return {
    dir,
    session,
    capture,
    push,
    fileStore,
    store: registry.store,
    ro: openTaskStore(dbPath, { readOnly: true }),
    reasons,
    close: () => {
      registry.close();
    },
  };
}

/** Main 侧已激活源文件（TTL 内）。 */
function putActiveSource(fx: Fixture, name: string, bytes: Buffer) {
  return fx.fileStore.putFile({ scope: SCOPE, name, bytes, activatedAt: Date.now() - 1_000 });
}

describe('CAP-01 S2 runtime 接线（run_task.inputFiles / 交办复制）', () => {
  it('④ inputFiles 混入他人 fileId → 整次 run_task 被拒：统一话术、零任务行、不进 Worker、零副本', async () => {
    const fx = await makeFixture();
    try {
      const good = putActiveSource(fx, '好.csv', Buffer.from('good'));
      const foreign = fx.fileStore
        .putFile({
          scope: { principalId: 'wecom:other-user', sessionId: 'sess_9' },
          name: '别人.xlsx',
          bytes: Buffer.from('foreign'),
          activatedAt: Date.now(),
        })
        .fileId;

      fx.push({ execCalls: [{ tool: 'run_task', args: { task: '处理这份名单', inputFiles: [good.fileId, foreign] } }], text: '收到' });
      await fx.session.send('交办一个带名单的任务');

      // 统一话术（与 run_js 输入不可用同码同形；不泄露存在性/状态差异，不含 fileId/reason）。
      expect(fx.capture.toolErrors).toHaveLength(1);
      const message = fx.capture.toolErrors[0]!;
      expect(message).toContain('输入文件不可用');
      expect(message).toContain('不存在、未激活或已过期');
      expect(message).not.toContain(good.fileId);
      expect(message).not.toContain(foreign);
      expect(message).not.toContain('missing_or_foreign');
      // 机械 reason 只进回调（日志面）。
      expect(fx.reasons).toHaveLength(1);
      expect(fx.reasons[0]!.startsWith('missing_or_foreign:')).toBe(true);

      // 整次拒绝：不建任务行、不进 Worker、零副本（可用文件也不复制——不部分执行）。
      expect(fx.session.tasks()).toHaveLength(0);
      expect(fx.ro.listFileRefs(SCOPE).every((row) => row.taskId === undefined)).toBe(true);
      expect(fx.ro.listFileRefs(SCOPE).map((row) => row.fileId).sort()).toEqual([good.fileId].sort());
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('正路径：交办复制成任务私有副本（新 file_id、task_id 绑定、sha256 同原件、原件不动），任务照常完成', async () => {
    const fx = await makeFixture({ worker: workerExecutesOnce });
    try {
      const sourceBytes = Buffer.from('id,name\n1,甲\n2,乙\n');
      const source = putActiveSource(fx, '名册.csv', sourceBytes);
      const sourceRowBefore = fx.store.getFileRef(source.fileId, SCOPE, { side: 'main' })!;

      fx.push({ execCalls: [{ tool: 'run_task', args: { task: '按名册核对', inputFiles: [source.fileId] } }], text: '核对完成。' });
      const turn = await fx.session.send('交办核对任务');

      expect(turn.taskIds).toHaveLength(1);
      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(task.status).toBe('completed');

      // 副本事实：task_id = 本任务、sha256/bytes 与原件一致、登记即激活。
      const rows = fx.ro.listFileRefs(SCOPE);
      const copyRows = rows.filter((row) => row.taskId === task.taskId);
      expect(copyRows).toHaveLength(1);
      expect(copyRows[0]!.sha256).toBe(source.sha256);
      expect(copyRows[0]!.bytes).toBe(sourceBytes.length);
      expect(copyRows[0]!.name).toBe('名册.csv');
      expect(copyRows[0]!.activatedAt).toBeDefined();
      expect(copyRows[0]!.fileId).not.toBe(source.fileId);

      // 原件不动（行原样；字节仍归 Main 作用域）。
      expect(fx.store.getFileRef(source.fileId, SCOPE, { side: 'main' })!).toEqual(sourceRowBefore);
      expect(fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === undefined).map((row) => row.fileId)).toEqual([
        source.fileId,
      ]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('⑤ 不带 inputFiles 的 run_task 与改造前完全一致：未注入复制面时 schema 不含该属性；注入后也不产生副本', async () => {
    // 未注入复制面：run_task 的 schema 与既有逐字节语义相同（无 inputFiles 属性）。
    const bare = await makeFixture({ withCopier: false, worker: workerExecutesOnce });
    try {
      bare.push({ execCalls: [{ tool: 'run_task', args: { task: '查询 documents W202611' } }], text: '查询完成。' });
      const turn = await bare.session.send('交办查询任务');
      expect(bare.capture.toolSchemas[0]!['run_task']).toEqual({
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '要交给执行层 Worker 的任务：写清对象、范围与要回答的问题；用自然语言，不要写命令。',
          },
        },
        required: ['task'],
        additionalProperties: false,
      });
      expect(turn.taskIds).toHaveLength(1);
      expect(bare.session.getTask(turn.taskIds[0]!).status).toBe('completed');
      expect(bare.ro.listFileRefs(SCOPE)).toHaveLength(0);
    } finally {
      bare.ro.close();
      bare.close();
    }

    // 注入复制面：schema 带 inputFiles（可选；required 仍只有 task）；不带 inputFiles 的
    // 调用零副本、任务照常（与改造前行为一致）。
    const withCopier = await makeFixture({ worker: workerExecutesOnce });
    try {
      withCopier.push({ execCalls: [{ tool: 'run_task', args: { task: '查询 documents W202611' } }], text: '查询完成。' });
      const turn = await withCopier.session.send('交办查询任务（不带文件）');

      const schema = withCopier.capture.toolSchemas[0]!['run_task'] as Record<string, unknown>;
      expect(schema['additionalProperties']).toBe(false);
      expect(schema['required']).toEqual(['task']);
      expect(Object.keys(schema['properties'] as Record<string, unknown>)).toEqual(['task', 'inputFiles']);
      expect((schema['properties'] as Record<string, unknown>)['inputFiles']).toEqual({
        type: 'array',
        items: { type: 'string' },
        description: '随任务交给执行层处理的输入文件 fileId 列表（来自文件清单；宿主复制为任务私有副本，原件不动）。',
      });

      expect(turn.taskIds).toHaveLength(1);
      expect(withCopier.session.getTask(turn.taskIds[0]!).status).toBe('completed');
      expect(withCopier.ro.listFileRefs(SCOPE)).toHaveLength(0);
    } finally {
      withCopier.ro.close();
      withCopier.close();
    }
  });

  it('fail-closed：未注入复制面时模型传 inputFiles → 确定性拒绝（无任务行、不进 Worker）', async () => {
    const fx = await makeFixture({ withCopier: false });
    try {
      fx.push({ execCalls: [{ tool: 'run_task', args: { task: '处理名单', inputFiles: ['file_any'] } }], text: '收到' });
      await fx.session.send('交办带文件的任务');
      expect(fx.capture.toolErrors).toHaveLength(1);
      expect(fx.capture.toolErrors[0]).toContain('inputFiles 未开通');
      expect(fx.session.tasks()).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('fail-closed：background 派发 + inputFiles → 确定性拒绝（本切片只做 inline，不静默丢文件）', async () => {
    const fx = await makeFixture({ dispatchMode: 'background' });
    try {
      const source = putActiveSource(fx, '后台.csv', Buffer.from('bg'));
      fx.push({
        execCalls: [{ tool: 'run_task', args: { task: '后台处理', inputFiles: [source.fileId] } }],
        text: '收到',
      });
      await fx.session.send('后台交办带文件的任务');
      expect(fx.capture.toolErrors).toHaveLength(1);
      expect(fx.capture.toolErrors[0]).toContain('background');
      expect(fx.session.tasks()).toHaveLength(0);
      expect(fx.ro.listFileRefs(SCOPE).every((row) => row.taskId === undefined)).toBe(true);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('② Worker 的 fileId（任务绑定行）被 Main 引用 → 整次 run_task 拒绝（同码话术，机械 reason 只进日志）', async () => {
    const fx = await makeFixture();
    try {
      // 直接播种一条任务绑定行（Worker 侧文件事实的形状；Worker 接 run_js 归后续切片）。
      fx.store.insertFileRef({
        fileId: 'file_taskbound',
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        taskId: 'task_someone',
        name: '任务产物.csv',
        sha256: 'sha_tb',
        bytes: 3,
        activatedAt: Date.now(),
        createdAt: Date.now(),
      });

      fx.push({ execCalls: [{ tool: 'run_task', args: { task: '处理任务产物', inputFiles: ['file_taskbound'] } }], text: '收到' });
      await fx.session.send('交办引用任务绑定文件');

      expect(fx.capture.toolErrors).toHaveLength(1);
      expect(fx.capture.toolErrors[0]).toContain('输入文件不可用');
      expect(fx.capture.toolErrors[0]).not.toContain('file_taskbound');
      expect(fx.reasons).toEqual(['missing_or_foreign:file_taskbound']);
      expect(fx.session.tasks()).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('inputFiles 形状校验：非数组 / 空 fileId → 确定性拒绝（无任务行）', async () => {
    const fx = await makeFixture();
    try {
      fx.push({
        execCalls: [
          { tool: 'run_task', args: { task: 'a', inputFiles: 'file_x' } },
          { tool: 'run_task', args: { task: 'b', inputFiles: [''] } },
        ],
        text: '收到',
      });
      await fx.session.send('交办形状错误的任务');
      expect(fx.capture.toolErrors).toHaveLength(2);
      expect(fx.capture.toolErrors[0]).toBe('run_task 的 inputFiles 必须是 fileId 数组。');
      expect(fx.capture.toolErrors[1]).toBe('run_task 的 inputFiles 含空 fileId（请用文件清单里给出的 fileId）。');
      expect(fx.session.tasks()).toHaveLength(0);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
