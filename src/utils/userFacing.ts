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
