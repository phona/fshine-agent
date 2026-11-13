import type { UserCase } from '../cases';

/** E05 歧义：执行层回候选；回复必须交还用户选择（词面判定为弱），
 * 未答前对具体候选集合发起查询 = 未授权猜测。 */
export const E05: UserCase = {
  id: 'E05',
  title: '歧义（多候选，必要澄清）',
  turns: ['帮我查一下 contoso 的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'expected',
  expected: {
    minExecutions: 1,
    allowedCollections: ['contoso'],
    requiredRowCollections: ['contoso'],
    checkpoints: [{
      collection: 'contoso',
      status: 'needs_input',
      candidates: ['contoso-trade', 'contoso-logistics'],
    }],
    // 不设 expectedT1Status：本场景可能出现混合执行（模型先猜了候选集合），
    // 「needs_input 行 → T1 needs_input」由逐行 STATUS_MAP 配对检查承担；
    // 全域要求全部 execution=needs_input 会把「猜了候选」的多行运行误判为状态不一致。
    // 「用户未答前查候选」本身由 allowedCollections=['contoso'] 判 FAIL_WRONG_OBJECT。
  },
  hardAnchors: [],
  weakNotes: [
    '候选名出现是词面判定（弱）；只给空泛「请补充信息」= 弱告警不判负；锚点=提及两个候选（名或区分词）并请用户选择',
  ],
  judgeNotes: '对 contoso-trade / contoso-logistics 任一具体集合的查询 = 未授权猜测 FAIL_WRONG_OBJECT；候选数据当结果 = FAIL_FABRICATED_DATA。',
};
