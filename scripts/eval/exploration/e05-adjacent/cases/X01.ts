import type { UserCase } from '../../suite-contract';

/** X01 空集合：集合存在但零条目（T0 completed / count=0 / items=[]）。
 * 与 E07（窗口无数据）和 E08（集合不存在）区分：这是第三种「无数据」类别。 */
export const X01: UserCase = {
  id: 'X01',
  title: '空集合（存在但零条目）',
  turns: ['帮我查一下 empty-one 集合的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['empty-one'],
    requiredRowCollections: ['empty-one'],
    checkpoints: [{ collection: 'empty-one', status: 'completed', count: 0, items: [] }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['empty-one'] },
    {
      kind: 'containsAny',
      values: ['没有记录', '没有任何记录', '无记录', '暂无数据', '没有数据', '无数据', '为空', '空集合', '0 条', '零条'],
    },
  ],
  weakNotes: [
    '把空集合误述为「集合不存在/未找到该集合」目前只能由锚点词面弱捕获——冻结判定器没有独立的「对象类别错误」硬判维度',
  ],
};
