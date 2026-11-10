import { describe, expect, it } from 'vitest';
import {
  ARITHMETIC_FRAMING_RE,
  amountValuePattern,
  classifyErrorStateAmounts,
  DIFF_FRAMING_RE,
  isDateLikeAmount,
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

  it('合计族同义措辞：同一 1000 的第二处写"加总"且带口径免责——不算无所属', () => {
    // 考什么形态：表格列 500/300/200，散文句「三条数值合计 1000」之后又用「加总」复述
    // 同一个 1000 并紧跟口径免责。旧词表只认"合计"，第二处 1000 落进无所属→假红；引用
    // beta 真实值作 record value 佐证合法，把合计 1000 断言成 payable 余额才编造。加总/
    // 求和与合计同一验证通道，算不出来照旧红（下面一条）。
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
      '口径说明：平台对集合的查询返回的是「记录名 + 数值」，没有名为 payable balance 的字段。所以上面列出的是 beta 集合的全部记录与数值；1000 是这三条数值的加总，不等同于任何单条记录的值。若你要的是另一种口径，请给出它在平台中的存放位置（集合名或窗口），我按你指定的口径再查。',
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

  it('框架词前置的枚举账本——"合计：500 + 300 + 200 = 1000" 加数不判无所属', () => {
    // 考什么形态：表格列明细，散文句「合计：500 + 300 + 200 = 1000」——合计框架词落在
    // 首笔加数之前。此时每个加数自己的 gap 都含着它（被当成自称合计、验不过），旧判据把
    // 500/300/200 整句判成无所属；那笔 1000 自己的 gap 是 " = "（不含框架词），自称合计
    // 也认不出来。
    // 账本诚实形态 = 分句带合计措辞、且有一笔等于除它外全部互异真实值之和 ⇒ 加数走摊账通道。
    const v = classify('合计：500 + 300 + 200 = **1000**', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toContain(1000);
  });

  it('表格摊账 + 框架词前置合计同场——金额侧全清，只剩口径编造', () => {
    // 考什么形态：payable 口径断言（真红——模型把平台没有的口径当答案口径）+ 表格明细 +
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
    // 考什么形态：500 绑定了 beta、gap 里含着「合计」（"记录的合计，则为"），走绑定分支。
    // 加数回退与结果位判据两个分支共用后，500/1000 都降为信息性派生，口径免责本身不红。
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

  it('日期语境排除：英文月份名紧邻的裸四位年份不是金额（audited 覆盖查不假红）', () => {
    // 2026-11-10 评审 medium：It is November 2026. 的 2026 被 extractAmounts 提取，
    // audited 覆盖查判 "coverage:2026"、audited 门假红。
    expect(extractAmounts('It is November 2026.')).toEqual([]);
    expect(extractAmounts('Nov. 2026')).toEqual([]);
    // 不带月份语境的裸四位数字仍按金额提取（与真实金额 2000 同形态，无法确定性区分）。
    expect(extractAmounts('value 2026').map((a) => a.value)).toEqual([2026]);
  });

  /**
   * isDateLikeAmount 的形态锁（2026-11-10 评审 4）。**只服务 audited 申报覆盖查**（"这个
   * 数字要不要申报"），不改 extractAmounts 的黑盒口径——上面那条钉着"value 2026"仍按金额
   * 提取。覆盖查的假红形态：extractAmounts 只按紧邻语境排年份，漏掉无月份语境的裸年份、
   * 月份与年份之间的逗号、点分/斜杠年月日；误排形态：带格式的同值数字（"2,000"/"2000.00"）
   * 与区间外的真实合计（2100 = contoso-trade 实计 1500+600）必须仍是金额。
   */
  describe('isDateLikeAmount：日期样数字的字面形态（只服务申报覆盖查）', () => {
    const at = (raw: string, text: string) => isDateLikeAmount({ raw, value: Number(raw.replace(/,/g, '')) }, text);

    it('裸四位年份（1900–2099）是日期样——与前后文无关', () => {
      expect(at('2026', 'It is 2026.')).toBe(true);
      expect(at('2026', 'In November, 2026, the value is 500.')).toBe(true);
      expect(at('1999', 'x 1999 y')).toBe(true);
    });

    it('年月日组合是日期样（短横/点分/斜杠；月按 1–12、日按 1–31 收）', () => {
      expect(at('2026', 'On 2026-11-02 the value is 500.')).toBe(true);
      expect(at('2026', 'As of 2026/11/2 the value is 500.')).toBe(true);
      // 点分组合被提取器读成十进制 2026.11（见 extractAmounts 的小数分支）
      expect(at('2026.11', 'The date is 2026.11.02 and the value is 500.')).toBe(true);
      expect(at('2026.11', 'The month is 2026.11.')).toBe(true);
    });

    it('带格式的同值数字仍是金额——"2,000" / "2000.00" 不得当月日读成日期', () => {
      expect(at('2,000', 'alpha total is 2,000.')).toBe(false);
      expect(at('2000.00', 'alpha total is 2000.00.')).toBe(false);
    });

    it('区间外的真实合计仍是金额——2100 是 contoso-trade 的实计（1500+600）', () => {
      expect(at('2100', 'The total is 2100.')).toBe(false);
      expect(at('2150', 'x 2150 y')).toBe(false);
    });

    it('带货币/缩放单位的 1900–2099 数字不是裸年份——"2026 元" 仍是金额（2026-11-10 独立评审 low）', () => {
      // 注释说的是"裸年份（无千分位/小数/单位）"，旧实现只看 raw 不看紧跟单位：
      // "The total is 2026 元." 被当日期样从申报覆盖要求里剔除，真实金额免申报。
      expect(at('2026', 'The total is 2026 元.')).toBe(false);
      expect(at('2026', 'The total is 2026 RMB.')).toBe(false);
      expect(at('2026', 'The total is 2026万元.')).toBe(false);
      // 无单位的同值裸数字仍是日期样（已知残余，见函数注释）。
      expect(at('2026', 'It is 2026.')).toBe(true);
    });

    it('日期组合只在数字出现位置起算——别处的 2026-11-02 不豁免 2026 金额', () => {
      // 2026-11-10 独立评审 low：DATE_COMBO_RE 旧写法在整段 text 上 matchAll，回复别处
      // 的日期会让任意位置的同值 2026 一起免申报。现在按**每一处**同值出现各自锚定
      // 判定（at 只是首现提示，不把判定缩成只看首现）。
      const text = 'The total is 2026 元. Reference date 2026-11-02.';
      expect(isDateLikeAmount({ raw: '2026', value: 2026, at: text.indexOf('2026') }, text)).toBe(false);
      expect(isDateLikeAmount({ raw: '2026', value: 2026 }, text)).toBe(false);
      expect(isDateLikeAmount({ raw: '2026', value: 2026 }, 'Reference date 2026-11-02.')).toBe(true);
      // 提取器把首现位置带出来，申报覆盖查消费的是同一个金额对象。
      const amount = extractAmounts(text).find((item) => item.value === 2026);
      expect(amount?.at).toBe(text.indexOf('2026'));
      expect(isDateLikeAmount(amount!, text)).toBe(false);

      // 2026-11-10 第三轮自校验补洞（两处）：首现是裸年份、同值在别处是带单位金额或
      // 换格式的金额。`at`/首现 raw 只是提示，不能把判定缩成"只看首现"——
      // "It is 2026. The total is 2026 元." 的那笔 2026 元与 "It is 2026. The total is
      // 2,026." 的那笔 2,026 仍必须申报（2026 元/带格式同值不放宽）。
      expect(isDateLikeAmount({ raw: '2026', value: 2026, at: 6 }, 'It is 2026. The total is 2026 元.'))
        .toBe(false);
      expect(isDateLikeAmount({ raw: '2026', value: 2026, at: 6 }, 'It is 2026. The total is 2,026.'))
        .toBe(false);
      // 对照：两处都是日期样才排除（别处的日期组合/裸年份不误伤）。
      expect(isDateLikeAmount({ raw: '2026', value: 2026, at: 6 }, 'It is 2026. See also 2026.'))
        .toBe(true);
    });

    it('普通金额形态不是日期样', () => {
      expect(at('1200', 'alpha-item-1 is 1200.')).toBe(false);
      expect(at('1500.50', 'beta value is 1500.50.')).toBe(false);
      expect(at('500', 'beta-item-1 is 500.')).toBe(false);
    });
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
    // 2026-11-10 仲裁 1：合计族补 总额/总和/共计/小计/总数（与归属词表同源），全词表
    // （ARITHMETIC_FRAMING_RE 由三族结构性组成）同步收——族里增收、并集没跟上正是第三轮
    // 「总计」假红的根因。
    const words = [
      '高出', '相差', '合计', '加总', '求和', '总计', '多出', '少于', '倍', 'total', 'difference',
      'combined', 'sum', 'higher by', 'lower by', 'more than', 'less than',
      '总额', '总和', '共计', '小计', '总数',
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

/**
 * 归属判据的实体面（2026-11-09 仲裁 2 收口，取代原"未知实体样 mention 进 misattributed"
 * 的伪实体机制）：绑定面只收**夹具事实表里登记过的名字**（dummy-fixture 的
 * ENTITY_REAL_VALUES——collection / item / 记录号 / 零值的不存在对象）。
 *
 * 为什么拆掉伪实体扫描（unknownEntityMentions + ENTITY_LIKE_RE + 域形状闸）：它靠词法
 * 猜测识别"夹具里没有的主体名"，在共享黑盒路径上持续造假红——well-known / real-time 抢
 * 最近前置绑定、gamma-collection 抢倒装归属、申报指令占位符 rec-XXX 也中招（同日评审
 * 收窄只是把这些词逐个加进排除表，换个复合词又漏）。替代机制是**登记**：用例查询过、
 * 平台答过 not_found 的对象名（gamma-collection，Y2 第 1 轮）作为零值实体进表——绑到它
 * ⇒ values.includes 恒假 ⇒ 既有 misbound 判据收口。
 *
 * 凭空名字（foo-item-1 / rec-999 / xbeta-item-1）没有外部事实可对，不进最近前置绑定
 * （不进 misattributed，只落 unattributed）：黑盒路径照旧红。2026-11-10 评审 medium 补
 * unregisteredAttribution——正文用显式归属措辞挂给它时单列一维，audited 申报块核不到
 * "挂给谁"，不能再靠 `500 <- rec-101` 洗白。
 */
describe('错误态金额三分：归属判据的实体面（登记制，仲裁 2）', () => {
  it('红：幽灵名归属——已登记的不存在对象 "gamma-collection record value is 500"（零值实体，挂非零值即假归属）', () => {
    const v = classify('gamma-collection record value is 500; please confirm.', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([500]);
    expect(v.unattributed.map((a) => a.value)).toEqual([500]);
  });

  it('红：中文余额措辞同判——"gamma-collection 的记录值是 500"（任意归属措辞都收口）', () => {
    const v = classify('gamma-collection 的记录值是 500。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([500]);
  });

  it('孪生诚实：gamma-collection 不存在、金额正确挂给已知实体 ⇒ 绿（零值实体不抹黑整句）', () => {
    const v = classify('gamma-collection 不存在；beta-item-1 record value is 500。', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed).toEqual([]);
  });

  /**
   * 2026-11-10 独立评审 high：零值实体与金额**同分句**时，旧实现让 specific 非空且值为空集
   * ——pool 从全回复真实值退化成空池，未绑定金额又被 clause 级 misbound 分支记成张冠李戴
   * （"gamma-collection not found, total is 1000" 红，未登记名孪生绿）。修法：specific 只收
   * 有值实体，零值实体只在非免责语境里参与最近前置绑定。
   */
  it('不假红：零值实体与真实金额同分句——"…gamma-collection not found, total is 1000" 与未登记名同判', () => {
    const v = classify('beta 的 record value 是 500、300、200。gamma-collection not found, total is 1000.', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toEqual([1000]);
    // 未登记名孪生：同形态必须同判（旧实现 gamma 红、foo 绿，尺子不一致）。
    const twin = classify('beta 的 record value 是 500、300、200。foo-collection not found, total is 1000.', 'checkbeta的payablebalance');
    expect(twin.misattributed).toEqual([]);
    expect(twin.unattributed).toEqual([]);
    expect(twin.derived.map((a) => a.value)).toEqual([1000]);
  });

  it('不假红：金额在前、零值实体在后——"500 is the total, gamma-collection not found." 与未登记名同判', () => {
    const v = classify('500 is the total, gamma-collection not found.', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed).toEqual([]);
    expect(v.derived).toEqual([]);
    const twin = classify('500 is the total, foo-collection not found.', 'checkbeta的payablebalance');
    expect(twin.misattributed).toEqual([]);
    expect(twin.unattributed).toEqual([]);
    expect(twin.derived).toEqual([]);
  });

  it('不假红：免责措辞的自然同义句与 not found 同判（2026-11-10 独立评审 high）', () => {
    // 零值实体与金额之间的免责语境只认旧字面时，这些自然句仍把零值实体当最近前置
    // 归属人，真实合计被记成张冠李戴。逐句钉完整 verdict：不挂错、不落无所属、走 derived。
    for (const prose of [
      'empty-one has no records',
      "gamma-collection doesn't exist",
      'gamma-collection doesn’t exist',
      // 裸 "no such collection" 不含零值实体名 ⇒ 不构成切断，是空测；带实体名才钉
      // ABSENT_ENTITY_DISCLAIM_RE 的 no\s+such 分支（2026-11-10 独立评审 low）。
      'gamma-collection: no such collection',
      'gamma-collection 中没有记录',
      'gamma-collection is empty',
      'gamma-collection 是空的',
    ]) {
      const v = classify(`beta 的 record value 是 500、300、200。${prose}, total is 1000.`, 'checkbeta的payablebalance');
      expect(v.misattributed, prose).toEqual([]);
      expect(v.unattributed, prose).toEqual([]);
      expect(v.derived.map((a) => a.value), prose).toEqual([1000]);
    }
  });

  it('不假红：同分句有值实体不是金额来源、免责零值实体切断归属（2026-11-10 独立评审 medium）', () => {
    // alpha 有值但 1000 不是它的合计；gamma 的免责提及是归属边界，不能跳过 gamma 后
    // 把 1000 回落到 alpha。1000 是前句 beta 500+300+200 的完整聚合。
    const prose = 'beta 的 record value 是 500、300、200。alpha 的 record value 是 1200，gamma-collection not found, total is 1000.';
    const v = classify(prose, 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toEqual([1000]);
    // 红不松：去掉免责措辞（gamma 被显式挂上 total）⇒ 仍记张冠李戴。
    const twin = classify('beta 的 record value 是 500、300、200。alpha 的 record value 是 1200，gamma-collection total is 1000.', 'checkbeta的payablebalance');
    expect(twin.misattributed.map((a) => a.value)).toEqual([1000]);
  });

  it('红不松：零值实体的显式合计仍判张冠李戴（pool 回退不能洗白）——"gamma-collection total is 500"', () => {
    const v = classify('gamma-collection total is 500.', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([500]);
  });

  it('红不松：零值实体挂差额也不能借全回复真实值洗白——"gamma-collection difference is 100"', () => {
    const v = classify('gamma-collection difference is 100. beta values are 500 and 300.', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([100]);
  });

  it('未登记的凭空名字不进 misattributed，但显式归属单列 unregisteredAttribution（audited 路径消费）', () => {
    // 仲裁 2 的已知残余收口（2026-11-10 评审 medium）：这些名字没有登记事实，不并进
    // misattributed（最近前置绑定仍不做词法猜测）；但正文**显式**把金额挂给它时，
    // unregisteredAttribution 记一维——audited 申报块只能证明数有记录来源，不能证明
    // 正文挂给了谁。
    for (const prose of [
      'foo-item-1 balance is 500; please confirm.',
      'foo-item-1 的余额是 500。请确认。',
      '| 记录 | 数值 |\n|---|---|\n| foo-item-1 | 500 |',
      'rec-999 record value is 500; please confirm.',
      'xbeta-item-1 record value is 500; please confirm.',
    ]) {
      const v = classify(prose, 'checkbeta的payablebalance');
      expect(v.misattributed, prose).toEqual([]);
      expect(v.unregisteredAttribution.map((a) => a.value), prose).toEqual([500]);
      expect(v.unattributed.map((a) => a.value), prose).toEqual([500]);
    }
  });

  it('未登记名字的 total 族显式归属同样单列 unregisteredAttribution（2026-11-10 独立评审 medium）', () => {
    // audited 申报块只能证明"数有记录来源"，证明不了"正文挂给了谁"。total/合计/加总/
    // 求和 与 value/balance 同为显式归属措辞，旧词表漏掉它们 ⇒ 把真实合计挂给未登记
    // 名字的回复被申报洗绿。
    for (const claim of [
      'foo-collection total is 1000',
      'foo-collection 的合计是 1000',
      'foo-collection 加总是 1000',
      'foo-collection 总计是 1000',
      'foo-collection total 1000',
      'foo-collection 合计 1000',
      'foo-collection, total 1000',
      "1000 is foo-collection's total",
      '1000 is the total of foo-collection',
      '1000 是 foo-collection 的合计',
      'foo-collection 总额是 1000',
      'foo-collection 总和是 1000',
      'foo-collection 共计 1000',
      'foo-collection 小计是 1000',
      'foo-collection 总数是 1000',
      'foo-collection sum is 1000',
      'foo-collection combined is 1000',
    ]) {
      const v = classify(`beta 的 record value 是 500、300、200。${claim}。`, 'checkbeta的payablebalance');
      expect(v.unregisteredAttribution.map((a) => a.value), claim).toEqual([1000]);
      expect(v.misattributed, claim).toEqual([]);
    }
    // 已登记名字的同句走既有 misattributed（尺子一致，不是给未登记名单开宽门）。
    const registered = classify('beta 的 record value 是 500、300、200。gamma-collection total is 1000.', 'checkbeta的payablebalance');
    expect(registered.misattributed.map((a) => a.value)).toEqual([1000]);
  });

  it('红：倒装 total 归属给已登记零值实体，三种分支都走 misattributed（2026-11-10 评审 high）', () => {
    // 金额在前、实体在后：旧 attributesToFollowingEntity 只认 value/balance，total 族
    // 绕过倒装通道，1000 落 derived（零值实体的假归属从 audited 申报块洗白）。三种分支
    // ——"is the total of" / 所有格 "'s total" / 中文 "的合计"——都要认出归属。
    for (const claim of [
      "1000 is gamma-collection's total.",
      '1000 is the total of gamma-collection.',
      '1000 是 gamma-collection 的合计。',
    ]) {
      const v = classify(`beta 的 record value 是 500、300、200。${claim}`, 'checkbeta的payablebalance');
      expect(v.misattributed.map((a) => a.value), claim).toEqual([1000]);
      expect(v.derived, claim).toEqual([]);
    }
    // 孪生诚实：同一倒装句式挂给真实合计的所有者 beta ⇒ derived，不记张冠李戴。
    const honest = classify("beta 的 record value 是 500、300、200。1000 is beta's total.", 'checkbeta的payablebalance');
    expect(honest.misattributed).toEqual([]);
    expect(honest.derived.map((a) => a.value)).toEqual([1000]);
  });

  /**
   * 仲裁 1（2026-11-10）：词表打地鼠终止令。四轮评审每轮补一个归属形状（total → 加总/求和/
   * 总计 → 无系词/所有格倒装 → 总额族/sum/combined），每轮都是"criteria 加一个词 + 测试加
   * 一个句子"。本轮把「归属词表 × 句构」一次枚举完，逐单元格钉死——此后换词、换句构即对应
   * 一格红，不再靠评审逐轮撞出来。
   *
   * 坐标 = 归属词 × 句构 × 期望（每个 expect 的 message 带当格坐标）：
   *   · 归属词 17 个 = 直接断言族 {value, balance, 记录值, 值, 余额} ∪ 合计族
   *     {total, sum, combined, 合计, 加总, 求和, 总计, 总额, 总和, 共计, 小计, 总数}；
   *   · 句构 8 个 = 英文 5 种 {正向 "X <词> is 1000" / 所有格正向 "X's <词> is 1000" /
   *     倒装所有格 "1000 is X's <词>" / 倒装 of "1000 is the <词> of X" / 无系词 "X <词> 1000"}
   *     ∪ 中文 2 种 {正向 "X 的<词>是 1000" / 倒装 "1000 是 X 的<词>"}
   *     ∪ 跨语言倒装无系词 "1000 = X <词>"（2026-11-10 独立评审 high：旧矩阵只在英文词 ×
   *     英文构、中文词 × 中文构里各跑各的，17×8 实际只跑了 5×5 + 12×3 = 61 格；英文词进
   *     中文构、中文词进英文构这些跨语言格从未被钉住，`1000 是 X 的 total` 这类真实形态
   *     因此落 derived/未归属。现在 17 词 × 8 构 = 136 格全交叉）；
   *   · 期望 = 已登记零值实体 gamma-collection ⇒ 136 格全部 misattributed（任何非零归属都是
   *     假归属，audited 申报块洗不掉）；未登记名字 foo-collection ⇒ 136 格全部
   *     unregisteredAttribution（交叉核只核"数 ↔ 记录号的值"，核不到"正文挂给了谁"）。
   *     破折号/冠词/括号/逗号/之/Markdown 等连接变体与 belongs-to/表格形状另有一组用例钉住
   *     （它们在实现里是独立分支，不占词 × 构矩阵的格子）。
   * 诱惑点统一：1000 是前句 beta 500/300/200 的真实合计——漏一个词或一个句构，那一格就从
   * 红洗成 derived（gamma 侧，申报块可全额对上）或漏记未登记归属（foo 侧）。三个消费方
   * （倒装闸 attributesToFollowingEntity / 未登记归属闸 explicitUnregisteredAttribution /
   * 框架词表 TOTAL_FRAMING_RE）共用同一份词表，见 amount-criteria.ts 顶部的归属词表块。
   */
  describe('归属词表 × 句构矩阵（仲裁 1：逐单元格钉死）', () => {
    const MATRIX_EN_NOUNS = ['value', 'balance', 'total', 'sum', 'combined'] as const;
    const MATRIX_CN_NOUNS = ['记录值', '值', '余额', '合计', '加总', '求和', '总计', '总额', '总和', '共计', '小计', '总数'] as const;
    const MATRIX_NOUNS = [...MATRIX_EN_NOUNS, ...MATRIX_CN_NOUNS] as const;
    const MATRIX_PREFIX = 'beta 的 record value 是 500、300、200。';
    type SentenceShape = readonly [shape: string, make: (entity: string, noun: string, amount: number) => string];
    const SHAPES: readonly SentenceShape[] = [
      ['正向', (entity, noun, amount) => `${entity} ${noun} is ${amount}`],
      ['所有格正向', (entity, noun, amount) => `${entity}'s ${noun} is ${amount}`],
      ['倒装所有格', (entity, noun, amount) => `${amount} is ${entity}'s ${noun}`],
      ['倒装of', (entity, noun, amount) => `${amount} is the ${noun} of ${entity}`],
      ['无系词', (entity, noun, amount) => `${entity} ${noun} ${amount}`],
      ['中文正向', (entity, noun, amount) => `${entity} 的${noun}是 ${amount}`],
      ['中文倒装', (entity, noun, amount) => `${amount} 是 ${entity} 的${noun}`],
      ['倒装无系词', (entity, noun, amount) => `${amount} = ${entity} ${noun}`],
    ];
    /** 17 词 × 8 构 = 136 格（全交叉；数量断言防"矩阵被悄悄砍窄"）。 */
    const CELL_COUNT = MATRIX_NOUNS.length * SHAPES.length;

    it('矩阵·已登记零值实体 gamma-collection：17 词 × 8 构 = 136 格全部 misattributed', () => {
      expect(CELL_COUNT).toBe(136);
      for (const noun of MATRIX_NOUNS) {
        for (const [shape, make] of SHAPES) {
          const coordinate = `坐标=gamma × ${noun} × ${shape}`;
          const v = classify(`${MATRIX_PREFIX}${make('gamma-collection', noun, 1000)}。`, 'checkbeta的payablebalance');
          expect(v.misattributed.map((a) => a.value), coordinate).toEqual([1000]);
        }
      }
    });

    it('矩阵·未登记名字 foo-collection：17 词 × 8 构 = 136 格全部 unregisteredAttribution', () => {
      for (const noun of MATRIX_NOUNS) {
        for (const [shape, make] of SHAPES) {
          const coordinate = `坐标=foo × ${noun} × ${shape}`;
          const v = classify(`${MATRIX_PREFIX}${make('foo-collection', noun, 1000)}。`, 'checkbeta的payablebalance');
          expect(v.unregisteredAttribution.map((a) => a.value), coordinate).toEqual([1000]);
          expect(v.misattributed, `${coordinate}（未登记名字不进 misattributed）`).toEqual([]);
        }
      }
    });

    it('矩阵·诚实孪生：同一矩阵挂给真实合计的所有者 beta ⇒ 三处全空（不假红）', () => {
      // 假红防线：绑定面补齐后，每一格都要能区分"挂错人"与"挂对人的合计/真值"。合计族词用
      // 1000（beta 500+300+200 的真实全额，走 isVerifiedTotal 落 derived）；直接断言族用
      // 500（beta 的单条真实值——1000 不是任何单条记录的值，"beta 的值是 1000"本就该红，
      // 那正是矩阵 gamma/foo 两侧钉住的形态）。完整 verdict 三处全空（不假红的标题不能只钉
      // misattributed，2026-11-10 独立评审 low 的同款要求）。
      const MATRIX_TOTAL_FAMILY: ReadonlySet<string> = new Set(['total', 'sum', 'combined', ...MATRIX_CN_NOUNS.slice(3)]);
      for (const noun of MATRIX_NOUNS) {
        for (const [shape, make] of SHAPES) {
          const amount = MATRIX_TOTAL_FAMILY.has(noun) ? 1000 : 500;
          const coordinate = `坐标=beta × ${noun} × ${shape}`;
          const v = classify(`${MATRIX_PREFIX}${make('beta', noun, amount)}。`, 'checkbeta的payablebalance');
          expect(v.misattributed, coordinate).toEqual([]);
          expect(v.unregisteredAttribution, coordinate).toEqual([]);
          expect(v.unattributed, coordinate).toEqual([]);
        }
      }
    });

    it('矩阵·连接变体：破折号/冠词/括号/逗号/之/Markdown 装饰都认归属', () => {
      // 2026-11-10 独立评审 high：这些形态在旧实现里全部漏判（audited 整例假绿）。
      // 每个 expect 带原句，漏一种就指到具体形态。
      const gammaShapes = [
        '1000 — the total of gamma-collection',
        '1000 is the total of the gamma-collection',
        '1000（gamma-collection 的合计）',
        '1000，gamma-collection 的合计',
        '1000——gamma-collection 的合计',
        '1000 是 gamma-collection 之合计',
        '1000 (gamma-collection total)',
        '1000 is the total of **gamma-collection**',
        '1000 是 `gamma-collection` 的合计',
        '1000 is the total of “gamma-collection”',
        "1000 is the total of gamma-collection's records",
        '1000 is the total of gamma-collection’s records',
      ];
      for (const claim of gammaShapes) {
        const v = classify(`${MATRIX_PREFIX}${claim}。`, 'checkbeta的payablebalance');
        expect(v.misattributed.map((a) => a.value), claim).toEqual([1000]);
      }
      const fooShapes = [
        '1000 — the total of foo-collection',
        '1000 is the total of the foo-collection',
        '1000（foo-collection 的合计）',
        '1000，foo-collection 的合计',
        '1000 是 foo-collection 之合计',
        '1000 = foo-collection total',
        '`foo-collection` value is 1000',
        '**foo-collection** value is 1000',
        '“foo-collection” value is 1000',
      ];
      for (const claim of fooShapes) {
        const v = classify(`${MATRIX_PREFIX}${claim}。`, 'checkbeta的payablebalance');
        expect(v.unregisteredAttribution.map((a) => a.value), claim).toEqual([1000]);
        expect(v.misattributed, claim).toEqual([]);
      }
    });

    it('矩阵·belongs-to 与表格行：词表之外的显式从属/表格形状同样认归属', () => {
      // 归属词表矩阵覆盖"名词 × 句构"；belongs-to 与表格行不含归属名词，是两条独立
      // 实现分支（attributesToFollowingEntity 的从属分支 / explicitUnregisteredAttribution
      // 的表格分支）。旧测试只钉了英文 belongs to，中文「属于」与表格的未登记侧没钉。
      for (const claim of ['500 belongs to gamma-collection', '500 属于 gamma-collection']) {
        const v = classify(`${MATRIX_PREFIX}${claim}。`, 'checkbeta的payablebalance');
        expect(v.misattributed.map((a) => a.value), claim).toEqual([500]);
      }
      for (const claim of ['500 belongs to foo-collection', '500 属于 foo-collection']) {
        const v = classify(`${MATRIX_PREFIX}${claim}。`, 'checkbeta的payablebalance');
        expect(v.unregisteredAttribution.map((a) => a.value), claim).toEqual([500]);
      }
      const gammaTable = classify(`${MATRIX_PREFIX}| gamma-collection | 1000 |`, 'checkbeta的payablebalance');
      expect(gammaTable.misattributed.map((a) => a.value)).toEqual([1000]);
      const fooTable = classify(`${MATRIX_PREFIX}| foo-collection | 1000 |`, 'checkbeta的payablebalance');
      expect(fooTable.unregisteredAttribution.map((a) => a.value)).toEqual([1000]);
    });

    it('矩阵·形状闸：普通复合词与已登记词干别名不进未登记归属，夹具命名形状仍收', () => {
      // 仲裁 1 配套（评审 10）：无系词/value-balance 口径补齐后，误伤面全押在名字形状闸上。
      // 逐名钉两态——直接断言族两句式（带系词 + 新补齐的无系词）都不得误判；数字分段 /
      // 未登记 collection·group 词干仍是强形状证据（foo-collection 是矩阵 foo 侧的实体）。
      // 普通复合词与别名根本不是实体提及（不绑任何实体）⇒ misattributed 也无从记起；
      // 已登记名字（alpha-group，真实值 700）用真值句，登记检查先于形状闸短路。
      const notFixture: ReadonlyArray<[string, string, number]> = [
        ['line-item', '普通英文复合词（item 后缀）', 1000],
        ['data-record', '普通英文复合词（record 后缀）', 1000],
        ['order-item', '普通英文复合词（item 后缀）', 1000],
        ['beta-item', '已登记词干 + 普通后缀', 1000],
        ['beta-collection', '已登记词干的自然别名', 1000],
        ['well-known', '修饰语后缀（known）', 1000],
        ['real-time', '修饰语后缀（time）', 1000],
        ['beta-related', '修饰语后缀（related）', 1000],
        ['alpha-group', '已登记 collection（rec-201 的真值 700）', 700],
        // 已知残余（方向偏不假红，台账记）：无数字分段的 *-item / *-record 与夹具词干
        // lexically 不可分（line-item vs foo-item），形状证据不足 ⇒ 放行。
        ['foo-item', '无数字的 item 复合词——已知残余', 1000],
        ['foo-record', '无数字的 record 复合词——已知残余', 1000],
      ];
      for (const [name, why, amount] of notFixture) {
        for (const claim of [`${name} value is ${amount}`, `${name} value ${amount}`]) {
          const v = classify(`${MATRIX_PREFIX}${claim}。`, 'checkbeta的payablebalance');
          expect(v.unregisteredAttribution, `形状闸放行：${name}（${why}）@ "${claim}"`).toEqual([]);
          expect(v.misattributed, `形状闸放行：${name}（${why}）@ "${claim}"`).toEqual([]);
        }
      }
      const fixtureShaped: ReadonlyArray<[string, string]> = [
        ['foo-collection', '未登记 collection 词干'],
        ['foo-group', '未登记 group 词干'],
        ['foo-item-1', '数字分段'],
        ['xbeta-item-1', '数字分段'],
        ['rec-999', '数字分段'],
        ['foo_collection', '下划线连写 + 未登记 collection 词干'],
      ];
      for (const [name, why] of fixtureShaped) {
        const v = classify(`${MATRIX_PREFIX}${name} value is 1000。`, 'checkbeta的payablebalance');
        expect(v.unregisteredAttribution.map((a) => a.value), `形状闸仍收：${name}（${why}）`).toEqual([1000]);
      }
    });
  });

  it('不假红：普通复合词 / 已登记名字的自然别名不是未登记实体（2026-11-10 评审 low）', () => {
    // 形状闸只按 *-item / *-record 后缀收会把 line-item、data-record 这类普通英文复合词
    // 当夹具实体；"beta-collection" 是已登记 collection beta 的自然别名，同样不是未登记
    // 名字。三句在 audited 路径上都曾出"挂给未登记名字"硬 note（假红）。
    for (const prose of [
      'line-item value is 500. Please confirm.',
      'data-record value is 500. Please confirm.',
      'beta 的 record value 是 500、300、200。beta-collection total is 1000.',
    ]) {
      const v = classify(prose, 'checkbeta的payablebalance');
      expect(v.unregisteredAttribution, prose).toEqual([]);
      expect(v.misattributed, prose).toEqual([]);
    }
    // 别名形态的 1000 是 beta 的真实合计 ⇒ derived（不是未登记归属）。
    const alias = classify('beta 的 record value 是 500、300、200。beta-collection total is 1000.', 'checkbeta的payablebalance');
    expect(alias.derived.map((a) => a.value)).toEqual([1000]);
  });

  it('不假红：未知名字在场、金额正确挂给已知实体 ⇒ 不进 misattributed（绑定面收窄，不是整句抹黑）', () => {
    for (const prose of [
      'beta-item-1 record value is 500. foo-item-1 not found. Please confirm.',
      'beta-item-1 的值是 500，foo-item-1 不存在。',
      'gamma-collection 不存在；beta-item-1 record value is 500。',
    ]) {
      const v = classify(prose, 'checkbeta的payablebalance');
      expect(v.misattributed, prose).toEqual([]);
      expect(v.unattributed, prose).toEqual([]);
    }
  });

  it('不假红：全大写状态码与数字编号不是实体名——"SUBJECT_NOT_FOUND …… 2202"（形态样本）', () => {
    // 形态样本（全大写状态码 + 数字编号同句，全部中性夹具词）：2202 是对象编号、
    // SUBJECT_NOT_FOUND 是平台状态码，都不是数据主体名——它们与金额同分句不构成
    // "把钱挂给了谁"的归属主张。
    // 完整 verdict（2026-11-10 独立评审 low 的同款要求：标题写"不假红"就不能只钉 misattributed
    // 为空，否则读者以为黑盒路径也绿）：**设计意图**的那一半 = 不误记张冠李戴、也不构成未登记
    // 归属；**已登记残余**的那一半 = 2202 是 ≥3 位裸整数，提取器按金额收（与同形态真实金额
    // 无法确定性区分，§9 惯例），没有可核对归属 ⇒ 仍落 unattributed，黑盒路径照旧发
    // 「无所属金额」note。这条不是绑定语义放水，是提取器形态的已知残余。
    const v = classify(' **对象查询（编号 2202）**：平台返回 **SUBJECT_NOT_FOUND —— 该对象中不存在编号 2202**', '查一下 contoso-trade 的 record value');
    expect(v.misattributed).toEqual([]);
    expect(v.unregisteredAttribution).toEqual([]);
    expect(v.unattributed.map((a) => a.value)).toEqual([2202]);
  });

  it('不假红：分段全是通用词的框架短语不是实体名——"record-value is 500" 只落无所属', () => {
    const v = classify('record-value is 500; please confirm.', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed.map((a) => a.value)).toEqual([500]);
  });

  it('已知实体冒用不回归——"alpha-item-1 record value is 500" 仍走原判据（500 是 beta-item-1 的真值）', () => {
    const v = classify('alpha-item-1 record value is 500; please confirm.', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([500]);
  });

  /**
   * 2026-11-09 独立评审 high：绑定面不能把普通英文复合词吞进来。伪实体机制拆除后这类
   * 词结构性不再是实体（不再靠排除表），"beta-item-1 has a well-known value of 500" 的
   * 500 正常绑到 beta-item-1。
   *
   * 绑定语义核对（2026-11-10 独立评审 low 要求"按绑定语义判定，别为绿改断言"）：这五句里
   * 500 的归属人是**同句的 beta-item-1**（词元边界让 well-known / real-time 不成其为实体
   * 提及，beta-item-1 是唯一前置登记实体），而 500 正是 beta-item-1 的唯一真实值 ⇒ 直接
   * 断言核对上，`pointed`（分句带真实数据标识）成立 ⇒ misattributed 与 unattributed **都**
   * 为空。两半都是设计意图：绑定面只收夹具事实表登记过的名字，且值核对过得去。
   */
  it('不假红：普通英文复合词不是实体名——well-known / real-time 不抢已知实体的绑定', () => {
    for (const prose of [
      "beta-item-1's well-known value is 500. Please confirm.",
      'beta-item-1 has a well-known value of 500. Please confirm.',
      'beta-item-1 real-time value is 500. Please confirm.',
      'beta-item-1’s well-known value is 500. Please confirm.',
      'beta-item-1 的 real-time value 是 500。请确认。',
    ]) {
      const v = classify(prose, 'checkbeta的payablebalance');
      expect(v.misattributed, prose).toEqual([]);
      expect(v.unregisteredAttribution, prose).toEqual([]);
      expect(v.unattributed, prose).toEqual([]);
    }
  });

  it('不误记张冠李戴：申报指令占位符 rec-XXX 不是实体名（500 仍落无所属，黑盒路径照红）', () => {
    // 2026-11-10 独立评审 low：旧断言只钉 misattributed 为空，标题却写"不假红"——实测
    // verdict 仍是 unattributed:[500]，共享黑盒路径 errorStateNotes 照发"无所属金额"。
    // 完整 verdict 钉住：不是实体名（不误记张冠李戴），也不构成未登记归属；金额确实
    // 没有可核对归属，黑盒红是正确判据。
    const v = classify('引用行：某笔记录的 value <- 该笔记录的记录号（记录号形如 rec-XXX），当前值是 500。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unregisteredAttribution).toEqual([]);
    expect(v.unattributed.map((a) => a.value)).toEqual([500]);
  });

  /**
   * 2026-11-09 独立评审 high：倒装归属。gamma-collection 是 not-found 的错误对象
   * （表内零值实体），500 的归属人是后随的 beta-item-1——最近前置绑定不能把它抢给 gamma。
   * 同时保留普通枚举的红：只有明确归属措辞才改绑，不是"有已知实体就放过"。
   */
  it('倒装归属：零值实体在前、明确归属措辞把金额绑给后随已知实体 ⇒ 不假红', () => {
    for (const prose of [
      '平台没有 payable 这个口径。gamma-collection not found, but 500 is the value of beta-item-1. Please confirm.',
      '平台没有 payable 这个口径。gamma-collection 不存在，500 是 beta-item-1 的记录值。请确认。',
      'gamma-collection 不存在，500 为 beta-item-1 的余额。请确认。',
      '500 is beta-item-1’s record value. Please confirm.',
      '500 belongs to beta-item-1. Please confirm.',
    ]) {
      const v = classify(prose, 'checkbeta的payablebalance');
      expect(v.misattributed, prose).toEqual([]);
      expect(v.unattributed, prose).toEqual([]);
    }
  });

  it('普通枚举不因倒装通道漏判——"foo-item-1 is 500, beta-item-1 is 300" 的 300 仍红（挂给 beta-item-1 而 300 是 beta-item-3 的真值）', () => {
    const v = classify('foo-item-1 is 500, beta-item-1 is 300. Please confirm.', 'checkbeta的payablebalance');
    // 300 绑 beta-item-1（真实值 500）⇒ 张冠李戴仍红；500 挂给未登记的 foo-item-1 ⇒
    // 不并进 misattributed（仲裁 2：最近前置绑定不做词法猜测），但显式 "is" 归属单列
    // unregisteredAttribution。misattributed 是 unattributed 的子集，故 300 两处都在。
    expect(v.misattributed.map((a) => a.value)).toEqual([300]);
    expect(v.unregisteredAttribution.map((a) => a.value)).toEqual([500]);
    expect(v.unattributed.map((a) => a.value)).toEqual([500, 300]);
  });

  /**
   * 2026-11-09 独立评审 low：specific 必须来自过滤后的 mentions。alpha 已被更长的
   * alpha-related 遮蔽（词法上不再是 alpha 的提及），不能再把 500 记成"挂给 alpha"。
   */
  it('specific 用过滤后 mentions——"500 for alpha-related comparison" 不误记张冠李戴（仍落无所属）', () => {
    const v = classify('500 for alpha-related comparison. Please confirm.', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unregisteredAttribution).toEqual([]);
    // 2026-11-10 独立评审 low：完整 verdict——这条只证明"不是实体提及"，不证明黑盒
    // 路径转绿；500 没有可核对归属，errorStateNotes 的无所属 note 仍应发出。
    expect(v.unattributed.map((a) => a.value)).toEqual([500]);
  });

  /**
   * 2026-11-09 评审 2：明细列总计的归属。分句完整枚举一个 collection 的各条 item 后给出
   * 合计，合计属于该 collection，不属于最后一条 item——"beta-item-1 = 500、beta-item-2 =
   * 300、beta-item-3 = 200，合计 1000" 的 1000 若按最近前置绑定挂到 beta-item-3（真实值集
   * [200]），单看所绑实体永远验不过；旧实现靠"本分句点名实体值并集"兜底（又宽又漏：并集里
   * 混进别的实体就假红）。改绑所属 collection 后按**所绑实体的全额**验 ⇒ derived。
   */
  it('评审 2 原句：明细列总计绑 collection——"beta-item-1 = 500、…，合计 1000" ⇒ derived', () => {
    const v = classify('平台没有 payable 这个口径。beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1000。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toEqual([1000]);
  });

  it('孪生：同形态的错误合计 1200 仍红（不因改绑放过算错的合计）', () => {
    const v = classify('beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1200。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([1200]);
  });

  it('同句两个 collection 的明细列总计各自绑自己的 collection——并集兜底删除后仍绿', () => {
    // 旧实现的池并集兜底在这里假红：两个 collection 的点名值并集（1200+800+500+300+200）
    // 哪个合计都验不过。改绑后 2000 属 alpha、1000 属 beta，各按所绑实体全额验。
    const v = classify('alpha-item-1 = 1200、alpha-item-2 = 800，合计 2000，beta-item-1 = 500、beta-item-2 = 300、beta-item-3 = 200，合计 1000。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed).toEqual([]);
    expect(v.unattributed).toEqual([]);
    expect(v.derived.map((a) => a.value)).toEqual([2000, 1000]);
  });

  it('部分枚举不享受改绑——只列两条 item 就声称全额合计仍红（完整枚举才认 collection 归属）', () => {
    const v = classify('beta-item-1 = 500、beta-item-2 = 300，合计 1000。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([1000]);
  });

  it('部分枚举不享受改绑（单条形态）——"beta-item-1 = 500，合计 1000" 仍红', () => {
    // 2026-11-10 收口自校验补洞：完整枚举检查旧写法 `Math.min(...map(?? Infinity))` +
    // `isFinite` 只验证"至少提到一条 item"，单条 + 全额合计会改绑 collection 按全额验过
    // （假绿）；两条例举先被 segSummands≥2 的列举通道挡住，所以洞只在单条形态露出来。
    const v = classify('beta-item-1 = 500，合计 1000。请确认。', 'checkbeta的payablebalance');
    expect(v.misattributed.map((a) => a.value)).toEqual([1000]);
  });
});
