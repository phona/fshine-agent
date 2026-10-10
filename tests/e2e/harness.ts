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
import type { NoticeFn, ProgressFn, ReplyHandler } from '@fshine/contracts';
import { evaluateAndActivatePlan, loadCurrentActivePlan, planCallFacts, planWriteClosed, type PlanCall, type PlanCliRunner } from '../../packages/agent/src/plan-runtime';
import { loadOperationArgSpecs, loadOperationLabels } from '../../packages/agent/src/operation-labels';
import { messageTextFor } from '../../packages/agent/src/error-codes';
import { validatePlanEntities, type PlanEntitySources } from '../../packages/agent/src/turn-contract';
import type { SubagentNeeds } from '../../packages/agent/src/driver';
import { selectionClarificationFromResponses, type SelectionClarification } from '../../packages/agent/src/platform-contract';
import { createServerAssembly, type ServerAssembly } from '../../apps/server/assembly';

const PLATFORM_ROOT = process.env['DZ_PLATFORM_ROOT'] ?? path.resolve(__dirname, '..', '..', '..', '17dz-platform');
const CLI = path.join(PLATFORM_ROOT, 'bin', '17dz');

let stateDir: string;
let savedEnv: NodeJS.ProcessEnv;
let counter = 0;
// 平台 args 规格与 label 表（D-065 结构化事实的取值来源）：一次性派生，测试替身与真实
// 驱动读同一份平台数据（不镜像、不手抄）。
const argSpecs = await loadOperationArgSpecs(PLATFORM_ROOT);
const operationLabels = await loadOperationLabels(PLATFORM_ROOT);
// access 语义表（D-075 写关闭判据的平台数据面）：与真实驱动同一把机械尺——calls（宿主
// 解析）× 语义表（平台 access 声明，confirm 列）× capabilities（宿主注入）。
// 为什么这里注入替身而不是经平台 CLI 派生：语义表是**判据**不是普通数据，平台侧正在并行
// 改造（顶层 accessSemantics 表尚未下发），此刻派生只会得到空表 = 写关闭扫描静默不生效
// （假绿）。替身与单测同口径（见 packages/agent/plan-runtime.test.ts 的 SEMANTICS）；
// 平台下发该表后可换回 loadOperationSemantics(PLATFORM_ROOT)。
const operationSemantics = new Map<string, { plan: boolean; confirm: boolean; mock: boolean }>([
  ['query-receivables', { plan: true, confirm: false, mock: true }],
  ['finance.query-receivables', { plan: true, confirm: false, mock: true }],
  ['query-saved', { plan: true, confirm: false, mock: true }],
  ['voucher.query-saved', { plan: true, confirm: false, mock: true }],
  ['search-account-sets', { plan: true, confirm: false, mock: true }],
  ['finance.search-account-sets', { plan: true, confirm: false, mock: true }],
  ['validate', { plan: false, confirm: false, mock: false }],
  ['payroll.validate', { plan: false, confirm: false, mock: false }],
  ['transform', { plan: false, confirm: false, mock: false }],
  ['payroll.transform', { plan: false, confirm: false, mock: false }],
  ['precheck', { plan: false, confirm: false, mock: false }],
  ['voucher.precheck', { plan: false, confirm: false, mock: false }],
  ['prepare', { plan: true, confirm: true, mock: true }],
  ['voucher.prepare', { plan: true, confirm: true, mock: true }],
  ['fill', { plan: true, confirm: true, mock: true }],
  ['voucher.fill', { plan: true, confirm: true, mock: true }],
  ['commit', { plan: true, confirm: true, mock: true }],
  ['voucher.commit', { plan: true, confirm: true, mock: true }],
]);

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
    // 入向密封：WecomBotChannel.start() 硬性要求 WECOM_BOT_ID/SECRET 非空，否则抛错、
    // boot() 失败——17 个 turn-loop 文件全红。这里装确定性假凭据；channel 已注入假 SDK
    // client（channelClientFactory），绝不真连企微。无凭据环境（env -u）因此可复现。
    WECOM_BOT_ID: 'e2e-bot-id-offline',
    WECOM_BOT_SECRET: 'e2e-bot-secret-offline',
  });
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(stateDir, { recursive: true, force: true });
});

// ── 装配台账（2026-10-10 资源边界整改）─────────────────────────────────
//
// 事故复盘：boot() 每个都建一个真 assembly（真 SQLite 库 + planConfirmation 接线 +
// channel.start()）。此前只有"测试自己记得调 assembly.close()"这一条路——turn-loop-
// progress-frames 三个用例一个都没关，SQLite 句柄与接线滞留到 worker 进程退出；
// 换 threads 池或 isolate:false 时同类泄漏会跨文件累积。这里给每个 boot 登记，
// afterEach 统一收掉"测试没关的"：测试显式关过的从台账移除（不双关，closeStore
// 本身幂等），没收的一律兜底 close + channel.stop()——start() 过的就必须有配对的
// 停止动作，不依赖人记得。
const liveAssemblies = new Set<ServerAssembly>();

afterEach(async () => {
  for (const assembly of [...liveAssemblies]) {
    liveAssemblies.delete(assembly);
    try {
      // 走的是包装后的 close：先停 channel 再关库（见 boot() 内的包装）
      await assembly.close();
    } catch { /* 收尾失败不掩盖用例本身的结果：兜底清理尽力而为 */ }
  }
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
 *
 * 多声明对话：申报被宿主接受且没有 terminate 时（纠错环、计划模式的每一步——宿主把
 * 步骤结果作为工具结果交还模型），模型继续同一回合并消费下一条声明；脚本耗尽仍未给出
 * text → 停嘴。
 *
 * `continueTaskId` 写 `LAST_TASK_ID_TOKEN` 时，由替身用上一条申报的工具结果里的 taskId
 * 代填：计划模式的步骤 2..M 要带上一步的子任务编号，而编号要等上一步真跑完才知道。
 */
export const LAST_TASK_ID_TOKEN = '@lastTaskId';

function mainDriver(declarations: Array<Record<string, unknown>>, observe?: (input: { messages: unknown[] }) => void) {
  let cursor = 0;
  let lastTaskId = '';
  return {
    run: async (input: {
      tools: unknown[];
      messages: unknown[];
      exec: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      observe?.(input);
      // 宿主续跑路径不带工具：Main Agent 只整理已完成的执行结果，不再申报
      if (input.tools.length === 0) {
        return { text: '已按你确认的范围整理完成。', messages: input.messages };
      }
      // 与生产驱动一致：申报是原生工具调用，转录里留下 assistant(toolCall) + toolResult
      // （ToolResultMessage 的原生形状：toolCallId + toolName + content 分段）。
      // delegate 轮次经 ToolUserError terminate、needs 回路轮次经工具结果继续——两者都因此
      // 成为"被 toolResult 终结的完整轮次"，下一轮仍留在最近轮次窗口里（C19）。
      const transcript: unknown[] = [...input.messages];
      for (;;) {
        const entry = declarations[Math.min(cursor, declarations.length - 1)]!;
        const exhausted = cursor >= declarations.length;
        const { text, ...declaration } = entry;
        if (declaration['continueTaskId'] === LAST_TASK_ID_TOKEN) declaration['continueTaskId'] = lastTaskId;
        if (exhausted && typeof text !== 'string') {
          return { text: '主 Agent 自由文本：不应外发', messages: transcript };
        }
        cursor += 1;
        const callId = `call_${cursor}`;
        transcript.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: callId, name: 'route_current_turn', arguments: declaration }],
          timestamp: Date.now(),
        } as never);
        try {
          const outcome = await input.exec('route_current_turn', declaration);
          const observedTaskId = (outcome as { taskId?: unknown } | null)?.taskId;
          if (typeof observedTaskId === 'string') lastTaskId = observedTaskId;
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: JSON.stringify(outcome) }],
            timestamp: Date.now(),
          } as never);
          if (typeof text === 'string') return { text, messages: transcript };
        } catch (error) {
          transcript.push({
            role: 'toolResult',
            toolCallId: callId,
            toolName: 'route_current_turn',
            content: [{ type: 'text', text: (error as Error).message }],
            timestamp: Date.now(),
          } as never);
          return { text: (error as Error).message, messages: transcript };
        }
      }
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
  | { plan: PlanCall[]; stopAtConfirm?: boolean; stopAfterActivate?: boolean }
  | { execute: PlanCall[] }
  | { need: SubagentNeeds; text?: string }
  | { end: true }
  | { text: string };

/**
 * 17dz 子 Agent 替身：提交计划走真实 evaluateAndActivatePlan（真 CLI、真账本、真 HMAC），
 * 计划激活后按 calls 真跑 operation run（mock executor、真 DZ_PLAN_ID 绑定）。
 *
 * `enforceEntityScope`（显式开启）：复刻真实驱动的实体门禁——计划参数必须逐字来自宿主
 * 注入的实体来源 + 本任务平台响应，越权即确定性拒绝（PLAN DECLINED → needs）。默认关闭：
 * 既有共享夹具先于门禁存在，参数并非都逐字可溯源（见下方拦截处的说明）。
 *
 * `enforceWriteClosure`（显式开启）：复刻真实驱动的写关闭计划扫描（D-075）——宿主解析出
 * 的 calls 含"要用户确认"的 operation（平台 access 语义表的 confirm 列，替身注入）而宿主
 * 注入的能力不含 write 时，在 evaluate **之前**终结该轮：终稿是宿主合成的
 * WRITE_NOT_ENABLED（error-codes.ts 唯一来源），worker 的准备/承诺文本不会成为终稿
 * （T7 形态的机械版），零平台调用发生。与实体门禁同性质：真实驱动的扫描在
 * pi-coding-driver 的 beforeToolCall，单测钉拦截点与理由，这里钉宿主级终稿行为。
 */
function gatedWorker(script: WorkerStep[], options?: { enforceEntityScope?: boolean; enforceWriteClosure?: boolean }) {
  const enforceEntityScope = options?.enforceEntityScope === true;
  const enforceWriteClosure = options?.enforceWriteClosure === true;
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
      /** 宿主注入的实体来源（架构 §2 第 9 条）：替身按它复刻真实驱动的计划门禁。 */
      entitySources?: PlanEntitySources;
      /** 宿主注入的能力声明（D-075）：替身按它复刻真实驱动的写关闭计划扫描。 */
      capabilities?: readonly string[];
      messages: unknown[];
    }) => {
      const taskId = input.sessionId ?? 'task_unknown';
      const parts: string[] = [];
      // 宿主要求"申报了实时查询就必须有本轮执行痕迹"：激活过的计划 + 真实跑过的调用
      // 就是这份凭证，由子 Agent 替身如实回报（真实 worker 由 pi-coding-driver 合成）。
      let proof: { planId: string; version: number; calls: number } | undefined;
      let pendingPlan: { planId: string; version: number; taskId: string; decision: 'confirm'; userText: string; evaluation: unknown } | undefined;
      // 纠错环（架构 §3）：执行不了就回报"缺什么/为什么/建议用户提供什么"，不执行任何调用。
      let needs: SubagentNeeds | undefined;
      // 收尾兜底（P1）：方案已批准但零执行。真实 worker 由 pi-coding-driver 补一刀后
      // 仍然零调用，才把这个事实上报宿主——这里直接复刻那个终局状态。
      let activatedPlan: { planId: string; version: number } | undefined;
      // 结构化事实（D-065）：与真实驱动走同一条生产函数——calls 取脚本里提交的计划，
      // 取值按平台 args 规格的声明名机械提取，label 取平台清单第 5 列。
      let plannedCalls: PlanCall[] = [];
      // 结构化歧义/未找到：真实 worker 由 pi-coding-driver 从本回合的 tool_result 信封派生
      // （platform-contract 的 selectionClarificationFromResponses）。替身走同一条生产函数
      // ——派生逻辑只有一份，不存在"测试里另写一套提取"。
      const platformOutputs: string[] = [];
      for (let step = 0; step < script.length; step += 1) {
        const current = script[Math.min(cursor, script.length - 1)]!;
        cursor += 1;
        if ('text' in current) { parts.push(current.text); continue; }
        if ('need' in current) {
          // 结构化线索直接产出（真实 worker 由 pi-coding-driver 从平台确定性拒绝原因派生）；
          // 宿主据此不 terminate 整轮，任务保持可续。
          needs = current.need;
          parts.push(typeof current.text === 'string' ? current.text : current.need.reason);
          break;
        }
        if ('end' in current) {
          // worker 收手：本回合到此结束，剩下的步骤留给下一次委派（多轮脚本的分段点）。
          break;
        }
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
            const body = (out.stdout ?? '').trim() || (out.stderr ?? '').trim();
            platformOutputs.push(body);
            parts.push(`执行 ${call.operation}: ${body}`);
          }
          continue;
        }
        // 实体门禁复刻（与真实驱动 pi-coding-driver 同一把尺，测试显式开启）：
        // 宿主注入的实体来源 + 本任务迄今的平台响应（替身自己收集的 platformOutputs，
        // 对应真实驱动的会话 tool_result 汇总）做逐字包含判定。越权 → 确定性拒绝：
        // 零执行 + needs 线索（missing 与 reason 的形状与真实驱动一致——宿主计划拦截的
        // 原因原文）。
        // 为什么默认不 enforce：共享替身的既有夹具先于门禁存在，脚本里的计划参数并非
        // 都逐字来自当轮消息（如 --period 202609 在消息里没有——真实驱动同样会拒）。
        // 把那批夹具改到"逐字可溯源"是另一件保真工作，不在本包范围；需要门禁的测试
        // （turn-loop-session-entities 的事故复刻）显式打开。
        if (enforceEntityScope && input.entitySources) {
          const scopeError = validatePlanEntities(current.plan, {
            ...input.entitySources,
            platformResponses: [...(input.entitySources.platformResponses ?? []), ...platformOutputs],
          });
          if (scopeError) {
            needs = { missing: ['请求中未给出的对象'], reason: scopeError };
            parts.push(`PLAN DECLINED：${scopeError}`);
            break;
          }
        }
        // 写关闭计划扫描（D-075）：与真实驱动 beforeToolCall 同一把机械尺——calls（宿主
        // 解析）× 语义表（平台 access 声明，confirm 列）× capabilities（宿主注入）。命中即在
        // evaluate 之前终结该轮，终稿是宿主合成的写关闭话术：T7 形态里模型停在"录入准备"阶段
        // 永不抵达提案步，这句话必须由宿主说，且 worker 的准备/承诺文本不得外发。
        if (enforceWriteClosure && planWriteClosed(current.plan, operationSemantics, input.capabilities)) {
          const text = messageTextFor('WRITE_NOT_ENABLED');
          return {
            text,
            messages: [...input.messages, { role: 'assistant', content: text, timestamp: Date.now() }],
            // 与真实驱动一致：终稿标记随结果上交——宿主据此把这段确定性话术直接作为
            // 本轮回复（出口校验的零执行标注不覆盖它）。
            writeClosed: true,
          };
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
        plannedCalls = current.plan;
        if (current.stopAfterActivate) {
          // 计划已激活（通知已送达）但一个调用都不发起：执行闭环断裂的终局
          activatedPlan = { planId: plan.planId, version: plan.version };
          parts.push(plan.message);
          continue;
        }
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
          platformOutputs.push(body);
          if (proof) proof = { ...proof, calls: proof.calls + 1 };
          parts.push(`执行 ${call.operation}: ${body}`);
        }
      }
      // 有计划停在确认门时，用户看到的是那条确认询问，而不是中间的探索输出
      // （真实 worker 也会在 PLAN NEEDS_USER_CONFIRM 处收手）。
      const text = pendingPlan ? pendingPlan.userText : parts.join('\n');
      // 本回合最后一条带信封的平台响应决定收尾状态：选择类码才挂 clarification
      // （与 pi-coding-driver 同一函数、同一"只看本回合"边界——platformOutputs 是本次
      // run 的局部收集，上一回合遗留的信封不会越权替这一回合提问）。
      const clarification: SelectionClarification | undefined = selectionClarificationFromResponses(
        platformOutputs.map((body) => ({ role: 'toolResult', content: [{ type: 'text', text: body }] })),
      );
      const facts = plannedCalls.length > 0
        ? (() => {
          const { accountSet, period, label } = planCallFacts(plannedCalls, argSpecs, operationLabels);
          return {
            calls: plannedCalls.map((call) => ({ operation: call.operation, args: call.args })),
            ...(accountSet ? { accountSet } : {}),
            ...(period ? { period } : {}),
            ...(label ? { label } : {}),
          };
        })()
        : undefined;
      return {
        text,
        messages: [...input.messages, { role: 'assistant', content: text, timestamp: Date.now() }],
        ...(facts ? { planFacts: facts } : {}),
        ...(proof ? { execution: proof } : {}),
        ...(activatedPlan ? { activatedPlan } : {}),
        ...(pendingPlan ? { pendingPlan } : {}),
        ...(needs ? { needs } : {}),
        ...(clarification ? { clarification } : {}),
      };
    },
  };
}

// ── 装配辅助 ────────────────────────────────────────────────────────────

interface Boot {
  /** 以指定企微用户身份发一句话，返回用户最终看到的文本。 */
  send(text: string, options?: { userid?: string; group?: boolean }): Promise<string>;
  /** 同上，同时带回这一回合产生的进度帧与计划通知帧（帧级断言用）。 */
  turn(text: string, options?: { userid?: string; group?: boolean }): Promise<Turn>;
  sdk: RecordingSdkClient;
  assembly: ServerAssembly;
}

/**
 * 一次企微回合的结果：用户看到的回复 + 这一回合产生的进度帧与计划通知帧。
 *
 * `steps` 采集点在 handler 入口（replyHandler 外层）：生产企微 adapter 就是把
 * progress 传给 handler 的，harness 以前不走这条路，帧级断言只能看 adapter 投递
 * 出来的那一帧——那是保真缺口。渠道侧的节流（3s 最小间隔 + 4 帧硬顶）是投递策略，
 * 不是产生策略，所以采集必须贴在 handler 上，才能看到这一回合真正产生了哪些帧。
 */
export interface Turn {
  /** 用户最终看到的回复文本（finish 帧内容，与 send() 的返回值一字不差）。 */
  text: string;
  /** 进度帧原文（未经渠道节流）。 */
  steps: string[];
  /** 计划通知帧原文（与 sdk.noticeTexts() 同源，按回合归集）。 */
  notices: string[];
}

/** 帧采集按 messageId 归集：并发会话的各个回合互不串味。 */
const turnFrames = new Map<string, { steps: string[]; notices: string[] }>();

/** 构造一条企微文本消息帧（与官方 SDK 投给适配器的形状一致）。 */
function wecomText(userid: string, content: string, options: { group?: boolean; messageId?: string } = {}): {
  headers: { req_id: string };
  body: Record<string, unknown>;
} {
  const messageId = options.messageId ?? `msg_${Math.random().toString(36).slice(2, 10)}`;
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
    // 入站防抖显式关掉：它是延迟旋钮，会把基于时间的控制（平台冷却、限流窗口）的时序
    // 整体后移。本批用例用 2s 冷却夹具，2s 防抖就足以让冷却过期、该拦截的轮次放行
    // （2026-10-08 实测：invocations 从 6 变 7）。生产上冷却 10 分钟、防抖 2 秒可忽略，
    // 但离线夹具必须把旋钮归零才能验时序本身。防抖自身的行为由 handler 单测覆盖。
    env: { ...process.env, FSHINE_INBOUND_DEBOUNCE_MS: '0' },
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
  // 登记 + 包装 close：测试显式调 close() 时把自己从台账移除（afterEach 只收没人关的），
  // 漏关的由 afterEach 兜底。closeStore 本身幂等，双关也不会炸，但台账让语义确定。
  // 包装里一并 stop channel：start() 过的就必须有配对的停止动作，测试自己关的路径
  // 与兜底路径行为一致（注入的是假 SDK client，disconnect 是 no-op；将来若注入真
  // client，漏 stop 就是真长连接泄漏）。
  liveAssemblies.add(assembly);
  const closeAssembly = assembly.close.bind(assembly);
  assembly.close = async () => {
    liveAssemblies.delete(assembly);
    try {
      await assembly.channel.stop();
    } catch { /* 停止渠道失败不阻塞关库 */ }
    await closeAssembly();
  };
  // 生产保真：adapter 把 progress/notice 传给 handler（channel-wecom adapter.ts 的
  // dispatchMessage）。这里只在外面包一层记录，生产链路一行不改——notices 的送达屏障
  // （失败必须抛给调用方）原样保留，进度帧也照常送给 adapter 投递。
  const recordingHandler: ReplyHandler = async (message, progress, notice) => {
    const frames = turnFrames.get(message.messageId) ?? { steps: [], notices: [] };
    turnFrames.set(message.messageId, frames);
    const recordingProgress: ProgressFn | undefined = progress
      ? (text) => { frames.steps.push(text); progress(text); }
      : undefined;
    const recordingNotice: NoticeFn | undefined = notice
      ? async (text) => { frames.notices.push(text); await notice(text); }
      : undefined;
    return assembly.replyHandler(message, recordingProgress, recordingNotice);
  };
  const starting = assembly.channel.start(recordingHandler);
  sdk.emit('authenticated');
  await starting;
  /** 发一句话并等到这一回合的 finish 帧；帧采集按 messageId 预先登记同一份对象。 */
  const deliver = (text: string, options: { userid?: string; group?: boolean } = {}): { done: Promise<string>; frames: { steps: string[]; notices: string[] }; messageId: string } => {
    const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
    const frames = { steps: [] as string[], notices: [] as string[] };
    turnFrames.set(messageId, frames);
    const before = sdk.frames.filter((frame) => frame.finish).length;
    sdk.emit('message.text', wecomText(options.userid ?? 'e2e_user', text, { group: options.group, messageId }));
    const done = (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) return finals.at(-1)!.content;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`等待最终回复超时；已收帧: ${JSON.stringify(sdk.frames)}`);
    })();
    return { done, frames, messageId };
  };
  const turn = async (text: string, options: { userid?: string; group?: boolean } = {}): Promise<Turn> => {
    const { done, frames, messageId } = deliver(text, options);
    const reply = await done;
    turnFrames.delete(messageId);
    return { text: reply, steps: [...frames.steps], notices: [...frames.notices] };
  };
  return {
    sdk,
    assembly,
    // send 只是 turn 的回复部分：既有断言一行不用改，帧级断言用 turn。
    send: async (text, options) => (await turn(text, options)).text,
    turn,
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

/**
 * 剥掉共享替身拼进 worker 文本的平台信封段（`执行 <op>: RESULT {…}` 整行）。
 *
 * 这是 harness 的已知保真度边界（turn-loop-phone-incident 篇首注释写明）：真实驱动里主模型
 * 自行组织终稿，worker 文本夹带的信封不会原样外发；替身脚本耗尽时它才拼进 parts 成为回复。
 * 断言"模型不得泄漏执行语言 / 不得把用户没问的对象当答案"必须先剥掉它——否则**平台自己的**
 * 中文 correctForm 与错误码会被当成模型泄漏。2026-09-29 mock 起对无数据期间回
 * not_found + PERIOD_NO_DATA + 中文三要素消息（17dz `src/lib/error-codes.js`），这层
 * "completed 信封恰好无中文无下划线码"的偶然性就被揭穿了：`请确认`/`期间` 出自 correctForm，
 * `PERIOD_NO_DATA` 是平台码，都不是模型说漏嘴。真实平台回中文三要素消息时同样如此。
 *
 * 只剥整行信封段，不动 worker 的叙述体——要判的正是叙述体。
 */
function withoutPlatformEnvelope(text: string): string {
  return text.replace(/^执行 \S+: RESULT \{.*\}$/gm, '').replace(/\n{2,}/g, '\n').trim();
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

/**
 * 平台错误码表的 correctForm（跨仓读平台文件：L2 单一来源在平台侧，e2e 按**数据**核期望，
 * 不在 fshine 仓抄一份期望台词——平台改措辞这边自动跟着变，抄了就成了第二份真相）。
 */
export function platformCorrectForm(code: string): string {
  const table = readFileSync(path.join(PLATFORM_ROOT, 'src', 'lib', 'error-codes.js'), 'utf8');
  const match = new RegExp(`${code}:\\s*\\{[^}]*correctForm:\\s*'([^']+)'`).exec(table);
  if (!match) throw new Error(`平台错误码表里找不到 ${code} 的 correctForm（跨仓契约漂移？）`);
  return match[1]!;
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
  withoutPlatformEnvelope,
};
export type { Boot, Turn };
