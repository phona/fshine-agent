/**
 * CAP-01 S1 交付（主动投递 B）· server 级确定性验证（假渠道事实 + 假模型驱动；零网络）。
 *
 * 片 2 起交付物只从 Worker 出：Main 交办（task_run）→ Worker 的 run_js 走真实受限执行器
 * （server 装配缺省构造；Node 权限模型子进程，只写 out/）→ 产物经真实 fileStore 登记成
 * 任务文件 → 汇入回合末 TurnResult.files → handler 经注入端口投递。
 *
 * 覆盖（逐条对应 ask ⑥，四必守见 v8 §7）：
 *   ① 故意让投递失败 → 用户看到「未送达」、事件记 delivery_failed、**不记 sent**；
 *   ② deliveryMode 非 live（silent）→ 记 `suppressed`、不发起投递、**不记 sent**；
 *   ③ 无投递端口 → fail-closed：用户可见「文件未送达（当前渠道不支持文件投递）」
 *      + 事件 delivery_unavailable；
 *   ④ 只有文件、正文为空 → 不判回合失败，投递照常发生（live 成功记 sent、端口收到字节）；
 *      附：正文空且无文件仍按既有「回合失败」处理（分支两侧都钉住）；
 *   ⑥ server 级清单注入：下一回合的机械事实只有 fileId/name/bytes（无文件内容/sha256），
 *      message_done 记 fileManifestBytes 观察项。
 *   ⑤ 同回合重复交付（sha256 + 文件名相同）→ 只投递一份；去重键是 (sha256, 文件名)：
 *      同名不同字节、同字节不同名都照常各投一份（不按名字或字节单维去重）。
 *
 * CAP-01 修复轮（R7-F3）：①b 投递成功后事件写失败 → 结果不得被日志写失败改写——回合
 * 结果仍是 sent、用户话术无「未送达」、不产生「请重试」诱导；失败的写只降级成一条独立
 * 观测事件（不触达用户）。
 *
 * 2026-11-19（投递真相切片）：①c 快活（同回合落定）+ 文件投递失败 → 「未送达」话术必须
 * 单独发；①d 这条话术**本身也投递失败** → 退回既有待注入队列（下次开口由模型补说，不静默
 * 终局）；①e 反向：话术送达成功时不退回（下次开口不重复说同一句）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppConfig,
  ChannelRoute,
  DeliveryReceipt,
  IncomingAttachment,
  IncomingChannelMessage,
  OutgoingFileReply,
} from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { createFileStore, type RegisteredFile } from '../../packages/agent/src/file-store';
import type { TurnFileRef } from '../../packages/agent/src/execution-runtime';
import type { TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { openTaskStore } from '@fshine/core';
import { createServer, deliverTurnFilesCore, turnProducedNothing, type FileDeliveryPort } from './server';
import { echoCompletionWake } from './testing/echo-completion-wake';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-cap01-delivery-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // 有推送面 = 后台派发（async）；0 窗口让受理即返回，完成投递走后台完成回调（确定性）。
    runtime: { taskRunWaitMs: 0 },
  };
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

const workerNeverCalled: TurnDriver = {
  async run() {
    throw new Error('（测试）worker 不应被调用');
  },
}

interface DriverStep {
  execCalls?: ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
  text: string;
}

interface DriverCapture {
  toolNames: string[][];
  injections: string[][];
}

/** 按调用序回放的假主驱动（同一会话跨消息复用同一实例与步骤队列）。 */
function sequencedDriver(steps: readonly DriverStep[], capture: DriverCapture): TurnDriver {
  let index = 0;
  return {
    async run(input) {
      capture.toolNames.push(input.tools.map((tool) => tool.name));
      capture.injections.push([...(input.injections ?? [])]);
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('（测试）没有更多驱动步骤');
      for (const call of step.execCalls ?? []) {
        await input.exec(call.tool, call.args);
      }
      return { text: step.text, messages: [] as unknown as DriverMessage[] };
    },
    // 唤醒回合（完成事实触发）按产品形状脚本化：模型把事实里的结果正文复读给用户。
    async wake(factText) {
      return echoCompletionWake(factText);
    },
  };
}

/** 按调用序回放的假 Worker 驱动（交办的活由它做：每回合按脚本调工具）。 */
function sequencedWorkerDriver(
  steps: readonly DriverStep[],
  record: { toolNames: string[][]; errors: string[] },
): TurnDriver {
  let index = 0;
  return {
    async run(input) {
      record.toolNames.push(input.tools.map((tool) => tool.name));
      const step = steps[index];
      index += 1;
      if (step === undefined) throw new Error('（测试）没有更多 Worker 驱动步骤');
      for (const call of step.execCalls ?? []) {
        try {
          await input.exec(call.tool, call.args);
        } catch (error) {
          record.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { text: step.text, messages: [] as unknown as DriverMessage[] };
    },
  };
}

function incoming(
  messageId: string,
  text: string,
  attachments?: readonly IncomingAttachment[],
): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId,
    chatType: 'single',
    text,
    ...(attachments === undefined ? {} : { attachments }),
    receivedAt: new Date().toISOString(),
  };
}

/** 渠道落盘形状的附件（adapter 的 saveAttachments 义务）：写临时目录并返回契约形状。 */
function stagedAttachment(root: string, filename: string, bytes: Buffer): IncomingAttachment {
  const dir = path.join(root, 'attachments');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return { filename, path: filePath, bytes: bytes.length };
}

/** live 端口：成功回 per-file 回执；fail=true 抛错（带空 receipt，模拟部分 ACK 形状）。
 *  `textFail=true`：文字投递（sendText）同样抛错——「未送达话术本身也送不出去」的故障形状。 */
function livePort(options: { fail?: boolean; textFail?: boolean } = {}): {
  port: FileDeliveryPort;
  calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }>;
  texts: Array<{ route: ChannelRoute; text: string }>;
} {
  const calls: Array<{ route: ChannelRoute; files: readonly OutgoingFileReply[] }> = [];
  const texts: Array<{ route: ChannelRoute; text: string }> = [];
  return {
    calls,
    texts,
    port: {
      deliveryMode: 'live',
      async sendToConversation(route, files): Promise<DeliveryReceipt> {
        calls.push({ route, files });
        if (options.fail === true) {
          const error = new Error('企微主动交付失败（file[0] upload）: 测试注入的投递失败') as Error & { receipt?: DeliveryReceipt };
          error.receipt = { route, parts: [] };
          throw error;
        }
        return { route, parts: files.map((_, index) => ({ kind: 'file' as const, index, status: 'sent' as const })) };
      },
      async sendText(route, text): Promise<DeliveryReceipt> {
        if (options.textFail === true) throw new Error('渠道路由故障：文字投递失败');
        texts.push({ route, text });
        return { route, parts: [{ kind: 'text' as const, index: 0, status: 'sent' as const }] };
      },
    },
  };
}

/** Worker 产物写入脚本：写 out/汇总.txt（cwd = runDir；out/ 由执行器预建）。 */
const RUN_JS_CALL = {
  tool: 'run_js',
  args: { code: "require('node:fs').writeFileSync('out/汇总.txt', 'summary-bytes');" },
};

/** Main 的交办（片 2：交付物只从 Worker 出，Main 不再自己写 out/ 产交付物）。 */
const TASK_RUN_CALL = { tool: 'task_run', args: { task: '帮我把结果汇总成一份文件' } };
const TASK_RUN_STEP: DriverStep = { execCalls: [TASK_RUN_CALL], text: '汇总完成。' };
const WORKER_RUN_JS_STEP: DriverStep = { execCalls: [RUN_JS_CALL], text: '汇总完成。' };

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  dbPath: string;
  logs: Array<Record<string, unknown>>;
  capture: DriverCapture;
  workerRecord: { toolNames: string[][]; errors: string[] };
}

async function makeFixture(input: {
  steps: readonly DriverStep[];
  /** Worker 回合脚本（片 2：交付物由 Worker 产出）。缺省 = worker 不应被调用。 */
  workerSteps?: readonly DriverStep[];
  port?: FileDeliveryPort;
  /** runtime 覆盖（例：短等待窗口 >0 造「快活」同回合落定）。 */
  runtime?: AppConfig['runtime'];
  /**
   * 事件写失败注入（R7-F3）：谓词命中的日志写抛错（模拟事件存储不可写），其余照常记录。
   * 抛错先于记录（存储挂了就什么都不落），未命中行进 logs 供断言。
   */
  throwsOnLog?: (line: Record<string, unknown>) => boolean;
}): Promise<Fixture> {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.db');
  const logs: Array<Record<string, unknown>> = [];
  const capture: DriverCapture = { toolNames: [], injections: [] };
  const workerRecord = { toolNames: [] as string[][], errors: [] as string[] };
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: input.runtime === undefined ? testConfig() : { ...testConfig(), runtime: input.runtime },
    dbPath,
    createDrivers: () => ({
      mainDriver: sequencedDriver(input.steps, capture),
      workerDriver: input.workerSteps === undefined
        ? workerNeverCalled
        : sequencedWorkerDriver(input.workerSteps, workerRecord),
    }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    ...(input.port === undefined ? {} : { fileDelivery: input.port }),
    logger: (line) => {
      if (input.throwsOnLog?.(line) === true) throw new Error('（测试注入）事件写失败：存储不可写');
      logs.push(line);
    },
  });
  return { server, dbPath, logs, capture, workerRecord };
}

describe('CAP-01 S1 交付（主动投递 B，server 级）', () => {
  it('① 后台完成投递失败 → 用户看到「未送达」、事件记 delivery_failed、不记 sent', async () => {
    const { port, calls, texts } = livePort({ fail: true });
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
    });
    try {
      await server.handler(incoming('m-fail', '帮我汇总'));
      // 后台完成 → 文件投递失败：结构化事实记 delivery_failed，绝不记 sent。
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]!['status']).toBe('delivery_failed');
      expect(deliveryLogs[0]!['files']).toBe(1);
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
      // 用户话术：结果文本 + 如实的未送达话术经文本投递面发出（失败不吞）。
      await vi.waitFor(() => {
        expect(texts).toHaveLength(1);
      });
      expect(texts[0]!.text).toContain('汇总完成。');
      expect(texts[0]!.text).toContain('未送达');
      expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
      expect(calls).toHaveLength(1); // live 确实发起了投递
    } finally {
      await server.close();
    }
  });

  it('①c 快活（同回合落定）但文件投递失败 → 仍单独发「未送达」；只抑制重复的「办完了」', async () => {
    // 2026-11-19 真缺陷：同回合模型已经说过「见附件」，文件却没送达，而快活抑制把
    // 未送达话术一起吞了 → 用户被虚假交付。修法：抑制只免重复播报，fileNote 必须单独发。
    const { port, texts } = livePort({ fail: true });
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
      // 短等待窗口 >0：任务在窗口内落定 = 快活（结果同回合交给模型转述）。
      runtime: { taskRunWaitMs: 1_500 },
    });
    try {
      await server.handler(incoming('m-relay-fail', '帮我汇总'));
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      expect(logs.find((line) => line['event'] === 'file_delivery')!['status']).toBe('delivery_failed');
      // 快活抑制照旧（不重复播报「办完了」）……
      expect(logs.some((line) => line['event'] === 'task_result_delivery_suppressed'
        && line['reason'] === 'relayed_in_turn')).toBe(true);
      // ……但文件未送达必须让用户知道（这是「如实交付」而不是重复播报）。
      await vi.waitFor(() => {
        expect(texts.some((entry) => entry.text.includes('未送达'))).toBe(true);
      });
      expect(texts).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('①d 未送达话术本身也投递失败 → 退回待注入（下次开口由模型补说），不静默终局', async () => {
    // 2026-11-19（同形缺口，与唤醒投递失败同一手法）：模型已经说过「见附件」、文件投递失败、
    // 而「文件未送达」这条宿主话术**再失败**时，用户会一直以为附件到了。后路 = 话术退进既有
    // 待注入队列，下一次用户开口由模型补说；不新建重试、不重投同一句话。
    const { port, texts } = livePort({ fail: true, textFail: true });
    const { server, logs, capture } = await makeFixture({
      steps: [TASK_RUN_STEP, { text: '收到。' }],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
      // 短等待窗口 >0：任务在窗口内落定 = 快活（结果同回合交给模型转述）。
      runtime: { taskRunWaitMs: 1_500 },
    });
    try {
      await server.handler(incoming('m-note-fail', '帮我汇总'));
      await vi.waitFor(() => {
        expect(logs.some((line) => line['event'] === 'task_result_delivery_requeued' && line['source'] === 'file_note')).toBe(true);
      });
      // 投递全失败：零用户可见文本、绝不记 sent；失败与退回各留痕。
      expect(texts).toEqual([]);
      expect(logs.some((line) => line['event'] === 'task_result_delivery_failed')).toBe(true);
      expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(false);

      // 后路真的生效：下一次用户开口，未送达话术随 injections 进模型上下文（既有机制补说）。
      await server.handler(incoming('m-note-fail-2', '到了吗'));
      const second = capture.injections[1] ?? [];
      expect(second.some((text) => text.includes('未送达'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('①e 不许修过头：未送达话术送达成功时不退回（下次开口不重复说同一句）', async () => {
    const { port, texts } = livePort({ fail: true });
    const { server, logs, capture } = await makeFixture({
      steps: [TASK_RUN_STEP, { text: '收到。' }],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
      runtime: { taskRunWaitMs: 1_500 },
    });
    try {
      await server.handler(incoming('m-note-ok', '帮我汇总'));
      await vi.waitFor(() => {
        expect(texts.some((entry) => entry.text.includes('未送达'))).toBe(true);
      });
      expect(logs.some((line) => line['event'] === 'task_result_delivery_requeued')).toBe(false);

      await server.handler(incoming('m-note-ok-2', '到了吗'));
      const second = capture.injections[1] ?? [];
      expect(second.some((text) => text.includes('未送达'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('①b 投递成功后事件写失败（R7-F3）→ 结果仍是 sent、话术无「未送达」、不诱导重试', async () => {
    const { port, calls, texts } = livePort();
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
      // R7-F3 故障注入：file_delivery 的 sent 事件写抛错（事件存储不可写），其余事件照常记录。
      throwsOnLog: (line) => line['event'] === 'file_delivery' && line['status'] === 'sent',
    });
    try {
      await server.handler(incoming('m-logfail', '帮我汇总'));
      // 用户话术：投递已成功，日志写失败不得改写结果——无「未送达」、无「请重试」诱导。
      await vi.waitFor(() => {
        expect(texts).toHaveLength(1);
      });
      expect(texts[0]!.text).toContain('汇总完成。');
      expect(texts[0]!.text).not.toContain('未送达');
      expect(texts[0]!.text).not.toContain('请重试');
      // 端口确实收到字节（只投一次，无重复交付）。
      expect(calls).toHaveLength(1);
      // 失败的写只降级为一条独立观测事件（status 仍 sent），不产生任何 delivery_failed 事实。
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery_log_write_failed')).toHaveLength(1);
      });
      const observed = logs.filter((line) => line['event'] === 'file_delivery_log_write_failed');
      expect(observed[0]!['status']).toBe('sent');
      expect(logs.some((line) => line['status'] === 'delivery_failed')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('② silent → 记 suppressed、不发起投递、不记 sent', async () => {
    let portCalls = 0;
    const port: FileDeliveryPort = {
      deliveryMode: 'silent',
      async sendToConversation() {
        portCalls += 1;
        throw new Error('（测试）silent 部署不应发起投递');
      },
    };
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
    });
    try {
      const reply = await server.handler(incoming('m-silent', '帮我汇总'));
      // owner 2026-11-19：用户看到的话永远是模型说的——交办回合的模型正文原样送达。
      expect(reply).toBe('汇总完成。');
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]!['status']).toBe('suppressed');
      expect(deliveryLogs[0]!['deliveryMode']).toBe('silent');
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
      expect(portCalls).toBe(0); // 非 live 不发起投递
    } finally {
      await server.close();
    }
  });

  it('③ 无投递端口 → fail-closed：用户可见「文件未送达（当前渠道不支持文件投递）」+ delivery_unavailable', async () => {
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
    });
    try {
      const reply = await server.handler(incoming('m-noport', '帮我汇总'));
      expect(reply).toContain('汇总完成。');
      expect(reply).toContain('文件未送达（当前渠道不支持文件投递）');
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]!['status']).toBe('delivery_unavailable');
      expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('④ 交办 + 正文为空 → 不算回合失败：零终帧、任务照常建、完成投递照常到达', async () => {
    const { port, calls, texts } = livePort();
    const { server, logs } = await makeFixture({
      // Main 正文为空：agent.md 要求交办后不复述过程话，模型照做时该回合就是没有正文。
      steps: [{ execCalls: [TASK_RUN_CALL], text: '' }],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
    });
    try {
      // 交办了任务 = 本回合产出了「东西」：空正文不是回合失败；空就是空，不投帧。
      const reply = await server.handler(incoming('m-empty', '发文件'));
      expect(reply).toBe('');
      // 任务照常建（message_done 带 taskIds 机械事实）。
      const done = logs.find((line) => line['event'] === 'message_done') as Record<string, unknown> | undefined;
      expect(done).toBeDefined();
      expect((done!['taskIds'] as unknown[]).length).toBe(1);
      // 投递面仍收到文件字节（后台任务完成回调，与前台同一交付面）。
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      expect(calls[0]!.files).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.txt');
      expect(calls[0]!.files[0]!.data.toString()).toBe('summary-bytes');
      expect(calls[0]!.route).toEqual({ channel: 'wecom', conversationId: 'conv-a' });
      await vi.waitFor(() => {
        expect(logs.some((line) => line['event'] === 'file_delivery' && line['status'] === 'sent')).toBe(true);
      });
      // 结果正文照常送达（文件过滤不影响结果文本）。
      await vi.waitFor(() => {
        expect(texts).toHaveLength(1);
      });
      expect(texts[0]!.text).toContain('汇总完成。');
    } finally {
      await server.close();
    }
  });

  it('④b 一无所有（无正文、无文件、无交办、无执行事实）→ 仍判回合失败（判据不收紧过头）', async () => {
    const { server, logs } = await makeFixture({ steps: [{ text: '' }] });
    try {
      await expect(server.handler(incoming('m-blank', '说点什么'))).rejects.toThrow('本回合未产出可用回复');
      expect(logs.some((line) => line['event'] === 'message_done')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('④c 有执行事实但没交办任务 + 空正文 → 判回合失败（执行事实不豁免，防静默终局）', () => {
    // 内联只读失败 / 内联写确认同族：executions 是内部动作，用户不会自动收到它——
    // 正文为空就是静默终局，必须判失败（owner 2026-11-19 最终形状）。
    expect(turnProducedNothing({
      reply: '',
      fileCount: 0,
      taskIds: [],
      executions: [{ status: 'failed' }],
    })).toBe(true);
    expect(turnProducedNothing({
      reply: '',
      fileCount: 0,
      taskIds: [],
      executions: [{ status: 'needs_confirmation' }],
    })).toBe(true);
    // 交办是唯一豁免：有 taskIds → 不判失败（结果由完成投递/唤醒送达）。
    expect(turnProducedNothing({
      reply: '',
      fileCount: 0,
      taskIds: ['task_x'],
      executions: [],
    })).toBe(false);
    // 一无所有同样判失败（与 ④b 同一判据）；有正文 / 有文件永不判失败。
    expect(turnProducedNothing({ reply: '', fileCount: 0, taskIds: [], executions: [] })).toBe(true);
    expect(turnProducedNothing({ reply: '好', fileCount: 0, taskIds: [], executions: [] })).toBe(false);
    expect(turnProducedNothing({ reply: '', fileCount: 1, taskIds: [], executions: [] })).toBe(false);
  });

  it('⑤ 同回合重复交付（同 sha256 + 同名）→ 只投递一份，去重项不产生额外事件/错误', async () => {
    const { port, calls } = livePort();
    const { server, logs } = await makeFixture({
      // Main 交办一次；Worker 两次 run_js 代码不同（memo 不命中，各自登记新 fileId），
      // 但产出同名同字节 → 交付面按 (sha256, 文件名) 去重。
      steps: [TASK_RUN_STEP],
      workerSteps: [
        {
          execCalls: [
            RUN_JS_CALL,
            {
              tool: 'run_js',
              args: {
                code:
                  "const fs = require('node:fs'); fs.writeFileSync('out/汇总.txt', 'summary-' + 'bytes'); // 同字节同名产物（第二次登记）",
              },
            },
          ],
          text: '汇总完成。',
        },
      ],
      port,
    });
    try {
      await server.handler(incoming('m-dedupe', '帮我汇总两次'));
      // 投递面：一次调用、一份文件（同 sha256 + 同文件名只投第一份）。
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      expect(calls[0]!.files).toHaveLength(1);
      expect(calls[0]!.files[0]!.filename).toBe('汇总.txt');
      expect(calls[0]!.files[0]!.data.toString()).toBe('summary-bytes');
      // 事件面：只有一条 sent 事实、计数按实际投递份数；去重项不产生额外事件或错误日志。
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]!['status']).toBe('sent');
      expect(deliveryLogs[0]!['files']).toBe(1);
      expect(logs.some((line) => line['status'] === 'delivery_failed')).toBe(false);
      expect(logs.some((line) => line['event'] === 'file_delivery_log_write_failed')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('⑤b 去重键是 (sha256, 文件名)：同名不同字节、同字节不同名都各投一份', async () => {
    const { port, calls } = livePort();
    const { server, logs } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [
        {
          execCalls: [
            { tool: 'run_js', args: { code: "require('node:fs').writeFileSync('out/同名.txt', 'A');" } },
            { tool: 'run_js', args: { code: "require('node:fs').writeFileSync('out/同名.txt', 'B');" } },
            { tool: 'run_js', args: { code: "require('node:fs').writeFileSync('out/异名-1.txt', 'C');" } },
            { tool: 'run_js', args: { code: "require('node:fs').writeFileSync('out/异名-2.txt', 'C');" } },
          ],
          text: '产物如下。',
        },
      ],
      port,
    });
    try {
      await server.handler(incoming('m-dedupe-key', '发四份'));
      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      // 四份两两不同（键 = sha256 + 文件名）→ 一份都不吞。
      expect(calls[0]!.files.map((file) => `${file.filename}:${file.data.toString()}`)).toEqual([
        '同名.txt:A',
        '同名.txt:B',
        '异名-1.txt:C',
        '异名-2.txt:C',
      ]);
      await vi.waitFor(() => {
        expect(logs.filter((line) => line['event'] === 'file_delivery')).toHaveLength(1);
      });
      const deliveryLogs = logs.filter((line) => line['event'] === 'file_delivery');
      expect(deliveryLogs[0]!['files']).toBe(4);
    } finally {
      await server.close();
    }
  });

  it('⑥ 片 2：Main 写 out/ 不登记、不投递；清单注入只含真登记的文件（入站附件）', async () => {
    const { port, calls } = livePort();
    const { server, logs, capture, dbPath } = await makeFixture({
      steps: [
        // 第一回合：Main 自己 run_js 写 out/ —— 片 2 起不登记、不投递。
        { execCalls: [RUN_JS_CALL], text: '汇总完成。' },
        // 第二回合：随消息收到一份入站附件（真登记 + 激活）→ 本回合清单注入。
        { text: '已按清单继续处理。' },
      ],
      port,
    });
    try {
      await server.handler(incoming('m-main-out', '帮我汇总'));

      // 用户可见路径变了：Main 写 out/ 既没有交付事件，也没有文件登记行。
      expect(logs.some((line) => line['event'] === 'file_delivery')).toBe(false);
      expect(calls).toHaveLength(0);
      const ro = openTaskStore(dbPath, { readOnly: true });
      try {
        expect(ro.listFileRefs(SCOPE)).toEqual([]); // out/ 不登记（结构性）
      } finally {
        ro.close();
      }
      // 第一回合：回合开始构建清单时没有已激活文件 → 无清单注入；工具面仍含 run_js。
      expect(capture.injections[0]).toEqual([]);
      expect(capture.toolNames[0]).toContain('run_js');

      // 第二回合：文字+附件一条消息 → 附件真登记并激活；清单 = 本会话已激活文件，
      // 每行 name/fileId/bytes + 脚本内路径（修复轮 ⑤）。
      await server.handler(incoming('m-inbound', '继续处理上一步的结果', [
        stagedAttachment(path.dirname(dbPath), '明细.xlsx', Buffer.from('mingxi-bytes')),
      ]));
      expect(capture.injections[1]).toHaveLength(1);
      const manifest = capture.injections[1]![0]!;
      const lines = manifest.split('\n');
      expect(lines[0]).toContain('[本会话文件清单]');
      // 2026-11-18 owner：行尾追加收到时间（YYYY-MM-DD HH:mm），字段顺序与 fileId 形态不变。
      expect(lines[1]).toMatch(
        /^- 明细\.xlsx（fileId: file_[0-9a-f]{32}，12 字节；脚本内路径：in\/file_[0-9a-f]{32}\.xlsx；\d{4}-\d{2}-\d{2} \d{2}:\d{2} 收到）$/,
      );
      expect(manifest).not.toContain('mingxi-bytes'); // 没有文件内容（行数据不进清单）
      expect(manifest).not.toContain('sha256');
      // 宿主路径边界：清单里唯一的斜杠是脚本内路径的 in/ 前缀，无任何宿主绝对/相对路径。
      expect(manifest.replaceAll('脚本内路径：in/', '')).not.toContain('/');
      const done = logs.filter((line) => line['event'] === 'message_done').at(-1);
      expect(done?.['fileManifestBytes']).toBe(Buffer.byteLength(manifest, 'utf8'));
    } finally {
      await server.close();
    }
  });

  it('⑧ 完成投递文本 = 唤醒回合模型那句（宿主不再拼「业务名」办完了：模板）', async () => {
    // 2026-11-19 唤醒切片：完成消息的身份由**模型**在唤醒回合里写（宿主只喂事实）；
    // 宿主身份行模板已删——投递文本必须逐字等于模型产出，不夹带宿主拼接。
    const { port, texts } = livePort();
    const { server } = await makeFixture({
      steps: [TASK_RUN_STEP],
      workerSteps: [WORKER_RUN_JS_STEP],
      port,
    });
    try {
      await server.handler(incoming('m-completion-name', '帮我汇总'));
      await vi.waitFor(() => expect(texts).toHaveLength(1));
      // 脚本模型复读事实里的结果正文（逐字）；没有宿主身份头。
      expect(texts[0]!.text).toBe('汇总完成。');
      expect(texts[0]!.text).not.toMatch(/「[^」]*」办完了：/);
    } finally {
      await server.close();
    }
  });

  it('⑨ 失败投递的用户文本等于话术模板：归类自执行事实的码，不含 Worker 原文/内部词', async () => {
    // 2026-11-19 收口：任务终局 failed 时用户可见文本用 failureMessageFor(kind) 模板
    // （kind 由底账执行事实 error.code 归类；取不到 = executor_failed），**不投 Worker
    // 失败汇报原文**——「COLLECTION_FAULT / gateway crashed」这类内部形态不进用户文本。
    const dir = tempDir();
    const dbPath = path.join(dir, 'state.db');
    const delivery = livePort();
    const { port, texts } = delivery;
    const logs: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: { ...testConfig(), runtime: { taskRunWaitMs: 0 } },
      dbPath,
      createDrivers: () => ({
        mainDriver: sequencedDriver([TASK_RUN_STEP], { toolNames: [], injections: [] }),
        workerDriver: workerNeverCalled,
      }),
      createExecutionFace: async () => ({
        client: new FaceClient(),
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      // 假后台执行器：回合无汇报收尾（S1：执行行就是事实；回合失败事实由 runner 发，
      // 用户文本走既有失败话术，不进 Worker 原文）。
      taskExecutor: {
        async execute(): Promise<TaskExecutionOutcome> {
          return { kind: 'ended' };
        },
      },
      fileDelivery: port,
      logger: (line) => logs.push(line),
    });
    try {
      await server.handler(incoming('m-failure-template', '帮我汇总'));
      // 失败主动投递恰一条：用户文本 = 话术模板（executor_failed），无内部词。
      await vi.waitFor(() => expect(texts).toHaveLength(1));
      expect(texts[0]!.text).toBe('没办成。再试一次，还是先放着？');
      expect(texts[0]!.text).not.toContain('COLLECTION_FAULT');
      expect(texts[0]!.text).not.toContain('gateway');
      expect(texts[0]!.text).not.toContain('执行层');
      expect(texts[0]!.text).not.toContain('dummy.query');
      // 事件面：失败投递记 sent（不是 suppressed）。
      await vi.waitFor(() => {
        expect(logs.some((line) => line['event'] === 'task_result_delivery_sent')).toBe(true);
      });
    } finally {
      await server.close();
    }
  });
});

// ───────────────────────── 交付角色闸（方案 A：只看 deliverable，不看文件名） ─────────────────────────
describe('交付角色闸（方案 A）', () => {
  const scope = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-a' };

  function deliveryHarness(): {
    store: ReturnType<typeof openTaskStore>;
    fileStore: ReturnType<typeof createFileStore>;
    workspaceRoot: string;
    put(name: string, deliverable: boolean): RegisteredFile;
  } {
    const store = openTaskStore(':memory:');
    const workspaceRoot = path.join(tempDir(), 'workspace');
    const fileStore = createFileStore({ store, workspaceRoot });
    return {
      store,
      fileStore,
      workspaceRoot,
      put(name, deliverable) {
        return fileStore.putFile({
          scope,
          name,
          bytes: Buffer.from(`bytes-of-${name}`),
          activatedAt: Date.now(),
          deliverable,
        });
      },
    };
  }

  const refOf = (file: RegisteredFile): TurnFileRef => ({
    fileId: file.fileId,
    name: file.name,
    bytes: file.bytes,
    deliverable: file.deliverable,
  });

  it('② 同回合 汇总.xlsx(可交付) + 明细.values.csv(内部) → 只投 1 份；事件 files=1、skippedInternal=1', async () => {
    const h = deliveryHarness();
    const summary = h.put('汇总.xlsx', true);
    const detail = h.put('明细.values.csv', false);
    const { port, calls } = livePort();
    const logs: Array<Record<string, unknown>> = [];
    try {
      const outcome = await deliverTurnFilesCore(
        {
          files: [refOf(summary), refOf(detail)],
          scope,
          channel: 'wecom',
          conversationId: 'conv-a',
          principalId: scope.principalId,
          sessionId: scope.sessionId,
        },
        { fileDelivery: port, workspaceRoot: h.workspaceRoot, log: (line) => logs.push(line) },
      );
      expect(outcome).toEqual({ status: 'sent', files: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files.map((file) => file.filename)).toEqual(['汇总.xlsx']);
      const sent = logs.find((line) => line['event'] === 'file_delivery' && line['status'] === 'sent');
      expect(sent?.['files']).toBe(1);
      expect(sent?.['skippedInternal']).toBe(1);
    } finally {
      h.store.close();
    }
  });

  it('③ 防退化：闸门只认角色不认名字——内部样式名但 deliverable:true 必投，普通名但 false 不投', async () => {
    const h = deliveryHarness();
    // 名字像内部产物的用户文件：必须投递（文件名不是判据）。
    const disguisedUserFile = h.put('file_deadbeef.values.csv', true);
    // 普通名字的内部诊断产物：必须不投（角色才是判据）。
    const plainNamedInternal = h.put('明细.values.csv', false);
    const { port, calls } = livePort();
    const logs: Array<Record<string, unknown>> = [];
    try {
      const outcome = await deliverTurnFilesCore(
        {
          files: [refOf(disguisedUserFile), refOf(plainNamedInternal)],
          scope,
          channel: 'wecom',
          conversationId: 'conv-a',
          principalId: scope.principalId,
          sessionId: scope.sessionId,
        },
        { fileDelivery: port, workspaceRoot: h.workspaceRoot, log: (line) => logs.push(line) },
      );
      expect(outcome).toEqual({ status: 'sent', files: 1 });
      expect(calls[0]!.files.map((file) => file.filename)).toEqual(['file_deadbeef.values.csv']);
      const sent = logs.find((line) => line['event'] === 'file_delivery' && line['status'] === 'sent');
      expect(sent?.['files']).toBe(1);
      expect(sent?.['skippedInternal']).toBe(1);
    } finally {
      h.store.close();
    }
  });

  it('全部是内部产物 → 不调渠道、记 skipped_internal（不发空批）', async () => {
    const h = deliveryHarness();
    const internal = h.put('明细.values.csv', false);
    const { port, calls } = livePort();
    const logs: Array<Record<string, unknown>> = [];
    try {
      const outcome = await deliverTurnFilesCore(
        {
          files: [refOf(internal)],
          scope,
          channel: 'wecom',
          conversationId: 'conv-a',
          principalId: scope.principalId,
          sessionId: scope.sessionId,
        },
        { fileDelivery: port, workspaceRoot: h.workspaceRoot, log: (line) => logs.push(line) },
      );
      expect(outcome).toEqual({ status: 'skipped_internal', files: 0 });
      expect(calls).toHaveLength(0);
      expect(logs).toContainEqual(
        expect.objectContaining({ event: 'file_delivery', status: 'skipped_internal', files: 0, skippedInternal: 1 }),
      );
    } finally {
      h.store.close();
    }
  });
});
