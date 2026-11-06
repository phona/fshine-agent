/**
 * 真实平台最小冒烟集（周跑闭环用）——scripts/probe-real-agent.ts 的简化亲戚。
 *
 * 分工：探针在 mock 上跑行为层全集（说胡话/稳定性/长会话/多线程/复杂会话/纠错）；
 * 本脚本只回答真实平台的三个最小问题——读得通吗（精确名查询）、歧义澄清形态对吗
 * （25 候选不静默选）、会话实体与期间续得上吗（只给参数的续问）。3 轮一会话，
 * 断言宽松但机械可执行，不判金额真值（真实平台无 mock 事实源可对），只判
 * "有没有真查/是不是平台来的/像不像人话"。
 *
 * 用法（纪律同探针：StepCode 衍生的 shell 会带 harness 的 LLM_*，Node --env-file
 * 不覆盖已存在变量，必须先剥；真实平台还须剥 EXECUTION_EXECUTOR/FSHINE_REAL_COMMIT）：
 *   env -u LLM_API_BASE_URL -u LLM_API_KEY -u LLM_MODEL -u LLM_THINKING_LEVEL \
 *       -u EXECUTION_EXECUTOR -u FSHINE_REAL_COMMIT \
 *       node --env-file=/tmp/env-real --import tsx scripts/smoke-real-platform.ts
 * 自检（不碰平台：只验环境三闸 + 断言尺子在好坏两种Fixture上各自该响的响、该静的音）：
 *   同上命令追加 --check
 *
 * 跑前纪律（人执行，脚本不替代）：
 *   · pgrep -af "probe-real|ask\.ts|smoke-real" 有空才跑（Lane B 探针错开）；
 *   · fictional-execution-layer 侧 login.sh 确认 LOGIN_OK（失败就停，报告）；
 *   · 白天跑；任何异常立即停：write 调用、审计异常、限流连续触发、进程失控；
 *   · 挂起检测：5 分钟无新日志且停在 declaration 后 → kill 重试一次，再失败记为
 *     端点抖动数据并停（模型端点不稳是已登记的 watch，D-074 同篇）。
 *
 * 与探针的状态隔离差异（刻意为之）：
 *   · EXECUTION_PLAN_STATE 隔离到临时文件——不与常驻生产服务器（mock 模式）互写 plans.json；
 *   · EXECUTION_AUDIT_PATH 保持生产共享——"审计共享"是今日真实平台实测确认的事实，
 *     跑完核对 .runtime/invocations.jsonl 新增条目；
 *   · EXECUTION_RATE_LIMIT_STATE 保持生产共享——"限流生产桶"同今日实测事实，冒烟节奏
 *     天然低于限额，被限就是信号（RATE_LIMITED 落审计，≥2 次记异常）；
 *   · dbPath 用临时目录——绝不碰生产 data/agent.db。
 *
 * 写安全三闸（boot 前校验，任一不过直接拒跑 exit 2）：非 mock / FSHINE_REAL_COMMIT
 * 空（真平台 commit 双闸之一）/ principal capabilities 只读。跑完机械核对审计新增
 * 条目：mode 全 query、exit 0 或干净拒绝（refused 即门禁在执行前挡下）。
 *
 * 结果写 .runtime/smoke-<ts>.json（turns/notes/audit/env 快照）；硬断言失败 exit 1。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executionLanguageFingerprints, isCommitEnabled, isPlatformMock } from '@fshine/agent';
import type { SdkClientLike } from '@fshine/channel-wecom';
import { firstEnabledPrincipalId, loadConfig } from '@fshine/core';
import { resolveActiveProfileId } from '@fshine/contracts';
import { createServerAssembly, type ServerAssembly } from '../apps/server/assembly';

/**
 * 等一条最终回复的轮询上限（10 分钟，与探针同值）。真实平台单轮 60-180s、
 * 探索型曾到 295s，10 分钟是"≥一个回合预算"的等待地平线；超时抛错记 note 不炸。
 * 5 分钟无新日志的挂起判定在跑法纪律里（人看日志执行），不塞进脚本——杀了重跑
 * 一次要比进程内重试干净（会话态可能已被挂起污染）。
 */
const SMOKE_REPLY_WAIT_MS = 600_000;

/** 冒烟调用预算：3 轮会话容许的平台调用上限（读桶 burst 5/3s 回 1，节奏天然低于限额）。 */
const CALL_BUDGET = 6;

/**
 * 三轮脚本（同一会话）：
 *   T1 精确名查询——真实数据 + 来源行（今日 V1 同款问题）；
 *   T2 歧义澄清——"幻州"真实平台 25 候选形态（今日 V2 同款），断言列候选不静默选；
 *   T3 只给参数的续问——"202608 呢"，会话实体（T1 执行过的幻亨纸业）沿用 + 期间切换。
 * 刻意不解析 T2 的澄清（不替用户选候选）：T3 考的正是"未解析澄清之后，只给参数
 * 的续问还能不能靠 T1 的执行事实续上"。
 */
const SCRIPT = [
  '查一下幻州市幻亨纸业有限公司 202609 的应收账款余额',
  '查一下幻州的应收账款',
  '202608 呢',
] as const;

interface Turn {
  text: string;
  reply: string;
  ms: number;
  notices: string[];
  /** 本轮实际产生的平台调用数（EXECUTION_PLAN_STATE 的 actual.calls 增量）。 */
  calls: number;
}

interface AuditRecord {
  ts?: string;
  mode?: string;
  script?: string;
  args?: string[];
  serve?: boolean;
  mock?: boolean;
  refused?: string;
  exitCode?: number;
  durationMs?: number;
}

// ─── 企微假 SDK（与探针同款：不起长连接，帧全量落内存）──

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

// ─── 平台状态：只隔离计划状态；审计与限流保持生产共享（见文件头）──

let planStateBackup: string | undefined;

function isolatePlanState(stateDir: string): void {
  planStateBackup = process.env['EXECUTION_PLAN_STATE'];
  process.env['EXECUTION_PLAN_STATE'] = path.join(stateDir, 'plans.json');
}

function restorePlanState(): void {
  if (planStateBackup === undefined) delete process.env['EXECUTION_PLAN_STATE'];
  else process.env['EXECUTION_PLAN_STATE'] = planStateBackup;
}

/** 计划底账里的累计平台调用数（隔离状态按会话累计，逐轮相减得本轮 calls）。 */
function ledgerCalls(): number {
  const file = process.env['EXECUTION_PLAN_STATE'];
  if (!file || !existsSync(file)) return 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { tasks?: Record<string, { actual?: { calls?: number } }> };
    return Object.values(state.tasks ?? {}).reduce((sum, task) => sum + (task.actual?.calls ?? 0), 0);
  } catch { return 0; }
}

/**
 * 平台审计文件：EXECUTION_AUDIT_PATH 未设（冒烟集刻意不隔离）时即平台默认路径
 * （fictional-execution-layer/.runtime/invocations.jsonl，src/execution/audit.js 同源）。
 */
function platformAuditFile(platformRoot: string): string {
  return process.env['EXECUTION_AUDIT_PATH']
    ? path.resolve(process.env['EXECUTION_AUDIT_PATH'])
    : path.join(platformRoot, '.runtime', 'invocations.jsonl');
}

function readAuditLines(file: string): AuditRecord[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as AuditRecord; } catch { return null; } })
      .filter((record): record is AuditRecord => record !== null);
  } catch { return []; }
}

// ─── 判定小函数（探针同款尺，按冒烟集需要裁剪）──

/**
 * 货币量级数字：千分位/小数/万亿单位/裸整数（≥3 位，避开 1-2 位编号与候选序号）。
 * 排除：四位年份、"年.月"、YYYYMM 期间、百分号结尾。科目代码（1122 应收账款等）
 * 在真实平台回复里同样满天飞（"科目 1122"），不是金额——与探针同一排除集。
 */
const AMOUNT_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*[万亿]|\d+\.\d+(?![\d%％])|(?<![\d.])\d{3,}(?![\d.%％])|(?<![\d.])0(?![\d.])/g;
const SUBJECT_CODES = new Set(['1001', '1002', '1121', '1122', '2201', '2202']);

interface Amount { raw: string; value: number }

function extractAmounts(text: string): Amount[] {
  const seen = new Map<number, Amount>();
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[0]!;
    if (/^(?:19|20)\d{2}(?:\.\d{1,2})?$/.test(raw)) continue; // 年份/年.月不是金额
    if (/^20\d{4}$/.test(raw)) continue;                     // YYYYMM 期间不是金额
    if (SUBJECT_CODES.has(raw)) continue;                    // 科目代码不是金额
    const value = /[万亿]/.test(raw)
      ? parseFloat(raw) * (raw.includes('亿') ? 1e8 : 1e4)
      : parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || seen.has(value)) continue;
    seen.set(value, { raw, value });
  }
  return [...seen.values()];
}

/** 期间标签的两种用户形态：202609 / 2026年09月 / 2026 年 9 月。 */
function periodMentioned(text: string, period: string): boolean {
  const year = period.slice(0, 4);
  const month = String(Number(period.slice(4)));
  return text.includes(period) || new RegExp(`${year}\\s*年\\s*0?${month}\\s*月`).test(text);
}

/**
 * 执行语言指纹（宿主侧同一把尺：runtime.ts 的 EXECUTION_LANGUAGE_FINGERPRINTS）：
 * 脚本路径/错误码/JSON/operation 名/内部控制词。Stage 3 事故后这是歧义与未找到
 * 回复的硬断言——真实平台冒烟全轮适用。
 */
function execLanguageLeakNotes(turn: Turn, index: number): string[] {
  const leaks = executionLanguageFingerprints(turn.reply);
  return leaks.length > 0 ? [`第${index + 1}轮回复泄漏执行语言（${leaks.join('、')}）：「${turn.text}」`] : [];
}

/** 来源行（宽松）：含"来源"且含"平台"——"来源：平台实时查询"及其变体都过。 */
function hasSourceLine(reply: string): boolean {
  return /来源/.test(reply) && /平台/.test(reply);
}

/** 编号候选项（宿主澄清模板渲染形如"…：1. 名称 2. 名称 …等 N 个"；首项前是冒号，后续项前是空格）。 */
function numberedCandidates(reply: string): string[] {
  return [...reply.matchAll(/(?:^|[\s：:])(\d{1,2})\.\s*\S/g)].map((m) => m[1]!);
}

function formatAmounts(amounts: Amount[]): string {
  return amounts.map((a) => a.raw).join('、');
}

// ─── 断言：轮次notes + 审计notes（--check 自检与实跑共用同一实现）──

function turnNotes(turns: Turn[]): string[] {
  const notes: string[] = [];
  const [t1, t2, t3] = turns as [Turn, Turn, Turn];
  const where = (t: Turn) => `「${t.text}」`;

  // ① 调用预算：最小冒烟集不该打满限流桶
  const total = turns.reduce((sum, t) => sum + t.calls, 0);
  if (total > CALL_BUDGET) notes.push(`总会话平台调用 ${total} 超过冒烟预算 ${CALL_BUDGET}——最小冒烟集不应把生产桶当探针跑`);

  // ② 全轮执行语言指纹
  for (const [i, turn] of turns.entries()) notes.push(...execLanguageLeakNotes(turn, i));

  // ③ 全轮防编造总尺：零平台调用的轮次不得出现非零金额（数字必须来自本会话真实执行）
  for (const [i, turn] of turns.entries()) {
    if (turn.calls > 0) continue;
    const amounts = extractAmounts(turn.reply).filter((a) => a.value !== 0);
    if (amounts.length) notes.push(`第${i + 1}轮零平台调用却出现非零金额（无来源数字）：${where(turn)} → ${formatAmounts(amounts)}`);
  }

  // ④ T1 精确名查询：真查了、有真实数字、点对了对象与期间、带来源行
  if (t1.calls === 0) notes.push(`T1 精确名查询零平台调用——真实数据无从到来：${where(t1)}`);
  if (extractAmounts(t1.reply).length === 0) notes.push(`T1 回复未含任何金额数字：${where(t1)}`);
  if (!t1.reply.includes('幻亨')) notes.push(`T1 回复未点名查询对象（幻亨纸业）：${where(t1)}`);
  if (!periodMentioned(t1.reply, '202609')) notes.push(`T1 回复未体现期间 202609：${where(t1)}`);
  if (!hasSourceLine(t1.reply)) notes.push(`T1 回复缺来源行（需含"来源"与"平台"表述）：${where(t1)}`);

  // ⑤ T2 歧义澄清（D-072 同款尺）：候选来自平台（有调用）、列候选≥2、有问句、
  //    不静默选定（歧义轮出现非零金额即"直接用某个候选出数"或编造）
  if (t2.calls === 0) notes.push(`T2 歧义轮零平台调用——候选清单不是平台返回的：${where(t2)}`);
  const listed = numberedCandidates(t2.reply);
  if (listed.length < 2) notes.push(`T2 澄清回复未列候选清单（编号项 ${listed.length} 个）：${where(t2)}`);
  if (!/[?？]|哪个|哪家/.test(t2.reply)) notes.push(`T2 澄清回复没有问句：${where(t2)}`);
  const silent = extractAmounts(t2.reply).filter((a) => a.value !== 0);
  if (silent.length) notes.push(`T2 歧义轮直接出数（静默选定/编造，D-072 形态）：${where(t2)} → ${formatAmounts(silent)}`);
  notes.push(`（信息性）T2 候选规模：编号项 ${listed.length} 个${/等\s*(\d+)\s*个/.exec(t2.reply)?.[1] ? `，平台总计 ${/等\s*(\d+)\s*个/.exec(t2.reply)![1]} 个` : ''}（今日实测形态 25 候选列 8 + "…等 25 个"）`);

  // ⑥ T3 只给参数的续问：期间切换必须真查；实体沿用（幻亨）只记信息性——
  //    澄清未解析时模型若重新澄清是行为选择，机械尺只抓"零调用/期间缺失"两个硬信号
  if (t3.calls === 0) notes.push(`T3 期间切换零平台调用——"202608 呢"没有真查（实体未沿用或在重新澄清，人工核对）：${where(t3)}`);
  if (!periodMentioned(t3.reply, '202608')) notes.push(`T3 回复未体现期间 202608：${where(t3)}`);
  if (extractAmounts(t3.reply).length > 0 && !hasSourceLine(t3.reply)) {
    notes.push(`T3 回复出了数但缺来源行（需含"来源"与"平台"表述）：${where(t3)}`);
  }
  notes.push(t3.reply.includes('幻亨')
    ? '（信息性）T3 沿用了会话实体（幻亨纸业）——只给参数的续问接上了 T1 的执行事实'
    : '（信息性）T3 回复未出现幻亨——实体沿用情况人工核对（可能重新澄清或换了口径）');
  const t1Amounts = extractAmounts(t1.reply).filter((a) => a.value !== 0).map((a) => a.value);
  const sameAsT1 = extractAmounts(t3.reply).some((a) => a.value !== 0 && t1Amounts.includes(a.value));
  if (sameAsT1) notes.push(`（信息性）T3 与 T1 出现同一金额——期间可能没切（或两期余额恰同），人工核对：${where(t3)}`);

  return notes;
}

/** 审计新增条目核对（任务书的跑后核对项，机械版）：全 read、exit 0 或干净拒绝、限流不连续。 */
function auditNotes(newEntries: AuditRecord[]): string[] {
  const notes: string[] = [];
  const nonRead = newEntries.filter((r) => r.mode !== 'query');
  if (nonRead.length) {
    notes.push(`审计出现非 read 模式调用（${nonRead.map((r) => `${r.mode}:${r.script ?? '?'}`).join('、')}）——冒烟集只读，出现 write/prepare/commit 立即停`);
  }
  const failed = newEntries.filter((r) => r.mode === 'query' && r.exitCode !== undefined && r.exitCode !== 0 && !r.refused);
  if (failed.length) {
    notes.push(`审计出现非零退出且非门禁拒绝的调用（${failed.map((r) => `${r.script ?? '?'} exit=${r.exitCode}`).join('、')}）——人工核对`);
  }
  const rateLimited = newEntries.filter((r) => r.refused?.startsWith('RATE_LIMITED'));
  if (rateLimited.length >= 2) notes.push(`限流连续触发 ${rateLimited.length} 次——冒烟节奏超过生产桶，按纪律停`);
  else if (rateLimited.length === 1) notes.push('（信息性）限流触发 1 次（生产桶，单次可接受——被限就是信号）');
  return notes;
}

// ─── 自检（--check）：不碰平台，验三闸 + 断言尺子在好坏 Fixture 上各自该响的响 ───

const FIXTURE_GOOD: Turn[] = [
  {
    text: SCRIPT[0]!,
    reply: '幻州市幻亨纸业有限公司 202609 应收账款余额为 123,456.78 元。来源：平台实时查询。',
    ms: 1, notices: [], calls: 2,
  },
  {
    text: SCRIPT[1]!,
    reply: '没有找到唯一匹配“幻州”的对象。平台上有 25 个名字相近的：1. 幻州市幻亨纸业有限公司 2. 幻州某某贸易有限公司 …等 25 个。你要查哪个？告诉我名称或序号即可。',
    ms: 1, notices: [], calls: 1,
  },
  {
    text: SCRIPT[2]!,
    reply: '幻州市幻亨纸业有限公司 202608 应收账款余额为 0.00 元。来源：平台实时查询。',
    ms: 1, notices: [], calls: 1,
  },
];

/** 坏 Fixture：T1 零调用出数（编造）、T2 静默选定、T3 指纹泄漏——三类硬断言必须全响。 */
const FIXTURE_BAD: Turn[] = [
  {
    text: SCRIPT[0]!,
    reply: '余额是 999,999.00 元。',
    ms: 1, notices: [], calls: 0,
  },
  {
    text: SCRIPT[1]!,
    reply: '幻州对应的账套是幻州市幻亨纸业有限公司，202609 应收账款余额 61,000.00 元。数据来源：finance.query-receivables。',
    ms: 1, notices: [], calls: 2,
  },
  {
    text: SCRIPT[2]!,
    reply: '202608 的余额要查“查询计划额度”才能继续，脚本 src/finance/scripts/query-receivables.js 报 ERR_RATE_LIMITED。', // leak-lint: fixture 负面夹具：故意含平台脚本路径，测指纹尺会响
    ms: 1, notices: [], calls: 1,
  },
];

function selftest(guards: string[]): string[] {
  const problems: string[] = [...guards];
  const good = turnNotes(FIXTURE_GOOD).filter((n) => !n.startsWith('（信息性）'));
  if (good.length) problems.push(`好 Fixture 触发硬断言（尺子过紧）：${good.join('; ')}`);
  const bad = turnNotes(FIXTURE_BAD).filter((n) => !n.startsWith('（信息性）'));
  const expectHits = ['零平台调用却出现非零金额', '歧义轮直接出数', '泄漏执行语言'];
  for (const expect of expectHits) {
    if (!bad.some((n) => n.includes(expect))) problems.push(`坏 Fixture 未触发预期断言：${expect}`);
  }
  const auditGood = auditNotes([{ mode: 'query', script: 's.js', exitCode: 0 }, { mode: 'query', script: 's.js', refused: 'PLAN_REFUSE: x' }])
    .filter((n) => !n.startsWith('（信息性）'));
  if (auditGood.length) problems.push(`干净审计被误报：${auditGood.join('; ')}`);
  const auditBad = auditNotes([{ mode: 'commit', script: 'fill.js' }, { mode: 'query', refused: 'RATE_LIMITED: a' }, { mode: 'query', refused: 'RATE_LIMITED: b' }]) // leak-lint: fixture 负面夹具：故意含平台脚本名，测审计尺会拦 write
    .filter((n) => !n.startsWith('（信息性）'));
  if (!auditBad.some((n) => n.includes('非 read 模式'))) problems.push('审计尺不挡 write 模式调用');
  if (!auditBad.some((n) => n.includes('限流连续触发'))) problems.push('审计尺不挡连续限流');
  return problems;
}

// ─── 装配（探针同款：生产同一装配 + 假企微 SDK；dbPath 临时目录，不碰生产库）──

async function boot(stateDir: string, principalUser: string): Promise<{ send: (text: string) => Promise<Turn>; assembly: ServerAssembly }> {
  isolatePlanState(stateDir);
  const sdk = new RecordingSdk();
  const assembly = await createServerAssembly({
    env: process.env,
    dbPath: path.join(stateDir, 'agent.db'),
    channelClientFactory: () => sdk,
  });
  const starting = assembly.channel.start(assembly.replyHandler);
  sdk.emit('authenticated');
  await starting;
  return {
    assembly,
    send: async (text: string): Promise<Turn> => {
      const before = sdk.frames.filter((frame) => frame.finish).length;
      const callsBefore = ledgerCalls();
      const startedAt = Date.now();
      console.log(JSON.stringify({ event: 'turn_start', text, at: new Date().toISOString() }));
      sdk.emit('message.text', wecomText(principalUser, text));
      const deadline = Date.now() + SMOKE_REPLY_WAIT_MS;
      let logged = sdk.frames.length;
      while (Date.now() < deadline) {
        // 进度帧逐条落日志：跑法纪律的"5 分钟无新日志"挂起判定要靠这个信号
        for (let i = logged; i < sdk.frames.length; i += 1) {
          const frame = sdk.frames[i]!;
          console.log(JSON.stringify({
            event: 'frame',
            turn: text,
            finish: frame.finish,
            content: frame.content.slice(0, 160),
            tMs: Date.now() - startedAt,
          }));
        }
        logged = sdk.frames.length;
        const finals = sdk.frames.filter((frame) => frame.finish);
        if (finals.length > before) {
          const turn: Turn = {
            text,
            reply: finals.at(-1)!.content,
            ms: Date.now() - startedAt,
            notices: sdk.frames.filter((frame) => !frame.finish && frame.content.startsWith('计划通知：')).map((frame) => frame.content),
            calls: ledgerCalls() - callsBefore,
          };
          console.log(JSON.stringify({ event: 'turn_end', text, ms: turn.ms, calls: turn.calls }));
          return turn;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等待回复超时(10min)：${text}`);
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig({ env: process.env });
  // 执行层 profile id 无关派生（W1 C5 规矩）：单 profile 取其键，0/多个 -> undefined，消费方 fail-closed；宿主不把实例名当缺省。
  const profileId = resolveActiveProfileId(config.contextProfiles);
  // 授权用户 = config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）首个
  // enabled principal。null = 没人可用：明确报错退出，不回落写死值（真实 UserID 曾是
  // 这里的硬编码）。
  const PRINCIPAL_USER = firstEnabledPrincipalId(config);
  if (!PRINCIPAL_USER) {
    console.error('config/agent.yaml（缺省配置路径，本脚本不读 AGENT_CONFIG_PATH）里没有 enabled 的 principal——冒烟脚本无法派生授权用户（fail-closed，不回落写死值）');
    process.exit(1);
  }
  const AUTHORIZED_KEY = `wecom:${PRINCIPAL_USER}`;
  const platformRoot = config.contextProfiles[profileId ?? '']?.root;
  if (!platformRoot) throw new Error('config/agent.yaml 未配置 example-gateway contextProfiles.root——无法定位平台仓');

  // ── 写安全三闸（boot 前）──
  const guards: string[] = [];
  if (isPlatformMock(process.env)) guards.push('当前 EXECUTION_EXECUTOR=mock——冒烟集只跑真实平台；mock 行为层全集请用探针 scripts/probe-real-agent.ts');
  if (process.env['FSHINE_REAL_COMMIT'] === '1') guards.push('FSHINE_REAL_COMMIT=1 已置位——真平台 commit 双闸之一被打开，只读冒烟集拒跑');
  const capabilities = config.principals[AUTHORIZED_KEY]?.capabilities ?? ['read'];
  if (capabilities.some((c) => c !== 'read')) guards.push(`principal capabilities 含非只读项（${capabilities.join('/')}）——冒烟集拒跑`);

  if (process.argv.includes('--check')) {
    const problems = selftest(guards);
    console.log(JSON.stringify({
      event: 'selftest',
      ok: problems.length === 0,
      guards,
      problems,
    }, null, 2));
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (guards.length) {
    console.error(JSON.stringify({ event: 'smoke_refused', guards }, null, 2));
    process.exit(2);
  }

  const stamp = Date.now();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fshine-smoke-'));
  const auditFile = platformAuditFile(platformRoot);
  const authFile = path.join(platformRoot, '.runtime', 'auth.json');
  const auditBefore = readAuditLines(auditFile).length;
  const authMtimeBefore = existsSync(authFile) ? statSync(authFile).mtime.toISOString() : null;

  const turns: Turn[] = [];
  const errors: string[] = [];
  const { send, assembly } = await boot(stateDir, PRINCIPAL_USER);
  try {
    for (const text of SCRIPT) turns.push(await send(text));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await assembly.close();
    restorePlanState();
  }

  // 审计diff（assembly 关闭后平台子进程已全部退出，文件不再增长）
  const auditAfterLines = readAuditLines(auditFile);
  const newEntries = auditAfterLines.slice(auditBefore);
  const authMtimeAfter = existsSync(authFile) ? statSync(authFile).mtime.toISOString() : null;

  const notes: string[] = [...errors, ...(turns.length === SCRIPT.length ? turnNotes(turns) : []), ...auditNotes(newEntries)];
  if (authMtimeBefore !== authMtimeAfter) {
    notes.push(`（信息性）auth.json mtime 变化（${authMtimeBefore} → ${authMtimeAfter}）——脚本不触任何凭据路径；若为平台侧会话刷新属正常，人工确认`);
  }
  const ok = notes.every((note) => note.startsWith('（信息性）')) && turns.length === SCRIPT.length;

  const report = {
    at: new Date().toISOString(),
    mode: 'real-platform-smoke',
    env: {
      executor: process.env['EXECUTION_EXECUTOR'] ?? '(unset=real)',
      mock: isPlatformMock(process.env),
      commitEnabled: isCommitEnabled(process.env),
      capabilities,
      llm: { base: process.env['LLM_API_BASE_URL'] ?? '', model: process.env['LLM_MODEL'] ?? '' },
      planStateIsolated: true,
      auditShared: !process.env['EXECUTION_AUDIT_PATH'],
      rateLimitShared: !process.env['EXECUTION_RATE_LIMIT_STATE'],
    },
    platformRoot,
    script: [...SCRIPT],
    turns: turns.map((turn) => ({ ...turn })),
    totalCalls: turns.reduce((sum, turn) => sum + turn.calls, 0),
    audit: {
      file: auditFile,
      before: auditBefore,
      after: auditAfterLines.length,
      newEntries,
      rateLimited: newEntries.filter((r) => r.refused?.startsWith('RATE_LIMITED')).length,
      nonRead: newEntries.filter((r) => r.mode !== 'query').length,
      cleanRefusals: newEntries.filter((r) => r.refused).length,
      failedExits: newEntries.filter((r) => r.mode === 'query' && r.exitCode !== undefined && r.exitCode !== 0 && !r.refused).length,
    },
    auth: { file: authFile, mtimeBefore: authMtimeBefore, mtimeAfter: authMtimeAfter },
    notes,
    ok,
  };
  const reportPath = path.join(process.cwd(), '.runtime', `smoke-${stamp}.json`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n================ 冒烟汇总 ================');
  for (const turn of turns) {
    console.log(`[${(turn.ms / 1000).toFixed(1)}s · ${turn.calls} 调用] 用户: ${turn.text}`);
    console.log(`  回复: ${turn.reply.replace(/\n/g, '\n         ')}`);
    if (turn.notices.length) console.log(`  通知: ${turn.notices.join(' | ')}`);
  }
  console.log(`总会话调用 ${report.totalCalls}/${CALL_BUDGET}；审计新增 ${newEntries.length} 条（拒绝 ${report.audit.cleanRefusals}、限流 ${report.audit.rateLimited}、非read ${report.audit.nonRead}、失败退出 ${report.audit.failedExits}）`);
  for (const note of notes) console.log(`  ${note.startsWith('（信息性）') ? '·' : '⚠'} ${note}`);
  console.log(`${ok ? '✓ 无异常' : '✗ 有异常'}；明细 ${reportPath}`);
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error('冒烟失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
