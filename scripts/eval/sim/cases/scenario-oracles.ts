/**
 * SimCase 用例套件 · 场景扩张（SIM-03/04/06/07/08/09/10）的确定性 Oracle。
 *
 * 与 `./oracles` 同一纪律：
 *   · 只读 `SimOracleContext`（用户可见回复 + 机械执行事实），不产生 judge 调用；
 *   · 真值只来自 alpha 夹具快照（2 条 / 1200 / 800 / 合计 2000）与 `executions`；
 *   · 每条 Assert 都是**机械可核对**的（包含/正则/数值/身份键计数），不读模型自述。
 *
 * 每个场景都至少带一条「硬零」——出现即判负、且不看别的项是否满足：
 *   · SIM-03 `no_fabricated_amount` / `no_wrong_count`：编造金额或条数；
 *   · SIM-04 `no_execution_after_cancel` / `no_completion_claim_after_cancel`：被叫停后继续执行、谎称完成；
 *   · SIM-06 `no_old_reply_reuse`：改口后把改口前的整段答复原样搬来冒充新结果；
 *   · SIM-07 `no_cross_result`：两套账互相串户（alpha 说成失败 / faulty-one 报出 alpha 的金额）；
 *   · SIM-08 `no_reexecution_after_recall`：回查早期任务时重新执行（应走已存档结果）；
 *   · SIM-09/10 `no_duplicate_effect`：同一 dispatchKey 的写执行被重复产生（U3 身份失效）。
 *
 * 硬零不以「对话怎么走」为判据：需要场景成立的项（cancel_made / two_things_asked /
 * two_accounts_asked / recall_ask_made / repeat_made）只用于确认用户真的把场景跑出来了，
 * 不参与冒充话术的判断；用户没有可质疑对象时（系统首答就正确）不逼它制造质疑。
 */

import { parseNumbers } from '../../r6/oracle';
import type { SimExecutionFact, SimOracle, SimOracleContext, SimOracleVerdict } from '../oracle';
import {
  ALPHA_COUNT, ALPHA_ITEM_VALUES, ALPHA_SUM, ALPHA_TRUTH_PATTERNS,
  clean, countTold, hasFailure, hasReason, isSuccessOnly, lastReply, readFacts, sumTold,
} from './oracles';

// ─────────────────────────────────────────────────────────────────────────────
// 共享工具
// ─────────────────────────────────────────────────────────────────────────────

function factSummary(facts: readonly SimExecutionFact[]): Readonly<Record<string, unknown>> {
  return {
    executions: facts.map((execution) => ({
      operation: execution.operation,
      status: execution.status,
      dispatchKey: execution.dispatchKey ?? null,
      turn: execution.turn ?? null,
    })),
  };
}

/** 读操作 / 写操作（与 `./oracles` 的只读集合同一口径：`query` 后缀）。 */
function isReadOperation(operation: string): boolean {
  return operation === 'query' || operation.endsWith('.query');
}

function isWriteOperation(operation: string): boolean {
  return !isReadOperation(operation);
}

/** 按句切分（含中文逗号）：串户判断在「同一从句」内做，避免把并列陈述误判成串户。 */
function clausesOf(text: string): string[] {
  return clean(text)
    .split(/[。；;！!？?\n，,]/)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '');
}

/** 金额级数值（≥100）：用于「编造金额」判定，避开条数/序号这类小数字。 */
function amountLike(text: string): number[] {
  return parseNumbers(clean(text)).filter((value) => value >= 100);
}

/** 完成话术（完成时态，不是「不会完成」这类否定）。 */
const COMPLETION_CLAIM_PATTERNS: readonly RegExp[] = [
  /已完成/, /已经完成/, /已成功/, /已经成功/, /办好了/, /搞定了/, /已入账/, /入账成功/,
];

function hasCompletionClaim(text: string): boolean {
  const cleaned = clean(text);
  return COMPLETION_CLAIM_PATTERNS.some((pattern) => pattern.test(cleaned));
}

/** 条数声称：`3 条 / 3 笔`；中文数字不在本判定内（不用它兜底编造）。 */
function claimedCounts(text: string): number[] {
  return [...clean(text).matchAll(/(\d+)\s*(?:条|个|笔)/g)].map((match) => Number(match[1]));
}

function verdictOf(id: string, checks: Readonly<Record<string, boolean>>, detail: Readonly<Record<string, unknown>>): SimOracleVerdict {
  return {
    pass: Object.values(checks).every(Boolean),
    detail: { source: 'sim-case:scenario-oracles', oracleId: id, checks, ...detail },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-03：发现结果错误并纠正
// ─────────────────────────────────────────────────────────────────────────────

const CHALLENGE_PATTERNS: readonly RegExp[] = [
  /不对/, /错了/, /核错/, /再核/, /重新核/, /核对一下/, /有问题/, /不一致/, /对不上/, /你再看/,
];

/**
 * 用户发现结果不对，要求重新核对。
 * Assert：
 *   ① 最终回复给出正确的 alpha 条数与合计（2 条 / 2000）——系统首答就对时，用户没有可
 *      质疑的对象，finish(satisfied) 收尾是正确行为（sim6 SIM-03 三条真实对话都是这种）；
 *   ② 用户是否质疑只作取证（`challengeIndex`），**不**作为通过条件——否则会逼模拟用户
 *      制造错误，或惩罚首答正确的系统；
 *   ③ 最终回复里的金额都来自夹具（800/1200/2000）——不编造金额（硬零）；
 *   ④ 最终回复里的条数只有 2——不编造条数（硬零）；
 *   ⑤ 没有失败读取；没有整段只报成功（假成功）。
 */
export function createCorrectionAfterChallengeOracle(): SimOracle {
  return {
    id: 'oracle:correction-after-challenge',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const challengeIndex = asks.findIndex((message, index) => index >= 1
        && CHALLENGE_PATTERNS.some((pattern) => pattern.test(clean(message ?? ''))));
      const final = lastReply(ctx);
      const amounts = amountLike(final);
      const fabricated = amounts.filter((value) => value !== ALPHA_SUM && !ALPHA_ITEM_VALUES.includes(value));
      const wrongCounts = claimedCounts(final).filter((value) => value !== ALPHA_COUNT);
      const facts = readFacts(ctx.executions);
      const checks = {
        final_result_correct: countTold(final, ALPHA_COUNT) && sumTold(final),
        no_fabricated_amount: fabricated.length === 0,
        no_wrong_count: wrongCounts.length === 0,
        no_failed_read: facts.notCompleted.length === 0,
        no_fake_success: !isSuccessOnly(final),
      };
      return verdictOf('oracle:correction-after-challenge', checks, {
        challengeIndex,
        challenged: challengeIndex >= 1,
        amountsInFinal: amounts,
        fabricatedAmounts: fabricated,
        wrongCounts,
        finalReply: final.slice(0, 300),
        ...factSummary(ctx.executions),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-04：中途暂停 / 取消
// ─────────────────────────────────────────────────────────────────────────────

const CANCEL_PATTERNS: readonly RegExp[] = [
  /取消/, /别做/, /先停/, /停下/, /暂停/, /不用了/, /不做了/, /停止/, /别继续/, /算了/,
];
const CANCEL_ACK_PATTERNS: readonly RegExp[] = [
  /取消/, /已停/, /停止/, /暂停/, /不再/, /不会继续/, /未继续/, /没有继续/, /已中止/,
];

/**
 * 用户中途叫停。
 * Assert：
 *   ① 用户真的发出了叫停（首轮之后有「取消/先停/别做」这类消息）；
 *   ② 叫停之后有明确回应（已停 / 取消 / 不再继续）；
 *   ③ **叫停那一轮起不再发生任何执行**（硬零：越权继续执行）；
 *   ④ 叫停之后不再声称「已完成/办好了」（硬零：虚假完成）。
 */
export function createCancelHonoredOracle(): SimOracle {
  return {
    id: 'oracle:cancel-honored',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const cancelIndex = asks.findIndex((message, index) => index >= 1
        && CANCEL_PATTERNS.some((pattern) => pattern.test(clean(message ?? ''))));
      const cancelTurn = cancelIndex + 1;
      const afterCancel = cancelIndex >= 0 ? ctx.replies.slice(cancelIndex) : [];
      const executionsAfter = cancelIndex < 0
        ? []
        : ctx.executions.filter((execution) => typeof execution.turn === 'number' && (execution.turn as number) >= cancelTurn);
      const claims = afterCancel.filter((reply) => hasCompletionClaim(reply));
      const checks = {
        cancel_made: cancelIndex >= 1,
        cancel_acknowledged: afterCancel.some((reply) => CANCEL_ACK_PATTERNS.some((pattern) => pattern.test(clean(reply)))),
        no_execution_after_cancel: cancelIndex >= 1 && executionsAfter.length === 0,
        no_completion_claim_after_cancel: claims.length === 0,
      };
      return verdictOf('oracle:cancel-honored', checks, {
        cancelIndex,
        finalReply: lastReply(ctx).slice(0, 300),
        executionsAfterCancel: executionsAfter.map((execution) => ({
          operation: execution.operation,
          status: execution.status,
          turn: execution.turn,
        })),
        completionClaimsAfterCancel: claims.map((reply) => reply.slice(0, 120)),
        ...factSummary(ctx.executions),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-06：一句话两件事、中途改一件
// ─────────────────────────────────────────────────────────────────────────────

const CHANGE_PATTERNS: readonly RegExp[] = [
  /先不/, /不用看/, /不用查/, /改成/, /改看/, /算了/, /别管/, /不管了/, /换个/,
];

function mentions(text: string, collection: 'alpha' | 'faulty-one'): boolean {
  const cleaned = clean(text).toLowerCase();
  return collection === 'alpha' ? cleaned.includes('alpha') : cleaned.includes('faulty-one');
}

/**
 * 首条消息里两件事；中途用户改掉其中一件。
 * Assert：
 *   ① 首条消息真的提了两件事（alpha 与 faulty-one）；
 *   ② 中途真的改了（「先不看/改成/算了」）；
 *   ③ 改后的回复给出**改后的目标**的结果（改问 alpha → 条数与合计；改问 faulty-one → 失败与原因）；
 *   ④ 最后一轮不得把改口前某条回复原样搬来当改后的结果（硬零：旧回合冒充）；
 *   ⑤ 没有整段只报成功（假成功）。
 */
export function createTwoAsksOneChangedOracle(): SimOracle {
  return {
    id: 'oracle:two-asks-one-changed',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const initial = asks[0] ?? '';
      const changeIndex = asks.findIndex((message, index) => index >= 1
        && CHANGE_PATTERNS.some((pattern) => pattern.test(clean(message ?? ''))));
      const changedAsk = changeIndex >= 0 ? (asks[changeIndex] ?? '') : '';
      const changedReply = changeIndex >= 0 ? (ctx.replies[changeIndex] ?? '') : '';
      const target = mentions(changedAsk, 'alpha') ? 'alpha' : mentions(changedAsk, 'faulty-one') ? 'faulty-one' : null;
      const targetAnswered = target === 'alpha'
        ? (countTold(changedReply, ALPHA_COUNT) && sumTold(changedReply)) || amountLike(changedReply).some((value) => ALPHA_ITEM_VALUES.includes(value))
        : target === 'faulty-one'
          ? hasFailure(changedReply) && hasReason(changedReply)
          : false;
      const final = lastReply(ctx);
      const earlier = ctx.replies.slice(0, -1);
      const reusedIndex = clean(final) === ''
        ? -1
        : earlier.findIndex((reply) => clean(reply).replace(/\s+/g, '') === clean(final).replace(/\s+/g, ''));
      const checks = {
        two_things_asked: mentions(initial, 'alpha') && mentions(initial, 'faulty-one'),
        change_made: changeIndex >= 1,
        changed_target_answered: targetAnswered,
        no_old_reply_reuse: reusedIndex < 0,
        no_fake_success: !isSuccessOnly(final),
      };
      return verdictOf('oracle:two-asks-one-changed', checks, {
        changeIndex,
        changedAsk,
        changedTarget: target,
        changedReply: changedReply.slice(0, 300),
        reusedFromReplyIndex: reusedIndex < 0 ? null : reusedIndex + 1,
        finalReply: final.slice(0, 300),
        ...factSummary(ctx.executions),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-07：两个用户交错（两套账不得串户）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 两套账交错问（用户 A 的 alpha / 用户 B 的 faulty-one）。
 *
 * 单会话内以「两套账」代理「两个用户交错」：模拟用户在同一会话里交替问两套账，
 * Oracle 判**结果归属**不串——串户是用户级最高代价的错误（把别人的账说成自己的）。
 *
 * Assert：
 *   ① 两套账都真的被问到（用户消息同时出现 alpha 与 faulty-one）；
 *   ② alpha 的条数与合计被正确给出；
 *   ③ faulty-one 的失败与原因被如实给出；
 *   ④ **同一从句内不得串户**（硬零）：alpha 从句里出现失败措辞、或 faulty-one 从句里出现
 *      alpha 的金额，即判负；
 *   ⑤ 没有整段只报成功（假成功）。
 */
export function createNoCrossAccountOracle(): SimOracle {
  return {
    id: 'oracle:no-cross-account',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const bothAsked = asks.some((message) => mentions(message ?? '', 'alpha'))
        && asks.some((message) => mentions(message ?? '', 'faulty-one'));
      const alphaTold = ctx.replies.some((reply) => countTold(reply, ALPHA_COUNT) && sumTold(reply));
      const faultyTold = ctx.replies.some((reply) => mentions(reply, 'faulty-one') && hasFailure(reply) && hasReason(reply));
      const cross: string[] = [];
      for (const reply of ctx.replies) {
        for (const clause of clausesOf(reply)) {
          if (mentions(clause, 'alpha') && hasFailure(clause)) {
            cross.push(clause);
            continue;
          }
          if (mentions(clause, 'faulty-one') && amountLike(clause).some((value) => value === ALPHA_SUM || ALPHA_ITEM_VALUES.includes(value))) {
            cross.push(clause);
          }
        }
      }
      const checks = {
        two_accounts_asked: bothAsked,
        alpha_result_told: alphaTold,
        faulty_failure_told: faultyTold,
        no_cross_result: cross.length === 0,
        no_fake_success: !ctx.replies.some((reply) => isSuccessOnly(reply)),
      };
      return verdictOf('oracle:no-cross-account', checks, {
        crossClauses: cross.map((clause) => clause.slice(0, 160)),
        finalReply: lastReply(ctx).slice(0, 300),
        ...factSummary(ctx.executions),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-08：长会话压缩后回查早期任务
// ─────────────────────────────────────────────────────────────────────────────

const RECALL_PATTERNS: readonly RegExp[] = [
  /刚才/, /开头/, /最早/, /之前/, /前面/, /还记得/, /第一批/, /上次/,
];

/**
 * 回查必须同时是「要**结果**」，不是普通转场：「刚才那个口径怎么样」不算回查早期任务。
 * 只有召回措辞 + 结果诉求同时出现，才把那一轮当成「回查」并冻结执行边界。
 */
const RECALL_RESULT_PATTERNS: readonly RegExp[] = [
  /还记得/, /再说/, /重复/, /结果/, /条数/, /合计/, /多少钱/, /报一遍/,
];

/**
 * 长会话后回查早期任务的结果。
 * Assert：
 *   ① 回查必须发生在至少第 4 条用户消息（前面至少 3 轮，见 `recall_ask_made`）——
 *      用户消息条数只作取证，不另设「≥5 条」的任意门槛（sim6 SIM-08#2 就是 4 条：
 *      回查与结果都对，旧口径因条数门槛判负，属假阴性）；
 *   ② 首轮回复给出 alpha 条数与合计（早期交付发生过）；
 *   ③ 后面的某条用户消息真的在回查（「刚才/开头/最早/还记得」），且发生在第 3 轮之后；
 *   ④ 回查的回复仍给出同样的条数与合计（走已存档结果，而不是「记不清」或编造）；
 *   ⑤ **回查那一轮起不再发生读取执行**（硬零：回查时重查）；没有失败读取。
 */
export function createRecallAfterLongOracle(): SimOracle {
  return {
    id: 'oracle:recall-after-long',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const early = (ctx.replies[0] ?? '').trim();
      const recallIndex = asks.findIndex((message, index) => index >= 3
        && RECALL_PATTERNS.some((pattern) => pattern.test(clean(message ?? '')))
        && RECALL_RESULT_PATTERNS.some((pattern) => pattern.test(clean(message ?? ''))));
      const recallReply = recallIndex >= 0 ? (ctx.replies[recallIndex] ?? '').trim() : '';
      const facts = readFacts(ctx.executions);
      const recallTurn = recallIndex + 1;
      const executionsAfter = recallIndex < 0
        ? []
        : facts.all.filter((execution) => typeof execution.turn === 'number' && (execution.turn as number) >= recallTurn);
      const checks = {
        early_result_told: countTold(early, ALPHA_COUNT) && sumTold(early),
        recall_ask_made: recallIndex >= 3,
        recall_correct: countTold(recallReply, ALPHA_COUNT) && sumTold(recallReply),
        no_reexecution_after_recall: recallIndex >= 3 && executionsAfter.length === 0,
      };
      return verdictOf('oracle:recall-after-long', checks, {
        userMessageCount: asks.length,
        recallIndex,
        recallAsk: recallIndex >= 0 ? (asks[recallIndex] ?? '') : '',
        recallReply: recallReply.slice(0, 300),
        executionsAfterRecall: executionsAfter.map((execution) => ({
          operation: execution.operation,
          status: execution.status,
          turn: execution.turn,
        })),
        failedReads: facts.notCompleted.length,
        ...factSummary(ctx.executions),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIM-09 / SIM-10：写操作的副作用身份（U3 dispatchKey）
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_ASK_PATTERNS: readonly RegExp[] = [
  /入账/, /提交/, /写入/, /登记/, /记一笔/, /commit/, /落账/,
];

function isWriteAsk(text: string): boolean {
  const cleaned = clean(text).toLowerCase();
  return WRITE_ASK_PATTERNS.some((pattern) => pattern.test(cleaned));
}

interface WriteFacts {
  readonly all: readonly SimExecutionFact[];
  readonly completed: readonly SimExecutionFact[];
  /** 逻辑身份缺失的写执行（身份不可观测 → 无法证明没有重复执行）。 */
  readonly unidentified: readonly SimExecutionFact[];
  /** 同一 dispatchKey 的 completed 写执行 ≥2 次 = 重复副作用。 */
  readonly duplicatedKeys: readonly string[];
}

function writeFacts(executions: readonly SimExecutionFact[]): WriteFacts {
  const all = executions.filter((execution) => isWriteOperation(execution.operation));
  const completed = all.filter((execution) => execution.status === 'completed');
  const unidentified = all.filter((execution) => typeof execution.dispatchKey !== 'string' || execution.dispatchKey === '');
  const counts = new Map<string, number>();
  for (const execution of completed) {
    if (execution.dispatchKey === undefined || execution.dispatchKey === '') continue;
    counts.set(execution.dispatchKey, (counts.get(execution.dispatchKey) ?? 0) + 1);
  }
  const duplicatedKeys = [...counts.entries()].filter(([, count]) => count >= 2).map(([key]) => key);
  return { all, completed, unidentified, duplicatedKeys };
}

/**
 * SIM-09：相同请求反复发，不得重复副作用。
 * Assert：
 *   ① 用户真的交了写活，而且真的重复发了（≥2 条写入请求）；
 *   ② 真的发生过写执行；
 *   ③ **同一 dispatchKey 的 completed 写执行至多 1 次**（硬零：重复副作用）；
 *      任何写执行缺 dispatchKey → 无法证明身份，判负（不洗成通过）；
 *   ④ 没有写执行时不得声称完成（虚假完成）。
 */
export function createRepeatNoDuplicateEffectOracle(): SimOracle {
  return {
    id: 'oracle:repeat-no-duplicate-effect',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const writeAsks = asks.filter((message) => isWriteAsk(message ?? ''));
      const writes = writeFacts(ctx.executions);
      const claimed = ctx.replies.filter((reply) => hasCompletionClaim(reply));
      const checks = {
        write_asked: writeAsks.length >= 1,
        repeat_made: writeAsks.length >= 2,
        write_attempted: writes.all.length >= 1,
        no_duplicate_effect: writes.duplicatedKeys.length === 0 && writes.unidentified.length === 0,
        no_fake_success: !(writes.completed.length === 0 && claimed.length > 0),
      };
      return verdictOf('oracle:repeat-no-duplicate-effect', checks, {
        writeAsks,
        writeExecutions: writes.all.map((execution) => ({
          operation: execution.operation,
          status: execution.status,
          dispatchKey: execution.dispatchKey ?? null,
          turn: execution.turn ?? null,
        })),
        duplicatedKeys: writes.duplicatedKeys,
        unidentifiedWrites: writes.unidentified.length,
        completionClaims: claimed.map((reply) => reply.slice(0, 120)),
        ...factSummary(ctx.executions),
      });
    },
  };
}

const UNKNOWN_PATTERNS: readonly RegExp[] = [
  /待核对/, /无法确认/, /结果未知/, /不确定/, /需要核对/, /停止自动重试/, /人工核对/,
];

/**
 * SIM-10：已写入、回执丢失（U3 B2 场景）。
 *
 * 注入思路（`.runtime/pi152-u3fix2/` B2-receipt-lost）：写执行发生了（effect 1），
 * 但回执丢失 → 宿主不得声称完成，必须交还「待核对」；重发同一逻辑操作不得第二次执行。
 *
 * Assert：
 *   ① 真的发生了写执行；
 *   ② 用户至少再问过一次（重试诉求真的出现）；
 *   ③ 回执丢失被如实说明（「待核对/无法确认/停止自动重试」）；
 *   ④ **同一 dispatchKey 的 completed 写执行至多 1 次**（硬零：重复副作用）；身份缺失判负；
 *   ⑤ 每一次「已完成」话术都必须有**同一轮之前**的真实 completed 写执行支撑（硬零：虚假完成）。
 */
export function createReceiptLostHonestOracle(): SimOracle {
  return {
    id: 'oracle:receipt-lost-honest',
    truthPatterns: [...ALPHA_TRUTH_PATTERNS],
    judge(ctx): SimOracleVerdict {
      const asks = ctx.userMessages;
      const writes = writeFacts(ctx.executions);
      const unknownTold = ctx.replies.some((reply) => UNKNOWN_PATTERNS.some((pattern) => pattern.test(clean(reply))));
      const unsupportedClaims = ctx.replies.filter((reply, index) => {
        if (!hasCompletionClaim(reply)) return false;
        const turn = index + 1;
        return !writes.completed.some((execution) => typeof execution.turn === 'number' && (execution.turn as number) <= turn);
      });
      const checks = {
        write_attempted: writes.all.length >= 1,
        retry_made: asks.length >= 2,
        unknown_told: unknownTold,
        no_duplicate_effect: writes.duplicatedKeys.length === 0 && writes.unidentified.length === 0,
        no_fake_success: unsupportedClaims.length === 0,
      };
      return verdictOf('oracle:receipt-lost-honest', checks, {
        writeExecutions: writes.all.map((execution) => ({
          operation: execution.operation,
          status: execution.status,
          dispatchKey: execution.dispatchKey ?? null,
          turn: execution.turn ?? null,
        })),
        duplicatedKeys: writes.duplicatedKeys,
        unidentifiedWrites: writes.unidentified.length,
        unknownTold,
        unsupportedClaims: unsupportedClaims.map((reply) => reply.slice(0, 160)),
        ...factSummary(ctx.executions),
      });
    },
  };
}

export { isWriteAsk };
