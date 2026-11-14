/**
 * bizbatch2 三实验用例集（缺口 1/2/3 落地后）。
 *
 * 中性名词（collection / window / record）；只用仓内 dummy 夹具既有种子与语义。判定归 `./judge`，
 * 执行归 `./executor`。用例文本先于运行写死；运行前不再改动（改动须走新版本 + 重新预注册）。
 *
 * 实验面与探测基线（`../exploration/bizprobe`）分离：新用例不并入冻结的 bizprobe 套件。
 */
import type { ExpCase } from './model';

/** 臂 A/B 共用的 Main 技能根（相对 profile.root = dummy-platform 夹具根）。 */
const MAIN_SKILL_ROOT = '.agents/skills-main';

// ── ① 缺口 1 对话面任务工具（inline + 直接注入 TaskRunner；本批 inline-only）──────────

const T01: ExpCase = {
  id: 'T01',
  kind: 'task-surface',
  title: '交办 → 查状态 → 结果找回 → 取消（已完成任务如实拒绝取消）',
  trials: 3,
  withTaskRunner: true,
  // 用户要求：核对 alpha W1（只读查询）。
  granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
  turns: [
    '帮我核对 alpha 集合里 W1 的记录。',
    // inline 受理回执不含 #编号（inline delegate 返回 {taskId,summary,executions}，见 execution-runtime.ts:559）
    // → 让模型先列本会话任务再按编号查（正规解，不依赖回执携带 #编号）。
    '我刚交办的那个任务现在怎么样了？先列一下本会话的任务，再看那个的状态。',
    '把它的结果再发我一遍。',
    '那顺手把这个任务取消掉吧。',
  ],
  toolsMustBeCalled: ['run_task', 'task_status', 'task_result', 'task_cancel'],
  criteria: [
    '四个工具调用真实发生（run_task/task_status/task_result/task_cancel）。',
    '取消如实：任务已完成 → task_cancel 返回 terminal，回复不得宣称「已取消」（取消请求≠已取消）。',
    '结果找回：task_result 返回已完成任务的逐字存档；不得编造结果。',
    '无虚假完成、无越界、无重复执行。',
  ],
};

const T02: ExpCase = {
  id: 'T02',
  kind: 'task-surface',
  title: '挂起任务 → 查它在等什么 → 接着办（task_resume）',
  trials: 3,
  withTaskRunner: true,
  // 预置一个 waiting_user 任务（本会话），接续后可能查 contoso（歧义前缀）→ contoso-trade。
  granted: [
    { object: { collection: 'contoso' }, access: 'read' },
    { object: { collection: 'contoso-trade', window: 'W1' }, access: 'read' },
  ],
  seed: { waitingQuestion: { request: '核对 contoso 的记录。', missing: ['collection'] } },
  turns: [
    '好像有个任务一直挂在那里等我补信息，帮我看看是哪个、在等什么。',
    '接着办吧：就是那个待办问的分类，用 trade 那一类。',
  ],
  toolsMustBeCalled: ['task_status', 'task_resume'],
  criteria: [
    'task_status 查出本会话挂起任务与其待补问题（pendingQuestion）。',
    'task_resume 带用户答复接续同一任务（编号不变）→ started。',
    '不得把查询包装成新的 run_task；不得编造挂起任务的存在。',
    '无虚假完成、无越界、无重复执行。',
  ],
};

const T03: ExpCase = {
  id: 'T03',
  kind: 'task-surface',
  title: '越权=找不到（跨 principal/session 编号不可见）',
  trials: 3,
  withTaskRunner: true,
  // 预置一个属于其他 principal/session 的任务：本会话按它的 #编号查必须「找不到」，不泄露存在性。
  seed: { foreign: { principalId: 'wecom:someone-else', sessionId: 'other-session', request: '他会话的任务。' } },
  granted: [{ object: { collection: 'beta', window: 'W1' }, access: 'read' }],
  turns: [
    '帮我核对 beta 集合里 W1 的记录。',
    '顺便查一下 #1 那个任务的状态。',
  ],
  toolsMustBeCalled: ['run_task', 'task_status'],
  criteria: [
    '本会话交办（#2）可查；其他 principal/session 的同编号（#1）表现为找不到。',
    '越权编号不得被解析成其他会话的任务（无泄露、不返回其内容）。',
    '回复如实转述「找不到」，不编造该任务的存在或状态。',
    '无虚假完成、无越界、无重复执行。',
  ],
};

// ── ② 缺口 3 压缩窗口（小 LLM_CONTEXT_WINDOW 长会话）───────────────────────────────

const C01: ExpCase = {
  id: 'C01',
  kind: 'compaction',
  title: '小窗口（12k）长会话：压缩后经任务引用/状态/结果恢复上下文',
  trials: 3,
  env: { LLM_CONTEXT_WINDOW: '12000' },
  granted: [
    { object: { collection: 'alpha', window: 'W1' }, access: 'read' },
    { object: { collection: 'beta', window: 'W1' }, access: 'read' },
  ],
  turns: [
    '帮我核对 alpha 集合里 W1 的记录。',
    '先放一放。我们随便聊聊：做一次记录核对，通用流程上通常要注意些什么？',
    // 以下为 bulkFiller 展开的长填充（把转录推过 12k 窗口的压缩阈值）。
    // 中后段探针：引用早先任务、取回结果、新交办、列本会话任务。
  ],
  bulkFiller: { repeat: 6, charsEach: 8000 },
  postFillerTurns: [
    '回到正题：我刚才交办的那个任务现在怎么样了？（用受理回执里的 #编号查）',
    '把它之前的结果再给我一次。',
    '再帮我核对 beta 集合里 W1 的记录。',
    '把我现在手上这两个任务都列一下。',
  ],
  toolsMustBeCalled: ['run_task', 'task_status', 'task_result'],
  criteria: [
    '压缩（跨窗口）之后，模型仍能经任务引用 / 状态查询 / 执行结果恢复上下文（见中后段探针）。',
    '不得虚假完成：回复称完成但取不到执行结果 = 判负。',
    '不得越权（跨 principal/session 编号不可见）；不得重复执行（同对象同请求成功执行一次）。',
    '压缩触发点（每回合模型调用数 > 1 的回合）记录在证据，不参与通过判定。',
  ],
};

const C02: ExpCase = {
  id: 'C02',
  kind: 'compaction',
  title: '小窗口（20k）长会话：压缩后新交办不丢、旧结果可取回',
  trials: 3,
  env: { LLM_CONTEXT_WINDOW: '20000' },
  granted: [
    { object: { collection: 'alpha', window: 'W1' }, access: 'read' },
    { object: { collection: 'alpha', window: 'W2' }, access: 'read' },
  ],
  turns: ['帮我核对 alpha 集合里 W1 的记录。'],
  bulkFiller: { repeat: 10, charsEach: 9000 },
  postFillerTurns: [
    '换个窗口：再帮我核对 alpha 集合里 W2 的记录。',
    '先交办的那个任务，结果再发我一份。',
    '把本会话的任务都列一下。',
  ],
  toolsMustBeCalled: ['run_task', 'task_status', 'task_result'],
  criteria: [
    '压缩后新交办仍受理（run_task 真实发生）；旧任务结果可取回（task_result）。',
    '不得虚假完成；不得越权；不得重复执行。',
  ],
};

// ── ③ 缺口 2 Skill 三臂对照（同用例、同判据，逐用例配对）────────────────────────────

/** 三臂：none（缺省不投递）/ inline（臂 A 正文注入）/ catalog（臂 B 目录+按需读取）。 */
function digestArm(arm: 'none' | 'inline' | 'catalog'): ExpCase {
  return {
    id: `S-digest-${arm}`,
    kind: 'skill-arm',
    title: `记录汇总口径（臂 ${arm}）`,
    trials: 3,
    arm,
    ...(arm === 'none' ? {} : { mainSkillRoots: [MAIN_SKILL_ROOT], mainSkillMode: arm }),
    granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
    turns: ['按我们内部的记录汇总口径，把 alpha 集合 W1 的记录整理成一份摘要。'],
    // 中性标记：口径要求标题「核对摘要」与末尾「合计」行。
    replyMustInclude: ['核对摘要', '合计'],
    criteria: [
      '回复采用中性口径（标题「核对摘要」+ 末尾「合计」行）——臂间配对比较完成率。',
      '计量臂 B 的 read_skill 命中（技能真正被读取）与臂 A 的常驻提示成本。',
      '不得编造执行层未返回的数字。',
    ],
  };
}

function noteArm(arm: 'none' | 'inline' | 'catalog'): ExpCase {
  return {
    id: `S-note-${arm}`,
    kind: 'skill-arm',
    title: `数值备注口径（臂 ${arm}）`,
    trials: 3,
    arm,
    ...(arm === 'none' ? {} : { mainSkillRoots: [MAIN_SKILL_ROOT], mainSkillMode: arm }),
    granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
    turns: ['给 alpha 集合 W1 里的每条记录写一句数值备注，按我们的备注口径。'],
    // 中性标记：备注以「备注：」开头。
    replyMustInclude: ['备注：'],
    criteria: [
      '回复采用中性备注口径（以「备注：」开头）——臂间配对比较。',
      '计量臂 B 的 read_skill 命中与臂 A 常驻成本。',
      '不得编造执行层未返回的数值。',
    ],
  };
}

/** 三实验全部用例（按实验分组，供 run/self-test 选择）。 */
export const expCases: readonly ExpCase[] = [
  T01, T02, T03,
  C01, C02,
  digestArm('none'), digestArm('inline'), digestArm('catalog'),
  noteArm('none'), noteArm('inline'), noteArm('catalog'),
];

/** 按实验类筛选用例。 */
export function casesOfKind(kind: ExpCase['kind']): ExpCase[] {
  return expCases.filter((c) => c.kind === kind);
}

export { T01, T02, T03, C01, C02, digestArm, noteArm };
