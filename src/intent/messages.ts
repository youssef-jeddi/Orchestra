// ─── Intent — fixed sentences the user may read when something breaks ───
// Plain words for newcomers. The technical detail goes to the server log, never here.

/** What /intent answers when something unexpected fails on the server (not an AI-call failure). */
export const INTENT_FALLBACK_ERROR = "Something went wrong on our side. Please try again in a moment.";

/** What a send, swap or liquidity request gets when the limits or the day's activity can't be read: nothing runs, since the daily limit can't be checked. */
export const LIMITS_UNREADABLE_REASON = "I can't check your limits right now, so nothing was done. Please try again in a moment.";
