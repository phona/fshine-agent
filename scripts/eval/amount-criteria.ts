/**
 * 金额判据纯核（探针 errorStateNotes / amountNote 共用的**单一来源**，无 I/O、不跑模型）。
 *
 * 抽出原因（2026-11-07 评审 blocking：错误态实体绑定要有反例的变异测试）：探针
 * scripts/probe-real-agent.ts 顶层就跑 main()（真实 LLM 装配），测试无法 import；纯核
 * 抽到这里后 amount-criteria.test.ts 才能把评审的反例形态钉成表征锁。夹具事实表在
 * dummy-fixture.ts（单一转录点），本模块只做判定。
 */

import {
  ENTITY_REAL_VALUES,
  MOCK_COLLECTION_WINDOWS,
  MOCK_ITEM_ID_BINDINGS,
  MOCK_ITEMS,
  MOCK_WINDOWS,
  REAL_DATA_TOKENS,
  REAL_DATA_VALUES,
} from './dummy-fixture';

/**
 * 分句切分：中日标点 + 英文句点。英文句点必须进集合——否则一整段英文只有一个"分句"，
 * accountProcessed / staleScopeAmounts / windowSwitchAmounts / errorStateNotes 的
 * 分句归属全部失效（旧collection名出现在段落任何位置就把陈旧金额赦免掉）。
 * 小数点护栏：**只有夹在两个数字之间的点不切**（1,200.00 完整保留）。这里比直觉形式
 * `(?<!\d)\.(?!\d)` 更宽一档——后者连"…is 500. locked-one…"这种以数字结尾的句子也不切，
 * 而那正是英文回复里最常见的形态（金额结尾句 + 下一句），不切就等于分句归属在最该起作用的
 * 地方失效。各站点同一把尺（本常量即单一来源）。
 */
export const CLAUSE_SPLIT = /(?<!\d)\.|\.(?!\d)|[。；;\n]/;

/**
 * 算术框架措辞（中英）：模型自己标注"这是算出来的"——高出/相差/合计/多出/倍数/total/
 * difference/combined/higher by…。与 isDerivedAmount 的配对求和取差合起来判定"诚实算术"，
 * 覆盖 ratio 形态（"约为其 4.7 倍"不是任何两个真实值的和差，但是标好的算术）。
 * 第二个条件（调用处判）= 同一回复里有 ≥2 个真实数值——模型把账摊开了（show your work），
 * 不是凭空蹦一个数；凭空一个数即便带"合计"措辞也照旧红。且该数字须过与措辞同族的
 * 具体验证（2026-11-07 评审 blocking：措辞不能豁免算不出来的数，"difference 999999" 照旧
 * 红；2026-11-08 评审 blocking：合计措辞按 isVerifiedTotal 子集和验，带符号组合不再冒充合计）。
 * 2026-11-07 C2 实测：比较轮答"contoso-trade 2100，比 contoso-logistics（450）高出 1650，
 * 约为其 4.7 倍"与"两者相差 100"——三条全是标好的算术，旧判据全当"金额与真实结果不一致"红。
 * 2026-11-09 成本轮实测补词：Y2 第 3 轮答"三条数值合计 1000……1000 是这三条数值的加总，
 * 不等同于应付余额科目"——第二处 1000 明写"加总"且紧跟口径免责，却因词表只有"合计"落进
 * 无所属（红）。合计的同义措辞（加总/求和）补进词表，语义与既有的"合计 1000 降信息性"
 * （expectations 表格摊账用例）一致：加总照样要过 isVerifiedTotal 子集和验，算不出来照红。
 */
/**
 * "当成本轮已查结果"的措辞（accountDrift 与 C1 漂移尺共用一把尺）。三族：
 *   ① 中文原有分支（已查/查到/结果如下 + **余额为**）——原样保留；
 *   ② 中文中性域分支（记录值/记录 N）——移植时原版的「凭证 N」（旧财税域词）映射到
 *      中性域的「记录」，双语化那轮只补了英文、没补回纯中文形态，中文回复的漂移
 *      因此漏判（2026-11-08 评审 major：用户问 beta、回复「alpha 余额为 1,200」时
 *      accountDrift 认不出来）；
 *   ③ 英文分支（checked/queried/found/balance is|of/record value is/the result/…）。
 * 语料仍有中文与混合语言发送、且不强制英文回复，所以三族都得在。
 */
// 中文分支不能用 \b 收尾——CJK 字符都不是 \w，「值」「为」之间不存在词边界，值\b 恒不匹配。
export const ACCOUNT_RESULT_PHRASING = /已查|查到|结果如下|余额\s*为|记录\s*(?:\d|值)|凭证\s*\d|balance\s*为|record\s*(?:\d|value\b)|checked|queried|\bfound\b|balance\s*(?:is|of)\b|the result|here are|as follows/i;

export const ARITHMETIC_FRAMING_RE = /高出|相差|合计|加总|求和|多出|少于|倍|total|difference|combined|sum\b|higher by|lower by|more than|less than/i;

/**
 * 框架词按**运算种类**分族（2026-11-08 评审 blocking）：措辞标的是什么运算，就按什么
 * 运算验证——合计族只认非负子集和（isVerifiedTotal），差额族认带符号组合
 * （isVerifiedDifference/isVerifiedArithmetic），倍数族认商（isVerifiedRatio）。三族并集
 * = ARITHMETIC_FRAMING_RE 全词表（有测试钉住分族完备性）。同分句多族并存时数字过**任一**
 * 在场族的验证即可降级（"2100，比 450 高出 1650，约为其 4.7 倍"一句三数各有各的运算，
 * 2026-11-07 C2 实测形态）；只剩合计措辞的分句里错误数字无处可蹭——"total is 600" 必须
 * 过子集和，带减项的 500+300−200 蹭不进来。
 * 合计族含"合计"的三个同义措辞（2026-11-09 成本轮：Y2 用"加总"）——加总/求和与合计同一
 * 验证通道（isVerifiedTotal），不是新开口子。
 */
export const TOTAL_FRAMING_RE = /合计|加总|求和|total|combined|sum\b/i;
export const DIFF_FRAMING_RE = /相差|多出|少于|高出|difference|higher by|lower by|more than|less than/i;
export const RATIO_FRAMING_RE = /倍/i;

/**
 * 枚举连接 gap（2026-11-09 codex-pr-review #23 三/四审 blocking）：金额之后到下一笔金额
 * 之间，必须**含一个运算符或枚举连接词**（+ - = × ÷ 和 与 plus and）、其余只允许空白与
 * 标点——「500 + 300」「500 和 300」都算同一笔账里的前后笔。冒号/括号单独不构成证据
 * （"合计：500，明细 500 + 300 + 200 = 1000" 的首笔带冒号仍是合计断言）；夹了文字
 * （"合计 500，明细 …" 的「，明细 」）更不是加数。
 * 已知限度：纯标点枚举（"合计：500、300、200，共 1000"）的首笔不认——往红的方向偏比把
 * 错误合计洗成派生安全；实测形态都是运算符分隔，暂不放开。
 */
const ENUMERATION_GAP_RE = /^[\s、，,。.；;：:()（）\[\]【】]*(?:[+＋\-−=＝×x*／÷]|和|与|plus|and)[\s+＋\-−=＝×x*／÷、，,。.；;：:()（）\[\]【】]*$/i;

/**
 * 由已查数字算术得出的新数值（汇总/对比轮的合计、差额）：等于基集里某两个的和或差。
 * 宿主无法在"算术"与"编造"间确定性区分（§9 记录的同族问题），探针侧只把"算不出来"的金额送审。
 */
export function isDerivedAmount(value: number, base: Set<number>): boolean {
  const values = [...base];
  return values.some((a) => values.some((b) => a + b === value || Math.abs(a - b) === value));
}

/**
 * 具体验证（2026-11-07 评审 blocking：算术措辞不能豁免任意错误数字）：带算术框架措辞的
 * 数字不再仅凭"措辞 + 回复里有 ≥2 个真实值"降信息性——那放得过宽，"Earlier: 1500 and
 * 450; difference 999999" 里 999999 蹭 difference 的车就溜过去了。降级前须验证该数字
 * 确由真实值算得：
 *   · 和/差：两两配对，含两级——"contoso-trade 比 logistics 高出 1650" =
 *     (1500+600)−450，先合计再比较的中间和 2100 不是种子值（2026-11-07 C2 第 13/25 轮
 *     实测形态："相差 100" = 2100−2000 同为两级差）；
 *   · 倍数：与真实值两两的商（1 位小数舍入）一致——"约为其 4.7 倍" = 2100/450≈4.7，
 *     商集含一级和差值（2100 本身是 1500+600 的和）。
 * 算不出来的数字照旧硬红（评审原话：无法验证的数字保留硬失败）。
 */
/**
 * 诚实算术核验（2026-11-07 评审 blocking ② 收紧）：金额必须是**互异真实值**的带符号
 * 组合（每个种子值在整条式子里至多出现一次，正=加数、负=减数），或互异真实值之间的一层商。
 *
 * 为什么不再做两级闭包 + 同值复用：那两条会推出种子里根本不存在的合计——
 *   · "beta-item-1 total value is 1000"：该 item 唯一真实值 500，1000=500+500（同值复用）；
 *   · "beta total is 1600"：beta 真实值 500/300/200（实计 1000），1600=(500+300)+(500+300)
 *     （派生值 800 复用两次）。
 * 合法形态照旧放行：实体实际聚合（contoso-trade 1500+600=2100、beta 500+300+200=1000）、
 * 实体内差额（|1500-600|=900）、跨实体差额（2100-450=1650）、比率（2100/450≈4.7）。
 * 派生值不可能当加数——叶子只能是种子真实值，中转层被整个去掉。
 */
/** 差额半边：互异真实值的带符号组合（等价于两个不相交聚合值之差）。 */
/**
 * 差额半边：互异真实值的带符号组合（等价于两个不相交聚合值之差）。注意它挡不住
 * "values are 500 and 300, difference is 800"——800=|1000−200| 仍是合法组合；
 * 那种形态由调用处的**列举操作数约束**收口（分句列了 ≥2 个真实值时，差额必须
 * 等于其中两个的差），不在这条纯函数里。
 */
export function isVerifiedDifference(value: number, pool: ReadonlyArray<number>): boolean {
  const base = [...new Set(pool)].filter((v) => v > 0);
  if (base.length === 0) return false;
  // 差额 = 两个**不相交非空**子集和之差（2026-11-08 评审 blocking：只存子集和的值时
  // 800=|1000−200| 成立，而 1000=500+300+200 复用了 200——两侧共享一个操作数，
  // 不存在满足约束的差额）。实现保留子集成员（位图），两侧位图相交即拒。
  const subsets: Array<{ sum: number; mask: number }> = [];
  for (let mask = 1; mask < (1 << base.length); mask += 1) {
    let sum = 0;
    for (let i = 0; i < base.length; i += 1) { if (mask & (1 << i)) sum += base[i]!; }
    subsets.push({ sum, mask });
  }
  return subsets.some((a) => subsets.some((b) => (a.mask & b.mask) === 0 && Math.abs(a.sum - b.sum) === value));
}

/** 比率半边：互异叶子组合值之间的一层商（1 位小数舍入）。 */
export function isVerifiedRatio(value: number, pool: ReadonlyArray<number>): boolean {
  const base = [...new Set(pool)].filter((v) => v > 0);
  if (base.length === 0) return false;
  const sums = new Set<number>([0]);
  for (const v of base) {
    for (const s of [...sums]) { sums.add(s + v); sums.add(s - v); }
  }
  // 比率同样建在互异叶子的组合之上："约为其 4.7 倍" = (1500+600)/450——分子是聚合值，
  // 不是叶子；但聚合值本身已是互异叶子的一次组合，复用同一 sums 集即可，不新开中转层。
  const positive = [...sums].filter((s) => s > 0);
  for (const a of positive) {
    for (const b of positive) {
      if (Math.round((a / b) * 10) / 10 === value) return true;
    }
  }
  return false;
}

/**
 * 合计语义核验（2026-11-08 评审 blocking）：合计只认互异真实值的**非负子集和**——每个
 * 种子值至多出现一次且全部为加项。带符号组合（含减项）不是合计的证据："beta W1 record
 * values are 500, 300, 200, total is 600"——600=500+300−200 组合得出来，但 beta W1 实计
 * 1000，600 不是所声称的合计；此前 framed 分支只验"任意带符号组合"，把错合计放成信息性
 * 结果。部分聚合照旧放行（"beta 合计 800" = 500+300，实体内诚实账）。
 */
/**
 * 完整合计核验（2026-11-08 owner 裁决的校准反转）：未列举加数的"合计"必须等于池中
 * **全部**真实值之和——部分和冒充合计就是错合计（"beta total is 800"而 beta 实计
 * 1000，是把 500+300 两颗.item 的和说成总额）。要报部分和就得在分句里列举加数，
 * 走列举通道（列举加数全和）。子集和通道由此关闭——它正是摘樱桃的口子。
 */
export function isVerifiedTotal(value: number, pool: ReadonlyArray<number>): boolean {
  const base = [...new Set(pool)].filter((v) => v > 0);
  if (base.length === 0) return false;
  return base.reduce((sum, v) => sum + v, 0) === value;
}

/**
 * 列举合计核验（2026-11-08 评审 blocking）：加数必须**互异**——同值重复等于把同一笔
 * 记录用两次（"alpha values are 1200 and 1200, total is 2400"而 alpha 实计 2000）。
 * 加数还须是真实种子值（调用处的 segSummands 已过滤 REAL_DATA_VALUES）。
 */
function enumeratedTotalOk(summands: ReadonlyArray<{ value: number }>, total: number): boolean {
  const values = summands.map((a) => a.value);
  return new Set(values).size === values.length && values.reduce((s, v) => s + v, 0) === total;
}

export function isVerifiedArithmetic(value: number, pool: ReadonlyArray<number>): boolean {
  return isVerifiedDifference(value, pool) || isVerifiedRatio(value, pool);
}

/** 用户这句话问到的window（码与名都收）：错误态金额判定的"所问window"依据（名字命中了就连带上码）。 */
/**
 * 数值的格式无关匹配模式（2026-11-08 评审 blocking）：探针 extractAmounts 按**值**去重、
 * 只留首次原文，按原文匹配会漏掉同值不同格式的出现——"alpha … is 1,200; beta … is 1200"
 * 的 beta 串台（无千分位）与 "500" / "500.00" 都因此漏判。模式覆盖：千分位可选
 * （1,?200 同时匹配 "1,200" 与 "1200"）、小数可选（500(?:\.\d{1,2})?）。
 *
 * 小数可选**只对整数值成立**（2026-11-08 评审：裸整数部分同现抢分句）：非整数值的小数
 * 部分必须**必选**——2.5 曾产出 `(?:2)(?:\.5)?`，裸整数 "2" 也命中（回复前置句
 * "We checked 2 collections" 抢走 2.5 的分句定位、运算族丢失、退回通用算术判定通过），
 * 判据被静默放松。尾随零至多两位可选（"2.50" 同值形态）；整数值保持可选
 * （"500" / "500.00" 同值形态不回归）。
 */
export function amountValuePattern(value: number): string {
  const intPart = Math.trunc(value);
  const grouped = intPart.toLocaleString('en-US').replace(/,/g, ',?');
  const decimal = Number.isInteger(value)
    ? '(?:\\.[\\d]{1,2})?'
    : `\\.${String(value).split('.')[1] ?? ''}(?:0{1,2})?`;
  // 单位缩放形态（2026-11-08 评审 minor）：提取器把"0.05万"归一成 500，但分类器按 500
  // 找字面量找不到——中文回复的单位缩写被误判无所属。补上万/亿的缩放字面量
  // （500 ↔ "0.05万"、86000 ↔ "8.6万"），尾随零与单位前空格都可选。
  const unitForms: string[] = [];
  // 万/亿缩放：value/10000（或 /1e8）至多两位小数时成立（500↔0.05万、86000↔8.6万）；
  // 判据用 (value×100) % 10000 === 0——直接取模会漏掉 0.05 这类非整数商。
  if (value > 0 && (value * 100) % 10000 === 0) {
    const wan = (value / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    unitForms.push(`${wan.replace('.', '\\.')}0*\\s*万`);
  }
  if (value > 0 && (value * 100) % 1e10 === 0) {
    const yi = (value / 1e8).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    unitForms.push(`${yi.replace('.', '\\.')}0*\\s*亿`);
  }
  const plain = `(?:${grouped}|${String(intPart)})${decimal}`;
  // 无单位形态时不追加空分支——"(?:a|)" 会匹配空串，位置绑定整个错掉。
  return unitForms.length > 0 ? `(?:${plain}|${unitForms.join('|')})` : plain;
}

/** 按模式（非原文）找数字边界的出现位置——amountValuePattern 的载体。 */
function patternPositions(clause: string, pattern: string): number[] {
  const out: number[] = [];
  for (const match of clause.matchAll(new RegExp('(?<![\\d.,%％])' + pattern + '(?!\\d)', 'g'))) out.push(match.index ?? 0);
  return out;
}

/**
 * 分句里某金额原文的全部**数字边界**出现位置。indexOf 不行——"100" 会命中进 "1500"、
 * "500" 会命中进 "1500"，位置绑定整个错掉（2026-11-08 实测：跨实体差额用例的 100 被绑到
 * 1500 里的假位置上，gap 取成 "0+600"，差额措辞匹配不到，诚实算术被判红）。
 */
function boundaryPositions(clause: string, raw: string): number[] {
  const pattern = new RegExp(`(?<![\\d.,%％])${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'g');
  const out: number[] = [];
  for (const match of clause.matchAll(pattern)) out.push(match.index ?? 0);
  return out;
}

export function askedWindows(userText: string): Set<string> {
  const asked = new Set<string>();
  for (const subject of MOCK_WINDOWS) {
    if (userText.includes(subject.name)) { asked.add(subject.code); asked.add(subject.name); }
    if (userText.includes(subject.code)) asked.add(subject.code);
  }
  return asked;
}

/**
 * 错误态金额的口径绑定（2026-11-07 评审 blocking）：金额所在分句把平台没有的口径当答案
 * 口径（"beta payable balance is 500"——500 确是 beta-item-1 的真实 record value，但
 * 夹具权威 schema 只有 records{name,value}，即 record value 一个口径），静默回落照红。
 * 口径词表按语料实据收：payable（Y2 T3 问句、corpus）、bank（acceptance 6.4/7.5 问句、
 * 探针 field 词表）、debt（corpus）；record value / value / balance 是夹具口径或回复侧
 * 中性金额词（语料诚实形态 "balance 500"），不收。分句带否定/让步限定（"平台没有
 * payable""no payable caliber""只有 record value"）是诚实澄清不是断言，不触发——诚实
 * 形态（"平台没有 payable 这个口径，beta W1 的 record value 是 500/300/200"）里口径词
 * 与否定限定同分句（CLAUSE_SPLIT 不切省略号/逗号），分句级判定恰好覆盖；断言形态
 * （"beta payable balance is 500; please confirm"）的分句没有否定词，照红。
 * 无法确定性区分的残余形态（否定词被反用、"not" 蹭车）按 §9 惯例交 Tier B 评审读。
 */
/** 窗口码不是金额（X1 首跑：numeric code 被当金额判串台，误报）。 */
const MOCK_WINDOW_CODES = new Set(['W1', 'W2']);

/**
 * 金额匹配模式：千分位 / 小数 / 万亿 / ≥3 位裸整数 / 单独的 0。
 * 裸整数分支的前向禁止集只挡**延续形态**（数字、小数延续 `.数字`、%、千分位逗号），
 * 不挡句末句点：`500.` 曾因紧跟句点整个不进提取——"beta W2 record value is 500."（beta
 * 只有 W1）三个判定数组全空，编造金额静默漏判（2026-11-08 修复现场验证发现，与
 * 2026-11-07 评审的句法逗号洞同族：金额不许静默消失）。残余形态：句末裸四位年份
 * （"…in 2026."）会进提取——与同形态的真实金额（alpha 实计 2000）无法确定性区分，
 * 按 §9 惯例交 Tier B 评审读；夹具与语料没有句末裸年份形态。
 */
const AMOUNT_PATTERN = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?\s*[万亿]|-?\d+\.\d+(?![\d%％])|(?<![\d.])-?\d{3,}(?!\.\d)(?![\d%％])|(?<![\d.])-?0(?!\.\d)(?!\d)/g;

/** 提取器产出的最小金额形状（探针与测试共用）。 */
export interface ExtractedAmount {
  raw: string;
  value: number;
  confident?: boolean;
}

/**
 * 生产金额提取器（2026-11-08 从探针搬来，单一真相源）：千分位/小数/万亿/≥3 位裸整数。
 * 排除三类非金额：
 *   ① **年份语境**（后随"年"或"年.月"小数形态）——旧实现按裸区间 1900–2099 排除，把新
 *      夹具 alpha 的真实合计 2000 当年份静默排除，错误金额整个消失（"beta total is
 *      2000"提取为空、三个判定数组全空；写成 2,000 才判红）——评审 blocking；
 *   ② YYYYMM window 码（20\d{4}）；
 *   ③ 标识符尾段（rec-401 的 401：数字紧跟字母-连字符）。
 * 按数值去重（保留首个原文）——同值不同格式的位置匹配由 amountValuePattern 负责。
 */
export function extractAmounts(text: string): ExtractedAmount[] {
  const seen = new Map<number, ExtractedAmount>();
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[0]!;
    const at = match.index ?? 0;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 年份只在**紧邻**语境里排除：数字后 1-2 个字符内出现"年"（"2026 年"），或
    // "年.月"小数形态后紧跟"月"。曾用 text.slice(at)（后文全文）搜索——后文出现同值
    // 年份会把前面的金额一起吞掉（"beta record value is 999; reference 999 年"提取
    // 为空，编造的 999 因此不触发金额失败，2026-11-08 评审 blocking）。
    const tail = text.slice(at + raw.length, at + raw.length + 3);
    if (/^\s{0,2}年/.test(tail)) continue;
    if (/^(?:19|20)\d{2}\.\d{1,2}$/.test(raw) && /^\s{0,2}月/.test(tail)) continue;
    // 日期/区间延续（"2026-11-02" / "2026 年 1 到 9 月"里的 2026）：1900–2099 的裸四位
    // 数后随 "-<数字>" 是日期或区间，不是金额（2026-11-08 C2 实测：召回轮报"本周
    // 2026-11-02 至 11-08"，2026 被当金额判无来源）。该范围外的数不受影响。
    if (/^(?:19|20)\d{2}$/.test(raw) && /^-\d{1,2}/.test(tail)) continue;
    if (/^20\d{4}$/.test(raw)) continue;
    if (MOCK_WINDOW_CODES.has(raw)) continue;
    // 标识符尾段排除的锚点是**数字位**（不是匹配起点）——模式的可选负号会让匹配从 "-"
    // 开始，"rec-101" 的 -101 曾因锚点错位漏排（2026-11-08 负号支持引入时踩到）。
    const digitAt = raw.startsWith('-') ? at + 1 : at;
    if (/(?:[A-Za-z])-$/.test(text.slice(Math.max(0, digitAt - 8), digitAt))) continue;
    // 符号保留（2026-11-08 评审 blocking）："-500" 曾被归一成 +500 混过实体绑定
    // （beta 真实值是正 500，符号反转的答案因此过机械门）。parseFloat 保留前导负号。
    const value = /[万亿]/.test(raw)
      ? parseFloat(raw) * (raw.includes('亿') ? 1e8 : 1e4)
      : parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || seen.has(value)) continue;
    const confident = /,\d{3}/.test(raw) || /\.\d/.test(raw) || /[万亿]/.test(raw);
    seen.set(value, { raw, value, confident });
  }
  return [...seen.values()];
}

export const MISSING_CALIBERS: readonly string[] = ['payable', 'bank', 'debt'];
export const CALIBER_DISCLAIM_RE = /没有|无|不|缺|仅|只|非|\bno\b|\bnot\b|\bmissing\b|\bunavailable\b|\bwithout\b|\blacks?\b|\bonly\b|\binstead\b|\bneither\b/i;

/** 判据输入的最小金额形状（探针传自己的 extractAmounts 产物，保留 raw/confident 供回显）。 */
export interface AmountLike {
  raw: string;
  value: number;
  confident?: boolean;
}

export interface AssertedCaliber {
  caliber: string;
  clause: string;
}

export interface ErrorStateAmountVerdict {
  /** 无所属（红）：既无可绑定实体/window，也不是可验证的算术。 */
  unattributed: AmountLike[];
  /** 算术派生（信息性）：加数在分句或全回复里可见，且数字算得出来。 */
  derived: AmountLike[];
  /** 口径编造（红）：分句把平台没有的口径当答案口径。 */
  assertedCalibers: AssertedCaliber[];
}

/**
 * 实体名 → 所属 collection 的 window 表（2026-11-08 评审 major）：实体绑定表有三族名字
 * （collection / item / 记录号），window 表只有 collection 键——item 名与记录号直接查表
 * 落空，"beta-item-1 W1 record value is 500"（该记录及所属 beta 的 W1 都真实有效）被误判
 * 无据。先解析到所属 collection 再查窗：collection 原名直查；记录号经
 * MOCK_ITEM_ID_BINDINGS 映射；item 名在 MOCK_ITEMS 各 collection 的 items 里找归属。
 */
function collectionWindowsOf(name: string): readonly string[] {
  if (MOCK_COLLECTION_WINDOWS[name]) return MOCK_COLLECTION_WINDOWS[name];
  const viaId = MOCK_ITEM_ID_BINDINGS[name];
  if (viaId) return MOCK_COLLECTION_WINDOWS[viaId.entity] ?? [];
  const owner = Object.entries(MOCK_ITEMS).find(([, items]) => items.includes(name));
  return owner ? MOCK_COLLECTION_WINDOWS[owner[0]] ?? [] : [];
}

/**
 * window×实体有效性（2026-11-07 评审 blocking 反例）："beta W2 record value is 500"
 * ——beta 种子只有 W1，夹具对 (beta, W2) 回 WINDOW_NO_DATA，任何挂上该组合的金额都无据。
 * 分句出现 W<数字> 形态的 window 词元且点名了具体实体时：每个词元要么是某点名实体的有效
 * window，要么在句内紧邻"无数据"类免责措辞（"窗口 W2、W3 均无数据"是诚实说明不是断言）。
 * 没点名实体的分句不判（window 码证据路径的金额常不带实体名，退回全局值核对）。
 */
function windowClaimOk(clause: string, specific: ReadonlyArray<{ name: string }>): boolean {
  if (!specific.length) return true;
  const tokens = [...new Set(clause.match(/W\d{1,3}/g) ?? [])];
  if (!tokens.length) return true;
  return tokens.every((token) => {
    if (specific.some((entity) => collectionWindowsOf(entity.name).includes(token))) return true;
    return new RegExp(`${token}[^。；;\\n]{0,12}(?:无数据|没有数据|no data)`, 'i').test(clause);
  });
}

/**
 * 分句账本实算（2026-11-09 codex-pr-review #23 五～十六审 blocking 逐轮收紧）：clauseLedgerOk
 * 原先用 Set 去重真实值后求和，忽略运算符与重复加数——"500 - 300 + 200 = 1000"（实算 400）与
 * "500 + 500 + 300 + 200 = 1000"（实算 1500）都被误判成成立账本，错误合计经加数回退放行。
 * 改为按出现顺序实算，返回**算得对的结果金额**（没有成立账本返回 null）。逐轮补上的纪律：
 *   · 归一化副本（逐字替换、长度不变，位置不受影响）：枚举连接词 和/与/plus/and → +，全角
 *     ＋－＝ → ASCII。gap 与 span 都从副本切——整句替换会改变串长、后续下标全偏（六审 minor：
 *     "500 plus 300 …" 的诚实账本被误红），全角 ＋ 也才不会撞符号检查（十一审 A）；
 *   · 减号 ASCII "-" 与 Unicode "−" 都按减算（六审 blocking）；
 *   · 只认 + -；乘除形态不认——符号用 Unicode 数学符号类 \p{Sm} **全覆盖**（× ÷ ∗ ± …逐个
 *     枚举总有漏：十三/十四/十六审三次都漏在符号上），受支持的 + - = 用负向断言排除；
 *     % ‰ ^ / ／ 不在 Sm 类，显式补（十/十三/十六审）。数字夹着的乘号写法 x X * ＊ 也不在
 *     Sm 类，按数字相邻认（"800 X 200" / "800 *200"）；
 *   · 运算词按**数字相邻**认（十四/十五/十六审）：乘/减/除/加/minus/mod/times/multiplied
 *     （容忍 "by"）/divided/product/quotient/sum/difference/ratio——"800乘200" "800 mod 200"
 *     "800 减 200" "800 multiplied by 200" 都曾在结果位之后被当成文字备注放行。"除了 alpha"、
 *     "减少 800" 的除/减后面不接数字，是行文不是运算，不误拒；
 *   · 加数**互异**（七审 B）：夹具种子值互异，同值重复 = 同一笔记录用两次（"500 + 500 = 1000"
 *     不是合法记录聚合——与 enumeratedTotalOk/scopedSummands 同规）；
 *   · 括号**不解析**（七审 A）：「500 - (300 + 200) = 400」顺序累计算成 400、实应 0。表达式里
 *     出现括号即拒绝账本豁免——往红偏，也不为实现括号优先级引入一份递归下降；
 *   · 语法完整性：一个 gap 里多个运算符（"500 − − 300"）即拒绝；gap 只由运算符与空白组成才算
 *     运算连接（"，即等于" 含汉字，是行文不是等号——不当成备注后面的运算符）；
 *   · 结果位（等号右边那笔）之后只能跟文字备注（"= 1000，另外 800 是 alpha 的"仍认），再出现
 *     运算符/乘除/运算词即拒绝；无等号的结果位（"…，共 1000"）同纪律——记结果后继续走完剩余
 *     表达式（九审 blocking：提前返回会放过 "…，共 800 × 200" 这类复合断言）；
 *   · markdown 强调号（**1000**）不是运算符：剥只剥**成对**包着操作数的（操作数前后各有一串
 *     * 才剥）——"800 * **200**" 的强调号会让 *=数字 失配（十一审 B），"800 *200" 的 * 后面没有
 *     配对闭口、是紧贴操作数的真乘号不能剥（十二审）。
 */
function clauseLedgerResult(
  clause: string,
  occs: ReadonlyArray<{ value: number; at: number; raw: string }>,
): number | null {
  const sorted = [...occs].sort((a, b) => a.at - b.at);
  if (sorted.length < 2) return null;
  // 归一化副本：枚举连接词 → +、全角运算符 → ASCII。**必须逐字保长**（occ 的下标按原句算）：
  // 和/与 与全角运算符都是 1→1；plus/and 是多字符，替换成"一个 + 加空格补齐"（4→4、3→3），
  // 否则 "500 plus 300" 里 plus 变 + 之后后续金额下标全偏（实测：诚实英文枚举整句误红）。
  const norm = clause
    .replace(/和|与/g, '+')
    .replace(/plus/gi, '+   ')
    .replace(/and/gi, '+  ')
    .replace(/＋/g, '+').replace(/－/g, '-').replace(/＝/g, '=');
  const used = new Set<number>();
  let acc: number | null = null;
  let result: number | null = null;
  for (let index = 1; index < sorted.length; index++) {
    const prev = sorted[index - 1]!;
    const occ = sorted[index]!;
    const between = norm.slice(prev.at + prev.raw.length, occ.at);
    if (/[()（）]/.test(between)) return null; // 括号不解析：拒绝账本豁免
    // 跨度副本（符号/运算词检测用）：剥掉**成对**包着操作数的 markdown 强调号（见文件头）。
    const spanParts: string[] = [];
    const pushAmount = (at: number, end: number): void => {
      const openRun = /(\*+)$/.exec(norm.slice(0, at))?.[1] ?? '';
      const closeRun = /^(\*+)/.exec(norm.slice(end))?.[1] ?? '';
      const paired = openRun !== '' && closeRun !== '';
      spanParts.push(paired ? '' : openRun, norm.slice(at, end), paired ? '' : closeRun);
    };
    pushAmount(prev.at, prev.at + prev.raw.length);
    spanParts.push(between);
    pushAmount(occ.at, occ.at + occ.raw.length);
    const spanText = spanParts.join('');
    // 未受支持的运算：数学符号（\p{Sm} 全覆盖，受支持的加减等——含 Unicode 减号 − 与全角
    // －（归一后就是 -）——用负向断言排除）+ % ‰ ^ / ／ 显式补；
    // 数字夹着的乘号写法；运算词（数字相邻认，容忍 multiplied/divided by）。
    // 注意 u 模式下类里不能写 \- ，连字符放类首。
    if (/(?![-+−－=])\p{Sm}|[%‰^/／]/u.test(spanText)) return null;
    if (/\d\s*[xX*＊]+(?:\s*[xX*＊]+)*\s*\d/.test(spanText)) return null;
    // 运算续断言（十四～十八审 blocking：符号总会漏，词表也要收全）：运算动词出现在 **gap
    // 开头**（只允许标点/空白在前）= 算术续断言，不是文字备注——"，减去 200 后余 500"（800−200
    // 应为 600，回复说 500，错误等式）拒；"，另外加上 200 条明细"（动词前面有"另外"，是行文）
    // 与"，减少 800"（减少不在四则闭集）放行。中文四则动词是闭集——乘/减/除/加 + 可选后缀
    // （以/上/去）覆盖「乘以/减去/除以/加上」；英文同理（minus/mod/times/multiplied/divided/
    // product/quotient/sum/difference/ratio，容忍 by）。gap 后面本来就是下一笔金额，"动词跟着
    // 一笔金额"是结构保证，不用再往 gap 里找数字。
    if (/^[\s，,、；;。.]*(?:[加减乘除][以上去]?|minus|plus|mod|times|multiplied|divided|product|quotient|sum|difference|ratio)(?:\s+by)?/i.test(between)) return null;
    // gap 只由运算符与空白组成才算运算连接；一个 gap 多个运算符 = 形态不认（"− −"）。
    const opChars = between.match(/[+\-−=]/g) ?? [];
    if (opChars.length > 1) return null;
    const op = /^[+\-−=\s]+$/.test(between) ? opChars[0] : undefined;
    if (op === undefined) {
      // 无运算符：还没结果位时这一笔就是声称的结果（"…，共 1000"）；已有结果位则是文字备注。
      // 记了结果位也要继续走完剩余表达式（九审 blocking）。
      if (result !== null) continue;
      if (acc === null || acc !== occ.value) return null;
      result = occ.value;
      continue;
    }
    if (result !== null) return null;          // 结果位之后又出现运算符 = 复合断言
    if (op === '=') {
      if (acc === null || acc !== occ.value) return null;
      result = occ.value;
      continue;
    }
    if (acc === null) { acc = prev.value; used.add(prev.value); }
    if (used.has(occ.value)) return null;                                  // 加数须互异（同值复用）
    used.add(occ.value);
    acc = op === '+' ? acc + occ.value : acc - occ.value; // 非 + 非 = 即减（ASCII - 与 Unicode −）
  }
  return result;
}

/**
 * 错误态回复的金额三分归类（errorStateNotes 的判定核，探针只做 note 文案组装）：
 *   · 有所属（放行）＝ 分句点名用户没问的 window 码或真实数据标识（pointed），且过了
 *     实体绑定（金额按出现位置绑到**最近一次未作废提及**——长名跨度内的短名提及作废、
 *     独立短名提及保留；或可由所绑实体真实值算得——"beta 合计 800" 是 500+300 的诚实账，
 *     "beta-item-1 … is 300" 蹭不来）、
 *     window×实体有效性（windowClaimOk）与全局值核对；
 *   · 算术派生（信息性）＝ 加数在**同一分句**里可见（原判据），或分句带算术框架措辞且
 *     数字过与措辞同族的验证（合计族=子集和 isVerifiedTotal，差额/倍数族=isVerifiedArithmetic）
 *     ——加数池点名实体时取**点名实体的真实值并集**（跨实体
 *     差额"2100−2000 相差 100"的账本），没点名实体时取全回复真实值（表格摊账形态：
 *     加数 500/300/200 在表格行、合计 1000 在散文句，2026-11-07 Y2 实测）；**window
 *     无效一律不许降级**——"beta W2 total is 2000"（2000 算得出来但挂在无数据的
 *     beta W2 上）照旧红（2026-11-07 评审 blocking：算术豁免不得绕过实体/窗口绑定）；
 *   · 无所属（红）＝ 其余；口径编造独立成第三类（assertedCalibers，同样红）。
 * 同一数值的**每次出现**逐分句核对（2026-11-07 评审 blocking：find 只看首次出现——
 * "beta W1 record value is 500; beta payable balance is 500" 的第二句被首句的合法
 * 上下文豁免），任一次出现判红即红；报告按数值/口径去重。
 * 零值不算金额（调用方过滤）；分句按数值边界重匹配（裸串 includes 会把 "500" 命中进 "1500"）。
 */
export function classifyErrorStateAmounts(
  reply: string,
  userText: string,
  extractAmounts: (text: string) => AmountLike[],
): ErrorStateAmountVerdict {
  const asked = askedWindows(userText);
  const unattributed = new Map<number, AmountLike>();
  const derived = new Map<number, AmountLike>();
  const asserted = new Map<string, string>();
  // 全回复范围的真实值池（表格摊账形态的加数）：isVerifiedArithmetic 的两级闭包会从
  // 500/300/200 推出 1000；凭空数即便带"合计"措辞也推不出来，照旧红。
  const replyRealValues = [...new Set(extractAmounts(reply).map((a) => a.value).filter((v) => REAL_DATA_VALUES.includes(v)))];
  const parts = reply.split(CLAUSE_SPLIT);
  for (const amount of extractAmounts(reply)) {
    if (amount.value === 0) continue;
    // 金额边界（2026-11-07 评审 blocking：紧跟英文逗号的金额静默漏判）——后向禁止集区分
    // 千分位逗号与句法逗号：`,<数字>` 是千分位延续（不许把 "1,500" 里的 500 当独立金额），
    // `", "`/`，` 是句法逗号（CLAUSE_SPLIT 不切逗号），金额后跟它必须照常找到分句。
    // 前向保持原禁止集（数字/./%/千分位逗号）。
    const boundary = new RegExp(`(?<![\\d.,%％])${amountValuePattern(amount.value)}(?!\\d)(?![.%％])(?!,\\d)`);
    let assertedHit = false;
    let hard = false;
    let soft = false;
    const hits = parts.filter((part) => boundary.test(part));
    if (!hits.length) { unattributed.set(amount.value, amount); continue; } // 边界异常宁可红，不静默消失
    for (const clause of hits) {
      // 口径绑定（MISSING_CALIBERS 处的决策记录）：先于归属豁免——挂真实值也不例外。
      // 口径检测大小写不敏感（2026-11-08 评审 blocking：模型把不存在的口径写成
      // "BANK"/"Payable" 就能绕过全小写 includes 匹配——编造口径漏判，500 又因真实
      // 实体和值获豁免）。
      const caliber = MISSING_CALIBERS.find((c) => new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(clause) && !CALIBER_DISCLAIM_RE.test(clause));
      if (caliber) { assertedHit = true; asserted.set(caliber, clause); continue; }
      // 有所属第一类 = 分句点名用户没问的 window 码；第二类 = 分句带真实数据标识。
      const pointed = MOCK_WINDOWS.some((subject) => !asked.has(subject.code)
        && (clause.includes(subject.code) || clause.includes(subject.name)))
        || REAL_DATA_TOKENS.some((token) => clause.includes(token));
      // 实体绑定：按**出现位置**处理名称重叠（2026-11-08 评审 blocking）——短名的某一次
      // 出现若落在更长名出现的跨度内，作废的只是那一次（beta ⊂ beta-item-1、alpha ⊂
      // alpha-group 的那一次），不是整句剔除："alpha-group … is 700, alpha … is 700" 的
      // 第二笔 700 须绑到后半句**独立的** alpha（真实 1200/800）——整句剔除会把独立 alpha
      // 一并丢掉，串台金额挂到 alpha-group（真实恰为 700）上全绿。直接陈述的值**严格**等于
      // 所绑实体真实值才算对上（2026-11-07 评审 blocking：算术豁免放过
      // "contoso-trade-item-2 is 1200"——item 真实 600，1200=600+600 且是别的实体的种子值；
      // 算术豁免只存在于下方带算术框架措辞的降级通道，不进步行通道）。
      const mentions: Array<{ entity: { name: string; values: readonly number[] }; at: number }> = [];
      for (const entity of ENTITY_REAL_VALUES) {
        for (const at of boundaryPositions(clause, entity.name)) {
          const end = at + entity.name.length;
          const shadowed = ENTITY_REAL_VALUES.some((other) => {
            if (other.name.length <= entity.name.length) return false;
            for (const oat of boundaryPositions(clause, other.name)) {
              if (oat <= at && oat + other.name.length >= end) return true;
            }
            return false;
          });
          if (!shadowed) mentions.push({ entity, at });
        }
      }
      mentions.sort((a, b) => a.at - b.at);
      const specific = [...new Map(mentions.map((m) => [m.entity.name, m.entity])).values()];
      // 分句内全部金额出现（带位置，含同值多次）——gap 与"列举加数"都按位置算，不按值去重
      // （同值重复时按值过滤会把另一笔同值加数误排，2026-11-08 实测）。
      const occs = extractAmounts(clause)
        .flatMap((a) => patternPositions(clause, amountValuePattern(a.value)).map((at) => ({ value: a.value, raw: a.raw, at })))
        .sort((a, b) => a.at - b.at);
      const positions = patternPositions(clause, amountValuePattern(amount.value));
      // 逐笔绑定（2026-11-08 评审 blocking 三连收口）：每一笔出现各自找**它之前最近**的
      // 实体提及，各自算 gap（与上一笔金额之间的文本）和自己那段里列举的加数。
      //   · 有绑定实体 = 直接断言或它自称的运算：值须属于该实体；自称合计时列举 ≥2 个
      //     加数就必须等于列举全和（"1200 and 800, total is 1200" → 全和 2000 ≠ 1200 红）；
      //   · 无绑定实体 = 摊账/未点名形态：走分句级算术通道（isSum/framed），值须真实——
      //     "记录值为 500 和 300（合计 800）"的加数由此放行，而"只有 record value……
      //     balance 500"（无运算可摊）照红。
      const bindings = positions.map((at) => {
        let mention: { entity: { name: string; values: readonly number[] }; at: number } | undefined;
        for (const m of mentions) { if (m.at > at) break; mention = m; }
        const next = mentions.find((m) => m.at > at);
        const segStart = mention ? mention.at : 0;
        const segment = clause.slice(segStart, next ? next.at : clause.length);
        const prevOcc = [...occs].reverse().find((o) => o.at + o.raw.length <= at);
        const gap = clause.slice(prevOcc ? prevOcc.at + prevOcc.raw.length : 0, at);
        return {
          at,
          mentionEntity: mention?.entity,
          segment,
          gap,
          claimsTotal: TOTAL_FRAMING_RE.test(gap),
          valueOk: mention === undefined
            ? specific.length === 0 || specific.some((entity) => entity.values.includes(amount.value))
            : mention.entity.values.includes(amount.value),
          windowOk: windowClaimOk(segment, mention === undefined ? specific : [mention.entity]),
          segSummands: occs.filter((o) => o.at >= segStart && o.at + o.raw.length <= at && REAL_DATA_VALUES.includes(o.value)),
        };
      });
      const entityOk = bindings.every((b) => b.valueOk);
      const windowOk = bindings.every((b) => b.windowOk);
      // 降级池：点名实体时取点名实体的真实值并集（跨实体差额的账本），没点名实体时取
      // 全回复真实值（表格摊账）；window 无效不许降级（评审 blocking ②）。
      const pool = specific.length ? [...new Set(specific.flatMap((entity) => entity.values))] : replyRealValues;
      // 等式形态的加数 = 分句里除**这一笔自身出现**外的真实值（加数可以在金额之后——
      // "alpha 2000（1200+800）"的加数就跟在后面；按位置排除而不是按值排除，同值重复的
      // 另一笔仍是合法加数，由 claimsTotal 的 segSummands 通道各自把关）。
      const summands = occs.filter((o) => !positions.includes(o.at) && REAL_DATA_VALUES.includes(o.value));
      const boundValues = [...new Set(bindings.flatMap((b) => b.mentionEntity ? b.mentionEntity.values : []))];
      const scopedSummands = summands.filter((a) => boundValues.length === 0 || boundValues.includes(a.value));
      // 加数还须是**不同值**（2026-11-08 评审 blocking：出现位置不同但值相同的两笔是同一笔
      // 记录的复用——"contoso-trade-item-2 … is 1200 (600 + 600)"用该记录唯一的 600 加两次
      // 冒充 1200；夹具种子值互异，同值相加必然意味着同一记录被用两次）。
      // 等式通道（无框架词的"2000（1200+800）"形态）：绑定时金额必须是所绑实体的**全额
      // 聚合**（isVerifiedTotal）且加数互异可见——部分和冒充记录值/总额都堵死（"beta …
      // is 800 (500 + 300)"beta 无 800 这条记录、实计 1000）；没绑实体时（摊账）才退回
      // 分句内互异加数的两两和。
      const pairSum = scopedSummands.some((a) => scopedSummands.filter((b) => b !== a && b.value !== a.value).some((b) => a.value + b.value === amount.value));
      const isSum = windowOk && (boundValues.length > 0
        ? isVerifiedTotal(amount.value, boundValues) && pairSum
        : pairSum);
      const totalFramed = TOTAL_FRAMING_RE.test(clause);
      // 框架词前置的枚举账本（2026-11-09 成本轮实测）：「合计：500 + 300 + 200 = 1000」——
      // 合计在句首，加数各自 gap 里都含着它（被当成自称合计、验不过），而那笔 1000 自己的
      // gap 是 " = "（不含框架词，自称合计也认不出来）。账本的诚实形态 = 分句带合计措辞，
      // 且有一笔金额等于除它自己外全部互异真实值之和。成立时真实值加数走摊账通道（见下方
      // claimsTotal 验不过的分支）。摘 Cherry 形态（"…500, 300, 200, total is 800"没有一笔
      // 等于三项全和）不成立，照旧红。
      // 框架词前置的枚举账本（2026-11-09 成本轮实测 + codex #23 五审 blocking）：「合计：
      // 500 + 300 + 200 = 1000」——合计在句首，加数各自 gap 里都含着它（被当成自称合计、
      // 验不过），而那笔 1000 自己的 gap 是 " = "（不含框架词，自称合计也认不出来）。
      // 账本诚实 = 分句带合计措辞，且按**实际运算符与操作数次数**实算成立（clauseLedgerResult：
      // 去重求和会把 "500 - 300 + 200 = 1000" 实算 400 与 "500 + 500 + 300 + 200 = 1000"
      // 实算 1500 都误判成 1000 的账本）。成立时真实值加数走摊账通道（见下方 claimsTotal
      // 验不过的分支），算得对的结果金额本身走终门（见下方 clauseLedgerValue 档）。
      const clauseLedgerValue = clauseLedgerResult(clause, occs);
      const clauseLedgerOk = totalFramed && clauseLedgerValue !== null;
      // 合计族的分句级验证（framed 的合计族切片单独取出：终门第三档只信它，见下方注释）。
      const totalFamilyOk = windowOk && totalFramed && bindings.every((b) => b.claimsTotal && b.segSummands.length >= 2
        ? b.segSummands.reduce((s, a) => s + a.value, 0) === amount.value
        : isVerifiedTotal(amount.value, b.mentionEntity ? b.mentionEntity.values : pool));
      const framed = totalFamilyOk
        || (windowOk && DIFF_FRAMING_RE.test(clause) && isVerifiedArithmetic(amount.value, pool))
        || (windowOk && RATIO_FRAMING_RE.test(clause) && isVerifiedRatio(amount.value, pool));
      // 逐笔判定：有绑定实体走严格通道（值∈该实体 / 它自称的运算各自验）；无绑定实体走
      // 分句级摊账通道（isSum/framed）。
      // 本分句是否有**成立的运算**（摊账判据）：某笔出现自称运算结果且按该族验证通过。
      // 无绑定实体又没自称运算的加数（"记录值为 500 和 300（合计 800）"里的 500/300）
      // 靠它获得归属——账本诚实时加数是合法佐证；"只有 record value……balance 500"
      // 没有任何运算可摊，照红。
      const clauseOpVerified = (): boolean => occs.some((occ) => {
        const prev = [...occs].reverse().find((o) => o.at + o.raw.length <= occ.at);
        const gap = clause.slice(prev ? prev.at + prev.raw.length : 0, occ.at);
        const before = occs.filter((o) => o.at + o.raw.length <= occ.at && REAL_DATA_VALUES.includes(o.value) && o.value !== occ.value);
        if (TOTAL_FRAMING_RE.test(gap)) {
          return before.length >= 2
            ? before.reduce((s, o) => s + o.value, 0) === occ.value
            : isVerifiedTotal(occ.value, pool);
        }
        if (DIFF_FRAMING_RE.test(gap)) return isVerifiedDifference(occ.value, pool);
        if (RATIO_FRAMING_RE.test(gap)) return isVerifiedRatio(occ.value, pool);
        return false;
      });
      const ledgerOk = clauseOpVerified();
      const perOccurrence = bindings.map((b) => {
        // 无绑定实体（摊账/未点名形态）同样按**每笔自己 gap 里的措辞族**验证（2026-11-08
        // 评审 blocking：未绑定差额曾直接吃 isSum/framed——"values are 500 and 300,
        // difference is 800"的和被记成派生、改成 2.5 也没有硬失败）：合计族同绑定规则
        // （列举全和 / 全回复值全和）、差额族走列举操作数约束、倍数族走商；都没自称
        // 运算的加数才走摊账通道。
        if (b.mentionEntity === undefined) {
          if (b.claimsTotal) {
            const claimed = b.segSummands.length >= 2
              ? enumeratedTotalOk(b.segSummands, amount.value)
              : isVerifiedTotal(amount.value, replyRealValues);
            // 自称合计验不过时，按**加数**再判一遍才落红（2026-11-09 成本轮实测）：框架词前置的
            // 枚举形态「合计：500 + 300 + 200 = 1000」里，每个加数自己的 gap 都含「合计」，
            // 会被当成自称合计——它不是合计（验不过），但它是同一分句里那笔**已验证**运算的
            // 加数（摊账通道，与框架词后置时加数走的同一条）。直接 return false 会把诚实列
            // 加数的回复整句判成无所属。通道只收「真实值 + 分句里有成立的账本」两项：不收
            // isSum 的两两和（"values are 500, 300, 200; total is 800" 的 800 会被 500+300
            // 蹭回来，摘 Cherry 反例照旧红），也不要 framed（族验证在上面自称合计处已判过）。
            if (claimed) return true;
            // 回退**只给没列举加数、且与算式相连**的自称合计（三轮 codex blocking 复现后收紧）：
            // ① 列举了 ≥2 个加数还验不过 = 明写"这些加起来等于我"而算不对
            //    （"…= 1000，total is 500"），是错误合计断言；
            // ② 与算式的连接关系（"合计 500，明细 500 + 300 + 200 = 1000" 的首笔）：金额之后
            //    必须只隔运算符/连接词/标点就有下一笔金额（它是算式的左操作数）。冒号/括号单独
            //    不构成证据（"合计：500，明细 …" 带冒号仍是合计断言），夹了文字更不是加数。
            if (b.segSummands.length >= 2) return false;
            const self = clause.slice(b.at).match(boundary);
            const end = b.at + (self ? self[0].length : amount.raw.length);
            const nextOcc = occs.reduce<{ at: number } | undefined>(
                (nearest, o) => (o.at >= end && (nearest === undefined || o.at < nearest.at) ? o : nearest), undefined);
            const addendPosition = nextOcc !== undefined && ENUMERATION_GAP_RE.test(clause.slice(end, nextOcc.at));
            if (!addendPosition) return false;
            return REAL_DATA_VALUES.includes(amount.value) && (ledgerOk || clauseLedgerOk);
          }
          if (DIFF_FRAMING_RE.test(b.gap)) {
            const listed = occs.filter((o) => !positions.includes(o.at)).map((o) => o.value);
            return listed.length >= 2
              ? listed.some((x, i) => listed.some((y, j) => i !== j && Math.abs(x - y) === amount.value))
              : isVerifiedDifference(amount.value, pool);
          }
          if (RATIO_FRAMING_RE.test(b.gap)) return isVerifiedRatio(amount.value, pool);
          return (REAL_DATA_VALUES.includes(amount.value) && (ledgerOk || clauseLedgerOk)) || isSum || framed
            // 算得对的账本的结果位（"合计：500 - 300 + 200 = 400" 的 400：不是种子值、过不了
            // isVerifiedTotal 全和验证，但分句算式实算成立）也属有所属——终门第四档接它。
            || clauseLedgerValue === amount.value;
        }
        if (b.claimsTotal) {
          return b.segSummands.length >= 2
            ? enumeratedTotalOk(b.segSummands, amount.value)
            : isVerifiedTotal(amount.value, b.mentionEntity.values);
        }
        if (DIFF_FRAMING_RE.test(b.gap)) {
          // 差额断言（2026-11-08 评审 blocking）：分句里列举了 ≥2 个真实值时，差额必须
          // 等于其中两个的差——"beta values are 500 and 300, difference is 800"把和说成
          // 差（真实差 200），池层面的 |1000−200| 救不了它；没列举操作数时（表格摊账、
          // 跨实体差额）才退回池验证。
          // 操作数取**整句**金额（含聚合值——"alpha 2000（1200+800）、contoso-trade
          // 2100（1500+600），两者相差 100"的操作数是 2000 与 2100 两个聚合值，按 segment
          // 取会漏掉跨实体那半个）；只排除这一笔自己的出现。
          const listed = occs.filter((o) => !positions.includes(o.at)).map((o) => o.value);
          return listed.length >= 2
            ? listed.some((x, i) => listed.some((y, j) => i !== j && Math.abs(x - y) === amount.value))
            : isVerifiedDifference(amount.value, pool);
        }
        if (RATIO_FRAMING_RE.test(b.gap)) return isVerifiedRatio(amount.value, pool);
        return b.valueOk;
      });
      const anyClaimsOperation = bindings.some((b) => b.claimsTotal || DIFF_FRAMING_RE.test(b.gap) || RATIO_FRAMING_RE.test(b.gap));
      const allVerified = perOccurrence.every(Boolean);
      // 直接放行：每一笔都是直接断言（无运算自称）且核对上，且有所属（pointed）或摊账
      // 通道成立（isSum/framed）。但凡有一笔自称运算结果，整笔走运算通道。
      // clauseLedgerOk = 框架词前置的枚举账本（「合计：500 + 300 + 200 = 1000」的加数
      // 所属通道，2026-11-09 成本轮）：加数自己没自称运算，gap 里也没有框架词，所属证据
      // 就是同一分句里那笔已验证的全和。
      if (!anyClaimsOperation && allVerified && windowOk && REAL_DATA_VALUES.includes(amount.value)
        && (pointed || isSum || framed || ledgerOk || clauseLedgerOk)) continue;
      const enumeratedTotal = bindings.some((b) => b.claimsTotal && b.segSummands.length >= 2);
      // 运算通道只给自称运算结果的金额；没自称的直接断言若没进直接通道必须落红，不能被
      // "值恰好算得出来"救走（"只有 record value……balance 500" 的 500 无归属也无框架词）。
      // 自称运算结果的金额只走它自己那族的验证（anyClaimsOperation ⇒ 逐笔判定），不被
      // isSum 等式通道救回——"values are 500 and 300, difference is 800"的 800 虽是
      // 500+300 的和，但它自称差额，差额验证不通过就红。
      // 2026-11-09 成本轮补第三档：框架词落在金额**后面**的形态（"1000 是这三条数值的加总"）
      // ——金额自身 gap 里没有框架词（anyClaimsOperation=false），逐笔判定全过，与自称运算同档
      // 降派生。少了这一档，Y2 第 3 轮那句明写"加总"且紧跟口径免责的 1000（不是种子值，进不了
      // 上面的直接放行档）会落进无所属假红——而无绑定分支的 perOccurrence 本来就经 framed 放行
      // 它，终门不认是自相矛盾。
      // **只收合计族**（totalFamilyOk）：差额/倍数族的分句级 framed 用 isVerifiedArithmetic，
      // 它含比率验证——"…500; …200; 2.5 是这两条数值的 difference"里 2.5 其实是 500/200 的比率，
      // 真差额是 300，按差额族该红；放开这一档就会把它洗成派生（codex-pr-review #23 blocking
      // 复现）。要开放差额/倍数族的措辞后置形态，得先把该族验证按族收紧（差额只认列举操作数
      // 之差、倍数只认商），那是另一个改动；没见到实测形态前不放。
      // 第四档（clauseLedgerValue）：金额是分句里**算得对的账本的结果**（"合计：500 - 300
      // + 200 = 400" 的 400——不是种子值、也过不了 isVerifiedTotal 的全和验证，但算式本身
      // 实算成立）。只认结果位，加数走上面的直接放行档；账本不成立（实算值对不上）时
      // clauseLedgerValue 是 null，这档不开。
      if ((isSum && !enumeratedTotal && !anyClaimsOperation)
        || (anyClaimsOperation && allVerified && windowOk)
        || (totalFamilyOk && allVerified && windowOk)
        || (clauseLedgerValue === amount.value && allVerified && windowOk)) { soft = true; } else { hard = true; }
    }
    if (assertedHit) continue; // 口径编造单独成类，不混进金额三分
    if (hard) unattributed.set(amount.value, amount);
    else if (soft) derived.set(amount.value, amount);
  }
  return {
    unattributed: [...unattributed.values()],
    derived: [...derived.values()],
    assertedCalibers: [...asserted].map(([caliber, clause]) => ({ caliber, clause })),
  };
}
