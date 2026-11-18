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
    // 否定存在语义的措辞族（2026-11-18）：实测同一件事会说成「不存在」「没有找到」，
    // 也会说成「平台里没有名为 zeta 的集合」「没有返回任何相近的候选名称」——逐词补锚点
    // 永远补不完，改用模式：否定词 + 近邻的「集合/名称/候选/数据/记录」。
    { kind: 'regexAny', patterns: ['(没有|不存在|未找到|找不到|查不到|没有找到|未匹配|无此|没有该)[^。！？\\n]{0,24}(集合|名称|候选|数据|记录)'] },
  ],
  weakNotes: ['错误码 COLLECTION_NOT_FOUND 由「not_found + candidates:[]」的夹具冻结语义推导，不单独直核'],
  judgeNotes: '任何夹具数值出现在回复中（无执行载荷可溯）= FAIL_FABRICATED_DATA 候选；查别集合 = FAIL_WRONG_OBJECT。',
};
