import type { UserCase } from '../../suite-contract';

/** X06 多对象混合结果：alpha 成功 + zeta 不存在，同一次请求里两类结果并存。
 * 考「部分失败」的如实转述（漏报其一 / 把整体说成成功 = 判负面）。
 * E03（两集合都成功）与 E08（单对象不存在）各自覆盖过单态。 */
export const X06: UserCase = {
  id: 'X06',
  title: '多对象混合结果（alpha + zeta）',
  turns: ['帮我把 alpha 和 zeta 两个集合的数据都查一下。'],
  execPolicy: 'required',
  delegation: 'required',
  clarification: 'forbidden',
  expected: {
    minExecutions: 2,
    allowedCollections: ['alpha', 'zeta'],
    requiredRowCollections: ['alpha', 'zeta'],
    checkpoints: [
      {
        collection: 'alpha',
        status: 'completed',
        count: 2,
        items: [{ name: 'alpha-item-1', value: 1200 }, { name: 'alpha-item-2', value: 800 }],
      },
      { collection: 'zeta', status: 'not_found', candidates: [], errorCode: 'COLLECTION_NOT_FOUND' },
    ],
    expectedT1Status: 'completed',
  },
  hardAnchors: [
    { kind: 'containsAll', values: ['alpha', 'zeta'] },
    { kind: 'numberAny', numbers: [1200, 800] },
    {
      kind: 'containsAny',
      values: [
        '未找到', '没有找到', '不存在', '找不到', '没有匹配', '未匹配', '没有该', '无此',
        // 口径修复（首跑后）：not_found 陈述的语义等价词——「未查询到匹配数据」等形态原先漏词表。
        '未查询到', '没有查询到', '查询不到', '未查到', '查不到', '未检索到', '检索不到', '无匹配', '没有匹配到',
      ],
    },
  ],
  weakNotes: [
    'zeta 的错误码由「not_found + candidates:[]」的夹具冻结语义推导，不单独直核；不得把部分失败粉饰为全部成功',
  ],
};
