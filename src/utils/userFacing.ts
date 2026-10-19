// ─── Utils — an error whose message is written for the user ───
// Guards on the paths that run a transaction (quote drift, a pool price off the market, a position
// that changed, an estimate that reverts) refuse with a plain sentence the user should read. They
// throw this, so the bridge shows the message as it is; any other error is logged and answered
// with one fixed sentence (src/integrations/ledger/errors.ts).

export class UserFacingError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

/**
 * A request refused because it would pass the account's on-chain daily ceiling. `ownerSign` is the
 * offer to sign it as the account owner (held by the server, see integrations/safe/ownerSign.ts);
 * absent when signing it yourself isn't available. The frontend reacts to `code`.
 */
export class OverCapError extends UserFacingError {
  readonly code = "over_daily_cap";
  constructor(message: string, public ownerSign?: Record<string, unknown>) {
    super(message, 409);
  }
}
