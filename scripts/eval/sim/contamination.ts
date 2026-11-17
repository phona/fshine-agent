/**
 * SimCase 薄机制 · 污染检测（模拟用户消息里出现真值 → 该 trial 作废，不是通过）。
 *
 * 纪律来源（AGENTS.md / 预注册）：模拟用户**知道业务目标但不知道正确答案**；真值只给
 * 独立 Oracle。用户消息（含 `initialMessage`）一旦命中 `forbiddenKnowledge` 或 Oracle 的
 * 真值模式，该 trial 记 `contaminated`——**作废**，不计通过，证据里保留原文与命中项。
 *
 * 匹配口径（确定性、零模型）：小写 + 去空白 + 去掉数字间的千分位分隔符 + **中文数字/量词
 * 归一化**后做**子串**匹配。归一化把同一语义的不同说法收敛到同一 token：
 *   · 中文金额 → 阿拉伯数字：`两千` → `2000`、`一千二` → `1200`、`八百` → `800`；
 *   · 数量 → `Q<数字><量词>`：`两条` / `2 条` / `2条` → `Q2条`；
 *   · 序数先保护：`第 2 步` / `第2号` / `第二条` 里的数字是**序号/编号**，不是数量，
 *     归一化时不会被拼成 `Q2条`——否则 SIM-02 那种「第二条」的正常指代会被误判成污染。
 * 归一化后长度 < 2 的模式无法可靠区分（例如真值条数 `2`），直接跳过——宁可漏检也不
 * 制造大面积假污染；需要保护时由用例显式写更长的真值模式（如 `2条`）。
 */

/** 命中来源：用户本不该知道的知识 / Oracle 真值模式。 */
export type ContaminationSource = 'forbiddenKnowledge' | 'truth';

export interface ContaminationHit {
  readonly source: ContaminationSource;
  /** 命中的原始模式（照抄声明，便于取证）。 */
  readonly pattern: string;
}

export interface ContaminationReport {
  readonly contaminated: boolean;
  readonly hits: readonly ContaminationHit[];
  /** 被检查的原始消息（证据保留原文，便于复核）。 */
  readonly original: string;
}

export interface ContaminationInput {
  readonly forbiddenKnowledge: readonly string[];
  /** 由 Oracle 提供（`SimOracle.truthPatterns`）。 */
  readonly truthPatterns: readonly string[];
}

/** 小于该长度（归一化后）的模式不参与匹配。 */
const MIN_PATTERN_LENGTH = 2;

const CN_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
});
const CN_UNITS: Readonly<Record<string, number>> = Object.freeze({
  十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000,
});
const CN_NUMERAL_CHARS = '零〇一二三四五六七八九十百千万亿两';
/** 数量量词：只有「数字 + 这些量词」才归一化成数量语义（`2 号` / 第 2 步不在此列）。 */
const COUNT_MEASURES = '条个项笔行份次批位张家组';

/**
 * 中文数字 → 数值（支持 `两千` / `一千二` / `两百五` / `一万二` 这类口语写法）。
 * 无法解析返回 null（调用方保留原文，不猜）。
 */
function parseChineseNumber(raw: string): number | null {
  if (!new RegExp(`^[${CN_NUMERAL_CHARS}]+$`).test(raw)) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 0;
  for (const char of raw) {
    const digit = CN_DIGITS[char];
    if (digit !== undefined) {
      number = digit;
      continue;
    }
    const unit = CN_UNITS[char];
    if (unit === undefined) return null;
    if (char === '万' || char === '亿') {
      section = (section + (number === 0 ? 1 : number)) * unit;
      total += section;
      section = 0;
      number = 0;
      lastUnit = unit;
      continue;
    }
    section += (number === 0 ? 1 : number) * unit;
    number = 0;
    lastUnit = unit;
  }
  if (number > 0) {
    // 口语尾数：`一千二` = 1200、`两百五` = 250（尾数是上一单位的十分之一）。
    section += lastUnit >= 100 ? number * (lastUnit / 10) : number;
  }
  return total + section;
}

/**
 * 归一化：小写、去全部空白、去数字千分位（`2,000` / `2_000` → `2000`），再做中文数字/
 * 量词归一化。模式与文本走同一个函数，保证「同一语义」在两边收敛到同一 token。
 */
export function normalizeForMatch(text: string): string {
  let normalized = (text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(?<=\d)[,_](?=\d{3}\b)/g, '');

  // ① 先保护序数：`第 2 条` / `第二条` / `第 2 步` 是序号，不是数量；用 `·` 隔开数字与量词，
  //    后续数量归一化就不会把它拼成 `Q2条`。
  normalized = normalized.replace(
    new RegExp(`第([0-9]+|[${CN_NUMERAL_CHARS}]+)(?=[${COUNT_MEASURES}步号])`, 'g'),
    (_match, raw: string) => {
      const value = /^[0-9]+$/.test(raw) ? raw : parseChineseNumber(raw);
      return value === null ? `第${raw}` : `第${value}·`;
    },
  );

  // ② 中文金额 → 阿拉伯数字（只处理带十/百/千/万/亿单位的写法；裸「一/二」留给量词处理）。
  normalized = normalized.replace(
    new RegExp(`[${CN_NUMERAL_CHARS}]+`, 'g'),
    (run) => {
      if (!/[十百千万亿]/.test(run)) return run;
      const value = parseChineseNumber(run);
      return value === null ? run : String(value);
    },
  );

  // ③ 数量 → `Q<数字><量词>`：`两条` / `2 条` / `2条` 收敛到同一 token。
  normalized = normalized.replace(
    new RegExp(`([0-9]+|[${CN_NUMERAL_CHARS}]+)([${COUNT_MEASURES}])`, 'g'),
    (match, raw: string, measure: string) => {
      if (/^[0-9]+$/.test(raw)) return `Q${raw}${measure}`;
      const value = parseChineseNumber(raw);
      return value === null ? match : `Q${value}${measure}`;
    },
  );

  return normalized;
}

/**
 * 一个声明模式可匹配的归一化变体：整串 + 各空白分隔片段。
 * 例：禁知写「内部工单号 INC-7788」时，用户单说「INC-7788」也应命中
 * （声明里多写描述词是常见写法）。片段过短由 MIN_PATTERN_LENGTH 过滤。
 */
function variantsOf(pattern: string): string[] {
  const whole = normalizeForMatch(pattern);
  const parts = pattern.split(/\s+/).map(normalizeForMatch).filter((part) => part.length >= MIN_PATTERN_LENGTH);
  return [...new Set([whole, ...parts])].filter((variant) => variant.length >= MIN_PATTERN_LENGTH);
}

function scan(text: string, patterns: readonly string[], source: ContaminationSource): ContaminationHit[] {
  const hits: ContaminationHit[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (seen.has(pattern)) continue;
    if (!variantsOf(pattern).some((variant) => text.includes(variant))) continue;
    seen.add(pattern);
    hits.push({ source, pattern });
  }
  return hits;
}

/** 检查一条用户消息是否污染；命中项与原文一并返回，供证据落盘。 */
export function detectContamination(message: string, input: ContaminationInput): ContaminationReport {
  const normalized = normalizeForMatch(message);
  const hits = [
    ...scan(normalized, input.forbiddenKnowledge, 'forbiddenKnowledge'),
    ...scan(normalized, input.truthPatterns, 'truth'),
  ];
  return { contaminated: hits.length > 0, hits, original: message };
}
