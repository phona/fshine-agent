import type { ConversationEventRecord } from '@fshine/contracts';
import { reduceContextState, type ContextEvidence, type ContextState } from './context-state';

/** One model-proposed note. The quote must occur verbatim in the cited event/state evidence. */
export interface ContextSemanticCandidate {
  text: string;
  sourceEventId: string;
  evidenceQuote: string;
}

/** Semantic fields are replacements when present; omitted fields retain deterministic reducer output. */
export interface ContextSemanticPatch {
  recentTopic?: ContextSemanticCandidate | null;
  userDecisions?: ContextSemanticCandidate[];
  agentAssumptions?: ContextSemanticCandidate[];
  unresolvedQuestions?: ContextSemanticCandidate[];
}

export interface ContextSemanticModelInput {
  principalId: string;
  sessionId: string;
  previous?: ContextState;
  incoming: readonly ConversationEventRecord[];
}

export type ContextSemanticModel = (input: ContextSemanticModelInput) => Promise<unknown>;

export type ContextExtractionErrorCode =
  | 'scope_mismatch'
  | 'invalid_evidence'
  | 'duplicate_note'
  | 'conflicting_notes'
  | 'invalid_patch'
  | 'model_failure';

export type ContextExtractionResult =
  | { ok: true; state: ContextState }
  | { ok: false; error: { code: ContextExtractionErrorCode; message: string } };

/**
 * Build a semantic short-term context projection from append-only events.
 * This module never receives a main-agent transcript or tools. Model output is untrusted;
 * callers should use reduceContextState as their explicit deterministic fallback on failure.
 */
export async function extractSemanticContext(input: ContextSemanticModelInput & { invokeModel: ContextSemanticModel }): Promise<ContextExtractionResult> {
  const { principalId, sessionId, incoming, previous } = input;
  const scopeError = validateScope(principalId, sessionId, incoming);
  if (scopeError) return failure('scope_mismatch', scopeError);

  let modelPatch: unknown;
  try {
    modelPatch = await input.invokeModel({ principalId, sessionId, previous, incoming });
  } catch (error) {
    return failure('model_failure', error instanceof Error ? error.message : 'Semantic context model call failed.');
  }

  let parsed: ContextSemanticPatch;
  try {
    parsed = parsePatch(modelPatch);
  } catch (error) {
    return failure('invalid_patch', error instanceof Error ? error.message : 'Semantic context patch is invalid.');
  }
  const evidence = buildEvidenceIndex(previous, incoming);
  const validationError = validatePatch(parsed, evidence, previous, incoming);
  if (validationError) return failure(validationError.code, validationError.message);

  const state = reduceContextState(previous, incoming);
  if (parsed.recentTopic !== undefined) {
    state.recentTopic = parsed.recentTopic === null ? undefined : toEvidence(parsed.recentTopic);
  }
  if (parsed.userDecisions !== undefined) state.userDecisions = parsed.userDecisions.map(toEvidence);
  if (parsed.agentAssumptions !== undefined) state.agentAssumptions = parsed.agentAssumptions.map(toEvidence);
  if (parsed.unresolvedQuestions !== undefined) state.unresolvedQuestions = parsed.unresolvedQuestions.map(toEvidence);
  return { ok: true, state };
}

function validateScope(principalId: string, sessionId: string, incoming: readonly ConversationEventRecord[]): string | undefined {
  const seen = new Map<string, ConversationEventRecord>();
  for (const event of incoming) {
    if (event.principalId !== principalId || event.sessionId !== sessionId) return `Event ${event.eventId} is outside the trusted principal/session scope.`;
    const prior = seen.get(event.eventId);
    if (prior && (prior.principalId !== event.principalId || prior.sessionId !== event.sessionId || prior.kind !== event.kind || prior.content !== event.content)) {
      return `Event id ${event.eventId} is reused for different event data.`;
    }
    seen.set(event.eventId, event);
  }
  return undefined;
}

function parsePatch(value: unknown): ContextSemanticPatch {
  if (!isRecord(value)) throw new PatchError('Model output must be an object.');
  const allowed = new Set(['recentTopic', 'userDecisions', 'agentAssumptions', 'unresolvedQuestions']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new PatchError('Model output contains an unsupported field.');
  const patch: ContextSemanticPatch = {};
  if ('recentTopic' in value) patch.recentTopic = value.recentTopic === null ? null : parseCandidate(value.recentTopic);
  if ('userDecisions' in value) patch.userDecisions = parseCandidateList(value.userDecisions, 'userDecisions');
  if ('agentAssumptions' in value) patch.agentAssumptions = parseCandidateList(value.agentAssumptions, 'agentAssumptions');
  if ('unresolvedQuestions' in value) patch.unresolvedQuestions = parseCandidateList(value.unresolvedQuestions, 'unresolvedQuestions');
  return patch;
}

function parseCandidateList(value: unknown, field: string): ContextSemanticCandidate[] {
  if (!Array.isArray(value)) throw new PatchError(`${field} must be an array.`);
  return value.map(parseCandidate);
}

function parseCandidate(value: unknown): ContextSemanticCandidate {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.sourceEventId !== 'string' || typeof value.evidenceQuote !== 'string') {
    throw new PatchError('Each context note must contain text, sourceEventId, and evidenceQuote strings.');
  }
  const text = value.text.trim();
  const evidenceQuote = value.evidenceQuote.trim();
  if (!text || !evidenceQuote || !value.sourceEventId.trim()) throw new PatchError('Context note text, sourceEventId, and evidenceQuote must be non-empty.');
  return { text, sourceEventId: value.sourceEventId, evidenceQuote };
}

function buildEvidenceIndex(previous: ContextState | undefined, incoming: readonly ConversationEventRecord[]): Map<string, string> {
  const evidence = new Map<string, string>();
  for (const item of [previous?.recentTopic, ...(previous?.userDecisions ?? []), ...(previous?.agentAssumptions ?? []), ...(previous?.unresolvedQuestions ?? [])]) {
    if (item) addEvidence(evidence, item.sourceEventId, item.text);
  }
  for (const event of previous?.recentEvents ?? []) addEvidence(evidence, event.eventId, event.text);
  for (const event of incoming) if (event.content) addEvidence(evidence, event.eventId, event.content);
  return evidence;
}

function addEvidence(index: Map<string, string>, eventId: string, text: string): void {
  const existing = index.get(eventId);
  // A recent event contains the original evidence text; prefer the longest representation for quote checks.
  if (existing === undefined || text.length > existing.length) index.set(eventId, text);
}

function validatePatch(
  patch: ContextSemanticPatch,
  evidence: Map<string, string>,
  previous: ContextState | undefined,
  incoming: readonly ConversationEventRecord[],
): { code: ContextExtractionErrorCode; message: string } | undefined {
  const groups: Array<[string, readonly ContextSemanticCandidate[]]> = [
    ['recentTopic', patch.recentTopic && patch.recentTopic !== null ? [patch.recentTopic] : []],
    ['userDecisions', patch.userDecisions ?? []],
    ['agentAssumptions', patch.agentAssumptions ?? []],
    ['unresolvedQuestions', patch.unresolvedQuestions ?? []],
  ];
  const eventKinds = new Map((previous?.recentEvents ?? []).map((event) => [event.eventId, event.kind]));
  for (const event of incoming) eventKinds.set(event.eventId, event.kind);
  const oldDecisionIds = new Set(previous?.userDecisions.map((item) => item.sourceEventId) ?? []);
  const oldAssumptionIds = new Set(previous?.agentAssumptions.map((item) => item.sourceEventId) ?? []);
  const oldQuestionIds = new Set(previous?.unresolvedQuestions.map((item) => item.sourceEventId) ?? []);
  for (const [field, candidates] of groups) {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const source = evidence.get(candidate.sourceEventId);
      if (source === undefined || !source.includes(candidate.evidenceQuote)) {
        return { code: 'invalid_evidence', message: `${field} cites unknown evidence or a quote absent from source event ${candidate.sourceEventId}.` };
      }
      const kind = eventKinds.get(candidate.sourceEventId);
      if ((field === 'userDecisions' && kind !== undefined && kind !== 'user_message' && !oldDecisionIds.has(candidate.sourceEventId))
        || (field === 'agentAssumptions' && kind !== undefined && kind !== 'assistant_message' && !oldAssumptionIds.has(candidate.sourceEventId))
        || (field === 'unresolvedQuestions' && kind !== undefined && kind !== 'assistant_message' && !oldQuestionIds.has(candidate.sourceEventId))) {
        return { code: 'invalid_evidence', message: `${field} cites an event kind that cannot support this note.` };
      }
      const normalized = normalize(candidate.text);
      if (seen.has(normalized)) return { code: 'duplicate_note', message: `${field} contains a duplicate note.` };
      seen.add(normalized);
    }
    if (field === 'userDecisions' && hasContradiction(candidates)) {
      return { code: 'conflicting_notes', message: 'userDecisions contains contradictory notes for the same source event.' };
    }
  }
  return undefined;
}

function hasContradiction(notes: readonly ContextSemanticCandidate[]): boolean {
  const oppositeTerms: Array<[RegExp, RegExp]> = [
    [/简洁|简短|精简/, /详细|详尽|展开/],
    [/扩大|全部|所有|更多期间/, /仅限|只查|不要扩大|当前期间/],
    [/允许|可以|同意/, /不允许|不可以|不同意|禁止/],
    [/中文/, /英文/],
  ];
  for (let left = 0; left < notes.length; left += 1) {
    for (let right = left + 1; right < notes.length; right += 1) {
      const a = notes[left]!;
      const b = notes[right]!;
      if (a.sourceEventId !== b.sourceEventId) continue;
      if (oppositeTerms.some(([first, second]) => (first.test(a.text) && second.test(b.text)) || (second.test(a.text) && first.test(b.text)))) return true;
    }
  }
  return false;
}

function toEvidence(candidate: ContextSemanticCandidate): ContextEvidence {
  return { text: candidate.text, sourceEventId: candidate.sourceEventId };
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s，。！？、,.!?；;：:「」『』“”"']/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: ContextExtractionErrorCode, message: string): ContextExtractionResult {
  return { ok: false, error: { code, message } };
}

class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}
