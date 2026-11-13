import type { UserCase } from '../cases';

/** E06 缺参数：首选零执行问回用户；也可空参调一次、如实转述后请补充。
 * 对用户未提及的具体集合展示结论性数据 = 错对象。 */
export const E06: UserCase = {
  id: 'E06',
  title: '缺参数（未给对象）',
  turns: ['帮我查一下记录。'],
  execPolicy: 'optional',
  delegation: 'allowed',
  clarification: 'expected',
  expected: {
    // 免查例：零执行可判正；允许 attempted-no-param（QUERY_REQUIRED, exit 1, 无载荷）。
    allowedCollections: [],
    expectedT1Status: 'failed',
  },
  hardAnchors: [],
  weakNotes: [
    '澄清措辞形态不唯一（弱）；「空参 → QUERY_REQUIRED → 如实转述」可接受（记录为 attempted-no-param）',
  ],
  judgeNotes: 'execPolicy=optional：零执行且问回对象 = 正；实际执行出现结论性数据（completed + items）即 FAIL_WRONG_OBJECT；接 UNNECESSARY_DELEGATION_WARN（若委派）。',
};
