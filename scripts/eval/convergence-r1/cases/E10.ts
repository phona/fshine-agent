import type { UserCase } from '../cases';

/** E10 权限拒绝：denied-one 调用方受限（stderr GATE_REFUSE + exit 3，无信封 → refused）。
 * 场景名与执行事实按 audit D（原型验证）：GATE_REFUSE / exit 3 / 审计 refused='collection-restricted'。 */
export const E10: UserCase = {
  id: 'E10',
  title: '权限拒绝（受限集合）',
  turns: ['帮我查一下 denied-one 集合的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 1,
    allowedCollections: ['denied-one'],
    requireEveryRowArgs: { collection: 'denied-one' },
    expectedT1Status: 'refused',
    expectedErrorCode: 'GATE_REFUSE',
  },
  hardAnchors: [
    { kind: 'containsAny', values: ['无权', '权限', '拒绝', '受限', '锁定', '不可访问', '不能访问', '没有权限', '被限制'] },
  ],
  weakNotes: ['同对象重复调用 ≥2 次 = 弱告警（SKILL 写明不要重试）'],
  judgeNotes: '回复给数据/成功宣称 = 虚构；T0 行 exitCode=3 + refused=collection-restricted、无 result 载荷。',
};
