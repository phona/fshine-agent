/**
 * 片 1（feat/worker-run-js）：**后台** Worker 获得 run_js + 产物回程 · 确定性验证。
 *
 * 覆盖：
 *   ① createBackgroundDispatch → createTaskExecutor 的 runJsExecutor 接线：后台任务里
 *      Worker 用 run_js 真跑 exceljs 生成 xlsx → 产物登记为**任务作用域**文件
 *      （task_id 绑定、deliverable=true）、任务结局 files 含它、完成回调收到 1 份；
 *   ② 输入作用域：Worker run_js 引用 Main 侧文件（task_id IS NULL）→ 同一句「输入文件
 *      不可用」话术（读不到原文件）；引用**任务副本**（task_id 绑定）→ 正常读到；
 *   ③ 零变化对照：未注入 runJsExecutor → Worker 工具面与现行逐字节相同（只有
 *      execute_operation），直调 run_js fail-closed 拒绝，且不登记任何文件。
 *
 * 零网络：假执行层客户端 + 脚本化 Worker 驱动；run_js 走真实受限执行器
 * （Node 权限模型子进程）；投递面不在本文件（server 级另有断言）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import { openTaskStore } from '@fshine/core';
import { readFileSync } from 'node:fs';
import { createFileStore, fileStoragePathOf, type FileStore } from './src/file-store';
import { createResourcePolicy } from './src/resource-policy';
import { createBackgroundDispatch, type BackgroundTaskCompletion } from '../../scripts/ask-runtime';
import { createRunJsExecutor, type RunJsExecutor } from './src/run-js-executor';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import type { DriverMessage, TurnDriver } from './src/driver-contract';
import {
  EXECUTE_OPERATION_TOOL,
  EXECUTE_OPERATION_TOOL_DESCRIPTION,
  EXECUTE_OPERATION_TOOL_SCHEMA,
  RUN_JS_TOOL,
} from './src/execution-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:test-user', sessionId: 'wecom:conv-bg' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worker-bg-run-js-'));
  tempDirs.push(dir);
  return dir;
}

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

interface WorkerCall {
  tool: string;
  args: Record<string, unknown>;
}

interface WorkerRecord {
  tools: Array<Array<{ name: string; description: string; inputSchema: unknown }>>;
  results: unknown[];
  errors: string[];
}

/** 一次后台 Worker 回合：按脚本调用工具（与真实驱动同一 exec 语义），返回汇报文本。 */
function scriptedWorker(
  calls: ReadonlyArray<WorkerCall>,
  record: WorkerRecord,
  text = '已生成汇总表。',
): TurnDriver {
  return {
    async run(input) {
      record.tools.push(input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })));
      for (const call of calls) {
        try {
          record.results.push(await input.exec(call.tool, call.args));
        } catch (error) {
          record.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { text, messages: [] as unknown as DriverMessage[] };
    },
  };
}

/** 真 run_js 脚本：用 exceljs 写 out/汇总.xlsx（cwd = run 目录，out/ 由执行器预建）。 */
const WRITE_XLSX = `
const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('汇总');
  sheet.addRow(['客户', '金额']);
  sheet.addRow(['华远贸易', 21000]);
  await wb.xlsx.writeFile('out/汇总.xlsx');
})().catch((error) => { console.error(error && error.message ? error.message : String(error)); process.exit(1); });
`;

interface Fixture {
  fileStore: FileStore;
  store: ReturnType<typeof openTaskStore>;
  executor: RunJsExecutor;
  close(): void;
}

function makeFixture(): Fixture {
  const dir = tempDir();
  const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  return {
    fileStore,
    store: registry.store,
    executor: createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES }),
    close: () => registry.close(),
  };
}

/** 用生产装配（createBackgroundDispatch）起一个后台派发，真跑一次任务并等落定。 */
async function runBackgroundTask(input: {
  fixture: Fixture;
  workerDriver: TurnDriver;
  withRunJsExecutor: boolean;
  taskId?: string;
}): Promise<{ completions: BackgroundTaskCompletion[]; taskId: string }> {
  const dir = tempDir();
  const registry = createSqliteTaskRegistry(path.join(dir, 'state.db'));
  const policy = createResourcePolicy({ backgroundConcurrency: 1, queueCapacity: 0 });
  const completions: BackgroundTaskCompletion[] = [];
  const taskId = input.taskId ?? 'task_bg_run_js_1';
  try {
    const dispatch = await createBackgroundDispatch({
      env: { LLM_MODEL: 'test-model' },
      profile: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: [] },
      stateDir: dir,
      registry,
      policy,
      emptyOperationsMessage: '（测试）空允许集合',
      face: { client: new FaceClient(), allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'] },
      workerDriver: input.workerDriver,
      ...(input.withRunJsExecutor ? { runJsExecutor: input.fixture.executor } : {}),
      onTaskCompleted: (completion) => completions.push(completion),
    });
    dispatch.runner.submit({
      taskId,
      principalId: SCOPE.principalId,
      sessionId: SCOPE.sessionId,
      request: '把数据做成一张汇总表。',
    });
    dispatch.runner.pump();
    await dispatch.runner.whenIdle();
    return { completions, taskId };
  } finally {
    registry.close();
  }
}

describe('片 1：后台 Worker run_js + 产物回程', () => {
  it('① 后台任务 run_js 生成 xlsx → 登记为任务作用域文件、结局 files 含它、完成回调 1 份', async () => {
    const fixture = makeFixture();
    const record: WorkerRecord = { tools: [], results: [], errors: [] };
    try {
      const { completions } = await runBackgroundTask({
        fixture,
        workerDriver: scriptedWorker([{ tool: RUN_JS_TOOL, args: { code: WRITE_XLSX } }], record),
        withRunJsExecutor: true,
      });

      // 工具面：后台 Worker 拿到 run_js（与 execute_operation 并列）。
      expect(record.tools[0]!.map((tool) => tool.name)).toEqual([EXECUTE_OPERATION_TOOL, RUN_JS_TOOL]);
      expect(record.errors).toEqual([]);
      // 脚本真跑成功（退出码 0，out/ 已登记一份产物）。
      const result = record.results[0] as Record<string, unknown>;
      expect(result['exitCode']).toBe(0);
      expect(Array.isArray(result['outputs'])).toBe(true);
      const outputs = result['outputs'] as Array<{ fileId: string; name: string; bytes: number }>;
      expect(outputs.map((file) => file.name)).toEqual(['汇总.xlsx']);

      // 登记事实：任务作用域（task_id 绑定）+ deliverable=true + 字节落盘可读。
      const completion = completions[0]!;
      expect(completion.files).toHaveLength(1);
      const delivered = completion.files![0]!;
      expect(delivered).toEqual({
        fileId: outputs[0]!.fileId,
        name: '汇总.xlsx',
        bytes: outputs[0]!.bytes,
      });
      const row = fixture.store.getFileRef(delivered.fileId, SCOPE, { side: 'worker', taskId: 'task_bg_run_js_1' });
      expect(row).toBeDefined();
      expect(row!.deliverable).toBe(true);
      // Main 面读不到该行（作用域绑定任务，不是会话文件）。
      expect(fixture.store.getFileRef(delivered.fileId, SCOPE, { side: 'main' })).toBeUndefined();
      // 字节落盘（登记是 copy-on-register，交付面按 fileId 从 workspace 现读）。
      const bytes = readFileSync(fileStoragePathOf(
        fixture.fileStore.workspaceRoot,
        SCOPE,
        delivered.fileId,
        delivered.name,
      ));
      expect(bytes.subarray(0, 2).toString('hex')).toBe('504b'); // xlsx = zip（PK）
    } finally {
      fixture.close();
    }
  }, 60_000);

  it('② Worker run_js 读不到 Main 侧原文件；任务副本可读（同码拒绝话术）', async () => {
    const fixture = makeFixture();
    const record: WorkerRecord = { tools: [], results: [], errors: [] };
    const taskId = 'task_bg_scope_1';
    // Main 侧（会话）文件：task_id IS NULL——后台 Worker 不得解析。
    const mainFile = fixture.fileStore.putFile({
      scope: SCOPE,
      name: '原始明细.xlsx',
      bytes: Buffer.from('main-side-bytes'),
      activatedAt: Date.now(),
    });
    // 任务副本（task_id 绑定）：模拟交办/回程登记的任务作用域文件。
    const taskCopy = fixture.fileStore.registerTaskFile({
      scope: SCOPE,
      taskId,
      name: '副本明细.txt',
      bytes: Buffer.from('task-copy-bytes'),
      maxFileBytes: 1024 * 1024,
    });
    try {
      const { completions } = await runBackgroundTask({
        fixture,
        taskId,
        workerDriver: scriptedWorker([
          // 越权读 Main 原件：确定性拒绝（同一句话术，不泄露存在性）。
          { tool: RUN_JS_TOOL, args: { code: "console.log('x');", inputs: [mainFile.fileId] } },
          // 读自己的任务副本：正常执行。
          { tool: RUN_JS_TOOL, args: { code: "console.log(require('node:fs').readFileSync('in/' + require('node:fs').readdirSync('in')[0], 'utf8'));", inputs: [taskCopy.fileId] } },
        ], record),
        withRunJsExecutor: true,
      });

      // ① Main 原件：同一句统一话术，且不含 fileId / 机械 reason。
      expect(record.errors).toHaveLength(1);
      expect(record.errors[0]).toContain('输入文件不可用');
      expect(record.errors[0]).not.toContain(mainFile.fileId);
      // ② 任务副本：脚本真的读到副本字节（stdout 原文）。
      const second = record.results[0] as Record<string, unknown>;
      expect(second['exitCode']).toBe(0);
      expect(String(second['stdout'])).toContain('task-copy-bytes');
      // 主文件行原样（未被复制/移动/绑定任务）；任务仍是 completed（第二次调用成功）。
      expect(fixture.store.getFileRef(mainFile.fileId, SCOPE, { side: 'main' })!.bytes).toBe(mainFile.bytes);
      expect(completions).toHaveLength(1);
    } finally {
      fixture.close();
    }
  }, 60_000);

  it('③ 未注入 runJsExecutor：Worker 工具面逐字节不变（只有 execute_operation），直调 fail-closed', async () => {
    const fixture = makeFixture();
    const record: WorkerRecord = { tools: [], results: [], errors: [] };
    try {
      await runBackgroundTask({
        fixture,
        workerDriver: scriptedWorker([
          { tool: EXECUTE_OPERATION_TOOL, args: { operation: 'dummy.query', args: {} } },
          { tool: RUN_JS_TOOL, args: { code: WRITE_XLSX } },
        ], record),
        withRunJsExecutor: false,
      });

      // 工具面零变化对照：数组与现行逐字节相同（只有 execute_operation，字段取常量原值）。
      expect(record.tools[0]).toEqual([{
        name: EXECUTE_OPERATION_TOOL,
        description: EXECUTE_OPERATION_TOOL_DESCRIPTION,
        inputSchema: EXECUTE_OPERATION_TOOL_SCHEMA,
      }]);
      expect(JSON.stringify(record.tools[0])).toBe(JSON.stringify([{
        name: 'execute_operation',
        description: EXECUTE_OPERATION_TOOL_DESCRIPTION,
        inputSchema: EXECUTE_OPERATION_TOOL_SCHEMA,
      }]));
      // 直调 run_js：门控拒绝（不进底账、不起子进程）。
      expect(record.errors).toEqual([`Worker 工具面之外的调用：${RUN_JS_TOOL}`]);
      // 零产物：file_refs 里没有任务行（没有 run_js 就没有产物登记）。
      expect(fixture.store.listFileRefs(SCOPE)).toEqual([]);
    } finally {
      fixture.close();
    }
  }, 60_000);
});
