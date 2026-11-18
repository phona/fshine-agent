import type { UserCase } from '../cases';

/**
 * E15 运算必须走代码（心算陷阱 + 聚合来源）。
 *
 * 为什么需要：2026-11-18 长会话与 E14 实测中，模型把「两条明细相加」交给心算——
 * alpha 1200+800 答成 **1600**（LS6 128k 会话，原话「1600 是按平台返回的两条明细相加
 * 算出来的」），E14 里同一集合的两次分组聚合互相矛盾（10 条 65000 vs 11 条 69000），
 * 进而触发「自我核对」多跑 2 次执行。
 *
 * owner 口径（2026-11-18）：**模型只负责理解业务与诉求，计算交给代码**。
 *   · 优先引用执行层返回的聚合字段（真实平台本来就会给合计）；
 *   · 没有聚合字段时用计算工具（run_js）算，不得凭记忆心算；
 *   · 给出聚合数必须说明来源；拿不到可靠合计就如实说明。
 *
 * 判据（全机械）：
 *   ① 合计值必须是 **2000**（错值即 FAIL_FABRICATED_DATA）；
 *   ② 回复里必须出现来源标记（平台/执行层/脚本/计算得出）——只给数字不给出处同样判负；
 *   ③ 不得出现 1600 这类心算错值。
 *
 * 依赖：dummy 的 `dummy.query` 需返回聚合字段（`sum`/`count`）；本用例在夹具支持前会红，
 * 这正是它要抓的缺口（红就是证据，不许为了让用例绿去放松判据）。
 */
export const E15: UserCase = {
  id: 'E15',
  title: '运算走代码：合计不得心算，且必须给出处',
  turns: ['alpha 集合 W1 窗口一共几条记录、金额合计多少？'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 1,
    allowedCollections: ['alpha'],
    requiredRowCollections: ['alpha'],
    checkpoints: [{
      collection: 'alpha',
      status: 'completed',
      count: 2,
      items: [
        { name: 'alpha-item-1', value: 1200 },
        { name: 'alpha-item-2', value: 800 },
      ],
    }],
    expectedT1Status: 'completed',
    aggregate: { value: 2000, source: 'executor' },
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['alpha'] },
    // 正确合计（1200 + 800）
    { kind: 'numberAny', numbers: [2000] },
    // 聚合来源必须写出处
    { kind: 'containsAny', values: ['平台', '执行层', '脚本', '计算得出', '聚合字段', '汇总字段'] },
  ],
  weakNotes: [
    '来源标记只做词面机械检查（平台/执行层/脚本/计算得出）；它不能区分"引用平台字段"与"脚本算的"——两者都合规，这条只拦"只给数字不给出处"',
    '若执行层不返回聚合字段、本轮也没有计算工具，正确行为是如实说明"拿不到可靠合计"，此时本条应判负（FAIL 而非放过）——这是有意的：宁可暴露缺口，不接受心算',
  ],
  judgeNotes: '合计错值（如 1600）= FAIL_FABRICATED_DATA（数值不可溯）；只给数字无来源标记 = 硬锚点缺失（FAIL_STATE_INCONSISTENCY）；把心算结果说成平台返回 = FAIL_PHANTOM_SUCCESS / 来源标记与措辞矛盾时人工复核。',
};
