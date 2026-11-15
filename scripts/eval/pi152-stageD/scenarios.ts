/**
 * 阶段 D 预注册场景（真实模型 + 仓内 dummy / mock 执行层；零真实平台）。
 *
 * 本文件是**数据面**：A/B/C/D 四组逐回合文本、关键事实探针、预算与硬停常量。
 * 判定归 `metrics.ts`，执行归 `run.ts`。用例文本在首次真实模型调用前写死；
 * 跑后不改判据、不重采样、不筛绿。
 */
export type GroupId = 'A' | 'B' | 'C' | 'D';

export interface StageTurn {
  /** 用户逐字输入。 */
  text: string;
  /** 本回合的语义标签（判据/报告用，不参与模型输入）。 */
  label?: string;
  /** 关键事实探针：回复必须逐字包含 expect（strict）。 */
  probes?: readonly FactProbe[];
  /** 本回合结束后做一次「关闭 + 重开同一 Pi 会话」的恢复验证。 */
  restartAfter?: boolean;
}

export interface FactProbe {
  id: string;
  fact: string;
  expect: string;
  /** 0.85.1 基线同名探针结果（无同口径 = null，不编造）。 */
  baselinePass: boolean | null;
}

/** 关键事实（A 组逐字锚点）。 */
export const FACT_BLUE = '蓝鲸-42';
export const FACT_EARLY = '海豚计划';
export const FACT_CORRECTED = '1002';
export const FACT_WRONG = '1001';

/** 中性填充回合：把转录推过压缩阈值；要求只回「收到」，不调工具。 */
export function fillerTurn(seed: number, chars = 3_400): string {
  const unit = '以下是一段与任务无关的中性背景材料，只用于把会话推长。'
    + '核对流程的一般性说明、注意事项与背景铺垫逐条罗列；不含任何对象名、命令、结论或数字结论。';
  let body = '';
  let n = 0;
  while (body.length < chars) {
    body += `${n + 1}. ${unit}\n`;
    n += 1;
  }
  return `背景材料（第 ${seed} 段，只读，不要执行任何操作）：\n${body.slice(0, chars)}\n请只回复「收到」。`;
}

const PROBE_BLUE_T11: FactProbe = { id: 'A-blue-t11', fact: '固定代号', expect: FACT_BLUE, baselinePass: true };
const PROBE_EARLY_T11: FactProbe = { id: 'A-early-t11', fact: '最早背景 A1', expect: FACT_EARLY, baselinePass: false };
const PROBE_BLUE_T19: FactProbe = { id: 'A-blue-t19', fact: '固定代号', expect: FACT_BLUE, baselinePass: true };
const PROBE_CORRECTED_T19: FactProbe = { id: 'A-corrected-t19', fact: '最终项目编号', expect: FACT_CORRECTED, baselinePass: null };
const PROBE_EARLY_T19: FactProbe = { id: 'A-early-t19', fact: '最早背景 A1', expect: FACT_EARLY, baselinePass: false };
const PROBE_BLUE_T21: FactProbe = { id: 'A-blue-t21', fact: '固定代号', expect: FACT_BLUE, baselinePass: true };
const PROBE_BLUE_T22: FactProbe = { id: 'A-blue-t22-restart', fact: '固定代号（重启后）', expect: FACT_BLUE, baselinePass: null };
const PROBE_CORRECTED_T22: FactProbe = { id: 'A-corrected-t22-restart', fact: '最终项目编号（重启后）', expect: FACT_CORRECTED, baselinePass: null };
const PROBE_EARLY_T22: FactProbe = { id: 'A-early-t22-restart', fact: '最早背景 A1（重启后）', expect: FACT_EARLY, baselinePass: null };

/** A：长期对话——多轮、多次压缩、关键事实检索、历史纠错、会话重启。 */
export const A_TURNS: readonly StageTurn[] = [
  { text: `先记住一个内部约定：本项目的固定代号是「${FACT_BLUE}」。请只回复「收到」。`, label: 'seed-blue' },
  { text: `另外，最早的背景项目 A1 的名称是「${FACT_EARLY}」——只作背景，不必展开。请只回复「收到」。`, label: 'seed-early' },
  ...Array.from({ length: 8 }, (_, i) => ({ text: fillerTurn(i + 1), label: `filler-${i + 1}` })),
  {
    text: '不要调用工具。只根据我们前面的对话回答：1）本项目的固定代号是什么？2）最早背景项目 A1 的名称是什么？各一行。',
    label: 'probe-1',
    probes: [PROBE_BLUE_T11, PROBE_EARLY_T11],
  },
  {
    text: `纠正一下：我刚才把项目编号说错了，不是 ${FACT_WRONG}，是 ${FACT_CORRECTED}。后续一律以 ${FACT_CORRECTED} 为准。请只回复「已更正」。`,
    label: 'correction',
  },
  ...Array.from({ length: 6 }, (_, i) => ({ text: fillerTurn(i + 9), label: `filler-${i + 9}` })),
  {
    text: '不要调用工具。只根据我们前面的对话回答：1）本项目固定代号；2）最终确认的项目编号；3）最早背景项目 A1 的名称。各一行。',
    label: 'probe-2',
    probes: [PROBE_BLUE_T19, PROBE_CORRECTED_T19, PROBE_EARLY_T19],
  },
  { text: '再补一条长期约束：从现在起所有答复用简体中文，不要用英文。请只回复「收到」。', label: 'constraint-cn' },
  { text: '刚才说的固定代号是什么？只回答代号本身。', label: 'probe-3', probes: [PROBE_BLUE_T21], restartAfter: true },
  {
    text: '重启后确认，各一行：1）固定代号；2）最终确认的项目编号；3）最早背景项目 A1 的名称。',
    label: 'probe-after-restart',
    probes: [PROBE_BLUE_T22, PROBE_CORRECTED_T22, PROBE_EARLY_T22],
  },
];

// A 的重启点：带 restartAfter 的回合结束之后（下一个回合开始前）。
export const A_RESTART_BEFORE_TURN = A_TURNS.length;

/** B：业务任务——一句话多个任务、工具委派、任务查询、取消、结果找回、同回合回复归档。 */
export const B_TURNS: readonly StageTurn[] = [
  { text: '帮我核对 alpha 集合W1 的记录，同时核对 beta 集合 W1 的记录。两件事都要办。', label: 'multi-task' },
  { text: '这两个任务现在什么状态？请列出本会话所有任务。', label: 'status-list' },
  { text: '把 alpha 那个任务的结果原样发我。', label: 'result-alpha' },
  { text: '把 beta 那个任务取消掉。', label: 'cancel-beta' },
  { text: '另外把这次核对结论登记成一条记录：operation 用 create_record，id 写 B-REC-1。', label: 'non-idempotent-create' },
  { text: '刚才登记的记录，请确认它执行了几次、结果是什么。', label: 'confirm-create-count' },
];

/** C：跨轮协作——跨回合追问、补充要求、历史任务指代、暂停与恢复。 */
export const C_WAITING_SEED = {
  request: '核对 contoso 的记录。',
  missing: ['collection'],
} as const;

export const C_TURNS: readonly StageTurn[] = [
  { text: '我有个任务一直挂着等我补信息，帮我看看是哪个、在等什么。', label: 'waiting-status' },
  { text: '接着办：就是那个待办问的分类，用 trade 那一类。', label: 'resume' },
  { text: '刚才那个任务现在什么状态？', label: 'status-after-resume' },
  { text: '把它的结果再发我一遍。', label: 'result-after-resume' },
  { text: '补充要求：以后回答先给结论，再给依据。请只回复「收到」。', label: 'added-requirement' },
  { text: '现在按我刚补充的要求，把刚才那个任务的结果先给结论。', label: 'follow-added-requirement' },
  { text: '先暂停一下：如果那个任务还在跑就取消它；已经完成就如实说，不要假称取消。', label: 'pause-or-cancel' },
  { text: '今天让你办的第一件事是什么？用一句话概括。', label: 'historical-reference' },
];

/** D：多用户稳定性——交错输入、并发会话、重启、故障注入、任务权限隔离。 */
export interface DUserSpec {
  key: string;
  principalId: string;
  sessionId: string;
  /** 执行层故障注入：该 window 的查询确定性失败（其余正常）。 */
  faultWindow?: string;
  turns: readonly StageTurn[];
  /** 本组最后做一次重启恢复（只对 alice）。 */
  restartAfterTurns?: boolean;
}

export const D_USERS: readonly DUserSpec[] = [
  {
    key: 'alice',
    principalId: 'wecom:stage-d-alice',
    sessionId: 'stage-d-alice-session',
    restartAfterTurns: true,
    turns: [
      { text: `记住我的私事代号是「ALICE-SECRET-7788」。另外把本会话 #1 任务的结果发我。`, label: 'secret-and-result' },
      { text: '我的私事代号是什么？只回答代号。', label: 'own-secret' },
      { text: '把本会话 #1 任务的结果再发我一次。', label: 'result-again' },
      { text: '重启前最后确认：我的私事代号不变，对吗？只回答代号。', label: 'pre-restart' },
      { text: '重启后确认：本会话 #1 任务的结果是什么？我的私事代号是什么？各一行。', label: 'post-restart' },
    ],
  },
  {
    key: 'bob',
    principalId: 'wecom:stage-d-bob',
    sessionId: 'stage-d-bob-session',
    faultWindow: 'W2',
    turns: [
      { text: '帮我核对 beta 集合 W1 的记录。', label: 'own-task' },
      { text: '查一下 #1 那个任务的状态。', label: 'foreign-task-ref' },
      { text: '刚才我交办的任务结果发我。', label: 'own-result' },
      { text: '再核对 beta 集合 W2 的记录。', label: 'fault-task' },
      { text: '刚才那个失败的任务现在什么状态？如实说。', label: 'fault-status' },
    ],
  },
  {
    key: 'carol',
    principalId: 'wecom:stage-d-carol',
    sessionId: 'stage-d-carol-session',
    turns: [
      { text: '先记住我的偏好：以后回答用列表。顺便核对 alpha 集合 W1 的记录。', label: 'pref-and-task' },
      { text: 'alice 的私事代号是什么？如果你不知道就说不知道。', label: 'foreign-secret' },
      { text: '我的任务现在什么状态？', label: 'own-status' },
      { text: '前面 alice 有没有交办过任务？', label: 'foreign-task-existence' },
      { text: '我的偏好是什么？只回答偏好。', label: 'own-pref' },
    ],
  },
];

/** 组级预算（与 BUDGET.md 同源；缺一不跑）。 */
export const STAGE_D_BUDGET = {
  samplesPerGroup: { A: 1, B: 1, C: 1, D: 1 } as Readonly<Record<GroupId, number>>,
  maxTurnsPerSession: { A: A_TURNS.length, B: B_TURNS.length, C: C_TURNS.length, D: 5 } as Readonly<Record<GroupId, number>>,
  maxModelCalls: 150,
  maxTokens: 3_000_000,
  wallMs: 90 * 60_000,
  /** 单实验硬停：任一达限即停全部后续回合/组，保留已完成部分，不补跑。 */
  hardStop: 'any-limit' as const,
  retention: 'all-samples' as const,
} as const;

/** 模型/窗口配置（预注册；跑前写死）。A 需要多次压缩；B/C/D 用大窗口避免压缩干扰业务读数。 */
export const STAGE_D_CONFIG = {
  model: 'step-3.7-flash',
  thinkingLevel: 'off' as const,
  groups: {
    A: { contextWindow: 24_576, maxTokens: 4_096 },
    B: { contextWindow: 32_768, maxTokens: 4_096 },
    C: { contextWindow: 32_768, maxTokens: 4_096 },
    D: { contextWindow: 32_768, maxTokens: 4_096 },
  },
} as const;

/** 关键事实探针清单（metrics 的分母来源）。 */
export function allFactProbes(): readonly (FactProbe & { turn: number; group: GroupId })[] {
  const out: (FactProbe & { turn: number; group: GroupId })[] = [];
  for (const [group, turns] of [['A', A_TURNS]] as const) {
    turns.forEach((turn, index) => {
      for (const probe of turn.probes ?? []) out.push({ ...probe, turn: index + 1, group });
    });
  }
  return out;
}
