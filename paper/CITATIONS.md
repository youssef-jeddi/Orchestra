# Citation list — working bibliography

Curated for the paper's argument. **Verify every entry yourself before submission**
(titles/URLs checked against my knowledge, but the originality statement is yours to
sign — each claim in the paper must trace to a source you have actually opened).
Aim to cite ~15–20 of these; cut what you don't use.

## Prompt injection & agent security (grounds §1–§2, §3)

1. **Greshake, K. et al.** "Not what you've signed up for: Compromising Real-World
   LLM-Integrated Applications with Indirect Prompt Injection." AISec @ CCS 2023.
   arXiv:2302.12173. — The canonical indirect-prompt-injection paper.
2. **Liu, Y. et al.** "Prompt Injection Attack against LLM-integrated Applications."
   2023. arXiv:2306.05499.
3. **Debenedetti, E. et al.** "AgentDojo: A Dynamic Environment to Evaluate Attacks
   and Defenses for LLM Agents." NeurIPS 2024 (Datasets & Benchmarks).
   arXiv:2406.13352. — State-of-the-art agents fail under injection; our E1/E2
   methodology is a domain-specific echo of this. Cite when describing eval design.
4. **Zhan, Q. et al.** "InjecAgent: Benchmarking Indirect Prompt Injections in
   Tool-Integrated LLM Agents." ACL Findings 2024. arXiv:2403.02691.
5. **OWASP.** "OWASP Top 10 for LLM Applications" (2025 edition) — LLM01: Prompt
   Injection, LLM06: Excessive Agency. https://owasp.org/www-project-top-10-for-large-language-model-applications/
   — "Excessive Agency" is literally the paper's topic; quote its definition.
6. **Willison, S.** "The lethal trifecta for AI agents: private data, untrusted
   content, and external communication." Blog, June 2025.
   https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ — An agent with funds
   + open NL input is a fourth leg of this; good framing citation.

## Agentic payments & the agentic economy (grounds §1)

7. **Coinbase.** "x402: An open protocol for internet-native payments" (HTTP 402
   machine-to-machine payments), May 2025. https://www.x402.org / developer docs.
8. **Google.** "Agent Payments Protocol (AP2)," announced Sept 2025 — note its
   "mandates" concept: cryptographically-signed user intent, i.e. the same
   authorization problem addressed at the card-rails layer. Good compare/contrast.
9. **Visa.** "Visa Intelligent Commerce" (agent-initiated payments platform),
   April 2025 press release / developer docs.
10. **Mastercard.** "Mastercard Agent Pay," April 2025 announcement.
11. **Anthropic.** "Introducing the Model Context Protocol," Nov 2024.
    https://www.anthropic.com/news/model-context-protocol — for the general
    agent-tool wiring the ecosystem is standardizing on.

## Onchain delegation & account abstraction (grounds §4 Ring 2)

12. **EIP-4337:** "Account Abstraction Using Alt Mempool." Buterin et al.
    https://eips.ethereum.org/EIPS/eip-4337 — session keys / programmable validation.
13. **ERC-7715:** "Grant Permissions from Wallets" (wallet_grantPermissions).
    https://eips.ethereum.org/EIPS/eip-7715 — the emerging standard form of the
    delegation Orchestra implements with Safe allowances.
14. **ERC-7710:** "Smart Contract Delegation." https://eips.ethereum.org/EIPS/eip-7710
15. **Safe.** Safe{Core} docs — Allowance Module (spending limits for delegates).
    https://docs.safe.global — cite the module's contract-enforced semantics.
16. **EIP-712:** "Typed structured data hashing and signing."
    https://eips.ethereum.org/EIPS/eip-712

## Hardware anchoring & clear signing (grounds §4 Ring 3, §8 Ledger Lens)

17. **ERC-7730:** "Structured Data Clear Signing Format" (Ledger-initiated registry
    for human-readable signing). https://eips.ethereum.org/EIPS/eip-7730 — the
    load-bearing Ledger Lens citation: the secure screen shows the actual effect.
18. **Ledger.** Clear Signing initiative / developer docs on the secure screen +
    "don't trust, verify" model. https://developers.ledger.com — cite docs, not
    marketing pages, to stay non-promotional.
19. **W3C.** "Web Authentication: An API for accessing Public Key Credentials
    (WebAuthn), Level 2/3." https://www.w3.org/TR/webauthn-2/ — the passkey tier.

## Context & motivation (optional, §1/§7)

20. **Buterin, V.** "The promise and challenges of crypto + AI applications." Blog,
    Jan 2024. https://vitalik.eth.limo — explicitly warns about AI as the *judge*
    in adversarial settings; strong support for interpretation/authority separation.
21. **Chainalysis.** Latest Crypto Crime Report — only if you want one scale-of-theft
    motivation number; otherwise cut.

## How to use these honestly (criterion #5)

- Every security claim in the paper gets either (a) a number from `eval/results/` or
  (b) one of the citations above. Nothing free-floating.
- Where we compare to AP2/x402/7715, compare *mechanisms* (who enforces the bound:
  a prompt, a server, a contract, or a secure element) — not vibes about which is better.
- Disclose AI assistance (research, harness code, figures) in acknowledgments;
  final prose must be yours — the competition prohibits AI-written final drafts.
