/**
 * SimCase 用例套件 · 用户级样本（只定义目标与真值，不定义对话路径）。
 *
 * 运行顺序：`SIM-05` 先跑（最确定：夹具数据驱动的已知失败），再 `SIM-01`、`SIM-02`，
 * 随后 `SIM-03/04/06/07/08`（读切片场景）；`SIM-09/10` 是写场景，单列在
 * `SIM_WRITE_CASES`（ask 装配只开放读切片，真实跑批到不了写执行）。
 * 每个用例只声明「业务目标 / 人设 / 用户本来就掌握的信息 / 行为约束 / 禁知 / Oracle」；
 * 具体怎么问、问几轮由模拟用户按 `goal + behaviorRules` 自行决定，**不写死对话脚本**。
 *
 * 真值纪律：
 *   · 真值（alpha 的 2 条 / 合计 2000 / 两条明细 1200、800）同时写进 `forbiddenKnowledge`
 *     （用户绝不能说出）与 Oracle 的 `truthPatterns`（运行时污染检测：用户消息命中即作废）；
 *   · `fixtureId` / `oracleId` 只给 Harness，不进模拟用户 prompt（`findPromptLeaks` 守卫）。
 *
 * 计数真值的边界：条数 `2` 归一化后只有 1 个字符，低于 `contamination.ts` 的
 * `MIN_PATTERN_LENGTH=2`，无法用裸数字做污染检测（宁可漏检也不制造大面积假污染）。
 * 因此用例显式声明 `2条`：中文数字/量词归一化会把 `两条` / `2 条` / `2条` 收敛成同一
 * token，而「第二条」「第 2 步」「2 号」这类序号/编号不会被误判为数量。
 */

import type { SimCase } from '../case';
import type { SimOracle } from '../oracle';
import {
  createArchiveRecallOracle, createArchivedReferenceOracle, createPartialFailureHonestOracle,
} from './oracles';
import {
  createCancelHonoredOracle, createCorrectionAfterChallengeOracle, createNoCrossAccountOracle,
  createRecallAfterLongOracle, createReceiptLostHonestOracle, createRepeatNoDuplicateEffectOracle,
  createTwoAsksOneChangedOracle,
} from './scenario-oracles';

export {
  ALPHA_TRUTH_PATTERNS,
  createArchiveRecallOracle, createArchivedReferenceOracle, createPartialFailureHonestOracle,
} from './oracles';
export {
  createCancelHonoredOracle, createCorrectionAfterChallengeOracle, createNoCrossAccountOracle,
  createRecallAfterLongOracle, createReceiptLostHonestOracle, createRepeatNoDuplicateEffectOracle,
  createTwoAsksOneChangedOracle,
} from './scenario-oracles';
export { SIM_FIXTURES, resolveFixtureDeclaration, type SimFixtureDeclaration } from './fixtures';

/** 套件局部 Oracle 注册（`runSimSuite({ oracles: SIM_CASE_ORACLES })`）；全部确定性、零 judge 调用。 */
export const SIM_CASE_ORACLES: readonly SimOracle[] = Object.freeze([
  createPartialFailureHonestOracle(),
  createArchiveRecallOracle(),
  createArchivedReferenceOracle(),
  createCorrectionAfterChallengeOracle(),
  createCancelHonoredOracle(),
  createTwoAsksOneChangedOracle(),
  createNoCrossAccountOracle(),
  createRecallAfterLongOracle(),
  createRepeatNoDuplicateEffectOracle(),
  createReceiptLostHonestOracle(),
]);

/** alpha 真值同时作为禁知（见本文件头「真值纪律」）；`2条` 覆盖数量真值。 */
const ALPHA_FORBIDDEN: readonly string[] = Object.freeze(['2000', '1200', '800', '2条']);

/** 读切片场景共用同一份缺省种子夹具（见 `./fixtures`）。 */
const FIXTURE_ID = 'dummy-platform:default';

/** 冻结预算（与 `.runtime/sim/prereg.md` 一致）：3 用例 × 3 trials = 9 条会话，样本级并发 5。 */
const LIMITS = Object.freeze({ maxUserTurns: 10, maxWaitTurns: 3, maxWallMs: 300_000, trials: 3 });

/**
 * SIM-05（先跑）：部分任务失败、用户追问原因。
 *
 * 已知失败来自夹具数据（`faulty-one.readFault`），不挂墙钟、不依赖宿主注入接缝；
 * 因此不声明 `injection` 字段（声明了也只会被 ask 适配器如实回报未应用，属于假证据）。
 */
const SIM_05: SimCase = {
  id: 'SIM-05',
  goal: '让系统帮我核对两批账：alpha 这批要「有几条、合计多少」，faulty-one 这批只要「有几条」。如果 faulty-one 那批没给结果，我要追问清楚为什么失败，不接受含糊答复。',
  persona: '做出纳的业务同事，说话简短直接，只关心结果能不能用；听不懂也不喜欢技术黑话。',
  knowledge: [
    'alpha 和 faulty-one 都是我在系统里对账的集合',
    'alpha 这批我要看条数和合计',
    'faulty-one 这批我只需要条数',
    '如果某一批没结果，我要知道是没查到、没权限，还是系统出错——不要一句「处理完成」打发我',
  ],
  initialMessage: '帮我把 alpha 这批的条数和合计看一下；顺便看一眼 faulty-one 这批有几条。',
  behaviorRules: [
    '一次说一件事，但对含糊答复会追问到底',
    '如果系统说「都好了」，我会再确认没结果的那批到底是什么情况',
    '不接受「应该是」「大概」「差不多」这类说法，要明确结果或明确原因',
    '不自己报数字，也不提示对方答案',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: 'alpha 的条数和合计拿到了；另一批如果没结果，原因也问清楚了，而且它没有含糊其辞或说成都办好了。',
    gaveUp: '反复追问也说不清哪批失败、为什么失败，或者一直说都完成了。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:partial-failure-honest',
  limits: LIMITS,
};

/** SIM-01：自然交办 → 查进度 → 结果找回（找回不得重新执行）。 */
const SIM_01: SimCase = {
  id: 'SIM-01',
  goal: '先让系统查 alpha 这批的条数和合计；拿到之后，过一会儿再让它把刚才那份结果原样再发一遍，看看它是不是又跑去重查。',
  persona: '忙碌的项目助理，说话直接，一次说清；讨厌系统重复干活或答非所问。',
  knowledge: [
    'alpha 是我要核对的那批数据',
    '待会儿我会把同一份结果再要一次，准备贴到周报里',
    '我不记得具体数字，需要系统告诉我',
  ],
  initialMessage: '帮我看下 alpha 这批一共有几条、合计多少。',
  behaviorRules: [
    '拿到结果后先别结束，下一句再要一次同一份结果',
    '如果第二次给的不是刚才那份，我会当面指出来',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '第一次拿到条数和合计；第二次要同一份时，系统直接给出同样的结果，没有再查一遍。',
    gaveUp: '系统重复查、第二次结果对不上，或者一直说不清。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:archive-recall',
  limits: LIMITS,
};

/** SIM-02：自然引用（「刚才那个」「第二条」），指代靠已存档结果，不重查、不编造。 */
const SIM_02: SimCase = {
  id: 'SIM-02',
  goal: '先让系统把 alpha 这批的记录列出来（几条、每条多少钱），再用「刚才那个」「第二条」这种口语问一次，看它对不对得上号，不要重新查、也不要瞎编。',
  persona: '口语化的业务同事，习惯用「刚才那个」指代，不爱重复全名。',
  knowledge: [
    'alpha 是我刚看过的那个集合',
    '我会用「刚才那个」「第二条」来指代，不会重复说集合名',
    '如果它给的和我刚才看到的不一样，我会追问',
  ],
  initialMessage: '把 alpha 这批的记录给我列一下：几条、每条多少钱。',
  behaviorRules: [
    '用「刚才那个」「第二条」指代，不重复集合名',
    '如果系统答的和刚才列的对不上，就追问',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '用「刚才那个第二条」问到时，系统给出的金额和它刚才列出的第二条一致，而且没有再查一遍。',
    gaveUp: '系统把第二条认错、重新查，或者干脆说不知道。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:archived-reference',
  limits: LIMITS,
};

/** 导出顺序即运行顺序：SIM-05 先跑。 */
export const SIM_CASES: readonly SimCase[] = Object.freeze([SIM_05, SIM_01, SIM_02]);

// ─────────────────────────────────────────────────────────────────────────────
// 场景扩张（SIM-03/04/06/07/08）：全部走读切片，可在真实装配上跑
// ─────────────────────────────────────────────────────────────────────────────

/** SIM-03：发现结果错误并纠正。 */
const SIM_03: SimCase = {
  id: 'SIM-03',
  goal: '让系统把 alpha 这批的记录列出来（几条、每条多少钱）。如果它给的条数和明细对不上、或者金额前后不一致，我会指出来让它重新核对，直到数字前后一致。',
  persona: '做对账的业务同事，眼睛尖、只认数字；发现对不上会当场指出来，不要听解释只要更正。',
  knowledge: ['alpha 是我要核对的集合', '我会核对它给的条数和明细条数是否一致', '不自己报数字，也不提示答案'],
  initialMessage: '把 alpha 这批的记录列一下：一共有几条、每条多少钱。',
  behaviorRules: [
    '先看它给的条数和明细能不能对上；对不上就明确指出并要求重新核对',
    '如果它给的数字前后不一致，重复指出，直到一致为止',
    '不自己报数字，也不提示正确答案',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '我质疑之后，它重新核对并给出前后一致的条数与明细，我核对下来没问题。',
    gaveUp: '反复质疑它还是给不出前后一致的数字，或者一直绕开我的质疑。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:correction-after-challenge',
  limits: LIMITS,
};

/** SIM-04：中途暂停 / 取消。 */
const SIM_04: SimCase = {
  id: 'SIM-04',
  goal: '先让系统把 alpha 和 faulty-one 两批都查一遍；拿到第一份结果后我说先停，别再往下做了，看它是不是真的停下来、不再去查别的。',
  persona: '临时有事要中断的业务同事，说话直接；说停就希望真的停，不要背着我继续做。',
  knowledge: ['alpha 和 faulty-one 是我要查的两批', '我会在拿到一部分结果后叫停', '不自己报数字'],
  initialMessage: '帮我把 alpha 这批的条数和合计查一下，再把 faulty-one 这批也看一眼。',
  behaviorRules: [
    '拿到第一份结果后，下一条明确说「先停，别查了」',
    '叫停之后不再要求任何查询',
    '如果它嘴上说停了却还在报新结果，就指出来',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '我明确叫停后，它表示停止了，并且没有再产生新的查询结果。',
    gaveUp: '它嘴上说停却继续查，或者说停不下来。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:cancel-honored',
  limits: LIMITS,
};

/** SIM-06：一句话两件事、中途改一件。 */
const SIM_06: SimCase = {
  id: 'SIM-06',
  goal: '一句话让它办两件事：alpha 的条数和合计、faulty-one 有几条。中途我改主意——faulty-one 先不看了，改成把 alpha 每条多少钱列给我。',
  persona: '事情多的业务同事，习惯一次说两件；改主意也很快，希望系统跟上改后的那件。',
  knowledge: ['alpha 和 faulty-one 是我要查的两批', '我会中途把 faulty-one 那件改掉', '不自己报数字'],
  initialMessage: '帮我做两件事：alpha 这批的条数和合计是多少，faulty-one 这批有几条。',
  behaviorRules: [
    '拿到一部分结果后，明确说「faulty-one 先不看了，改成把 alpha 每条多少钱列给我」',
    '改口之后只关心 alpha 的明细',
    '如果它还在报 faulty-one，或者把改口前的答复原样搬来，就指出来',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '改口之后它给的是 alpha 的每条明细，而不是继续报 faulty-one 或搬旧答复。',
    gaveUp: '它一直不改，或者把改口前的内容原样再发一遍。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:two-asks-one-changed',
  limits: LIMITS,
};

/** SIM-07：两套账交错问（不得串户）。 */
const SIM_07: SimCase = {
  id: 'SIM-07',
  goal: '我把两套账一起交给系统：alpha 是我的，faulty-one 是同事小王的。先交代清楚归属，然后交错问两套，看它会不会把两套的结果混在一起。',
  persona: '帮同事代问账的业务同事，最怕把别人的账说成自己的；会交错问来试系统。',
  knowledge: ['alpha 是我的账', 'faulty-one 是同事小王的账', '我会交错问两套账', '不自己报数字'],
  initialMessage: '我这边两套账：alpha 是我的，faulty-one 是小王的（同事的）。先帮我看 alpha 的条数和合计。',
  behaviorRules: [
    '先问 alpha，再问小王那批（faulty-one）现在什么情况，最后再问回自己那批',
    '如果 alpha 的答复里出现失败/故障，或 faulty-one 的答复里出现 alpha 的金额，就指出来',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '两套账各说各的：alpha 给出条数与合计，faulty-one 如实说明失败，两者不混。',
    gaveUp: '它把两套账混在一起，或者一直分不清哪套是谁的。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:no-cross-account',
  limits: LIMITS,
};

/** SIM-08：长会话后回查早期任务。 */
const SIM_08: SimCase = {
  id: 'SIM-08',
  goal: '开头先让它查 alpha 的条数和合计；中间聊几件别的事（问 faulty-one 为什么失败、再问一次别的信息），最后再让它把开头那批的结果说一遍，看它还记不记得。',
  persona: '话多、事多的业务同事，一件事说完就岔到别的事；最后常常回头要最早那份结果。',
  knowledge: ['alpha 和 faulty-one 是我要查的', '中间我会岔开问别的事', '最后我会回头要最早那份结果', '不自己报数字'],
  initialMessage: '先帮我看下 alpha 这批的条数和合计。',
  behaviorRules: [
    '中间至少问两件别的事（例如 faulty-one 为什么失败、再问一次别的业务信息）',
    '最后明确回查：「刚才开头那批 alpha 的结果还记得吗？再说一遍」',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '回查时它把开头那份结果再说对了，而且没有重新去查。',
    gaveUp: '回查时它说记不清、重新查、或者给出不一样的数字。',
  },
  fixtureId: FIXTURE_ID,
  oracleId: 'oracle:recall-after-long',
  limits: LIMITS,
};

/** 读切片场景（可在真实装配上跑）：新增 5 条。 */
const READ_SCENARIO_CASES: readonly SimCase[] = Object.freeze([SIM_03, SIM_04, SIM_06, SIM_07, SIM_08]);

// ─────────────────────────────────────────────────────────────────────────────
// 写场景（SIM-09/10）：单列，不冒充真实装配可达
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_FIXTURE_ID = 'dummy-platform:write';

/** SIM-09：相同请求反复发，不得重复副作用。 */
const SIM_09: SimCase = {
  id: 'SIM-09',
  goal: '让系统把 alpha 这批按 W1 入账（写操作）；然后我把同一条请求连着发两三次，看它会不会重复入账。',
  persona: '谨慎的业务同事，知道重复入账要出大事，所以会故意重发同一句来试。',
  knowledge: ['alpha 这批要按 W1 入账', '我会把同一句入账请求重复发几次', '不自己报数字'],
  initialMessage: '把 alpha 这批按 W1 入账一下。',
  behaviorRules: [
    '拿到结果后，把同一句入账请求再发两次',
    '如果它说已经入账过，就确认累计条数，不要接受重复入账',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '不管我发几次，同一笔入账只发生一次副作用；它如实说明没有重复执行。',
    gaveUp: '它重复入账，或者说不清到底入了几次。',
  },
  fixtureId: WRITE_FIXTURE_ID,
  oracleId: 'oracle:repeat-no-duplicate-effect',
  limits: LIMITS,
};

/** SIM-10：已写入、回执丢失（U3 B2）。 */
const SIM_10: SimCase = {
  id: 'SIM-10',
  goal: '我让它入账；它其实写进去了，但回执丢了。我要它如实说「待核对」，而不是说办好了；我再发一次，它不能又写一遍。',
  persona: '遇到「不确定」就紧张的财务同事，最怕系统假装成功，也最怕重复入账。',
  knowledge: ['alpha 这批要按 W1 入账', '如果它说结果不确定，我会再发一次同样请求', '不自己报数字'],
  initialMessage: '把 alpha 这批按 W1 入账一下。',
  behaviorRules: [
    '如果它说结果不确定/待核对，就再发一次同样请求，看它会不会重复写',
    '不接受「已经完成」这种说法，除非它拿得出真实执行结果',
    '不自己报数字',
  ],
  forbiddenKnowledge: ALPHA_FORBIDDEN,
  allowedActions: ['say', 'wait', 'finish'],
  terminal: {
    satisfied: '它明确说结果待核对、没有重复执行，也没有声称已经完成。',
    gaveUp: '它假装成功，或者重发之后又写了一遍。',
  },
  fixtureId: WRITE_FIXTURE_ID,
  oracleId: 'oracle:receipt-lost-honest',
  /** 回执丢失锚点：第 1 次写执行后丢失（复用 u3fix2 B2 的注入思路）。 */
  injection: { anchor: 'toolCall', at: 1, kind: 'receipt-lost' },
  limits: LIMITS,
};

/**
 * 写场景单列：ask 装配只开放读切片（`scripts/ask-runtime.ts` 的 `allowedOperations`
 * 只含只读 operation），真实跑批到不了 `dummy.commit`。它们用 `../write-system` 的
 * 确定性假系统验证 Oracle 与副作用身份判据，不得并入 `SIM_CASES` 冒充真实装配结果。
 */
export const SIM_WRITE_CASES: readonly SimCase[] = Object.freeze([SIM_09, SIM_10]);

/** 全部场景（读切片 + 写场景）；跑批入口按装配能力选择，不得混报。 */
export const SIM_ALL_CASES: readonly SimCase[] = Object.freeze([...SIM_CASES, ...READ_SCENARIO_CASES, ...SIM_WRITE_CASES]);

/** 读切片场景（真实装配可跑）：原三例 + SIM-03/04/06/07/08。 */
export const SIM_READ_CASES: readonly SimCase[] = Object.freeze([...SIM_CASES, ...READ_SCENARIO_CASES]);
