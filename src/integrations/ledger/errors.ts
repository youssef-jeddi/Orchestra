// ─── Bridge — what an error becomes in an HTTP answer ───
// Errors the code raised on purpose (they carry a status and a sentence written for the user) keep
// their message. Anything else — a library or RPC error, a bug — can hold addresses, URLs or other
// internals, so it is logged on the server (by the caller) and the user gets one fixed sentence.
// Pure, so a test can throw an error with a secret in it and see it never reaches the response.

import { PasskeyError } from "../passkey";
import { OnboardingError } from "../safe/onboarding";
import { ApprovalError } from "../../approvals";
import { AuthError } from "../../auth";
import { LimitsError } from "../../policy/limits";
import { INTENT_FALLBACK_ERROR, EXECUTION_FAILED_REASON } from "../../intent/messages";
import { UserFacingError, OverCapError } from "../../utils/userFacing";

/** The sentence for an error nobody wrote a message for. */
export const UNEXPECTED_ERROR = INTENT_FALLBACK_ERROR;

/** Is this one of the errors raised on purpose, with a message that is safe to show? */
export function isUserFacing(err: unknown): boolean {
  return err instanceof PasskeyError || err instanceof OnboardingError || err instanceof ApprovalError
    || err instanceof AuthError || err instanceof LimitsError || err instanceof UserFacingError;
}

/** The status and JSON body for an error. */
export function errorResponse(err: any): { status: number; body: Record<string, unknown> } {
  if (err instanceof LimitsError) return { status: err.status, body: { error: err.message, ...(err.code ? { code: err.code } : {}), ...err.extra } };
  if (err instanceof PasskeyError || err instanceof OnboardingError) return { status: err.status, body: { error: err.message, code: err.code } };
  if (err instanceof OverCapError) return { status: err.status, body: { error: err.message, code: err.code, ...(err.ownerSign ? { ownerSign: err.ownerSign } : {}) } };
  if (err instanceof ApprovalError || err instanceof AuthError || err instanceof UserFacingError) return { status: err.status, body: { error: err.message } };
  return { status: 500, body: { error: UNEXPECTED_ERROR } };
}

/** What the user reads when an account action fails: the guard's own sentence, or the fixed "can't confirm" one. */
export function executionErrorMessage(err: any): string {
  return isUserFacing(err) ? err.message : EXECUTION_FAILED_REASON;
}
