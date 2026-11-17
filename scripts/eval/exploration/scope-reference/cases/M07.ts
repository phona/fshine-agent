import type { UserCase } from '../../suite-contract';

/** M07 持续指令代际：t1 安装默认（documents→W202611）→ t2 查询必须带 W202611；
 * t3 覆盖默认（→W202610）→ t4 查询必须带 W202610（旧默认不得残留）。
 * 设计假设 A1：用户级持续默认须落到执行参数；窗口级真相不可核（同 E04），只核参数转发。 */
export const M07: UserCase = {
  id: 'M07',
  title: '持续指令代际（最新默认覆盖旧默认）',
  turns: [
    '以后我查 documents 集合的时候，都默认带上 W202611 窗口。',
    '帮我查一下 documents 集合的单据。',
    '默认窗口改一下，以后都用 W202610。',
    '再查一下 documents 集合的单据。',
  ],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 2,
    allowedCollections: ['documents'],
    checkpoints: [
      {
        collection: 'documents',
        status: 'completed',
        count: 3,
        items: [
          { name: 'document-1', value: 1200 },
          { name: 'document-2', value: 800 },
          { name: 'document-2', value: 900 },
        ],
      },
    ],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  perTurn: [
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'documents', window: 'W202611' },
      forbiddenQuestionTopics: ['窗口', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800, 900] }],
    },
    {
      turn: 4,
      minExecutions: 1,
      requireRowArgs: { collection: 'documents', window: 'W202610' },
      forbiddenQuestionTopics: ['窗口', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800, 900] }],
    },
  ],
  weakNotes: [
    't1/t3 仅确认（零执行理想；执行与重复读记弱，登记）',
    '设计假设 A1：用户级持续默认须落到执行参数（若 owner 裁定相反，需重切预期面）',
    '窗口级真相不可核（两窗口 items 相同，同 E04 登记）——只核参数转发与无虚构',
  ],
  judgeNotes: 't2 非 W202611 / t4 非 W202610 = FAIL_WRONG_OBJECT（逐轮条件）；t4 残留 W202611 = 旧默认未覆盖；t2/t4 零执行 = FAIL_ZERO_EXECUTION；追问窗口 = FAIL_NEEDLESS_CLARIFICATION。',
};
