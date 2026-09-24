import type { ConversationEventRecord } from '@fshine/contracts';
import { renderMemoryProjection, type MemoryRecord } from '@fshine/core';
import { reduceLongMemory, type LongMemoryCandidate } from './long-memory';

/** Extractor receives source events only; it is not given MEMORY.md or prior memory text. */
export type CandidateExtractor = (
  sourceUserEvents: readonly ConversationEventRecord[],
  currentRecords?: readonly MemoryRecord[],
) => readonly LongMemoryCandidate[] | Promise<readonly LongMemoryCandidate[]>;

export interface MemoryConsolidationInput {
  principalId: string;
  /** Ordered Conversation Log page. If cursor is present in this page, only later events are processed. */
  sourceEvents: readonly ConversationEventRecord[];
  current: readonly MemoryRecord[];
  cursor?: string;
  extractor: CandidateExtractor;
  now: string;
}

export interface MemoryConsolidationResult {
  ok: boolean;
  records: MemoryRecord[];
  memoryMarkdown: string;
  /** Last successfully processed user source event; unchanged when extraction/reduction fails. */
  cursor?: string;
  error?: string;
}

/** Consolidate only original user messages for one principal, then rebuild the projection. */
export async function consolidateLongMemory(input: MemoryConsolidationInput): Promise<MemoryConsolidationResult> {
  const current = input.current.filter((record) => record.principalId === input.principalId).map((record) => structuredClone(record));
  const safeCurrent = () => current.map((record) => structuredClone(record));
  const fail = (error: unknown): MemoryConsolidationResult => ({
    ok: false,
    records: safeCurrent(),
    memoryMarkdown: renderMemoryProjection(current),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    error: error instanceof Error ? error.message : String(error),
  });

  try {
    if (!input.principalId.trim()) throw new Error('principalId is required');
    if (!Number.isFinite(Date.parse(input.now))) throw new Error('now must be an ISO date');
    const scopedEvents = input.sourceEvents.filter((event) => event.principalId === input.principalId);
    assertUniqueSourceEvents(scopedEvents);

    const cursorIndex = input.cursor ? scopedEvents.findIndex((event) => event.eventId === input.cursor) : -1;
    const afterCursor = cursorIndex >= 0 ? scopedEvents.slice(cursorIndex + 1) : scopedEvents;
    const userEvents = deduplicateEvents(afterCursor.filter((event) => event.kind === 'user_message'));
    if (!userEvents.length) {
      return { ok: true, records: safeCurrent(), memoryMarkdown: renderMemoryProjection(current), ...(input.cursor ? { cursor: input.cursor } : {}) };
    }

    const candidates = await input.extractor(userEvents, current);
    const reduced = reduceLongMemory({ current, sourceEvents: userEvents, candidates, now: input.now });
    return {
      ok: true,
      records: reduced.records,
      memoryMarkdown: reduced.memoryMarkdown,
      cursor: userEvents[userEvents.length - 1]!.eventId,
    };
  } catch (error) {
    return fail(error);
  }
}

function assertUniqueSourceEvents(events: readonly ConversationEventRecord[]): void {
  const seen = new Map<string, string>();
  for (const event of events) {
    const serialized = JSON.stringify(event);
    const previous = seen.get(event.eventId);
    if (previous !== undefined && previous !== serialized) throw new Error(`source event id ${event.eventId} has conflicting data`);
    seen.set(event.eventId, serialized);
  }
}

function deduplicateEvents(events: readonly ConversationEventRecord[]): ConversationEventRecord[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });
}
