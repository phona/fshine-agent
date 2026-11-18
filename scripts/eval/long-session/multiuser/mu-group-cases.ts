/**
 * R6 MU · 群聊多用户交办（MU-11～MU-13）——同一群（同 conversationId）里 A/B 两位发言人。
 *
 * 业务盲区：MU-8 只验证「同一个人的群/私隔离」。真实群聊里**不同用户**在同一个群里
 * 各自交办时，宿主必须按发言人（principal）而不是按群（session）归属任务：
 *   · MU-11：A/B 同群各自交办 → 两条任务分属 A/B；B 查 A 的编号（status/result/cancel）
 *     一律「任务不存在或不属于当前会话」；A/B 查自己的编号成功（正向对照）。
 *   · MU-12：A 在群里发附件、B 引用 A 的 fileId → task_run / run_js 同话术拒绝（与不存在
 *     逐字一致，不泄露存在性），B 零任务行；A 用自己的 fileId 交办成功（正向对照）。
 *   · MU-13：经真实渠道（WecomBotChannel + 记录型假 SDK，显式 live）把结果投回同一个群；
 *     B 在同群仍查不到 A 的任务（投递回群 ≠ 授权继承）。
 *
 * 硬边界（与 MU 夹具一致）：零真实模型 / 零真实企微 / 零真实写；判定器是纯函数，
 * 反向绊线直接对判定器喂「泄漏/越权/错投」观测，证明断言不是恒真。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  createMuServer, deliver, incoming, makeCtx, makeTempDir, readTasks,
  MU_TAGS, MuPlans, principalIdOf, sessionIdOf, settle, startLiveWecomChannel, wecomTextFrame,
  type MuCallRecord, type MuCaseResult, type MuDeliveryRecord, type MuHardZero, type MuPrincipal, type MuTaskSnapshot,
} from './mu-support';
import {
  EVIDENCE_ROOT, TASK_NOT_IN_SESSION, crossoverHits, finalize, makeRecords, scopeViolations, waitUntil,
} from './mu-cases';

const GROUP11 = 'group-mu11';
const GROUP12 = 'group-mu12';
const GROUP13 = 'group-mu13';

// ─────────────────────────────────────────────────────────────────────────────
// 纯判定器（用例与反向绊线共用；喂坏观测必须报红）
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupQueryObservation {
  readonly tool: string;
  readonly ref: string;
  readonly error: string | null;
  readonly result: unknown;
}

export interface GroupJudgement {
  readonly hits: readonly MuHardZero[];
  readonly details: Readonly<Record<string, unknown>>;
}

function observationText(observation: { readonly error: string | null; readonly result: unknown }): string {
  return `${observation.error ?? ''}\n${JSON.stringify(observation.result ?? null)}`;
}

function containsAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => marker !== '' && text.includes(marker));
}

function taskIdOf(result: unknown): string | null {
  const id = (result as { taskId?: unknown } | null | undefined)?.taskId;
  return typeof id === 'string' ? id : null;
}

export interface GroupTaskIsolationInput {
  readonly tasks: readonly MuTaskSnapshot[];
  /** 请求原文 → 应归属的 principal。 */
  readonly expectedOwnerByRequest: ReadonlyMap<string, string>;
  readonly aTaskId: string | null;
  readonly bTaskId: string | null;
  /** B 用 A 的编号做的查询（status/result/cancel）。 */
  readonly bQueriesOfATask: readonly GroupQueryObservation[];
  readonly aOwnQueries: readonly GroupQueryObservation[];
  readonly bOwnQueries: readonly GroupQueryObservation[];
  /** A 的请求原文/语料标记（用于检 B 侧是否泄漏内容）。 */
  readonly forbiddenMarkers: readonly string[];
}

/**
 * MU-11 判定：同群两条任务必须各归各人；B 对 A 编号的每次解析都必须被拒且无内容泄漏；
 * A/B 查自己的编号必须成功（防「全拒绝也算绿」）。
 */
export function judgeGroupTaskIsolation(input: GroupTaskIsolationInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const sessionIds = [...new Set(input.tasks.map((task) => task.sessionId))];
  const ownerMismatches = input.tasks
    .filter((task) => input.expectedOwnerByRequest.get(task.request) !== task.principalId)
    .map((task) => task.taskId);
  const bCrossAllRejected = input.bQueriesOfATask.length > 0
    && input.bQueriesOfATask.every((query) => query.error !== null && query.error.includes(TASK_NOT_IN_SESSION));
  const bCrossResolved = input.bQueriesOfATask.filter((query) => query.error === null).length;
  const bCrossLeaked = input.bQueriesOfATask.some((query) => containsAny(observationText(query), input.forbiddenMarkers));
  const aOwnResolved = input.aTaskId !== null && input.aOwnQueries.length > 0
    && input.aOwnQueries.every((query) => query.error === null && taskIdOf(query.result) === input.aTaskId);
  const bOwnResolved = input.bTaskId !== null && input.bOwnQueries.length > 0
    && input.bOwnQueries.every((query) => query.error === null && taskIdOf(query.result) === input.bTaskId);

  if (input.tasks.length !== 2 || sessionIds.length !== 1) hits.add('task_crossover');
  if (ownerMismatches.length > 0) hits.add('cross_principal_leak');
  if (bCrossResolved > 0 || !bCrossAllRejected) hits.add('unauthorized_execution');
  if (bCrossLeaked) hits.add('cross_principal_leak');
  if (!aOwnResolved || !bOwnResolved || input.aTaskId === null || input.bTaskId === null) {
    hits.add('unauthorized_execution');
  }

  return {
    hits: [...hits],
    details: {
      sessionIds,
      ownerMismatches,
      taskCount: input.tasks.length,
      bCrossAllRejected,
      bCrossResolvedCount: bCrossResolved,
      bCrossLeaked,
      aOwnResolved,
      bOwnResolved,
    },
  };
}

export interface FileCallObservation {
  readonly tool: string;
  readonly error: string | null;
  readonly result: unknown;
}

export interface ForeignFileReferenceInput {
  readonly aFileId: string;
  readonly aFileName: string;
  readonly bForeignTaskRun: FileCallObservation | undefined;
  readonly bForeignRunJs: FileCallObservation | undefined;
  readonly bNonexistentTaskRun: FileCallObservation | undefined;
  readonly aOwnTaskRun: FileCallObservation | undefined;
  readonly bTaskCountBefore: number;
  readonly bTaskCountAfter: number;
  readonly aTaskCountAfter: number;
  /** B 回合的文件清单注入里是否出现 A 的 fileId/文件名。 */
  readonly bManifestSawForeign: boolean;
}

/**
 * MU-12 判定：B 引用 A 的 fileId 必须拒绝，且与「不存在 fileId」同一话术（无存在性 oracle）；
 * B 侧零任务行；B 的文件清单不含 A 的文件；A 用自己的 fileId 必须成功（正向对照）。
 */
export function judgeForeignFileReference(input: ForeignFileReferenceInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const allRejected = input.bForeignTaskRun?.error != null
    && input.bForeignRunJs?.error != null
    && input.bNonexistentTaskRun?.error != null;
  const sameWording = allRejected
    && input.bForeignTaskRun!.error === input.bNonexistentTaskRun!.error
    && input.bForeignRunJs!.error === input.bNonexistentTaskRun!.error;
  const foreignCalls = [input.bForeignTaskRun, input.bForeignRunJs]
    .filter((call): call is FileCallObservation => call !== undefined);
  const leakedMarkers = [input.aFileId, input.aFileName]
    .filter((marker) => foreignCalls.some((call) => observationText(call).includes(marker)));
  const bNoTaskRow = input.bTaskCountBefore === input.bTaskCountAfter;
  const aOwnSucceeded = input.aOwnTaskRun !== undefined && input.aOwnTaskRun.error === null;

  if (input.bManifestSawForeign || leakedMarkers.length > 0) hits.add('cross_principal_leak');
  if (!allRejected || !sameWording || !aOwnSucceeded) hits.add('unauthorized_execution');
  if (!bNoTaskRow || input.aTaskCountAfter !== input.bTaskCountAfter + 1) hits.add('task_crossover');

  return {
    hits: [...hits],
    details: {
      allRejected,
      sameWordingAsNonexistent: sameWording,
      leakedMarkers,
      bManifestSawForeign: input.bManifestSawForeign,
      bNoTaskRow,
      aOwnSucceeded,
      bTaskCountBefore: input.bTaskCountBefore,
      bTaskCountAfter: input.bTaskCountAfter,
      aTaskCountAfter: input.aTaskCountAfter,
    },
  };
}

export interface GroupOutboundObservation {
  readonly chatid: string | null;
  readonly content: string;
}

export interface GroupDeliveryIsolationInput {
  readonly groupChatId: string;
  readonly outbound: readonly GroupOutboundObservation[];
  /** A 的结果片段（必须出现在发往群的某条出站帧里）。 */
  readonly aReply: string;
  readonly bQuery: GroupQueryObservation;
  readonly bQueryReply: string;
  readonly aTaskId: string | null;
  /** B 的 scope（principal B + 同群 session）里读到的任务列表。 */
  readonly bScopeTasks: readonly MuTaskSnapshot[];
  readonly forbiddenMarkers: readonly string[];
}

/**
 * MU-13 判定：结果必须投回同一个群；B 在同群查 A 的任务仍必须被拒；B 的 scope 列表不得含 A 的任务。
 */
export function judgeGroupDeliveryIsolation(input: GroupDeliveryIsolationInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const aReplyDeliveredToGroup = input.outbound.some((message) => message.chatid === input.groupChatId && message.content.includes(input.aReply));
  const allOutboundToGroup = input.outbound.length > 0 && input.outbound.every((message) => message.chatid === input.groupChatId);
  const bQueryRejected = input.bQuery.error !== null && input.bQuery.error.includes(TASK_NOT_IN_SESSION);
  const bQueryLeaked = containsAny(`${observationText(input.bQuery)}\n${input.bQueryReply}`, input.forbiddenMarkers);
  const bScopeHasATask = input.aTaskId !== null && input.bScopeTasks.some((task) => task.taskId === input.aTaskId);

  if (!aReplyDeliveredToGroup || !allOutboundToGroup) hits.add('notification_misdelivery');
  if (!bQueryRejected) hits.add('unauthorized_execution');
  if (bQueryLeaked || bScopeHasATask) hits.add('cross_principal_leak');

  return {
    hits: [...hits],
    details: {
      aReplyDeliveredToGroup,
      allOutboundToGroup,
      outboundCount: input.outbound.length,
      outboundChatIds: [...new Set(input.outbound.map((message) => message.chatid))],
      bQueryRejected,
      bQueryLeaked,
      bScopeTaskCount: input.bScopeTasks.length,
      bScopeHasATask,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 观测提取
// ─────────────────────────────────────────────────────────────────────────────

function observationOf(call: MuCallRecord | undefined): GroupQueryObservation | undefined {
  if (call === undefined) return undefined;
  return {
    tool: call.tool,
    ref: String(call.args['ref'] ?? ''),
    error: call.error,
    result: call.result,
  };
}

function fileObservationOf(call: MuCallRecord | undefined): FileCallObservation | undefined {
  if (call === undefined) return undefined;
  return { tool: call.tool, error: call.error, result: call.result };
}

function fileIdFromInjections(injections: readonly string[]): string | null {
  const match = injections.join('\n').match(/fileId: (file_[0-9a-f]{32})/);
  return match?.[1] ?? null;
}

function tasksOfScope(tasks: readonly MuTaskSnapshot[], userId: MuPrincipal, conversationId: string): MuTaskSnapshot[] {
  return tasks.filter((task) => task.principalId === principalIdOf(userId) && task.sessionId === sessionIdOf(conversationId));
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-11 同群不同用户各自交办
// ─────────────────────────────────────────────────────────────────────────────

export async function mu11(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-11';
  const title = '同群不同用户各自交办（任务归属与查询按发言人）';
  const tmp = makeTempDir('mu11-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP11);
  const aSubmit = 'GROUP-MU11 A 交办查账';
  const bSubmit = 'GROUP-MU11 B 交办查账';
  plans.delegate('mu-alice', aSubmit, { reply: 'A 已受理。', operation: 'dummy.query', args: { '--collection': 'GROUP-MU11-A' }, summary: 'A 完成。' });
  plans.delegate('mu-bob', bSubmit, { reply: 'B 已受理。', operation: 'dummy.query', args: { '--collection': 'GROUP-MU11-B' }, summary: 'B 完成。' });

  const ctx = makeCtx(plans.table(), null);
  // background：任务工具面齐全（含 task_cancel）；不注入假执行器 → 假 Worker 驱动的
  // execute_operation 记入 ExecutionRecord（避免 completed 零执行触发 H4 假完成）。
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'background', runtime: rt });
  try {
    const aReply = await deliver(handle.server.handler, incoming('mu-alice', GROUP11, 'a-1', aSubmit, 'group'));
    const bReply = await deliver(handle.server.handler, incoming('mu-bob', GROUP11, 'b-1', bSubmit, 'group'));

    const tasksAfterDelegation = readTasks(handle.dbPath);
    const aTask = tasksAfterDelegation.find((task) => task.request === aSubmit) ?? null;
    const bTask = tasksAfterDelegation.find((task) => task.request === bSubmit) ?? null;
    const aNo = aTask?.taskNo ?? 0;
    const bNo = bTask?.taskNo ?? 0;

    const bCrossText = 'GROUP-MU11 B 查 A 的编号';
    const aOwnText = 'GROUP-MU11 A 查自己的编号';
    const bOwnText = 'GROUP-MU11 B 查自己的编号';
    plans.turn('mu-bob', bCrossText, {
      calls: [
        { tool: 'task_status', args: { ref: `#${aNo}` } },
        { tool: 'task_result', args: { ref: `#${aNo}` } },
        { tool: 'task_cancel', args: { ref: `#${aNo}` } },
      ],
      reply: '群里没有这个任务。',
    });
    plans.turn('mu-alice', aOwnText, { calls: [{ tool: 'task_status', args: { ref: `#${aNo}` } }], reply: 'A 自己的任务。' });
    plans.turn('mu-bob', bOwnText, { calls: [{ tool: 'task_status', args: { ref: `#${bNo}` } }], reply: 'B 自己的任务。' });

    const bCrossReply = await deliver(handle.server.handler, incoming('mu-bob', GROUP11, 'b-2', bCrossText, 'group'));
    const aOwnReply = await deliver(handle.server.handler, incoming('mu-alice', GROUP11, 'a-2', aOwnText, 'group'));
    const bOwnReply = await deliver(handle.server.handler, incoming('mu-bob', GROUP11, 'b-3', bOwnText, 'group'));

    const bCrossRecord = ctx.mainRecords.find((record) => record.userText === bCrossText);
    const aOwnRecord = ctx.mainRecords.find((record) => record.userText === aOwnText);
    const bOwnRecord = ctx.mainRecords.find((record) => record.userText === bOwnText);
    const bCrossQueries = (bCrossRecord?.calls ?? []).map((call) => observationOf(call)!);
    const aOwnQueries = (aOwnRecord?.calls ?? []).map((call) => observationOf(call)!);
    const bOwnQueries = (bOwnRecord?.calls ?? []).map((call) => observationOf(call)!);

    const tasks = readTasks(handle.dbPath);
    const expectedOwnerByRequest = new Map<string, string>([
      [aSubmit, principalIdOf('mu-alice')],
      [bSubmit, principalIdOf('mu-bob')],
    ]);
    const judgement = judgeGroupTaskIsolation({
      tasks,
      expectedOwnerByRequest,
      aTaskId: aTask?.taskId ?? null,
      bTaskId: bTask?.taskId ?? null,
      bQueriesOfATask: bCrossQueries,
      aOwnQueries,
      bOwnQueries,
      forbiddenMarkers: [aSubmit, MU_TAGS['mu-alice']],
    });

    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const hardZeroHits: MuHardZero[] = [
      ...new Set<MuHardZero>([
        ...judgement.hits,
        ...(scope.length > 0 ? ['cross_principal_leak' as const] : []),
        ...crossover.hits,
      ]),
    ];
    const groupRepliesDelivered = aReply.includes('已受理') && bReply.includes('已受理')
      && [bCrossReply, aOwnReply, bOwnReply].every((reply) => reply.trim() !== '');

    const records = makeRecords(id, [
      { principalId: principalIdOf('mu-alice'), sessionId, taskId: aTask?.taskId ?? null, request: aSubmit, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-bob'), sessionId, taskId: bTask?.taskId ?? null, request: bSubmit, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-bob'), sessionId, taskId: null, request: bCrossText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-alice'), sessionId, taskId: aTask?.taskId ?? null, request: aOwnText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-bob'), sessionId, taskId: bTask?.taskId ?? null, request: bOwnText, deliveredTo: sessionId, kind: 'reply' },
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `同群 ${GROUP11}：A/B 各 1 任务（#${aNo}/#${bNo}）分属 ${aTask?.principalId ?? '缺失'}/${bTask?.principalId ?? '缺失'}；`
      + `B 查 A 的 ${bCrossQueries.length} 次全拒绝=${String(judgement.details['bCrossAllRejected'])}、泄漏=${String(judgement.details['bCrossLeaked'])}；`
      + `A/B 查自己=${String(judgement.details['aOwnResolved'])}/${String(judgement.details['bOwnResolved'])}；群内回复均已投递=${groupRepliesDelivered}。`,
      {
        ...judgement.details,
        sessionId,
        taskCount: tasks.length,
        aTaskId: aTask?.taskId ?? null,
        bTaskId: bTask?.taskId ?? null,
        aTaskNo: aTask?.taskNo ?? null,
        bTaskNo: bTask?.taskNo ?? null,
        groupRepliesDelivered,
        replies: { aReply, bReply, bCrossReply, aOwnReply, bOwnReply },
        bCrossCalls: bCrossQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error })),
        aOwnCalls: aOwnQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error })),
        bOwnCalls: bOwnQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error })),
        scopeViolations: scope,
        crossoverCodes: crossover.verdict,
        allTasks: tasks.map((task) => ({
          taskId: task.taskId, taskNo: task.taskNo, principalId: task.principalId,
          sessionId: task.sessionId, status: task.status, request: task.request, requestIds: task.requestIds,
        })),
      });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-12 同群引用他人附件
// ─────────────────────────────────────────────────────────────────────────────

export async function mu12(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-12';
  const title = '同群 B 引用 A 的附件（与不存在同话术拒绝，不泄露存在性）';
  const tmp = makeTempDir('mu12-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP12);
  const sourceName = 'mu12-a-list.xlsx';
  const sourcePath = path.join(tmp.dir, sourceName);
  const sourceContent = 'MU12-A-SECRET-CONTENT';
  writeFileSync(sourcePath, sourceContent);

  const aFileText = 'GROUP-MU12 A 已发文件';
  plans.turn('mu-alice', aFileText, { reply: '文件已收到。' });
  const ctx = makeCtx(plans.table(), null);
  // inline：本用例固定前台派发，聚焦「文件解析作用域」路径（background 的受理/排队时序
  // 不在本判据内；background 现已支持 inputFiles，见 runtime-background-input-files）。
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    // ① A 在群里发纯附件（暂存 pending，不起回合）→ ② A 发文字激活本会话文件。
    await deliver(handle.server.handler, {
      ...incoming('mu-alice', GROUP12, 'a-file', '', 'group'),
      attachments: [{ filename: sourceName, path: sourcePath, bytes: Buffer.byteLength(sourceContent, 'utf8') }],
      attachmentOnly: true,
    });
    await deliver(handle.server.handler, incoming('mu-alice', GROUP12, 'a-text', aFileText, 'group'));

    const aTurn = ctx.mainRecords.find((record) => record.userText === aFileText);
    if (aTurn === undefined) throw new Error('MU-12 未采集到 A 的激活回合');
    const aFileId = fileIdFromInjections(aTurn.injections);
    if (aFileId === null) throw new Error('MU-12 A 回合清单注入缺少 fileId（附件激活未生效）');

    // ③ B 在同群引用 A 的 fileId：task_run 与 run_js 都必须拒绝；同时用不存在 fileId 做对照。
    const nonexistentFileId = 'file_00000000000000000000000000000000';
    const bForeignTask = 'GROUP-MU12 B 处理群里的文件';
    const bNonexistentTask = 'GROUP-MU12 B 处理不存在的文件';
    const bForeignText = 'GROUP-MU12 B 引用 A 的文件';
    plans.turn('mu-bob', bForeignText, {
      calls: [
        { tool: 'task_run', args: { task: bForeignTask, inputFiles: [aFileId] } },
        { tool: 'task_run', args: { task: bNonexistentTask, inputFiles: [nonexistentFileId] } },
        { tool: 'run_js', args: { code: 'module.exports = { ok: true };', inputs: [aFileId] } },
      ],
      reply: '这份文件用不了。',
    });
    const bTaskCountBefore = readTasks(handle.dbPath).length;
    await deliver(handle.server.handler, incoming('mu-bob', GROUP12, 'b-1', bForeignText, 'group'));
    const tasksAfterB = readTasks(handle.dbPath);
    const bTaskCountAfter = tasksAfterB.length;

    const bTurn = ctx.mainRecords.find((record) => record.userText === bForeignText);
    if (bTurn === undefined) throw new Error('MU-12 未采集到 B 的引用回合');
    const bManifestSawForeign = bTurn.injections.join('\n').includes(aFileId)
      || bTurn.injections.join('\n').includes(sourceName);
    const bForeignTaskRun = fileObservationOf(bTurn.calls[0]);
    const bNonexistentTaskRun = fileObservationOf(bTurn.calls[1]);
    const bForeignRunJs = fileObservationOf(bTurn.calls[2]);

    // ④ 正向对照：A 用自己的 fileId 交办 → 成功建任务（否则「全拒绝也算绿」）。
    const aUseText = 'GROUP-MU12 A 用自己的文件交办';
    plans.delegate('mu-alice', aUseText, {
      reply: 'A 已受理。', operation: 'dummy.query', args: { '--collection': 'GROUP-MU12-A' },
      summary: 'A 完成。', inputFiles: [aFileId],
    });
    await deliver(handle.server.handler, incoming('mu-alice', GROUP12, 'a-use', aUseText, 'group'));

    const tasks = readTasks(handle.dbPath);
    const aTask = tasks.find((task) => task.request === aUseText) ?? null;
    const aOwnCall = ctx.mainRecords.find((record) => record.userText === aUseText)?.calls[0];

    const judgement = judgeForeignFileReference({
      aFileId,
      aFileName: sourceName,
      bForeignTaskRun,
      bForeignRunJs,
      bNonexistentTaskRun,
      aOwnTaskRun: fileObservationOf(aOwnCall),
      bTaskCountBefore,
      bTaskCountAfter,
      aTaskCountAfter: tasks.length,
      bManifestSawForeign,
    });
    const scope = scopeViolations(plans.table(), tasks);
    const crossover = crossoverHits(tasks);
    const hardZeroHits: MuHardZero[] = [
      ...new Set<MuHardZero>([
        ...judgement.hits,
        ...(scope.length > 0 ? ['cross_principal_leak' as const] : []),
        ...crossover.hits,
      ]),
    ];
    const aOwnFileTaskCreated = aOwnCall?.error === null && aTask !== null;

    const records = makeRecords(id, [
      { principalId: principalIdOf('mu-alice'), sessionId, taskId: null, request: aFileText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-bob'), sessionId, taskId: null, request: bForeignText, deliveredTo: sessionId, kind: 'reply' },
      ...(aTask === null ? [] : [{
        principalId: aTask.principalId, sessionId, taskId: aTask.taskId, request: aTask.request,
        deliveredTo: sessionId, kind: 'reply' as const,
      }]),
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `A 文件 fileId=${aFileId}；B task_run 外语=${String(bForeignTaskRun?.error)}；B run_js 外语=${String(bForeignRunJs?.error)}；`
      + `不存在对照=${String(bNonexistentTaskRun?.error)}；同话术=${String(judgement.details['sameWordingAsNonexistent'])}；`
      + `B 清单见外语文件=${bManifestSawForeign}；B 失败尝试任务行 ${bTaskCountBefore}→${bTaskCountAfter}；`
      + `A 用自己的 fileId 建任务=${aOwnFileTaskCreated}（taskCount=${tasks.length}）。`,
      {
        ...judgement.details,
        aFileId,
        aFileName: sourceName,
        bForeignTaskRunError: bForeignTaskRun?.error ?? null,
        bForeignRunJsError: bForeignRunJs?.error ?? null,
        bNonexistentTaskRunError: bNonexistentTaskRun?.error ?? null,
        bManifestSawForeign,
        bManifestInjections: bTurn.injections,
        bTaskCountBefore,
        bTaskCountAfter,
        aOwnFileTaskCreated,
        taskCount: tasks.length,
        aTaskPrincipal: aTask?.principalId ?? null,
        aTaskId: aTask?.taskId ?? null,
        scopeViolations: scope,
        crossoverCodes: crossover.verdict,
        allTasks: tasks.map((task) => ({
          taskId: task.taskId, taskNo: task.taskNo, principalId: task.principalId,
          sessionId: task.sessionId, status: task.status, request: task.request, requestIds: task.requestIds,
        })),
      });
  } finally { handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-13 结果投递回群 ≠ 授权继承（真实渠道路径）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu13(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-13';
  const title = '结果投递回群但查询授权按发言人（同群不继承他人任务）';
  const tmp = makeTempDir('mu13-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP13);
  const aSubmit = 'GROUP-MU13 A 交办查账';
  const aResultReply = 'A-MU13 完成：已核对 3 条。';
  plans.delegate('mu-alice', aSubmit, { reply: aResultReply, operation: 'dummy.query', args: { '--collection': 'GROUP-MU13-A' }, summary: '3 条。' });
  const ctx = makeCtx(plans.table(), null);
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  const started = await startLiveWecomChannel(handle.server.handler, tmp.dir);
  try {
    // ① A 在群里交办 → 结果经渠道出站（帧体 chatid 可核对）。
    started.sdk.emit('message.text', wecomTextFrame('cb-mu13-a', {
      msgid: 'a-1', from: 'mu-alice', content: aSubmit, chattype: 'group', chatid: GROUP13,
    }));
    const aDelivered = await waitUntil(() => started.sdk.replyStreams.some((stream) => stream.content.includes(aResultReply)), 5000);
    if (!aDelivered) throw new Error('MU-13 A 的结果没有经渠道投出');

    const tasks = readTasks(handle.dbPath);
    const aTask = tasks.find((task) => task.principalId === principalIdOf('mu-alice') && task.sessionId === sessionId);
    const aNo = aTask?.taskNo ?? 0;

    // ② B 在同一个群查 A 的编号：必须拒绝。③ A 查自己的编号：必须成功（正向对照）。
    const bQueryText = 'GROUP-MU13 B 查 A 的编号';
    const aOwnText = 'GROUP-MU13 A 查自己的编号';
    plans.turn('mu-bob', bQueryText, { calls: [{ tool: 'task_status', args: { ref: `#${aNo}` } }], reply: '群里没有这个任务。' });
    plans.turn('mu-alice', aOwnText, { calls: [{ tool: 'task_status', args: { ref: `#${aNo}` } }], reply: 'A-MU13 自己的任务。' });

    started.sdk.emit('message.text', wecomTextFrame('cb-mu13-b', {
      msgid: 'b-1', from: 'mu-bob', content: bQueryText, chattype: 'group', chatid: GROUP13,
    }));
    const bReplyDelivered = await waitUntil(() => started.sdk.replyStreams.some((stream) => stream.content.includes('群里没有这个任务')), 5000);
    started.sdk.emit('message.text', wecomTextFrame('cb-mu13-a2', {
      msgid: 'a-2', from: 'mu-alice', content: aOwnText, chattype: 'group', chatid: GROUP13,
    }));
    const aOwnDelivered = await waitUntil(() => started.sdk.replyStreams.some((stream) => stream.content.includes('A-MU13 自己的任务')), 5000);
    await settle();

    const outbound: GroupOutboundObservation[] = [
      ...started.sdk.replyStreams.map((stream) => ({ chatid: stream.chatid, content: stream.content })),
      ...started.sdk.sentMessages.map((message) => ({ chatid: message.chatid, content: message.content })),
    ];
    const bQueryRecord = ctx.mainRecords.find((record) => record.userText === bQueryText);
    const aOwnRecord = ctx.mainRecords.find((record) => record.userText === aOwnText);
    const bQuery = observationOf(bQueryRecord?.calls[0]) ?? { tool: 'task_status', ref: `#${aNo}`, error: '未执行', result: null };
    const aOwn = observationOf(aOwnRecord?.calls[0]);
    const bScopeTasks = tasksOfScope(readTasks(handle.dbPath), 'mu-bob', GROUP13);

    const judgement = judgeGroupDeliveryIsolation({
      groupChatId: GROUP13,
      outbound,
      aReply: aResultReply,
      bQuery,
      bQueryReply: ctx.mainRecords.find((record) => record.userText === bQueryText)?.reply ?? '',
      aTaskId: aTask?.taskId ?? null,
      bScopeTasks,
      forbiddenMarkers: [aSubmit, MU_TAGS['mu-alice'], 'GROUP-MU13-A'],
    });

    const hardZeroHits: MuHardZero[] = [...judgement.hits];
    const bQueryLeaked = judgement.details['bQueryLeaked'] === true;

    const records = makeRecords(id, [
      ...(aTask === undefined ? [] : [{
        principalId: aTask.principalId, sessionId, taskId: aTask.taskId, request: aTask.request,
        deliveredTo: sessionId, kind: 'reply' as const,
      }]),
      { principalId: principalIdOf('mu-bob'), sessionId, taskId: null, request: bQueryText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: principalIdOf('mu-alice'), sessionId, taskId: aTask?.taskId ?? null, request: aOwnText, deliveredTo: sessionId, kind: 'reply' },
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `A 的回复经渠道投回群=${String(judgement.details['aReplyDeliveredToGroup'])}（B 拒绝帧已投=${bReplyDelivered}、A 自查帧已投=${aOwnDelivered}）；`
      + `B 同群查 A 的 #${aNo} 被拒=${String(judgement.details['bQueryRejected'])}、泄漏=${String(bQueryLeaked)}；`
      + `B 的 scope 任务数=${bScopeTasks.length}；所有出站 chatid=${JSON.stringify(judgement.details['outboundChatIds'])}。`,
      {
        ...judgement.details,
        groupChatId: GROUP13,
        sessionId,
        aTaskId: aTask?.taskId ?? null,
        aTaskNo: aTask?.taskNo ?? null,
        aTaskPrincipal: aTask?.principalId ?? null,
        aOwnResolved: aOwn !== undefined && aOwn.error === null && taskIdOf(aOwn.result) === (aTask?.taskId ?? null),
        bQueryCalls: bQueryRecord?.calls.map((call) => ({ tool: call.tool, ref: call.args['ref'], error: call.error })),
        bQueryReply: ctx.mainRecords.find((record) => record.userText === bQueryText)?.reply ?? null,
        bScopeTaskCount: bScopeTasks.length,
        bReplyDelivered,
        aOwnDelivered,
        outbound,
        allTasks: readTasks(handle.dbPath).map((task) => ({
          taskId: task.taskId, taskNo: task.taskNo, principalId: task.principalId,
          sessionId: task.sessionId, status: task.status, request: task.request, requestIds: task.requestIds,
        })),
      });
  } finally { await started.stop(); handle.close(); tmp.cleanup(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 群聊多用户全量运行
// ─────────────────────────────────────────────────────────────────────────────

export async function runAllGroupMuCases(rt: RuntimeConfig): Promise<MuCaseResult[]> {
  const results: MuCaseResult[] = [];
  for (const runner of [mu11, mu12, mu13]) {
    results.push(await runner(rt));
  }
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  writeFileSync(path.join(EVIDENCE_ROOT, 'summary-group.json'), JSON.stringify(results.map((result) => ({
    id: result.id, title: result.title, status: result.status, hardZeroHits: result.hardZeroHits, notes: result.notes,
  })), null, 2));
  return results;
}
