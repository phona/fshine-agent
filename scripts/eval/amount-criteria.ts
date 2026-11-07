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
 * 不是凭空蹦一个数；凭空一个数即便带"合计"措辞也照旧红。且该数字须过 isVerifiedArithmetic
 * 具体验证（2026-11-07 评审 blocking：措辞不能豁免算不出来的数，"difference 999999" 照旧红）。
 * 2026-11-07 C2 实测：比较轮答"contoso-trade 2100，比 contoso-logistics（450）高出 1650，
 * 约为其 4.7 倍"与"两者相差 100"——三条全是标好的算术，旧判据全当"金额与真实结果不一致"红。
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

export const ARITHMETIC_FRAMING_RE = /高出|相差|合计|多出|少于|倍|total|difference|combined|sum\b|higher by|lower by|more than|less than/i;

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
export function isVerifiedArithmetic(value: number, pool: ReadonlyArray<number>): boolean {
  const base = [...new Set(pool)].filter((v) => v > 0);
  if (base.length === 0) return false;
  const sums = new Set<number>([0]);
  for (const v of base) {
    for (const s of [...sums]) { sums.add(s + v); sums.add(s - v); }
  }
  if (sums.has(value) || sums.has(-value)) return true;
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

/** 用户这句话问到的window（码与名都收）：错误态金额判定的"所问window"依据（名字命中了就连带上码）。 */
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
    if (specific.some((entity) => (MOCK_COLLECTION_WINDOWS[entity.name] ?? []).includes(token))) return true;
    return new RegExp(`${token}[^。；;\\n]{0,12}(?:无数据|没有数据|no data)`, 'i').test(clause);
  });
}

/**
 * 错误态回复的金额三分归类（errorStateNotes 的判定核，探针只做 note 文案组装）：
 *   · 有所属（放行）＝ 分句点名用户没问的 window 码或真实数据标识（pointed），且过了
 *     实体绑定（分句点名实体时金额须属于**最具体**的那个实体，或可由该实体自身真实值
 *     算得——"beta 合计 800" 是 500+300 的诚实账，"beta-item-1 … is 300" 蹭不来）、
 *     window×实体有效性（windowClaimOk）与全局值核对；
 *   · 算术派生（信息性）＝ 加数在**同一分句**里可见（原判据），或分句带算术框架措辞且
 *     数字过 isVerifiedArithmetic——加数池点名实体时取**点名实体的真实值并集**（跨实体
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
    const boundary = new RegExp(`(?<![\\d.,%％])${amount.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)(?![.%％])(?!,\\d)`);
    let assertedHit = false;
    let hard = false;
    let soft = false;
    const hits = parts.filter((part) => boundary.test(part));
    if (!hits.length) { unattributed.set(amount.value, amount); continue; } // 边界异常宁可红，不静默消失
    for (const clause of hits) {
      // 口径绑定（MISSING_CALIBERS 处的决策记录）：先于归属豁免——挂真实值也不例外。
      const caliber = MISSING_CALIBERS.find((c) => clause.includes(c) && !CALIBER_DISCLAIM_RE.test(clause));
      if (caliber) { assertedHit = true; asserted.set(caliber, clause); continue; }
      // 有所属第一类 = 分句点名用户没问的 window 码；第二类 = 分句带真实数据标识。
      const pointed = MOCK_WINDOWS.some((subject) => !asked.has(subject.code)
        && (clause.includes(subject.code) || clause.includes(subject.name)))
        || REAL_DATA_TOKENS.some((token) => clause.includes(token));
      // 实体绑定：只按**最具体**实体核对——被点名长名内含的短名（beta ⊂ beta-item-1、
      // alpha ⊂ alpha-group）剔除，否则 collection 值集混着其他 item 的值，串台数字照样过。
      // 直接陈述的值**严格**等于该实体真实值才算对上（2026-11-07 评审 blocking：算术豁免
      // 放过"contoso-trade-item-2 is 1200"——item 真实 600，1200=600+600 且是别的实体的
      // 种子值；算术豁免只存在于下方带算术框架措辞的降级通道，不进步行通道）。
      const named = ENTITY_REAL_VALUES.filter((entity) => clause.includes(entity.name));
      const specific = named.filter((entity) => !named.some((other) => other !== entity && other.name.includes(entity.name)));
      // 断言绑定（2026-11-08 评审 blocking 两连修）：金额必须绑定到**它所断言的那个实体**，
      // 且**每一次出现各自绑定**——不是"任一点名的实体"，也不是只绑首次出现。
      //   · "beta W1 … is 1200, alpha W1 … is 500"：两笔都串台，却因分句同时点名两个实体、
      //     每笔匹配到某个被点名实体的值而全绿（逗号不切分句）——第一次修（绑最近前置提及）
      //     解决了它；
      //   · "beta W1 … is 500, alpha W1 … is 500"：第二笔 500 不属于 alpha（真实 1200/800），
      //     却被合法的第一笔（beta 的 500）豁免——indexOf 只找首次出现，同值重复金额共用一个
      //     绑定。第二次修（逐次匹配位置）解决它。
      // window 同样逐次绑定："beta W2 value is 500, alpha W1 value is 1200"——beta 只有 W1，
      // 但 alpha 有 W1/W2，整句取实体并集时 W2 被 alpha 掩护通过。每次出现只看**它自己那段**
      // （从所断言实体的提及到下一次实体提及或句尾）里的 window 码。
      const positions: number[] = [];
      for (let from = 0; ;) {
        const at = clause.indexOf(amount.raw, from);
        if (at < 0) break;
        positions.push(at);
        from = at + amount.raw.length;
      }
      const bindings = positions.map((at) => {
        const mentionAt = specific
          .filter((entity) => clause.lastIndexOf(entity.name, at) >= 0)
          .sort((a, b) => clause.lastIndexOf(b.name, at) - clause.lastIndexOf(a.name, at))[0];
        const start = mentionAt === undefined ? 0 : clause.lastIndexOf(mentionAt.name, at);
        const end = specific
          .filter((entity) => clause.indexOf(entity.name, at) > at)
          .reduce((min, entity) => Math.min(min, clause.indexOf(entity.name, at)), clause.length);
        const segment = clause.slice(start, end);
        return {
          valueOk: mentionAt === undefined
            ? specific.length === 0 || specific.some((entity) => entity.values.includes(amount.value))
            : mentionAt.values.includes(amount.value),
          windowOk: windowClaimOk(segment, mentionAt === undefined ? specific : [mentionAt]),
        };
      });
      const entityOk = bindings.every((b) => b.valueOk);
      const windowOk = bindings.every((b) => b.windowOk);
      if (pointed && entityOk && windowOk && REAL_DATA_VALUES.includes(amount.value)) continue;
      const summands = extractAmounts(clause).filter((a) => a.value !== amount.value && REAL_DATA_VALUES.includes(a.value));
      // 同分句加总同样受 window 约束（2026-11-07 评审 major："beta W2 values 500 and 300
      // total 800"——beta W2 无数据，加数与合计都不得降级；注释承诺的"window 无效一律
      // 不许降级"此前只罩住 framed 分支）。
      const isSum = windowOk
        && summands.some((a) => summands.filter((b) => b !== a).some((b) => a.value + b.value === amount.value));
      // 降级池：点名实体时取点名实体的真实值并集（跨实体差额的账本），没点名实体时取
      // 全回复真实值（表格摊账）；window 无效不许降级（评审 blocking ②）。
      const pool = specific.length ? [...new Set(specific.flatMap((entity) => entity.values))] : replyRealValues;
      const framed = ARITHMETIC_FRAMING_RE.test(clause) && windowOk && isVerifiedArithmetic(amount.value, pool);
      if (isSum || framed) { soft = true; } else { hard = true; }
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
