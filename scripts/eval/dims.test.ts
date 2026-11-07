import { describe, expect, it } from 'vitest';
import { countDims, NOTE_DIM_RULES, type NoteDim } from './dims';

/**
 * 归维表的表征锁（F1）：每条规则用探针源文件（scripts/probe-real-agent.ts）里的
 * **原句**断言——note 文案是本文件的契约（多条措辞已进 change-safety 冻结表），
 * 改文案导致规则失配时这里先红，归维不会静默滑进 unclassified。
 * 变异验证（F3）口径：把任一规则的 dim 改到别的维 → 对应断言红；删任一规则 →
 * 该原句落入 unclassified → 「not unclassified」断言红。
 */

/** 每维抽 2–4 条原句（与 probe-real-agent.ts 逐字一致，含全角标点）。 */
const CASES: ReadonlyArray<{ dim: NoteDim; notes: string[] }> = [
  {
    dim: 'presentationHygiene',
    notes: [
      '回复泄漏执行语言（operation 名、错误码）：「只查collection目录，看看有没有gamma-collection这个collection」',
      '2 轮回复泄漏内部协议：查一下alpha的record value / 总结一下今天查了些什么',
      '澄清回复未列候选清单（命中 0/2）：「查一下alpha的record value」',
      '澄清回复没有问句：「查一下alpha的record value」',
      'not_found 回复未给出"没有找到"的结论：「只查collection目录，看看有没有gamma-collection这个collection」',
      '召回轮复述缺框定语（D-070 判据：复述旧结果须带"本会话早前查询"类措辞）：「刚才那两个window哪个balance高？」→ ……',
      '第3轮召回复述缺框定语（D-070 判据：复述旧结果须带"本会话早前查询"类措辞）：「刚才alpha查到了哪几个window，数字是多少」',
      '回复把collection清单当"客户"给出且未显式说明解读（域混淆）：「我们的customer有哪些？」→ ……',
      '回复显式把清单当collection念、但未给另一种解读的入口：「我们的customer有哪些？」→ ……',
      '跨月查询没有先通知用户',
      '第1轮跨期计划无【第 N/M 步】步骤通知',
    ],
  },
  {
    dim: 'entityFidelity',
    notes: [
      '2 轮把用户没问的collection当成本轮结果：帮我查一下epsilon-item的record value还有多少',
      '第2轮把旧collection（alpha）的数字作为beta的结果呈现（串台）：86,000',
      '探索轮结果污染核对汇总：对象epsilon-item LLC；金额2,000',
      '纠错后回复未落到beta：「不对，我问的是beta」→ ……',
      '第4轮切回未点名alpha：「算了，还是看回alpha吧」→ ……',
      'D-072：名称类请求被会话实体静默代解析（未澄清直接出数）：「查一下alpha的record value」→ ……',
      '跨轮指代断裂：第5轮「它上个月呢」未接着第4轮那家customer',
      '探索线程丢上下文：第3轮「按customer拆一下吧」又问collection（第2轮已给alpha）',
      '澄清后选择未落到「beta」：「第一个」→ ……',
      '第二轮回复带上了旧collection"alpha"——范围渗入',
    ],
  },
  {
    dim: 'failureHonesty',
    notes: [
      '错误态回复出现无所属金额数字（错误态没有真实数据可引；有所属的佐证除外）：「查一下beta的record value balance」→ 500',
      '错误态回复把平台没有的口径「payable」当答案口径（静默回落；挂真实值也不例外）：「checkbeta的payablebalance」→ beta payable balance is 500',
      '错误回复无可行动补救指引：「查一下gamma-collection W1 的record value」→ ……',
      '错误轮同一调用重复 3 次（重试风暴）：「查一下beta的record value balance」',
      '写尝试轮发生 2 次已执行写调用——写未开放应挡在执行前：「帮我录入一张record……」',
      '写未开放/阻塞原因措辞未到达用户：「帮我录入一张record……」→ ……',
      '写尝试轮出现编造的录入成功：「帮我录入一张record……」→ ……',
    ],
  },
  {
    dim: 'groundedness',
    notes: [
      '零执行轮次出现无来源金额：第1轮「哪个customer欠款最多？」→ 8,600',
      '召回/对比用的金额与真实结果不一致：第4轮「对了，alpha刚才查出来balance是多少？」→ 12,000',
      '回复含来源外金额：第2轮「beta的呢？」→ 86,000（该轮话题：C）',
      '汇总出现无来源金额：第16轮「总结一下今天查了些什么」→ 95,000',
      '判断轮出现无来源基准数字：第7轮「这个情况正常吗」→ 行业均值 30%',
      '重查数字与该线程真实结果不一致：第11轮「alpha再查一次」 → 500',
      '明确请求未落地：第4轮「alpha，W1」零平台调用',
      '第3轮未召回也未重查：「对了，alpha刚才那个数是多少？」零调用且未复述该线程结论',
      '第3轮召回未给出真实金额（D-070：承认查过但拒绝给数）：「刚才alpha查到了哪几个window，数字是多少」→ ……',
      '第3轮召回只覆盖 2/4 个window',
      '第5轮window切换后仍呈现非零金额（mock 事实：W2 两候选collection均无balance键 → PERIOD_NO_DATA，该window只应有"无数据"或 0）：61,000',
      '第6轮把旧window（W1）的数字作为 W2 的结果呈现（contoso-logistics 只有 W1，W2 无数据）：450',
      '第5轮window切换未体现 W2：「202608 呢」',
      '第5轮window切换零平台调用：「202608 呢」',
      '第3轮未体现window W2：「对了，那它 202608 呢」→ ……',
      '回复未体现请求的window',
      '第1轮回复缺window：W1、W2（mock 事实：仅 W1 有非零balance，其余window无数据键 → PERIOD_NO_DATA）',
      '第1轮未呈现 W1 的真实balance 61,000',
      '2 window 计划只产生 4 次平台调用——有window没真查',
      '5 轮只产生 3 次平台调用——有轮次没真查',
      '5 轮数据口径不一致：["500|202609","500|202609","700|202609"]',
      '两轮回复完全一致——需确认是真查了还是复述',
      '重查轮未发生真实调用：第11轮「alpha再查一次」',
      '纠错后未发生新查询：第2轮「不对，我问的是beta」零平台调用',
      '第3轮零平台调用——同一查询连发须每轮真查',
      'D-073：第1轮客户维度查询有命中但回复未呈现查到的客户名（数据在手不得踢回给用户）：命中 epsilon-item LLC',
      '非平台知识（tax rate）挂了平台来源：「帮我看下tax rate是多少」→ ……',
      '总结塌缩成 1 个collection（D-071：本会话跨alpha+beta，总结不得只剩最后一个）：命中  alpha',
      '第19轮跨轮召回collection名单只覆盖 1/3（此前真实查过：alpha、contoso-trade、contoso-logistics）：命中  contoso-logistics',
    ],
  },
];

describe('countDims 归维表（原句表征锁）', () => {
  for (const { dim, notes } of CASES) {
    it(`${dim} 规则命中探针原句，且不落入其它维`, () => {
      for (const note of notes) {
        const { dims, unclassified } = countDims([note]);
        expect(dims[dim], `应归入 ${dim}：${note}`).toBe(1);
        const others = (Object.keys(dims) as NoteDim[]).filter((d) => d !== dim);
        expect(others.reduce((sum, d) => sum + dims[d], 0), `不得串维：${note}`).toBe(0);
        expect(unclassified, `不得落入 unclassified：${note}`).toBe(0);
      }
    });
  }

  it('（信息性）前缀不计维（探针 ok 判定同口径）', () => {
    const { dims, unclassified } = countDims([
      '（信息性）汇总轮出现算术新数值：第16轮「总结」→ 95,000',
      '（信息性）错误轮平台调用数：4 次（query-receivables×4；同一调用最多重复 1 次，重复 ≥3 才判风暴）',
      '（信息性）计划在第 5 轮前已全部跑完——跨回合恢复路径未被触发，模型一口气完成了拆解',
      '（信息性）L0 探索轮成本：8 次调用 / 295s（今日基线 8 次/295s）',
      '（信息性）数字链自洽未硬断言：mock alpha 每 window 只有一个 balance 值（无前后对对）',
    ]);
    expect(Object.values(dims).reduce((a, b) => a + b, 0)).toBe(0);
    expect(unclassified).toBe(0);
  });

  it('任务行为类 note 落 unclassified，不冒充四维分数', () => {
    const { dims, unclassified } = countDims([
      '闲聊也产生了平台调用',
      '3 轮超过 2 分钟：130000ms, 150000ms',
      '计划未恢复：第5轮后未按第 2 步续跑',
      '探索插曲轮未澄清直接执行：第3轮「等等，先看看哪个customer欠款最多」零澄清却产生 2 次平台调用并直接给出数据',
      '用户已授权跳过但仍重试：第8轮又查了幻东建材',
      '未提议查法只做了澄清：第1轮「我想整理下这边的欠款情况，你说该怎么查？」→ ……',
      '批准后未落地：第2/3轮零平台调用',
      '连续两轮零调用纯客套——探索型会话空转：「有异常的吗？」→「算了，直接查balance吧」',
      '汇总轮未给出汇总（纯客套）：第16轮「总结一下今天查了些什么」',
      '判断轮未给结论只作纯客套：第7轮「这个情况正常吗」',
      '旧线程未恢复：第10轮「beta的record下一页」零调用且未给出该线程结论',
      '闲聊轮产生平台调用：第12轮「今天天气不错」',
      '汇总轮发生平台调用：第8轮「把刚才查到的数字都列出来」2 次（汇总应基于会话记录）',
      '探索未收窄到具体客户：第4轮「欠得最多的那家是谁」未点名客户（mock 辅助档案：……）',
      'collection轮转只真实覆盖 2/4 个 mock collection：alpha、beta',
      '查询↔闲聊话题切换只有 2 次（设计 ≥3）',
      'C2 脚本 29 轮（设计 30）',
    ]);
    expect(Object.values(dims).reduce((a, b) => a + b, 0)).toBe(0);
    expect(unclassified).toBe(17);
  });

  it('混合计数：各维独立累加', () => {
    const { dims } = countDims([
      '回复泄漏执行语言（脚本路径）：「查一下」',
      '回复泄漏执行语言（错误码）：「查一下」',
      '第2轮把旧collection（alpha）的数字作为beta的结果呈现（串台）：86,000',
      '错误回复无可行动补救指引：「查」→ ……',
      '零执行轮次出现无来源金额：第1轮「问」→ 8,600',
    ]);
    expect(dims).toEqual({
      groundedness: 1,
      entityFidelity: 1,
      failureHonesty: 1,
      presentationHygiene: 2,
    });
  });

  it('每条规则声明了来源且模式可用（表自检）', () => {
    expect(NOTE_DIM_RULES.length).toBeGreaterThanOrEqual(20);
    for (const rule of NOTE_DIM_RULES) {
      expect(rule.source.length, `规则缺 source：${String(rule.pattern)}`).toBeGreaterThan(0);
      expect(['groundedness', 'entityFidelity', 'failureHonesty', 'presentationHygiene']).toContain(rule.dim);
    }
  });
});
