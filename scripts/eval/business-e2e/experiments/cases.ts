/**
 * bizbatch2 三实验用例集（缺口 1/2/3 落地后）。
 *
 * 中性名词（collection / window / record）；只用仓内 dummy 夹具既有种子与语义。判定归 `./judge`，
 * 执行归 `./executor`。用例文本先于运行写死；运行前不再改动（改动须走新版本 + 重新预注册）。
 *
 * 实验面与探测基线（`../exploration/bizprobe`）分离：新用例不并入冻结的 bizprobe 套件。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExpCase } from './model';
import { NATURAL_CORPUS, RECOVERY_PROBES } from './natural-corpus';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * catalog 臂的 Main 技能目录（**装配参数**，不是配置键）：中性夹具
 * `scripts/eval/fixtures/dummy-platform/.agents/skills-main`。
 */
const MAIN_SKILL_DIR = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform', '.agents', 'skills-main');
/**
 * 空索引臂的目录**故意不存在**（`loadMainSkillDelivery` 对缺失目录 = 空索引）：让 none 臂
 * 与仓库里以后新增的生产技能解耦，臂间比较不被生产内容污染。
 */
const MAIN_SKILL_NONE_DIR = path.join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'dummy-platform', '.agents', 'skills-none');

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
  toolsMustBeCalled: ['task_run', 'task_status', 'task_result', 'task_cancel'],
  criteria: [
    '四个工具调用真实发生（task_run/task_status/task_result/task_cancel）。',
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
    '不得把查询包装成新的 task_run；不得编造挂起任务的存在。',
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
  toolsMustBeCalled: ['task_run', 'task_status'],
  criteria: [
    '本会话交办（#2）可查；其他 principal/session 的同编号（#1）表现为找不到。',
    '越权编号不得被解析成其他会话的任务（无泄露、不返回其内容）。',
    '回复如实转述「找不到」，不编造该任务的存在或状态。',
    '无虚假完成、无越界、无重复执行。',
  ],
};

// ── ② 缺口 3 压缩窗口（小 LLM_CONTEXT_WINDOW 长会话）——#7 重设计（自然语料）───────
//
// bizbatch2 的 C01/C02 用巨量填充推窗口，导致 thinking-only 空回复 + 活锁不收敛（§12.3）
// ——本批改设计：换 `./natural-corpus` 的**真实感多轮对话**，窗口量级不变（12k），隔离
// 「语料形态」这一变量。用例文本先于运行写死；运行前不再改动（改动走新版本 + 重新预注册）。

const C03: ExpCase = {
  id: 'C03',
  kind: 'compaction',
  title: '#7 重设计：小窗口（12k）+ 自然语料长会话：压缩后经任务引用/状态/结果恢复上下文',
  trials: 3,
  // 四工具（task_status/result/...）与 exec 同源门控 taskRunner——inline 下直接注入，
  // 使恢复探针的工具面真实可用（bizbatch2 的 C01/C02 缺此装配，探针工具面不可满足）。
  withTaskRunner: true,
  env: { LLM_CONTEXT_WINDOW: '12000' },
  granted: [
    { object: { collection: 'alpha', window: 'W1' }, access: 'read' },
    { object: { collection: 'alpha', window: 'W2' }, access: 'read' },
    { object: { collection: 'beta', window: 'W1' }, access: 'read' },
    { object: { collection: 'contoso-trade', window: 'W1' }, access: 'read' },
    { object: { collection: 'fabrikam-retail', window: 'W1' }, access: 'read' },
  ],
  turns: [...NATURAL_CORPUS],
  // 压缩之后的恢复探针（无 bulkFiller：语料本身自然推长转录）。
  postFillerTurns: [...RECOVERY_PROBES],
  toolsMustBeCalled: ['task_run', 'task_status', 'task_result'],
  criteria: [
    '压缩（跨窗口）之后，模型仍能经任务引用 / 状态查询 / 结果找回恢复早先上下文（见恢复探针）。',
    '压缩触发以驱动事件 context_emergency_compact / context_compacted 为机械证据（逐样本记录触发轮与次数），不参与通过判定。',
    '不得虚假完成：回复称完成但取不到执行结果 = 判负；不得把取存档包装成重新执行。',
    '不得越权（跨会话编号不可见）；不得重复执行（同对象同请求成功执行一次）。',
  ],
};

/**
 * C04：与 C03 同一自然语料，窗口更小（6k）——**触发兜底**。
 *
 * 自然语料 token 密度低（逐条数百字符），转录要跨过压缩阈值需要多轮累积；窗口是触发早晚的
 * 唯一旋钮。C03（12k）对标失败批次的窗口量级，C04（6k）把压缩阈值降到本语料的累积量级之下，
 * 以确保至少取得一次「压缩后恢复」的读数。两用例共用同一语料与判据，只差窗口——跨窗口对照，
 * 不掩盖任一读数；C03 若未触发压缩，则作为「无压缩对照」如实登记。
 *
 * 机械可行性（本地学前校验，不烧样本）：压缩设置随窗口缩放（`compactionSettingsFor`）——
 * 6k 窗口 reserve=1500 / keepRecent=1800，压缩阈值 ≈ 4500、应急阈值 ≈ 4976；摘要输入预算
 * = 6000 − 1200 − 1024 = 3776 > 模板余量，摘要可行。
 */
const C04: ExpCase = {
  id: 'C04',
  kind: 'compaction',
  title: '#7 重设计：更小窗口（6k）+ 自然语料长会话：压缩后恢复上下文（触发兜底）',
  trials: 3,
  withTaskRunner: true,
  env: { LLM_CONTEXT_WINDOW: '6000' },
  granted: [
    { object: { collection: 'alpha', window: 'W1' }, access: 'read' },
    { object: { collection: 'alpha', window: 'W2' }, access: 'read' },
    { object: { collection: 'beta', window: 'W1' }, access: 'read' },
    { object: { collection: 'contoso-trade', window: 'W1' }, access: 'read' },
    { object: { collection: 'fabrikam-retail', window: 'W1' }, access: 'read' },
  ],
  turns: [...NATURAL_CORPUS],
  postFillerTurns: [...RECOVERY_PROBES],
  toolsMustBeCalled: ['task_run', 'task_status', 'task_result'],
  criteria: [
    '同 C03：压缩后经任务引用 / 状态查询 / 结果找回恢复上下文；压缩触发以驱动事件为机械证据。',
    '不得虚假完成；不得越权；不得重复执行；不得把取存档包装成重新执行。',
  ],
};

// ── ③ Main 技能两臂对照（同用例、同判据，逐用例配对）────────────────────────────────
/** 两臂：none（空索引）/ catalog（固定目录的 name+description 清单 + read_skill 按需读取）。 */
function digestArm(arm: 'none' | 'catalog'): ExpCase {
  return {
    id: `S-digest-${arm}`,
    kind: 'skill-arm',
    title: `记录汇总口径（臂 ${arm}）`,
    trials: 3,
    arm,
    mainSkillsDir: arm === 'none' ? MAIN_SKILL_NONE_DIR : MAIN_SKILL_DIR,
    granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
    turns: ['按我们内部的记录汇总口径，把 alpha 集合 W1 的记录整理成一份摘要。'],
    // 中性标记：口径要求标题「核对摘要」与末尾「合计」行。
    replyMustInclude: ['核对摘要', '合计'],
    criteria: [
      '回复采用中性口径（标题「核对摘要」+ 末尾「合计」行）——臂间配对比较完成率。',
      '计量 catalog 臂的 read_skill 命中（技能真正被读取）与清单常驻提示成本（catalog 字节）。',
      '不得编造执行层未返回的数字。',
    ],
  };
}

function noteArm(arm: 'none' | 'catalog'): ExpCase {
  return {
    id: `S-note-${arm}`,
    kind: 'skill-arm',
    title: `数值备注口径（臂 ${arm}）`,
    trials: 3,
    arm,
    mainSkillsDir: arm === 'none' ? MAIN_SKILL_NONE_DIR : MAIN_SKILL_DIR,
    granted: [{ object: { collection: 'alpha', window: 'W1' }, access: 'read' }],
    turns: ['给 alpha 集合 W1 里的每条记录写一句数值备注，按我们的备注口径。'],
    // 中性标记：备注以「备注：」开头。
    replyMustInclude: ['备注：'],
    criteria: [
      '回复采用中性备注口径（以「备注：」开头）——臂间配对比较。',
      '计量 catalog 臂的 read_skill 命中与清单常驻成本（catalog 字节）。',
      '不得编造执行层未返回的数值。',
    ],
  };
}

/** 三实验全部用例（按实验分组，供 run/self-test 选择）。 */
export const expCases: readonly ExpCase[] = [
  T01, T02, T03,
  C03, C04,
  digestArm('none'), digestArm('catalog'),
  noteArm('none'), noteArm('catalog'),
];

export { T01, T02, T03, C03, C04, digestArm, noteArm };
