/**
 * Tier-1 打分器（L7 / D-060）：把「可信度靠 eval 基线跑漂移，不靠审计轮次」变成一条命令。
 *
 * 取数面（都是本仓已落地的仪器，本模块零判定逻辑复制）：
 *   · 机械分量（四维违例数）← 探针报告 .runtime/probe-*.json（归维表 scripts/eval/dims.ts）
 *   · 写链三指标 ← acceptance 报告 JSON 的 writeChain 节（scripts/eval/write-chain.ts）
 *   · 评委分量（--judge）← scripts/eval/judge.ts（只吃转录，与机械分量独立）
 *
 * 判定口径（对 baseline.json 逐项比对）：
 *   · 机械分量：违例数 ≤ 基线（只增才算劣化——A2 的既有观察项用上限 1 表达"不劣化"）；
 *   · 评委分量：得分 ≥ 基线 − 容差（默认 1；基线 null = 未定，跳过并提示）；
 *   · 写链：布尔/下限逐项对照（提案尝试 ≥1、确认码已给出、意图已建、committed、读回在）；
 *   · 探针自身 ok（含任务行为类 note）：基线 okExpected 逐例对照（A2 按冻结表 = false）。
 *
 * 回归即 exit 1；输入缺失/语料-基线失配 exit 2。每轮向 .runtime/scores.jsonl 追加一行
 * （corpusVersion / judgePromptVersion / judgeModel 随行——三元组变了，分数不可比，须重定基线）。
 * 基线重定只走 --write-baseline（从当前轮实值生成），不手改文件。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIM_LABELS_ZH, NOTE_DIMS, type DimCounts, type NoteDim } from './dims';
import { judgeEnvReady, judgeModel, judgePromptVersion, judgeTranscript, type JudgeResult } from './judge';
// 用例语料（issue 切片 C）：corpus.jsonl 已并进 cases.yaml——inBaseline / incidents /
// expect 与消息序列、期望值同一份数据，不再有两处可漂移的语料。
import { CASES_PATH, loadCases, toCorpusEntries, type CaseSpec, type CorpusEntry } from './cases';
import { evaluateCaseExpectations } from './expectations';
import type { ExecutionAuditRow } from './evidence';
import type { ConversationWriteChainFacts } from './write-chain';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evalDir, '..', '..');
const BASELINE_PATH = path.join(evalDir, 'baseline.json');
const SCORES_PATH = path.join(repoRoot, '.runtime', 'scores.jsonl');
// 配置同源：本脚本目前不加载 agent config（只读 probe/acceptance 报告 + 基线），
// 但遵循同一 resolveConfigPath 约定——若未来需要读取配置，走同一 helper。
// 详见 scripts/resolve-config-path.ts。

// ── 数据形状 ──

export type { CorpusEntry } from './cases';

export interface BaselineCase {
  /** 四维违例数上限（只增才算劣化）。 */
  dims?: DimCounts;
  /** 评委分基线；null = 未定（跳过并提示）。 */
  judge?: Partial<Record<NoteDim, number | null>>;
  judgeTolerance?: number;
  /**
   * 探针自身 ok 的断言模式（缺省 strict）。
   * strict = ok 必须为 true（健康用例：出现任何 note 即回归）；
   * free = 不断言 ok（已知间歇观察项：缺点出现与否是方差，dims 上限承载「不劣化」）。
   * 不存在 "必须为 false" 的模式——那是要求缺点必须出现，惩罚改进（首轮实测踩过）。
   */
  okMode?: 'strict' | 'free';
  /**
   * audited 申报模式的申报失败数上限（缺省 0）。只增才算劣化，与 dims 同口径。
   * 只在 audited 报告上出检查；黑盒报告没有交叉核判定，不拿 0 冒充「查过且全过」。
   */
  auditFailures?: number;
  note?: string;
}

export interface BaselineWriteChainGroup {
  proposalAttemptsAtLeast?: number;
  confirmCodeOffered?: boolean;
  intentCreated?: boolean;
  committed?: boolean;
  readbackVerified?: boolean;
}

export interface Baseline {
  version: number;
  generatedAt: string;
  note?: string;
  cases: Record<string, BaselineCase>;
  writeChain: Record<string, BaselineWriteChainGroup>;
}

/**
 * 报告行的申报失败计数：数字 = 在该轮平台证据上跑过交叉核；`'not-applicable'` =
 * **整例没有一个可核轮**（零轮占位、纯闲聊轮、崩溃无已完成轮）——显式不适用，不是 0
 * （0 会被读成「查过且全过」，与「没查过」混为一谈），也**不是通过**（见
 * auditFailuresCheckOf：「没有可核轮」≠「查过且全过」）；`'unverifiable'` = 有轮次但
 * 审计源不可读（`auditMissing`），交叉核缺证据——**不是不适用，是核不了**，门必须判失败
 * 而不是因为"还有别的干净轮次"放行（2026-11-10 独立评审 high）。字段缺席（undefined）=
 * 旧报告/黑盒报告没有这一列，仍按 fail-closed 处理。
 */
export type AuditFailuresValue = number | 'not-applicable' | 'unverifiable';

/**
 * audited 报告格式守卫的字段判据（**导出**供单测钉）：非负整数计数、显式
 * `'not-applicable'`、或显式 `'unverifiable'` 都是可评分的值；字段缺席（旧报告/黑盒
 * 报告）不是。负数不是计数（-1 是不可知哨兵，`<= limit` 会让它冒充全过），小数也不是
 * 计数（2026-11-10 独立评审 low）。
 * 守卫必须接受两个显式状态——零轮占位/纯闲聊轮用 `'not-applicable'` 表达「没有可核
 * 证据」，审计源不可读用 `'unverifiable'` 表达「证据缺席、核不了」；拒收会让整份
 * audited 报告 exit 2，连带其余可评分的用例都打不了分。
 */
export function validAuditFailuresValue(value: unknown): value is AuditFailuresValue {
  return value === 'not-applicable'
    || value === 'unverifiable'
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

export interface ProbeResultRow {
  id: string;
  ok: boolean;
  /** runner 抛错中止（caseCrashOf 产物）：与 okMode 无关，任何模式都判失败。 */
  crashed?: boolean;
  dims: DimCounts;
  unclassifiedNotes: number;
  /**
   * audited 申报模式的申报失败条数（对**有可核内容**的轮次累计 findings：有平台证据的轮 +
   * 回复里有金额/申报块的轮——后者无据可核、判红不跳过；整例没有可核轮时记
   * `'not-applicable'`，检查照出但**不判过**；审计源不可读记 `'unverifiable'`，门判失败）。
   * 黑盒报告**不带该字段**（旧报告同理）。
   */
  auditFailures?: AuditFailuresValue;
  notes: string[];
  turns: Array<{
    text: string;
    reply: string;
    notices: string[];
    /** 该轮已执行的平台调用数（期望值层的每轮真查/调用数判定用）。 */
    calls?: number;
    /** 该轮被门拒的调用数。 */
    refusedCalls?: number;
    /** 该轮审计窗口内的执行层审计行（期望值层的门禁时序/无风暴/写尝试判定用）。 */
    execution?: ExecutionAuditRow[];
  }>;
}

export interface ProbeReport { at: string; results: ProbeResultRow[]; /** 探针跑在 audited 申报模式（--audit）；旧报告无此字段 = 黑盒。 */ audited?: boolean }

export interface Check { name: string; pass: boolean; expected: string; actual: string }
export interface CaseVerdict {
  /** 语料 id（baseline.cases 的键；acceptance 与 probe 同一命名空间）。 */
  corpusId: string;
  /** 展示 id（probe 用例 id 或语料 id）。 */
  id: string;
  kind: string;
  pass: boolean;
  checks: Check[];
  /** 评委原始结论（--judge 时），含引文证据，进 scores.jsonl 供人读。 */
  judge?: JudgeResult;
  note?: string;
}

// ── 加载与定位 ──

/** 语料（cases.yaml 的语料元数据视图；inBaseline 已从 corpus.jsonl 并进 yaml）。 */
export function loadCorpus(casesPath: string = CASES_PATH): CorpusEntry[] {
  return toCorpusEntries(loadCases(casesPath));
}

export function loadBaseline(baselinePath: string = BASELINE_PATH): Baseline {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  if (!baseline.cases || !baseline.writeChain) throw new Error('基线缺 cases/writeChain 节');
  return baseline;
}

/**
 * 判定集 / 跳过集（**单一来源**，导出供单测钉主循环判据）。
 *
 * 判定集 = 进基线且非占位；跳过集 = 未进基线或占位。占位条目**即使被误标
 * `inBaseline:true`** 也不评估——统一报告侧 `unifiedCasePassedOf` 先判 `placeholder`，
 * score.ts 若只看 `inBaseline` 就会评估它，两侧判定不同源（2026-11-10 独立评审 low）。
 * 主循环、语料-基线锁与输入面判定都消费本函数，避免过滤条件在两处各写一份后漂移。
 */
export function partitionCorpusForScoring(corpus: readonly CorpusEntry[]): {
  judged: CorpusEntry[];
  skipped: CorpusEntry[];
} {
  return {
    judged: corpus.filter((entry) => entry.inBaseline && entry.placeholder !== true),
    skipped: corpus.filter((entry) => !entry.inBaseline || entry.placeholder === true),
  };
}

export function corpusVersion(casesPath: string = CASES_PATH): string {
  return createHash('sha256').update(readFileSync(casesPath, 'utf8')).digest('hex').slice(0, 8);
}

/** 目录下最新一份报告（mtime 最大）。 */
export function latestReport(dir: string, prefix: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile());
  if (!candidates.length) return null;
  return candidates.reduce((latest, file) => (statSync(file).mtimeMs > statSync(latest).mtimeMs ? file : latest));
}

// ── 逐例判定（纯函数，单测面） ──

/**
 * audited 申报失败检查（**导出**：探针统一报告的通过率与打分器共用同一实现）。
 *
 * 判定只有一处，全部 fail-closed：
 *   · 缺计数（undefined）= 没跑交叉核的 0 是「不知道」，不是「查过且全过」⇒ 判失败；
 *   · 数字 ⇒ 对照基线上限（只增才算劣化）；
 *   · `'unverifiable'`（审计源不可读——有轮次但证据缺席）⇒ 判失败：交叉核缺证据不是
 *     「不适用」，不能因为同例还有别的干净轮次就把不可核的那一轮放行（2026-11-10 独立评审
 *     high）；
 *   · `'not-applicable'`（整例没有一个可核轮——零轮占位/纯闲聊/崩溃无完成轮）⇒ **同样判
 *     失败**（2026-11-10 评审 2 high）。理由：「没有可核轮」意味着申报交叉核既没跑也没
 *     过，让它判过就等于"无证据 = 通过"——与本分支既有口径（evidence.ts 的
 *     mechanicallyPassed：零证据 ⇒ false）相悖。选**失败**而不是第三种"待定"态：Check 只有
 *     pass 布尔、score/report/统一报告都按它门，引入三态要改整条评分链；actual 写清
 *     「不适用（整例没有可核轮）」与真实计数失败可区分（可审计性不丢——报告里看得出是
 *     "没得核"而不是"核出 3 条"）。占位条目（Q5b/Q13b）在判定集外（partitionCorpusForScoring
 *     跳过、unifiedCasePassedOf 先判 placeholder），不会因此进失败分母。
 */
export function auditFailuresCheckOf(auditFailures: AuditFailuresValue | undefined, limit = 0): Check {
  if (auditFailures === 'not-applicable') {
    return { name: 'audited·申报失败', pass: false, expected: `≤${limit}`, actual: '不适用（整例没有可核轮）' };
  }
  if (auditFailures === 'unverifiable') {
    return { name: 'audited·申报失败', pass: false, expected: `≤${limit}`, actual: '不可核（审计源不可读）' };
  }
  return typeof auditFailures === 'number'
    ? { name: 'audited·申报失败', pass: auditFailures <= limit, expected: `≤${limit}`, actual: String(auditFailures) }
    : { name: 'audited·申报失败', pass: false, expected: `≤${limit}`, actual: '缺计数（未跑申报交叉核）' };
}

/**
 * 探针逐例判定：四层并列，**不替换任何一层**。
 *   ① 四维违例上限（基线 cap，只增才算劣化）
 *   ② 探针自身 ok（strict/free）
 *   ③ 评委分下限（--judge 时）
 *   ④ 期望值层（scripts/eval/expectations.ts）：应报的值/条数/collection、逐线程真值、
 *      跨线程隔离、总结收敛、门禁时序/无风暴/大额行归属。这一层**不受基线 cap 影响**——
 *      B1 的 2000、Y2 的 payable=1000、A2 的 alpha 渗入都是「各自有据所以 cap 放过」的
 *      形态，只有它能变成硬失败。
 * spec 缺 expectations（未审计占位条目）时第四层不出检查——不猜期望值。
 *
 * audited=true（探针 --audit 报告）时另加一道并列的「audited·申报失败」门：申报交叉核的
 * findings 全量 ≤ 基线上限（缺省 0）。它不并入四维（申报失败不是可信度维度），但必须
 * 有门——否则申报判定只落 unclassified note，对评分零影响（PR #26 评审 blocking）。
 */
export function evaluateProbeCase(
  corpusId: string,
  row: ProbeResultRow | undefined,
  baselineCase: BaselineCase | undefined,
  judge?: JudgeResult,
  spec?: CaseSpec,
  audited = false,
): CaseVerdict {
  const id = row?.id ?? corpusId;
  if (!row) {
    return { corpusId, id, kind: 'probe', pass: false, checks: [{ name: '探针报告含该用例', pass: false, expected: '在', actual: '缺' }] };
  }
  if (!baselineCase) {
    return { corpusId, id, kind: 'probe', pass: false, checks: [{ name: '基线含该用例', pass: false, expected: '在', actual: '缺（进基线的语料必须有基线项）' }] };
  }
  const checks: Check[] = [];
  for (const dim of NOTE_DIMS) {
    const limit = baselineCase.dims?.[dim] ?? 0;
    const actual = row.dims[dim] ?? 0;
    checks.push({ name: `${DIM_LABELS_ZH[dim]}违例`, pass: actual <= limit, expected: `≤${limit}`, actual: String(actual) });
  }
  // audited 申报门（D-206/D-207）：交叉核失败的 note 归不进四维（落 unclassified），只门
  // 四维会让申报模式的判定输出对评分零影响——错误数据照过。计数是 findings 全量，不枚举
  // 种类：新增判据自动计入。只对 audited 报告出检查：黑盒没有交叉核判定，不拿 0 冒充
  // 「查过且全过」。缺计数同样不是 0——没跑交叉核的 0 是「不知道」，按 fail-closed 判红
  // （2026-11-09 独立评审：此前 ?? 0 让缺列在单行评分面静默变绿）。判定实现在
  // auditFailuresCheckOf（探针统一报告也吃这一份，不另写）。
  if (audited) checks.push(auditFailuresCheckOf(row.auditFailures, baselineCase.auditFailures ?? 0));
  // 崩溃是硬事实，不是 okMode='free' 要容忍的模型方差（2026-11-10 独立评审 medium）：
  // 旧写法 free 基线不查 ok，崩溃若发生在所有期望轮次之后，四维/期望值层全过 ⇒ 整例
  // 判 pass。crashed 标记与 ok 分开，free 用例同样判失败。
  if (row.crashed) {
    checks.push({ name: '探针未崩溃', pass: false, expected: 'runner 正常完成', actual: 'runner 崩溃（用例未完成）' });
  }
  const okMode = baselineCase.okMode ?? 'strict';
  if (okMode === 'strict') {
    checks.push({ name: '探针ok', pass: row.ok, expected: 'true', actual: String(row.ok) });
  }
  const tolerance = baselineCase.judgeTolerance ?? 1;
  if (judge) {
    for (const dim of NOTE_DIMS) {
      const expected = baselineCase.judge?.[dim];
      if (expected === undefined) continue;
      if (expected === null) {
        checks.push({ name: `评委·${DIM_LABELS_ZH[dim]}`, pass: true, expected: '未定基线', actual: String(judge.scores[dim]) });
        continue;
      }
      const actual = judge.scores[dim];
      checks.push({ name: `评委·${DIM_LABELS_ZH[dim]}`, pass: actual >= expected - tolerance, expected: `≥${expected - tolerance}`, actual: String(actual) });
    }
  }
  // ④ 期望值层（issue 切片 C）：与上面三层并列。期望值只活在判定层，不进任何 prompt。
  if (spec) checks.push(...expectationChecksOf(spec, row, audited));
  // 口径答案分类门（2026-11-10 三层断言模型②）：口径编造的判定已移交 judge 的 answerTypes
  // （机械层不再判——正则只做封闭世界查找），但“判定移交了”不等于“默认路径能放过”：
  // 没跑 --judge 时该轴无人判定，把“没判”读成“没问题”正是申报门堵过的假绿
  // （auditFailures 缺列不按 0 过门，同一纪律）。需要答案分类的轮次在判定未完成时显式红。
  // 跑过 --judge 时该轴由评委分承载：回复落入 fail 形态 ⇒ groundedness 0 ⇒ 上面的评委分
  // 检查红；落入 pass 形态 ⇒ 不扣分。无需在此处另判——judge 的输出就是这一轴的判定。
  if (spec && spec.messages.some((message) => (message.answerTypes?.length ?? 0) > 0) && !judge) {
    checks.push({
      name: '期望·口径答案分类',
      pass: false,
      expected: 'judge 按 answerTypes 定型（--judge）',
      actual: '未判定（默认路径不判口径，需 --judge）',
    });
  }
  return { corpusId, id, kind: 'probe', pass: checks.every((check) => check.pass), checks, judge };
}

/**
 * 探针报告行 → 期望值层检查（**导出**：统一报告的通过率也要吃这一层，2026-11-09 十三审
 * major）。导出而不是在探针里重写一份——判据只能有一个实现，两份必然漂移。
 *
 * `audited` = 该报告跑在 audited 申报模式（探针 --audit）：置位时逐轮 reply 含模型追加的
 * `[audit]…[/audit]` 申报块，期望值层先剥成答案正文再判（见 evaluateCaseExpectations 的
 * 归一化）。缺省 false = 黑盒报告，逐字进场。
 */
export function expectationChecksOf(spec: CaseSpec, row: ProbeResultRow, audited = false): Check[] {
  return evaluateCaseExpectations(spec, (row.turns ?? []).map((turn) => ({
    text: turn.text,
    reply: turn.reply,
    notices: turn.notices ?? [],
    calls: turn.calls,
    refusedCalls: turn.refusedCalls,
    execution: turn.execution ?? [],
    audited,
  }))).checks;
}

export function evaluateWriteChainCase(
  entry: CorpusEntry,
  facts: ConversationWriteChainFacts | undefined,
  group: BaselineWriteChainGroup | undefined,
  spec?: CaseSpec,
  records?: ReadonlyArray<{ id: string; reply?: string; durationMs?: number }>,
): CaseVerdict {
  const expectedTrue = (name: string, expected: boolean | undefined, actual: boolean): Check => ({
    name,
    pass: expected === undefined ? true : actual === expected,
    expected: expected === undefined ? '（基线未定）' : String(expected),
    actual: String(actual),
  });
  if (!facts) {
    return { corpusId: entry.id, id: entry.id, kind: 'acceptance', pass: false, checks: [{ name: '验收报告含该会话', pass: false, expected: entry.conversation ?? '', actual: '缺' }] };
  }
  if (!group) {
    return { corpusId: entry.id, id: entry.id, kind: 'acceptance', pass: false, checks: [{ name: '基线含该会话', pass: false, expected: '在', actual: '缺（进基线的语料必须有基线项）' }] };
  }
  const committed = facts.intents.some((intent) => intent.status === 'committed');
  const checks: Check[] = [
    {
      name: '提案尝试',
      pass: facts.proposalAttempts >= (group.proposalAttemptsAtLeast ?? 1),
      expected: `≥${group.proposalAttemptsAtLeast ?? 1}`,
      actual: String(facts.proposalAttempts),
    },
    expectedTrue('确认码已给出', group.confirmCodeOffered ?? true, facts.confirmCodeOffered),
    expectedTrue('提案意图已建', group.intentCreated ?? true, facts.intents.length > 0),
    expectedTrue('落账 committed', group.committed ?? true, committed),
    expectedTrue('读回校验在', group.readbackVerified ?? true, committed && facts.intents.some((intent) => intent.status === 'committed' && intent.hasResult)),
  ];
  // ④ 期望值层（acceptance 侧）：5.1 给确认码、5.3 读回条数、5.4 复用码不双计。
  // 取数面 = 验收报告的 records（回复文本）；calls/execution 审计面 acceptance 报告不载，
  // 因此 acceptance 的期望值只覆盖文本面断言，过程不变量里依赖审计行的几条不出检查
  // （没有证据不出判定——不造零也不造成功；调用数族同理，见 expectations.ts 的
  // callsEvidenceOf）。turns 按 yaml 消息下标**稀疏**落位：中间某条记录缺席（--only
  // 子集或该轮没跑起来）时后续轮次不错位——错位会让「第 N 轮」的期望值判到另一轮回复上，
  // 是比缺判更坏的假信号（2026-11-08 实测 D-097 报告只有 5.1/5.2 两条记录时踩过）。
  if (spec && records) {
    const slots: Array<{ text: string; reply: string; notices: string[] } | undefined> = (spec.messages ?? []).map(() => undefined);
    for (const record of records) {
      const index = (spec.messages ?? []).findIndex((message) => message.id === record.id);
      if (index < 0) continue; // 报告里没有对应消息（acceptance 只跑了子集）→ 该轮缺席
      slots[index] = { text: spec.messages[index]?.text ?? record.id, reply: record.reply ?? '', notices: [] };
    }
    checks.push(...evaluateCaseExpectations(spec, slots).checks);
  }
  return { corpusId: entry.id, id: entry.id, kind: 'acceptance', pass: checks.every((check) => check.pass), checks };
}

// ── 主流程 ──

interface Args {
  probeReport?: string;
  acceptanceReport?: string;
  baselinePath?: string;
  judge: boolean;
  writeBaseline: boolean;
  forceBaseline: boolean;
}

function parseArgs(argv: string[]): Args {
  const take = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  return {
    probeReport: take('--probe-report'),
    acceptanceReport: take('--acceptance-report'),
    baselinePath: take('--baseline'),
    judge: argv.includes('--judge'),
    writeBaseline: argv.includes('--write-baseline'),
    forceBaseline: argv.includes('--force-baseline'),
  };
}

function fmtVerdict(verdict: CaseVerdict): string {
  const failed = verdict.checks.filter((check) => !check.pass);
  const head = `${verdict.pass ? '✓' : '✗'} ${verdict.id}`;
  if (verdict.pass) {
    const judgeScores = verdict.judge
      ? ` 评委 ${NOTE_DIMS.map((dim) => verdict.judge!.scores[dim]).join('/')}` : '';
    return `${head}  ${verdict.checks.map((check) => check.name).join('、')}${judgeScores}`;
  }
  return `${head}  ${failed.map((check) => `${check.name} 期望${check.expected} 实际${check.actual}`).join('; ')}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus(CASES_PATH);
  const baselinePath = args.baselinePath ?? BASELINE_PATH;
  const baseline = loadBaseline(baselinePath);
  const corpusVer = corpusVersion(CASES_PATH);
  const promptVer = judgePromptVersion();
  // 判定集与跳过集**同源**（2026-11-10 独立评审 low）：占位条目即使被误标 inBaseline:true
  // 也不评估——`unifiedCasePassedOf` 先判 spec.placeholder，score.ts 若只看 inBaseline 就会
  // 评估它，两侧判定不同源。占位条目的基线项失配也随之不拦（它本来就不该有基线项）。
  // 判定集的唯一实现是 partitionCorpusForScoring（单测直接钉主循环判据）。
  const { judged: judgedEntries, skipped: skippedEntries } = partitionCorpusForScoring(corpus);

  // 语料 ⊆ 基线锁：进基线的语料必须有基线项（反向多余项只提示不拦——删语料时基线项随 --write-baseline 清理）。
  // 2026-11-08 修（PR #21 二审 blocking 的过程中发现）：`--write-baseline` 时**不锁**。原写法
  // 无条件 exit 2，于是"给一条新用例开门禁"这件唯一正当的事恰好被锁挡住——A5 从 b62d322
  // 被删后恢复进 cases.yaml（inBaseline: true），却没有任何 sanctioned 路径能把它的基线项
  // 写进去，只能手改文件（违反"基线只走 --write-baseline"）。锁的用途是防止**拿着陈旧基线
  // 打分**，不是阻止基线自身演进；写基线正是消解失配的那个动作，逻辑上该放行。
  const missingBaseline = judgedEntries.filter((entry) =>
    entry.kind === 'probe' ? !(entry.id in baseline.cases) : !(entry.conversation! in baseline.writeChain));
  if (missingBaseline.length && !args.writeBaseline) {
    console.error(`语料-基线失配（exit 2）：${missingBaseline.map((entry) => entry.id).join('、')} 进基线但 baseline.json 无对应项`);
    console.error('  （--write-baseline 可消解此失配：把本轮实值写进去；不写基线则先跑 npm run eval:probe）');
    process.exit(2);
  }
  if (missingBaseline.length && args.writeBaseline) {
    console.log(`重定基线：新增 ${missingBaseline.map((entry) => entry.id).join('、')} 的基线项（语料 ⊆ 基线锁在写基线时不拦）`);
  }

  const probePath = args.probeReport ?? latestReport(path.join(repoRoot, '.runtime'), 'probe-', '.json');
  const acceptancePath = args.acceptanceReport
    ?? latestReport(path.join(repoRoot, 'data'), 'acceptance-report-', '.json');
  const needsProbe = judgedEntries.some((entry) => entry.kind === 'probe');
  const needsAcceptance = judgedEntries.some((entry) => entry.kind === 'acceptance');
  const missing: string[] = [];
  if (needsProbe && (!probePath || !existsSync(probePath))) missing.push('探针报告（.runtime/probe-*.json；先跑 npm run eval:probe）');
  if (needsAcceptance && (!acceptancePath || !existsSync(acceptancePath))) missing.push('验收报告（data/acceptance-report-*.json；先跑 npm run eval:acceptance）');
  if (missing.length) {
    console.error(`输入缺失（exit 2）：\n  - ${missing.join('\n  - ')}`);
    process.exit(2);
  }
  const probeReport = JSON.parse(readFileSync(probePath!, 'utf8')) as ProbeReport;
  // audited 申报模式（探针 --audit）：报告记着自己跑在哪个模式。置位时逐轮 reply 含模型
  // 追加的申报块，期望值层按答案正文判（D-207 未决一：申报块是机器 annex 不是答案）。
  // 缺省 false = 黑盒报告（旧报告没有这个字段），逐字进场——模式未知时不猜。
  const probeAudited = probeReport.audited === true;
  // 格式守卫：L7 之前生成的探针报告没有 dims 字段，静默按零违例通过会制造假绿。
  const staleProbe = probeReport.results.find((result) => !result.dims);
  if (staleProbe) {
    console.error(`探针报告是旧格式（${path.basename(probePath!)} 的 ${staleProbe.id} 无 dims；L7 归维前的产物），打分须先重跑：npm run eval:probe（exit 2）`);
    process.exit(2);
  }
  // 格式守卫：旧报告可能缺 execution/calls 列，期望值层会把它读成「零调用轮次」制造假红。
  const staleExecution = probeReport.results.find((result) =>
    (result.turns ?? []).some((turn) => turn.execution === undefined || turn.calls === undefined),
  );
  if (staleExecution) {
    console.error(`探针报告格式过旧，请重跑：npm run eval:probe（${path.basename(probePath!)} 的 ${staleExecution.id} 缺 execution/calls 列）（exit 2）`);
    process.exit(2);
  }
  // 格式守卫：audited 报告必须逐行带申报失败计数或用显式不适用状态（本门落地前的
  // audited 报告没有这一列）。缺列按 0 过门会把「没跑交叉核」读成「查过且全过」——正是
  // 申报失败门要堵的假绿；但零轮占位 / 崩溃 / 纯闲聊轮不该被写成 0（评审修复），
  // 用 `'not-applicable'` 显式表达，守卫接受该状态（判据在 validAuditFailuresValue，
  // 单测直接钉它，不靠跑 main 才能验证）。
  const staleAudit = probeReport.audited === true
    ? probeReport.results.find((result) => !validAuditFailuresValue(result.auditFailures))
    : undefined;
  if (staleAudit) {
    console.error(`audited 报告缺申报失败计数，请重跑：npm run eval:probe -- --audit（${path.basename(probePath!)} 的 ${staleAudit.id} 无 auditFailures 列）（exit 2）`);
    process.exit(2);
  }
  const acceptanceJson = JSON.parse(readFileSync(acceptancePath!, 'utf8')) as {
    records: Array<{ id: string; reply?: string; durationMs?: number }>;
    writeChain: ConversationWriteChainFacts[];
  };
  console.log(`== L7 打分 == 语料 v${corpusVer} · 评委提示词 v${promptVer} · 基线 v${baseline.version}（${baseline.generatedAt}）`);
  console.log(`   探针报告 ${path.basename(probePath!)}（${probeReport.at}）· 验收报告 ${path.basename(acceptancePath!)}`);

  if (args.judge && !judgeEnvReady()) {
    console.error('评委缺环境变量（exit 2）：LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL（--env-file=.env）');
    process.exit(2);
  }

  // 用例规格（期望值层的取数面）：语料 id → CaseSpec（acceptance 按条目 id 找）。
  const cases = loadCases(CASES_PATH);
  const specOf = (entry: CorpusEntry): CaseSpec | undefined =>
    cases.find((item) => (item.kind === 'probe' ? item.id === entry.case : item.id === entry.id));

  const verdicts: CaseVerdict[] = [];
  for (const entry of judgedEntries) {
    if (entry.kind === 'probe') {
      const row = probeReport.results.find((result) => result.id === entry.case);
      const spec = specOf(entry);
      let judgeResult: JudgeResult | undefined;
      if (args.judge && row) {
        judgeResult = await judgeTranscript({
          intent: entry.incidents.join('；'),
          expect: entry.expect,
          // 用例语境（judge-prompt.md「用例语境」）：businessGoal 给目标，answerTypes 是
          // 用例作者对本轮问题的封闭答案分类——按消息下标（0-based）组装，没有分类表的
          // 轮次不出现在列表里（judge 按四维通用定义判）。
          businessGoal: spec?.businessGoal ?? '',
          answerTypes: (spec?.messages ?? []).flatMap((message, turn) => message.answerTypes?.length
            ? [{
              turn,
              types: message.answerTypes.map((type) => ({ id: type.id, verdict: type.verdict, shape: type.shape })),
            }]
            : []),
          turns: row.turns.map((turn) => ({ user: turn.text, reply: turn.reply, notices: turn.notices })),
        });
      }
      verdicts.push(evaluateProbeCase(entry.id, row, baseline.cases[entry.id], judgeResult, spec, probeAudited));
    } else {
      const facts = acceptanceJson.writeChain.find((item) => item.conversationId === entry.conversation);
      verdicts.push(evaluateWriteChainCase(entry, facts, baseline.writeChain[entry.conversation!], specOf(entry), acceptanceJson.records));
    }
  }
  for (const entry of skippedEntries) {
    verdicts.push({ corpusId: entry.id, id: entry.id, kind: entry.kind, pass: true, checks: [], note: entry.placeholder === true ? '未审计占位（不猜判定）' : '未进默认基线（--only 跑后用 --include 评分，或临时移入基线）' });
  }

  for (const verdict of verdicts) {
    console.log(fmtVerdict(verdict) + (verdict.note ? `  （${verdict.note}）` : ''));
    for (const item of verdict.judge?.evidence ?? []) {
      console.log(`      · [${DIM_LABELS_ZH[item.dim]}] "${item.quote.slice(0, 60)}" — ${item.why.slice(0, 80)}`);
    }
  }
  const judged = verdicts.filter((verdict) => verdict.pass && !verdict.note);
  const failed = verdicts.filter((verdict) => !verdict.pass);
  console.log(`\n汇总：${judged.length}/${judgedEntries.length} 通过${failed.length ? `；回归：${failed.map((verdict) => verdict.id).join('、')}` : ''}`);

  // 记分台：每轮追加一行（含评委证据）。回归也落账——台账引用的是这里的轨迹。
  appendFileSync(SCORES_PATH, JSON.stringify({
    at: new Date().toISOString(),
    kind: 'eval',
    corpusVersion: corpusVer,
    judgePromptVersion: args.judge ? promptVer : undefined,
    judgeModel: args.judge ? judgeModel() : undefined,
    probeReport: path.basename(probePath!),
    acceptanceReport: path.basename(acceptancePath!),
    verdicts,
  }) + '\n');

  if (args.writeBaseline) {
    const factsByConversation = new Map(acceptanceJson.writeChain.map((facts) => [facts.conversationId, facts]));
    writeBaselineFrom(verdicts, baseline, baselinePath, args.forceBaseline, corpus, factsByConversation);
  }

  if (failed.length) process.exit(1);
}

/** 从当前轮实值重写基线（基线重定的唯一入口）。既有 okExpected=true 的用例转 ⚠ 时拒绝写入——那是要打回的回归，不许烤进基线。 */
function writeBaselineFrom(
  verdicts: CaseVerdict[],
  baseline: Baseline,
  baselinePath: string,
  force: boolean,
  corpus: CorpusEntry[],
  factsByConversation: Map<string, ConversationWriteChainFacts>,
): void {
  const next: Baseline = {
    version: baseline.version + 1,
    generatedAt: new Date().toISOString(),
    note: baseline.note,
    cases: {},
    writeChain: JSON.parse(JSON.stringify(baseline.writeChain)) as Baseline['writeChain'],
  };
  const refusals: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.note) continue; // 未进基线的用例不动
    if (verdict.kind === 'probe') {
      const okCheck = verdict.checks.find((check) => check.name === '探针ok');
      // baseline 键 = 语料 id（verdict.corpusId），不是探针用例显示 id——两者差一个
      // "probe-" 前缀，混用会让重定基线写错命名空间、误判前值（首轮实测踩过）。
      const previous = baseline.cases[verdict.corpusId];
      const previousOkMode = previous?.okMode ?? 'strict';
      const actualOk = okCheck ? okCheck.actual === 'true' : true; // free 模式无 ok 断言，不触发拒绝
      if (!actualOk && previousOkMode === 'strict' && !force) {
        refusals.push(`${verdict.id}（ok 由 true 转 false）`);
      }
      const dims = {} as DimCounts;
      for (const dim of NOTE_DIMS) {
        const check = verdict.checks.find((item) => item.name === `${DIM_LABELS_ZH[dim]}违例`);
        dims[dim] = Number(check?.actual ?? 0);
      }
      const judgeScores = verdict.judge
        ? Object.fromEntries(NOTE_DIMS.map((dim) => [dim, verdict.judge!.scores[dim]])) as BaselineCase['judge']
        : previous?.judge ?? null;
      // audited 申报失败上限随本轮实值重定（与 dims 同口径：只增才算劣化）。黑盒轮不出这个
      // 检查——缺席不能被写成 0（那会把「没查过」烤成「查过且全过」），保留前值；显式
      // 不适用（actual=不适用）同样保留前值，不把 "not-applicable" 烤成数字。
      const auditCheck = verdict.checks.find((check) => check.name === 'audited·申报失败');
      const auditFailures = auditCheck && /^\d+$/.test(auditCheck.actual)
        ? Number(auditCheck.actual)
        : previous?.auditFailures;
      next.cases[verdict.corpusId] = {
        dims,
        ...(judgeScores ? { judge: judgeScores } : {}),
        ...(auditFailures !== undefined ? { auditFailures } : {}),
        ...(previousOkMode === 'free' ? { okMode: 'free' as const } : {}),
        ...(previous?.note ? { note: previous.note } : {}),
      };
    } else {
      const entry = corpus.find((item) => item.id === verdict.id);
      const facts = entry?.conversation ? factsByConversation.get(entry.conversation) : undefined;
      if (entry?.conversation && facts) {
        next.writeChain[entry.conversation] = {
          // 尝试次数下限恒为设计目标 1（重试多几次是正常方差，不随单轮抬高门槛）；
          // 快照的是布尔面（意图/落账/读回/确认码）。
          proposalAttemptsAtLeast: 1,
          confirmCodeOffered: facts.confirmCodeOffered,
          intentCreated: facts.intents.length > 0,
          committed: facts.intents.some((intent) => intent.status === 'committed'),
          readbackVerified: facts.intents.some((intent) => intent.status === 'committed' && intent.hasResult),
        };
      }
    }
  }
  if (refusals.length && !force) {
    console.error(`拒绝重定基线（--force-baseline 可越过，须在台账留一行理由）：${refusals.join('、')}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  console.log(`基线已重写：v${next.version}（${next.generatedAt}）→ ${path.relative(repoRoot, baselinePath)}`);
}

// 仅直接执行时运行（tsx 场景 process.argv[1] 即本文件）：vitest 会 import 本模块复用纯函数，
// 不加守卫会在加载时跑一轮打分并 process.exit，把测试进程带走。
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('打分器失败:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
