/**
 * 评测侧自持的执行语言指纹尺（判据自持，2026-11-08）。
 *
 * **刻意不 import `@fshine/agent` 的 `executionLanguageFingerprints`**：
 * 与宿主那份不共享代码——宿主检测器有假阴性时评测继承同一个假阴性，永远发现不了。
 * 评测尺的职责是「独立发现问题」，不是「复刻宿主实现」；两份尺子语义对齐（五类标签
 * 一致，见下），写法各自持有：宿主那份在 packages/agent/src/execution-language.ts，
 * 这里的每条 pattern 都是同义但不同形的独立实现。漂移是有意的：哪边先收紧，另一边
 * 的差异会在评测输出里显形（多报或少报一类），而不是被同源实现静默吞掉。
 *
 * 五类标签与宿主一致（note 文案与 dims 归维都按这些标签组句，见
 * probe-real-agent.ts 的 execLanguageLeakNotes 与 scripts/eval/dims.ts）：
 *   · 脚本路径        —— src/… .js 形态的平台脚本路径
 *   · 错误码          —— UPPER_SNAKE / lower_snake 码形
 *   · JSON 片段       —— candidates: 键与花括号
 *   · operation 名    —— 带点的全小写操作名（至少一段含连字符）或已登记操作名
 *   · 内部控制词      —— 额度/配额/熔断/计划门/上限族的中文词形
 * 英文内部控制词形（quota / circuit breaker / retry limit…）不在这里收：探针在
 * execLanguageLeakNotes 里已有一层独立补丁（probe-real-agent.ts 的
 * INTERNAL_CONTROL_TERM_EN，2026-10 决策记录保留），评测尺只对齐宿主的五类，
 * 不替探针做加法——两处各管各的，谁漏了在输出里看得见。
 */

/**
 * 已登记操作名的评测侧名单（宿主的 PLATFORM_OPERATIONS 不 import，名单由评测自持）。
 * 刻意只收「去域后缀不退化成普通英文词」的名字：宿主登记表 today 只有
 * finance.search-account-sets 一支，其后缀形 search-account-sets 也该报（宿主同判）；
 * 夹具的 dummy/ballot/stock 三个域的操作注册名**不**进这份名单——它们的去域后缀形
 * （query/commit/proposal…）是普通英文词，收了会把正常回复判成泄漏（假红），与宿主
 * 「带点带横杠才报」的口径同义地保持一致。评测尺对宿主名单的职责是独立复判，不是
 * 加码：宿主漏报靠 pattern 差异显形，不靠换一份会改变判定结果的名单。
 */
const EVAL_REGISTERED_OPERATIONS: readonly string[] = [
  'finance.search-account-sets',
];

/** 转义操作名里的正则元字符（名单是常量，这一步只是纵深）。 */
function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * operation 名：两种形态任一命中即报（与宿主同语义，写法独立）：
 *   ① 通用的带点小写名，且**末段含连字符**——前瞻 = 「有点，且末个点号之后带横杠」，
 *      合起来就是 voucher.query-saved 这一族。不含连字符的纯 `a.b` 点分名刻意不收
 *      （正常英文句读 "e.g." / "i.e." / 版本号 v1.2 不是操作名）；横杠只在末段之前的
 *      也不收（`query-receivables.js` 这种脚本文件名不是操作名，宿主同判）；
 *   ② 已登记名单的完整名或去域后缀名（`search-account-sets` 这种裸段也算）。
 */
const OPERATION_NAME_EVAL = new RegExp([
  String.raw`\b(?=[a-z][a-z0-9.-]*\.[a-z][a-z0-9-]*-)[a-z][a-z0-9.-]*\b`,
  EVAL_REGISTERED_OPERATIONS
    .flatMap((name) => [name, name.slice(name.indexOf('.') + 1)])
    .map((token) => String.raw`\b${escaped(token)}\b`)
    .join('|'),
].join('|'));

/** 五类指纹。标签即对外措辞，与宿主对齐；pattern 写法刻意与宿主不同。 */
export const EVAL_EXECUTION_LANGUAGE_FINGERPRINTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '脚本路径', pattern: /src\/[^\s，,；;）)]*\.js/ },
  // 错误码：大写形写成「首字母 + 一段或多段 _段」结构（宿主是星号量词的等价集合，
  // 集合相同、构造式不同）；小写 snake 照收。
  { label: '错误码', pattern: /\b[A-Z](?:[A-Z0-9]*_[A-Z0-9]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/ },
  { label: 'JSON 片段', pattern: /\bcandidates\s*:|\{|\}/ },
  { label: 'operation 名', pattern: OPERATION_NAME_EVAL },
  { label: '内部控制词', pattern: /额度|配额|熔断|计划门|拒绝上限|重试上限/ },
];

/**
 * 文本里命中的指纹标签（顺序 = 表序，去重天然成立）。独立于宿主实现：
 * 宿主检测器漏报时，这把尺按自己的 pattern 独立判定。
 */
export function executionLanguageFingerprints(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern } of EVAL_EXECUTION_LANGUAGE_FINGERPRINTS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}
