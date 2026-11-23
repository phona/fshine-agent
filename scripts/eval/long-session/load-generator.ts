/**
 * R6 测试基建 · 负载生成器（确定性语料规划 + 上下文推进器；零模型）。
 *
 * 定位：为六轨（LS1–LS6）生成**确定性的逐轮语料计划**，并给出逐轮机械期望
 * （供事实 Oracle 与轮期望判定消费）。本模块是**纯函数面**：不 import 产品运行时、
 * 不读压缩阈值、**不做任何压缩决策**。它的唯一职责是「给出要注入的真实内容轮」与
 * 「该轮的事实/任务/执行期望」。
 *
 * 期望字段的机械判定在 `harness.ts`（`judgeTurnExpectations`），全部只看会话面事实：
 *   · `fact` —— 事实 Oracle（`judgeFactAnswer`），**任何 kind 都可携带**（interaction 轮同样判定）；
 *   · `expectNoNewTask` / `expectNewTask` —— 本轮前后任务账本（`tasks()`）行数差；
 *   · `expectNoExecution` / `expectExecutionObjects` —— 本轮 `execute_operation` 审计行；
 *   · `expectPrevTasksUnchanged` / `expectTaskFactIn` —— 任务账本机械事实与执行清单；
 *   · `replyExcludes` —— 回复文本的负向机械检查；
 *   · `gapMs` —— 该轮 send 前的真实空档（真 `setTimeout`）；
 *   · `deferIdle` / `settleBeforeJudge` —— 只交办不等收尾（真交错/在飞取消）与落定后再判。
 *
 * 上下文推进器（Context Pump）只**追加新的真实内容轮**（更多真实业务查询），
 * 以便在真实窗口下累积到 ≥3 次有效压缩；它**不读阈值、不决定何时压缩**
 * （对齐 harness 设计 §一 / 预注册 §三.6）。是否继续追加由执行器按「压缩计数」驱动。
 */
import { type FactExpectation, FACT_TRUTH } from './oracle';

export type Track = 'LS1' | 'LS2' | 'LS3' | 'LS4' | 'LS5' | 'LS6';
export type TurnKind = 'establish' | 'fact' | 'task' | 'interaction' | 'pump' | 'probe';

/** 任务账本里「哪一个任务」的机械事实期望（oldest = 最早创建，latest = 最新创建）。 */
export interface TaskFactPick {
  readonly which: 'oldest' | 'latest';
  /** 机械事实标签（'reported'/'stopped'/'progressing'/'exec:failed' …，见 oracle 的 taskHasFact）。 */
  readonly facts: readonly string[];
}

export interface TurnSpec {
  readonly index: number;
  readonly text: string;
  readonly kind: TurnKind;
  /** 事实期望（**任何 kind 都可携带**；interaction 轮也走同一套事实判定）。 */
  readonly fact?: FactExpectation;
  /** 任务轮的期望机械事实标签（Oracle 对照用；可省，任务判定以 registry 快照为准）。 */
  readonly expectTaskFact?: string;
  /** 交互轮标签（LS3 的 NL1–NL10；LS6 的 N1-A…N6-C）。 */
  readonly label?: string;
  /** 本轮不得新建任务（该轮前后任务账本行数不变、且不出现新 taskId）。 */
  readonly expectNoNewTask?: boolean;
  /** 本轮必须新建任务（出现该轮之前账本里没有的 taskId）。 */
  readonly expectNewTask?: boolean;
  /** 本轮不得发起任何 `execute_operation`（凭上下文回答 / 纯解释 / 暂停继续）。 */
  readonly expectNoExecution?: boolean;
  /** 本轮执行调用的对象必须包含这些（按 `execute_operation` 审计行判定）。 */
  readonly expectExecutionObjects?: readonly string[];
  /** 本轮之前已存在的任务：状态与执行清单不得改变（旧任务不被改写）。 */
  readonly expectPrevTasksUnchanged?: boolean;
  /** 本轮结束时指定任务必须具备的机械事实之一（见 oracle 的 taskHasFact）。 */
  readonly expectTaskFactIn?: TaskFactPick;
  /** 回复文本（去空白）不得包含这些字面片段；纯数字片段按「出现该数值」判。 */
  readonly replyExcludes?: readonly string[];
  /** 负向检查的作用域（2026-11-18）：只检查**提到该对象**的句子。
   *  实测：N5-B 里回复合法地报了 beta 的「3 条」，被裸词判负——负向检查必须限定对象。 */
  readonly replyExcludesScope?: string;
  /**
   * 取消诚实性：回复声称「已取消」时账本最新任务必须真的 `cancelled`；若任务已
   * `completed`，回复不得声称取消（如实说已完成即可）。用于「不许假取消」。
   */
  readonly expectCancelHonest?: boolean;
  /**
   * `expectCancelHonest` 检查哪个任务：缺省 latest（取消「刚开的」那个）；
   * N6-C 要撤销最早那个已完成任务，必须显式 `'oldest'`，否则会拿最新任务
   * （可能是已 cancelled 的另一个任务）造成空过。
   */
  readonly cancelTarget?: 'oldest' | 'latest';
  /**
   * 在飞取消：本轮之前最新任务必须仍在飞（queued/running/cancelling），本轮落定后
   * 该任务必须真的 `cancelled`。轮前就已 completed → `E-INCONCLUSIVE`（没有在飞窗口，
   * 不冒充判定）；落定后未 cancelled → E-D（取消未生效，含「指错任务」）。
   */
  readonly expectInflightCancel?: boolean;
  /** 本轮 send 之前的真实等待（毫秒；harness 用真 `setTimeout`，不用注入时钟假装）。 */
  readonly gapMs?: number;
  /**
   * 只交办、不等后台完成：本轮用 `session.sendNoWait`（background 派发下受理即返回），
   * 下一个非延迟轮发送前（或会话结束）统一 `waitIdle`。用于「A 在飞时插 B」与
   * 「在飞任务取消」这两类真交错场景；缺省 false = 与既有轮一致，send 内等 idle。
   */
  readonly deferIdle?: boolean;
  /**
   * 延迟轮是否在本轮判定前先 `waitIdle` 收尾（只对 `deferIdle` 生效）。
   * 用于「发出取消时任务还在飞，但要按取消落定后的状态判诚实性」。
   */
  readonly settleBeforeJudge?: boolean;
}

export interface TrackPlan {
  readonly track: Track;
  readonly turns: readonly TurnSpec[];
}

function withIndex(turns: readonly Omit<TurnSpec, 'index'>[]): TurnSpec[] {
  return turns.map((t, i) => ({ ...t, index: i + 1 }));
}

/** LS1 事实语的建立轮（先建立事实，再经压缩后追问）。 */
function ls1Establish(): Omit<TurnSpec, 'index'>[] {
  return [
    { kind: 'establish', text: '先帮我查一下 alpha 集合 W1 窗口的记录总额，一共几条、总金额多少，把任务编号告诉我。' },
    { kind: 'establish', text: '同时再帮我开一个任务：查 beta 集合 W1 的记录，回头我要和 alpha 对比。' },
    { kind: 'establish', text: 'documents W202610 的记录也查一下，第二条金额是多少？' },
  ];
}

/** LS1 事实追问轮（F1–F8）。 */
function ls1Facts(): Omit<TurnSpec, 'index'>[] {
  const alpha = FACT_TRUTH['alpha']!;
  const beta = FACT_TRUTH['beta']!;
  return [
    { kind: 'fact', text: 'alpha 集合 W1 一共几条、总金额多少？', fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum } },
    { kind: 'fact', text: 'beta 集合 W1 一共几条、总金额多少？alpha 比 beta 多多少？', fact: { kind: 'exact', collection: 'beta', count: beta.count, sum: beta.sum } },
    { kind: 'fact', text: 'documents W202610 第二条金额是多少？', fact: { kind: 'exact', collection: 'documents', value: 800 } },
    { kind: 'fact', text: '我刚才把 alpha 总额说错了，请按查询结果给出准确值。', fact: { kind: 'session_value', value: '2000' } },
    { kind: 'fact', text: '我之前让你按某个结论处理，现在那个结论作废，不要再按它回答。', fact: { kind: 'session_value', value: '作废' } },
    { kind: 'fact', text: '那个还没做完的汇总任务现在是什么状态？', fact: { kind: 'session_value', value: '未完成' } },
    { kind: 'fact', text: '记住：金额一律不要四舍五入。再报一次 alpha 总额。', fact: { kind: 'exact', collection: 'alpha', sum: 2000 } },
    { kind: 'fact', text: '帮我查一下 W9999 窗口的记录总额是多少？', fact: { kind: 'unanswerable', collection: 'alpha', window: 'W9999' } },
  ];
}

function ls2Turns(): Omit<TurnSpec, 'index'>[] {
  return [
    { kind: 'task', text: '帮我开一个大任务：核对 alpha 和 beta 的记录，逐项说明。', expectTaskFact: 'reported' },
    { kind: 'task', text: '把刚才那个 alpha/beta 核对任务取消掉，不要做了。', expectTaskFact: 'stopped' },
    { kind: 'task', text: '再开一个任务：查 empty-one W1 的记录。', expectTaskFact: 'reported' },
    { kind: 'task', text: '再开一个任务：查 faulty-one W1 的记录。', expectTaskFact: 'exec:failed' },
    { kind: 'task', text: '把正在执行的任务再报一次状态，别重复建任务。', expectTaskFact: 'progressing' },
    { kind: 'task', text: '第一个和第二个任务的编号分别是多少？结果对应哪个对象？' },
  ];
}

/**
 * LS3 交互轮（NL1–NL10）。NL2/NL3/NL4/NL5/NL7/NL9/NL10 携带机械期望（事实真值见
 * `FACT_TRUTH`，任务状态取自既有建立轮计划），NL8（暂停…继续）不得新建任务。
 * 期望只**加**不减：NL1/NL6 仍由既有硬零/事实链路兜底。
 */
function ls3Turns(): Omit<TurnSpec, 'index'>[] {
  const alpha = FACT_TRUTH['alpha']!;
  const beta = FACT_TRUTH['beta']!;
  return [
    { kind: 'interaction', text: '刚才那个任务的结论是什么？', label: 'NL1' },
    // 「第二个结果」= 第二个建立轮（beta 任务）的结果。
    { kind: 'interaction', text: '第二个结果是什么？', label: 'NL2', expectNoNewTask: true, fact: { kind: 'exact', collection: 'beta', count: beta.count, sum: beta.sum } },
    { kind: 'interaction', text: '上次查的 alpha 总额是多少？', label: 'NL3', expectNoNewTask: true, fact: { kind: 'exact', collection: 'alpha', sum: alpha.sum } },
    { kind: 'interaction', text: '改成查 beta 吧，不要 alpha 了。', label: 'NL4', fact: { kind: 'exact', collection: 'beta', count: beta.count, sum: beta.sum } },
    { kind: 'interaction', text: '你数错了，alpha 是 2 条不是 3 条，按 2 条重来。', label: 'NL5', fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum } },
    { kind: 'interaction', text: '在这个任务上再加一条：只统计金额为正的记录。', label: 'NL6' },
    { kind: 'interaction', text: '先不聊账务了，帮我看看 documents 的异常。', label: 'NL7', fact: { kind: 'exact', collection: 'documents', value: 800 } },
    { kind: 'interaction', text: '暂停一下，稍后继续。……继续刚才的。', label: 'NL8', expectNoNewTask: true },
    // NL9：任务未被取消（最早那个 alpha 查询任务最终已完成）——取消回执诚实性由 H5 兜底。
    { kind: 'interaction', text: '刚才那个任务取消了吗？', label: 'NL9', expectTaskFactIn: { which: 'oldest', facts: ['reported'] } },
    { kind: 'interaction', text: '你刚才为什么把 alpha 判成 3 条？解释一下你的判断。', label: 'NL10', fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum } },
  ];
}

/**
 * LS6 · 自然交互扰动（6 个场景，13 轮，全部带机械判据）。
 *
 * N1 真交错（A 在飞插 B，回头要 A 的结论）/ N2 改口径后回头 / N3 真间隔暂停（真实 1.5s 空档）/
 * N4 反悔重做（新建任务，旧任务不被改写）/ N5 自我更正（最终按 2 条 2000，不得沿用 3 条）/
 * N6 三档取消（在飞取消必须落地；已完成任务如实拒绝；排队档在 background 下无稳定窗口）。
 *
 * 判据全部是会话面机械事实（任务账本行数/状态、执行审计行、事实 Oracle、回复负向检查），
 * 不靠模型自述。
 */
function ls6Turns(): Omit<TurnSpec, 'index'>[] {
  const alpha = FACT_TRUTH['alpha']!;
  const beta = FACT_TRUTH['beta']!;
  return [
    // ── N1 真交错 ────────────────────────────────────────────────────────────
    // N1-A/N1-B 只交办不等待：B 在 A 仍在执行时插入（background 派发，受理即返回）。
    { kind: 'establish', label: 'N1-A', text: '先帮我查 alpha 集合 W1 窗口的记录，开个任务跑：一共几条、总金额多少。', expectNewTask: true, deferIdle: true },
    { kind: 'interaction', label: 'N1-B', text: '这个先放着。同时另开一个任务：查 documents 集合 W202611 的记录，回头我要对一下。', expectNewTask: true, deferIdle: true },
    {
      kind: 'interaction', label: 'N1-C',
      text: '回到刚才第一个任务：alpha 集合 W1 的结果是什么？一共几条、总金额多少？',
      expectNoNewTask: true, expectTaskFactIn: { which: 'oldest', facts: ['reported'] },
      fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum },
    },
    // ── N2 改口径后回头 ──────────────────────────────────────────────────────
    {
      kind: 'interaction', label: 'N2-A',
      text: '口径改一下：改成查 beta 集合 W1，不要 alpha 了，给我条数和总额。',
      // background 派发下「开始任务」轮的回复天然是「已受理/后台办理中」，不含结果；
      // 该轮只判「执行对象真的落到 beta」（执行审计行），结论事实判在 N2-B。
      expectExecutionObjects: ['beta'],
    },
    {
      kind: 'interaction', label: 'N2-B',
      text: '刚才那个还是按 beta 吧？把 beta 的结论再报一遍，不用再查。',
      expectNoExecution: true, expectNoNewTask: true,
      fact: { kind: 'exact', collection: 'beta', count: beta.count, sum: beta.sum },
      // 2026-11-18 去掉「排除 2000」：实测回复里出现 2000 是**正确归属**的对比说明
      // （「之前 alpha 的结果仍是 2 条、总额 2000，与 beta 是两次独立查询」），
      // 裸数字排除无法区分"把 alpha 的 2000 说成 beta"与"如实并列两个口径"。
      // beta 自己的合计由 fact 判据（sum=1000）保证。
    },
    // ── N3 真间隔暂停（1.5s 真空档 → 继续）────────────────────────────────
    { kind: 'interaction', label: 'N3-A', text: '先停一下，我过几分钟再回来继续。', expectNoNewTask: true, expectNoExecution: true, expectPrevTasksUnchanged: true },
    { kind: 'interaction', label: 'N3-B', text: '继续刚才的。', gapMs: 1500, expectNoNewTask: true, expectNoExecution: true, expectPrevTasksUnchanged: true },
    // ── N4 反悔重做（对已完成任务重做：必须新建任务，旧任务不被改写）────────
    { kind: 'interaction', label: 'N4', text: 'beta 那个结论我不太放心，再重做一遍。', expectNewTask: true, expectPrevTasksUnchanged: true },
    // ── N5 自我更正（先说 3 条，再改口 2 条）────────────────────────────────
    { kind: 'interaction', label: 'N5-A', text: '补充一下：alpha 一共有 3 条。', expectNoNewTask: true },
    {
      kind: 'interaction', label: 'N5-B',
      text: '更正：alpha 是 2 条，按 2 条重算，把条数和总额再给我一次。',
      fact: { kind: 'exact', collection: 'alpha', count: alpha.count, sum: alpha.sum },
      replyExcludes: ['3条', '三条'],
      replyExcludesScope: 'alpha',
    },
    // ── N6 三档取消 ──────────────────────────────────────────────────────────
    // ①在飞取消：Q1 交办即返回（任务仍在执行），Q2 在任务未完成时发出取消，
    //   并在判定前等它落定。Q1 取大载荷集合（bulk-a）以保证「在飞」窗口稳定存在，
    //   避免小查询在取消到达前就完成（那是时序竞态，不是取消语义）。
    { kind: 'interaction', label: 'N6-Q1', text: '开个任务查 bulk-a 集合 W1 窗口的记录，报总条数与总金额，并列前 5 条即可。', expectNewTask: true, deferIdle: true },
    { kind: 'interaction', label: 'N6-Q2', text: '刚开的那个任务先别跑了，取消掉。', expectInflightCancel: true, deferIdle: true, settleBeforeJudge: true },
    // ②对已完成任务取消：必须如实拒绝，状态不变、不得声称已取消
    {
      kind: 'interaction', label: 'N6-C',
      text: '把最早那个 alpha 任务也取消掉，别要了。',
      expectPrevTasksUnchanged: true,
      expectTaskFactIn: { which: 'oldest', facts: ['reported'] },
      cancelTarget: 'oldest',
      // 声称取消但状态没变 = 假取消；「没能取消成功 / 无法取消」这类如实拒绝不算声称。
      expectCancelHonest: true,
    },
  ];
}


/** 上下文推进器：追加**新的真实内容轮**（更多真实业务查询），迫使上下文累积。 */
export function buildPumpTurns(startIndex: number, count: number): TurnSpec[] {
  // 每轮换一个新对象/新窗口的组合，都是真实可查的业务语料（不是无意义填充）。
  const pumpTexts: readonly string[] = [
    '再开一个任务：查 bankflow-oct 2025-10 的记录，逐条列出来，说明有没有异常。',
    'contoso-logistics W1 也查一下有什么。',
    'alpha-group W1 的记录也核对一下。',
    'contoso-trade W2 的记录查一下。',
    'locked-one W1 的记录查一下（只读）。',
    '把上面几个集合的条数各报一遍，然后重新核对 alpha。',
  ];
  const out: TurnSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ index: startIndex + i, kind: 'pump', text: pumpTexts[i % pumpTexts.length]! });
  }
  return out;
}

/**
 * 构建某轨的确定性语料计划。LS4/LS5 本身不产事实轮（生命周期/长稳），但同样注入
 * 真实内容轮以累积上下文（LS5 复用 pump；LS4 复用 LS1 建立轮）。LS6 是自然交互扰动轨，
 * 自带建立轮（N1-A）与 6 个场景的全部轮次。
 */
export function buildTrackPlan(track: Track): TrackPlan {
  switch (track) {
    case 'LS1':
      return { track, turns: withIndex([...ls1Establish(), ...ls1Facts()]) };
    case 'LS2':
      return { track, turns: withIndex([...ls1Establish(), ...ls2Turns()]) };
    case 'LS3':
      return { track, turns: withIndex([...ls1Establish(), ...ls3Turns()]) };
    case 'LS4':
      return { track, turns: withIndex([...ls1Establish()]) };
    case 'LS5':
      return { track, turns: withIndex([...ls1Establish()]) };
    case 'LS6':
      return { track, turns: withIndex([...ls6Turns()]) };
  }
}

/** 事实轮（供事实 Oracle 聚合）：**任何 kind** 携带 `fact` 都算（interaction 轮同样判定）。 */
export function factTurns(plan: TrackPlan): readonly TurnSpec[] {
  return plan.turns.filter((t) => t.fact !== undefined);
}
