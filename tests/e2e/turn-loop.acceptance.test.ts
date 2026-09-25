/**
 * 离线全链 e2e：把消息直接灌进生产装配，断言用户最终会收到什么。
 *
 * 与手工企微测试的差别只有两处是假的：
 *   - 模型（Main Agent 与 17dz 子 Agent 都用脚本化驱动回放）
 *   - 平台执行器（DZ_EXECUTOR=mock 的应答器，不开浏览器不触网）
 * 其余全是生产代码：企微适配器的 stream/节流/notice 语义、createMessageHandler、
 * createTaxAgentRuntime 的回合契约与出口校验、ContextTaskRunner、计划门禁，
 * 以及真 spawn 的 bin/17dz（plan evaluate/activate/status、累计账本、HMAC、逐次参数绑定）。
 *
 * 子 Agent 替身不复刻模型行为，但复刻它的门禁行为：提交计划走真实的
 * evaluateAndActivatePlan，执行走真实的 operation run + DZ_PLAN_ID 绑定。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SdkClientLike } from '@fshine/channel-wecom';
import { evaluateAndActivatePlan, loadCurrentActivePlan, type PlanCall, type PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { createServerAssembly, type ServerAssembly } from '../../apps/server/assembly';

const PLATFORM_ROOT = process.env['DZ_PLATFORM_ROOT'] ?? path.resolve(__dirname, '..', '..', '..', '17dz-platform');
const CLI = path.join(PLATFORM_ROOT, 'bin', '17dz');

let stateDir: string;
let savedEnv: NodeJS.ProcessEnv;
let counter = 0;

/** 平台侧持久化状态：每个用例独一份，避免账本/限流桶跨用例串味。 */
const PLATFORM_STATE_KEYS = ['DZ_PLAN_STATE', 'DZ_RATE_LIMIT_STATE', 'DZ_MOCK_STATE', 'DZ_AUDIT_PATH'] as const;
let platformStateBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  platformStateBackup = Object.fromEntries(PLATFORM_STATE_KEYS.map((key) => [key, process.env[key]]));
  counter += 1;
  Object.assign(process.env, {
    DZ_PLAN_STATE: path.join(stateDir, `plans-${counter}.json`),
    DZ_RATE_LIMIT_STATE: path.join(stateDir, `rate-${counter}.json`),
    DZ_MOCK_STATE: path.join(stateDir, `mock-${counter}.json`),
    DZ_AUDIT_PATH: path.join(stateDir, `audit-${counter}.jsonl`),
  });
});

afterEach(() => {
  for (const key of PLATFORM_STATE_KEYS) {
    const value = platformStateBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`缺少平台 CLI: ${CLI}（设置 DZ_PLATFORM_ROOT 指向 17dz-platform）`);
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-turn-loop-'));
  savedEnv = { ...process.env };
  Object.assign(process.env, {
    DZ_SERVE: '1',
    DZ_EXECUTOR: 'mock',
    DZ_MOCK_STATE: path.join(stateDir, 'mock-state.json'),
    DZ_PLAN_STATE: path.join(stateDir, 'plans.json'),
    DZ_RATE_LIMIT_STATE: path.join(stateDir, 'rate-limit.json'),
    DZ_AUDIT_PATH: path.join(stateDir, 'invocations.jsonl'),
    DZ_REQUIRE_PLAN: '1',
    DZ_PLAN_ACTIVATION_SECRET: 'turn-loop-test-secret',
    DZ_PLAN_AUTO_CALLS: '2',
    DZ_PLAN_NOTIFY_CALLS: '10',
    DZ_PLAN_CONFIRM_CALLS: '20',
    DZ_PLAN_HARD_CALLS: '50',
    DZ_PLAN_MAX_NOTIFY: '2',
    DZ_PLAN_MAX_REPLANS: '6',
    // 网关限流有 17dz 自己的专项测试；这里放宽 burst，避免 9 期查询被限流挡住，
    // 从而测不到"通知先于执行"这条主线。
    DZ_RATE_LIMIT: JSON.stringify({ read: { burst: 60, perMs: 0 }, global: { burst: 120, perMs: 0 } }),
    // 离线环境不发真实模型请求；脚本化驱动覆盖了 Main Agent 与子 Agent。
    LLM_API_BASE_URL: 'http://127.0.0.1:9',
    LLM_API_KEY: 'unused-in-offline-harness',
    LLM_MODEL: 'unused',
  });
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(stateDir, { recursive: true, force: true });
});

// ── 企微替身 ────────────────────────────────────────────────────────────

class RecordingSdkClient implements SdkClientLike {
  readonly frames: Array<{ content: string; finish: boolean }> = [];
  /** 命中该子串的计划通知投递失败，用来验证"通知不到就不放行"。 */
  failNotice: string | null = null;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
    return this;
  }
  connect(): unknown { return this; }
  disconnect(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  async replyStream(_frame: unknown, _streamId: string, content: string, finish: boolean): Promise<unknown> {
    this.frames.push({ content, finish });
    if (content.startsWith('计划通知：') && this.failNotice !== null && content.includes(this.failNotice)) {
      throw new Error('notice delivery failed');
    }
    return {};
  }
  async uploadMedia(): Promise<{ media_id: string }> { return { media_id: 'unused' }; }
  async replyMedia(): Promise<unknown> { return {}; }

  finalText(): string {
    return this.frames.filter((frame) => frame.finish).at(-1)?.content ?? '';
  }
  /** 计划通知是非 finish 帧；最终回复也是 finish 帧，不能混为一谈。 */
  noticeTexts(): string[] {
    return this.frames.filter((frame) => !frame.finish && frame.content.startsWith('计划通知：')).map((frame) => frame.content);
  }
}

// ── 模型替身 ────────────────────────────────────────────────────────────

/** Main Agent：按脚本申报本轮动作；宿主给出的文本经 terminate 成为最终回复。 */
function mainDriver(declarations: Array<Record<string, unknown>>, observe?: (input: { messages: unknown[] }) => void) {
  let cursor = 0;
  return {
    run: async (input: {
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      // 宿主续跑路径不带工具：Main Agent 只整理已完成的执行结果，不再申报
      if (input.tools.length === 0) {
        observe?.(input);
        return { text: '已按你确认的范围整理完成。', messages: input.messages };
      }
      const declaration = declarations[Math.min(cursor, declarations.length - 1)]!;
      cursor += 1;
      try {
        await input.exec('route_current_turn', declaration);
      } catch (error) {
        return { text: (error as Error).message, messages: input.messages };
      }
      return { text: '主 Agent 自由文本：不应外发', messages: input.messages };
    },
  };
}

/** 完全不申报的 Main Agent，用来验证跳过重试与失败关闭。 */
function silentDriver() {
  return {
    run: async (input: { messages: unknown[] }) => ({
      text: '直接回答：应收余额 42 元。',
      messages: [...input.messages, { role: 'assistant', content: '直接回答：应收余额 42 元。', timestamp: Date.now() }],
    }),
  };
}

type WorkerStep =
  | { plan: PlanCall[]; stopAtConfirm?: boolean }
  | { execute: PlanCall[] }
  | { text: string };

/**
 * 17dz 子 Agent 替身：提交计划走真实 evaluateAndActivatePlan（真 CLI、真账本、真 HMAC），
 * 计划激活后按 calls 真跑 operation run（mock executor、真 DZ_PLAN_ID 绑定）。
 */
function gatedWorker(script: WorkerStep[]) {
  let cursor = 0;
  const runCli: PlanCliRunner = ({ platformRoot, args, input, env }) => new Promise((resolve, reject) => {
    const child = spawnSync(path.join(platformRoot, 'bin', '17dz'), args, {
      input, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
    });
    if (child.error) return reject(child.error);
    resolve({ code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' });
  });

  return {
    run: async (input: {
      sessionId?: string;
      requestId?: string;
      onNotice?: (text: string) => Promise<void>;
      messages: unknown[];
    }) => {
      const taskId = input.sessionId ?? 'task_unknown';
      const parts: string[] = [];
      // 宿主要求"申报了实时查询就必须有本轮执行痕迹"：激活过的计划 + 真实跑过的调用
      // 就是这份凭证，由子 Agent 替身如实回报（真实 worker 由 pi-coding-driver 合成）。
      let proof: { planId: string; version: number; calls: number } | undefined;
      let pendingPlan: { planId: string; version: number; taskId: string; decision: 'confirm'; userText: string; evaluation: unknown } | undefined;
      for (let step = 0; step < script.length; step += 1) {
        const current = script[Math.min(cursor, script.length - 1)]!;
        cursor += 1;
        if ('text' in current) { parts.push(current.text); continue; }
        if ('execute' in current) {
          // 用户确认后宿主激活计划并续跑原任务：worker 按平台当前 active 计划执行，
          // 不再重新评估（重新评估会再次撞上确认门）。
          const active = await loadCurrentActivePlan({ platformRoot: PLATFORM_ROOT, taskId, runCli });
          if (!active) throw new Error('宿主未激活任何计划，拒绝执行');
          proof = { planId: active.planId, version: active.version, calls: 0 };
          for (const call of current.execute) {
            const script = SCRIPTS[call.operation];
            if (!script) throw new Error(`未知 operation 脚本: ${call.operation}`);
            const out = spawnSync(CLI, ['query', script, ...call.args.map(String)], {
              encoding: 'utf8', timeout: 30_000,
              env: { ...process.env, DZ_PLAN_ID: active.planId, DZ_REQUIRE_PLAN: '1' },
            });
            if (proof) proof = { ...proof, calls: proof.calls + 1 };
            parts.push(`执行 ${call.operation}: ${(out.stdout ?? '').trim() || (out.stderr ?? '').trim()}`);
          }
          continue;
        }
        const plan = await evaluateAndActivatePlan({
          platformRoot: PLATFORM_ROOT,
          taskId,
          requestId: input.requestId,
          calls: current.plan,
          onNotice: input.onNotice,
          runCli,
          activationSecret: process.env['DZ_PLAN_ACTIVATION_SECRET'],
        });
        if (plan.status === 'confirm') {
          // 计划停在用户确认门：把 pending 上报宿主，由宿主持久化并等真实回复。
          // stopAtConfirm 时立即收手；否则继续改口径——那正是旧确认被新计划取代的复现路径。
          if (current.stopAtConfirm) {
            return {
              text: plan.message,
              messages: [...input.messages, { role: 'assistant', content: plan.message, timestamp: Date.now() }],
              pendingPlan: plan.pending,
            };
          }
          pendingPlan = plan.pending;
          parts.push(plan.message);
          continue;
        }
        if (plan.status !== 'active') { parts.push(plan.message); continue; }
        proof = { planId: plan.planId, version: plan.version, calls: 0 };
        for (const call of current.plan) {
          // 与真实 worker 一致：bash 只允许 bin/17dz，且必须走网关形式——
          // serve 法域的 DZ_INVOCATION 由网关铸造，直调 operation run 会被拒。
          const script = SCRIPTS[call.operation];
          if (!script) throw new Error(`未知 operation 脚本: ${call.operation}`);
          const out = spawnSync(CLI, ['query', script, ...call.args.map(String)], {
            encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, DZ_PLAN_ID: plan.planId, DZ_REQUIRE_PLAN: '1' },
          });
          const body = (out.stdout ?? '').trim() || (out.stderr ?? '').trim();
          if (proof) proof = { ...proof, calls: proof.calls + 1 };
          parts.push(`执行 ${call.operation}: ${body}`);
        }
      }
      // 有计划停在确认门时，用户看到的是那条确认询问，而不是中间的探索输出
      // （真实 worker 也会在 PLAN NEEDS_USER_CONFIRM 处收手）。
      const text = pendingPlan ? pendingPlan.userText : parts.join('\n');
      return {
        text,
        messages: [...input.messages, { role: 'assistant', content: text, timestamp: Date.now() }],
        ...(proof ? { execution: proof } : {}),
        ...(pendingPlan ? { pendingPlan } : {}),
      };
    },
  };
}

// ── 装配辅助 ────────────────────────────────────────────────────────────

interface Boot {
  send(text: string): Promise<string>;
  sdk: RecordingSdkClient;
  assembly: ServerAssembly;
}

async function boot(options: { main: unknown; worker: unknown }): Promise<Boot> {
  const sdk = new RecordingSdkClient();
  const assembly = await createServerAssembly({
    env: process.env,
    dbPath: path.join(stateDir, `agent-${counter}.db`),
    driver: options.main as never,
    workerDriver: options.worker as never,
    channelClientFactory: () => sdk,
    // 离线环境没有模型可用：Context State 走确定性兜底，记忆整理不产出候选
    contextModelDriver: { run: async (input: { messages: unknown[] }) => ({ text: '{}', messages: input.messages }) },
    memoryCandidateExtractor: async () => [],
  });
  // 与生产一致：principal 由可信的企微用户 ID 解析，先开通查询权限
  await assembly.store.principalScopes.upsert({
    wecomUserId: 'e2e_user', accountSetIds: [], accountSetScope: 'all', enabled: true,
  });
  const starting = assembly.channel.start(assembly.replyHandler);
  sdk.emit('authenticated');
  await starting;
  return {
    sdk,
    assembly,
    send: async (text: string) => {
      const before = sdk.frames.filter((frame) => frame.finish).length;
      sdk.emit('message.text', {
        headers: { req_id: `req_${counter}_${before}` },
        body: { msgtype: 'text', from: { userid: 'e2e_user' }, msgid: `msg_${counter}_${before}`, chattype: 'single', text: { content: text } },
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) return finals.at(-1)!.content;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`等待最终回复超时；已收帧: ${JSON.stringify(sdk.frames)}`);
    },
  };
}

function ledger(): { tasks?: Record<string, { actual?: { calls?: number } }> } {
  const file = process.env['DZ_PLAN_STATE'];
  if (!file || !existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

function totalActualCalls(): number {
  return Object.values(ledger().tasks ?? {}).reduce((sum, task) => sum + (task.actual?.calls ?? 0), 0);
}

function balanceCalls(account: string, period: string): PlanCall[] {
  return [{ operation: 'finance.query-receivables', args: ['--query', account, '--period', period] }];
}

/** operation 名 → 平台脚本文件名（网关 query 形式按脚本寻址）。 */
const SCRIPTS: Record<string, string> = {
  'finance.query-receivables': 'query-receivables.js',
  'finance.search-account-sets': 'search-account-sets.js',
  'voucher.query-saved': 'query-saved.js',
};

const CURRENT_PERIOD = '202609';

/** 单期查询失败后自行扩大到 1–9 月：必须让用户先知道。 */
function nineMonthPlan(): PlanCall[] {
  return Array.from({ length: 9 }, (_, i) => ({
    operation: 'finance.query-receivables',
    args: ['--query', '幻辰财税', '--period', `20260${i + 1}`],
  }));
}

/** 超过 confirm 门槛的高重量计划。 */
function heavyPlan(): PlanCall[] {
  return Array.from({ length: 21 }, (_, i) => ({
    operation: 'finance.query-receivables',
    args: ['--query', '幻辰财税', '--period', `20260${(i % 9) + 1}`],
  }));
}

/** n 期余额查询，用于观察 notify 档内的逐步扩张。 */
function growingPlan(n: number): PlanCall[] {
  return Array.from({ length: n }, (_, i) => ({
    operation: 'finance.query-receivables',
    args: ['--query', '幻辰财税', '--period', `20260${i + 1}`],
  }));
}

// ── 场景 ────────────────────────────────────────────────────────────────

describe('离线全链 e2e：直接发消息给 fshine-agent', () => {
  it('S2 不问账套的实时余额问题先追问，不调用平台', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'missing', accountQueries: [], question: '要查哪个账套？' }]),
      worker: gatedWorker([{ text: '不应执行' }]),
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');
    expect(reply).toContain('账套');
    expect(sdk.noticeTexts()).toHaveLength(0);
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('S1 重复提问实时数据必须产生本轮平台执行，不能重放旧答复', async () => {
    const worker = () => gatedWorker([
      { plan: balanceCalls('幻辰财税', CURRENT_PERIOD) },
      { text: '幻辰财税 202609 应收余额为 51 元。' },
    ]);
    const main = () => mainDriver([
      { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
    ]);

    const first = await boot({ main: main(), worker: worker() });
    const firstReply = await first.send('查一下幻辰财税的应收账款');
    expect(firstReply).toContain('51 元');
    expect(firstReply).not.toContain('不应外发');
    const callsAfterFirst = totalActualCalls();
    expect(callsAfterFirst).toBeGreaterThan(0);
    await first.assembly.close();

    // 同一问题重问：宿主会话里已经有旧答复，但仍必须重新查询
    const second = await boot({ main: main(), worker: worker() });
    const secondReply = await second.send('查一下幻辰财税的应收账款');
    expect(secondReply).toContain('51 元');
    expect(totalActualCalls()).toBeGreaterThan(callsAfterFirst);
    await second.assembly.close();
  });

  it('S3 申报夹带历史账套时降级为澄清，不委派', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻东'] }]),
      worker: gatedWorker([{ text: '幻东应收 42 元。' }]),
    });
    const reply = await send('帮我查一下猫一杯的应收账款还有多少');
    expect(reply).toContain('账套');
    expect(reply).not.toContain('幻东');
    expect(reply).not.toContain('42 元');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('R2 申报实时查询但子 Agent 零执行时，不外发其财务结论', async () => {
    const before = totalActualCalls();
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] }]),
      // 子 Agent 直接给结论，没有任何计划激活与平台调用
      worker: gatedWorker([{ text: '幻辰财税 202609 应收余额大概是 42 元。' }]),
    });
    const reply = await send('查一下幻辰财税的应收账款');
    expect(reply).toContain('没有产生任何平台查询');
    expect(reply).not.toContain('42 元');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('S4 扩大查询范围前用户先收到范围与耗时通知，通知送达后才执行', async () => {
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] }]),
      worker: gatedWorker([{ plan: nineMonthPlan() }]),
    });
    const reply = await send('查幻辰财税账套 1 到 9 月的应收账款');

    const notices = sdk.noticeTexts();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.join('\n')).toContain('2026年01月至2026年09月');
    // 通知帧必须早于最终回复帧
    const noticeIndex = sdk.frames.findIndex((frame) => frame.content.startsWith('计划通知：'));
    const finalIndex = sdk.frames.map((frame) => frame.finish).lastIndexOf(true);
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(finalIndex);
    // 通知放行后，跨月查询真的执行了
    expect(reply).toContain('query-receivables');
    expect(totalActualCalls()).toBeGreaterThan(0);
    await assembly.close();
  });

  it('S5 计划通知投递失败时不激活、不执行扩展查询', async () => {
    const before = totalActualCalls();
    const { send, sdk, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] }]),
      worker: gatedWorker([{ plan: nineMonthPlan() }]),
    });
    sdk.failNotice = '2026年01月至2026年09月';
    const reply = await send('查幻辰财税账套 1 到 9 月的应收账款');

    expect(sdk.noticeTexts().length).toBeGreaterThan(0);
    expect(reply).not.toContain('query-receivables');
    expect(reply).toContain('失败');
    expect(totalActualCalls()).toBe(before);
    await assembly.close();
  });

  it('S6/S7 高重量计划等用户确认，确认后激活并续跑原任务', async () => {
    const resumeInputs: string[] = [];
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      ], (input) => resumeInputs.push(JSON.stringify(input.messages))),
      worker: gatedWorker([{ plan: heavyPlan(), stopAtConfirm: true }, { execute: heavyPlan() }, { text: '已按你确认的范围查完 1 至 9 月。' }]),
    });
    const asked = await send('查幻辰财税账套全年的应收账款');
    expect(asked).toContain('确认继续');
    expect(totalActualCalls()).toBe(0);

    const done = await send('确认继续');
    expect(done).toContain('整理完成');
    expect(resumeInputs.join('')).toContain('已按你确认的范围查完');
    expect(totalActualCalls()).toBeGreaterThan(0);
    await assembly.close();
  });

  it('S8 待确认计划被新计划取代后，旧确认得到确定性解释', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      ]),
      worker: gatedWorker([{ plan: heavyPlan() }, { plan: balanceCalls('幻辰财税', CURRENT_PERIOD) }]),
    });
    await send('查幻辰财税账套全年的应收账款');
    // 同一任务再提一个轻量计划：平台把旧计划标记为 superseded
    await send('只查本月幻辰财税的应收账款');
    const stale = await send('确认继续');

    expect(stale).toContain('已经被更新的计划取代');
    expect(stale).not.toContain('处理失败');
    await assembly.close();
  });

  it('S9 同一任务内反复通知后升级为必须等用户确认', async () => {
    // 计数器按 taskId 记账：必须是同一个任务里连续改口径，才能观察到升级。
    const { send, sdk, assembly } = await boot({
      main: mainDriver([
        { kind: 'platform_query', taskType: 'balance', accountResolution: 'explicit', accountQueries: ['幻辰财税'] },
      ]),
      worker: gatedWorker([{ plan: growingPlan(4) }, { plan: growingPlan(6) }, { plan: growingPlan(8) }]),
    });
    const reply = await send('查幻辰财税账套的应收账款');

    // 前两次是 notify 档通知，第三次是升级后的确认询问（confirm 也会先告知用户）
    expect(sdk.noticeTexts()).toHaveLength(3);
    expect(sdk.noticeTexts().at(-1)).toContain('确认继续');
    expect(reply).toContain('确认继续');
    await assembly.close();
  });

  it('S10 账套不存在时只走目录搜索，不用余额或凭证接口探测', async () => {
    const { send, assembly } = await boot({
      main: mainDriver([{ kind: 'platform_query', taskType: 'account_search', searchQuery: '胜利' }]),
      worker: gatedWorker([
        { plan: [{ operation: 'finance.search-account-sets', args: ['--query', '胜利'] }] },
        { text: '现有接口没有账套目录搜索能力返回"胜利"，我无法确认这个账套是否存在。' },
      ]),
    });
    const reply = await send('只查账套目录，看看有没有胜利这个帐套');

    expect(reply).toContain('无法确认');
    // 平台账本里这个任务只登记了目录搜索，没有余额/凭证调用
    const tasks = Object.values(ledger().tasks ?? {});
    const last = tasks.at(-1) as { actual?: { calls?: number } } | undefined;
    expect(last?.actual?.calls ?? 0).toBe(1);
    await assembly.close();
  });

  it('R3 Main Agent 跳过申报时失败关闭，不外发其文本', async () => {
    const { send, assembly } = await boot({ main: silentDriver(), worker: gatedWorker([{ text: '不应执行' }]) });
    const reply = await send('查一下幻辰财税的应收账款');
    expect(reply).toContain('没有产生任何平台查询');
    expect(reply).not.toContain('42 元');
    await assembly.close();
  });
});
