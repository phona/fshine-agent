import { describe, expect, it } from 'vitest';
import { classifyErrorStateAmounts, isVerifiedArithmetic } from './amount-criteria';

/**
 * 金额判据纯核的表征锁（2026-11-07 评审 blocking 点名的反例变异测试 + 既有校准的诚实形态）。
 * 每条注释标了来源：评审反例必须持续红（回归即评审复发），校准形态必须持续绿（回归即误报复发）。
 * extractAmounts 用探针同形的最小替代（千分位/小数金额，字母粘连数字不算——W1/beta-item-1
 * 里的 1 不是金额）；分句/边界逻辑在纯核内自足。
 */

function amounts(text: string): Array<{ raw: string; value: number }> {
  // 与探针 extractAmounts 同形态学（千分位/小数/≥3 位裸整数；rec-401 记录号尾段、W1 里
  // 的 1、共 3 条的 3 都不是金额）——单字符与两位数不在 AMOUNT_PATTERN 内。
  const pattern = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+(?![\d%％])|(?<![\d.])\d{3,}(?![\d.%％])/g;
  const out: Array<{ raw: string; value: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (/(?:[A-Za-z])-$/.test(text.slice(Math.max(0, at - 8), at))) continue;
    out.push({ raw: match[0], value: Number(match[0].replace(/,/g, '')) });
  }
  return out;
}

function classify(reply: string, userText = '') {
  return classifyErrorStateAmounts(reply, userText, amounts);
}

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

  it('实体自身真实值的和算对得上——"beta 合计 800"（500+300）不判无所属', () => {
    const v = classify('beta 合计 800', 'checkbeta的payablebalance');
    expect(v.unattributed).toEqual([]);
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

  it('两级差："alpha 2000（1200+800）、contoso-trade 2100（1500+600），两者相差 100"', () => {
    const v = classify('alpha 2000（1200+800）、contoso-trade 2100（1500+600），两者相差 100');
    expect(v.unattributed).toEqual([]);
  });
});

describe('isVerifiedArithmetic：算术豁免的具体验证', () => {
  it('互异真实值的带符号组合成立（C2 实测形态），同值复用/派生中转不成立（评审反例）', () => {
    const pool = [1500, 600, 450];
    expect(isVerifiedArithmetic(2100, pool)).toBe(true);   // 1500+600（实体实际聚合）
    expect(isVerifiedArithmetic(1650, pool)).toBe(true);   // (1500+600)-450（跨实体差额）
    expect(isVerifiedArithmetic(4.7, pool)).toBe(true);    // 2100/450 约 4.7（聚合值之比）
    expect(isVerifiedArithmetic(100, [1200, 800, 1500, 600])).toBe(true); // 1500+600-1200-800
    expect(isVerifiedArithmetic(1000, [500, 300, 200])).toBe(true);       // beta 三项实计
    // 评审 blocking ② 反例：同值复用与派生值复用推出的假合计，必须红
    expect(isVerifiedArithmetic(1000, [500])).toBe(false);        // 500+500（beta-item-1 唯一值）
    expect(isVerifiedArithmetic(1600, [500, 300, 200])).toBe(false); // (500+300)*2（实计 1000）
    expect(isVerifiedArithmetic(999999, pool)).toBe(false);      // "difference 999999" 照旧红
    expect(isVerifiedArithmetic(1000, [1500, 450])).toBe(false);
  });
});
