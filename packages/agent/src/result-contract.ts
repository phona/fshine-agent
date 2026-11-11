/**
 * T10 段1：声明 N，验到 N——执行结果的宿主侧对账（2026-11-11）。
 *
 * 定位（与门的分工）：门验的是**请求**（要做什么、范围是否已确认）；本模块验的是
 * **结果**（执行层状态里到底落了多少）。两者不能互相冒充：一张形状合法的计划照样
 * 可能在执行时走成空跑。
 *
 * 真实语料（本模块必须抓住的形状，2026-11 实测）：域命令简写走 query 模式、写标志
 * 漏传不报错、空跑十分钟退出码仍为 0、一个对象也没落盘——worker 自述"已完成"，
 * 平台上什么都没有。判定因此不能读 worker 文本，只能比两份宿主持有的事实：
 *
 *   · 声明（ResultContractDeclaration）：执行层计划声明的"要写/上传 N 个对象"。
 *     生产者 = 执行层适配边界（TaskResultPort.declare），不进 worker 自由文本；
 *   · 观测（ResultObservation）：宿主对执行层状态的**独立读**（TaskResultPort.observe
 *     ——与执行不是同一条回执，也不是转录里的 tool_result）。
 *
 * 判定四态（只有 verified 允许调用方记完成）：
 *   · verified     ：不声称写，或每个声明指标的实际值都 >= 声明值；
 *   · shortfall    ：实际值 < 声明值（差额逐项列出，供留痕与用户可见反馈）；
 *   · shape_defect ：声称写，却没有声明任何可读指标，或声明的指标读不回来
 *                    ——"声明不出可读的结果指标"是计划形状缺陷，不许用 worker 的话凑；
 *   · inconclusive ：读回整体不可用（端口故障/未接线）。绝不降级成 verified。
 *
 * 纯函数、零 IO：端口与留痕在调用方（context.ts 的任务执行边界），本模块只做机械判定，
 * 因此可被纯数据钉住语义（R3）。
 */
/** 宿主独立读到的执行层结果指标值（一次观测）。 */
export interface ResultObservation {
  /** 与声明同一词表的指标名（执行层自己的词汇）。 */
  metric: string;
  /** 执行层状态里的实际计数（非负整数，畸形值由适配边界拒收）。 */
  actual: number;
}

/** 执行层计划声明的一项结果指标（对象计数）。 */
export interface ResultDeclaration {
  /** 执行层自己的指标名（宿主不解释、不枚举——同 effects 的开放词表纪律）。 */
  metric: string;
  /** 声明要写/上传的数量；非负整数，畸形值由调用方在适配边界拒收。 */
  expected: number;
}

/** 执行层计划声明的本步结果契约。 */
export interface ResultContractDeclaration {
  /** 本步是否声称写/上传。false = 只读步，不参与对账。 */
  claimsWrite: boolean;
  metrics: readonly ResultDeclaration[];
}

/** 差额项：声明值与独立读回值都留痕，差额由宿主算，不由 worker 说。 */
export interface ResultShortfall {
  metric: string;
  expected: number;
  actual: number;
  missing: number;
}

export type ResultContractVerdict = 'verified' | 'shortfall' | 'shape_defect' | 'inconclusive';

export type ResultContractReason =
  | 'read_only'
  | 'verified'
  | 'below_declared'
  | 'no_readable_metric'
  | 'unreadable_metric'
  | 'probe_unavailable';

export interface ResultContractReconciliation {
  verdict: ResultContractVerdict;
  reason: ResultContractReason;
  claimsWrite: boolean;
  declarations: readonly ResultDeclaration[];
  observations: readonly ResultObservation[];
  shortfalls: readonly ResultShortfall[];
  /** verdict='shape_defect' 时点名的读不回指标（空 = 整份声明都没有可读指标）。 */
  unreadable: readonly string[];
}

/**
 * 结果面的执行层端口（T10）：两份事实都必须由执行层适配边界提供，宿主不猜。
 *
 *   · declare：执行层计划声明的结果契约（"这一步要写/上传 N 个对象"）。生产者是
 *     执行层计划状态，不是 worker 的自由文本；
 *   · observe：宿主对执行层状态的独立读（实际落盘/上传数）。与执行回执、转录里的
 *     tool_result 都不是同一条数据——这正是"不是从 worker 的话里读"的落地。
 *
 * 实现归执行层适配边界（装配注入）；缺省不注入 = 本机制不启用，现有行为零变化。
 */
export interface TaskResultScope {
  taskId: string;
  /** 本步加工后的请求（执行层按它定位自己的计划/状态）。 */
  request: string;
  /** 计划模式的步骤标签（「第 N/M 步」）；单步为空。 */
  stepLabel?: string;
}

export interface TaskResultPort {
  declare(scope: TaskResultScope): Promise<ResultContractDeclaration | null>;
  observe(scope: TaskResultScope): Promise<readonly ResultObservation[] | null>;
}

/**
 * 声明 ↔ 独立读回的对账。纯函数：入参是两份已取到的事实，缺席用 null 表示
 * （"没写过"与"写了 0"严格区分——后者是 observations 里 actual=0 的一项）。
 */
export function reconcileResultContract(input: {
  declaration: ResultContractDeclaration | null;
  observations: readonly ResultObservation[] | null;
}): ResultContractReconciliation {
  const declaration = input.declaration;
  const declarations = declaration?.metrics ?? [];
  const observations = input.observations ?? [];
  const base = {
    claimsWrite: declaration?.claimsWrite === true,
    declarations,
    observations,
    shortfalls: [] as ResultShortfall[],
    unreadable: [] as string[],
  };
  // 只读步 / 没有声明：无对账对象。这不是"清白证明"，只是本模块没有判据可用——
  // 写步的判据必须来自执行层声明，宿主不猜。
  if (!declaration || !declaration.claimsWrite) {
    return { ...base, verdict: 'verified', reason: 'read_only' };
  }
  // 声称写却一个可读指标都没有：计划形状缺陷，宿主无从核实，禁止用 worker 文本兜底。
  if (declarations.length === 0) {
    return { ...base, verdict: 'shape_defect', reason: 'no_readable_metric' };
  }
  // 读回整体不可用：不编造、不降级成完成。
  if (input.observations === null) {
    return { ...base, verdict: 'inconclusive', reason: 'probe_unavailable' };
  }
  const byMetric = new Map(observations.map((observation) => [observation.metric, observation.actual]));
  const shortfalls: ResultShortfall[] = [];
  const unreadable: string[] = [];
  for (const declared of declarations) {
    const actual = byMetric.get(declared.metric);
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      unreadable.push(declared.metric);
      continue;
    }
    if (actual < declared.expected) {
      shortfalls.push({
        metric: declared.metric,
        expected: declared.expected,
        actual,
        missing: declared.expected - actual,
      });
    }
  }
  // 读不回的指标属于形状缺陷（声明了却不可核实），优先于差额如实上报。
  if (unreadable.length > 0) {
    return { ...base, shortfalls, unreadable, verdict: 'shape_defect', reason: 'unreadable_metric' };
  }
  if (shortfalls.length > 0) {
    return { ...base, shortfalls, verdict: 'shortfall', reason: 'below_declared' };
  }
  return { ...base, verdict: 'verified', reason: 'verified' };
}

/**
 * 对账不通过时的用户可见终稿。措辞纪律：
 *   · 只陈述声明值与宿主独立读回值（数字来自两份宿主事实，不转述 worker）；
 *   · 零执行层实现细节（脚本名/写标志/错误码/operation 名都不出现）；
 *   · 绝不说"已完成/成功"——不足就是不足，未核实就是未核实。
 */
export function renderResultContractReply(reconciliation: ResultContractReconciliation): string {
  const lines: string[] = [];
  if (reconciliation.verdict === 'shortfall') {
    const details = reconciliation.shortfalls
      .map((item) => `声明 ${item.expected} 个、实际 ${item.actual} 个，差 ${item.missing} 个`)
      .join('；');
    lines.push(`[结果未核实] 本次任务的结果数量与计划声明不一致：${details}。`);
    lines.push('未完成部分：声明要求的结果没有全部落盘，任务不记为完成。');
  } else if (reconciliation.verdict === 'shape_defect') {
    lines.push('[结果无法核实] 本次任务声明了写入或上传，但执行层没有提供可读的结果指标，宿主无法核实实际数量。');
    lines.push('未完成部分：结果无法核实，任务不记为完成。');
  } else {
    lines.push('[结果无法核实] 本次任务的结果读回不可用，宿主无法核实实际数量。');
    lines.push('未完成部分：结果无法核实，任务不记为完成。');
  }
  lines.push('已发生的工作痕迹与证据已保留；请核对后再试，或回复“继续”从断点续跑。');
  return lines.join('\n');
}
