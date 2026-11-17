import type { UserCase } from '../../suite-contract';

/** X04 多轮候选选择：t1 先查歧义句柄（执行层回候选），t2 用户用业务词选择
 * （物流那个 → contoso-logistics），模型只查被选中集合并交付数据。
 * E05 只覆盖 t1（歧义 → 候选）；本案例覆盖「候选 → 用户选择 → 正确成员 → 数据」这一段。 */
export const X04: UserCase = {
  id: 'X04',
  title: '多轮候选选择（业务词选择）',
  turns: ['帮我查一下 contoso 的数据。', '物流那个，帮我查一下。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 2,
    allowedCollections: ['contoso', 'contoso-logistics'],
    requiredRowCollections: ['contoso', 'contoso-logistics'],
    checkpoints: [
      { collection: 'contoso', status: 'needs_input', candidates: ['contoso-trade', 'contoso-logistics'] },
      {
        collection: 'contoso-logistics',
        status: 'completed',
        count: 1,
        items: [{ name: 'contoso-logistics-item-1', value: 450 }],
      },
    ],
  },
  hardAnchors: [
    { kind: 'containsAny', values: ['contoso-logistics', '物流'] },
    { kind: 'numberAny', numbers: [450] },
  ],
  weakNotes: [
    't1 候选名呈现：E05 记弱；本案例把「用户看得到候选」当作 t2 前提，升级为 t1 轮锚点（若判过严，可回落为弱记录）',
  ],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      requireRowArgs: { collection: 'contoso' },
      hardAnchors: [{ kind: 'containsAny', values: ['contoso-trade', 'contoso-logistics'] }],
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'contoso-logistics' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
    },
  ],
  judgeNotes: '用户确认前查 contoso-trade = FAIL_WRONG_OBJECT（同 E05 防线）；t2 再问集合 = FAIL_NEEDLESS_CLARIFICATION。',
};
