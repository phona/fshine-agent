/**
 * 真实模型探针：把消息直接注入生产装配，跑真实 LLM + 真实 17dz 计划门禁 + mock 执行器。
 *
 * 与 tests/e2e/turn-loop-*.test.ts 的差别只有一点：那里的 Main Agent 和
 * 17dz 子 Agent 是脚本化驱动，这里用真实 pi driver。企微仍由假 SDK 替代（不起长连接）。
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
 * 全量约 110 分钟（G1 约 20 分钟、G2 约 8 分钟、H1 约 35 分钟、H2 约 15 分钟）。涉及申报/指代的 Phase 按 roadmap 验证协议加跑 --only C1。
 * E/F/G/H 是重场景（多任务交织、探索型会话、并发多线程、乒乓与长探索），按需 --only E1 / --only F1 / --only G1,G2 / --only H1,H2，不进 quick。
 *
 * 用例分组：
 *   A 说胡话（A1–A5）：重放历史、范围渗入、歧义澄清、闲聊不委派。
 *   B 稳定性（B1/B2）：连发重查口径一致、期间口径体现在回复。
 *   C 长会话（C1）：20 轮混合对话的漂移、变慢与旧范围渗入。
 *   D 长任务（D1/D2）：跨月查询先通知、高重量任务停在确认门。
 *   E 多任务交织（E1）：三任务交织后召回旧任务、恢复旧任务线程，汇总不张冠李戴。
 *   F 探索型会话（F1）：目标不明的模糊请求不编造，补充明确后落地为真实查询。
 *   G 并发多线程（G1/G2）：多步核对计划被探索插曲打断后跨回合恢复、失败步授权跳过；用户让 agent 提议查法（meta-planning）。
 *   H 乒乓与长探索（H1/H2）：四任务跨 16 轮来回切的线程隔离/召回一致/重查正确/汇总诚实；单线程逐轮收窄的探索不断线、指代跨轮解析、判断不越界。
 *
 * 关注九件事：会不会说胡话（重放历史/范围渗入）、每次是否稳定、长会话是否漂移、长任务是否收口、
 * 多任务交织后能否召回与恢复、探索型会话能否不编造并落地、并发多线程下计划能否跨回合恢复（授权跳过被尊重、agent 能提议查法）、
 * 多任务乒乓跨多轮切换能否线程隔离且跨线程汇总诚实、长探索型任务逐轮收窄能否不断线（指代跨轮解析、判断不发明基准）、
 * 歧义/未找到回复是否零执行语言指纹（脚本路径/错误码/JSON——2026-09-27 Stage 3 事故：一次结构化歧义被模型翻译成
 * 1201 字符技术报告；宿主改为机械组装澄清问题后，这条由 A2/A3/A4/D1 的断言守）。
 * 结果写 .runtime/probe-<runId>.json，同时在终端打可读摘要。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { executionLanguageFingerprints, isPlatformMock } from '@fshine/agent';
import type { SdkClientLike } from '@fshine/channel-wecom';
import { createServerAssembly, type ServerAssembly } from '../apps/server/assembly';

const PRINCIPAL_USER = 'REPLACE_WITH_YOUR_WECOM_USERID';

interface Turn {
  text: string;
  reply: string;
  ms: number;
  notices: string[];
  /** 本轮实际产生的平台调用数（17dz plan state 的 actual.calls 增量；隔离状态按用例累计，可逐轮相减）。 */
  calls: number;
  group?: boolean;
}

interface CaseResult {
  id: string;
  group: string;
  intent: string;
  turns: Turn[];
  ledgerCalls: number;
  notes: string[];
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

const PLATFORM_STATE_KEYS = ['DZ_PLAN_STATE', 'DZ_RATE_LIMIT_STATE', 'DZ_MOCK_STATE', 'DZ_AUDIT_PATH'] as const;
let platformStateBackup: Record<string, string | undefined> = {};

function isolatePlatformState(): void {
  platformStateBackup = Object.fromEntries(PLATFORM_STATE_KEYS.map((key) => [key, process.env[key]]));
  counter += 1;
  Object.assign(process.env, {
    DZ_PLAN_STATE: path.join(stateDir, `plans-${counter}.json`),
    DZ_RATE_LIMIT_STATE: path.join(stateDir, `rate-${counter}.json`),
    DZ_MOCK_STATE: path.join(stateDir, `mock-${counter}.json`),
    DZ_AUDIT_PATH: path.join(stateDir, `audit-${counter}.jsonl`),
    // 网关限流有 17dz 专项测试；mock 上探针要跑长任务，放宽 burst 以免被限流挡住主线。
    // 真实平台保持生产限流（"别让下游平台有感知"）：探针节奏天然低于限额，被限就是信号。
    ...(isPlatformMock() ? { DZ_RATE_LIMIT: JSON.stringify({ read: { burst: 200, perMs: 0 }, global: { burst: 400, perMs: 0 } }) } : {}),
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
  const file = process.env['DZ_PLAN_STATE'];
  if (!file || !existsSync(file)) return 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: Record<string, { actual?: { calls?: number } }> };
    return Object.values(state.tasks ?? {}).reduce((sum, task) => sum + (task.actual?.calls ?? 0), 0);
  } catch { return 0; }
}

async function boot(): Promise<{ send: (text: string) => Promise<Turn>; assembly: ServerAssembly; sdk: RecordingSdk }> {
  isolatePlatformState();
  const sdk = new RecordingSdk();
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
      const startedAt = Date.now();
      sdk.emit('message.text', wecomText(PRINCIPAL_USER, text));
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline) {
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) {
          return {
            text,
            reply: finals.at(-1)!.content,
            ms: Date.now() - startedAt,
            notices: sdk.frames.filter((frame) => !frame.finish && frame.content.startsWith('计划通知：')).map((frame) => frame.content),
            calls: ledgerCalls() - callsBefore,
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
  /** 高置信金额：带千分位/小数/万亿单位。裸整数（700、1122）低置信——科目编号等噪声混在里面。 */
  confident: boolean;
}

/**
 * 货币量级数字：千分位（86,000.00）、小数（0.00）、万/亿（8.6 万→86000）、
 * 裸整数（700、86000）、裸 0。刻意排除：百分号结尾、四位年份与"年.月"（2026 / 2026.09）、
 * YYYYMM 期间（202609）、日期/版本号里的数字片段（lookaround 挡连字符与点号相邻片段）。
 * 按数值去重（保留首个原文），零值单列——0/0.00 在平台回复里是格式噪声（贷方 0、空结果 0.00）。
 */
const AMOUNT_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*[万亿]|\d+\.\d+(?![\d%％])|(?<![\d.])\d{3,}(?![\d.%％])|(?<![\d.])0(?![\d.])/g;

function extractAmounts(text: string): Amount[] {
  const seen = new Map<number, Amount>();
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[0]!;
    if (/^(?:19|20)\d{2}(?:\.\d{1,2})?$/.test(raw)) continue; // 年份/年.月不是金额
    if (/^20\d{4}$/.test(raw)) continue;                     // YYYYMM 期间不是金额
    const value = /[万亿]/.test(raw)
      ? parseFloat(raw) * (raw.includes('亿') ? 1e8 : 1e4)
      : parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || seen.has(value)) continue;
    const confident = /,\d{3}/.test(raw) || /\.\d/.test(raw) || /[万亿]/.test(raw);
    seen.set(value, { raw, value, confident });
  }
  return [...seen.values()];
}

type TaskId = 'A' | 'B' | 'C' | 'D';

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

/**
 * 由已查数字算术得出的新数值（汇总/对比轮的合计、差额）：等于基集里某两个的和或差。
 * 宿主无法在"算术"与"编造"间确定性区分（§9 记录的同族问题），探针侧只把"算不出来"的金额送审。
 */
function isDerivedAmount(value: number, base: Set<number>): boolean {
  const values = [...base];
  return values.some((a) => values.some((b) => a + b === value || Math.abs(a - b) === value));
}

/** note 回显：高置信金额是主信号；裸整数（无千分位/小数/单位）多为科目编号，单列降噪。 */
function formatAmounts(amounts: Amount[]): string {
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
 * 纯客套：剥掉客套词、语气词、标点后不剩任何实质内容。
 * 澄清问句、能力边界说明、带数据/带账套名的回复都剩下内容，不算客套。
 */
function isPurePleasantry(text: string): boolean {
  const stripped = text
    .replace(/好的|好|嗯|行|收到|明白|了解|清楚|稍等|稍候|马上|立刻|谢谢|感谢|多谢|不客气|辛苦|OK|ok|请|呀|啊|呢|吧|嘛|哦|噢|你|您|我|它|他|她|咱们|大家|了|的|是|就|也|和|跟|吗|么/g, '')
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
  // 算术派生的新数值（合计/差额）三种处理：推理轮（derived）直接放行——算术正是这类轮次该做的事；
  // 汇总轮（derivedLabel）单列信息性 note——算术可见，但不与"真无来源"混为一张脸；其余轮次
  // （E1/F1/G1/G2 及普通轮次）并入硬 note，与既有行为一致。
  const arithmetic = outside.filter((a) => isDerivedAmount(a.value, allowed));
  const tolerated = options.derived ? arithmetic : [];
  const soft = options.derivedLabel ? arithmetic.filter((a) => !tolerated.includes(a)) : [];
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
 * 任务串台的文本侧证据（E1/H1 共用）：用户点明了某些账套的轮次，回复把"用户没点名的账套"
 * 当成本轮已查结果。只在用户点名了账套的轮次查——裸期间、闲聊、汇总轮带账套名是正确行为。
 * 思路同 C1 的漂移判定：只认"当成本轮结果"，不认"被点名"。
 */
function accountDrift(turns: Turn[], accounts: string[]): number[] {
  return turns.flatMap((turn, i) => (accounts.some((a) => turn.text.includes(a))
    && accounts.some((a) => !turn.text.includes(a) && turn.reply.includes(a)
      && /已查|查到|余额为|凭证\s*\d|结果如下/.test(turn.reply)) ? [i] : []));
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

/** 计划步骤措辞：「第2/3步」「第 2 步」「第二步」。宿主只给带前缀的计划步骤通知加【第 N/M 步】前缀。 */
function stepMarkers(text: string): string[] {
  return [...text.matchAll(/第\s*([0-9一二三四五六])\s*(?:[/／]\s*[0-9一二三四五六]\s*)?步/g)].map((m) => m[0].replace(/\s/g, ''));
}

function hasStepMarker(turn: Turn): boolean {
  return stepMarkers(turn.reply).length > 0 || turn.notices.some((notice) => stepMarkers(notice).length > 0);
}

/** 失败/未执行措辞：核对里"这一步没查到"的常见说法（含用户授权跳过时的复述）。 */
const ACCOUNT_FAILED = /未找到|查不到|无法查|没查|未查到|不存在|失败|无数据|跳过/;

/**
 * 该账套在本轮是否已出"结果"（而非仅被点名）：按分句判定——账套名与失败措辞同句，
 * 或与"数字+结果词"同句（"幻辰财税应收 86,000 元"、"新兴建材 700 元"）。只点名不给结果的
 * 不算（"接下来核对幻东建材"、"幻东建材、新兴建材"这种列举都不是已执行）。
 */
function accountProcessed(turn: Turn, account: string): boolean {
  return turn.reply
    .split(/[。；;\n]/)
    .some((clause) => clause.includes(account)
      && (ACCOUNT_FAILED.test(clause) || (/[\d,．.]+/.test(clause) && /余额|应收|应付|欠款|为|是|：|:|元/.test(clause))));
}

type ResumeState = 'resumed' | 'not-resumed' | 'already-done';

/**
 * G1 核心判定——计划的跨回合恢复（宿主经 latestOpenPlan 找回同一计划；此路径此前只有
 * FakeRepo 单测，这里是真实模型首考，探针侧只能看 calls 与回复文本）：
 * - already-done：恢复点前所有账套都已出结果——模型一口气跑完了拆解，恢复路径未被触发（信息性）；
 * - resumed：恢复点后两轮发生了平台调用，且某个"恢复点前还没结果"的账套被继续核对出结果
 *   （核对语义延续）；或回复/计划通知出现「第 N/M 步」且没有从头重拆；
 * - not-resumed：其余——零调用、只澄清、新开与计划无关的单查、或从头重拆（又查已完成账套）。
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
 * 文本里的对象名（客户/供应商等：公司后缀结尾）。贪婪前缀会把"幻辰财税里幻电设备有限公司"
 * 整段吞进匹配，按前导语境词（账套/里/中/的/为/是…）裁掉上下文再返回——刻意不含"有"：
 * "有限公司"自身带"有"，拿它当边界会把名字切断。
 */
function objectNames(text: string): string[] {
  return [...text.matchAll(/[\u4e00-\u9fa5]{2,8}(?:有限公司|有限责任公司|公司|工厂|商行|经营部|分公司)/g)]
    .map((m) => m[0].replace(/^[\s\S]*[账套里中内的为是和及与、（，。：:；;\s]/, ''));
}

/**
 * G1 探索轮结果污染核对汇总：探索落地轮（客户级查询）回复里的对象名/金额，若原样出现在
 * 汇总轮、且汇总轮没有任何"另外/此外"类分隔措辞，即把探索线程的结果算进了核对汇总。
 * 在核对线程轮次里也出现过的对象/数字不判——它们本就是核对结果。
 */
function explorationPollution(turns: Turn[], landingIdx: number, summaryIdx: number, threadIdxs: number[]): { objects: string[]; amounts: string[] } {
  const summary = turns[summaryIdx]!.reply;
  if (/另外|此外|补充|之前|前面|你还问|你问过|问过/.test(summary)) return { objects: [], amounts: [] };
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
 * G1 跳过授权判定：授权轮之后若又把"授权前已失败过"的账套查了一遍（同对象再次失败），
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
      && !/如前|刚才|已经查过|此前|之前已|已跳过|按你说的跳过|不再重试|无需/.test(turn.reply)) {
      retried.push(i + 1);
    }
  }
  return retried;
}

/** 规划性措辞：「先…再…」「第 N 步」「分 N 步」「分别」「逐步」；或列出两个以上待查账套/期间（清单式提议）。 */
const PROPOSAL_PHRASING = /先[^。！？!?\n]{0,40}(再|然后|接着)|第[一二三四五六1-6]\s*步|分\s*[两二三四五1-5]\s*步|分别|逐步|一步步/;

/**
 * G2 判定——第 1 轮是否真的"提议了查法"（业务 skill 拆解表 surfaced）。
 * 纯澄清问句不算提议：问句形式列对象（"查幻辰还是新兴？"）是澄清，不是方案。
 */
function hasPlanProposal(text: string): boolean {
  if (PROPOSAL_PHRASING.test(text)) return true;
  if (/[?？]/.test(text)) return false;
  const accounts = ['幻辰财税', '幻辰实业', '新兴五金', '新兴建材'].filter((account) => text.includes(account));
  const periods = new Set([...text.matchAll(/20\d{2}\s*年?\s*\d{1,2}\s*月?|20\d{4}/g)].map((m) => m[0]));
  return accounts.length >= 2 || periods.size >= 2;
}

// ─── H 用例（乒乓与长探索）判定 helper ───

/**
 * 线程结论措辞：线程真实结果为"空/未找到"时（B 的 0 条凭证、D 的目录 not_found），
 * 召回轮复述结论即算召回。刻意不收裸"没有"——出口校验的兜底话术
 * （"本轮没有产生任何平台查询"）也含"没有"，那不是线程结论。
 */
const THREAD_CONCLUSION = /未找到|没找到|查不到|查无|不存在|无数据|无凭证|没有已保存|没有凭证|没有匹配|没有更多|没有下一页|无需|不必|不用再|拒绝|跳过|失败|0\s*[条张笔家]|零\s*[条张笔家]|没有(?=[。！？!?，,、\s]|$)/;

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
 * mock 之下同参数重查必然同数，重查轮冒出基集以外的金额即期间/账套被悄悄换掉的信号。
 */
function requeryMismatch(turns: Turn[], script: ScriptLine[], index: number): Amount[] {
  const base = realAmounts(turns, script, index, script[index]!.tasks);
  if (base.size === 0) return [];
  return extractAmounts(turns[index]!.reply).filter((a) => a.value !== 0 && !base.has(a.value));
}

/** mock 幻辰财税客户辅助档案（seed.json）：客户级查询的落点。真实平台同名不同数，判定只问"有没有落到具体客户"。 */
const QIANLONG_CUSTOMERS = ['幻电设备有限公司', '机电贸易有限公司', '恒信钢铁'];

/** 回复里点名的具体客户：已知辅助档案名 + 通用公司名抽取（objectNames 捞不到无后缀的"恒信钢铁"）。 */
function namedCustomers(text: string): string[] {
  return [...new Set([...QIANLONG_CUSTOMERS.filter((name) => text.includes(name)), ...objectNames(text)])];
}

/**
 * 探索线程丢上下文（H2 第 3 轮）：用户第 2 轮已给账套，本轮回复又把账套当成待补信息问一遍。
 * 回复带上该账套名的不判——它只是在同一线程内继续问别的（如"按哪个客户拆"）。
 */
function asksAccountAgain(turn: Turn, account: string): boolean {
  if (turn.reply.includes(account)) return false;
  return /账套/.test(turn.reply) && /[?？]|请告诉|需要您|需要你|补充|明确|确认/.test(turn.reply);
}

/**
 * 跨轮指代断裂（H2 第 5 轮）："它"应指第 4 轮点名的客户。反问"它是谁/哪家客户"即断裂；
 * 或转而谈另一家客户（上一轮点名的客户在本轮回复里消失、且换成了别家）。
 */
function referentialBreak(prev: Turn, cur: Turn): boolean {
  if (/哪家|哪个客户|哪位|它是谁|指哪家|你说的是哪|哪一个/.test(cur.reply)) return true;
  const prevNames = namedCustomers(prev.reply);
  if (prevNames.length === 0) return false;
  return !prevNames.some((name) => cur.reply.includes(name)) && namedCustomers(cur.reply).length > 0;
}

// H1 关键轮次（0-based，对应脚本第 10/12/15/16 行）：恢复 B 旧线程、闲聊、跨线程汇总。
const H1_RESUME_B = 9;
const H1_CHITCHAT = [11, 14];
const H1_SUMMARY = 15;
// H2 关键轮次（0-based，对应脚本第 3/4/5/7/8 行）：收窄维度、欠得最多的客户、"它"、判断型、汇总。
const H2_NARROW = 2;
const H2_TOP = 3;
const H2_IT = 4;
const H2_JUDGMENT = 6;
const H2_SUMMARY = 7;

// ─── 歧义 / not_found 用例的执行语言指纹断言（Stage 3 事故根治包） ───

/**
 * 回复里的执行语言指纹（宿主侧同一把尺：runtime.ts 的 EXECUTION_LANGUAGE_FINGERPRINTS）：
 * 脚本路径 / 错误码形态（全大写且含下划线）/ JSON 片段。2026-09-27 Stage 3 实测：模型把
 * 一次结构化歧义翻译成 1201 字符技术报告，三类指纹全中。宿主改为持信封数据机械组装澄清
 * 问题后，这类指纹在歧义/未找到回复里必须绝迹——这是防回归的硬断言。
 */
function execLanguageLeakNotes(turn: Turn): string[] {
  const leaks = executionLanguageFingerprints(turn.reply);
  return leaks.length > 0 ? [`回复泄漏执行语言（${leaks.join('、')}）：「${turn.text}」`] : [];
}

/**
 * 澄清轮的形状判定（歧义 / not_found 两种收尾，宿主机械组装的模板必然两者俱全）：
 *   · 歧义：候选清单（回复里出现 ≥2 个平台候选名）+ 问句——少一样用户就没法回答"选哪个"；
 *   · not_found：明确的"没有找到"结论——那是模板的第一句，也是用户唯一需要的信息。
 * 模型自己翻译时常常二缺一（只列候选不问、或只问不列），所以两件事都查。
 */
function clarificationShapeNotes(turn: Turn, candidates: readonly string[]): string[] {
  const notes: string[] = [];
  if (candidates.length >= 2) {
    const listed = candidates.filter((name) => turn.reply.includes(name));
    if (listed.length < 2) notes.push(`澄清回复未列候选清单（命中 ${listed.length}/${candidates.length}）：「${turn.text}」`);
    if (!/[?？]|告诉|请回复/.test(turn.reply)) notes.push(`澄清回复没有问句：「${turn.text}」`);
  } else if (!/没有|未找到|查不到|不存在|无匹配/.test(turn.reply)) {
    notes.push(`not_found 回复未给出"没有找到"的结论：「${turn.text}」`);
  }
  return notes;
}

/** mock 账套目录里"幻辰"的两个候选（seed.json）：A3 歧义场景的期望候选集。 */
const QIANLONG_AMBIGUOUS_CANDIDATES = ['幻辰财税', '幻辰实业有限公司'];

const CASES: Case[] = [
  {
    id: 'A1', group: 'A 说胡话', intent: '同一实时问题重问，必须重新查询而不是复述旧答案',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('查一下幻辰财税账套本期的应收账款'));
      const first = turns[0]!.reply;
      turns.push(await send('再帮我查一下幻辰财税账套本期的应收账款'));
      const second = turns[1]!.reply;
      await assembly.close();
      const notes: string[] = [];
      if (first === second) notes.push('两轮回复完全一致——需确认是真查了还是复述');
      return { turns, notes };
    },
  },
  {
    id: 'A2', group: 'A 说胡话', intent: '新问题不带账套时先追问，不把旧账套带进来',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [];
      turns.push(await send('查一下幻辰财税账套本期的应收账款'));
      turns.push(await send('帮我查一下猫一杯的应收账款还有多少'));
      await assembly.close();
      const notes: string[] = [];
      if (turns[1]!.reply.includes('幻辰')) notes.push('第二轮回复带上了旧账套"幻辰"——范围渗入');
      // 第二轮是 not_found（平台账套目录里没有"猫一杯"）：回复同样不得出现执行语言指纹
      notes.push(...execLanguageLeakNotes(turns[1]!), ...clarificationShapeNotes(turns[1]!, []));
      return { turns, notes };
    },
  },
  {
    id: 'A3', group: 'A 说胡话', intent: '歧义账套先澄清，不猜也不自动遍历多个账套',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下幻辰的应收账款')];
      await assembly.close();
      const notes: string[] = [];
      // Stage 3 事故原型：平台返回 ACCOUNT_SET_AMBIGUOUS（候选：幻辰财税 / 幻辰实业有限公司）。
      // 回复必须是澄清问句（候选清单 + 问句），且零执行语言指纹（脚本路径/错误码/JSON）。
      notes.push(...execLanguageLeakNotes(turns[0]!), ...clarificationShapeNotes(turns[0]!, QIANLONG_AMBIGUOUS_CANDIDATES));
      return { turns, notes };
    },
  },
  {
    id: 'A4', group: 'A 说胡话', intent: '不存在的账套只走目录搜索，不用余额/凭证接口探测',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('只查账套目录，看看有没有胜利这个帐套')];
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
      const turns: Turn[] = [await send('现在几月份了？')];
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
      for (let i = 0; i < 5; i += 1) turns.push(await send('查一下新兴五金账套 202609 的应收账款'));
      await assembly.close();
      const notes: string[] = [];
      const calls = ledgerCalls();
      if (calls < 5) notes.push(`5 轮只产生 ${calls} 次平台调用——有轮次没真查`);
      // 比数据口径，不比措辞：抽取所有数字，5 轮必须一致（开场白本来就会变）
      const numbers = turns.map((turn) => (turn.reply.match(/[\d,]+\.?\d*/g) ?? []).join('|'));
      if (new Set(numbers).size > 1) notes.push(`5 轮数据口径不一致：${JSON.stringify(numbers)}`);
      return { turns, notes };
    },
  },
  {
    id: 'B2', group: 'B 稳定性', intent: '期间口径必须体现在回复里',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下新兴建材账套 202607 的应收账款余额')];
      await assembly.close();
      const notes: string[] = [];
      if (!turns[0]!.reply.includes('202607') && !turns[0]!.reply.includes('2026年07月')) notes.push('回复未体现请求的期间');
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
        '查一下新兴五金账套 202609 的应收账款',
        '这个账套 202608 呢？',
        '那把 202607 也看一下',
        '辛苦了，先聊点别的：现在几月份？',
        '刚才我让你查的那三个期间，哪个余额最高？',
        '帮我查一下猫一杯的应收账款还有多少',
        '算了，不问余额了。只查账套目录，有没有新兴建材这个帐套',
        '有的话它的 202609 应收是多少？',
        '下一页',
        '刚才查的是哪个账套？',
        '把新兴五金的凭证也列一下',
        '只列 202609 的',
        '谢谢你',
        '再帮我查一次新兴五金 202609 的应收账款',
        '和刚才的结果一样吗？',
        '如果不一样以哪次为准？',
        '帮我查一下幻辰财税的应收账款',
        '这个账套 202609 的凭证有多少张？',
        '总结一下我们今天查了些什么',
      ];
      for (const text of script) turns.push(await send(text));
      await assembly.close();
      const notes: string[] = [];
      const slow = turns.filter((turn) => turn.ms > 120_000);
      if (slow.length) notes.push(`${slow.length} 轮超过 2 分钟：${slow.map((t) => `${t.ms}ms`).join(', ')}`);
      // 内部协议泄漏：用户不该看到宿主/申报/主 Agent 这类字样
      const leaked = turns.filter((turn) => /主 Agent|route_current_turn|已按要求先申报|宿主|PLAN (ACTIVE|DECLINED|NEEDS)/.test(turn.reply));
      if (leaked.length) notes.push(`${leaked.length} 轮回复泄漏内部协议：${leaked.map((t) => t.text).join(' / ')}`);
      // 只在"回复把某个账套当成本轮已查结果"时才算漂移；在澄清问句里点名账套是正确行为
      const drift = turns.filter((turn) => /新兴五金/.test(turn.text) === false && /新兴五金/.test(turn.reply)
        && /已查|查到|余额为|凭证\s*\d|结果如下/.test(turn.reply));
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的账套当成本轮结果`);
      return { turns, notes };
    },
  },
  {
    id: 'D1', group: 'D 长任务', intent: '跨 9 个月查询：先通知，送达后才执行',
    run: async () => {
      const { send, assembly } = await boot();
      const turns: Turn[] = [await send('查一下新兴五金账套 2026 年 1 到 9 月的应收账款')];
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
      turns.push(await send('把所有账套 2026 年 1 到 9 月的应收账款都查一遍'));
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
      // A=幻辰财税余额（第1轮完成）；B=新兴五金凭证（第2轮缺期间→纠错环问用户，第3轮补充→B继续，
      // 第10轮"下一页"恢复旧线程）；C=新兴建材余额（第5轮）。第4/7轮召回、第6轮对比、第8轮问B的下落，
      // 第9/11轮闲聊、第12轮跨任务汇总。话题判定见 amountViolations 的 tasks 标注。
      const script: ScriptLine[] = [
        { text: '查一下幻辰财税账套本期的应收账款', tasks: ['A'] },
        { text: '把新兴五金的凭证列一下', tasks: ['B'] },
        { text: '202609 的', tasks: ['B'] },
        { text: '对了，幻辰财税刚才查出来余额是多少？', tasks: ['A'], past: true, recall: true },
        { text: '顺手看看新兴建材的应收', tasks: ['C'] },
        { text: '幻辰财税和新兴建材哪个余额高？', tasks: ['A', 'C'], past: true },
        { text: '这两个数分别是多少来着？', tasks: ['A', 'C'], past: true, recall: true },
        { text: '新兴五金那凭证后来查了吗？', tasks: ['B'], past: true },
        { text: '谢谢，先这样', tasks: [] },
        { text: '哦对，新兴五金的凭证下一页', tasks: ['B'] },
        { text: '今天天气不错', tasks: [] },
        { text: '总结一下今天查了些什么', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // 任务隔离（drift）：只在用户点名了账套的轮次查——用户没点名（裸期间"202609 的"、闲聊、
      // 总结）时回复带账套名是正确行为。思路同 C1：把用户没提的账套当成本轮已查结果才算漂移。
      const drift = accountDrift(turns, ['幻辰财税', '新兴五金', '新兴建材']);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的账套当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
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
      // 第4轮用户点出账套+期间、第6轮明确化——两轮都必须落地为真实平台调用。
      const script: ScriptLine[] = [
        { text: '哪个客户欠款最多？', tasks: [] },
        { text: '这个月账上有什么要看的吗？', tasks: [] },
        { text: '帮我分析下应收情况', tasks: [] },
        { text: '幻辰财税，本月', tasks: ['A'], landing: true },
        { text: '有异常的吗？', tasks: [] },
        { text: '算了，直接查余额吧', tasks: ['A'], landing: true },
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
      // 计划线程（业务 skill：跨账套核对→按账套拆 3 步）：幻辰财税(1)→幻东建材(2，mock 无此账套→
      // 必然失败)→新兴建材(3)。第 3/4 轮探索插曲（哪个客户欠款最多→落到幻辰财税客户级查询）
      // 打断计划；第 5 轮「继续刚才的核对」是跨回合恢复点——宿主经 latestOpenPlan 找回同一计划，
      // 模型应发第 2/3 步 + continueTaskId 续跑，而不是新开单查或从头重拆。第 7 轮用户授权跳过
      // 失败步；第 9 轮跨线程汇总（三账套核对 + 探索结果，失败步如实）。
      // tasks 全空：G1 多对象多线程，allowedAmounts 的 tasks 维度不够用——金额判定简化为
      // "必须来自本会话真实执行"（E1 汇总轮同款），串台/误归属由下面的污染判定专门负责。
      const script: ScriptLine[] = [
        { text: '帮我把幻辰财税、幻东建材、新兴建材三个账套本期的应收都核对一遍', tasks: [] },
        { text: '好，先查幻辰财税吧', tasks: [] },
        { text: '等等，先看看哪个客户欠款最多', tasks: [] },
        { text: '幻辰财税的', tasks: [] },
        { text: '好，继续刚才的核对', tasks: [] },
        { text: '继续', tasks: [] },
        { text: '幻东要是查不到就跳过吧', tasks: [] },
        { text: '继续', tasks: [] },
        { text: '总结一下今天查了些什么', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      const PLAN_ACCOUNTS = ['幻辰财税', '幻东建材', '新兴建材'];
      // ① 计划恢复（核心）：第 5 轮后必须按第 2 步续跑同一计划，而不是新开单查/从头重拆/声称完成却没执行。
      const resume = planResumeState(turns, PLAN_ACCOUNTS, 4);
      if (resume === 'already-done') notes.push('（信息性）计划在第 5 轮前已全部跑完——跨回合恢复路径未被触发，模型一口气完成了拆解');
      if (resume === 'not-resumed') notes.push('计划未恢复：第5轮后未按第 2 步续跑');
      // ② 探索不污染：插曲轮零调用或仅目录搜索（澄清/边界说明放行，只问不答不判）；
      // 汇总轮把探索轮的对象/数字算进"核对"结果才算污染。
      if (turns[2]!.calls > 0 && !/[?？]|哪个|哪家|哪些|请告诉|需要您|补充|澄清|边界|无法/.test(turns[2]!.reply)) {
        notes.push(`探索插曲轮未澄清直接执行：第3轮「${turns[2]!.text}」零澄清却产生 ${turns[2]!.calls} 次平台调用并直接给出数据`);
      }
      const polluted = explorationPollution(turns, 3, 8, [0, 1, 2, 4, 5, 6, 7]);
      if (polluted.objects.length || polluted.amounts.length) {
        notes.push(`探索轮结果污染核对汇总：对象${polluted.objects.join('、') || '无'}${polluted.amounts.length ? `；金额${polluted.amounts.join('、')}` : ''}`);
      }
      // ③ 跳过被尊重：授权后不重查已失败的账套（转述旧失败不判）。
      const retried = skipIgnored(turns, 6, '幻东建材');
      if (retried.length) notes.push(`用户已授权跳过但仍重试：第${retried.join('/')}轮又查了幻东建材`);
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
        { text: '我想整理下这边的欠款情况，你说该怎么查？', tasks: [] },
        { text: '可以，按你说的来', tasks: [] },
        { text: '好，开始吧', tasks: [] },
        { text: '辛苦，先这样', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ① 提议出现：纯澄清问句（只问查哪个账套）不算提议。
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
      // 任务线：A=幻辰财税应收余额（第1轮落地，mock 当期 86,000）；B=新兴五金凭证（第2轮缺期间→
      // 纠错环问用户，第3轮补 202609；mock 无凭证→真实结果 0 条）；C=新兴建材应收（第5轮，mock 700）；
      // D=目录搜索"胜利"（第7轮，mock not_found）。第 4/6/9/14 轮召回、第 8 轮 A/C 跨线程对比、
      // 第 10 轮恢复 B 旧线程（下一页）、第 11/13 轮重查、第 12/15 轮闲聊、第 16 轮跨线程汇总。
      // 每个线程被碰 3–4 次（A 4、B 4、C 3、D 3，汇总轮再各碰一次）。
      // 线程隔离两个维度：金额走 amountViolations 的 tasks 维度（D 通常零金额，其召回轮判结论），
      // 账套名走 accountDrift（E1 实测的"实体降级+串任务"家族的文本证据）。
      const script: ScriptLine[] = [
        { text: '查一下幻辰财税账套本期的应收账款', tasks: ['A'] },
        { text: '把新兴五金的凭证列一下', tasks: ['B'] },
        { text: '202609 的', tasks: ['B'] },
        { text: '对了，幻辰财税刚才那个数是多少？', tasks: ['A'], past: true, recall: true },
        { text: '新兴建材的应收也查一下', tasks: ['C'] },
        { text: '新兴五金凭证查到了吗？', tasks: ['B'], past: true, recall: true },
        { text: '顺便帮我看看有没有胜利这个账套', tasks: ['D'] },
        { text: '幻辰财税和新兴建材哪个余额高？', tasks: ['A', 'C'], reasoning: true },
        { text: '胜利那个搜索后来怎样？', tasks: ['D'], past: true, recall: true },
        { text: '新兴五金的凭证下一页', tasks: ['B'] },
        { text: '幻辰财税再查一次', tasks: ['A'], requery: true },
        { text: '今天天气不错', tasks: [] },
        { text: '新兴建材按上个月再查一次', tasks: ['C'], requery: true },
        { text: '刚才胜利那个搜索，结果再念一遍', tasks: ['D'], past: true, recall: true },
        { text: '谢谢，先这样', tasks: [] },
        { text: '总结一下今天查了些什么', tasks: [], summary: true },
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
      // ④ 线程隔离——账套名维度：用户没点名的账套被当成本轮已查结果（实体降级/串任务）。
      const drift = accountDrift(turns, ['幻辰财税', '新兴五金', '新兴建材']);
      if (drift.length) notes.push(`${drift.length} 轮把用户没问的账套当成本轮结果：${drift.map((i) => turns[i]!.text).join(' / ')}`);
      // ⑤ 恢复旧线程（第 10 轮 B 的下一页）：应发生真实调用；零调用时只有"没有更多页/无需再查"
      //    式收尾算正确（B 的真实结果是 0 条凭证，本就无下一页）。张冠李戴到别的线程由上面的
      //    金额/账套名判定负责，这里只判"线程有没有被接上"。
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
      // 单线程逐轮收窄，每轮依赖上一轮的答案：第1轮开放（应澄清账套/期间，零编造）→第2轮补全并
      // 落地真实查询→第3轮按客户拆（依赖第2轮的账套）→第4轮问欠得最多的一家（依赖第3轮）→
      // 第5轮"它上个月呢"（指代跨轮 + 期间切换）→第6轮两月趋势→第7轮"正常吗"（判断型，不得发明
      // 基准）→第8轮汇总（零调用，数字须全有来源）→第9轮收尾。
      const script: ScriptLine[] = [
        { text: '帮我看看应收方面的情况', tasks: [] },
        { text: '幻辰财税，本月', tasks: ['A'], landing: true },
        { text: '按客户拆一下吧', tasks: ['A'] },
        { text: '欠得最多的那家是谁', tasks: ['A'] },
        { text: '它上个月呢', tasks: ['A'] },
        { text: '按月看看这两个月的趋势', tasks: ['A'] },
        { text: '这个情况正常吗', tasks: [], reasoning: true },
        { text: '把刚才查到的数字都列出来', tasks: [], summary: true },
        { text: '好，就这样', tasks: [] },
      ];
      const turns: Turn[] = [];
      for (const line of script) turns.push(await send(line.text));
      await assembly.close();
      const notes: string[] = [];
      // ① 逐轮收窄不断线：第3轮又问账套（第2轮已给）= 探索线程丢上下文；
      //    第5轮反问"它是谁"或换成别家客户 = 跨轮指代断裂。
      if (asksAccountAgain(turns[H2_NARROW]!, '幻辰财税')) {
        notes.push(`探索线程丢上下文：第${H2_NARROW + 1}轮「${turns[H2_NARROW]!.text}」又问账套（第2轮已给幻辰财税）`);
      }
      if (referentialBreak(turns[H2_TOP]!, turns[H2_IT]!)) {
        notes.push(`跨轮指代断裂：第${H2_IT + 1}轮「${turns[H2_IT]!.text}」未接着第${H2_TOP + 1}轮那家客户`);
      }
      // ② 收窄到客户：第4轮应落到具体客户（mock 幻辰财税客户辅助档案有三家）。模型如实说
      //    "平台不区分客户/三家结果相同"是正确行为，不判——mock 与真实平台的差异要容忍。
      if (!namedCustomers(turns[H2_TOP]!.reply).length
        && !/无法|不能|未能|看不出|未区分|相同|一致|无差异/.test(turns[H2_TOP]!.reply)) {
        notes.push(`探索未收窄到具体客户：第${H2_TOP + 1}轮「${turns[H2_TOP]!.text}」未点名客户（mock 辅助档案：${QIANLONG_CUSTOMERS.join('、')}）`);
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
];

/** 日常快速子集：说胡话主线（A1/A2/A4/A5）+ 一次稳定性（B1）。E/F/G/H 是重场景，按需 --only，不进 quick。 */
const QUICK_CASE_IDS = new Set(['A1', 'A2', 'A4', 'A5', 'B1']);

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
    try {
      const { turns, notes = [] } = await item.run();
      const after = ledgerCalls();
      // （信息性）前缀的 note 只陈述事实（如"模型一口气跑完，恢复路径未触发"），不算异常
      const ok = notes.every((note) => note.startsWith('（信息性）'));
      results.push({ id: item.id, group: item.group, intent: item.intent, turns, ledgerCalls: after - before, notes, ok });
      for (const turn of turns) {
        console.log(`  [${(turn.ms / 1000).toFixed(1)}s] 用户: ${turn.text}`);
        console.log(`         回复: ${turn.reply.replace(/\n/g, '\n              ')}`);
        if (turn.notices.length) console.log(`         通知: ${turn.notices.join(' | ')}`);
      }
      console.log(`  平台调用: ${after - before}${ok ? '' : `  ⚠ ${notes.join('; ')}`}`);
    } catch (error) {
      results.push({
        id: item.id, group: item.group, intent: item.intent, turns: [],
        ledgerCalls: 0, notes: [error instanceof Error ? error.message : String(error)], ok: false,
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
      console.log(`  ${result.ok ? '✓' : '⚠'} ${result.id} ${(total / 1000).toFixed(1)}s 平台调用 ${result.ledgerCalls} ${result.notes.length ? '— ' + result.notes.join('; ') : ''}`);
    }
  }
  const bad = results.filter((result) => !result.ok);
  const scope = only ? `--only ${[...only].join(',')}` : quick ? '--quick' : '全量';
  console.log(`\n[${scope}] ${results.length - bad.length}/${results.length} 无异常；明细 ${report}`);
  process.env = savedEnv;
  rmSync(stateDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('探针失败:', error);
  process.exit(1);
});
