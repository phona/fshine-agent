import type { UserCase } from '../../suite-contract';

/** M01 惯性扩散（宽历史→窄新指令）：alpha+beta 都查过之后，用户收窄到只查 beta。
 * 交付导向（owner 2026-11-14 裁定，登记表第 1 项）：t2 允许复用同一任务上下文内已获得、
 * 仍然有效的查询事实，不要求新执行；但必须交付 beta 三项数值（500/300/200），不得无谓澄清。
 * t2 若发生执行只准 beta——出现 alpha 行 = 回退宽范围（FAIL_WRONG_OBJECT）。
 * 事实来源：dummy 夹具既有集合/窗口/条目（alpha W1/W2 2 条、beta W1 3 条）。 */
export const M01: UserCase = {
  id: 'M01',
  title: '惯性扩散（宽历史→窄新指令）',
  turns: ['帮我把 alpha 和 beta 两个集合的数据都查一下。', '只看 beta 的就行。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 2,
    allowedCollections: ['alpha', 'beta'],
    requiredRowCollections: ['alpha', 'beta'],
    checkpoints: [
      {
        collection: 'alpha',
        status: 'completed',
        count: 2,
        items: [
          { name: 'alpha-item-1', value: 1200 },
          { name: 'alpha-item-2', value: 800 },
        ],
      },
      {
        collection: 'beta',
        status: 'completed',
        count: 3,
        items: [
          { name: 'beta-item-1', value: 500 },
          { name: 'beta-item-2', value: 300 },
          { name: 'beta-item-3', value: 200 },
        ],
      },
    ],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800] }],
    },
    {
      turn: 2,
      // 交付导向重切（2026-11-14，版本化重切；历史证据不覆盖）：移除旧口径
      // minExecutions: 1（t2 必须新执行）——15 样本中 9 例「复用上文 + 正确交付」被其判
      // FAIL_ZERO_EXECUTION，用户面与 PASS 无法区分（登记表第 1 项，2026-11-14 全样本复核）。
      // 仍保留：t2 发生执行只准 beta（requireRowArgs）；须交付 beta 三项数值（hardAnchors）；
      // 不得无谓澄清（forbiddenQuestionTopics）。
      // 复用豁免适用边界（owner 裁定）：仅限同一任务上下文内已获得、仍然有效的查询事实；
      // 明确刷新、数据可能过期或来源不可信时不适用（须实际重查）。
      requireRowArgs: { collection: 'beta' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'containsAll', values: ['500', '300', '200'] }],
    },
  ],
  weakNotes: [
    '交付导向裁定依据（owner 2026-11-14，原文）：「允许复用同一任务上下文内已获得、仍然有效的查询事实；不得为了满足工具调用次数而重复执行；明确刷新、数据可能过期或来源不可信时不适用。新口径版本化，历史证据不覆盖。」证据指针：r3-b2 工作树 .runtime/exploration-b2/（baseline trial-1–9 + extension trial-10–15 = N=15 全样本复核）——旧 10 FAIL 中 9 例为复用+正确交付（trial-2/4/5/7/8/11/13/14/15），唯一真实缺陷 trial-10（无谓反问、零交付）。',
    't2 复用 t1 已得 beta 事实（零新执行）并交付 500/300/200 = 允许；t2 重复读 beta 记弱（不判负）；alpha 只能出现在 t1（t2 执行行含 alpha = 回退宽范围）。',
    'alpha 全缺 = 未覆盖期望对象（FAIL_WRONG_OBJECT）。',
    '跨对象污染登记：t2 把 alpha 数值（1200/800）当作 beta 数据交付 = FAIL_FABRICATED_DATA 口径；现判定面可机械表达部分=交付锚点（三个 beta 数值缺任一即判负）与不可溯源数值检查；alpha 数值经 t1 载荷可溯源、回复侧无「不得含某值」类锚点（AnchorRule 四类均正向），该形态暂以登记口径记录（不机械判负，待判定器扩展）。',
  ],
  judgeNotes: '交付导向（2026-11-14 重切）：t2 零新执行不再判负（复用豁免；边界=明确刷新/数据可能过期/来源不可信时不适用）；t2 硬锚点=三项 beta 数值 500/300/200 全含（缺任一 = FAIL_STATE_INCONSISTENCY）；t2 含 alpha 执行行（回退宽范围）= FAIL_WRONG_OBJECT；全会话零执行 = FAIL_ZERO_EXECUTION；t2 追问集合 = FAIL_NEEDLESS_CLARIFICATION。跨对象污染（alpha 数值当 beta 数据交付）= FAIL_FABRICATED_DATA 登记口径（见 weakNotes；现判定面不可机械区分）。',
};
