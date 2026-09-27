/**
 * 泄漏预算 lint：平台实现细节不得出现在白名单之外的 fshine 源码中。
 * 白名单 = platform-contract.ts（唯一契约适配层）。
 * 平台侧契约演进（E1 操作名 / E2 信封 / E3 权重）落地后，白名单应持续收窄。
 *
 * 第二条预算（L1 业务词归属）：业务词不得以**非防御**形态进入宿主 src。进度帧里的
 * 业务措辞只能由平台清单第 5 列提供（见 operation-labels.ts）。词表九词（应收/凭证/
 * 科目/账套/期间/目录/税号/财务/借贷）；命中项按**四标签归属制度**登记（警职执法/
 * 防御排除/平台下发/遗留待清），断言"非防御命中=0"——每个命中必须在允许集里且挂标签，
 * 未挂标签的命中即红。防御排除项（记忆提取财务正则、hasFinancialFigure 等）删它=防御
 * 变聋，100% 挂「防御排除」并注释理由。
 *
 * 第三条预算：字面量 if 预算——禁止新增"针对具体输入值的字面量比较分支"
 * （出事点 if-else / 症状嗅探，2026-09 用户点名：不希望再看到针对具体模型输入的
 * 一堆 if-else）。哲学与业务词预算相同：扫出当前命中集 → 冻结为基线 → 只减不增
 * （新增即红，收敛直接通过）。模式定义、三轮收窄过程与白名单理由见文件底部
 * LITERAL_IF_* 常量块。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['packages', 'apps', 'scripts'];
// 白名单：platform-contract.ts 是唯一契约适配层（*.test.ts 豁免——夹具演示被拦形态）
const ALLOWLIST = new Set([
  path.join(REPO_ROOT, 'packages/agent/src/platform-contract.ts'),
]);

/** 平台实现细节指纹：出现即泄漏（公共契约——操作名/模式名/env 名——不在列） */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: '脚本文件名 fill.js', pattern: /fill\.js/ },
  { label: '脚本文件名 verify-saved.js', pattern: /verify-saved\.js/ },
  { label: '脚本文件名 query-saved.js / query-history.js / subject-list.js', pattern: /(query-saved|query-history|subject-list)\.js/ },
  { label: '平台脚本目录路径', pattern: /src\/(voucher|finance|payroll)\/scripts/ },
  { label: '平台内部清单文件', pattern: /operations\.json/ },
  { label: '已废弃入口 serve.sh', pattern: /serve\.sh/ },
  { label: '旧消费者命名（E4 后应全量 DZ_*）', pattern: /FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'data') continue;
      yield* walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full;
  }
}

describe('平台泄漏预算 lint', () => {
  it('fshine 源码中平台实现细节仅允许存在于契约适配层', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        if (ALLOWLIST.has(file)) continue;
        const content = readFileSync(file, 'utf8');
        for (const { label, pattern } of FORBIDDEN) {
          if (pattern.test(content)) violations.push(`${path.relative(REPO_ROOT, file)}: ${label}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('编排层业务词归属预算：非防御命中=0 且防御项 100% 挂「防御排除」', () => {
    const hits = businessWordHits(path.join(REPO_ROOT, 'packages/agent/src'));
    // 判据一（非防御命中=0）：命中项必须在允许集里且挂标签；未挂标签的命中即红。
    const untagged = hits.filter((hit) => !BUSINESS_WORD_ALLOWLIST.has(hit));
    expect(untagged, [
      '新增了未归属的业务词（宿主 src 业务词非防御命中必须=0）：',
      ...untagged,
      '合法命中 → 在 BUSINESS_WORD_ALLOWLIST 登记并挂四标签之一 + 理由；',
      '真违例 → 改为平台数据下发或删除，不进白名单。',
    ].join('\n')).toEqual([]);
    // 判据二（防御项 100% 挂「防御排除」）：删条目/改标签即红。与判据一互补——判据一抓
    // "漏挂"，判据二抓"把防御项降级成非防御标签"（那会让它被后续当违例清理掉）。
    for (const key of DEFENSIVE_EXCLUSION_KEYS) {
      expect(BUSINESS_WORD_ALLOWLIST.get(key)?.tag, key).toBe('防御排除');
    }
  });

  it('字面量 if 预算：针对具体输入值的字面量比较分支只减不增（新增即红）', () => {
    const hits = literalIfHits();
    // 子集断言：当前命中必须全部在冻结基线内（新增 → 红）；收敛（删分支）直接通过。
    const added = hits.filter((hit) => !LITERAL_IF_BASELINE.includes(hit));
    expect(added, [
      '新增了针对具体输入值的字面量比较分支（出事点 if-else / 症状嗅探）：',
      ...added,
      '合法协议常量 → 加 LITERAL_IF_WHITELIST 并注释理由；真气味 → 改数据判据（错误码 / 能力声明），不嗅探具体值。',
    ].join('\n')).toEqual([]);
  });
});

/** 编排层业务词（中文领域词，九词）：出现即说明 fshine 可能在替平台说话。 */
const BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录|税号|财务|借贷/g;

/**
 * 四标签归属类型（docs/architecture-laws.md 归属标签制度）：
 *   · 警职执法：守卫/解析器/校验器本身，其存在就是为了识别或阻挡被禁模式；
 *   · 防御排除：防御机制的字面量，删它=防御变聋；
 *   · 平台下发：文本由执行层数据携带，宿主只是渲染（label / correctForm / 候选名）；
 *   · 遗留待清：已知该走但还没走的，挂账限期。
 */
type LeakTag = '警职执法' | '防御排除' | '平台下发' | '遗留待清';

/**
 * 业务词命中允许集（`文件: 词` → 标签 + 理由）。宿主 src 的每个业务词命中必须在此
 * 登记、挂且仅挂一类标签；未登记即红（见上方"非防御命中=0"断言）。位置无关：只按
 * 文件与词记账，行号漂移不影响归属。
 */
const BUSINESS_WORD_ALLOWLIST: ReadonlyMap<string, { tag: LeakTag; reason: string }> = new Map([
  // ── 防御排除：删它=防御变聋，不得当违例删 ──
  ['packages/agent/src/memory-candidate-extractor.ts: 应收', { tag: '防御排除', reason: 'FINANCIAL_RESULT_RE（五条财务识别正则之一）：拦"把临时财务事实存进长期记忆"，删=防沉积防御变聋' }],
  ['packages/agent/src/memory-candidate-extractor.ts: 科目', { tag: '防御排除', reason: 'BALANCE_RE（科目余额…）：同上财务识别防御正则' }],
  ['packages/agent/src/memory-candidate-extractor.ts: 账套', { tag: '防御排除', reason: 'ACCOUNT_SET_RE：同上财务识别防御正则（PERIOD_RE/CURRENCY_AMOUNT_RE 两条不含九词，故不命中）' }],
  ['packages/agent/src/runtime.ts: 财务', { tag: '防御排除', reason: 'hasFinancialFigure 及周边"财务数字"检测（区分编造结论 vs 能力边界说明）+ 历史资料防串（旧财务结论不当本轮实时结果）：删=出口校验/防串防御变聋' }],
  // ── 警职执法：守卫/校验器识别业务模式，其存在就是为了识别 ──
  ['packages/agent/src/context-extractor.ts: 期间', { tag: '警职执法', reason: 'hasContradiction 范围意图识别（更多期间/当前期间配对）：识别业务词以判定用户范围意图，是识别器不是泄漏' }],
  ['packages/agent/src/serve-gate.ts: 目录', { tag: '警职执法', reason: 'G1 门知识面/根目录的路径安全判定：门守卫自身引用它约束的知识面' }],
  ['packages/agent/src/turn-contract.ts: 目录', { tag: '警职执法', reason: 'validatePlanEntities 实体来源校验：平台响应（含账套检索结果）是受认实体来源，校验器说明其为何天然放行' }],
  ['packages/agent/src/pi-coding-driver.ts: 目录', { tag: '警职执法', reason: '计划实体来源收集：账套检索结果作为执行痕迹/候选名来源的识别' }],
  // ── 遗留待清：已知该走还没走，挂账限期 ──
  ['packages/agent/src/context.ts: 借贷', { tag: '遗留待清', reason: '写路径确认摘要渲染"借贷合计"（L4 违例）：Wave 3 迁到平台盖章 summary，宿主不再渲染业务字段' }],
  ['packages/agent/src/context.ts: 目录', { tag: '遗留待清', reason: 'worker 系统提示词的工作目录/账套检索/域目录前缀描述：理想应收敛为平台 SKILL 指针（Wave 2 D）' }],
  ['packages/agent/src/context.ts: 期间', { tag: '遗留待清', reason: '并发注释"会话期间"的时间描述（非业务期间口径）：待改写成中性"过程/时间"' }],
  ['packages/agent/src/history-tools.ts: 财务', { tag: '遗留待清', reason: '通用历史工具描述误用"财务"限定（search_history/get_messages 领域无关）：待改成"实时数据/历史结果"中性措辞' }],
  ['packages/agent/src/platform-mock.ts: 目录', { tag: '遗留待清', reason: 'mock 状态路径注释"该目录已 gitignore"（文件系统目录）：待改成"路径"' }],
]);

/** 防御排除类命中（L1：必须 100% 挂「防御排除」，删条目/改标签即红，见上方第二条断言）。 */
const DEFENSIVE_EXCLUSION_KEYS: readonly string[] = [
  'packages/agent/src/memory-candidate-extractor.ts: 应收',
  'packages/agent/src/memory-candidate-extractor.ts: 科目',
  'packages/agent/src/memory-candidate-extractor.ts: 账套',
  'packages/agent/src/runtime.ts: 财务',
];

// 防御排除登记（属防御性业务逻辑，但当前正则/名单不含九词中文、故不命中，仍登记防误删）：
//   · runtime.ts hasFinancialFigure：正则用 余额/金额/发生额（不在九词表）检测"财务数字"。
//   · serve-gate.ts KEY_ARG_FLAGS（--query/--period/--subject-code）：Wave 2 前从平台
//     operations.json args 规格派生前的宿主侧镜像（参数摘要提取用），非中文业务词。

/** 逐词收集业务词命中（位置无关：按文件与词去重记账，行号漂移不影响归属）。 */
function businessWordHits(dir: string): string[] {
  const seen = new Set<string>();
  for (const file of walk(dir)) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      for (const match of line.matchAll(BUSINESS_WORD_RE)) {
        seen.add(`${rel}: ${match[0]}`);
      }
    }
  }
  return [...seen].sort();
}

// ── 第三条预算：字面量 if（针对具体输入值的字面量比较分支）────────────────────
//
// 气味（2026-09 用户点名：不要针对具体模型输入的一堆 if-else）：
//   `if (x === '具体值')` / `x.includes('具体值')` / `switch (x) { case '具体值' }`
// 出现在处理模型/调用方输入的位置——宿主替模型猜"这其实是同一个命令 / 同一句话"，
// 猜错时模型收到一句答非所问，于是开始瞎试（真实平台实测：被误导到把方案 JSON
// 打印成助手文本，12 步全空转）。判据必须是数据（错误码 / 能力声明），不是值嗅探。
//
// 模式收窄过程（扫的都是 packages/agent/src/** 与 apps/**，排除 *.test.ts）：
//   ① 全量字面量比较（任何 '...' 出现在 ===/includes/case）→ 78 处。
//      角色名/事件类型/契约枚举/CLI 子命令全是标识符形 token——模式太宽，收窄；
//   ② "具体值"定义为：中文 ∪ 格式符（` " '）∪ 长度≥8 且非标识符形 → 12 处。
//      标识符形 token 一律预设为协议常量（新枚举值零摩擦，见 PROTOCOL 白名单）；
//   ③ `case` 从句额外把"长度≥8 的标识符形"也算具体值——switch 按具体值逐分支
//      正是"一堆 if-else"的原型形状。既有 6 条全是已退役工具名，进白名单。
// 最终：12 命中 = 3 基线（真气味，只减不增）+ 9 白名单（合法/死代码，逐条注释）。
// 2026-09 第二波：3 条真气味已收敛（结构化 outcome 取代回复文本嗅探），基线清空，
// 命中集 = 9 白名单。新增任何字面量 if 即红（白名单外），收敛继续直接通过。

/** 字面量比较的出现位置（一行一扫，与业务词预算同样的行扫哲学）。 */
const LITERAL_IF_SITES: ReadonlyArray<{ re: RegExp; isCaseClause?: boolean }> = [
  { re: /(?:===|!==)\s*'([^']*)'/g },
  { re: /(?:===|!==)\s*"([^"]*)"/g },
  { re: /\.includes\(\s*'([^']*)'\s*\)/g },
  { re: /\.includes\(\s*"([^"]*)"\s*\)/g },
  { re: /\.startsWith\(\s*'([^']*)'\s*\)/g },
  { re: /\.startsWith\(\s*"([^"]*)"\s*\)/g },
  { re: /case\s+'([^']*)'\s*:/g, isCaseClause: true },
  { re: /case\s+"([^"]*)"\s*:/g, isCaseClause: true },
];

const CJK_RE = /[\u4e00-\u9fff]/;
/** markdown 围栏 / 引号类格式符：模型输出包装的典型症状（```、"…"、'…'）。 */
const FORMAT_CHAR_RE = /[`"']/;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const LONG_TOKEN_CHARS = 8;

/** 字面量是否"具体输入值"：中文 / 格式符 / 长而非标识符形；case 从句另计长标识符形。 */
function isSpecificInputLiteral(literal: string, isCaseClause: boolean): boolean {
  if (CJK_RE.test(literal)) return true;
  if (FORMAT_CHAR_RE.test(literal)) return true;
  if (literal.length >= LONG_TOKEN_CHARS && !IDENTIFIER_RE.test(literal)) return true;
  return isCaseClause && literal.length >= LONG_TOKEN_CHARS && IDENTIFIER_RE.test(literal);
}

/**
 * 协议常量白名单（全局豁免，分组注释理由）。
 *
 * 用户点名的 `=== 'mock'`（platform-mock.ts 执行器开关值）、serve-gate.ts 的
 * `=== 'bash'` / `=== 'operation'` / `=== 'run'`（CLI 子命令与工具名）、dz-env 类
 * env 值比较（'1'）都在本表内。收窄后的模式下它们本就不命中（短/标识符形 token
 * 预设为协议常量）——仍显式登记：既是双保险（模式若再放宽不会一夜爆红），
 * 也是"为什么合法"的文档：这些值不是模型可能吐出的内容，而是 fshine 自己契约 /
 * 平台协议定义的结构性常量。新增协议常量在这里登记，不要散进分支。
 */
const LITERAL_IF_PROTOCOL_TOKENS: ReadonlySet<string> = new Set([
  // pi 原生消息形状与角色（driver/转录处理的结构常量）
  'user', 'assistant', 'toolResult', 'toolCall', 'text',
  // Conversation Log 事件类型（contracts 定义）
  'user_message', 'assistant_message', 'tool_result', 'plan_event',
  // 回合契约 kind（turn-contract.ts 两枝枚举）
  'conversation', 'delegate',
  // 计划门 / 确认流状态（plan-runtime 决策、plan-confirmation 结局）
  'active', 'pending', 'confirmed', 'activated', 'cancelled', 'superseded', 'ambiguous', 'expired', 'ignored',
  // 平台 RESULT 信封 status / 写流程提案信封 type（platform-contract.ts 唯一适配层）
  'completed', 'needs_input', 'not_found', 'failed', 'change_proposal',
  // 长期记忆记录 type / status（@fshine/contracts）
  'preference', 'fact', 'conflicted', 'deleted',
  // Context State 补丁字段名（context-extractor 契约）
  'userDecisions', 'agentAssumptions', 'unresolvedQuestions', 'recentTopic',
  // CLI 子命令 / 原生工具名 / 开关值（bin/17dz 网关与 serve-gate 协议）
  'operation', 'plan', 'query', 'prepare', 'commit', 'evaluate', 'activate', 'current', 'status', 'run',
  'bash', 'sh', 'read', 'ls', 'write', 'mock',
  // 宿主内部工具名（step-text.ts 静默帧名单）
  'search_history', 'get_messages', 'route_current_turn',
  // 渠道来源判别符（可信渠道适配器添加，从不复制模型输出）
  'wecom_user',
  // typeof 守卫与 contextMode 枚举（结构判定，非输入值）
  'function', 'transcript',
]);

/**
 * 逐项例外白名单（`文件:字面量` → 合法理由）。协议常量走上面的全局表；
 * 只有"全局豁免过宽"的项才落这里——每一条都必须注释为什么合法。
 */
const LITERAL_IF_WHITELIST: ReadonlyMap<string, string> = new Map([
  // Pi skill 的约定文件名：发现遍历的定位常量，不是模型可能吐出的内容值。
  ['packages/agent/src/skills.ts:SKILL.md', 'Pi skill 约定文件名（协议常量）'],
  // YAML frontmatter 标量去引号：判断"是不是被引号包住"——结构形状检查，非内容嗅探。
  ['packages/agent/src/skills.ts:"', 'frontmatter 标量去引号（结构形状检查）'],
  ["packages/agent/src/skills.ts:'", 'frontmatter 标量去引号（结构形状检查）'],
  // L6：step-text.ts 的 6 个已退役直接平台工具名 case（search_account_sets 等）已随
  // 沉积清理删除，对应白名单条目一并移除——主 Agent 工具面早已只剩宿主内部工具与
  // run_17dz_task 委派，任何新的具名 case 不在表内，照样红。
]);

/**
 * 当前命中集（`文件: 字面量`）——冻结基线，新增任意一行即失败。
 *
 * 原三条（context.ts 嗅探自己生成的回复文本给日志 outcome 分类 ×2、runtime.ts
 * 嗅探'已作废'给 turn_span 分类 ×1）已于 2026-09 第二波收敛：finalizeProposal /
 * matchConfirmation 改为返回结构化 outcome（{kind:'proposal_declined'} 一族），
 * 日志从数据里取，includes 断言整体删除。收敛直接通过（子集断言只减不增），
 * 基线相应清空——再出现同类嗅探即红。
 */
const LITERAL_IF_BASELINE: readonly string[] = [];

/** 第三条预算的扫描范围：编排层源码（测试文件豁免——夹具演示被拦形态）。 */
const LITERAL_IF_SCAN_DIRS = ['packages/agent/src', 'apps'];

function literalIfHits(): string[] {
  const hits: string[] = [];
  for (const dir of LITERAL_IF_SCAN_DIRS) {
    for (const file of walk(path.join(REPO_ROOT, dir))) {
      const rel = path.relative(REPO_ROOT, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        for (const { re, isCaseClause } of LITERAL_IF_SITES) {
          for (const match of line.matchAll(re)) {
            const literal = match[1]!;
            if (!isSpecificInputLiteral(literal, isCaseClause === true)) continue;
            if (LITERAL_IF_PROTOCOL_TOKENS.has(literal)) continue;
            if (LITERAL_IF_WHITELIST.has(`${rel}:${literal}`)) continue;
            hits.push(`${rel}: ${literal}`);
          }
        }
      }
    }
  }
  return hits.sort();
}
