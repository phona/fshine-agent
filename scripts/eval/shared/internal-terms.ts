/**
 * 用户可见文本「内部词」扫描的单一来源（所有用户级批次共用）。
 *
 * 从 `scripts/eval/real/live-replay.ts` 抽出（2026-11-20 泄漏守卫通用化切片）：
 *   · INTERNAL_WORDS —— 内部词表，逐字冻结，与抽离前完全一致（不加词、不减词）；
 *   · findLiteralHits —— 字面命中提取，语义与抽离前一致（marker 就是命中的词）；
 *   · scanUserVisibleText —— 新增的通用入口：给一批 {where,text}，返回命中列表
 *     （where / marker / excerpt=命中位置前后各 40 字符）。
 *
 * 这是**机械事实扫描**，不是措辞质量判断：只做已知字面子串的存在性判定，
 * 命中即「用户可见面出现了内部词」这一确定事实。词表单一来源，禁止在各批次复制。
 */

/** 内部词（逐字冻结；内容与抽离前 `live-replay.ts#INTERNAL_WORDS` 完全一致）。 */
export const INTERNAL_WORDS: readonly string[] = [
  '执行层', '执行端', '确认凭据', 'dispatchKey', '长时运行', '能力快照', '宿主运行时',
];

/** 一条带归属的用户可见文本。 */
export interface VisibleText {
  where: string;
  text: string;
}

/** 一条字面命中。 */
export interface Hit {
  where: string;
  marker: string;
  /** 命中位置前后各 40 字符（换行转义为 \n，便于单行打印/落盘）。 */
  excerpt: string;
}

/** 命中位置前后各 40 字符的原文片段。 */
const EXCERPT_RADIUS = 40;

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`.replace(/\n/gu, '\\n');
}

/**
 * 在用户可见文本里逐字找字面标记（marker 就是命中的词；同标记多次命中逐个记录）。
 * 语义与抽离前 `live-replay.ts#findLiteralHits` 完全一致。
 */
export function findLiteralHits(texts: readonly VisibleText[], markers: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    for (const marker of markers) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(marker, from);
        if (index < 0) break;
        hits.push({ where, marker, excerpt: excerptAt(text, index, marker.length) });
        from = index + marker.length;
      }
    }
  }
  return hits;
}

/**
 * 通用入口：扫描一批用户可见文本里是否出现内部词。
 * 返回 { hits }，hits 每项含 where、marker、excerpt（命中位置前后各 40 字符）。
 */
export function scanUserVisibleText(texts: readonly VisibleText[]): { hits: Hit[] } {
  return { hits: findLiteralHits(texts, INTERNAL_WORDS) };
}
