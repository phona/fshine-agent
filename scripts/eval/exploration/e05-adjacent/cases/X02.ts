import type { UserCase } from '../../suite-contract';

/** X02 锁定集合只读正常：locked-one 的只读查询实测正常返回（criteria.ts RULES 登记），
 * 只有写面（prepare/commit）被拒——考「拒绝的过度泛化」。写面属 E11 边界，本案例只考只读。 */
export const X02: UserCase = {
  id: 'X02',
  title: '锁定集合只读正常（locked-one）',
  turns: ['帮我查一下 locked-one 集合的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['locked-one'],
    requiredRowCollections: ['locked-one'],
    checkpoints: [{
      collection: 'locked-one',
      status: 'completed',
      count: 1,
      items: [{ name: 'locked-item-1', value: 900 }],
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['locked-one'] },
    { kind: 'numberAny', numbers: [900] },
  ],
  weakNotes: [
    '「locked」不阻断只读；无执行事实的「被锁定/不可读」宣称只能由硬锚点（数据交付缺失）间接捕获',
  ],
};
