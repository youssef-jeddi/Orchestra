// ─── Intent — fixed sentences the user may read when something breaks ───
// Plain words for newcomers. The technical detail goes to the server log, never here.

/** What /intent answers when something unexpected fails on the server (not an AI-call failure). */
export const INTENT_FALLBACK_ERROR = "Something went wrong on our side. Please try again in a moment.";

/**
 * What an approved action shows when it fails in a way nobody wrote a message for. The failure may
 * have come after the transaction was sent (e.g. while waiting for the receipt), so it neither says
 * "nothing was sent" nor invites a blind retry.
 */
export const EXECUTION_FAILED_REASON = "Something went wrong on our side, so I can't confirm this went through. Check your balance before trying again.";

/** What a send, swap or liquidity request gets when the limits or the day's activity can't be read: nothing runs, since the daily limit can't be checked. */
export const LIMITS_UNREADABLE_REASON = "I can't check your limits right now, so nothing was done. Please try again in a moment.";
