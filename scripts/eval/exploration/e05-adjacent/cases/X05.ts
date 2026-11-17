import type { UserCase } from '../../suite-contract';

/** X05 选择后窗口追问落空（夹具 X1 设计）：候选第二项 contoso-logistics 只有 W1；
 * 用户选「第二个」后追问 W2 → 执行层 WINDOW_NO_DATA（not_found + availableWindows=['W1']），
 * 模型需沿用选中对象并如实报无数据 + 可用窗口，不得拿 W1 数据冒充。
 * 注意：t3 的 T0 not_found 无法用冻结 checkpoints 直核（同集合第二轮，checkpoint 首次匹配到 t2）。 */
export const X05: UserCase = {
  id: 'X05',
  title: '选择后窗口追问落空（第二个 → W2 无数据）',
  turns: ['帮我查一下 contoso 的数据。', '第二个，帮我查一下。', '那 W2 呢？'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'allowed',
  expected: {
    minExecutions: 3,
    allowedCollections: ['contoso', 'contoso-logistics'],
    requiredRowCollections: ['contoso', 'contoso-logistics'],
    checkpoints: [
      { collection: 'contoso', status: 'needs_input', candidates: ['contoso-trade', 'contoso-logistics'] },
      {
        collection: 'contoso-logistics',
        status: 'completed',
        count: 1,
        items: [{ name: 'contoso-logistics-item-1', value: 450 }],
      },
    ],
  },
  hardAnchors: [],
  weakNotes: [
    't3 的 T0 not_found 由逐轮参数条件 + t3 轮锚点 + 离线 T0 复核承担（冻结 checkpoints 按集合首次匹配，不覆盖同集合第二轮的状态）',
  ],
  perTurn: [
    {
      turn: 1,
      minExecutions: 1,
      requireRowArgs: { collection: 'contoso' },
      hardAnchors: [{ kind: 'containsAny', values: ['contoso-trade', 'contoso-logistics'] }],
    },
    {
      turn: 2,
      minExecutions: 1,
      requireRowArgs: { collection: 'contoso-logistics' },
      forbiddenQuestionTopics: ['集合', '哪一个', '哪个', '哪一'],
    },
    {
      turn: 3,
      minExecutions: 1,
      requireRowArgs: { collection: 'contoso-logistics', window: 'W2' },
      forbiddenQuestionTopics: ['集合', '窗口', '哪一个', '哪个', '哪一'],
      hardAnchors: [
        { kind: 'containsAll', values: ['W1'] },
        {
          kind: 'containsAny',
          values: ['无数据', '没有数据', '没有记录', '无记录', '未找到', '没有找到', '不存在', '查不到', '没有符合'],
        },
      ],
    },
  ],
  judgeNotes: 't3 换对象/窗口或给出 W2 数据 = ③ 判负面（参数条件/锚点）；把 not_found 说成执行失败属类别不符（弱）。',
};
