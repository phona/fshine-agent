/**
 * 用户可见文本「内部词」扫描的单一来源（所有用户级批次共用）。
 *
 * 从 `scripts/eval/real/live-replay.ts` 抽出（2026-11-20 泄漏守卫通用化切片）：
 *   · INTERNAL_WORDS —— 内部词表，逐字冻结，与抽离前完全一致（不加词、不减词）；
 *   · findLiteralHits —— 字面命中提取，语义与抽离前一致（marker 就是命中的词）；
 *   · scanUserVisibleText —— 新增的通用入口：给一批 {where,text}，返回命中列表
 *     （where / marker / excerpt=命中位置前后各 40 字符）。
 *
 * 这是**机械事实扫描**，不是措辞质量判断：只做已知字面子串与机械形态（任务编号 / taskId /
 * 结构化块）的存在性判定，命中即「用户可见面出现了内部词/内部标识」这一确定事实。
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
 * 结构化块形状（2026-11-24 补 live P0 ①「DSML 工具块原样投给用户」；同日晚按 grok 实测
 * 修订：**判定基础换成已冻结的封闭表，不再维持开放式词表**）。
 *
 * 为什么是封闭表：工具块写法的输入空间是开的，逐词补不会收敛（grok major：`tool_use` /
 * `antml:` / `function_call` 在仓内用户可见语料里零样本，属「假设形态进判据」，违反
 * change-safety F8「判据扩张用实测原文做表征锁」）。2026-11-20 live 实测拿到的真形状是
 * 封闭的四条（原 live-replay 的 `TOOL_MARKERS`，已冻结），本表就是那四条的唯一来源——
 * live-replay 改为从这里 import，不再各存一份。
 *
 * 判据是**机械形状**（格式/泄漏类），不判语义：
 *   · 工具调用块标记：上面那四条封闭表；
 *   · ~~JSON 结构字面量~~：2026-11-25 删（debt R-6）——假设形态、真实跑批零命中，见
 *     findStructuredBlockHits 的注释。
 *
 * 明确**不**判的：模型自己说「系统不支持 X」（编造限制）——那是语义行为，判据红线禁止用
 * 词/正则判语义；只能靠「不给它编造的机会」（卸载上下文，见 factword 那条链）+ 用户级 eval
 * 间接反映。同理不判 ``` 代码围栏本身（用户让模型写代码时围栏是合规产物）。
 *
 * 取舍说明：这是**严闸**——只拦实测见过的形状，不拦假设形状（2026-11-25 debt R-6 删掉
 * JSON 字面量那半后同步改口）。原「提案摘要合法含 JSON 会红」描述的是已删除的正则，不再成立。
 */

/** 工具调用块标记（2026-11-20 live 实测冻结的四条；原 live-replay TOOL_MARKERS）。 */
export const TOOL_BLOCK_MARKERS: readonly string[] = ['<｜｜DSML', '<｜tool', '<invoke', 'parameter name='];

/**
 * 在用户可见文本里找结构化块形状的命中（marker = 命中的那段文本）。
 *
 * **只有实测冻结的四条工具块标记**（2026-11-25 debt R-6 删掉 JSON 那半）。
 *
 * 为什么删：JSON 字面量（`{"a":1` / `["a","b"]`）是本轮**假设**的形状——没有任何一次实测
 * 泄漏的原文佐证；而它的判据有两个已暴露的缺陷：放宽冒号条件会把业务文本里的无冒号引语
 * （`{"备注"}`）打红，首键超 48 字的对象又漏。按 change-safety F8「判据扩张用实测原文做
 * 表征锁，假设形态不进判据」删掉。
 *
 * **注意**：这里没有「实测零命中」的份数claim——`leak.json` 只在跑批目录里、不进检出，
 * 无法在仓内复核。可复核的判据是**方向性**的：工具块四条有 2026-11-20 live 实测原文
 * （`live-replay.test.ts` 的绊线），JSON 一条都没有。真出现 JSON 泄漏那天，用泄漏原文做
 * 绊线再加回来。
 */
export function findStructuredBlockHits(texts: readonly VisibleText[]): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of texts) {
    for (const marker of TOOL_BLOCK_MARKERS) {
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
 * 通用入口：扫描一批用户可见文本里是否出现内部词、任务编号形态、taskId 形态或结构化块形状。
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
      ...findStructuredBlockHits(texts),
    ],
  };
}
