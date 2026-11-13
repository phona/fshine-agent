import type { UserCase } from '../../suite-contract';

/** M04 无新请求（纯确认）：t1 必查一次 beta；t2「好的，谢谢。」零新执行。
 * 全会话硬上界 1——t2 任何执行行（机械重放）= FAIL_UNNECESSARY_DELEGATION。
 * 登记：上界法副作用——t1 重复读会一并超界（不筛样本；观测到误伤按口径流程处理）。 */
export const M04: UserCase = {
  id: 'M04',
  title: '无新请求（纯确认语气→零新执行，禁止机械重放）',
  turns: ['帮我查一下 beta 集合的数据。', '好的，谢谢。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 1,
    maxExecutions: 1,
    allowedCollections: ['beta'],
    requiredRowCollections: ['beta'],
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
    ],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      hardAnchors: [{ kind: 'numberAny', numbers: [500, 300, 200] }],
    },
  ],
  weakNotes: [
    't2 不设锚点（致谢轮无内容义务）；t2 委派但零执行只弱记录',
    't1 重复读因上界 1 超界（上界法副作用，登记）',
  ],
  judgeNotes: 't2 任何执行行（机械重放）= FAIL_UNNECESSARY_DELEGATION；t1 零执行 = FAIL_ZERO_EXECUTION；非 beta 对象 = FAIL_WRONG_OBJECT。',
};
