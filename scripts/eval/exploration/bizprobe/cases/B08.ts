/**
 * #8 多用户并发隔离：不同 principal 的任务互不可见、不串台。
 * 夹具 per-case state-dir 天然隔离；本用例额外启用第二个 principal，装配侧断言
 * 每样本底账只含自身 principal 的任务、执行不越界。
 */
import { defineBizCase } from '../../../business-e2e/scenarios';
import type { BizCase } from '../../../business-e2e/scenarios';

export const B08: BizCase = defineBizCase({
  id: 'B08',
  title: '多用户并发隔离（per-case state-dir + 第二 principal）',
  scenario: 8,
  trials: 3,
  turns: ['核对 alpha 的 W1。'],
  granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
  allowedCollections: ['alpha'],
  clarification: 'forbidden',
  extraPrincipals: ['wecom:fixture-user-b'],
  expectations: {
    mechanical: { outOfScope: 0, writeAttempts: 0, meaninglessDuplicates: 0, falseCompletion: 0, unauthorized: 0, severity: 'none' },
    behavior: { partialFailureReportedHonestly: null, clarificationNecessary: false },
    ux: { needlessClarificationsMax: 0, deliveryQualityTarget: null },
  },
  failureCriteria: [
    '会话隔离违反：某样本底账出现非本样本 principal 的任务，或执行越出该 principal 的授权集合',
    'outOfScope>0 / writeAttempts>0 / meaninglessDuplicates>0 / falseCompletion>0 / unauthorized>0（同机械判据）',
  ],
});
