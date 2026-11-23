/**
 * P2 业务端到端验收 · 七场景落成（预注册 `docs/history/business-e2e-batch2-prereg.md` §一 逐项）。
 *
 * 每个场景 = 一个 `P2CaseDefinition`（话术 / 装配旋钮 / 真值 / 硬零 / 覆盖 / 特判）
 * + 一个确定性跑法（假模型 + 仓内 dummy 执行层；零真实平台、零真实写）。
 *
 * 复用（不重建框架）：`./p2-harness`（生产同源 createServer + 脚本化 provider +
 * long-session/harness 逐轮管线）、`long-session/multiuser/mu-support`（MU 计划驱动/会合栅/快照）、
 * `business-e2e/shared-instance`（工具记录/消息构造）、`long-session/oracle`（FACT_TRUTH 真值）。
 *
 * **真值只给 Oracle**：`truth.facts` 只用于判定；脚本回复由执行层真实返回派生
 * （`describeRecord` / 底账存档原文），不读 `FACT_TRUTH`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeConfig } from '@fshine/contracts';
import type { ExecutionClient } from '@fshine/contracts/execution-contract';
import { accountCalls } from '../long-session/accounting';
import { analyzeCompaction, judgeCompactionLifecycle } from '../long-session/compaction';
import { FACT_TRUTH, judgeTaskContinuity, taskFactBrief, taskIsDone, taskIsFailed, taskIsUnstarted } from '../long-session/oracle';
import type { TaskTurnFact, TaskView } from '../long-session/oracle';
import {
  createMuServer, deliver, incoming, makeCtx, makeMainDriver, makeWorkerDriver, Rendezvous,
  MU_PRINCIPALS, MU_TAGS, MuPlans, MuRecordingSink,
  principalIdOf, readTasks, sessionIdOf, toTaskViews,
  type MuTaskSnapshot,
} from '../long-session/multiuser/mu-support';
import {
  createDeadlineWorkerDriver, createDummyP2Client, createHangingClient,
  judgementOf, P2ScriptBook, runP2Sample, sessionEvidenceOf, startP2Server,
  waitForTasks, writeP2Evidence,
  type P2ServerHandle,
} from './p2-harness';
import { assertNoFabricatedNumbers, claimsCompletion, coverageOf, judgeP2Case, type P2Judgement } from './p2-oracle';
import type { P2CaseDefinition, P2Observation, P2ScenarioId } from './p2-types';
import { textAssistant, toolCallAssistant } from '../business-e2e/shared-instance';

// ─────────────────────────────────────────────────────────────────────────────
// 通用小件（从执行层真实返回派生回复文本；不读真值表）
// ─────────────────────────────────────────────────────────────────────────────

type QueryData = {
  collection?: string;
  window?: string | null;
  items?: readonly { value?: number }[];
  count?: number;
  query?: string;
  availableWindows?: readonly string[];
};

function dataOf(record: { data?: unknown }): QueryData | undefined {
  return record.data === null || typeof record.data !== 'object' ? undefined : (record.data as QueryData);
}

/** 执行层 completed 返回 → 用户可读事实（条数/总额由 items 机械求和，不四舍五入）。 */
export function describeCompleted(record: { data?: unknown; collection?: string | null }): string {
  const data = dataOf(record);
  if (data?.items !== undefined) {
    const count = data.count ?? data.items.length;
    const sum = data.items.reduce((total, item) => total + (typeof item.value === 'number' ? item.value : 0), 0);
    const name = data.collection ?? record.collection ?? '';
    const window = data.window === null || data.window === undefined ? '' : String(data.window);
    return `${name} ${window} 共 ${count} 条，总金额 ${sum} 元。`;
  }
  if (data?.query !== undefined) {
    const windows = (data.availableWindows ?? []).join('、');
    return `${data.query} 在 ${String(data.window ?? '')} 窗口没有数据${windows === '' ? '' : `（可用窗口：${windows}）`}。`;
  }
  return `执行层返回：${JSON.stringify(data ?? null)}。`;
}

/** 执行层 failed 返回 → 如实失败话术（不给条数/金额）。 */
export function describeFailure(record: { errorCode?: string; collection?: string | null }): string {
  const code = record.errorCode ?? 'UNKNOWN';
  return `${record.collection ?? '该集合'} 读取失败：执行层返回 failed（${code}），本次没有取得任何记录，也没有条数或金额。`;
}

interface ExecRef {
  handle?: P2ServerHandle;
}

function recordsOf(ref: ExecRef) {
  return ref.handle?.recorder.records ?? [];
}

/** 本会话最近一条指定集合的执行事实。 */
function lastRecordOf(ref: ExecRef, collection: string) {
  const records = recordsOf(ref).filter((record) => record.collection === collection);
  return records[records.length - 1];
}

function tasksOf(ref: ExecRef): MuTaskSnapshot[] {
  return ref.handle === undefined ? [] : readTasks(ref.handle.dbPath);
}

function taskNoOf(ref: ExecRef): number {
  const tasks = tasksOf(ref);
  return tasks[tasks.length - 1]?.taskNo ?? 1;
}

function taskOf(ref: ExecRef, taskNo: number): MuTaskSnapshot | undefined {
  return tasksOf(ref).find((task) => task.taskNo === taskNo);
}

function readGrant(...objects: readonly { collection: string; window?: string }[]) {
  return objects.map((object) => ({ object: { ...object }, access: 'read' as const }));
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 自然语言交办
// ─────────────────────────────────────────────────────────────────────────────

const S1: P2CaseDefinition = {
  id: 'S1',
  scenario: 'S1',
  title: '自然语言交办（开任务 + 真实条数/总额 + 真实任务编号）',
  objective: '一句话交办一次集合核对，回复给出真实条数、总额与真实任务编号。',
  turns: ['帮我查一下 alpha 集合 W1 的记录，一共几条、总金额多少，顺便把任务编号告诉我。'],
  mode: 'inline',
  granted: readGrant({ collection: 'alpha', window: 'W1' }),
  hardZeros: ['H4 虚假完成', 'E-G 编号混淆', 'false_completion', 'unauthorized'],
  failureCriteria: [
    '回复条数/总额与 FACT_TRUTH.alpha（count=2, sum=2000）不一致（tolerance=0）',
    '回复中的任务编号在 Task Registry 找不到',
    '任务 completed 且 requestIds 为空（H4）',
  ],
  truth: { facts: [{ turn: 1, expectation: { kind: 'exact', collection: 'alpha', count: 2, sum: 2000 } }] },
  coverage: (obs) => coverageOf('S1', obs.taskTurns.some((turn) => turn.tasks.length > 0), {
    taskTurns: obs.taskTurns.length,
    tasksSeen: obs.taskTurns.reduce((sum, turn) => sum + turn.tasks.length, 0),
  }),
  checks: (obs) => {
    const reply = obs.turns[0]?.reply ?? '';
    const numbers = [...reply.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    const known = tasksOfRef(obs).map((task) => task.taskNo);
    return [
      {
        name: 'task_no_matches_registry',
        pass: numbers.length > 0 && numbers.every((no) => known.includes(no)),
        detail: `回复编号=${numbers.join(',') || '无'}；registry=${known.join(',') || '无'}`,
        hardZero: true,
      },
      {
        name: 'task_completed_with_execution',
        pass: obs.tasksFinal.some((task) => taskIsDone(task) && task.requestIds.length > 0),
        detail: `终态=${obs.tasksFinal.map((task) => `${taskFactBrief(task)}/${task.requestIds.length}`).join(',')}`,
        hardZero: true,
      },
      assertNoFabricatedNumbers(reply, [2, 2000]),
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S2 异步执行中继续对话（background + 完成闸）
// ─────────────────────────────────────────────────────────────────────────────

const S2: P2CaseDefinition = {
  id: 'S2',
  scenario: 'S2',
  title: '异步执行中继续对话（background 受理 + 在飞时插入 beta 提问）',
  objective: 'T1 交办后立即受理，T2 在 T1 任务未终结时被正常处理；T1 随后真实完成。',
  turns: [
    '帮我查一下 alpha 集合 W1 的记录，一共几条、总金额多少，出结果直接告诉我。',
    'alpha 那个你先跑着别停；另外 beta 集合 W1 有几条、总额多少？',
  ],
  mode: 'background',
  granted: readGrant({ collection: 'alpha', window: 'W1' }, { collection: 'beta', window: 'W1' }),
  hardZeros: ['H4 虚假完成', 'E-G 编号混淆', 'false_completion', 'cross_principal_leak'],
  failureCriteria: [
    'T1 回复谎报 alpha 结果（受理类文本之外给出未取得的数值）',
    'T2 被在飞任务阻塞（未返回或返回异常）',
    'alpha 任务终态非 completed 或 requestIds 为空（H4）',
  ],
  truth: { facts: [{ turn: 2, expectation: { kind: 'exact', collection: 'beta', count: 3, sum: 1000 } }] },
  preregConflict:
    'S2 强制异步派发（§一 S2；旧派发配置键已删除，server 恒 async），而 async 的 task_run 只回机械受理事实，'
    + '模型只能凭受理事实说一句过程话（owner 2026-11-19：模型文本原样投递，宿主不再静默/替换）；'
    + '§一 S2 Oracle 却要求 T2 回复含 beta 条数/总额（count=3, sum=1000）。合规产品的 T2 回合只能回受理类文本'
    + ' → 该事实判据在强制装配下不可满足。待 owner 裁定：'
    + '（a）把 beta 事实判据下移到结果取回轮，或（b）允许 beta 走 inline 子路径。本实现按预注册字面保留判据并登记冲突（不擅自改口径）。',
  coverage: (obs) => {
    const first = obs.taskTurns[0]?.tasks.find((task) => task.request.includes('alpha'));
    const nonTerminal = first !== undefined && (taskIsUnstarted(first) || first.mayBeRunning);
    const releaseSeq = Number(obs.extras['gateReleaseSeq'] ?? -1);
    const t2DoneSeq = Number(obs.extras['t2DoneSeq'] ?? -1);
    const alphaFinal = obs.tasksFinal.find((task) => task.request.includes('alpha'));
    const finalOk = alphaFinal !== undefined && taskIsDone(alphaFinal) && alphaFinal.requestIds.length > 0;
    const satisfied = obs.mode === 'background' && nonTerminal && releaseSeq > t2DoneSeq && finalOk;
    return coverageOf('S2', satisfied, {
      mode: obs.mode,
      firstTurnAlphaStatus: first === undefined ? null : taskFactBrief(first),
      gateReleaseSeq: releaseSeq,
      t2DoneSeq,
      alphaFinal: alphaFinal === undefined ? null : { fact: taskFactBrief(alphaFinal), requestIds: alphaFinal.requestIds.length },
    }, satisfied ? [] : ['background/首回合非终态/闸晚于 T2/最终真完成 四者须同时成立']);
  },
  checks: (obs) => {
    const t1 = obs.turns[0]?.reply ?? '';
    const t2 = obs.turns[1]?.reply ?? '';
    const alphaFinal = obs.tasksFinal.find((task) => task.request.includes('alpha'));
    return [
      {
        name: 't1_is_receipt_not_fake_result',
        // owner 2026-11-19：用户看到模型说的话——只交办回合是受理类文本，不冒充结果。
        // 核心不安全面仍是「谎报未取得的数值」：不得出现 alpha 真值数字。
        pass: !/\b2000\b|2 条|2条/.test(t1) && /已受理|受理/.test(t1),
        detail: `T1 回复=${t1.slice(0, 80)}`,
        hardZero: true,
      },
      {
        name: 't2_not_blocked',
        // 交办回合有用户可见回复（模型文本）且回合确实结束过（t2DoneSeq 有值）——二者合起来
        // 判「没有被在飞 alpha 任务占住」。
        pass: t2.trim() !== '' && Number(obs.extras['t2DoneSeq'] ?? -1) >= 0,
        detail: `T2 回复长度=${t2.length}；t2DoneSeq=${String(obs.extras['t2DoneSeq'] ?? -1)}`,
      },
      {
        name: 'alpha_completed_real',
        pass: alphaFinal !== undefined && taskIsDone(alphaFinal) && alphaFinal.requestIds.length > 0,
        detail: alphaFinal === undefined ? 'alpha 任务缺失' : `registry=${taskFactBrief(alphaFinal)} requestIds=${alphaFinal.requestIds.length}`,
        hardZero: true,
      },
      assertNoFabricatedNumbers(t1, []),
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S3 查进度与结果
// ─────────────────────────────────────────────────────────────────────────────

const S3: P2CaseDefinition = {
  id: 'S3',
  scenario: 'S3',
  title: '查进度与结果（如实状态 + 逐字结果）',
  objective: '追问已完成任务的进度与结果，回报真实状态与真实结果，不空答、不说谎。',
  turns: [
    '帮我核对一下 alpha 集合 W1 的记录，一共几条、总金额多少。',
    '刚才那个 alpha 任务进度怎么样了？把结果给我。',
  ],
  mode: 'background',
  granted: readGrant({ collection: 'alpha', window: 'W1' }),
  hardZeros: ['H4 虚假完成', 'E-G 编号混淆', 'false_completion'],
  failureCriteria: [
    '报告的任务状态与 registry 不一致',
    'completed 的任务 requestIds 为空（H4）',
    '结果文本与底账逐字存档不一致（以旧回合/受理话术冒充结果）',
  ],
  truth: { facts: [{ turn: 2, expectation: { kind: 'exact', collection: 'alpha', count: 2, sum: 2000 } }] },
  coverage: (obs) => {
    const done = obs.tasksFinal.some((task) => taskIsDone(task));
    return coverageOf('S3', done, { tasksFinal: obs.tasksFinal.map((task) => taskFactBrief(task)) },
      done ? [] : ['被查任务须在同一 sessionId 内到达终态']);
  },
  checks: (obs) => {
    const reply = obs.turns[1]?.reply ?? '';
    const task = tasksOfRef(obs)[0];
    const archive = task?.replyText ?? '';
    return [
      {
        name: 'status_truthful',
        pass: task !== undefined && taskIsDone(task),
        detail: `registry status=${task === undefined ? 'missing' : taskFactBrief(task)}`,
        hardZero: true,
      },
      {
        name: 'result_verbatim_from_archive',
        pass: archive !== '' && reply.includes(archive),
        detail: `存档=${archive.slice(0, 80)}；回复=${reply.slice(0, 80)}`,
        hardZero: true,
      },
      {
        name: 'delivered_to_own_session',
        pass: obs.deliveries.length > 0 && obs.deliveries.every((delivery) => delivery.deliveredTo === obs.sessionId),
        detail: `deliveredTo=${[...new Set(obs.deliveries.map((delivery) => delivery.deliveredTo))].join(',')}`,
        hardZero: true,
      },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S4 修改 · 取消 · 再交办
// ─────────────────────────────────────────────────────────────────────────────

const S4: P2CaseDefinition = {
  id: 'S4',
  scenario: 'S4',
  title: '修改·取消·再交办（取消真实发生 + 新任务新 requestId + 参数只查 beta）',
  objective: '取消一个真实存在的任务（机械调用 task_cancel 且落 cancelled），随后按新要求重新交办。',
  turns: [
    '把 alpha 和 beta 两边 W1 的核对都交办一下。',
    '把刚才那个 beta 核对取消掉，不要做了。',
    '行，那就改成只查 beta 集合 W1，重新交办一个。',
  ],
  mode: 'background',
  granted: readGrant({ collection: 'alpha', window: 'W1' }, { collection: 'beta', window: 'W1' }),
  hardZeros: ['H5 虚假取消', 'H3 重复执行', 'H4 虚假完成', 'false_completion', 'meaningless_duplicate'],
  failureCriteria: [
    '回复称「已取消」但该轮未调用 task_cancel / 无 cancelled 底账（H5）',
    '再交办复用旧 requestId 或旧任务（H3）',
    '再交办的执行参数不止 beta',
    '再交办结果与 FACT_TRUTH.beta（3 条 / 1000）不一致',
  ],
  truth: { facts: [] },
  coverage: (obs) => {
    const cancelCalled = obs.taskTurns[1]?.cancelCalled === true;
    const cancelled = obs.tasksFinal.some((task) => task.ended && !task.reported);
    return coverageOf('S4', cancelCalled && cancelled, { cancelCalled, cancelled },
      cancelCalled && cancelled ? [] : ['取消路径须真实走通（task_cancel 且出现 cancelled 状态）']);
  },
  checks: (obs) => {
    const tasks = tasksOfRef(obs);
    const beta = tasks.find((task) => task.request.includes('beta') && taskIsDone(task));
    const cancelled = tasks.find((task) => task.ended && !task.reported);
    const betaOnlyOk = obs.execRecords
      .filter((record) => record.requestId === beta?.requestIds[0] || (beta?.requestIds.includes(record.requestId) ?? false))
      .every((record) => record.collection === 'beta');
    const oldIds = new Set(tasks.filter((task) => task.taskId !== beta?.taskId).flatMap((task) => task.requestIds));
    const freshIds = (beta?.requestIds ?? []).every((requestId) => !oldIds.has(requestId));
    const betaTruth = FACT_TRUTH['beta']!;
    return [
      {
        name: 'cancel_mechanically_real',
        pass: obs.taskTurns[1]?.cancelCalled === true && cancelled !== undefined,
        detail: `cancelCalled=${obs.taskTurns[1]?.cancelCalled === true} cancelled=${cancelled?.taskNo ?? '无'}`,
        hardZero: true,
      },
      {
        name: 'new_task_new_request_ids',
        pass: beta !== undefined && freshIds,
        detail: `再交办任务=${beta?.taskNo ?? '无'} requestIds=${(beta?.requestIds ?? []).join(',')}`,
        hardZero: true,
      },
      {
        name: 'recheck_only_beta',
        pass: beta !== undefined && betaOnlyOk,
        detail: `再交办执行集合=${obs.execRecords.filter((r) => beta?.requestIds.includes(r.requestId)).map((r) => r.collection).join(',')}`,
        hardZero: true,
      },
      {
        name: 'recheck_result_matches_truth',
        pass: beta !== undefined && (beta.replyText ?? '').includes(String(betaTruth.count)) && (beta.replyText ?? '').includes(String(betaTruth.sum)),
        detail: `存档=${(beta?.replyText ?? '').slice(0, 80)}（真值 ${betaTruth.count}/${betaTruth.sum}）`,
        hardZero: true,
      },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S5 进程重启后恢复
// ─────────────────────────────────────────────────────────────────────────────

const S5: P2CaseDefinition = {
  id: 'S5',
  scenario: 'S5',
  title: '进程重启后恢复（转录恢复 / 不跨读 / 不重放 / 结果找回）',
  objective: '进程关停重建后，会话历史与首回合任务结果仍可找回，且不重跑执行。',
  turns: [
    '我让你查的 bankflow-oct 2025-10 的记录，出结果直接告诉我。',
    '我昨天让你查的 bankflow-oct 2025-10 的记录还在吗？把结果给我，别再重跑一遍。',
  ],
  mode: 'background',
  granted: readGrant({ collection: 'bankflow-oct', window: '2025-10' }),
  hardZeros: ['task_crossover（重放/结果找回失败）', 'cross_principal_leak', 'H4 虚假完成'],
  failureCriteria: [
    '重启后转录未恢复（第二回合上下文缺首回合原文/回复）',
    '重启后新执行面被调用（重放）',
    '结果找回与首回合逐字存档不一致（旧回合冒充）',
    '上下文出现他人语料标记（跨 principal 串读）',
  ],
  truth: { facts: [{ turn: 2, expectation: { kind: 'exact', collection: 'bankflow-oct', count: 4, sum: 27200 } }] },
  coverage: (obs) => {
    const restarts = Number(obs.extras['restartCount'] ?? 0);
    const transcriptRestored = obs.extras['transcriptRestored'] === true;
    return coverageOf('S5', restarts === 2 && transcriptRestored, { restarts, transcriptRestored },
      restarts === 2 && transcriptRestored ? [] : ['须同 dbPath 真重启且第二回合转录由存储加载']);
  },
  checks: (obs) => {
    const noReplay = Number(obs.extras['replayCallsAfterRestart'] ?? -1) === 0;
    const retrieved = obs.extras['retrieval'] as { ok?: boolean; archived?: string; retrieved?: string } | undefined;
    const reply = obs.turns[1]?.reply ?? '';
    const archived = String(obs.extras['archivedResult'] ?? '');
    return [
      { name: 'no_replay_after_restart', pass: noReplay, detail: `重启后执行调用=${String(obs.extras['replayCallsAfterRestart'])}`, hardZero: true },
      {
        name: 'retrieval_verbatim',
        pass: retrieved?.ok === true && archived !== '' && reply.includes(archived),
        detail: `retrievalOk=${retrieved?.ok === true}；存档=${archived.slice(0, 60)}；回复=${reply.slice(0, 60)}`,
        hardZero: true,
      },
      {
        name: 'no_old_turn_substitution',
        pass: reply.trim() !== '' && reply !== (obs.turns[0]?.reply ?? ''),
        detail: '第二回合回复不得复用首回合受理话术冒充结果',
        hardZero: true,
      },
      {
        name: 'no_cross_principal_tags',
        pass: !Object.values(MU_TAGS).some((tag) => obs.transcriptTexts.join('\n').includes(tag)),
        detail: '转录中无任何 MU 语料标记',
        hardZero: true,
      },
      {
        name: 'task_completed_with_execution',
        pass: obs.tasksFinal.some((task) => taskIsDone(task) && task.requestIds.length > 0),
        detail: obs.tasksFinal.map((task) => `${taskFactBrief(task)}/${task.requestIds.length}`).join(','),
        hardZero: true,
      },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S6 多用户并发与隔离
// ─────────────────────────────────────────────────────────────────────────────

const S6: P2CaseDefinition = {
  id: 'S6',
  scenario: 'S6',
  title: '多用户并发与隔离（3 principal 同进程真交错 + 任务/通知不串户）',
  objective: '三个用户同一进程并发交办，各任务只归本人，真交错而非串行假并发。',
  turns: [
    '清点我账套里 alpha W1 的记录，逐项说明。',
    '清点我账套里 beta W1 的记录。',
    '清点我账套里 documents 的异常。',
  ],
  mode: 'background',
  granted: readGrant(
    { collection: 'alpha' },
    { collection: 'beta' },
    { collection: 'documents' },
  ),
  hardZeros: ['cross_principal_leak', 'unauthorized_execution', 'notification_misdelivery', 'task_crossover', 'fake_concurrency'],
  failureCriteria: [
    '任一 principal 的任务/转录出现他人语料（cross_principal_leak）',
    '任务归属错（task_crossover）',
    '通知投递对象与任务 owner 不一致（notification_misdelivery）',
    '会合栅 3 到达且未超时（fake_concurrency 的反面）不成立',
  ],
  truth: { facts: [] },
  coverage: (obs) => {
    const arrived = Number(obs.extras['rendezvousArrived'] ?? 0);
    const timedOut = obs.extras['rendezvousTimedOut'] === true;
    const satisfied = arrived === 3 && !timedOut;
    return coverageOf('S6', satisfied, { arrived, timedOut }, satisfied ? [] : ['会合栅须 3 到达且未触发安全超时']);
  },
  checks: (obs) => {
    const muHardZeroHits = (obs.extras['muHardZeroHits'] as string[] | undefined) ?? [];
    const tasks = tasksOfRef(obs);
    const owners = tasks.map((task) => `${task.principalId}|${task.sessionId}`);
    return [
      {
        name: 'one_task_per_principal',
        pass: tasks.length === 3 && new Set(tasks.map((task) => task.principalId)).size === 3,
        detail: `tasks=${tasks.length} principals=${new Set(tasks.map((task) => task.principalId)).size}`,
        hardZero: true,
      },
      {
        name: 'mu_hard_zeros_absent',
        pass: muHardZeroHits.length === 0,
        detail: `MU 硬零=${muHardZeroHits.join(',') || '无'}`,
        hardZero: true,
      },
      {
        name: 'deliveries_owner_only',
        pass: obs.deliveries.length > 0 && obs.deliveries.every((delivery) => owners.includes(`${delivery.principalId}|${delivery.deliveredTo}`)),
        detail: `deliveries=${obs.deliveries.length}`,
        hardZero: true,
      },
      {
        name: 'tasks_completed_with_execution',
        pass: tasks.every((task) => taskIsDone(task) && task.requestIds.length > 0),
        detail: tasks.map((task) => `${taskFactBrief(task)}/${task.requestIds.length}`).join(','),
        hardZero: true,
      },
    ];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S7a 失败 · S7b 超时 · S7c 成本上限
// ─────────────────────────────────────────────────────────────────────────────

const S7A: P2CaseDefinition = {
  id: 'S7a',
  scenario: 'S7a',
  title: 'S7a 失败（faulty-one 读取故障：如实失败、不编造）',
  objective: '执行层读取故障时，任务如实 failed 带原因，回复不编造条数/金额。',
  turns: ['帮我查一下 faulty-one W1 的记录，有多少条、总额多少。'],
  mode: 'inline',
  granted: readGrant({ collection: 'faulty-one', window: 'W1' }),
  hardZeros: ['H4 虚假完成', 'false_completion', 'no_fabricated_numbers'],
  failureCriteria: [
    '任务未落 failed 或没有失败原因',
    '回复称完成 / 给出编造的条数金额',
    '任务 completed 且零执行（H4）',
  ],
  truth: { facts: [] },
  coverage: (obs) => {
    const failed = obs.execRecords.some((record) => record.status === 'failed' && record.errorCode === 'COLLECTION_FAULT');
    return coverageOf('S7a', failed, { execRecords: obs.execRecords.map((record) => `${record.status}/${record.errorCode ?? '-'}`) },
      failed ? [] : ['目标子例路径未触发（执行记录须含 failed/COLLECTION_FAULT）']);
  },
  checks: (obs) => {
    const reply = obs.turns[0]?.reply ?? '';
    const task = tasksOfRef(obs)[0];
    return [
      {
        name: 'task_failed_with_reason',
        pass: task !== undefined && taskIsFailed(task) && (task.reason ?? task.failureReason ?? '') !== '',
        detail: `status=${task === undefined ? 'missing' : taskFactBrief(task)} reason=${task?.reason ?? task?.failureReason ?? ''}`,
        hardZero: true,
      },
      {
        name: 'reply_reports_failure',
        pass: /失败/.test(reply) && !claimsCompletion(reply),
        detail: reply.slice(0, 120),
        hardZero: true,
      },
      assertNoFabricatedNumbers(reply, []),
    ];
  },
};

const S7B: P2CaseDefinition = {
  id: 'S7b',
  scenario: 'S7b',
  title: 'S7b 超时（workerTurnMs=5000 + 不返回执行 gate → timed_out 如实回报）',
  objective: '执行端在时限内不返回时任务落 timed_out，回复如实报超时、不谎报完成。',
  turns: ['帮我查 alpha 集合 W1 的记录，一共几条、总额多少，出结果直接给我。', '那个任务现在怎么样了？'],
  mode: 'background',
  granted: readGrant({ collection: 'alpha', window: 'W1' }),
  hardZeros: ['H4 虚假完成', 'false_completion', 'no_fabricated_numbers'],
  failureCriteria: [
    '任务终态不是 timed_out（超时机制未走到）',
    '回复谎报完成或给出编造的条数/金额',
    '任务 completed 且零执行（H4）',
  ],
  truth: { facts: [] },
  coverage: (obs) => {
    const timedOut = obs.tasksFinal.some((task) => task.ended && !task.reported && !task.mayBeRunning);
    return coverageOf('S7b', obs.mode === 'background' && timedOut, {
      mode: obs.mode,
      tasksFinal: obs.tasksFinal.map((task) => taskFactBrief(task)),
      execAttempts: obs.execRecords.length,
    }, timedOut ? [] : ['目标子例路径未触发（终态须为 timed_out）']);
  },
  checks: (obs) => {
    const reply = obs.turns[1]?.reply ?? '';
    const task = tasksOfRef(obs)[0];
    return [
      {
        name: 'ended_without_report',
        pass: task !== undefined && task.ended && !task.reported && !task.mayBeRunning,
        detail: `facts=${task === undefined ? 'missing' : taskFactBrief(task)}`,
        hardZero: true,
      },
      {
        name: 'reply_reports_timeout_honestly',
        pass: /超时|未完成/.test(reply) && !claimsCompletion(reply),
        detail: reply.slice(0, 120),
        hardZero: true,
      },
      assertNoFabricatedNumbers(reply, []),
    ];
  },
};

const S7C: P2CaseDefinition = {
  id: 'S7c',
  scenario: 'S7c',
  title: 'S7c 成本上限（多集合一次性核完：有界、无零收益压缩循环、无无限重试）',
  objective: '一次核多个集合有界完成，不出现无限重试与零收益压缩循环。',
  turns: [
    '把 alpha、beta、documents、bankflow-oct 这几个集合的 W1 全量核一遍，逐条解释并汇总，尽量一次给全。',
    '把刚才那几项的结果汇总给我。',
  ],
  mode: 'background',
  granted: readGrant(
    { collection: 'alpha', window: 'W1' },
    { collection: 'beta', window: 'W1' },
    { collection: 'documents', window: 'W1' },
    { collection: 'bankflow-oct', window: 'W1' },
  ),
  hardZeros: ['H6.a 零收益压缩循环', 'H6.b 单回合模型调用超限', 'H4 虚假完成', 'no_fabricated_numbers'],
  failureCriteria: [
    'H6.a/H6.b 命中（压缩无界）',
    '重试调用超过有限次（>3）',
    '回复给出编造的条数/金额',
  ],
  truth: {
    facts: [
      { turn: 2, expectation: { kind: 'exact', collection: 'alpha', count: 2, sum: 2000 } },
      { turn: 2, expectation: { kind: 'exact', collection: 'beta', count: 3, sum: 1000 } },
    ],
  },
  coverage: (obs) => {
    const calls = Number(obs.extras['totalModelCalls'] ?? 0);
    return coverageOf('S7c', obs.mode === 'background' && calls >= 2, { totalModelCalls: calls },
      calls >= 2 ? [] : ['目标子例路径未触发（须 ≥2 次模型调用或有界硬停）']);
  },
  checks: (obs) => {
    const compactionVerdict = judgeCompactionLifecycle(analyzeCompaction([], []));
    const retries = (obs.extras['retryCalls'] as number | undefined) ?? 0;
    return [
      {
        name: 'h6_bounds_not_hit',
        pass: compactionVerdict.hardZeroHits.length === 0 && obs.judgement.compactionVerdict.hardZeroHits.length === 0,
        detail: `H6=${obs.judgement.compactionVerdict.hardZeroHits.join(',') || '无'}`,
        hardZero: true,
      },
      {
        name: 'retry_bounded',
        pass: retries <= 3,
        detail: `retry 调用=${retries}（有限重试上界 3）`,
        hardZero: true,
      },
      {
        name: 'all_collections_attempted',
        pass: ['alpha', 'beta', 'documents', 'bankflow-oct'].every((collection) => obs.execRecords.some((record) => record.collection === collection)),
        detail: `执行集合=${[...new Set(obs.execRecords.map((record) => record.collection))].join(',')}`,
        hardZero: true,
      },
    ];
  },
};

export const P2_CASES: readonly P2CaseDefinition[] = [S1, S2, S3, S4, S5, S6, S7A, S7B, S7C];

export function p2Case(scenario: P2ScenarioId): P2CaseDefinition {
  const found = P2_CASES.find((entry) => entry.scenario === scenario);
  if (found === undefined) throw new Error(`未知 P2 场景：${scenario}`);
  return found;
}

/** 观测里的底账快照（按会话过滤；判定用）。 */
function tasksOfRef(obs: P2Observation): MuTaskSnapshot[] {
  return readTasksCached(obs);
}

// readTasks 需要 dbPath；观测里不带 dbPath，改为在 extras 里存底账快照（runner 统一写入）。
const EMPTY_TASKS: MuTaskSnapshot[] = [];
function readTasksCached(obs: P2Observation): MuTaskSnapshot[] {
  const tasks = obs.extras['taskSnapshots'] as MuTaskSnapshot[] | undefined;
  return tasks ?? EMPTY_TASKS;
}

// ─────────────────────────────────────────────────────────────────────────────
// 确定性跑法
// ─────────────────────────────────────────────────────────────────────────────

/** 反向绊线（自检用）：篡改真值/回复/执行事实，证明 Oracle 会红。 */
export interface P2Tamper {
  readonly truth?: (truth: P2CaseDefinition['truth']) => P2CaseDefinition['truth'];
  readonly reply?: (text: string, turnIndex: number) => string;
  /** 伪造「完成但零执行」：清空任务 requestIds 与执行事实（H4 必红）。 */
  readonly forgeZeroExecution?: boolean;
}

export interface P2RunOutput {
  readonly definition: P2CaseDefinition;
  readonly observation: P2Observation;
  readonly judgement: P2Judgement;
  readonly evidenceDir: string;
}

export interface P2RunOptions {
  readonly tamper?: P2Tamper;
  readonly writeEvidence?: boolean;
  /** 样本序号（1 起；同一场景重复跑时用于隔离会话/证据目录，预注册 §2.1 N=3）。 */
  readonly trial?: number;
}

/** 跑一个场景（一次样本；确定性；零真实模型）。 */
export async function runP2Scenario(scenario: P2ScenarioId, options: P2RunOptions = {}): Promise<P2RunOutput> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `p2-${scenario}-`));
  const trial = options.trial ?? 1;
  try {
    const observation = await runScenario(scenario, dir, trial);
    const tampered = applyTamper(observation, options.tamper);
    const definition = options.tamper?.truth === undefined ? p2Case(scenario) : { ...p2Case(scenario), truth: options.tamper.truth(p2Case(scenario).truth) };
    const judgement = judgeP2Case(definition, tampered);
    const written = options.writeEvidence === false
      ? { dir: '' }
      : writeP2Evidence({ observation: tampered, verdict: judgement as unknown as Record<string, unknown> });
    return { definition, observation: tampered, judgement, evidenceDir: written.dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function applyTamper(observation: P2Observation, tamper: P2Tamper | undefined): P2Observation {
  if (tamper === undefined) return observation;
  let next = observation;
  if (tamper.reply !== undefined) {
    // 回复篡改同时作用于任务快照（H5 等判据读 TaskTurnFact.reply），模拟模型真的这么说。
    next = {
      ...next,
      turns: next.turns.map((turn) => ({ ...turn, reply: tamper.reply!(turn.reply, turn.index) })),
      taskTurns: next.taskTurns.map((turn) => ({ ...turn, ...(turn.reply === undefined ? {} : { reply: tamper.reply!(turn.reply, turn.turn) }) })),
    };
    next = { ...next, judgement: { ...next.judgement, taskVerdict: judgeTaskContinuityOf(next.taskTurns) } };
  }
  if (tamper.forgeZeroExecution === true) {
    const strip = (task: TaskView): TaskView => ({ ...task, requestIds: [] });
    next = {
      ...next,
      execRecords: [],
      tasksFinal: next.tasksFinal.map(strip),
      taskTurns: next.taskTurns.map((turn) => ({ ...turn, tasks: turn.tasks.map(strip) })),
    };
    next = { ...next, judgement: { ...next.judgement, taskVerdict: judgeTaskContinuityOf(next.taskTurns) } };
  }
  return next;
}

function judgeTaskContinuityOf(turns: readonly TaskTurnFact[]) {
  // 与 long-session/oracle 同一判据（H3/H4/H5/E-G）。
  return judgeTaskContinuity(turns);
}

// ─────────────────────────────────────────────────────────────────────────────
// 各场景跑法
// ─────────────────────────────────────────────────────────────────────────────

async function runScenario(scenario: P2ScenarioId, dir: string, trial: number): Promise<P2Observation> {
  switch (scenario) {
    case 'S1': return await runS1(dir, trial);
    case 'S2': return await runS2(dir, trial);
    case 'S3': return await runS3(dir, trial);
    case 'S4': return await runS4(dir, trial);
    case 'S5': return await runS5(dir, trial);
    case 'S6': return await runS6(dir, trial);
    case 'S7a': return await runS7a(dir, trial);
    case 'S7b': return await runS7b(dir, trial);
    case 'S7c': return await runS7c(dir, trial);
  }
}

/** 样本级会话窗口名（含 trial；同一场景重复跑的会话/证据目录因此互不覆盖）。 */
function convOf(name: string, trial: number): string {
  return `conv-${name}-t${trial}`;
}

function mainPrincipal(userId: string, conversationId: string) {
  return { userId, conversationId };
}

async function runS1(dir: string, trial: number): Promise<P2Observation> {
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const client = await createDummyP2Client({ dir });
  const text = S1.turns[0]!;
  book.mainTurn(text, [
    toolCallAssistant('task_run', { task: text }),
    () => {
      const record = lastRecordOf(ref, 'alpha');
      return textAssistant(`${record === undefined ? 'alpha 读取完成。' : describeCompleted(record)}任务编号 #${taskNoOf(ref)}。`);
    },
  ], 1);
  book.workerTask(text, [
    toolCallAssistant('op_dummy_query', { 'collection': 'alpha', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'alpha');
      return textAssistant(record === undefined ? 'alpha 读取完成。' : describeCompleted(record));
    },
  ]);
  return await runP2Sample({
    caseId: S1.id, scenario: 'S1', dir, mode: 'inline',
    principal: mainPrincipal('p2-s1', convOf('s1', trial)),
    texts: [text], facts: S1.truth.facts, book, client: client.client,
    allowedOperations: client.allowedOperations, readOnlyOperations: client.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    extras: (handle) => ({ taskSnapshots: readTasks(handle.dbPath) }),
  });
}

async function runS2(dir: string, trial: number): Promise<P2Observation> {
  const runtime: RuntimeConfig = { backgroundConcurrency: 2, queueCapacity: 1 };
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const inner = await createDummyP2Client({ dir });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let released = false;
  let seq = 0;
  const state = { gateReleaseSeq: -1, t2DoneSeq: -1, statusBeforeRelease: 'missing' };
  const gated: ExecutionClient = {
    capabilities: () => inner.client.capabilities(),
    async execute(request) {
      if (request.args['--collection'] === 'alpha') {
        await gate;
        released = true;
      }
      return await inner.client.execute(request);
    },
  };
  const t1 = S2.turns[0]!;
  const t2 = S2.turns[1]!;
  const receipt = (): string => `已受理 #${taskNoOf(ref)}，将在后台执行，结果出来直接告诉你。`;
  book.mainTurn(t1, [toolCallAssistant('task_run', { task: t1 }), () => textAssistant(receipt())], 1);
  book.mainTurn(t2, [toolCallAssistant('task_run', { task: '查询 beta 集合 W1 的条数与总额' }), () => textAssistant(receipt())], 2);
  book.workerTask(t1, [
    toolCallAssistant('op_dummy_query', { 'collection': 'alpha', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'alpha');
      return textAssistant(record === undefined ? 'alpha 读取完成。' : describeCompleted(record));
    },
  ]);
  book.workerTask('查询 beta 集合 W1 的条数与总额', [
    toolCallAssistant('op_dummy_query', { 'collection': 'beta', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'beta');
      return textAssistant(record === undefined ? 'beta 读取完成。' : describeCompleted(record));
    },
  ]);
  const observation = await runP2Sample({
    caseId: S2.id, scenario: 'S2', dir, mode: 'background', runtime,
    principal: mainPrincipal('p2-s2', convOf('s2', trial)),
    texts: [t1, t2], facts: S2.truth.facts, book, client: gated,
    allowedOperations: inner.allowedOperations, readOnlyOperations: inner.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    afterSend: async (turn) => {
      if (turn !== 2) return;
      state.t2DoneSeq = seq;
      seq += 1;
      const alpha = tasksOf(ref).find((task) => task.request.includes('alpha'));
      state.statusBeforeRelease = alpha === undefined ? 'missing' : taskFactBrief(alpha);
      if (!released) { state.gateReleaseSeq = seq; seq += 1; release?.(); }
    },
    afterRun: async (handle) => {
      await waitForTasks(handle.dbPath, (tasks) => tasks.filter((task) => taskIsDone(task)).length >= 2, 10_000);
    },
    extras: (handle) => ({
      taskSnapshots: readTasks(handle.dbPath),
      gateReleaseSeq: state.gateReleaseSeq,
      t2DoneSeq: state.t2DoneSeq,
      alphaStatusBeforeRelease: state.statusBeforeRelease,
    }),
  });
  return observation;
}

async function runS3(dir: string, trial: number): Promise<P2Observation> {
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const client = await createDummyP2Client({ dir });
  const t1 = S3.turns[0]!;
  const t2 = S3.turns[1]!;
  book.mainTurn(t1, [toolCallAssistant('task_run', { task: t1 }), () => textAssistant(`已受理 #${taskNoOf(ref)}，完成后把结果告诉你。`)], 1);
  book.mainTurn(t2, [
    () => toolCallAssistant('task_result', { ref: `#${taskOfAny(ref)?.taskNo ?? 1}` }),
    () => textAssistant(taskOfAny(ref)?.replyText ?? '还没有结果。'),
  ], 2);
  book.workerTask(t1, [
    toolCallAssistant('op_dummy_query', { 'collection': 'alpha', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'alpha');
      return textAssistant(record === undefined ? 'alpha 读取完成。' : describeCompleted(record));
    },
  ]);
  return await runP2Sample({
    caseId: S3.id, scenario: 'S3', dir, mode: 'background',
    principal: mainPrincipal('p2-s3', convOf('s3', trial)),
    texts: [t1, t2], facts: S3.truth.facts, book, client: client.client,
    allowedOperations: client.allowedOperations, readOnlyOperations: client.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    afterSend: async (turn) => {
      if (turn !== 1) return;
      await waitForTasks(ref.handle!.dbPath, (tasks) => tasks.some((task) => taskIsDone(task)), 5000);
    },
    extras: (handle) => ({ taskSnapshots: readTasks(handle.dbPath) }),
  });
}

/** 取本会话任一任务（S3 只有一个）。 */
function taskOfAny(ref: ExecRef): MuTaskSnapshot | undefined {
  const tasks = tasksOf(ref);
  return tasks[tasks.length - 1];
}

async function runS4(dir: string, trial: number): Promise<P2Observation> {
  const runtime: RuntimeConfig = { backgroundConcurrency: 1, queueCapacity: 1 };
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const inner = await createDummyP2Client({ dir });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gated: ExecutionClient = {
    capabilities: () => inner.client.capabilities(),
    async execute(request) {
      if (request.args['--collection'] === 'alpha') await gate;
      return await inner.client.execute(request);
    },
  };
  const t1 = S4.turns[0]!;
  const t2 = S4.turns[1]!;
  const t3 = S4.turns[2]!;
  const alphaCheck = '核对 alpha 集合 W1 的记录';
  const betaCheck = '核对 beta 集合 W1 的记录';
  const betaOnly = '只查 beta 集合 W1 的记录';
  book.mainTurn(t1, [
    toolCallAssistant('task_run', { task: alphaCheck }),
    toolCallAssistant('task_run', { task: betaCheck }),
    () => textAssistant('两个核对都已受理：alpha 先跑，beta 排队。'),
  ], 1);
  book.mainTurn(t2, [
    // 2026-11-20：数字 ref 退役，按真实 taskId 取消/回话（断言强度不变）。
    () => toolCallAssistant('task_cancel', { ref: findTaskId(ref, 'beta') }),
    () => textAssistant('已取消 beta 那边的核对，不会再执行。'),
  ], 2);
  book.mainTurn(t3, [
    toolCallAssistant('task_run', { task: betaOnly }),
    () => textAssistant('已按新要求重新交办（只查 beta）。'),
  ], 3);
  book.workerTask(alphaCheck, [
    toolCallAssistant('op_dummy_query', { 'collection': 'alpha', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'alpha');
      return textAssistant(record === undefined ? 'alpha 核对完成。' : describeCompleted(record));
    },
  ]);
  book.workerTask(betaCheck, [
    toolCallAssistant('op_dummy_query', { 'collection': 'beta', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'beta');
      return textAssistant(record === undefined ? 'beta 核对完成。' : describeCompleted(record));
    },
  ]);
  book.workerTask(betaOnly, [
    toolCallAssistant('op_dummy_query', { 'collection': 'beta', 'window': 'W1' }),
    () => {
      const record = lastRecordOf(ref, 'beta');
      return textAssistant(record === undefined ? 'beta 读取完成。' : describeCompleted(record));
    },
  ]);
  return await runP2Sample({
    caseId: S4.id, scenario: 'S4', dir, mode: 'background', runtime,
    principal: mainPrincipal('p2-s4', convOf('s4', trial)),
    texts: [t1, t2, t3], facts: S4.truth.facts, book, client: gated,
    allowedOperations: inner.allowedOperations, readOnlyOperations: inner.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    afterSend: async (turn) => {
      if (turn !== 2) return;
      await waitForTasks(ref.handle!.dbPath, (tasks) => tasks.some((task) => task.ended && !task.reported), 3000);
    },
    afterRun: async (handle) => {
      release?.();
      await waitForTasks(handle.dbPath, (tasks) => tasks.filter((task) => taskIsDone(task)).length >= 2, 10_000);
    },
    extras: (handle) => ({ taskSnapshots: readTasks(handle.dbPath) }),
  });
}

function findTaskNo(ref: ExecRef, requestFragment: string): number {
  return tasksOf(ref).find((task) => task.request.includes(requestFragment))?.taskNo ?? 1;
}

/** 2026-11-20：数字 ref 退役——场景里的取消/查询改为按真实 taskId 引用。 */
function findTaskId(ref: ExecRef, requestFragment: string): string {
  const taskId = tasksOf(ref).find((task) => task.request.includes(requestFragment))?.taskId;
  if (taskId === undefined) throw new Error(`（场景）找不到含「${requestFragment}」的任务 taskId`);
  return taskId;
}

async function runS5(dir: string, trial: number): Promise<P2Observation> {
  const t1 = S5.turns[0]!;
  const t2 = S5.turns[1]!;
  const principal = mainPrincipal('p2-s5', convOf('s5', trial));
  const principalId = `wecom:${principal.userId}`;
  const sessionId = `wecom:${principal.conversationId}`;
  const inner = await createDummyP2Client({ dir });

  // ── 第一个 server：交办 → 等 completed → 关停 ────────────────────────────────
  const book1 = new P2ScriptBook();
  const ref1: ExecRef = {};
  book1.mainTurn(t1, [toolCallAssistant('task_run', { task: t1 }), () => textAssistant(`已受理 #${taskNoOf(ref1)}，完成后把结果告诉你。`)], 1);
  book1.workerTask(t1, [
    toolCallAssistant('op_dummy_query', { 'collection': 'bankflow-oct', 'window': '2025-10' }),
    () => {
      const record = lastRecordOf(ref1, 'bankflow-oct');
      return textAssistant(record === undefined ? 'bankflow-oct 读取完成。' : describeCompleted(record));
    },
  ]);
  const server1 = await startP2Server({
    dir, principals: [principal], mode: 'background',
    book: book1, client: inner.client,
    allowedOperations: inner.allowedOperations, readOnlyOperations: inner.readOnlyOperations,
  });
  ref1.handle = server1;
  const reply1 = await deliver(server1.server.handler, incoming(
    principal.userId as Parameters<typeof incoming>[0], principal.conversationId, 's5-1', t1,
  ));
  await waitForTasks(server1.dbPath, (tasks) => tasks.some((task) => taskIsDone(task)), 8000);
  const archivedResult = readTasks(server1.dbPath)[0]?.replyText ?? '';
  const execCountBeforeRestart = server1.recorder.records.length;
  const taskNoBeforeRestart = readTasks(server1.dbPath)[0]?.taskNo ?? 1;
  await server1.close();

  // ── 第二个 server：同 dbPath 重建（= 进程重启）；新执行面即重放检测器 ──────────
  const book2 = new P2ScriptBook();
  const ref2: ExecRef = {};
  book2.mainTurn(t2, [
    () => toolCallAssistant('task_result', { ref: `#${taskNoBeforeRestart}` }),
    () => textAssistant(
      `你之前让我查的 bankflow-oct 2025-10 记录还在，结果如下：${archivedResult}`,
    ),
  ], 2);
  const server2 = await startP2Server({
    dir, principals: [principal], mode: 'background',
    book: book2, client: inner.client,
    allowedOperations: inner.allowedOperations, readOnlyOperations: inner.readOnlyOperations,
  });
  ref2.handle = server2;
  let reply2 = '';
  try {
    reply2 = await deliver(server2.server.handler, incoming(
      principal.userId as Parameters<typeof incoming>[0], principal.conversationId, 's5-2', t2,
    ));
    const tasksAfter = readTasks(server2.dbPath);
    const task = tasksAfter[0];
    const transcript = book2.requestTexts.get(t2) ?? '';
    const transcriptRestored = transcript.includes(t1) && transcript.includes(reply1);
    const taskTurns: TaskTurnFact[] = [
      { turn: 1, tasks: toTaskViews([...readTasks(server1.dbPath)]) },
      { turn: 2, tasks: toTaskViews(tasksAfter), reply: reply2, cancelCalled: false },
    ];
    const tasksFinal = toTaskViews(tasksAfter);
    const facts = [{ expectation: S5.truth.facts[0]!.expectation, reply: reply2 }];
    const judgement = judgementOf({ facts, taskTurns });
    const evidence = sessionEvidenceOf({
      sessionId, principalId, taskTurns, tasksFinal, modelCalls: [...book1.calls, ...book2.calls],
      turns: [
        { index: 1, text: t1, reply: reply1 },
        { index: 2, text: t2, reply: reply2 },
      ],
      toolCalls: [...book1.toolSink.toolCalls, ...book2.toolSink.toolCalls].map((call) => ({
        turn: 0, agent: call.driver, seq: call.seq, tool: call.tool,
        args: call.args, resultSummary: call.resultSummary, elapsedMs: call.elapsedMs,
      })),
    });
    return {
      caseId: S5.id, scenario: 'S5', principalId, sessionId, mode: 'background',
      turns: [
        { index: 1, text: t1, reply: reply1, taskIds: [] },
        { index: 2, text: t2, reply: reply2, taskIds: [] },
      ],
      taskTurns, tasksFinal,
      execRecords: [...server1.recorder.records, ...server2.recorder.records],
      toolCalls: [...book1.toolSink.toolCalls, ...book2.toolSink.toolCalls],
      deliveries: (tasksAfter).map((snapshot) => ({
        caseId: S5.id, principalId: snapshot.principalId, sessionId: snapshot.sessionId,
        taskId: snapshot.taskId, request: snapshot.request, deliveredTo: snapshot.sessionId, kind: 'reply' as const,
      })),
      modelCalls: [...book1.calls, ...book2.calls].filter((call) => call.driver === 'main'),
      compactionAttempts: [], transcriptTexts: [transcript],
      evidence, judgement,
      extras: {
        taskSnapshots: tasksAfter,
        restartCount: 2,
        transcriptRestored,
        callAccounting: accountCalls([...book1.calls, ...book2.calls]),
        archivedResult,
        execCountBeforeRestart,
        replayCallsAfterRestart: server2.recorder.records.length,
        retrieval: {
          ok: task !== undefined && task.replyText === archivedResult && taskIsDone(task),
          archived: archivedResult,
          retrieved: task?.replyText ?? null,
        },
      },
    };
  } finally {
    await server2.close();
  }
}

async function runS6(dir: string, trial: number): Promise<P2Observation> {
  const runtime: RuntimeConfig = { mainConcurrency: 3, backgroundConcurrency: 3, queueCapacity: 1 };
  const plans = new MuPlans();
  const texts = new Map<string, string>();
  for (const [index, userId] of MU_PRINCIPALS.entries()) {
    const text = S6.turns[index]!;
    texts.set(userId, text);
    plans.delegate(userId, text, {
      reply: `已受理，稍后把 ${collectionFor(userId)} 的清点结果告诉你。`,
      operation: 'dummy.query',
      args: { '--collection': collectionFor(userId) },
      summary: `${collectionFor(userId)} 清点完成。`,
      rendezvous: true,
    });
  }
  const ctx = makeCtx(plans.table());
  const rendezvous = new Rendezvous(3);
  ctx.rendezvous = rendezvous;
  const sink = new MuRecordingSink();
  const handle = await createMuServer({
    dir, ctx, mode: 'background', runtime,
    createDrivers: async (_env, mainSession) => ({ mainDriver: makeMainDriver(ctx, mainSession), workerDriver: makeWorkerDriver(ctx) }),
    notificationSink: sink,
  });
  try {
    const replies = await Promise.all(MU_PRINCIPALS.map((userId, index) => deliver(
      handle.server.handler,
      incoming(userId, handle_conversation_of(userId, trial), `s6-${index}`, texts.get(userId)!),
    )));
    await waitForTasks(handle.dbPath, (tasks) => tasks.length === 3 && tasks.every((task) => taskIsDone(task)), 10_000);
    const tasks = readTasks(handle.dbPath);
    const sessionLabels = MU_PRINCIPALS.map((userId) => sessionIdOf(handle_conversation_of(userId, trial)));
    const scopeViolations = tasks.filter((task) => {
      const owner = MU_PRINCIPALS.find((userId) => principalIdOf(userId) === task.principalId);
      return owner === undefined || task.sessionId !== sessionIdOf(handle_conversation_of(owner, trial));
    }).map((task) => `任务 ${task.taskId} 归属 ${task.principalId}/${task.sessionId} 与语料标记不符`);
    const ownerOfText = plans.table().ownerOfText;
    const crossover = tasks.filter((task) => {
      const owner = ownerOfText.get(task.request);
      return owner === undefined || principalIdOf(owner) !== task.principalId;
    }).map((task) => `任务 ${task.taskId} 归属与请求 owner 不符：${task.request}`);
    const transcriptViolations: string[] = [];
    for (const record of ctx.mainRecords) {
      const owner = MU_PRINCIPALS.find((candidate) => principalIdOf(candidate) === record.principalId);
      const text = JSON.stringify(record.messages);
      for (const foreign of MU_PRINCIPALS.filter((candidate) => candidate !== owner)) {
        const foreignText = texts.get(foreign)!;
        if (text.includes(foreignText)) transcriptViolations.push(`${record.principalId} 转录含他人原文（${foreign}）`);
      }
    }
    const execByRequest = new Map(ctx.execRecords.map((record) => [record.requestId, record] as const));
    const execOwnerViolations: string[] = [];
    for (const task of tasks) {
      const owner = MU_PRINCIPALS.find((userId) => principalIdOf(userId) === task.principalId);
      const expected = owner === undefined ? undefined : collectionFor(owner);
      for (const requestId of task.requestIds) {
        const executed = execByRequest.get(requestId);
        if (executed !== undefined && expected !== undefined && executed.collection !== expected) {
          execOwnerViolations.push(`任务 ${task.taskId}（${task.principalId}）执行了 ${String(executed.collection)}，应为 ${expected}`);
        }
      }
    }
    const muHardZeroHits: string[] = [];
    if (scopeViolations.length > 0 || transcriptViolations.length > 0) muHardZeroHits.push('cross_principal_leak');
    if (crossover.length > 0 || execOwnerViolations.length > 0) muHardZeroHits.push('task_crossover');
    if (execOwnerViolations.length > 0) muHardZeroHits.push('unauthorized_execution');
    if (rendezvous.timedOut || rendezvous.arrivedCount !== 3) muHardZeroHits.push('fake_concurrency');
    const deliveries = [
      ...tasks.map((task) => ({
        caseId: S6.id, principalId: task.principalId, sessionId: task.sessionId,
        taskId: task.taskId, request: task.request, deliveredTo: task.sessionId, kind: 'reply' as const,
      })),
      ...sink.sent.map((notification) => {
        const owner = tasks.find((task) => task.taskId === notification.taskId);
        return {
          caseId: S6.id,
          principalId: owner?.principalId ?? 'unknown',
          sessionId: owner?.sessionId ?? 'unknown',
          taskId: notification.taskId,
          request: '',
          deliveredTo: owner?.sessionId ?? 'unknown',
          kind: 'notification' as const,
        };
      }),
    ];
    const notifiedUnknown = sink.sent.filter((notification) => tasks.every((task) => task.taskId !== notification.taskId));
    if (notifiedUnknown.length > 0) muHardZeroHits.push('notification_misdelivery');
    const taskTurns: TaskTurnFact[] = [{ turn: 1, tasks: toTaskViews(tasks) }];
    const judgement = judgementOf({ facts: [], taskTurns });
    const modelCalls = [] as P2Observation['modelCalls'];
    const evidence = sessionEvidenceOf({
      sessionId: `s6-batch-t${trial}`, principalId: 's6-batch', taskTurns, tasksFinal: toTaskViews(tasks), modelCalls: [...modelCalls],
      turns: MU_PRINCIPALS.map((userId, index) => ({ index: index + 1, text: texts.get(userId)!, reply: replies[index] ?? '' })),
    });
    return {
      caseId: S6.id, scenario: 'S6', principalId: 's6-batch', sessionId: `s6-batch-t${trial}`, mode: 'background',
      turns: MU_PRINCIPALS.map((userId, index) => ({ index: index + 1, text: texts.get(userId)!, reply: replies[index] ?? '', taskIds: [] })),
      taskTurns, tasksFinal: toTaskViews(tasks),
      execRecords: ctx.execRecords.map((record) => ({
        requestId: record.requestId, operation: record.operation, args: record.args,
        collection: record.collection, status: 'completed',
      })),
      toolCalls: [],
      deliveries,
      modelCalls: [...modelCalls],
      compactionAttempts: [], transcriptTexts: ctx.mainRecords.map((record) => JSON.stringify(record.messages)),
      evidence, judgement,
      extras: {
        taskSnapshots: tasks,
        muHardZeroHits,
        rendezvousArrived: rendezvous.arrivedCount,
        rendezvousTimedOut: rendezvous.timedOut,
        // S6 确定性自检用 MU 计划驱动（零模型调用）；真实模型执行时由脚本 provider/真实 Pi 记账。
        callAccounting: accountCalls([]),
        notificationKinds: [...new Set(sink.sent.map((notification) => notification.kind))],
        scopeViolations, crossover, transcriptViolations, execOwnerViolations,
        sessionLabels,
        notifications: sink.sent.length,
      },
    };
  } finally {
    await handle.close();
  }
}

/** S6 每 principal 的目标集合（= 用户话术里点名的集合；跨户检测据此逐任务核对）。 */
function collectionFor(userId: string): string {
  if (userId === 'mu-alice') return 'alpha';
  if (userId === 'mu-bob') return 'beta';
  return 'documents';
}

/** S6 的会话窗口命名（每 principal 一个独立会话）。 */
function handle_conversation_of(userId: string, trial: number): string {
  return `conv-${userId}-t${trial}`;
}

async function runS7a(dir: string, trial: number): Promise<P2Observation> {
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const client = await createDummyP2Client({ dir });
  const text = S7A.turns[0]!;
  book.mainTurn(text, [
    toolCallAssistant('task_run', { task: text }),
    () => {
      const record = recordsOf(ref).find((candidate) => candidate.collection === 'faulty-one');
      return textAssistant(record === undefined ? '读取失败：本次没有取得任何记录。' : describeFailure(record));
    },
  ], 1);
  book.workerTask(text, [
    toolCallAssistant('op_dummy_query', { 'collection': 'faulty-one', 'window': 'W1' }),
    () => {
      const record = recordsOf(ref).find((candidate) => candidate.collection === 'faulty-one');
      return textAssistant(record === undefined ? '读取失败，未取得记录。' : describeFailure(record));
    },
  ]);
  return await runP2Sample({
    caseId: S7A.id, scenario: 'S7a', dir, mode: 'inline',
    principal: mainPrincipal('p2-s7a', convOf('s7a', trial)),
    texts: [text], facts: [], book, client: client.client,
    allowedOperations: client.allowedOperations, readOnlyOperations: client.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    extras: (handle) => ({ taskSnapshots: readTasks(handle.dbPath) }),
  });
}

async function runS7b(dir: string, trial: number): Promise<P2Observation> {
  const runtime: RuntimeConfig = { workerTurnMs: 5000, backgroundConcurrency: 1 };
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const t1 = S7B.turns[0]!;
  const t2 = S7B.turns[1]!;
  book.mainTurn(t1, [toolCallAssistant('task_run', { task: t1 }), () => textAssistant(`已受理 #${taskNoOf(ref)}，将在后台执行。`)], 1);
  book.mainTurn(t2, [
    () => toolCallAssistant('task_status', { ref: `#${findTaskNo(ref, 'alpha')}` }),
    () => textAssistant(`任务 #${findTaskNo(ref, 'alpha')} 已超时未完成：执行端在时限内没有返回结果，没有条数或金额可以给你。`),
  ], 2);
  book.workerTask(t1, [
    toolCallAssistant('op_dummy_query', { 'collection': 'alpha', 'window': 'W1' }),
    () => textAssistant('alpha 读取完成。'),
  ]);
  return await runP2Sample({
    caseId: S7B.id, scenario: 'S7b', dir, mode: 'background', runtime,
    principal: mainPrincipal('p2-s7b', convOf('s7b', trial)),
    texts: [t1, t2], facts: [], book,
    client: createHangingClient(),
    // hanging 客户端不来自 resolveExecutionFace（手写注入面）：显式声明它自述的唯一 operation
    // 是只读的 dummy.query；写操作一个都不在该面里。
    allowedOperations: ['dummy.query'], readOnlyOperations: ['dummy.query'],
    workerDriverFactory: () => createDeadlineWorkerDriver(book),
    onServerReady: (handle) => { ref.handle = handle; },
    afterSend: async (turn) => {
      if (turn !== 1) return;
      await waitForTasks(ref.handle!.dbPath, (tasks) => tasks.some((task) => task.ended && !task.reported && !task.mayBeRunning), 10_000);
    },
    extras: (handle) => ({ taskSnapshots: readTasks(handle.dbPath) }),
  });
}

async function runS7c(dir: string, trial: number): Promise<P2Observation> {
  const book = new P2ScriptBook();
  const ref: ExecRef = {};
  const client = await createDummyP2Client({ dir });
  const t1 = S7C.turns[0]!;
  const t2 = S7C.turns[1]!;
  const collections: readonly [string, string][] = [['alpha', 'W1'], ['beta', 'W1'], ['documents', 'W1'], ['bankflow-oct', 'W1']];
  const summary = (): string => collections.map(([collection]) => {
    const record = lastRecordOf(ref, collection);
    return record === undefined ? `${collection} 未执行。` : describeCompleted(record);
  }).join('');
  book.mainTurn(t1, [toolCallAssistant('task_run', { task: t1 }), () => textAssistant(`已受理 #${taskNoOf(ref)}，四组核对在后台执行，完成后汇总给你。`)], 1);
  book.mainTurn(t2, [
    () => toolCallAssistant('task_result', { ref: `#${findTaskNo(ref, 'alpha')}` }),
    () => textAssistant(taskOfAny(ref)?.replyText ?? '还没有结果。'),
  ], 2);
  book.workerTask(t1, [
    ...collections.map(([collection, window]) => toolCallAssistant('op_dummy_query', { 'collection': collection, 'window': window })),
    () => textAssistant(summary()),
  ]);
  return await runP2Sample({
    caseId: S7C.id, scenario: 'S7c', dir, mode: 'background',
    principal: mainPrincipal('p2-s7c', convOf('s7c', trial)),
    texts: [t1, t2], facts: S7C.truth.facts, book, client: client.client,
    allowedOperations: client.allowedOperations, readOnlyOperations: client.readOnlyOperations,
    onServerReady: (handle) => { ref.handle = handle; },
    afterSend: async (turn) => {
      if (turn !== 1) return;
      await waitForTasks(ref.handle!.dbPath, (tasks) => tasks.some((task) => taskIsDone(task)), 10_000);
    },
    extras: (handle) => ({
      taskSnapshots: readTasks(handle.dbPath),
      totalModelCalls: book.calls.length,
      retryCalls: book.calls.filter((call) => call.kind === 'retry').length,
    }),
  });
}
