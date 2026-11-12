/**
 * 申报契约遵循判据模块（workflow 用例 C1「申报契约遵循，不许死循环」；仓内用例 id = P1，
 * 见 scripts/eval/cases.yaml —— cases.yaml 的 C1 已被 20 轮长会话占位条目占用，故本用例
 * 另起 id，理由与 U2 同族，见 cases.yaml 的 P1 条目注释）。
 *
 * ── 为什么这条用例存在（数据里撞出来的）──────────────────────────────────────
 * 当前最大单一失败源。三处实测同一病根：模型提交 `{kind:'conversation', request:'…'}`
 * 的申报（多带一个字段就是另一份契约，`parseTurnDeclaration` 拒收，见 turn-contract.ts:307-309
 * 与 schema 的 additionalProperties:false），宿主回一句**零信息**的
 * 「申报不是合法的结构化意图。请按 schema 重新调用 route_current_turn。」，
 * 模型照着同一形状再交一次 → 循环：
 *   · T9 r01：同一回合 33 次 `route_declaration_invalid` → 模型弃权（route_declaration_missing）
 *     → 用户拿到「我需要实际查询平台才能回答这个问题…」（NO_EXECUTION_CLARIFICATION）；
 *   · T9 r04：同一回合 2 次 + 弃权 → 同上（归因轮被判红）；
 *   · arch-d C2：同一回合 226 次（整例 242 次）→ 300s 看门狗收掉，0 轮 0 调用。
 * 而 #54 已裁定「申报层 1+2 判删、待实施」（⑦，见 AGENTS.md 的已删及理由表）——在它消失
 * 之前，这条用例是它的兜底回归锁：**申报层可以拒收，但不许把一轮拖成死循环，也不许把
 * fail-closed 的出口做成一句零信息的话术。**
 *
 * ── 机械判据（逐条对应裁定原文）──────────────────────────────────────────────
 * ① 不得出现无限重试 / ③ 重试次数有界：单回合 `route_declaration_invalid` 次数有上限。
 *    阈值的来源是实测分布（各 run 的**单回合最大值**，脚本逐 requestId 聚合）：
 *      0（r05/r08/r09/verify-b-c1-128k/baseline 无触发）
 *      1（r02/r06/baseline…）  2（arch-a 弱/强、r04）    ← 健康样例实测上限 = 2
 *      3（r03）  4（verify-merge/t9）  5（arch-b）  6（r07）  33（r01）  226（arch-d C2）
 *    健康样例（模型在同回合内自纠成功）的单回合上限正好是 2，故 **容差 = 2，≥3 判红**；
 *    这条线与仓内既有的风暴尺同族（同一调用重复 ≥3 判风暴，cases.yaml 的 noStorm.threshold: 3）。
 *    阈值是**声明的政策线**，不是自然常数：原始计数每次都在 evidence 里如实报出，评审可据
 *    分布表重新标定，但标定必须改代码里的常量、带上新证据，不许在报告里含糊过去。
 * ② fail-closed 路径必须给出可行动的话术：**每个用户可见回复**非空，且不得是零信息的
 *    空洞话术（FALLBACK_FAILURE「查询失败,请稍后再试或联系管理员」/ FALLBACK_TIMEOUT
 *    「查询超时,请稍后再试」/ 同形锚定句）。NO_EXECUTION_CLARIFICATION 是裁定认可的
 *    fail-closed 话术（error-codes.ts:345-347，说清了"要重新查"与"缺什么"），**允许**——
 *    判据只反对"零信息"，不反对"失败关闭"本身。
 * ③ 回合必须收口（死循环的另一种形态是没有出口）：每个出现过申报失败的回合都要有
 *    `turn_span`（回合闭合）；日志里出现探针的 300s 等待回复超时标记即红（arch-d 形状）；
 *    实测轮数少于用例消息数即红（用例没跑完）。
 * ④ 证据完整性（防假绿）：日志里 `"event":"route_declaration_invalid"` 的**原始出现次数**
 *    必须等于**解析成功的条数**——解析不出来就是证据不可读，判 inconclusive，绝不判绿
 *    （"证据缺席不是零"是同一条纪律）。
 *
 * ── 职责边界（不越界）────────────────────────────────────────────────────────
 * 本模块只判"申报契约的收口过程"：不判模型有没有答对用户的问题（那是 T9 的归因判据
 * scripts/eval/attribution.ts）、不判它该不该委派（那是归因/期望值层）、不判执行面
 * （那是 execution-scope / U1 / U2）。回复面只量"是不是空洞话术"。
 *
 * 纯函数：只吃两样东西——探针日志文本、逐轮回复投影。不读网络、不读模型自述以外的来源、
 * 不起装配。措辞常量**直接 import 生产的唯一消息表**（parser 与话术都是被测对象本身，
 * 抄一份副本会让"宿主改了话术"这件事在判据侧看不见——与 execution-language-eval.ts
 * 刻意自持同义尺的情形相反，那里的被测对象是模型文本，这里是被测机制自己的输出）。
 */

// 话术常量取自生产的唯一消息表：判据要认的就是宿主真实会说的那几句。
// （import 而不抄：宿主改话术时本判据跟着变，不会出现"判据认旧句子、宿主说新句子"的假绿。）
import { FALLBACK_FAILURE, FALLBACK_TIMEOUT, NO_EXECUTION_CLARIFICATION } from '../../packages/agent/src/runtime-messages';
// 容差同样取生产的单一出处（2026-11-12 分层调整）：本判据与宿主的收敛界是**同一个数**，
// 各持一份字面值就会出现"宿主收在 2、判据认 3"的静默分叉。方向是 eval → 生产，
// 不是生产 → eval（生产代码与生产测试不得依赖 scripts/eval，见 declaration-retry-bound.test.ts 的注）。
import { MAX_DECLARATION_REJECTIONS } from '../../packages/agent/src/turn-state';

/** 仓内用例 id（cases.yaml）。workflow 里这条叫 C1。 */
export const DECLARATION_CASE_ID = 'P1';

/**
 * 单回合同形状拒收的容差。违规条件 = 计数 **> 容差**（即 ≥3）。
 * 依据见文件头②的实测分布表：健康样例（同回合内自纠成功）实测上限 = 2。
 * 值直接派生自生产常量 `MAX_DECLARATION_REJECTIONS`（packages/agent/src/turn-state.ts）——
 * 那里是唯一权威与取值依据所在，本行只是它在判据侧的别名。
 */
export const INVALID_DECLARATION_TOLERANCE = MAX_DECLARATION_REJECTIONS;

/** 探针的等待回复上限（probe-real-agent.ts 的 PROBE_REPLY_WAIT_MS = 300_000）在日志里的原文标记。 */
export const REPLY_WAIT_TIMEOUT_MARKER = '等待回复超时';

/** 探针日志里申报事件的类型（宿主 console.warn 的 JSON 行，event 字段的全部取值）。 */
export const DECLARATION_EVENT_TYPES = [
  'route_declaration_invalid',
  'route_declaration_missing',
  'turn_declaration',
  'turn_span',
] as const;
export type DeclarationEventType = (typeof DECLARATION_EVENT_TYPES)[number];

/** 日志里一条申报事件的消费投影（字段缺席 = 这条事实本来就没有，不是零）。 */
export interface DeclarationLogEvent {
  event: DeclarationEventType;
  /** 日志行号（1-based，原文定位用）。 */
  line: number;
  requestId?: string;
  /** 宿主退回原文（route_declaration_invalid 的 reason）。 */
  reason?: string;
  /** 被拒申报的键集合（诊断用：多带的是哪个字段）。 */
  keys?: string[];
  /** 被拒申报自报的 kind（诊断用）。 */
  kind?: string;
  /** turn_span 的 outcome（ok / route_declaration_missing / …）。 */
  outcome?: string;
  durationMs?: number;
}

/** 一轮的证据投影（探针报告的 turns 切片；reply 必给，requestId 有就用来精确配对）。 */
export interface DeclarationTurnInput {
  reply: string;
  requestId?: string;
}

export interface DeclarationContractInput {
  /** 探针日志全文（<out>/probe.log 的原始文本）。 */
  logText: string;
  /** 逐轮回复（探针报告 results[case].turns 的投影，发送顺序）。 */
  turns: readonly DeclarationTurnInput[];
  /** 用例的消息条数（探针每轮一条；实测轮数少于它 = 用例没跑完）。 */
  expectedTurns: number;
  /**
   * 日志里要切的用例段（缺省 = 本用例 P1）。参数化是为了让**历史事故证据**能原样入测：
   * r01/r04 的原文段头是 `=== T9 … ===`、arch-d 的是 `=== C2 … ===`，转抄时不该改一个字符
   * （改了就变成"我造的夹具"而不是"真实事故原文"）。
   */
  caseId?: string;
}

/** 逐回合的申报事实（回合边界由 turn_span 切出，与探针的回合语义同源）。 */
export interface DeclarationTurnFacts {
  index: number;
  requestId?: string;
  /** 本回合 route_declaration_invalid 次数（判据③的原始计数）。 */
  invalidCount: number;
  /** 被拒形状的去重指纹（如 'keys=[kind,request] kind=conversation'），诊断用。 */
  invalidShapes: string[];
  /** 宿主退回原文（本回合第一条）。 */
  invalidReason?: string;
  /** 本回合是否出现 route_declaration_missing（模型被催一次后仍不申报）。 */
  declarationMissing: boolean;
  /** 本回合是否有 turn_span（回合闭合）。 */
  closed: boolean;
  /** 本回合的 token/耗时事实（有就给）。 */
  durationMs?: number;
  outcome?: string;
  /** 探针报告里对应轮的回复（没有对上的轮为 undefined——报告缺席时不冒充空回复）。 */
  reply?: string;
}

export interface DeclarationEvidence {
  /** 命中的用例段是否存在（--only 单跑时就是整段；全量日志里按段切）。 */
  sectionFound: boolean;
  /** 日志里 route_declaration_invalid 的原始出现次数（含解析失败的潜在行）。 */
  rawInvalidOccurrences: number;
  /** 解析成功的 route_declaration_invalid 条数。 */
  parsedInvalidCount: number;
  /** 逐回合事实。 */
  turns: DeclarationTurnFacts[];
  /** 单回合最大拒收次数（判据①的原始值）。 */
  maxInvalidPerTurn: number;
  /** 用例段内轮数（turn_span 数）与用例消息条数。 */
  observedTurns: number;
  expectedTurns: number;
  /** 日志里是否出现 300s 等待回复超时标记。 */
  replyWaitTimeout: boolean;
  /** 逐轮回复面的违例原文（'第N轮：…'）。 */
  replyFaceViolations: string[];
}

export type DeclarationOutcome =
  /** 全部判据通过。 */
  | 'clean'
  /** 判据①：单回合同形状拒收超过容差（死循环前兆）。 */
  | 'retry-unbounded'
  /** 判据③：回合没闭合 / 被 300s 看门狗收掉 / 用例没跑完。 */
  | 'turn-not-closed'
  /** 判据②：回复为空或零信息空洞话术。 */
  | 'hollow-reply'
  /** 判据④：日志证据不可读（解析不出 / 段找不到）——不判绿。 */
  | 'inconclusive';

export interface DeclarationVerdict {
  caseId: string;
  ok: boolean;
  outcome: DeclarationOutcome;
  /** 红判据原文（空 = 无违例）。 */
  violations: string[];
  /** 信息性事实（不进红绿：计数、形状、missing 标记等）。 */
  informational: string[];
  evidence: DeclarationEvidence;
}

/** 解析一行日志是不是 JSON 事件（宿主埋点是纯 JSON 行；别的前缀行直接跳过）。 */
function parseEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 逐条解析日志里的申报事件（保持原序）。
 *
 * 只认四种 event（DECLARATION_EVENT_TYPES）；别的 JSON 行（delegation_span、business_skill_loaded…）
 * 一律跳过——本判据不消费它们。
 */
export function parseDeclarationEvents(logText: string): DeclarationLogEvent[] {
  const events: DeclarationLogEvent[] = [];
  const lines = logText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const record = parseEventLine(lines[index] ?? '');
    if (!record) continue;
    const event = record['event'];
    if (typeof event !== 'string' || !DECLARATION_EVENT_TYPES.includes(event as DeclarationEventType)) continue;
    const requestId = record['requestId'];
    const reason = record['reason'];
    const keys = record['keys'];
    const kind = record['kind'];
    const outcome = record['outcome'];
    const durationMs = record['durationMs'];
    events.push({
      event: event as DeclarationEventType,
      line: index + 1,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(Array.isArray(keys) ? { keys: keys.filter((item): item is string => typeof item === 'string') } : {}),
      ...(typeof kind === 'string' ? { kind } : {}),
      ...(typeof outcome === 'string' ? { outcome } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
    });
  }
  return events;
}

/**
 * 按用例 id 切出日志里的用例段（探针每个用例打一行 `=== <id> <intent> ===` 头）。
 *
 * 切到下一个用例头为止；`--only P1` 单跑时整段就是全日志。段尾的汇总行
 * （`================ 汇总 …`）不匹配用例头形态（`=== ` 后必须紧跟 id + 空格），
 * 所以不会把汇总吞进段里。
 *
 * 找不到段 = 证据缺席 → null（调用方判 inconclusive，不判零）。
 */
export function sliceCaseSection(logText: string, caseId: string): string | null {
  const lines = logText.split('\n');
  const headerRe = /^===\s+([A-Za-z0-9_-]+)\s/;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = headerRe.exec(lines[index] ?? '');
    if (match && match[1] === caseId) { start = index; break; }
  }
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = headerRe.exec(lines[index] ?? '');
    if (match) return lines.slice(start, index).join('\n');
  }
  return lines.slice(start).join('\n');
}

/** 被拒形状指纹（去重键）：多带哪个键、自报什么 kind。 */
export function invalidShapeOf(event: DeclarationLogEvent): string {
  const keys = event.keys ? `keys=[${event.keys.join(',')}]` : 'keys=缺';
  const kind = event.kind ? `kind=${event.kind}` : 'kind=缺';
  return `${keys} ${kind}`;
}

/**
 * 回复面的空洞话术判定（判据②的机械面，纯函数；探针 runner 与测量脚本共用同一把尺）。
 *
 * 红 = 空回复（trim 后无正文）、FALLBACK_FAILURE / FALLBACK_TIMEOUT 原文、或同形锚定句
 * （整句只有「查询失败/查询超时 + 稍后再试」的信息量）。NO_EXECUTION_CLARIFICATION 原文
 * **放行**（裁定认可的 fail-closed 话术：说清了要重新查、缺什么）。
 *
 * 返回 null = 通过；返回字符串 = 违例原文。
 */
export function replyFaceViolation(reply: string): string | null {
  const text = reply.trim();
  if (!text) return '空回复（用户拿不到任何文本）';
  if (text === NO_EXECUTION_CLARIFICATION) return null;
  if (text === FALLBACK_FAILURE || text === FALLBACK_TIMEOUT) {
    return `零信息空洞话术：「${text}」`;
  }
  // 同形锚定句：整句只有"查询失败/超时 + 重试导航"，没有对象、没有原因、没有下一步。
  // 结尾要求句末（允许尾部标点/空白），避免把「查询失败的原因是…」这类有内容的句子误判。
  if (/^查询(失败|超时)\s*[，,、]?\s*(请稍后再试|请稍后重试|请联系管理员|或联系管理员)*[\s。.！!]*$/u.test(text)) {
    return `零信息空洞话术：「${text}」`;
  }
  return null;
}

/**
 * 判定体：申报契约遵循（判据①②③④，见文件头）。
 *
 * 回合切法：日志按 turn_span 切回合（探针一回合一行 turn_span，带 requestId 与 outcome），
 * 与探针报告 turns 的发送顺序一一对齐；对齐不上的尾部回合按"未闭合"处理（不猜）。
 */
export function judgeDeclarationContract(input: DeclarationContractInput): DeclarationVerdict {
  const caseId = input.caseId ?? DECLARATION_CASE_ID;
  const section = sliceCaseSection(input.logText, caseId);
  const source = section ?? input.logText;
  const events = parseDeclarationEvents(source);
  const rawInvalidOccurrences = (source.match(/"event"\s*:\s*"route_declaration_invalid"/g) ?? []).length;

  // ── 回合切分：turn_span 是回合边界（前一 span 之后 → 本 span 含） ──
  const invalidEvents = events.filter((event) => event.event === 'route_declaration_invalid');
  const spans = events.filter((event) => event.event === 'turn_span');
  const missingEvents = events.filter((event) => event.event === 'route_declaration_missing');
  const byRequestId = (list: readonly DeclarationLogEvent[], requestId: string | undefined): DeclarationLogEvent[] =>
    requestId === undefined ? [] : list.filter((event) => event.requestId === requestId);

  interface Bucket { span?: DeclarationLogEvent; invalid: DeclarationLogEvent[]; missing: DeclarationLogEvent[]; order: number }
  const buckets: Bucket[] = [];
  const bucketByRequestId = new Map<string, Bucket>();
  const bucketFor = (requestId: string | undefined, order: number): Bucket => {
    if (requestId !== undefined) {
      const existing = bucketByRequestId.get(requestId);
      if (existing) return existing;
    }
    const bucket: Bucket = { invalid: [], missing: [], order };
    buckets.push(bucket);
    if (requestId !== undefined) bucketByRequestId.set(requestId, bucket);
    return bucket;
  };
  for (const event of events) {
    if (event.event === 'route_declaration_invalid') bucketFor(event.requestId, event.line).invalid.push(event);
    else if (event.event === 'route_declaration_missing') bucketFor(event.requestId, event.line).missing.push(event);
    else if (event.event === 'turn_span') {
      const bucket = bucketFor(event.requestId, event.line);
      bucket.span = event;
    }
  }
  // 有 span 的桶按 span 出现顺序排（= 发送顺序）；无 span 的桶（未闭合）跟在后面。
  buckets.sort((a, b) => (a.span?.line ?? Number.MAX_SAFE_INTEGER) - (b.span?.line ?? Number.MAX_SAFE_INTEGER));

  const turnReplies = input.turns;
  const turnFacts: DeclarationTurnFacts[] = buckets.map((bucket, index) => {
    const requestId = bucket.span?.requestId ?? bucket.invalid[0]?.requestId ?? bucket.missing[0]?.requestId;
    const shapes = [...new Set(bucket.invalid.map(invalidShapeOf))];
    const paired = turnReplies[index];
    const sameRequest = requestId !== undefined && paired?.requestId === requestId ? paired : undefined;
    const reply = (sameRequest ?? paired)?.reply;
    return {
      index,
      ...(requestId !== undefined ? { requestId } : {}),
      invalidCount: bucket.invalid.length,
      invalidShapes: shapes,
      ...(bucket.invalid[0]?.reason ? { invalidReason: bucket.invalid[0].reason } : {}),
      declarationMissing: bucket.missing.length > 0,
      closed: bucket.span !== undefined,
      ...(bucket.span?.durationMs !== undefined ? { durationMs: bucket.span.durationMs } : {}),
      ...(bucket.span?.outcome ? { outcome: bucket.span.outcome } : {}),
      ...(reply !== undefined ? { reply } : {}),
    };
  });

  const maxInvalidPerTurn = turnFacts.reduce((max, turn) => Math.max(max, turn.invalidCount), 0);
  const replyWaitTimeout = source.includes(REPLY_WAIT_TIMEOUT_MARKER);

  // ── 回复面（判据②）：逐轮原文核；没有回复文本的回合（报告缺席）不在这一层判 ——
  //    它在判据③按"用例没跑完/回合未闭合"出红，两类事实不互相冒充。
  const replyFaceViolations = turnReplies
    .map((turn, index) => {
      const violation = replyFaceViolation(turn.reply);
      return violation ? `第${index}轮：${violation}` : null;
    })
    .filter((item): item is string => item !== null);

  const informational: string[] = [];
  for (const turn of turnFacts) {
    if (turn.invalidCount === 0) continue;
    informational.push(
      `第${turn.index}轮申报被拒 ${turn.invalidCount} 次（形状 ${turn.invalidShapes.join(' / ')}）；`
      + `宿主退回原文「${turn.invalidReason ?? '（缺）'}」`,
    );
  }
  for (const turn of turnFacts) {
    if (turn.declarationMissing) {
      informational.push(`第${turn.index}轮：模型被催一次后仍未申报（route_declaration_missing）——弃权路径，话术面由判据②核`);
    }
  }
  if (invalidEvents.length > 0) {
    const kinds = [...new Set(invalidEvents.map((event) => invalidShapeOf(event)))];
    informational.push(`整例被拒申报共 ${invalidEvents.length} 次，出现过的形状：${kinds.join(' / ')}`);
  }

  const violations: string[] = [];
  let outcome: DeclarationOutcome = 'clean';
  const mark = (next: DeclarationOutcome): void => {
    if (outcome === 'clean') outcome = next;
  };

  // 判据④：证据不可读不判绿。
  if (!section) {
    violations.push(`日志里找不到用例 ${caseId} 的段（\`=== ${caseId} … ===\` 头）——证据缺席，不判绿`);
    outcome = 'inconclusive';
  }
  if (rawInvalidOccurrences > invalidEvents.length) {
    violations.push(
      `日志里 route_declaration_invalid 原始出现 ${rawInvalidOccurrences} 次，只解析出 ${invalidEvents.length} 条`
      + `——有行解析不出，证据不完整，不判绿`,
    );
    outcome = 'inconclusive';
  }

  // 判据①：单回合同形状拒收 > 容差 = 死循环前兆。
  for (const turn of turnFacts) {
    if (turn.invalidCount > INVALID_DECLARATION_TOLERANCE) {
      violations.push(
        `第${turn.index}轮同一申报形状被拒 ${turn.invalidCount} 次（容差 ${INVALID_DECLARATION_TOLERANCE}）：`
        + `${turn.invalidShapes.join(' / ')}——宿主每次回同一句零信息话术，模型照原样重交 = 死循环前兆`,
      );
      mark('retry-unbounded');
    }
  }

  // 判据③：回合收口 / 看门狗 / 用例跑完。
  if (replyWaitTimeout) {
    violations.push(`日志出现「${REPLY_WAIT_TIMEOUT_MARKER}」——回合被探针 300s 等待上限收掉（arch-d 的形状），回合没有出口`);
    mark('turn-not-closed');
  }
  for (const turn of turnFacts) {
    if (!turn.closed) {
      violations.push(`第${turn.index}轮没有 turn_span——回合没闭合（模型卡在申报循环里未返回）`);
      mark('turn-not-closed');
    }
  }
  if (turnFacts.length < input.expectedTurns) {
    violations.push(`实测回合数 ${turnFacts.length} < 用例消息数 ${input.expectedTurns}——用例没跑完`);
    mark('turn-not-closed');
  }

  // 判据②：回复面空洞话术。
  for (const line of replyFaceViolations) {
    violations.push(`${line}——fail-closed 出口必须是可行动的话术（NO_EXECUTION_CLARIFICATION 属可行动，放行）`);
    mark('hollow-reply');
  }

  return {
    caseId,
    ok: violations.length === 0,
    outcome,
    violations,
    informational,
    evidence: {
      sectionFound: section !== null,
      rawInvalidOccurrences,
      parsedInvalidCount: invalidEvents.length,
      turns: turnFacts,
      maxInvalidPerTurn,
      observedTurns: turnFacts.length,
      expectedTurns: input.expectedTurns,
      replyWaitTimeout,
      replyFaceViolations,
    },
  };
}

/** 人读摘要（measure 脚本与测试共用；成败与每一条原文都在）。 */
export function declarationCriteriaSummary(verdict: DeclarationVerdict): string[] {
  const lines: string[] = [];
  const label = verdict.ok ? '绿' : verdict.outcome === 'inconclusive' ? '灰（不可判）' : '红';
  lines.push(
    `[申报契约 ${verdict.caseId}] ${label} · outcome=${verdict.outcome} · `
    + `单回合最大拒收 ${verdict.evidence.maxInvalidPerTurn} 次（容差 ${INVALID_DECLARATION_TOLERANCE}） · `
    + `整例被拒 ${verdict.evidence.parsedInvalidCount} 次 · 回合 ${verdict.evidence.observedTurns}/${verdict.evidence.expectedTurns} 闭合`,
  );
  for (const violation of verdict.violations) lines.push(`  ✗ ${violation}`);
  for (const fact of verdict.informational) lines.push(`  · ${fact}`);
  return lines;
}
