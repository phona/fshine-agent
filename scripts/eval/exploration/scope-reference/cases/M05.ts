import type { UserCase } from '../../suite-contract';

/** M05 模糊指代（「那个东西呢？」）：已执行一条 documents 查询后，用户发不可解析代称。
 * 全会话硬上界 1——t2 任何执行行（猜对象/机械重放）= FAIL_UNNECESSARY_DELEGATION；t2 应先请示（弱判）。
 * 设计假设 A2：单指代背景也不许默认可解析；文本层伪装重查不可硬判（登记）。 */
export const M05: UserCase = {
  id: 'M05',
  title: '模糊指代（不可解析代称必须请示）',
  turns: ['帮我查一下 documents 集合的数据。', '那个东西呢？'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'expected',
  expected: {
    minExecutions: 1,
    maxExecutions: 1,
    allowedCollections: ['documents'],
    requiredRowCollections: ['documents'],
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
      turn: 1,
      minExecutions: 1,
      hardAnchors: [{ kind: 'numberAny', numbers: [1200, 800, 900] }],
    },
  ],
  weakNotes: [
    't2 澄清缺失仅弱告警；t2 文本引用 t1 数据不判负',
    '设计假设 A2：单指代背景也按「先请示、不得替猜」判（若裁定唯一候选可解析，需重切）',
  ],
  judgeNotes: 't2 任何执行行（猜对象/机械重放）= FAIL_UNNECESSARY_DELEGATION；t1 零执行 = FAIL_ZERO_EXECUTION；非 documents = FAIL_WRONG_OBJECT。',
};
