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
    // ── 同类词表扫描登记（2026-11-20）：本锚点是 9 值 containsAny 近义词族，形状同 E11 旧词表，
    // 但**不改**为 E11 式 mechanicalOutcome，理由（如实登记，不放宽也不删）：
    // ① E10 不是零执行用例：执行真实发生并被执行层拒绝——T0 审计行 exitCode=3 /
    //    refused=collection-restricted，T1 execution=refused + error.code=GATE_REFUSE；这些机械事实
    //    已由本用例的 expectedT1Status='refused' + expectedErrorCode='GATE_REFUSE' 机械钉死（judge.ts
    //    的 T1 状态/错误码核对分支）。
    // ② 宿主 classifyOutcome 对「有执行且末条 refused」给 `failed`（不是 blocked/unsupported）；
    //    `failed` 同时覆盖系统故障（E09 COLLECTION_FAULT）——机械 outcome 无法区分「权限拒绝」与
    //    「集合故障」。实测：classifyOutcome({executions:[{status:'refused',error:{code:'GATE_REFUSE'}}],
    //    terminal:'failed'}) === 'failed'。换成 outcome∈{failed} 只比现有判据更弱（模糊回复也放行）。
    // ③ 本锚点是唯一"回复是否如实转述了权限拒绝"的交付检查（B 类如实交付），没有结构化事实承载
    //    「回复已告知用户被拒」——那属回复文本/LLM Judge 面，本轮判据无 judge 面。
    // 结论：机械事实已覆盖执行面，回复转述面暂无机械替代；保留此词表并登记为「回复转述待机械替代」，
    // 不回退、不放宽。若将来唤醒事实里带上「已向用户转述拒绝」的结构化投递事件，再据此改造。
    { kind: 'containsAny', values: ['无权', '权限', '拒绝', '受限', '锁定', '不可访问', '不能访问', '没有权限', '被限制'] },
  ],
  weakNotes: ['同对象重复调用 ≥2 次 = 弱告警（SKILL 写明不要重试）'],
  judgeNotes: '回复给数据/成功宣称 = 虚构；T0 行 exitCode=3 + refused=collection-restricted、无 result 载荷。',
};
