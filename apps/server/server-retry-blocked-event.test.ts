/**
 * `execution_retry_blocked` 事件（A2b 拦截的运维可见面）· server 级联测。
 *
 * 为什么单独钉一条：拦截事实在 runtime 里只是「不给模型发起」，如果装配层不落事件，
 * 运维看到的就是「模型突然不查了」，无法区分是模型放弃还是宿主拦下——owner 2026-11-18
 * 要求「宁可停下让人介入」，那必须停得可见。
 *
 * 断言：① 同对象第二次尝试被拦 → 一条 execution_retry_blocked（含 operation/object/code
 * 与执行层的 retryable 声明）；② 只拦不发（执行客户端只被调用 1 次）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, IncomingChannelMessage } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { DriverMessage, TurnDriver } from '../../packages/agent/src/driver-contract';
import type { TaskExecutionInput, TaskExecutionOutcome, TaskExecutor } from '../../packages/agent/src/task-runner';
import { createServer } from './server';

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-retry-blocked-'));
  tempDirs.push(dir);
  return dir;
}

function config(): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true, accountSetScope: 'all', capabilities: ['read'] } },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    // inline 派发：委派在同一回合里由 workerDriver 直接执行（background 由注入的
    // taskExecutor 接管，Worker 回合不会走 driver，拦不住这条链路）。
  };
}

function incoming(text: string): IncomingChannelMessage {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom',
    conversationId: 'conv-a',
    messageId: `msg-${text}`,
    chatType: 'single',
    text,
    receivedAt: new Date().toISOString(),
  };
}

const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

/** 第一次确定性拒绝（retryable:false），之后（若不该发生）返回成功。 */
class RejectingClient implements ExecutionClient {
  calls = 0;
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  }
  async execute(): Promise<ExecutionOutcome> {
    this.calls += 1;
    return this.calls === 1
      ? { status: 'failed', error: { code: 'WHERE_INVALID', message: 'collection has no window dimension', retryable: false } }
      : { status: 'completed', data: {} };
  }
}

/** Main 委派一次；Worker 同一回合连试两次同对象（第二次必须被 A2b 拦下）。 */
function retryingWorkerDriver(): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools.find((entry) => entry.name === 'execute_operation') ?? input.tools[0];
      if (tool === undefined) throw new Error('（测试）没有工具面');
      const args = { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': 'W202610' } };
      try {
        await input.exec(tool.name, args);
      } catch {
        // 第一次失败：像真实 Worker 一样继续尝试换写法
      }
      try {
        await input.exec(tool.name, { operation: 'dummy.query', args: { '--collection': 'finance-invoices', '--window': '2026-10' } });
      } catch {
        // 期望这里被 A2b 拦下（不发起执行）
      }
      const messages = [...input.messages, { role: 'assistant', content: '查不到' } as never];
      return { text: '查不到', messages };
    },
  };
}

function mainDriver(): TurnDriver {
  return {
    async run(input) {
      const tool = input.tools[0];
      if (tool === undefined) throw new Error('（测试）Main 无工具面');
      try {
        await input.exec(tool.name, { task: '查 finance-invoices 2026-10' });
      } catch {
        // 后台受理失败不在这里断言
      }
      const messages = [...input.messages, { role: 'assistant', content: '已经接下了' } as never];
      return { text: '已经接下了', messages };
    },
  };
}

class NoopExecutor implements TaskExecutor {
  async execute(_input: TaskExecutionInput): Promise<TaskExecutionOutcome> {
    return { kind: 'completed', resultText: '' };
  }
}

describe('A2b 拦截的运维可见面', () => {
  it('同对象第二次尝试被拦 → 落一条 execution_retry_blocked，且不再发起执行', async () => {
    const dir = tempDir();
    const client = new RejectingClient();
    const events: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: config(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: mainDriver(), workerDriver: retryingWorkerDriver() }),
      createExecutionFace: async () => ({
        client,
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      taskExecutor: new NoopExecutor(),
      logger: (line) => events.push(line as Record<string, unknown>),
    });
    try {
      await server.handler(incoming('查 finance-invoices 2026-10'));
      const blocked = events.filter((event) => event['event'] === 'execution_retry_blocked');
      // 只拦不发：执行客户端只被调用 1 次
      expect(client.calls).toBe(1);
      // 且这条拦下的事实对运维可见（对象/操作/执行层的码与 retryable 声明）
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toMatchObject({
        operation: 'dummy.query',
        object: 'finance-invoices',
        code: 'WHERE_INVALID',
        declaredRetryable: false,
      });
    } finally {
      server.close();
    }
  });

  it('瞬时故障（retryable:true）不拦，但落 execution_retry_allowed', async () => {
    const dir = tempDir();
    let calls = 0;
    const transient: ExecutionClient = {
      async capabilities(): Promise<CapabilityManifest> {
        return MANIFEST;
      },
      async execute(): Promise<ExecutionOutcome> {
        calls += 1;
        return { status: 'failed', error: { code: 'TRANSIENT', message: 'busy', retryable: true } };
      },
    };
    const events: Array<Record<string, unknown>> = [];
    const server = await createServer({
      env: { LLM_MODEL: 'test-model' },
      config: config(),
      dbPath: path.join(dir, 'state.db'),
      createDrivers: () => ({ mainDriver: mainDriver(), workerDriver: retryingWorkerDriver() }),
      createExecutionFace: async () => ({
        client: transient,
        allowedOperations: ['dummy.query'],
        readOnlyOperations: ['dummy.query'],
      }),
      logger: (line) => events.push(line as Record<string, unknown>),
    });
    try {
      await server.handler(incoming('查 finance-invoices 2026-10'));
      // 放行：同对象两次尝试都真的发起了
      expect(calls).toBe(2);
      const allowed = events.filter((event) => event['event'] === 'execution_retry_allowed');
      expect(allowed).toHaveLength(2);
      expect(allowed[0]).toMatchObject({ operation: 'dummy.query', object: 'finance-invoices', code: 'TRANSIENT' });
      expect(events.filter((event) => event['event'] === 'execution_retry_blocked')).toEqual([]);
    } finally {
      server.close();
    }
  });
});
