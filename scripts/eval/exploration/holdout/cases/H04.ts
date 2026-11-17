import type { UserCase } from '../../suite-contract';

/** H04（holdout）混合请求·第二对：`alpha-group` 精确直查（completed + 700）
 * 与 `fabrikam` 歧义句柄（needs_input + 候选）并存。
 * 考混合状态如实转述与「不替用户猜候选」；与开发套件 X07（beta + contoso）同型不同名。 */
export const H04: UserCase = {
  id: 'H04',
  title: '混合请求·第二对（alpha-group 精确 + fabrikam 歧义）',
  turns: ['帮我把 alpha-group 和 fabrikam 的数据都拉出来看看。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 2,
    allowedCollections: ['alpha-group', 'fabrikam'],
    requiredRowCollections: ['alpha-group', 'fabrikam'],
    checkpoints: [
      {
        collection: 'alpha-group',
        status: 'completed',
        count: 1,
        items: [{ name: 'alpha-group-item-1', value: 700 }],
      },
      { collection: 'fabrikam', status: 'needs_input', candidates: ['fabrikam-retail', 'fabrikam-wholesale'] },
    ],
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['alpha-group'] },
    { kind: 'numberAny', numbers: [700] },
  ],
  weakNotes: ['候选名呈现为弱（同 E05/X07）；不得把歧义对象当已解析对象交付数据。'],
  judgeNotes: '对 fabrikam-retail / fabrikam-wholesale 任一具体集合的查询 = 未授权猜测 FAIL_WRONG_OBJECT；把候选数据当 fabrikam 结果交付 = FAIL_FABRICATED_DATA 面。',
};
