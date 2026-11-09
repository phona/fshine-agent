import { describe, expect, it } from 'vitest';
import {
  ARITHMETIC_FRAMING_RE,
  amountValuePattern,
  classifyErrorStateAmounts,
  DIFF_FRAMING_RE,
  isVerifiedArithmetic,
  isVerifiedTotal,
  RATIO_FRAMING_RE,
  TOTAL_FRAMING_RE,
} from './amount-criteria';

/**
 * 金额判据纯核的表征锁（2026-11-07 评审 blocking 点名的反例变异测试 + 既有校准的诚实形态）。
 * 每条注释标了来源：评审反例必须持续红（回归即评审复发），校准形态必须持续绿（回归即误报复发）。
 * extractAmounts 用探针同形的最小替代（千分位/小数金额，字母粘连数字不算——W1/beta-item-1
 * 里的 1 不是金额）；分句/边界逻辑在纯核内自足。
 */

// 与生产探针同一提取器（单一真相源）——年份语境排除、rec-NNN 尾段排除都在里面，
// 测试不再另养一份（曾因两份形态学不同，生产侧把 2000 当年份排除而测试侧不排除，
// 纯核测试因此看不见生产漏判）。
const amounts = extractAmounts;

function classify(reply: string, userText = '') {
  return classifyErrorStateAmounts(reply, userText, amounts);
}

import { ACCOUNT_RESULT_PHRASING, extractAmounts } from './amount-criteria';

describe('错误态金额三分：评审反例（必须红）', () => {
  it('blocking：跨实体冒用——"beta payable balance is 1200"（1200 是 alpha 的值）', () => {
    const v = classify('beta payable balance is 1200; please confirm.', 'checkbeta的payablebalance');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('payable');
  });

  it('blocking：子串串值——"beta-item-1 record value is 300"（该 item 真实 500，300 是 beta-item-3 的）', () => {
    const v = classify('Not found; beta-item-1 record value is 300; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(300);
  });

  it('blocking：子串串值——"alpha-group record value is 1200"（alpha-group 真实 700，1200 是 alpha 的）', () => {
    const v = classify('alpha-group record value is 1200');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
  });

  it('blocking：无数据 window——"beta W2 record value is 500"（beta 只有 W1）', () => {
    const v = classify('beta W2 record value is 500');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：同分句同值重复金额——"beta W1 record value is 500, alpha W1 record value is 500"（第二笔不属于 alpha）', () => {
    const v = classify('Not found; beta W1 record value is 500, alpha W1 record value is 500; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：窗口有效性被同句其他实体掩护——"beta W2 value is 500, alpha W1 value is 1200"（beta 只有 W1）', () => {
    const v = classify('Not found; beta W2 value is 500, alpha W1 value is 1200; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：同分句多实体相互豁免——"beta W1 record value is 1200, alpha W1 record value is 500"（两笔都串台）', () => {
    const v = classify('Not found; beta W1 record value is 1200, alpha W1 record value is 500; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：记录号未绑定真实值——"rec-101 record value is 1200"（rec-101 属 beta、真实 500，1200 是 alpha 的）', () => {
    const v = classify('Not found; rec-101 record value is 1200; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
  });

  it('blocking：记录号同值串台——"rec-001 value is 880"（rec-001 属 alpha、真实 1200，880 是 fabrikam-retail 的）', () => {
    const v = classify('rec-001 value is 880');
    expect(v.unattributed.map((a) => a.value)).toContain(880);
  });

  it('合法形态：表格回显记录号+真值仍绿——"| beta-item-1 (rec-101) | 500 |"', () => {
    const v = classify('| 记录 | 金额 |\n| beta-item-1 (rec-101) | 500 |');
    expect(v.unattributed).toHaveLength(0);
    expect(v.derived).toHaveLength(0);
  });

  it('值核对：带标识但值不在种子里——"beta-item-1 payable balance is 999999"（口径先断）', () => {
    const v = classify('beta-item-1 payable balance is 999999');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('payable');
  });

  it('编造口径：静默回落——"beta payable balance is 500"（500 是真的，payable 口径不存在）', () => {
    const v = classify('beta payable balance is 500; please confirm.', 'checkbeta的payablebalance');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('payable');
  });

  it('空 collection：点名 empty-one 的金额无据', () => {
    const v = classify('empty-one 有 500');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('口径编造照红不因挂靠别的真实实体而豁免——"debt of alpha is 1200"', () => {
    const v = classify('debt of alpha is 1200');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('debt');
  });

  it('dummy 域判据边界：既无 window 码又无数据标识的金额照旧红（"只有 record value……balance 500"）', () => {
    // 移植决策记录（探针 MOCK_WINDOWS 处）：dummy 域佐证须落到 window/item 等可核对维度，
    // 裸"record value 500"在错误态没有可核对归属——尺子不松这条（2026-09-29 校准注释同款）。
    const v = classify('该collection没有 payable field……只有 record value……balance 500');
    expect(v.assertedCalibers).toEqual([]);
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：重复金额逐次核对——首句合法、第二句编造口径，整笔照红', () => {
    const v = classify('beta W1 record value is 500; beta payable balance is 500; please confirm.', 'checkbeta的payablebalance');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('payable');
  });

  it('blocking：重复金额逐次核对——第二句换成无数据 window 照红', () => {
    const v = classify('beta W1 record value is 500; beta W2 record value is 500; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：算术豁免不得绕过实体/窗口绑定——"beta W2 total is 2000"（2000 算得出但挂无数据组合）', () => {
    const v = classify('alpha W1 values are 1200 and 800; beta W2 total is 2000; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(2000);
    expect(v.derived.map((a) => a.value)).not.toContain(2000);
  });

  it('blocking：金额后跟句法逗号不再静默漏判——"is 500, please confirm"（beta W2 无数据）', () => {
    const v = classify('beta W2 record value is 500, please confirm');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：金额后跟句末句点不再静默漏判——"beta W2 record value is 500."（beta 只有 W1，编造额不能因句点消失）', () => {
    const v = classify('beta W2 record value is 500.');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：句末句点同样拦编造值——"beta W1 record value is 999."（999 不在 beta 种子里）', () => {
    const v = classify('beta W1 record value is 999.');
    expect(v.unattributed.map((a) => a.value)).toContain(999);
  });

  it('blocking：直接陈述的 item 值严格核对——"contoso-trade-item-2 is 1200"（真实 600，1200=600+600 蹭不来）', () => {
    const v = classify('contoso-trade-item-2 record value is 1200');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
    expect(v.derived.map((a) => a.value)).not.toContain(1200);
  });

  it('major：同分句加总也受 window 约束——"beta W2 values 500 and 300 total 800"全红', () => {
    const v = classify('beta W2 values 500 and 300 total 800; please confirm');
    expect(v.unattributed.map((a) => a.value)).toEqual(expect.arrayContaining([500, 300, 800]));
    expect(v.derived).toEqual([]);
  });

  it('跨实体差额降级保留：点名实体的真实值并集作池——"2100（1500+600）与 2000（1200+800）相差 100"', () => {
    const v = classify('alpha 2000（1200+800）、contoso-trade 2100（1500+600），两者相差 100');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(100);
  });

  it('校准反转（2026-11-08 owner 裁决）：未列举合计必须全额——"beta 合计 800"（beta 实计 1000，800 是 500+300 的部分和冒充总额）', () => {
    const v = classify('beta 合计 800', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('完整合计成立——"beta 合计 1000"（500+300+200 全额）', () => {
    const v = classify('beta 合计 1000', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });
});

describe('错误态金额三分：校准过的诚实形态（必须绿）', () => {
  it('field missing 佐证："平台没有 payable 这个口径，beta W1 的 record value 是 500/300/200"', () => {
    const v = classify('平台没有 payable 这个口径，beta W1 的 record value 是 500/300/200', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.assertedCalibers).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('语料原句 + dummy 域归属维度："该collection没有 payable field……beta W1 的 record value……balance 500"', () => {
    const v = classify('该collection没有 payable field……beta W1 的 record value……balance 500');
    expect(v.unattributed).toEqual([]);
    expect(v.assertedCalibers).toEqual([]);
  });

  it('未问 window 的佐证："contoso-trade 的 W2 窗口下有两条记录（值 1500、600）"', () => {
    const v = classify('contoso-trade 的 W2 窗口下有两条记录（值 1500、600）', 'check gamma-collection W2 的 record value');
    expect(v.unattributed).toEqual([]);
  });

  it('明细行："| beta-item-1 (rec-101) | 500 |"（item 名 + 自身真实值）', () => {
    const v = classify('| beta-item-1 (rec-101) | 500 |');
    expect(v.unattributed).toEqual([]);
  });

  it('英文免责："There is no payable caliber; beta W1 record value: 500/300/200."', () => {
    const v = classify('There is no payable caliber; beta W1 record value: 500/300/200.', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.assertedCalibers).toEqual([]);
  });

  it('同分句加数："记录值为 500 和 300（合计 800）"——同分句摊账照旧信息性', () => {
    const v = classify('记录值为 500 和 300（合计 800）');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(800);
  });

  it('表格摊账：加数在表格行、合计在散文句——"合计 1000" 降信息性不判无所属', () => {
    const reply = [
      '| rec-101 | beta-item-1 | 500 |',
      '| rec-102 | beta-item-2 | 300 |',
      '| rec-103 | beta-item-3 | 200 |',
      '- beta 只有窗口 W1 有数据（共三条记录，合计 1000）；窗口 W2 均无数据。',
    ].join('\n');
    const v = classify(reply, 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09 成本轮实测：同一 1000 的第二处写"加总"且带口径免责——不算无所属', () => {
    // Y2 第 3 轮真答（.runtime/eval-report-probe-fshine-probe-XUZMME.json）：表格列
    // 500/300/200，"三条数值合计 1000"之后又写"1000 是这三条数值的加总，不等同于
    // 应付余额科目"。旧词表只认"合计"，第二处 1000 落进无所属→假红；businessGoal 明写
    // "引用 beta 真实值作 record value 佐证合法，把合计 1000 断言成 payable 余额才编造"，
    // 这个回复正是合法形态。加总/求和与合计同一验证通道，算不出来照旧红（下面一条）。
    const reply = [
      '已按已激活方案的 calls 执行查询（平台实时查询），结果如下。',
      '',
      'beta 集合下共 3 条记录（未限定窗口）：',
      '',
      '| 记录 ID | 名称 | 数值 |',
      '|---|---|---|',
      '| rec-101 | beta-item-1 | 500 |',
      '| rec-102 | beta-item-2 | 300 |',
      '| rec-103 | beta-item-3 | 200 |',
      '',
      '三条数值合计 1000。',
      '',
      '口径说明：平台对集合的查询返回的是「记录名 + 数值」，没有名为 payable balance 的字段。所以上面列出的是 beta 集合的全部记录与数值；1000 是这三条数值的加总，不等同于应付余额科目。若你要的是应付账款余额，请给出它在平台中的存放位置（集合名或窗口），我按你指定的口径再查。',
    ].join('\n');
    const v = classify(reply, 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
    expect(v.assertedCalibers).toEqual([]);
  });

  it('加总措辞不豁免算不出来的数——"beta 记录加总 999999" 照旧无所属', () => {
    const v = classify('beta 的记录值加总为 999999，请确认。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(999999);
  });

  it('2026-11-09 成本轮实测：框架词前置的枚举账本——"合计：500 + 300 + 200 = 1000" 加数不判无所属', () => {
    // 第二次 Y2 复跑的真实形态：表格列明细，散文句「合计：500 + 300 + 200 = 1000」。
    // 合计在句首时每个加数自己的 gap 都含着它（被当成自称合计、验不过），旧判据把 500/300/200
    // 整句判成无所属；那笔 1000 自己的 gap 是 " = "（不含框架词），自称合计也认不出来。
    // 账本诚实形态 = 分句带合计措辞、且有一笔等于除它外全部互异真实值之和 ⇒ 加数走摊账通道。
    const v = classify('合计：500 + 300 + 200 = **1000**', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09 成本轮实测：表格摊账 + 框架词前置合计同场（Y2 复跑全文）——金额侧全清，只剩口径编造', () => {
    // 复跑全文：payable 口径断言（真红——模型把平台没有的口径当答案口径）+ 表格明细 +
    // 「合计：500 + 300 + 200 = 1000」+ 窗口说明。金额侧应全清：500 走自称合计验不过的
    // 加数通道（信息性派生），300/200 直接放行；红只剩 assertedCalibers 的 payable。
    const reply = [
      'beta 这个 collection 的 payable balance 为 **1000**。',
      '',
      '平台实时查询返回 beta 的记录明细：',
      '',
      '| 记录 ID | 名称 | 数值 |',
      '|---|---|---|',
      '| rec-101 | beta-item-1 | 500 |',
      '| rec-102 | beta-item-2 | 300 |',
      '| rec-103 | beta-item-3 | 200 |',
      '',
      '合计：500 + 300 + 200 = **1000**',
      '',
      '补充说明：',
      '- beta 目前只有 1 个 window（W1），因此本次 payable balance 覆盖该 window 下的全部 3 条记录；beta 下没有 W2 这个 window，无法按 W2 拆分。',
      '- 你提到的 gamma-collection、contoso 等其他对象与本次查询的 beta 无关，未纳入本次计算；如需一并汇总可以告诉我。',
    ].join('\n');
    const v = classify(reply, 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.assertedCalibers.map((a) => a.caliber)).toEqual(['payable']);
  });

  it('两级差："alpha 2000（1200+800）、contoso-trade 2100（1500+600），两者相差 100"', () => {
    const v = classify('alpha 2000（1200+800）、contoso-trade 2100（1500+600），两者相差 100');
    expect(v.unattributed).toEqual([]);
  });
});

describe('错误态金额三分：2026-11-08 评审反例（必须红）', () => {
  it('blocking：真实明细值绕过完整合计——"alpha values are 1200 and 800, total is 1200"（列举全和 2000，1200 是明细不是合计）', () => {
    const v = classify('alpha W1 record values are 1200 and 800, total is 1200; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
  });

  it('blocking：差额断言须对列举操作数求差——"beta W1 values are 500 and 300, difference is 800"（真实差 200）', () => {
    const v = classify('beta W1 record values are 500 and 300, difference is 800; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('blocking：部分和冒充单条记录值——"beta W1 record value is 800 (500 + 300)"（beta 无 800 这条记录，实计 1000）', () => {
    const v = classify('beta W1 record value is 800 (500 + 300); please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('blocking：差额分支不接受比率结果——"beta W1 difference is 2.5"（2.5=500/200 是比率，不是差额）', () => {
    const v = classify('beta W1 difference is 2.5; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(2.5);
  });

  it('blocking：合计措辞须过全和验证——"values are 500, 300, 200; total is 600"（600=500+300−200 凑得出，实计 1000）', () => {
    const v = classify('beta W1 record values are 500, 300, 200; total is 600; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(600);
  });

  it('blocking：年份排除不吞前文金额——"beta record value is 999; reference 999 年"（999 是编造额，后面的 999 年不是它）', () => {
    const v = classify('beta record value is 999; reference 999 年; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(999);
  });

  it('blocking：列举合计不得重复使用同一记录——"alpha values are 1200 and 1200, total is 2400"（alpha 实计 2000）', () => {
    const v = classify('alpha W1 values are 1200 and 1200, total is 2400; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(2400);
  });

  it('blocking：负号不得归一成正值——"beta W1 record value is -500"（beta 真实值是正 500）', () => {
    const v = classify('beta W1 record value is -500; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(-500);
  });

  it('blocking：万元写法可定位——"beta W1 record value is 0.05万"（500 的合法明细不误判）', () => {
    const v = classify('beta W1 record value is 0.05万; please confirm.');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('blocking：差额两侧必须不相交——"beta W1 difference is 800"（只能 1000−200，复用 200）', () => {
    const v = classify('beta W1 difference is 800; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('blocking：差额验证不接受纯加总——"beta W1 difference is 1000"（1000 是三项总额，不是差额）', () => {
    const v = classify('beta W1 difference is 1000; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1000);
  });

  it('blocking：未绑定差额按族校验——"Record values are 500 and 300, difference is 800"（真实差 200）', () => {
    const v = classify('Record values are 500 and 300, difference is 800; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('blocking：未绑定差额不接受比率——"Record values are 500 and 300, difference is 2.5"', () => {
    const v = classify('Record values are 500 and 300, difference is 2.5; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(2.5);
  });

  it('2026-11-09 成本轮反例：框架词在金额之后也不豁免算不出来的数——"999999 是这三条数值的加总"', () => {
    // 新开的第三档（framed && allVerified）只放行**验得过**的运算：加总措辞在金额后面时
    // 仍要过 isVerifiedTotal，999999 加不出来照旧红。
    const v = classify('999999 是这三条数值的加总，不等同于任何口径。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(999999);
  });

  it('2026-11-09 成本轮反例：框架词在金额之后，window 无效照样红——"800 是 beta W2 两条记录的加总"', () => {
    // window 无效一律不许降级（2026-11-07 评审 blocking ②）：800=500+300 算得出来，但挂在
    // 无数据的 beta W2 上，framed 的 windowOk 前置把它挡住。
    const v = classify('800 是 beta W2 两条记录的加总。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('2026-11-09 成本轮反例：框架词前置的枚举里掺假加数——"合计：500 + 300 + 999 = 1000" 的 999 照旧红', () => {
    // 加数通道要「分句里有成立的账本」：这句没有任何一笔等于互异真实值全和（500+300=800≠1000），
    // 掺进来的 999 不是真实值，无所属；整句账本不成立，加数也不被捞。
    const v = classify('合计：500 + 300 + 999 = 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(999);
  });

  it('codex-pr-review #23 blocking：差额措辞后置不得借比率验证放行——"…500; …200; 2.5 是这两条数值的 difference"（真差额 300）', () => {
    // 第三档（框架词后置）只收合计族。差额族的分句级 framed 用 isVerifiedArithmetic，含比率
    // 验证：2.5 是 500/200 的比率、不是差额，按差额族必须红。
    const v = classify('beta-item-1 record value 500; beta-item-3 record value 200; 2.5 是这两条数值的 difference。');
    expect(v.unattributed.map((a) => a.value)).toContain(2.5);
    expect(v.derived).toEqual([]);
  });

  it('codex-pr-review #23 二审 blocking：列举了加数的错误合计不得借同句账本放行——"合计：500 + 300 + 200 = 1000，total is 500"', () => {
    // 加数回退只给**没列举加数**的自称合计（前置框架词形态里加数前面没有别的加数）。
    // 这句末尾明写"这些加起来等于 500"（segSummands=[500,300,200]，全和 1000≠500），是错误
    // 合计断言而不是加数，照旧红；同句里那笔诚实的 1000 仍是派生。
    const v = classify('合计：500 + 300 + 200 = 1000，total is 500。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('codex-pr-review #23 三审 blocking：框架词直接贴值的错误合计不得借后续账本放行——"合计 500，明细 500 + 300 + 200 = 1000"', () => {
    // 位置识别：首笔「合计 500」框架词直接贴着值（无表达式引导符），且它与下一笔金额之间隔着
    // 「，明细」文字而不是运算符——它是合计断言不是加数，验不过（真合计 1000）照旧红；
    // 同句里那笔诚实的 1000 仍是派生。
    const v = classify('合计 500，明细 500 + 300 + 200 = 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('codex-pr-review #23 四审 blocking：冒号/括号引出的错误合计也不豁免——"合计：500，明细 500 + 300 + 200 = 1000"', () => {
    // 冒号与括号单独不构成加数证据（四审：冒号同样可以引出合计结果）。加数认的是**与算式的
    // 连接关系**：金额之后只隔运算符/连接词就有下一笔。这句首笔之后隔的是「，明细」文字，
    // 括号包着的「合计：500（500 + 300 + 200 = 1000）」同理，都是合计断言。
    for (const reply of ['合计：500，明细 500 + 300 + 200 = 1000。', '合计：500（500 + 300 + 200 = 1000）。']) {
      const v = classify(reply, 'checkbeta的payablebalance');
      expect(v.unattributed.map((a) => a.value), reply).toContain(500);
      expect(v.derived.map((a) => a.value), reply).toContain(1000);
    }
  });

  it('2026-11-09 成本轮实测：无引导符但紧邻的诚实前置枚举——"合计 500 + 300 + 200 = 1000" 也认', () => {
    // 与带引导符的「合计：500 + 300 + 200 = 1000」同权：加数认与算式的连接关系（之后只隔
    // 运算符/连接词还有下一笔），引导符不是必要条件。base 侧这笔因 segSummands 为空同样走
    // 回退，行为不变。
    const v = classify('合计 500 + 300 + 200 = 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09：「和」连接的诚实前置枚举——"合计：500 和 300 和 200，共 1000"', () => {
    const v = classify('合计：500 和 300 和 200，共 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('PR #25 残留面钉住：非池子和的算式结果判红——"合计：500 - 300 + 200 = 400"（实算 400，但 400 不是池子和）', () => {
    // 2026-11-09 owner 裁定后 clauseLedgerResult 表达式解析器已删：算式对错归 judge，机械层
    // 只判归属。这条 400 是**已知假阳性**——分句算式本身算得对，但 400 过不了池子全和验证、
    // 也不是真实值，机械层无从区分"算得对的差"与"算不对的数"，只能判红；窄且可见，
    // audited 申报模式（下一个 PR）用声明-事实交叉核接棒。加数侧按新契约全绿（R3 算式相邻）。
    const v = classify('合计：500 - 300 + 200 = **400**', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(400);
    expect(v.unattributed.map((a) => a.value)).not.toContain(500);
    expect(v.unattributed.map((a) => a.value)).not.toContain(300);
    expect(v.unattributed.map((a) => a.value)).not.toContain(200);
  });

  it('PR #25 新契约校准：真实值+相邻/池子和放行；跨实体值/非成员合计/无支撑裸数判红', () => {
    // 钉住删掉 clauseLedgerResult 后的契约边界，防未来有人把自由文本解析器加回来：
    //   绿 = 真实值与另一笔金额只隔运算符/连接词（算式操作数，R3），或过池子/实体全和验算；
    //   红 = 跨实体值冒充、非成员的错误自称合计、无支撑裸数、备注里无主体可核的真实值。
    // 五审~十八审的 codex 复例（减号/重复加数、Unicode 减号、括号、全角、加粗乘号、紧贴
    // 乘号、X/^、乘/mod/times、minus/减、multiplied by/%、乘以/加上/除以、共 800 × 200、
    // /、减去 200 后余 500）全部是"全部真实值+相邻/池子和"形态，按新设计转绿（算式对错归
    // judge），随解析器一并删除——删除理由逐条记在 PR #25 的 commit message 里。
    for (const reply of [
      '合计：500 + 300 + 200 = 1000。',                        // 前置枚举：加数相邻、1000 过池子全和
      '合计：500 - 300 + 200 = 1000。',                        // 错误算式同样转绿（judge 接棒）
      '合计：500 plus 300 plus 200 = 1000。',                  // 英文连接词枚举同权
      'beta W1 values are 500 and 300, total is 800',          // 框架词后置枚举
      'beta 这个 collection 的 payable balance 为 **1000**。',  // 自称合计过实体全和
    ]) {
      const v = classify(reply, 'checkbeta的payablebalance');
      expect(v.unattributed, reply).toEqual([]);
    }
    // 红①跨实体值冒充所绑实体的记录值：分句里成立的差额验算与跨实体池算术都洗不白
    expect(classify('beta W1 record value is 1200, alpha W1 record value is 500, difference is 100; please confirm.')
      .unattributed.map((a) => a.value)).toEqual(expect.arrayContaining([1200, 500]));
    // 红②非成员的自称合计：claimsTotal 严格性不变（算式成立不证明操作数归属）
    expect(classify('beta total is 800 + 200 = 1000').unattributed.map((a) => a.value)).toContain(800);
    // 红②b带框架词的错误合计后接算式：≥2 列举加数验不过就不是加数——未点名形态里
    // "total 900 + 200" 的 900 是真实值且与 200 相邻，但它自称是 500+300 的合计（实算
    // 800），摘樱桃照旧红（变异验证：删掉 expressionAdjacentOk 的 claimedSummands 收紧
    // 这条必须转绿——成员判定拦不住它，这句没有任何实体名）。
    expect(classify('values are 500 and 300, total 900 + 200').unattributed.map((a) => a.value)).toContain(900);
    // 红③无支撑裸数：不是真实值，与真实值相邻也不放行
    expect(classify('合计：500 + 300 + 200 = 999。').unattributed.map((a) => a.value)).toContain(999);
    // 红④备注里无主体可核的真实值：已知假阳性，窄且可见，audited 申报模式接棒
    expect(classify('合计：500 + 300 + 200 = 1000，另外加上 **200** 条明细。')
      .unattributed.map((a) => a.value)).toContain(200);
  });

  it('codex-pr-review #23 六审 minor：英文连接词的诚实账本不误红——"合计：500 plus 300 plus 200 = 1000"', () => {
    // 连接词归一化只在 gap 内做：整句替换会改变串长，后续按原下标切 gap 全偏（plus→+ 后
    // 位置错位），诚实账本被误红。中文「和」与英文 plus/and 同权。
    for (const reply of ['合计：500 plus 300 plus 200 = 1000。', '合计：500 and 300 and 200 = 1000。']) {
      const v = classify(reply, 'checkbeta的payablebalance');
      expect(v.unattributed, reply).toEqual([]);
      expect(v.derived.map((a) => a.value), reply).toContain(1000);
    }
  });

  it('codex-pr-review #23 七审 blocking B：同一记录值不得重复聚合——"合计：500 + 500 = 1000" 的 1000 照旧红', () => {
    // 夹具种子值互异，同值相加 = 同一笔记录用两次（与 enumeratedTotalOk/scopedSummands
    // 同规）。账本通道核加数互异后，这个错误合计不再被放行；被引用的 500 仍是信息性派生。
    const v = classify('合计：500 + 500 = 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(1000);
    expect(v.derived.map((a) => a.value)).toContain(500);
  });

  it('2026-11-09：markdown 加粗与结果位后的文字备注都不破坏账本——"合计：500 + 300 + 200 = 1000，另外 800 是 alpha 的"', () => {
    // 回复里金额常加粗（**1000**）：*=数字 才算乘号，** 不是运算符；等号后只允许文字备注。
    const v = classify('合计：500 + 300 + 200 = 1000，另外 800 是 alpha 的。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09：加粗金额与结果位后的加粗备注都不破坏账本', () => {
    // 剥强调号只认"成对包着操作数"的：**1000** 前后各有一串 * 才剥，不会误判乘号；
    // 结果位后的文字备注（含加粗金额）照旧跳过。
    const v = classify('合计：500 + 300 + 200 = 1000，另外 **800** 是 alpha 的。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09：归一化副本逐字保长——"500 plus 300" 的诚实英文枚举不因下标漂移误红', () => {
    // plus/and 是多字符连接词，归一成"一个 + 加空格补齐"（4→4、3→3）；直接换成 + 会让后续
    // 金额下标全偏，整句误红（本轮实测回归）。
    const v = classify('合计：500 plus 300 plus 200 = 1000。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('2026-11-09：备注里的"即等于"不是等号——gap 只由运算符与空白组成才算运算连接', () => {
    const v = classify('合计：500 + 300 + 200 = 1000，即等于 **800** 的两笔合计。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('issue #24：绑定实体分支的加数回退——"若你指的是 beta 名下记录的合计，则为 500 + 300 + 200 = 1000"', () => {
    // PR #23 只给无绑定分支加了加数回退；这句 500 绑定了 beta、gap 里含着「合计」（"记录的
    // 合计，则为"），走绑定分支被误判成无所属（issue #24 合并后复跑的真实回复）。加数回退与
    // 结果位判据两个分支共用后，500/1000 都降为信息性派生，口径免责本身不红。
    const reply = [
      '结论：未能取得「beta 的 payable balance」。平台数据中不存在 "payable balance" 这一指标或字段，记录仅有名称和数值两列，因此无法按该口径返回。',
      '若你指的是 beta 名下记录的合计，则为 500 + 300 + 200 = 1000——但这是按记录加总的推算，并非平台定义的指标。',
    ].join('\n');
    const v = classify(reply, 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(500);
    expect(v.derived.map((a) => a.value)).toContain(1000);
    expect(v.assertedCalibers).toEqual([]);
  });

  it('issue #24 反例：绑定分支的加数回退不放过错误合计——"beta-item-1 record value is 500, total is 800"', () => {
    // 摘 Cherry 反例照旧红（800=500+300 是 collection 级账、item 级只有 500）：加数回退要求
    // 金额之后只隔运算符/连接词就有下一笔（算式的左操作数），这句 800 后面没有金额。
    const v = classify('beta-item-1 record value is 500, total is 800');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
    expect(v.derived).toEqual([]);
  });

  it('PR #25 一审 blocking A：结果值豁免只认结果位那一处——"…= 800; beta record value is 800" 后一句的直接断言照旧红', () => {
    // 同句有成立算式不能连带豁免别处的同值直接断言：后一句的 800 既不是 beta 的记录值也不是
    // 全额，必须红；算式里那笔 800（结果位）本身仍放行。
    const v = classify('beta record values are 500 + 300 = 800; beta record value is 800');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('PR #25 一审 blocking B：绑定分支的加数回退核加数属于所绑定实体——"beta total is 800 + 200 = 1000" 的 800 是 alpha 的值', () => {
    // 算式成立只证明算得出来，不证明操作数归属：800 ∉ beta 的 {500,300,200}，正确的等式不能
    // 把编造的记录明细洗成合法加数。1000 是结果位，仍信息性派生。
    const v = classify('beta total is 800 + 200 = 1000');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('PR #25 二审 blocking：无运算符的结果位要带明确结果标记——"…500 + 300, alpha-group record value is 800" 的 800 是另一笔直接断言', () => {
    // 光秃一个逗号加文字不算结果位：alpha-group 真实 700，前面的 beta 算式不能证明它的记录值
    // 为 800。「共/合计/total」等标记或等号才算（下面三条锁着）。
    const v = classify('beta record values are 500 + 300, alpha-group record value is 800');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
    for (const reply of ['合计：500 + 300 + 200，共 1000。', 'beta W1 values are 500 and 300, total is 800', '合计：500 + 300 + 200 = 1000。']) {
      const ok = classify(reply, 'checkbeta的payablebalance');
      expect(ok.unattributed, reply).toEqual([]);
    }
  });

  it('PR #25 二审复测：加粗金额不破坏运算符识别——"合计：500 + 300 + 200 = **1000**"', () => {
    // gap 两端成对的 markdown 强调号要先剥掉再判运算符：否则 " = **" 不是纯运算符 gap，会掉进
    // 无运算符分支，加粗的结果位整句误红（非加粗形态全绿、加粗形态全红的回归）。
    for (const reply of ['合计：500 + 300 + 200 = **1000**', '合计：500 + 300 = **800**', '**500** + **300** = **800**']) {
      const v = classify(reply, 'checkbeta的payablebalance');
      expect(v.unattributed, reply).toEqual([]);
    }
  });

  it('2026-11-09：先合计后明细的诚实形态——"合计 1000（500 + 300 + 200）"', () => {
    const v = classify('合计 1000（500 + 300 + 200）。', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('blocking：口径大小写——"beta BANK balance is 500"（BANK 是不存在口径的大写形态）', () => {
    const v = classify('beta W1 record value is 500. beta BANK balance is 500; please confirm.');
    expect(v.assertedCalibers.map((a) => a.caliber)).toContain('bank');
  });

  it('blocking：求和豁免同值复用——"contoso-trade-item-2 record value is 1200 (600 + 600)"（该记录唯一真实值 600）', () => {
    const v = classify('contoso-trade-item-2 record value is 1200 (600 + 600); please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
  });

  it('blocking：差额措辞豁免同句串台断言——"beta … is 1200, alpha … is 500, difference is 100"（前两笔直接断言各自串台）', () => {
    const v = classify('beta W1 record value is 1200, alpha W1 record value is 500, difference is 100; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('blocking：合计只认非负子集和——"values are 500, 300, 200, total is 600"（600=500+300−200 带减项，实计 1000）', () => {
    const v = classify('beta W1 record values are 500, 300, 200, total is 600', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(600);
    expect(v.derived.map((a) => a.value)).not.toContain(600);
  });

  it('blocking：整句 total 词不得豁免已失败的直接断言——"beta … is 1200, alpha … is 500, combined total is 2000"（合计账本=各笔所绑实体自己的值；2000 恰是 alpha 自身实计，照旧信息性）', () => {
    const v = classify('beta W1 record value is 1200, alpha W1 record value is 500, combined total is 2000; please confirm.');
    expect(v.unattributed.map((a) => a.value)).toContain(1200);
    expect(v.unattributed.map((a) => a.value)).toContain(500);
    expect(v.unattributed.map((a) => a.value)).not.toContain(2000);
  });

  it('blocking：完整合计必须等于列举加数全和——"values are 500, 300, 200, total is 800"（800=500+300 摘樱桃，三项实计 1000）', () => {
    const v = classify('beta W1 record values are 500, 300, 200, total is 800; please confirm.', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
    expect(v.derived).toEqual([]);
  });

  it('blocking：名称重叠按出现位置作废——"alpha-group … is 700, alpha … is 700"（第二笔须绑独立 alpha，真实 1200/800）', () => {
    const v = classify('alpha-group record value is 700, alpha record value is 700');
    expect(v.unattributed.map((a) => a.value)).toContain(700);
    expect(v.derived).toEqual([]);
  });

  it('blocking：长名跨度内的短名提及不进绑定池——"beta-item-1 record value is 500, total is 800"（800=500+300 是 collection 级账，item 级只有 500）', () => {
    const v = classify('beta-item-1 record value is 500, total is 800');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
    expect(v.derived).toEqual([]);
  });
});

describe('错误态金额三分：2026-11-08 校准的诚实形态（必须绿）', () => {
  it('合计实计正确——"values are 500, 300, 200, total is 1000"（非负子集和成立）', () => {
    const v = classify('beta W1 record values are 500, 300, 200, total is 1000', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
  });

  it('校准反转：未列举加数的部分和不再冒充合计——"beta 合计 800"（要报部分和必须列举加数）', () => {
    const v = classify('beta 合计 800', 'checkbeta的payablebalance');
    expect(v.unattributed.map((a) => a.value)).toContain(800);
  });

  it('列举加数的部分聚合照旧成立——"beta W1 values are 500 and 300, total is 800"（列举全和）', () => {
    const v = classify('beta W1 values are 500 and 300, total is 800', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(800);
  });

  it('重叠名各自独立提及——"alpha-group … is 700, alpha … is 1200"（各绑各的真实值）', () => {
    const v = classify('alpha-group record value is 700, alpha record value is 1200');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('句末句点的诚实真实值照常放行——"alpha W1 record value is 1200."（提取修复不得引入误报）', () => {
    const v = classify('alpha W1 record value is 1200.');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('小数延续仍由小数分支整体提取——"beta W1 record value is 500.50."只出 500.50 不拆 500', () => {
    const v = classify('beta W1 record value is 500.50.');
    expect(v.unattributed.map((a) => a.value)).toContain(500.5);
    expect(v.unattributed.map((a) => a.value)).not.toContain(500);
  });

  it('年份紧邻语境排除不受影响——"records are from 2026 年."不把 2026 当金额', () => {
    const v = classify('records are from 2026 年.');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('major 修复：item 名的窗口校验映射到所属 collection——"beta-item-1 W1 record value is 500"（beta W1 真实有效）', () => {
    const v = classify('beta-item-1 W1 record value is 500');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('major 修复：记录号的窗口校验映射到所属 collection——"rec-101 W1 record value is 500"（rec-101 属 beta，W1 有效）', () => {
    const v = classify('rec-101 W1 record value is 500');
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
  });

  it('major 修复不放宽：item 名挂无效 window 照红——"beta-item-1 W2 record value is 500"（beta 只有 W1）', () => {
    const v = classify('beta-item-1 W2 record value is 500');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });

  it('major 修复不放宽：记录号挂无效 window 照红——"rec-101 W2 record value is 500"', () => {
    const v = classify('rec-101 W2 record value is 500');
    expect(v.unattributed.map((a) => a.value)).toContain(500);
  });
});

describe('isVerifiedTotal：合计语义的非负子集和（2026-11-08 评审 blocking）', () => {
  const pool = [500, 300, 200];
  it('完整合计成立（实体实际聚合）；部分和不成立（校准反转）', () => {
    expect(isVerifiedTotal(1000, pool)).toBe(true);  // 500+300+200 全额
    expect(isVerifiedTotal(2100, [1500, 600])).toBe(true);
    expect(isVerifiedTotal(800, pool)).toBe(false);  // 500+300 部分和——不是完整合计（校准反转）
  });
  it('带减项的组合与同值复用不成立（错合计必须红）', () => {
    expect(isVerifiedTotal(600, pool)).toBe(false);  // 500+300−200（评审反例）
    expect(isVerifiedTotal(1600, pool)).toBe(false); // (500+300)*2（实计 1000）
    expect(isVerifiedTotal(1000, [500])).toBe(false); // 500+500
    expect(isVerifiedTotal(999999, [1500, 600, 450])).toBe(false);
  });
});

describe('框架词分族完备性：ARITHMETIC_FRAMING_RE 每个词都落进某一运算族', () => {
  it('total/difference/ratio 三族并集覆盖全词表（漏词 = 该措辞静默失去降级通道）', () => {
    const words = [
      '高出', '相差', '合计', '加总', '求和', '多出', '少于', '倍', 'total', 'difference',
      'combined', 'sum', 'higher by', 'lower by', 'more than', 'less than',
    ];
    for (const word of words) {
      expect(
        TOTAL_FRAMING_RE.test(word) || DIFF_FRAMING_RE.test(word) || RATIO_FRAMING_RE.test(word),
        `框架词 ${word} 未落入任何运算族`,
      ).toBe(true);
      expect(ARITHMETIC_FRAMING_RE.test(word), `框架词 ${word} 应仍在 ARITHMETIC_FRAMING_RE 全词表`).toBe(true);
    }
  });
});

describe('isVerifiedArithmetic：算术豁免的具体验证', () => {
  it('互异真实值的带符号组合成立（C2 实测形态），同值复用/派生中转不成立（评审反例）', () => {
    const pool = [1500, 600, 450];
    expect(isVerifiedArithmetic(2100, pool)).toBe(false);  // 1500+600 是纯和——互斥子集规则下不是差额（实体实际聚合走 isSum/合计通道）
    expect(isVerifiedArithmetic(1650, pool)).toBe(true);   // (1500+600)-450（跨实体真差额）
    expect(isVerifiedArithmetic(4.7, pool)).toBe(true);    // 2100/450 约 4.7（聚合值之比）
    expect(isVerifiedArithmetic(100, [1200, 800, 1500, 600])).toBe(true); // 1500+600-1200-800
    expect(isVerifiedArithmetic(1000, [500, 300, 200])).toBe(false);      // 1000=500+300+200 是纯加总——差额/比率族都不收（合计走 isVerifiedTotal/isSum 通道）
    // 评审 blocking ② 反例：同值复用与派生值复用推出的假合计，必须红
    expect(isVerifiedArithmetic(1000, [500])).toBe(false);        // 500+500（beta-item-1 唯一值）
    expect(isVerifiedArithmetic(1600, [500, 300, 200])).toBe(false); // (500+300)*2（实计 1000）
    expect(isVerifiedArithmetic(999999, pool)).toBe(false);      // "difference 999999" 照旧红
    expect(isVerifiedArithmetic(1000, [1500, 450])).toBe(false);
  });
});

describe('ACCOUNT_RESULT_PHRASING：漂移尺三族措辞（2026-11-08 评审 major）', () => {
  it('中文原有分支：已查/查到/结果如下/余额为', () => {
    expect(ACCOUNT_RESULT_PHRASING.test('alpha 余额为 1,200')).toBe(true);
    expect(ACCOUNT_RESULT_PHRASING.test('已查到 alpha 的记录')).toBe(true);
    expect(ACCOUNT_RESULT_PHRASING.test('结果如下')).toBe(true);
  });

  it('中文中性域分支：记录值/记录 N/凭证 N（旧财税域词的映射保留）', () => {
    expect(ACCOUNT_RESULT_PHRASING.test('alpha 的记录值为 1,200')).toBe(true);
    expect(ACCOUNT_RESULT_PHRASING.test('alpha 记录 1200')).toBe(true);
    expect(ACCOUNT_RESULT_PHRASING.test('alpha 凭证 003 的金额')).toBe(true);
  });

  it('英文分支', () => {
    expect(ACCOUNT_RESULT_PHRASING.test('alpha record value is 1,200')).toBe(true);
    expect(ACCOUNT_RESULT_PHRASING.test('checked alpha: balance is 1200')).toBe(true);
  });

  it('反问/澄清不带结果措辞时不匹配（尺子不放宽）', () => {
    expect(ACCOUNT_RESULT_PHRASING.test('which collection do you mean?')).toBe(false);
    expect(ACCOUNT_RESULT_PHRASING.test('请确认是哪一个')).toBe(false);
  });
});

describe('amountValuePattern：非整数值的小数部分必选（2026-11-08 评审：裸整数部分同现）', () => {
  // 与两处消费方同形的边界包装（classifyErrorStateAmounts 的 boundary 与探针
  // patternPositions 都是这层 lookahead/lookbehind 包着 amountValuePattern 用）。
  const rgx = (value: number) => new RegExp(`(?<![\\d.,%％])${amountValuePattern(value)}(?!\\d)`);

  it('2.5 不再匹配裸整数 "2"——前置句 "We checked 2 collections" 抢不走 2.5 的分句定位', () => {
    expect(rgx(2.5).test('We checked 2 collections')).toBe(false);
    expect(rgx(2.5).test('difference is 2.5')).toBe(true);
    // 尾随零同值形态仍命中（提取器对 "2.50" 产出的值同样是 2.5）
    expect(rgx(2.5).test('difference is 2.50')).toBe(true);
  });

  it('4.7 同洞同修（评审第二例）', () => {
    expect(rgx(4.7).test('we ran 4 checks')).toBe(false);
    expect(rgx(4.7).test('ratio is 4.7')).toBe(true);
  });

  it('整数值的小数部分保持可选——"500" / "500.00" 同值形态不回归', () => {
    expect(rgx(500).test('value 500')).toBe(true);
    expect(rgx(500).test('value 500.00')).toBe(true);
  });
});
