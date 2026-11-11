// [L4 集成] fshine + 配置派生的网关一起才能跑的集成测试（见 docs/e2e-ownership.md）。
// 前置：兄弟仓 + config/agent.yaml + 财税 mock，脚本化驱动，不碰真平台。
// 本用例的证据不得冒充通用证据；通用闭环只认 typecheck + unit + generic-mock。
/**
 * 离线全链 e2e：一次委派回合产生的进度帧（D1）。共享替身见 ./harness.ts。
 *
 * 背景：harness 以前只把消息喂给渠道适配器，从不校验 handler 收到的 progress——
 * 生产企微 adapter 是传的（channel-wecom adapter.ts 的 dispatchMessage），帧级行为
 * 因此完全没有离线覆盖。这里把采集点补在 handler 入口（见 harness.ts 的 Turn）。
 *
 * 链路保真度：真 SQLite、真 assembly、真 ContextTaskRunner/runtime、真 G1 工具门与
 * 计划门；假的只有两处——pi-coding-agent 的 AgentSession（脚本化假 agent 回放每轮
 * 发起哪些 bash）与平台计划 CLI 的应答（提交即激活的 execute 档）。帧的文本由生产
 * 渲染层合成（operationStepText + 平台清单第 5 列派生的 label 表），测试不写死措辞。
 *
 * 守四件事：
 *   ⓪ 受理帧先行（首帧提速，2026-10-16）：每个启回合的消息，handler 在进 runtime 之前
 *      经 progress 通道发一帧宿主回执（TURN_ACCEPTED_TEXT，文案纪律：ack=已收达、
 *      受理帧=已开跑，两帧语义递进）——它排在一切 runtime 帧之前，且每回合恰一帧。
 *      文案与发射点在 apps/server/handler.ts，这里按同一常量断言，不另抄一份措辞。
 *   ① 委派回合真的产出 `正在…` 形态的用户可见帧（不是内部事件名）；
 *   ② 内部事件名（SDK 会话事件的 worker_ 前缀形态）不出厂；
 *   ③ 连续重复帧被压制：worker 连发两次相同调用只外发一帧——生产企微 progress 只有
 *      4 帧硬顶，重复帧会挤占真实进度帧的预算（真实平台战斗测试实测的 churn）。
 *      受理帧在渠道侧豁免硬顶（adapter 用例钉），真实帧的 4 帧预算不因此缩水。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TURN_ACCEPTED_TEXT } from '../../apps/server/handler';
import type { PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { createPiCodingTurnDriver, PLAN_SUBMIT_STEP } from '../../packages/agent/src/pi-coding-driver';
import { boot, GATEWAY, mainDriver, type Turn } from './harness';

/** 假 agent 的单个模型回合：要发起哪些 bash、收尾文本。 */
type FakeTurn = { bash?: string[]; text?: string };

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; rounds: number; messages: unknown[] };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [] };
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
          record.rounds += 1;
          const turn = record.turns[Math.min(record.rounds - 1, record.turns.length - 1)];
          if (!turn) return;
          let index = 0;
          for (const command of turn.bash ?? []) {
            index += 1;
            const ctx = {
              assistantMessage: {},
              toolCall: { id: `call_${record.rounds}_${index}`, type: 'toolCall', name: 'bash', arguments: { command } },
              args: { command },
              context: {},
            };
            // 走生产接线：G1 计划门 + serve gate（放行/拦截都留痕，放行才计 gateCalls）
            const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
            record.messages.push({
              role: 'toolResult',
              toolCallId: ctx.toolCall.id,
              toolName: 'bash',
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : 'RESULT {"v":1,"op":"finance.query-receivables","status":"completed","data":{"ok":true},"error":null}' }],
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

const agentDirs: string[] = [];
afterEach(() => { for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 首条 bash：提交 JSON calls 方案（实体都在用户消息里，逐字包含判定放行）。 */
const PLAN_COMMAND = `${GATEWAY} plan {"calls":[{"operation":"finance.query-receivables","args":["--query","幻辰财税","--period","202606"]}]}`;
/** 真实平台查询：计划已激活 → G1 放行 → 按 label 表出帧。 */
const QUERY_COMMAND = `${GATEWAY} query query-receivables.js --query 幻辰财税 --period 202606`;
/** 换一个期间的同类查询：帧文本不同，用来在两条相同帧之间"插一件事"。 */
const QUERY_COMMAND_2 = `${GATEWAY} query query-receivables.js --query 幻辰财税 --period 202607`;

/** label 表直接注入（平台清单第 5 列的替身）：单测里绝不 spawn 平台 CLI 派生。 */
const OPERATION_LABELS = new Map([['query-receivables', '读取余额']]);
const QUERY_STEP = '正在读取余额「幻辰财税」·202606…';
const QUERY_STEP_2 = '正在读取余额「幻辰财税」·202607…';

/** 计划 CLI 替身：本任务没有既有计划，提交即激活（execute 档，无需通知/确认）。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_frames', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_frames', version: 3, decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 2 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

/** 真 driver（只替身 SDK 会话与计划 CLI）：帧的合成走生产代码。 */
function workerDriver() {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-frames-'));
  agentDirs.push(agentDir);
  return createPiCodingTurnDriver({
    env: process.env,
    agentDir,
    operationLabels: OPERATION_LABELS,
    planCliRunner: activatingPlanRunner,
    // C7b 起派生 loader 对未声明 gateway 降级空表（不回退实例名缺省）：命令前缀与
    // 这里的声明都取 harness 的 GATEWAY（活跃 profile），不在 e2e 里另写实例名。
    // args 样式表仍从兄弟仓 CLI 真派生（不替身）。
    gateway: GATEWAY,
  });
}

/** 一次委派回合：主 Agent 申报 delegate，worker 按脚本回放 bash。 */
async function delegatedTurn(turns: FakeTurn[]): Promise<Turn> {
  fake.setScript(turns);
  const booted = await boot({
    main: mainDriver([{ kind: 'delegate', request: '查询幻辰财税账套 202606 的应收账款余额' }]),
    worker: workerDriver(),
  });
  const turn = await booted.turn('查一下幻辰财税 202606 的应收账款余额');
  // 真 driver 真的跑了一个 worker 会话（替身只替换 SDK 会话与计划 CLI 应答）
  expect(fake.records.length).toBeGreaterThan(0);
  return turn;
}

describe('[L4 集成] 离线全链 e2e：委派回合的进度帧', () => {
  it('⓪①② 受理帧先行，委派回合产出「正在…」形态的用户可见帧，内部事件名不出厂', async () => {
    const turn = await delegatedTurn([
      { bash: [PLAN_COMMAND, QUERY_COMMAND], text: '幻辰财税 202606 应收账款余额为 61000 元。' },
    ]);

    // ⓪ 受理帧是本回合第一帧、恰一帧（宿主回执，先于一切 runtime 帧）
    expect(turn.steps[0]).toBe(TURN_ACCEPTED_TEXT);
    expect(turn.steps.filter((step) => step === TURN_ACCEPTED_TEXT)).toHaveLength(1);
    // ① 帧的形状是生产模板 operationStepText：正在${label}${参数摘要}…
    // （受理帧之后的其余帧全是 runtime 帧受理这个判据）
    const runtimeSteps = turn.steps.slice(1);
    expect(runtimeSteps).toContain(QUERY_STEP);
    expect(runtimeSteps.every((step) => /^正在.+…$/.test(step))).toBe(true);
    // ② 内部事件名（SDK 会话事件 / 计划协议状态）不出厂：用户只看得到人类可读短语
    for (const step of turn.steps) {
      expect(step).not.toContain('worker_');
      expect(step).not.toMatch(/tool_execution_start|agent_start|agent_end|PLAN (ACTIVE|DECLINED|STOP)/);
      expect(step).not.toContain('query-receivables.js');
    }
    // 回复本身不带帧文本的重复堆叠：帧走流式通道，finish 帧只给结论
    expect(turn.text).toContain('61000 元');
    expect(turn.text).not.toContain('正在读取余额');
    expect(turn.text).not.toContain(TURN_ACCEPTED_TEXT);
    // 单次调用的轻量委派不走计划通知门（通知帧由计划门的用例覆盖）
    expect(turn.notices).toEqual([]);
  });

  it('③ 连续重复帧被压制：连发两次相同调用只外发一帧', async () => {
    const turn = await delegatedTurn([
      // worker 重提同一方案两次 + 对同一对象连发两次相同查询：四种发射各只有一条唯一文本
      { bash: [PLAN_COMMAND, PLAN_COMMAND, QUERY_COMMAND, QUERY_COMMAND], text: '幻辰财税 202606 应收账款余额为 61000 元。' },
    ]);

    // 提交帧两次 → 一帧；查询帧两次 → 一帧。受理帧在前、恰一帧；真实进度帧的预算
    // （企微 4 帧硬顶，渠道侧对受理帧豁免）不被 churn 挤占
    expect(turn.steps).toEqual([TURN_ACCEPTED_TEXT, PLAN_SUBMIT_STEP, QUERY_STEP]);
  });

  it('③ 补：中间插过别的帧后相同文本放行（连续去重不是永久去重）', async () => {
    const turn = await delegatedTurn([
      { bash: [PLAN_COMMAND, PLAN_COMMAND, QUERY_COMMAND, QUERY_COMMAND_2, PLAN_COMMAND, QUERY_COMMAND], text: '幻辰财税两个期间都查完了。' },
    ]);

    // 最后一次查询与第一次文本相同，但中间插过别的帧——那是合法的新动作，必须放行
    expect(turn.steps).toEqual([TURN_ACCEPTED_TEXT, PLAN_SUBMIT_STEP, QUERY_STEP, QUERY_STEP_2, PLAN_SUBMIT_STEP, QUERY_STEP]);
  });
});
