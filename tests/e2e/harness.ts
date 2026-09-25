/**
 * 离线全链 e2e 共享替身：tests/e2e/turn-loop-*.test.ts 四个文件共用。
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
 *
 * 并行安全：每个导入本模块的测试文件各得一份模块实例（独立 stateDir 与 counter），
 * 文件内每个用例再按编号分到独立的平台状态文件；vitest 线程池给每个文件独立的
 * process.env 副本，四个文件并行跑不会串味。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
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

/**
 * Main Agent：按脚本申报本轮动作（申报契约：kind / request / continueTaskId）。
 *
 * 声明条目可带可选 `text`：申报之后返回的回复文本（缺省为'主 Agent 自由文本：不应外发'）。
 * conversation 申报后返回的文本就是用户可见回复——模型文本即回复，无需宿主转述；
 * delegate 申报走 terminate 语义，用户看到的是子 Agent 的文本，这里的 text 不参与外发
 * （只在申报被宿主退回时用于兜底，见 catch 分支）。
 */
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
      const { text, ...declaration } = declarations[Math.min(cursor, declarations.length - 1)]!;
      cursor += 1;
      try {
        await input.exec('route_current_turn', declaration);
      } catch (error) {
        return { text: (error as Error).message, messages: input.messages };
      }
      return { text: typeof text === 'string' ? text : '主 Agent 自由文本：不应外发', messages: input.messages };
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

export type WorkerStep =
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
  /** 以指定企微用户身份发一句话，返回用户最终看到的文本。 */
  send(text: string, options?: { userid?: string; group?: boolean }): Promise<string>;
  sdk: RecordingSdkClient;
  assembly: ServerAssembly;
}

/** 构造一条企微文本消息帧（与官方 SDK 投给适配器的形状一致）。 */
function wecomText(userid: string, content: string, options: { group?: boolean } = {}): {
  headers: { req_id: string };
  body: Record<string, unknown>;
} {
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  const mentioned = options.group ? `@幻晟记账助手 ${content}` : content;
  return {
    headers: { req_id: `req_${messageId}` },
    body: {
      msgtype: 'text',
      from: { userid },
      msgid: messageId,
      chattype: options.group ? 'group' : 'single',
      ...(options.group ? { chatid: 'grp_e2e' } : {}),
      text: { content: mentioned },
    },
  };
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
    send: async (text: string, options: { userid?: string; group?: boolean } = {}) => {
      const before = sdk.frames.filter((frame) => frame.finish).length;
      sdk.emit('message.text', wecomText(options.userid ?? 'e2e_user', text, { group: options.group }));
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

export {
  RecordingSdkClient,
  mainDriver,
  silentDriver,
  gatedWorker,
  boot,
  ledger,
  totalActualCalls,
  balanceCalls,
  CURRENT_PERIOD,
  nineMonthPlan,
  heavyPlan,
  growingPlan,
};
export type { Boot };
