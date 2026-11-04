/**
 * Isolated write-path proposal review (Phase 2).
 *
 * Pattern reused from context-model.ts: an isolated model turn with its own
 * message list, no tools, a timeout, and input/output byte caps. The reviewer
 * never sees the worker transcript, the host confirmation code, or any
 * business payload beyond what is listed below.
 *
 * Inputs, and only these inputs:
 *   - the proposal schema as declared by the platform (opaque to the host;
 *     the host passes it through, it does not parse business fields),
 *   - the domain dry-run envelope (status / data / error as returned),
 *   - the platform-rendered summaryText.
 * Output, and only this output:
 *   - verdict: 'consistent' | 'inconsistent', plus the field names that
 *     disagree (field names only, no values, no business summary).
 *
 * Fail-closed: an unparsable reviewer reply, a reply with an unknown
 * verdict, a dry-run that is not 'completed', an empty summaryText, or a
 * missing/illegal proposal schema (interface §5, package 2: the schema slot
 * is no longer nullable in production — a null schema is not "review
 * without a schema", it is a failed review) all count as 'inconsistent'.
 * A reviewer turn that throws also blocks. The caller must then not issue
 * a confirmation code.
 *
 * Note on independence: this is an isolated turn, not an independent
 * model. In production assembly the driver is the context-model driver
 * (isolated message list, no tools); a truly independent judge model
 * (a different LLM_JUDGE_MODEL) is a separate, still-open step and must
 * not be claimed from this module alone.
 */
import type { TurnDriver } from './driver';

export interface ProposalReviewInput {
  /** Opaque platform proposal schema (passed through, never parsed here). */
  proposalSchema: unknown;
  /** Domain dry-run envelope as returned by the platform. */
  dryRunEnvelope: { status?: unknown; data?: unknown; error?: unknown } | null;
  /** Platform-rendered summary text. */
  summaryText: string;
}

export interface ProposalReviewVerdict {
  verdict: 'consistent' | 'inconsistent';
  fields: readonly string[];
  /** Why the mechanical pre-check blocked, when it did (no business detail). */
  blockedReason?: string;
}

export type ProposalReviewTurn = (input: ProposalReviewInput) => Promise<ProposalReviewVerdict>;

const REVIEW_SYSTEM_PROMPT = `You are an isolated proposal reviewer. You receive only a proposal schema, a domain dry-run envelope, and a platform-rendered summary. Compare the summary against the dry-run envelope only. Return exactly one JSON object and no markdown or extra prose: {"verdict": "consistent" | "inconsistent", "fields": ["<field name>", ...]}. List only field names that disagree; never repeat values, never invent fields, never use any other source. If the dry-run did not complete or the summary is empty, verdict is "inconsistent".`;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INPUT_BYTES = 32_000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseReviewReply(text: string): ProposalReviewVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.verdict !== 'consistent' && row.verdict !== 'inconsistent') return null;
  if (!Array.isArray(row.fields) || !row.fields.every((f) => typeof f === 'string')) return null;
  return { verdict: row.verdict, fields: [...(row.fields as string[])] };
}

/** Mechanical pre-checks that need no model: a failed dry-run, an empty summary, or a missing/illegal schema cannot be consistent. The schema check is shape-only (non-empty plain object): the host never parses business fields. */
export function mechanicalReview(input: ProposalReviewInput): ProposalReviewVerdict | null {
  if (!input.proposalSchema || typeof input.proposalSchema !== 'object' || Array.isArray(input.proposalSchema)) {
    return { verdict: 'inconsistent', fields: [], blockedReason: 'proposal schema missing or invalid' };
  }
  if (!input.dryRunEnvelope || input.dryRunEnvelope.status !== 'completed') {
    return { verdict: 'inconsistent', fields: [], blockedReason: 'dry-run did not complete' };
  }
  if (!input.summaryText.trim()) {
    return { verdict: 'inconsistent', fields: [], blockedReason: 'summaryText is empty' };
  }
  return null;
}

export async function reviewProposalWithDriver(
  driver: TurnDriver,
  input: ProposalReviewInput,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProposalReviewVerdict> {
  const blocked = mechanicalReview(input);
  if (blocked) return blocked;
  const promptInput = JSON.stringify({
    proposalSchema: input.proposalSchema ?? null,
    dryRunEnvelope: input.dryRunEnvelope,
    summaryText: input.summaryText,
  });
  if (utf8Bytes(REVIEW_SYSTEM_PROMPT) + utf8Bytes(promptInput) > DEFAULT_MAX_INPUT_BYTES) {
    return { verdict: 'inconsistent', fields: [], blockedReason: 'review input exceeds byte cap' };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Proposal review timed out.')), timeoutMs);
  try {
    const result = await driver.run({
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: 'user', content: `Review this proposal:\n${promptInput}`, timestamp: startedAt }],
      onStep: () => undefined,
      exec: async () => {
        throw new Error('Proposal review turns do not permit tools.');
      },
      deadline: startedAt + timeoutMs,
      signal: controller.signal,
    });
    if (!result.text.trim()) return { verdict: 'inconsistent', fields: [], blockedReason: 'reviewer returned empty text' };
    if (utf8Bytes(result.text) > DEFAULT_MAX_OUTPUT_BYTES) {
      return { verdict: 'inconsistent', fields: [], blockedReason: 'review output exceeds byte cap' };
    }
    return parseReviewReply(result.text) ?? { verdict: 'inconsistent', fields: [], blockedReason: 'review reply was not strict JSON with a known verdict' };
  } catch {
    return { verdict: 'inconsistent', fields: [], blockedReason: 'review turn failed' };
  } finally {
    clearTimeout(timer);
  }
}
