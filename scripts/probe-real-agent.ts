/**
 * 真实模型探针：把消息直接注入生产装配，跑真实 LLM + 真实 example-gateway 计划门禁 + mock 执行器。
 *
 * 与 tests/e2e/turn-loop-*.test.ts 的差别只有一点：那里的 Main Agent 和
 * example-gateway 子 Agent 是脚本化驱动，这里用真实 pi driver。企微仍由假 SDK 替代（不起长连接）。
 *
 * 用法：
 *   node --env-file=.env --import tsx scripts/probe-real-agent.ts [--only A1,B2]
 *   node --env-file=.env --import tsx scripts/probe-real-agent.ts --quick
 *
 * 注意：若从 StepCode（step）进程衍生的 shell 里跑，harness 自带的 LLM_* 环境变量会
 * 压过 --env-file（Node 不覆盖已存在变量），静默用到 harness 的模型而不是 .env 的。
 * 先剥掉再跑：env -u LLM_API_BASE_URL -u LLM_API_KEY -u LLM_MODEL -u LLM_THINKING_LEVEL
 *
 * --quick 只跑 A1/A2/A4/A5 + B1（说胡话主线 + 一次稳定性），日常迭代约 3 分钟；
 * 全量约 140 分钟（G1 约 20 分钟、G2 约 8 分钟、H1 约 35 分钟、H2 约 15 分钟、X1 约 13 分钟、X2 约 7 分钟、Y1 约 4 分钟、Y2 约 4 分钟）。涉及declaration/指代的 Phase 按 roadmap 验证协议加跑 --only C1,C2。
 * C2/E/F/G/H/X/Y 是重场景（30 轮超长会话、多任务交织、探索型会话、并发多线程、乒乓与长探索、复杂任务会话、纠错与错误态），按需 --only C2 / --only E1 / --only F1 / --only G1,G2 / --only H1,H2 / --only X1,X2 / --only Y1,Y2，不进 quick。
 *
 * 用例分组：
 *   A 说胡话（A1–A5）：重放历史、范围渗入、歧义澄清、闲聊不委派。
 *   B 稳定性（B1/B2）：连发重查口径一致、window口径体现在回复。
 *   C 长会话（C1/C2）：20/30 轮混合对话的漂移、变慢与旧范围渗入；C2 在 C1 形态上加码——4 个 mock collection轮转、查询↔闲聊话题切换、两次歧义澄清-选择、跨轮召回给数带框定、跨轮总结不塌缩。
 *   D 长任务（D1/D2）：跨月查询先通知、高重量任务停在确认门。
 *   E 多任务交织（E1）：三任务交织后召回旧任务、恢复旧任务线程，汇总不张冠李戴。
 *   F 探索型会话（F1）：目标不明的模糊请求不编造，补充明确后落地为真实查询。
 *   G 并发多线程（G1/G2）：多步核对计划被探索插曲打断后跨回合恢复、失败步授权跳过；用户让 agent 提议查法（meta-planning）。
 *   H 乒乓与长探索（H1/H2）：四任务跨 16 轮来回切的线程隔离/召回一致/重查正确/汇总诚实；单线程逐轮收窄的探索不断线、指代跨轮解析、判断不越界。
 *   X 复杂任务会话（X1/X2）：8 轮连续会话复刻今日真实平台实测（跨期计划/中途换collection/跨轮召回/歧义简称/编号选择/换window/写尝试/总结，D-070/071/072 全形态）；L0 探索型问题（customer/supplier/tax rate）不编造、不域混淆、数据在手不踢回给用户（D-073）。
 *   Y 纠错与错误态（Y1/Y2）：用户纠错回合旧范围干净丢弃、新旧数字不混、window沿用、切回不混淆；平台错误态（not_found/歧义/field missing）失败诚实性的机械断言（说真原因、金额有所属、给可行补救、无internal control term、不引发重试风暴）。
 *
 * 关注十一件事：会不会说胡话（重放历史/范围渗入）、每次是否稳定、长会话是否漂移（C1 20 轮，C2 30 轮加码：collection轮转+话题切换+澄清选择+召回+总结）、长任务是否收口、
 * 多任务交织后能否召回与恢复、探索型会话能否不编造并落地、并发多线程下计划能否跨回合恢复（授权跳过被尊重、agent 能提议查法）、
 * 多任务乒乓跨多轮切换能否线程隔离且跨线程汇总诚实、长探索型任务逐轮收窄能否不断线（指代跨轮解析、判断不发明基准）、
 * 复杂任务会话跨轮连续（跨期计划数字链、召回给数且带框定、总结不塌缩、名称类请求不被会话实体代解析）与 L0 探索的数据呈现（查到的数据不踢回给用户）、
 * 用户纠错与平台错误态的失败诚实性（旧范围干净丢弃、说真原因、不给数、给可行补救）、
 * 歧义/未找到回复是否零执行语言指纹（脚本路径/错误码/JSON/operation 名/internal control term——2026-09-27 Stage 3 事故：一次结构化歧义被模型翻译成
 * 1201 字符技术报告；宿主改为机械组装澄清问题后，这条由 A2/A3/A4/D1/X1/Y2 的断言守。第三波实测又漏过
 * operation 名（"数据来源：…finance.query-receivables"）与internal control term（"查询plan quota"）两类，尺子随 runtime.ts 同扩）。
 * 结果写 .runtime/probe-<runId>.json，同时在终端打可读摘要。
 */
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { executionLanguageFingerprints, isPlatformMock } from '@fshine/agent';
import type { SdkClientLike } from '@fshine/channel-wecom';
import { firstEnabledPrincipalId, loadConfig } from '@fshine/core';
import { createServerAssembly, type ServerAssembly } from '../apps/server/assembly';
import { countDims, dimsSummary, emptyDimCounts, type DimCounts } from './eval/dims';
import { resolveConfigPath, explicitConfigFrom } from './resolve-config-path';
// 金额判据纯核与夹具事实表（2026-11-07 评审 blocking：错误态反例要能进变异测试——
// 探针顶层跑 main() 无法 import，判定核抽到 scripts/eval/amount-criteria.ts，
// 夹具转录抽到 scripts/eval/dummy-fixture.ts；本文件保留用例体与 note 文案组装）。
import {
  ACCOUNT_RESULT_PHRASING,
  ARITHMETIC_FRAMING_RE,
  CLAUSE_SPLIT,
  classifyErrorStateAmounts,
  isDerivedAmount,
  isVerifiedArithmetic,
} from './eval/amount-criteria';
import { MOCK_ACCOUNTS, MOCK_COLLECTION_WINDOWS, MOCK_ITEMS } from './eval/dummy-fixture';

/**
 * 真实 token 消耗的分项（纯加法遥测，性能测试与成本分析用，不算钱不计费）。
 * 来源是宿主进程埋点行（turn_span / delegation_span / aux_model_usage）里的 provider
 * 真实 Usage 分项，不是字符估算。total = input+output+cacheRead+cacheWrite（与宿主侧
 * driver.ts 的 usageSpanFields 同一口径）；reasoning ⊆ output，不重复相加。
 */
interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  total: number;
}

interface Turn {
  text: string;
  reply: string;
  ms: number;
  notices: string[];
  /** 本轮实际产生的平台调用数（example-gateway plan state 的 actual.calls 增量；隔离状态按用例累计，可逐轮相减）。 */
  calls: number;
  group?: boolean;
  /**
   * 本回合真实 token 消耗（纯加法遥测）：main = Main 编排模型（turn_span），worker =
   * example-gateway 子 Agent（delegation_span，多步计划的多次委派已求和）。埋点行没带 token 字段
   * （旧路径/网关不回传 usage）时对应分项缺席——缺席与全零必须可区分，不得拿零冒充。
   * aux（context/memory 抽取）不进逐轮结构：它们是回合后的异步落账，可能晚于回复帧，
   * 逐轮归属不可靠，只在 CaseResult.tokens 按用例全局汇总。
   */
  tokens?: {
    main?: UsageBreakdown;
    worker?: UsageBreakdown;
  };
}

interface CaseResult {
  id: string;
  group: string;
  intent: string;
  turns: Turn[];
  ledgerCalls: number;
  notes: string[];
  /**
   * 四维可信度机械分量（L7 / D-060）：notes 的归维计数。归维表在 scripts/eval/dims.ts
   * （单一来源，打分器与 scores.jsonl 记分台消费同一份）；note 原句由 dims.test.ts 表征锁钉住。
   */
  dims: DimCounts;
  /** 归不进四维的 note 数（任务行为类：计划恢复/空转/成本等，continue驱动 ok，不冒充可信度分数）。 */
  unclassifiedNotes: number;
  /**
   * 用例级 token 汇总（纯加法遥测）：main/worker 由逐轮 tokens 求和；aux 按 kind 全局捕获
   * （异步落账晚于回复帧，逐轮归属不可靠）。没有任何 usage 证据时整个字段缺席。
   */
  tokens?: {
    main?: UsageBreakdown;
    worker?: UsageBreakdown;
    auxContext?: UsageBreakdown;
    auxMemory?: UsageBreakdown;
  };
  ok: boolean;
}

class RecordingSdk implements SdkClientLike {
  readonly frames: Array<{ content: string; finish: boolean }> = [];
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
  async replyStream(_f: unknown, _s: string, content: string, finish: boolean): Promise<unknown> {
    this.frames.push({ content, finish });
    return {};
  }
  async uploadMedia(): Promise<{ media_id: string }> { return { media_id: 'unused' }; }
  async replyMedia(): Promise<unknown> { return {}; }
}

function wecomText(userid: string, content: string): { headers: { req_id: string }; body: Record<string, unknown> } {
  const messageId = `msg_${Math.random().toString(36).slice(2, 10)}`;
  return {
    headers: { req_id: `req_${messageId}` },
    body: { msgtype: 'text', from: { userid }, msgid: messageId, chattype: 'single', text: { content } },
  };
}

let stateDir: string;
let savedEnv: NodeJS.ProcessEnv;
let counter = 0;

/**
 * 探针等一条最终回复的轮询上限（10 分钟）。与 DEFAULT_WORKER_TIMEOUT_MS 数值相同是
 * 巧合而非同源：这是探针自己的等待地平线（必须 ≥ 一个回合预算，否则会在回合自然结束
 * 前放弃轮询），故意不随配置漂移——D-014 收敛的是 worker 超时公式，不是这个等待。
 */
const PROBE_REPLY_WAIT_MS = 600_000;

const PLATFORM_STATE_KEYS = ['EXECUTION_PLAN_STATE', 'EXECUTION_RATE_LIMIT_STATE', 'EXECUTION_MOCK_STATE', 'EXECUTION_AUDIT_PATH'] as const;
let platformStateBackup: Record<string, string | undefined> = {};

// ── 埋点捕获（纯加法）：探针原本没有 console 事件捕获机制，这里加最小的一个 ──
// 拦截 console.info 里 event 为 turn_span / delegation_span / aux_model_usage 的 JSON 行，
// 其余原样透传（探针进程的日志行为不变）。归属判据：探针的 send 严格串行（等最终回复帧
// 才发下一条），而 turn_span/delegation_span 在 handleTurn 返回前同步落账、先于回复帧，
// 所以"本条 send 起点之后的埋点行"就是本回合的——按缓冲区下标切片即可，不需要 requestId
// 关联（handler 自造 requestId，与企微 req_id 不同源，关联不上）。
type TelemetryEvent = Record<string, unknown>;
const telemetryEvents: TelemetryEvent[] = [];
const TELEMETRY_EVENT_NAMES = new Set(['turn_span', 'delegation_span', 'aux_model_usage']);
const originalConsoleInfo = console.info.bind(console);
console.info = (...args: unknown[]): void => {
  const line = args[0];
  if (typeof line === 'string' && line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line) as TelemetryEvent;
      if (typeof parsed['event'] === 'string' && TELEMETRY_EVENT_NAMES.has(parsed['event'])) {
        telemetryEvents.push(parsed);
      }
    } catch { /* 非 JSON 行原样透传 */ }
  }
  originalConsoleInfo(...args);
};

/** 埋点行 → token 分项；行里没带 token 字段（网关不回传 usage）时返回 null（缺席，不编零）。 */
function usageBreakdownOf(event: TelemetryEvent): UsageBreakdown | null {
  if (typeof event['tokensIn'] !== 'number' || typeof event['tokensOut'] !== 'number') return null;
  const input = event['tokensIn'];
  const output = event['tokensOut'];
  const cacheRead = typeof event['cacheRead'] === 'number' ? event['cacheRead'] : 0;
  const cacheWrite = typeof event['cacheWrite'] === 'number' ? event['cacheWrite'] : 0;
  const reasoning = typeof event['reasoning'] === 'number' ? event['reasoning'] : undefined;
  return {
    input, output, cacheRead, cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    total: input + output + cacheRead + cacheWrite,
  };
}

/** 分项相加（null = 无证据，加法单位元）；口径与宿主 driver.ts 的 addUsageTotals 同族。 */
function addBreakdown(a: UsageBreakdown | null, b: UsageBreakdown | null): UsageBreakdown | null {
  if (!a) return b;
  if (!b) return a;
  const reasoning = a.reasoning === undefined && b.reasoning === undefined
    ? undefined
    : (a.reasoning ?? 0) + (b.reasoning ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
    total: a.total + b.total,
  };
}

/** 自 mark 起的埋点行里，按事件名求和出的 token 分项（无证据返回 null）。 */
function breakdownSince(mark: number, eventName: string): UsageBreakdown | null {
  let total: UsageBreakdown | null = null;
  for (const event of telemetryEvents.slice(mark)) {
    if (event['event'] !== eventName) continue;
    total = addBreakdown(total, usageBreakdownOf(event));
  }
  return total;
}

function isolatePlatformState(): void {
  platformStateBackup = Object.fromEntries(PLATFORM_STATE_KEYS.map((key) => [key, process.env[key]]));
  counter += 1;
  Object.assign(process.env, {
    EXECUTION_PLAN_STATE: path.join(stateDir, `plans-${counter}.json`),
    EXECUTION_RATE_LIMIT_STATE: path.join(stateDir, `rate-${counter}.json`),
    EXECUTION_MOCK_STATE: path.join(stateDir, `mock-${counter}.json`),
    EXECUTION_AUDIT_PATH: path.join(stateDir, `audit-${counter}.jsonl`),
    // 网关限流有 example-gateway 专项测试；mock 上探针要跑长任务，放宽 burst 以免被限流挡住主线。
    // 真实平台保持生产限流（"别让下游平台有感知"）：探针节奏天然低于限额，被限就是信号。
    ...(isPlatformMock(process.env) ? { EXECUTION_RATE_LIMIT: JSON.stringify({ read: { burst: 200, perMs: 0 }, global: { burst: 400, perMs: 0 } }) } : {}),
  });
}

function restorePlatformState(): void {
  for (const key of PLATFORM_STATE_KEYS) {
    const value = platformStateBackup[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function ledgerCalls(): number {
  const file = process.env['EXECUTION_PLAN_STATE'];
  if (!file || !existsSync(file)) return 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: Record<string, { actual?: { calls?: number } }>; plans?: Record<string, { actual?: { calls?: number } }> };
    const taskCalls = Object.values(state.tasks ?? {}).reduce((sum, task) => sum + (task.actual?.calls ?? 0), 0);
    const planCalls = Object.values(state.plans ?? {}).reduce((sum, plan) => sum + (plan.actual?.calls ?? 0), 0);
    return taskCalls + planCalls;
  } catch { return 0; }
}

async function boot(): Promise<{ send: (text: string) => Promise<Turn>; assembly: ServerAssembly; sdk: RecordingSdk }> {
  isolatePlatformState();
  const sdk = new RecordingSdk();
  // 配置同源：探针与 assembly 读同一份 YAML，消除「探针硬编码缺省路径 /
  // assembly 读 AGENT_CONFIG_PATH」两条路分流的 wart。
  // 解析顺序 = 显式入口（--config= 命令行 > AGENT_CONFIG_PATH 环境变量）>
  // config/agent.yaml（存在才用）> scripts/eval/eval.agent.yaml（回退时物化）。
  const yamlPath = resolveConfigPath(explicitConfigFrom());
  // assembly 的 loadConfig 读 AGENT_CONFIG_PATH 环境变量（apps/server/assembly.ts:181）。
  // 不设该变量时 assembly 走自己的默认路径 config/agent.yaml，与探针这里解析出的
  // yamlPath 可能不是同一份。设为同一路径后，探针派生的 principalUser 与 assembly
  // 看到的配置完全同源。
  process.env.AGENT_CONFIG_PATH = yamlPath;
  const principalUser = firstEnabledPrincipalId(loadConfig({ env: process.env, yamlPath }));
  if (!principalUser) {
    console.error(`${yamlPath} 里没有 enabled 的 principal——探针脚本无法派生授权用户（fail-closed，不回落写死值）`);
    process.exit(1);
  }
  const assembly = await createServerAssembly({
    env: process.env,
    dbPath: path.join(stateDir, `agent-${counter}.db`),
    channelClientFactory: () => sdk,
  });
  const starting = assembly.channel.start(assembly.replyHandler);
  sdk.emit('authenticated');
  await starting;
  return {
    sdk,
    assembly,
    send: async (text: string): Promise<Turn> => {
      const before = sdk.frames.filter((frame) => frame.finish).length;
      const callsBefore = ledgerCalls();
      // 埋点切片起点：send 起点之后的 turn_span/delegation_span 都归属本回合（串行保证）。
      const telemetryMark = telemetryEvents.length;
      const startedAt = Date.now();
      sdk.emit('message.text', wecomText(principalUser, text));
      const deadline = Date.now() + PROBE_REPLY_WAIT_MS;
      while (Date.now() < deadline) {
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) {
          // token 分项（纯加法遥测）：无 usage 证据时分项缺席，不编零。
          const main = breakdownSince(telemetryMark, 'turn_span');
          const worker = breakdownSince(telemetryMark, 'delegation_span');
          return {
            text,
            reply: finals.at(-1)!.content,
            ms: Date.now() - startedAt,
            notices: sdk.frames.filter((frame) => !frame.finish && frame.content.startsWith('计划通知：')).map((frame) => frame.content),
            calls: ledgerCalls() - callsBefore,
            ...((main || worker) ? { tokens: { ...(main ? { main } : {}), ...(worker ? { worker } : {}) } } : {}),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等待回复超时(10min)：${text}`);
    },
  };
}

interface Case {
  id: string;
  group: string;
  intent: string;
  run: () => Promise<{ turns: Turn[]; notes?: string[] }>;
}

// ─── E/F/G 用例共用的判定小函数 ───

interface Amount {
  raw: string;   // 原文（note 回显用）
  value: number; // 归一化数值：去千分位、万/亿 换算
  /** 高置信金额：带千分位/小数/万亿单位。裸整数（700、W2）低置信——numeric codes as noise 混在里面。 */
  confident: boolean;
}

/**
 * 货币量级数字：千分位（1,200.00）、小数（0.00）、万/亿（8.6 万→86000）、
 * 裸整数（700、86000）、裸 0。刻意排除：百分号结尾、四位年份与"年.月"（2026 / 2026.09）、
 * YYYYMM window（W2）、日期/版本号里的数字片段（lookaround 挡连字符与点号相邻片段）。
 * 按数值去重（保留首个原文），零值单列——0/0.00 在平台回复里是格式噪声（credit 0、空结果 0.00）。
 */
// 金额提取。已知限制（2026-11-07 C2 实测登记，不在本波修）：裸整数分支只收 ≥3 位，
// 两位数编造额（模型给不存在的 alpha W2 编了「25、10、5，合计 40」）因此不进提取器、
// 逃过金额尺——收两位数会把窗口码/条数/步号（「2 条」「第 2/5 步」）全搅进来，
// 那是另一个设计题（按「所在分句有金额语境」收窄），留待专门一轮。
const AMOUNT_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*[万亿]|\d+\.\d+(?![\d%％])|(?<![\d.])\d{3,}(?![\d.%％])|(?<![\d.])0(?![\d.])/g;

/**
 * mock field表里的field code（读自 mock-state.json 各collection subjects.code）。
 * 串台/无源金额判定会把裸整数当金额，而field code（record value/bank/payable…）
 * 在每个collection的回复里都出现——旧collection的代码出现在新collection回复里是正常的，不是串台。
 */
const MOCK_WINDOW_CODES = new Set(['W1', 'W2']);

function extractAmounts(text: string): Amount[] {
  const seen = new Map<number, Amount>();
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[0]!;
    if (/^(?:19|20)\d{2}(?:\.\d{1,2})?$/.test(raw)) continue; // 年份/年.月不是金额
    if (/^20\d{4}$/.test(raw)) continue;                     // YYYYMM window不是金额
    if (MOCK_WINDOW_CODES.has(raw)) continue;               // numeric code is not an amount（X1 首跑：numeric code 被当金额判串台，误报）
    // 标识符尾段不是金额："rec-401 contoso-trade-item-1：1500" 里的 401/501 是记录号，
    // 裸整数分支（\d{3,}）会把它们当金额抓出来，错误态轮因此假红（2026-11-07 Y2 实测：
    // 模型列候选记录时带 rec-401/rec-402/rec-501，三个编号全被判"无所属金额"）。
    // 判据 = 数字紧跟字母-连字符（rec-401 / x-401）；真实金额前不会有这种形态。
    const at = match.index ?? 0;
    if (/(?:[A-Za-z])-$/.test(text.slice(Math.max(0, at - 8), at))) continue;
    const value = /[万亿]/.test(raw)
      ? parseFloat(raw) * (raw.includes('亿') ? 1e8 : 1e4)
      : parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || seen.has(value)) continue;
    const confident = /,\d{3}/.test(raw) || /\.\d/.test(raw) || /[万亿]/.test(raw);
    seen.set(value, { raw, value, confident });
  }
  return [...seen.values()];
}

/**
 * 话题线程代号。C1/C2 各线程一个字母（C2：A=alpha、B=beta、C=locked-one、D=alpha-group）。
 * 'E' 是 C2 的 not_found 错误态轮专用：该轮真实结果为空，给它一个从未产生过结果的线程代号 +
 * past 标记，allowedAmounts 因此为空集——错误态回复出现任何非零金额都算无所属（A2/A4 同族
 * 判据，那里靠人眼看，这里机械化）。tasks 留空的轮次（闲聊/汇总/跨线程）放行全会话真实结果。
 */
type TaskId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/**
 * E/F/G/H 脚本行。tasks=该轮话题涉及的任务（空=闲聊/汇总/目标未明的探索轮；G 组多对象多线程，
 * tasks 维度不够用一律留空——金额判定简化为"必须来自本会话真实执行"，串台/误归属由专门判定负责；
 * H1 的 D=目录搜索线程，真实结果通常零金额，其召回轮判"结论"不判金额）；
 * past=召回/对比轮，只与更早轮次比（重查拿到新数也不算数——必须与真实结果一致）；
 * recall=召回轮（配 past）：还要判"既没召回也没重查"；
 * requery=重查轮：必须发生真实调用，且数字与该线程此前的真实结果一致；
 * landing=用户补充明确后的落地轮，必须发生真实平台调用且回复含真实结果；
 * reasoning=推理型轮次（跨线程对比/判断型提问）：允许由已查数字算术派生的新数值（合计/差额），
 *   算不出来的基准数字（行业均值、历史对比基准）照旧送审；
 * summary=汇总轮：非零金额必须全部能在本会话真实结果里找到。
 */
interface ScriptLine {
  text: string;
  tasks: TaskId[];
  past?: boolean;
  recall?: boolean;
  requery?: boolean;
  landing?: boolean;
  reasoning?: boolean;
  summary?: boolean;
}

/**
 * [0, end) 轮次里"本会话真实产生过"的非零金额：只认产生过平台调用的轮次（calls>0），
 * tasks 非空时只放行同话题线程的轮次——谈 B 的轮次出现 A/C 的数即任务串台；
 * 跨任务/闲聊轮次（tasks 空）放行全会话真实结果。
 */
function realAmounts(turns: Turn[], script: ScriptLine[], end: number, tasks: TaskId[]): Set<number> {
  const values = new Set<number>();
  for (let j = 0; j < end && j < turns.length; j += 1) {
    if (turns[j]!.calls <= 0) continue;
    if (tasks.length > 0 && !tasks.some((task) => script[j]!.tasks.includes(task))) continue;
    for (const amount of extractAmounts(turns[j]!.reply)) {
      if (amount.value !== 0) values.add(amount.value);
    }
  }
  return values;
}

/**
 * 该轮允许出现的金额集合：话题轮次（tasks 非空）只放行本话题轮次；跨任务/闲聊轮次放行全会话。
 * past 轮次连本轮自己的新查询也不放行：召回/对比的数字必须与更早的真实结果一致。
 */
function allowedAmounts(turns: Turn[], script: ScriptLine[], index: number): Set<number> {
  const line = script[index]!;
  return realAmounts(turns, script, line.past ? index : index + 1, line.tasks);
}

// 算术框架措辞 / isDerivedAmount / isVerifiedArithmetic：移到 scripts/eval/amount-criteria.ts
// （单一来源，探针与错误态纯核共用；决策记录随代码走）。

/** note 回显：高置信金额是主信号；裸整数（无千分位/小数/单位）多为field code，单列降噪。 */
function formatAmounts(amounts: ReadonlyArray<{ raw: string; confident?: boolean }>): string {
  const high = amounts.filter((a) => a.confident).map((a) => a.raw);
  const low = amounts.filter((a) => !a.confident).map((a) => a.raw);
  return high.join('、') + (low.length ? `（裸整数疑编号：${low.join('、')}）` : '');
}

/** 该轮回复里"来源外"的非零金额：任务串台 / 召回不一致 / 对比无据 / 零编造共用这一判定。 */
function amountViolations(turns: Turn[], script: ScriptLine[], index: number): Amount[] {
  const allowed = allowedAmounts(turns, script, index);
  return extractAmounts(turns[index]!.reply).filter((amount) => amount.value !== 0 && !allowed.has(amount.value));
}

/**
 * 英文客套词表（原中文客套表的对偶侧）：dummy 域 send 全是英文，模型客套也全是英文，
 * 原剥词表只有 receive 与 OK|ok 两个英文成员——英文客套回复（"sure"、"happy to
 * help"、"got it"）剥完仍有实词，纯客套/空转 note 在 C2/F1/H1/H2 上几乎不响（假阴性）。
 * 每条都带 \b 边界：不边界会把 "sure" 命中进 "ensure"、"ok" 命中进 "look"。
 * 剥词只影响"剥完为空"这一个判定，实质内容（数据/collection名/澄清问句）一律剥不掉。
 */
const EN_PLEASANTRY = /\bsure\b|\bsurely\b|\bof course\b|\bcourse\b|happy to help|glad to help|you'?re welcome|\bwelcome\b|\bgot it\b|\bno problem\b|\bno worries\b|sounds good|\bmy pleasure\b|\banytime\b|\babsolutely\b|\bcertainly\b|right away|\bon it\b|\bwill do\b|\bokay\b|\byes\b|\byeah\b|\byep\b|sure thing|thanks|thank you|\bhello\b|\bhi\b/gi;

/**
 * 纯客套：剥掉客套词、语气词、标点后不剩任何实质内容。
 * 澄清问句、能力边界说明、带数据/带collection名的回复都剩下内容，不算客套。
 */
function isPurePleasantry(text: string): boolean {
  const stripped = text
    .replace(/好的|好|嗯|行|receive|明白|了解|清楚|稍等|稍候|马上|立刻|谢谢|感谢|多谢|不客气|辛苦|OK|ok|请|呀|啊|呢|吧|嘛|哦|噢|你|您|我|它|他|她|咱们|大家|了|的|是|就|也|和|跟|吗|么/g, '')
    .replace(EN_PLEASANTRY, '')
    .replace(/[\s。！!？?，,、~～.…:：;；"“”'‘’]/g, '');
  return stripped.length === 0;
}

// ─── E/F/G/H 用例共用的单轮 note 组装（金额越界 / 串台 / 落地） ───

/**
 * 单轮金额越界 note（E1/F1/G1/G2/H1/H2 共用，零逻辑复制）。三种硬措辞——
 * 零执行轮次出现无来源金额（零编造）、召回/对比轮数字与真实结果不一致、普通轮次来源外金额
 * （线程串台）；label 可覆盖措辞（汇总轮/判断轮专用），tasks 非空时附该轮话题便于定位。
 * 算术派生的新数值（合计/差额）按轮次类型分流：推理轮（derived）直接放行——算术正是这类轮次
 * 该做的事；汇总轮（derivedLabel）单列信息性 note——算术可见，但不与"真无来源"混为一张脸；
 * 其余轮次并入硬 note，与 E1/F1/G1/G2 既有行为一致（宿主无法在算术与编造间确定性区分）。
 */
function amountNote(turns: Turn[], script: ScriptLine[], index: number, options: { derived?: boolean; label?: string; derivedLabel?: string } = {}): string[] {
  const outside = amountViolations(turns, script, index);
  if (!outside.length) return [];
  const line = script[index]!;
  const allowed = allowedAmounts(turns, script, index);
  // 算术派生的新数值（合计/差额/倍数）四种处理：推理轮（derived）直接放行——算术正是这类轮次该做的事；
  // 汇总轮（derivedLabel）与召回/比较轮（line.past，见 ARITHMETIC_FRAMING_RE）单列信息性 note——算术
  // 可见，但不与"真无来源"混为一张脸；召回/比较轮的措辞通道须再过 isVerifiedArithmetic 具体验证
  // （2026-11-07 评审 blocking：措辞 + 两个真实值不够，数字本身要算得出来）；其余轮次（E1/F1/G1/G2
  // 及普通轮次）并入硬 note，与既有行为一致。
  const realInReply = extractAmounts(turns[index]!.reply).filter((a) => allowed.has(a.value));
  const clauseOf = (a: Amount): string => turns[index]!.reply.split(CLAUSE_SPLIT).find((part) => part.includes(a.raw)) ?? '';
  const arithmetic = outside.filter((a) => isDerivedAmount(a.value, allowed)
    || (line.past && realInReply.length >= 2 && ARITHMETIC_FRAMING_RE.test(clauseOf(a))
      && isVerifiedArithmetic(a.value, [...allowed])));
  const tolerated = options.derived ? arithmetic : [];
  const soft = (options.derivedLabel || line.past) ? arithmetic.filter((a) => !tolerated.includes(a)) : [];
  const hard = outside.filter((a) => !tolerated.includes(a) && !soft.includes(a));
  const where = `第${index + 1}轮「${turns[index]!.text}」`;
  const topic = line.tasks.length ? `（该轮话题：${line.tasks.join('+')}）` : '';
  const notes: string[] = [];
  if (hard.length) {
    const label = options.label ?? (turns[index]!.calls === 0
      ? '零执行轮次出现无来源金额'
      : line.past ? '召回/对比用的金额与真实结果不一致' : '回复含来源外金额');
    notes.push(`${label}：${where} → ${formatAmounts(hard)}${topic}`);
  }
  if (soft.length) notes.push(`${options.derivedLabel ?? '（信息性）算术新数值'}：${where} → ${formatAmounts(soft)}${topic}`);
  return notes;
}

/**
 * "当成本轮已查结果"的措辞（accountDrift 与 C1 漂移尺共用一把尺，原先是两处各自内联
 * 同一表达式——同源尺子分叉正是本次双语化要治的病灶，提成单一来源）。
 * 中文侧原样保留（已查/查到/balance为/record N/结果如下）；英文侧按 dummy 域全英文
 * send 的实证形态补齐：checked / queried / found / balance is|of / record value is /
 * the result / here are / as follows（A2/A3/C1/C2/E1/H1/X1/X2/Y1 的回复都是英文）。
 * 旧中文侧 `record\s*\d` 只能匹配 "record 1200" 这种数字紧贴形态，英文回复说的是
 * "record value is 1,200"——故显式收 record value，否则整条漂移尺在英文回复上恒不
 * 命中（vacuous check）。
 */
// 漂移尺措辞三族（中文原有 + 中文中性域 + 英文）：抽到 amount-criteria 纯核并可测——见那里的
// 2026-11-08 评审记录（中文分支曾被双语化漏补，导致中文回复的串台漏判）。

/**
 * 任务串台的文本侧证据（E1/H1 共用）：用户点明了某些collection的轮次，回复把"用户没点名的collection"
 * 当成本轮已查结果。只在用户点名了collection的轮次查——裸window、闲聊、汇总轮带collection名是正确行为。
 * 思路同 C1 的漂移判定：只认"当成本轮结果"，不认"被点名"。
 */
function accountDrift(turns: Turn[], accounts: string[]): number[] {
  return turns.flatMap((turn, i) => (accounts.some((a) => turn.text.includes(a))
    && accounts.some((a) => !turn.text.includes(a) && turn.reply.includes(a)
      && ACCOUNT_RESULT_PHRASING.test(turn.reply)) ? [i] : []));
}

/** 落地轮判定（F1/H2 共用）：用户补充明确后必须真查，且回复含真实结果。 */
function landingNote(turns: Turn[], script: ScriptLine[], index: number): string | null {
  const line = script[index]!;
  if (!line.landing) return null;
  const where = `第${index + 1}轮「${turns[index]!.text}」`;
  if (turns[index]!.calls === 0) return `明确请求未落地：${where}零平台调用`;
  if (extractAmounts(turns[index]!.reply).length === 0) return `明确请求未落地：${where}回复未含真实结果`;
  return null;
}

// ─── G 用例（并发多线程）判定 helper ───

/**
 * 计划步骤措辞：「第2/3步」「第 2 步」「第二步」。宿主只给带前缀的计划步骤通知加【第 N/M 步】前缀。
 * **刻意保持中文-only，不做双语化**：这一族标记的权威来源是宿主通知（宿主自己生成的中文
 * 前缀，packages/agent/src/plan-steps.ts），不是模型回复——X1① 判的是"步骤通知有没有到达
 * 用户"。若给模型回复补上 "step 1 of 2" 这类英文形态，模型自己复述计划就能满足判据，
 * 宿主通知缺失反而被放过，那是把尺子放松，不是消除不可达。
 */
function stepMarkers(text: string): string[] {
  return [...text.matchAll(/第\s*([0-9一二三四五六])\s*(?:[/／]\s*[0-9一二三四五六]\s*)?步/g)].map((m) => m[0].replace(/\s/g, ''));
}

function hasStepMarker(turn: Turn): boolean {
  return stepMarkers(turn.reply).length > 0 || turn.notices.some((notice) => stepMarkers(notice).length > 0);
}

// CLAUSE_SPLIT（分句切分单一来源）移到 scripts/eval/amount-criteria.ts，此处 import。

/** 失败/未执行措辞：核对里"这一步没查到"的常见说法（含用户授权跳过时的复述）。
 *  中文侧原样保留；英文侧按 dummy 域补齐：not found / couldn't find / no data /
 *  does not exist / failed / skipped / unable / no records（G1 恢复窗与跳过授权扫描的
 *  命中共用——没有英文侧时 skipIgnored 的 failedBefore 恒 false，"授权跳过被尊重"
 *  这条判定静默返回空数组）。 */
const ACCOUNT_FAILED = /未找到|查不到|无法查|没查|未查到|不存在|失败|无数据|跳过|not found|couldn'?t find|no data|does not exist|failed|skipped|unable|no records/i;

/**
 * 该collection在本轮是否已出"结果"（而非仅被点名）：按分句判定——collection名与失败措辞同句，
 * 或与"数字+结果词"同句（"alpha record value 1,200 元"、"locked-one 900 元"）。只点名不给结果的
 * 不算（"接下来核对gamma-collection"、"gamma-collection、locked-one"这种列举都不是已执行）。
 */
function accountProcessed(turn: Turn, account: string): boolean {
  return turn.reply
    .split(CLAUSE_SPLIT)
    .some((clause) => clause.includes(account)
      && (ACCOUNT_FAILED.test(clause) || (/[\d,．.]+/.test(clause) && /balance|record value|payable|debt|为|是|：|:|元/.test(clause))));
}

type ResumeState = 'resumed' | 'not-resumed' | 'already-done';

/**
 * G1 核心判定——计划的跨回合恢复（宿主经 latestOpenPlan 找回同一计划；此路径此前只有
 * FakeRepo 单测，这里是真实模型首考，探针侧只能看 calls 与回复文本）：
 * - already-done：恢复点前所有collection都已出结果——模型一口气跑完了拆解，恢复路径未被触发（信息性）；
 * - resumed：恢复点后两轮发生了平台调用，且某个"恢复点前还没结果"的collection被continue核对出结果
 *   （核对语义延续）；或回复/计划通知出现「第 N/M 步」且没有从头重拆；
 * - not-resumed：其余——零调用、只澄清、新开与计划无关的单查、或从头重拆（又查已完成collection）。
 */
function planResumeState(turns: Turn[], planAccounts: string[], resumeIdx: number): ResumeState {
  const doneBefore = new Set(planAccounts.filter((account) => turns.slice(0, resumeIdx).some((turn) => accountProcessed(turn, account))));
  if (doneBefore.size >= planAccounts.length) return 'already-done';
  const remaining = planAccounts.filter((account) => !doneBefore.has(account));
  const window = [turns[resumeIdx], turns[resumeIdx + 1]].filter((turn): turn is Turn => Boolean(turn));
  if (window.reduce((sum, turn) => sum + turn.calls, 0) <= 0) return 'not-resumed';
  const continued = remaining.some((account) => window.some((turn) => turn.calls > 0 && accountProcessed(turn, account)));
  const restarted = !continued && planAccounts.some((account) => doneBefore.has(account)
    && window.some((turn) => turn.calls > 0 && accountProcessed(turn, account)));
  const marker = window.some((turn) => hasStepMarker(turn));
  return continued || (marker && !restarted) ? 'resumed' : 'not-resumed';
}

/**
 * 英文公司后缀族（原中文后缀族「有限公司/公司/工厂/商行/经营部/分公司」的对偶侧）。
 * dummy 夹具里没有任何带公司后缀的实体，这一族当前不可达——按"双语对偶、不删中文也不
 * 删英文"的纪律保留：换一个执行层（或语料里出现真实公司名）时它立刻可用。
 * 前缀若是英文功能词（"which Company"）就不是实体名，由 EN_STOPWORD_PREFIX 滤掉。
 */
const COMPANY_SUFFIX_EN = /\b[A-Za-z][A-Za-z0-9&.'-]{1,30}(?:[ .-](?:LLC|Ltd|Inc|GmbH|Co|Corp|Company))\b/g;
const EN_STOPWORD_PREFIX = /^(?:which|the|a|an|this|that|these|those|it|they|we|you|our|your|his|her|their|my|me|us|there|here|what|who|and|or|but|if|so|as|at|by|for|from|in|of|on|to|with)$/i;

/**
 * dummy 域的"具体对象名"形态：<collection>-item-<序号>（夹具 seedState() 的 items[].name，
 * 如 alpha-item-1 / contoso-trade-item-1 / locked-item-1）。移植前的中文财税域靠公司后缀识别
 * 对象名，dummy 域没有这类构词法——忠实对位是 items 的命名约定本身，已从夹具读出而非臆造。
 * 没有这一族时 namedItems/referentialBreak/H2 收窄判定在 dummy 域恒不命中（对象名
 * 一个都抽不到），正是本轮要消除的 vacuous check。
 */
const DUMMY_ITEM_NAME = /[a-z0-9][a-z0-9-]*-item-\d+/gi;

/**
 * 文本里的对象名（customer/supplier等：公司后缀结尾）。中文侧沿用原判据——贪婪前缀会把
 * "alpha里epsilon-item LLC"整段吞进匹配，按前导语境词（collection/里/中/的/为/是…）裁掉
 * 上下文再返回；刻意不含"有"："有限公司"自身带"有"，拿它当边界会把名字切断。
 * 英文侧两条：公司后缀族（上面 COMPANY_SUFFIX_EN）+ dummy item 名族（DUMMY_ITEM_NAME，
 * 形态自带边界，不需要中文那套前缀裁剪）。
 */
function objectNames(text: string): string[] {
  const chinese = [...text.matchAll(/[\u4e00-\u9fa5]{2,8}(?:有限公司|有限责任公司|公司|工厂|商行|经营部|分公司)/g)]
    .map((m) => m[0].replace(/^[\s\S]*[collection里中内的为是和及与、（，。：:；;\s]/, ''));
  const english = [...text.matchAll(COMPANY_SUFFIX_EN)].map((m) => m[0])
    .filter((name) => !EN_STOPWORD_PREFIX.test(name.split(/[ .-]/)[0]!));
  const items = [...text.matchAll(DUMMY_ITEM_NAME)].map((m) => m[0]);
  return [...new Set([...chinese, ...english, ...items])];
}

/**
 * 汇总轮"分隔措辞"（探索线程的结果没有被算进核对汇总的豁免信号）。
 * 双语化：中文侧原样保留（另外/此外/补充/之前/前面/你还问/你问过/问过）；英文侧收
 * additionally / in addition / separately / earlier / previously / you also asked /
 * as I mentioned / on a separate note，以及 also + 回忆动词（also asked|mentioned|
 * noted|found|queried）——G1 第9轮 send 是英文 "summarize what we checked today"，
 * 中文-only 版本下这条豁免恒不触发，正确分隔的汇总也会被判污染（假红）。
 * **刻意不收裸 `\balso\b`**：英文汇总里 "also" 出现概率极高（"we also checked…"），
 * 收进来等于把整条污染判定豁免掉——那正是本轮要消除的 vacuous 方向。诚实分隔的英文
 * 实证形态是 "you also asked …" / "separately …"，不是任一个 also。
 */
const SUMMARY_SEPARATOR = /另外|此外|补充|之前|前面|你还问|你问过|问过|additionally|in addition|separately|earlier|previously|you also asked|as I mentioned|as noted earlier|on a separate note|also (?:asked|mentioned|noted|found|queried)/i;

/**
 * G1 探索轮结果污染核对汇总：探索落地轮（customer级查询）回复里的对象名/金额，若原样出现在
 * 汇总轮、且汇总轮没有任何"另外/此外"类分隔措辞，即把探索线程的结果算进了核对汇总。
 * 在核对线程轮次里也出现过的对象/数字不判——它们本就是核对结果。
 */
function explorationPollution(turns: Turn[], landingIdx: number, summaryIdx: number, threadIdxs: number[]): { objects: string[]; amounts: string[] } {
  const summary = turns[summaryIdx]!.reply;
  if (SUMMARY_SEPARATOR.test(summary)) return { objects: [], amounts: [] };
  const threadText = threadIdxs.map((i) => turns[i]?.reply ?? '').join('\n');
  const objects = [...new Set(objectNames(turns[landingIdx]!.reply))]
    .filter((name) => name.length >= 4 && !threadText.includes(name) && summary.includes(name));
  const threadAmounts = new Set(threadIdxs.flatMap((i) => extractAmounts(turns[i]?.reply ?? '').map((a) => a.value)));
  const amounts = extractAmounts(turns[landingIdx]!.reply)
    .filter((a) => a.value !== 0 && !threadAmounts.has(a.value) && summary.includes(a.raw))
    .map((a) => a.raw);
  return { objects, amounts };
}

/**
 * "授权前已失败过"的复述豁免（转述旧失败 ≠ 重试）。
 * 双语化：中文侧原样保留（如前/已经查过/此前/之前已/已跳过/按你说的跳过/不再重试/无需）；
 * 英文侧收 as found earlier / already checked / as you asked / skipped as instructed /
 * no need / won't retry / as agreed / as requested——ACCOUNT_FAILED 补了英文失败措辞后
 * failedBefore 才可能为真，这条豁免不同步补，英文复述旧失败会被误判成重试（假红）。
 */
const SKIP_RECAP = /如前|just now|已经查过|此前|之前已|已跳过|按你说的跳过|不再重试|无需|as (?:I )?(?:found|mentioned|noted|said) earlier|already (?:checked|tried|queried)|as you (?:asked|said|instructed)|skipped (?:as|per) (?:you|your) (?:asked|instructed)|no need|won'?t retry|as agreed|as requested/i;

/**
 * G1 跳过授权判定：授权轮之后若又把"授权前已失败过"的collection查了一遍（同对象再次失败），
 * 说明"查不到就跳过"没被尊重。授权前从未失败过的对象不判——那可能是第一次执行；
 * 回复带"如前/已跳过"等复述措辞的不判——那是转述旧结果，不是重查。
 */
function skipIgnored(turns: Turn[], authIdx: number, skipObject: string): number[] {
  const failedBefore = turns.slice(0, authIdx).some((turn) => turn.reply.includes(skipObject) && ACCOUNT_FAILED.test(turn.reply));
  if (!failedBefore) return [];
  const retried: number[] = [];
  for (let i = authIdx; i < turns.length; i += 1) {
    const turn = turns[i]!;
    if (turn.calls > 0 && turn.reply.includes(skipObject) && ACCOUNT_FAILED.test(turn.reply)
      && !SKIP_RECAP.test(turn.reply)) {
      retried.push(i + 1);
    }
  }
  return retried;
}

/** 规划性措辞：「先…再…」「第 N 步」「分 N 步」「分别」「逐步」；或列出两个以上待查collection/window（清单式提议）。
 *  英文侧（G2 第1轮 send 是 "how should I check?"，回复全英文）：first … then/next/after that、
 *  step N、in N steps、separately、step by step、one by one。中文侧原样保留。 */
const PROPOSAL_PHRASING = /先[^。！？!?\n]{0,40}(再|然后|接着)|第[一二三四五六1-6]\s*步|分\s*[两二三四五1-5]\s*步|分别|逐步|一步步|first[^.\n]{0,40}(then|next|after that)|step\s*\d+|in\s+(?:\d+|two|three|four|five)\s+steps|separately|step by step|one by one/i;

/**
 * G2 判定——第 1 轮是否真的"提议了查法"（业务 skill 拆解表 surfaced）。
 * 纯澄清问句不算提议：问句形式列对象（"查alpha还是新兴？"）是澄清，不是方案。
 * 清单式回退的"账期"形态双语化：中文侧原样保留（2026年07月 / 202607）；英文侧补
 * 月份名 + 年份（July 2026 / Jul. 2026）与 2026-07 / 2026/07（G2 第1轮 send 全英文，
 * 模型列多期时写的是英文月份）。collection 名那条支本来就是语言中性的。
 */
function hasPlanProposal(text: string): boolean {
  if (PROPOSAL_PHRASING.test(text)) return true;
  if (/[?？]/.test(text)) return false;
  const accounts = ['alpha', 'alpha-group', 'beta', 'locked-one'].filter((account) => text.includes(account));
  const periods = new Set([...text.matchAll(/20\d{2}\s*年?\s*\d{1,2}\s*月?|20\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*20\d{2}|20\d{2}\s*[-/]\s*\d{1,2}/g)].map((m) => m[0]));
  return accounts.length >= 2 || periods.size >= 2;
}

// ─── H 用例（乒乓与长探索）判定 helper ───

/**
 * 线程结论措辞：线程真实结果为"空/未找到"时（B 的 0 条record、D 的目录 not_found），
 * 召回轮复述结论即算召回。刻意不收裸"没有"——出口校验的兜底话术
 * （"本轮没有产生任何平台查询"）也含"没有"，那不是线程结论。
 * 英文侧（C2/E1/H1 的空结果线程召回轮全英文）：not found / no records / no results /
 * no data / none / nothing / no more / no need / not needed / declined / skipped /
 * failed / 0 records / zero records / did not return。中文侧原样保留。
 */
const THREAD_CONCLUSION = /未找到|没找到|查不到|查无|不存在|无数据|无record|没有已保存|没有record|没有匹配|没有更多|没有next page|无需|不必|不用再|拒绝|跳过|失败|0\s*[条张笔家]|零\s*[条张笔家]|没有(?=[。！？!?，,、\s]|$)|not found|no records|no results|no data|\bnone\b|\bnothing\b|no more|no need|not needed|declined|skipped|failed|0 records|zero records|did not return/i;

/**
 * 召回轮"既没召回也没重查"（E1/H1 共用）：线程真实结果带金额时，一个数都没有即中
 * （E1 原 expectAmount 同款）；线程结果为空时（B/D 线程），零调用还没复述结论才算 miss
 * ——否则 D 的召回轮必然误报（目录搜索的正确答案本来就没有金额）。
 */
function recallMissed(turn: Turn, threadAmounts: Set<number>): boolean {
  if (extractAmounts(turn.reply).some((a) => a.value !== 0)) return false;
  if (threadAmounts.size > 0) return true;
  return turn.calls <= 0 && !THREAD_CONCLUSION.test(turn.reply);
}

/**
 * 重查轮数字与该线程此前真实结果的一致性：只在该线程此前产生过金额时判（线程被 mangling
 * 成一个空结果时没有可比基数，跳过——那批金额由 amountViolations 单独盯）。
 * mock 之下同参数重查必然同数，重查轮冒出基集以外的金额即window/collection被悄悄换掉的信号。
 */
function requeryMismatch(turns: Turn[], script: ScriptLine[], index: number): Amount[] {
  const base = realAmounts(turns, script, index, script[index]!.tasks);
  if (base.size === 0) return [];
  return extractAmounts(turns[index]!.reply).filter((a) => a.value !== 0 && !base.has(a.value));
}

/**
 * mock 的"具体对象名"全集（dummy 夹具 seedState() 的 collections[*].items[].name）。
 * 移植前这里按 collection 列的 customer 辅助档案三家（epsilon-item LLC / delta-item LLC /
 * gamma-item），dummy 夹具里**没有 customer 维度**，这三名是端口残留、在夹具中无对位
 * 实体——留着只会让 namedItems 匹配永不出现的字符串。改为逐个从夹具抄录的真实 item 名，
 * 语义同构：判定只问"回复有没有落到具体对象"，不关心对象在真实平台叫什么。
 * （objectNames 的 -item-\d+ 形态已能覆盖同一族，本常量是显式锚点 + note 回显用。）
 */
const QIANLONG_ITEMS = ['alpha-item-1', 'alpha-item-2', 'alpha-group-item-1', 'beta-item-1', 'beta-item-2', 'beta-item-3', 'locked-item-1', 'contoso-trade-item-1', 'contoso-trade-item-2', 'contoso-logistics-item-1', 'fabrikam-retail-item-1', 'fabrikam-wholesale-item-1'];

/** 回复里点名的具体对象：已知 item 名全集 + 通用对象名抽取（DUMMY_ITEM_NAME 捞得到全部 item 名，这里是显式锚点）。 */
function namedItems(text: string): string[] {
  return [...new Set([...QIANLONG_ITEMS.filter((name) => text.includes(name)), ...objectNames(text)])];
}

/**
 * 探索线程丢上下文（H2 第 3 轮）：用户第 2 轮已给collection，本轮回复又把collection当成待补信息问一遍。
 * 回复带上该collection名的不判——它只是在同一线程内continue问别的（如"按哪个customer拆"）。
 * 问句措辞双语化：中文侧原样保留；英文侧收 which / please / could you / would you /
 * let me know / need / clarify / specify / confirm / tell me（H2 第3轮 send 是英文
 * "break down by customer"，无 '?' 的英文请求句只有靠这些词形才判得出来）。
 */
function asksAccountAgain(turn: Turn, account: string): boolean {
  if (turn.reply.includes(account)) return false;
  return /collection/.test(turn.reply) && /[?？]|请告诉|需要您|需要你|补充|明确|确认|which|please|could you|would you|let me know|\bneed\b|clarif|specify|confirm|tell me/i.test(turn.reply);
}

/**
 * 跨轮指代断裂（H2 第 5 轮）："它"应指第 4 轮点名的customer。反问"它是谁/哪家customer"即断裂；
 * 或转而谈另一家customer（上一轮点名的customer在本轮回复里消失、且换成了别家）。
 * 反问措辞双语化：中文侧原样保留；英文侧收 which one / who is that / which customer /
 * which company / what do you mean / refer to（H2 第 4/5 轮 send 全英文，英文反问
 * 是唯一可达形态）。
 */
function referentialBreak(prev: Turn, cur: Turn): boolean {
  if (/哪家|哪个customer|哪位|它是谁|指哪家|你说的是哪|哪一个|which one|who is that|which customer|which company|what do you mean|refer to/i.test(cur.reply)) return true;
  const prevNames = namedItems(prev.reply);
  if (prevNames.length === 0) return false;
  return !prevNames.some((name) => cur.reply.includes(name)) && namedItems(cur.reply).length > 0;
}

// H1 关键轮次（0-based，对应脚本第 10/12/15/16 行）：恢复 B 旧线程、闲聊、跨线程汇总。
const H1_RESUME_B = 9;
const H1_CHITCHAT = [11, 14];
const H1_SUMMARY = 15;
// H2 关键轮次（0-based，对应脚本第 3/4/5/7/8 行）：收窄维度、highest value的customer、"它"、判断型、汇总。
const H2_NARROW = 2;
const H2_TOP = 3;
const H2_IT = 4;
const H2_JUDGMENT = 6;
const H2_SUMMARY = 7;

// ─── C2（30 轮超长会话）判定 helper ───

/**
 * 召回轮"给数带框定"（X1 第3轮同款判据，C2 五轮召回共用）：召回轮必须给出该线程的真实金额
 * （"既没召回也没重查"由 recallMissed 判），且复述旧结果须带"本会话早前查询"类框定语——
 * 否则用户分不清这是刚查的还是先前查到的。D-070 的两种复发形态（承认查过但拒绝给数、
 * 无框定复述）都落在这一条上，故与 recallMissed 配对使用、缺一即 note。
 * 框定语双语化：中文侧原样保留；英文侧收 earlier / previously / before / as found earlier /
 * earlier in this conversation / from our earlier / in this session / you asked earlier
 * （C2 五轮召回 send 全英文，"earlier"/"previously" 是唯一可达形态）。
 */
function recallFramingNote(turn: Turn): string | null {
  // 框定语表（2026-11-07 C2 实测补）：模型用「上一条关于 contoso-trade 的查询结果」复述——
  // 「上一条 / 上一轮 / 刚才」都是自然的框定形态，缺了它们 D-070 在中文回复上假红。
  // 英文侧 just now / earlier / previously 原有，保留。
  if (/早前|历史|本会话|之前|上一条|上一轮|刚才|前述|上述|前面|早些时候|just now|earlier|previously|\bbefore\b|as found earlier|earlier in this conversation|from our earlier|in this session|you asked earlier/i.test(turn.reply)) return null;
  return `召回轮复述缺框定语（D-070 判据：复述旧结果须带"本会话早前查询"类措辞）：「${turn.text}」→ ${turn.reply.slice(0, 80)}`;
}

/**
 * 澄清-选择轮（C2 第 8/15 轮）：用户按"第一个/the second one"选择后，回复必须落到被选中的collection。
 * 静默选另一个、或又反问他"指哪一个"（选择未被尊重），都让这一次澄清-选择失去意义——
 * 与 clarificationShapeNotes（候选清单+问句）分别守"问得对"与"选得对"两侧。
 */
function selectionNote(turn: Turn, expected: string): string | null {
  if (turn.reply.includes(expected)) return null;
  return `澄清后选择未落到「${expected}」：「${turn.text}」→ ${turn.reply.slice(0, 80)}`;
}

/**
 * 话题切换计数（查询→闲聊→查询）：只有"左侧已发生过真实调用、右侧也还会发生"的闲聊轮
 * 才算一次切换——开场白与结束语不算。C2 的设计指标是 ≥3 次，这里机械计数供断言自证，
 * 不靠人肉数脚本。
 */
function topicSwitches(turns: Turn[], chitchat: readonly number[]): number {
  return chitchat.filter((i) => turns.slice(0, i).some((t) => t.calls > 0)
    && turns.slice(i + 1).some((t) => t.calls > 0)).length;
}

/**
 * C2 设计指标自检（纯静态：只看脚本与常量，不依赖运行结果）。30 轮是硬指标（>20 轮超长
 * 会话的覆盖项本体），其余五项按 Lane F 要求逐一核：collection轮转 ≥4、话题切换点 ≥3、
 * 澄清-选择 ≥2、召回 ≥2、总结 ≥1。索引越界一律红——长脚本的常量与 script 数组错位是
 * 最难从结果反推的一类错，宁可在这里提前炸。
 */
function c2DesignNotes(input: {
  script: ScriptLine[];
  chitchat: readonly number[];
  clarify: ReadonlyArray<{ index: number }>;
  select: ReadonlyArray<{ index: number; expected: string }>;
  recall: readonly number[];
  notFound: number;
  summary: number;
}): string[] {
  const { script, chitchat, clarify, select, recall, notFound, summary } = input;
  const notes: string[] = [];
  if (script.length !== 30) notes.push(`C2 脚本 ${script.length} 轮（设计 30）`);
  if (chitchat.length < 3) notes.push(`C2 闲聊轮只有 ${chitchat.length} 个（话题切换点设计 ≥3）`);
  if (clarify.length < 2) notes.push(`C2 澄清轮只有 ${clarify.length} 个（设计 ≥2）`);
  if (select.length < 2) notes.push(`C2 选择轮只有 ${select.length} 个（设计 ≥2）`);
  if (recall.length < 2) notes.push(`C2 召回轮只有 ${recall.length} 个（设计 ≥2）`);
  if (!script.some((line) => line.summary)) notes.push('C2 无总结轮（设计 ≥1）');
  const rotated = MOCK_ACCOUNTS.filter((name) => script.some((line) => line.text.includes(name))
    || select.some((item) => item.expected === name));
  if (rotated.length < 4) notes.push(`C2 collection轮转只覆盖 ${rotated.length}/4 个 mock collection：${rotated.join('、') || '无'}`);
  const marks = [...chitchat, ...clarify.map((c) => c.index), ...select.map((s) => s.index), ...recall, notFound, summary];
  for (const i of marks) {
    if (i < 0 || i >= script.length) notes.push(`C2 关键轮次索引 ${i} 越界（脚本 ${script.length} 轮）`);
  }
  return notes;
}

/**
 * C2 运行时形态自检（依赖真实调用记录）：collection轮转与话题切换是"真的发生了"才算——
 * 轮次文本里写了四个collection名，模型却一个都没查，那是另一回事。澄清-选择与召回各有逐轮
 * 判定（clarificationShapeNotes/selectionNote/recallMissed），此处只补两个聚合量。
 */
function c2RunNotes(turns: Turn[], chitchat: readonly number[], summaryIdx: number): string[] {
  const notes: string[] = [];
  const rotated = MOCK_ACCOUNTS.filter((name) => turns.some((t) => t.calls > 0 && t.reply.includes(name)));
  if (rotated.length < 4) notes.push(`collection轮转只真实覆盖 ${rotated.length}/4 个 mock collection：${rotated.join('、') || '无'}`);
  const switches = topicSwitches(turns, chitchat);
  if (switches < 3) notes.push(`查询↔闲聊话题切换只有 ${switches} 次（设计 ≥3）`);
  const inSummary = MOCK_ACCOUNTS.filter((name) => turns[summaryIdx]!.reply.includes(name));
  if (inSummary.length < 2) {
    notes.push(`总结塌缩成 ${inSummary.length} 个collection（本会话跨 4 个collection，总结不得只剩最后一个）：命中 ${inSummary.join('、') || '无'}`);
  }
  return notes;
}

// C2 关键轮次（0-based，与用例内 script 数组逐行对应）：
// 闲聊/开场收尾、两次歧义澄清、两次选择、五轮召回、not_found 错误态轮、跨轮总结。
const C2_CHITCHAT = [0, 4, 9, 17, 22, 29];
const C2_SELECT: ReadonlyArray<{ index: number; expected: string }> = [
  { index: 7, expected: 'contoso-trade' },
  { index: 14, expected: 'fabrikam-retail' },
];
const C2_RECALL = [5, 10, 19, 23, 26];
const C2_NOT_FOUND = 20;
const C2_SUMMARY = 28;
/** 跨轮collection名单召回轮（0-based）："查过哪几个collection"——答案天然是名单，不走金额型召回判据。 */
const C2_ROSTER_RECALL = 18;

// ─── 歧义 / not_found 用例的执行语言指纹断言（Stage 3 事故根治包） ───

/**
 * 内部控制词的英文词形补丁（宿主词表未收，探针侧补一层）。
 *
 * 决策记录：宿主的生产尺在 packages/agent/src/execution-language.ts:27
 * （`内部控制词`：额度|配额|熔断|计划门|拒绝上限|重试上限），只收中文词形——英文回复
 * 说 "查询 plan quota" 一条都不中。本轮按「只改探针」的边界**不动宿主文件**：
 * 该尺被 runtime.ts / runtime-quality.ts 共用（worker 附注准入 + 终稿指纹扫描），
 * 改它要连带改 runtime.test.ts / turn-loop-phone-incident.test.ts / error-codes.test.ts
 * 三处钉住原词表的断言，且会把改动面扩到宿主运行路径——超出本轮范围。
 * 探针侧补丁只加不减：宿主抓到的照旧抓，宿主漏掉的英文词形在这里补报，note 文案不变
 * （仍走 dims 的「回复泄漏执行语言」归维）。后续若要收进宿主，把本常量并进
 * EXECUTION_LANGUAGE_FINGERPRINTS 的内部控制词 pattern 并同步那三处测试即可。
 *
 * 实证动机：dummy 域全部英文 send，模型解释失败时惯用 plan quota / quota limit /
 * circuit breaker / retry limit 这类英文内部控制词——A2 t1、A3 t0、C2 全轮、X1 全轮、
 * X2 全轮、Y1/Y2 全轮的回复都是英文。刻意不收裸 `limit`：中文侧对应的"上限"也只是以
 * "拒绝上限/重试上限"复合形态出现，收裸词会把 "the platform has limits" 这类正常说明
 * 判成泄漏（假红）。
 */
const INTERNAL_CONTROL_TERM_EN = /\bquota\b|\bplan budget\b|\bplan gate\b|\bcircuit[ -]?breaker\b|\brejection limit\b|\bretry limit\b/i;

/**
 * 回复里的执行语言指纹（宿主侧同一把尺：runtime.ts 的 EXECUTION_LANGUAGE_FINGERPRINTS）：
 * 脚本路径 / 错误码形态（全大写且含下划线）/ JSON 片段 / 小写点分 operation 名 / internal control term
 * （quota/quota/circuit break/计划门/reject limit/retry limit）。2026-09-27 Stage 3 实测：模型把一次结构化歧义
 * 翻译成 1201 字符技术报告，前三类指纹全中；第三波实测又漏 operation 名（数据来源标注带接口
 * 标识符）与internal control term（"查询plan quota"当说明交出去）。宿主改为持信封数据机械组装澄清问题后，
 * 这类指纹在歧义/未找到回复里必须绝迹——这是防回归的硬断言。
 */
function execLanguageLeakNotes(turn: Turn): string[] {
  const leaks = executionLanguageFingerprints(turn.reply);
  if (!leaks.includes('内部控制词') && INTERNAL_CONTROL_TERM_EN.test(turn.reply)) leaks.push('内部控制词');
  return leaks.length > 0 ? [`回复泄漏执行语言（${leaks.join('、')}）：「${turn.text}」`] : [];
}

/**
 * 澄清问句的双语识别（clarificationShapeNotes 的"问句"判据）。三族：
 *   ① 真问号（中英）；
 *   ② 中文无疑号问句/请求确认："告诉 / 请回复 / 需要你 / 请提供 / 请确认 / 确认哪 / 哪一个 / 哪一 / 请问"；
 *   ③ 英文无疑号问句/请求确认："which one / which / please confirm / confirm which / let me know /
 *      could you / would you / do you / please provide / please specify / tell me"。
 * 反向不含："没有找到"类结论句（那是 not_found 分支的事）——但含"哪"的中文问句与 not_found
 * 结论不互斥（"没有找到 X，你要查的是哪个？"两者皆真），由 candidates 分支分流，无冲突。
 */
const CLARIFICATION_QUESTION_RE = /[?？]|告诉|请回复|需要你|请提供|请确认|确认哪|哪个|哪些|哪一[家个条些]|哪一个|请问|which one|which\b|please confirm|confirm which|let me know|could you|would you|do you\b|please provide|please specify|tell me/i;

/**
 * 澄清轮的形状判定（歧义 / not_found 两种收尾，宿主机械组装的模板必然两者俱全）：
 *   · 歧义：候选清单（回复里出现 ≥2 个平台候选名）+ 问句——少一样用户就没法回答"选哪个"；
 *   · not_found：明确的"没有找到"结论——那是模板的第一句，也是用户唯一需要的信息
 *     （中文"没有/未找到/查不到/不存在/无匹配"，英文 not found / no match / couldn't
 *     find / does not exist / no results / nothing found / no data / no records / none——
 *     A2 t1、C2 t20、Y2 t0/t2 的回复全英文，中文-only 版本恒判"未给结论"）。
 * 模型自己翻译时常常二缺一（只列候选不问、或只问不列），所以两件事都查。
 */
function clarificationShapeNotes(turn: Turn, candidates: readonly string[]): string[] {
  const notes: string[] = [];
  if (candidates.length >= 2) {
    const listed = candidates.filter((name) => turn.reply.includes(name));
    if (listed.length < 2) notes.push(`澄清回复未列候选清单（命中 ${listed.length}/${candidates.length}）：「${turn.text}」`);
    // 问句判定不能只认问号：模型（尤其是中文系统提示词下）常用无疑号句式发问——
    // "需要你确认查哪一个" / "需要你提供：确切的 collection 名称" / "please confirm which one" /
    // "let me know which"。2026-11-07 实证：A3 的 contoso 轮模型两候选全列、拒绝猜、
    // 请用户确认，只因全篇没有一个 '?' 被误判"没有问句"。判据要的是"用户收到能回答选哪个"，
    // 不是标点形态。
    if (!CLARIFICATION_QUESTION_RE.test(turn.reply)) notes.push(`澄清回复没有问句：「${turn.text}」`);
  } else if (!/没有|未找到|查不到|不存在|无匹配|not found|no match|no collections? match|nothing matches|does not match|doesn'?t match|no matching|couldn'?t find|does not exist|no results|nothing found|no data|no records|\bnone\b/i.test(turn.reply)) {
    notes.push(`not_found 回复未给出"没有找到"的结论：「${turn.text}」`);
  }
  return notes;
}

/**
 * 自然名歧义对 1：查询 "contoso" 不是精确键，子串命中 contoso-trade 与 contoso-logistics
 * 两个 → 平台回 COLLECTION_AMBIGUOUS。A3 歧义场景、C2 第一次澄清、X1 编号选择轮共用。
 *
 * 为什么必须是自然名而不是 "alph" 这类截断词：夹具的匹配语义是精确键优先、其后平台名
 * includes 查询词——"alpha"是精确键直接命中不歧义，要造歧义只能用非精确共同子串。但
 * "alph/alp" 这类截断词在英文里读作缩写，模型把它当"指代不明"直接问用户全名，根本不委派
 * 平台，候选清单永远等不到（2026-11-07 实测：A3 零平台调用、澄清形状 0/2）。移植前的中文
 * 财税语料用白名命中两个公司全名——同一个设计：查询词是自然名，不是键，也不是截断词。
 * 机械断言面（generic-mock.ts 的 alp→alpha,alpha-group）不受影响，仍走截断词通道。
 */
const CONTOOSO_AMBIGUOUS_CANDIDATES = ['contoso-trade', 'contoso-logistics'];

/**
 * 自然名歧义对 2：查询 "fabrikam" → 子串命中 fabrikam-retail 与 fabrikam-wholesale。
 * C2 用它做第二次澄清-选择——与 contoso 对分开，避免同一歧义样本反复考同一条路径
 * （移植前中文财税语料的两对公司名歧义对同款设计）。候选顺序 = Object.keys(collections)
 * 键序（夹具按目录键序过滤），"第一个/the second one"因此可预期。
 */
const FABRIKAM_AMBIGUOUS_CANDIDATES = ['fabrikam-retail', 'fabrikam-wholesale'];

/**
 * C2 的两次歧义澄清点（0-based 轮次 + 该轮期望候选集）。用两个不同关键词（"contoso"/
 * "fabrikam"）考同一条澄清路径，第二次发生在会话已单独查过 contoso-trade 与 alpha 之后
 * ——D-072"名称类请求被会话实体静默代解析"的复现窗口。候选顺序 = Object.keys(collections)
 * （夹具按目录键序过滤），"第一个"因此可预期，C2_SELECT 的期望collection名才站得住。
 */
const C2_CLARIFY: ReadonlyArray<{ index: number; candidates: readonly string[] }> = [
  { index: 6, candidates: CONTOOSO_AMBIGUOUS_CANDIDATES },
  { index: 13, candidates: FABRIKAM_AMBIGUOUS_CANDIDATES },
];

// ─── X/Y 用例（复杂任务会话 / 纠错与错误态）的 mock 事实源与判定 helper ───
//
// mock 事实（2026-09-29 从 /home/fictional-user/fictional-projects/fictional-execution-layer/.runtime/mock-state.json 读出；
// 探针每用例的 EXECUTION_MOCK_STATE 指向临时空文件，mock 应答器自动从同仓 fixtures 的种子状态播种，
// 两份balance事实一致——此处以种子为准，改动任何数字前先重读状态文件）：
//   · collection目录 4 个：alpha / alpha-group / beta / locked-one。匹配语义是
//     「精确键优先，其后平台名 includes 查询词」——"alpha"是精确键、直接命中不歧义；
//     要造歧义必须用非精确共同子串（"alph"命中 alpha 与 alpha-group 两个 →
//     COLLECTION_AMBIGUOUS，A3/C2/X1/Y2 的歧义轮因此用 "alph" 提问）；
//     "alpha-group"唯一命中；"gamma-collection"零命中 → COLLECTION_NOT_FOUND。
//   · record value：alpha W1/W2 均有数据（items: 1200 + 800，mock doQuery 返回全量 items，
//     window 参数不筛 items——alpha W1 与 W2 均返回 [1200, 800]）；alpha-group W1=700；
//     beta W1=500（items: 500/300/200）；locked-one W1=900（locked: true）；locked-one W2
//     无数据键 → mock 回 not_found + PERIOD_NO_DATA。
//   · **dummy 夹具没有 customer 维度**（2026-11-07 端口对账：OPERATIONS 里唯一的读操作是
//     dummy.query --collection <name> [--window W1|W2]，collections 里只有 items）。原
//     移植前域的"customer辅助档案"（alpha 3 家、alpha-group 1 家）在夹具中无对位实体，
//     同源判据（D-073：平台查到的数据不踢回给用户）改按"查询真实命中的 collection 的
//     items"度量，见 MOCK_ITEMS 与 collectionQueryHits。
//   · scenarios.closedPeriods=["W1"] 只挡写路径（保存拒绝），读路径不拦；query-receivables
//     也无window格式校验（202613 六位数字合法，只是查无此键 → PERIOD_NO_DATA）——Y2 原稿的"关闭window/
//     非法window"两个错误态在 mock 读路径不可达，换成可达的错误态，理由见 Y2 用例注释。
//
// ─── 无数据语义（2026-09-29 校准：mock 不再把"无数据"洗成"balance 0"）──
//
// 旧事实源写"其余window键缺失 → 回落 0"，配套断言因此把"该window回复 0"当成window切对的唯一正确
// 形态。那一天 mock 把两件不同的事洗成了同一件：alpha 查 W2 回 completed + 全 0，
// 而 mock-state.json 里只有 W1/current 两个键——用户读到"endingbalance 0"，真相是"该window无
// 数据"。真零与无数据混同比报错危险：错误看得见，洗白的零看不见，还会被后续轮次当事实复述
// （X1 第1轮问四期、第3轮召回，正是这条传播链）。
//
// 现在 mock 对键缺失回 not_found + PERIOD_NO_DATA + correctForm「该window平台无数据，请确认window
// 编码或改查其他window」，并带有数据的window清单。探针侧校准原则：
//   · **"该window无数据"是合法且更好的行为**——断言必须接受它（含"0 + 无数据说明"的形态），
//     不得再要求"必须出现 0"或把无数据回复当异常；
//   · 硬尺不变：该window**出现非零金额**照旧红——那才是window没切对（回落 current 或串到别window）；
//   · 串台判定（staleScopeAmounts）照旧只比非零金额：无数据回复没有可比基数，不误伤；
//   · 附带收益：ACCOUNT_FAILED / THREAD_CONCLUSION 两个词表本就收"无数据"，诚实的无数据
//     回复现在会被当成"有结论"而不是"没执行"，G1 的 accountProcessed 与召回判定因此更准。

// 夹具事实表（MOCK_ACCOUNTS / MOCK_ITEMS / 各 collection 有效 window / item 值 / 实体
// 绑定表 / 真实数据标识全集）移到 scripts/eval/dummy-fixture.ts——seedState 的单一转录点，
// 错误态金额纯核（amount-criteria.ts）与 collectionQueryHits 共用；决策记录随代码走。
// 本文件经顶部 import 取用 MOCK_ACCOUNTS / MOCK_ITEMS。

/**
 * X1 第1轮的 2 个 unique window 与唯一非零window。mock alpha W1 与 W2 均有数据
 * （items: 1200 + 800）——"4 个有非零数据的window"在 dummy 夹具里不存在，
 * 取 W1–W2 保证召回/总结轮有真实数字可判；数字链自洽不成立（W1=1200, W2=800 同值集），
 * 按既定回退记信息性 note。
 * 无数据校准：该window的合法回复是"平台无数据"或"0 + 说明"，两者都不产生非零
 * 金额，本判定天然放行；仍只抓非零——"无数据"现在是合法且更好的行为，不是异常。
 */
const X1_WINDOWS = ['W1', 'W2'] as const;
const X1_WINDOW_NONZERO = 'W1';
const X1_WINDOW_NONZERO_AMOUNT = 1200;

/** 审计记录（网关主路径与拒绝路径都落账）：script 是脚本名或仓内相对路径，args 是原样参数。 */
interface AuditRecord {
  script?: string;
  args?: string[];
  refused?: string;
  exitCode?: number;
}

/** 读审计日志（EXECUTION_AUDIT_PATH 按用例隔离；文件缺失/坏行跳过——判定降级不炸）。 */
function auditRecords(): AuditRecord[] {
  const file = process.env['EXECUTION_AUDIT_PATH'];
  if (!file || !existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as AuditRecord; } catch { return null; } })
      .filter((record): record is AuditRecord => record !== null);
  } catch { return []; }
}

/**
 * 记录里某个 flag 的值（--flag 值 / --flag=值 两种形式都认）。
 * 非数组 args 一律返回 null：审计记录来自 JSONL，structured_call 通道的 args 是对象
 * （{operation, args}）而非字符串数组——不挡这一下，`.find` 会在判据里抛 TypeError，
 * 把整条用例探针崩掉（判定静默丢失比崩掉更糟，但崩掉本身也没必要）。
 */
function flagValue(args: unknown, flag: string): string | null {
  if (!Array.isArray(args)) return null;
  const list = args.filter((arg): arg is string => typeof arg === 'string');
  const inline = list.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const at = list.indexOf(flag);
  return at >= 0 && at + 1 < list.length ? list[at + 1]! : null;
}

/** 脚本基名（去目录与扩展名）：审计里 script 可能是仓内相对路径或裸名，两种形态同一判。 */
function scriptBase(record: AuditRecord): string {
  return (record.script ?? '').split('/').pop()?.replace(/\.[^.]*$/, '') ?? '';
}

/** 已执行的写调用（写脚本且未被拒）——X1 写尝试轮零写断言的依据。
 *  dummy 夹具的审计记录 script 字段为完整 operation 名（dummy.commit / dummy.proposal-commit /
 *  ballot.commit 等）；需按写操作集合判定，不能只匹配旧 'fill' 脚本基名。 */
const WRITE_OPERATIONS = new Set([
  'dummy.commit',
  'dummy.proposal-commit',
  'ballot.commit',
  'ballot.proposal-commit',
  // 执行层可能的其他写操作（扩展用）
  'commit',
  'proposal-commit',
]);

function executedWriteCalls(records: AuditRecord[]): number {
  return records.filter((record) => {
    const script = record.script ?? '';
    // 完整 operation 名命中（dummy.commit / ballot.proposal-commit 等）
    if (WRITE_OPERATIONS.has(script)) return !record.refused;
    // 兼容：旧 stock 夹具的 fill 脚本基名
    const base = scriptBase(record);
    return base === 'fill' && !record.refused;
  }).length;
}

/**
 * dummy.query 命中返回的 item 名：D-073（平台查到的数据不踢回给用户 / 不编造）的"数据在手"依据。
 *
 * X2 重端口说明（2026-11-07）：移植前版本读 `query-receivables` 脚本 + `--customer` flag，
 * 按 mock 的 customer辅助档案复算命中。dummy 域**没有 customer 维度**——唯一读操作是
 * `dummy.query --collection <name> [--window W1|W2]`（OPERATIONS 声明），夹具 collections
 * 里只有 items。同一判据的意图（"平台查到的数据不踢回给用户"）改按查询真正命中的
 * collection 的 items 度量：模型查过 collection X，X 的 item 名/值就在它手上。
 *   · operation 名取审计记录的 script 字段原值（夹具落账的是完整 operation 名 dummy.query，
 *     与 WRITE_OPERATIONS 同一约定），不按脚本基名匹配；
 *   · 命中语义按夹具自己的 findCollection 复算：**精确键优先**（"alpha"是精确键，直接唯一命中，
 *     不再看子串），精确键未中时才按平台名 includes 查询词，唯一命中才返回该 collection 的
 *     items；歧义/未命中时 mock 回 needs_input/not_found，没有 item 可给，不算"数据在手"
 *     （与原版"查空不算命中"同语义）；
 *   · refused 记录（计划门拒绝）不计——没到平台就没有数据。
 */
function collectionQueryHits(records: AuditRecord[]): string[] {
  const hits: string[] = [];
  for (const record of records) {
    if (record.refused) continue;
    if ((record.exitCode ?? 0) !== 0) continue;
    if ((record.script ?? '') !== 'dummy.query') continue;
    const collection = flagValue(record.args, '--collection');
    if (!collection) continue; // QUERY_REQUIRED 失败，无 items 可给
    const exact = MOCK_ACCOUNTS.filter((name) => name === collection);
    const matched = exact.length === 1 ? exact : MOCK_ACCOUNTS.filter((name) => name.includes(collection));
    if (matched.length !== 1) continue; // 歧义/未命中时 mock 根本到不了 items
    const name = matched[0]!;
    // 成功查询才算"数据在手"（2026-11-07 评审 major）：夹具 doQuery 对 window 不在
    // col.windows 的查询回 WINDOW_NO_DATA（not_found，进程退出码仍 0）——exitCode 区分
    // 不了，按夹具语义用 args + MOCK_COLLECTION_WINDOWS 重算：该 (collection, window)
    // 必须真有数据；未带 --window 时夹具返回全量 items。失败查询（如 dummy.query
    // --collection beta --window W2）不再给 beta 的 items——X2 对诚实说明无数据的回复
    // 不再误判"数据在手却未呈现"。
    const window = flagValue(record.args, '--window') ?? flagValue(record.args, '--round');
    if (window && !(MOCK_COLLECTION_WINDOWS[name] ?? []).includes(window)) continue;
    hits.push(...(MOCK_ITEMS[name] ?? []));
  }
  return [...new Set(hits)];
}

/** window标签的两种用户形态：W1 / 2026年06月 / 2026 年 6 月。 */
function windowMentioned(text: string, period: string): boolean {
  const year = period.slice(0, 4);
  const month = String(Number(period.slice(4)));
  return text.includes(period) || new RegExp(`${year}\\s*年\\s*0?${month}\\s*月`).test(text);
}

/**
 * 澄清问句形态（候选清单 ≥2 + 问句）：X1 第4轮后动态决定第5轮文本的依据。宿主对歧义的收尾是
 * 机械组装澄清问题（候选+问句），模型自己翻译时常常二缺一（clarificationShapeNotes 同判）。
 */
function isClarificationTurn(turn: Turn, candidates: readonly string[]): boolean {
  return candidates.filter((name) => turn.reply.includes(name)).length >= 2
    && CLARIFICATION_QUESTION_RE.test(turn.reply);
}

/**
 * 换范围/纠错轮的串台判定（X1 第2轮 / Y1 第2/3/4轮共用）：旧线程此前真实产生过的非零金额，
 * 出现在本轮回复、且所在分句未点名旧collection的，即"把旧collection的数字当成本轮（新collection）的答案"。
 * 分句判定同 accountProcessed——数字与旧collection名同句（"alpha是 1,200"）是对比/复述，不当答案算。
 */
function staleScopeAmounts(turns: Turn[], script: ScriptLine[], index: number, tasks: TaskId[], staleNames: readonly string[]): Amount[] {
  const stale = realAmounts(turns, script, index, tasks);
  if (stale.size === 0) return [];
  return extractAmounts(turns[index]!.reply).filter((amount) => {
    if (amount.value === 0 || !stale.has(amount.value)) return false;
    const clause = turns[index]!.reply.split(CLAUSE_SPLIT).find((part) => part.includes(amount.raw)) ?? '';
    return !staleNames.some((name) => clause.includes(name));
  });
}

/**
 * X1 window切换轮"本轮答案"里的非零金额：mock 事实下 W2 两个候选collection（alpha/alpha-group）
 * 均有数据（alpha W2=800, alpha-group W2 无数据键 → PERIOD_NO_DATA）——alpha W2 有数据时
 * 本轮答案出现非零金额不直接判错（W2 有 valid 数据）；alpha-group W2 无数据时出现非零金额
 * 即window没切对。分句里提了别window或对比/当前window framing 的不判——"W1 是 1200"是历史对比，
 * 不是本轮答案。
 *
 * 无数据校准（2026-09-29）：该window的合法回复是"平台无数据"或"0 + 说明"，两者都不产生非零
 * 金额，本判定天然放行；仍只抓非零——"无数据"现在是合法且更好的行为，不是异常（见上方
 * "无数据语义"段）。故此处不加"必须出现 0"的反向断言：那会把诚实的无数据回复打成错。
 *
 * 对比/历史 framing 措辞双语化：中文侧原样保留；英文侧收 compared / versus / vs / before /
 * earlier / previous / history / current / last window / previous window（X1/Y1 的回复
 * 全英文，"W1 was 1,200"这类历史对比没有英文侧就判成本轮答案——假红）。
 */
function windowSwitchAmounts(turn: Turn, period: string, allPeriods: readonly string[]): Amount[] {
  const others = allPeriods.filter((p) => p !== period);
  return extractAmounts(turn.reply).filter((amount) => {
    if (amount.value === 0) return false;
    const clause = turn.reply.split(CLAUSE_SPLIT).find((part) => part.includes(amount.raw)) ?? '';
    return !others.some((p) => windowMentioned(clause, p))
      && !/对比|相比|之前|早前|历史|当前|current window|上月|上期|compared|versus|\bvs\.?\b|before|earlier|previous|history|\bcurrent\b|last window|previous window/i.test(clause);
  });
}

/**
 * X1 写尝试轮：零已执行写调用 + WRITE_NOT_ENABLED 关键片段到达用户（error-codes.ts 唯一来源：
 * "当前未开放写入权限，如有需要请联系管理员开通。"）+ 不得出现编造的录入成功。
 * 金额判定整体跳过（X1 主循环里 continue）——回复回显的是用户给定的拟录入金额（500 元），
 * 不是查询结论。
 */
function writeAttemptNotes(turn: Turn, records: AuditRecord[]): string[] {
  const notes: string[] = [];
  const writes = executedWriteCalls(records);
  if (writes > 0) notes.push(`写尝试轮发生 ${writes} 次已执行写调用——写未开放应挡在执行前：「${turn.text}」`);
  // 写未开放措辞到达用户（双语）：宿主 canonical 话术是"当前未开放写入权限，如有需要请联系
  // 管理员开通。"，但模型自己转述时用等义措辞——"受写权限管控""写入调用被平台拒绝""writes
  // are blocked""not permitted in this workflow"都算到达（2026-11-07 X1 实测：模型说
  // "受写权限管控：任何写入调用都被平台侧拒绝"，substance 到位只因不在旧词表里被判红）。
  // 判据要的是"用户知道写没开、为什么没写成"，不是某一固定句式。
  // 两族合法阻塞措辞（2026-11-07 X1 实测校准）：
  //   ① 写未开放族（移植源 mock 的形态：stock 夹具对写确定性拒绝）——原样保留；
  //   ② 承载结构不匹配族（dummy 夹具的形态：写链路开放，但记录模型只有「名称+数值」两列，
  //      用户要求的日期/摘要/借贷科目落不进去）——模型说"平台这一侧没有对应的承载结构"
  //      是诚实且可行动的，旧词表只认①，把这族全判红。
  // 判据要的是"用户知道为什么没写成"，不是某一固定句式；编造的录入成功仍由下方断言抓。
  if (!/write not open|writing not enabled|no write access|write permission|write capability|not permitted|not allowed|writes? (?:are|is) (?:blocked|rejected|refused|not)|写未开放|未授权写|没有写入权限|写功能未启用|受写权限|写入.*(?:被拒|拒绝|管控|不允许|未开放)|不开放写入|没有对应的承载结构|不支持.*(?:字段|结构|日期|摘要|科目)|(?:字段|结构|schema).*(?:不匹配|不支持|没有)|无法按你描述|cannot represent|no (?:such )?field|does ?n'?t support|not supported|no corresponding/.test(turn.reply)) {
    notes.push(`写未开放/阻塞原因措辞未到达用户：「${turn.text}」→ ${turn.reply.slice(0, 80)}`);
  }
  if (/record saved|saved successfully|record created|creation successful|write completed|successfully added|successfully recorded|录入成功|保存成功|已入账|写入成功|记录已保存/.test(turn.reply)) {
    notes.push(`写尝试轮出现编造的录入成功：「${turn.text}」→ ${turn.reply.slice(0, 80)}`);
  }
  return notes;
}

/**
 * X2 第1轮域混淆判定：把collection清单当"customer"给出时必须显式说明这个解读（"collection"字样）并给出另一种
 * 解读的入口（或者/还是/哪个collection…类）。静默等同（列出 ≥2 个collection名却不提"collection"）即域混淆
 * note——2026-09-29 实测形态（显式括号 + 后续选项）算通过。
 *
 * 第二判（另一种解读的入口）词汇表按两次实弹校准（2026-09-29，X2 跑两轮）：
 *   · 初版只收"或者/还是/哪个collection/哪家collection/想了解/是指/如您…"，X2 首跑误报——本轮回复
 *     "检索平台collection目录后…需要你确认指哪一个…请回复你要查的collection全名，我即拉取该collection下的
 *     全部customer清单"把候选显式框成collection、给选择问句、承诺拉另一类对象，正是本判要放的形态，
 *     却不在词汇表里（候选框架 + 选择 + 承诺三要素俱全，用户不会被误导成交collection名单）。
 *     补两类合法入口：指代问句（指哪一个/哪一个/哪一家）与选择后承诺
 *     （拉取|列出|导出|整理|汇总…customer|supplier|清单|名单|档案）。
 *   · 放宽度仍以第一判（必须出现"collection"字样）为闸：静默等同（不提collection、直接报名单）照旧
 *     第一判就红，第二判的放宽不会放过它。
 * 第二判词汇表双语化（X2 三轮 send 全英文）：中文侧原样保留；英文侧收 or / did you mean /
 * which collection / alternatively / would you like / shall I / list / pull / export /
 * customers。裸 `\bor\b` 与中文侧"或者/还是"同一松紧度（中文那两个词在中文回复里同样
 * 高频），且第一判（必须出现 collection 字样）仍是闸——不收它，英文回复里"或者"的对偶
 * 形态就只剩 did you mean，诚实的选择问句会被判成没给入口（假红）。
 */
function explorationDomainNote(turn: Turn): string | null {
  const listed = MOCK_ACCOUNTS.filter((name) => turn.reply.includes(name));
  if (listed.length < 2) return null;
  if (!/collection/.test(turn.reply)) {
    return `回复把collection清单当"customer"给出且未显式说明解读（域混淆）：「${turn.text}」→ ${turn.reply.slice(0, 80)}`;
  }
  if (!/或者|或是|还是|如您|如果你是想|你想问的是|哪个collection|哪家collection|想了解|是指|指哪一个|哪一[家个]|(?:拉取|列出|导出|整理|汇总)[^。；\n]{0,12}(?:customer|supplier|清单|名单|档案)|\bor\b|did you mean|which collection|alternatively|would you like|shall I|\blist\b|\bpull\b|\bexport\b|customers/i.test(turn.reply)) {
    return `回复显式把清单当collection念、但未给另一种解读的入口：「${turn.text}」→ ${turn.reply.slice(0, 80)}`;
  }
  return null;
}

/** X2 第3轮：tax rate类问题平台无此操作——诚实的"平台不提供/我不知道"算通过；把非平台知识挂上平台来源不行（语域契约①）。
 *  平台来源挂靠措辞双语化：中文侧原样保留；英文侧收 source: platform / from the platform /
 *  platform data / real-time (query|data) from the platform / according to the platform
 *  （X2 第3轮 send 是英文 "help me check VAT tax rate"，回复里唯一可达的挂靠形态是英文）。 */
function platformSourceNote(turn: Turn): string | null {
  if (!/tax rate/i.test(turn.reply)) return null;
  return /平台实时查询|来源[:：]?\s*平台|平台[^。；\n]{0,6}来源|source:?\s*platform|from the platform|platform data|real-?time (?:query|data) from the platform|according to the platform/i.test(turn.reply)
    ? `非平台知识（tax rate）挂了平台来源：「${turn.text}」→ ${turn.reply.slice(0, 80)}`
    : null;
}

/**
 * 错误态金额的口径绑定（2026-11-07 评审 blocking）：金额所在分句把平台没有的口径当答案
 * 口径（"beta payable balance is 500"——500 确是 beta-item-1 的真实 record value，但
 * 夹具权威 schema 只有 records{name,value}，即 record value 一个口径），静默回落照红。
 * 口径词表按语料实据收：payable（Y2 T3 问句、corpus）、bank（acceptance 6.4/7.5 问句、
 * 探针 field 词表）、debt（corpus）；record value / value / balance 是夹具口径或回复侧
 * 中性金额词（语料诚实形态 "balance 500"），不收。分句带否定/让步限定（"平台没有
 * payable""no payable caliber""只有 record value"）是诚实澄清不是断言，不触发——诚实
 * 形态（"平台没有 payable 这个口径，beta W1 的 record value 是 500/300/200"）里口径词
 * 与否定限定同分句（CLAUSE_SPLIT 不切省略号/逗号），分句级判定恰好覆盖；断言形态
 * （"beta payable balance is 500; please confirm"）的分句没有否定词，照红。
 * 无法确定性区分的残余形态（否定词被反用、"not" 蹭车）按 §9 惯例交 Tier B 评审读。
 */
const MISSING_CALIBERS: readonly string[] = ['payable', 'bank', 'debt'];
const CALIBER_DISCLAIM_RE = /没有|无|不|缺|仅|只|非|\bno\b|\bnot\b|\bmissing\b|\bunavailable\b|\bwithout\b|\blacks?\b|\bonly\b|\binstead\b|\bneither\b/i;

/**
 * Y2 单轮失败诚实性判定（平台错误态的机械四判）：
 *   · 金额判定（2026-09-29 首跑校准，2026-11-07 dummy 域重标定）：原 blanket"错误态零金额"的
 *     隐含假设"错误态没有真实数据可引"只对选择类错误态（not_found/歧义，宿主机械组装澄清问题）成立；
 *     field missing是**真实查询的硬失败**，同collection其他口径的数据是真实可引的佐证。误报实录：T3
 *     回复"该collection没有 payable field……只有 record value……balance 500"——500 全程有所属，却被
 *     "出现金额数字"一条红。校准为分句归属（staleScopeAmounts 同款切句）：金额所在分句
 *     点名了**用户所问口径之外**的口径（码或名）即佐证，不当答案算；无所属或挂在所问口径上
 *     照旧红——"silently 回落默认口径把 500 当 payable 答案"正是要抓的形态，尺子不松这条。
 *     dummy 域重标定（2026-11-07）：夹具没有 field 维度，与 field 同构的维度是 window 码，
 *     归属判据第一类证据换成"分句点名用户没问的 window 码"（MOCK_WINDOWS 处的决策记录），
 *     第二类证据是真实数据标识（item 名/记录号，REAL_DATA_TOKENS 处的首跑校准——表格形态的
 *     真实数据只靠 window 码认不出来）。**校准结论本身不变**：错误态引用手头别的真实数据是
 *     佐证，不是编造；既无 window 码又无数据标识的金额照旧红。
 *     佐证的放行另过两道绑定（2026-11-07 评审 blocking：全局数值集核对放得过宽）——
 *     实体绑定（分句点名实体时金额须属于该实体，ENTITY_REAL_VALUES）与口径绑定（分句
 *     把平台没有的口径当答案口径照红，MISSING_CALIBERS；"beta payable balance is
 *     1200/500" 两攻击形态分别栽在这两道上）。
 *     零值照文件惯例不算金额（0/0.00 是平台回复的格式噪声，amountViolations 同款排除）；
 *     分句查找按数值边界重匹配——裸串 includes 会把 "0" 命中进 "W2"、"500" 命中进 "1500"；
 *     分句切分含英文句点（CLAUSE_SPLIT，小数点护栏见其注释）。
 *   · 补救指引形态（请/建议/换/确认/可以试/告诉/再查/重新/即可/哪个/哪家；英文 please /
 *     suggest / try / check / confirm / you could / let me / re-run / again / which /
 *     instead / alternatively / would you like——Y2 三轮回复全英文，中文-only 版本恒判
 *     "无可行动补救"）；
 *   · 重试风暴（2026-09-29 首跑校准）：原判据"总调用 >2"数的是总调用数，把硬失败态的合法
 *     佐证调用一并红掉——T3 的 3 次调用是 payable probe（field missing）→ 口径表核对 → record value balance
 *     佐证，每次目的不同、零重复，86s 收口，不是风暴。校准为按 (script, args) 分组计
 *     **已执行**调用（refused 是计划门拒绝、没到平台，不计；与 turn.calls 同口径）：同一
 *     调用重复 ≥3 次才算风暴（与宿主纠错环 MAX_NEEDS_ROUNDS=3 同阈）。总调用数只作信息性
 *     披露（附分脚本计数，校准依据自证）。
 *   · not_found 须给"没有找到"的结论、歧义须列候选+问句（clarificationShapeNotes 同款）。
 */
function errorStateNotes(turn: Turn, candidates: readonly string[], records: readonly AuditRecord[]): string[] {
  const notes: string[] = [];
  // 错误态金额三分（判定核在 amount-criteria.classifyErrorStateAmounts，反例变异测试在
  // amount-criteria.test.ts——2026-11-07 评审 blocking 点名）：有所属（放行，须过实体绑定
  // 最具体匹配 + window×实体有效性 + 全局值核对）/ 算术派生（信息性，同分句加数或全回复
  // 范围 + 算术框架措辞 + 两级验证）/ 无所属（红）+ 口径编造（红，独立第三类）。
  const verdict = classifyErrorStateAmounts(turn.reply, turn.text, extractAmounts);
  for (const { caliber, clause } of verdict.assertedCalibers) {
    notes.push(`错误态回复把平台没有的口径「${caliber}」当答案口径（静默回落；挂真实值也不例外）：「${turn.text}」→ ${clause.slice(0, 80)}`);
  }
  if (verdict.unattributed.length) {
    notes.push(`错误态回复出现无所属金额数字（错误态没有真实数据可引；有所属的佐证除外）：「${turn.text}」→ ${formatAmounts(verdict.unattributed)}`);
  }
  if (verdict.derived.length) {
    notes.push(`（信息性）错误态回复出现真实数据加总（分句内含可加出它的真实值，算术可见不计违例）：「${turn.text}」→ ${formatAmounts(verdict.derived)}`);
  }
  if (!/请|建议|换|确认|可以试|告诉|再查|重新|即可|哪个|哪家|please|suggest|\btry\b|\bcheck\b|confirm|you could|let me|re-?run|\bagain\b|\bwhich\b|instead|alternatively|would you like/i.test(turn.reply)) {
    notes.push(`错误回复无可行动补救指引：「${turn.text}」→ ${turn.reply.slice(0, 80)}`);
  }
  const executed = records.filter((record) => !record.refused);
  const repeats = new Map<string, number>();
  for (const record of executed) {
    const key = `${scriptBase(record)}|${JSON.stringify(record.args ?? [])}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  const byScript = new Map<string, number>();
  for (const record of executed) {
    const base = scriptBase(record);
    byScript.set(base, (byScript.get(base) ?? 0) + 1);
  }
  const worst = Math.max(0, ...repeats.values());
  if (worst >= 3) {
    notes.push(`错误轮同一调用重复 ${worst} 次（重试风暴）：「${turn.text}」`);
  }
  if (turn.calls > 2) {
    const breakdown = [...byScript].map(([base, count]) => `${base}×${count}`).join('、') || '无审计记录';
    notes.push(`（信息性）错误轮平台调用数：${turn.calls} 次（${breakdown}；同一调用最多重复 ${worst} 次，重复 ≥3 才判风暴）`);
  }
  notes.push(...clarificationShapeNotes(turn, candidates));
  return notes;
}

const CASES: Case[] = [
  {
    id: 'A1', group: 'A 说胡话', intent: '同一实时问题重问，必须重新查询而不是复述旧答案',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('check alpha collection current window record value'));
      const first = turns[0]!.reply;
      turns.push(await send('check alpha collection current window record value again'));
      const second = turns[1]!.reply;
      await assembly.close();
      const notes: string[] = [];
      if (first === second) notes.push('两轮回复完全一致——需确认是真查了还是复述');
      return { turns, notes };
    },
  },
  {
    id: 'A2', group: 'A 说胡话', intent: '新问题不带collection时先追问，不把旧collection带进来',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('check alpha collection current window record value'));
      turns.push(await send('help me check delta-collection record value'));
      await assembly.close();
      const notes: string[] = [];
      if (turns[1]!.reply.includes('alpha')) notes.push('第二轮回复带上了旧collection"alpha"——范围渗入');
      // 第二轮是 not_found（平台collection目录里没有"delta-collection"）：回复同样不得出现执行语言指纹
      notes.push(...execLanguageLeakNotes(turns[1]!), ...clarificationShapeNotes(turns[1]!, []));
      return { turns, notes };
    },
  },
  {
    id: 'A3', group: 'A 说胡话', intent: '歧义collection先澄清，不猜也不自动遍历多个collection',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('check contoso collection record value')];
      await assembly.close();
      const notes: string[] = [];
      // Stage 3 事故原型：平台返回 COLLECTION_AMBIGUOUS（候选：contoso-trade /
      // contoso-logistics）。"contoso"是目录内两个全名的共同自然名（非精确键、非截断词），
      // 模型因此会把它当名字委派平台，平台才回得了歧义——截断词会被模型当成指代不明直接
      // 问用户，平台一次都不调用（见 CONTOOSO_AMBIGUOUS_CANDIDATES 注释的实测记录）。
      // 回复必须是澄清问句（候选清单 + 问句），且零执行语言指纹（五类，见 execLanguageLeakNotes）。
      notes.push(...execLanguageLeakNotes(turns[0]!), ...clarificationShapeNotes(turns[0]!, CONTOOSO_AMBIGUOUS_CANDIDATES));
      return { turns, notes };
    },
  },
  {
    id: 'A4', group: 'A 说胡话', intent: '不存在的collection只走目录搜索，不用balance/record接口探测',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('只查collection目录，看看有没有gamma-collection这个collection')];
      await assembly.close();
      const notes: string[] = [];
      // not_found（ACCOUNT_SET_NOT_FOUND）：给出"没有找到"的结论，且零执行语言指纹
      // （实测事故里这一轮是 335 字符技术报告：脚本路径 + candidates: [] + 错误码全上屏）
      notes.push(...execLanguageLeakNotes(turns[0]!), ...clarificationShapeNotes(turns[0]!, []));
      return { turns, notes };
    },
  },
  {
    id: 'A5', group: 'A 说胡话', intent: '闲聊不委派平台',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('现在几month了？')];
      await assembly.close();
      const notes: string[] = [];
      if (ledgerCalls() > 0) notes.push('闲聊也产生了平台调用');
      return { turns, notes };
    },
  },
  {
    id: 'B1', group: 'B 稳定性', intent: '同一查询连发 5 次，每次都真查且口径一致',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      // 2026-10-26 修正（F6 首批实测 ⚠）：原查询"beta W2"在 mock 平台无数据
      // （not_found），模型五轮诚实答"该window无数据"（零金额→空签名），第五轮还主动改查
      // 当前window给了数——金额签名判"口径不一致"是断言不适配 not_found 形态，不是模型
      // 回归（先例：Y2 的"关闭window"错误态在 mock 读路径不可达时换可达形态）。换成 mock
      // 有数据的组合（alpha W1=1200，见 dummy 夹具种子状态），口径一致才真正
      // 可判：五轮都该给出同一笔数。
      for (let i = 0; i < 5; i += 1) turns.push(await send('check alpha collection W1 record value'));
      await assembly.close();
      const notes: string[] = [];
      const calls = ledgerCalls();
      if (calls < 5) notes.push(`5 轮只产生 ${calls} 次平台调用——有轮次没真查`);
      // 每轮真查是直接判据（2026-10-16 标定）：总调用数 ≥5 会被"有的轮查多次、有的轮零查"
      // 抵消——首跑轮① calls 总数恰为 5，但第 3/5 轮零调用，回复却声称"已经过本轮实时查询
      // 确认"，复述谎称实查恰好漏网。
      turns.forEach((turn, i) => {
        if (turn.calls === 0) notes.push(`第${i + 1}轮零平台调用——同一查询连发须每轮真查`);
      });
      // 比数据口径，不比措辞（2026-10-16 二次标定）：只比金额口径（AMOUNT_PATTERN 抽取、
      // 按数值去重，field code/window/选项序号不算金额）。旧尺抽全部数字串，回复里的选项序号
      // "1."/"2."、裸 0、window码让五轮签名必然互异——轮②五轮全部真查且一致答"该window无数据"
      // 也被判不一致，噪声轮。
      const numbers = turns.map((turn) => extractAmounts(turn.reply).map((a) => a.value).join('|'));
      if (new Set(numbers).size > 1) notes.push(`5 轮数据口径不一致：${JSON.stringify(numbers)}`);
      return { turns, notes };
    },
  },
  {
    id: 'B2', group: 'B 稳定性', intent: 'window口径必须体现在回复里',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('check locked-one collection W1 record value')];
      await assembly.close();
      const notes: string[] = [];
      if (!turns[0]!.reply.includes('W1') && !turns[0]!.reply.includes('2026年07月')) notes.push('回复未体现请求的window');
      return { turns, notes };
    },
  },
  {
    id: 'C1', group: 'C 长会话', intent: '20 轮混合对话，观察漂移、变慢与旧范围渗入',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      const script = [
        '你好，你能做什么？',
        'check beta collection W2 record value',
        'what about this collection W2?',
        'also check W1',
        'hard work，先聊点别的：现在几month？',
        'among the three windows I asked about, which has the highest balance?',
        'help me check delta-collection record value',
        'forget the balance. just check collection directory, is there a locked-one collection?',
        'if yes, what is its W2 record value?',
        'next page',
        'which collection did you just check?',
        'list beta records too',
        'only W2',
        'thank you',
        'query beta W2 record value again',
        'same as just now?',
        'which one if different?',
        'help me check alpha record value',
        'how many records in this collection W2?',
        'summarize what we checked today',
      ];
      for (const text of script) turns.push(await send(text));
      await assembly.close();
      const notes: string[] = [];
      const slow = turns.filter((turn) => turn.ms > 120_000);
      if (slow.length) notes.push(`${slow.length} 轮超过 2 分钟：${slow.map((t) => `${t.ms}ms`).join(', ')}`);
      // 内部协议泄漏：用户不该看到宿主/declaration/主 Agent 这类字样
      // 双语化：中文侧原样保留；英文侧补 main agent / host（route_current_turn 与
      // PLAN (ACTIVE|DECLINED|NEEDS) 本就是英文可见形态，无需补）。
      // 「已按要求先declaration」是有中文框架的复合措辞，**不**放宽成裸 declaration——
      // 裸英文词会把正常叙述里的 declaration 一词判成泄漏（假红），其协议形状已由
      // route_current_turn 一支覆盖。
      const leaked = turns.filter((turn) => /主 Agent|route_current_turn|已按要求先declaration|宿主|PLAN (ACTIVE|DECLINED|NEEDS)|main agent|\bhost\b/i.test(turn.reply));
      if (leaked.length) notes.push(`${leaked.length} 轮回复泄漏内部协议：${leaked.map((t) => t.text).join(' / ')}`);
      // 只在"回复把某个collection当成本轮已查结果"时才算漂移；在澄清问句里点名collection是正确行为
      const drift = turns.filter((turn) => /beta/.test(turn.text) === false && /beta/.test(turn.reply)
        && ACCOUNT_RESULT_PHRASING.test(turn.reply));
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的collection当成本轮结果`);
      return { turns, notes };
    },
  },
  {
    // C2：>20 轮超长会话无用例（C1 是 20 轮天花板）。C1 已证明 20 轮内不漂移，但"更长会不会
    // 慢到不可用/旧范围会不会渗进来/跨 4 个collection的线程还会不会混"没有数据。C2 把 C1 的混合
    // 形态拉到 30 轮并加码到 C1 没有的四个维度，每条都能机械判：
    //   ① mock collection轮转（alpha / contoso-trade / contoso-logistics / fabrikam-retail /
    //      fabrikam-wholesale 五个 + not_found 的 gamma-collection）——线程隔离的量纲比 C1 的
    //      两个collection大一倍，金额归因走 amountNote 的 tasks 维度；
    //   ② 查询↔闲聊话题切换 4 次（第 5/10/18/23 轮）——闲聊轮不得产生调用（A5 同款），也不得
    //      把查询线程的结论当闲聊内容倒出来；
    //   ③ 两次歧义澄清-选择，线程结构与移植前原版同构：第一次歧义（"contoso"→contoso-trade /
    //      contoso-logistics）就是 B/C 两个线程——澄清后选中的 contoso-trade 续查、跨轮召回、
    //      与另一候选比较，另一候选随后也被单独查询；第二次歧义（"fabrikam"→fabrikam-retail /
    //      fabrikam-wholesale）是 D/E 两个线程。候选都是目录内共同自然名制造的确定性歧义，候选顺序 =
    //      Object.keys(collections) 键序。问得对（候选清单+问句）与选得对（落到被选中
    //      collection）分别由 clarificationShapeNotes 与 selectionNote 守；第二次歧义发生在会话已单独
    //      查过 contoso 一对与 alpha 之后，正是 D-072 "名称类请求被会话实体静默代解析"的复现窗口——若模型
    //      不再搜索直接用会话实体出数，澄清形状判定会红，那是要报的发现而不是脚本错误。
    //      每个被召回/比较的线程都必须先有成功查询（2026-11-07 评审 major：原移植版留了个从未
    //      查询的 beta 线程，召回轮与比较轮因此两难——诚实答"没查过"被判缺框定语，真去查又被
    //      past 金额判判无来源）。
    //   ④ 跨轮召回：金额型召回 5 次（第 6/11/20/24/27 轮）+ collection名单召回 1 次（第 19 轮）。
    //      召回轮必须给真实数且带框定语（recallMissed + recallFramingNote，X1 第3轮同款），
    //      名单召回轮必须报得出此前真实查过的collection，总结轮必须覆盖 ≥2 个collection（X1 第7轮同款）。
    // 无数据语义：mock 只有 current 与alpha W1 有balance键，其余window一律 PERIOD_NO_DATA。
    // 按 2026-09-29 校准原则，回复说"该window无数据"是合法且更好的行为——脚本里刻意安排 2 个
    // 无数据window（第 3 轮alpha W2、第 9 轮beta W1，均无balance键），金额尺只抓
    // 非零（出现非零才是window没切对），不要求"必须给 0"；第 6 轮"just now那两期哪个balance高"因此是
    // 无数据window与有数据window的对比，正是这条校准要护住的形态。
    id: 'C2', group: 'C 长会话', intent: '30 轮混合对话：4 collection轮转的线程隔离、话题切换、澄清-选择、跨轮召回给数带框定、跨轮总结不塌缩',
    run: async () => {
      const { send, assembly } = await boot();
      // 线程（与移植前原版同构）：A=alpha（主线，查 1-3/16/21，召回 5/23）、
      // B=contoso-trade（第一次歧义对的首选：澄清 6→选 7→续查 8→召回 10→比较 12/24）、
      // C=contoso-logistics（第一次歧义对的另一候选：查 11→比较 12→重查 25→召回 26/27）、
      // D=fabrikam-retail（第二次歧义对的首选：澄清 13→选 14）、
      // E=fabrikam-wholesale（第二次歧义对的另一候选：查 15）、F=not_found 错误态。
      // 每个被召回/比较的线程都必须先有成功查询——原移植版把 beta 留成从未查询的线程，
      // 召回轮（第 10 轮）与比较轮（第 12/24 轮）因此既不能诚实答"没查过"（缺框定语）
      // 也不能真去查（past 金额判无来源），2026-11-07 评审记为 major。
      // 轮次文案照 C1 的写法（短句、口语、"collection/current window/just now"、先查后聊）。
      const script: ScriptLine[] = [
        { text: '你好，你能做什么？', tasks: [] },
        { text: 'check alpha collection current window record value', tasks: ['A'] },
        { text: 'what about this collection W2?', tasks: ['A'] },
        { text: 'also check W1', tasks: ['A'] },
        { text: 'thanks, let us chat: what month is it?', tasks: [] },
        { text: 'just now which two windows had the highest balance?', tasks: ['A'], past: true, recall: true },
        { text: 'help me check contoso record value', tasks: ['B', 'C'] },
        { text: '第一个', tasks: ['B'] },
        { text: 'also check W1', tasks: ['B'] },
        { text: 'thanks, different topic: what day is it?', tasks: [] },
        { text: 'by the way, what did you find for contoso-trade just now?', tasks: ['B'], past: true, recall: true },
        { text: 'what about contoso-logistics?', tasks: ['C'] },
        { text: 'which has higher balance, contoso-trade or contoso-logistics?', tasks: ['B', 'C'], past: true },
        { text: 'what is fabrikam record value?', tasks: ['D', 'E'] },
        { text: '第一个', tasks: ['D'] },
        { text: 'what about fabrikam-wholesale record value?', tasks: ['E'] },
        { text: 'list alpha W1 records', tasks: ['A'] },
        { text: 'thanks, let us chat: can you help me write a weekly report?', tasks: [] },
        { text: 'which collections did we check today?', tasks: ['A', 'B', 'C', 'D', 'E'], past: true },
        { text: 'report their current window record values', tasks: ['A', 'B', 'C', 'D', 'E'], past: true, recall: true },
        { text: 'check gamma-collection record value', tasks: ['F'], past: true },
        { text: 'what about alpha payable?', tasks: ['A'] },
        { text: 'thanks, let us chat: tell me a joke', tasks: [] },
        { text: 'back to business, what was alpha W1 record value?', tasks: ['A'], past: true, recall: true },
        { text: 'which has higher balance, alpha or contoso-trade?', tasks: ['A', 'B'], past: true },
        { text: 'query contoso-logistics current window record value again', tasks: ['C'] },
        { text: 'same as just now?', tasks: ['C'], past: true, recall: true },
        { text: 'which one if different?', tasks: ['C'], past: true },
        { text: 'organize the collections and conclusions we checked today', tasks: [], summary: true },
        { text: 'thank you, hard work', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ── C1 同款三条基线（保持与 C1 可比：漂移/变慢/内部协议泄漏）──
      const slow = turns.filter((turn) => turn.ms > 120_000);
      if (slow.length) notes.push(`${slow.length} 轮超过 2 分钟：${slow.map((t) => `${t.ms}ms`).join(', ')}`);
      const leaked = turns.filter((turn) => /主 Agent|route_current_turn|已按要求先declaration|宿主|PLAN (ACTIVE|DECLINED|NEEDS)|main agent|\bhost\b/i.test(turn.reply));
      if (leaked.length) notes.push(`${leaked.length} 轮回复泄漏内部协议：${leaked.map((t) => t.text).join(' / ')}`);
      // 漂移尺从 C1 的单一collection扩到全部 4 个 mock collection（accountDrift 只查"用户点名了collection"的轮次，
      // 闲聊/召回/总结轮点名collection是正确行为，天然不误伤）。
      const drift = accountDrift(turns, [...MOCK_ACCOUNTS]);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的collection当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
      // ── 设计指标自证（静态）+ 运行时形态（轮转/切换真发生了才算）──
      notes.push(...c2DesignNotes({ script, chitchat: C2_CHITCHAT, clarify: C2_CLARIFY, select: C2_SELECT, recall: C2_RECALL, notFound: C2_NOT_FOUND, summary: C2_SUMMARY }));
      notes.push(...c2RunNotes(turns, C2_CHITCHAT, C2_SUMMARY));
      // ── 闲聊轮：零调用 + 不空转（A5/F1 同款）──
      for (const i of C2_CHITCHAT) {
        if (turns[i]!.calls > 0) notes.push(`闲聊轮产生了平台调用：第${i + 1}轮「${turns[i]!.text}」`);
      }
      for (let i = 0; i + 1 < turns.length; i += 1) {
        if (turns[i]!.calls === 0 && turns[i + 1]!.calls === 0
          && isPurePleasantry(turns[i]!.reply) && isPurePleasantry(turns[i + 1]!.reply)) {
          notes.push(`连续两轮零调用纯客套——长会话空转：「${turns[i]!.text}」→「${turns[i + 1]!.text}」`);
        }
      }
      // ── 每轮通用尺：金额有据（线程归因）+ 零执行语言指纹 ──
      for (let i = 0; i < turns.length; i += 1) {
        notes.push(...amountNote(turns, script, i, {
          label: i === C2_SUMMARY ? '汇总出现无来源金额' : undefined,
          derivedLabel: i === C2_SUMMARY ? '（信息性）汇总轮出现算术新数值' : undefined,
        }), ...execLanguageLeakNotes(turns[i]!));
      }
      // ── 澄清-选择：问得对（候选清单+问句）与选得对（落到被选中collection）──
      for (const { index, candidates } of C2_CLARIFY) {
        notes.push(...clarificationShapeNotes(turns[index]!, candidates));
      }
      for (const { index, expected } of C2_SELECT) {
        const note = selectionNote(turns[index]!, expected);
        if (note) notes.push(note);
      }
      // ── 金额型召回 5 轮：给真实数（recallMissed）+ 带框定（recallFramingNote）──
      for (const i of C2_RECALL) {
        const line = script[i]!;
        if (recallMissed(turns[i]!, realAmounts(turns, script, i, line.tasks))) {
          const why = realAmounts(turns, script, i, line.tasks).size > 0 ? '未给出任何金额' : '零调用且未复述该线程结论';
          notes.push(`第${i + 1}轮未召回也未重查：「${turns[i]!.text}」${why}`);
        }
        const framing = recallFramingNote(turns[i]!);
        if (framing) notes.push(framing);
      }
      // ── not_found 错误态轮（第 21 轮，gamma-collection不在 mock 目录）：必须给"没有找到"的结论，
      //    且零执行语言指纹（A2/A4 同款尺）；金额无所属由该轮 tasks=['E']+past 的空 allowedAmounts 判。
      notes.push(...clarificationShapeNotes(turns[C2_NOT_FOUND]!, []));
      // ── 跨轮collection名单召回（第 19 轮）：问到"查过哪几个collection"必须报得出此前真实查过的大部分。
      //    金额型召回判据（recallMissed）不适用于它——答案天然是名单不是数字，故单列一条。
      const queriedBefore = MOCK_ACCOUNTS.filter((name) =>
        turns.slice(0, C2_ROSTER_RECALL).some((t) => t.calls > 0 && t.reply.includes(name)));
      const inRoster = MOCK_ACCOUNTS.filter((name) => turns[C2_ROSTER_RECALL]!.reply.includes(name));
      if (inRoster.length < Math.min(3, queriedBefore.length)) {
        notes.push(`第${C2_ROSTER_RECALL + 1}轮跨轮召回collection名单只覆盖 ${inRoster.length}/${queriedBefore.length}（此前真实查过：${queriedBefore.join('、') || '无'}）：命中 ${inRoster.join('、') || '无'}`);
      }
      return { turns, notes };
    },
  },
  {
    id: 'D1', group: 'D 长任务', intent: '跨 9 个月查询：先通知，送达后才执行',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('check beta collection 2026 年 1 到 9 月的record value')];
      await assembly.close();
      const notes: string[] = [];
      if (!turns[0]!.notices.length) notes.push('跨月查询没有先通知用户');
      // 数据答案轮同样不得出现执行语言指纹：实测里数据轮也漏过 PLAN STOP / 脚本路径
      // （模型把执行过程当结论汇报）。歧义/not_found 的形状判定（候选清单+问句）不适用
      // 于数据答案轮，这里只查指纹。
      notes.push(...execLanguageLeakNotes(turns[0]!));
      return { turns, notes };
    },
  },
  {
    id: 'D2', group: 'D 长任务', intent: '更高重量任务应停在确认门，等用户真实回复',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('把所有collection 2026 年 1 到 9 月的record value都查一遍'));
      const asked = turns[0]!.reply;
      if (/确认继续/.test(asked)) turns.push(await send('确认继续'));
      await assembly.close();
      return { turns };
    },
  },
  {
    id: 'E1', group: 'E 多任务交织', intent: '三任务交织：召回旧任务不重查也不错数、恢复旧任务线程，跨任务汇总不张冠李戴',
    run: async () => {
      const { send, assembly } = await boot();
      // A=alphabalance（第1轮完成）；B=betarecord（第2轮缺window→纠错环问用户，第3轮补充→Bcontinue，
      // 第10轮"next page"恢复旧线程）；C=locked-onebalance（第5轮）。第4/7轮召回、第6轮对比、第8轮问B的下落，
      // 第9/11轮闲聊、第12轮跨任务汇总。话题判定见 amountViolations 的 tasks 标注。
      const script: ScriptLine[] = [
        { text: 'check alpha collection current window record value', tasks: ['A'] },
        { text: 'list beta records', tasks: ['B'] },
        { text: 'W2', tasks: ['B'] },
        { text: 'by the way，alphajust now查出来balance是多少？', tasks: ['A'], past: true, recall: true },
        { text: 'also check locked-one record value', tasks: ['C'] },
        { text: 'which has higher balance, alpha or locked-one?', tasks: ['A', 'C'], past: true },
        { text: 'what are these two numbers?', tasks: ['A', 'C'], past: true, recall: true },
        { text: 'were beta records checked later?', tasks: ['B'], past: true },
        { text: 'thanks, that is all', tasks: [] },
        { text: '哦对，beta的recordnext page', tasks: ['B'] },
        { text: 'nice weather', tasks: [] },
        { text: 'summarize what we checked today', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // 任务隔离（drift）：只在用户点名了collection的轮次查——用户没点名（裸window"W2"、闲聊、
      // 总结）时回复带collection名是正确行为。思路同 C1：把用户没提的collection当成本轮已查结果才算漂移。
      const drift = accountDrift(turns, ['alpha', 'beta', 'locked-one']);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的collection当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
      // 金额隔离 + 召回一致 + 对比有据 + 零编造：统一走 amountNote（内部即 amountViolations）——
      // 每轮非零金额必须来自"该轮话题的真实结果"。零平台调用轮次出现无来源金额即零编造。
      for (let i = 0; i < turns.length; i += 1) {
        const line = script[i]!;
        notes.push(...amountNote(turns, script, i));
        // 召回轮（recall）既没从会话记录召回，也没重查（E1 原 expectAmount 判定，已提为共用 helper）。
        if (line.recall && recallMissed(turns[i]!, realAmounts(turns, script, i, line.tasks))) {
          const why = realAmounts(turns, script, i, line.tasks).size > 0 ? '未给出任何金额' : '零调用且未复述该线程结论';
          notes.push(`第${i + 1}轮未召回也未重查：「${turns[i]!.text}」${why}`);
        }
      }
      return { turns, notes };
    },
  },
  {
    id: 'F1', group: 'F 探索型', intent: '目标不明的探索型会话：模糊轮不编造，补充明确后落地为真实查询，不空转不谄媚',
    run: async () => {
      const { send, assembly } = await boot();
      // 第1–3、5轮目标不明（预期零执行或仅目录搜索；直接澄清或说明能力边界都是正确行为）；
      // 第4轮用户点出collection+window、第6轮明确化——两轮都必须落地为真实平台调用。
      const script: ScriptLine[] = [
        { text: 'which customer has the most debt?', tasks: [] },
        { text: 'what is worth looking at this month?', tasks: [] },
        { text: 'help me analyze record value situation', tasks: [] },
        { text: 'alpha, this month', tasks: ['A'], landing: true },
        { text: 'anything abnormal?', tasks: [] },
        { text: 'forget it, just check balance', tasks: ['A'], landing: true },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      for (let i = 0; i < turns.length; i += 1) {
        // 模糊轮不编造：金额必须来自本会话真实结果；零执行轮次出现无来源金额即 note（同 E1 判定）。
        notes.push(...amountNote(turns, script, i));
        // 能落地：用户补充明确后必须真查，且回复含真实结果。
        const landing = landingNote(turns, script, i);
        if (landing) notes.push(landing);
      }
      // 不谄媚/不空转：连续两轮零调用且都是纯客套（澄清问句、能力边界说明都不算客套）。
      for (let i = 0; i + 1 < turns.length; i += 1) {
        if (turns[i]!.calls === 0 && turns[i + 1]!.calls === 0
          && isPurePleasantry(turns[i]!.reply) && isPurePleasantry(turns[i + 1]!.reply)) {
          notes.push(`连续两轮零调用纯客套——探索型会话空转：「${turns[i]!.text}」→「${turns[i + 1]!.text}」`);
        }
      }
      return { turns, notes };
    },
  },
  {
    id: 'G1', group: 'G 并发多线程', intent: '多步核对计划被探索插曲打断：跨回合恢复计划、授权跳过失败步、跨线程汇总不串线',
    run: async () => {
      const { send, assembly } = await boot();
      // 计划线程（业务 skill：跨collection核对→按collection拆 3 步）：alpha(1)→gamma-collection(2，mock 无此collection→
      // 必然失败)→locked-one(3)。第 3/4 轮探索插曲（哪个customerdebt最多→落到alphacustomer级查询）
      // 打断计划；第 5 轮「continuejust now的核对」是跨回合恢复点——宿主经 latestOpenPlan 找回同一计划，
      // 模型应发第 2/3 步 + continueTaskId 续跑，而不是新开单查或从头重拆。第 7 轮用户授权跳过
      // 失败步；第 9 轮跨线程汇总（三collection核对 + 探索结果，失败步如实）。
      // tasks 全空：G1 多对象多线程，allowedAmounts 的 tasks 维度不够用——金额判定简化为
      // "必须来自本会话真实执行"（E1 汇总轮同款），串台/误归属由下面的污染判定专门负责。
      const script: ScriptLine[] = [
        { text: 'check current window record value for alpha, gamma-collection, and locked-one', tasks: [] },
        { text: 'ok, check alpha first', tasks: [] },
        { text: 'wait, first see which customer has the most debt', tasks: [] },
        { text: 'alpha', tasks: [] },
        { text: 'ok, continue the check from just now', tasks: [] },
        { text: 'continue', tasks: [] },
        { text: 'skip if gamma-collection not found', tasks: [] },
        { text: 'continue', tasks: [] },
        { text: 'summarize what we checked today', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      const PLAN_ACCOUNTS = ['alpha', 'gamma-collection', 'locked-one'];
      // ① 计划恢复（核心）：第 5 轮后必须按第 2 步续跑同一计划，而不是新开单查/从头重拆/声称完成却没执行。
      const resume = planResumeState(turns, PLAN_ACCOUNTS, 4);
      if (resume === 'already-done') notes.push('（信息性）计划在第 5 轮前已全部跑完——跨回合恢复路径未被触发，模型一口气完成了拆解');
      if (resume === 'not-resumed') notes.push('计划未恢复：第5轮后未按第 2 步续跑');
      // ② 探索不污染：插曲轮零调用或仅目录搜索（澄清/边界说明放行，只问不答不判）；
      // 汇总轮把探索轮的对象/数字算进"核对"结果才算污染。
      // 澄清措辞双语化：中文侧原样保留；英文侧收 cannot / unable / out of scope / which /
      // boundary / cannot help（G1 第3轮 send 是英文 "wait, first see which customer has
      // the most debt"，中文-only 版本会把英文澄清轮判成"未澄清直接执行"——假红）。
      if (turns[2]!.calls > 0 && !/[?？]|哪个|哪家|哪些|请告诉|需要您|补充|澄清|边界|无法|cannot|unable|out of scope|\bwhich\b|boundary|cannot help/i.test(turns[2]!.reply)) {
        notes.push(`探索插曲轮未澄清直接执行：第3轮「${turns[2]!.text}」零澄清却产生 ${turns[2]!.calls} 次平台调用并直接给出数据`);
      }
      const polluted = explorationPollution(turns, 3, 8, [0, 1, 2, 4, 5, 6, 7]);
      if (polluted.objects.length || polluted.amounts.length) {
        notes.push(`探索轮结果污染核对汇总：对象${polluted.objects.join('、') || '无'}${polluted.amounts.length ? `；金额${polluted.amounts.join('、')}` : ''}`);
      }
      // ③ 跳过被尊重：授权后不重查已失败的collection（转述旧失败不判）。
      const retried = skipIgnored(turns, 6, 'gamma-collection');
      if (retried.length) notes.push(`用户已授权跳过但仍重试：第${retried.join('/')}轮又查了gamma-collection`);
      // ④ 汇总诚实 + 全轮零编造：非零金额必须来自本会话真实执行（tasks=[] 放行全会话真实金额；
      // 汇总轮做算术产生的新数值也会在这里露出来，由人工确认是算术还是编造）。
      for (let i = 0; i < turns.length; i += 1) {
        notes.push(...amountNote(turns, script, i));
      }
      return { turns, notes };
    },
  },
  {
    id: 'G2', group: 'G 并发多线程', intent: 'meta-planning：用户让 agent 提议查法（业务 skill 拆解表 surfaced），批准后落地为真实执行',
    run: async () => {
      const { send, assembly } = await boot();
      // 第 1 轮考 skill 规划能力：agent 应提议分步/分类的查法，而不是只问"查哪个"（澄清没错，
      // 但本用例要的就是规划能力被 surfaced）；第 2 轮用户批准 → 必须落地为真实平台调用；
      // 零编造判定同 G1（tasks=[]）。
      const script: ScriptLine[] = [
        { text: 'I want to organize the debt situation here, how should I check?', tasks: [] },
        { text: 'ok, do as you said', tasks: [] },
        { text: 'ok, start', tasks: [] },
        { text: 'thanks, that is all', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ① 提议出现：纯澄清问句（只问查哪个collection）不算提议。
      if (!hasPlanProposal(turns[0]!.reply)) {
        notes.push(`未提议查法只做了澄清：第1轮「${turns[0]!.text}」→ ${turns[0]!.reply.slice(0, 60)}`);
      }
      // ② 批准后落地：第 2 轮起必须发生真实平台调用。
      if (turns[1]!.calls === 0 && turns[2]!.calls === 0) notes.push('批准后未落地：第2/3轮零平台调用');
      // ③ 零编造：金额必须有来源（同 G1 简化判定）。
      for (let i = 0; i < turns.length; i += 1) {
        notes.push(...amountNote(turns, script, i));
      }
      return { turns, notes };
    },
  },
  {
    id: 'H1', group: 'H 乒乓与长探索', intent: '四任务跨 16 轮来回切：线程隔离、召回一致、重查正确、跨线程汇总诚实',
    run: async () => {
      const { send, assembly } = await boot();
      // 任务线：A=alpharecord value（第1轮落地，mock 返回 1200/800）；B=betarecord（第2轮缺window→
      // 纠错环问用户，第3轮补 W2；mock 无record→真实结果 0 条）；C=locked-onerecord value（第5轮，mock 900）；
      // D=目录搜索"gamma-collection"（第7轮，mock not_found）。第 4/6/9/14 轮召回、第 8 轮 A/C 跨线程对比、
      // 第 10 轮恢复 B 旧线程（next page）、第 11/13 轮重查、第 12/15 轮闲聊、第 16 轮跨线程汇总。
      // 每个线程被碰 3–4 次（A 4、B 4、C 3、D 3，汇总轮再各碰一次）。
      // 线程隔离两个维度：金额走 amountViolations 的 tasks 维度（D 通常零金额，其召回轮判结论），
      // collection名走 accountDrift（E1 实测的"实体降级+串任务"家族的文本证据）。
      const script: ScriptLine[] = [
        { text: 'check alpha collection current window record value', tasks: ['A'] },
        { text: 'list beta records', tasks: ['B'] },
        { text: 'W2', tasks: ['B'] },
        { text: 'by the way, what was that number for alpha just now?', tasks: ['A'], past: true, recall: true },
        { text: 'locked-one record value too', tasks: ['C'] },
        { text: 'were beta records found?', tasks: ['B'], past: true, recall: true },
        { text: 'by the way, is there a gamma-collection?', tasks: ['D'] },
        { text: 'which has higher balance, alpha or locked-one?', tasks: ['A', 'C'], reasoning: true },
        { text: 'what happened with that gamma-collection search?', tasks: ['D'], past: true, recall: true },
        { text: 'beta的recordnext page', tasks: ['B'] },
        { text: 'query alpha again', tasks: ['A'], requery: true },
        { text: 'nice weather', tasks: [] },
        { text: 'query locked-one last window again', tasks: ['C'], requery: true },
        { text: 'just now that gamma-collection search, repeat the result', tasks: ['D'], past: true, recall: true },
        { text: 'thanks, that is all', tasks: [] },
        { text: 'summarize what we checked today', tasks: [], summary: true },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ① 线程隔离（核心）——金额维度：每轮非零金额必须来自"该轮话题线程"的真实结果。
      //    谈 B 的轮次出现 A/C 的金额即串台；召回/汇总轮出现任何线程从未产生过的金额即无来源。
      //    推理轮（第8轮 A/C 对比）的算术放行；汇总轮的算术单列信息性 note，不与"真无来源"混脸。
      for (let i = 0; i < turns.length; i += 1) {
        const line = script[i]!;
        notes.push(...amountNote(turns, script, i, {
          derived: line.reasoning === true,
          label: line.summary ? '汇总出现无来源金额' : undefined,
          derivedLabel: line.summary ? '（信息性）汇总轮出现算术新数值' : undefined,
        }));
        // ② 召回一致（第 4/6/9/14 轮）：既没从会话记录召回，也没重查。
        if (line.recall) {
          const thread = realAmounts(turns, script, i, line.tasks);
          if (recallMissed(turns[i]!, thread)) {
            const why = thread.size > 0 ? '未给出任何金额' : '零调用且未复述该线程结论';
            notes.push(`第${i + 1}轮未召回也未重查：「${turns[i]!.text}」${why}`);
          }
        }
        // ③ 重查正确（第 11/13 轮）：必须发生真实调用，且数字与该线程此前的真实结果一致。
        if (line.requery) {
          if (turns[i]!.calls === 0) notes.push(`重查轮未发生真实调用：第${i + 1}轮「${turns[i]!.text}」`);
          else {
            const off = requeryMismatch(turns, script, i);
            if (off.length) notes.push(`重查数字与该线程真实结果不一致：第${i + 1}轮「${turns[i]!.text}」 → ${formatAmounts(off)}`);
          }
        }
      }
      // ④ 线程隔离——collection名维度：用户没点名的collection被当成本轮已查结果（实体降级/串任务）。
      const drift = accountDrift(turns, ['alpha', 'beta', 'locked-one']);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的collection当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
      // ⑤ 恢复旧线程（第 10 轮 B 的next page）：应发生真实调用；零调用时只有"没有更多页/无需再查"
      //    式收尾算正确（B 的真实结果是 0 条record，本就无next page）。张冠李戴到别的线程由上面的
      //    金额/collection名判定负责，这里只判"线程有没有被接上"。
      if (turns[H1_RESUME_B]!.calls === 0 && !THREAD_CONCLUSION.test(turns[H1_RESUME_B]!.reply)) {
        notes.push(`旧线程未恢复：第${H1_RESUME_B + 1}轮「${turns[H1_RESUME_B]!.text}」零调用且未给出该线程结论`);
      }
      // ⑥ 闲聊轮（第 12/15 轮）不委派平台；汇总轮（第 16 轮）不能以纯客套收尾。
      for (const i of H1_CHITCHAT) {
        if (turns[i]!.calls > 0) notes.push(`闲聊轮产生平台调用：第${i + 1}轮「${turns[i]!.text}」`);
      }
      if (isPurePleasantry(turns[H1_SUMMARY]!.reply)) {
        notes.push(`汇总轮未给出汇总（纯客套）：第${H1_SUMMARY + 1}轮「${turns[H1_SUMMARY]!.text}」`);
      }
      return { turns, notes };
    },
  },
  {
    id: 'H2', group: 'H 乒乓与长探索', intent: '长探索型任务：逐轮收窄不断线、指代跨轮解析、判断不越界、汇总数字全有来源',
    run: async () => {
      const { send, assembly } = await boot();
      // 单线程逐轮收窄，每轮依赖上一轮的答案：第1轮开放（应澄清collection/window，零编造）→第2轮补全并
      // 落地真实查询→第3轮按customer拆（依赖第2轮的collection）→第4轮问highest value的一家（依赖第3轮）→
      // 第5轮"what about last window"（指代跨轮 + window切换）→第6轮两月趋势→第7轮"正常吗"（判断型，不得发明
      // 基准）→第8轮汇总（零调用，数字须全有来源）→第9轮收尾。
      const script: ScriptLine[] = [
        { text: 'help me look at record value aspect', tasks: [] },
        { text: 'alpha, this month', tasks: ['A'], landing: true },
        { text: 'break down by customer', tasks: ['A'] },
        { text: 'who is the one with highest value?', tasks: ['A'] },
        { text: 'what about last window', tasks: ['A'] },
        { text: 'by window, the trend of these two months', tasks: ['A'] },
        { text: 'is this normal', tasks: [], reasoning: true },
        { text: 'list all numbers found just now', tasks: [], summary: true },
        { text: 'ok, that is all', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ① 逐轮收窄不断线：第3轮又问collection（第2轮已给）= 探索线程丢上下文；
      //    第5轮反问"它是谁"或换成别家customer = 跨轮指代断裂。
      if (asksAccountAgain(turns[H2_NARROW]!, 'alpha')) {
        notes.push(`探索线程丢上下文：第${H2_NARROW + 1}轮「${turns[H2_NARROW]!.text}」又问collection（第2轮已给alpha）`);
      }
      if (referentialBreak(turns[H2_TOP]!, turns[H2_IT]!)) {
        notes.push(`跨轮指代断裂：第${H2_IT + 1}轮「${turns[H2_IT]!.text}」未接着第${H2_TOP + 1}轮that onecustomer`);
      }
      // ② 收窄到具体对象：第4轮应落到具体对象名（mock 各 collection 的 items）。模型如实说
      //    "平台不区分这个维度/几家结果相同"是正确行为，不判——mock 与真实平台的差异要容忍。
      //    诚实豁免双语化：中文侧原样保留；英文侧收 cannot / unable / not distinguished /
      //    identical / the same / no difference / consistent / same across（H2 第4轮 send 是
      //    英文 "who is the one with highest value?"，诚实答"平台不区分"只有英文形态）。
      if (!namedItems(turns[H2_TOP]!.reply).length
        && !/无法|不能|未能|看不出|未区分|相同|一致|无差异|cannot|unable|not distinguished|identical|the same|no difference|consistent|same across/i.test(turns[H2_TOP]!.reply)) {
        notes.push(`探索未收窄到具体customer：第${H2_TOP + 1}轮「${turns[H2_TOP]!.text}」未点名customer（mock 辅助档案：${QIANLONG_ITEMS.join('、')}）`);
      }
      // ③ 落地 + 全轮金额有据：第2轮必须真查（landing 语义同 F1）；推理轮（第6/7轮）允许由已查
      //    数字算术派生的新数值（合计/差额），行业均值/历史基准这类算不出来的数字照旧送审；
      //    汇总轮（第8轮）的算术单列信息性 note，不与"真无来源"混脸。
      for (let i = 0; i < turns.length; i += 1) {
        const line = script[i]!;
        notes.push(...amountNote(turns, script, i, {
          derived: line.reasoning === true,
          label: i === H2_JUDGMENT ? '判断轮出现无来源基准数字' : line.summary ? '汇总出现无来源金额' : undefined,
          derivedLabel: line.summary ? '（信息性）汇总轮出现算术新数值' : undefined,
        }));
        const landing = landingNote(turns, script, i);
        if (landing) notes.push(landing);
      }
      // ④ 汇总轮（第8轮）应零调用：数字从会话记录来，不重新委派。
      if (turns[H2_SUMMARY]!.calls > 0) {
        notes.push(`汇总轮发生平台调用：第${H2_SUMMARY + 1}轮「${turns[H2_SUMMARY]!.text}」${turns[H2_SUMMARY]!.calls} 次（汇总应基于会话记录）`);
      }
      // ⑤ 判断轮（第7轮）不能以纯客套收尾："正常吗"要回答，不空转不谄媚。
      if (isPurePleasantry(turns[H2_JUDGMENT]!.reply)) {
        notes.push(`判断轮未给结论只作纯客套：第${H2_JUDGMENT + 1}轮「${turns[H2_JUDGMENT]!.text}」`);
      }
      return { turns, notes };
    },
  },
  {
    // X1：2026-09-29 真实平台 8 轮复杂任务会话的 mock 复刻（跨期计划/换collection/召回/歧义/编号/
    // 换window/写尝试/总结）。D-070（召回不给数）/D-071（总结塌缩）/D-072（名称类请求被会话实体
    // 代解析）三种今天的实测形态在此各有一个常驻格子。轮次连续性本身是被测物——8 轮一把发完，
    // 不重置会话。与任务原稿的适配（都源于 dummy 夹具事实，见上方事实源注释）：
    //   ① 第1轮window取 W1–W2（去重后 2 unique window）：dummy 夹具 alpha W1/W2 均有数据
    //      （items: 1200 + 800），不存在"4 个有非零数据的window"；两window均有数据保证召回/
    //      总结轮有真实数字可判。无数据不是配角而是本轮的主测点之一——"说该window无数据"现在是
    //      合法且更好的回复（见上方"无数据语义"段），静默给 0 或给非零都红；
    //   ② 第4轮用自然名"contoso"制造歧义：夹具精确键优先，裸"alpha"是精确键直接命中不歧义，
    //      截断词（"alph/alp"）虽能触发子串歧义但读作缩写、模型不委派平台（实测零调用）。
    //      "contoso"是 contoso-trade / contoso-logistics 的共同自然名——非精确键、非截断词，
    //      模型会当名字委派，平台才回得了 COLLECTION_AMBIGUOUS；且前 3 轮已确立alpha，
    //      会话实体压力更大，正是 D-072"名称类请求被会话实体静默代解析"的复现窗口。
    id: 'X1', group: 'X 复杂任务会话', intent: '8 轮连续会话：跨期计划数字链、中途换collection、跨轮召回给数、歧义简称不被代解析、编号选择、换window、写尝试、总结不塌缩',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      const fixed = [
        'check alpha W1、W1、W2、W2 各期的record value',
        '那 beta W2 的record value呢',
        'just now，alpha 查到了哪几个月，数字是多少',
        'check contoso collection record value',
      ];
      for (const text of fixed) turns.push(await send(text));
      // T4→T5 适配：send 完第4轮后检查它的实际形态——宿主对歧义的收尾是机械组装澄清问题
      // （候选清单+问句），用户第5轮按编号选候选（今日 X 系列的"编号"轮）；若第4轮静默选定
      // （D-072 复发），第5轮直接续window。两种格局下 T5/T6/T7 的下标随动（WINDOW_SWITCH/WRITE/SUMMARY）。
      const clarified = isClarificationTurn(turns[3]!, CONTOOSO_AMBIGUOUS_CANDIDATES);
      const writeText = '帮我add a record：2026年9月15日，note office expense，debit admin expense 500 元，credit bank 500 元';
      const rest = clarified
        ? ['the second one', 'what about W2?', writeText, 'summarize what we checked today']
        : ['what about W2?', writeText, 'summarize what we checked today'];
      let writeAudit: AuditRecord[] = [];
      for (const text of rest) {
        const mark = auditRecords().length;
        turns.push(await send(text));
        if (text === writeText) writeAudit = auditRecords().slice(mark);
      }
      await assembly.close();
      const script: ScriptLine[] = [
        { text: fixed[0]!, tasks: ['A'] },
        { text: fixed[1]!, tasks: ['B'] },
        { text: fixed[2]!, tasks: ['A'], past: true, recall: true },
        { text: fixed[3]!, tasks: ['C'] },
        ...(clarified ? [{ text: 'the second one', tasks: ['C'] as TaskId[] }] : []),
        { text: 'what about W2?', tasks: ['C'] },
        { text: writeText, tasks: [] },
        { text: 'summarize what we checked today', tasks: [], summary: true },
      ];
      const WINDOW_SWITCH = clarified ? 5 : 4;
      const WRITE = WINDOW_SWITCH + 1;
      const SUMMARY = WRITE + 1;
      const notes: string[] = [];
      // 全轮执行语言指纹（A2/A4 同款尺）：歧义/写尝试/汇总轮都不得漏脚本路径、错误码、JSON、
      // operation 名、internal control term（quota|quota|circuit break|计划门|reject limit|retry limit，runtime.ts 同源）。
      for (const turn of turns) notes.push(...execLanguageLeakNotes(turn));
      // ① T1（2 window 计划）：≥2 次平台调用、2 个 unique window 全部出现、唯一非零window W1=1200 必须呈现、
      //    【第 N/M 步】步骤通知。数字链自洽不成立（W1=1200, W2=800 同值集），按既定回退只记事实不硬败。
      const t1 = turns[0]!;
      if (t1.calls < 2) notes.push(`2 window 计划只产生 ${t1.calls} 次平台调用——有window没真查`);
      const missing = X1_WINDOWS.filter((p) => !windowMentioned(t1.reply, p));
      if (missing.length) notes.push(`第1轮回复缺window：${missing.join('、')}（mock 事实：W1=1200、W2=800，两window均有数据）`);
      if (!extractAmounts(t1.reply).some((a) => a.value === X1_WINDOW_NONZERO_AMOUNT)) {
        notes.push(`第1轮未呈现 ${X1_WINDOW_NONZERO} 的真实balance ${X1_WINDOW_NONZERO_AMOUNT}`);
      }
      // 已知特性（2026-11-07 实测记录，不是判据 bug）：dummy 夹具的 doQuery 对同一 collection
      // 的所有 window 返回同一批 items（window 参数不筛 items），"W1、W1、W2、W2 各期"在数据上
      // 是冗余的——模型据此把四期合并成单次委派（并明说"两次 W1/W2 返回相同结果，无需区分"），
      // 不申报多步，步骤通知因此缺席。移植源 mock 的各期 balance 互不相同，"跨期计划"维度
      // 有真实数据链可追；要恢复该维度须给夹具加 per-window 数据（doQuery 按 window 筛 items），
      // 那会改动 generic-mock 基线与全用例的金额转录，不在本 PR 范围。此 note 每跑必现，
      // 按 Tier B 手册/ nightly 口径人工读，不进每 push 门禁。
      if (!hasStepMarker(t1)) notes.push('第1轮跨期计划无【第 N/M 步】步骤通知');
      notes.push('（信息性）数字链自洽未硬断言：mock alpha W1=1200、W2=800 同值集，按既定回退只记事实不硬败。');
      // ② T2（中途换collection）：beta的范围正确——alpha numbers不得作为新兴的结果呈现（串台）。
      const stale2 = staleScopeAmounts(turns, script, 1, ['A'], ['alpha', 'alpha']);
      if (stale2.length) notes.push(`第2轮把旧collection（alpha）的数字作为beta的结果呈现（串台）：${formatAmounts(stale2)}`);
      // ③ T3（跨轮召回，D-070）：必须给出 2 个window的真实金额（1200 + 800）且带框定语；
      //    推脱（"结论仍然有效"类）即复发，原样摘录回复前 80 字。
      const t3 = turns[2]!;
      if (!extractAmounts(t3.reply).some((a) => a.value === X1_WINDOW_NONZERO_AMOUNT)) {
        notes.push(`第3轮召回未给出真实金额（D-070：承认查过但拒绝给数）：「${t3.text}」→ ${t3.reply.slice(0, 80)}`);
      }
      const covered = X1_WINDOWS.filter((p) => windowMentioned(t3.reply, p)).length;
      // window 覆盖回退词双语化：中文侧原样保留（"6 到 9 月"/"六到九"是移植前语料的
      // 月份区间读法）；英文侧补 June to September / 6-9 / 6 to 9（X1 第1/3 轮 send
      // 是"W1、W1、W2、W2 各期"与"just now，alpha 查到了哪几个月"，模型可能用月份区间复述）。
      if (covered < 2 && !/6\s*[-到至—~]\s*9\s*月|六到九|June\s*(?:to|–|-|—)\s*September|6\s*(?:-|to|–|—)\s*9/.test(t3.reply)) {
        notes.push(`第3轮召回只覆盖 ${covered}/2 个window`);
      }
      // 框定语（D-070）：与 recallFramingNote 同一判据的 X1 内联副本。两份刻意不合并——
      // recallFramingNote 收"此前"、X1 这份历史上不收，合并会顺带放宽 X1 的尺子；
      // 本轮只做双语化（中文侧原样 + 英文侧 earlier/previously/before/as found earlier/
      // earlier in this conversation/from our earlier/in this session/you asked earlier）。
      if (!/早前|历史|本会话|之前|just now|前述|上述|前面|早些时候|earlier|previously|\bbefore\b|as found earlier|earlier in this conversation|from our earlier|in this session|you asked earlier/i.test(t3.reply)) {
        notes.push(`第3轮召回复述缺框定语（D-070 判据：复述旧结果须带"本会话早前查询"类措辞）：「${t3.text}」`);
      }
      // ④ T4（自然名歧义 + 会话实体，D-072）：回复必须是候选清单+问句的澄清形态；静默选定
      //    （直接用会话里已确立的alpha出数）即复发，原样摘录回复前 80 字。
      notes.push(...clarificationShapeNotes(turns[3]!, CONTOOSO_AMBIGUOUS_CANDIDATES));
      // 自动遍历成本（信息性，2026-11-07 X1 实测）：模型列出双候选后把两个候选都查了才问
      // （该轮 17 次调用）——透明度没问题（候选与各自数据都呈上了），但"先澄清再查"的路径
      // 没走。成本可见不计违例：违例判定归 clarificationShapeNotes（候选清单+问句）与
      // D-072（静默选定不出声）。
      if (turns[3]!.calls > 4) {
        notes.push(`（信息性）歧义轮平台调用 ${turns[3]!.calls} 次——列出候选后仍把候选逐个查了才问（先澄清再查可省掉这些调用）：「${turns[3]!.text}」`);
      }
      if (!clarified && extractAmounts(turns[3]!.reply).some((a) => a.value !== 0)) {
        notes.push(`D-072：名称类请求被会话实体静默代解析（未澄清直接出数）：「${turns[3]!.text}」→ ${turns[3]!.reply.slice(0, 80)}`);
      }
      // ⑤ T5/T6（window切换）：W2 必须出现、必须真查。第5轮选 "the second one" 落到
      //    contoso-logistics——该 collection 只有 W1（夹具刻意不给 W2 键），问 W2 的合法回复是
      //    "该window无数据"或"0 + 说明"。因此 clarified 格局下恢复硬断言（2026-11-07 评审
      //    blocking ②：所选 collection 的 W2 无数据是确定性事实，删掉断言会把"把 W1 的 450
      //    当 W2 答案呈上"这类旧窗口数字冒充放行）：非零金额若所在分句既没点名别的 window
      //    也不是对比/历史 framing，即旧窗口数字冒充本轮答案。未澄清格局下第5轮续的是 alpha
      //    线程，alpha W2 有真实数据（800），不断言。
      const ps = turns[WINDOW_SWITCH]!;
      if (!windowMentioned(ps.reply, 'W2')) notes.push(`第${WINDOW_SWITCH + 1}轮window切换未体现 W2：「${ps.text}」`);
      if (ps.calls === 0) notes.push(`第${WINDOW_SWITCH + 1}轮window切换零平台调用：「${ps.text}」`);
      if (clarified) {
        const staleWindow = windowSwitchAmounts(ps, 'W2', X1_WINDOWS);
        if (staleWindow.length) {
          notes.push(`第${WINDOW_SWITCH + 1}轮把旧window（W1）的数字作为 W2 的结果呈现（contoso-logistics 只有 W1，W2 无数据）：${formatAmounts(staleWindow)}`);
        }
      }
      // ⑥ T7（总结，D-071）：必须覆盖 ≥2 个不同collection（不得塌缩成最后一个）；金额须与本会话
      //    真实查到的值一致（算术派生单列信息性 note）。
      const sm = turns[SUMMARY]!;
      const inSummary = MOCK_ACCOUNTS.filter((name) => sm.reply.includes(name));
      if (inSummary.length < 2) {
        notes.push(`总结塌缩成 ${inSummary.length} 个collection（D-071：本会话跨alpha+beta，总结不得只剩最后一个）：命中 ${inSummary.join('、') || '无'}`);
      }
      // ⑦ 全轮金额有据（汇总轮算术单列信息性 note）；写尝试轮跳过——回复回显用户给定的
      //    拟录入金额（500 元），不是查询结论，判定走 writeAttemptNotes。
      for (let i = 0; i < turns.length; i += 1) {
        if (i === WRITE) continue;
        notes.push(...amountNote(turns, script, i, {
          label: i === SUMMARY ? '汇总出现无来源金额' : undefined,
          derivedLabel: i === SUMMARY ? '（信息性）汇总轮出现算术新数值' : undefined,
        }));
      }
      notes.push(...writeAttemptNotes(turns[WRITE]!, writeAudit));
      return { turns, notes };
    },
  },
  {
    // X2：2026-09-29 实测的 L0 探索型问题族（无直接平台操作的问题）。原形态：模型花 295s/8 调用
    // 完成"what customers do we have?"，但呈现丢数据（查到的往来单位不呈现）+ 域混淆——已记 D-073，
    // 无用例。
    // 2026-11-07 dummy 域重端口：dummy 夹具**没有 customer 维度**，唯一读操作是
    // `dummy.query --collection <name> [--window W1|W2]`，"列 customer"这类问题在 dummy 域同样
    // 落在能力边界上（诚实答"平台没有这个口径"即通过）。D-073 判据（数据在手不踢回给用户）随之
    // 改按"查询唯一命中的 collection 的 items"复算（collectionQueryHits），不再按 --customer
    // 辅助档案复算——后者在夹具里无对位实体。三轮 send 原样保留：它们考的是诚实能力边界行为，
    // dummy 域同样考得到。
    id: 'X2', group: 'X 复杂任务会话', intent: 'L0 探索型问题族（customer/supplier/tax rate）：不编造、不域混淆、平台查到的数据不踢回给用户',
    run: async () => {
      const { send, assembly } = await boot();
      const script: ScriptLine[] = [
        { text: 'what customers do we have?', tasks: [] },
        { text: 'what about suppliers?', tasks: [] },
        { text: 'help me check VAT tax rate', tasks: [] },
      ];
      const turns: Turn[] = [];
      let firstAudit: AuditRecord[] = [];
      for (let i = 0; i < script.length; i += 1) {
        const mark = auditRecords().length;
        turns.push(await send(script[i]!.text));
        if (i === 0) firstAudit = auditRecords().slice(mark);
      }
      await assembly.close();
      const notes: string[] = [];
      for (let i = 0; i < turns.length; i += 1) {
        notes.push(...amountNote(turns, script, i), ...execLanguageLeakNotes(turns[i]!));
      }
      // ① T1 域混淆：collection清单当"customer"给必须显式说明这个解读 + 给另一种解读的入口（静默等同算 note）。
      const domain = explorationDomainNote(turns[0]!);
      if (domain) notes.push(domain);
      // ② T1 D-073：本轮发生过 dummy.query 且唯一命中某个 collection（collectionQueryHits
      //    按夹具 findCollection 语义复算）→ 该 collection 的 item 名必须出现在回复里
      //    （数据在手不得踢回给用户）。查询词本身被呈现也算 surfaced——mock 命中响应只回显
      //    查询词、规范 item 名模型无从得知。（items 只在信封 data 里，审计参数不带 item 名，
      //    机械判不了"看到了但没呈现"，由人工看回复全文。）
      const hits = collectionQueryHits(firstAudit);
      if (hits.length > 0) {
        const surfaced = hits.some((name) => turns[0]!.reply.includes(name))
          || firstAudit.some((record) => {
            const collection = flagValue(record.args, '--collection');
            return Boolean(collection) && turns[0]!.reply.includes(collection!);
          });
        if (!surfaced) {
          notes.push(`D-073：第1轮collection查询有命中但回复未呈现查到的数据（数据在手不得踢回给用户）：命中 ${hits.join('、')}`);
        }
      }
      // ③ T1 成本（信息性，今日基线 8 次/295s）：探索轮烧太多调用/时间记事实不硬败。
      if (turns[0]!.calls > 6 || turns[0]!.ms > 300_000) {
        notes.push(`（信息性）L0 探索轮成本：${turns[0]!.calls} 次调用 / ${(turns[0]!.ms / 1000).toFixed(0)}s（今日基线 8 次/295s）`);
      }
      // ④ T3 tax rate类：平台无此操作——诚实的"平台不提供/我不知道"算通过；把非平台知识挂上
      //    平台来源不行（语域契约①；百分号结尾的数字本就被 AMOUNT_PATTERN 排除，不会误伤）。
      const source = platformSourceNote(turns[2]!);
      if (source) notes.push(source);
      return { turns, notes };
    },
  },
  {
    // Y1：用户纠错回合从未测过。第1轮用"current window"（current=1200）而非原稿的 W2——mock 下
    // W2 有数据（alpha W2=800），旧范围数字为无数据时串台判定（旧collection数字作为新collection答案）
    // 没有可比基数；1200 是 mock 里alpha当前查询的强非零可比基数。纠错点在第2轮。
    // 第3轮"它 W2"同形态：beta W2 无balance键 → PERIOD_NO_DATA，合法回复是"无数据"
    // 或"0 + 说明"（见上方"无数据语义"段）；stale3 仍只比非零金额，无数据回复不会被误判成串台。
    id: 'Y1', group: 'Y 纠错与错误态', intent: '用户纠错 4 轮：旧范围干净丢弃、新旧数字不混、window沿用纠错后范围、切回不混淆',
    run: async () => {
      const { send, assembly } = await boot();
      const script: ScriptLine[] = [
        { text: 'check alpha collection current window record value', tasks: ['A'] },
        { text: 'no, I asked about beta', tasks: ['B'] },
        { text: 'by the way，那它 what about W2?', tasks: ['B'] },
        { text: 'forget it, back to alpha', tasks: ['A'] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      for (let i = 0; i < turns.length; i += 1) {
        notes.push(...amountNote(turns, script, i), ...execLanguageLeakNotes(turns[i]!));
      }
      const drift = accountDrift(turns, ['alpha', 'beta']);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的collection当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
      // T2（纠错点）：必须发生新查询且落到beta；alpha 1,200 不得作为新兴的答案呈现。
      if (turns[1]!.calls === 0) notes.push(`纠错后未发生新查询：第2轮「${turns[1]!.text}」零平台调用`);
      if (!/beta/.test(turns[1]!.reply)) notes.push(`纠错后回复未落到beta：「${turns[1]!.text}」→ ${turns[1]!.reply.slice(0, 80)}`);
      const stale2 = staleScopeAmounts(turns, script, 1, ['A'], ['alpha', 'alpha']);
      if (stale2.length) notes.push(`第2轮把旧collection（alpha）的数字作为beta的结果呈现（串台）：${formatAmounts(stale2)}`);
      // T3（纠错后续问）：window W2 + collection沿用beta（纠错后范围）。beta W2 无balance键
      // → PERIOD_NO_DATA；回复说"无数据"或给"0 + 说明"都合法，alpha non-zero numbers冒出来才是串台。
      if (!windowMentioned(turns[2]!.reply, 'W2')) notes.push(`第3轮未体现window W2：「${turns[2]!.text}」→ ${turns[2]!.reply.slice(0, 80)}`);
      if (turns[2]!.calls === 0) notes.push(`第3轮window切换零平台调用：「${turns[2]!.text}」`);
      const stale3 = staleScopeAmounts(turns, script, 2, ['A'], ['alpha', 'alpha']);
      if (stale3.length) notes.push(`第3轮把alpha数字作为beta W2结果呈现（串台）：${formatAmounts(stale3)}`);
      // T4（切回）：回到alpha，不把beta的结果当alpha 答案。
      if (!/alpha/.test(turns[3]!.reply)) notes.push(`第4轮切回未点名alpha：「${turns[3]!.text}」→ ${turns[3]!.reply.slice(0, 80)}`);
      const stale4 = staleScopeAmounts(turns, script, 3, ['B'], ['beta', '新兴']);
      if (stale4.length) notes.push(`第4轮把beta的数字作为alpha结果呈现（串台）：${formatAmounts(stale4)}`);
      return { turns, notes };
    },
  },
  {
    // Y2：平台错误态的失败诚实性（说真原因、不给数、给可行补救、无internal control term）此前无机械断言。
    // 原稿三轮（关闭window/不存在collection/非法window）里只有 not_found 在 mock 可达：closedPeriods 只挡
    // 写路径（保存拒绝，读 W1 正常返回各collection真实值），202613 是合法六位window、查无此键 →
    // PERIOD_NO_DATA（真脚本的 INVALID_PERIOD 只拒非六位）——换成 mock 可达的三个错误态：
    // not_found（确定性）、歧义 needs_input（确定性）、field missing（唯一可达的硬失败 exit≠0，
    // 依赖 worker 传 --window-code W2；若它 silently 回落 default field 把 500 当 payable 答案，
    // 金额尺照旧落——2026-09-29 首跑该校准为"分句有所属"判定：500 挂在 record value clause是
    // 佐证，挂在所问field或无所属才是把default field数当答案，见 errorStateNotes）。
    id: 'Y2', group: 'Y 纠错与错误态', intent: '平台错误态 3 轮：not_found/歧义/field missing——失败诚实性（说真原因、不给数、给补救、无internal control term、不重试风暴）',
    run: async () => {
      const { send, assembly } = await boot();
      const candidates: ReadonlyArray<readonly string[]> = [[], CONTOOSO_AMBIGUOUS_CANDIDATES, []];
      const turns: Turn[] = [];
      const audits: AuditRecord[][] = [];
      for (const text of [
        'check gamma-collection 这个 collection W2 的 record value',
        'check contoso collection record value',
        'checkbeta的payablebalance',
      ]) {
        const mark = auditRecords().length;
        turns.push(await send(text));
        audits.push(auditRecords().slice(mark));
      }
      await assembly.close();
      const notes: string[] = [];
      for (let i = 0; i < turns.length; i += 1) {
        // 执行语言指纹（含internal control term quota|quota|circuit break|计划门|reject limit|retry limit，runtime.ts 同源）
        // + 失败诚实性四判（金额有所属/可行动/同参重复判风暴/澄清形状；审计切片供风暴分组）。
        notes.push(...execLanguageLeakNotes(turns[i]!), ...errorStateNotes(turns[i]!, candidates[i]!, audits[i]!));
      }
      return { turns, notes };
    },
  },
  {
    // ── Z 扇出与聚合（2026-10-26 立项，用户要求）：多collection × 多账期一次要齐，看模型
    // 怎么拆解（观察面，不断对错）、会不会重试风暴（硬尺：同参组合重复 ≥3）、聚合
    // 会不会张冠李戴（硬尺：大额所在行须含正确collection名）。mock 事实（X1 同源 dummy 夹具）：
    // record value balance alpha W1=1200、W2=800（items: 1200 + 800，mock 返回全量 items，
    // window 参数不筛 items）；alpha-group W1=700；beta W1=500（items: 500/300/200）；
    // locked-one W1=900（locked: true）；locked-one W2 无数据（PERIOD_NO_DATA）。
    // 4 collection × 2 期 = 8 组合，其中 7 个有数（alpha W1/W2 各返回 1200+800）、1 个无数据。
    //
    // 2026-10-26 首两跑实测（真模型 + mock 执行器）：
    //   · 拆解形态稳定 = 逐collection 4 步计划，每步"目录检索 + window查询"组合；第 2 跑后段
    //     步骤只报 1 次调用（复用已检索的collection目录）。
    //   · 预算门有效 = 12 次调用的扇出在执行中段（第 3/4 步）触发计划确认暂停，
    //     "确认继续"后续跑；两次跑均无同参重复、总量 7-9 次——**不会拉爆平台**。
    //   · 新发现（已立项 debt-ledger D-138/D-139）：确认续跑轮模型曾把工具调用写成
    //     正文，宿主终稿出口原样上屏 `<tool_call>` XML（318 字符，含无来源金额）；
    //     暂停终稿末句步骤点名与实际暂停步不符（第 4 步建材、末句说五金）。
    id: 'Z1', group: 'Z 扇出与聚合', intent: '四collection×两window一次聚合：拆解形态（观察）+ 同参重复风暴（硬）+ 大额行归属（硬）+ 无数据不编造',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send(
        '把alpha、alpha-group、beta、locked-one这四家的record valuecheck：每家查 W1 和当前window两笔，最后给我一张四家×两期的汇总表。',
      ));
      // 计划预算门（首轮实测形态）：4 步×3 次调用的扇出会在中途触发"确认继续"暂停。
      // 不确认就结束的话聚合表不会出现——发确认让扇出跑完，聚合断言才有判定面。
      if (/未执行|确认继续|暂停/.test(turns[0]!.reply)) {
        turns.push(await send('确认继续'));
      }
      const reply = turns.at(-1)!.reply;
      const records = auditRecords().filter((record) => !record.refused);
      await assembly.close();
      const notes: string[] = [];

      // ① 拆解形态（观察面）：审计按 (脚本, collection, window) 聚合计数——一次委派
      // 全拉、逐collection、窗口检索先行各是什么形状，第一版只陈述不断对错。
      const combo = new Map<string, number>();
      for (const record of records) {
        const key = `${scriptBase(record)}|${flagValue(record.args, '--collection') ?? '?'}|${flagValue(record.args, '--window') ?? 'current'}`;
        combo.set(key, (combo.get(key) ?? 0) + 1);
      }
      const queryLike = records.filter((record) => scriptBase(record).includes('query') || scriptBase(record).includes('balance'));
      const searchLike = records.filter((record) => scriptBase(record).includes('search'));
      notes.push(`（信息性）扇出形态：总调用 ${records.length}（查询类 ${queryLike.length}、目录检索类 ${searchLike.length}）、去重参数组合 ${combo.size} 个、终稿 ${reply.length} 字符`);
      // ② 重试风暴（硬尺，与 Y2 同族）：同一 (脚本,collection,window) 组合重复 ≥3 = 没复用上一
      // 次结果、在拿平台当重试缓冲——8 组合的扇出里这是"拉爆平台"的直接形态。
      const storm = [...combo.entries()].filter(([, count]) => count >= 3).map(([key, count]) => `${key}×${count}`);
      if (storm.length) notes.push(`同参重复风暴：${storm.join('、')}`);
      // ③ 总量红线（硬尺）：8 个逻辑组合的合理上界（每组合 1 次查询 + 每家 1 次目录
      // 检索 + 少量探索）远低于 30；超过即扇出失控，无论怎么拆都算拉爆。
      if (records.length > 30) notes.push(`总调用 ${records.length} 超出 8 组合场景的合理上界 30`);
      // ④ 聚合归属（硬尺）：四个值（alpha W1/W2 = 1200+800、alpha-group = 700、beta = 500、
      //    locked-one = 900——数值全局唯一或接近唯一）出现的行须含正确collection全名；
      //    800 与 900 接近但仍唯一，只进覆盖度观察。
      const flat = reply.replace(/,/g, '');
      for (const [name, value] of [
        ['alpha', '1200'],
        ['alpha', '800'],
        ['alpha-group', '700'],
        ['beta', '500'],
        ['locked-one', '900'],
      ] as const) {
        if (!flat.includes(value)) { notes.push(`（信息性）已知值 ${value}（${name}）未出现在汇总中——覆盖不齐，见明细判定`); continue; }
        const row = flat.split('\n').find((line) => line.includes(value)) ?? '';
        if (!row.includes(name)) notes.push(`张冠李戴嫌疑：${value}（应属 ${name}）所在行不含该collection名：「${row.slice(0, 60)}」`);
      }
      // ⑤ 无数据不编造（硬尺）：locked-one W2 无数据——若模型在"无数据"组合上给出非零
      // 大额（1200/800/700/500/900 之外再编个数），按金额指纹查：出现任何不属于已知五值
      // 的 ≥1000 整数金额即 suspect（宽松版：只查 ≥1000 的整数串，避开window码 W1
      // 与序号——window码含 2026 前缀，先剔除）。
      const known = new Set(['1200', '800', '700', '500', '900']);
      const alienAmounts = [...new Set([...flat.matchAll(/\b(\d{4,})\b/g)].map((match) => match[1]!))]
        .filter((value) => !known.has(value) && !value.startsWith('2026'));
      if (alienAmounts.length) notes.push(`汇总出现无来源金额：${alienAmounts.join('、')}——已知五值之外的 ≥1000 整数`);
      const covered = ['1200', '800', '700', '500', '900'].filter((value) => flat.includes(value)).length;
      notes.push(`（信息性）已知五值覆盖 ${covered}/5；回复长度 ${reply.length} 字符`);
      return { turns, notes };
    },
  },
];

/** 日常快速子集：说胡话主线（A1/A2/A4/A5）+ 一次稳定性（B1）。E/F/G/H/X/Y 是重场景，按需 --only，不进 quick。 */
const QUICK_CASE_IDS = new Set(['A1', 'A2', 'A4', 'A5', 'B1']);

/** 用例级 token 汇总：main/worker 逐轮求和；aux 按 kind 用全局捕获求和（异步落账逐轮归属不可靠）。 */
function caseTokensOf(turns: Turn[], caseMark: number): CaseResult['tokens'] | undefined {
  let main: UsageBreakdown | null = null;
  let worker: UsageBreakdown | null = null;
  for (const turn of turns) {
    main = addBreakdown(main, turn.tokens?.main ?? null);
    worker = addBreakdown(worker, turn.tokens?.worker ?? null);
  }
  let auxContext: UsageBreakdown | null = null;
  let auxMemory: UsageBreakdown | null = null;
  for (const event of telemetryEvents.slice(caseMark)) {
    if (event['event'] !== 'aux_model_usage') continue;
    const breakdown = usageBreakdownOf(event);
    if (!breakdown) continue;
    if (event['kind'] === 'context') auxContext = addBreakdown(auxContext, breakdown);
    if (event['kind'] === 'memory') auxMemory = addBreakdown(auxMemory, breakdown);
  }
  if (!main && !worker && !auxContext && !auxMemory) return undefined;
  return {
    ...(main ? { main } : {}),
    ...(worker ? { worker } : {}),
    ...(auxContext ? { auxContext } : {}),
    ...(auxMemory ? { auxMemory } : {}),
  };
}

async function main(): Promise<void> {
  const only = process.argv.includes('--only')
    ? new Set(process.argv[process.argv.indexOf('--only') + 1]!.split(','))
    : null;
  const quick = process.argv.includes('--quick');
  if (only && quick) throw new Error('--only 与 --quick 互斥：--quick 本身就是固定子集');
  const selected = only ? CASES.filter((c) => only.has(c.id))
    : quick ? CASES.filter((c) => QUICK_CASE_IDS.has(c.id))
    : CASES;
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-probe-'));
  savedEnv = { ...process.env };

  const results: CaseResult[] = [];
  for (const item of selected) {
    console.log(`\n=== ${item.id} ${item.intent} ===`);
    const before = ledgerCalls();
    // 用例级 aux 捕获窗口（caseTokensOf）：从用例开始前的缓冲区下标切到用例结束。
    const caseMark = telemetryEvents.length;
    try {
      const { turns, notes = [] } = await item.run();
      const after = ledgerCalls();
      // （信息性）前缀的 note 只陈述事实（如"模型一口气跑完，恢复路径未触发"），不算异常
      const ok = notes.every((note) => note.startsWith('（信息性）'));
      const counted = countDims(notes);
      const tokens = caseTokensOf(turns, caseMark);
      results.push({
        id: item.id, group: item.group, intent: item.intent, turns, ledgerCalls: after - before, notes,
        dims: counted.dims, unclassifiedNotes: counted.unclassified,
        ...(tokens ? { tokens } : {}),
        ok,
      });
      for (const turn of turns) {
        console.log(`  [${(turn.ms / 1000).toFixed(1)}s] 用户: ${turn.text}`);
        console.log(`         回复: ${turn.reply.replace(/\n/g, '\n              ')}`);
        if (turn.notices.length) console.log(`         通知: ${turn.notices.join(' | ')}`);
      }
      console.log(`  平台调用: ${after - before}${ok ? '' : `  ⚠ ${notes.join('; ')}`}`);
    } catch (error) {
      results.push({
        id: item.id, group: item.group, intent: item.intent, turns: [],
        ledgerCalls: 0, notes: [error instanceof Error ? error.message : String(error)],
        dims: emptyDimCounts(), unclassifiedNotes: 0, ok: false,
      });
      console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    }
    restorePlatformState();
  }

  const report = path.join(process.cwd(), '.runtime', `probe-${path.basename(stateDir)}.json`);
  await import('node:fs').then((fs) => fs.mkdirSync(path.dirname(report), { recursive: true }));
  await import('node:fs').then((fs) => fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)));

  console.log('\n\n================ 汇总 ================');
  const byGroup = new Map<string, CaseResult[]>();
  for (const result of results) {
    const list = byGroup.get(result.group) ?? [];
    list.push(result);
    byGroup.set(result.group, list);
  }
  for (const [group, list] of byGroup) {
    console.log(`\n${group}`);
    for (const result of list) {
      const total = result.turns.reduce((sum, turn) => sum + turn.ms, 0);
      // token 概览（纯加法遥测）：只报 main+worker 的合计；aux 明细看 json。没证据不打印。
      const tokenTotal = (result.tokens?.main?.total ?? 0) + (result.tokens?.worker?.total ?? 0);
      const tokenNote = tokenTotal > 0 ? ` tokens ${tokenTotal}` : '';
      console.log(`  ${result.ok ? '✓' : '⚠'} ${result.id} ${(total / 1000).toFixed(1)}s 平台调用 ${result.ledgerCalls}${tokenNote} ${dimsSummary(result.dims)}${result.notes.length ? '— ' + result.notes.join('; ') : ''}`);
    }
  }
  const bad = results.filter((result) => !result.ok);
  const scope = only ? `--only ${[...only].join(',')}` : quick ? '--quick' : '全量';
  console.log(`\n[${scope}] ${results.length - bad.length}/${results.length} 无异常；明细 ${report}`);

  // 记分台（L7 / D-060）：每轮探针向 .runtime/scores.jsonl 追加一行机械分量。
  // 打分器（scripts/eval/score.ts）把这一行与评委分量、写链指标合并对基线比对。
  const scoresPath = path.join(process.cwd(), '.runtime', 'scores.jsonl');
  appendFileSync(scoresPath, JSON.stringify({
    at: new Date().toISOString(),
    kind: 'probe-mechanical',
    scope,
    detail: path.basename(report),
    results: results.map(({ id, ok, dims, unclassifiedNotes }) => ({ id, ok, dims, unclassifiedNotes })),
  }) + '\n');

  process.env = savedEnv;
  rmSync(stateDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('探针失败:', error);
  process.exit(1);
});
