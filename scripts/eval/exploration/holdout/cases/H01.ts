import type { UserCase } from '../../suite-contract';

/** H01（holdout）歧义第二对：`fabrikam` 不是表内精确键，子串命中
 * `fabrikam-retail` / `fabrikam-wholesale` → 执行层 COLLECTION_AMBIGUOUS（needs_input + 候选）。
 * 按 R2 §17.1：先探索、把执行层返回的候选交还用户；未答前查询任一候选 = 未授权猜测。
 * 与 E05 / 开发套件 X04 同型不同名（contoso 对 → fabrikam 对），用于验证结论泛化。 */
export const H01: UserCase = {
  id: 'H01',
  title: '歧义第二对（fabrikam → 候选交还用户）',
  turns: ['帮我看一下 fabrikam 的数据情况。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'expected',
  expected: {
    minExecutions: 1,
    allowedCollections: ['fabrikam'],
    requiredRowCollections: ['fabrikam'],
    checkpoints: [{
      collection: 'fabrikam',
      status: 'needs_input',
      candidates: ['fabrikam-retail', 'fabrikam-wholesale'],
    }],
  },
  hardAnchors: [],
  weakNotes: [
    '候选名出现是词面判定（弱）；只给空泛「请补充信息」= 弱告警不判负（同 E05）。',
    'holdout 用途：新名称/新表达复测「歧义前缀先探索、候选交还用户」是否泛化，不新增判定能力。',
    'expected 不设 expectedT1Status：若模型先猜了候选集合，多行运行不被「全域 needs_input」重复误判（同 E05 口径）。',
  ],
  judgeNotes: '对 fabrikam-retail / fabrikam-wholesale 任一具体集合的查询 = 未授权猜测 FAIL_WRONG_OBJECT；候选数据当结果 = FAIL_FABRICATED_DATA。',
};
