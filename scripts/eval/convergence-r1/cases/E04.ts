import type { UserCase } from '../cases';

/**
 * E04 多轮上下文：同一 session 两轮；t2 必须沿用 t1 的对象并切换窗口，
 * 且不得再问窗口/集合（问 = 无谓追问）。
 * 弱判登记：夹具两窗口返回同一 items（bin/dummy.cjs 的 documents 种子），
 * 窗口级真相不可核，只能核「参数转发 + 无虚构」。
 */
export const E04: UserCase = {
  id: 'E04',
  title: '多轮上下文（窗口切换追问）',
  turns: [
    '帮我核对 documents 集合里 W202611 窗口的单据。',
    '那 W202610 窗口的呢？',
  ],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['documents'],
    requiredRowCollections: ['documents'],
    checkpoints: [{
      collection: 'documents',
      status: 'completed',
      count: 3,
      items: [
        { name: 'document-1', value: 1200 },
        { name: 'document-2', value: 800 },
        { name: 'document-2', value: 900 },
      ],
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  weakNotes: [
    '夹具两窗口返回同一 items（bin/dummy.cjs:388 种子的 documents），窗口级真相不可核——只核参数转发与无虚构',
  ],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      requireRowArgs: { collection: 'documents', window: 'W202611' },
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'documents', window: 'W202610' },
      forbiddenQuestionTopics: ['窗口', '集合', '哪一个', '哪个', '哪一'],
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800, 900] }],
    },
  ],
  judgeNotes: 't2 零执行 = FAIL_ZERO_EXECUTION；t2 问窗口/集合 = FAIL_NEEDLESS_CLARIFICATION；t2 回复不得给出新的窗口差异宣称（无载荷依据）。',
};
