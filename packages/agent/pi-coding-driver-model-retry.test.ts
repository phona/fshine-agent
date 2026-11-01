/**
 * 模型瞬时失败的有界重试 + 观测补强（波次C，2026-11-01）：驱动侧表征测试。
 *
 * 事故形态（2026-10-31 实测，task_144c9690）：确认续跑中第 4 个平台调用（业务失败
 * exit 1，无害）之后的下一次 worker 模型请求发生 ~260ms 瞬时传输失败（openai SDK 归类
 * APIConnectionTimeoutError，"Request timed out."）。pi-agent-core 的 agent-loop 遇
 * stopReason=error 正常 return 不抛异常，驱动在 `timedOut || cancelled ||
 * state.errorMessage` 分支返回空文本且 **errorMessage 零日志被吞**，宿主空文本检查抛
 * "未返回可用结果"、分类 executor_error——260ms 网抖报废 90 秒工作 + 烧掉一次用户确认。
 *
 * 本文件钉住三层防线（C1+C2）：
 *   ① C1 观测：errorMessage 命中点发 `worker_model_stream_error` 结构化日志（真实错误
 *      不再被吞），失败事实经 `modelError` 透传进 TurnDriverResult——上层分类不再只有
 *      空文本可看；
 *   ② C2 有界重试：判据用 pi-ai 现成的 `isRetryableAssistantError`（不造第二份判据），
 *      可重试则原地重试（默认最多 2 次、间隔 1-2 秒），恢复即照常返回结果并记
 *      `worker_model_retry_recovered`（第几次、耗时）；用尽仍失败 → modelError 透传；
 *      不可重试（含配额/账单类，pi-ai 的 NON_RETRYABLE 覆盖表）不重试直接透传；
 *   ③ 边界：超时/取消优先于重试（那两条是宿主自己的收尾事实，模型错误只是其表征，
 *      重试它们等于跟自己的 abortTimer 作对）——cancelled 下一次调用即收、不透传
 *      modelError。
 *
 * 假 agent 忠实镜像真实 SDK 的三个关键语义（缺一个都会让重试测试变成假绿）：
 *   · `continue()` 开跑即清 `state.errorMessage`（agent.js runWithLifecycle 入口）——
 *     上一轮失败不污染下一轮判定；
 *   · 模型轮失败时 push 一条 `stopReason:'error'` 的 assistant 消息（handleRunFailure /
 *     流式 message_end 同形）——重试前必须剥掉它，否则 `continue()` 会以
 *     "Cannot continue from message role: assistant" 拒绝续跑；
 *   · `continue()` 在结尾是 assistant 消息时抛错——逼着重试实现真做剥除，而不是
 *     只在 happy path 上过。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, DEFAULT_MODEL_RETRY_DELAYS_MS } from './src/pi-coding-driver';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';

/** 假 agent 的单个模型回合：收尾文本，或模型轮失败（errorMessage）。 */
type FakeTurn = { text?: string; errorMessage?: string };

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; continueCalls: number; messages: unknown[] };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, continueCalls: 0, messages: [] };
      records.push(record);
      const state: { errorMessage?: string; messages: unknown[] } = {
        errorMessage: undefined,
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      };
      const agent = {
        state,
        beforeToolCall: undefined as unknown,
        shouldStopAfterTurn: undefined as unknown,
        abort: () => {},
        steer: () => {},
        continue: async () => {
          // 镜像真实 SDK：结尾是 assistant 消息时 continue() 拒绝续跑——重试实现
          // 必须先剥掉 error assistant 消息，否则这里抛错（正是 SDK 的行为）。
          const last = record.messages[record.messages.length - 1] as { role?: string } | undefined;
          if (last && last.role === 'assistant') {
            throw new Error('Cannot continue from message role: assistant');
          }
          record.continueCalls += 1;
          // 镜像真实 SDK：开跑即清上一轮的失败态（agent.js runWithLifecycle 入口）。
          state.errorMessage = undefined;
          // 脚本耗尽后重复最后一跳（与 fast-path 假 agent 的 Math.min 手法一致）：
          // "连抛三次"用单元素脚本即可表达。
          const turn = record.turns[Math.min(record.continueCalls - 1, record.turns.length - 1)];
          if (!turn) return;
          if (turn.errorMessage) {
            // 镜像真实 SDK：失败以 error assistant 消息落转录 + state.errorMessage 置位。
            state.errorMessage = turn.errorMessage;
            record.messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: '' }],
              stopReason: 'error',
              errorMessage: turn.errorMessage,
              timestamp: Date.now(),
            });
            return;
          }
          if (turn.text) {
            record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
          }
        },
      };
      return { session: { agent, dispose: () => {} } };
    },
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createAgentSession: async () => fake.makeSession() };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function makeDriver(modelRetryDelaysMs?: readonly number[]): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-modelretry-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      // 测试注入点：1ms 间隔让重试路径不等真秒表（生产行为由常量测试钉住）。
      ...(modelRetryDelaysMs ? { modelRetryDelaysMs } : {}),
    }),
  };
}

function runInput(cwd: string, signal?: AbortSignal): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '查一下', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_modelretry',
    requestId: 'req_modelretry',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: Date.now() + 10_000,
    ...(signal ? { signal } : {}),
  };
}

/** 2026-10-31 实测的瞬时形态：openai SDK 的 APIConnectionTimeoutError 文案。 */
const TRANSIENT_ERROR = 'Request timed out.';

describe('模型瞬时失败：有界重试与 modelError 透传（波次C）', () => {
  it('生产默认档位：最多 2 次重试、间隔 1-2 秒（常量钉住，不许静默漂移）', () => {
    expect(DEFAULT_MODEL_RETRY_DELAYS_MS).toEqual([1000, 2000]);
  });

  it('可重试模型错误 → 原地重试后恢复：结果照常、有 retry_recovered 事件、error assistant 消息被剥除', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { driver, cwd } = await makeDriver([1, 1]);
      fake.setScript([{ errorMessage: TRANSIENT_ERROR }, { text: '查询完成。' }]);

      const result = await driver.run(runInput(cwd));

      // 恢复即照常：终稿是 worker 文本，不带 modelError。
      expect(result.text).toBe('查询完成。');
      expect(result.modelError).toBeUndefined();
      // 初次失败 + 1 次重试，共 2 次模型调用。
      expect(fake.records.at(-1)!.continueCalls).toBe(2);
      // C1：失败事实进结构化日志（真实错误不再被吞）。
      const streamErrors = errorSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'worker_model_stream_error');
      expect(streamErrors).toHaveLength(1);
      expect(streamErrors[0]).toMatchObject({ errorMessage: TRANSIENT_ERROR, stopReason: 'error', requestId: 'req_modelretry', taskId: 'task_modelretry' });
      // C2：恢复留痕（第几次、耗时）。
      const recovered = infoSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'worker_model_retry_recovered');
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ attempt: 1, requestId: 'req_modelretry', taskId: 'task_modelretry' });
      expect(typeof recovered[0].durationMs).toBe('number');
      // 剥除语义：error assistant 消息不留在转录里（SDK _prepareRetry 同款）。
      const assistantStops = (result.messages as Array<{ role?: string; stopReason?: string }>).filter((m) => m.role === 'assistant').map((m) => m.stopReason);
      expect(assistantStops).toEqual(['stop']);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('连抛可重试错误 → 重试用尽（默认 2 次）：modelError 透传、无第四次调用、每次失败都有日志', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { driver, cwd } = await makeDriver([1, 1]);
      fake.setScript([{ errorMessage: TRANSIENT_ERROR }]);

      const result = await driver.run(runInput(cwd));

      // 用尽：1 次初调 + 2 次重试，绝无第 4 次。
      expect(fake.records.at(-1)!.continueCalls).toBe(3);
      // C1 透传：上层分类不再只有空文本可看。
      expect(result.modelError).toBe(TRANSIENT_ERROR);
      expect(result.text).toBe('');
      // 每次失败都留痕（attempt 1/2/3）。
      const streamErrors = errorSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'worker_model_stream_error');
      expect(streamErrors.map((e) => e.attempt)).toEqual([1, 2, 3]);
      // 用尽即失败，没有 recovered 事件。
      expect(infoSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'worker_model_retry_recovered')).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('不可重试错误（配额/账单族，pi-ai 判据的非重试覆盖表）→ 不重试直接透传', async () => {
    // 同时命中可重试（rate limit）与不可重试（insufficient_quota）模式时，pi-ai 的
    // NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN 优先——这条钉住"用的是 pi-ai 判据"，
    // 而不是自造的宽松版。
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { driver, cwd } = await makeDriver([1, 1]);
      fake.setScript([{ errorMessage: 'rate limit reached: insufficient_quota for this account' }]);

      const result = await driver.run(runInput(cwd));

      expect(fake.records.at(-1)!.continueCalls).toBe(1);
      expect(result.modelError).toBe('rate limit reached: insufficient_quota for this account');
      const streamErrors = errorSpy.mock.calls.map((args) => JSON.parse(String(args[0]))).filter((e) => e.event === 'worker_model_stream_error');
      expect(streamErrors).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('取消优先于重试：signal 已中止 → 一次调用即收、不透传 modelError（timedOut/cancelled 分支先后不破坏）', async () => {
    const controller = new AbortController();
    controller.abort();
    const { driver, cwd } = await makeDriver([1, 1]);
    fake.setScript([{ errorMessage: TRANSIENT_ERROR }]);

    const result = await driver.run(runInput(cwd, controller.signal));

    // 取消是宿主自己的收尾事实：不重试（1 次调用）、不把模型错误透传成 model_transient。
    expect(fake.records.at(-1)!.continueCalls).toBe(1);
    expect(result.modelError).toBeUndefined();
    expect(result.text).toBe('');
  });
});
