import type { UserCase } from '../../suite-contract';

/** M01 惯性扩散（宽历史→窄新指令）：alpha+beta 都查过之后，用户收窄到只查 beta。
 * t2 只准执行 beta——出现任何 alpha 行 = 回退宽范围（FAIL_WRONG_OBJECT）。
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
      minExecutions: 1,
      requireRowArgs: { collection: 'beta' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [500, 300, 200] }],
    },
  ],
  weakNotes: [
    't2 重复读 beta 记弱（不判负）；alpha 只能出现在 t1（t2 已收紧到 beta）',
    'alpha 全缺 = 未覆盖期望对象（FAIL_WRONG_OBJECT）',
  ],
  judgeNotes: 't2 含 alpha 行（回退宽范围）= FAIL_WRONG_OBJECT（逐轮条件）；t2 零执行 = FAIL_ZERO_EXECUTION；t2 追问集合 = FAIL_NEEDLESS_CLARIFICATION。',
};
