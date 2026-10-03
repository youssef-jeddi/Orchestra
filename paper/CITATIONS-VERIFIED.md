# Citation verification report — 2026-08-26

Each entry in `paper/latex/refs.bib` checked against its URL. Status legend:
✅ verified (URL opens, content matches the claim we cite it for) ·
🟡 exists but one detail to confirm · ⬜ not yet fetched (author: spot-check).

| Key | Status | Notes |
|---|---|---|
| greshake2023 | ✅ | Title, authors, indirect-prompt-injection subject all confirmed on arXiv:2302.12173. |
| liu2023promptinjection | ✅ | arXiv:2306.05499 confirmed (Liu et al., HouYi attack, 31/36 real apps vulnerable — usable stat). |
| debenedetti2024agentdojo | 🟡 | Confirmed; exact title is "…Evaluate **Prompt Injection** Attacks and Defenses…" (bib fixed). arXiv page doesn't state venue — confirm NeurIPS 2024 D&B acceptance before citing the venue line. |
| zhan2024injecagent | ✅ | Confirmed; bonus stat: GPT-4 vulnerable in ~24% of cases under standard prompting. |
| owasp2025 | ✅ | Latest is the **2026 edition** (Aug 4, 2026) under the OWASP GenAI Security Project; Excessive Agency is **LLM08** (bib fixed). |
| willison2025 | ✅ | Post, title, date, definition all confirmed. |
| coinbase2025x402 | ✅ | Real; now governed by the x402 Foundation under the Linux Foundation (bib updated). HTTP 402 mechanism confirmed. |
| google2025ap2 | 🟡 | Repo confirmed as Google's AP2. The "signed mandates" concept is in the docs/ spec, not the README — open the spec once before keeping that clause in the note. |
| visa2025 | ⬜ | Corporate URL generic — find the actual press-release URL before submission. |
| mastercard2025 | ⬜ | Same. |
| eip4337 / erc7715 / erc7710 / eip712 | ⬜ | Canonical eips.ethereum.org URLs — low risk; open each once. |
| safedocs | 🟡 | docs.safe.global describes modules with "daily spending allowances" generally; the concrete Allowance Module lives in the safe-global/safe-modules repo (bib now points there). |
| erc7730 | ✅ | Confirmed: "Structured Data Clear Signing Format", **Draft** status, Ledger co-authors (Castillo, Aoun). Bib notes Draft. |
| ledgerclear | ⬜ | developers.ledger.com — find the specific clear-signing doc page for a precise URL. |
| webauthn | ✅ | W3C Recommendation, April 8 2021, title exact. |
| buterin2024 | ✅ | Jan 30 2024; explicitly warns "AI as the rules of the game" is the riskiest crypto+AI pattern — strong §3/§7 support, quotable. |
| anthropic2024mcp | ⬜ | Well-known; open once. |

**Author actions before submission:** resolve the four ⬜ rows and the two 🟡 details;
delete any bib entry the final text doesn't cite.
