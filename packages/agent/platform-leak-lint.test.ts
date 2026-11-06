/**
 * 泄漏预算 lint：平台实现细节不得出现在白名单之外的 fshine 源码中。
 * 白名单 = platform-contract.ts（唯一契约适配层）。
 * 平台侧契约演进（E1 操作名 / E2 信封 / E3 权重）落地后，白名单应持续收窄。
 *
 * 第二条预算（L1 业务词归属）：业务词不得以**非防御**形态进入宿主 src。进度帧里的
 * 业务措辞只能由平台清单第 5 列提供（见 operation-labels.ts）。词表十五词（应收/凭证/
 * 科目/账套/期间/目录/税号/财务/借贷/余额/往来/时间范围/记录/档案/摸底）；命中项按
 * **四标签归属制度**登记（警职执法/防御排除/平台下发/遗留待清），断言"非防御命中=0"——
 * 每个命中必须在允许集里且挂标签，未挂标签的命中即红。防御排除项（记忆提取财务正则、
 * hasFinancialFigure 等）删它=防御变聋，100% 挂「防御排除」并注释理由。
 *
 * 词表收词纪律（D-005）：**同义改写抓不到**——进度帧曾用"时间范围/记录/档案/摸底"
 * 一类伪装形绕过了最初的六词表。收词因此按"领域概念"而不是"最显而易见的词"：
 * 时间范围→期间、记录/档案→凭证、摸底→域操作（对照表见 BUSINESS_WORD_RE 上方）。
 * 命中即现形，再逐条按四标签归属——伪装形的正确出路是改中性措辞或挂标签，
 * 不是继续换一个词。
 *
 * 第三条预算：字面量 if 预算——禁止新增"针对具体输入值的字面量比较分支"
 * （出事点 if-else / 症状嗅探，2026-09 用户点名：不希望再看到针对具体模型输入的
 * 一堆 if-else）。哲学与业务词预算相同：扫出当前命中集 → 冻结为基线 → 只减不增
 * （新增即红，收敛直接通过）。模式定义、三轮收窄过程与白名单理由见文件底部
 * LITERAL_IF_* 常量块。
 *
 * 第四条预算（D-017）：FSHINE_* 命名空间登记锁——执行层治理接口已收敛到
 * EXECUTION_*，剩下宿主自用的 FSHINE_* 名字必须显式登记（挂标签 + 理由），未登记的新名字
 * 即红。命名空间从此只有两种状态：禁绝或已登记，没有"没决定"。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['packages', 'apps', 'scripts'];
/** 负面夹具行标签：scripts/ 的验收夹具故意含平台细节（测探测器），挂此签的行不扫描。 */
const FIXTURE_TAG = 'leak-lint: fixture';
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
  { label: '旧消费者命名（E4 后应全量 EXECUTION_*）', pattern: /FSHINE_(MODE|INVOCATION|COMMIT_TOKEN|GATE_SECRET|EXECUTOR|MOCK_STATE)/ },
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
        // 夹具行豁免：开发脚本（scripts/）的负面夹具必须原样含平台细节——坏回复样本要含
        // 脚本路径、坏审计条目要含 fill.js，否则探测器失效。与业务词预算的「防御排除」
        // 同族：命中行须显式挂签，未挂标签的命中照旧红（摘掉标签即回到违例）。
        const content = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !line.includes(FIXTURE_TAG))
          .join('\n');
        for (const { label, pattern } of FORBIDDEN) {
          if (pattern.test(content)) violations.push(`${path.relative(REPO_ROOT, file)}: ${label}`);
        }
      }
    }
    expect(violations, [
      ...violations,
      '开发脚本的负面夹具命中 → 在该行挂 `// leak-lint: fixture` 标签（故意含平台细节才测到探测器）；',
      '生产代码（packages/agent/src、apps）命中 → 真违例，改平台数据下发或删除，不打标签。',
    ].join('\n')).toEqual([]);
  });

  it('编排层业务词归属预算：非防御命中=0 且防御项 100% 挂「防御排除」', () => {
    // D-004：扫描范围与字面量 if 预算对齐（packages/agent/src + apps）——生产装配与落账
    // 执行器（apps/server）也属编排层，曾整目录在守卫之外；scripts 的排除是显式常量
    // （见 BUSINESS_WORD_EXCLUDED_DIRS），不是"忘了传这个目录"。
    const hits = BUSINESS_WORD_SCAN_DIRS.flatMap((dir) => businessWordHits(path.join(REPO_ROOT, dir)));
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

  it('D-017 FSHINE_* 命名空间登记锁：禁绝集之外的名字必须显式登记（未登记即红）', () => {
    const found = new Set<string>();
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir))) {
        for (const match of readFileSync(file, 'utf8').matchAll(/\bFSHINE_[A-Z0-9_]+/g)) found.add(match[0]!);
      }
    }
    const unregistered = [...found].filter((name) => !FSHINE_NAME_REGISTRY.has(name)).sort();
    expect(unregistered, [
      '出现了未登记的 FSHINE_* 名字（只允许两种状态：禁绝或已登记）：',
      ...unregistered,
      '新名字 → 按归属定前缀：执行层接口用 EXECUTION_*，宿主自用用 FSHINE_* 并在 FSHINE_NAME_REGISTRY 登记并挂四标签之一 + 理由。',
    ].join('\n')).toEqual([]);
    // 登记项必须挂标签（与业务词预算同纪律：没有标签的命中既不许默默保留也不许当违例删）
    for (const [name, entry] of FSHINE_NAME_REGISTRY) {
      expect(entry.tag, name).toMatch(/警职执法|防御排除|平台下发|遗留待清/);
      expect(entry.reason.length, name).toBeGreaterThan(0);
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

/**
 * 编排层业务词（中文领域词）：出现即说明 fshine 可能在替平台说话。
 *
 * 收词纪律（D-005）：按**领域概念**收，不按"最显而易见的词"收——泄漏的真实形状是
 * 同义改写。显式对照表（伪伪装形 → 真实领域概念）：
 *   时间范围 → 期间      （进度帧/提示词用它绕开"期间"）
 *   记录 / 档案 → 凭证   （"拉取记录""检索档案"实为查凭证）
 *   摸底     → 域操作    （"正在做摸底"实为平台域检索）
 * 余额 / 往来 是财务口径本身（应收账款的附属概念），同样只住执行层。
 * 词表只增不减：新增词会让一批存量命中现形，逐条按四标签归属（见下方允许集），
 * 真违例改中性措辞、防御项挂标签——不许为了让灯绿把词从表里删掉。
 */
const BUSINESS_WORD_RE = /应收|凭证|科目|账套|期间|目录|税号|财务|借贷|余额|往来|时间范围|记录|档案|摸底/g;

/**
 * 业务词预算的扫描目录（D-004）：与第三条预算（字面量 if）对齐——编排层生产代码 =
 * packages/agent/src + apps/server。scripts/ 的排除必须显式：D-005 附条判其 144 处命中
 * 为"接受不修"（验收夹具与探针替身，领域词是测试数据不是宿主替平台说话），纳入
 * "只减不增"预算会冻结 144 行。**排除是决策不是遗漏**——若 scripts/ 下新增非夹具用途
 * 文件（把验收逻辑提升为生产代码），该文件须并入扫描范围（台账 D-005 附条复核条件）。
 */
const BUSINESS_WORD_SCAN_DIRS = ['packages/agent/src', 'apps'];
const BUSINESS_WORD_EXCLUDED_DIRS = ['scripts'];

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
  ['packages/agent/src/memory-candidate-extractor.ts: 余额', { tag: '防御排除', reason: 'BALANCE_RE 的"科目余额…"模式（D-005 扩词后现形）：财务事实识别正则的一部分，删=记忆提取器对余额类事实变聋' }],
  ['packages/agent/src/runtime.ts: 财务', { tag: '防御排除', reason: 'needs/计划收尾注释解释零执行出口如何阻断财务数字、避免把带金额的 worker 文本当结果；出口判据在 runtime-quality.ts 的 hasFinancialFigure，删=该数字出口防御的维护理由失去着落' }],
  ['packages/agent/src/runtime-quality.ts: 余额', { tag: '防御排除', reason: 'hasFinancialFigure 正则的"余额"分支（随 runtime-quality.ts 文本防御模块搬迁）：检测"回复是否带财务数字"的出口校验尺，删=编造结论识别变聋' }],
  // 方案 2 分批 1：renderPlanStepOutcomeLines 的"不含财务数字"注释随函数搬进 plan-facts.ts；
  // 同一条防御理由（出口校验的零执行数字拦截不误伤步骤事实汇总）换文件不换归属。
  ['packages/agent/src/plan-facts.ts: 财务', { tag: '防御排除', reason: 'renderPlanStepOutcomeLines 注释"不猜业务语义，因此不含财务数字"（随函数自 runtime.ts 逐字搬入）：说明步骤事实汇总为何不被出口校验的零执行数字拦截误伤，删=该防御理由失去着落' }],
  // 方案 2 分批 1：renderWriteClosureReply 的"不含财务数字"注释随函数搬进 turn-relay.ts；
  // 判据本体（hasFinancialFigure）已抽到 runtime-quality.ts。（同批搬来的 usefulWorkerNote /
  // composeClarificationReply 后因消循环 import 搬回 runtime.ts，见其上的 runtime.ts 条目。）
  ['packages/agent/src/turn-relay.ts: 财务', { tag: '防御排除', reason: 'renderWriteClosureReply 注释"不含财务数字"（随函数自 runtime.ts 逐字搬入）：说明写关闭终稿为何要剥掉带数字的文本，删=该防御理由失去着落' }],
  // 方案 2 分批 3a：出口校验两块（turn-exit.ts）与每回合上下文档装配（turn-context.ts）
  // 自 runtime.ts 逐字搬入，随函数/常量搬过来的注释与注令文案各带一处"财务"命中。
  // 归属与 runtime.ts 上的原条目同族（数字结论判据 + 防串注令），换文件不换理由。
  ['packages/agent/src/turn-exit.ts: 财务', { tag: '防御排除', reason: 'activatedPlan 收尾分支注释"只在不带财务数字…才算有价值"（随函数自 runtime.ts 逐字搬入）：worker 说明附注的准入判据，删=附在状态文案后的可能是编造结论' }],
  ['packages/agent/src/turn-context.ts: 财务', { tag: '防御排除', reason: 'RECENT_TURN_HISTORY_NOTE 注令及其注释"其中的财务结论不得作为本轮实时结果引用"（随常量自 runtime.ts 逐字搬入）+ renderContextState 的"实时财务数据"措辞：防串轮防御（旧财务结论不当本轮实时结果）的着落，删=防冒充实时的注令失去登记' }],
  ['packages/agent/src/turn-state.ts: 凭证', { tag: '防御排除', reason: '后台受理状态注释明示“不是平台执行凭证”：防止 queued/running 回执被提升为实际执行证明，删=受理与执行边界的防御说明失去着落' }],
  // ── 警职执法：守卫/校验器识别业务模式，其存在就是为了识别 ──
  ['packages/agent/src/context-extractor.ts: 期间', { tag: '警职执法', reason: 'hasContradiction 范围意图识别（更多期间/当前期间配对）：识别业务词以判定用户范围意图，是识别器不是泄漏' }],
  ['packages/agent/src/serve-gate.ts: 目录', { tag: '警职执法', reason: 'G1 门知识面/根目录的路径安全判定：门守卫自身引用它约束的知识面' }],
  // SERVE_WRITE_NO_PLATFORM_ROOT 的拒绝理由随 serve 门拒绝理由收口（error-codes.ts 唯一来源）
  // 从 serve-gate.ts 迁到本表：同一条措辞、同一个"平台工作目录 = worker cwd，write 落点裁决的
  // 前提"语义，只是不再有第二份手抄本。文件系统义的目录，不是领域检索动作。
  ['packages/agent/src/error-codes.ts: 目录', { tag: '警职执法', reason: 'SERVE_WRITE_NO_PLATFORM_ROOT「未配置平台工作目录」（随 serve 门拒绝理由收口自 serve-gate.ts 迁入）：平台工作目录是 write/edit 落点裁决的前提，门守卫自身引用它' }],
  ['packages/agent/src/turn-contract.ts: 目录', { tag: '警职执法', reason: 'validatePlanEntities 实体来源校验：平台响应（含账套检索结果）是受认实体来源，校验器说明其为何天然放行' }],
  ['packages/agent/src/pi-coding-driver.ts: 目录', { tag: '警职执法', reason: '计划实体来源收集：账套检索结果作为执行痕迹/候选名来源的识别' }],
  ['packages/agent/src/freeze-task-inputs.ts: 目录', { tag: '警职执法', reason: '后台输入冻结代码校验任务输入目录并复制/校验文件摘要；这里是文件系统路径边界，不是领域目录检索' }],
  ['packages/agent/src/background-runtime.ts: 记录', { tag: '警职执法', reason: '宿主 task_event 结构化记录用于追加会话历史和幂等续步，属于跨业务任务协议状态，不是平台业务记录' }],
  ['apps/server/background-delivery.ts: 记录', { tag: '防御排除', reason: '后台交付回执要持久化每部分 ACK 状态；删掉记录会把未确认或失败的发送误报为已送达' }],
  // ── 遗留待清：已知该走还没走，挂账限期 ──
  // D-004 扩范围后 apps/ 生产代码的首批命中（commit.ts 的账套校验/读回注释与凭证读回错误
  // 串）已随 C 波关闭：那个 legacy 落账执行器整文件删除，业务词不再进编排层。其两条登记
  // （`apps/server/commit.ts: 账套` / `: 凭证`）与 `context.ts: 借贷`（旧文本路径的宿主
  // 摘要渲染）一并撤销——预算只减不增，撤销不等于放行回流：再出现同类命中照旧红。
  // D-005 扩词后 execution-facts.ts 现形的两词：文件头数据源取舍注释正在描述 D-065 欠账
  // 本身（platform_tasks 无账套/期间/calls），同波任务组5 补结构化字段时此段重写。
  ['packages/agent/src/execution-facts.ts: 时间范围', { tag: '遗留待清', reason: '文件头"没有对象、没有时间范围、没有调用次数"描述 D-065 欠账现状：Wave 2 Lane D 任务组5（D-065）补 accountSet/period/calls 结构化字段后此段重写，届时本条关闭' }],
  ['packages/agent/src/execution-facts.ts: 记录', { tag: '遗留待清', reason: '文件头/渲染注释里的"执行记录/记录原文"（Conversation Log 条目的通称）：随 D-065 结构化渲染改造（同波任务组5）一并清理，届时本条关闭' }],
  ['packages/agent/src/context.ts: 目录', { tag: '遗留待清', reason: 'worker 系统提示词与文件注释里的"工作目录"（文件系统义，非领域检索动作）：2026-10-08 重构已清掉提示词中的账套检索/域目录前缀描述，只剩 cwd 告知；理想形态（Wave 2 D）是把 cwd 也收敛为平台 SKILL 指针，届时本条关闭' }],
  ['packages/agent/src/context.ts: 期间', { tag: '遗留待清', reason: '并发注释"会话期间"的时间描述（非业务期间口径）：待改写成中性"过程/时间"' }],
  ['packages/agent/src/history-tools.ts: 财务', { tag: '遗留待清', reason: '通用历史工具描述误用"财务"限定（search_history/get_messages 领域无关）：待改成"实时数据/历史结果"中性措辞' }],
  ['packages/agent/src/platform-mock.ts: 目录', { tag: '遗留待清', reason: 'mock 状态路径注释"该目录已 gitignore"（文件系统目录）：待改成"路径"' }],
]);

/** 防御排除类命中（L1：必须 100% 挂「防御排除」，删条目/改标签即红，见上方第二条断言）。 */
const DEFENSIVE_EXCLUSION_KEYS: readonly string[] = [
  'packages/agent/src/memory-candidate-extractor.ts: 应收',
  'packages/agent/src/memory-candidate-extractor.ts: 科目',
  'packages/agent/src/memory-candidate-extractor.ts: 账套',
  'packages/agent/src/memory-candidate-extractor.ts: 余额',
  'packages/agent/src/runtime.ts: 财务',
  'packages/agent/src/runtime-quality.ts: 余额',
  'packages/agent/src/turn-state.ts: 凭证',
  'apps/server/background-delivery.ts: 记录',
  'packages/agent/src/plan-facts.ts: 财务',
  'packages/agent/src/turn-relay.ts: 财务',
  'packages/agent/src/turn-exit.ts: 财务',
  'packages/agent/src/turn-context.ts: 财务',
];

/**
 * FSHINE_* 名字登记表（D-017：执行层治理接口已收敛到 EXECUTION_*，剩余宿主运行参数显式登记）。
 *
 * 为什么不是统统禁绝：这些不是执行层治理接口，而是宿主自己的安全
 * 开关/运行参数——按新命名规则，宿主自用参数保留 FSHINE_* 前缀，不跟进 EXECUTION_*；
 * 其中 FSHINE_REAL_COMMIT 是真写放行总闸（比治理接口更危险），须显式登记。
 * 每条挂且仅挂一类标签；宿主自用参数一律保留 FSHINE_*，不改 EXECUTION_*。
 */
const FSHINE_NAME_REGISTRY: ReadonlyMap<string, { tag: LeakTag; reason: string }> = new Map([
  ['FSHINE_REAL_COMMIT', { tag: '警职执法', reason: '真平台落账放行总闸（安全开关，platform-mock.ts 读它决定写放行）：宿主自用，不改 EXECUTION_*；17dz 侧 LEAKY_EXACT 仅作泄漏剥离（EXECUTION_REAL_COMMIT），不读取；此前面向生产的"显式声明"语义不变' }],
  ['FSHINE_PI_AGENT_DIR', { tag: '警职执法', reason: 'Pi SDK 会话目录环境变量（pi-coding-driver.ts）：宿主运行参数，无跨仓契约方；按新命名规则保留 FSHINE_*，不改 EXECUTION_*' }],
  ['FSHINE_PLATFORM_CONCURRENCY', { tag: '警职执法', reason: '委派并发闸（context.ts，默认 1）：宿主运行参数，无跨仓契约方；.env.example 已文档化；按新命名规则保留 FSHINE_*，不改 EXECUTION_*' }],
  ['FSHINE_INBOUND_DEBOUNCE_MS', { tag: '警职执法', reason: '入站防抖窗口（apps/server/handler.ts，默认 2000ms）：企微模型里文件与文字是独立消息，文字回合启动前等一拍，让同一burst里晚到的附件先落盘。宿主运行参数，无跨仓契约方；.env.example 已文档化；按新命名规则保留 FSHINE_*，不改 EXECUTION_*' }],
  ['FSHINE_PLATFORM_COOLDOWN_MS', { tag: '警职执法', reason: '平台健康冷却时长（assembly.ts → runtime.ts，默认 10 分钟，Lane 2 治标补法）：宿主运行参数，无跨仓契约方；.env.example 已文档化；按新命名规则保留 FSHINE_*，不改 EXECUTION_*' }],
  ['FSHINE_ATTACHMENT_DIR', { tag: '警职执法', reason: '企微附件落盘目录（channel-wecom/adapter.ts，缺省 <cwd>/data/attachments）：宿主运行参数，无跨仓契约方——17dz 只通过 operation 的位置参数拿到路径，不关心文件落在哪。它不该改 EXECUTION_*（那是执行层命名空间，会把"宿主把用户文件存哪"误记成执行层协议）；.env.example 已文档化；按新命名规则保留 FSHINE_*' }],
  ['FSHINE_WORKER_DISPATCH_MODE', { tag: '警职执法', reason: 'fshine 部署选择新委派 inline/background 的宿主交互模式开关（默认 inline）：这是通用 runtime 调度策略，不是 17dz 执行层协议，保留 fshine 命名空间，不改 EXECUTION_*' }],
  ['FSHINE_PLATFORM_QUEUE_CAPACITY', { tag: '警职执法', reason: '共享 PlatformExecutionGate 的宿主排队容量上限：这是通用平台资源保护参数，不是 17dz 业务规则或执行层协议，保留 fshine 命名空间，不改 EXECUTION_*' }],
  ['FSHINE_WORKER_STEP_CAP', { tag: '警职执法', reason: '自由 worker 每回合放行调用步数上限（Phase 2，pi-coding-driver.ts，缺省 50）：这是通用 worker 生命周期调度参数，不是执行层协议也不是业务规则，保留 fshine 命名空间，不改 EXECUTION_*' }],
  ['FSHINE_SHUTDOWN_DRAIN_MS', { tag: '警职执法', reason: '宿主停机排干上限（apps/server：main.ts 经 shutdownDrainMsOf 读入并传给 backgroundTasks.shutdown({drainMs})，缺省/非法回退 30000ms）：宿主停机参数，非执行层协议——排干的是 fshine 自己的后台任务与终态事件投递，与 17dz 无关，保留 fshine 命名空间，不改 EXECUTION_*' }],
  // 方案 1 · B 波曾登记的两个写流程开关（一个管提案创建走不走网关、一个管落账后端接不接）
  // 已随 C 波后只剩一种行为而退役，登记项一并删除——本表只减不增；那两个名字若在
  // packages/apps/scripts 里复活（含注释），下面"未登记即红"会当场抓住。
]);

// 防御排除登记（属防御性业务逻辑，但当前正则/名单不含九词中文、故不命中，仍登记防误删）：
//   · runtime-quality.ts hasFinancialFigure：正则用 余额/金额/发生额（不在九词表）检测"财务数字"。
//   · serve-gate.ts 的参数摘要：Wave 2 Lane D 已把 KEY_ARG_FLAGS 硬编码名单删掉，改为从
//     平台 `operation list --json` 的 args 规格消费（flag→style 是平台数据，见
//     operation-labels.ts）——镜像表不复存在，这里留档防"再立第二份名单"复发。

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
 * `=== 'bash'` / `=== 'operation'` / `=== 'run'`（CLI 子命令与工具名）、execution-env 类
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
  // Background TaskRunState enum values from @fshine/contracts; status protocol constants, not model intent sniffing.
  'queued', 'running', 'cancelling', 'waiting_input', 'waiting_confirmation', 'interrupted',
  // 宿主内部工具名（step-text.ts 静默帧名单）
  'search_history', 'get_messages', 'route_current_turn',
  // 协议失败分类（FailureClass / DelegationFailureClass，contracts + failure-delivery 判定用）
  'NEEDS_INPUT', 'CAPABILITY_UNAVAILABLE', 'PLATFORM_ERROR', 'RESOURCE_EXHAUSTED', 'HARD_REJECTED',
  'cancelled', 'model_transient', 'executor_error',
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
  // run_task 委派（实例名经 profile.toolName 声明，C3），任何新的具名 case 不在表内，照样红。
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
