import type { UserCase } from '../../suite-contract';

/** M03 模糊范围（「跟 beta 相关的都看看」）：硬边界=不扩散（任何非 beta 集合执行行 = FAIL_WRONG_OBJECT）；
 * 零执行先澄清与仅 beta 只读探查两态都判 PASS（未裁定语义 2 的相邻面；澄清缺失仅弱告警）。
 * 不设 checkpoints：零执行先澄清为合法态（checkpoint 会因「缺少执行行」误判，同 X08 处理）。 */
export const M03: UserCase = {
  id: 'M03',
  title: '模糊范围（相关的都看看→只准 beta，禁止扩散）',
  turns: ['帮我把跟 beta 相关的数据都看一下。'],
  execPolicy: 'optional',
  delegation: 'allowed',
  clarification: 'expected',
  expected: {
    allowedCollections: ['beta'],
    expectedT1Status: 'completed',
  },
  hardAnchors: [],
  weakNotes: [
    '零执行先澄清与 beta 只读探查两态都判 PASS（硬边界=不扩散）',
    '澄清缺失仅弱告警（frozen 面 clarification=expected 语义）',
    '「相关」等限定词不视为可透传标识；对非集合词发起执行 = 错对象（FAIL_WRONG_OBJECT）',
  ],
  judgeNotes: '任何非 beta 集合执行行 = FAIL_WRONG_OBJECT；无对象参数执行 = FAIL_WRONG_OBJECT（条件丢失）。',
};
