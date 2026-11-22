/**
 * CAP-01 S2 ①⑥：Worker 工具面接 run_js（任务作用域）· 确定性验证。
 *
 * 覆盖（ask ①②⑥ 对应的 runtime 侧断言）：
 *   ① Worker 处理链：task_run.inputFiles 交办复制 → Worker run_js 读 in/ 写 out/ →
 *      产物登记成**新 fileId**（task_id 绑定本任务）、**原件（Main 源与交办副本）字节与
 *      行原样不动**；产物事实随本回合 TurnResult.files 带出（交付面）；
 *   ⑥ 工具面门控：注入 runJsExecutor 时 Worker 工具面才有 run_js；未注入时工具面只有
 *      execute_operation，exec 直调 run_js → fail-closed 拒绝；
 *   · 任务文件清单（机械事实）随委派进入 Worker 转录：**副本 fileId/name/bytes** 可见、
 *     Main 的源 fileId 不可见（inputFiles 的 Main 侧引用不进 Worker 转录，S2 前半口径）；
 *   ② 数据面：输入单元格数值只走文件字节——worker 委派文本、工具参数、工具返回、汇报
 *     文本里 grep 不到任何单元格数值（正对照：机械事实 fileId 必须在捕获里出现，
 *     证明捕获非空、grep 有牙）；
 *   · 幂等（v8 §5）：同 code+inputs 重放命中 memo，不重跑、不重复登记。
 *
 * 零网络：假客户端 + 脚本化双驱动；run_js 走真实受限执行器（Node 权限模型子进程）。
 */
import { executionsOf, lastExecutionOf, lastFailureOf, archivedReportOf, taskLivenessOf, taskUnstartedOf, taskReportedOf } from './testing/task-facts';
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
  type RunJsLayoutUnsafeReport,
} from './src/execution-runtime';
import {
  createRunJsExecutor,
  RUN_JS_LAYOUT_UNSAFE_MESSAGE,
  RunJsLayoutUnsafeError,
  type RunJsExecutor,
} from './src/run-js-executor';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { ToolUserError, type DriverMessage, type TurnDriver, type TurnDriverResult } from './src/driver-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCOPE = { principalId: 'wecom:test-user', sessionId: 'sess_s2w' };

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

interface MainStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface MainCapture {
  toolNames: string[][];
  results: unknown[];
  toolErrors: string[];
}

/** 按步骤队列驱动的假 Main 驱动：exec 错误记为工具错误（回合继续）。 */
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
  execCalls?: ReadonlyArray<{ tool: string; args: WorkerArgSpec; signal?: AbortSignal }>;
  text: string;
}

interface WorkerCapture {
  toolNames: string[][];
  prompts: string[];
  delegationTexts: string[];
  results: unknown[];
  toolErrors: string[];
  /** 原始异常对象（判 ToolUserError 等类型的确定性面）。 */
  toolErrorObjects: unknown[];
}

/**
 * 按步骤队列驱动的假 Worker 驱动。execCalls 的 args 支持**委派文本后解析**的工厂
 * （(delegation) => args）——任务副本 fileId 在建 Worker 回合时才存在，Worker 面的
 * 引用只能来自委派里的任务文件清单（机械事实），这正是 S2 的接线口径。
 */
function scriptedWorkerDriver(capture: WorkerCapture): { driver: TurnDriver; push(step: WorkerStep): void } {
  const pending: WorkerStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      capture.prompts.push(input.systemPrompt);
      const delegation = input.messages.at(-1) as unknown as { content?: unknown } | undefined;
      const delegationText = typeof delegation?.content === 'string' ? delegation.content : JSON.stringify(delegation?.content ?? '');
      capture.delegationTexts.push(delegationText);
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多 Worker 驱动步骤');
      for (const call of step.execCalls ?? []) {
        const args = typeof call.args === 'function' ? call.args(delegationText) : call.args;
        try {
          capture.results.push(await input.exec(call.tool, args, call.signal));
        } catch (error) {
          capture.toolErrors.push(error instanceof Error ? error.message : String(error));
          capture.toolErrorObjects.push(error);
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

/** 从委派文本里的任务文件清单提取 fileId（正对照用；也证明清单确实进了 Worker 转录）。 */
function fileIdsInDelegation(delegationText: string): string[] {
  return [...delegationText.matchAll(/fileId: (file_[0-9a-f]{32})/g)].map((match) => match[1]!);
}

interface Fixture {
  dir: string;
  session: Session;
  main: MainCapture;
  mainPush(step: MainStep): void;
  worker: WorkerCapture;
  workerPush(step: WorkerStep): void;
  fileStore: FileStore;
  store: ReturnType<typeof openTaskStore>;
  ro: ReturnType<typeof openTaskStore>;
  reasons: string[];
  close(): void;
}

async function makeFixture(input: {
  withRunJsExecutor?: boolean;
  /** 测试替身执行器（布局不安全用例；缺省 = 真实受限执行器）。 */
  executor?: RunJsExecutor;
  /** 真实执行器的宿主超时（缺省 30s；超时用例用极短值注入真实时间墙）。 */
  runJsTimeoutMs?: number;
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-worker-run-js-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const runJsExecutor: RunJsExecutor | undefined = input.executor
    ?? (input.withRunJsExecutor === false
      ? undefined
      : createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES, timeoutMs: input.runJsTimeoutMs ?? 30_000 }));
  const mainCapture: MainCapture = { toolNames: [], results: [], toolErrors: [] };
  const main = queueMainDriver(mainCapture);
  const workerCapture: WorkerCapture = {
    toolNames: [],
    prompts: [],
    delegationTexts: [],
    results: [],
    toolErrors: [],
    toolErrorObjects: [],
  };
  const worker = scriptedWorkerDriver(workerCapture);
  const reasons: string[] = [];
  const copier: TaskInputCopier = fileStore;
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: main.driver,
    workerDriver: worker.driver,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    taskInputCopier: copier,
    ...(runJsExecutor === undefined ? {} : { runJsExecutor }),
    ...(input.onRunJsLayoutUnsafe === undefined ? {} : { onRunJsLayoutUnsafe: input.onRunJsLayoutUnsafe }),
    onFileRefUnavailable: (reason) => reasons.push(reason),
  });
  return {
    dir,
    session,
    main: mainCapture,
    mainPush: main.push,
    worker: workerCapture,
    workerPush: worker.push,
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

/** Worker 侧 run_js 脚本：读 in/ 第一个文件、写 out/ 汇总（不打印任何单元格数值）。 */
const WORKER_SCRIPT_WITHOUT_LEAK = [
  "const fs = require('node:fs');",
  "const src = fs.readdirSync('in')[0];",
  "const raw = fs.readFileSync('in/' + src, 'utf8');",
  "const rows = raw.trim().split('\\n').length - 1;",
  "fs.writeFileSync('out/汇总.csv', 'rows=' + rows + '\\n');",
  "console.log('done');",
].join('\n');

describe('CAP-01 S2 ① Worker 接 run_js（任务作用域）', () => {
  it('① Worker 处理 → 产物登记成新 fileId（task 绑定）、原件与交办副本原样不动；产物进本回合交付事实', async () => {
    const fx = await makeFixture();
    try {
      const sourceBytes = Buffer.from('id,name\n1,甲\n2,乙\n');
      const source = putActiveSource(fx, '名册.csv', sourceBytes);
      const sourceRowBefore = fx.store.getFileRef(source.fileId, SCOPE, { side: 'main' })!;
      fx.workerPush({
        execCalls: [
          { tool: 'run_js', args: (delegation) => ({ code: WORKER_SCRIPT_WITHOUT_LEAK, inputs: fileIdsInDelegation(delegation) }) },
          { tool: 'execute_operation', args: { operation: 'dummy.query', args: { '--collection': 'documents' } } },
        ],
        text: '已按名册完成核对。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '按名册核对', inputFiles: [source.fileId] } }], text: '核对完成。' });
      const turn = await fx.session.send('交办核对任务');

      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(lastExecutionOf(task)?.status).toBe('completed');

      // 产物事实：新 fileId、task_id 绑定本任务、登记即激活；随 TurnResult.files 带出（交付面）。
      const productRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId && row.name === '汇总.csv');
      expect(productRows).toHaveLength(1);
      const product = productRows[0]!;
      expect(product.fileId).toMatch(/^file_[0-9a-f]{32}$/);
      expect(product.activatedAt).toBeDefined();
      expect(product.fileId).not.toBe(source.fileId);
      expect(turn.files).toEqual([{ fileId: product.fileId, name: '汇总.csv', bytes: product.bytes }]);

      // 交办副本与 Main 原件原样不动（行原样；副本字节与源字节仍在原位）。
      const copyRows = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId && row.name === '名册.csv');
      expect(copyRows).toHaveLength(1);
      expect(copyRows[0]!.sha256).toBe(source.sha256);
      expect(fx.store.getFileRef(source.fileId, SCOPE, { side: 'main' })!).toEqual(sourceRowBefore);
      expect(fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === undefined).map((row) => row.fileId)).toEqual([source.fileId]);

      // Worker run_js 的工具返回只有机械事实（fileId/name/materializedName/outputs），无行数据。
      const runJsResult = JSON.stringify(fx.worker.results[0]);
      expect(runJsResult).toContain('materializedName');
      expect(runJsResult).not.toContain('1,甲');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('只靠脚本完成的任务不再被判 unexecuted（run_js 进执行事实）', async () => {
    const fx = await makeFixture();
    try {
      fx.workerPush({
        execCalls: [{ tool: 'run_js', args: { code: "require('node:fs').writeFileSync('out/纯脚本.txt', 'ok');" } }],
        text: '已用脚本处理完成。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '只用脚本办一件事' } }], text: '办完了。' });
      const turn = await fx.session.send('交办');
      const task = fx.session.getTask(turn.taskIds[0]!);
      // 修复前：底账里没有执行事实 → unexecuted；修复后脚本执行也算真实执行。
      expect(lastExecutionOf(task)?.status).toBe('completed');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('查询成功但脚本失败 → 任务判 failed（不再假绿）', async () => {
    const fx = await makeFixture();
    try {
      fx.workerPush({
        execCalls: [
          { tool: 'execute_operation', args: { operation: 'dummy.query', args: { '--collection': 'documents' } } },
          { tool: 'run_js', args: { code: 'process.exit(3);' } },
        ],
        text: '查询完成，脚本也跑过了。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '查完再算' } }], text: '完成。' });
      const turn = await fx.session.send('交办');
      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
      expect(lastFailureOf(task)?.error?.code ?? '').not.toBe('');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('查询成功但脚本超时 → 任务判 failed（超时写失败执行事实，不再假绿）', async () => {
    // 宿主时间墙用极短值注入（真实受限执行器）：死循环脚本被进程组 SIGKILL。
    // 超时只杀脚本、Worker 仍有预算 → Worker 正常汇报；底账若不写超时事实，
    // 「查询成功」会单独把任务判 completed——正是本用例要钉死的假绿。
    const fx = await makeFixture({ runJsTimeoutMs: 100 });
    try {
      fx.workerPush({
        execCalls: [
          { tool: 'execute_operation', args: { operation: 'dummy.query', args: { '--collection': 'documents' } } },
          { tool: 'run_js', args: { code: 'while (true) {}' } },
        ],
        text: '查询完成，脚本跑过了。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '查完再算' } }], text: '完成。' });
      const turn = await fx.session.send('交办');
      const task = fx.session.getTask(turn.taskIds[0]!);
      expect(['failed', 'refused']).toContain(lastExecutionOf(task)?.status);
      // 原因可读：机械合成里带 run_js 与超时事实，不是空话术。
      expect(lastFailureOf(task)?.error?.message ?? '').toContain('run_js');
      expect(lastFailureOf(task)?.error?.message ?? '').toContain('超时');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('宿主中止（killReason=abort）不写失败执行事实（取消归取消路径定性）', async () => {
    const fx = await makeFixture();
    try {
      const aborted = new AbortController();
      aborted.abort();
      fx.workerPush({
        execCalls: [
          { tool: 'execute_operation', args: { operation: 'dummy.query', args: { '--collection': 'documents' } } },
          // 预先取消信号 → 真实执行器不 spawn、返回 killReason=abort。
          { tool: 'run_js', args: { code: 'while (true) {}' }, signal: aborted.signal },
        ],
        text: '查询完成。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '查完再算' } }], text: '完成。' });
      const turn = await fx.session.send('交办');
      const task = fx.session.getTask(turn.taskIds[0]!);
      // abort 不进底账：只有查询这一条执行事实，不把取消伪装成 run_js 失败。
      expect(task.executions.map((execution) => [execution.operation, execution.status]))
        .toEqual([['dummy.query', 'completed']]);
      expect(lastExecutionOf(task)?.status).toBe('completed');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('同字节不同名的两份任务产物都保留、都交付（复用键含文件名）', async () => {
    const fx = await makeFixture();
    try {
      fx.workerPush({
        execCalls: [{
          tool: 'run_js',
          args: {
            code: [
              "const fs = require('node:fs');",
              "fs.writeFileSync('out/甲.csv', 'same-bytes');",
              "fs.writeFileSync('out/乙.csv', 'same-bytes');",
            ].join('\n'),
          },
        }],
        text: '两份表都生成了。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '生成两份同内容表' } }], text: '好了。' });
      const turn = await fx.session.send('交办');
      const names = (turn.files ?? []).map((file) => file.name).sort();
      // 修复前：乙.csv 会复用甲.csv 的 fileId 与名字 → 只剩一份。
      expect(names).toEqual(['乙.csv', '甲.csv']);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('② 转录与工具参数里 grep 不到任何单元格数值（正对照：机械事实在捕获里出现）', async () => {
    const fx = await makeFixture();
    try {
      const sourceBytes = Buffer.from('订单号,客户,金额\nF20261117-001,陈小明,12345.67\nF20261117-002,李大海,8765.43\n');
      const source = putActiveSource(fx, '订单.csv', sourceBytes);
      fx.workerPush({
        execCalls: [
          { tool: 'run_js', args: (delegation) => ({ code: WORKER_SCRIPT_WITHOUT_LEAK, inputs: fileIdsInDelegation(delegation) }) },
          { tool: 'execute_operation', args: { operation: 'dummy.query', args: { '--collection': 'orders' } } },
        ],
        text: '订单共 2 行，汇总已生成。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '统计订单行数', inputFiles: [source.fileId] } }], text: '统计完成：共 2 行。' });
      const turn = await fx.session.send('统计这份订单的行数');
      expect(turn.taskIds).toHaveLength(1);

      // 宿主→模型的全捕获面：Main 工具面/结果、Worker 提示词、委派文本、工具参数、工具返回、汇报。
      const surfaces = JSON.stringify({
        mainToolNames: fx.main.toolNames,
        mainResults: fx.main.results,
        mainErrors: fx.main.toolErrors,
        workerPrompts: fx.worker.prompts,
        workerDelegations: fx.worker.delegationTexts,
        workerResults: fx.worker.results,
        workerErrors: fx.worker.toolErrors,
        reply: turn.reply,
        files: turn.files,
      });
      // 正对照：机械事实（fileId/文件名/汇报）确实在捕获里——grep 有牙，不是空捕获。
      expect(surfaces).toContain('fileId: file_');
      expect(surfaces).toContain('订单.csv');
      expect(surfaces).toContain('汇总.csv');
      expect(surfaces).toContain('共 2 行');
      // 单元格数值一个都不出现（文件字节只走文件系统与 fileId）。
      for (const cell of ['陈小明', '李大海', '12345.67', '8765.43', 'F20261117-001', 'F20261117-002']) {
        expect(surfaces).not.toContain(cell);
      }
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('幂等（v8 §5）：同 code+inputs 的重放命中 memo——不重跑、不重复登记', async () => {
    const fx = await makeFixture();
    try {
      const source = putActiveSource(fx, '幂等.csv', Buffer.from('a,b\n1,2\n'));
      fx.workerPush({
        execCalls: [
          { tool: 'run_js', args: (delegation) => ({ code: WORKER_SCRIPT_WITHOUT_LEAK, inputs: fileIdsInDelegation(delegation) }) },
          { tool: 'run_js', args: (delegation) => ({ code: WORKER_SCRIPT_WITHOUT_LEAK, inputs: fileIdsInDelegation(delegation) }) },
        ],
        text: '已生成（第二次命中重放）。',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '生成汇总', inputFiles: [source.fileId] } }], text: '完成。' });
      const turn = await fx.session.send('交办幂等任务');

      // 两次 run_js 工具返回完全一致（同 outputs = 命中 memo）；产物行只有一条。
      expect(fx.worker.results[0]).toEqual(fx.worker.results[1]);
      const task = fx.session.getTask(turn.taskIds[0]!);
      const products = fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === task.taskId && row.name === '汇总.csv');
      expect(products).toHaveLength(1);
      expect(turn.files).toHaveLength(1);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('Worker 引用 Main 侧 fileId → 同码拒绝（统一话术，机械 reason 只进日志；脚本不起子进程）', async () => {
    const fx = await makeFixture();
    try {
      const mainFile = putActiveSource(fx, '主侧.csv', Buffer.from('main'));
      fx.workerPush({
        execCalls: [{ tool: 'run_js', args: { code: WORKER_SCRIPT_WITHOUT_LEAK, inputs: [mainFile.fileId] } }],
        text: 'noop',
      });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '越权引用', inputFiles: [mainFile.fileId] } }], text: '完成。' });
      await fx.session.send('交办越权引用');

      expect(fx.worker.toolErrors[0]).toContain('输入文件不可用');
      expect(fx.worker.toolErrors[0]).not.toContain(mainFile.fileId);
      expect(fx.reasons).toEqual([`missing_or_foreign:${mainFile.fileId}`]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});

describe('CAP-01 S2 ⑥ Worker 工具面门控', () => {
  it('⑥ 注入 runJsExecutor 时 Worker 工具面有 run_js；未注入时只有 op_* 工具，直调 fail-closed', async () => {
    const withExecutor = await makeFixture();
    try {
      const source = putActiveSource(withExecutor, 'g.csv', Buffer.from('g'));
      withExecutor.workerPush({ execCalls: [], text: 'noop' });
      withExecutor.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '触发委派', inputFiles: [source.fileId] } }], text: '完成。' });
      await withExecutor.session.send('触发');
      expect(withExecutor.worker.toolNames[0]).toEqual(['op_dummy_query', 'run_js']);
    } finally {
      withExecutor.ro.close();
      withExecutor.close();
    }

    const withoutExecutor = await makeFixture({ withRunJsExecutor: false });
    try {
      withoutExecutor.workerPush({ execCalls: [], text: 'noop' });
      withoutExecutor.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '触发委派' } }], text: '完成。' });
      await withoutExecutor.session.send('触发');
      expect(withoutExecutor.worker.toolNames[0]).toEqual(['op_dummy_query']);
    } finally {
      withoutExecutor.ro.close();
      withoutExecutor.close();
    }

    // 工具面之外的直调 fail-closed（即使模型/驱动绕过工具面）。
    const probed = await makeFixture({ withRunJsExecutor: false });
    try {
      probed.workerPush({ execCalls: [{ tool: 'run_js', args: { code: 'console.log(1)' } }], text: 'noop' });
      probed.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '触发委派' } }], text: '完成。' });
      await probed.session.send('触发');
      expect(probed.worker.toolErrors[0]).toBe('Worker 工具面之外的调用：run_js');
      expect(executionsOf(probed.session.tasks()[0]!)).toEqual([]);
    } finally {
      probed.ro.close();
      probed.close();
    }
  });

  it('任务文件清单进 Worker 转录：副本 fileId/name/bytes 可见；Main 源 fileId 不可见', async () => {
    const fx = await makeFixture();
    try {
      const source = putActiveSource(fx, '清单.csv', Buffer.from('清单内容'));
      fx.workerPush({ execCalls: [], text: 'noop' });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '带文件委派', inputFiles: [source.fileId] } }], text: '完成。' });
      await fx.session.send('交办');

      const delegation = fx.worker.delegationTexts[0]!;
      expect(delegation).toContain('[本任务文件清单]');
      expect(delegation).toContain('清单.csv');
      // 副本 fileId 进了委派（Worker 只解析当前任务的副本）；Main 源 fileId 不进 Worker 转录。
      const referenced = fileIdsInDelegation(delegation);
      expect(referenced).toHaveLength(1);
      expect(referenced[0]).not.toBe(source.fileId);
      expect(delegation).not.toContain(source.fileId);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('不交办文件时委派不带任务文件清单（与改造前逐字节语义一致）', async () => {
    const fx = await makeFixture();
    try {
      fx.workerPush({ execCalls: [{ tool: 'execute_operation', args: { operation: 'dummy.query', args: {} } }], text: '已查询。' });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '纯查询' } }], text: '完成。' });
      await fx.session.send('交办查询');
      expect(fx.worker.delegationTexts[0]).not.toContain('[本任务文件清单]');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('布局不安全（Worker）：执行器拒跑 → ToolUserError 用户话术 + 事件 side=worker/taskId；零产物', async () => {
    const events: RunJsLayoutUnsafeReport[] = [];
    const failingExecutor: RunJsExecutor = {
      async runJs() {
        throw new RunJsLayoutUnsafeError({ runId: 'run_fedcba9876543210fedcba9876543210', item: 'scratch', kind: 'symlink' });
      },
    };
    const fx = await makeFixture({
      executor: failingExecutor,
      onRunJsLayoutUnsafe: (event) => events.push(event),
    });
    try {
      fx.workerPush({ execCalls: [{ tool: 'run_js', args: { code: 'console.log(1)' } }], text: '未能执行。' });
      fx.mainPush({ execCalls: [{ tool: 'task_run', args: { task: '跑一次代码' } }], text: '任务未执行。' });
      const turn = await fx.session.send('交办');

      const taskId = turn.taskIds[0]!;
      expect(fx.worker.toolErrorObjects.at(-1)).toBeInstanceOf(ToolUserError);
      expect(fx.worker.toolErrors.at(-1)).toBe(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
      expect(events).toEqual([
        { runId: 'run_fedcba9876543210fedcba9876543210', item: 'scratch', kind: 'symlink', side: 'worker', taskId },
      ]);
      // 零产物：本任务没有任何 file_refs 行。
      expect(fx.ro.listFileRefs(SCOPE).filter((row) => row.taskId === taskId)).toEqual([]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
