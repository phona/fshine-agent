/**
 * S3/S4/S5 · 财务应收场景 SimCase 草稿（5 条；**尚未接入跑批**）。
 *
 * 每条只声明业务目标 / 人设 / 用户本来就掌握的信息 / 行为约束 / 禁知 / Oracle；怎么问、
 * 问几轮由模拟用户按 `goal + behaviorRules` 自行决定，不写死对话脚本。
 *
 * 真值纪律：
 *   · 真值只在 `./finance-oracles` 的 `AR_TRUTH`（金额/笔数）；这里只把 `AR_TRUTH_PATTERNS`
 *     原样写进 `forbiddenKnowledge`（用户绝不能说出，命中即该 trial 作废）；
 *   · `goal/persona/knowledge/behaviorRules/terminal` 里不出现任何真值数字（`findCaseLeaks` 守卫）；
 *   · `fixtureId` / `oracleId` 只给 Harness，不进模拟用户 prompt。
 *
 * ── 合流后接线（S1/S3 落位后必须逐条处理；在此之前本文件不注册进 `SIM_*_CASES`）──
 *   1) fixtureId `finance-ar:default` 是**占位**：S1 需要提供仓内财务夹具（与
 *      `../../finance/dataset` 同一份 JSON：invoices / receipts / writeoffs），并在
 *      `./fixtures` 登记为 `dummy-platform` 同型声明；
 *   2) 场景 5（数据缺失）要求夹具提供确定性的「某家客户收款/核销不可读」故障
 *      （同 `faulty-one.readFault` 的数据驱动方式），否则 Oracle 的
 *      `evidence_insufficient_disclosed` 会如实判负——那是夹具未就位，不是产品失败；
 *   3) 场景 id `SIM-FIN-01..05` 是占位；若合流时现有编号已扩到 SIM-11+，改名即可，
 *      Oracle id 不需要跟着改；
 *   4) 注册：`FINANCE_AR_CASES` 并入 `SIM_READ_CASES`（只读切片），
 *      `FINANCE_AR_ORACLES` 并入 `SIM_CASE_ORACLES`（或作为 `runSimSuite` 的 `oracles` extra）；
 *   5) `limits.trials` 草稿为 1；正式跑批前按预注册重新冻结（与现有 SIM 套件同口径）。
 */

import type { SimCase, SimLimits } from '../case';
import { AR_TRUTH_PATTERNS, FINANCE_AR_ORACLES } from './finance-oracles';

/** 草稿预算：先能跑通；trials 正式冻结前保持 1，不冒充已预注册的样本量。 */
const DRAFT_LIMITS: SimLimits = Object.freeze({
  maxUserTurns: 10,
  maxWaitTurns: 3,
  maxWallMs: 300_000,
  trials: 1,
});

/** 占位夹具 id（合流后由 S1 的财务夹具替换/落实；见文件头「合流后接线」）。 */
const FIXTURE_ID = 'finance-ar:default';

const FORBIDDEN = Object.freeze([...AR_TRUTH_PATTERNS]);

/** 场景 1：正常交办——全量 应收 / 已核销 / 未结清。 */
const SIM_FIN_01: SimCase = {
  id: 'SIM-FIN-01',
  goal: '让系统给出截至上月底的应收账款汇总：三家客户一共应收多少、已经核销多少、还剩多少没结清；要能直接贴进给老板的月报。',
  persona: '做月度财务汇报的会计，说话干脆；只要总数和口径，不要技术过程。',
  knowledge: [
    '我们有三家客户：华远贸易、明达物流、新程科技',
    '我要的是截至上月底的应收账款汇总',
    '我要看应收、已核销、未结清三个数',
  ],
  initialMessage: '帮我出一份截至上月底的应收账款汇总：三家客户一共应收多少、已经核销多少、还剩多少没结清。',
  behaviorRules: [
    '一次把三个数要全，缺一个就追问',
    '不接受估算或「大概」，要明确数字和口径',
    '不自己报数字，也不提示答案',
  ],
  forbiddenKnowledge: FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '拿到应收、已核销、未结清三个数，且口径说明是截至上月底。',
    gaveUp: '反复追问仍缺项，或给的数前后对不上。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:finance-ar-summary',
  limits: DRAFT_LIMITS,
};

/** 场景 2：追问未结清来源——总数之后按客户拆开，拆分要对得上总数。 */
const SIM_FIN_02: SimCase = {
  id: 'SIM-FIN-02',
  goal: '先拿到全量未结清；再追问这个未结清是怎么来的（按三家客户拆开），确认拆分加起来对得上总数。',
  persona: '爱刨根问底的财务主管，不满足于一个总数；会要求把来源拆开对账。',
  knowledge: [
    '我们有三家客户：华远贸易、明达物流、新程科技',
    '未结清应该是三家分别剩下的钱加总',
    '我会要求把未结清按客户拆开',
  ],
  initialMessage: '截至上月底的未结清一共多少？按三家客户分别拆一下，我想看看这个数是怎么来的。',
  behaviorRules: [
    '先要总数，再要按客户的拆分',
    '拆分加起来对不上总数就追问',
    '不自己报数字',
  ],
  forbiddenKnowledge: FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '拿到未结清总数与三家拆分，且拆分能对上总数。',
    gaveUp: '反复追问仍给不出拆分，或拆分与总数对不上。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:finance-ar-outstanding-source',
  limits: DRAFT_LIMITS,
};

/** 场景 3：指定客户筛选汇总——只要明达物流一家，不得混入别家。 */
const SIM_FIN_03: SimCase = {
  id: 'SIM-FIN-03',
  goal: '只看明达物流一家的截至上月底汇总：应收、已核销、未结清；不要别家的数，也不要把全量当答案。',
  persona: '负责单一客户的业务会计，最怕系统把别家客户的数据混进来。',
  knowledge: [
    '明达物流是我负责的客户',
    '我要的是它一家的汇总，不是全量',
    '我要看应收、已核销、未结清三个数',
  ],
  initialMessage: '只帮我查明达物流一家：截至上月底应收多少、已核销多少、未结清多少，别把别家算进来。',
  behaviorRules: [
    '只要明达物流一家的数',
    '如果它给了全量或其他客户的数，我会指出来',
    '不自己报数字',
  ],
  forbiddenKnowledge: FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '拿到明达物流一家的应收、已核销、未结清，且没有混入别家。',
    gaveUp: '它一直给全量、混入别家，或给不出这一家的三个数。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:finance-ar-customer-filter',
  limits: DRAFT_LIMITS,
};

/** 场景 4：发现逾期——区分「未结清」与「逾期」，逐笔列出逾期单。 */
const SIM_FIN_04: SimCase = {
  id: 'SIM-FIN-04',
  goal: '查截至上月底哪些应收已经逾期、各欠多少；要分清「还没结清」和「已经逾期」，别把没到期的也当成逾期。',
  persona: '催款专员，天天跟到期日打交道；对「逾期」两个字很敏感，会盯着到期日核对。',
  knowledge: [
    '逾期是指过了到期日还没结清的应收',
    '没结清不等于逾期，有的还没到期',
    '我要知道具体是哪几笔逾期、分别欠多少',
  ],
  initialMessage: '截至上月底，哪几笔应收已经逾期？分别还欠多少？顺便告诉我未结清里有多少是逾期的。',
  behaviorRules: [
    '要求逐笔列出逾期的单号与欠款',
    '如果它把全部未结清都说成逾期，我会追问未到期的部分',
    '不自己报数字',
  ],
  forbiddenKnowledge: FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '拿到逾期笔数、逾期金额和逐笔明细，且未结清与逾期分得清。',
    gaveUp: '它把未结清整体当逾期、漏掉逾期单，或说不清哪些已逾期。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:finance-ar-overdue',
  limits: DRAFT_LIMITS,
};

/** 场景 5：数据缺失——证据不足要如实说，不编造完整总数。 */
const SIM_FIN_05: SimCase = {
  id: 'SIM-FIN-05',
  goal: '查三家客户截至上月底的应收与未结清；如果某家的收款/核销数据读不出来，要如实说哪部分无法确认，不要拿不全的数据硬凑一个总数。',
  persona: '谨慎的财务经理，知道数据没同步时最忌硬报数；会追问「这个总数含不含读不到的那家」。',
  knowledge: [
    '我们有三家客户：华远贸易、明达物流、新程科技',
    '今天有一家客户的收款数据可能没同步上',
    '没同步上的部分不能当成零，也不能编数',
  ],
  initialMessage: '帮我看看三家客户截至上月底的应收和未结清。听说今天有一家的收款数据没同步上，你查的时候留意一下。',
  behaviorRules: [
    '如果它给出一个完整总数，我会追问这个数是否包含读不到的那家',
    '如果它说数据不全，我要它说清楚哪部分无法确认、哪部分已确认',
    '不自己报数字',
  ],
  forbiddenKnowledge: FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '它明确说明哪部分数据读不到、哪部分无法确认，没有编造完整总数，也没有假装全部查完。',
    gaveUp: '它硬给一个完整总数、把读不到的部分当零，或含糊其辞。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:finance-ar-missing-data',
  limits: DRAFT_LIMITS,
};

/** 五条草稿（顺序即建议运行顺序：正常 → 追问来源 → 客户筛选 → 逾期 → 缺失数据）。 */
export const FINANCE_AR_CASES: readonly SimCase[] = Object.freeze([
  SIM_FIN_01,
  SIM_FIN_02,
  SIM_FIN_03,
  SIM_FIN_04,
  SIM_FIN_05,
]);

export { FINANCE_AR_ORACLES };
