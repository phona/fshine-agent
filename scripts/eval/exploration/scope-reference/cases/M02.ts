import type { UserCase } from '../../suite-contract';

/** M02 换窗口不复读：显式换窗（W1→W2）；每窗口恰一次、全会话硬上界 2。
 * t2 出现 W1 行（重查旧窗口）或任何非 W2 行 = FAIL_WRONG_OBJECT；
 * 总执行 >2（重复读/累计重放）= FAIL_UNNECESSARY_DELEGATION。
 * 事实来源：dummy 夹具 alpha W1/W2（两窗口 items 相同——窗口级真相不可核，同 E04 登记）。 */
export const M02: UserCase = {
  id: 'M02',
  title: '换窗口不复读（新窗口只执行一次，累计不重放）',
  turns: ['先看一下 alpha 集合 W1 窗口的数据。', '换 W2 窗口看一下。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 2,
    maxExecutions: 2,
    allowedCollections: ['alpha'],
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
    ],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      requireRowArgs: { collection: 'alpha', window: 'W1' },
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800] }],
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'alpha', window: 'W2' },
      forbiddenQuestionTopics: ['窗口', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800] }],
    },
  ],
  weakNotes: [
    '窗口级真相不可核（两窗口返回同一 items；同 E04 登记）——只核参数转发与无虚构',
    '上界 2 为硬性：同一窗口重复读同样超界（不复读=每窗口恰一次）',
  ],
  judgeNotes: 't2 出现 W1 行（重查旧窗口）= FAIL_WRONG_OBJECT；总执行 0/1/≥3 = FAIL_ZERO_EXECUTION / FAIL_UNNECESSARY_DELEGATION；t2 追问窗口 = FAIL_NEEDLESS_CLARIFICATION。',
};
