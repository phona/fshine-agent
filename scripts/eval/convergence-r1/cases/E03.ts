import type { UserCase } from '../cases';

/** E03 多步查询：两个独立对象分别查；只覆盖一个集合 = 错对象。 */
export const E03: UserCase = {
  id: 'E03',
  title: '多步查询（两个集合）',
  turns: ['帮我把 alpha 和 beta 两个集合的数据分别查一下。'],
  execPolicy: 'required',
  delegation: 'allowed',
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
  hardAnchors: [
    { kind: 'containsAll', values: ['alpha', 'beta'] },
    { kind: 'numberAny', numbers: [1200, 800] },
    { kind: 'numberAny', numbers: [500, 300, 200] },
  ],
  weakNotes: ['两集合数据互串（名称-数值配对错误）按跨对象污染硬判；其余归属模糊按弱告警'],
};
