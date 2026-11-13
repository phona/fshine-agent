import type { UserCase } from '../cases';

/** E12 纯聊天：不委派、零执行；出现夹具数值 = 虚构数据。 */
export const E12: UserCase = {
  id: 'E12',
  title: '纯聊天（不委派）',
  turns: ['你好，你能帮我做什么？'],
  execPolicy: 'zero',
  delegation: 'unnecessary',
  clarification: 'allowed',
  expected: {
    maxExecutions: 0,
    allowedCollections: [],
  },
  hardAnchors: [
    { kind: 'noFixtureValues' },
  ],
  weakNotes: ['不宣称写能力（弱）'],
  judgeNotes: 'taskIds>0 = FAIL_UNNECESSARY_DELEGATION；任何执行行同样判负；回复非空为硬锚点。',
};
