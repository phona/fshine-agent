import type { ConversationEventRecord } from '@fshine/contracts';
import { renderMemoryProjection, type MemoryRecord, type MemoryRecordType } from '@fshine/core';

export interface LongMemoryCandidate {
  /** Stable ID supplied by the extraction stage; same ID cannot mean two facts. */
  candidateId: string;
  principalId: string;
  key: string;
  type: MemoryRecordType;
  content: string;
  sourceEventIds: string[];
  action: 'assert' | 'correct' | 'delete';
  /** Required for a correction or deletion; targets remain as traceable history/tombstones. */
  supersedesMemoryIds?: string[];
}

export interface ReduceLongMemoryInput {
  current: readonly MemoryRecord[];
  sourceEvents: readonly ConversationEventRecord[];
  candidates: readonly LongMemoryCandidate[];
  now: string;
}

export interface ReduceLongMemoryResult {
  records: MemoryRecord[];
  memoryMarkdown: string;
}

/**
 * Apply source-backed candidate decisions to durable rows and rebuild the Markdown projection.
 * Deliberately has no MEMORY.md input: a projection can never become evidence for itself.
 */
export function reduceLongMemory(input: ReduceLongMemoryInput): ReduceLongMemoryResult {
  assertIsoDate(input.now, 'now');
  const records = input.current.map((record) => structuredClone(record));
  const events = new Map<string, ConversationEventRecord>();
  for (const event of input.sourceEvents) {
    const previous = events.get(event.eventId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error(`source event id ${event.eventId} has conflicting data`);
    events.set(event.eventId, event);
  }
  assertCurrentRows(records);

  for (const candidate of input.candidates) {
    validateCandidate(candidate, events);
    const existingById = records.find((record) => record.memoryId === candidate.candidateId);
    if (candidate.action === 'delete') {
      applyDeletion(records, candidate, input.now);
      continue;
    }

    if (existingById) {
      if (!sameClaim(existingById, candidate)) throw new Error(`candidate id ${candidate.candidateId} was reused for different data`);
      mergeSources(existingById, candidate.sourceEventIds, input.now);
      continue;
    }

    if (candidate.action === 'correct') {
      const targets = requireTargets(records, candidate);
      for (const target of targets) setStatus(target, 'superseded', candidate.sourceEventIds, input.now);
      records.push(newRecord(candidate, input.now, 'active'));
      continue;
    }

    const competing = records.filter((record) =>
      record.principalId === candidate.principalId && record.key === candidate.key &&
      (record.status === 'active' || record.status === 'conflicted') && record.content !== candidate.content,
    );
    if (competing.length) {
      for (const record of competing) setStatus(record, 'conflicted', candidate.sourceEventIds, input.now);
      records.push(newRecord(candidate, input.now, 'conflicted'));
      continue;
    }

    const identical = records.find((record) => record.principalId === candidate.principalId && record.key === candidate.key && record.content === candidate.content && record.status === 'active');
    if (identical) {
      mergeSources(identical, candidate.sourceEventIds, input.now);
      continue;
    }
    records.push(newRecord(candidate, input.now, 'active'));
  }

  return { records, memoryMarkdown: renderMemoryProjection(records) };
}

function validateCandidate(candidate: LongMemoryCandidate, events: Map<string, ConversationEventRecord>): void {
  if (!candidate.candidateId.trim() || !candidate.principalId.trim() || !candidate.key.trim() || !candidate.content.trim()) throw new Error('candidate id, principal, key, and content are required');
  if (candidate.type !== 'preference' && candidate.type !== 'fact') throw new Error('unsupported memory type');
  if (!['assert', 'correct', 'delete'].includes(candidate.action)) throw new Error('unsupported memory action');
  if (!candidate.sourceEventIds.length) throw new Error('candidate must cite at least one source event');
  for (const eventId of candidate.sourceEventIds) {
    const event = events.get(eventId);
    if (!event) throw new Error(`candidate references missing source event ${eventId}`);
    if (event.principalId !== candidate.principalId) throw new Error(`source event ${eventId} belongs to another principal`);
    if (event.kind !== 'user_message') throw new Error(`candidate requires a user source event; ${eventId} is ${event.kind}`);
    if (!event.content?.trim()) throw new Error(`source event ${eventId} has no source content`);
  }
  if ((candidate.action === 'correct' || candidate.action === 'delete') && !candidate.supersedesMemoryIds?.length) {
    throw new Error(`${candidate.action} requires supersedesMemoryIds`);
  }
}

function assertCurrentRows(records: MemoryRecord[]): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.memoryId)) throw new Error(`duplicate memory id ${record.memoryId}`);
    ids.add(record.memoryId);
    if (record.version < 1 || !record.sourceEventIds.length) throw new Error(`memory record ${record.memoryId} is missing version or provenance`);
  }
}

function requireTargets(records: MemoryRecord[], candidate: LongMemoryCandidate): MemoryRecord[] {
  const ids = candidate.supersedesMemoryIds ?? [];
  const targets = ids.map((id) => records.find((record) => record.memoryId === id));
  if (targets.some((target) => !target)) throw new Error('correction or deletion references an unknown memory record');
  const resolved = targets as MemoryRecord[];
  if (resolved.some((target) => target.principalId !== candidate.principalId || target.key !== candidate.key)) throw new Error('correction or deletion target must match principal and memory key');
  return resolved;
}

function applyDeletion(records: MemoryRecord[], candidate: LongMemoryCandidate, now: string): void {
  for (const target of requireTargets(records, candidate)) {
    if (target.status === 'deleted' && candidate.sourceEventIds.every((id) => target.sourceEventIds.includes(id))) continue;
    setStatus(target, 'deleted', candidate.sourceEventIds, now);
  }
}

function newRecord(candidate: LongMemoryCandidate, now: string, status: MemoryRecord['status']): MemoryRecord {
  return {
    memoryId: candidate.candidateId,
    principalId: candidate.principalId,
    key: candidate.key,
    type: candidate.type,
    content: candidate.content,
    status,
    sourceEventIds: unique(candidate.sourceEventIds),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function setStatus(record: MemoryRecord, status: MemoryRecord['status'], evidence: string[], now: string): void {
  const sources = unique([...record.sourceEventIds, ...evidence]);
  if (record.status === status && sources.length === record.sourceEventIds.length) return;
  record.status = status;
  record.sourceEventIds = sources;
  record.version += 1;
  record.updatedAt = now;
}

function mergeSources(record: MemoryRecord, evidence: string[], now: string): void {
  const sources = unique([...record.sourceEventIds, ...evidence]);
  if (sources.length === record.sourceEventIds.length) return;
  record.sourceEventIds = sources;
  record.version += 1;
  record.updatedAt = now;
}

function sameClaim(record: MemoryRecord, candidate: LongMemoryCandidate): boolean {
  return record.principalId === candidate.principalId && record.key === candidate.key && record.type === candidate.type && record.content === candidate.content;
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function assertIsoDate(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO date`);
}
