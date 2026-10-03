# Paper Outline — Ledger N3XT Research Competition, Track 1: Agentic Economy

**Working title:** *Never Let the Model Hold the Keys: Layered Authorization for
Value-Holding AI Agents*

**Alternative titles (pick what feels yours):**
- *The Model Is Not the Guardrail: Deterministic Authorization for Autonomous Onchain Agents*
- *Interpretation Is Not Authority: A Delegation Architecture for AI Agents That Move Money*

**Thesis (one sentence):** An AI agent may *interpret* what a user wants, but it must
never be the component that *decides* whether value moves — authorization must live in
deterministic, auditable code, delegation must be bounded on-chain, and irreversible
actions must be anchored to human intent through hardware.

**Target:** 2,500–4,000 words, designed PDF, 5–6 figures.
**Evidence base:** the Orchestra reference implementation + the adversarial evaluation
in `eval/` (results feed §6). The paper is a *research argument*; Orchestra is the
testbed, not the subject — no product promotion (pass/fail criterion #1).

---

## Word budget

| § | Section | Words |
|---|---------|-------|
| — | Abstract | 150–200 |
| 1 | Introduction: the delegation problem | 350–450 |
| 2 | Threat model | 350–400 |
| 3 | Design principle: separate interpretation from authority | 450–550 |
| 4 | Architecture: three rings of authority | 600–750 |
| 5 | Evaluation methodology | 300–400 |
| 6 | Results | 400–500 |
| 7 | Discussion & limitations | 250–350 |
| 8 | Ledger Lens (required section) | 250–300 |
| 9 | Conclusion | 150–200 |
| | **Total** | **~3,250–4,100** (trim to ≤4,000) |

---

## Abstract (150–200 words)

Written for a non-expert — this is explicitly graded ("non-expert can follow") and it
is also the text people see when deciding whether to like/share the paper. Structure:

1. Hook: AI agents are starting to hold wallets and act on them autonomously.
2. Problem: today the same probabilistic model that interprets a request is often
   trusted to police it — prompt injection or a single hallucination becomes an
   unauthorized transfer.
3. Contribution: a layered authorization architecture (probabilistic interpretation →
   deterministic policy → on-chain delegation bounds → hardware-anchored approval),
   implemented and evaluated.
4. Headline result: fill in from eval, e.g. *"an LLM-based risk gate approved X% of
   adversarial intents; the deterministic policy engine approved none, at zero added
   latency."*
5. One-line implication: autonomy is safe to grant only when the model's authority is
   structurally bounded, not politely requested in a prompt.

## 1. Introduction: the delegation problem (350–450 w)

- Open with the concrete scene: you tell an agent "swap 10 USDC for ETH" and it
  happens with no clicks. The agentic economy assumes exactly this: agents that hold
  value and act autonomously (mirror the track's own language).
- The industry is racing there: agent payment rails (x402, Visa Intelligent Commerce,
  Mastercard Agent Pay, Google AP2), wallet-permission standards (ERC-7715/7710,
  session keys). Cite 2–3.
- The uncomfortable core: an LLM is a probabilistic text function. "Don't spend more
  than $100" in a system prompt is a *request*, not a control. Cite prompt-injection
  literature (Greshake et al.; OWASP LLM01; AgentDojo showing sota agents fail under
  injection).
- Framing question the paper answers: **what is the minimal architecture under which
  it is rational to let a probabilistic agent hold value?**
- Contributions list (3 bullets): (i) a design principle — interpretation/authority
  separation; (ii) a concrete three-ring architecture with tiered human anchoring
  (passkey vs hardware) implemented on Safe + Ledger; (iii) an adversarial evaluation
  comparing an LLM risk-gate baseline against a deterministic policy engine on the
  same intents.

## 2. Threat model (350–400 w)

Be precise here — this is what makes it *research* and satisfies "Safety & Defense:
claims reasoned" (criterion #5). Three adversaries, one table:

- **T1 — Adversarial input, honest model.** Attacker controls text reaching the
  planner (the user is tricked, or content is injected upstream): prompt injection,
  authority claims ("your limit was raised"), unit obfuscation (gwei vs ETH,
  decimal-comma locales), value misdirection.
- **T2 — Compromised or hallucinating planner.** The model itself emits a malicious
  or wrong plan: under-reported USD value, symbol/address mismatch, invented
  recipient. Cause irrelevant (jailbreak, poisoned context, plain hallucination) —
  the defense must not care.
- **T3 — Compromised execution host.** The server running the agent is attacked.
  Software alone cannot fix this; this is where on-chain allowances (ring 2) and
  hardware signing (ring 3) are load-bearing: what the attacker can steal is bounded
  by the on-chain delegation, not by any server-side check.
- Out of scope (say so explicitly): compromised hardware wallet, malicious user,
  protocol-level (Uniswap/Safe contract) bugs, MEV.

**Fig. 1:** threat table — adversary × capability × which ring stops them.

## 3. Design principle: separate interpretation from authority (450–550 w)

The intellectual heart. Argue from first principles:

- Two jobs get conflated in today's agent stacks: *interpretation* (NL → structured
  intent; genuinely needs a model) and *authorization* (may this intent execute; needs
  determinism, auditability, fail-closed behavior).
- Why a "gatekeeper LLM" is a category error even with a strong model: verdicts are
  sampled, not computed — same plan can get different verdicts; it shares the failure
  mode (prompt sensitivity) of the very component it's meant to police, so failures
  correlate; its reasoning is unfalsifiable post-hoc.
- Analogy for the non-expert: the interpreter at a border crossing translates your
  request; they do not stamp the passport. (Or: a bank teller types in what you ask
  for; the transfer limit lives in the core banking system, not in the teller's
  goodwill.)
- Honest confession that strengthens the paper: Orchestra v1 shipped with a
  Gatekeeper LLM prompted with risk rules ("apply these rules in order…") plus a
  ~20-line server-side patch that overrode it when its arithmetic was wrong. The
  patch kept growing; the LLM verdict kept mattering less. The refactor — deleting the
  gatekeeper LLM and promoting the patch to a pure policy engine — is the paper's
  origin story. (Also cuts one full LLM round-trip: safety *and* latency improved —
  worth one sentence + number.)
- State the resulting invariants as a numbered list (these become the rubric §6 tests):
  1. No model output is ever trusted for valuation — the server re-prices every plan
     from step params using live feeds.
  2. The verdict function is pure, deterministic, unit-tested, and fail-closed
     (unknown intent ⇒ approval required).
  3. Nothing the model writes can *weaken* a verdict; rules only escalate.
  4. Escalation terminates in a human factor whose strength scales with value.

## 4. Architecture: three rings of authority (600–750 w)

**Fig. 2:** the pipeline (NL → Planner LLM → deterministic policy `decide()` →
executor → Safe) with the three rings drawn as nested boundaries.

- **Ring 0 — Interpretation (probabilistic, zero authority).** Planner LLM parses NL
  into a typed plan (action, token addresses from a pinned registry, amounts). It is
  told to not price the plan; nothing it says is load-bearing. Anti-hallucination
  prompt rules exist but are treated as *hygiene, not defense*.
- **Ring 1 — Deterministic policy (server, code).** The `decide()` engine: server-side
  USD revaluation; rolling 24-h spend limit; token allow-list; recipient allow-list;
  daily auto-approval count; habit-anomaly rule (10× median of observed activity —
  boring statistics, no ML, deliberately: the baseline can only *add* friction, so
  learning is fail-closed). Verdicts: AUTO_EXECUTE / NEEDS_APPROVAL / BLOCKED / INFO,
  each with machine-readable triggered-rule slugs → every decision is explainable and
  auditable. Decisions logged to decentralized storage (0G) for tamper-evident audit.
- **Ring 2 — On-chain delegation bounds (Safe + AllowanceModule).** The agent wallet
  is a *delegate* of a Safe smart account, not an owner; its allowance is enforced by
  contract. Even a fully compromised server (T3) cannot exceed it. This is the
  delegation mechanism the track asks about: revocable, inspectable, chain-enforced.
- **Ring 3 — Human anchor, tiered by value.** NEEDS_APPROVAL resolves to a factor
  proportional to value: passkey (WebAuthn platform authenticator) below a hardware
  threshold; Ledger hardware signature above it. Key point for Ledger Lens: the
  hardware wallet's secure screen renders *what will actually execute* (clear
  signing / ERC-7730), so the human approves the transaction, not the model's account
  of it — the trusted display is outside every software ring.
- **Fig. 3:** decision flowchart of `decide()` (verbatim rule order, incl. fail-closed
  default).
- **Fig. 4:** value-tiered approval ladder ($0–limit: auto → limit–threshold: passkey
  → above: hardware).

## 5. Evaluation methodology (300–400 w)

Describe `eval/` (methodology must be stated — criterion). Two experiments:

- **E1 (end-to-end, threat T1):** N adversarial + benign natural-language intents ×
  k trials through the real pipeline (live LLM planner). Both gates judge the *same*
  plan: (a) the historical Gatekeeper-LLM (recovered verbatim from git history —
  faithful baseline, not a strawman), (b) the deterministic engine.
- **E2 (plan injection, threat T2):** handcrafted malicious plans fed directly to
  both gates, simulating a compromised planner — under-reported values, symbol/address
  mismatches, malformed plans, unknown actions.
- Metrics: **unsafe-approval rate** (attack case auto-executed — the metric that
  matters), **friction rate** (benign case needlessly escalated), verdict variance
  across trials (determinism itself as a measured property).
- Configuration disclosed: fixed policy profile (limits, allow-lists), stubbed price
  feed for reproducibility, model + temperature, trial counts.
- Honesty: state that the corpus is written by the authors, small-N, single model —
  §7 owns these limits.

## 6. Results (400–500 w)  ← *numbers land here after `npm run eval`*

- **Fig. 5 (the money chart):** unsafe-approval rate per attack category, LLM gate vs
  deterministic engine, side-by-side bars.
- **Table 2:** per-category breakdown: cases, LLM unsafe %, deterministic unsafe %,
  friction on benign set.
- Expected shape (verify, don't assume): LLM gate fails on some injection /
  misreport / unit cases and *varies across trials*; deterministic engine has 0%
  unsafe by construction on valuation-based attacks — and, importantly, any nonzero
  finding for the deterministic engine is a *feature of the paper, not a bug*: report
  it, fix it, describe the fix (e.g. valuation trusting model-supplied token symbols
  over address-derived ones). "We found and closed a residual trust edge" is a
  stronger research narrative than "we were perfect."
- Also report: latency (one LLM call instead of two), and that deterministic verdicts
  had zero variance across trials.

## 7. Discussion & limitations (250–350 w)

- What the architecture does *not* solve: a perfectly-in-policy malicious intent
  (attacker keeps every tx under the limit — mitigated only in expectation by
  velocity caps); semantic attacks inside interpretation (the plan is what the user
  *said*, not what they *meant*); oracle manipulation of the price feed; UX blindness
  (habitual approval-clicking).
- Generalization: rings are portable — any agent framework + any programmable
  account (ERC-4337 session keys, ERC-7715 permissions) can host the same separation.
- Where LLMs *do* belong in safety: advisory anomaly narration, never verdicts.
- Small-N eval, one model family, author-written corpus; future work: community
  red-team corpus, formalizing the policy language, per-protocol semantic validators.

## 8. Ledger Lens (250–300 w — REQUIRED, pass/fail)

Connect honestly, no product promotion:

- The architecture's last ring is *physical*: the entire software stack — model,
  policy engine, server — is treated as potentially compromised, and the final
  authority is a signature produced inside a secure element whose screen shows the
  actual transaction (clear signing, ERC-7730). This is "atoms over code" made concrete:
  when code can be subverted by text, the root of trust must be something text
  cannot rewrite.
- Delegation inverts the usual hardware-wallet story: the Ledger is no longer the
  *bottleneck* for every action but the *constitution* of the agent — it signs the
  delegation bounds (Safe owner, allowance updates) rarely and deliberately, and
  arbitrates only the exceptional. Hardware anchoring is what makes agent autonomy
  *grantable*: you can delegate boldly because you can bound and revoke physically.
- One forward-looking sentence: as agents transact agent-to-agent, the scarce
  resource is not intelligence but *accountable intent* — and hardware-anchored
  signatures are how intent stays accountable at machine speed.

## 9. Conclusion (150–200 w)

Restate the principle as the take-away: the question is not "can we trust the
model?" (no) but "what must be true so that we don't have to?" Answer: deterministic
policy, chain-enforced delegation, hardware-anchored escalation. Autonomy is an
architecture property, not a model property.

---

## Figures list

1. Threat table (adversary × ring that stops it)
2. Three-ring architecture diagram
3. `decide()` flowchart (fail-closed)
4. Value-tiered approval ladder
5. Results: unsafe-approval rate by category, LLM vs deterministic
6. (optional) Verdict variance across trials — determinism as measured property

## Compliance checklist (all five pass/fail criteria)

- [ ] **Ledger Lens** section present, honest, non-promotional (§8)
- [ ] **Originality**: final prose written by the author (AI used as tool for
      research/figures/eval harness — disclose this in methodology or acknowledgments);
      signed originality statement
- [ ] **Format**: PDF, designed layout, figures + captions, 2,500–4,000 words
- [ ] **Track**: Agentic Economy
- [ ] **Safety & Defense**: every security claim backed by the eval or a citation;
      no financial advice; no padding
- [ ] Public social post with **#LedgerN3XTCollab**
- [ ] Submit EARLY — 30-entry cap

## Writing-order suggestion (you write, I support)

1. Run the eval → freeze numbers (results dictate §6 and abstract's headline).
2. Draft §3 + §4 first (the argument you know cold), then §2, §5–6 from the eval
   README + results, then §1, §7, §8, abstract last.
3. I fact-check each draft section, verify citations, and build the figures + layout.
