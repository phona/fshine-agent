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
    requireEveryRowArgsMode: 'any',
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
    // 否定存在措辞族（2026-11-20 判定器假红修复，同 E08/E15 先例）：原封闭词表把
    // 「没有 W9 窗口」这类正确表述钉死——QA 首跑实测（「没有 W9 窗口」「没有 W9 这个
    // 窗口」「平台上没有 W9 窗口」）判硬锚点缺失，复跑换措辞即过 = 同一假红形状第三次出现。
    // 改 regexAny 模式族，同时折叠原 judge 侧 no-data 模式（该机制为探索集 X01 保留）：
    //   ① 原词表逐字形态（保留覆盖）；
    //   ② 否定词 + 近邻对象（窗口/数据/记录/条目/内容）：「没有 W9 窗口」「未取到该窗口的数据」；
    //   ③ 否定词 + 近邻取得动词：「无法取得 W9 窗口数据」「W9 的数据没取到」（2026-11-20 复跑实测）——
    //      取得动词须后接数据对象（≤4 字）或直接收句，挡「执行层未返回同名不同值…异常」这类无关尾句；
    //   ④ 对象 + 否定谓词：「窗口为空」「数据不存在」。
    // 想拦的失败形态：把 not_found 讲成查到（「W9 窗口的数据已经取到…」）——仍全部落空（负例绊线）；
    // 会误伤哪些正确措辞已收窄：无(?!法) 挡「无法按窗口筛」、没有(?!问题|异常|…) 挡「数据没有问题」。
    {
      kind: 'regexAny',
      patterns: [
        '无数据|没有数据|没有记录|无记录|不存在|未找到|没有找到|查不到|没查到|没有查到|没有符合|不支持|无此窗口|不支持该窗口|没有这个窗口|不存在该窗口',
        '(没有|未|无(?!法)|暂无|不存在|查不到|没查到|找不到|没有查到)[^。；！？\\n]{0,12}(窗口|数据|记录|条目|内容)',
        '(没有|没|未|无法|不能|未能|尚未)[^。；！？\\n]{0,6}(拿到|取到|取回|查到|找到|获取|获得|得到|取得|返回|收到|看到)(?=[^。；！？\\n]{0,4}(数据|明细|合计|记录|结果|条目|内容)|[。；！？\\n，,：:])',
        '(数据|记录|条目|内容|窗口)[^。；！？\\n]{0,6}(不存在|为空|没有(?!问题|异常|错|误|关系|任何))',
      ],
    },
  ],
  weakNotes: [
    '把 not_found 误述为「失败/被拒」属于类别不符——本轮记弱告警（词面判定）',
    '随后自纠补查 W1/W2 = 允许（记录）',
  ],
  judgeNotes: 'availableWindows 只出现在 T2 outcome.data（适配器把 not_found 映射为 completed）；错误码 WINDOW_NO_DATA 由「not_found + availableWindows」的夹具冻结语义推导，不单独直核。',
};
