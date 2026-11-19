/**
 * 交互性质场景（INT）· 用户级样本。
 *
 * 定位：这批用例只测「像不像一个真助理」里**脚本化模型判不了**的那几条交互面——
 * 模糊指代的范围澄清、确定性失败之后的下一步、慢活期间插话、跨会话不泄露。
 * 每条只声明业务目标 / 人设 / 用户本来就掌握的信息 / 行为约束 / 禁知 / Oracle；
 * 怎么问、问几轮由模拟用户按 `goal + behaviorRules` 自行决定，**不写死对话脚本**。
 *
 * 可达性登记（诚实，不冒充）：
 *   · `SIM_INTERACTION_CASES`（SIM-INT-01/02）= 当前**回合制单会话** harness 可在真实装配上跑；
 *   · `SIM_INTERACTION_BLOCKED_CASES`（SIM-INT-03/04）= 需要 harness 具备异步受理/后台投递
 *     （慢活期间插话）或跨会话渠道（单聊 vs 群聊）才能表达——现有 harness 表达不了，因此
 *     **不在跑批里运行**，只登记用例与判据（blockedBy 逐条写明缺什么）。把不可达项混进跑批
 *     冒充读数，属于假证据。
 *
 * 真值纪律：
 *   · 真值（documents 的 3 条 / 合计 2900 / 明细 1200、800、900）只登记在 Oracle 的
 *     `truthPatterns`，并写进 `forbiddenKnowledge`（用户绝不能说出，命中即该 trial 作废）；
 *   · 判官（模型）只在 Harness 侧运行，其输入/输出不进模拟用户 prompt；
 *   · `fixtureId` / `oracleId` 只给 Harness，不进模拟用户 prompt（`findPromptLeaks` 守卫）。
 */

import type { SimCase, SimLimits } from '../case';

/** 预注册预算（与现有 SIM 读用例同口径：每用例 3 trials = N=3）。 */
const LIMITS: SimLimits = Object.freeze({
  maxUserTurns: 10,
  maxWaitTurns: 3,
  maxWallMs: 300_000,
  trials: 3,
});

/** 夹具：documents / denied-one 都在缺省平台场景 `dummy-finance` 里（见 `./fixtures`）。 */
const FIXTURE_ID = 'dummy-platform:interaction';

/** documents 真值（同时作为污染检测的禁知）：条数、合计、两条明细值。 */
const DOCUMENTS_FORBIDDEN: readonly string[] = Object.freeze(['2900', '1200', '800', '900', '3条']);

/**
 * INT-01：模糊指代——先给明确窗口，再口语追加一个范围。
 *
 * 已知事实（`dummy-routing` 技能 + 夹具）：documents 两窗口返回同一批 items（3 条，合计 2900）；
 * 口语映射 上个月=W202610、本月=W202611。判据焦点不是数据（两窗口数据相同），而是**系统会
 * 不会把追加的范围问清楚/说明白**，还是闷头按一个没说明的窗口交差。
 */
const SIM_INT_01: SimCase = {
  id: 'SIM-INT-01',
  goal: '让系统查 documents 里 W202611 这批有多少条、合计多少；拿到结果后，用口语追加一句「那上个月的也一起看一下」。我要看它是把追加的范围问清楚（或明确说明它按哪个窗口查），还是闷头按一个没说明的窗口就把数给我。',
  persona: '说话随口的业务同事，习惯用「上个月」「那批」这种口语指代，不爱重复窗口代码；对「它到底按哪个口径算的」很在意。',
  knowledge: [
    '我平时说的「单据/记录」就是 documents 那个集合',
    '我第一句会给一个明确的窗口代码',
    '我第二句只会用口语追加一个范围，不会再把窗口代码报出来',
    '我要看它到底是问清楚，还是自己猜一个窗口',
  ],
  initialMessage: '帮我查下 documents 里 W202611 这批有多少条、合计多少。',
  behaviorRules: [
    '第一句按上面那条发出',
    '拿到回复后紧接着用口语追加一句：「那上个月的也一起看一下」——不要说出任何窗口代码',
    '如果它没交代用的是哪个窗口就给了数，下一句就质疑它到底按哪个窗口算的',
    '我自己不报任何数字，也不提示答案',
  ],
  forbiddenKnowledge: DOCUMENTS_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '追加之后它把范围说清楚了（问了我，或明确说明它按哪个窗口查），我能确认它没有猜错范围。',
    gaveUp: '它闷头按一个没说明的窗口给数，或反复追问我已经说过的事。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:ambiguous-scope',
  limits: LIMITS,
};

/**
 * INT-02：确定性失败之后的下一步。
 *
 * 已知失败来自夹具数据：`denied-one` 被执行层拒绝（`GATE_REFUSE`，exit 3，无载荷），
 * 系统无法自行绕过。判据焦点：失败之后会不会给一个能落地的下一步，而不是反复道歉/讲内部机制。
 */
const SIM_INT_02: SimCase = {
  id: 'SIM-INT-02',
  goal: '让系统查 denied-one 这个集合（它没有权限/被限制）；拿到失败之后，我要看它给不给我一个能实际去做的下一步，而不是反复道歉或讲一堆内部原因。',
  persona: '遇事先要办法的业务同事，不吃「抱歉，出错了」这种空话；听不懂也不想听内部机制，只要具体能做的事。',
  knowledge: [
    '我要查的是 denied-one 这个集合',
    '它好像没有权限、被限制了',
    '我不懂内部机制，只想知道我这边还能怎么办',
    '我自己不报数字',
  ],
  initialMessage: '帮我查一下 denied-one 这个集合有多少条、合计多少。',
  behaviorRules: [
    '第一句按上面那条发出',
    '拿到失败回复后紧接着问一句：「那我这边现在能做什么？」',
    '如果它只是道歉或讲内部原因，就再追一句：「给我个能做的办法」',
    '我自己不报数字',
  ],
  forbiddenKnowledge: [],
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '它给了一个我能实际去做的下一步（换别的、请人开通、先放着等），不是空道歉。',
    gaveUp: '它反复道歉、只讲内部原因，或给不出任何可执行的办法。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:failure-next-step',
  limits: LIMITS,
};

/** 当前回合制单会话 harness 可在真实装配上跑的交互用例。 */
export const SIM_INTERACTION_CASES: readonly SimCase[] = Object.freeze([SIM_INT_01, SIM_INT_02]);

/**
 * INT-03：长活期间插话。
 *
 * blockedBy：现有 SimCase harness 回合制、单会话、同步等答复（一次 `send` 恰一条可见回复、
 * 逐次 `await`），表达不了「慢活未完成时插一句不相干的问题、两个答复不串、慢活完成后另有带
 * 身份的完成消息」。生产面这一能力在 `apps/server` 的 async 派发 + 通知 outbox，不在
 * `scripts/ask-runtime` 的同步装配里；且本仓 dummy 的 `dummy.longtask` 是**写操作**（ask 装配
 * 只开放只读集合，真实跑批到不了）。判据已先行写在 `./interaction-oracles` 的
 * `oracle:interjection-answered`，等 harness 具备异步/跨会话表达力后再接。
 */
const SIM_INT_03: SimCase = {
  id: 'SIM-INT-03',
  goal: '交办一个较慢的活；活还没完时，我再插一句不相干的问题。我要看插话是不是当场被正常回答（不是等我那件慢活做完才回）、两个答复不串，而且慢活做完时有一条能对得上我交办那件事的完成消息。',
  persona: '手里同时好几件事的业务同事，喜欢想起来就问；最烦系统「憋着不说话」或把两件事的回话搅在一起。',
  knowledge: [
    '我会先交办一个比较慢的活',
    '活还没完时我会插一句不相干的问题',
    '我不想等慢活做完才听到插话的答复',
    '我自己不报数字',
  ],
  initialMessage: '帮我跑一个比较慢的活（会需要一会儿）。',
  behaviorRules: [
    '先交办慢活',
    '在慢活还没完时，紧接着插一句不相干的问题',
    '看插话是不是当场被回答；如果被拖着不回就指出来',
    '我自己不报数字',
  ],
  forbiddenKnowledge: [],
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '插话被当场正常回答、两个答复不串，慢活完成后也有一条带身份的完成消息。',
    gaveUp: '插话被静默或排队到慢活之后才回，或两个答复搅在一起。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:interjection-answered',
  limits: LIMITS,
};

/**
 * INT-04：群里的一句。
 *
 * blockedBy：现有 harness 每 trial 只建**一个**会话（`createSystem` 返回单个
 * `SimSystemUnderTest`），表达不了「同一个人的单聊/群聊两个会话各自持有上下文，且群聊回复不得
 * 泄露单聊内容」。生产面这一能力在 `apps/server` 的群/私聊渠道与会话映射里，不在 SIM 面。
 * 判据已先行写在 `./interaction-oracles` 的 `oracle:group-one-liner`，等 harness 具备跨会话
 * 表达力后再接。
 */
const SIM_INT_04: SimCase = {
  id: 'SIM-INT-04',
  goal: '我先在单聊里问过一批 A 数据；随后在群里只问另一批 B 数据。我要看它是不是只答群里问的那批、不在群里主动冒泡、也不把我单聊里聊过的内容带到群里。',
  persona: '既用单聊也用群的业务同事，很在意「不该出现在群里的别冒出来」；会拿两边的问法来试系统。',
  knowledge: [
    '我先在单聊里问过一批数据',
    '随后我会在群里只问另一批数据',
    '群里不该出现我单聊里聊过的内容',
    '我自己不报数字',
  ],
  initialMessage: '（单聊）先帮我看下 A 这批的情况。',
  behaviorRules: [
    '先在单聊里问 A',
    '随后在群里只问 B（不要提到 A）',
    '如果群里冒出单聊的内容，或在没人问时主动冒泡，就指出来',
    '我自己不报数字',
  ],
  forbiddenKnowledge: [],
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '群里只答了被问的那批，没有主动冒泡，也没有泄露单聊内容。',
    gaveUp: '群里带了单聊内容，或在没人问时主动往群里发消息。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:group-one-liner',
  limits: LIMITS,
};

/** 一条被登记为「当前 harness 表达不了」的用例 + 缺什么。 */
export interface BlockedInteractionCase {
  readonly case: SimCase;
  readonly blockedBy: string;
}

/**
 * 当前 harness 表达不了、**不并入跑批**的交互用例（登记缺什么，不冒充读数）。
 * 与 `SIM_WRITE_CASES` 同一纪律：不可达的能力单列，绝不混进真实跑批当读数。
 */
export const SIM_INTERACTION_BLOCKED_CASES: readonly BlockedInteractionCase[] = Object.freeze([
  {
    case: SIM_INT_03,
    blockedBy: [
      'harness 回合制单会话、同步等答复（一次 send 恰一条可见回复、逐次 await）：',
      '表达不了「慢活未完成时插话、两个答复不串、慢活完成后另有带身份的完成消息」；',
      '生产面该能力在 apps/server 的 async 派发 + 通知 outbox，不在 scripts/ask-runtime 同步装配；',
      '且 dummy.longtask 是写操作（ask 装配只开放只读集合，真实跑批到不了）。',
    ].join(''),
  },
  {
    case: SIM_INT_04,
    blockedBy: [
      'harness 每 trial 只建一个会话（createSystem 返回单个 SimSystemUnderTest）：',
      '表达不了「同一个人的单聊/群聊两个会话各自有上下文、群聊回复不得泄露单聊内容」；',
      '生产面该能力在 apps/server 的群/私聊渠道与会话映射，不在 SIM 面。',
    ].join(''),
  },
]);
