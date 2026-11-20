/**
 * 用户可见文本「内部词」扫描的单一来源（所有用户级批次共用）。
 *
 * 从 `scripts/eval/real/live-replay.ts` 抽出（2026-11-20 泄漏守卫通用化切片）：
 *   · INTERNAL_WORDS —— 内部词表，逐字冻结，与抽离前完全一致（不加词、不减词）；
 *   · findLiteralHits —— 字面命中提取，语义与抽离前一致（marker 就是命中的词）；
 *   · scanUserVisibleText —— 新增的通用入口：给一批 {where,text}，返回命中列表
 *     （where / marker / excerpt=命中位置前后各 40 字符）。
 *
 * 这是**机械事实扫描**，不是措辞质量判断：只做已知字面子串与机械形态（任务编号 / taskId）
 * 的存在性判定，命中即「用户可见面出现了内部词/内部标识」这一确定事实。
 * 词表单一来源，禁止在各批次复制。
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
 * 任务编号形态（工单腔四项之一）：`#N` 与模板产物「编号 N / 编号 #N」。
 *
 * 与 INTERNAL_WORDS 分开——词表逐字冻结、不扩词；这是独立的**形状断言**（正则），
 * 和字面词表走同一个 `scanUserVisibleText` 入口，故三个用户级批次自动生效（不复制三份）。
 * 编号仍留在底账/日志/审计里对账，这里只拦用户可见文本。
 */
export const TASK_NO_SHAPE_RE = /#\d+|编号\s*#?\d+/gu;

/** 在用户可见文本里找任务编号形态的命中（marker = 命中的那段文本）。 */
export function findTaskNumberHits(texts: readonly VisibleText[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    TASK_NO_SHAPE_RE.lastIndex = 0; // global 正则先归零，避免跨文本状态泄漏。
    for (const match of text.matchAll(TASK_NO_SHAPE_RE)) {
      const index = match.index ?? 0;
      hits.push({ where, marker: match[0], excerpt: excerptAt(text, index, match[0].length) });
    }
  }
  return hits;
}

/**
 * taskId 原文形态（2026-11-21 稳定性批次实测泄漏）：`task_` 前缀 + ≥8 位标识段。
 *
 * 稳定性批次 stop 场景的受理话术把「任务号 task_db2b3ca3」说给了用户——taskId 是宿主
 * 内部归属键，词表拦不住（真模型可以随时把它带进话术，逐词枚举追不上），只拦「#N /
 * 编号 N」也拦不住裸 taskId。与任务编号形态同一条纪律：独立的**机械形状**判据（正则），
 * 词表逐字冻结不扩词；只判用户可见面（底账/日志/审计/断言等内部证据文本不进本入口）。
 */
export const TASK_ID_SHAPE_RE = /task_[A-Za-z0-9-]{8,}/gu;

/** 在用户可见文本里找 taskId 形态的命中（marker = 命中的那段文本）。 */
export function findTaskIdShapeHits(texts: readonly VisibleText[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    TASK_ID_SHAPE_RE.lastIndex = 0; // global 正则先归零，避免跨文本状态泄漏。
    for (const match of text.matchAll(TASK_ID_SHAPE_RE)) {
      const index = match.index ?? 0;
      hits.push({ where, marker: match[0], excerpt: excerptAt(text, index, match[0].length) });
    }
  }
  return hits;
}

/**
 * 通用入口：扫描一批用户可见文本里是否出现内部词、任务编号形态或 taskId 形态。
 * 返回 { hits }，hits 每项含 where、marker、excerpt（命中位置前后各 40 字符）。
 * 三批（write-loop / write-loop-scenarios / convergence-r1）与 wecom-sim 用户可见面守卫
 * 共用这一个入口；新增形状断言只改这里，批次侧零改动。
 */
export function scanUserVisibleText(texts: readonly VisibleText[]): { hits: Hit[] } {
  return {
    hits: [
      ...findLiteralHits(texts, INTERNAL_WORDS),
      ...findTaskNumberHits(texts),
      ...findTaskIdShapeHits(texts),
    ],
  };
}
