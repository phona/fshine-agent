/** Server-side completion handling and proactive delivery for background task events. */
import { newId } from '@fshine/core';
import type {
  AgentRuntime,
  AuditStore,
  BackgroundTaskEvent,
  ChannelDeliveryError,
  ChannelReply,
  ChannelRoute,
  DeliveryPartReceipt,
  DeliveryReceipt,
  IncomingAttachment,
  NoticeFn,
  SessionArtifactRecord,
  TaskRunRecord,
  TrustedContext,
} from '@fshine/contracts';
import {
  collectTaskRunOutputFiles,
  evictOverCapArtifacts,
  fileReturnReceipt,
  ingestArtifacts,
  loadTaskArtifactFiles,
  type IngestCandidate,
} from './artifact-store';

type PushToConversation = (route: ChannelRoute, reply: ChannelReply) => Promise<DeliveryReceipt>;

export interface BackgroundTaskEventProcessorOptions {
  store: AuditStore;
  runtime: AgentRuntime;
  pushToConversation?: PushToConversation;
  platformRoot?: string;
  dataRoot?: string;
  onPlanPending?: TrustedContext['onPlanPending'];
  createRequestId?: () => string;
}

interface ResultHandling {
  eventId: string;
  state: 'processing' | 'handled' | 'failed';
  requestId: string;
  replyText?: string;
  artifactRefs?: string[];
  error?: string;
}

interface DeliveryItem {
  itemId: string;
  kind: 'text' | 'file';
  index: number;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
}

interface StoredDelivery {
  eventId: string;
  route?: ChannelRoute;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'staged' | 'not_required';
  items: DeliveryItem[];
  receipt?: DeliveryReceipt;
  failedPart?: ChannelDeliveryError['failedPart'];
  error?: string;
}

function metadataOf(run: TaskRunRecord): Record<string, unknown> {
  return run.metadata && typeof run.metadata === 'object' ? run.metadata : {};
}

function resultHandlingOf(run: TaskRunRecord): ResultHandling | undefined {
  const value = metadataOf(run)['resultHandling'];
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Partial<ResultHandling>;
  return typeof row.eventId === 'string' && typeof row.requestId === 'string'
    && (row.state === 'processing' || row.state === 'handled' || row.state === 'failed')
    ? row as ResultHandling
    : undefined;
}

function isChannelDeliveryError(value: unknown): value is ChannelDeliveryError {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ChannelDeliveryError>;
  return row.code === 'CHANNEL_TRANSPORT_FAILED'
    && typeof row.message === 'string'
    && !!row.route
    && !!row.failedPart
    && !!row.receipt;
}

/** 投递重试参数：总尝试次数与固定间隔（选值理由见 pushWithBoundedRetry）。 */
const DELIVERY_PUSH_ATTEMPTS = 3;
const DELIVERY_RETRY_DELAY_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 渠道投递的有界重试（蓝图 interactive-session-plan.md 的"明确失败可按既有有界策略
 * 有限重试"承诺）。只对适配器明确报告的传输失败（ChannelDeliveryError）重试；普通
 * Error（缺路由、渠道未启动等确定性失败）重试也不会好，原样抛出。
 *
 * 选值：3 次总尝试 × 固定 750ms。渠道抖动通常秒级内恢复，三连尝试已覆盖；这段重试
 * 跑在会话串行队列里，最坏 1.5s 的总停顿不至于把后续用户回合拖到分钟级。send 阶段
 * 的失败可能"实际已送达、只是 ACK 丢失"，重试至多多送一份副本——蓝图明示不承诺
 * 网络故障下 exactly-once，有界副本优于结果静默丢失（正是本波要修的 P1 形态）。
 */
async function pushWithBoundedRetry(
  route: ChannelRoute,
  reply: ChannelReply,
  push: PushToConversation,
  context: { requestId: string; runId?: string },
): Promise<DeliveryReceipt> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await push(route, reply);
    } catch (error) {
      if (!isChannelDeliveryError(error) || attempt >= DELIVERY_PUSH_ATTEMPTS) throw error;
      console.warn(JSON.stringify({
        event: 'background_delivery_retry',
        requestId: context.requestId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
        attempt,
        of: DELIVERY_PUSH_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      }));
      await delay(DELIVERY_RETRY_DELAY_MS);
    }
  }
}

/** 可行动指引沿既有 resend 机制的真实能力措辞：会话产物库里有的 ref 才承诺「重发」。 */
function deliveryFailureHint(refs: readonly string[]): string {
  return refs.length > 0
    ? '已生成的文件已保留，回复「重发」可重新获取'
    : '如需结果，请直接向助手索取';
}

/** 重试耗尽后的用户失败通知：failed/unknown 分别措辞，不把"可能已送达"说成"失败"。 */
function deliveryFailureNotice(state: 'failed' | 'unknown', refs: readonly string[]): string {
  const hint = deliveryFailureHint(refs);
  return state === 'failed'
    ? `后台任务的结果投递失败（已自动重试 ${DELIVERY_PUSH_ATTEMPTS} 次仍未送达）。${hint}。`
    : `后台任务的结果可能未送达（渠道未确认送达）。若稍后仍未收到，${hint}。`;
}

interface TaskReplyArtifact {
  record?: SessionArtifactRecord;
  file: { data: Buffer; filename: string };
}

function fileReply(text: string, artifacts: readonly TaskReplyArtifact[]): ChannelReply {
  if (artifacts.length === 0) return text;
  // 点名行走 artifact-store 的收据权威（D-128）：登记产物带 #ref，未登记字节退裸文件名。
  const note = fileReturnReceipt(artifacts.map(({ record, file }) => ({ filename: file.filename, ...(record ? { ref: record.ref } : {}) })));
  return {
    text: text === '' ? note : `${text}\n${note}`,
    files: artifacts.map(({ file }) => file),
  };
}

function deliveryItems(eventId: string, reply: ChannelReply): DeliveryItem[] {
  const text = typeof reply === 'string' ? reply : reply.text ?? '';
  const files = typeof reply === 'string' ? [] : reply.files ?? [];
  const items: DeliveryItem[] = [];
  if (text !== '') items.push({ itemId: `${eventId}:text:0`, kind: 'text', index: 0, status: 'pending' });
  files.forEach((_file, index) => items.push({ itemId: `${eventId}:file:${index}`, kind: 'file', index, status: 'pending' }));
  return items;
}

function acknowledgedParts(items: readonly DeliveryItem[], receipt: DeliveryReceipt): DeliveryItem[] {
  const acknowledged = new Set(receipt.parts.map((part) => `${part.kind}:${part.index}`));
  return items.map((item) => acknowledged.has(`${item.kind}:${item.index}`) ? { ...item, status: 'sent' } : item);
}

async function artifactRunIdsForDelivery(
  store: AuditStore,
  event: BackgroundTaskEvent,
): Promise<ReadonlySet<string>> {
  if (metadataOf(event.run)['kind'] === 'host_confirmation') return new Set();
  const runIds = new Set([event.run.runId]);
  const repo = store.taskRuns;
  if (!repo) return runIds;
  try {
    const runs = await repo.listBySession(event.run.principalId, event.run.sessionId);
    for (const run of runs) {
      if (run.taskId !== event.run.taskId || run.runId === event.run.runId) continue;
      // Intermediate plan steps were explicitly staged without a direct message; include their
      // files with the eventual final result. Previously sent files are omitted to avoid repeats.
      if (run.deliveryState === 'not_required' && resultHandlingOf(run)?.state === 'handled') runIds.add(run.runId);
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'task_artifact_lineage_failed',
      taskId: event.run.taskId,
      runId: event.run.runId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return runIds;
}

async function taskArtifactsForDelivery(options: {
  store: AuditStore;
  event: BackgroundTaskEvent;
  platformRoot?: string;
  dataRoot?: string;
  requestId: string;
  currentOutputs: readonly IngestCandidate[];
  currentIngested: readonly SessionArtifactRecord[];
}): Promise<TaskReplyArtifact[]> {
  const { store, event } = options;
  const sourceRunIds = await artifactRunIdsForDelivery(store, event);
  if (sourceRunIds.size === 0) return [];
  const artifacts: TaskReplyArtifact[] = (await loadTaskArtifactFiles(
    store,
    event.run.sessionId,
    event.run.taskId,
    sourceRunIds,
  )).map(({ record, file }) => ({ record, file }));
  const representedRuns = new Set(artifacts.map(({ record }) => record?.sourceRunId).filter((id): id is string => id !== undefined));

  for (const runId of sourceRunIds) {
    if (representedRuns.has(runId)) continue;
    const run = runId === event.run.runId ? event.run : await store.taskRuns?.get(runId);
    const outputs = runId === event.run.runId
      ? [...options.currentOutputs]
      : run && options.platformRoot ? collectTaskRunOutputFiles(options.platformRoot, run) : [];
    if (outputs.length === 0) continue;

    // The current run may already have been staged before runtime continuation. Keep those exact
    // records even if a later read query is temporarily unavailable.
    if (runId === event.run.runId && options.currentIngested.length > 0) {
      for (const [index, record] of options.currentIngested.entries()) {
        const candidate = record.sourceRunId === runId ? options.currentOutputs[index] : undefined;
        if (candidate) artifacts.push({ record, file: { data: candidate.data, filename: candidate.filename } });
      }
      representedRuns.add(runId);
      continue;
    }

    const repo = store.sessionArtifacts;
    if (repo && options.dataRoot) {
      try {
        const outcome = await ingestArtifacts({
          candidates: outputs,
          sessionId: event.run.sessionId,
          dataRoot: options.dataRoot,
          store,
          requestId: options.requestId,
          sourceTaskId: event.run.taskId,
          sourceRunId: runId,
        });
        const newlyStored = outputs.flatMap((candidate, index) => {
          const record = candidate.sourcePath ? outcome.bySourcePath.get(candidate.sourcePath) : outcome.records[index];
          return record ? [{ record, file: { data: candidate.data, filename: candidate.filename } }] : [];
        });
        if (newlyStored.length > 0) {
          artifacts.push(...newlyStored);
          representedRuns.add(runId);
          continue;
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'background_artifact_retry_failed',
          requestId: options.requestId,
          taskId: event.run.taskId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    // Durable storage may be unavailable, but the exact run manifest still lets us deliver this
    // completion's bytes once. The source workspace remains pinned for later reconciliation.
    artifacts.push(...outputs.map((candidate) => ({ file: { data: candidate.data, filename: candidate.filename } })));
  }

  return artifacts.sort((a, b) => Number(a.record?.ref ?? Number.MAX_SAFE_INTEGER) - Number(b.record?.ref ?? Number.MAX_SAFE_INTEGER)
    || a.file.filename.localeCompare(b.file.filename));
}

function noteFor(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function frozenInputFilesForRun(run: TaskRunRecord): IncomingAttachment[] {
  const raw = metadataOf(run)['inputFiles'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): IncomingAttachment[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as { filename?: unknown; path?: unknown; size?: unknown };
    return typeof row.filename === 'string' && typeof row.path === 'string'
      && typeof row.size === 'number' && row.size >= 0
      ? [{ filename: row.filename, path: row.path, bytes: row.size }]
      : [];
  });
}

async function updateRun(
  store: AuditStore,
  runId: string,
  buildPatch: (current: TaskRunRecord) => Partial<TaskRunRecord>,
): Promise<boolean> {
  const repo = store.taskRuns;
  if (!repo) return false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await repo.get(runId);
    if (!current) return false;
    if (await repo.transition(
      runId,
      [current.state],
      { ...buildPatch(current), updatedAt: new Date().toISOString() },
      current.revision,
    )) return true;
  }
  return false;
}

/**
 * Build the trusted, route-bound notice sender passed to runtime task-event handling.
 * A successful channel ACK is the barrier; history append failure is logged but does not
 * pretend the notice failed to reach the user.
 *
 * D-131：发送走与结果交付同一条有界重试（pushWithBoundedRetry）——渠道瞬断不再把
 * 整个任务炸成 failed（Worker 可能已产生平台副作用）；持续失败仍原样抛，由既有
 * 语义处置。确定性错误（缺路由/能力）不重试，与结果投递同判据。
 */
export function createBackgroundNoticeSender(options: {
  store: AuditStore;
  route?: ChannelRoute;
  requestId: string;
  principalId: string;
  sessionId: string;
  pushToConversation?: PushToConversation;
}): NoticeFn | undefined {
  if (!options.route || !options.pushToConversation) return undefined;
  let sequence = 0;
  return async (text) => {
    await pushWithBoundedRetry(options.route!, text, options.pushToConversation!, { requestId: options.requestId });
    try {
      await options.store.conversationLog?.append({
        eventId: `${options.requestId}:background_notice:${++sequence}`,
        principalId: options.principalId,
        sessionId: options.sessionId,
        kind: 'plan_event',
        content: redactNotice(text),
        createdAt: new Date().toISOString(),
        requestId: options.requestId,
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'background_notice_log_failed',
        requestId: options.requestId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };
}

/** Process one already-persisted terminal event. Call only inside the handler's session queue. */
export function createBackgroundTaskEventProcessor(options: BackgroundTaskEventProcessorOptions): (event: BackgroundTaskEvent) => Promise<void> {
  const makeRequestId = options.createRequestId ?? (() => newId('req'));

  return async (event) => {
    const repo = options.store.taskRuns;
    if (!repo) {
      console.warn(JSON.stringify({ event: 'background_result_untracked', runId: event.run.runId, resultEventId: event.eventId }));
      return;
    }
    const requestId = makeRequestId();
    const processing: ResultHandling = { eventId: event.eventId, state: 'processing', requestId };
    let began = false;
    let current = event.run;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      current = await repo.get(event.run.runId) ?? event.run;
      const prior = resultHandlingOf(current);
      if (prior) {
        // Runtime/log projection is deliberately not replayed after a crash or duplicate event.
        console.info(JSON.stringify({ event: 'background_result_duplicate', runId: event.run.runId, resultEventId: event.eventId, state: prior.state }));
        return;
      }
      began = await repo.transition(event.run.runId, [current.state], {
        metadata: { ...metadataOf(current), resultHandling: processing },
        resultHandlingState: 'processing',
        updatedAt: new Date().toISOString(),
      }, current.revision);
      if (began) break;
    }
    if (!began) {
      // Four claim races lost in a row must not drop the event silently — this is the only
      // trace tying the dropped completion to its run when the queue moves on.
      console.warn(JSON.stringify({
        event: 'background_result_claim_abandoned',
        runId: event.run.runId,
        resultEventId: event.eventId,
        taskId: event.run.taskId,
        attempts: 4,
      }));
      return;
    }

    const route = event.run.deliveryRoute;
    const onBackgroundNotice = createBackgroundNoticeSender({
      store: options.store,
      ...(route ? { route } : {}),
      requestId,
      principalId: event.run.principalId,
      sessionId: event.run.sessionId,
      ...(options.pushToConversation ? { pushToConversation: options.pushToConversation } : {}),
    });
    const inputFiles = frozenInputFilesForRun(event.run);
    const trusted: TrustedContext = {
      backgroundRunId: event.run.runId,
      requestId,
      principalId: event.run.principalId,
      sessionId: event.run.sessionId,
      ...(inputFiles.length > 0 ? { inputFiles } : {}),
      ...(route ? { deliveryRoute: route } : {}),
      ...(onBackgroundNotice ? { onBackgroundNotice } : {}),
      ...(options.onPlanPending ? { onPlanPending: options.onPlanPending } : {}),
    };

    let outputFiles: IngestCandidate[] = [];
    let ingested: SessionArtifactRecord[] = [];
    let resultHandled = false;
    let continuationAccepted = false;
    let deliveryAttempted = false;
    let resultText: string | undefined;
    let resultRefs: string[] = [];
    let plannedDelivery: StoredDelivery | undefined;
    try {
      if (options.platformRoot) outputFiles = collectTaskRunOutputFiles(options.platformRoot, event.run);
      if (outputFiles.length > 0 && options.dataRoot && options.store.sessionArtifacts) {
        try {
          const outcome = await ingestArtifacts({
            candidates: outputFiles,
            sessionId: event.run.sessionId,
            dataRoot: options.dataRoot,
            store: options.store,
            requestId,
            sourceTaskId: event.run.taskId,
            sourceRunId: event.run.runId,
          });
          ingested = outcome.records;
          for (const record of ingested) {
            console.info(JSON.stringify({
              event: 'background_artifact_staged',
              requestId,
              taskId: event.run.taskId,
              runId: event.run.runId,
              ref: record.ref,
              filename: record.filename,
              bytes: record.size,
            }));
          }
        } catch (error) {
          // Preserve task outputs in the manifest/scratch and still deliver this result. A later
          // task event can retry registration without re-running the platform operation.
          console.warn(JSON.stringify({
            event: 'background_artifact_stage_failed',
            requestId,
            taskId: event.run.taskId,
            runId: event.run.runId,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      const reply = await options.runtime.handleTaskEvent?.(trusted, event);
      if (reply === undefined) throw new Error('runtime.handleTaskEvent 未配置');
      resultHandled = true;
      if (reply === null) {
        continuationAccepted = true;
        const recorded = await updateRun(options.store, event.run.runId, (latest) => ({
          deliveryState: 'not_required',
          delivery: { eventId: event.eventId, state: 'staged', items: [], stagedArtifactRefs: ingested.map((record) => record.ref) },
          metadata: { ...metadataOf(latest), resultHandling: { ...processing, state: 'handled', artifactRefs: ingested.map((record) => record.ref) } },
          resultHandlingState: 'handled',
        }));
        if (!recorded) throw new Error('后台 continuation 状态未能写入任务记录');
        return;
      }

      const replyArtifacts = await taskArtifactsForDelivery({
        store: options.store,
        event,
        ...(options.platformRoot ? { platformRoot: options.platformRoot } : {}),
        ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
        requestId,
        currentOutputs: outputFiles,
        currentIngested: ingested,
      });
      const deliveryReply = fileReply(reply.text, replyArtifacts);
      const plannedItems = deliveryItems(event.eventId, deliveryReply);
      const delivery = route ? {
        eventId: event.eventId,
        route,
        state: 'pending' as const,
        items: plannedItems,
      } satisfies StoredDelivery : undefined;
      const refs = replyArtifacts.flatMap(({ record }) => record ? [record.ref] : []);
      resultText = reply.text;
      resultRefs = refs;
      plannedDelivery = delivery;
      if (plannedItems.length === 0) {
        const recorded = await updateRun(options.store, event.run.runId, (latest) => ({
          resultText: reply.text,
          deliveryState: 'not_required',
          delivery: { eventId: event.eventId, state: 'not_required', items: [] },
          metadata: {
            ...metadataOf(latest),
            resultHandling: { ...processing, state: 'handled', replyText: reply.text, artifactRefs: refs },
          },
          resultHandlingState: 'handled',
        }));
        if (!recorded) throw new Error('后台无内容交付状态未能写入任务记录');
        return;
      }
      const deliveryPrepared = await updateRun(options.store, event.run.runId, (latest) => ({
        resultText: reply.text,
        deliveryState: 'pending',
        ...(delivery ? { delivery } : { delivery: { eventId: event.eventId, state: 'failed', items: [], error: '缺少可信的主动发送路由' } }),
        metadata: {
          ...metadataOf(latest),
          resultHandling: { ...processing, state: 'handled', replyText: reply.text, artifactRefs: refs },
        },
        resultHandlingState: 'handled',
      }));
      if (!deliveryPrepared) throw new Error('后台交付项目未能登记，已跳过外发');

      if (!route || !options.pushToConversation) {
        await updateRun(options.store, event.run.runId, () => ({
          deliveryState: 'failed',
          delivery: { eventId: event.eventId, state: 'failed', items: deliveryItems(event.eventId, deliveryReply), error: '缺少可信的主动发送通道' },
        }));
        return;
      }

      try {
        const sending = {
          ...delivery!,
          state: 'sending' as const,
          items: delivery!.items.map((item) => ({ ...item, status: 'sending' as const })),
        };
        const markedSending = await updateRun(options.store, event.run.runId, () => ({ delivery: sending }));
        if (!markedSending) throw new Error('后台交付状态未能更新，已跳过外发');
        plannedDelivery = sending;
        deliveryAttempted = true;
        const receipt = await pushWithBoundedRetry(
          route,
          deliveryReply,
          options.pushToConversation,
          { requestId, runId: event.run.runId },
        );
        const sentItems = acknowledgedParts(delivery!.items, receipt);
        const allAcknowledged = sentItems.every((item) => item.status === 'sent');
        let savedDelivery = await updateRun(options.store, event.run.runId, () => ({
          deliveryState: allAcknowledged ? 'sent' : 'unknown',
          delivery: { ...delivery!, state: allAcknowledged ? 'sent' : 'unknown', items: sentItems, receipt },
        }));
        if (!savedDelivery) {
          savedDelivery = await updateRun(options.store, event.run.runId, () => ({
            deliveryState: 'unknown',
            delivery: { ...delivery!, state: 'unknown', items: sentItems, receipt, error: '渠道已确认，但送达回执未能写入任务记录' },
          }));
        }
        if (allAcknowledged && savedDelivery && options.store.sessionArtifacts) {
          try {
            await evictOverCapArtifacts({ store: options.store, sessionId: event.run.sessionId, freshRefs: refs });
          } catch (error) {
            console.warn(JSON.stringify({
              event: 'artifact_post_delivery_eviction_failed',
              requestId,
              taskId: event.run.taskId,
              runId: event.run.runId,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      } catch (error) {
        const transportError = isChannelDeliveryError(error) ? error : undefined;
        const partialReceipt = transportError?.receipt ?? { route, parts: [] as readonly DeliveryPartReceipt[] };
        const attemptedItems = acknowledgedParts(delivery!.items, partialReceipt).map((item) => {
          if (transportError && item.kind === transportError.failedPart.kind && item.index === transportError.failedPart.index) {
            return { ...item, status: transportError.failedPart.stage === 'upload' ? 'failed' as const : 'unknown' as const };
          }
          return item;
        });
        const explicitUploadFailure = transportError?.failedPart.stage === 'upload';
        const state = explicitUploadFailure || !deliveryAttempted ? 'failed' : 'unknown';
        const failure = {
          ...delivery!,
          state,
          items: attemptedItems,
          ...(transportError ? { receipt: transportError.receipt, failedPart: transportError.failedPart } : {}),
          error: error instanceof Error ? error.message : String(error),
        } satisfies StoredDelivery;
        await updateRun(options.store, event.run.runId, () => ({ deliveryState: state, delivery: failure }));
        console.warn(JSON.stringify({
          event: 'background_result_delivery_failed',
          requestId,
          taskId: event.run.taskId,
          runId: event.run.runId,
          resultEventId: event.eventId,
          state,
          error: failure.error,
        }));
        // Retry budget exhausted: the user must not learn about this only from silence.
        // Best effort — if the channel is fully down the notice itself fails and is logged,
        // leaving the DB state and the recovery sweep as the remaining traces.
        if (onBackgroundNotice) {
          try {
            await onBackgroundNotice(deliveryFailureNotice(state === 'unknown' ? 'unknown' : 'failed', refs));
          } catch (noticeError) {
            console.warn(JSON.stringify({
              event: 'background_failure_notice_failed',
              requestId,
              runId: event.run.runId,
              error: noticeError instanceof Error ? noticeError.message : String(noticeError),
            }));
          }
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (resultHandled) {
        const state = continuationAccepted ? 'not_required' : deliveryAttempted ? 'unknown' : 'failed';
        await updateRun(options.store, event.run.runId, (latest) => ({
          ...(resultText === undefined ? {} : { resultText }),
          deliveryState: state,
          delivery: {
            ...(plannedDelivery ?? { eventId: event.eventId, ...(route ? { route } : {}), items: [] }),
            state: continuationAccepted ? 'staged' : state,
            error: noteFor(detail),
          },
          metadata: {
            ...metadataOf(latest),
            resultHandling: {
              ...processing,
              state: 'handled',
              ...(resultText === undefined ? {} : { replyText: resultText }),
              artifactRefs: resultRefs,
              ...(deliveryAttempted ? { deliveryError: noteFor(detail) } : {}),
            },
          },
          resultHandlingState: 'handled',
        }));
      } else {
        await updateRun(options.store, event.run.runId, (latest) => ({
          metadata: { ...metadataOf(latest), resultHandling: { ...processing, state: 'failed', error: noteFor(detail) } },
          resultHandlingState: 'failed',
        }));
      }
      console.error(JSON.stringify({
        event: 'background_result_processing_failed',
        requestId,
        taskId: event.run.taskId,
        runId: event.run.runId,
        resultEventId: event.eventId,
        error: detail,
      }));
    }
  };
}

/** 服务中断收尾通知：可行动指引按"库里是否还有可重发产物"分别措辞（只承诺真实能力）。 */
function interruptedResultNotice(hasResendableFiles: boolean): string {
  const hint = hasResendableFiles
    ? '已生成的文件已保留，回复「重发」可重新获取'
    : '如需结果，请让助手重新执行该任务';
  return `后台任务的结果因服务中断未能送达。${hint}。`;
}

/**
 * One-shot startup sweep for crash-orphaned deliveries (P1 崩溃恢复缺口).
 *
 * 后台完成事件排在 handler 会话队列尾、只活在内存 promise 链上；进程重启后队列已死，
 * "终态但 deliveryState='pending' 或 resultHandling.state='processing'"的 run 就永远
 * 停在 pending——listPinnedTaskIds 把工作区永久 pin 住，用户永远收不到已完成的結果。
 * 本清扫在渠道就绪后跑一次：不重跑 Worker、不重放 LLM 续跑（与事件重复消费守卫同一
 * 立场），只用已持久化的事实（resultText + 会话产物库中 sha256 校验过的字节）重投；
 * 不可恢复的标 failed 并给用户一条可行动通知。状态写入全部走 core store 的 CAS
 * transition 原语（updateRun），并发写人抢不到锁就留给下一次清扫。
 *
 * 返回值 = 本次处置的 run 数（重投成功 + 标失败）。
 */
export async function sweepUndeliveredTaskRuns(options: {
  store: AuditStore;
  pushToConversation?: PushToConversation;
  createRequestId?: () => string;
}): Promise<number> {
  const repo = options.store.taskRuns;
  if (!repo || typeof repo.listTerminalUnsettledDeliveries !== 'function') return 0;
  let candidates: TaskRunRecord[];
  try {
    candidates = await repo.listTerminalUnsettledDeliveries();
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'background_recovery_sweep_list_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return 0;
  }
  if (candidates.length === 0) return 0;
  if (!options.pushToConversation) {
    // 没有主动发送能力时不动状态：run 保持未决（继续 pin），带渠道的下一次重启仍可收尾。
    console.warn(JSON.stringify({ event: 'background_recovery_sweep_skipped', reason: 'no_push_channel', candidates: candidates.length }));
    return 0;
  }

  const makeRequestId = options.createRequestId ?? (() => newId('req'));
  let recovered = 0;
  let failed = 0;
  for (const snapshot of candidates) {
    const current = await repo.get(snapshot.runId) ?? snapshot;
    // Freshness re-check with CAS below: a run that settled in between is skipped.
    const stillUnsettled = current.deliveryState === 'pending' || current.resultHandlingState === 'processing';
    if (!stillUnsettled) continue;
    const requestId = makeRequestId();
    const priorHandling = resultHandlingOf(current);
    const eventId = priorHandling?.eventId ?? current.resultEventId ?? `recovery:${current.runId}`;
    const route = current.deliveryRoute;
    const runId = current.runId;

    let artifacts: TaskReplyArtifact[] = [];
    try {
      const sourceRunIds = await artifactRunIdsForDelivery(options.store, { eventId, run: current });
      artifacts = (await loadTaskArtifactFiles(options.store, current.sessionId, current.taskId, sourceRunIds))
        .map(({ record, file }) => ({ record, file }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'background_recovery_artifact_lookup_failed',
        runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    const text = current.resultText ?? '';
    const refs = artifacts.flatMap(({ record }) => record ? [record.ref] : []);
    const recoverable = text !== '' || artifacts.length > 0;

    const markFailed = async (reason: string, noticeText: string): Promise<void> => {
      const recorded = await updateRun(options.store, runId, (latest) => ({
        deliveryState: 'failed',
        delivery: { eventId, ...(route ? { route } : {}), state: 'failed', items: [], error: reason },
        metadata: {
          ...metadataOf(latest),
          resultHandling: {
            ...(priorHandling ?? { eventId, requestId }),
            state: 'failed',
            error: noteFor(reason),
          },
        },
        resultHandlingState: 'failed',
      }));
      if (recorded) {
        failed += 1;
        console.warn(JSON.stringify({ event: 'background_result_recovery_failed', requestId, runId, taskId: current.taskId, reason }));
      } else {
        console.warn(JSON.stringify({ event: 'background_result_recovery_record_failed', requestId, runId }));
        return;
      }
      if (route) {
        try {
          await options.pushToConversation!(route, noticeText);
        } catch (noticeError) {
          console.warn(JSON.stringify({
            event: 'background_failure_notice_failed',
            requestId,
            runId,
            error: noticeError instanceof Error ? noticeError.message : String(noticeError),
          }));
        }
      }
    };

    if (!route) {
      // 无可信路由：既不能重投也不能通知，只能落状态与留痕。
      await markFailed('服务中断后无可信的主动发送路由，结果未能送达', interruptedResultNotice(false));
      continue;
    }

    if (recoverable) {
      try {
        const reply = fileReply(text, artifacts);
        const receipt = await pushWithBoundedRetry(route, reply, options.pushToConversation, { requestId, runId });
        const items = acknowledgedParts(deliveryItems(eventId, reply), receipt);
        const allAcknowledged = items.every((item) => item.status === 'sent');
        const recorded = await updateRun(options.store, runId, (latest) => ({
          ...(text === '' ? {} : { resultText: text }),
          deliveryState: allAcknowledged ? 'sent' : 'unknown',
          delivery: { eventId, route, state: allAcknowledged ? 'sent' : 'unknown', items, receipt },
          metadata: {
            ...metadataOf(latest),
            resultHandling: {
              ...(priorHandling ?? { eventId, requestId }),
              state: 'handled',
              ...(text === '' ? {} : { replyText: text }),
              artifactRefs: refs,
            },
          },
          resultHandlingState: 'handled',
        }));
        if (recorded) {
          recovered += 1;
          console.info(JSON.stringify({
            event: 'background_result_recovered',
            requestId,
            runId,
            taskId: current.taskId,
            resultEventId: eventId,
            deliveryState: allAcknowledged ? 'sent' : 'unknown',
          }));
        } else {
          console.warn(JSON.stringify({ event: 'background_result_recovery_record_failed', requestId, runId }));
        }
        continue;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await markFailed(`恢复投递失败：${detail}`, interruptedResultNotice(artifacts.length > 0));
        continue;
      }
    }

    await markFailed('服务中断导致结果未能送达且无可恢复的产物', interruptedResultNotice(false));
  }

  console.info(JSON.stringify({
    event: 'background_recovery_sweep',
    candidates: candidates.length,
    recovered,
    failed,
  }));
  return recovered + failed;
}

/** Keep the same secret redaction rule for inline and independently sent plan notices. */
export function redactNotice(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
