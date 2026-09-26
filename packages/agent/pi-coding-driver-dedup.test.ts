/**
 * Worker 回合内连续重复的进度帧与计划通知去重（2026-09-26 真实平台战斗测试实测）。
 *
 * 实测形态：worker 在真实调用之后继续重提执行方案（beforeToolCall 里 activePlan 置空再
 * evaluateAndActivatePlan，后续提交可能 scope 识别失败被拒），每次重提都触发一帧
 * PLAN_SUBMIT_STEP 与一条平台计划通知——单回合 5-6 帧重复、两条一模一样的通知。
 * 生产企微侧 progress 有 4 帧硬顶，重复帧挤占真实进度帧的预算；重复通知是纯用户噪音。
 *
 * 这里守四件事：
 *   1. 帧去重：同一回合连发两次相同文本的帧（PLAN_SUBMIT_STEP / 相同 label 的调用帧）
 *      只外发一次；
 *   2. 帧去重只压**连续**重复：中间插过别的帧之后，相同文本再次出现要放行——那说明
 *      worker 又干了别的事，重复文本是合法的新动作，不是 churn；
 *   3. 通知去重：同一回合内两次相同文本的通知只送达一次，不同文本都送达；
 *   4. 两个记忆都是 run() 局部的：新回合（新 run）相同帧/相同通知重新放行——跨回合用户
 *      有机会做确认操作，计划门通知不能因上一个回合送达过同样文本就被吞掉。
 *
 * 只替身 SDK 的 AgentSession：模型回合由脚本化的假 agent 回放（每轮发起哪些 bash），其余
 * 全是生产代码——G1 工具门、计划 CLI 替身、gateCalls 计数、帧/通知的合成都走
 * createPiCodingTurnDriver 里的真路径（含 createServeGateAuditSink 这条生产接线）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver, PLAN_SUBMIT_STEP } from './src/pi-coding-driver';
import { PLAN_NOTICE_PREFIX } from './src/plan-runtime';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';

/** 假 agent 的单个模型回合：要发起哪些 bash、收尾文本。 */
type FakeTurn = { bash?: string[]; text?: string };

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; rounds: number; messages: unknown[]; continues: number };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [], continues: 0 };
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
        abort: () => {},
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
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : 'RESULT {"v":1,"op":"probe.query","status":"completed","data":{"ok":true},"error":null}' }],
              isError: Boolean(verdict?.block),
              timestamp: Date.now(),
            });
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

// 提交即激活的方案（execute 档，不走通知/确认门）——用于帧去重用例。
const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"probe.query","args":["--query","某公司","--period","202609"]}]}';
// 真实平台查询（计划已激活 → G1 放行，按 label 表出帧）。
const QUERY_COMMAND = 'bin/17dz query probe-query.js --query 某公司 --period 202609';
// 参数不同的同类查询：帧文本不同，用来在两条相同帧之间"插一件事"。
const QUERY_COMMAND_2 = 'bin/17dz query probe-query.js --query 某公司 --period 202610';

/** label 表直接注入：单测里绝不 spawn 平台 CLI 派生能力清单（P0 的 label 数据驱动不变）。 */
const OPERATION_LABELS = new Map([['probe-query', '读取余额']]);
const QUERY_STEP = '正在读取余额「某公司」·202609…';
const QUERY_STEP_2 = '正在读取余额「某公司」·202610…';

/** 计划 CLI 替身：本任务没有既有计划，提交即激活（execute 档，无需通知/确认）。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_dedup', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_activated', version: 7, decision: 'execute', estimate: { calls: 1, seconds: 10 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/** 计划 CLI 替身：提交即停在用户确认门（confirm 档）——每次评估返回同一份裁决。 */
const confirmingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_dedup', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600 },
    delta: { addedCalls: 30 }, cumulative: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/** 计划 CLI 替身：每次评估给出不同 noticeText——通知文本不同的来源（不是 churn）。 */
function varyingNoticeRunner(): PlanCliRunner {
  let batch = 0;
  return async ({ args }) => {
    if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_dedup', planId: null, version: null, status: 'none' }), stderr: '' };
    if (args[1] === 'evaluate') {
      batch += 1;
      return { code: 0, stdout: JSON.stringify({
        planId: 'plan_confirm', version: 3, decision: 'confirm', estimate: { calls: 30, seconds: 600 },
        delta: { addedCalls: batch }, cumulative: {}, reasonCode: 'CONFIRM_THRESHOLD', status: 'confirming',
        noticeText: `第 ${batch} 批查询`,
      }), stderr: '' };
    }
    throw new Error(`unexpected CLI call: ${args.join(' ')}`);
  };
}

async function makeDriver(planCliRunner: PlanCliRunner = activatingPlanRunner): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-dedup-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: OPERATION_LABELS,
      planCliRunner,
    }),
  };
}

/** 每回合一份新 input：宿主侧收集这一步真正看到的帧与通知。 */
function runInput(cwd: string, seen: { steps: string[]; notices: string[] }): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '把本期要查的对象查一遍', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_dedup',
    requestId: 'req_dedup',
    onStep: (text) => { seen.steps.push(text); },
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: Date.now() + 10_000,
    onNotice: async (text) => { seen.notices.push(text); },
  };
}

describe('进度帧去重：只压连续重复，不压合法重复动作', () => {
  it('同一回合连发两次相同帧只外发一次（PLAN_SUBMIT_STEP 与相同 label 的调用帧）', async () => {
    const { driver, cwd } = await makeDriver();
    // worker 重提同一方案两次 + 对同一对象连发两次相同查询：四种发射各只有一条唯一文本
    fake.setScript([
      { bash: [PLAN_COMMAND, PLAN_COMMAND, QUERY_COMMAND, QUERY_COMMAND], text: '对象已查到。' },
    ]);

    const seen = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, seen));

    // 提交帧两次 → 一帧；查询帧两次 → 一帧。真实进度帧的预算（企微 4 帧硬顶）不被 churn 挤占
    expect(seen.steps).toEqual([PLAN_SUBMIT_STEP, QUERY_STEP]);
  });

  it('中间插过别的帧后相同文本放行：连续去重不是永久去重', async () => {
    const { driver, cwd } = await makeDriver();
    // 重提方案（重复帧被压）→ 真实查询 → 参数不同的同类查询 → 又重提方案 → 再查同一对象。
    // 最后一次查询与第一次文本相同，但中间插过别的帧——那是合法的新动作，必须放行。
    fake.setScript([
      { bash: [PLAN_COMMAND, PLAN_COMMAND, QUERY_COMMAND, QUERY_COMMAND_2, PLAN_COMMAND, QUERY_COMMAND], text: '对象已查到。' },
    ]);

    const seen = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, seen));

    expect(seen.steps).toEqual([PLAN_SUBMIT_STEP, QUERY_STEP, QUERY_STEP_2, PLAN_SUBMIT_STEP, QUERY_STEP]);
  });
});

describe('计划通知去重：同一回合的重复通知是 churn，跨回合必须重新送达', () => {
  it('同一回合两次相同通知文本只送达一次', async () => {
    const { driver, cwd } = await makeDriver(confirmingPlanRunner);
    // worker 连提两次同一方案：平台两次都停在确认门，通知文本逐字相同
    fake.setScript([{ bash: [PLAN_COMMAND, PLAN_COMMAND], text: '等待用户确认。' }]);

    const seen = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, seen));

    // 同一 worker 回合内用户无法做确认操作：连续相同文本的通知只可能是重提同一方案的 churn
    expect(seen.notices).toHaveLength(1);
    expect(seen.notices[0]?.startsWith(PLAN_NOTICE_PREFIX)).toBe(true);
  });

  it('不同文本的通知都送达：去重只认逐字相同', async () => {
    const { driver, cwd } = await makeDriver(varyingNoticeRunner());
    fake.setScript([{ bash: [PLAN_COMMAND, PLAN_COMMAND], text: '等待用户确认。' }]);

    const seen = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, seen));

    expect(seen.notices).toHaveLength(2);
    expect(new Set(seen.notices).size).toBe(2);
    for (const notice of seen.notices) expect(notice.startsWith(PLAN_NOTICE_PREFIX)).toBe(true);
  });

  it('两个记忆都是 run 局部的：新回合相同帧/相同通知重新放行', async () => {
    const { driver, cwd } = await makeDriver(confirmingPlanRunner);
    // 同一 driver 连续两个回合提交同一方案：第二个回合用户仍有机会确认，
    // 帧和通知都不能因为上一个回合出现过就被吞掉。
    fake.setScript([{ bash: [PLAN_COMMAND] }]);
    const first = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, first));

    fake.setScript([{ bash: [PLAN_COMMAND] }]);
    const second = { steps: [] as string[], notices: [] as string[] };
    await driver.run(runInput(cwd, second));

    expect(first.steps).toEqual([PLAN_SUBMIT_STEP]);
    expect(second.steps).toEqual([PLAN_SUBMIT_STEP]);
    expect(first.notices).toHaveLength(1);
    expect(second.notices).toHaveLength(1);
    expect(second.notices[0]).toBe(first.notices[0]);
  });
});
