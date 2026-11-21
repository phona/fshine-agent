/**
 * CAP-01 排队容量与前台并发（server 生产装配 · 假驱动 · 零网络）：
 *   ① 缺省 queueCapacity=16：5 个会话同时发起回合 → 5 个全部成功、queue_full 次数 0、
 *      按 FIFO（发起顺序）完成；
 *   ② 排队上限仍生效（不是把上限拿掉）：显式 queueCapacity=1 时第 3 个并发请求仍被
 *      queue_full 确定性拒绝；
 *   ③ 缺省 mainConcurrency=4：5 个会话并发（每回合占槽 2s）→ 5 个全部成功、queue_full 0、
 *      同时 active ≤ 4（且确实用到 4 槽）、至少 1 个回合真实经历过排队。
 *
 * 计数口径：vi.mock 只做 `createResourcePolicy` 的**直通包装**（委托真实实现），把
 * `acquire` 的拒绝 reason / 许可状态记进数组——生产装配与策略行为逐字节不变，只多观测点。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@fshine/contracts';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from '../../packages/agent/src/driver-contract';
import { ForegroundRejectionError } from '../../packages/agent/src/execution-runtime';
import { createServer } from './server';

/** acquire 观测（mock 直通包装写入；每用例重置）。 */
const policyProbe = vi.hoisted(() => ({
  rejections: [] as Array<{ kind: string; reason: string }>,
  permits: [] as Array<{ kind: string; state: string }>,
}));

vi.mock('../../packages/agent/src/resource-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/agent/src/resource-policy')>();
  return {
    ...actual,
    createResourcePolicy: (
      config?: Parameters<typeof actual.createResourcePolicy>[0],
      options?: Parameters<typeof actual.createResourcePolicy>[1],
    ) => {
      const policy = actual.createResourcePolicy(config, options);
      return {
        ...policy,
        acquire: ((kind, opts) => {
          const result = policy.acquire(kind, opts);
          if (!result.ok) policyProbe.rejections.push({ kind: result.kind, reason: result.reason });
          else policyProbe.permits.push({ kind: result.kind, state: result.state });
          return result;
        }) as typeof policy.acquire,
      };
    },
  };
});

const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'scripts', 'eval', 'fixtures', 'dummy-platform');
const CONVERSATIONS = ['conv-1', 'conv-2', 'conv-3', 'conv-4', 'conv-5'] as const;
/** 首回合的占槽时长：让后续请求真实进入等待队列（FIFO 晋升而非串行秒完）。 */
const TURN_HOLD_MS = 20;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  policyProbe.rejections.length = 0;
  policyProbe.permits.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-capq-queue-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(runtime?: AppConfig['runtime']): AppConfig {
  return {
    principals: { 'wecom:user-a': { enabled: true } },
    contextProfiles: {
      dummy: { root: FIXTURE_ROOT, gateway: 'bin/dummy', skillRoots: ['.agents/skills-serve'] },
    },
    channel: { port: 3000, publicUrl: '', callbackPath: '/wecom/callback' },
    sessionTtlMs: 86_400_000,
    ...(runtime === undefined ? {} : { runtime }),
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

/**
 * 假主驱动：回合文本 → 记录**开始顺序**（turn-* 才记）→ 占槽 holdMs → 回 `reply:<text>`。
 * 同一驱动实例只服务一个会话（createDrivers 每会话调用一次），共享 `order` 是 FIFO 证据；
 * `spans` 记录每个 turn-* 回合的起止墙钟（并发上限/排队经历的行为证据，不读策略内部）。
 */
function scriptedDriver(order: string[], spans: TurnSpan[], holdMs: number): TurnDriver {
  return {
    async run(input) {
      const last = input.messages[input.messages.length - 1] as { content?: unknown } | undefined;
      const text = typeof last?.content === 'string' ? last.content : '';
      if (text.startsWith('turn-')) {
        order.push(text);
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        spans.push({ text, start, end: Date.now() });
      }
      const reply = `reply:${text}`;
      return { text: reply, messages: [...input.messages, { role: 'assistant', content: reply } as never] };
    },
  };
}

interface TurnSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** 区间最大重叠数（同一时刻先算结束再算开始：首尾相接不算同时 active）。 */
function maxOverlap(spans: readonly TurnSpan[]): number {
  const events: Array<[number, number]> = [];
  for (const span of spans) events.push([span.start, 1], [span.end, -1]);
  events.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  order: string[];
  spans: TurnSpan[];
}

async function makeFixture(runtime?: AppConfig['runtime'], holdMs = TURN_HOLD_MS): Promise<Fixture> {
  const dir = tempDir();
  const order: string[] = [];
  const spans: TurnSpan[] = [];
  const server = await createServer({
    env: { LLM_MODEL: 'test-model' },
    config: testConfig(runtime),
    dbPath: path.join(dir, 'state.db'),
    createDrivers: () => ({ mainDriver: scriptedDriver(order, spans, holdMs), workerDriver: workerNeverCalled }),
    createExecutionFace: async () => ({
      client: new FaceClient(),
      allowedOperations: ['dummy.query'],
      readOnlyOperations: ['dummy.query'],
    }),
    logger: () => undefined,
  });
  return { server, order, spans };
}

/** 预先把每个会话各跑一轮（顺序、无并发），让并发突发只测准入/排队本身。 */
async function warmUp(server: Fixture['server'], conversations: readonly string[]): Promise<void> {
  for (const conversationId of conversations) {
    await server.handler({
      wecomUserId: 'user-a',
      channel: 'wecom',
      conversationId,
      messageId: `warm-${conversationId}`,
      chatType: 'single',
      text: 'warm',
      receivedAt: new Date().toISOString(),
    });
  }
}

function turnMessage(conversationId: string, index: number) {
  return {
    wecomUserId: 'user-a',
    channel: 'wecom' as const,
    conversationId,
    messageId: `m-${conversationId}-${index}`,
    chatType: 'single' as const,
    text: `turn-${index}`,
    receivedAt: new Date().toISOString(),
  };
}

function queueFullCount(): number {
  return policyProbe.rejections.filter((rejection) => rejection.reason === 'queue_full').length;
}

describe('CAP-01 排队容量与前台并发（server 生产装配）', () => {
  it('① 缺省 16：5 个会话并发 → 5 个全部成功、queue_full 0 次、按 FIFO 顺序完成', async () => {
    const { server, order } = await makeFixture(); // 无 runtime 段 = 缺省（mainConcurrency 4 / queueCapacity 16）
    try {
      await warmUp(server, CONVERSATIONS);
      policyProbe.rejections.length = 0; // 只统计并发突发本身

      // 并发突发：先到的会话占唯一前台槽，其余进等待队列；全部成功才算数。
      const results = await Promise.allSettled(
        CONVERSATIONS.map((conversationId, index) => server.handler(turnMessage(conversationId, index + 1))),
      );

      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      expect(results.map((result) => (result as PromiseFulfilledResult<string>).value)).toEqual([
        'reply:turn-1',
        'reply:turn-2',
        'reply:turn-3',
        'reply:turn-4',
        'reply:turn-5',
      ]);
      // FIFO：回合开始顺序 = 发起顺序（队首晋升，不插队）。
      expect(order).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
      // 缺省并发 4：4 个占槽 + 1 个排队，全部 ≤ 缺省容量 16：零 queue_full。
      expect(queueFullCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('② 排队上限仍生效：显式 mainConcurrency=1 + queueCapacity=1 时第 3 个并发请求被 queue_full 确定性拒绝', async () => {
    const { server, order } = await makeFixture({ mainConcurrency: 1, queueCapacity: 1 });
    const conversations = CONVERSATIONS.slice(0, 3);
    try {
      await warmUp(server, conversations);
      policyProbe.rejections.length = 0;

      const results = await Promise.allSettled(
        conversations.map((conversationId, index) => server.handler(turnMessage(conversationId, index + 1))),
      );

      // 第 1 个占槽、第 2 个排队（容量 1）、第 3 个满员 → queue_full（上限没被拿掉）。
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      expect((results[0] as PromiseFulfilledResult<string>).value).toBe('reply:turn-1');
      expect((results[1] as PromiseFulfilledResult<string>).value).toBe('reply:turn-2');
      const rejection = (results[2] as PromiseRejectedResult).reason as ForegroundRejectionError;
      expect(rejection).toBeInstanceOf(ForegroundRejectionError);
      expect(rejection.reason).toBe('queue_full');
      expect(order).toEqual(['turn-1', 'turn-2']); // 第 3 个从未进入执行
      expect(queueFullCount()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('③ 缺省前台并发 4：5 会话并发（每回合 2s）→ 全部完成、queue_full 0、同时 active 恰为 4、至少 1 个排队', async () => {
    const { server, order, spans } = await makeFixture(undefined, 2_000);
    try {
      await warmUp(server, CONVERSATIONS);
      policyProbe.rejections.length = 0; // 只统计并发突发本身
      policyProbe.permits.length = 0;
      spans.length = 0;

      const results = await Promise.allSettled(
        CONVERSATIONS.map((conversationId, index) => server.handler(turnMessage(conversationId, index + 1))),
      );

      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      expect(results.map((result) => (result as PromiseFulfilledResult<string>).value)).toEqual([
        'reply:turn-1',
        'reply:turn-2',
        'reply:turn-3',
        'reply:turn-4',
        'reply:turn-5',
      ]);
      expect(queueFullCount()).toBe(0);

      // 同时 active ≤ 4（行为证据来自回合起止墙钟）；且确实用到 4 槽——缺省回到 1 时本断言会红。
      expect(maxOverlap(spans)).toBe(4);
      // 至少 1 个回合真实经历过排队（acquire 时拿到 queued，而不是 5 个都 active）。
      const foreground = policyProbe.permits.filter((permit) => permit.kind === 'foreground');
      expect(foreground.filter((permit) => permit.state === 'active')).toHaveLength(4);
      expect(foreground.filter((permit) => permit.state === 'queued').length).toBeGreaterThanOrEqual(1);
      // 排队者按 FIFO 最后进入执行。
      expect(order).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
    } finally {
      await server.close();
    }
  }, 20_000);
});
