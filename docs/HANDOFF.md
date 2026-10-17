# Swipeback — handoff context (read this first)

Written Sat 17 Oct 2026, ~13:30 BST, so a fresh Claude Code session (different account) can continue without losing anything.
**Hard deadline: Sun 18 Oct 2026, 13:00 BST** (SotonShip 2026 FinTech track; submit video, ~150-word summary, GitHub link, pricing hypothesis, pilot route). About 23.5 hours remain at the time of writing. Freeze code ~12:45.

Everything here is derived from the repo and the conversation. The source of truth for requirements is the PRD; the source of truth for the plan and a milestone-by-milestone log is `docs/PLAN.md`.

---

## 1. What this project is

**Swipeback**: an email-first, card-agnostic expense-operations agent. Promise: **"Finance only deals with exceptions."** It connects to a designated company finance mailbox (with consent), reads receipt emails, reconciles them with company-card transactions, applies the company's written policy deterministically, autonomously clears or escalates, reimburses employee-paid spend through a **simulated** payout, and keeps an audit trail for everything.

- PRD: `/Users/taran/Downloads/Swipeback_Master_PRD_v1.1_Multichannel.pdf` (12 pages). Not in the repo. If missing, the repo's `docs/PLAN.md` restates its workflows, acceptance criteria (AC-01…AC-12), risks and cutline.
- User (founder / sole engineer): Taran. GitHub account `36taransingh5-dotcom`. Studies in the UK (Southampton); this is for the SotonShip hackathon.
- Founding-engineer brief the user gave: *"genuinely working, commercially credible FinTech product, not a mockup"*; **email is the primary interface; do NOT build a dashboard-first product**; optimise for real working functionality, code quality, reliability and a compelling live demo.
- Working agreement: implement milestone by milestone, **tests and verification after each milestone**, commit each milestone once its gate passes (the user said this explicitly). Never fake results; report real denominators and failures.

### Non-negotiable product rules (from the PRD and the user)
1. Company-card expenses are **cleared and exported, never reimbursed**. Enforced in code and by Postgres triggers.
2. Two separate authorisations: (a) auto-clear/approve an expense, (b) authorise a payment. (a) never implies (b).
3. All policy / eligibility / payout decisions are **deterministic code**. The model only extracts and explains. Any uncertainty, conflict, duplicate, sender mismatch or model failure **fails closed into human review**, never an auto-clear.
4. Email/receipt text is untrusted data, never instructions. Prompt-injection must be tested.
5. Payouts are **simulated only** (MockPay). All demo data is synthetic and labelled. No real money, no real cards. Do not claim Slack/WhatsApp/Telegram/iMessage are live; only email is real (Slack is a stretch).
6. Thresholds/limits belong to the organisation (policy document), not hard-coded.
7. Idempotency everywhere: duplicate emails, webhooks, jobs and payout attempts must not duplicate expenses or payments.

---

## 2. Current status (honest)

| Milestone | Status |
|---|---|
| M0 Foundations (workspace, schema + money invariants, job queue, audit chain) | DONE, committed `654b354` |
| M1 Pure domain (policy engine, matching, duplicates, eligibility, intents) | DONE, committed `cb6ae74` |
| M2 Walking skeleton (channels, extraction baseline, engine pipeline, MockPay, worker, CLI) | DONE, committed `3254985` |
| M4 AI extraction (built before M3 because Gmail creds weren't ready) | DONE, `8cc4b1c` |
| M4b OpenAI GPT-5.5 provider + held-out benchmark | DONE, `0db3fd3` |
| M5 Exception loop + authenticated reviewer (Hono app) | DONE, `122764f` |
| M3 Gmail connector | BUILT and tested offline; **real Gmail connected and polling**; **live receipt round trip NOT yet completed** (see §3) |
| Card-swipe-triggered receipt collection (user's latest requirement) | BUILT and tested offline (12 new tests); **live test NOT yet run** |
| M6 Full-pipeline evaluation (tune/held-out, baseline, PRD metrics) | NOT STARTED (a model-level held-out benchmark exists; the end-to-end one does not) |
| M7 Demo hardening, README, threat model, runbook, fallback video | NOT STARTED |
| M8 Slack stretch | NOT STARTED (decide only if everything else is green) |

`corepack pnpm verify` is green: **331 tests in 23 files**. M3 + card-led work is committed together in the commit that accompanies this file (message says live tests are pending).

---

## 3. Immediate next steps (in order)

1. **Finish the two live tests with the real Gmail mailbox** (the user must send/reply from their own accounts):
   - **Receipt-first:** `corepack pnpm verify:gmail --wait 900`. User emails a receipt (use `eval/demo-receipts/trainline-42.10-personal-card.jpg`) from `36taransingh5@gmail.com` to `swipeback.finance@gmail.com`. It checks: ingested with Gmail message id + attachment sha256, expense created and decided, reply in the **same Gmail thread**. Expected: Trainline £42.10, personal card, auto-cleared, simulated payout, reply "Reimbursed (simulated)".
   - **Card-swipe-first:** `corepack pnpm verify:card-receipt --amount 58.40 --merchant "SHELL WATFORD 123" --card 4242`. It emits a signed SYNTHETIC swipe on Sam Taylor's company card, waits for the grace period (1 minute in `.env.local`), checks the receipt-request email goes out from the finance mailbox to the employee, then the user **replies in that thread attaching `eval/demo-receipts/shell-watford-58.40-card-4242.jpg`**; the command checks decision, same-thread reply, 0 reimbursements, and the OpenAI model used.
   - The worker (`corepack pnpm worker`) must be running for both. Gmail polling interval 10 s.
   - Report real results. If something fails, diagnose; do not paper over.
2. **M6 evaluation** (PRD §10, AC-12): 40–60 labelled synthetic expense cases, ≥20 held out and frozen by checksum before tuning, covering clean card receipts, personal reimbursements, missing VAT, currency mismatch, duplicates, merchant mismatch, policy cap, ambiguous purpose, manipulated receipt, prompt injection. Report numerators and denominators: field accuracy, match precision, **false auto-clear rate**, false escalation rate, autonomous resolution rate, follow-ups per expense, cost per expense, time saved vs a manually timed baseline, rule-only baseline side by side. Target zero false simulated payouts (report as measured). Also expose via `GET /api/evaluations/report` (route exists, reads `eval/reports/*.json`). Reuse `tools/cli/src/eval/` and the receipt renderer.
3. **M7**: `demo:reset` (<10 s), storyboard runbook (PRD §11), CSV import/export polish (P1), README (install, credentials, dataset provenance, threat model, limitations, test commands, competitor references from the PRD appendix), `SYNTHETIC`/`SIMULATED` labels everywhere (AC-11), fallback video of a genuine run (never present a replay as live).
4. **M8 Slack** only if all above are green by ~Sun 11:30. If not built, keep it roadmap; no half-working Slack on stage.
5. Submission artefacts by Sun 13:00.

---

## 4. Architecture (as built)

```
Gmail (live) | fixture .eml | synthetic chat | card simulator (signed)  ->  channel adapters (transport only)
   -> InboundMessage v1 / CardTransaction v1 (provider-neutral)
   -> Postgres durable job queue (SKIP LOCKED, leases, backoff, dead-letter)
   -> engine: identity -> intent -> extraction -> evidence checks -> matching -> duplicates
      -> deterministic policy -> expense state machine -> reimbursement eligibility/authorisation -> payout state machine
   -> outbox (transactional, idempotent) -> originating channel (email thread)
   -> append-only hash-chained audit log
```

Monorepo (`pnpm`, run everything with `corepack pnpm …` because pnpm isn't installed globally; Node 24; TypeScript strict; ESM; no build step, `tsx`):

| Path | Role |
|---|---|
| `packages/domain` | **Pure** (lint-enforced: no IO/clock/random). Money (integer minor units), state machines, policy schema (zod, clause citations), policy engine (`evaluatePolicy`/`decideExpense`), matching, merchant similarity, duplicates, payment-type resolution, reimbursement eligibility (`blockers` vs `humanRequired`), intents. |
| `packages/db` | SQL-first migrations (`migrations/0001…0005`), checksum guard, job queue (`JobRunner`), audit chain + verifier, pool/transactions, embedded Postgres helper. |
| `packages/channels` | `ChannelAdapter` contract + `InboundMessageV1` (zod), sanitiser, evidence store, email MIME/auth/anti-loop/reply-stripping, `FixtureEmailAdapter`, `SyntheticChatAdapter` (HMAC-signed), `GmailAdapter`, Gmail REST/OAuth client, reusable contract test suite. |
| `packages/extraction` | Provider-neutral `model-contract.ts` (one prompt, schema, mapping), `BaselineExtractor` (rules, text/HTML/PDF text layer), `LlmExtractor` (Anthropic), `OpenAIExtractor` (**default, gpt-5.5**), evidence/arithmetic/injection checks (`checks.ts`), cassette record/replay, PDF text layer (pdfjs). |
| `packages/payouts` | `PayoutProvider` port + `MockPayProvider` (separate `mockpay` schema, idempotent on key, failure injection: timeout before/after commit, 5xx, decline). |
| `packages/engine` | Commands/handlers: inbound intake, extraction, evaluation, questions/reminders, review decisions, payment authorisation, payout execution, export, card feed, receipt chase, Gmail connect/poll, auth, challenges, case read models, runtime wiring. |
| `apps/worker` | Long-running job runners + Gmail poll loop. |
| `apps/web` | Hono server-rendered **minimal reviewer app** (not a dashboard) + PRD §7.4 API routes. |
| `tools/cli` | `corepack pnpm sb <cmd>`: db, seed, replay, email, card-sim, expenses, eval, smoke, verify commands; synthetic receipt renderer (Playwright Chromium); demo org policy. |
| `eval/` | `datasets/heldout` (24 frozen images + manifest + labels), `cassettes` (recorded model responses), `reports`, `demo-receipts`. |
| `test/support` | Test DB harness (clones a migrated template DB per test file), `fake-gmail.ts`. |
| `docs/` | `PLAN.md` (architecture, milestones, **progress log**), `EXTRACTION_BENCHMARK.md`, this file. |

### Key invariants enforced in Postgres (see `0001_core.sql`, tested in `packages/db/test/invariants.test.ts`)
- State-transition tables copied from `packages/domain` by the migrator; triggers reject illegal transitions (`SBT01`).
- Reimbursement can only be created for a PERSONAL, unmatched, cleared expense, to the claimant's own verified destination (`SBI01`); one live reimbursement per expense; `AUTHORIZED` needs an authorisation row; `SIMULATED_PAID` needs a succeeded payout attempt with the same idempotency key; payee/amount/key immutable.
- Human payment authorisation: `payment_approver` role, not the claimant, mandatory reason.
- Reviews: reviewer role, not own expense, non-blank reason; immutable. Policy versions, payout destinations (revoke-only), audit events: append-only (`SBA01`). Expense pinned to one policy version.
- `audit_events` is hash-chained per organisation with a verifier (`corepack pnpm sb audit:verify`). Chain is tamper-evident only if the head hash is published outside the DB (not yet done).

### Expense states
`RECEIVED → EXTRACTING → NEEDS_MATCH | NEEDS_INFO | POLICY_CHECK → AUTO_CLEARED | REVIEW_REQUIRED → APPROVED | REJECTED → EXPORTED`, plus `MERGED` (a separately emailed receipt absorbed into the card-led expense for the same transaction). A card-led expense goes `RECEIVED → NEEDS_MATCH` at the swipe.
Reimbursement: `DRAFT → ELIGIBILITY_CHECK → AUTHORIZED → PAYOUT_QUEUED → SIMULATED_PAID | FAILED | CANCELED`.

### Policy outcome precedence (deterministic)
INTEGRITY (evidence/identity/duplicate/conflict) → HUMAN_REVIEW; then REJECT → REJECT_FOR_CORRECTION; then INFO → REQUEST_INFO (exactly one question, never the same question twice; unresolved question escalates); then LIMIT → HUMAN_REVIEW; else CLEAR. Demo org policy (clauses NW-1…NW-16, caps, auto-pay limits £150/each, £300/day, £600/week, £5,000/month) is in `tools/cli/src/demo-policy.ts` and seeded as policy v1.

### Card-led receipt collection (just built)
- `ingestCardTransaction` stores a provider-neutral `CardTransactionV1` exactly once (unique provider+txn id), emits job `card-transaction`.
- `onCardTransaction`: if an emailed receipt already waits and fits the swipe → re-evaluate it (no second expense); else create a **card-led expense** (`source_type=CARD_FEED`, `payment_type=CORPORATE`, linked to the transaction) in `NEEDS_MATCH` and schedule `receipt-chase` after `SB_RECEIPT_GRACE_MINUTES` (default 60).
- `chaseReceipt` (after grace, if still no receipt): one email from the finance mailbox to the enrolled cardholder with merchant, amount, date, card last4; subject `Receipt needed: GBP 58.40 at SHELL WATFORD 123 on 2026-10-17 [SB-1001]`; Reply-To plus-address token; creates the open `RECEIPT` question; reminder then expiry via `question-timeout` (reminder `SB_QUESTION_REMINDER_MINUTES`, expiry `SB_QUESTION_EXPIRY_MINUTES`; defaults 24 h each). Expiry or an answer without a receipt → escalates to finance (never re-asks). No connected mailbox → fails closed to finance.
- The reply is correlated by token or thread to the card-led expense, extracted with the configured model, and **the receipt must agree with the card payment** (amount, date window, card); disagreement raises `RECEIPT_TRANSACTION_MISMATCH` → review. A separately emailed receipt for a transaction whose card-led expense is still waiting is **merged** (`MERGED`), not duplicated.
- Card-led replies thread onto our own first email (`outbound_messages.rfc_message_id`).
- Card feeds are adapters (`CardFeedAdapter`): the simulator (`CardSimulatorFeed`, HMAC + 5-min window) is the only one; a real issuer webhook would add an adapter and call `ingestCardTransaction`.

---

## 5. Environment, secrets and how to run

Everything runs **locally**: embedded Postgres 18 (no Docker), worker, web. Secrets live only in `/Users/taran/Documents/GitHub/swipeback/.env.local` (gitignored; **never print or commit it**). `.env.example` is the template; code loads `.env.local` via `loadLocalEnv()` (CLI, worker, web).

Keys in `.env.local` (names only):
`SB_FINANCE_MAILBOX` (swipeback.finance@gmail.com, the designated mailbox), `SB_EMPLOYEE_EMAIL` (36taransingh5@gmail.com, seeded as enrolled employee "Sam Taylor"), `SB_REVIEWER_EMAIL` (techediting5@gmail.com, seeded as finance controller "Priya Shah": roles reviewer + payment_approver + admin), `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` (redirect `http://localhost:3000/api/oauth/google/callback`; Google consent screen in Testing mode, mailbox is a test user), `SB_TOKEN_ENCRYPTION_KEY` (generated locally; mailbox tokens are AES-GCM encrypted at rest; **if lost, reconnect the mailbox**), `SB_OPENAI_API_KEY`, `SB_OPENAI_MODEL=gpt-5.5`, `SB_EXTRACTOR=llm`, `SB_LLM_PROVIDER=openai`, `SB_APP_URL=http://localhost:3000`, demo timings `SB_RECEIPT_GRACE_MINUTES=1`, `SB_QUESTION_REMINDER_MINUTES=10`, `SB_QUESTION_EXPIRY_MINUTES=20`. `SB_ANTHROPIC_API_KEY` is empty (Anthropic provider is optional).
Optional: `SB_OPENAI_REASONING_EFFORT` (default medium), `SB_CASSETTES=off|record|replay`, `SB_GMAIL_POLL_SECONDS` (10), `SB_SYNTHETIC_CHAT_SECRET`, `SB_CARD_FEED_SECRET` (dev defaults only work against a local DB).
**On a new machine or account the `.env.local` is not in git**: recreate it from `.env.example` and redo the Google consent (see below).

### Start everything
```bash
corepack pnpm install
corepack pnpm db:start        # embedded Postgres in the foreground (port 54329, data in .data/pg) — own terminal/background
corepack pnpm db:migrate      # apply migrations (idempotent)
corepack pnpm seed            # synthetic org "Northwind Field Services Ltd (SYNTHETIC DEMO)" + policy v1 + members/cards/payee
corepack pnpm worker          # jobs + Gmail polling (needs the DB)
corepack pnpm web             # reviewer app on http://localhost:3000
```
A fresh seed uses the three addresses above; `corepack pnpm db:reset && corepack pnpm seed` rebuilds everything (local DBs only; refuses non-local URLs). After a reset the Gmail connection is lost: sign in as the reviewer (§ below) and click Connect again.

**Reviewer sign-in (magic link):** while Gmail is connected the link is emailed to the reviewer address through the finance mailbox. Before Gmail is connected (fixture transport), the email is written to `.data/outbox/*.eml` (decode with Python `email`; link is `http://localhost:3000/auth/callback?t=…`). Go to `/login`, enter `techediting5@gmail.com`.
**Connect Gmail:** signed in as admin, open `/connect` → "Connect swipeback.finance@gmail.com with Google" → sign in as that Google account and grant read+send. The server rejects any mailbox that isn't the designated one and revokes that grant.

### Commands
```bash
corepack pnpm verify                      # typecheck + lint + all tests (331) — run before every commit
corepack pnpm sb                          # list CLI commands
corepack pnpm sb expenses                 # table of expenses/decisions/payouts
corepack pnpm sb card-sim --amount 11.25 --merchant "PRET A MANGER LONDON GB" --card 4242
corepack pnpm sb email --from <enrolled> --attach file --subject "…"        # offline fixture transport (not Gmail)
corepack pnpm sb eval:generate | eval:benchmark --models gpt-5.5,gpt-5.4-mini [--record|--replay]
corepack pnpm sb audit:verify | jobs:stats | run-jobs
corepack pnpm smoke:extract [--model id] [--record]
corepack pnpm verify:gmail --wait 900 | verify:card-receipt --amount 58.40 --merchant "SHELL WATFORD 123"
```
Preview server config `swipeback-web` is in `/Users/taran/Documents/GitHub/.claude/launch.json` (workspace-level, not in the repo); on another machine start with `corepack pnpm web`.

### Seeded identities
Sam Taylor (employee, payout VERIFIED, company card `4242`, chat id `chat:sam.taylor`) = the employee address; Priya Shah (controller) = the reviewer address; Alex Morgan (employee, NOT payout-enrolled, card `1881`); Jordan Lee (employee+reviewer). Alex/Jordan use `.example` addresses and exist to demo unenrolled-payee and segregation-of-duties cases. Synthetic chat connection exists for the second-channel demo (`SyntheticChatAdapter`).

---

## 6. Testing and evidence

- **Unit/property:** exhaustive state-machine table; 10,000-case seeded property test that any auto-authorised payout satisfies every PRD §5 control (non-vacuity guard; mutation-checked); matching, duplicates, intents, money, policy tests.
- **DB invariants:** attacks the schema directly (triggers). Job queue (1,000 jobs × 4 runners exactly once, leases, backoff, dead-letter). Audit chain tamper detection.
- **Pipeline (real Postgres):** 28 scenarios + LLM-path + review + Gmail (fake) + card-led suites; duplicate email/webhook ×5, payout exactly-once under 20 concurrent executions and timeouts, injection, malformed files, model outage, spoofed senders, channel neutrality (email vs synthetic chat give identical decisions).
- **Browser e2e:** Playwright against the real web app: approval-link → sign-in → approve → separate payment authorisation → one simulated payout; reused/expired/stale/wrong-person links rejected.
- **Live evidence so far:** OpenAI gpt-5.5 smoke on 5 receipts correct (~$0.03/receipt); live pipeline run with real images; held-out benchmark below; real Google OAuth connected with the exact two scopes; magic-link sign-in in a real browser pane.
- **Held-out model benchmark (24 frozen synthetic images):** gpt-5.5 and gpt-5.4-mini both 96/96 decision fields, 0 silent errors; mini is 4.9× cheaper ($0.0066 vs $0.0326/receipt) with worse p95 latency; the set is saturated, so **the default stays gpt-5.5** (user instruction: do not switch to the cheaper model unless an evaluation supports it). Details and limits: `docs/EXTRACTION_BENCHMARK.md`. Replays offline from `eval/cassettes` (regression test in `tools/cli/test`).
- Test data is synthetic only. Dates in fixtures are relative to "now" so they don't age out of the claim window.

---

## 7. Decisions, deviations and gotchas (things that will bite)

- **No Drizzle, no down migrations**: SQL-first + `pg`, reset+migrate reproducibility instead. Migrations are append-only with checksums: **never edit an applied migration; add a new one** (0006…).
- **Reviewer app is Hono, not Next.js** (PRD preferred Next.js): fewer moving parts, testable in-process. Keep it minimal; the user explicitly does not want a dashboard.
- **GPT-5.5 is the default extractor** (user choice); Anthropic provider (`claude-opus-5-5`) kept selectable. Both share prompt/schema/checks. Ambient `ANTHROPIC_*`/`OPENAI_*` shell variables are deliberately ignored (explicit keys only; the shell has an `ANTHROPIC_BASE_URL` set).
- OpenAI structured-output specifics, pricing (gpt-5.5 $5/$30, gpt-5.4-mini $0.75/$4.50 per M tokens, checked on OpenAI's pricing page 17 Oct) are in `packages/extraction/src/openai.ts`. Unknown-price models log cost as unknown, never guessed.
- **Gmail threading:** replies keep the employee's subject (`Re: …`) because Gmail only threads when Subject matches; the status line moved into the body. The first outbound card-led message has its own subject.
- **Sender authentication:** identity needs an enrolled address **and** Google's `Authentication-Results` (authserv `mx.google.com`) DKIM/DMARC pass aligned with From. Display names are never used. Unknown-but-authenticated senders get one rate-limited enrolment reply; failed-auth senders get nothing (no backscatter).
- **Gotchas:** pnpm only via `corepack pnpm`; don't `pnpm install` while dev servers run (restart them); the browser tool's CSP blocked the first OAuth redirect (fixed: `/connect` allows `form-action https://accounts.google.com`); Gmail testing-mode refresh tokens expire after ~7 days (`RECONNECT_REQUIRED` state + banner exist); `.data/` (DB, evidence, outbox) is local-only and gitignored; background processes: `db:start` runs in the user's current session, worker/web were started from there too (restart after code changes).
- **Known limitations / honest gaps:** audit-chain head not published externally; arithmetic check ignores discounts/service lines when a model omits them (could falsely escalate; not seen yet); images' quote verification uses the model's own transcription (PDFs use the real text layer); benchmark set synthetic and saturated; no malware scanner; no retention/deletion automation; SPF/DKIM trust is Google's verdict only; Slack/WhatsApp/Telegram/iMessage are roadmap (only email + the synthetic chat simulator exist); gmail poller is poll-based (no Pub/Sub push).
- **User preferences seen:** wants real working behaviour, honest reporting of failures, commits after gates pass, secrets never printed; asked for plain explanations (e.g. why employees send receipts when bank data exists — the card feed gives amount/merchant but not itemised receipt/VAT invoice/purpose; personal spend never appears in the company bank feed). They asked to "not automatically choose the cheaper model".

---

## 8. Pitch/judging notes (for M7)
- Demo storyboard (PRD §11): synthetic swipe + receipt → auto-match, cleared (finance touches nothing) → personal receipt → extraction → approved simulated reimbursement → duplicate/over-cap → targeted follow-up/review → eval metrics with denominators and known failures → buyer economics + clearly labelled future card concept render. Card-swipe-triggered chase is the strongest new demo beat: *finance never chases a receipt again*.
- Truth in pitch: do not claim competitors only do field matching; do not claim messaging or AI policy review is novel; differentiation is a hypothesis (existing stack in, exceptions out). Hypothetical pricing in PRD §12.1 (£99/workspace/month + £0.30 per expense).
- A fallback video of a genuine end-to-end run is required; never present a replay as live.

---

## 9. How to resume in a new Claude Code session
1. `cd /Users/taran/Documents/GitHub/swipeback` (or clone the repo) → read this file and `docs/PLAN.md` (§8 progress log).
2. `corepack pnpm install && corepack pnpm verify` (expect 331 green). Recreate `.env.local` if needed (§5).
3. Start DB, migrate, seed, worker, web (§5). Confirm Gmail status at `/connect`; reconnect if `RECONNECT_REQUIRED`.
4. Do §3 step 1 (live tests) first; then M6, M7. Commit after each gate with a message listing real results.
5. Keep the plan-tracking habit: update `docs/PLAN.md` §8 after each milestone.
