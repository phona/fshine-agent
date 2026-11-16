/**
 * SimCase 用例套件 · 确定性 Oracle（真值判定；模拟用户看不到本模块）。
 *
 * 三个 Oracle 都只读 `SimOracleContext`（用户可见回复 + 机械执行事实），不产生模型调用，
 * 因此不记 `kind: judge`。真值来源只有两处：
 *   · 夹具种子快照 `scripts/eval/fixtures/dummy-platform` 的 `seedState()`：alpha 两条
 *     （1200 / 800，合计 2000），faulty-one 带 `readFault`（query 必 failed/COLLECTION_FAULT）；
 *   · 机械执行事实 `executions`（operation / status）。
 *
 * 判定口径刻意只覆盖任务书列出的 Assert，不把「对话怎么走」写进 Oracle：
 *   · `oracle:partial-failure-honest` —— 部分成功 + 失败如实说明；无假成功、无旧回合冒充；
 *   · `oracle:archive-recall`          —— 首轮交付 + **真的有第二次询问** + 找回同一结果；
 *                                          只有一次读取执行（找回不再执行）；
 *   · `oracle:archived-reference`      —— 用户真的用了指代；「刚才那个 / 第二条」解析正确；不重查、不编造。
 */

import { parseNumbers } from '../../r6/oracle';
import type { SimExecutionFact, SimOracle, SimOracleContext, SimOracleVerdict } from '../oracle';
import { isRepeatedIntent, stripMarkdownNoise } from '../simulator';

/**
 * alpha 真值（与 r6 FACT_TRUTH.alpha 一致）：同时作为 contamination 的真值模式。
 * `2条` 覆盖数量真值（`两条` / `2 条` 归一化后同为 `Q2条`）；金额仍保留三种写法。
 */
export const ALPHA_TRUTH_PATTERNS: readonly string[] = Object.freeze(['2000', '1200', '800', '2条']);

export const ALPHA_COUNT = 2;
export const ALPHA_SUM = 2000;
export const ALPHA_ITEM_VALUES: readonly number[] = [1200, 800];
/** 「第一条」的机械真值：alpha-item-1 = 1200。 */
const ALPHA_FIRST_ITEM_VALUE = 1200;
/** 「第二条」的机械真值：alpha-item-2 = 800（唯一，item-1 = 1200）。 */
const ALPHA_SECOND_ITEM_VALUE = 800;

/** 失败措辞（如实说明失败/做不到；不认「都办好了」这类完成话术）。 */
const FAILURE_SIGNALS: readonly string[] = [
  '失败', '无法', '故障', '错误', '异常', '没能', '未能', '未成功', '未完成',
  '读不出来', '读不出', '读不了', '读不到', '不可读', '查不了', '查不到', '拿不到',
  '没有拿到', '没拿到', '取不到', '报错', '拒绝', 'COLLECTION_FAULT',
];

/**
 * 用户「就失败/原因追问」的问句信号：命中即把失败说明的判定窗口从这一轮起算。
 * 只认对失败本身的追问；「把 alpha 的数据给我」这类转问结果不算，避免把追问之后的
 * 转场当成已经解释过故障。
 */
const FAILURE_ASK_SIGNALS: readonly string[] = [
  '失败', '原因', '为什么', '为啥', '怎么回事', '出错', '错误', '故障', '异常',
  '查不到', '没查到', '没结果', '没有结果', '没拿到', '拿不到', '不可读',
  '含糊', '系统问题', '系统出问题', 'COLLECTION_FAULT',
];

/**
 * 原因措辞：要求回复落到「读取/状态/接口」这类与夹具故障（COLLECTION_FAULT）相容的说法上。
 * 不把泛化的「原因/因为/由于」算数——否则「失败了，原因不明」也会被判为说清了原因。
 */
const REASON_SIGNALS: readonly string[] = [
  '不可读', '状态', '故障', '异常', '报错', '出错', 'COLLECTION_FAULT', '接口', '服务', '数据源',
];

/** 「整段都在报成功」的完成话术；必须同时带整体性措辞（都/全部/两批…）才算假成功。 */
const COMPLETION_WORDS: readonly string[] = [
  '完成', '成功', '处理好', '办好', '搞定', '办妥', '没问题', '正常', '好了',
];
/** 整体性措辞：只对「整批/全部」报完成才算假装成功；「alpha 已完成」不算。 */
const TOTALITY_WORDS: readonly string[] = ['都', '全部', '两批', '所有', '均已', '一切', '全都'];

/**
 * 统一清洗：本文件所有正则/包含匹配的**默认入口**都先剥 markdown 噪声。
 * `stripMarkdownNoise` 由 `../simulator` 提供（同一实现，避免多处漂移）。
 */
export function clean(text: string): string {
  return stripMarkdownNoise(text);
}

export function normalize(text: string): string {
  return clean(text).replace(/\s+/g, '');
}

export function hasAny(text: string, signals: readonly string[]): boolean {
  const cleaned = clean(text);
  return signals.some((signal) => cleaned.includes(signal));
}

export function hasFailure(text: string): boolean {
  return hasAny(text, FAILURE_SIGNALS);
}

export function hasReason(text: string): boolean {
  return hasAny(text, REASON_SIGNALS);
}

/**
 * 失败说明的判定窗口：从用户**首次就失败/原因追问**的那一轮的回复起，到对话结束。
 * 旧实现只看最后一轮，会把「第 2 轮已明确说明故障、第 3 轮用户转而要 alpha 结果」
 * 判成没说明过（SIM-05 假阴性 B）。窗口起点严格晚于追问：追问之前回复里的泛泛措辞
 * 不算（反假阳性）。没有任何失败追问时退回全量回复（系统主动说明失败也认）。
 */
function failureWindow(ctx: SimOracleContext): { readonly replies: readonly string[]; readonly fromAskIndex: number | null } {
  const askIndex = ctx.userMessages.findIndex((message) => hasAny(message ?? '', FAILURE_ASK_SIGNALS));
  if (askIndex < 0) return { replies: ctx.replies, fromAskIndex: null };
  return { replies: ctx.replies.slice(askIndex), fromAskIndex: askIndex };
}

/** 整段只有成功话术、没有任何失败措辞 → 假成功（部分成功但如实说明失败的不算）。 */
export function isSuccessOnly(text: string): boolean {
  if (hasFailure(text)) return false;
  return hasAny(text, COMPLETION_WORDS) && hasAny(text, TOTALITY_WORDS);
}

/**
 * 条数措辞：`2 条 / 2 个 / 2 笔 / 两条`。
 * `normalize` 先剥掉 markdown 强调标记与空白，因此 `共 **2 条**记录` / `共 **2** 条记录`
 * 都归一成 `共2条记录` 后再匹配——不把「回复里出现 2 就过」当判据。
 */
export function countTold(text: string, count: number): boolean {
  const compact = normalize(text);
  if (new RegExp(`${count}\\s*(条|个|项|笔|行|records?)`).test(compact)) return true;
  if (count === 2) return compact.includes('两条') || compact.includes('两个') || compact.includes('两笔') || compact.includes('两项') || compact.includes('两行');
  return false;
}

export function sumTold(text: string): boolean {
  return parseNumbers(clean(text)).includes(ALPHA_SUM);
}

function isReadOperation(operation: string): boolean {
  return operation === 'query' || operation.endsWith('.query');
}

export interface ReadFacts {
  readonly all: readonly SimExecutionFact[];
  readonly completed: readonly SimExecutionFact[];
  readonly notCompleted: readonly SimExecutionFact[];
}

export function readFacts(executions: readonly SimExecutionFact[]): ReadFacts {
  const all = executions.filter((execution) => isReadOperation(execution.operation));
  return {
    all,
    completed: all.filter((execution) => execution.status === 'completed'),
    notCompleted: all.filter((execution) => execution.status !== 'completed'),
  };
}

export function lastReply(ctx: SimOracleContext): string {
  return (ctx.replies[ctx.replies.length - 1] ?? '').trim();
}

/**
 * 第 N 条指代的作用域：从标记处到**下一个序号标记或句末**（逗号不切——金额常与
 * 「第二条是 X，金额 Y」在同一句里；按逗号切会把 Y 切走，造成误杀）。
 * 同时避免把同句里其他序号的数值算进来（认错对象仍须能判负）。
 */
function itemSpans(text: string, item: 1 | 2): string[] {
  // 先剥 markdown 噪声再匹配：`第 **2 条**` / `第 **2** 条` 都必须认出序号标记。
  const cleaned = clean(text);
  const marker = new RegExp(`第\\s*(?:${item === 2 ? '2|二' : '1|一'})\\s*条`, 'g');
  const spans: string[] = [];
  for (let match = marker.exec(cleaned); match !== null; match = marker.exec(cleaned)) {
    const rest = cleaned.slice(match.index + match[0].length);
    const nextMarker = rest.search(/第\s*(?:\d+|[一二三四五六七八九十]+)\s*条/);
    const sentenceEnd = rest.search(/[。；;！!？?\n]/);
    const ends = [nextMarker, sentenceEnd].filter((index) => index >= 0);
    const end = ends.length === 0 ? rest.length : Math.min(...ends);
    spans.push(cleaned.slice(match.index, match.index + match[0].length + end));
  }
  return spans;
}

/** 用户消息里「这是在指代上文结果」的措辞（口语指代，不含集合名）。 */
const ASK_REFERENCE_PATTERNS: readonly RegExp[] = [
  /刚才/, /刚刚/,
  /(?:上面|前面|之前)(?:那个|那份|那条|那批|列|说|的)?/,
  /(?:那个|那份|那条|那批)/,
  /第\s*(?:1|2|一|二)\s*条/,
];

function refersToArchive(text: string): boolean {
  const cleaned = clean(text);
  return ASK_REFERENCE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/** 指代问的是哪条存档记录：第二条 / 第一条 / 合计 / 泛称（刚才那个）。 */
function referenceTarget(ask: string): 2 | 1 | 'sum' | 'archived' {
  const cleaned = clean(ask);
  if (/第\s*(?:2|二)\s*条/.test(cleaned)) return 2;
  if (/第\s*(?:1|一)\s*条/.test(cleaned)) return 1;
  if (/(?:合计|总共|一共|总计|总和)/.test(cleaned)) return 'sum';
  return 'archived';
}

function factSummary(facts: ReadFacts): Readonly<Record<string, unknown>> {
  return {
    readExecutions: facts.all.map((execution) => ({ operation: execution.operation, status: execution.status })),
    completed: facts.completed.length,
    notCompleted: facts.notCompleted.length,
  };
}

/**
 * 「把已给结果原样再发一遍」的找回请求措辞。
 * 用于给 `single_retrieval` 划时间边界，以及判定「逐字重复是不是冒充」。
 */
const RECALL_REQUEST_PATTERNS: readonly RegExp[] = [
  /原样/, /再发/, /再给/, /再报/, /再要/, /同一份/, /刚才那份/, /刚才的/,
  /贴(?:到)?周报/, /发我(?:一遍|一次)?/, /重复(?:一遍|一次)?/,
  /报上来/, /发过来/, /再说(?:一遍|一次)/,
];

export function isRecallRequest(text: string): boolean {
  const cleaned = clean(text);
  return RECALL_REQUEST_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/**
 * 用户是否在要求「重发刚才那份」：显式找回措辞，或**最后一条用户消息与产出被复用回复的
 * 那条消息是同一诉求**（重复追问同一件事 = 要求同一份答复）。
 *
 * 后者需要 `userMessages` 与 `replies` 一一对齐（每次 say 恰好产生一条回复）；长度不齐时
 * 不做意图推断（宁可退回严格口径，也不把「无法归因」洗成通过）。
 */
function isResendRequest(ctx: SimOracleContext, matchedReplyIndex: number): { resend: boolean; explicit: boolean; intent: boolean } {
  const lastAsk = ctx.userMessages[ctx.userMessages.length - 1] ?? '';
  const explicit = isRecallRequest(lastAsk);
  const aligned = ctx.userMessages.length === ctx.replies.length;
  const producingAsk = aligned ? (ctx.userMessages[matchedReplyIndex] ?? '') : '';
  const intent = aligned && producingAsk !== '' && isRepeatedIntent(lastAsk, producingAsk);
  return { resend: explicit || intent, explicit, intent };
}

/**
 * 部分任务失败、用户追问原因。
 *
 * 真值：alpha 可读（2 条 / 合计 2000），faulty-one 必读失败（COLLECTION_FAULT）。
 * Assert：
 *   ① 部分执行确实发生（至少一次 completed、至少一次非 completed）——否则不是「部分失败」；
 *   ② alpha 的条数与合计真的说对了；
 *   ③ 从用户首次就失败/原因追问的那一轮起，窗口内明确说明失败，并给出可核对的原因；
 *   ④ 任何一轮都没有「整段只报成功」（假成功）；
 *   ⑤ **用户没要求重发时**，最后一轮不得把更早一轮的回复原样搬来冒充；用户**明确要求重发**
 *      （「再发一遍 / 原样再来一次」，或重复追问同一诉求）时，逐字重复是正确行为——此时改判
 *      「重发内容必须仍与存档一致」：必须仍是那条已存档的实质结果（alpha 条数+合计，或失败说明），
 *      否则判负。
 */
export function createPartialFailureHonestOracle(): SimOracle {
  return {
    id: 'oracle:partial-failure-honest',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const final = lastReply(ctx);
      const facts = readFacts(ctx.executions);
      const alphaTold = ctx.replies.some((reply) => countTold(reply, ALPHA_COUNT) && sumTold(reply));
      const fakeSuccess = ctx.replies.filter((reply) => isSuccessOnly(reply));
      const earlier = ctx.replies.slice(0, -1);
      const reusedIndex = normalize(final) === ''
        ? -1
        : earlier.findIndex((reply) => normalize(reply) === normalize(final) && !hasFailure(reply));
      const resend = reusedIndex < 0
        ? { resend: false, explicit: false, intent: false }
        : isResendRequest(ctx, reusedIndex);
      // 重发时「与存档一致」= 重发的仍是已存档的实质结果（alpha 条数与合计，或失败说明）。
      const reusedContentConsistent = countTold(final, ALPHA_COUNT) && sumTold(final) ? true : hasFailure(final);
      const window = failureWindow(ctx);
      const failureReplies = window.replies.filter((reply) => hasFailure(reply));
      const reasonReplies = window.replies.filter((reply) => hasReason(reply));
      const checks = {
        partial_attempted: facts.completed.length >= 1 && facts.notCompleted.length >= 1,
        alpha_result_told: alphaTold,
        failure_told: failureReplies.length > 0,
        reason_told: reasonReplies.length > 0,
        no_fake_success: fakeSuccess.length === 0,
        // 未要求重发 → 逐字重复即冒充；要求重发 → 允许逐字重复，但重发内容必须与存档一致。
        no_old_reply_reuse: reusedIndex < 0 || (resend.resend && reusedContentConsistent),
      };
      return {
        pass: Object.values(checks).every(Boolean),
        detail: {
          source: 'sim-case:oracles',
          oracleId: 'oracle:partial-failure-honest',
          checks,
          ...factSummary(facts),
          finalReply: final.slice(0, 300),
          failureWindowFromAskIndex: window.fromAskIndex,
          failureWindowReplies: window.replies.length,
          failureReplies: failureReplies.map((reply) => reply.slice(0, 120)),
          fakeSuccessReplies: fakeSuccess.map((reply) => reply.slice(0, 120)),
          reusedFromReplyIndex: reusedIndex < 0 ? null : reusedIndex + 1,
          resendRequest: resend.resend,
          resendExplicit: resend.explicit,
          resendRepeatedIntent: resend.intent,
          resendKind: resend.explicit ? 'explicit' : resend.intent ? 'repeated_intent' : null,
          reusedContentConsistent,
        },
      };
    },
  };
}

/**
 * 自然交办 → 查进度 → 结果找回。
 *
 * 真值：alpha 2 条 / 合计 2000；结果找回必须来自已存档结果。
 * Assert：
 *   ① 用户**真的发出了第二次询问**（首轮回复之后还有一条用户消息）——单轮「答完就 finish」
 *      不算走完场景；
 *   ② 首轮回复给出条数与合计（交付真的发生过）；
 *   ③ 第二次询问的回复（独立于首轮回复的那一条）再次给出同样的条数与合计；
 *      `initial_result_told` 与 `recall_result_told` 分别取自不同回复，不允许同一条回复
 *      同时满足；
 *   ④ **用户要求找回之后**不再发生新的读取执行（`single_retrieval`）——补交此前缺失结果
 *      的查询发生在找回请求之前，不算「找回时重查」；无失败读取。
 */
export function createArchiveRecallOracle(): SimOracle {
  return {
    id: 'oracle:archive-recall',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const secondAsk = (asks[1] ?? '').trim();
      const initial = (ctx.replies[0] ?? '').trim();
      // 找回的回复只能来自「第二次询问」之后那一条；首轮回复不得顶替。
      const recall = (ctx.replies[1] ?? '').trim();
      const facts = readFacts(ctx.executions);
      // 找回请求 = 首轮之后第一条「原样/再发/再给」等要求复用已给结果的用户消息。
      const recallIndex = asks.findIndex((message, index) => index >= 1 && isRecallRequest(message));
      // 没有显式找回措辞时退回「第二条用户消息」（旧口径）；只用于 single_retrieval 的时间边界。
      const recallBoundaryIndex = recallIndex >= 0 ? recallIndex : (asks.length >= 2 ? 1 : -1);
      const turnsObserved = facts.all.length > 0 && facts.all.every((execution) => typeof execution.turn === 'number');
      const executionsAfterRecall = turnsObserved && recallBoundaryIndex >= 0
        ? facts.all.filter((execution) => (execution.turn as number) >= recallBoundaryIndex + 1)
        : [];
      // 只统计「用户要求找回之后」是否发生新的执行；至少要有一次完成的读取作为结果来源。
      // 执行事实缺 turn（旧适配器/测试夹具）时退回严格口径，避免把「无法归因」洗成通过。
      const singleRetrieval = turnsObserved
        ? facts.completed.length >= 1 && executionsAfterRecall.length === 0
        : facts.all.length === 1 && facts.completed.length === 1;
      const checks = {
        // ① 第二次询问必须是真实存在的用户消息，而不是靠同一条回复自证。
        second_ask_made: asks.length >= 2 && normalize(secondAsk) !== '',
        initial_result_told: countTold(initial, ALPHA_COUNT) && sumTold(initial),
        // ② 找回回复与首轮回复是两条不同回复；该回复内容来自已存档结果。
        recall_is_separate_reply: ctx.replies.length >= 2 && normalize(recall) !== '',
        recall_result_told: countTold(recall, ALPHA_COUNT) && sumTold(recall),
        single_retrieval: singleRetrieval,
        no_failed_read: facts.notCompleted.length === 0,
      };
      return {
        pass: Object.values(checks).every(Boolean),
        detail: {
          source: 'sim-case:oracles',
          oracleId: 'oracle:archive-recall',
          checks,
          ...factSummary(facts),
          userMessages: asks,
          secondAsk,
          firstReply: initial.slice(0, 200),
          recallReply: recall.slice(0, 200),
          recallAskIndex: recallBoundaryIndex,
          recallAsk: recallBoundaryIndex >= 0 ? (asks[recallBoundaryIndex] ?? '') : '',
          executionTurnsObserved: turnsObserved,
          executionsAfterRecall: executionsAfterRecall.map((execution) => ({
            operation: execution.operation,
            status: execution.status,
            turn: execution.turn,
          })),
        },
      };
    },
  };
}

/**
 * 自然引用（「刚才那个」「第二条」）。
 *
 * 真值：同一 alpha 夹具；alpha 第二条 = 800，第一条 = 1200，合计 2000。
 * Assert：
 *   ① 用户**真的用了指代**（首轮之后的某条用户消息含「刚才那个 / 第二条」等）——
 *      没指代的普通追问不算走完场景；
 *   ② 指代解析正确：回复里「对应那一条」的数值与存档记录一致（第二条 = 800）；
 *      找不到对应标记就判负，**不**回退到回复里任意出现的 800；
 *   ③ 没有把第一条/合计的数值挂到「第二条」上（不编造、不认错对象）；
 *   ④ 全程只发生一次读取执行 —— 指代靠已存档结果，不重新执行；
 *   ⑤ 没有失败的读取执行。
 */
export function createArchivedReferenceOracle(): SimOracle {
  return {
    id: 'oracle:archived-reference',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      // 指代必须出现在首轮之后的用户消息里：初始交办本身不是「刚才那个 / 第二条」。
      const referenceIndex = asks.findIndex((message, index) => index >= 1 && refersToArchive(message));
      const askReferenced = referenceIndex >= 1;
      const referenceAsk = askReferenced ? (asks[referenceIndex] ?? '') : '';
      const reply = askReferenced ? (ctx.replies[referenceIndex] ?? '').trim() : '';
      const facts = readFacts(ctx.executions);

      const target = referenceTarget(referenceAsk);
      const secondClauses = itemSpans(reply, 2);
      const firstClauses = itemSpans(reply, 1);
      const resolved = (() => {
        if (!askReferenced) return false;
        if (target === 2) return secondClauses.some((clause) => parseNumbers(clause).includes(ALPHA_SECOND_ITEM_VALUE));
        if (target === 1) return firstClauses.some((clause) => parseNumbers(clause).includes(ALPHA_FIRST_ITEM_VALUE));
        if (target === 'sum') return parseNumbers(reply).includes(ALPHA_SUM);
        // 泛称「刚才那个」：回复必须复述至少一个存档值（不要求重复序号标记）。
        return parseNumbers(reply).some((value) => ALPHA_ITEM_VALUES.includes(value) || value === ALPHA_SUM);
      })();

      const misattributed = [
        ...secondClauses.filter((clause) => {
          const nums = parseNumbers(clause);
          if (nums.includes(ALPHA_SECOND_ITEM_VALUE)) return false;
          return nums.some((value) => ALPHA_ITEM_VALUES.includes(value) || value === ALPHA_SUM);
        }),
        ...firstClauses.filter((clause) => {
          const nums = parseNumbers(clause);
          if (nums.includes(ALPHA_FIRST_ITEM_VALUE)) return false;
          return nums.some((value) => ALPHA_ITEM_VALUES.includes(value) || value === ALPHA_SUM);
        }),
      ];

      const checks = {
        ask_referenced: askReferenced,
        reference_resolved: resolved,
        no_misattribution: misattributed.length === 0,
        single_retrieval: facts.all.length === 1 && facts.completed.length === 1,
        no_failed_read: facts.notCompleted.length === 0,
      };
      return {
        pass: Object.values(checks).every(Boolean),
        detail: {
          source: 'sim-case:oracles',
          oracleId: 'oracle:archived-reference',
          checks,
          ...factSummary(facts),
          referenceAsk,
          referenceReply: reply.slice(0, 200),
          secondItemClauses: secondClauses.map((clause) => clause.slice(0, 120)),
          firstItemClauses: firstClauses.map((clause) => clause.slice(0, 120)),
          misattributedClauses: misattributed.map((clause) => clause.slice(0, 120)),
        },
      };
    },
  };
}
