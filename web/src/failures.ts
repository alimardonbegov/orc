import type { TFunction } from "./i18n";

/**
 * Why a card stopped, in plain language. The server keeps a code next to the technical text (orc/failures.py);
 * the words and the next step live here, so they follow the owner's language. A code this client does not know,
 * and a card from before the codes, return null: the caller shows the text as it always did.
 */
export const FAILURE_CODES = [
  "session_lost",
  "quota_limit",
  "project_unavailable",
  "branch_gone",
  "check_failed_again",
  "conflict_unresolved",
  "stopped_by_owner",
  "agent_reported",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export function isFailureCode(code: string | null | undefined): code is FailureCode {
  return typeof code === "string" && (FAILURE_CODES as readonly string[]).includes(code);
}

export interface FailureExplanation {
  reason: string;
  /** The next step, naming the composer's own buttons. */
  hint: string;
}

export function explainFailure(t: TFunction, code: string | null | undefined): FailureExplanation | null {
  if (!isFailureCode(code)) return null;
  const buttons = {
    retry: t("taskModal.retry"),
    continue: t("activity.continue"),
    accept: t("activity.accept"),
    resolved: t("taskModal.conflictResolved"),
  };
  return { reason: t(`card.failure.${code}.reason`), hint: t(`card.failure.${code}.hint`, buttons) };
}
