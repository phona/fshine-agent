/**
 * 排队最长等待（2026-11-18，预期契约配套的资源边界；先红后绿）。
 *
 * 目标：前台回合排队晋升**有上限**（`runtime.queueWaitMs`，缺省 120s）——
 *   · 超过上限 → 确定性拒绝（既有 ForegroundRejectionError 形状，话术说明「当前系统忙，
 *     请稍后再说」），不留下排队残留（队列长度回到 0）；
 *   · 记一条 `resource_queue_timeout{kind, principalId, waitedMs}` 事件；
 *   · 上限走 resource-policy 单一配置源（本测试只经 `createResourcePolicy({queueWaitMs})`）。
 *
 * 确定性：注入假时钟（now + sleep 两原语），不真 sleep 两分钟。反向绊线：把超时判据去掉 →
 * 等待者的 sleep 次数超过测试预算 → send 以「预算」错误拒绝（不是 ForegroundRejectionError），
 * 本用例立刻转红而不是悬挂。
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityManifest, ExecutionClient, ExecutionOutcome } from '@fshine/contracts/execution-contract';
import type { TurnDriver } from './src/driver-contract';
import {
  ForegroundRejectionError,
  createSession,
  type ResourceQueueTimeoutEvent,
  type RuntimeClock,
} from './src/execution-runtime';
import { createResourcePolicy } from './src/resource-policy';

const PRINCIPAL = 'wecom:queue-user';
const SESSION = 'conv-queue';
const MANIFEST: CapabilityManifest = {
  contractVersion: 1,
  operations: [{ name: 'dummy.query', label: 'query', args: [] }],
};

const client: ExecutionClient = {
  async capabilities(): Promise<CapabilityManifest> {
    return MANIFEST;
  },
  async execute(): Promise<ExecutionOutcome> {
    return { status: 'completed', data: {} };
  },
};

/** 不应被调用的 Main 驱动（准入拒绝发生在回合开始前）。 */
const unreachableDriver: TurnDriver = {
  async run() {
    throw new Error('（测试）排队超时不应进入回合');
  },
};

/** 假时钟：sleep 只推进时间；超过迭代预算即抛错（反向绊线的确定性红）。 */
function guardedClock(input: { startMs: number; maxSleeps: number }): RuntimeClock & { time(): number } {
  let current = input.startMs;
  let sleeps = 0;
  return {
    now: () => current,
    sleep: (ms) => {
      sleeps += 1;
      if (sleeps > input.maxSleeps) {
        return Promise.reject(new Error('排队等待超过测试预算：排队上限（queueWaitMs）看似未生效'));
      }
      current += ms;
      return Promise.resolve();
    },
    time: () => current,
  };
}

describe('前台排队最长等待（queueWaitMs）', () => {
  it('排队超过上限 → 确定性拒绝 + 系统忙话术 + 无排队残留 + resource_queue_timeout 事件', async () => {
    let nowMs = Date.parse('2026-11-18T00:00:00.000Z');
    const events: ResourceQueueTimeoutEvent[] = [];
    const policy = createResourcePolicy(
      { mainConcurrency: 1, queueCapacity: 1, queueWaitMs: 5_000 },
      { now: () => nowMs },
    );
    // 占满唯一前台位（另一个会话的回合正在跑）。
    const held = policy.acquire('foreground', { taskId: 'session:other:conv' });
    expect(held.ok).toBe(true);

    const clock = guardedClock({ startMs: nowMs, maxSleeps: 1_000 });
    const session = await createSession({
      principalId: PRINCIPAL,
      sessionId: SESSION,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver: unreachableDriver,
      workerDriver: unreachableDriver,
      mainSystemPrompt: '（测试）Main 系统提示',
      policy,
      taskRunClock: clock,
      onResourceQueueTimeout: (event) => events.push(event),
    });

    try {
      const error = await session.send('查一下上季度报销').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForegroundRejectionError);
      expect((error as ForegroundRejectionError).reason).toBe('queue_full');
      // 既有拒绝形状 + 明确「系统忙」话术（业务用户读得懂的确定性说明）。
      expect((error as Error).message).toContain('当前系统忙，请稍后再说');
      // 不留下排队残留：队列回到 0（等待者已退队）。
      expect(policy.snapshot().foreground.queued).toBe(0);
      expect(policy.snapshot().foreground.active).toBe(1);
      // 事件字段（只进日志，不进用户话术）。
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'foreground', principalId: PRINCIPAL });
      expect(events[0]!.waitedMs).toBeGreaterThanOrEqual(5_000);
      // 假时钟确实推进到上限（不是立即拒绝）。
      expect(clock.time()).toBeGreaterThanOrEqual(nowMs + 5_000);
      nowMs = clock.time();
    } finally {
      if (held.ok) policy.release(held);
    }
  });

  it('上限内晋升成功 → 不拒绝（占位者释放后等待者拿到许可并跑完回合）', async () => {
    let nowMs = Date.parse('2026-11-18T00:00:00.000Z');
    const policy = createResourcePolicy(
      { mainConcurrency: 1, queueCapacity: 1, queueWaitMs: 60_000 },
      { now: () => nowMs },
    );
    const held = policy.acquire('foreground', { taskId: 'session:other:conv-2' });
    expect(held.ok).toBe(true);

    let sleeps = 0;
    const clock: RuntimeClock = {
      now: () => nowMs,
      sleep: (ms) => {
        sleeps += 1;
        nowMs += ms;
        // 第 2 次让出时释放占位许可：等待者应被 FIFO 晋升。
        if (sleeps === 2 && held.ok) policy.release(held);
        return Promise.resolve();
      },
    };
    const session = await createSession({
      principalId: PRINCIPAL,
      sessionId: SESSION,
      client,
      allowedOperations: ['dummy.query'],
      mainDriver: {
        async run(input) {
          return { text: '已办完。', messages: [...input.messages] };
        },
      },
      workerDriver: unreachableDriver,
      mainSystemPrompt: '（测试）Main 系统提示',
      policy,
      taskRunClock: clock,
    });

    const result = await session.send('查一下上季度报销');
    expect(result.reply).toBe('已办完。');
    expect(sleeps).toBeLessThan(10);
    nowMs = clock.now();
  });
});
