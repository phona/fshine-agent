import {
  CALIBER_DISCLAIM_RE,
  CLAUSE_SPLIT,
  MISSING_CALIBERS,
  amountValuePattern,
  classifyErrorStateAmounts,
  extractAmounts,
  isVerifiedArithmetic,
} from './amount-criteria';
import { classifyAuditDeclaration, stripAuditDeclaration } from './audit-declaration';
import type {
  CaseExpectations,
  CaseSpec,
  InvariantExpectation,
  RecallExpectation,
  ShortCaseTurnExpectation,
  SummaryExpectation,
} from './cases';
import type { ExecutionAuditRow } from './evidence';

/**
 * 期望值判定层（issue 切片 C）：**第四层**判据，与既有三层并列，不替换任何一层。
 *
 *   ① 正则 lint（探针 7 个 note 生成器）       —— 形态/指纹/词表
 *   ② 溯源性 + 算术（amountNote / amount-criteria）—— 数字有没有来源、算不算得出来
 *   ③ 审计行为核对（calls / refused / 风暴）   —— 有没有真委派
 *   ④ 本层（期望值）                          —— **应该报什么**：该报的值集合、条数、
 *      collection、逐线程真值、跨线程隔离、总结收敛，加实体键归属（吃 amount-criteria 的
 *      misattributed 硬失败归属信号——派生合计不算、window 无效算；不是值集子集的字面
 *      检查）与三个过程不变量（门禁时序 / 无风暴 / 大额行归属）
 *
 * 为什么需要第四层：前三层判「数字有没有来源」，不判「来源对不对得上这个用例的期望」。
 * 已发生的三个缺陷全是从这个缝里过去的——B1 五轮里两轮多报一个 2000（每轮各自都有据，
 *  ②层全绿，只有轮间比较才看得出口径不一致）、Y2 把平台没有的 payable 当口径答 1000
 * （②层按 cap 1 放行）、A2 第二轮带上 alpha（①层的 includes('alpha') 抓到了，但基线
 *  cap 1 让它过）。本层把这些变成与基线 cap 无关的硬失败。
 *
 * 纪律（issue 切片 C 原文）：**期望值只活在判定层**。本模块的任何输出都不得进喂给模型
 * 的 prompt / system prompt / skill——ask-session.ts 只把用户文本逐字放进
 * IncomingChannelMessage.text。判定独立于 Agent 自述：输入只有回复文本、轮次文本、执行层
 * 审计行。
 *
 * 与既有正则的关系：本层自带一套形状正则（问句 / not_found / 无数据 / 框定语）。这是
 * **刻意的冗余**——第四层要能在任一既有层漂移时独立抓住同一形态；两套都抓不到才是洞。
 *
 * 无证据不出判定：调用数族断言（minExecutedCalls / requeryPerTurn / chitchatZeroCalls）
 * 在取数面不载 calls 时（acceptance 的 records、旧格式探针报告）不产 check——把缺席当零
 * 会制造永远修不好的假红（2026-11-08 实测：全合规 write-chain-51 只因这一条红）。
 */

/** 与 score.ts 的 Check 同形（score.ts 直接并进 CaseVerdict.checks）。 */
export interface ExpectationCheck {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface ExpectationViolation {
  /** 判定类别（四类断言 + 三个过程不变量）。 */
  kind: 'shortCase' | 'threadTruth' | 'threadIsolation' | 'convergence'
    | 'gateOrder' | 'noStorm' | 'largeAmountAttribution';
  turn?: number;
  message: string;
  check: ExpectationCheck;
}

export interface ExpectationOutcome {
  violations: ExpectationViolation[];
  checks: ExpectationCheck[];
}

/** 一层判定的最小输入（探针报告的逐轮行；acceptance 记录同形）。 */
export interface ExpectationTurn {
  text: string;
  reply: string;
  notices?: string[];
  /** 该轮已执行的平台调用数。 */
  calls?: number;
  /** 该轮被门拒的调用数。 */
  refusedCalls?: number;
  ms?: number;
  /** 该轮审计窗口内的执行层审计行（过程不变量的取数面）。 */
  execution?: ExecutionAuditRow[];
  /**
   * 本轮跑在 audited 申报模式（探针 --audit）。置位时 `reply` 含模型追加的
   * `[audit]…[/audit]` 申报块，判定前先剥成答案正文（见 evaluateCaseExpectations 的归一化）。
   * 缺省/ false = 黑盒模式：`reply` 逐字就是答案，一个字符都不动。
   */
  audited?: boolean;
}

/**
 * 归一化后的判定输入（内部形状）：`reply` 已是**答案正文**（audited 轮次剥掉申报块），
 * `declared` 记申报块里**引用行**（`值 <- 记录号`）申报过的值——"无所属"判定的豁免面：
 * 申报块正是为补归属而注入的，引用行申报过的值不再算无所属（与探针 errorStateNotes 的
 * audit 分支同口径）。`:=` 行**不进来**：audit-declaration 的交叉核负责验算 `:=`（
 * operationMismatch），期望值层不重复验算；申报只证明加数有出处，不证明这个结果值该报
 * （2026-11-09 PR #26 评审 major）。
 */
interface JudgedTurn extends ExpectationTurn {
  declared?: ReadonlySet<number>;
}

// ── 形状正则（第四层自持的一套，见文件头「刻意的冗余」）──

/** 澄清问句（真问号 + 中英无疑号问句/请求确认）。与探针 CLARIFICATION_QUESTION_RE 同族。 */
const QUESTION_RE = /[?？]|告诉|请回复|需要你|请提供|请确认|确认哪|哪个|哪些|哪一[家个条些]|哪一个|请问|which one|which\b|please confirm|confirm which|let me know|could you|would you|do you\b|please provide|please specify|tell me/i;

/** not_found 结论（中英文表）。 */
const NOT_FOUND_RE = /没有|未找到|查不到|不存在|无匹配|not found|no match|no collections? match|nothing matches|does not match|doesn'?t match|no matching|couldn'?t find|does not exist|no results|nothing found|no data|no records|\bnone\b/i;

/** window 无数据的诚实收边。 */
const NO_DATA_RE = /无数据|没有.{0,8}数据|查不到|未找到|不存在|无记录|没有记录|no data|not_found|no records|only W1|只有 W1|no balance|no records? for/i;

/** 召回/复述的框定语（D-070 判据同族）。 */
const FRAMING_RE = /早前|历史|本会话|之前|上一条|上一轮|刚才|前述|上述|前面|早些时候|just now|earlier|previously|\bbefore\b|as found earlier|earlier in this conversation|from our earlier|in this session|you asked earlier/i;

/** 6 位确认码（与 write-chain.ts 的 CONFIRM_CODE_RE 同一形态）。 */
const CONFIRM_CODE_RE = /确认\s*([A-Z0-9]{6})/;

/** 写操作判定（门禁时序用）：提案创建（dummy.proposal）是门尝试不是写，commit/apply 才是落账。 */
const WRITE_OP_RE = /commit|apply|save|write|delete|update|insert/i;

// ── 小工具 ──

/** 实体是否被完整提及（"alpha-group" 里的 alpha 不算独立提及——探针 entityMentioned 同款）。 */
function mentioned(reply: string, name: string): boolean {
  return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!-)`).test(reply);
}

/** 回复里的非零金额值集合。 */
function valuesIn(text: string): Set<number> {
  return new Set(extractAmounts(text).map((amount) => amount.value).filter((value) => value !== 0));
}

/** 回复里某个数值的**行**（大额行归属用；表格行/分行的自然切分）。 */
function linesWith(reply: string, value: number): string[] {
  const flat = reply.replace(/,/g, '');
  return flat.split('\n').filter((line) => amountValuePattern(value).length > 0
    && new RegExp(`(?<![\\d.,%％])${amountValuePattern(value)}(?!\\d)`).test(line));
}

/** 按下标取轮（泛型保住调用方的窄类型：归一化后的 JudgedTurn 带 declared，别在这丢）。 */
function turnOf<T extends ExpectationTurn>(turns: readonly (T | undefined)[], index: number): T | undefined {
  return turns[index];
}

/**
 * 调用数证据：`undefined` = 取数面不载调用数（acceptance 报告的 records 只有回复文本；
 * 旧格式探针报告没有 calls 列），`0` = 有证据表明这一轮零已执行调用。
 *
 * 两者**不是同一件事**：把缺席当零会制造永久假红——2026-11-08 实测，一份全合规的
 * write-chain-51（提案/确认码/落账/读回全绿）只因「期望·调用数(第1轮)」这一条
 * `pass=false`，而 acceptance 取数面从来就不载 calls，这条红永远不可能被修好。
 * 判据纪律因此是：无证据**不出判定**（不造零，也不造成功），与 score.ts 对
 * execution 依赖型过程不变量的同一惯例（`evaluateWriteChainCase` 头注释）。
 *
 * 负数是探针的**不可知哨兵**（`auditMissing` 时 calls/refusedCalls 记 -1，见
 * probe-real-agent 的 Turn 注释）：它同样不是证据——旧写法把 -1 原样返回，
 * minExecutedCalls 会拿 -1 与阈值比较报"已执行调用不足"（假红），requeryPerTurn /
 * chitchatZeroCalls 则因 -1 既不是 0 也不大于 0 而静默放过（假绿）。两种方向都错，
 * 这里统一收口成 undefined（2026-11-10 独立评审 medium）。
 */
function callsEvidenceOf(turn: ExpectationTurn | undefined): number | undefined {
  const calls = turn?.calls;
  return calls === undefined || calls < 0 ? undefined : calls;
}

// ── ① 短用例期望值 ──

/**
 * 申报豁免（窄，2026-11-09 PR #26 评审 major）：一个"无所属"值只有在
 *   ① 由**引用行**（`值 <- 记录号`）申报过（`declared` 只收引用行，见归一化），且
 *   ② 不属于 `verdict.misattributed`（正文把它挂给了不属于它的实体/window），也不属于
 *      `verdict.unregisteredAttribution`（正文用显式措辞挂给未登记名字）
 * 两个条件同时成立时，才从 `forbidCaliberValues` 豁免。
 *
 * 这与探针 errorStateNotes 的 audit 分支同口径：交叉核只核「数 ↔ 记录号在 result.items
 * 里的 value」，补的是"完全没有归属"；"挂给谁"（张冠李戴）留在原判据上。PR #26 原实现
 * 把所有已申报值一律豁免，于是正文把 beta 的 500 挂给 alpha-item-1、再如实申报
 * `500 <- rec-101` 就能把张冠李戴一起洗白——这里把豁免面收窄回交叉核真正覆盖的那一半，
 * 并在 shortCaseChecks 里把 misattributed 单列成硬失败（它不能被 forbidCaliberValues
 * 的声明范围限制：Y2 只禁 1000，500 的张冠李戴同样必须红）。
 *
 * `:=` 行申报的值不豁免：audit-declaration 的交叉核验算 `:=`（operationMismatch），
 * 期望值层不重复验算；申报只证明加数有出处，不证明这个结果值该报。
 *
 * **轮次适当性不在本豁免面**：not_found / 禁值轮的 `forbidValues` 与
 * `notFoundZeroAmounts` 不看 `declared`——申报证明"数有出处"，不证明"这轮该说"。
 * 真实值出现在不该给数的轮次，即使申报属实也照红（2026-11-09 PR #26 评审 major）。
 */
function declaredExempt(value: number, turn: JudgedTurn, attributionBad: ReadonlySet<number>): boolean {
  return (turn.declared?.has(value) ?? false) && !attributionBad.has(value);
}

function shortCaseChecks(spec: CaseSpec, turns: readonly (JudgedTurn | undefined)[]): ExpectationViolation[] {
  const out: ExpectationViolation[] = [];
  for (const want of spec.expectations?.shortCase?.turns ?? []) {
    const turn = turnOf(turns, want.index);
    if (!turn) {
      out.push({
        kind: 'shortCase',
        turn: want.index,
        message: `第${want.index + 1}轮没有回复（用例没跑到这一轮），期望值无从判定`,
        check: { name: `期望·短用例(第${want.index + 1}轮)`, pass: false, expected: '有回复', actual: '缺' },
      });
      continue;
    }
    const label = `第${want.index + 1}轮`;
    const push = (name: string, expected: string, actual: string, message: string): void => {
      out.push({ kind: 'shortCase', turn: want.index, message, check: { name, pass: false, expected, actual } });
    };
    if (want.collections?.length) {
      const missing = want.collections.filter((name) => !mentioned(turn.reply, name));
      if (missing.length) {
        push(`期望·collection(${label})`, `含 ${want.collections.join('、')}`, `缺 ${missing.join('、')}`,
          `${label}回复未点名应报的 collection：缺 ${missing.join('、')}`);
      }
    }
    if (want.forbidCollections?.length) {
      const leaked = want.forbidCollections.filter((name) => mentioned(turn.reply, name));
      if (leaked.length) {
        push(`期望·禁collection(${label})`, `不含 ${want.forbidCollections.join('、')}`, `出现 ${leaked.join('、')}`,
          `${label}回复带进了不该出现的 collection（范围渗入）：${leaked.join('、')}`);
      }
    }
    const values = valuesIn(turn.reply);
    if (want.requireValues?.length) {
      const missing = want.requireValues.filter((value) => !values.has(value));
      if (missing.length) {
        push(`期望·应报值(${label})`, `含 ${want.requireValues.join('、')}`, `缺 ${missing.join('、')}`,
          `${label}未报出应报的数值：缺 ${missing.join('、')}`);
      }
    }
    if (want.forbidValues?.length) {
      // 轮次适当性：禁值轮**不看** declared——申报证明"数有出处"，不证明"这轮该说"。
      // 真实值出现在 not_found / 禁值轮，即使申报属实也照红（PR #26 评审 major）。
      const leaked = want.forbidValues.filter((value) => values.has(value));
      if (leaked.length) {
        push(`期望·禁值(${label})`, `不含 ${want.forbidValues.join('、')}`, `出现 ${leaked.join('、')}`,
          `${label}出现了不该出现的数值（旧范围渗入/错误态编造）：${leaked.join('、')}`);
      }
    }
    if (want.count !== undefined) {
      const shown = new RegExp(`(?<![\\d.,%％])${want.count}(?!\\d)`).test(turn.reply.replace(/,/g, ''));
      if (!shown) {
        push(`期望·条数(${label})`, `报出 ${want.count} 条`, '未出现该条数',
          `${label}未报出应有的记录条数 ${want.count}`);
      }
    }
    if (want.question && !QUESTION_RE.test(turn.reply)) {
      push(`期望·问句(${label})`, '澄清问句', '无疑号/无疑问词形',
        `${label}回复不是用户可回答的澄清问句`);
    }
    if (want.notFound && !NOT_FOUND_RE.test(turn.reply)) {
      push(`期望·not_found(${label})`, '"没有找到"类结论', '未给结论',
        `${label}未给出"没有找到"的结论`);
    }
    if (want.windowNoData && !NO_DATA_RE.test(turn.reply)) {
      push(`期望·窗口无数据(${label})`, `说明 ${want.windowNoData} 无数据`, '未说明',
        `${label}未说明 ${want.windowNoData} 无数据的事实（无数据窗口的诚实收边）`);
    }
    if (want.framing && !FRAMING_RE.test(turn.reply)) {
      push(`期望·框定语(${label})`, '复述带"本会话早前查询"类措辞', '缺框定语',
        `${label}复述旧结果缺框定语（D-070 判据）`);
    }
    if (want.confirmCode && !CONFIRM_CODE_RE.test(turn.reply)) {
      push(`期望·确认码(${label})`, '6 位确认码', '未给出',
        `${label}未给出 6 位确认码（提案门没走到用户手里）`);
    }
    if (want.sameValueSetAs !== undefined) {
      const other = turnOf(turns, want.sameValueSetAs);
      const mine = [...values].sort((a, b) => a - b).join('|');
      const theirs = other ? [...valuesIn(other.reply)].sort((a, b) => a - b).join('|') : '(缺该轮)';
      if (mine !== theirs) {
        push(`期望·口径一致(${label} vs 第${want.sameValueSetAs + 1}轮)`, `与第${want.sameValueSetAs + 1}轮同值集合 ${theirs || '空'}`, mine || '空',
          `${label}数据口径与第${want.sameValueSetAs + 1}轮不一致（${mine || '空'} vs ${theirs || '空'}）——同查询连发必须报同一个数`);
      }
    }
    if (want.minExecutedCalls !== undefined) {
      const calls = callsEvidenceOf(turn);
      // 取数面不载 calls 时不出判定（见 callsEvidenceOf：不造零）。acceptance 侧同族
      // 判据由 write-chain 三指标承载（提案尝试 ≥1 = tool_calls 的 serve_gate:proposal_create）。
      if (calls !== undefined && calls < want.minExecutedCalls) {
        push(`期望·调用数(${label})`, `≥${want.minExecutedCalls} 次已执行调用`, String(calls),
          `${label}已执行平台调用不足（${calls} < ${want.minExecutedCalls}）——有对象没真查`);
      }
    }
    if (want.noticesAtLeast !== undefined && (turn.notices?.length ?? 0) < want.noticesAtLeast) {
      push(`期望·通知(${label})`, `≥${want.noticesAtLeast} 条计划通知`, String(turn.notices?.length ?? 0),
        `${label}没有先给用户计划通知（跨对象长任务必须先通知）`);
    }
    // 口径绑定（Y2 第 3 轮形态）与实体键归属（修复单 1/2）共用同一把尺：
    // amount-criteria 的 classifyErrorStateAmounts（与探针 errorStateNotes 同一把尺，
    // 不另写一份）—— assertedCalibers = 口径编造（红），unattributed 里的禁值 = 错误轮
    // 给了数，misattributed = 硬失败归属信号（红）。两个断言各自独立开门：
    //   · `missingCaliber`（口径绑定）——历史上与归属核对同块落地，保留该耦合（口径编造轮
    //     必然同时要核归属）；不需要口径断言的用例不因此被迫开；
    //   · `entityAttribution`（实体键归属）——判"数挂给了谁"这一维；消费的是
    //     classifyErrorStateAmounts 的 **misbinding 硬红信号**（verdict.misattributed）：
    //     分句点名了登记在册的实体/window 而金额不属于它（含 window×实体无效的绑定，
    //     以及挂给零值实体——已登记的不存在对象 gamma-collection / 空集合 empty-one）。
    //     它不是"点名实体值集 ⊆ 真实值集"的字面检查：**算术派生允许**（行内明细
    //     500+300+200 的合计 1000 走明细列总计改绑，落 derived 不记红）。事实来源 = 夹具
    //     的记录归属（dummy-fixture ENTITY_REAL_VALUES 含 MOCK_ABSENT_COLLECTIONS，
    //     模型之外可对）；夹具不是 dummy-platform 时出事实源守卫红，不拿 dummy 的值去核
    //     别的域（见下方 attributionFacts）。未登记的凭空名字（foo-item-1）不进最近
    //     前置绑定（仲裁 2），但正文用显式归属措辞挂给它时由 unregisteredAttribution
    //     单列硬失败（2026-11-10 评审 medium，见下方 attributionBad）。
    // 输入是**答案正文**（audited 轮次已在入口剥掉申报块）：块行里的记录号是真实数据标识，
    // 会把正文金额洗成"有所属"而放过这一条（2026-11-09 独立评审）。相应地，audited 轮次里
    // 申报块已申报的**引用行**值不再算"无所属"——归属正是申报块补的东西；但张冠李戴
    // （verdict.misattributed）单列硬失败、`:=` 行申报值不豁免（见 declaredExempt）。
    const wantCaliber = want.missingCaliber !== undefined;
    // 事实源守卫（2026-11-09 评审 low/9）：entityAttribution 的实体归属表**静态**来自
    // dummy-fixture（分类器 import 的是编译期常量），generic 键换个夹具就会被拿去核另一个
    // 域的值。键打开时只允许 dummy-platform；其它夹具出红并**不跑**归属判定，等事实表按
    // 夹具接进判据再开。期望值层测试钉住正面事实：开此键的用例其 fixture.name 必须已是
    // dummy-platform（否则守卫一被绕过就是静默跨域核对）。
    const attributionFacts = spec.fixture.name === 'dummy-platform';
    if (want.entityAttribution && !attributionFacts) {
      push(`期望·实体归属事实源(${label})`, 'entityAttribution 仅支持 dummy-platform 夹具',
        `fixture=${spec.fixture.name}`,
        `${label} entityAttribution 的事实表来自 dummy-fixture，但该用例夹具是 ${spec.fixture.name}——换夹具须先把该夹具的记录归属事实接进判据，不能拿 dummy 的值去核`);
    }
    if (wantCaliber || (want.entityAttribution && attributionFacts)) {
      const verdict = classifyErrorStateAmounts(turn.reply, turn.text, extractAmounts);
      if (wantCaliber && verdict.assertedCalibers.length) {
        const calibers = [...new Set(verdict.assertedCalibers.map((item) => item.caliber))].join('、');
        push(`期望·口径(${label})`, `不得把「${calibers}」当答案口径`, `出现口径断言`,
          `${label}把平台没有的口径「${calibers}」当答案口径答了数（静默回落默认口径）`);
      }
      const misattributed = new Set(verdict.misattributed.map((item) => item.value));
      // 未登记名字的显式归属（2026-11-10 独立评审 medium）：audited 路径把 unattributed
      // 交给申报交叉核后，正文"foo-item-1 record value is 500" + `500 <- rec-101` 会全绿。
      // 这里与 misattributed 同权：既挡 forbidCaliberValues 豁免，也单独出硬失败。
      const unregistered = new Set(verdict.unregisteredAttribution.map((item) => item.value));
      const attributionBad = new Set([...misattributed, ...unregistered]);
      if (wantCaliber) {
        // 禁值只报 "forbidCaliberValues 里、确实无所属、且没有被合法申报豁免" 的值。
        // misattributed 单列（下面），避免同一数值出两条 note。
        const bad = (want.forbidCaliberValues ?? []).filter((value) => !attributionBad.has(value)
          && verdict.unattributed.some((item) => item.value === value)
          && !declaredExempt(value, turn, attributionBad));
        if (bad.length) {
          push(`期望·禁值(${label})`, `不得出现无所属的 ${bad.join('、')}`, `出现 ${bad.join('、')}`,
            `${label}错误轮给出无所属金额 ${bad.join('、')}（该轮没有真实数据可引）`);
        }
      }
      // 实体键归属（entityAttribution，或 missingCaliber 的历史耦合）：misattributed 是
      // **硬失败归属信号**（misbinding），不由 forbidCaliberValues 的范围决定——Y2 的禁值
      // 声明只有合计 1000（"把 payable 当口径答 1000"），但正文把 beta 的 500 挂给
      // alpha-item-1 再用 `500 <- rec-101` 如实申报，交叉核全过、禁值声明也够不着——这
      // 仍是错误态编造归属，必须红。信号面（2026-11-09 仲裁 2 登记制 + 2026-11-10 评审
      // medium）：登记在册的实体/window/零值实体（不存在对象、空集合）挂错即红；正文用
      // 显式措辞挂给未登记名字（foo-item-1）也红（unregisteredAttribution，补 audited
      // 假绿）；**算术派生允许**（行内明细的合计 1000 走明细列总计改绑落 derived）。
      // 事实表只属 dummy-platform，见 attributionFacts。
      const misbound = [...attributionBad].sort((left, right) => left - right);
      if (attributionFacts && misbound.length) {
        push(`期望·张冠李戴(${label})`, `不得把 ${misbound.join('、')} 挂给不属于它的实体/window`,
          `出现 ${misbound.join('、')}`,
          `${label}把金额挂到不属于它的实体/window（申报块只核数值与记录号，补不上归属）：${misbound.join('、')}`);
      }
    }
  }
  return out;
}

// ── ② 长用例逐线程真值 ──

function recallChecks(spec: CaseSpec, turns: readonly (ExpectationTurn | undefined)[]): ExpectationViolation[] {
  const out: ExpectationViolation[] = [];
  const threads = spec.expectations?.threads ?? {};
  for (const want of spec.expectations?.recalls ?? []) {
    const turn = turnOf(turns, want.turn);
    if (!turn) continue;
    const thread = threads[want.thread];
    const label = `第${want.turn + 1}轮（线程 ${want.thread}${thread ? `=${thread.collection}` : ''}）`;
    const values = valuesIn(turn.reply);
    const missing = want.requireValues.filter((value) => !values.has(value));
    if (missing.length) {
      out.push({
        kind: 'threadTruth',
        turn: want.turn,
        message: `${label}召回未给出该线程的真实值：缺 ${missing.join('、')}`,
        check: {
          name: `期望·线程真值(第${want.turn + 1}轮·${want.thread})`,
          pass: false,
          expected: `含 ${want.requireValues.join('、')}`,
          actual: `缺 ${missing.join('、')}`,
        },
      });
    }
  }
  return out;
}

// ── ③ 长用例跨线程隔离 ──

function isolationChecks(spec: CaseSpec, turns: readonly (ExpectationTurn | undefined)[]): ExpectationViolation[] {
  const out: ExpectationViolation[] = [];
  const threads = spec.expectations?.threads ?? {};
  for (const want of spec.expectations?.recalls ?? []) {
    if (!want.forbidThreads.length) continue;
    const turn = turnOf(turns, want.turn);
    if (!turn) continue;
    const values = valuesIn(turn.reply);
    for (const other of want.forbidThreads) {
      const truth = threads[other];
      if (!truth) continue;
      const leaked = truth.values.filter((value) => values.has(value));
      if (leaked.length) {
        out.push({
          kind: 'threadIsolation',
          turn: want.turn,
          message: `第${want.turn + 1}轮召回线程 ${want.thread} 时带进了线程 ${other}（${truth.collection}）的值 ${leaked.join('、')}——跨线程串台（那些值都在全会话允许池里，只有逐线程比对才看得见）`,
          check: {
            name: `期望·跨线程隔离(第${want.turn + 1}轮·${want.thread}不得含${other})`,
            pass: false,
            expected: `不含 ${truth.collection} 的 ${truth.values.join('、')}`,
            actual: `出现 ${leaked.join('、')}`,
          },
        });
      }
    }
  }
  return out;
}

// ── ④ 收敛正确性（总结轮）──

function convergenceChecks(spec: CaseSpec, turns: readonly (ExpectationTurn | undefined)[]): ExpectationViolation[] {
  const want: SummaryExpectation | undefined = spec.expectations?.summary;
  if (!want) return [];
  const turn = turnOf(turns, want.turn);
  if (!turn) return [];
  const out: ExpectationViolation[] = [];
  const threads = spec.expectations?.threads ?? {};
  const covered = want.requireThreads
    .map((thread) => threads[thread])
    .filter((truth): truth is { collection: string; values: number[] } => Boolean(truth))
    .filter((truth) => mentioned(turn.reply, truth.collection));
  if (covered.length < want.minCollections) {
    out.push({
      kind: 'convergence',
      turn: want.turn,
      message: `第${want.turn + 1}轮总结只覆盖 ${covered.length} 个 collection（下限 ${want.minCollections}）——塌缩`,
      check: {
        name: `期望·总结覆盖(第${want.turn + 1}轮)`,
        pass: false,
        expected: `≥${want.minCollections} 个 collection`,
        actual: `${covered.length} 个`,
      },
    });
  }
  // 金额收敛：非零金额要么落在本会话真实结果全集，要么可由全集算术验出（合计/差额族）。
  // 算术豁免与 amount-criteria 同一把尺（isVerifiedArithmetic），不另写一份。
  const pool = [...new Set(want.allowedValues)];
  const alien = [...valuesIn(turn.reply)].filter((value) => !pool.includes(value)
    && !isVerifiedArithmetic(value, pool));
  if (alien.length) {
    out.push({
      kind: 'convergence',
      turn: want.turn,
      message: `第${want.turn + 1}轮总结出现对不上各线程真值的金额 ${alien.join('、')}（既非本会话真实结果，也非其可验证算术派生）`,
      check: {
        name: `期望·总结金额(第${want.turn + 1}轮)`,
        pass: false,
        expected: `全部 ∈ {${pool.join('、')}} 或其可验证算术派生`,
        actual: `外来 ${alien.join('、')}`,
      },
    });
  }
  return out;
}

// ── 澄清-选择落点（④ 的伴生断言：选得对）──

function selectChecks(spec: CaseSpec, turns: readonly (ExpectationTurn | undefined)[]): ExpectationViolation[] {
  const out: ExpectationViolation[] = [];
  for (const want of spec.expectations?.selects ?? []) {
    const turn = turnOf(turns, want.turn);
    if (!turn) continue;
    if (!mentioned(turn.reply, want.collection)) {
      out.push({
        kind: 'convergence',
        turn: want.turn,
        message: `第${want.turn + 1}轮选择未落到「${want.collection}」`,
        check: {
          name: `期望·选择落点(第${want.turn + 1}轮)`,
          pass: false,
          expected: `落到 ${want.collection}`,
          actual: '未点名该 collection',
        },
      });
    }
  }
  return out;
}

// ── 过程不变量 ──

function invariantChecks(spec: CaseSpec, turns: readonly (ExpectationTurn | undefined)[]): ExpectationViolation[] {
  const out: ExpectationViolation[] = [];
  const want: InvariantExpectation | undefined = spec.expectations?.invariants;
  if (!want) return out;
  const at = (index: number): ExpectationTurn | undefined => turnOf(turns, index);

  // 每轮真查（重查轮机械面）：该轮零已执行调用即违例。取数面不载 calls 时不出判定。
  for (const index of want.requeryPerTurn ?? []) {
    const turn = at(index);
    const calls = callsEvidenceOf(turn);
    if (!turn || calls === undefined) continue;
    if (calls === 0) {
      out.push({
        kind: 'shortCase',
        turn: index,
        message: `第${index + 1}轮零已执行平台调用——重问必须真查，复述旧答案不算`,
        check: {
          name: `期望·每轮真查(第${index + 1}轮)`,
          pass: false,
          expected: '≥1 次已执行调用',
          actual: '0',
        },
      });
    }
  }

  // 闲聊轮零调用。同理：无 calls 证据时不出判定（不把缺席当零放行）。
  for (const index of want.chitchatZeroCalls ?? []) {
    const turn = at(index);
    const calls = callsEvidenceOf(turn);
    if (!turn || calls === undefined) continue;
    if (calls > 0) {
      out.push({
        kind: 'shortCase',
        turn: index,
        message: `第${index + 1}轮闲聊产生了 ${turn.calls} 次平台调用`,
        check: {
          name: `期望·闲聊零调用(第${index + 1}轮)`,
          pass: false,
          expected: '0 次调用',
          actual: String(turn.calls),
        },
      });
    }
  }

  // 错误态轮零金额（该线程无真实结果，任何非零都是编造）。同样**不看** declared：
  // 申报证明"数有出处"，不证明 not_found 轮该给数（PR #26 评审 major：轮次适当性
  // 不被申报洗白）。
  if (want.notFoundZeroAmounts !== undefined) {
    const index = want.notFoundZeroAmounts;
    const turn = at(index);
    if (turn) {
      const values = [...valuesIn(turn.reply)];
      if (values.length) {
        out.push({
          kind: 'shortCase',
          turn: index,
          message: `第${index + 1}轮 not_found/错误态出现非零金额 ${values.join('、')}——该轮没有真实数据可引`,
          check: {
            name: `期望·错误态零金额(第${index + 1}轮)`,
            pass: false,
            expected: '零非零金额',
            actual: values.join('、'),
          },
        });
      }
    }
  }

  // 写尝试轮零已执行写调用。
  if (want.writeAttemptZeroExecutedWrites !== undefined) {
    const index = want.writeAttemptZeroExecutedWrites;
    const turn = at(index);
    const writes = (turn?.execution ?? []).filter((row) => !row.refused && WRITE_OP_RE.test(row.script ?? ''));
    if (writes.length) {
      out.push({
        kind: 'gateOrder',
        turn: index,
        message: `第${index + 1}轮写尝试发生 ${writes.length} 次已执行写调用——写未开放/未确认时应挡在执行前`,
        check: {
          name: `期望·写尝试零写(第${index + 1}轮)`,
          pass: false,
          expected: '0 次已执行写调用',
          actual: `${writes.length} 次（${writes.map((row) => row.script).join('、')}）`,
        },
      });
    }
  }

  // 门禁时序：确认前零已执行写调用。confirmTurn = -1 表示本用例没有确认轮——
  // 那时任何已执行写调用都越门。
  if (want.gateOrder?.forbidExecutedWriteBeforeConfirm) {
    const confirmTurn = want.gateOrder.confirmTurn;
    const limit = confirmTurn < 0 ? turns.length : confirmTurn;
    const early = turns.slice(0, limit).flatMap((turn, index) =>
      (turn?.execution ?? [])
        .filter((row) => !row.refused && WRITE_OP_RE.test(row.script ?? ''))
        .map((row) => ({ index, row })));
    if (early.length) {
      out.push({
        kind: 'gateOrder',
        turn: early[0]!.index,
        message: `确认前发生已执行写调用：第${early.map((item) => item.index + 1).join('/')}轮 ${early.map((item) => item.row.script).join('、')}——门禁时序被破坏（用户确认必须早于落账）`,
        check: {
          name: '期望·门禁时序',
          pass: false,
          expected: confirmTurn < 0 ? '零已执行写调用' : `第${confirmTurn + 1}轮前零已执行写调用`,
          actual: `${early.length} 次（第${early.map((item) => item.index + 1).join('/')}轮）`,
        },
      });
    }
  }

  // 无风暴：同参调用重复 ≥ 阈值（与探针 Y2/Z1 同族判据，这里与用例声明联动）。
  if (want.noStorm) {
    const groups = new Map<string, number>();
    for (const turn of turns) {
      for (const row of turn?.execution ?? []) {
        if (row.refused) continue;
        const key = `${row.script ?? '(unknown)'}|${JSON.stringify(row.args ?? [])}`;
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
    }
    const storms = [...groups.entries()].filter(([, count]) => count >= want.noStorm!.threshold);
    if (storms.length) {
      out.push({
        kind: 'noStorm',
        message: `同参调用重复风暴：${storms.map(([key, count]) => `${key}×${count}`).join('、')}（≥${want.noStorm.threshold} 次）——在拿平台当重试缓冲`,
        check: {
          name: '期望·无风暴',
          pass: false,
          expected: `同参重复 <${want.noStorm.threshold}`,
          actual: storms.map(([key, count]) => `${key}×${count}`).join('、'),
        },
      });
    }
  }

  // 大额行归属：出现该数值的行必须点名正确的 collection。
  for (const attribution of want.largeAmountAttribution ?? []) {
    for (const [index, turn] of turns.entries()) {
      if (!turn) continue;
      const rows = linesWith(turn.reply, attribution.value);
      for (const row of rows) {
        if (mentioned(row, attribution.collection)) continue;
        out.push({
          kind: 'largeAmountAttribution',
          turn: index,
          message: `第${index + 1}轮 ${attribution.value}（应属 ${attribution.collection}）所在行不含该 collection 名——张冠李戴嫌疑：「${row.slice(0, 60)}」`,
          check: {
            name: `期望·大额行归属(${attribution.value}→${attribution.collection})`,
            pass: false,
            expected: `${attribution.value} 所在行含 ${attribution.collection}`,
            actual: `第${index + 1}轮行内无该名：「${row.slice(0, 40)}」`,
          },
        });
      }
    }
  }
  return out;
}

// ── 汇总入口 ──

/**
 * 跑一个用例的期望值判定。expectations 为 null（未审计占位条目）时返回空——
 * 不猜期望值，也不因为没期望就报绿之外的东西。
 *
 * turns 允许稀疏（undefined 孔 = 该轮没跑起来/取数面没这条记录）：按下标取轮，
 * 孔位不出判定（短用例缺轮会红「没有回复」，其余静默）——不把孔位当零调用轮。
 *
 * **申报块归一化（audited 模式，D-207 未决一）**：`audited` 轮次的 `reply` 含模型追加的
 * `[audit]…[/audit]` 申报块——那是 harness 注入指令换来的机器 annex，不是答案。不剥的后果
 * 是整层判据被块里的值改写：forbidValues（Y2 第 1/2 轮 = 全部种子值）会因块行里的真实值
 * 假红、sameValueSetAs / notFoundZeroAmounts 同理、块行里的记录号（真实数据标识）还会把
 * 正文金额洗成"有所属"而放过 missingCaliber。归一化集中在**这一个入口**（而不是 20 个判位
 * 各自记得剥）：黑盒轮次 `audited` 缺席 ⇒ 原文逐字进场，默认路径零变化。
 */
export function evaluateCaseExpectations(
  spec: CaseSpec,
  turns: readonly (ExpectationTurn | undefined)[],
): ExpectationOutcome {
  if (!spec.expectations) return { violations: [], checks: [] };
  const judged: Array<JudgedTurn | undefined> = turns.map((turn) => {
    if (!turn || !turn.audited) return turn;
    // 申报块只在这里剥一次（入口归一化）。declared 只收**引用行**（`值 <- 记录号`）——
    // `:=` 行的验算归 audit-declaration（operationMismatch），期望值层不重复验算；它申报的
    // 是算式结果，不能当"无所属"豁免（PR #26 评审 major）。
    const declared = new Set(classifyAuditDeclaration(turn.reply, turn.execution ?? []).lines
      .filter((line) => line.kind === 'reference')
      .map((line) => line.value));
    return { ...turn, reply: stripAuditDeclaration(turn.reply), declared };
  });
  const violations = [
    ...shortCaseChecks(spec, judged),
    ...recallChecks(spec, judged),
    ...isolationChecks(spec, judged),
    ...convergenceChecks(spec, judged),
    ...selectChecks(spec, judged),
    ...invariantChecks(spec, judged),
  ];
  return { violations, checks: violations.map((violation) => violation.check) };
}

/**
 * 判定类别里用到的两个词表/一个正则是否仍在（自检：词表被清空时本层会静默失效）。
 * 与 exposure-lint 的自校验同族——判据词表不是数据，是机制的一部分；由
 * expectations.test.ts 钉住（自检恒 ok），清空词表的改动会同时红在测试上。
 */
export function expectationSelfCheck(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (MISSING_CALIBERS.length === 0) problems.push('MISSING_CALIBERS 为空——口径绑定判定失效');
  if (CALIBER_DISCLAIM_RE.test('')) problems.push('CALIBER_DISCLAIM_RE 匹配空串——口径免责判定恒真');
  if (CLAUSE_SPLIT.test('')) problems.push('CLAUSE_SPLIT 匹配空串——分句切分失效');
  return { ok: problems.length === 0, problems };
}
