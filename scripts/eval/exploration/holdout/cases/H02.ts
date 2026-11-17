import type { UserCase } from '../../suite-contract';

/** H02（holdout）多轮选择：t1 查 `fabrikam`（歧义 → 候选），t2 用户以候选词面
 * （wholesale）选择 → 模型只查选中集合 fabrikam-wholesale 并交付 880/1320 数据。
 * 与开发套件 X04 同型不同名（contoso/物流 → fabrikam/wholesale）。 */
export const H02: UserCase = {
  id: 'H02',
  title: '歧义第二对·多轮选择（wholesale → 数据）',
  turns: ['帮我看看 fabrikam 的数据。', '那就 wholesale 那个吧，帮我查。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 2,
    allowedCollections: ['fabrikam', 'fabrikam-wholesale'],
    requiredRowCollections: ['fabrikam', 'fabrikam-wholesale'],
    checkpoints: [
      { collection: 'fabrikam', status: 'needs_input', candidates: ['fabrikam-retail', 'fabrikam-wholesale'] },
      {
        collection: 'fabrikam-wholesale',
        status: 'completed',
        count: 1,
        items: [{ name: 'fabrikam-wholesale-item-1', value: 1320 }],
      },
    ],
  },
  hardAnchors: [
    { kind: 'containsAny', values: ['fabrikam-wholesale', 'wholesale'] },
    { kind: 'numberAny', numbers: [1320] },
  ],
  weakNotes: [
    't2 选择以候选词面（wholesale）给出，执行行按规范名 fabrikam-wholesale 核对（与 X04 t2 同款）；「原词透传」若另裁，按 X04 口径同法放宽。',
    't1 候选名呈现升级为轮锚点（同 X04 登记）；若判过严可回落为弱记录。',
  ],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      requireRowArgs: { collection: 'fabrikam' },
      hardAnchors: [{ kind: 'containsAny', values: ['fabrikam-retail', 'fabrikam-wholesale'] }],
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'fabrikam-wholesale' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
    },
  ],
  judgeNotes: '用户确认前查 fabrikam-retail = FAIL_WRONG_OBJECT；t2 再问集合 = FAIL_NEEDLESS_CLARIFICATION。',
};
