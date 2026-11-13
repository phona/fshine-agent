import type { UserCase } from '../cases';

/** E02 多条件：每条执行行都必须同时带集合与窗口；条件丢失 = 错对象。 */
export const E02: UserCase = {
  id: 'E02',
  title: '多条件查询（集合 + 窗口）',
  turns: ['帮我查一下 alpha 集合 W1 窗口的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['alpha'],
    requireEveryRowArgs: { collection: 'alpha', window: 'W1' },
    checkpoints: [{
      collection: 'alpha',
      status: 'completed',
      count: 2,
      items: [
        { name: 'alpha-item-1', value: 1200 },
        { name: 'alpha-item-2', value: 800 },
      ],
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['alpha'] },
    { kind: 'numberAny', numbers: [1200, 800] },
  ],
  weakNotes: [
    '把窗口级差异讲成事实（载荷无窗口差异）= 未溯源数字弱告警；数字挂到实体且矛盾时按跨对象污染判负',
  ],
};
