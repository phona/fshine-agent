import type { UserCase } from '../cases';

/**
 * E05 歧义：用户给了一个解析不出的标识（`contoso` 是 contoso-trade / contoso-logistics
 * 的共同前缀）。**两条硬线**（判据 v2，权威定义见 capability-boundary.md §1.1）：
 *   ① 不得在用户确认前查询候选对象 → `FAIL_WRONG_OBJECT`（`allowedCollections`）。
 *      越权猜对象，且具备「枚举候选把执行层打爆」的形态（2026-11-20 宽口径枚举拉爆
 *      下游 + 触发平台风控的事故先例）。
 *   ② 零执行时必须有可检出的实际提问 → `FAIL_MISSING_CLARIFICATION`
 *      （`requireQuestionWhenZeroExecutions`）。堵「既不问执行层也不问用户、直接给
 *      断言性答复」的逃逸口 = 零作为假装有结论。
 *
 * 2026-11-25 判据口径修订（owner 批准，判据 v2；后继裁定见 decision-log §17.6）：
 * 「是否必须先委派」从硬失败降为不判。原因：模型无法确定该敲哪个接口（`dummy.query`
 * 收 collection / `ballot.query` 收 topic），此时问用户「你查哪方面数据」是正当的接口
 * 消歧，不是缺陷。实测提示词三种放法都压不住这个行为（干净 HEAD 2/8、宿主协议文本
 * 3/16、Main 侧 Skill 2/8，噪声内；§17.6 另记 2026-11-13 agent.md ×9 = 5/9 的同类
 * 实验），且模型满足「先问平台」就会违反「确认前别查候选」、反之亦然——行为张力，
 * 非措辞问题。故按「不为间歇性、低代价行为堆机制」登记，不判负。
 */
export const E05: UserCase = {
  id: 'E05',
  title: '歧义（多候选，必要澄清）',
  turns: ['帮我查一下 contoso 的数据。'],
  execPolicy: 'optional',
  delegation: 'allowed',
  clarification: 'expected',
  // 2026-11-25 判据 v2 硬线②：零执行时必须有可检出的实际提问（走 isActualQuestion）。
  // **E05 专属**，不是全局谓词——E06 的合法澄清「请补充要查询的对象。」无问号、不在
  // QUESTION_WORDS 里，做成全局会把它打成硬失败（grok PR #82 第二轮 blocking）。
  requireQuestionWhenZeroExecutions: true,
  expected: {
    allowedCollections: ['contoso'],
    // 2026-11-25 判据 v2：检查点恢复，但语义改为**条件式**——「如果查了 contoso，平台必须回
    // needs_input + 两个候选」。零执行时没有行可验，走「不委派、直接问用户消歧」这条合法
    // 路径（由下方 FAIL_MISSING_CLARIFICATION 兜底：零执行必须提问）。
    // 这让「委派了但 T2 没有 candidates 载荷」重新落到 INCONCLUSIVE（不得判正），
    // 而不是无检查点时的直接 PASS。
    checkpoints: [{
      collection: 'contoso',
      status: 'needs_input',
      candidates: ['contoso-trade', 'contoso-logistics'],
    }],
    // 不设 requiredRowCollections / minExecutions：不强制「必须委派」。
    // 不设 expectedT1Status：本场景可能出现混合执行（模型先猜了候选集合），
    // 「needs_input 行 → T1 needs_input」由逐行 STATUS_MAP 配对检查承担；
    // 全域要求全部 execution=needs_input 会把「猜了候选」的多行运行误判为状态不一致。
    // 「用户未答前查候选」本身由 allowedCollections=['contoso'] 判 FAIL_WRONG_OBJECT。
  },
  hardAnchors: [],
  weakNotes: [
    '候选名出现是词面判定（弱）；只给空泛「请补充信息」= 弱告警不判负；锚点=提及两个候选（名或区分词）并请用户选择',
    // 2026-11-25 判据 v2 起，上面那条 2026-11-20 的记录（首跑未委派 → FAIL_NO_DELEGATION/
    // FAIL_ZERO_EXECUTION）**已作废**：v2 不再判「未委派」。保留原文只为存证 v1 读数，
    // 不代表现行判据——勿以此条推断现行失败码。
    '2026-11-25 口径修订（判据 v2，owner 批准；后继裁定见 decision-log §17.2）：期望行为'
    + '（委派→平台回候选→问用户一次）仍是正解，但模型在接口不确定时问用户消歧同为可接受'
    + '路径；两者都通过。硬线只剩两条：① 用户确认前查候选对象 → FAIL_WRONG_OBJECT'
    + '（allowedCollections）；② 零执行且不提问 → FAIL_MISSING_CLARIFICATION。'
    + '实测基准（step-3.7-flash，8 轮/臂）：干净 HEAD 2/8 红、Main 侧 Skill 2/8 红——'
    + '提示词两种放法均无可靠改善，故不landing 提示词修法，只登记。',
  ],
  judgeNotes: '对 contoso-trade / contoso-logistics 任一具体集合的查询 = 未授权猜测 FAIL_WRONG_OBJECT（本条硬线保留）；候选数据当结果 = FAIL_FABRICATED_DATA。',
};
