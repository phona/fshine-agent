// 用户回合文本逐字取自 scripts/eval/pi-runtime-experiment/replay.mjs（与上轮证据同源）。
const FILLER = (n: number, tag: string): string => {
  const sentences = [
    '把这件事拆成可执行的小步，每一步只解决一个明确的问题，做完就地记录事实。',
    '过程中的中间结论要能追溯到来源，不能凭印象补全，也不能把没发生的动作说成发生了。',
    '遇到信息不足时，先如实说明缺什么，再请对方补齐，不要自己替对方假设一个答案。',
    '结果交付时只讲用户看得懂的话，数字用平台返回的原文，不四舍五入也不修饰。',
    '长期运行要能续跑：状态可查、任务可数、失败可解释、取消要有回执。',
    '同一件事不要反复重做，重试只允许发生在失败之后，且必须能被审计追溯。',
    '任何结论都要给出依据；依据来自平台返回的事实，不是来自推测。',
  ];
  let out = '';
  for (let i = 0; i < n; i += 1) out += `[${tag}-${i}] ${sentences[i % sentences.length]}\n`;
  return out;
};
const fill = (tag: string, n = 130): string => `背景补充（${tag}），读完即可，不需要做任何事：\n${FILLER(n, tag)}`;

export const SCENARIOS: Record<string, { name: string; turns: string[]; failureTurns: number[] }> = {
  A: {
    name: 'A-长对话连续压缩',
    turns: [
      `先记住两件必须一直遵守的事：(1) 我的项目代号是「蓝鲸-42」；(2) 你回答我时一律用简体中文。\n${fill('A1')}`,
      `请用 run_task 让执行层查一下 collection=alpha（窗口取 recent）的记录，把条数和第一条内容告诉我。`,
      fill('A2'),
      `把刚才 alpha 查询的结果再复述一遍：条数是多少？`,
      fill('A3'),
      fill('A4'),
      `现在回答我：我最开始让你记住的项目代号是什么？我要求你用哪种语言回答？`,
      `请再次用 run_task 查 collection=alpha 的记录并给出条数。`,
      fill('A5'),
      fill('A6'),
      `到目前为止我们已经聊过哪几个主题？请按时间顺序列一下。`,
      fill('A7'),
      fill('A8'),
      `再确认一次：项目代号、必须使用的语言，这两个你分别还记得吗？`,
      fill('A9'),
      `最后：请复述我最早那段背景（A1）的主题。`,
    ],
    // 0.85.1 阶段四补的空摘要回合（1-based）：6/9/12/15
    failureTurns: [6, 9, 12, 15],
  },
  B: {
    name: 'B-多任务交替交办',
    turns: [
      `交办第一个任务：用 run_task 让执行层查 collection=alpha（窗口 recent）的记录，统计条数。`,
      `交办第二个任务：用 run_task 查 topic=budget 的 ballot（窗口 recent）结果，说明票数。`,
      `用 task_status 看一下本会话现有任务，把编号和状态列出来。`,
      fill('B1', 160),
      `用 task_result 取回第一个任务（#1）的结果，原文告诉我。`,
      fill('B2', 160),
      fill('B3', 160),
      `请回答：我最先交办的第一个任务，它的编号是多少、结果是什么？不要编造，找不到就如实说。`,
      `对 #1 发起取消请求，并按返回的机械结果如实告诉我它现在的状态。`,
      fill('B4', 160),
      fill('B5', 160),
      `我们一共交办了几个任务？分别是几号、什么状态？`,
    ],
    // 0.85.1 阶段四补的压缩后空回复回合（1-based）
    failureTurns: [9],
  },
  C: {
    name: 'C-长会话稳定性',
    turns: [
      `第 1 段背景：\n${fill('C1')}`,
      `第 2 段背景：\n${fill('C2')}`,
      `用 run_task 查 collection=alpha（窗口 recent）记录，给出条数。`,
      `第 3 段背景：\n${fill('C3')}`,
      `第 4 段背景：\n${fill('C4')}`,
      `用 run_task 再查一次 collection=alpha 的记录。`,
      `第 5 段背景：\n${fill('C5')}`,
      `第 6 段背景：\n${fill('C6')}`,
      `请给出目前为止，你对我每一段背景的要点的一句话概括。`,
      `第 7 段背景：\n${fill('C7')}`,
      `第 8 段背景：\n${fill('C8')}`,
      `第 9 段背景：\n${fill('C9')}`,
      `请确认你仍能正常工作，并复述第 1 段背景的主题。`,
    ],
    failureTurns: [],
  },
};
