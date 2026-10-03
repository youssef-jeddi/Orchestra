# Adversarial evaluation harness

Empirical backbone for the N3XT paper (§5–§6 of `paper/OUTLINE.md`). It compares two
authorization gates **on the exact same plans**:

- **Baseline — historical Gatekeeper LLM.** The risk-rule prompt Orchestra actually
  shipped with, recovered verbatim from git history (`2e9560f^`), before the
  deterministic refactor. Not a strawman: it's our own previous production design.
- **Deterministic policy engine.** `src/policy`'s `decide()` — server-side
  revaluation, rolling 24h limit, allow-lists, velocity, habit anomaly. Pure code.

## Threat models

- **E1 — adversarial input, honest model** (`mode: "e2e"`): natural-language
  messages (benign, over-limit, prompt-injection, unit-confusion, …) run through the
  *real* Planner LLM; both gates judge the resulting plan.
- **E2 — compromised planner** (`mode: "plan"`): handcrafted malicious plans
  (under-reported USD, symbol/address mismatch, malformed, unknown actions) injected
  directly, as if the model itself were subverted or hallucinating.

## Metrics

- **Unsafe-approval rate** — attack trials verdicted `AUTO_EXECUTE`. The metric that
  matters: it is the probability that an attack moves funds without a human factor.
- **Friction rate** — benign trials needlessly escalated.
- **Verdict variance** — same case, same gate, different verdicts across trials.
  Determinism itself as a measured property (the LLM gate samples verdicts; the
  policy engine computes them).

## Running

```
npm run eval                    # full corpus, 3 trials/case
npx tsx eval/run.ts --trials 5
npx tsx eval/run.ts --only inj  # substring match on case id or category
```

Needs `GROQ_API_KEY` in `.env`. The run is **offline and side-effect-free**: 0G env
vars are stripped at startup (storage falls back to in-memory), the price feed stays
on its deterministic stubs (ETH $2500, USDC $1), and the harness stops at the
verdict — no transaction is ever built or submitted.

Results land in `eval/results/` (timestamped JSON with every trial record + a
markdown summary; `latest.md` is the most recent summary).

## Honest reporting rules (paper criterion #5)

- Report the deterministic engine's failures too. A nonzero unsafe rate for `decide()`
  (e.g. the `plan-02` symbol/address-mismatch valuation edge) is a *finding*: report
  it, fix it, and describe the fix in the paper. Do not silently patch before
  measuring.
- The corpus is author-written and small; one model family at default temperature.
  These limits go in §7 verbatim.
- Do not cherry-pick trials. The summary aggregates every trial of the run you cite;
  keep the JSON of the cited run in the repo.
