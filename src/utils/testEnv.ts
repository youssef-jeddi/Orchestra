// ─── Utils — environment for a bridge started by a test (test helper) ───
// Tests start the real serve.ts as a child process. serve.ts loads dotenv, so without this the child
// would read the developer's .env and could call Privy, Uniswap or a model provider with real
// credentials, or sign with the real agent key. No side effects on import, unlike testBridge.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Credentials a developer may also have exported in their shell; a test that needs one passes it in.
const REAL_SECRETS = [
  "AGENT_PRIVATE_KEY", "AGENT_KEY_ENCRYPTION_KEY", "PRIVY_APP_ID", "PRIVY_APP_SECRET", "GROQ_API_KEY", "ANTHROPIC_API_KEY",
  "UNISWAP_API_KEY", "ETHERSCAN_API_KEY", "ZERO_G_PRIVATE_KEY", "ZERO_G_API_KEY", "ADMIN_TOKEN", "LEDGER_WEBHOOK_SECRET",
];

let emptyDotenv: string | null = null;

/**
 * process.env without real credentials, with dotenv pointed at an empty file instead of ./.env,
 * then `overrides` on top. Use it as the `env` of every spawned serve.ts.
 */
export function isolatedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  if (!emptyDotenv) {
    emptyDotenv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-test-env-")), "empty.env");
    fs.writeFileSync(emptyDotenv, "");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of REAL_SECRETS) delete env[k];
  return { ...env, DOTENV_CONFIG_PATH: emptyDotenv, ...overrides };
}
