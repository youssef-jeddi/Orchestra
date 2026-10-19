// ─── Utils — refuse to start with fault injection in production ───
// Imported first by the bridge (side effect only), so the check runs before anything else loads.

import { faultInjectProblem } from "./faultInject";

const problem = faultInjectProblem();
if (problem) {
  console.error(`[startup] ${problem}`);
  process.exit(1);
}
if (process.env.ORCHESTRA_FAULT_INJECT) console.warn(`[startup] fault injection ON: ${process.env.ORCHESTRA_FAULT_INJECT} (development only)`);
