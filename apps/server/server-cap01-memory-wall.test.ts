/**
 * CAP-01 内存墙（run_js 子进程因内存退出）· server 生产装配级确定性验证（假驱动 + 假执行器；零网络）：
 *   ① 工具结果与用户可见话术用同一句「文件太大，处理时内存不足，请拆分或压缩后重试」
 *      （模型写「处理完成」也不得盖住内存墙事实）；
 *   ② 结构化事件 run_js_memory_exit 含 bytes（输入总字节）与退出形状（exitCode/exitSignal/
 *      stderr 尾窗）——日志能查到是哪次、多大、怎么死的；
 *   ③ 判据是 `exitSignal` 非空 **或** stderr 含 heap out of memory / Allocation failed（两分支各一例）；
 *   ④ 宿主主动杀（killReason=timeout/abort）不算内存墙——话术不得误报「内存不足」。
 *
 * 内存退出用假执行器返回与真实 OOM 同形的输出（owner 裁决允许 mock 子进程 exitSignal），
 * 避免测试进程真分配 1GB。真实堆上限（1024MB 写进 spawn argv）由 run-js-executor.test.ts
 * 的 spawn argv 断言钉住。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import { RUN_JS_MEMORY_EXIT_MESSAGE } from '../../packages/agent/src/execution-runtime';
import type { RunJsOutput } from '../../packages/agent/src/run-js-executor';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const MB = 1024 * 1024;
const SCOPE = { principalId: 'wecom:user-a', sessionId: 'wecom:conv-oom' };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-cap01-memory-wall-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(): AppConfig {
  return {
    principals: {
      'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] },
    },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
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
};

/** 与真实内存退出同形的执行器输出（脚本/输入字节数照实给 21MB）。 */
function memoryExitOutput(shape: {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderr: string;
  killReason?: 'timeout' | 'abort';
}): RunJsOutput {
  const inputBytes = 21 * MB;
  return {
    exitCode: shape.exitCode,
    exitSignal: shape.exitSignal,
    stdout: '',
    stderr: shape.stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputs: [],
    audit: {
      runId: 'run_0123456789abcdef0123456789abcdef',
      runDir: '/tmp/not-used-by-fake-executor',
      scriptSha256: '0'.repeat(64),
      inputFileIds: ['file_big'],
      materializedInputs: [{ fileId: 'file_big', name: '大表.xlsx', materializedName: 'file_big.xlsx' }],
      inputBytes,
      outputs: [],
      skippedOutputs: [],
      exitCode: shape.exitCode,
      exitSignal: shape.exitSignal,
      ...(shape.killReason === undefined ? {} : { killReason: shape.killReason }),
      durationMs: 7,
    },
  };
}

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  toolResults: unknown[];
  logs: Array<Record<string, unknown>>;
}

async function makeFixture(output: RunJsOutput): Promise<Fixture> {
  const dir = tempDir();
  const toolResults: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  // 假主驱动：像真实模型一样调一次 run_js，然后给出与内存墙事实矛盾的「处理完成」文本
  // （用户可见话术必须被宿主出口覆盖，不得采信模型自述）。
  const mainDriver: TurnDriver = {
    async run(input) {
      toolResults.push(await input.exec('run_js', { code: 'console.log("boom")' }));
      const reply = '处理完成，文件已生成。';
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({ mainDriver, workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    createRunJsExecutor: () => ({
      async runJs() {
        return output;
      },
    }),
    logger: (line) => logs.push(line),
  });
  return { server, toolResults, logs };
}

function incoming(messageId: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-oom',
    messageId,
    chatType: 'single',
    text: '汇总这份大表',
    receivedAt: new Date().toISOString(),
  };
}

function memoryLogs(logs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return logs.filter((line) => line['event'] === 'run_js_memory_exit');
}

describe('CAP-01 内存墙（run_js 子进程因内存退出）', () => {
  it('① signal 分支：工具结果与用户话术同一句；事件含 bytes 与退出形状（哪次/多大/怎么死）', async () => {
    const fx = await makeFixture(
      memoryExitOutput({
        exitCode: null,
        exitSignal: 'SIGABRT',
        stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
      }),
    );
    try {
      const reply = await fx.server.handler(incoming('m-oom-signal'));

      // 工具结果：模型看到的是可执行话术（不是 exit 134 黑箱），机械输出仍照实带回。
      const result = fx.toolResults[0] as Record<string, unknown>;
      expect(result['error']).toBe(RUN_JS_MEMORY_EXIT_MESSAGE);
      expect(result['exitSignal']).toBe('SIGABRT');
      expect(String(result['stderr'])).toContain('heap out of memory');
      // 用户可见话术：与工具结果同一句（覆盖模型「处理完成」的自述）。
      expect(reply).toBe(RUN_JS_MEMORY_EXIT_MESSAGE);
      expect(reply).toBe('文件太大，处理时内存不足，请拆分或压缩后重试');

      // 结构化事件：哪次（runId/side）、多大（bytes）、怎么死（exitCode/exitSignal/stderrTail）。
      const events = memoryLogs(fx.logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        principalId: SCOPE.principalId,
        sessionId: SCOPE.sessionId,
        runId: 'run_0123456789abcdef0123456789abcdef',
        side: 'main',
        bytes: 21 * MB,
        exitCode: null,
        exitSignal: 'SIGABRT',
      });
      expect(String(events[0]!['stderrTail'])).toContain('heap out of memory');
    } finally {
      await fx.server.close();
    }
  });

  it('② stderr 分支（exitSignal 为 null）：Allocation failed 仍判内存墙，话术/事件同一路径', async () => {
    const fx = await makeFixture(
      memoryExitOutput({
        exitCode: 134,
        exitSignal: null,
        stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      }),
    );
    try {
      const reply = await fx.server.handler(incoming('m-oom-stderr'));

      expect(reply).toBe(RUN_JS_MEMORY_EXIT_MESSAGE);
      const result = fx.toolResults[0] as Record<string, unknown>;
      expect(result['error']).toBe(RUN_JS_MEMORY_EXIT_MESSAGE);
      const events = memoryLogs(fx.logs);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ bytes: 21 * MB, exitCode: 134, exitSignal: null });
      expect(String(events[0]!['stderrTail'])).toContain('Allocation failed');
    } finally {
      await fx.server.close();
    }
  });

  it('③ 宿主主动杀（killReason=timeout）不算内存墙：不误报「内存不足」、不发内存墙事件', async () => {
    const fx = await makeFixture(
      memoryExitOutput({
        exitCode: null,
        exitSignal: 'SIGKILL',
        stderr: '',
        killReason: 'timeout',
      }),
    );
    try {
      const reply = await fx.server.handler(incoming('m-killed'));

      expect(reply).not.toBe(RUN_JS_MEMORY_EXIT_MESSAGE);
      const result = fx.toolResults[0] as Record<string, unknown>;
      expect(result['error']).toBeUndefined();
      expect(memoryLogs(fx.logs)).toEqual([]);
    } finally {
      await fx.server.close();
    }
  });
});
