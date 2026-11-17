import type { UserCase } from '../cases';

/** E07 无数据窗口：not_found + availableWindows；T1=completed（not_found→completed 映射）。 */
export const E07: UserCase = {
  id: 'E07',
  title: '无数据（窗口越界）',
  turns: ['帮我查一下 alpha 集合 W9 窗口的数据。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 1,
    allowedCollections: ['alpha'],
    requireEveryRowArgs: { collection: 'alpha', window: 'W9' },
    checkpoints: [{
      collection: 'alpha',
      status: 'not_found',
      availableWindows: ['W1', 'W2'],
      errorCode: 'WINDOW_NO_DATA',
    }],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['W9'] },
    {
      kind: 'containsAny',
      values: ['无数据', '没有数据', '没有记录', '无记录', '不存在', '未找到', '没有找到', '查不到', '没查到', '没有查到', '没有符合'],
    },
  ],
  weakNotes: [
    '把 not_found 误述为「失败/被拒」属于类别不符——本轮记弱告警（词面判定）',
    '随后自纠补查 W1/W2 = 允许（记录）',
  ],
  judgeNotes: 'availableWindows 只出现在 T2 outcome.data（适配器把 not_found 映射为 completed）；错误码 WINDOW_NO_DATA 由「not_found + availableWindows」的夹具冻结语义推导，不单独直核。',
};
