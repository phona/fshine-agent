import type { UserCase } from '../../suite-contract';

/** X03 单命中子串解析：logistics 不是表内名称，但作为子串在夹具里只命中 contoso-logistics。
 * 按 R2 §17.1 的延伸解读，先把用户原词交执行层裁决（执行层单命中即解析），再如实交付。
 * 注意：checkpoint 按参数值 logistics 匹配（judge 的 rowTargets 取 args）。 */
export const X03: UserCase = {
  id: 'X03',
  title: '单命中子串解析（logistics → contoso-logistics）',
  turns: ['帮我查一下 logistics 的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['logistics', 'contoso-logistics'],
    requiredRowCollections: ['logistics'],
    checkpoints: [{
      collection: 'logistics',
      status: 'completed',
      count: 1,
      items: [{ name: 'contoso-logistics-item-1', value: 450 }],
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAny', values: ['contoso-logistics', 'logistics'] },
    { kind: 'numberAny', numbers: [450] },
  ],
  weakNotes: [
    '透传用户原词是 R2 §17.1 的延伸解读（只裁过「歧义句柄先探索」）；若 owner 裁定「按规范名直接查询」也可接受，本案例的 allowedCollections/checkpoint 需同步放宽',
  ],
};
