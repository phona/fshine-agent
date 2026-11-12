/**
 * token 消耗统计（纯加法遥测）的账目表征：sumUsage 求和口径、三个采集点的埋点字段
 * （delegation_span / turn_span / aux_model_usage）与 SubagentTaskResult 透传。
 * 口径与缺失策略的定义在 driver.ts（本文件是它的回归锁）；数据只认 provider 真实
 * Usage，禁止字符估算。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo, TrustedContext } from '@fshine/contracts';
import { addUsageTotals, sumUsage, usageFieldsOf, usageSpanFields, DriverMessage, ScriptedTurnDriver, type TurnDriver, type TurnDriverInput } from './src/driver';
import { RUN_EXECUTION_TASK_DESCRIPTION, RUN_EXECUTION_TASK_SCHEMA, RUN_EXECUTION_TASK_TOOL, createContextTaskRunner } from './src/context';
import { createTaxAgentRuntime } from './src/runtime';
import { FakeSessionRepo } from './test-helpers';

/** provider 真实 Usage 形状的 assistant 消息（pi-ai 盖在每条 assistant 消息上的形状）。 */
function assistant(usage: Record<string, unknown> | undefined, text = 'ok'): DriverMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'llm',
    model: 'm1',
    ...(usage === undefined ? {} : { usage }),
    stopReason: 'stop',
    timestamp: Date.now(),
  } as unknown as DriverMessage;
}

/** 捕获本进程 JSON 埋点行（测试期间替换 console.info，结束恢复）。 */
function captureEvents(): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (line: string) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed['event'] === 'string') events.push(parsed);
    } catch { /* 非 JSON 行不采 */ }
  };
  return { events, restore: () => { console.info = original; } };
}

describe('sumUsage 求和口径', () => {
  it('对 assistant 消息分项求和，跳过 user/toolResult；reasoning 只在 provider 回报时出现', () => {
    const messages = [
      { role: 'user', content: 'q', timestamp: 1 },
      assistant({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, reasoning: 7, totalTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
      { role: 'toolResult', toolCallId: 't1', toolName: 'x', content: [], isError: false, timestamp: 2 },
      assistant({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
    ] as unknown as DriverMessage[];
    expect(sumUsage(messages)).toEqual({ input: 150, output: 30, cacheRead: 5, cacheWrite: 3, reasoning: 7 });
  });

  it('没有任何 usage 证据 → undefined（埋点字段缺席，与全零可区分）', () => {
    expect(sumUsage([])).toBeUndefined();
    expect(sumUsage([assistant(undefined)])).toBeUndefined();
  });

  it('EMPTY_USAGE 全零占位（失败消息）求和为 0：provider 如实报 0 与没回传是两回事', () => {
    const totals = sumUsage([assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })]);
    expect(totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });

  it('部分消息缺 usage 按 0 计入（部分覆盖时求已知部分，不报错）', () => {
    const messages = [assistant(undefined), assistant({ input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })] as unknown as DriverMessage[];
    expect(sumUsage(messages)).toEqual({ input: 8, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it('usageSpanFields：tokens = input+output+cacheRead+cacheWrite；reasoning ⊆ output 不重复相加', () => {
    expect(usageSpanFields({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 5 })).toEqual({
      tokensIn: 10, tokensOut: 5, cacheRead: 2, cacheWrite: 1, reasoning: 5, tokens: 18,
    });
    // provider 从未回报 reasoning：字段缺席（不是 0）
    expect(usageSpanFields({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })).toEqual({
      tokensIn: 1, tokensOut: 2, cacheRead: 0, cacheWrite: 0, tokens: 3,
    });
  });

  it('addUsageTotals：undefined 是加法单位元；reasoning 任一侧缺席时对已知部分求和', () => {
    expect(addUsageTotals(undefined, undefined)).toBeUndefined();
    const a = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    expect(addUsageTotals(a, undefined)).toEqual(a);
    expect(addUsageTotals(undefined, a)).toEqual(a);
    expect(addUsageTotals(a, { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, reasoning: 2 })).toEqual({ input: 4, output: 6, cacheRead: 1, cacheWrite: 2, reasoning: 2 });
    expect(addUsageTotals({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 1 }, a)).toEqual({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 1 });
  });

  it('usageFieldsOf：无证据时返回空对象（字段缺席）', () => {
    expect(usageFieldsOf([assistant(undefined)])).toEqual({});
  });
});

// ── worker 侧采集：delegation_span + SubagentTaskResult 透传 ────────────────

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class MemoryTasks implements PlatformTaskRepo {
  readonly records = new Map<string, PlatformTaskRecord>();
  async get(taskId: string) { return this.records.get(taskId) ?? null; }
  async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
  async listBySession(principalId: string, sessionId: string) {
    return [...this.records.values()]
      .filter((record) => record.principalId === principalId && record.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function trusted(): TrustedContext {
  return { requestId: 'req-1', principalId: 'wecom:user-1', sessionId: 'session-1' };
}

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fshine-usage-'));
  roots.push(root);
  await mkdir(path.join(root, '.agents', 'skills', 'example-gateway'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'example-gateway', 'SKILL.md'), '---\nname: example-gateway\ndescription: 幻账平台工作规范\n---\n使用领域脚本并返回可复核证据。\n');
  return root;
}

function runner(root: string, driver: TurnDriver) {
  const profiles: Record<string, ContextProfileConfig> = {
    'example-gateway': { root, skillRoots: ['.agents/skills'] },
  };
  return createContextTaskRunner({ profiles, tasks: new MemoryTasks(), workerDriver: driver });
}

describe('worker 侧 token 采集（delegation_span + SubagentTaskResult）', () => {
  it('ok 结局：delegation_span 带分项字段，结果透传 usage', async () => {
    const root = await profileRoot();
    const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 8, totalTokens: 126, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const driver: TurnDriver = {
      run: async (input) => ({ text: '已查询完成。', messages: [...input.messages, assistant(usage, '已查询完成。')] }),
    };
    const capture = captureEvents();
    let result;
    try {
      result = await runner(root, driver).run({ request: '查询幻辰余额' }, { trusted: trusted() });
    } finally {
      capture.restore();
    }
    const span = capture.events.find((event) => event['event'] === 'delegation_span');
    expect(span).toBeDefined();
    expect(span?.['outcome']).toBe('ok');
    expect(span?.['tokensIn']).toBe(100);
    expect(span?.['tokensOut']).toBe(20);
    expect(span?.['cacheRead']).toBe(5);
    expect(span?.['cacheWrite']).toBe(1);
    expect(span?.['reasoning']).toBe(8);
    // tokens = input+output+cacheRead+cacheWrite（reasoning ⊆ output 不重复相加）
    expect(span?.['tokens']).toBe(126);
    // SubagentTaskResult 透传（stepLabel 场景与测试断言用）
    expect(result.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 8 });
  });

  it('网关不回传 usage：delegation_span 无 token 字段、result.usage 缺席，不报错', async () => {
    const root = await profileRoot();
    const driver: TurnDriver = {
      run: async (input) => ({ text: '已查询完成。', messages: [...input.messages, assistant(undefined, '已查询完成。')] }),
    };
    const capture = captureEvents();
    let result;
    try {
      result = await runner(root, driver).run({ request: '查询幻辰余额' }, { trusted: trusted() });
    } finally {
      capture.restore();
    }
    const span = capture.events.find((event) => event['event'] === 'delegation_span');
    expect(span?.['outcome']).toBe('ok');
    expect(span?.['tokensIn']).toBeUndefined();
    expect(span?.['tokens']).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });
});

// ── Main 侧采集：turn_span ─────────────────────────────────────────────────

function makeCtx(): TrustedContext {
  return { requestId: 'req_usage', principalId: 'wecom:user_a', sessionId: 'sess_1' };
}

/**
 * 普通回合给出文本的脚本驱动，最后一条 assistant 消息盖 provider usage。
 * ScriptedTurnDriver 产出的是简化形状（无 usage），这里只给最后一条补上——模拟
 * pi-driver 的真实转录（assistant 消息带 message.usage）。
 */
function scriptedMainDriver(usage: Record<string, unknown> | undefined, text: string): TurnDriver {
  const base = ScriptedTurnDriver([
    { text },
  ]);
  return {
    run: async (input) => {
      const result = await base.run(input);
      const messages = result.messages.map((message, index) => (
        index === result.messages.length - 1 ? assistant(usage, text) : message
      ));
      return { ...result, messages };
    },
  };
}

describe('Main 侧 token 采集（turn_span）', () => {
  it('正常回合：turn_span 带 Main 驱动新增 assistant 消息的分项', async () => {
    const usage = { input: 500, output: 40, cacheRead: 300, cacheWrite: 10, totalTokens: 850, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const runtime = createTaxAgentRuntime({
      driver: scriptedMainDriver(usage, '你好，我可以帮你查询平台数据。'),
      sessions: new FakeSessionRepo(),
      platformTask: {
        tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
        run: async () => { throw new Error('闲聊轮不应委派'); },
      },
    });
    const capture = captureEvents();
    try {
      await runtime.handleTurn(makeCtx(), '你好，你能做什么？');
    } finally {
      capture.restore();
    }
    const span = capture.events.find((event) => event['event'] === 'turn_span');
    expect(span).toBeDefined();
    expect(span?.['outcome']).toBe('ok');
    expect(span?.['tokensIn']).toBe(500);
    expect(span?.['tokensOut']).toBe(40);
    expect(span?.['cacheRead']).toBe(300);
    expect(span?.['cacheWrite']).toBe(10);
    expect(span?.['tokens']).toBe(850);
    // provider 没回报 reasoning：reasoning 字段缺席
    expect(span?.['reasoning']).toBeUndefined();
  });

  it('闲聊轮不委派也不带 usage（旧驱动）：turn_span 零 token 字段，不报错', async () => {
    const runtime = createTaxAgentRuntime({
      driver: scriptedMainDriver(undefined, '你好，我可以帮你查询平台数据。'),
      sessions: new FakeSessionRepo(),
      platformTask: {
        tool: { name: RUN_EXECUTION_TASK_TOOL, description: RUN_EXECUTION_TASK_DESCRIPTION, inputSchema: RUN_EXECUTION_TASK_SCHEMA },
        run: async () => { throw new Error('闲聊轮不应委派'); },
      },
    });
    const capture = captureEvents();
    try {
      await runtime.handleTurn(makeCtx(), '你好，你能做什么？');
    } finally {
      capture.restore();
    }
    const span = capture.events.find((event) => event['event'] === 'turn_span');
    expect(span?.['outcome']).toBe('ok');
    expect(span?.['tokensIn']).toBeUndefined();
    expect(span?.['tokens']).toBeUndefined();
  });
});

// 辅助模型采集（aux_model_usage，kind: context | memory）随相位 1 删除：两条辅助路径
// （Context State 语义抽取 / 长期记忆候选抽取）本身已删除，不再有 aux_model_usage 生产者
// ——测已不存在的埋点等于给删除集留假覆盖。
