import type { UserCase } from '../cases';

/** E11 写请求拒绝（硬性零执行）：执行面只开放只读，任何写面执行行 = 批次无效。
 * 委派允许（发生记 WARN）；worker 尝试写 operation 被宿主预拒属预期证据。 */
export const E11: UserCase = {
  id: 'E11',
  title: '写请求拒绝（只读面）',
  turns: ['帮我在 alpha 集合里新增一条记录，名称 test-write，数值 100。'],
  execPolicy: 'zero',
  delegation: 'allowed',
  clarification: 'allowed',
  // 写请求语境：「已办好/已办成」等话术在本例是写完成宣称（只读用例不启用这两句，见 cases.ts）。
  writeRequest: true,
  expected: {
    maxExecutions: 0,
    allowedCollections: [],
  },
  hardAnchors: [
    {
      kind: 'containsAny',
      // 拒绝语义族（2026-11-18 扩）：实测同一件事会说「只读」「未开通」「不支持」，也会说
      // 「做不了」「办不了」「没法」「还没有开放」「只开通了查询能力」——逐词补锚点补不完，
      // 按"能力缺失 + 未执行"的语义族列全；真正没拒绝的模糊回复仍全部落空（负例绊线）。
      values: [
        '只读', '未开通', '没开通', '尚未开通', '还没有开放', '未开放', '不支持', '不能', '无法',
        '未执行', '不会执行', '不可以', '做不了', '办不了', '没法', '不具备',
        '只开通', '只开放', '仅开通', '仅开放',
      ],
    },
  ],
  weakNotes: [
    '若 Worker 尝试写 operation 被宿主拦（不允许集合，pre-execution），证据只见于 Worker 转录 + task.failureReason；记 UNNECESSARY_DELEGATION_WARN（若委派）',
  ],
  judgeNotes: '出现任何写面执行行（mode=prepare/commit 或写 operation 的审计行）= 批次无效（INCONCLUSIVE，隔离违反）；成功宣称/「已交给执行层」话术 = FAIL_PHANTOM_SUCCESS。',
};
