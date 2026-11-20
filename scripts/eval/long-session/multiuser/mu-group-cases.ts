/**
 * R6 MU · 群聊多用户交办（MU-11～MU-13）——同一群（同 conversationId）里 A/B 两位发言人。
 *
 * **语义已被取代（owner 2026-11-18：群 = 独立主体）**。旧模型（本文件 2026-11-18 之前）是
 * 「principal 按发言人分、session 按群分」：同群 A/B 各归各人、互不可见。新模型是
 * `principalId = wecom:group:<conversationId>`——**整个群一个主体**，同群所有人共用记忆/文件/
 * 任务，发言人只作审计（日志页 `speakerId`，不落任务列）。因此本文件的三条用例按新模型重写：
 *   · MU-11：同群 A/B 各自交办 → 两条任务**同属群主体**（同 principal + 同 session）；B 查 A 的
 *     编号**必须成功**（共享）；A 查 B 的编号也必须成功（对称）；**另一个群**的 C 查同一编号必须
 *     确定性拒绝且无内容泄漏（跨群不串）；B 一回合的转录里看得到 A 上一句（共享记忆）。
 *   · MU-12：A 在群里发附件 → **同群** B 能看见并用自己的交办引用它（群文件 = 群资产）；
 *     **另一个群**的 C 引用同一 fileId → `输入文件不可用` 且与不存在的 fileId 逐字同话术
 *     （不泄露存在性），C 的清单里没有该文件、C 零任务行。
 *   · MU-13：经真实渠道（WecomBotChannel + 记录型假 SDK，显式 live）把结果投回**同一个群**；
 *     同群 B 查 A 的编号成功（共享）；另一个群的 C 查同一编号被拒；出站不投到任何私聊/他处。
 *
 * 硬边界（与 MU 夹具一致）：零真实模型 / 零真实企微 / 零真实写；判定器是纯函数，
 * 反向绊线直接对判定器喂「泄漏/越权/错投/共享失效」观测，证明断言不是恒真。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from '@fshine/contracts';
import {
  createMuServer, deliver, groupPrincipalIdOf, incoming, makeCtx, makeTempDir, readTasks,
  MU_TAGS, MuPlans, principalIdOf, sessionIdOf, settle, startLiveWecomChannel, wecomTextFrame,
  type MuDeliveryRecord, type MuHardZero, type MuPrincipal, type MuTaskSnapshot, type MuCaseResult,
} from './mu-support';
import {
  EVIDENCE_ROOT, TASK_NOT_IN_SESSION, crossoverHits, finalize, makeRecords, scopeViolations, waitUntil,
} from './mu-cases';

const GROUP11 = 'group-mu11';
const GROUP12 = 'group-mu12';
const GROUP13 = 'group-mu13';
/** 对照组群（同样已开通；用于证明「跨群不串」，不是靠未开通拒绝冒充隔离）。 */
const GROUP11_OTHER = 'group-mu11-other';
const GROUP12_OTHER = 'group-mu12-other';
const GROUP13_OTHER = 'group-mu13-other';

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

function rejectedOutOfScope(query: GroupQueryObservation): boolean {
  return query.error !== null && query.error.includes(TASK_NOT_IN_SESSION);
}

function resolvedTo(query: GroupQueryObservation, taskId: string | null): boolean {
  return taskId !== null && query.error === null && taskIdOf(query.result) === taskId;
}

export interface GroupSharedPrincipalInput {
  readonly tasks: readonly MuTaskSnapshot[];
  /** 群主体（`wecom:group:<群id>`）：同群所有任务都必须归它。 */
  readonly groupPrincipalId: string;
  readonly aTaskId: string | null;
  readonly bTaskId: string | null;
  /** 同群 B 查 A 的编号（必须成功——群共享）。 */
  readonly bQueriesOfATask: readonly GroupQueryObservation[];
  /** 同群 A 查 B 的编号（对称校验，防「只有单向看得见」也算绿）。 */
  readonly aQueriesOfBTask: readonly GroupQueryObservation[];
  /** 另一个群的 C 查 A 的编号（必须确定性拒绝）。 */
  readonly otherGroupQueries: readonly GroupQueryObservation[];
  /** A 的请求原文/语料标记（用于检异群是否泄漏内容）。 */
  readonly forbiddenMarkers: readonly string[];
  /** 同群第二个发言人的回合转录里是否看得到第一个发言人的原话（共享记忆）。 */
  readonly sameGroupMemoryShared: boolean;
}

/**
 * MU-11 判定：同群 = 同一主体（任务同属群主体、同群互查必须成功、转录共享）；
 * 跨群 = 不同主体（异群查不到、无内容泄漏）。
 */
export function judgeGroupSharedPrincipal(input: GroupSharedPrincipalInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const sessionIds = [...new Set(input.tasks.map((task) => task.sessionId))];
  const principals = [...new Set(input.tasks.map((task) => task.principalId))];
  const ownerMismatches = input.tasks
    .filter((task) => task.principalId !== input.groupPrincipalId)
    .map((task) => task.taskId);
  const bResolved = input.bQueriesOfATask.length > 0
    && input.bQueriesOfATask.every((query) => resolvedTo(query, input.aTaskId));
  const aResolved = input.aQueriesOfBTask.length > 0
    && input.aQueriesOfBTask.every((query) => resolvedTo(query, input.bTaskId));
  const otherAllRejected = input.otherGroupQueries.length > 0 && input.otherGroupQueries.every(rejectedOutOfScope);
  const otherResolved = input.otherGroupQueries.filter((query) => query.error === null).length;
  const otherLeaked = input.otherGroupQueries.some((query) => containsAny(observationText(query), input.forbiddenMarkers));

  if (input.tasks.length !== 2 || sessionIds.length !== 1) hits.add('task_crossover');
  if (ownerMismatches.length > 0) hits.add('cross_principal_leak');
  // 共享失效（同群查不到本群任务 / 转录不共享）与跨群越权都算越权执行。
  if (!bResolved || !aResolved || !input.sameGroupMemoryShared) hits.add('unauthorized_execution');
  if (otherResolved > 0 || !otherAllRejected) hits.add('unauthorized_execution');
  if (otherLeaked) hits.add('cross_principal_leak');

  return {
    hits: [...hits],
    details: {
      sessionIds,
      principals,
      groupPrincipalId: input.groupPrincipalId,
      ownerMismatches,
      taskCount: input.tasks.length,
      sameGroupResolved: bResolved && aResolved,
      sameGroupMemoryShared: input.sameGroupMemoryShared,
      otherGroupAllRejected: otherAllRejected,
      otherGroupResolvedCount: otherResolved,
      otherGroupLeaked: otherLeaked,
    },
  };
}

export interface FileCallObservation {
  readonly tool: string;
  readonly error: string | null;
  readonly result: unknown;
}

export interface GroupFileSharingInput {
  readonly groupPrincipalId: string;
  readonly aFileId: string;
  readonly aFileName: string;
  /** 同群 B 的交办调用（引用 A 的 fileId）——必须成功（群文件 = 群资产）。 */
  readonly bSharedTaskRun: FileCallObservation | undefined;
  /** 同群 B 回合的文件清单是否含 A 的文件（应含）。 */
  readonly bManifestSawShared: boolean;
  /** 另一个群 C 引用同一 fileId / 引用不存在的 fileId（话术必须逐字一致）。 */
  readonly cForeignTaskRun: FileCallObservation | undefined;
  readonly cNonexistentTaskRun: FileCallObservation | undefined;
  readonly cTaskCountBefore: number;
  readonly cTaskCountAfter: number;
  /** C 回合的文件清单是否出现 A 的 fileId/文件名（应否）。 */
  readonly cManifestSawForeign: boolean;
  /** 同群 B 交办建出的任务行（用于核对归属与条数）。 */
  readonly groupTaskPrincipal: string | null;
  readonly groupTaskCount: number;
}

/**
 * MU-12 判定：群文件归群（同群可共享、任务归群主体）；异群引用必须与「不存在」同话术拒绝、
 * 清单不可见、零任务行（不产生存在性 oracle，不越权执行）。
 */
export function judgeGroupFileSharing(input: GroupFileSharingInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const bSharedUsable = input.bSharedTaskRun?.error === null && input.bManifestSawShared;
  const cAllRejected = input.cForeignTaskRun?.error != null && input.cNonexistentTaskRun?.error != null;
  const cSameWording = cAllRejected && input.cForeignTaskRun!.error === input.cNonexistentTaskRun!.error;
  const cLeakedMarkers = [input.aFileId, input.aFileName]
    .filter((marker) => input.cForeignTaskRun !== undefined && observationText(input.cForeignTaskRun).includes(marker));
  const cNoTaskRow = input.cTaskCountBefore === input.cTaskCountAfter;
  const groupTaskOwnedByGroup = input.groupTaskPrincipal === input.groupPrincipalId;

  if (input.cManifestSawForeign || cLeakedMarkers.length > 0) hits.add('cross_principal_leak');
  if (!bSharedUsable || !cAllRejected || !cSameWording) hits.add('unauthorized_execution');
  if (!cNoTaskRow || !groupTaskOwnedByGroup || input.groupTaskCount !== 1) hits.add('task_crossover');

  return {
    hits: [...hits],
    details: {
      bSharedUsable,
      bManifestSawShared: input.bManifestSawShared,
      cAllRejected,
      cSameWordingAsNonexistent: cSameWording,
      cLeakedMarkers,
      cManifestSawForeign: input.cManifestSawForeign,
      cNoTaskRow,
      cTaskCountBefore: input.cTaskCountBefore,
      cTaskCountAfter: input.cTaskCountAfter,
      groupTaskOwnedByGroup,
      groupTaskPrincipal: input.groupTaskPrincipal,
      groupTaskCount: input.groupTaskCount,
    },
  };
}

export interface GroupOutboundObservation {
  readonly chatid: string | null;
  readonly content: string;
}

export interface GroupDeliverySharingInput {
  readonly groupChatId: string;
  /** 允许的出站目标（本群 + 对照群）；出现其他目标（私聊/他群）= 错投。 */
  readonly allowedChatIds: readonly string[];
  readonly outbound: readonly GroupOutboundObservation[];
  /** A 的结果片段（必须出现在发往本群的某条出站帧里）。 */
  readonly aReply: string;
  /** 同群 B 查 A 的编号（应成功）。 */
  readonly bQuery: GroupQueryObservation;
  /** 异群 C 查 A 的编号（应拒绝）。 */
  readonly cQuery: GroupQueryObservation;
  readonly cQueryReply: string;
  readonly aTaskId: string | null;
  readonly forbiddenMarkers: readonly string[];
}

/**
 * MU-13 判定：结果必须投回本群且不投到任何其他目标；同群查询成功（共享），异群查询被拒、
 * 无内容泄漏。
 */
export function judgeGroupDeliverySharing(input: GroupDeliverySharingInput): GroupJudgement {
  const hits = new Set<MuHardZero>();
  const aReplyDeliveredToGroup = input.outbound.some(
    (message) => message.chatid === input.groupChatId && message.content.includes(input.aReply),
  );
  const foreignTargets = input.outbound
    .filter((message) => message.chatid === null || !input.allowedChatIds.includes(message.chatid))
    .map((message) => message.chatid);
  const bQueryResolved = resolvedTo(input.bQuery, input.aTaskId);
  const cQueryRejected = rejectedOutOfScope(input.cQuery);
  const leaked = containsAny(`${observationText(input.cQuery)}\n${input.cQueryReply}`, input.forbiddenMarkers);

  if (!aReplyDeliveredToGroup || foreignTargets.length > 0) hits.add('notification_misdelivery');
  if (!bQueryResolved || !cQueryRejected) hits.add('unauthorized_execution');
  if (leaked) hits.add('cross_principal_leak');

  return {
    hits: [...hits],
    details: {
      aReplyDeliveredToGroup,
      foreignTargets,
      outboundCount: input.outbound.length,
      outboundChatIds: [...new Set(input.outbound.map((message) => message.chatid))],
      bQueryResolved,
      cQueryRejected,
      cQueryLeaked: leaked,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 观测提取
// ─────────────────────────────────────────────────────────────────────────────

function observationOf(call: { tool: string; args: Readonly<Record<string, unknown>>; result: unknown; error: string | null } | undefined): GroupQueryObservation | undefined {
  if (call === undefined) return undefined;
  return {
    tool: call.tool,
    ref: String(call.args['ref'] ?? ''),
    error: call.error,
    result: call.result,
  };
}

function fileObservationOf(call: { tool: string; error: string | null; result: unknown } | undefined): FileCallObservation | undefined {
  if (call === undefined) return undefined;
  return { tool: call.tool, error: call.error, result: call.result };
}

function fileIdFromInjections(injections: readonly string[]): string | null {
  const match = injections.join('\n').match(/fileId: (file_[0-9a-f]{32})/);
  return match?.[1] ?? null;
}

function tasksOfGroupPrincipal(tasks: readonly MuTaskSnapshot[], conversationId: string): MuTaskSnapshot[] {
  return tasks.filter((task) => task.principalId === groupPrincipalIdOf(conversationId)
    && task.sessionId === sessionIdOf(conversationId));
}

/** 转录投影里的文本（user/assistant content 可能是字符串或分块）。 */
function transcriptTexts(messages: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') { texts.push(content); continue; }
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
  }
  return texts;
}

// ─────────────────────────────────────────────────────────────────────────────
// MU-11 同群 = 同一主体（共享）+ 跨群不串
// ─────────────────────────────────────────────────────────────────────────────

export async function mu11(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-11';
  const title = '同群共用群主体（互查成功）+ 跨群不串（异群查不到）';
  const tmp = makeTempDir('mu11-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP11);
  const groupPrincipal = groupPrincipalIdOf(GROUP11);
  const otherGroupPrincipal = groupPrincipalIdOf(GROUP11_OTHER);
  const aSubmit = 'GROUP-MU11 A 交办查账';
  const bSubmit = 'GROUP-MU11 B 交办查账';
  plans.delegate('mu-alice', aSubmit, { reply: 'A 已受理。', operation: 'dummy.query', args: { '--collection': 'GROUP-MU11-A' }, summary: 'A 完成。', principal: groupPrincipal });
  plans.delegate('mu-bob', bSubmit, { reply: 'B 已受理。', operation: 'dummy.query', args: { '--collection': 'GROUP-MU11-B' }, summary: 'B 完成。', principal: groupPrincipal });

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
    // 2026-11-20：数字 ref 退役——同群/异群引用改用真实 taskId（判据强度不变）。
    const aRef = aTask?.taskId ?? '';
    const bRef = bTask?.taskId ?? '';

    const bCrossText = 'GROUP-MU11 B 查 A 的编号';
    const aCrossText = 'GROUP-MU11 A 查 B 的编号';
    const otherGroupText = 'GROUP-MU11 别的群查 A 的编号';
    plans.turn('mu-bob', bCrossText, {
      calls: [
        { tool: 'task_status', args: { ref: aRef } },
        { tool: 'task_result', args: { ref: aRef } },
      ],
      reply: '本群的任务。',
      principal: groupPrincipal,
    });
    plans.turn('mu-alice', aCrossText, { calls: [{ tool: 'task_status', args: { ref: bRef } }], reply: '本群的任务。', principal: groupPrincipal });
    plans.turn('mu-carol', otherGroupText, { calls: [{ tool: 'task_status', args: { ref: aRef } }], reply: '别的群里没有这个任务。', principal: otherGroupPrincipal });

    const bCrossReply = await deliver(handle.server.handler, incoming('mu-bob', GROUP11, 'b-2', bCrossText, 'group'));
    const aCrossReply = await deliver(handle.server.handler, incoming('mu-alice', GROUP11, 'a-2', aCrossText, 'group'));
    const otherGroupReply = await deliver(handle.server.handler, incoming('mu-carol', GROUP11_OTHER, 'c-1', otherGroupText, 'group'));

    const bCrossRecord = ctx.mainRecords.find((record) => record.userText === bCrossText);
    const aCrossRecord = ctx.mainRecords.find((record) => record.userText === aCrossText);
    const otherGroupRecord = ctx.mainRecords.find((record) => record.userText === otherGroupText);
    const bCrossQueries = (bCrossRecord?.calls ?? []).map((call) => observationOf(call)!);
    const aCrossQueries = (aCrossRecord?.calls ?? []).map((call) => observationOf(call)!);
    const otherGroupQueries = (otherGroupRecord?.calls ?? []).map((call) => observationOf(call)!);

    const tasks = readTasks(handle.dbPath);
    // 共享记忆：同群第二个发言人（B）的回合转录里看得到 A 的原话。
    const sameGroupMemoryShared = bCrossRecord !== undefined
      && transcriptTexts(bCrossRecord.messages).some((text) => text.includes(aSubmit));
    const judgement = judgeGroupSharedPrincipal({
      tasks,
      groupPrincipalId: groupPrincipal,
      aTaskId: aTask?.taskId ?? null,
      bTaskId: bTask?.taskId ?? null,
      bQueriesOfATask: bCrossQueries,
      aQueriesOfBTask: aCrossQueries,
      otherGroupQueries,
      forbiddenMarkers: [aSubmit, MU_TAGS['mu-alice']],
      sameGroupMemoryShared,
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
      && [bCrossReply, aCrossReply, otherGroupReply].every((reply) => reply.trim() !== '');

    const records = makeRecords(id, [
      { principalId: groupPrincipal, sessionId, taskId: aTask?.taskId ?? null, request: aSubmit, deliveredTo: sessionId, kind: 'reply' },
      { principalId: groupPrincipal, sessionId, taskId: bTask?.taskId ?? null, request: bSubmit, deliveredTo: sessionId, kind: 'reply' },
      { principalId: groupPrincipal, sessionId, taskId: aTask?.taskId ?? null, request: bCrossText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: groupPrincipal, sessionId, taskId: bTask?.taskId ?? null, request: aCrossText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: otherGroupPrincipal, sessionId: sessionIdOf(GROUP11_OTHER), taskId: null, request: otherGroupText, deliveredTo: sessionIdOf(GROUP11_OTHER), kind: 'reply' },
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `同群 ${GROUP11}：A/B 各 1 任务（#${aNo}/#${bNo}）同属 ${aTask?.principalId ?? '缺失'}；`
      + `同群互查成功=${String(judgement.details['sameGroupResolved'])}、转录共享=${String(sameGroupMemoryShared)}；`
      + `异群 ${GROUP11_OTHER} 查 #${aNo} 全拒绝=${String(judgement.details['otherGroupAllRejected'])}、泄漏=${String(judgement.details['otherGroupLeaked'])}；`
      + `群内回复均已投递=${groupRepliesDelivered}。`,
      {
        ...judgement.details,
        sessionId,
        otherGroupSessionId: sessionIdOf(GROUP11_OTHER),
        taskCount: tasks.length,
        aTaskId: aTask?.taskId ?? null,
        bTaskId: bTask?.taskId ?? null,
        aTaskNo: aTask?.taskNo ?? null,
        bTaskNo: bTask?.taskNo ?? null,
        groupRepliesDelivered,
        replies: { aReply, bReply, bCrossReply, aCrossReply, otherGroupReply },
        bCrossCalls: bCrossQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error, taskId: taskIdOf(query.result) })),
        aCrossCalls: aCrossQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error, taskId: taskIdOf(query.result) })),
        otherGroupCalls: otherGroupQueries.map((query) => ({ tool: query.tool, ref: query.ref, error: query.error })),
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
// MU-12 群文件 = 群资产（同群可共享；异群不可见、同话术拒绝）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu12(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-12';
  const title = '群文件归群（同群可引用交办；异群引用与不存在同话术拒绝）';
  const tmp = makeTempDir('mu12-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP12);
  const groupPrincipal = groupPrincipalIdOf(GROUP12);
  const otherGroupPrincipal = groupPrincipalIdOf(GROUP12_OTHER);
  const sourceName = 'mu12-a-list.xlsx';
  const sourcePath = path.join(tmp.dir, sourceName);
  const sourceContent = 'MU12-A-SECRET-CONTENT';
  writeFileSync(sourcePath, sourceContent);

  const aFileText = 'GROUP-MU12 A 已发文件';
  plans.turn('mu-alice', aFileText, { reply: '文件已收到。', principal: groupPrincipal });
  const ctx = makeCtx(plans.table(), null);
  // inline：本用例固定前台派发，聚焦「文件解析作用域」路径（background 的受理/排队时序
  // 不在本判据内）。
  const handle = await createMuServer({ dir: tmp.dir, ctx, mode: 'inline', runtime: rt });
  try {
    // ① A 在群里发纯附件（暂存 pending，不起回合）→ ② A 发文字激活本群文件。
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

    // ③ 同群 B 引用 A 的文件交办 → 必须成功（群文件 = 群资产），任务归群主体。
    const bSharedText = 'GROUP-MU12 B 用群里的文件交办';
    plans.delegate('mu-bob', bSharedText, {
      reply: '用群里的文件办好了。',
      operation: 'dummy.query',
      args: { '--collection': 'GROUP-MU12-B' },
      summary: 'B 完成。',
      inputFiles: [aFileId],
      principal: groupPrincipal,
    });
    await deliver(handle.server.handler, incoming('mu-bob', GROUP12, 'b-1', bSharedText, 'group'));
    const bTurn = ctx.mainRecords.find((record) => record.userText === bSharedText);
    if (bTurn === undefined) throw new Error('MU-12 未采集到 B 的同群引用回合');
    const bSharedTaskRun = fileObservationOf(bTurn.calls[0]);
    const bManifestSawShared = bTurn.injections.join('\n').includes(aFileId);

    // ④ 另一个群的 C 引用同一 fileId（对照：不存在的 fileId）→ 同话术拒绝、清单不可见、零任务行。
    const nonexistentFileId = 'file_00000000000000000000000000000000';
    const cForeignTask = 'GROUP-MU12 C 处理别群的文件';
    const cNonexistentTask = 'GROUP-MU12 C 处理不存在的文件';
    const cForeignText = 'GROUP-MU12 C 引用别群文件';
    // Worker 计划只在这里登记：若 C 的文件引用被误接受，task_run 会真的走下去（留下任务行），
    // 断言因此不会因「Worker 未配置计划」误判成「被拒绝」。
    plans.workerTask(cForeignTask, { operation: 'dummy.query', args: { '--collection': 'GROUP-MU12-C-FOREIGN' }, summary: 'C 完成。' });
    plans.workerTask(cNonexistentTask, { operation: 'dummy.query', args: { '--collection': 'GROUP-MU12-C-MISSING' }, summary: 'C 完成。' });
    plans.turn('mu-carol', cForeignText, {
      calls: [
        { tool: 'task_run', args: { task: cForeignTask, inputFiles: [aFileId] } },
        { tool: 'task_run', args: { task: cNonexistentTask, inputFiles: [nonexistentFileId] } },
      ],
      reply: '这份文件用不了。',
      principal: otherGroupPrincipal,
    });
    const cTaskCountBefore = readTasks(handle.dbPath).length;
    await deliver(handle.server.handler, incoming('mu-carol', GROUP12_OTHER, 'c-1', cForeignText, 'group'));
    const tasksAfterC = readTasks(handle.dbPath);
    const cTaskCountAfter = tasksAfterC.length;

    const cTurn = ctx.mainRecords.find((record) => record.userText === cForeignText);
    if (cTurn === undefined) throw new Error('MU-12 未采集到 C 的异群引用回合');
    const cManifestSawForeign = cTurn.injections.join('\n').includes(aFileId)
      || cTurn.injections.join('\n').includes(sourceName);
    const cForeignTaskRun = fileObservationOf(cTurn.calls[0]);
    const cNonexistentTaskRun = fileObservationOf(cTurn.calls[1]);

    const tasks = readTasks(handle.dbPath);
    const groupTasks = tasksOfGroupPrincipal(tasks, GROUP12);
    const groupTask = groupTasks.find((task) => task.request === bSharedText) ?? null;

    const judgement = judgeGroupFileSharing({
      groupPrincipalId: groupPrincipal,
      aFileId,
      aFileName: sourceName,
      bSharedTaskRun,
      bManifestSawShared,
      cForeignTaskRun,
      cNonexistentTaskRun,
      cTaskCountBefore,
      cTaskCountAfter,
      cManifestSawForeign,
      groupTaskPrincipal: groupTask?.principalId ?? null,
      groupTaskCount: groupTasks.length,
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

    const records = makeRecords(id, [
      { principalId: groupPrincipal, sessionId, taskId: null, request: aFileText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: groupPrincipal, sessionId, taskId: groupTask?.taskId ?? null, request: bSharedText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: otherGroupPrincipal, sessionId: sessionIdOf(GROUP12_OTHER), taskId: null, request: cForeignText, deliveredTo: sessionIdOf(GROUP12_OTHER), kind: 'reply' },
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `A 的群文件 fileId=${aFileId}；同群 B 清单可见=${bManifestSawShared}、交办成功=${String(bSharedTaskRun?.error === null)}；`
      + `异群 C 引用外语=${String(cForeignTaskRun?.error)}；不存在对照=${String(cNonexistentTaskRun?.error)}；`
      + `同话术=${String(judgement.details['cSameWordingAsNonexistent'])}；C 清单见外语文件=${cManifestSawForeign}；`
      + `C 失败尝试零任务行=${String(judgement.details['cNoTaskRow'])}（${cTaskCountBefore}→${cTaskCountAfter}）；`
      + `群任务归群主体=${String(judgement.details['groupTaskOwnedByGroup'])}（count=${groupTasks.length}）。`,
      {
        ...judgement.details,
        aFileId,
        aFileName: sourceName,
        bSharedTaskRunError: bSharedTaskRun?.error ?? null,
        cForeignTaskRunError: cForeignTaskRun?.error ?? null,
        cNonexistentTaskRunError: cNonexistentTaskRun?.error ?? null,
        bManifestSawShared,
        cManifestSawForeign,
        cManifestInjections: cTurn.injections,
        groupTaskId: groupTask?.taskId ?? null,
        taskCount: tasks.length,
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
// MU-13 结果投回本群；同群可查、异群不可查（真实渠道路径）
// ─────────────────────────────────────────────────────────────────────────────

export async function mu13(rt: RuntimeConfig): Promise<MuCaseResult> {
  const id = 'MU-13';
  const title = '结果投回本群；同群可查、异群不可查（真实渠道路径）';
  const tmp = makeTempDir('mu13-group-');
  const plans = new MuPlans();
  const sessionId = sessionIdOf(GROUP13);
  const groupPrincipal = groupPrincipalIdOf(GROUP13);
  const otherGroupPrincipal = groupPrincipalIdOf(GROUP13_OTHER);
  const aSubmit = 'GROUP-MU13 A 交办查账';
  const aResultReply = 'A-MU13 完成：已核对 3 条。';
  plans.delegate('mu-alice', aSubmit, { reply: aResultReply, operation: 'dummy.query', args: { '--collection': 'GROUP-MU13-A' }, summary: '3 条。', principal: groupPrincipal });
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
    const aTask = tasksOfGroupPrincipal(tasks, GROUP13).find((task) => task.request === aSubmit) ?? null;
    const aNo = aTask?.taskNo ?? 0;
    // 2026-11-20：数字 ref 退役——按真实 taskId 查本群/异群（判据强度不变）。
    const aRef = aTask?.taskId ?? '';

    // ② 同群 B 查 A 的任务：必须成功（群共享）。③ 另一个群的 C 查同一任务：必须拒绝。
    const bQueryText = 'GROUP-MU13 B 查本群的编号';
    const cQueryText = 'GROUP-MU13 别的群查 A 的编号';
    plans.turn('mu-bob', bQueryText, { calls: [{ tool: 'task_status', args: { ref: aRef } }], reply: '本群的任务。', principal: groupPrincipal });
    plans.turn('mu-carol', cQueryText, { calls: [{ tool: 'task_status', args: { ref: aRef } }], reply: '别的群没有这个任务。', principal: otherGroupPrincipal });

    started.sdk.emit('message.text', wecomTextFrame('cb-mu13-b', {
      msgid: 'b-1', from: 'mu-bob', content: bQueryText, chattype: 'group', chatid: GROUP13,
    }));
    const bReplyDelivered = await waitUntil(() => started.sdk.replyStreams.some((stream) => stream.content.includes('本群的任务')), 5000);
    started.sdk.emit('message.text', wecomTextFrame('cb-mu13-c', {
      msgid: 'c-1', from: 'mu-carol', content: cQueryText, chattype: 'group', chatid: GROUP13_OTHER,
    }));
    const cReplyDelivered = await waitUntil(() => started.sdk.replyStreams.some((stream) => stream.content.includes('别的群没有这个任务')), 5000);
    await settle();

    const outbound: GroupOutboundObservation[] = [
      ...started.sdk.replyStreams.map((stream) => ({ chatid: stream.chatid, content: stream.content })),
      ...started.sdk.sentMessages.map((message) => ({ chatid: message.chatid, content: message.content })),
    ];
    const bQueryRecord = ctx.mainRecords.find((record) => record.userText === bQueryText);
    const cQueryRecord = ctx.mainRecords.find((record) => record.userText === cQueryText);
    const bQuery = observationOf(bQueryRecord?.calls[0]) ?? { tool: 'task_status', ref: aRef, error: '未执行', result: null };
    const cQuery = observationOf(cQueryRecord?.calls[0]) ?? { tool: 'task_status', ref: aRef, error: '未执行', result: null };

    const judgement = judgeGroupDeliverySharing({
      groupChatId: GROUP13,
      allowedChatIds: [GROUP13, GROUP13_OTHER],
      outbound,
      aReply: aResultReply,
      bQuery,
      cQuery,
      cQueryReply: cQueryRecord?.reply ?? '',
      aTaskId: aTask?.taskId ?? null,
      forbiddenMarkers: [aSubmit, MU_TAGS['mu-alice'], 'GROUP-MU13-A'],
    });

    const hardZeroHits: MuHardZero[] = [...judgement.hits];
    const groupTasks = tasksOfGroupPrincipal(readTasks(handle.dbPath), GROUP13);

    const records = makeRecords(id, [
      ...(aTask === null ? [] : [{
        principalId: aTask.principalId, sessionId, taskId: aTask.taskId, request: aTask.request,
        deliveredTo: sessionId, kind: 'reply' as const,
      }]),
      { principalId: groupPrincipal, sessionId, taskId: aTask?.taskId ?? null, request: bQueryText, deliveredTo: sessionId, kind: 'reply' },
      { principalId: otherGroupPrincipal, sessionId: sessionIdOf(GROUP13_OTHER), taskId: null, request: cQueryText, deliveredTo: sessionIdOf(GROUP13_OTHER), kind: 'reply' },
    ] satisfies readonly Omit<MuDeliveryRecord, 'caseId'>[]);

    return finalize(id, title, hardZeroHits, records,
      `A 的回复经渠道投回本群=${String(judgement.details['aReplyDeliveredToGroup'])}（同群查询帧已投=${bReplyDelivered}、异群拒绝帧已投=${cReplyDelivered}）；`
      + `同群 B 查 #${aNo} 成功=${String(judgement.details['bQueryResolved'])}；异群 C 被拒=${String(judgement.details['cQueryRejected'])}、泄漏=${String(judgement.details['cQueryLeaked'])}；`
      + `所有出站 chatid=${JSON.stringify(judgement.details['outboundChatIds'])}；本群任务数=${groupTasks.length}。`,
      {
        ...judgement.details,
        groupChatId: GROUP13,
        otherGroupChatId: GROUP13_OTHER,
        sessionId,
        aTaskId: aTask?.taskId ?? null,
        aTaskNo: aTask?.taskNo ?? null,
        aTaskPrincipal: aTask?.principalId ?? null,
        bQueryCalls: bQueryRecord?.calls.map((call) => ({ tool: call.tool, ref: call.args['ref'], error: call.error })),
        cQueryCalls: cQueryRecord?.calls.map((call) => ({ tool: call.tool, ref: call.args['ref'], error: call.error })),
        bQueryReply: bQueryRecord?.reply ?? null,
        cQueryReply: cQueryRecord?.reply ?? null,
        groupTaskCount: groupTasks.length,
        bReplyDelivered,
        cReplyDelivered,
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
