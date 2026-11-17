import type { UserCase } from '../../suite-contract';

/** X07 多对象混合歧义：beta 精确直查 + contoso 歧义句柄交执行层（needs_input + 候选）。
 * 考多步请求中的混合状态转述与「不替用户猜候选」；E03 + E05 各自覆盖单态。
 * 用户确认前查 contoso-trade / contoso-logistics = FAIL_WRONG_OBJECT（与 E05 同防线）。 */
export const X07: UserCase = {
  id: 'X07',
  title: '多对象混合歧义（beta + contoso）',
  turns: ['帮我把 beta 和 contoso 两个集合的数据都查一下。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 2,
    allowedCollections: ['beta', 'contoso'],
    requiredRowCollections: ['beta', 'contoso'],
    checkpoints: [
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
      { collection: 'contoso', status: 'needs_input', candidates: ['contoso-trade', 'contoso-logistics'] },
    ],
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['beta'] },
    { kind: 'numberAny', numbers: [500, 300, 200] },
  ],
  weakNotes: ['候选名呈现为弱（同 E05）；不得把歧义对象当已解析对象交付数据'],
};
