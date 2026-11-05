/**
 * 错误态快路径 v2 的驱动侧（皮带）测试（2026-10-16 重做；第一版 2026-10-17 凌晨回退后重写）。
 *
 * 平台确定性终局码（TERMINAL_FAST_PATH_CODES）以"整份答案"收尾时，真实驱动的
 * shouldStopAfterTurn 早停必须：① 合成**非空**话术填进 result.text（第一版死因正是
 * 早停后 text 为空串，宿主空文本检查先于一切分支抛"未返回可用结果"，真模型探针 4/4
 * 全数触发——这条皮带就是为此而设）；② 挂 terminalFailure 结构化事实（"整份答案"判定
 * 单一事实源在驱动侧）；③ 只对单调用计划 + 本跳执行过生效——多调用计划一跳撞终局
 * 只是进行中的一步，照旧循环，行为零变化；④ 信封完整性门不挂时不快转（fail-loud 留痕）；
 * ⑤ 跳内多信封不快转——SDK 并行执行同一跳的全部 toolCall，worker 可以先拿到一条
 * completed 数据信封、收尾再撞一条终局信封，只数计划调用数会让收尾信封冒充整份答案、
 * 同跳已取得的 completed 数据被静默丢弃（e2e 镜像一轮一调用，结构上造不出这个形状）；
 * ⑥ 补刀两条出口（超时/异常腿与正常腿）的 terminalReply 话术必须到达——删掉出口全套
 * 测试仍绿的死形（空 text → executor_error 上屏）不得静默复活。
 *
 * 只替身 SDK 的 AgentSession（与 pi-coding-driver-execution.test.ts 同一手法）：假 agent
 * 的 continue() 在推完本跳 tool_result 后调用生产装配的 shouldStopAfterTurn（与 SDK
 * agent-loop 同一语义：命中即在 agent_end 前结束循环），其余全是生产代码——G1 计划门、
 * 计划 CLI 替身、gateCalls 计数、plannedCalls latch、话术合成都走 createPiCodingTurnDriver
 * 里的真路径。**替身不能只镜像 happy path**：早停的假绿正是第一版漏掉空 text 的原因。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver } from './src/pi-coding-driver';
import { createContextTaskRunner } from './src/context';
import type { ContextProfileConfig, PlatformTaskRecord, PlatformTaskRepo } from '@fshine/contracts';
import { ToolUserError, type DriverMessage, type TurnDriver, type TurnDriverInput } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';

/** 假 agent 的单个模型回合：要发起哪些 bash（可带各自的信封应答）、收尾文本、模型轮失败。 */
type FakeTurn = { bash?: Array<{ command: string; envelope: string }>; text?: string; errorMessage?: string };

const OK_ENVELOPE = 'RESULT {"v":1,"op":"probe.query","status":"completed","data":{"ok":true},"error":null}';
/** PERIOD_NO_DATA 信封（与 17dz mock respond.js receivables() 逐字段同形）。 */
const PERIOD_NO_DATA_ENVELOPE = 'RESULT {"v":1,"op":"finance.query-receivables","status":"not_found","data":{"query":"对象甲","accountSet":"对象甲","subject":{"code":"1122","name":"应收账款"},"period":"202609","availablePeriods":["202606"]},"error":{"code":"PERIOD_NO_DATA","message":"PERIOD_NO_DATA: 期间 202609 无余额数据（有数据的期间：202606）","correctForm":"该期间平台无数据，请确认期间编码或改查其他期间"}}';
/** AMBIGUOUS 信封的 mock 形状：只带 candidates，不带 data.customer（真脚本带）。 */
const AMBIGUOUS_MOCK_ENVELOPE = 'RESULT {"v":1,"op":"finance.query-receivables","status":"needs_input","data":{"query":"对象甲","candidates":[{"name":"幻电设备有限公司"},{"name":"机电贸易有限公司"}]},"error":{"code":"ASSISTANT_AMBIGUOUS","message":"ASSISTANT_AMBIGUOUS: 客户匹配到多个候选","correctForm":"把候选呈现给用户选择——绝不代选"}}';

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: Array<{ bash?: Array<{ command: string; envelope: string }>; text?: string; errorMessage?: string }>; rounds: number; messages: unknown[]; stopped: boolean };
  const records: SessionRecord[] = [];
  let script: Array<{ bash?: Array<{ command: string; envelope: string }>; text?: string; errorMessage?: string }> = [];
  return {
    records,
    setScript: (turns: typeof script) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, rounds: 0, messages: [], stopped: false };
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
        continue: async () => {
          const turn = record.turns[Math.min(record.rounds, record.turns.length - 1)];
          record.rounds += 1;
          if (!turn) return;
          const roundToolResults: unknown[] = [];
          let index = 0;
          for (const call of turn.bash ?? []) {
            index += 1;
            const callId = `call_${record.rounds}_${index}`;
            const ctx = {
              assistantMessage: {},
              toolCall: { id: callId, type: 'toolCall', name: 'bash', arguments: { command: call.command } },
              args: { command: call.command },
              context: {},
            };
            const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
            const message = {
              role: 'toolResult',
              toolCallId: callId,
              toolName: 'bash',
              content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : call.envelope }],
              isError: Boolean(verdict?.block),
              timestamp: Date.now(),
            };
            record.messages.push(message);
            roundToolResults.push(message);
          }
          // 与 SDK agent-loop 同一语义：每跳收尾时调用宿主装配的 shouldStopAfterTurn，
          // 命中即在 agent_end 之前结束循环（后续模型轮与收尾文本都不再发生）。
          const stop = await (agent.shouldStopAfterTurn as ((c: { toolResults: unknown[] }) => Promise<boolean> | boolean) | undefined)?.({ toolResults: roundToolResults });
          if (stop) record.stopped = true;
          // errorMessage 注入（与 pi-coding-driver-activation.test.ts:79 同一手法）放在早停
          // 判定**之后**：模型轮自身的失败落在 shouldStopAfterTurn 裁决之后，latch 与失败态
          // 可以同跳并存——那正是补刀异常出口（terminalReply 先于错误收尾）要走的形状。
          if (turn.errorMessage) state.errorMessage = turn.errorMessage;
          if (stop) return;
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

// 首条 bash：提交单调用方案（实体"对象甲/202609"都在 currentMessage 里 → 宿主放行并激活）。
const PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","对象甲","--period","202609"]}]}';
// 两调用方案（多调用计划的零变化用例）。
const TWO_CALL_PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"finance.query-receivables","args":["--query","对象甲","--period","202609"]},{"operation":"finance.query-receivables","args":["--query","对象甲","--period","202606"]}]}';
const QUERY_COMMAND = 'bin/17dz query query-receivables.js --query 对象甲 --period 202609';
const QUERY_COMMAND_OK = 'bin/17dz query query-receivables.js --query 对象甲 --period 202606';
const ENTITY_SOURCES = { currentMessage: '核对对象甲 202609 的应收余额' };

/** 计划 CLI 替身：本任务没有既有计划，提交即激活。 */
const activatingPlanRunner: PlanCliRunner = async ({ args }) => {
  if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_fastpath', planId: null, version: null, status: 'none' }), stderr: '' };
  if (args[1] === 'evaluate') return { code: 0, stdout: JSON.stringify({
    planId: 'plan_activated', version: 7, decision: 'execute', estimate: { calls: 1, seconds: 10, weight: 2 },
    delta: { addedCalls: 1 }, cumulative: {}, reasonCode: 'ok', status: 'active',
  }), stderr: '' };
  throw new Error(`unexpected CLI call: ${args.join(' ')}`);
};

async function makeDriver(): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-fastpath-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      gateway: 'bin/17dz',
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      operationLabels: new Map(),
      planCliRunner: activatingPlanRunner,
    }),
  };
}

function runInput(cwd: string): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '把本期要查的对象查一遍', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_fastpath',
    requestId: 'req_fastpath',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: Date.now() + 10_000,
    onNotice: async () => {},
    entitySources: ENTITY_SOURCES,
  };
}

describe('错误态快路径 v2：驱动早停与皮带（非空 text）', () => {
  it('单调用计划撞 PERIOD_NO_DATA：早停 + 合成非空话术 + terminalFailure 随行 + 执行痕迹照常', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      // 激活方案 → 真实查询撞终局信封 → 早停：第二跳（若有）与收尾文本都不再发生。
      { bash: [{ command: PLAN_COMMAND, envelope: OK_ENVELOPE }, { command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE }] },
      { text: '不应该到达：早停后不再有后续模型轮。' },
    ]);

    const result = await driver.run(runInput(cwd));

    // 皮带：text 是宿主模板渲染的非空话术，不是空串、不是 worker 文本（第一版死因钉死）。
    expect(result.text).toBe('没有查到“对象甲”在 202609 的数据。平台上有数据的是：202606。要改查的话，告诉我查哪一项即可。');
    // 结构化事实随行："整份答案"判定单一事实源在驱动侧。
    expect(result.terminalFailure).toEqual({
      code: 'PERIOD_NO_DATA',
      query: '对象甲',
      period: '202609',
      availablePeriods: ['202606'],
    });
    // 那一次平台调用真发生过：执行痕迹照常（与终局话术并列，不互相替代）。
    expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 1 });
    // 早停真的停了：只有一跳模型轮（没有重规划循环），替身记录 stop 命中。
    expect(fake.records.at(-1)?.rounds).toBe(1);
    expect(fake.records.at(-1)?.stopped).toBe(true);
  });

  it('多调用计划一跳撞终局：不早停，worker 照旧继续，行为零变化', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      // 两调用方案：第一跳 PERIOD_NO_DATA 只是进行中的一步，第二跳照常执行并成功。
      { bash: [{ command: TWO_CALL_PLAN_COMMAND, envelope: OK_ENVELOPE }, { command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE }, { command: QUERY_COMMAND_OK, envelope: OK_ENVELOPE }], text: '对象甲两期已查完。' },
    ]);
    // 实体门逐字包含判定：两期都在当前消息里，方案才放行（与生产同一把尺）。
    const result = await driver.run({ ...runInput(cwd), entitySources: { currentMessage: '核对对象甲 202609 与 202606 的应收余额' } });

    expect(result.terminalFailure).toBeUndefined();
    expect(result.text).toBe('对象甲两期已查完。');
    expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 2 });
    expect(fake.records.at(-1)?.stopped).toBe(false);
  });

  it('单调用计划同跳双信封（先 completed 数据、收尾撞终局）：不快转，数据不被收尾信封冒充', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { driver, cwd } = await makeDriver();
      fake.setScript([
        // SDK 并行执行同一跳的全部 toolCall（agent-loop.js：一条 assistant 消息的所有
        // toolCall 都执行、toolResults 一起交给 hook）：计划放行后两条 bash 同跳返回——
        // 先一条 completed 数据信封，收尾一条 PERIOD_NO_DATA 终局信封。收尾信封不是整份答案。
        { bash: [
          { command: PLAN_COMMAND, envelope: OK_ENVELOPE },
          { command: QUERY_COMMAND, envelope: OK_ENVELOPE },
          { command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE },
        ], text: '对象甲 202606 的余额已查到；202609 期间无数据，可改查 202606。' },
      ]);

      const result = await driver.run(runInput(cwd));

      // 跳内多信封 → "收尾信封 = 整份答案"前提不成立：宿主不合成话术、不早停（诊断留痕），
      // 回落既有循环由模型汇总——同跳已取得的 completed 数据不被静默丢弃。
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('terminal_fast_path_skip_multi_envelope'));
      expect(result.terminalFailure).toBeUndefined();
      expect(result.text).toBe('对象甲 202606 的余额已查到；202609 期间无数据，可改查 202606。');
      // 两次放行调用都真实发生并留痕：数据与终局状态都在执行足迹里，不由宿主拼装文本。
      expect(result.execution).toEqual({ planId: 'plan_activated', version: 7, calls: 2 });
      expect(fake.records.at(-1)?.stopped).toBe(false);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('信封完整性门：mock 形状的 AMBIGUOUS（缺 data.customer）不快转，fail-loud 留痕', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { driver, cwd } = await makeDriver();
      fake.setScript([
        { bash: [{ command: PLAN_COMMAND, envelope: OK_ENVELOPE }, { command: QUERY_COMMAND, envelope: AMBIGUOUS_MOCK_ENVELOPE }], text: '客户名匹配到多个候选。' },
      ]);

      const result = await driver.run(runInput(cwd));

      // 不快转：话术不由宿主合成，worker 文本照旧收尾（行为零变化）；契约漂移可发现。
      expect(result.terminalFailure).toBeUndefined();
      expect(result.text).toBe('客户名匹配到多个候选。');
      expect(fake.records.at(-1)?.stopped).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('terminal_fast_path_envelope_incomplete'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('整链（驱动 → 宿主）：单调用终局经 context 终局分支以同一段话术终结本轮', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [{ command: PLAN_COMMAND, envelope: OK_ENVELOPE }, { command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE }] },
    ]);
    const tasks = new (class implements PlatformTaskRepo {
      private readonly records = new Map<string, PlatformTaskRecord>();
      async get(taskId: string) { return this.records.get(taskId) ?? null; }
      async upsert(record: PlatformTaskRecord) { this.records.set(record.taskId, structuredClone(record)); }
      async listBySession() { return []; }
    })();
    const profiles: Record<string, ContextProfileConfig> = { '17dz': { root: cwd, skillRoots: [] } };
    const task = createContextTaskRunner({ profiles, tasks, workerDriver: driver });

    // 宿主终局分支（背带的常规位）：ToolUserError 语义 = 这段文本成为本轮回复。
    await expect(task.run({ request: '核对对象甲 202609 的应收余额' }, { trusted: { requestId: 'req_fastpath', principalId: 'wecom:u', sessionId: 's1' } }))
      .rejects.toThrow('没有查到“对象甲”在 202609 的数据。平台上有数据的是：202606。要改查的话，告诉我查哪一项即可。');
  });
});

describe('补刀出口的 terminalReply 话术（v1 空 text 死形防护）', () => {
  // 与上组第一条用例同一句宿主合成话术（renderTerminalFailureReply 的唯一来源）。
  const NUDGE_TERMINAL_TEXT = '没有查到“对象甲”在 202609 的数据。平台上有数据的是：202606。要改查的话，告诉我查哪一项即可。';
  const NUDGE_TERMINAL_FAILURE = {
    code: 'PERIOD_NO_DATA',
    query: '对象甲',
    period: '202609',
    availablePeriods: ['202606'],
  };

  it('正常腿：补刀那一跳撞终局早停，terminalReply 先于普通收尾交还话术', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      // 第一跳只提交计划（gateCalls=0，早停门关闭）→ 落到"计划已激活却零执行"的补刀；
      { bash: [{ command: PLAN_COMMAND, envelope: OK_ENVELOPE }] },
      // 第二跳（补刀轮）真实查询撞终局 → latch 在场，正常腿出口以宿主话术收尾。
      { bash: [{ command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE }] },
    ]);

    const result = await driver.run(runInput(cwd));

    const record = fake.records.at(-1)!;
    // 补刀真的发生了：rounds === 2（主回合 + 补刀那一轮）。
    expect(record.rounds).toBe(2);
    // 终局话术到达：非空、非"未返回可用结果"——早停后普通收尾的 lastAssistantText 是
    // 空串（v1 死形），这条出口必须用 latch 里的宿主话术替换它。
    expect(result.text).toBe(NUDGE_TERMINAL_TEXT);
    expect(result.terminalFailure).toEqual(NUDGE_TERMINAL_FAILURE);
    expect(record.stopped).toBe(true);
  });

  it('超时/异常腿：补刀那一跳模型失败，latch 已在场的终局话术仍先于错误收尾交还', async () => {
    const { driver, cwd } = await makeDriver();
    fake.setScript([
      { bash: [{ command: PLAN_COMMAND, envelope: OK_ENVELOPE }] },
      // 补刀轮的模型回合自身失败（errorMessage 注入，activation.test.ts:79 同一手法）：
      // 走超时/异常出口——terminalReply 必须先于该出口的兜底（closureText() ?? ''）。
      { bash: [{ command: QUERY_COMMAND, envelope: PERIOD_NO_DATA_ENVELOPE }], errorMessage: 'upstream model error' },
    ]);

    const result = await driver.run(runInput(cwd));

    expect(result.text).toBe(NUDGE_TERMINAL_TEXT);
    expect(result.terminalFailure).toEqual(NUDGE_TERMINAL_FAILURE);
    expect(fake.records.at(-1)?.stopped).toBe(true);
  });
});
