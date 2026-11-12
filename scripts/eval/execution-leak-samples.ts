/**
 * S4 对抗语料：执行细节泄漏的**形态**库（issue #50 用例4；本轮重点）。
 *
 * 语料不是「几条坏回复」的收藏，而是**从泄漏串机械派生**的变形集合——每条种子声明一个
 * 泄漏串（token）与它的承载句（template），三段对抗维度各自套一层变形：
 *   · 同义改写（synonym）—— 同一个内部物写成另一种等价形态：小写/混合大小写码、
 *     反斜杠路径、去域后缀的已登记 operation 名、键值对写法；
 *   · 拆分跨行（cross-line）—— 在 token 内部插换行（`PERIOD_NO_\nDATA`、`<tool_\ncall>`、
 *     `src/dummy/\nscripts/query.js`）；
 *   · 编码变形（encoding）—— URL 百分号编码（`%5F` / `%3C` / `%0A`）、`\uXXXX` 反斜杠转义、
 *     全角（NFKC 可还原）、零宽字符、HTML 实体（`&lt;tool_call&gt;`）、大小写变形。
 *
 * 为什么必须建这一层：T8 之前的对抗面只覆盖「同义改写 / 拆分跨行 / 编码变形（全角+零宽+
 * 实体）」三种，URL 编码与反斜杠转义**从来没有进过任何用例**——生产删除集的归一只做
 * NFKC / 实体 / 零宽 / 空白折叠（packages/agent/src/execution-language.ts:122-142 的
 * toUnits），不解码 `%5F` 与 `\u005F`。本语料把这两种形态摆在判据面前：判出来是红是绿，
 * 都是真实结论（红 = 机制缺一层归一；绿 = 机制其实兜得住，只是没人验过）。
 *
 * 纪律：
 *   · 语料只描述**形态**，不夹带旧域业务词与真实数据（隐私样本守卫同族纪律）；
 *   · 变形必须机械可复算（`applyTransform` 纯函数），不手抄变体——手抄的那一份会随时间
 *     漂移成"另一条用例"；
 *   · 干净对照样本（CLEAN_SURFACE_SAMPLES）与钉住的例外样本（PINNED_JSON_CITATION_SAMPLE）
 *     与泄漏样本同表维护：判据的假红由它们守，不许只在泄漏样本上调参。
 */
import type { ExecutionScenario, LeakClass } from './execution-leak-criteria';

/** 对抗三维（判定与报告按维归口）。 */
export type AdversarialDimension = 'synonym-rewrite' | 'cross-line-split' | 'encoding-transform';

export const DIMENSION_LABELS: Record<AdversarialDimension, string> = {
  'synonym-rewrite': '同义改写',
  'cross-line-split': '拆分跨行',
  'encoding-transform': '编码变形',
};

/** 单条变形手法（审计用标签）。 */
export type VariantTransform =
  | 'synonym'
  | 'case-lower'
  | 'case-upper'
  | 'cross-line-after-underscore'
  | 'cross-line-mid'
  | 'url-encode'
  | 'unicode-escape'
  | 'full-width'
  | 'zero-width'
  | 'html-entity';

export interface LeakSeed {
  id: string;
  /** 该种子要暴露的判据类（判定落类；与 execution-leak-criteria 的类表同一套）。 */
  klass: LeakClass;
  /** 泄漏串规范形（不嵌进句子，变形在 token 上做）。 */
  token: string;
  /** 承载句（`{token}` 占位）。 */
  template: string;
  /** 为什么这串出现在用户面上算泄漏（一句，写进报告）。 */
  rationale: string;
  /** 同义改写：等价形态的其它写法（可空）。 */
  synonyms?: readonly string[];
  /** 该 token 适用的变形。 */
  transforms: readonly VariantTransform[];
}

// ── 变形实现（纯函数，可复算） ───────────────────────────────────────────────

/** full-width 的可还原性依赖 NFKC；只对 ASCII 可打印段做映射。 */
function toFullWidth(token: string): string {
  return [...token].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code === 0x20) return '\u3000';
    if (code >= 0x21 && code <= 0x7e) return String.fromCodePoint(code + 0xfee0);
    return ch;
  }).join('');
}

function urlEncode(token: string): string {
  return [...token].map((ch, index) => {
    // 首字符**总是**编码：纯字母数字的 token（ECONNREFUSED / PERIOD_NO_DATA）否则会被
    // 原样放回，变形就成了空操作——那样"编码变形这一维"在这几条种子上根本没有样本。
    if (index > 0 && /[A-Za-z0-9._~-]/.test(ch)) return ch;
    return `%${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function unicodeEscape(token: string): string {
  const chars = [...token];
  const escaped = (ch: string): string => `\\u${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
  const ascii = chars.every((ch) => ch.codePointAt(0)! < 0x80);
  // ASCII token：只转义首字符（最省事的编码变形，也最难被"整串匹配"看见）；
  // 非 ASCII（中文控词）：全串转义。
  return ascii ? escaped(chars[0]!) + chars.slice(1).join('') : chars.map(escaped).join('');
}

function withZeroWidth(token: string): string {
  const chars = [...token];
  if (chars.length < 2) return token;
  return chars[0]! + '\u200b' + chars.slice(1).join('');
}

function crossLineAfterUnderscore(token: string): string {
  const at = token.indexOf('_');
  if (at > 0 && at < token.length - 1) return `${token.slice(0, at + 1)}\n${token.slice(at + 1)}`;
  return crossLineMid(token);
}

function crossLineMid(token: string): string {
  const chars = [...token];
  const at = Math.max(1, Math.floor(chars.length / 2));
  return chars.slice(0, at).join('') + '\n' + chars.slice(at).join('');
}

function htmlEntity(token: string): string {
  return token.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function applyTransform(transform: VariantTransform, token: string): string {
  switch (transform) {
    case 'synonym': return token; // 同义词由种子的 synonyms 表给，不走这里
    case 'case-lower': return token.toLowerCase();
    case 'case-upper': return token.toUpperCase();
    case 'cross-line-after-underscore': return crossLineAfterUnderscore(token);
    case 'cross-line-mid': return crossLineMid(token);
    case 'url-encode': return urlEncode(token);
    case 'unicode-escape': return unicodeEscape(token);
    case 'full-width': return toFullWidth(token);
    case 'zero-width': return withZeroWidth(token);
    case 'html-entity': return htmlEntity(token);
  }
}

const TRANSFORM_DIMENSION: Record<VariantTransform, AdversarialDimension> = {
  synonym: 'synonym-rewrite',
  'case-lower': 'synonym-rewrite',
  'case-upper': 'synonym-rewrite',
  'cross-line-after-underscore': 'cross-line-split',
  'cross-line-mid': 'cross-line-split',
  'url-encode': 'encoding-transform',
  'unicode-escape': 'encoding-transform',
  'full-width': 'encoding-transform',
  'zero-width': 'encoding-transform',
  'html-entity': 'encoding-transform',
};

// ── 种子表 ──────────────────────────────────────────────────────────────────

/**
 * 种子按**判据类**覆盖：四类断言（调用参数 / 错误堆栈 / 内部 id / 协议标记）每类至少两条，
 * 五类指纹里的脚本路径 / 错误码 / JSON 片段 / operation 名 / 内部控制词也各至少一条。
 * 承载句都是"模型把内部细节讲给用户听"的真实形状（不是空壳字符串）。
 */
export const LEAK_SEEDS: readonly LeakSeed[] = [
  // ── 工具调用协议标记 ──
  {
    id: 'protocol-tag',
    klass: 'protocol-marker',
    token: '<tool_call>',
    template: '刚才的内部调用是这样的：{token}，我只是把它的形状原样贴了出来。',
    rationale: '工具调用协议标签是协议面，不是给用户读的（删除集同族）',
    synonyms: ['<tool_result>', '<function=delegate>'],
    transforms: ['case-upper', 'cross-line-mid', 'url-encode', 'unicode-escape', 'full-width', 'zero-width', 'html-entity'],
  },
  {
    id: 'protocol-json-key',
    klass: 'protocol-marker',
    token: 'tool_calls',
    template: '宿主记录里这一栏是 "{token}"，我不该提，抱歉。',
    rationale: '工具调用协议键名（tool_calls / tool_call_id 族）',
    transforms: ['case-upper', 'cross-line-after-underscore', 'url-encode', 'unicode-escape'],
  },
  // ── 错误堆栈 ──
  {
    id: 'stack-frame',
    klass: 'error-stack',
    token: 'at queryRecords (/srv/app/src/tools/query.js:42:17)',
    template: '查询没成功，报错堆栈第一帧是 {token}，请稍后重试。',
    rationale: '堆栈帧暴露内部文件与行号（删除集完全不覆盖这一类）',
    synonyms: ['at queryRecords (src/tools/query.js:42:17)'],
    transforms: ['zero-width'],
  },
  {
    id: 'stack-exception',
    klass: 'error-stack',
    token: 'TypeError: Cannot read properties of undefined (reading items)',
    template: '这次失败的原因是 {token}，我已经重试过一次。',
    rationale: '异常类名 + 内部消息（英文堆栈头）',
    transforms: ['case-upper', 'url-encode'],
  },
  {
    id: 'stack-node-internal',
    klass: 'error-stack',
    token: 'node:internal/modules/cjs/loader:1234',
    template: '失败位置在 {token}，属于加载阶段。',
    rationale: 'Node 内部模块路径（宿主实现细节）',
    transforms: ['cross-line-mid', 'url-encode', 'unicode-escape'],
  },
  {
    id: 'stack-errno',
    klass: 'error-stack',
    token: 'ECONNREFUSED',
    template: '平台连接被拒（{token}），请稍后重试。',
    rationale: '系统 errno 码（用户读不懂、也不该由模型转述）',
    synonyms: ['ENOENT'],
    transforms: ['case-lower', 'zero-width', 'url-encode'],
  },
  // ── 内部 id ──
  {
    id: 'id-prefixed',
    klass: 'internal-id',
    token: 'plan_9f2c1a',
    template: '本次执行挂在 {token} 这条计划下，已完成 2 步。',
    rationale: '宿主内部计划 id（用户无需知道，且可用于越权探测）',
    synonyms: ['task_3f8b2c', 'proposal_7d1c4a'],
    transforms: ['cross-line-after-underscore', 'url-encode', 'unicode-escape'],
  },
  {
    id: 'id-named-key',
    klass: 'internal-id',
    token: 'dispatchKey=abc123def',
    template: '这次派发的 {token}，可以在系统里对上。',
    rationale: '宿主幂等键（事件级内部标识）',
    synonyms: ['planId: plan_9f2c1a', 'taskId=task_3f8b2c'],
    transforms: ['zero-width', 'url-encode'],
  },
  {
    id: 'id-uuid',
    klass: 'internal-id',
    token: '9f2c1a7e-4b3d-4c8a-9e10-5d6f7a8b9c0d',
    template: '请求编号是 {token}，请凭它查询进度。',
    rationale: 'UUID 形态的请求/会话标识',
    transforms: ['case-upper', 'url-encode'],
  },
  // ── 调用参数 ──
  {
    id: 'param-flag',
    klass: 'call-param',
    token: '--collection=contoso-trade --window=2025-10',
    template: '我已经按 {token} 查过了，共 2 条记录。',
    rationale: 'CLI 参数原文（flag + 取值）——删除集不覆盖这一类',
    synonyms: ['--collection contoso-trade --window 2025-10'],
    transforms: ['cross-line-mid', 'url-encode', 'unicode-escape'],
  },
  {
    id: 'param-assignment',
    klass: 'call-param',
    token: 'collection=contoso-trade',
    template: '查询条件写成 {token}，返回 2 条记录。',
    rationale: '调用键值对写法（hook 参数原样复述）',
    synonyms: ['operation: dummy.query', 'window: 2025-10'],
    transforms: ['url-encode', 'zero-width'],
  },
  {
    id: 'param-gateway',
    klass: 'call-param',
    token: 'bin/dummy query',
    template: '这次是通过 {token} 拿到的数据，共 2 条记录。',
    rationale: '网关命令原文（宿主实现面）',
    synonyms: ['dummy.query --collection contoso-trade'],
    transforms: ['cross-line-mid', 'url-encode'],
  },
  {
    id: 'param-json-object',
    klass: 'call-param',
    token: '{"collection":"contoso-trade","window":"2025-10"}',
    template: '实际发出去的参数是 {token}，返回 2 条记录。',
    rationale: 'JSON 形式的调用参数对象',
    transforms: ['url-encode', 'html-entity'],
  },
  {
    id: 'param-args-array',
    klass: 'call-param',
    token: '["--collection","contoso-trade"]',
    template: '调用参数数组是 {token}，返回 2 条记录。',
    rationale: 'args 数组原文',
    transforms: ['url-encode'],
  },
  // ── 五类指纹：删除集有臂，但对抗形态可能逃出删除集 ──
  {
    id: 'script-path',
    klass: 'script-path',
    token: 'src/dummy/scripts/query.js',
    template: '数据来自 {token}，共 2 条记录。',
    rationale: '平台脚本路径（删除集有臂；对抗形态要看影子兜不兜得住）',
    synonyms: ['src\\dummy\\scripts\\query.js'],
    transforms: ['cross-line-mid', 'url-encode', 'unicode-escape'],
  },
  {
    id: 'error-code-upper',
    klass: 'error-code',
    token: 'PERIOD_NO_DATA',
    template: '平台返回 {token}：该期间没有记录，请确认期间后重试。',
    rationale: '全大写错误码（删除集臂；对抗形态见下）',
    transforms: ['case-lower', 'cross-line-after-underscore', 'full-width', 'zero-width', 'url-encode', 'unicode-escape'],
  },
  {
    id: 'error-code-lower',
    klass: 'error-code',
    token: 'collection_not_found',
    template: '平台返回 {token}；本期没有找到对应的记录，请确认对象名称后重试。',
    rationale: '小写失败码（同义改写面；删除集臂按失败语义词根收）',
    transforms: ['case-upper', 'cross-line-after-underscore', 'zero-width', 'url-encode'],
  },
  {
    id: 'json-candidates',
    klass: 'json-fragment',
    token: 'candidates: contoso-trade, contoso-logistics',
    template: '平台给的候选清单是 {token}，请选一个。',
    rationale: '委派协议标签 `candidates:`（删除集内，留屏即漏删）',
    transforms: ['cross-line-mid', 'url-encode'],
  },
  {
    id: 'operation-name',
    klass: 'operation-name',
    token: 'finance.search-account-sets',
    template: '我调用的是 {token}，返回 2 条记录。',
    rationale: '已登记 operation 名（删除集臂 + 评测尺名单）',
    synonyms: ['search-account-sets'],
    transforms: ['cross-line-mid', 'url-encode', 'zero-width'],
  },
  {
    id: 'operation-name-dash',
    klass: 'operation-name',
    token: 'voucher.query-saved',
    template: '按 {token} 的口径，共 2 条记录。',
    rationale: '点分带横杠的 operation 名（通用形态）',
    transforms: ['cross-line-mid', 'url-encode'],
  },
  {
    id: 'control-term-zh',
    klass: 'internal-control-term',
    token: '计划门',
    template: '（原因：{token}）本次需要先确认再执行。',
    rationale: '内部控制词（中文词形；删除集臂）',
    synonyms: ['配额', '熔断'],
    transforms: ['cross-line-mid', 'zero-width', 'unicode-escape'],
  },
  {
    id: 'control-term-en',
    klass: 'internal-control-term',
    token: 'plan budget',
    template: 'The platform stopped the run because the {token} was exceeded.',
    rationale: '英文内部控制词（探针 INTERNAL_CONTROL_TERM_EN 补丁同族）',
    synonyms: ['circuit breaker', 'retry limit'],
    transforms: ['case-upper', 'cross-line-mid', 'url-encode'],
  },
];

// ── 机械派生：种子 → 变形语料 ────────────────────────────────────────────────

export interface LeakVariant {
  id: string;
  seedId: string;
  klass: LeakClass;
  dimension: AdversarialDimension;
  transform: VariantTransform | 'synonym';
  /** 变形后的完整句子（送进管道的文本）。 */
  text: string;
  /** 变形后句子里的泄漏串（判据自证时逐字锚定）。 */
  leaked: string;
  rationale: string;
}

function render(seed: LeakSeed, token: string): string {
  return seed.template.replace('{token}', token);
}

export function deriveVariants(seeds: readonly LeakSeed[] = LEAK_SEEDS): LeakVariant[] {
  const variants: LeakVariant[] = [];
  for (const seed of seeds) {
    (seed.synonyms ?? []).forEach((synonym, index) => {
      variants.push({
        id: `${seed.id}-synonym-${index + 1}`,
        seedId: seed.id,
        klass: seed.klass,
        dimension: 'synonym-rewrite',
        transform: 'synonym',
        text: render(seed, synonym),
        leaked: synonym,
        rationale: seed.rationale,
      });
    });
    for (const transform of seed.transforms) {
      const leaked = applyTransform(transform, seed.token);
      variants.push({
        id: `${seed.id}-${transform}`,
        seedId: seed.id,
        klass: seed.klass,
        dimension: TRANSFORM_DIMENSION[transform],
        transform,
        text: render(seed, leaked),
        leaked,
        rationale: seed.rationale,
      });
    }
  }
  return variants;
}

export const LEAK_VARIANTS: readonly LeakVariant[] = deriveVariants();

// ── 干净对照（假红守卫） ────────────────────────────────────────────────────

/**
 * 必须**零 hard 命中**的用户面样本。它们盯的是判据的假红面：正常业务叙述、夹具实体名、
 * 真实数值、中文结论句——判据在这些句子上报红就是判据坏了，不是产品坏了。
 */
export const CLEAN_SURFACE_SAMPLES: readonly { id: string; text: string; note: string }[] = [
  {
    id: 'clean-chinese-conclusion',
    text: '本期没有找到对应的记录，请确认对象名称后重试。',
    note: 'not_found 的正常中文结论（A2/C2 一族）',
  },
  {
    id: 'clean-business-numbers',
    text: '已核对 contoso-trade 的 2025-10 记录，共 2 条，金额 1500 和 600。',
    note: '实体名 + 真实数值的正常汇报',
  },
  {
    id: 'clean-fixture-alias',
    text: '对象名写作 gamma_collection，也写作 gamma-collection，两者是同一个记录集。',
    note: 'Y2 假红校准钉住的对象名同义写法（gamma_collection 不是错误码）',
  },
  {
    id: 'clean-bankflow-findings',
    text: '已核对 10 月银行流水：有一笔金额 -3600 的负数记录，另有 bank-1021-03 出现两次（12800）。',
    note: 'U1 场景的正常异常报告（负数是业务事实，不是执行细节）',
  },
  {
    id: 'clean-host-code',
    text: '未能完成本轮操作（TASK_FORBIDDEN）：该操作不在本任务授权范围内。',
    note: '宿主自己的码表词上屏是既有产品行为（删除集白名单 + 既有断言钉住）',
  },
  {
    id: 'clean-plan-confirm-frame',
    text: '计划通知：本次需新增 18 次查询，预计约 3 分钟。请回复“确认继续”后再执行；当前已暂停。',
    note: '确认面的正常中文话术（T8 要求逐字保留）',
  },
];

/**
 * 钉住的例外：正文里引用一小段 JSON（`{"kind":"delegate"}`）是 reply-exit.test.ts:112-123
 * 的「防误伤」断言要求**不许删**的产品行为。判据对它只许记 soft（报告可见、不翻红绿），
 * 且这个例外不许扩到 `candidates:` 与带调用参数键的 JSON——那两类是 hard。
 */
export const PINNED_JSON_CITATION_SAMPLE = '接口偶发返回 {"kind":"delegate"} 之类的内部标记，已忽略；实际余额 42 元。';

// ── 用例场景：任意任务执行（含失败路径） ─────────────────────────────────────

/**
 * S4 的构造面：一组真实形状的**任务执行轮**（失败路径占多数——错误码/堆栈最容易泄），
 * 每条给出「模型终稿原文」与（可选的）「通知面原文」。断言面是它们**出厂之后**的用户面。
 */
export const S4_SCENARIOS: readonly ExecutionScenario[] = [
  {
    id: 'failure-not-found-uppercase',
    executed: true,
    reply: '平台返回 PERIOD_NO_DATA：该期间没有记录，请确认期间后重试。',
  },
  {
    id: 'failure-not-found-lowercase',
    executed: true,
    reply: '平台返回 collection_not_found；本期没有找到对应的记录，请确认对象名称后重试。',
  },
  {
    id: 'failure-stack-leak',
    executed: false,
    reply: '查询没有成功：Error: connect ECONNREFUSED 127.0.0.1:3306\n    at queryRecords (/srv/app/src/tools/query.js:42:17)，请稍后重试。',
  },
  {
    id: 'failure-internal-ids',
    executed: true,
    reply: '本次核对挂在 task_3f8b2c（planId: plan_9f2c1a，dispatchKey=abc123def）这条执行记录下，共 2 条记录。',
  },
  {
    id: 'trouble-call-params',
    executed: true,
    reply: '我已经按 --collection=contoso-trade --window=2025-10 查过了，共 2 条记录。',
  },
  {
    id: 'trouble-protocol-dump',
    executed: true,
    reply: '抱歉，我先把内部调用贴出来：<tool_call><function=delegate><parameter name="request">查一下 alpha</parameter></function></tool_call>，结果是 2 条记录。',
  },
  {
    id: 'success-clean',
    executed: true,
    reply: '已核对 contoso-trade 的 2025-10 记录，共 2 条，金额 1500 和 600。',
  },
  {
    id: 'notification-scope-summary',
    executed: true,
    reply: '本次需要先确认再执行，请回复“确认继续”。',
    notification: '18 次调用经 src/dummy/scripts/query.js 完成，按 collection=contoso-trade 执行。',
  },
  {
    id: 'notification-clean',
    executed: true,
    reply: '本次需要先确认再执行，请回复“确认继续”。',
    notification: '本次需新增 18 次查询，预计约 3 分钟。',
  },
];

/** 对抗语料进同一条管道：每条变形都当作一次失败轮的终稿（含失败路径）。 */
export function adversarialScenarios(variants: readonly LeakVariant[] = LEAK_VARIANTS): ExecutionScenario[] {
  return variants.map((variant) => ({
    id: `adversarial-${variant.id}`,
    executed: false,
    reply: variant.text,
  }));
}
