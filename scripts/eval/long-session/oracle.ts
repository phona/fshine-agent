/**
 * R6 测试基建 · 事实 Oracle + 任务 Oracle（确定性、零模型、只采集事实）。
 *
 * 定位：把「事实保留 / 任务连续性」从模型自述里解耦，用**确定性真值**判定。
 * 本模块是**纯函数面**——不 import 产品运行时、不读 env、不触网；真值来自夹具种子
 * （`scripts/eval/fixtures/dummy-platform/bin/dummy.cjs` 的 seedState 语义快照）与会话内
 * 显式约定的 expected，不看模型回复以外的任何输入。
 *
 * 边界（对齐 AGENTS.md 与 R6 harness 设计）：
 *   · 观测只采集事实，**不改压缩触发/门控**；本模块不读阈值、不做压缩决策。
 *   · 事实 Oracle 是**机械比对**（数值解析 + 关键词）；措辞面的模糊判定交判官层
 *     （见 harness 设计 §六），本模块对不确定措辞给 `inconclusive`（不冒充结论）。
 *   · 任务 Oracle 只读 Task Registry 快照的形状，不 import SQLite 实现——Wave1 生产装配
 *     把真实 registry 投影成 `TaskView[]` 后喂入（同一判定，两处同源）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 事实 Oracle
// ─────────────────────────────────────────────────────────────────────────────

/** 事实真值表：仅登记**夹具种子**有确定性答案的对象（金额/条数/异常）。 */
export interface CollectionTruth {
  readonly name: string;
  /** 返回条数（= items.length，query 返回全量，窗口只作合法性维度）。 */
  readonly count: number;
  /** 金额总和（items 全量）。 */
  readonly sum: number;
  /** 唯一可答的窗口（不在表内 → WINDOW_NO_DATA）。 */
  readonly windows: readonly string[];
  /** 特定条目的唯一真值（如「第二条金额」）；index 从 1 起。 */
  readonly items?: readonly { readonly index: number; readonly name: string; readonly value: number }[];
  readonly note?: string;
}

/** 夹具种子的确定性事实快照（与 dummy.cjs seedState 语义一致；只读消费者）。 */
export const FACT_TRUTH: Readonly<Record<string, CollectionTruth>> = {
  alpha: { name: 'alpha', count: 2, sum: 2000, windows: ['W1', 'W2'], items: [{ index: 1, name: 'alpha-item-1', value: 1200 }, { index: 2, name: 'alpha-item-2', value: 800 }] },
  beta: { name: 'beta', count: 3, sum: 1000, windows: ['W1'], items: [{ index: 1, name: 'beta-item-1', value: 500 }, { index: 2, name: 'beta-item-2', value: 300 }, { index: 3, name: 'beta-item-3', value: 200 }] },
  'alpha-group': { name: 'alpha-group', count: 1, sum: 700, windows: ['W1'], items: [{ index: 1, name: 'alpha-group-item-1', value: 700 }] },
  documents: { name: 'documents', count: 3, sum: 2900, windows: ['W202610', 'W202611'], items: [{ index: 1, name: 'document-1', value: 1200 }, { index: 2, name: 'document-2', value: 800 }, { index: 3, name: 'document-2', value: 900 }], note: '同名异值：document-2 出现两次（800/900）——异常事实' },
  'contoso-trade': { name: 'contoso-trade', count: 2, sum: 2100, windows: ['W1', 'W2'], items: [{ index: 1, name: 'contoso-trade-item-1', value: 1500 }, { index: 2, name: 'contoso-trade-item-2', value: 600 }] },
  'contoso-logistics': { name: 'contoso-logistics', count: 1, sum: 450, windows: ['W1'], items: [{ index: 1, name: 'contoso-logistics-item-1', value: 450 }] },
  'bankflow-oct': { name: 'bankflow-oct', count: 4, sum: 27200, windows: ['2025-10'], items: [{ index: 1, name: 'bank-1012-01', value: 5200 }, { index: 2, name: 'bank-1015-02', value: -3600 }, { index: 3, name: 'bank-1021-03', value: 12800 }, { index: 4, name: 'bank-1021-03', value: 12800 }], note: '异常：负值 −3600 + 同名单值重复记账（12800×2）' },
  'empty-one': { name: 'empty-one', count: 0, sum: 0, windows: ['W1'], items: [] },
  'locked-one': { name: 'locked-one', count: 1, sum: 900, windows: ['W1'], items: [{ index: 1, name: 'locked-item-1', value: 900 }], note: '只挡写，读可达' },
};

/** 子串歧义对：命中多个集合 → 唯一正确答案 = 澄清并给候选。 */
export const AMBIGUOUS_PREFIX: Readonly<Record<string, readonly string[]>> = {
  contoso: ['contoso-trade', 'contoso-logistics'],
  fabrikam: ['fabrikam-retail', 'fabrikam-wholesale'],
};

/** 「无法确认」的措辞信号（不可答题的正解形态）。 */
const UNANSWERABLE_SIGNALS: readonly string[] = ['无法确认', '需先查询', '需要先查', '没有查询', '尚未查询', '没查过', '未查过', '不确定', '无法回答', '需要查询'];

/** 澄清的措辞信号。 */
const CLARIFY_SIGNALS: readonly string[] = ['澄清', '是指', '哪一个', '哪一家', '哪个', '请问', 'confirm', '是否指', '具体是'];

/**
 * 事实判据：一个轮次的期望形态。
 *   · exact              —— 必须出现指定 count / sum / value 之一（present 集合，全满足才通过）；
 *   · unanswerable       —— 唯一正解是「无法确认/需先查询」；出现可疑编造数值即判负；
 *   · clarify            —— 唯一正解是澄清并给候选；硬答单值 = 判负；
 *   · session_value      —— 会话内约定事实（被纠正/被撤销/未完成/用户约束），必须含字面值。
 */
export type FactExpectation =
  | { readonly kind: 'exact'; readonly collection: string; readonly count?: number; readonly sum?: number; readonly value?: number; readonly forbid?: readonly number[] }
  | { readonly kind: 'unanswerable'; readonly collection: string; readonly window: string }
  | { readonly kind: 'clarify'; readonly prefix: string }
  | { readonly kind: 'session_value'; readonly value: string; readonly forbid?: readonly string[] };

/** 事实失败码（对齐预注册 §2.3 E-A/E-B/E-F 分区）。 */
export type FactFailureCode = 'E-A' | 'E-B' | 'E-F' | 'E-INCONCLUSIVE';

export interface FactVerdict {
  readonly pass: boolean;
  /** 失败/不确定归因码；pass=true 时为 null。 */
  readonly code: FactFailureCode | null;
  /** 机械证据（解析到的数值/信号），便于逐条复核。 */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** 解析回复里的全部十进制数值（去掉千分位；保留负号）。 */
export function parseNumbers(reply: string): number[] {
  const cleaned = reply.replace(/(?<=\d)[,_](?=\d{3}\b)/g, '');
  const matches = cleaned.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m)).filter((n) => Number.isFinite(n));
}

/**
 * 去掉「窗口码 / 期间码」形状的记号（`W9999` / `2025-10` / `202610` / `2026年`），
 * 供「不可答题不得出现编造金额」判定使用——否则回复复述窗口名会被误判为编造数值。
 * 只去**明显是编码**的形状，保留正常金额（如 2000 / 800）。
 */
export function stripCodeTokens(reply: string): string {
  return reply
    .replace(/W\d+/g, ' ')
    .replace(/\d{4}-\d{2}/g, ' ')
    .replace(/\d{4}年/g, ' ')
    .replace(/\b20\d{4}\b/g, ' ');
}

function hasSignal(reply: string, signals: readonly string[]): boolean {
  return signals.some((s) => reply.includes(s));
}

/**
 * 机械判定一次事实回答。tolerance = 0（禁四舍五入漂移，对齐预注册 §三 LS1）。
 * 无法机械定论的措辞 → `E-INCONCLUSIVE`（pass=false 但标记为「待判官」，不冒充产品失败）。
 */
export function judgeFactAnswer(expectation: FactExpectation, reply: string): FactVerdict {
  const text = reply ?? '';
  const nums = parseNumbers(text);
  if (expectation.kind === 'exact') {
    const required: number[] = [];
    if (expectation.count !== undefined) required.push(expectation.count);
    if (expectation.sum !== undefined) required.push(expectation.sum);
    if (expectation.value !== undefined) required.push(expectation.value);
    const missing = required.filter((r) => !nums.includes(r));
    const forbidden = (expectation.forbid ?? []).filter((f) => nums.includes(f));
    const pass = missing.length === 0 && forbidden.length === 0;
    if (pass) return { pass: true, code: null, evidence: { nums, required } };
    return { pass: false, code: 'E-A', evidence: { nums, required, missing, forbidden } };
  }
  if (expectation.kind === 'unanswerable') {
    const denied = hasSignal(text, UNANSWERABLE_SIGNALS);
    // 出现任何数值都可能是编造（先去掉窗口/期间编码形状，避免复述窗口名被误判）。
    const nums = parseNumbers(stripCodeTokens(text));
    const fabricated = nums.length > 0;
    if (denied && !fabricated) return { pass: true, code: null, evidence: { nums, denied } };
    return { pass: false, code: fabricated ? 'E-A' : 'E-INCONCLUSIVE', evidence: { nums, denied, fabricated } };
  }
  if (expectation.kind === 'clarify') {
    const candidates = AMBIGUOUS_PREFIX[expectation.prefix] ?? [];
    const mentionsAll = candidates.length > 0 && candidates.every((c) => text.includes(c));
    const asked = hasSignal(text, CLARIFY_SIGNALS);
    if (mentionsAll && asked) return { pass: true, code: null, evidence: { candidates, asked } };
    // 硬答单值（未澄清）— 只有出现数值且未澄清才算「硬答」。
    const hardAnswered = nums.length > 0 && !asked;
    return { pass: false, code: hardAnswered ? 'E-F' : 'E-INCONCLUSIVE', evidence: { candidates, mentionsAll, asked } };
  }
  // session_value：必须是字面匹配（含 forbid 字面出现即判负）。
  const normalized = text.replace(/\s+/g, '');
  const want = expectation.value.replace(/\s+/g, '');
  const present = normalized.includes(want);
  const forbidden = (expectation.forbid ?? []).some((f) => normalized.includes(f.replace(/\s+/g, '')));
  if (present && !forbidden) return { pass: true, code: null, evidence: { want } };
  return { pass: false, code: 'E-A', evidence: { want, present, forbidden } };
}

/** 会话内事实聚合：全对才判该会话事实保留（T1）通过（对齐预注册 §2.4，不拆独立样本）。 */
export function judgeSessionFacts(answers: readonly { readonly expectation: FactExpectation; readonly reply: string }[]): {
  readonly pass: boolean;
  readonly failures: readonly FactFailureCode[];
} {
  const failures: FactFailureCode[] = [];
  let allPass = true;
  for (const a of answers) {
    const v = judgeFactAnswer(a.expectation, a.reply);
    if (!v.pass) {
      allPass = false;
      if (v.code !== null) failures.push(v.code);
    }
  }
  return { pass: allPass, failures };
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务 Oracle = Task Registry 投影
// ─────────────────────────────────────────────────────────────────────────────

/** Task Registry 快照的可移植投影（Wave1 由真实 registry 投影而来，测试由假会话产生）。 */
export interface TaskView {
  readonly taskId: string;
  readonly taskNo?: number;
  readonly request: string;
  /** 原始事实（布尔）：启动 / 已停（结束事实或汇报/末条终态）/ 汇报 / 等待 / 可能还在跑。 */
  readonly started: boolean;
  readonly ended: boolean;
  readonly reported: boolean;
  readonly waiting: boolean;
  readonly mayBeRunning: boolean;
  /** 末条执行行 status 原值（如 completed/failed/refused/accepted）。 */
  readonly lastExecutionStatus?: string;
  readonly reason?: string;
  /** 本任务的执行调用 requestId 清单（H3 重复执行检测）。 */
  readonly requestIds: readonly string[];
}

/** 任务事实标签（判据用；`exec:<status>` = 末条执行行 status 原值）。 */
export type TaskFactLabel = 'progressing' | 'waiting' | 'stopped' | 'reported';

/** 某任务是否具备给定事实（纯函数；不读/不造任务级状态词/种类）。 */
export function taskHasFact(task: TaskView, label: TaskFactLabel | string): boolean {
  switch (label) {
    case 'progressing': return task.mayBeRunning;
    case 'waiting': return task.waiting;
    case 'stopped': return task.ended && !task.reported;
    case 'reported': return task.reported;
    default:
      return label.startsWith('exec:') && `exec:${task.lastExecutionStatus ?? ''}` === label;
  }
}

/** 任务已办成（机械事实：汇报存档 或 末条执行 completed）。 */
export function taskIsDone(task: TaskView): boolean {
  return task.reported || task.lastExecutionStatus === 'completed';
}

/** 任务失败（事实：已停且无汇报，或末条执行 failed/refused——不判「为什么停」）。 */
export function taskIsFailed(task: TaskView): boolean {
  if (task.lastExecutionStatus === 'failed' || task.lastExecutionStatus === 'refused') return true;
  return task.ended && !task.reported && !task.mayBeRunning;
}

/** 任务未启动排队（未启动、未停、无汇报/提问）。 */
export function taskIsUnstarted(task: TaskView): boolean {
  return !task.started && !task.ended && !task.reported && !task.waiting;
}

/** 任务事实的紧凑文本（证据 detail 用；只拼机械事实，不造任务级状态词）。 */
export function taskFactBrief(task: TaskView): string {
  return [task.started ? 'started' : 'unstarted', task.ended ? 'ended' : 'active', task.reported ? 'reported' : '-', task.waiting ? 'waiting' : '-', task.mayBeRunning ? 'may-run' : '-', task.lastExecutionStatus ?? '-'].join('/');
}

/** 任务的机械事实签名（用于「旧任务未被改写」比对；只含事实，无状态词）。 */
export function taskFactSignature(task: TaskView): string {
  return JSON.stringify([task.started, task.ended, task.reported, task.waiting, task.mayBeRunning, task.lastExecutionStatus ?? null]);
}
export interface TaskTurnFact {
  readonly turn: number;
  readonly tasks: readonly TaskView[];
  /** 该轮 Main 回复文本（H5 取消虚假回执：文本声称已取消但未调 task_cancel）。 */
  readonly reply?: string;
  /** 该轮机械上是否调用了 task_cancel。 */
  readonly cancelCalled?: boolean;
}

/** 任务失败码（对齐预注册 §2.3 E-D/E-G 分区；H3/H4/H5 为硬零子集）。 */
export type TaskFailureCode = 'E-D' | 'E-G' | 'H3' | 'H4' | 'H5';

export interface TaskVerdict {
  readonly pass: boolean;
  readonly codes: readonly TaskFailureCode[];
  readonly hardZeroHits: readonly TaskFailureCode[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

const HARD_ZERO_TASK_CODES: ReadonlySet<TaskFailureCode> = new Set(['H3', 'H4', 'H5']);

/**
 * 判定任务连续性：跨全部轮次检查机械硬零 + 编号/结果不混淆。
 *   · H3 重复执行 —— 同一 requestId 在**全批**出现 >1 次；
 *   · H4 虚假完成 —— 终态 completed 却 requestIds 为空（未发起任何执行）；
 *   · H5 取消虚假回执 —— 某轮回复声称「已取消」但该轮 cancelCalled=false（且无已取消任务底账）；
 *   · E-G 编号混淆 —— 同一 taskNo 映射到不同 taskId。
 */
export function judgeTaskContinuity(turns: readonly TaskTurnFact[]): TaskVerdict {
  const codes: TaskFailureCode[] = [];
  const evidence: Record<string, unknown> = {};

  // H3：同一 requestId 只能归属唯一 taskId（逐轮快照会重复同一任务，故按 (taskId,requestId) 去重）。
  const requestOwners = new Map<string, Set<string>>();
  for (const t of turns) {
    for (const task of t.tasks) {
      for (const rid of task.requestIds) {
        const owners = requestOwners.get(rid) ?? new Set<string>();
        owners.add(task.taskId);
        requestOwners.set(rid, owners);
      }
    }
  }
  const dupRequest = [...requestOwners.entries()].filter(([, owners]) => owners.size > 1).map(([r]) => r);
  if (dupRequest.length > 0) { codes.push('H3'); evidence['dupRequestIds'] = dupRequest; }

  // H4：汇报存档却零执行（虚假完成）。
  const falseCompleted: string[] = [];
  for (const t of turns) {
    for (const task of t.tasks) {
      if (task.reported && task.requestIds.length === 0) falseCompleted.push(task.taskId);
    }
  }
  if (falseCompleted.length > 0) { codes.push('H4'); evidence['falseCompleted'] = falseCompleted; }

  // H5：取消虚假回执。
  const falseCancel: number[] = [];
  for (const t of turns) {
    const claims = (t.reply ?? '').includes('已取消') || (t.reply ?? '').includes('已经取消');
    // 「已停且无汇报」是取消的可得事实代理（任务行不存取消种类）。
    const hasStopped = t.tasks.some((task) => task.ended && !task.reported);
    if (claims && t.cancelCalled !== true && !hasStopped) falseCancel.push(t.turn);
  }
  if (falseCancel.length > 0) { codes.push('H5'); evidence['falseCancelTurns'] = falseCancel; }

  // E-G：taskNo 混淆（同编号不同 taskId）。
  const noToId = new Map<number, Set<string>>();
  for (const t of turns) {
    for (const task of t.tasks) {
      if (task.taskNo === undefined) continue;
      const set = noToId.get(task.taskNo) ?? new Set<string>();
      set.add(task.taskId);
      noToId.set(task.taskNo, set);
    }
  }
  const confused = [...noToId.entries()].filter(([, ids]) => ids.size > 1).map(([no]) => no);
  if (confused.length > 0) { codes.push('E-G'); evidence['confusedTaskNos'] = confused; }

  const hardZeroHits = codes.filter((c) => HARD_ZERO_TASK_CODES.has(c));
  return { pass: codes.length === 0, codes, hardZeroHits, evidence };
}

/** 任务事实覆盖（LS2）：某会话内观测到的机械事实标签集合（运行/等待/已停无汇报/已汇报/执行事实）。 */
export function coveredTaskFacts(turns: readonly TaskTurnFact[]): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const t of turns) {
    for (const task of t.tasks) {
      if (task.mayBeRunning) seen.add('progressing');
      if (task.waiting) seen.add('waiting');
      if (task.ended && !task.reported) seen.add('stopped');
      if (task.reported) seen.add('reported');
      if (task.lastExecutionStatus !== undefined) seen.add(`exec:${task.lastExecutionStatus}`);
    }
  }
  return seen;
}
