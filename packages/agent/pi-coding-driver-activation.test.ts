/**
 * P1 收尾兜底：计划已激活却零平台调用时，driver 侧那一次确定性补一刀。
 *
 * 2026-09-26 真实平台实测（ask.ts 多轮脚本 T5r）：方案已批准、计划通知已送达用户，
 * worker 却不再发起任何平台调用就结束回合。这里守四件事：
 *   1. 补一刀真的发生（追加一条 nudge user 消息 + 再跑一轮），且同一回合内一刀就够；
 *   2. 补一刀也无效时如实上报 activatedPlan（不是伪装成执行过）；
 *   3. 补一刀边界是**每回合一次**：同一 driver 的下一个 run 仍然保留补刀机会
 *      （生产上单进程单 driver 管所有回合，"生命周期一次"会把用户卷进手动重试循环）；
 *   4. 该补才补：等用户确认门 / 超时 / 取消 / 模型出错都不补。
 *
 * 只替身 SDK 的 AgentSession：模型回合由脚本化的假 agent 回放（每轮发起哪些 bash），
 * 其余全是生产代码——G1 工具门、计划 CLI 替身、gateCalls 计数、execution/activatedPlan
 * 的合成都走 createPiCodingTurnDriver 里的真路径。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, PLAN_ACTIVATED_NUDGE } from './src/pi-coding-driver';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';

/** 假 agent 的单个模型回合：要发起哪些 bash、收尾文本、出错与挂起（超时用）。 */
type FakeTurn = { bash?: string[]; text?: string; errorMessage?: string; hangMs?: number; throws?: string };

/** 放行的平台调用回给 worker 的应答：合法的 RESULT 信封，不带任何"输入不足"错误码。 */
const OK_ENVELOPE = 'RESULT {"v":1,"op":"probe.query","status":"completed","data":{"ok":true},"error":null}';

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; rounds: number; messages: unknown[]; aborts: number; continues: number };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [], aborts: 0, continues: 0 };
      records.push(record);
      const state: { errorMessage?: string; messages: unknown[] } = {
        errorMessage: undefined,
        // driver 会整块替换 messages（恢复宿主转录）：代理到同一个数组，两边看到同一份
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      };
      const agent = {
        state,
        beforeToolCall: undefined as unknown,
        abort: () => { record.aborts += 1; },
        continue: async () => {
          record.continues += 1;
          const turn = record.turns[Math.min(record.rounds, record.turns.length - 1)];
          record.rounds += 1;
          if (!turn) return;
          let index = 0;
          for (const command of turn.bash ?? []) {
            index += 1;
            const callId = `call_${record.rounds}_${index}`;
            const ctx = {
              assistantMessage: {},
              toolCall: { id: callId, type: 'toolCall', name: 'bash', arguments: { command } },
              args: { command },
              context: {},
            };
            // 走生产接线：G1 计划门 + serve gate（放行/拦截都留痕，放行才计 gateCalls）
            const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
            record.messages.push({
              role: 'toolResult',
              toolCallId: callId,
              toolName: 'bash',
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : OK_ENVELOPE }],
              isError: Boolean(verdict?.block),
              timestamp: Date.now(),
            });
          }
          if (turn.text) {
            record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
          }
          if (turn.errorMessage) state.errorMessage = turn.errorMessage;
          if (turn.throws) throw new Error(turn.throws);
          // 挂起放在工具调用之后：模拟"计划已激活，然后这一轮卡住不动"
          if (turn.hangMs) await new Promise((resolve) => setTimeout(resolve, turn.hangMs));
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

const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"probe.query","args":["--query","某公司","--period","202609"]}]}';
const QUERY_COMMAND = 'bin/17dz query probe-query.js --query 某公司 --period 202609';
const USER_REQUEST = '把本期要查的对象查一遍';

/** 计划 CLI 替身：本任务没有既有计划，提交即激活（execute 档，无需通知/确认）。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_activation', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_activated', version: 7, decision: 'execute', estimate: { calls: 1, seconds: 10 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/** 计划 CLI 替身：提交即停在用户确认门（confirm 档）。 */
const confirmingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_activation', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600 },
    delta: { addedCalls: 30 }, cumulative: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

async function makeDriver(planCliRunner: PlanCliRunner = activatingPlanRunner): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-nudge-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      // label 表直接注入：单测里绝不 spawn 平台 CLI 派生能力清单
      operationLabels: new Map(),
      // access 表同样直接注入（D-075）：否则每回合多一次 CLI spawn，会把 40ms 极限
      // deadline 的超时用例挤到会话创建阶段就提前返回（rounds=0），测不到补刀边界。
      operationAccesses: new Map(),
      planCliRunner,
    }),
  };
}

function runInput(cwd: string, options: { deadline?: number; signal?: AbortSignal } = {}): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: USER_REQUEST, timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_activation',
    requestId: 'req_nudge',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: options.deadline ?? Date.now() + 10_000,
    ...(options.signal ? { signal: options.signal } : {}),
    onNotice: async () => {},
  };
}

/** 转录里的 user 消息（补一刀追加的那条就在其中）。 */
function userMessages(messages: readonly unknown[]): Array<{ role: string; content: unknown; timestamp?: unknown }> {
  return messages.filter((message): message is { role: string; content: unknown; timestamp?: unknown } =>
    (message as { role?: unknown }).role === 'user') as never;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => (item as { type?: string; text?: string }).type === 'text' ? (item as { text: string }).text : '').join('');
}

function nudgeMessages(messages: readonly unknown[]): unknown[] {
  return userMessages(messages).filter((message) => textOf(message.content) === PLAN_ACTIVATED_NUDGE);
}

describe('P1 收尾兜底：计划已激活却零执行的补一刀', () => {
  it('通知后零执行：追加一条 nudge 并再跑一轮，第二轮真执行后带回 execution', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [PLAN_COMMAND] },
      { bash: [QUERY_COMMAND], text: '已按方案执行查询。' },
    ]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(2);
    // 同一回合内一刀就够：continue 恰好两次（主回合 + 补刀那一轮），不会三次
    expect(record.continues).toBe(2);
    const nudges = nudgeMessages(result.messages);
    expect(nudges).toHaveLength(1);
    // 形状与宿主注入的本轮用户消息完全一致（role / content / timestamp 三个键）
    const users = userMessages(result.messages);
    expect(Object.keys(users[0]!).sort()).toEqual(['content', 'role', 'timestamp']);
    expect(Object.keys(nudges[0]!).sort()).toEqual(Object.keys(users[0]!).sort());
    // 补一刀落在"计划已激活"之后、"真正的查询"之前
    expect(result.messages.indexOf(nudges[0] as never)).toBe(2);
    expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 1 });
    expect(result.activatedPlan).toBeUndefined();
  });

  it('补一刀也无效：同一回合内只补一次（continue 恰好两次），如实上报 activatedPlan', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [PLAN_COMMAND] },
      { text: '方案已批准，但这一步执行不了。' },
    ]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(2);
    // 补刀后仍是零执行：不再追加第二条 nudge、不再跑第三轮——回合内有界一次
    expect(record.continues).toBe(2);
    expect(nudgeMessages(result.messages)).toHaveLength(1);
    expect(result.execution).toBeUndefined();
    expect(result.activatedPlan).toEqual({ planId: 'plan_activated', version: 7 });
  });

  it('同一 driver 的第二次 run 仍然补刀：补一刀边界是每回合一次，不是生命周期一次', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ bash: [PLAN_COMMAND] }, { text: '收手。' }]);
    const first = await driver.run(runInput(cwd));
    expect(nudgeMessages(first.messages)).toHaveLength(1);
    expect(first.activatedPlan).toEqual({ planId: 'plan_activated', version: 7 });

    // 第二个回合出现同样故障（生产上可能是一小时后、另一个用户）：仍然要追问一次。
    // 若退回"整个 driver 生命周期只补一次"，这里就变成零补刀，用户只能手动回复"继续"，
    // 把用户卷进"重新委派 → 重新计划通知 → 再坏 → 再说继续"的重试循环。
    fake.setScript([{ bash: [PLAN_COMMAND] }, { text: '还是收手。' }]);
    const second = await driver.run(runInput(cwd));
    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(2);
    expect(record.continues).toBe(2);
    expect(nudgeMessages(second.messages)).toHaveLength(1);
    expect(second.activatedPlan).toEqual({ planId: 'plan_activated', version: 7 });
  });

  it('停在用户确认门（pendingPlan）不补刀：那一步本来就等在确认', async () => {
    const { driver, cwd } = await makeDriver(confirmingPlanRunner);
    fake.setScript([{ bash: [PLAN_COMMAND] }]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(1);
    expect(nudgeMessages(result.messages)).toHaveLength(0);
    expect(result.pendingPlan?.planId).toBe('plan_confirm');
    expect(result.activatedPlan).toBeUndefined();
  });

  it('超时不补刀：沿用现有 timedOut 路径返回', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ bash: [PLAN_COMMAND], hangMs: 400 }]);

    const result = await driver.run(runInput(cwd, { deadline: Date.now() + 40 }));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(1);
    expect(record.aborts).toBeGreaterThan(0);
    expect(nudgeMessages(result.messages)).toHaveLength(0);
    expect(result.text).toBe('');
    // 计划确实已经激活（补一刀的条件本来成立），是超时拦住了它
    expect(JSON.stringify(result.messages)).toContain('PLAN ACTIVE');
  });

  it('取消不补刀：沿用现有 cancelled 路径返回', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ bash: [PLAN_COMMAND] }]);
    const controller = new AbortController();
    controller.abort();

    const result = await driver.run(runInput(cwd, { signal: controller.signal }));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(1);
    expect(nudgeMessages(result.messages)).toHaveLength(0);
    // 同上：计划已激活，是取消拦住了补一刀
    expect(JSON.stringify(result.messages)).toContain('PLAN ACTIVE');
  });

  it('模型回合出错不补刀：沿用现有 errorMessage 路径返回', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ bash: [PLAN_COMMAND], errorMessage: 'upstream model error' }]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(1);
    expect(nudgeMessages(result.messages)).toHaveLength(0);
    expect(result.activatedPlan).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain('PLAN ACTIVE');
  });

  it('追问这一轮自己失败（网络/模型抖动）时不吞掉事实：仍上报 activatedPlan', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ bash: [PLAN_COMMAND] }, { throws: 'upstream unavailable' }]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(2);
    expect(nudgeMessages(result.messages)).toHaveLength(1);
    expect(result.execution).toBeUndefined();
    expect(result.activatedPlan).toEqual({ planId: 'plan_activated', version: 7 });
  });

  it('没有激活过计划就不补刀：零执行但没有"批准了没执行"这个事实', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([{ text: '这一轮没有提交任何方案。' }]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    expect(record.rounds).toBe(1);
    expect(nudgeMessages(result.messages)).toHaveLength(0);
    expect(result.activatedPlan).toBeUndefined();
  });
});
