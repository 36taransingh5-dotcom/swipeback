# Swipeback

**Finance only deals with exceptions.** Swipeback is an email-first expense agent. Employees email receipts, or simply reply when Swipeback asks for one after a company-card swipe. Swipeback reads the receipt, matches it to the card transaction, checks it against the written expense policy, and either clears it, asks exactly one question, or hands it to finance with the evidence. Personal spend that is within policy is reimbursed automatically, through a separate deterministic authorisation step.

It works with any card feed or bank (card-agnostic), with no app to install and no dashboard to live in. The reviewer screen exists only for the exceptions.

> Built for SotonShip 2026 (FinTech track). **Everything here is a synthetic demo:** fictitious people, cards and receipts. Payouts go to a mock provider (`SIMULATED-MP-…`), and no money moves. Every email and screen says so.

## What is real and what is simulated

| Real | Simulated or synthetic |
|---|---|
| Gmail mailbox (OAuth, read + send scopes only), threaded replies | Card feeds: signed `sb card-sim` and a TrueLayer Data API sandbox adapter. The latter reads mock-bank cards, not production bank data |
| Receipt extraction with gpt-5.5 (structured output, evidence quotes, recorded for offline replay) | Payouts: MockPay, idempotent, with failure injection |
| Deterministic, versioned policy engine; matching; duplicate detection | People, cards, receipts and the demo company "Northwind Field Services Ltd (SYNTHETIC DEMO)" |
| Postgres invariants (triggers) that make card-spend reimbursement and double payout impossible | The receipt images are renders with simulated photo damage, not camera photos |
| Hash-chained audit log; authenticated reviewer app with one-time challenges | |

## How it works

```
Gmail / fixture .eml / synthetic chat / card simulator / TrueLayer sandbox
  -> InboundMessage v1 / CardTransaction v1                 (provider-neutral)
  -> Postgres job queue (SKIP LOCKED, retries, dead-letter)
  -> identity -> intent -> extraction -> evidence checks -> card matching -> duplicates
  -> deterministic policy (INTEGRITY > REJECT > one QUESTION > LIMIT > CLEAR)
  -> reimbursement authorisation (separate, deterministic) -> MockPay, exactly once
  -> reply in the employee's thread; append-only hash-chained audit
```

The model only reads documents. It has no tools and no authority: its output is a schema, and every decision field is checked (evidence quotes, arithmetic, card amount, uncertainty). Anything unclear fails closed to a person.

## Quick start (offline, no credentials)

Needs Node ≥ 24. Postgres is embedded (no Docker).

```bash
corepack pnpm install
corepack pnpm verify                       # typecheck + lint + 380+ tests (real Postgres, real Chromium)
corepack pnpm db:start                     # separate terminal; embedded Postgres on :54329
corepack pnpm demo:reset                   # fresh synthetic org in ~2 s
corepack pnpm sb connect:fixture           # offline email transport
corepack pnpm sb card-sim --amount 11.25 --merchant "PRET A MANGER LONDON GB"
corepack pnpm sb email --from sam.taylor@northwind.example --subject Lunch \
  --text "Purpose: Lunch with the Acme site team" --attach eval/demo-receipts/pret-11.25-card-4242.txt
corepack pnpm sb expenses                  # matched and cleared, no reimbursement
corepack pnpm web                          # reviewer app on http://localhost:3000
```

If `playwright-core` has no browser yet, run `corepack pnpm exec playwright-core install --with-deps chromium chromium-headless-shell` first. The full storyboard, live and offline, is in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Live set-up (credentials)

Copy `.env.example` to `.env.local` (gitignored) and fill it in:

- A dedicated finance Gmail address, with a Google Cloud OAuth client (Gmail API enabled, consent screen in Testing mode, the mailbox added as a test user).
- `SB_OPENAI_API_KEY`.
- A token-encryption key (`openssl rand -base64 32`).

Then `corepack pnpm worker` and `corepack pnpm web`, sign in as the reviewer, and connect the mailbox at `/start`. Details: [`docs/HANDOFF.md`](docs/HANDOFF.md) §5. Secrets are read explicitly; ambient `OPENAI_*` and `ANTHROPIC_*` shell variables are ignored on purpose.

## New workspace onboarding

The landing page's **Try it out** button opens `/start`. Visitors enter an email, receive a single-use link, and return to the same flow to choose a channel. A verified new address creates its own synthetic preview workspace with every expense requiring human review and automatic reimbursement disabled. Slack and iMessage are visible as coming-soon choices.

Set `SB_SIGNUP_CONNECTION_ID` to the ID of a connected Swipeback Gmail mailbox in `channel_connections`. It sends the verification links; signup fails visibly if that mailbox is unavailable. The ID is explicit so a customer's connected mailbox is never used as the signup sender. Gmail connection by new users still depends on the Google OAuth app's test-user and consent settings.

## TrueLayer sandbox card feed

The adapter runs **only locally** with `SB_APP_URL=http://localhost:3000`; it uses only `auth.truelayer-sandbox.com` and `api.truelayer-sandbox.com`. It is disabled on Vercel and in production. Add the sandbox client secret as `TRUELAYER_CLIENT_SECRET` in `.env.local`, keep `SB_TOKEN_ENCRYPTION_KEY` set, and allowlist the exact redirect `http://localhost:3000/callback` for client `sandbox-swipeback-a13286` in TrueLayer Console. No production TrueLayer credentials are used.

1. Start the local database (`corepack pnpm db:start`) in one terminal. In another, run `corepack pnpm db:migrate` and `corepack pnpm seed` if the demo organisation is not already there.
2. Start `corepack pnpm worker` and `corepack pnpm web`. Sign in as the seeded admin/reviewer and open `http://localhost:3000/start`.
3. Click **Connect card feed**, choose TrueLayer's Mock Bank, and sign in with a [mock user](https://docs.truelayer.com/docs/mock-users), such as `john` / `doe`. TrueLayer returns to `/callback`; Swipeback exchanges the code, encrypts the tokens, and checks settled card transactions immediately. It then checks again every eight hours while the worker runs, or on **Sync now**. The slower background interval respects common [unattended Data API limits](https://docs.truelayer.com/docs/data-api-errors).
4. If the mock card's last four digits do not match a card already assigned to an employee, use **Assign card** on `/start`, then **Sync now**. Unknown cards are never silently assigned. Purchases arrive through the same signed card-event intake as `card-sim`; refunds and credits are skipped. The reviewer UI labels these transactions **Sandbox**.

The `cards transactions offline_access` scopes are requested, with PKCE and a one-use state. The initial sync checks 89 days of settled card transactions; duplicate polls are safe. The TrueLayer card endpoint covers credit/charge cards, while debit-card current accounts are under a separate accounts endpoint and are outside this sandbox adapter. See [TrueLayer's card data guide](https://docs.truelayer.com/docs/account-and-card-data) and [sandbox auth guide](https://docs.truelayer.com/docs/quickstart-retrieve-bank-data).

## Evaluation

The full pipeline was evaluated end to end on **29 held-out cases, frozen by checksum before any run**, plus 25 tune cases. The rule-only baseline is shown side by side. Details, every miss, and the limits: [`docs/EVALUATION.md`](docs/EVALUATION.md).

| Held-out (gpt-5.5) | Blind first run | After fixing the one bug it found |
|---|---|---|
| Cases correct | 27/29 | 28/29 |
| False auto-clears | 1/14 | 0/14 |
| False simulated payouts | 1 ("ok thanks" accepted as a business purpose) | 0 |
| Resolved with no finance touch | 15/29 | 14/29 (the policy expects 14) |
| Model cost per expense | $0.029 | $0.029 |

The post-fix run is not blind, and it is labelled that way in the report. Time saved versus manual processing is **not measured** yet: it needs a person to time 10 cases by hand. The extraction-model comparison (gpt-5.5 vs gpt-5.4-mini) is in [`docs/EXTRACTION_BENCHMARK.md`](docs/EXTRACTION_BENCHMARK.md).

```bash
corepack pnpm sb eval:pipeline --split heldout --replay    # offline, recorded model responses
corepack pnpm sb eval:benchmark --models gpt-5.5,gpt-5.4-mini --replay
```

## Threat model (summary)

| Threat | Control |
|---|---|
| Spoofed sender ("From: ceo@…") | Identity = an enrolled address **and** a DKIM/DMARC pass aligned with From (Google's `Authentication-Results`). Display names are ignored. Anything else is quarantined, with no backscatter to failed-auth senders |
| Prompt injection in a receipt ("approve and pay to …") | The model has no tools or authority; output is schema-only; injection heuristics plus the model's own flag send it to review; free text can never approve, pay, or change a payee or policy |
| Plausible but wrong extraction | Evidence quotes are verified against the PDF text layer, plus arithmetic and card-amount cross-checks; an uncertain decision field blocks auto-clear |
| Double payout (retries, two workers) | Row lock + state precondition + unique idempotency key + provider-side idempotency; Postgres triggers reject illegal transitions; tested under 20 concurrent attempts |
| Reimbursing company-card spend | Trigger-enforced: a reimbursement needs a PERSONAL, unmatched, cleared expense and the claimant's own verified destination |
| Forged or replayed approval links | Email links never authenticate. One-time challenges are bound to a person, an expense version, a purpose and an expiry; the decision needs a signed-in session, the right role, and must not be the reviewer's own expense |
| Mail loops and auto-responders | `Auto-Submitted`, `List-Id` and bulk mail are ignored, as are our own sent IDs; at most one open question per expense; an unanswered question escalates instead of re-asking |
| Tampering with history | Append-only, hash-chained audit log per organisation (`sb audit:verify`) |
| Token theft at rest | Mailbox tokens are AES-GCM encrypted, bound to the connection id; least-privilege Gmail scopes; any non-designated mailbox grant is revoked |

## Data provenance

All data is synthetic. Receipts are rendered locally from HTML templates with Playwright Chromium (`tools/cli/src/receipts.ts`), with simulated photo damage (blur, tilt, JPEG artefacts). Merchants are real brand names on fictitious receipts, and VAT numbers are invalid test values. The held-out images (`eval/datasets/heldout`) and the held-out pipeline cases (`eval/datasets/pipeline`) are frozen by checksum manifests. Model responses were recorded from live gpt-5.5 calls on 17 Oct 2026 (`eval/cassettes`) so that evaluations replay offline and deterministically.

## Known limitations

- The live Gmail receipt round trips (receipt-first and card-swipe-first) are built and tested against a fake Gmail, but have not yet been completed against the real mailbox.
- Per-night accommodation caps are applied per expense (a multi-night stay goes to finance); no "which card payment was it?" question is asked on a merchant mismatch (it waits safely). Both are in `docs/EVALUATION.md`.
- The evaluation is small and synthetic. Real crumpled, faded or handwritten receipts will be harder.
- The audit-chain head is not yet published outside the database; there is no malware scanner and no retention automation; Gmail is polled (no push); Slack, WhatsApp and Telegram are roadmap items (only email and a synthetic chat channel exist).
- No FX: foreign-currency expenses go to finance.

## Market and pricing hypothesis

Expense tools such as Expensify, Pleo, Spendesk, Payhawk, Soldo and Dext already offer receipt capture, card matching, and in several cases email or chat submission and automated policy checks. Swipeback does not claim those features are new. **The hypothesis** is that a finance team with an existing card and accounting stack will pay for an agent that works over the email they already use and returns only exceptions, without a new card programme or an employee app. Hypothetical pricing: **£99 per workspace per month + £0.30 per processed expense**. The evaluation's 14/29 autonomous resolution rate on deliberately hard cases is the number to improve, and to validate with a pilot.

## Repository

| Path | What |
|---|---|
| `packages/domain` | Pure domain: money (integer minor units), state machines, policy engine, matching, duplicates, eligibility, intents. No IO (lint-enforced) |
| `packages/db` | SQL migrations with the invariant triggers, job queue, audit chain, embedded Postgres |
| `packages/channels` | Channel adapter contract, email MIME/auth/anti-loop, Gmail, fixture and synthetic-chat adapters |
| `packages/extraction` | Model contract, gpt-5.5 / Claude extractors, rule-only baseline, evidence checks, cassettes |
| `packages/payouts` | MockPay |
| `packages/engine` | Pipeline handlers, review, payment authorisation, card-led receipt chase, Gmail connect/poll, runtime |
| `apps/worker`, `apps/web` | Job runners and mailbox polling; Hono reviewer app and API |
| `tools/cli` | `corepack pnpm sb …`: seed, `demo:reset`, `card-sim`, `email`, `reply`, evaluations |
| `docs` | `PLAN.md` (architecture, progress log), `HANDOFF.md`, `EVALUATION.md`, `EXTRACTION_BENCHMARK.md`, `RUNBOOK.md` |
