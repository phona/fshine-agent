import type { SelectionClarification } from './platform-contract';
import { clarificationTextFor, messageTextFor } from './error-codes';
import { executionLanguageFingerprints } from './execution-language';
import { stripFootprint } from './text-hygiene';

const NO_EXECUTION_CLARIFICATION = messageTextFor('NO_EXECUTION_CLARIFICATION');
const ACTIVATED_PLAN_NOT_EXECUTED = messageTextFor('ACTIVATED_PLAN_NOT_EXECUTED');
const RESUMED_PLAN_NOT_EXECUTED = messageTextFor('RESUMED_PLAN_NOT_EXECUTED');

/** Reply-level evidence gate shared by the runtime exit and clarification paths. */
export function hasFinancialFigure(text: string): boolean {
  return /[\d,]+\.?\d*\s*(元|块|万|亿)|余额|金额|发生额/.test(text);
}

export function usefulWorkerNote(text: string): string {
  const note = stripFootprint(text).trim();
  if (!note || hasFinancialFigure(note) || note === NO_EXECUTION_CLARIFICATION
    || note === ACTIVATED_PLAN_NOT_EXECUTED || note === RESUMED_PLAN_NOT_EXECUTED) return '';
  if (executionLanguageFingerprints(note).length > 0) return '';
  return note;
}

/** Selection clarification wording is host-owned; only a clean worker note may follow it. */
export function composeClarificationReply(clarification: SelectionClarification, workerText: string): string {
  const question = clarificationTextFor(clarification.code, clarification);
  const note = usefulWorkerNote(workerText);
  return note ? `${question}\n\n${note}` : question;
}
