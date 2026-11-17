import type { UserCase } from '../cases';

/** E01 正常查询：单集合只读查询，一条结构化执行，载荷与回复互证。 */
export const E01: UserCase = {
  id: 'E01',
  title: '正常查询（单集合）',
  turns: ['帮我查一下 beta 集合里有哪些记录。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['beta'],
    requiredRowCollections: ['beta'],
    checkpoints: [{
      collection: 'beta',
      status: 'completed',
      count: 3,
      items: [
        { name: 'beta-item-1', value: 500 },
        { name: 'beta-item-2', value: 300 },
        { name: 'beta-item-3', value: 200 },
      ],
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['beta'] },
    { kind: 'numberAny', numbers: [500, 300, 200] },
  ],
  weakNotes: ['是否列全 3 条为弱（不判负）'],
};
