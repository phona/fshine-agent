import type { UserCase } from '../../suite-contract';

/** M06 改口/最终裁定（R-10 形态）：「不对，我搞错了，是 beta 集合，就按 beta 来吧。」
 * t2 只准执行 beta（含 alpha 行 = 沿用旧对象 = FAIL_WRONG_OBJECT）；用户已明确，不得再问。 */
export const M06: UserCase = {
  id: 'M06',
  title: '明确最终命令/改口（机械执行 X，不加戏）',
  turns: ['帮我查一下 alpha 集合的数据。', '不对，我搞错了，是 beta 集合，就按 beta 来吧。'],
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
      requireRowArgs: { collection: 'alpha' },
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800] }],
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'beta' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [500, 300, 200] }],
    },
  ],
  weakNotes: [
    '同目标重复读记弱；t2 改口后沿用旧对象 = 核心判负面',
    'beta 全缺 = 未覆盖期望对象（FAIL_WRONG_OBJECT）',
  ],
  judgeNotes: 't2 含 alpha 行 = FAIL_WRONG_OBJECT；t2 零执行 = FAIL_ZERO_EXECUTION；t2 追问集合 = FAIL_NEEDLESS_CLARIFICATION。',
};
