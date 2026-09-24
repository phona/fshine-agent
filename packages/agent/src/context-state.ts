import type { ConversationEventRecord } from '@fshine/contracts';

export const CONTEXT_REDUCER_VERSION = 1;
const RECENT_EVENT_LIMIT = 12;
const NOTE_LIMIT = 8;

export interface ContextEvidence {
  text: string;
  sourceEventId: string;
}

export interface ContextEventEvidence extends ContextEvidence {
  eventId: string;
  kind: ConversationEventRecord['kind'];
  text: string;
}

export interface ContextState {
  reducerVersion: number;
  throughEventId?: string;
  recentTopic?: ContextEvidence;
  userDecisions: ContextEvidence[];
  agentAssumptions: ContextEvidence[];
  unresolvedQuestions: ContextEvidence[];
  recentEvents: ContextEventEvidence[];
}

const DECISION_RE = /(?:我选择|我决定|就按|请按|确认采用|以后|今后|默认用|不要再|不再|改为|还是用)/;
const ASSUMPTION_RE = /(?:^|[\s。！？])假设[:：]\s*([^。！？\n]*[。！？]?)/;
const QUESTION_RE = /[^。！？?]*[？?]/g;

/** Deterministic, source-linked short-term projection. Replaying throughEventId is a no-op. */
export function reduceContextState(
  previous: ContextState | undefined,
  incoming: readonly ConversationEventRecord[],
): ContextState {
  const state: ContextState = previous
    ? structuredClone(previous)
    : { reducerVersion: CONTEXT_REDUCER_VERSION, userDecisions: [], agentAssumptions: [], unresolvedQuestions: [], recentEvents: [] };
  state.reducerVersion = CONTEXT_REDUCER_VERSION;

  const cursorIndex = state.throughEventId
    ? incoming.findIndex((event) => event.eventId === state.throughEventId)
    : -1;
  for (const event of incoming) {
    if (cursorIndex >= 0 && incoming.indexOf(event) <= cursorIndex) continue;
    if (state.recentEvents.some((seen) => seen.eventId === event.eventId)) continue;
    if (!event.content) {
      state.throughEventId = event.eventId;
      continue;
    }
    const text = event.content.trim();
    state.recentEvents.push({ eventId: event.eventId, sourceEventId: event.eventId, kind: event.kind, text: truncate(text, 400) });
    state.recentEvents = state.recentEvents.slice(-RECENT_EVENT_LIMIT);

    if (event.kind === 'user_message') {
      state.recentTopic = { text: truncate(text, 240), sourceEventId: event.eventId };
      if (DECISION_RE.test(text)) pushUnique(state.userDecisions, { text: truncate(text, 240), sourceEventId: event.eventId });
      // A new user turn is evidence that the previous clarification was answered; new assistant questions can reopen it.
      if (state.unresolvedQuestions.length) state.unresolvedQuestions = [];
    } else if (event.kind === 'assistant_message') {
      const assumption = ASSUMPTION_RE.exec(text)?.[1]?.trim();
      if (assumption) pushUnique(state.agentAssumptions, { text: truncate(assumption, 240), sourceEventId: event.eventId });
      const questions = [...text.matchAll(QUESTION_RE)].map((match) => match[0].trim()).filter(Boolean);
      for (const question of questions) pushUnique(state.unresolvedQuestions, { text: truncate(question, 240), sourceEventId: event.eventId });
    }
    state.throughEventId = event.eventId;
  }

  state.userDecisions = state.userDecisions.slice(-NOTE_LIMIT);
  state.agentAssumptions = state.agentAssumptions.slice(-NOTE_LIMIT);
  state.unresolvedQuestions = state.unresolvedQuestions.slice(-NOTE_LIMIT);
  return state;
}

function pushUnique(items: ContextEvidence[], item: ContextEvidence): void {
  if (!items.some((existing) => existing.sourceEventId === item.sourceEventId && existing.text === item.text)) items.push(item);
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
