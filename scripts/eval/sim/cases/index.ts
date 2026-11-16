/**
 * SimCase 用例套件 · 三个用户级样本（只定义目标与真值，不定义对话路径）。
 *
 * 运行顺序：`SIM-05` 先跑（最确定：夹具数据驱动的已知失败），再 `SIM-01`、`SIM-02`。
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

export {
  ALPHA_TRUTH_PATTERNS,
  createArchiveRecallOracle, createArchivedReferenceOracle, createPartialFailureHonestOracle,
} from './oracles';
export { SIM_FIXTURES, resolveFixtureDeclaration, type SimFixtureDeclaration } from './fixtures';

/** 套件局部 Oracle 注册（`runSimSuite({ oracles: SIM_CASE_ORACLES })`）；全部确定性、零 judge 调用。 */
export const SIM_CASE_ORACLES: readonly SimOracle[] = Object.freeze([
  createPartialFailureHonestOracle(),
  createArchiveRecallOracle(),
  createArchivedReferenceOracle(),
]);

/** alpha 真值同时作为禁知（见本文件头「真值纪律」）；`2条` 覆盖数量真值。 */
const ALPHA_FORBIDDEN: readonly string[] = Object.freeze(['2000', '1200', '800', '2条']);

/** 三个用例共用同一份缺省种子夹具（见 `./fixtures`）。 */
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
