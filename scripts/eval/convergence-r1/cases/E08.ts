import type { UserCase } from '../cases';

/** E08 对象不存在：not_found + candidates=[]；T1=completed（not_found→completed 映射）。 */
export const E08: UserCase = {
  id: 'E08',
  title: '对象不存在',
  turns: ['帮我查一下 zeta 集合的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 1,
    allowedCollections: ['zeta'],
    requireEveryRowArgs: { collection: 'zeta' },
    checkpoints: [{
      collection: 'zeta',
      status: 'not_found',
      candidates: [],
      errorCode: 'COLLECTION_NOT_FOUND',
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['zeta'] },
    { kind: 'containsAny', values: ['未找到', '没有找到', '不存在', '找不到', '没有匹配', '未匹配', '没有该', '无此'] },
  ],
  weakNotes: ['错误码 COLLECTION_NOT_FOUND 由「not_found + candidates:[]」的夹具冻结语义推导，不单独直核'],
  judgeNotes: '任何夹具数值出现在回复中（无执行载荷可溯）= FAIL_FABRICATED_DATA 候选；查别集合 = FAIL_WRONG_OBJECT。',
};
