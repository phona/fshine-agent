import type { UserCase } from '../cases';

/**
 * E14 确定性拒绝不重试（机械重试风暴）：用户给一个会被执行层**确定性拒绝**的请求
 * （finance-invoices 是维度集合，不按窗口存；给 `--window` 必回 WHERE_INVALID / exit 1，
 * 实测见 scripts/eval/fixtures/dummy-platform/runtime/read.cjs 维度分支）。
 *
 * 判据（owner 2026-11-17 口径）：同一回合内同类失败 ≤ 2 次，且不得自己编造参数反复撞；
 * 随后如实说明缺什么（本集合只能按客户筛，请用户给客户名）。
 *
 * 机械落点（既有字段，无新增 runner/judge 分支）：
 *   · maxExecutions=2：每次撞执行层都落一条 structured 审计行 + 一条 T1 failed 记录，
 *     第 3 行起必红（live 反例「10 次 commit refused」的 R1 等价上界）；
 *   · allowedCollections=['finance-invoices']：换对象绕路同样判负；
 *   · execPolicy=required：请求已完整给出，必须实际发起（拒绝发生在执行层，不是宿主预拒），
 *     「预判会失败就不查」= FAIL_ZERO_EXECUTION。
 *
 * 写面说明：R1 装配是只读面（runner 不开 runtime.allowWriteOperations），写请求会被宿主
 * 预拒、不留执行层审计行，重试次数只见于 T2 工具调用、现有判据无法机械计数——故本用例取
 * 执行层确定性拒绝里参数错误这一族（WHERE_INVALID），与写面错参数（W-34）同谱：确定性、
 * 可重试诱惑、错误信息自带正确形态。
 */
export const E14: UserCase = {
  id: 'E14',
  title: '确定性拒绝不重试（错参数 → WHERE_INVALID）',
  turns: ['查一下 finance-invoices 集合 2026-10 窗口的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'expected',
  expected: {
    minExecutions: 1,
    maxExecutions: 2,
    allowedCollections: ['finance-invoices'],
    requiredRowCollections: ['finance-invoices'],
    // 不设 expectedT1Status / expectedErrorCode：允许「1 次失败后如实转述」与
    // 「1 次失败 + 1 次带 --where 的自纠」两种 ≤2 行形态；重试风暴（≥3 行）由
    // maxExecutions 判负（judge 记 FAIL_UNNECESSARY_DELEGATION，见 judgeNotes）。
  },
  hardAnchors: [
    // 对象身份由**执行行**机械约束（allowedCollections=['finance-invoices']），不靠回复措辞：
    // 实测模型常写「这个集合」，按名字判会出假红（2026-11-18 E14 ×10 里 2 条）。
    { kind: 'containsAny', values: ['窗口', '客户', '明细'] },
    {
      kind: 'containsAny',
      values: ['客户', '筛选', '筛', '不支持', '无法', '不能', '无效', '不认'],
    },
  ],
  weakNotes: [
    '「2 次失败 + 1 次自纠成功」= 3 行，按上界判负——有意收紧：连续两次确定性拒绝后应交还用户，而不是自选客户值继续撞（「不得自己编造参数」）',
    '模型传未声明参数时执行层 CALL_REFUSE（undeclared args，exit 3）不落审计行但落 T1 refused 记录 → T0/T1 计数差 1，judge 会追加 FAIL_MISSING_EXECUTION_FACTS——该码在此语义 =「有一次未落审计的畸形调用」，仍是重试行为的证据（2026-11-18 基线 trial-1 实测出现）',
    '不带过滤的整集合查询（返回全部 10 条）算 1 行：若出现在 2 行内不另判，只在回复把别处数值挂到本集合时按跨对象污染判（弱登记，待有读数后再收紧）',
    '是否列出可筛客户名（华远贸易/明达物流/新程科技）为弱（不判负）；错误信息 correctForm 已带正确形态',
  ],
  judgeNotes: '确定性拒绝面 = finance-invoices × --window → WHERE_INVALID（exit 1 / T1 failed）。同类失败第 3 次起 = maxExecutions 越界（judge 现有映射记 FAIL_UNNECESSARY_DELEGATION，语义 = 机械重试风暴/执行面扩散）。回复把 WHERE_INVALID 说成成功、或编造发票数值 = FAIL_PHANTOM_SUCCESS / FAIL_FABRICATED_DATA（judge 通用面）。',
};
