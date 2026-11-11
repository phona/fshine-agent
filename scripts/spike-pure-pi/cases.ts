/**
 * 17dz 域的 C1/C2/A2/D2 轮次脚本。
 *
 * 来源与改写说明：
 * - 用例结构（轮次、线程、召回/澄清/总结的落点）来自仓史里 17dz 真平台版探针
 *   （`git show 7654e2a^:scripts/probe-real-agent.ts` 的 C1/C2/A2/D2 条目）。
 * - HEAD 的 `scripts/eval/cases.yaml` 同名条目已端口到 dummy 域
 *   （collection/window/record），与本次要跑的 17dz 网关对不上，故不直接采用。
 * - 17dz mock 种子（`src/execution/mocks/fixtures/seed.json`）里的账套名是
 *   黔隆财税 / 黔隆实业有限公司 / 新兴五金 / 新兴建材；原用例里的
 *   幻辰财税 / 幻辰实业有限公司 做同形改名（线程数、歧义关系、期间不变）。
 * - D2 用当前语料的扇出形状，落到 17dz 即 4 个账套 ×（本期 + 202606 + 202607）
 *   = 12 次查询：calls 12、weight 72、seconds 720，平台自己的线判到 confirm
 *   （估算值来自真实 `plan evaluate` 实测，见提交说明；未改任何门限）。
 */

export interface CaseTurn {
  text: string;
  /** 该轮是否为确认回复（宿主据此放行已停在确认门的计划）。 */
  confirmation?: boolean;
}

export interface SpikeCase {
  id: string;
  title: string;
  turns: CaseTurn[];
  /** 只有回复里出现确认询问时才追加的轮次（D2 的 followUp）。 */
  followUpOnConfirm?: CaseTurn[];
}

export const SELF_CHECK: SpikeCase = {
  id: 'SELF',
  title: '单轮自检：提交计划、查到数、给出回复',
  turns: [{ text: '查一下新兴五金本期的应收账款' }],
};

export const DEBUG_PLAN: SpikeCase = {
  id: 'DEBUG',
  title: '两轮自检：指定期间查询 + 指代同账套的另一期间（计划绑定路径）',
  turns: [
    { text: '查一下新兴五金账套 202609 的应收账款' },
    { text: '这个账套 202608 呢？' },
  ],
};

export const A2: SpikeCase = {
  id: 'A2',
  title: '新问题不带旧账套：先查黔隆财税本期应收，再问一个目录里没有的"猫一杯"',
  turns: [
    { text: '查一下黔隆财税账套本期的应收账款' },
    { text: '帮我查一下猫一杯的应收账款还有多少' },
  ],
};

export const C1: SpikeCase = {
  id: 'C1',
  title: '20 轮混合对话：两个账套、期间切换、闲聊、召回、目录检索、凭证、总结',
  turns: [
    { text: '你好，你能做什么？' },
    { text: '查一下新兴五金账套 202609 的应收账款' },
    { text: '这个账套 202608 呢？' },
    { text: '那把 202607 也看一下' },
    { text: '辛苦了，先聊点别的：现在几月份？' },
    { text: '刚才我让你查的那三个期间，哪个余额最高？' },
    { text: '帮我查一下猫一杯的应收账款还有多少' },
    { text: '算了，不问余额了。只查账套目录，有没有新兴建材这个帐套' },
    { text: '有的话它的 202609 应收是多少？' },
    { text: '下一页' },
    { text: '刚才查的是哪个账套？' },
    { text: '把新兴五金的凭证也列一下' },
    { text: '只列 202609 的' },
    { text: '谢谢你' },
    { text: '再帮我查一次新兴五金 202609 的应收账款' },
    { text: '和刚才的结果一样吗？' },
    { text: '如果不一样以哪次为准？' },
    { text: '帮我查一下黔隆财税的应收账款' },
    { text: '这个账套 202609 的凭证有多少张？' },
    { text: '总结一下我们今天查了些什么' },
  ],
};

export const C2: SpikeCase = {
  id: 'C2',
  title: '30 轮超长会话：4 账套轮转、话题切换、两次澄清-选择、跨轮召回、总结不塌缩',
  turns: [
    { text: '你好，你能做什么？' },
    { text: '查一下黔隆财税账套本期的应收账款' },
    { text: '这个账套 202608 呢？' },
    { text: '那把 202606 也看一下' },
    { text: '辛苦了，先聊点别的：现在几月份了？' },
    { text: '刚才那两期哪个余额高？' },
    { text: '帮我查一下新兴的应收账款' },
    { text: '第一个' },
    { text: '那把 202607 也看一下' },
    { text: '谢谢，换个话题：今天星期几？' },
    { text: '对了，新兴五金刚才查出来是多少？' },
    { text: '新兴建材的呢？' },
    { text: '新兴五金和新兴建材哪个余额高？' },
    { text: '那黔隆的银行存款有多少？' },
    { text: '第一个' },
    { text: '黔隆实业有限公司的银行存款呢' },
    { text: '把黔隆财税 202607 的凭证列一下' },
    { text: '辛苦了，先聊点别的：你能帮我写周报吗？' },
    { text: '今天我们查过哪几个账套？' },
    { text: '把它们本期的应收余额报一遍' },
    { text: '查一下幻东建材的应收账款' },
    { text: '那黔隆财税的应付账款呢' },
    { text: '辛苦了，先聊点别的：给我讲个笑话' },
    { text: '回到正事，黔隆财税 202606 的应收是多少来着' },
    { text: '黔隆财税和新兴五金哪个余额高？' },
    { text: '再帮我查一次新兴建材本期的应收' },
    { text: '和刚才的结果一样吗？' },
    { text: '如果不一样以哪次为准？' },
    { text: '把今天查过的账套和结论整理一下' },
    { text: '谢谢你，辛苦了' },
  ],
};

export const D2: SpikeCase = {
  id: 'D2',
  title: '高重量扇出：4 账套 ×（本期 + 202606 + 202607）应收，应先停在确认门',
  turns: [{ text: '把所有账套本期、202606 和 202607 的应收账款都查一遍' }],
  followUpOnConfirm: [{ text: '确认继续', confirmation: true }],
};

export const CASES: Record<string, SpikeCase> = {
  SELF: SELF_CHECK,
  DEBUG: DEBUG_PLAN,
  A2,
  C1,
  C2,
  D2,
};

export function caseById(id: string): SpikeCase {
  const found = CASES[id];
  if (!found) {
    throw new Error(`未知用例 ${id}（可选：${Object.keys(CASES).join(', ')}）`);
  }
  return found;
}
