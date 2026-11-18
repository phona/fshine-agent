/**
 * CAP-01 S1 runtime 接线（run_js 工具 + 出口清理 + 清单注入）· 确定性验证。
 *
 * 零网络：假客户端 + 脚本化主驱动（按步骤调 exec 的假 TurnDriver）；run_js 用真实受限
 * 执行器（Node 权限模型子进程，与 run-js-executor.test.ts 同款手法，只写 out/）。
 *
 * 覆盖（对应 ask ⑥ 的 runtime 侧断言）：
 *   ⑤ run_js 在未注入 runJsExecutor 时不注册（工具面没有它，exec 也 fail-closed 拒绝）；
 *   · 片 2（owner 裁定）：Main 的 run_js 能执行、能读 in/、能写 scratch/，但写 out/ **不登记
 *     file_refs 行、不进 TurnResult.files**（结构性禁止 Main 产交付物）；脚本仍真跑，工具
 *     结果不带 audit/runDir（机械路径不进转录）；
 *   · resolveFileRef 同码（照 resolveTaskId 写法）：不存在/pending/过期/越权 → 同一句
 *     话术（防存在性 oracle），机械 reason 只进 onFileRefUnavailable（不进错误消息）；
 *   · 幂等（v8 §5）：同回合同 code+inputs 重试命中，执行器只跑一次；
 *   ② 出口清理：stripServerPaths 在返回前调用一次；剥完为空且有文件 → 宿主话术
 *     「文件已生成（见附件）」（只有文件、正文为空不判失败）；
 *   ⑥ 清单注入：机械事实只有 fileId/name/bytes（没有行数据/路径/sha256），
 *     字节数作为观察项随 TurnResult.fileManifestBytes 带出。
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
import { createFileStore, FILE_REF_TTL_MS, type FileStore } from './src/file-store';
import {
  createRunJsExecutor,
  RUN_JS_LAYOUT_UNSAFE_MESSAGE,
  RunJsLayoutUnsafeError,
  type RunJsExecutor,
} from './src/run-js-executor';
import {
  createSession,
  type Session,
  type TurnFileRef,
  type RunJsLayoutUnsafeReport,
} from './src/execution-runtime';
import { createSqliteTaskRegistry } from './src/task-registry-sqlite';
import { ToolUserError, type DriverMessage, type TurnDriver } from './src/driver-contract';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
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

interface DriverStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  /** 本步执行工具时传给 exec 的取消信号（真实驱动由 Pi 回合持有；这里用于验证贯穿）。 */
  signal?: AbortSignal;
  text: string;
}

interface DriverCapture {
  toolNames: string[][];
  /** 每回合模型收到的工具描述（Main 面事实：scratch/ 是工作区、交付走 task_run）。 */
  toolDescriptions: string[][];
  injections: string[][];
  results: unknown[];
  toolErrors: string[];
  /** 原始异常对象（判 ToolUserError 等类型的确定性面）。 */
  toolErrorObjects: unknown[];
}

/** 按外部步骤队列驱动的假主驱动：exec 错误按真实驱动的语义记为工具结果消息（回合继续）。 */
function queueDriver(capture: DriverCapture): { driver: TurnDriver; push(step: DriverStep): void } {
  const pending: DriverStep[] = [];
  const driver: TurnDriver = {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      capture.toolDescriptions.push(input.tools.map((tool) => tool.description));
      capture.injections.push([...(input.injections ?? [])]);
      const step = pending.shift();
      if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
      for (const call of step.execCalls ?? []) {
        try {
          capture.results.push(await input.exec(call.tool, call.args, step.signal));
        } catch (error) {
          capture.toolErrors.push(error instanceof Error ? error.message : String(error));
          capture.toolErrorObjects.push(error);
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
  ro: ReturnType<typeof openTaskStore>;
  reasons: string[];
  executorCalls(): number;
  lastRunJsSignal(): AbortSignal | undefined;
  close(): void;
}

async function makeFixture(input: {
  withExecutor?: boolean;
  /** 测试替身执行器（布局不安全用例；缺省 = 真实受限执行器）。 */
  executor?: RunJsExecutor;
  onRunJsLayoutUnsafe?: (event: RunJsLayoutUnsafeReport) => void;
  fileManifestProvider?: (principalId: string, sessionId: string) => readonly TurnFileRef[];
} = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-run-js-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'state.db');
  const registry = createSqliteTaskRegistry(dbPath);
  const fileStore = createFileStore({ store: registry.store, workspaceRoot: path.join(dir, 'workspace') });
  const realExecutor = createRunJsExecutor({ fileStore, nodeModulesDir: NODE_MODULES });
  let executorCalls = 0;
  let lastRunJsSignal: AbortSignal | undefined;
  const countingExecutor: RunJsExecutor = {
    async runJs(runInput) {
      executorCalls += 1;
      lastRunJsSignal = runInput.signal;
      return realExecutor.runJs(runInput);
    },
  };
  const runJsExecutor = input.executor ?? countingExecutor;
  const capture: DriverCapture = { toolNames: [], toolDescriptions: [], injections: [], results: [], toolErrors: [], toolErrorObjects: [] };
  const { driver, push } = queueDriver(capture);
  const reasons: string[] = [];
  const session = await createSession({
    principalId: SCOPE.principalId,
    sessionId: SCOPE.sessionId,
    client: new FaceClient(),
    allowedOperations: ['dummy.query'],
    mainDriver: driver,
    workerDriver: workerNeverCalled,
    mainSystemPrompt: '你是测试主 Agent。',
    taskRegistry: registry,
    ...(input.withExecutor === false ? {} : { runJsExecutor }),
    ...(input.onRunJsLayoutUnsafe === undefined ? {} : { onRunJsLayoutUnsafe: input.onRunJsLayoutUnsafe }),
    ...(input.fileManifestProvider === undefined ? {} : { fileManifestProvider: input.fileManifestProvider }),
    onFileRefUnavailable: (reason) => reasons.push(reason),
  });
  return {
    dir,
    session,
    capture,
    push,
    fileStore,
    ro: openTaskStore(dbPath, { readOnly: true }),
    reasons,
    executorCalls: () => executorCalls,
    lastRunJsSignal: () => lastRunJsSignal,
    close: () => {
      registry.close();
    },
  };
}

/** 产物写入脚本：写 out/汇总.txt（cwd = runDir；out/ 由执行器预建）。 */
const WRITE_ONE_OUTPUT = "require('node:fs').writeFileSync('out/汇总.txt', 'summary-bytes');";

describe('CAP-01 S1 runtime 接线（run_js / 出口清理 / 清单注入）', () => {
  it('回合取消信号贯穿到执行器：run_js 收到调用方传下来的 AbortSignal', async () => {
    const f = await makeFixture();
    const controller = new AbortController();
    f.push({
      execCalls: [{ tool: 'run_js', args: { code: "console.log('x');" } }],
      signal: controller.signal,
      text: '完成',
    });
    await f.session.send('跑个脚本');

    // 执行器必须拿到**同一个** signal 对象——否则任务取消/宿主中止后脚本会跑到自然结束或超时。
    expect(f.lastRunJsSignal()).toBe(controller.signal);
    // 取消后该 signal 处于 aborted，执行器的 abort 监听会据此杀进程组。
    controller.abort();
    expect(f.lastRunJsSignal()?.aborted).toBe(true);
    f.close();
  });

  it('⑤ 未注入 runJsExecutor：run_js 不注册，exec 调用 fail-closed 拒绝', async () => {
    const fx = await makeFixture({ withExecutor: false });
    try {
      fx.push({ text: '本轮没有代码执行面。' });
      const turn = await fx.session.send('随便聊聊');
      expect(turn.files).toBeUndefined();
      expect(fx.capture.toolNames[0]).not.toContain('run_js');

      // 工具面外调用：fail-closed（与 task/read_skill 工具同一门控形状）；
      // 假驱动按真实驱动的语义把 exec 错误记为工具结果消息（回合继续，模型看到拒收话术）。
      fx.push({ execCalls: [{ tool: 'run_js', args: { code: WRITE_ONE_OUTPUT } }], text: '本轮没有代码执行面。' });
      await fx.session.send('试试 run_js');
      expect(fx.capture.toolErrors.at(-1)).toBe('Main 工具面之外的调用：run_js');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('片 2：Main 写 out/ 不登记、不产交付物；脚本仍真跑，工具结果不带 audit/runDir', async () => {
    const fx = await makeFixture();
    try {
      fx.push({ execCalls: [{ tool: 'run_js', args: { code: WRITE_ONE_OUTPUT } }], text: '汇总完成。' });
      const turn = await fx.session.send('帮我汇总');

      expect(fx.capture.toolNames[0]).toContain('run_js');
      // 结构性禁止：out/ 不登记（零 file_refs 行）、不进交付面。
      expect(fx.ro.listFileRefs(SCOPE)).toEqual([]);
      expect(turn.files).toBeUndefined();
      expect(turn.reply).toBe('汇总完成。');

      // 脚本仍然真跑（exit 0），只是产物不登记：outputs 为空数组（不是隐藏的真 fileId）。
      const result = fx.capture.results[0] as Record<string, unknown>;
      expect(result).not.toHaveProperty('audit');
      expect(result).not.toHaveProperty('runDir');
      expect(result['exitCode']).toBe(0);
      expect(result['outputs']).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('runs/');
      // 工具描述给了替代路径：scratch/ 是工作区，交付文件走 task_run。
      const runJsIndex = fx.capture.toolNames[0]!.indexOf('run_js');
      expect(fx.capture.toolDescriptions[0]![runJsIndex]).toContain('scratch/ 是工作区');
      expect(fx.capture.toolDescriptions[0]![runJsIndex]).toContain('task_run 交办');
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('resolveFileRef 同码：不存在/pending/过期/越权 → 同一句话术；机械 reason 只进回调', async () => {
    const fx = await makeFixture();
    try {
      const pending = fx.fileStore.putFile({ scope: SCOPE, name: '待激活.xlsx', bytes: Buffer.from('pending') });
      const expired = fx.fileStore.putFile({
        scope: SCOPE,
        name: '过期.xlsx',
        bytes: Buffer.from('expired'),
        activatedAt: Date.now() - FILE_REF_TTL_MS - 60_000,
      });
      const foreign = fx.fileStore.putFile({
        scope: { principalId: 'wecom:other', sessionId: 'sess_9' },
        name: '别人.xlsx',
        bytes: Buffer.from('foreign'),
      });

      const cases: ReadonlyArray<{ label: string; fileId: string; reason: string }> = [
        { label: '不存在', fileId: 'file_missing', reason: 'missing_or_foreign' },
        { label: 'pending', fileId: pending.fileId, reason: `pending:${pending.fileId}` },
        { label: '过期', fileId: expired.fileId, reason: `expired:${expired.fileId}` },
        { label: '越权', fileId: foreign.fileId, reason: 'missing_or_foreign' },
      ];
      const messages: string[] = [];
      for (const testCase of cases) {
        fx.push({ execCalls: [{ tool: 'run_js', args: { code: WRITE_ONE_OUTPUT, inputs: [testCase.fileId] } }], text: '收到' });
        await fx.session.send(`用 ${testCase.label} 的文件`);
        expect(fx.capture.toolErrors).toHaveLength(messages.length + 1);
        messages.push(fx.capture.toolErrors[messages.length]!);
      }
      // 同码：四种拒绝表面上是同一句话（不泄露存在性/状态差异）。
      expect(new Set(messages).size).toBe(1);
      const uniform = messages[0]!;
      expect(uniform).toContain('不存在、未激活或已过期');
      for (const testCase of cases) {
        expect(uniform).not.toContain(testCase.fileId);
        expect(uniform).not.toContain('missing_or_foreign');
        expect(uniform).not.toContain('pending:');
        expect(uniform).not.toContain('expired:');
      }
      // 机械 reason 只进回调（日志面），与请求面一一对应。
      expect(fx.reasons).toHaveLength(cases.length);
      expect(fx.reasons[0]!.startsWith('missing_or_foreign:file_missing')).toBe(true);
      expect(fx.reasons[1]).toBe(`pending:${pending.fileId}`);
      expect(fx.reasons[2]).toBe(`expired:${expired.fileId}`);
      expect(fx.reasons[3]!.startsWith(`missing_or_foreign:${foreign.fileId}`)).toBe(true);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('布局不安全（Main）：执行器拒跑 → ToolUserError 用户话术 + 结构化事件（side=main）；零产物', async () => {
    const events: RunJsLayoutUnsafeReport[] = [];
    const failingExecutor: RunJsExecutor = {
      async runJs() {
        throw new RunJsLayoutUnsafeError({ runId: 'run_0123456789abcdef0123456789abcdef', item: 'home', kind: 'file' });
      },
    };
    const fx = await makeFixture({
      executor: failingExecutor,
      onRunJsLayoutUnsafe: (event) => events.push(event),
    });
    try {
      fx.push({ execCalls: [{ tool: 'run_js', args: { code: WRITE_ONE_OUTPUT } }], text: '模型自由文本。' });
      const turn = await fx.session.send('生成一份文件');

      // 工具层确定性失败话术（ToolUserError 由 driver 直接作为最终回复，不经模型改写）。
      expect(fx.capture.toolErrorObjects.at(-1)).toBeInstanceOf(ToolUserError);
      expect(fx.capture.toolErrors.at(-1)).toBe(RUN_JS_LAYOUT_UNSAFE_MESSAGE);
      // 结构化事件：定位 + 机械形状 + 作用面；只进日志回调，不进用户话术。
      expect(events).toEqual([
        { runId: 'run_0123456789abcdef0123456789abcdef', item: 'home', kind: 'file', side: 'main' },
      ]);
      // 零产物：不交付、不登记。
      expect(turn.files).toBeUndefined();
      expect(fx.ro.listFileRefs(SCOPE)).toEqual([]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('幂等（v8 §5）：同回合同 code+inputs 的重试命中，执行器只跑一次', async () => {
    const fx = await makeFixture();
    try {
      const call = { tool: 'run_js' as const, args: { code: WRITE_ONE_OUTPUT } };
      fx.push({ execCalls: [call, { ...call, args: { code: WRITE_ONE_OUTPUT } }], text: '完成' });
      const turn = await fx.session.send('汇总（会重试一次）');
      expect(fx.executorCalls()).toBe(1);
      // Main 面：无交付物（memo 命中回放的不是登记事实）。
      expect(turn.files).toBeUndefined();
      expect(fx.ro.listFileRefs(SCOPE)).toEqual([]);
      // 两次工具调用拿到同一结果（命中回放）。
      expect(fx.capture.results[0]).toEqual(fx.capture.results[1]);
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('② 出口清理：返回前剥服务器路径（Main 面不再有「只有文件、正文为空」兜底）', async () => {
    const fx = await makeFixture();
    try {
      // 正文里混入服务器路径 → 出口被剥（模型转录里原样，用户面干净）。
      fx.push({ execCalls: [{ tool: 'run_js', args: { code: WRITE_ONE_OUTPUT } }], text: '文件在 /home/fictional-user/fictional-projects/secret-drafts/汇总.xlsx 已经生成。' });
      const withText = await fx.session.send('汇总并告诉我位置');
      expect(withText.reply).not.toContain('/home');
      expect(withText.reply).not.toContain('fictional-user');
      expect(withText.reply).not.toContain('secret-drafts');
      expect(withText.reply).toContain('已经生成');
      // 片 2：Main 没有交付物，TurnResult.files 缺省（「文件已生成（见附件）」兜底属 Worker 面）。
      expect(withText.files).toBeUndefined();
    } finally {
      fx.ro.close();
      fx.close();
    }
  });

  it('⑥ 清单注入：每行 name/fileId/bytes + 脚本内路径（没有行数据/宿主路径/sha256）；字节数随 TurnResult 带出', async () => {
    const providerCalls: Array<[string, string]> = [];
    const fx = await makeFixture({
      fileManifestProvider: (principalId, sessionId) => {
        providerCalls.push([principalId, sessionId]);
        return providerCalls.length === 1
          ? [{ fileId: 'file_abc123def456', name: '明细.xlsx', bytes: 20480 }]
          : [];
      },
    });
    try {
      fx.push({ text: '已看到清单。' });
      const first = await fx.session.send('处理这份明细');
      expect(providerCalls[0]).toEqual([SCOPE.principalId, SCOPE.sessionId]);

      // 注入面：清单每行 name/fileId/bytes + 脚本内路径（in/<fileId><安全扩展名>，修复轮 ⑤）；
      // 不含 sha256 / 宿主路径（斜杠只允许出现在机械派生的 in/ 前缀里）。
      expect(fx.capture.injections[0]).toHaveLength(1);
      const manifest = fx.capture.injections[0]![0]!;
      expect(manifest).toContain('file_abc123def456');
      expect(manifest).toContain('明细.xlsx');
      expect(manifest).toContain('20480');
      const lines = manifest.split('\n');
      expect(lines[0]).toContain('[本会话文件清单]');
      expect(lines[1]).toMatch(/^- 明细\.xlsx（fileId: file_abc123def456，20480 字节；脚本内路径：in\/file_abc123def456\.xlsx）$/);
      expect(manifest).not.toContain('sha256');
      // 宿主路径边界：清单里唯一的斜杠是脚本内路径的 in/ 前缀，无任何宿主绝对/相对路径。
      expect(manifest.replaceAll('脚本内路径：in/', '')).not.toContain('/');
      // 观察项：清单字节数随 TurnResult 带出（= 注入文本的 UTF-8 字节数）。
      expect(first.fileManifestBytes).toBe(Buffer.byteLength(manifest, 'utf8'));

      // 空清单：不注入（回合输入零新增），观察项缺省。
      fx.push({ text: '本轮没有文件。' });
      const second = await fx.session.send('随便聊聊');
      expect(fx.capture.injections[1]).toEqual([]);
      expect(second.fileManifestBytes).toBeUndefined();
    } finally {
      fx.ro.close();
      fx.close();
    }
  });
});
