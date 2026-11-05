/**
 * D-075 写关闭 disclosure：宿主计划扫描 + 终稿合成（第 1 层机械兜底的 driver 级验证）。
 *
 * 2026-09-29 真实平台 T7 事故形态：用户发起录入请求，模型走了完整的"录入准备"流程
 * （核实范围/日期/科目/平衡，行为优秀），然后停在准备阶段、承诺"即可产出录入提案"，
 * 永不抵达提案步。写关闭话术原先只挂在提案路径的 capability 检查与平台计划门拒绝上——
 * 模型不走到那儿，用户就永远不知道写权限是关闭的。
 *
 * 这里守四件事：
 *   1. 计划里出现要用户确认的 operation（平台语义表 confirm=true）而平台声明写未开放：宿主在
 *      **计划评估前**拦截（平台计划门 CLI 一次都没被调用），拦截理由复用 error-codes.ts
 *      的 WRITE_NOT_ENABLED 唯一来源；
 *   2. 终稿由宿主合成的话术整体替换——worker 的准备/承诺文本没有成为用户回复
 *      （T7 形态的机械版：不依赖模型自觉披露）；
 *   3. 写开放部署（平台声明 writeEnabled=true）：同一份计划照常提交平台评估，行为零变化；
 *   4. worker 转录原样保留（审计轨迹完整），替换只发生在结果文本上。
 *
 * 只替身 SDK 的 AgentSession：模型回合由脚本化的假 agent 回放（每轮发起哪些 bash），
 * 其余全是生产代码——beforeToolCall 的计划解析、写关闭扫描、planFacts/execution 合成
 * 都走 createPiCodingTurnDriver 里的真路径。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiCodingTurnDriver } from './src/pi-coding-driver';
import { messageTextFor } from './src/error-codes';
import type { DriverMessage, TurnDriver, TurnDriverInput } from './src/driver';
import type { PlanCliRunner } from './src/plan-runtime';

/** 假 agent 的单个模型回合：要发起哪些 bash、收尾文本。 */
type FakeTurn = { bash?: string[]; text?: string };

const fake = vi.hoisted(() => {
  type SessionRecord = { turns: FakeTurn[]; cursor: number; messages: unknown[] };
  const records: SessionRecord[] = [];
  let script: FakeTurn[] = [];
  return {
    records,
    setScript: (turns: FakeTurn[]) => { script = turns; },
    makeSession: () => {
      const record: SessionRecord = { turns: script, cursor: 0, messages: [] };
      records.push(record);
      const state: { errorMessage?: string; messages: unknown[] } = {
        errorMessage: undefined,
        get messages() { return record.messages; },
        set messages(next: unknown[]) { record.messages = next; },
      };
      const agent = {
        state,
        beforeToolCall: undefined as unknown,
        abort: () => {},
        // 与真实 SDK 的语义对齐：一次 continue() = 一个完整 agent 轮——若干工具轮
        // （bash 走生产接线 beforeToolCall）+ 一个收尾文本；跨 continue() 用 cursor 续跑。
        continue: async () => {
          for (;;) {
            const turn = record.turns[record.cursor];
            if (!turn) return;
            if (turn.text !== undefined) {
              record.cursor += 1;
              record.messages.push({ role: 'assistant', content: [{ type: 'text', text: turn.text }], stopReason: 'stop', timestamp: Date.now() });
              return;
            }
            record.cursor += 1;
            let index = 0;
            for (const command of turn.bash ?? []) {
              index += 1;
              const callId = `call_${record.cursor}_${index}`;
              const ctx = {
                assistantMessage: {},
                toolCall: { id: callId, type: 'toolCall', name: 'bash', arguments: { command } },
                args: { command },
                context: {},
              };
              // 走生产接线：G1 计划门 + serve gate（放行/拦截都留痕）
              const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>)(ctx);
              record.messages.push({
                role: 'toolResult',
                toolCallId: callId,
                toolName: 'bash',
                content: [{ type: 'text', text: verdict?.block ? (verdict.reason ?? '') : 'OK' }],
                isError: Boolean(verdict?.block),
                timestamp: Date.now(),
              });
            }
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

/** 平台 `operation list --json` 的语义表同形替身（read / scratch / write 三列由平台声明）。 */
const SEMANTICS_TABLE = new Map<string, { plan: boolean; confirm: boolean; mock: boolean }>([
  ['query-saved', { plan: true, confirm: false, mock: true }],
  ['voucher.query-saved', { plan: true, confirm: false, mock: true }],
  ['precheck', { plan: false, confirm: false, mock: false }],
  ['voucher.precheck', { plan: false, confirm: false, mock: false }],
  ['prepare', { plan: true, confirm: true, mock: true }],
  ['voucher.prepare', { plan: true, confirm: true, mock: true }],
  ['commit', { plan: true, confirm: true, mock: true }],
  ['voucher.commit', { plan: true, confirm: true, mock: true }],
]);

/** T7 形态的 worker 脚本：准备流程（只读摸底）+ 含写类 operation 的计划 + 停在准备阶段的承诺。 */
const WRITE_PLAN_COMMAND = 'bin/17dz plan {"calls":[{"operation":"voucher.query-saved","args":["A","202609"]},{"operation":"voucher.prepare","args":["A","202609"]}]}';
const T7_PROMISE = '已核实账套、日期与贷方科目，借贷平衡，即可产出录入提案。';

async function makeDriver(options: { planCliRunner: PlanCliRunner }): Promise<{ driver: TurnDriver; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fshine-pi-write-closure-'));
  roots.push(cwd);
  return {
    cwd,
    driver: createPiCodingTurnDriver({
      env: { LLM_API_BASE_URL: 'http://127.0.0.1:9', LLM_API_KEY: 'test-key', LLM_MODEL: 'worker-test' },
      agentDir: path.join(cwd, '.fshine-agent'),
      // 三张平台清单派生表全部显式注入：单测里绝不 spawn 平台 CLI
      operationLabels: new Map(),
      operationArgStyles: new Map(),
      operationArgSpecs: new Map(),
      operationSemantics: SEMANTICS_TABLE,
      planCliRunner: options.planCliRunner,
    }),
  };
}

function runInput(cwd: string, writeEnabled: boolean): TurnDriverInput {
  return {
    systemPrompt: 'worker system prompt',
    tools: [],
    messages: [{ role: 'user', content: '帮我录入一笔办公费凭证', timestamp: 1 } as unknown as DriverMessage],
    cwd,
    skillRoots: [],
    sessionId: 'task_write_closure',
    requestId: 'req_write_closure',
    onStep: () => {},
    exec: async () => { throw new Error('worker 只能使用其工作目录内配置的原生工具'); },
    deadline: Date.now() + 10_000,
    onNotice: async () => {},
    writeEnabled,
  };
}

describe('D-075 写关闭：计划扫描 + 终稿合成', () => {
  it('写关闭部署：宿主在计划评估前拦截，终稿是合成的写关闭话术而非 worker 的准备承诺', async () => {
    const cliCalls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      cliCalls.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_closure', planId: null, version: null, status: 'none' }), stderr: '' };
      // 扫描拦在 evaluate 之前：这一行被触达即说明拦截点错了位置
      throw new Error('写关闭拦截后不得调用平台计划门 evaluate');
    };
    const { driver, cwd } = await makeDriver({ planCliRunner });
    fake.setScript([
      { bash: [WRITE_PLAN_COMMAND] },
      { text: T7_PROMISE },
    ]);

    const result = await driver.run(runInput(cwd, false));

    // 终稿 = error-codes.ts 的 WRITE_NOT_ENABLED 唯一来源（一字不差，不新写措辞）
    expect(result.text).toBe(messageTextFor('WRITE_NOT_ENABLED'));
    // 终稿标记随结果上交：宿主据此把这段确定性话术直接作为本轮回复
    expect(result.writeClosed).toBe(true);
    // T7 形态的机械版：worker 的"准备/承诺"文本没有成为终稿
    expect(result.text).not.toContain('即可产出录入提案');
    // 零平台调用：evaluate 从未发生（会话创建时的 plan current 除外）
    expect(cliCalls.filter((args) => args[1] === 'evaluate')).toEqual([]);
    expect(result.execution).toBeUndefined();
    // worker 转录原样保留：审计轨迹完整，替换只发生在结果文本上
    expect(JSON.stringify(result.messages)).toContain(T7_PROMISE);
  });

  it('写开放部署（平台声明 writeEnabled=true）：同一份计划照常提交平台评估并激活，行为零变化', async () => {
    const cliCalls: string[][] = [];
    const planCliRunner: PlanCliRunner = async ({ args }) => {
      cliCalls.push(args);
      if (args[1] === 'current') return { code: 0, stdout: JSON.stringify({ taskId: 'task_write_closure', planId: null, version: null, status: 'none' }), stderr: '' };
      return { code: 0, stdout: JSON.stringify({
        taskId: 'task_write_closure', planId: 'plan_open', version: 1, decision: 'execute',
        estimate: { calls: 2, seconds: 20, weight: 2 }, delta: { addedCalls: 2 }, cumulative: {}, reasonCode: 'ok', status: 'active',
      }), stderr: '' };
    };
    const { driver, cwd } = await makeDriver({ planCliRunner });
    fake.setScript([
      { bash: [WRITE_PLAN_COMMAND] },
      { text: '已按方案执行。' },
    ]);

    const result = await driver.run(runInput(cwd, true));

    expect(cliCalls.filter((args) => args[1] === 'evaluate')).toHaveLength(1);
    expect(result.text).toBe('已按方案执行。');
    expect(result.writeClosed).toBeUndefined();
  });
});
