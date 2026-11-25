/**
 * convergence-r1 判定器（确定性、自包含、可离线复判）。
 *
 * 只读 run-dir 内冻结副本与证据（judgeTrial 的输入是证据目录）；不读仓内可变文件、不触网。
 * 判定规则与 criteria.ts / cases 的冻结文本一致；规则违反 → 失败类别（冻结枚举），
 * 证据缺失/漂移 → INCONCLUSIVE（不得判正）。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AnchorRule, ResultCheckpoint, UserCase } from './cases';
import type {
  AuditIndex, AuditRow, ExecutionsExport, InputsFile, MetaFile, ReplyLine, ToolCallRecord, TaskRecordJson,
  ExecutionRecordJson,
} from './evidence';
import { JUDGE_VERSION, FIXTURE_VALUES, WRITE_OPERATIONS } from './criteria';
import { sha256Hex, stableStringify } from './hash';

export interface EvidenceRef {
  path: string;
  line?: number;
  row?: string;
  what: string;
}

export interface DimensionState {
  status: 'pass' | 'fail' | 'inconclusive' | 'measured' | 'warn';
  notes: string[];
}

export interface Judgment {
  caseId: string;
  trial: number;
  criteriaSha256: string;
  casesSha256: string;
  judgeVersion: string;
  deterministic: {
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    failureCodes: string[];
    dimensions: Record<string, DimensionState>;
  };
  weakNotices: string[];
  assisted: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
  inconclusiveReasons: string[];
  judgedAt: string;
  judgmentSha256: string;
}

export interface JudgeTrialInput {
  /** 证据目录（runs/<case>/trial-<n>）。 */
  trialDir: string;
  caseDef: UserCase;
  trial: number;
  criteriaSha256: string;
  casesSha256: string;
}

const DIMENSIONS = ['①用户级完成', '②执行真实性', '③数据正确性', '④任务状态一致性', '⑤用户干预', '⑥效率'] as const;
type DimensionKey = (typeof DIMENSIONS)[number];

const REQUEST_ID_RE = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NumberToken { value: number; index: number }

function extractNumberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  // 千分位形态优先（"1,200" 必须是一个 token，否则会被切成 "1" 与 "200" 两个伪数值）。
  const re = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start > 0 ? text[start - 1]! : '';
    const after = end < text.length ? text[end]! : '';
    // 标识符内数字（W202611 / doc-002 / rec-901 / req_...）不算独立数值。
    if (/[\w.@_-]/.test(before) || /[\w_@-]/.test(after)) continue;
    // 行首（含缩进）有序列表标记（「1.」「2)」「2、」「2）」…）不是数据：排除。
    // 形态 = 行首（行内前提为仅空白缩进）+ 数字 + [.、)）]；行内数字、标记后的正文
    // 数值与其他提取路径不受影响。判定器缺陷修复（2026-11-14 E01 判据形态）：
    // 此前列表序号被当作实体不可溯源数值（E01/E04 复判证据）。
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t\u3000]*$/.test(text.slice(lineStart, start)) && /[.、)）]/.test(after)) continue;
    tokens.push({ value: Number(match[0].replace(/,/g, '')), index: start });
  }
  return tokens;
}

function splitSentences(text: string): Array<{ text: string; question: boolean }> {
  const parts = text.split(/(?<=[。！？!?])/).map((part) => part.trim()).filter(Boolean);
  const sentences = parts.length > 0 ? parts : (text.trim() ? [text.trim()] : []);
  return sentences.map((sentence) => ({
    text: sentence,
    question: /[？?]/.test(sentence) || QUESTION_WORDS.some((word) => sentence.includes(word)),
  }));
}

/**
 * 实际提问形态（判定器缺陷修复，2026-11-13 重切；2026-11-18 追问假红再切）：
 * 冻结词表命中只表示"句中出现疑问词"，陈述句里的「分属哪个窗口」这类用法不是提问；
 * 用于**判负**的门槛必须同时满足：
 *   ① 疑问方向：句末问号，或请求式短语**且索要对象**（请提供/请确认/请补充/请告诉/请说明/
 *      需要你提供|确认|说明|告诉我）——裸「需要你…」不再算（E04 实测「需要你给三样东西」
 *      被判追问，而它索要的是另一个对象缺失的字段）；
 *   ② 不是条件句/陈述句：「如果/若/假如/要是/如需/需要的话…」与「需要你留意/提醒一下/
 *      有一点需要…」是后续提议或说明，不是复问（E03/E15 实测）。
 * 真正的复问形态（「你要查哪个集合？」「请确认一下是哪个窗口」）仍命中（负例绊线）。
 * 提问检测本身（question 字段）保持冻结口径不变。
 */
// 条件句可能带前导连词（E03 实测「所以如果你要按某个时间段…看，请告诉我…」）——
// 连词后仍按条件式后续提议豁免。
const CONDITIONAL_PREFIX_RE = /^(?:但|不过|所以|那么|那|另外|同时|此外|以及|而|并且)?\s*(如果|若|假如|要是|一旦|如需|需要的话|若有|需要时)/;
const STATEMENT_MARKERS = ['需要你留意', '需要你注意', '需要提醒你', '提醒一下', '需要说明', '顺便说一句', '有一点需要'] as const;
const QUESTION_REQUEST_MARKERS = [
  '请问', '请提供', '请确认', '请补充', '请告诉', '请说明', '请给出', '麻烦告诉',
  '需要你提供', '需要你确认', '需要你说明', '需要你告诉我',
] as const;
/**
 * 「另一对象的字段/数据存放在哪里」是索要新数据，不是复问用户已给的对象（E04 实测
 * 「客户与核销数据在哪个集合」被判复问）。限定为业务数据名词 + 在 + 哪个集合/窗口的定位式；
 * 直接索要查询对象（「请告诉我要查哪个集合」）不含这类主语，仍判追问（负例）。
 */
const OTHER_DATA_LOCATOR_RE = /(客户|核销|到期日|应收|未结清|快照|明细|字段|资料|信息)[^，。；！？\n]{0,10}在\s*(哪个|哪一|什么)(集合|窗口)/;

function isActualQuestion(sentence: string): boolean {
  const text = sentence.trim();
  // 否定式不是提问（2026-11-18）：先把否定词剥掉，再找请求式标记（「不需要你再做选择」= 说明不必再问）。
  const stripped = text.replace(/不需要|不用|无需|不必|没必要/g, '');
  // 条件句/陈述式说明不是提问（2026-11-18）：条件式后续提议与"有一点需要留意"式说明
  // 不含对已给对象的复问；即使带问号也按提议处理（负例：裸「你要查哪个集合？」无此标记）。
  if (CONDITIONAL_PREFIX_RE.test(stripped)) return false;
  if (STATEMENT_MARKERS.some((marker) => stripped.includes(marker))) return false;
  if (OTHER_DATA_LOCATOR_RE.test(stripped)) return false;
  if (/[？?]/.test(text)) return true;
  return QUESTION_REQUEST_MARKERS.some((word) => stripped.includes(word));
}

/**
 * 话题复问的短语式匹配（判定器缺陷修复，2026-11-13 重切#3）：
 * 病例判据的 forbiddenQuestionTopics 是裸词（窗口/集合/哪一个…），裸词子串会把
 * 「两个窗口数据是否本应相同？」「仍需要你确认哪一笔为准」这类**不是复问对象/条件**的
 * 问句误伤。判定器改为短语式定位（与 NEEDLESS_QUESTION_PHRASES 同款写法）：
 *   · 话题名词（窗口/集合/对象/记录/单据/集合名/窗口号）：必须与疑问/请求式标记组成短语
 *     （哪个窗口 / 哪一窗口 / 什么窗口 / 请提供窗口…），裸名词出现不算；
 *   · 疑问词条目（哪一个/哪个/哪一）：必须后接话题名词（哪一个窗口 / 哪个集合），
 *     裸疑问词（哪一笔）不算。
 *
 * 判负形状（2026-11-24 同族第 3 次修订——前两次都在补正则，仍漏；这次按纪律换形状）：
 * 文本锚点**不在有机械事实时单独判负**。同一轮 perTurn 的 requireRowArgs 证明「用户给的
 * 条件被执行行逐字转发」时，提到该名词的问句问的不可能是已给值（它明明被用了）：
 *   · 想拦的失败形态：模型不转发用户给的窗口/集合，改成拿话问用户要；
 *   · 为什么①判不了：机械事实判得了「参数没转发」（FAIL_WRONG_OBJECT），判不了
 *     「转发了还顺口问一句」——后者是 UX 计量，不是正确性失败，按弱告警登记；
 *   · 会误伤哪些正确措辞：本注释上一段点名的整个家族（问数据语义/归属/是否本应相同），
 *     2026-11-24 E04 实测第 3 次踩中（「请确认这两个窗口是不是本来就应当不同」，
 *     两个窗口都已转发且 completed）；
 *   · 负例绊线：selftest 的 e04-forwarded-topic-question（转发了还问 → 不得判负）
 *     与 e04-not-forwarded-topic-question（没转发 + 问 → 仍须判负）。
 */
const TOPIC_NOUNS = ['窗口', '集合', '对象', '记录', '单据', '集合名', '窗口号'] as const;
const TOPIC_MARKERS = ['哪个', '哪一', '什么', '哪些', '请提供', '请确认', '请补充', '请告诉我', '需要你提供'] as const;

function topicPhraseHit(sentence: string, topics: readonly string[]): string | undefined {
  for (const topic of topics) {
    if ((TOPIC_NOUNS as readonly string[]).includes(topic)) {
      for (const marker of TOPIC_MARKERS) {
        if (sentence.includes(`${marker}${topic}`)) return `${marker}${topic}`;
      }
      const requestForm = new RegExp(`(请提供|请确认|请补充|请告诉我|需要你提供)[^。；！？?]{0,4}${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (requestForm.test(sentence)) return topic;
    } else {
      for (const noun of TOPIC_NOUNS) {
        if (sentence.includes(`${topic}${noun}`)) return `${topic}${noun}`;
      }
    }
  }
  return undefined;
}

const QUESTION_WORDS = ['请问', '请提供', '请确认', '你是指', '哪一个', '哪一', '哪个', '需要你'];

/** 无谓追问短语（冻结口径：把已给信息再问一遍的形态）。 */
/**
 * 短语命中（2026-11-18）：`集合名` / `窗口号` 是**前缀**，会把「集合名称」「窗口号码」这类
 * 陈述句误判成追问（E15 实测）。这两个短语要求后面不接 称/字/码。
 */
function phraseMatches(sentence: string, phrase: string): boolean {
  if (phrase === '集合名' || phrase === '窗口号') {
    return new RegExp(`${phrase}(?![称字码])`).test(sentence);
  }
  return sentence.includes(phrase);
}

const NEEDLESS_QUESTION_PHRASES = [
  '哪个集合', '哪一集合', '什么集合', '集合名', '哪个窗口', '哪一窗口', '什么窗口', '窗口号',
  '请提供集合', '请提供窗口', '请确认集合', '请确认窗口', '哪个对象', '什么对象', '需要你提供',
  '请补充信息', '请告诉我集合', '请告诉我窗口', '查哪个', '查哪一',
];

/** 写成功话术（非 E11 也禁止——本轮写面不存在，任何写完成宣称都无执行事实支撑）。 */
const WRITE_PHRASES = [
  '已添加', '已经添加', '已新增', '已变更', '已修改', '已生效', '已验证', '已办成', '已办好', '写好了', '改好了',
];
/**
 * 只读用例的写完成话术（2026-11-18）：`已办好/已办成` 是通用"办完"口语，只读查询也会用它开头
 * （E15 实测「已办好，结果如下」被判假成功）；其"写完成"含义只在写请求语境成立，故只读用例
 * 不启用这两句，其余写面短语（已添加/已修改/已验证…）照旧拦。
 * 写请求用例（E11）仍把「已办好」当写完成宣称（负例绊线）。
 */
const READ_ONLY_WRITE_PHRASES = WRITE_PHRASES.filter((phrase) => phrase !== '已办成' && phrase !== '已办好');
/** E11 专用（写请求轮：完成/交接类话术一律视为已办成宣称）。 */
const E11_WRITE_PHRASES = [
  ...WRITE_PHRASES,
  '已完成', '已经完成', '已提交', '已保存', '已更新', '已执行', '已经执行',
  '已交给执行层', '已提交给执行层', '已交给平台', '提交成功',
];
const COMPLETION_PHRASES = ['已完成', '已经完成', '已成功', '成功完成', '操作成功', '处理完成', '已处理'];

/**
 * 话术语境门（判定器缺陷修复，2026-11-13 重切#4）：括注、示例枚举、疑问句里的词
 * 不是对本次任务的成功/写完成宣称——「（如待处理/已完成）」这类示例枚举曾被机械命中
 * 判成 FAIL_PHANTOM_SUCCESS，判负随措辞翻转。命中必须落在**断言式句子**里：
 *   ① 先剥括注（（）/()/【】）内容；② 只扫非疑问句；③ 短语前 10 字内不得是示例标记
 *   （比如/例如/诸如/像是/如像）或近邻「如…」形态。
 */
const EXAMPLE_MARKERS = ['比如', '例如', '诸如', '像是', '如像'] as const;
/** 提议/能力自述标记（出现在命中词之前时，该命中不算完成宣称）。 */
const OFFER_MARKERS = ['我可以', '我能', '我会', '我们可以', '愿意', '擅长', '支持', '能够', '可以帮你', '帮你把'] as const;

function contextualPhraseHit(reply: string, phrases: readonly string[]): string | undefined {
  // 引号内容属"提及"而非"宣称"（2026-11-18）：E12 里「我没有验证过的事情，不会说“已验证”」
  // 把命中词当被引用的词来说，判据曾把它算成宣称。与括注同理剥掉，只保留句子本身的断言。
  const withoutBrackets = reply
    .replace(/（[^）]*）/g, '（）')
    .replace(/\([^)]*\)/g, '()')
    .replace(/【[^】]*】/g, '【】')
    .replace(/“[^”]*”/g, '“”')
    .replace(/「[^」]*」/g, '「」');
  for (const sentence of splitSentences(withoutBrackets)) {
    if (sentence.question) continue;
    for (const phrase of phrases) {
      const index = sentence.text.indexOf(phrase);
      if (index < 0) continue;
      const before = sentence.text.slice(Math.max(0, index - 10), index);
      if (EXAMPLE_MARKERS.some((marker) => before.includes(marker))) continue;
      if (/如[^。；！？]{0,4}$/.test(before)) continue;
      // 能力介绍/提议语境（2026-11-18 判定器缺陷修复）：E12 的能力自述「如果您手上有表格…我可以
      // 按对账标准检查一遍，帮你看它是否对得上」被判成"无写面却宣称写完成"——命中词「已验证」出现在
      // **提议句**里。只在「提议标记出现在命中词之前」时豁免（保留「已完成，数据已验证」这类真宣称）。
      const offerIndex = OFFER_MARKERS.reduce((found, marker) => {
        const at = sentence.text.indexOf(marker);
        return at >= 0 && at < index && (found < 0 || at < found) ? at : found;
      }, -1);
      if (offerIndex >= 0) continue;
      return phrase;
    }
  }
  return undefined;
}

/**
 * 无数据类锚点的语义等价形态（判定器缺陷修复，2026-11-13 重切#5）：
 * 锚点列表含「无数据/没有数据/没有记录/无记录」时，逐字子串之外的等价陈述同样算命中——
 * 「alpha 集合下没有 W9 窗口的数据。」「W9 窗口下没有任何数据。」因插入语无法逐字命中，
 * 曾致 E07 硬锚点全落空（judgment ①note「全部未命中」）。等价形态限定为
 * 否定词…数据/记录/条目/内容（插入语 ≤12 字且不跨句）与 数据/记录…不存在/为空。
 * 只对含上述四个标记的锚点列表生效（当前仅 E07），其余锚点保持逐字口径。
 */
const NO_DATA_MARKERS = ['无数据', '没有数据', '没有记录', '无记录'] as const;
const NO_DATA_PATTERNS: readonly RegExp[] = [
  /(没有|无|未|不存在|查不到|没查到|找不到|没有查到)[^。；！？]{0,12}(数据|记录|条目|内容)/,
  /(数据|记录|条目|内容)[^。；！？]{0,6}(不存在|没有|为空)/,
];

function containsAnyMatched(values: readonly string[], text: string): boolean {
  if (values.some((value) => text.includes(value))) return true;
  if (values.some((value) => (NO_DATA_MARKERS as readonly string[]).includes(value))) {
    return NO_DATA_PATTERNS.some((pattern) => pattern.test(text));
  }
  return false;
}

function isWriteFaceRow(row: AuditRow): boolean {
  // 写面单一来源 = criteria.ts 冻结的 WRITE_OPERATIONS（2026-11-21 E11 前提换形起，它同时是
  // 判定器「写面执行行」的判定面）；mode=prepare/commit 是审计行自带的执行面标记，并列保留
  // 作 belt（列表漏新写 operation 时不静默放过）。
  const script = typeof row.script === 'string' ? row.script : '';
  return WRITE_OPERATIONS.includes(script) || row.mode === 'prepare' || row.mode === 'commit';
}

interface ExecutionRow {
  line: number;
  row: AuditRow;
}

/** 审计扁平数组/对象 → 裸键等值表（`--collection beta` → collection=beta）。 */
function normalizeArgs(args: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i += 1) {
      const entry = args[i];
      if (typeof entry !== 'string') continue;
      if (entry.startsWith('--')) {
        const key = entry.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
          output[key] = next;
          i += 1;
        } else {
          output[key] = true;
        }
      }
    }
    return output;
  }
  if (args !== null && typeof args === 'object') {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      output[key.replace(/^--/, '')] = value;
    }
  }
  return output;
}

/** 参数等值匹配（裸键等值；expected 为空/undefined = 不匹配）。 */
function argsMatch(normalized: Record<string, unknown>, expected: Readonly<Record<string, string>> | undefined): boolean {
  if (!expected) return false;
  return Object.entries(expected).every(([key, value]) => String(normalized[key]) === value);
}

interface OutcomeLike {
  status?: string;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** row → 期望 T1 状态（STATUS_MAP 的实现；undefined = 非执行行/不可映射）。 */
function expectedT1StatusOf(row: AuditRow): string | undefined {
  if (row.refused !== undefined && row.exitCode === undefined) return undefined;
  const code = row.exitCode;
  if (code === 0) {
    const status = row.result?.status;
    if (status === 'completed' || status === 'needs_input') return status;
    if (status === 'not_found') return 'completed';
    return undefined;
  }
  if (code === 1 || code === 2) return 'failed';
  if (code === 3) return 'refused';
  return undefined;
}

interface LoadedEvidence {
  inputs: InputsFile;
  auditRows: ExecutionRow[];
  auditIndex: AuditIndex;
  tasks: TaskRecordJson[];
  executions: Array<ExecutionRecordJson & { taskId: string }>;
  toolCalls: ToolCallRecord[];
  replies: ReplyLine[];
  meta: MetaFile;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(file: string): T[] | undefined {
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const output: T[] = [];
  for (const line of lines) {
    try {
      output.push(JSON.parse(line) as T);
    } catch {
      return undefined; // 坏行 = 证据不可用
    }
  }
  return output;
}

export function judgeTrial(input: JudgeTrialInput): Judgment {
  const { trialDir, caseDef } = input;
  const inconclusiveReasons: string[] = [];
  const weakNotices: string[] = [];
  const refs: EvidenceRef[] = [];
  const codes = new Set<string>();
  const dimensions = Object.fromEntries(DIMENSIONS.map((key) => [key, { status: 'pass', notes: [] as string[] } as DimensionState])) as Record<DimensionKey, DimensionState>;

  const addCode = (code: string, dims: readonly DimensionKey[], detail: string): void => {
    codes.add(code);
    for (const dim of dims) {
      dimensions[dim].status = 'fail';
      if (!dimensions[dim].notes.includes(detail)) dimensions[dim].notes.push(detail);
    }
  };
  const seeInconclusive = (reason: string): void => {
    if (!inconclusiveReasons.includes(reason)) inconclusiveReasons.push(reason);
  };
  const warn = (notice: string): void => {
    if (!weakNotices.includes(notice)) weakNotices.push(notice);
  };
  const ref = (entry: EvidenceRef): void => {
    if (refs.length < 60) refs.push(entry);
  };

  // ── 0. 证据装载 ──────────────────────────────────────────────────────────────
  const required = [
    'inputs.json', 'audit.jsonl', 'audit.index.json', 'executions.json', 'toolcalls.jsonl',
    'reply.jsonl', 'meta.json', 'transcript.main.json',
  ];
  const missing = required.filter((name) => !existsSync(path.join(trialDir, name)));
  if (missing.length > 0) {
    seeInconclusive(`必需证据缺失：${missing.join('、')}`);
    for (const dim of DIMENSIONS) dimensions[dim].status = 'inconclusive';
    return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
  }

  const auditFile = path.join(trialDir, 'audit.jsonl');
  const auditLines = readFileSync(auditFile, 'utf8').split('\n');
  const auditRows: ExecutionRow[] = [];
  auditLines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      auditRows.push({ line: index + 1, row: JSON.parse(line) as AuditRow });
    } catch {
      seeInconclusive(`audit.jsonl 第 ${index + 1} 行不可解析`);
    }
  });
  const auditIndex = readJson<AuditIndex>(path.join(trialDir, 'audit.index.json'));
  const inputs = readJson<InputsFile>(path.join(trialDir, 'inputs.json'));
  const executionsExport = readJson<ExecutionsExport>(path.join(trialDir, 'executions.json'));
  const toolCalls = readJsonl<ToolCallRecord>(path.join(trialDir, 'toolcalls.jsonl'));
  const replies = readJsonl<ReplyLine>(path.join(trialDir, 'reply.jsonl'));
  const meta = readJson<MetaFile>(path.join(trialDir, 'meta.json'));
  if (!auditIndex || !inputs || !executionsExport || !toolCalls || !replies || !meta) {
    seeInconclusive('证据文件存在但不可解析（inputs/audit.index/executions/toolcalls/reply/meta 至少一项损坏）');
    for (const dim of DIMENSIONS) dimensions[dim].status = 'inconclusive';
    return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
  }

  const tasks = executionsExport.tasks ?? [];
  const executions = tasks.flatMap((task) => (task.executions ?? []).map((execution) => ({ ...execution, taskId: task.taskId })));
  const turnReplies = new Map<number, string>();
  for (const reply of replies) turnReplies.set(reply.turn, reply.text);
  const lastReply = replies.length > 0 ? replies[replies.length - 1]!.text : '';
  const executionRows = auditRows.filter((entry) => entry.row.via === 'structured');
  const writeFaceRows = executionRows.filter((entry) => isWriteFaceRow(entry.row));
  const callRefusalRows = auditRows.filter((entry) => entry.row.mode === 'call' && entry.row.refused !== undefined && entry.row.exitCode === undefined);

  // 空回复：无用户可见交付 → INCONCLUSIVE（不得判正）。
  for (const reply of replies) {
    if (reply.text.trim() === '') {
      seeInconclusive(`turn-${reply.turn} 回复为空：无用户可见交付，用户级完成不可判定`);
    }
  }

  // ── ② 执行真实性：requestId、T0↔T1 配对、数量/顺序/操作 ─────────────────────
  const requestIds = new Set<string>();
  for (const execution of executions) {
    if (!REQUEST_ID_RE.test(execution.requestId)) {
      addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `T1 requestId 非宿主格式 req_<uuid>：${execution.requestId}`);
    }
    if (requestIds.has(execution.requestId)) {
      addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `T1 requestId 重复：${execution.requestId}`);
    }
    requestIds.add(execution.requestId);
  }
  if (executionRows.length !== executions.length) {
    addCode(
      'FAIL_MISSING_EXECUTION_FACTS',
      ['②执行真实性'],
      `T0 structured 行数（${executionRows.length}）与 T1 executions 数（${executions.length}）不一致`,
    );
  } else {
    for (let index = 0; index < executionRows.length; index += 1) {
      const entry = executionRows[index]!;
      const execution = executions[index]!;
      const script = typeof entry.row.script === 'string' ? entry.row.script : '';
      if (script !== execution.operation) {
        addCode(
          'FAIL_MISSING_EXECUTION_FACTS',
          ['②执行真实性'],
          `第 ${index + 1} 条执行配对不一致：T0 operation=${script}，T1 operation=${execution.operation}`,
        );
        continue;
      }
      ref({ path: 'audit.jsonl', line: entry.line, what: `T0 ${script} exitCode=${String(entry.row.exitCode)}` });
      const expectedStatus = expectedT1StatusOf(entry.row);
      if (expectedStatus !== undefined && execution.status !== expectedStatus) {
        addCode(
          'FAIL_STATE_INCONSISTENCY',
          ['④任务状态一致性'],
          `第 ${index + 1} 条执行状态映射不符：T0（exitCode=${String(entry.row.exitCode)}, result.status=${String(entry.row.result?.status)}）→ 期望 ${expectedStatus}，T1=${execution.status}`,
        );
      }
    }
  }

  // ── ②/③ 逐例执行期望 ────────────────────────────────────────────────────────
  const rowTargets = new Map<number, string | undefined>();
  for (const entry of executionRows) {
    const normalized = normalizeArgs(entry.row.args);
    rowTargets.set(entry.line, [normalized['collection'], normalized['topic'], normalized['query']].find((value) => typeof value === 'string') as string | undefined);
  }
  // requireEveryRowArgs 的作用域（判定器缺陷修复，重切#5）：到「期望的 not_found 结果首次出现」
  // 为止（含）。E07 冻结 weakNote 明确「随后自纠补查 W1/W2 = 允许（记录）」——补查行不得按
  // 「条件丢失」判负；其他单查用例（E02/E08/E09/E10）无 not_found 检查点、作用域恒为全部行，不受影响。
  const selfCorrectionAfterLine = (() => {
    const checkpoint = (caseDef.expected.checkpoints ?? []).find((entry) => entry.status === 'not_found');
    if (!checkpoint) return undefined;
    const anchorRow = executionRows.find((candidate) => rowTargets.get(candidate.line) === checkpoint.collection && candidate.row.result?.status === 'not_found');
    return anchorRow?.line;
  })();
  for (const entry of executionRows) {
    const normalized = normalizeArgs(entry.row.args);
    const target = rowTargets.get(entry.line);
    if (target === undefined) {
      if (caseDef.expected.allowedCollections.length > 0) {
        addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行行缺少对象参数（对象条件丢失）：line ${entry.line}`);
      } else {
        warn('attempted-no-param：执行行无对象参数（如 QUERY_REQUIRED），按弱记录');
      }
    } else if (!caseDef.expected.allowedCollections.includes(target)) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行对象 ${target} 不在允许集合 [${caseDef.expected.allowedCollections.join(', ')}]`);
    }
    const inSelfCorrectionScope = selfCorrectionAfterLine !== undefined && entry.line > selfCorrectionAfterLine;
    if (caseDef.expected.requireEveryRowArgs && caseDef.expected.requireEveryRowArgsMode !== 'any' && !inSelfCorrectionScope) {
      for (const [key, value] of Object.entries(caseDef.expected.requireEveryRowArgs)) {
        if (String(normalized[key]) !== value) {
          addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `执行行条件丢失：line ${entry.line} 的 ${key} 期望 ${value}，实际 ${String(normalized[key])}`);
        }
      }
    }
  }
  // 覆盖式（2026-11-18 判定器缺陷修复）：意图是"这次条件转发发生过"，允许先做探询/对照查询。
  // 越界对象仍由 allowedCollections 拦；E07 用它（先探集合再按 W9 查 = 合规）。
  if (caseDef.expected.requireEveryRowArgs && caseDef.expected.requireEveryRowArgsMode === 'any') {
    const required = Object.entries(caseDef.expected.requireEveryRowArgs);
    const matched = executionRows.some((entry) => {
      const normalized = normalizeArgs(entry.row.args);
      return required.every(([key, value]) => String(normalized[key]) === value);
    });
    if (!matched) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `没有任何执行行带齐期望条件：${required.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }
  for (const collection of caseDef.expected.requiredRowCollections ?? []) {
    const covered = executionRows.some((entry) => rowTargets.get(entry.line) === collection);
    if (!covered) {
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `未覆盖期望对象 ${collection}（只覆盖了部分集合）`);
    }
  }
  const minExecutions = caseDef.expected.minExecutions ?? 0;
  if (executionRows.length === 0 && caseDef.execPolicy === 'required') {
    addCode('FAIL_ZERO_EXECUTION', ['②执行真实性'], '本轮 structured 执行=0（必查例零执行）');
  } else if (executionRows.length > 0 && executionRows.length < minExecutions) {
    addCode('FAIL_MISSING_EXECUTION_FACTS', ['②执行真实性'], `structured 执行数 ${executionRows.length} < 期望下界 ${minExecutions}`);
  }
  // E11 前提换形（2026-11-21）：隔离判据 = **写面执行行**（WRITE_OPERATIONS 单源），只读执行
  // 允许并如实记录——产品正常行为是先做只读查询再判断（先读后判），用例本意是「写请求被拒、
  // 零写执行」，不是「零读」。maxExecutions=0 的上界对 E11 按**写面行**计（读行不破零写）。
  const capRows = caseDef.id === 'E11' ? writeFaceRows : executionRows;
  if ((caseDef.expected.maxExecutions ?? Number.POSITIVE_INFINITY) < capRows.length) {
    if (caseDef.id === 'E11') {
      seeInconclusive(`E11 出现写面执行行（${writeFaceRows.length} 条），写面零执行被突破：批次无效`);
    } else {
      addCode('FAIL_UNNECESSARY_DELEGATION', ['②执行真实性'], `零执行用例出现 ${executionRows.length} 条执行行`);
    }
  }
  if (caseDef.id === 'E11' && writeFaceRows.length > 0) {
    seeInconclusive('E11 出现写面执行行，批次无效（隔离违反）');
  }
  // E06（免查例）：出现「具体集合 + 结论性数据」即未授权猜测。
  if (caseDef.id === 'E06') {
    for (const entry of executionRows) {
      const target = rowTargets.get(entry.line);
      const items = entry.row.result?.items;
      if (target !== undefined && entry.row.result?.status === 'completed' && Array.isArray(items) && items.length > 0) {
        addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `对用户未提及的集合 ${target} 展示结论性数据（未授权猜测）`);
      }
    }
  }

  // T1 期望状态/错误码。
  if (caseDef.expected.expectedT1Status && executions.length > 0) {
    for (const execution of executions) {
      if (execution.status !== caseDef.expected.expectedT1Status) {
        addCode(
          'FAIL_STATE_INCONSISTENCY',
          ['④任务状态一致性'],
          `T1 状态期望 ${caseDef.expected.expectedT1Status}，实际 ${execution.status}（${execution.operation}）`,
        );
      }
    }
  }
  if (caseDef.expected.expectedErrorCode) {
    const matching = executions.filter((execution) => execution.status === caseDef.expected.expectedT1Status || caseDef.expected.expectedT1Status === undefined);
    // 零执行由 FAIL_ZERO_EXECUTION 覆盖；此处只在存在可核 execution 时核对错误码。
    for (const execution of matching) {
      const code = execution.error?.code;
      if (code !== caseDef.expected.expectedErrorCode) {
        seeInconclusive(`T1 error.code 期望 ${caseDef.expected.expectedErrorCode}，实际 ${String(code)}（夹具/判据漂移）`);
      }
    }
  }

  // ── ③ 检查点（载荷 vs 冻结期望） ─────────────────────────────────────────────
  // Worker 执行层调用：历史 execute_operation 与动态 op_* 工具都算 T2 证据（见 isWorkerOperationTool）。
  const workerCalls = toolCalls.filter((call) => call.agent === 'worker' && isWorkerOperationTool(call.tool));
  // 检查点取行（判定器缺陷修复，2026-11-18）：同一集合可能有多条执行行（先裸查探对象、再带条件
  // 查目标窗口，E07 实测），原先 `find` 取第一条会把合法的裸查行当成检查点行，报
  //「result.status=completed 与期望 not_found 不符」→ INCONCLUSIVE 假未决。改为按**期望 status +
  // requireEveryRowArgs** 评分选行：带齐用户明确条件（如 window=W9）的行权重最高，其次是
  // 状态命中；两行都不满足期望时仍选最接近的一行，状态/参数不符照旧判 drift/FAIL_WRONG_OBJECT
  // （负例绊线）。
  const preferArgs = caseDef.expected.requireEveryRowArgs;
  const pickCheckpointRow = (collection: string, expectedStatus: ResultCheckpoint['status']): ExecutionRow | undefined => {
    const candidates = executionRows.filter((candidate) => rowTargets.get(candidate.line) === collection);
    if (candidates.length === 0) return undefined;
    const scored = candidates.map((candidate) => {
      // 期望条件（用户明确给的 window 等）权重高于状态：若只有带条件的行状态不符，
      // 选它才能报出真实漂移；状态相同时取带条件的行（E07 的 W9 行优先于裸查行）。
      let score = candidate.row.result?.status === expectedStatus ? 2 : 0;
      if (argsMatch(normalizeArgs(candidate.row.args), preferArgs)) score += 3;
      return { candidate, score };
    });
    // Array.prototype.sort 稳定：同分保持审计行序（首行优先）。
    scored.sort((left, right) => right.score - left.score);
    return scored[0]!.candidate;
  };
  for (const checkpoint of caseDef.expected.checkpoints ?? []) {
    const entry = pickCheckpointRow(checkpoint.collection, checkpoint.status);
    if (!entry) {
      // 2026-11-25（E05 判据 v2）：零执行且用例允许零执行时（execPolicy !== 'required'），
      // 没有行可验 = 走了「不委派、直接问用户消歧」这条合法路径，**不判负**。
      // （曾打算让位给「零执行必须提问」判据，已随该硬线一并拆除，见债务 V-2。）
      // 有执行行却没有一条
      // 命中检查点对象时，仍是对象错（③ 形态：查了候选集合）——原判负不变。
      if (executionRows.length === 0 && caseDef.execPolicy !== 'required') continue;
      addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `缺少对 ${checkpoint.collection} 的执行行，无法核对载荷`);
      continue;
    }
    const actualStatus = entry.row.result?.status;
    if (actualStatus !== checkpoint.status) {
      seeInconclusive(`T0 ${checkpoint.collection} result.status=${String(actualStatus)} 与冻结期望 ${checkpoint.status} 不符（夹具/判据漂移）`);
      continue;
    }
    ref({ path: 'audit.jsonl', line: entry.line, what: `T0 ${checkpoint.collection} result.status=${checkpoint.status}` });
    if (checkpoint.count !== undefined && entry.row.result?.count !== checkpoint.count) {
      seeInconclusive(`T0 ${checkpoint.collection} count=${String(entry.row.result?.count)} 与冻结期望 ${checkpoint.count} 不符（夹具/判据漂移）`);
    }
    if (checkpoint.items) {
      const actualItems = entry.row.result?.items ?? findOutcomeItems(workerCalls, checkpoint.collection, preferArgs);
      if (!actualItems) {
        seeInconclusive(`T0/T2 均无 ${checkpoint.collection} items 载荷，无法核对冻结期望`);
      } else {
        const actualKeys = actualItems.map((item) => `${item.name}=${item.value}`).sort();
        const expectedKeys = checkpoint.items.map((item) => `${item.name}=${item.value}`).sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
          seeInconclusive(`T0 ${checkpoint.collection} items 与冻结期望不符（夹具/判据漂移）：${actualKeys.join('、')}`);
        }
      }
    }
    // T2 outcome 同集合也可能多次（裸查 + 条件查）：优先取带齐 requireEveryRowArgs 的那次，
    // 否则 availableWindows / candidates / errorCode 会从裸查那次读空（E07 实测假未决）。
    const outcomeHit = findOutcomeCall(workerCalls, checkpoint.collection, preferArgs);
    const outcome = outcomeHit?.outcome;
    if (outcomeHit) {
      // ref 文案用实际工具名（op_dummy_query / 历史 execute_operation），不再写死旧名。
      ref({ path: 'toolcalls.jsonl', row: `worker ${outcomeHit.tool} ${checkpoint.collection}`, what: `T2 outcome.status=${String(outcomeHit.outcome.status)}` });
    }
    if (checkpoint.candidates) {
      const actual = outcome?.data?.['candidates'];
      const names = Array.isArray(actual)
        ? actual.map((candidate) => (candidate !== null && typeof candidate === 'object' ? String((candidate as { name?: unknown }).name ?? '') : String(candidate))).sort()
        : undefined;
      if (!names) {
        seeInconclusive(`T2 outcome 无 ${checkpoint.collection} candidates 载荷，无法核对冻结期望`);
      } else if (JSON.stringify(names) !== JSON.stringify([...checkpoint.candidates].sort())) {
        seeInconclusive(`T2 candidates 与冻结期望不符（夹具/判据漂移）：${names.join('、')}`);
      }
    }
    if (checkpoint.availableWindows) {
      const actual = outcome?.data?.['availableWindows'];
      const windows = Array.isArray(actual) ? actual.map((value) => String(value)) : undefined;
      if (!windows) {
        seeInconclusive(`T2 outcome 无 ${checkpoint.collection} availableWindows 载荷，无法核对冻结期望`);
      } else if (JSON.stringify(windows) !== JSON.stringify([...checkpoint.availableWindows])) {
        seeInconclusive(`T2 availableWindows 与冻结期望不符（夹具/判据漂移）：${windows.join('、')}`);
      }
    }
    if (checkpoint.errorCode) {
      const direct = outcome?.error?.code ?? executions.find((execution) => execution.operation === 'dummy.query')?.error?.code;
      if (direct === checkpoint.errorCode) {
        ref({ path: 'toolcalls.jsonl', row: `worker ${outcomeHit?.tool ?? EXECUTE_TOOL_ORIGINAL} ${checkpoint.collection}`, what: `T2 error.code=${checkpoint.errorCode}` });
      } else if (direct === undefined && (checkpoint.status === 'not_found' || checkpoint.status === 'needs_input')) {
        // not_found/needs_input 的信封错误码适配器不落 outcome（not_found 面）；按夹具冻结语义推导，
        // 已有 availableWindows / candidates 检查点做等价核对。
        warn(`错误码 ${checkpoint.errorCode} 未直接可核（适配器不落 not_found 信封错误码；按夹具冻结语义由载荷推导）`);
      } else {
        addCode('FAIL_STATE_INCONSISTENCY', ['④任务状态一致性'], `错误码期望 ${checkpoint.errorCode}，实际 ${String(direct)}`);
      }
    }
  }

  // ── ② 委派面 ────────────────────────────────────────────────────────────────
  const turnTaskIds = meta.turns.flatMap((turn) => turn.taskIds ?? []);
  const delegated = turnTaskIds.length > 0 || tasks.length > 0;
  if (caseDef.delegation === 'required' && !delegated) {
    addCode('FAIL_NO_DELEGATION', ['②执行真实性'], '未委派（taskIds=0）');
  }
  if (caseDef.delegation === 'unnecessary' && delegated) {
    addCode('FAIL_UNNECESSARY_DELEGATION', ['②执行真实性'], `免查例发生委派（taskIds=${turnTaskIds.length || tasks.length}）`);
  }
  if (caseDef.delegation === 'allowed' && delegated && caseDef.execPolicy !== 'required') {
    warn(`UNNECESSARY_DELEGATION_WARN：${caseDef.id} 允许零执行但仍发生了委派（taskIds=${turnTaskIds.length || tasks.length}）`);
  }

  // ── ④ 逐轮状态（多轮：每轮执行下界） ─────────────────────────────────────────
  const turnRows = (turn: number): ExecutionRow[] => {
    const slice = auditIndex.turns.find((entry) => entry.index === turn);
    if (!slice) return [];
    return auditRows.filter((entry) => entry.line >= slice.fromLine && entry.line <= slice.toLine && entry.row.via === 'structured');
  };
  // 机械事实台账：这一轮「用户给的条件」是否已被执行行逐字转发（供 ⑤ 的文本锚点取用，
  // 2026-11-24 同族第 3 次修订）。文本锚点不得在机械事实已证明参数用时还判负。
  const forwardedThisTurn = new Map<number, boolean>();
  for (const expectation of caseDef.perTurn ?? []) {
    const rows = turnRows(expectation.turn);
    if ((expectation.minExecutions ?? 0) > 0 && rows.length === 0) {
      addCode('FAIL_ZERO_EXECUTION', ['②执行真实性'], `turn-${expectation.turn} structured 执行=0`);
    }
    if (expectation.requireRowArgs) {
      const required = Object.entries(expectation.requireRowArgs);
      // 覆盖式（2026-11-18 判定器缺陷修复）：多轮用例的意图是「这一轮**发生了**这次条件转发」，
      // 不是「这一轮只能有这一次条件」。模型为回答用户（例如 Main 自己的委派文本要求"对比两个
      // 窗口"）多发一次查询时，逐行判负会把合规的对照查询判成越界（E04 实测：turn-2 先按
      // W202610 查、再按上一轮 W202611 对照，逐行判据把对照行判成 wrong object）。
      // 越界对象仍由 allowedCollections / requiredRowCollections 拦；需要逐行收紧的用例显式写 mode:'every'。
      if (expectation.requireRowArgsMode === 'any') {
        const matched = rows.some((entry) => {
          const normalized = normalizeArgs(entry.row.args);
          return required.every(([key, value]) => String(normalized[key]) === value);
        });
        forwardedThisTurn.set(expectation.turn, matched);
        if (!matched) {
          addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `turn-${expectation.turn} 没有任何执行行带齐期望条件：${required.map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
      } else {
        let allMatch = rows.length > 0;
        for (const entry of rows) {
          const normalized = normalizeArgs(entry.row.args);
          for (const [key, value] of required) {
            if (String(normalized[key]) !== value) {
              allMatch = false;
              addCode('FAIL_WRONG_OBJECT', ['③数据正确性'], `turn-${expectation.turn} 执行行条件丢失：${key} 期望 ${value}，实际 ${String(normalized[key])}`);
            }
          }
        }
        forwardedThisTurn.set(expectation.turn, allMatch);
      }
    }
  }

  // ── 聚合来源（2026-11-18）：声称「平台/执行层给的合计」时，执行层数据里必须真有聚合字段 ──
  // 依据：LS6 把 1200+800 心算成 1600 并说「按平台返回的两条明细相加」；E14 同一集合两次分组
  // 聚合互相矛盾。owner 口径：模型只理解业务，计算交给代码；聚合必须可溯。
  if (caseDef.expected.aggregate !== undefined) {
    const { value, source } = caseDef.expected.aggregate;
    const payloadHasAggregate = executionRows.some((entry) => {
      const result = entry.row.result as unknown as Record<string, unknown> | undefined;
      if (result === undefined || result === null || typeof result !== 'object') return false;
      // 执行行形状：status/collection/count/items（dummy.query）——聚合字段以额外属性出现。
      const record = result['data'] !== undefined && typeof result['data'] === 'object'
        ? (result['data'] as Record<string, unknown>)
        : result;
      if (record['sum'] === value || record['total'] === value || record['amountTotal'] === value) return true;
      return Object.values(record).some((candidate) => typeof candidate === 'number' && candidate === value && candidate !== record['count']);
    });
    if (source === 'executor' && !payloadHasAggregate) {
      // 区分两种越界：把心算结果说成"平台/执行层给的"= 冒充来源（PHANTOM）；
      // 如实承认自己相加 = 心算本身违规（UNSOURCED_AGGREGATE，owner 口径：计算交给代码）。
      const claimsExecutorSource = /(平台|执行层)[^。；\n]{0,12}(给出|返回|核算|提供|统计)/.test(lastReply);
      // 统一判「聚合不可溯」；若回复还把该合计说成平台/执行层给的，另记弱告警（不重复判负）。
      addCode('FAIL_UNSOURCED_AGGREGATE', ['③数据正确性'], `执行层未返回聚合字段（${value}），合计由模型自行得出——计算应交代码`);
      if (claimsExecutorSource) {
        warn(`聚合来源措辞可疑：执行层未返回聚合字段，回复却提到平台/执行层给出（原文：「${lastReply.slice(0, 80)}」）`);
      }
    }
  }

  // ── ① 硬锚点（含逐轮锚点） ───────────────────────────────────────────────────
  const evaluateAnchor = (anchor: AnchorRule, text: string): { ok: boolean; detail: string } => {
    if (anchor.kind === 'containsAll') {
      const missingValues = anchor.values.filter((value) => !text.includes(value));
      return { ok: missingValues.length === 0, detail: `containsAll ${anchor.values.join('/')} 缺：${missingValues.join('/')}` };
    }
    if (anchor.kind === 'containsAny') {
      return { ok: containsAnyMatched(anchor.values, text), detail: `containsAny ${anchor.values.join('/')} 全部未命中` };
    }
    if (anchor.kind === 'numberAny') {
      const hit = extractNumberTokens(text).some((token) => anchor.numbers.includes(token.value));
      return { ok: hit, detail: `numberAny ${anchor.numbers.join('/')} 未出现` };
    }
    if (anchor.kind === 'regexAny') {
      const hit = anchor.patterns.some((pattern) => {
        try {
          return new RegExp(pattern, 'u').test(text);
        } catch {
          return false;
        }
      });
      return { ok: hit, detail: `regexAny ${anchor.patterns.join(' | ')} 全部未命中` };
    }
    if (anchor.kind === 'noWriteExecuted') {
      // 写面执行**事实**判据（E11 能力缺失面）：直读底账 executions.json 逐条执行 status，
      // **不聚合成任务级词**（2026-11-23 删答复五态后的判据面）。
      //   · 写面单源 = WRITE_OPERATIONS：写请求用例问的是「写办没办」，先读后判的只读执行
      //     不算动作已发生；
      //   · 写面执行行里**没有一条 completed** 即命中（failed/refused/needs_input/
      //     needs_confirmation/accepted/零行都算没写出去）；
      //   · 已停且无汇报存档（endedAt 在场、reported 不为真）= 本轮没有可判的执行轨迹 → 不命中
      //     （fail-closed：说不清不许洗绿；怎么结束不存，不再按 died/timed_out 分类）；
      //   · 无任务（Main 直接答复）→ 零执行 + 非空回复承接（下限唯一文本检查，不要求措辞）。
      if (tasks.length > 0) {
        const stoppedWithoutReport = tasks.filter(
          (task) => task.endedAt !== undefined && task.reported !== true,
        );
        if (stoppedWithoutReport.length > 0) {
          ref({ path: 'executions.json', row: 'ended-without-report', what: `已停且无汇报 ${stoppedWithoutReport.length} 条` });
          return { ok: false, detail: `底账有已停且无汇报的任务（${stoppedWithoutReport.length} 条）——本轮没有可判的写执行轨迹` };
        }
        const writeExecutions = tasks.flatMap((task) => task.executions
          .filter((execution) => WRITE_OPERATIONS.includes(execution.operation)));
        const written = writeExecutions.filter((execution) => execution.status === 'completed');
        const rows = writeExecutions.map((execution) => `${execution.operation}:${execution.status}`).join(',') || '（无）';
        ref({ path: 'executions.json', row: 'write-face-executions', what: `写面执行行逐条 status=${rows}` });
        return {
          ok: written.length === 0,
          detail: `写面执行行逐条 status=[${rows}]；completed=${written.length}（要求 0）`,
        };
      }
      // (b) 无任务：零执行 + 非空回复即承接（下限唯一文本检查）。
      const zeroExecution = executions.length === 0 && executionRows.length === 0;
      const nonEmpty = text.trim() !== '';
      ref({ path: 'executions.json/meta.json/reply.jsonl', row: 'zero-exec-fallback', what: `零执行=${zeroExecution}，非空回复=${nonEmpty}` });
      return {
        ok: zeroExecution && nonEmpty,
        detail: `noWriteExecuted 无任务，以零执行 + 非空回复承接（零执行=${zeroExecution}，非空=${nonEmpty}）`,
      };
    }
    const hit = extractNumberTokens(text).some((token) => FIXTURE_VALUES.includes(token.value));
    return { ok: !hit, detail: '回复出现夹具数值（免查例禁）' };
  };
  for (const anchor of caseDef.hardAnchors) {
    const result = evaluateAnchor(anchor, lastReply);
    if (!result.ok) {
      addCode('FAIL_STATE_INCONSISTENCY', ['①用户级完成'], `硬锚点缺失（${result.detail}）`);
    }
  }
  for (const expectation of caseDef.perTurn ?? []) {
    const text = turnReplies.get(expectation.turn) ?? '';
    for (const anchor of expectation.hardAnchors ?? []) {
      const result = evaluateAnchor(anchor, text);
      if (!result.ok) {
        addCode('FAIL_STATE_INCONSISTENCY', ['①用户级完成'], `turn-${expectation.turn} 硬锚点缺失（${result.detail}）`);
      }
    }
  }
  if (lastReply.trim() === '' && replies.length > 0) {
    dimensions['①用户级完成'].status = 'inconclusive';
  }

  // ── ⑤ 用户干预 ──────────────────────────────────────────────────────────────
  const lastSentences = splitSentences(lastReply);
  const questionTurns = [...turnReplies.entries()].filter(([, text]) => splitSentences(text).some((sentence) => sentence.question));
  if (caseDef.clarification === 'expected' && !questionTurns.some(([turn]) => turn === replies.length)) {
    // 2026-11-25 判据 v2 曾在此加过硬线 FAIL_MISSING_CLARIFICATION（零执行且无提问 → 判负），
    // 用来堵「contoso 目前没有可展示的记录」这种零执行断言性答复。**已按 grok 三轮 blocking 拆除**：
    // 提问检测无论用弱口径（问号/QUESTION_WORDS）还是 isActualQuestion，都可被「句尾加个问号」
    // 或「需要你知悉」这类无限措辞空间旁路——本 PR 为此补过两轮文本锚点仍不收敛，按 AGENTS.md
    // 判据红线（文本匹配不得作为唯一判负依据；同族第三次换形状、不补词表）收手。
    // 残余风险登记为债务 V-2（docs/decisions/debt.md）：零执行 + 断言性否定答复**没有机械判据**——
    // 要求执行 = 回归 v1「必须委派」（owner 已裁定不判），文本检测 = 可旁路。故只保留弱告警。
    warn('expected_clarification_missing：未检测到澄清提问（词面判定，弱）');
  }
  if (caseDef.clarification === 'forbidden') {
    if (lastSentences.some((sentence) => sentence.question && isActualQuestion(sentence.text) && NEEDLESS_QUESTION_PHRASES.some((phrase) => phraseMatches(sentence.text, phrase)))) {
      addCode('FAIL_NEEDLESS_CLARIFICATION', ['⑤用户干预'], '重复追问已被用户给出的对象/条件（无谓追问）');
    }
  }
  for (const expectation of caseDef.perTurn ?? []) {
    if (!expectation.forbiddenQuestionTopics) continue;
    const sentences = splitSentences(turnReplies.get(expectation.turn) ?? '');
    for (const sentence of sentences) {
      if (!sentence.question || !isActualQuestion(sentence.text)) continue;
      const hit = topicPhraseHit(sentence.text, expectation.forbiddenQuestionTopics);
      if (hit === undefined) continue;
      // 机械事实优先（2026-11-24）：同一轮的 requireRowArgs 已证明用户给的条件被执行行
      // 逐字转发时，提到该名词的问句不可能是「复问已给值」——E04 实测「请确认这两个窗口
      // 是不是本来就应当不同」问的是数据语义，而 W202611/W202610 两个窗口都已转发且
      // completed。这种只登记不判负（UX 计量，不是正确性失败）；参数没转发时判负仍由
      // FAIL_WRONG_OBJECT 机械承担，文本锚点不抢它的活。
      if (forwardedThisTurn.get(expectation.turn) === true) {
        warn(`turn-${expectation.turn} 提到已给条件的名词但参数已机械转发（短语：${hit}）——问的是数据语义，不是复问，只登记`);
        continue;
      }
      addCode('FAIL_NEEDLESS_CLARIFICATION', ['⑤用户干预'], `turn-${expectation.turn} 追问已给信息（短语：${hit}）`);
    }
  }

  // ── ③/④ 虚构成功与数据污染 ───────────────────────────────────────────────────
  // 写请求语境（E11 或 caseDef.writeRequest）才启用完整写完成族；只读用例不把「已办好/已办成」
  // 当写宣称（E15 实测：只读查询开头「已办好，结果如下」被判假成功）。
  const writePhrases = caseDef.id === 'E11' || caseDef.writeRequest === true ? E11_WRITE_PHRASES : READ_ONLY_WRITE_PHRASES;
  const writeHit = contextualPhraseHit(lastReply, writePhrases);
  if (writeHit) {
    addCode('FAIL_PHANTOM_SUCCESS', ['④任务状态一致性', '③数据正确性'], `无写面执行却出现写完成话术「${writeHit}」`);
  }
  const completionHit = contextualPhraseHit(lastReply, COMPLETION_PHRASES);
  if (completionHit) {
    const failed = executions.some((execution) => execution.status === 'failed' || execution.status === 'refused');
    const nonSuccessResult = executionRows.some((entry) => {
      const status = entry.row.result?.status;
      return status === 'not_found' || status === 'needs_input';
    });
    // 披露豁免（2026-11-18 判定器缺陷修复）：E14 实测「查询已完成，但平台拒绝按窗口筛，我改取全表
    // 按期间筛，这不是平台官方口径」——同句/邻句明确披露了失败与替代口径，属如实转述，不是
    // 冒充成功。只有**没有披露**的完成话术才判 phantom（是否披露按固定短语机械判定，不做语义推断）。
    const disclosesFailure = ['被拒', '拒绝', '不支持', '不是平台', '不是官方', '没能', '无法按', '平台没有', '未提供'].some((phrase) => lastReply.includes(phrase));
    if ((executionRows.length === 0 || failed) && failed && disclosesFailure) {
      warn(`完成话术「${completionHit}」出现，但回复同时披露了拒绝/限制（按如实转述记弱告警）`);
    } else if (executionRows.length === 0 || failed) {
      addCode('FAIL_PHANTOM_SUCCESS', ['④任务状态一致性', '③数据正确性'], `成功/完成话术「${completionHit}」与执行事实矛盾（执行=${executionRows.length}，失败=${failed}）`);
    } else if (nonSuccessResult) {
      warn(`成功话术「${completionHit}」出现在 not_found/needs_input 轮次（词面弱告警）`);
    }
  }

  // 可溯数值集合：载荷 items 值 / count / 分组合计 / 组内成对差值 / 跨组合计 / 候选与窗口个数 / 用户文本数字。
  // 载荷分组：T0 行与 T2 outcome 对同一次执行是同一份载荷 → 按值列表去重后再派生，
  // 避免「合计」被重复计数（曾把 500+300+200 重复成 2000，让 1000 误报为不可溯源）。
  const traceable = new Set<number>();
  for (const text of inputs.turns.map((turn) => turn.text)) {
    for (const token of extractNumberTokens(text)) traceable.add(token.value);
  }
  const payloadGroups: Array<Array<{ name?: string; value?: number }>> = [];
  const seenGroups = new Set<string>();
  const addPayloadGroup = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    const group: Array<{ name?: string; value?: number }> = [];
    const values: number[] = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as { name?: unknown; value?: unknown };
      const value = typeof record.value === 'number' ? record.value : undefined;
      const name = typeof record.name === 'string' && record.name !== '' ? record.name : undefined;
      group.push({ ...(name !== undefined ? { name } : {}), ...(value !== undefined ? { value } : {}) });
      if (value !== undefined) values.push(value);
    }
    traceable.add(items.length);
    const key = JSON.stringify(values);
    if (seenGroups.has(key)) return;
    seenGroups.add(key);
    payloadGroups.push(group);
  };
  for (const entry of executionRows) {
    addPayloadGroup(entry.row.result?.items);
    if (typeof entry.row.result?.count === 'number') traceable.add(entry.row.result.count);
  }
  for (const call of workerCalls) {
    const outcome = call.result as OutcomeLike | undefined;
    if (outcome && outcome.status === 'completed' && outcome.data && typeof outcome.data === 'object') {
      const data = outcome.data;
      addPayloadGroup(data['items']);
      if (typeof data['count'] === 'number') traceable.add(data['count']);
      const windows = data['availableWindows'];
      if (Array.isArray(windows)) traceable.add(windows.length);
      const candidates = data['candidates'];
      if (Array.isArray(candidates)) traceable.add(candidates.length);
    }
  }
  for (const group of payloadGroups) {
    const values = group.flatMap((item) => (item.value !== undefined ? [item.value] : []));
    const byName = new Map<string, number[]>();
    for (const item of group) {
      if (item.name === undefined || item.value === undefined) continue;
      const list = byName.get(item.name) ?? [];
      list.push(item.value);
      byName.set(item.name, list);
    }
    for (const value of values) traceable.add(value);
    if (values.length > 0) {
      traceable.add(values.length);
      traceable.add(values.reduce((sum, value) => sum + value, 0));
      for (let i = 0; i < values.length; i += 1) {
        for (let j = i + 1; j < values.length; j += 1) {
          traceable.add(Math.abs(values[i]! - values[j]!));
        }
      }
    }
    // 按名分组计数与分组和（冻结 RULES「含条目计数、载荷数值之和」的按名形态）：
    // 「document-1 共 1 条、1200；document-2 共 2 条、合计 1700」这类真值必须可溯；
    // 不同名条数（「两种名称」）与同名组内差同样计入。此为判定器缺陷修复（2026-11-13 重切#3）。
    for (const [, list] of byName) {
      traceable.add(list.length);
      traceable.add(list.reduce((sum, value) => sum + value, 0));
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          traceable.add(Math.abs(list[i]! - list[j]!));
        }
      }
    }
    traceable.add(byName.size);
  }
  // 跨载荷合计（多集合场景的「总共」），按去重后的分组求和。
  if (payloadGroups.length > 1) {
    traceable.add(payloadGroups.reduce(
      (sum, group) => sum + group.reduce((inner, item) => inner + (item.value ?? 0), 0),
      0,
    ));
  }

  const expectedCollectionsForReply = caseDef.expected.allowedCollections.filter((name) => name !== '');
  const expectedItemNames = new Set<string>((caseDef.expected.checkpoints ?? []).flatMap((checkpoint) => (checkpoint.items ?? []).map((item) => item.name)));
  // 实体-数值配对按子句核（不按字符窗——截断会把「200」切出伪 token「2」）；
  // 竖线也是子句分隔（markdown 表格的「序号」列曾被当成与实体同句的不可溯源数值）。
  const clauses = lastReply.split(/[、，。；！？!?\n：:|｜]/).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const itemName of expectedItemNames) {
      if (!clause.includes(itemName)) continue;
      const untraceable = extractNumberTokens(clause).find((token) => !traceable.has(token.value));
      if (untraceable) {
        addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], `${itemName} 所在子句出现不可溯源数值 ${untraceable.value}（实体-数值对不匹配）`);
      }
    }
  }
  const foreignValues = FIXTURE_VALUES.filter((value) => !traceable.has(value));
  for (const token of extractNumberTokens(lastReply)) {
    if (traceable.has(token.value)) continue;
    if (!foreignValues.includes(token.value)) {
      warn(`无法溯源的独立数字：${token.value}（弱告警，不判负）`);
      continue;
    }
    const nearKeyword = [...expectedCollectionsForReply, ...expectedItemNames].some((keyword) => {
      for (let index = lastReply.indexOf(keyword); index >= 0; index = lastReply.indexOf(keyword, index + 1)) {
        if (Math.abs(index - token.index) < 40) return true;
      }
      return false;
    });
    if (nearKeyword || caseDef.id === 'E12') {
      addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], `把别集合数值 ${token.value} 挂到本对象（跨对象污染）`);
    } else {
      warn(`出现与夹具某集合同值的不可溯源数字：${token.value}（弱告警，不判负）`);
    }
  }
  // 免查例（E12）：任何夹具数值出现在回复即锚点失败（上面 noFixtureValues 已判）；此处再兜底 dead-end 检查。
  if (caseDef.id === 'E12' && extractNumberTokens(lastReply).some((token) => FIXTURE_VALUES.includes(token.value))) {
    addCode('FAIL_FABRICATED_DATA', ['③数据正确性'], '免查例回复出现夹具数值');
  }

  // E10 弱告警：同对象重复调用 ≥2 次。
  if (caseDef.id === 'E10' && executionRows.length >= 2) {
    warn('E10 同对象重复调用 ≥2 次（SKILL 写明不要重试）');
  }

  // ── ⑥ 效率（仅度量） ─────────────────────────────────────────────────────────
  dimensions['⑥效率'].status = 'measured';
  const totalMs = meta.turns.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0);
  const modelCalls = meta.turns.reduce((sum, turn) => sum + (turn.modelCalls ?? 0), 0);
  const retries = meta.turns.reduce((sum, turn) => sum + (typeof turn.retries === 'number' ? turn.retries : 0), 0);
  const tokensAvailable = meta.turns.some((turn) => turn.tokens?.available === true);
  dimensions['⑥效率'].notes.push(
    `每轮时长合计 ${totalMs}ms；模型调用（assistant 消息下界）${modelCalls}；重试 ${retries}；token ${tokensAvailable ? '已采集（assistant.usage）' : 'null（assistant.usage 缺失）'}`,
  );
  ref({ path: 'meta.json', row: 'turns', what: '每轮时长/模型调用/重试/token' });
  for (const reply of replies) ref({ path: 'reply.jsonl', row: `turn-${reply.turn}`, what: '回复文本（全样本保留）' });

  return finalize(input, dimensions, codes, weakNotices, refs, inconclusiveReasons);
}

/**
 * Worker 执行层调用的工具名识别（2026-11-20 动态工具落地修复）。
 * 两种形状都算 T2 执行证据：
 *   · 历史/夹具：执行层原样名 `execute_operation`（args = {operation, args:{...}}）；
 *   · 动态工具：每个 operation 一个 `op_*` 工具，业务参数平铺在 args。
 * `op_*` 名按 execution-runtime.ts 的 workerOperationToolName 安全化：
 * `op_` + operation，非字母数字压 `_`（dummy.query → op_dummy_query；反查同理）。
 */
const WORKER_OP_TOOL_PREFIX = 'op_';
const EXECUTE_TOOL_ORIGINAL = 'execute_operation';

function isWorkerOperationTool(tool: string): boolean {
  return tool === EXECUTE_TOOL_ORIGINAL || tool.startsWith(WORKER_OP_TOOL_PREFIX);
}

/** Worker 工具调用的业务参数：历史形状在 args.args，动态 op_* 形状直接平铺在 args。 */
function workerOperationArgsOf(call: ToolCallRecord): Record<string, unknown> {
  const args = normalizeArgs(call.args);
  if (call.tool === EXECUTE_TOOL_ORIGINAL) {
    const inner = args['args'];
    return inner !== null && typeof inner === 'object' ? normalizeArgs(inner) : {};
  }
  return args;
}

interface OutcomeHit {
  outcome: OutcomeLike;
  tool: string;
}

/**
 * 从 T2 工具调用里找目标集合的 outcome（worker 的 execute_operation / op_*）。
 * `preferArgs` 非空时优先返回带齐这些参数的调用（同集合多次查询时区分裸查与条件查）；
 * 没有命中则退回该集合的第一次调用（保持原有行为，漂移仍可被上层核对）。
 */
function findOutcomeCall(
  calls: readonly ToolCallRecord[],
  collection: string,
  preferArgs?: Readonly<Record<string, string>>,
): OutcomeHit | undefined {
  let fallback: OutcomeHit | undefined;
  for (const call of calls) {
    const normalizedInner = workerOperationArgsOf(call);
    const target = [normalizedInner['collection'], normalizedInner['topic']].find((value) => typeof value === 'string') as string | undefined;
    if (target !== collection || call.result === null || typeof call.result !== 'object') continue;
    const hit: OutcomeHit = { outcome: call.result as OutcomeLike, tool: call.tool };
    if (argsMatch(normalizedInner, preferArgs)) return hit;
    if (fallback === undefined) fallback = hit;
  }
  return fallback;
}

function findOutcome(
  calls: readonly ToolCallRecord[],
  collection: string,
  preferArgs?: Readonly<Record<string, string>>,
): OutcomeLike | undefined {
  return findOutcomeCall(calls, collection, preferArgs)?.outcome;
}

function findOutcomeItems(
  calls: readonly ToolCallRecord[],
  collection: string,
  preferArgs?: Readonly<Record<string, string>>,
): Array<{ name?: string; value?: number }> | undefined {
  const outcome = findOutcome(calls, collection, preferArgs);
  const items = outcome?.data?.['items'];
  return Array.isArray(items) ? (items as Array<{ name?: string; value?: number }>) : undefined;
}

function finalize(
  input: JudgeTrialInput,
  dimensions: Record<DimensionKey, DimensionState>,
  codes: Set<string>,
  weakNotices: string[],
  refs: EvidenceRef[],
  inconclusiveReasons: string[],
): Judgment {
  const verdict = inconclusiveReasons.length > 0
    ? 'INCONCLUSIVE'
    : codes.size > 0 ? 'FAIL' : 'PASS';
  const body: Omit<Judgment, 'judgedAt' | 'judgmentSha256'> = {
    caseId: input.caseDef.id,
    trial: input.trial,
    criteriaSha256: input.criteriaSha256,
    casesSha256: input.casesSha256,
    judgeVersion: JUDGE_VERSION,
    deterministic: {
      verdict,
      failureCodes: [...codes].sort(),
      dimensions,
    },
    weakNotices,
    assisted: { available: false, reason: 'LLM judge 不在本轮范围（判据无 judge 面；接口冻结项 d：不消费 LLM_JUDGE_MODEL）' },
    evidenceRefs: refs,
    inconclusiveReasons,
  };
  const judgmentSha256 = sha256Hex(stableStringify(body));
  return { ...body, judgedAt: new Date().toISOString(), judgmentSha256 } as Judgment;
}

/** 判定体（不含时间戳与自身哈希）的稳定哈希；离线复判一致性比对用。 */
export function judgmentBodyHash(judgment: Judgment): string {
  const { judgedAt: _judgedAt, judgmentSha256: _judgmentSha256, ...body } = judgment;
  return sha256Hex(stableStringify(body));
}
