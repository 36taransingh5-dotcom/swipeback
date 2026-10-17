# Swipeback — Architecture & Execution Plan

Source: *Swipeback Master PRD v1.1 (Multichannel)*, 17 Oct 2026. Status: **approved 17 Oct; see §8 for progress.**
Clock at time of writing: **Sat 17 Oct 06:11 BST → cutline Sun 18 Oct 13:00 BST ≈ 31 h**, not 41 h. The plan is sized for that.

Product promise we are engineering against: **"Finance only deals with exceptions."** Proof standard: a connected mailbox
that actually resolves expenses, with measured limitations. Not a dashboard.

---

## 1. Analysis

### 1.1 Critical end-to-end workflows

| # | Workflow | Trigger → terminal state | Must never happen |
|---|---|---|---|
| A | Company-card expense | card event + receipt email (either order) → match → policy → `AUTO_CLEARED` → `EXPORTED` | Reimbursement created for card spend (AC-04) |
| B | Personal purchase | receipt email from enrolled employee → payment-type resolved → policy → expense cleared → **separate** payout authorisation → `SIMULATED_PAID` | Payout without deterministic authorisation; double payout (AC-05/06/09) |
| C | Exception loop | gap detected → one targeted in-thread question → reply resumes same case under same policy version → clear, or escalate to reviewer → authenticated decision | Spam loops; unauthenticated approve link; silent clear of ambiguity (AC-03/07/08) |
| D | Channel-neutral intake | any adapter → `InboundMessage v1` → same engine | Channel-specific business logic; chat identity treated as payee identity |
| E | Failure paths | LLM outage, malformed file, duplicate webhook, provider timeout, token expiry | Any failure that ends in auto-clear or auto-pay (AC-10) |

The P0 spine the user asked to prioritise is **A + B + C over real email**: connected inbox → extraction → matching → policy → autonomous clear/exception → simulated payout.

### 1.2 Dependencies

**External (user-gated — these are the critical path, not the code):**

| Dependency | Needed by | Lead time | Fallback |
|---|---|---|---|
| Dedicated Gmail mailbox + GCP OAuth client (Gmail API, consent screen in *Testing* mode, mailbox added as test user) | M3 | 20–30 min of your time | IMAP adapter with Gmail app password (needs 2FA); `.eml` fixture replay (labelled as replay, never presented as live) |
| Anthropic API key | M4 | 5 min | Deterministic rule-only extractor (also used as the eval baseline) — demo still runs, accuracy drops |
| A second email account to act as "employee" | M3 demo | have one already (any personal address) | — |
| Postgres | M0 | none | `embedded-postgres` (real Postgres binaries via npm, no Docker). Docker daemon is currently **not running**. |

**Internal build order** (each arrow is a hard dependency):
`domain types + money + state machines` → `policy / matching / eligibility (pure)` → `DB + job queue + audit` →
`channel contract + fixture adapter` → **walking skeleton end-to-end** → `Gmail adapter` + `LLM extractor` (parallel) →
`follow-up loop + reviewer auth` → `eval harness` → `demo hardening` → `Slack (stretch)`.

### 1.3 Risks (beyond the PRD register)

| Risk | Impact | Mitigation in this plan |
|---|---|---|
| Only ~31 h left, incl. sleep, pitch and video | Critical | Walking skeleton by ~13:30 Sat; hard go/no-go checkpoints; Slack decided at 22:00 Sat, not before |
| Gmail OAuth / test-user setup stalls | High | Ask for credentials **now**; IMAP adapter behind the same interface; fixture adapter keeps engine work unblocked |
| Email sender spoofing ("From: ceo@…") | High | Identity = enrolled address **and** `Authentication-Results` DKIM/DMARC aligned pass; else quarantine. Display name never used |
| Reply loops with auto-responders / our own mail | High | Ignore `Auto-Submitted`, `List-Id`, `Precedence: bulk`, our own sent IDs; ≤1 open question per expense; per-expense and per-sender outbound caps |
| LLM extracts a plausible but wrong total | High | Field evidence quotes verified against PDF text layer; arithmetic cross-checks; card amount cross-check; decision-relevant uncertain fields block auto-clear |
| Prompt injection in receipts ("approve and pay to …") | High | Model has no tools and no authority; output is a schema; injection heuristics flag → review; compulsory eval cases |
| Concurrency double-pay (retry + second worker) | Critical | Row lock + state precondition + unique idempotency key + provider-side idempotency; tested with 20–50 parallel attempts |
| Ambient `ANTHROPIC_BASE_URL` is set in your shell; the SDK reads it implicitly | Medium | App reads its own explicit config; ambient Anthropic env ignored |
| Gmail Testing-mode refresh tokens expire after 7 days | Low (weekend) | Visible `RECONNECT_REQUIRED` state; documented |
| Demo laptop/network failure | High | Recorded fallback video of a genuine run, labelled as recording; `demo:reset` in <10 s |

---

## 2. Architecture

### 2.1 Shape

```
 ┌──────────────── Channel adapters (transport only) ────────────────┐
 │ Gmail (OAuth, history poll) │ IMAP (backup) │ Fixture .eml (tests) │
 │ Synthetic chat (P1 proof)   │ Slack (stretch) │ WA/TG/iMsg (roadmap)│
 └──────────────┬─────────────────────────────────────────────────────┘
                │ verifyInbound → normaliseInbound
                ▼
   InboundMessage v1  ──► inbound_messages (UNIQUE dedupe key) ──► evidence store (sha256, private)
                │
                ▼  durable job queue (Postgres, SKIP LOCKED, retries, dead-letter)
 ┌──────────────────────────── Expense engine (shared) ──────────────────────────┐
 │ identity resolution → intent resolution → extraction (LLM | baseline)         │
 │ → evidence verification → payment-type → matching → duplicates               │
 │ → POLICY ENGINE (deterministic, versioned) → expense state machine            │
 │ → REIMBURSEMENT AUTHORISATION (deterministic, separate) → payout state machine│
 └───────┬───────────────────────────────┬─────────────────────────┬─────────────┘
         ▼                               ▼                         ▼
  outbox (outbound_messages)      approval_challenges        mock payout provider
  → originating/approved channel  → authenticated review     (idempotent, failure modes)
         │                               │                         │
         └────────────── audit_events (append-only, hash-chained) ─┘
```

Two processes, one codebase:
- **`apps/worker`** — long-running Node: job runner, mailbox poller, outbox delivery, payout jobs, timers (match deadlines, reminders). This is where the product lives.
- **`apps/web`** — Next.js: OAuth connect/consent page, minimal authenticated reviewer screen, API endpoints from PRD §7.4, webhooks (card simulator, Slack).

### 2.2 Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript strict, pnpm workspace (via `corepack pnpm`) | Shared domain types across web/worker/adapters |
| DB | PostgreSQL. Local/tests: `embedded-postgres`; hosted: Supabase/managed PG | Real row locks, `SKIP LOCKED`, partial unique indexes, triggers — needed to *prove* exactly-once |
| ORM / migrations | Drizzle + plain SQL migrations for triggers/constraints | Typed queries; invariants live in SQL too |
| Jobs | Own `jobs` table (`FOR UPDATE SKIP LOCKED`, attempts, backoff, dead-letter) | ~150 lines, fully testable, replayable; no extra infra |
| Email | Gmail API: `gmail.readonly` + `gmail.send`, `history.list` polling (5 s) | Least privilege, native threading (`threadId` + `In-Reply-To`/`References`), works locally without a public URL. Push (`/api/inbox/webhook` via Pub/Sub) is optional |
| Extraction | Claude (`claude-sonnet-5-5`) with PDF/image input and schema-constrained output, validated with zod | Messy receipts; native PDF/vision; exact model and pricing confirmed via the Claude API reference at M4 |
| Policy / matching / eligibility | Pure TypeScript, no IO | Testable safety boundary (PRD §5) |
| Evidence store | Content-addressed local dir (`sha256`) behind `EvidenceStore` port; Supabase Storage when hosted | Private; served only through an authenticated route |
| Payouts | `MockPayoutProvider` behind `PayoutProvider` port, with configurable timeout/5xx/latency | Honest boundary; proves idempotent retry semantics |
| Tests | Vitest, fast-check (property tests), msw (HTTP mocks), Playwright (reviewer UI) | Objective acceptance gates |

### 2.3 Repository layout

```
swipeback/
  apps/web            Next.js: connect inbox, review screen, API routes, webhooks
  apps/worker         job runner, pollers, outbox, payouts, timers
  packages/domain     PURE: money, ids, state machines, policy, matching, duplicates,
                      payment-type, reimbursement eligibility, intents   (no IO, ~100% unit-tested)
  packages/engine     application commands (processInbound, evaluateExpense, applyReview,
                      authoriseReimbursement, executePayout) — transactions + ports
  packages/db         schema, migrations, repositories, job queue, audit chain
  packages/channels   ChannelAdapter contract + contract test suite + adapters
  packages/extraction LLM extractor, baseline extractor, evidence verifier
  packages/payouts    PayoutProvider port + mock provider
  tools/cli           seed, card-sim, csv import/export, replay, demo:reset, eval
  eval/               generator, tune/ and heldout/ (manifest + checksums), reports/
  docs/               PLAN.md, THREAT_MODEL.md, RUNBOOK.md (demo), DATASET.md
```

Boundary rule (lint-enforced): `domain` imports nothing; `channels` may not import `engine` commands that approve or pay — they only emit events or call role-checked commands through `engine`.

### 2.4 Data model (PRD §7.2 + §17.5, with the constraints that carry the invariants)

Core: `organisations`, `members` (role: employee | reviewer | payment_approver | admin; `payout_enrolment_status`), `payout_destinations` (pre-enrolled, verified flag; immutable — change = new row via separate workflow, roadmap), `policy_versions` (immutable JSON + content hash + source policy text), `cards` (last4 → member), `transactions`, `receipts`, `extractions` (per attempt; fields with value/confidence/evidence), `expenses` (with `version` for optimistic concurrency), `policy_decisions`, `reviews`, `reimbursements`, `payout_attempts`, `exports`.
Messaging: `channel_connections` (provider, scopes, encrypted token ref, status, cursor), `channel_identities` (verified member↔provider address), `inbound_messages` (dedupe key, thread, intent, processing_state incl. `QUARANTINED`), `outbound_messages` (template, idempotency key, provider id, delivery state), `approval_challenges` (expiry, role, action scope, nonce hash, consumed_at), `conversation_links` (thread/correlation token → expense).
Ops: `jobs`, `audit_events` (actor, action, before/after, correlation_id, prev_hash, hash), `llm_calls` (tokens, latency, cost, outcome), `eval_runs`.

**Invariants enforced in code *and* in Postgres:**

| ID | Invariant | Enforcement |
|---|---|---|
| I1 | No reimbursement unless expense `payment_type = PERSONAL` and `matched_transaction_id IS NULL` | engine guard + trigger on `reimbursements` insert; a later card match on a paid expense raises an incident to review |
| I2 | ≤1 live reimbursement per expense | partial unique index `WHERE state <> 'CANCELED'` |
| I3 | Only legal state transitions (no `RECEIVED → PAID`, no skipping `AUTHORIZED`) | transition table in `domain`; DB trigger checks `(old,new)` against the same table |
| I4 | One provider payout per reimbursement | unique `idempotency_key`; row lock `FOR UPDATE`; provider dedupes by key; timeout ⇒ query-by-key before retry |
| I5 | Identical inbound processed once | unique `(tenant, channel, provider_event_id)`; attachment `sha256` dedupe per tenant |
| I6 | Audit is append-only and tamper-evident | trigger rejects UPDATE/DELETE; per-tenant hash chain verified by test |
| I7 | Decisions are reproducible | `policy_decisions.policy_version_id` + inputs hash; policy versions immutable |
| I8 | Limits are cumulative and race-free | per-member/period/budget ledger rows locked in the same transaction as authorisation |
| I9 | Money is integer minor units + ISO currency | `Money` type; no floats in `domain` |

### 2.5 State machines

**Expense:** `RECEIVED → EXTRACTING → {NEEDS_MATCH | NEEDS_INFO | POLICY_CHECK} → {AUTO_CLEARED | REVIEW_REQUIRED} → {APPROVED | REJECTED} → EXPORTED`
- Policy outcomes: `CLEAR → AUTO_CLEARED`; `REQUEST_INFO → NEEDS_INFO`; `HUMAN_REVIEW → REVIEW_REQUIRED`; `REJECT_FOR_CORRECTION → REJECTED` (correction = new receipt linked to the same expense, re-evaluated; appeal path → review).
- `NEEDS_*` re-enter `POLICY_CHECK` only via new evidence (reply, card event, reviewer correction), always under the **same pinned policy version**.
- Every failure edge (LLM error after retries, malformed file, conflict, injection flag, sender mismatch) goes to `REVIEW_REQUIRED`. There is no failure edge into `AUTO_CLEARED`.

**Reimbursement:** `DRAFT → ELIGIBILITY_CHECK → AUTHORIZED → PAYOUT_QUEUED → SIMULATED_PAID`, or `FAILED | CANCELED`.
- Created only from a cleared/approved `PERSONAL` expense. Clearing an expense ≠ authorising a payment (PRD §5 (a)/(b)): `AUTHORIZED` requires a separate `reimbursement_authorisations` row — either `auto` (all deterministic checks under the org's auto-pay limits) or `human` (role `payment_approver`, not the claimant).
- Eligibility checks: per-expense cap, daily/weekly member cap, category cap, budget remaining, verified payee destination, verified sender identity, no open duplicate, no uncertain decision-relevant field, extraction not flagged.

### 2.6 Decision logic (all deterministic)

- **Payment type:** receipt card last4 ∈ company cards, or a unique card match ⇒ `CORPORATE`; receipt shows a non-company card / cash ⇒ `PERSONAL`; otherwise ask one `CONFIRM_PAYMENT_SOURCE` question (choice, not free text).
- **Matching:** candidates = unmatched transactions for the member's cards within [−1 d, +5 d]; amount must match exactly in minor units (or on the card feed's original-currency amount); merchant similarity on normalised descriptors + alias table. Exactly one qualifying candidate ⇒ match. Zero ⇒ wait in `NEEDS_MATCH` until a configurable deadline, then ask. More than one ⇒ ask the employee to pick; **never auto-pick**. A card event arriving later triggers re-match (out-of-order support).
- **Duplicates:** same file hash ⇒ duplicate; same (normalised merchant, date, total, receipt no.) ⇒ *possible* duplicate ⇒ review; transaction already matched elsewhere ⇒ conflict ⇒ review. Labelled "evidence inconsistency", never "fraud".
- **Policy:** versioned JSON rules per organisation, each rule citing a clause ID and quote from the org's written policy. Thresholds come from the seeded demo org, not universal defaults. P1: LLM drafts structured rules from written policy text → admin confirms → new version (the model never activates a policy).

### 2.7 AI boundary

| AI does | Code does |
|---|---|
| Extract fields with confidence + evidence spans; transcribe images | Validate schema; verify quotes exist in source text; arithmetic checks; mark uncertain fields |
| Suggest category and purpose clues | Decide eligibility, authorisation, matching, duplicates |
| Word the clarifying question / exception explanation from a fixed template + cited policy clause | Choose *whether* and *what* to ask; rate-limit; dedupe |

Email/receipt text is passed as delimited untrusted data; the model has no tools; temperature 0; timeout + 2 retries with backoff; then `REVIEW_REQUIRED`. Every call is logged with tokens/latency/cost for the cost-per-expense metric. No training on customer data; synthetic data only.

### 2.8 Security model (hackathon-appropriate, honest)

- Inbox: explicit consent page listing exact scopes, consent recorded in audit; tokens AES-GCM encrypted at rest (key from env); only mail addressed to the designated address is processed; tenant-level disconnect.
- Reviewer auth: email magic link (one-time, 15 min, hashed) → httpOnly session. Approval links in email point at `/a/:challengeId`; they **do not** authenticate — a reviewer session plus a one-time nonce plus the expense `version` are all required. Claimant can never approve their own expense.
- Webhooks: HMAC + timestamp window + replay protection (card simulator; Slack v0 signatures).
- Notifications carry minimum data (ref, merchant, amount, status); receipts and payee details only behind auth.
- All demo data synthetic and visibly labelled `SYNTHETIC DEMO`; payouts labelled `SIMULATED — no funds moved`.

---

## 3. Shared messaging architecture

Goal: adding Slack, WhatsApp, Telegram or iMessage is **one adapter + one route + passing the contract test suite** — zero changes to `domain` or `engine`.

### 3.1 Adapter contract (PRD §17.5)

```ts
interface ChannelAdapter {
  readonly channel: 'email' | 'slack' | 'whatsapp' | 'telegram' | 'imessage' | 'synthetic';
  readonly capabilities: {
    attachments: boolean; threading: boolean; interactiveActions: boolean;
    deliveryReceipts: boolean; businessInitiatedMessages: 'free' | 'template_only' | 'none';
  };
  verifyInbound(req: RawInbound): Promise<VerifiedInbound>;            // signature / OAuth / DKIM; throws on failure
  normaliseInbound(v: VerifiedInbound): Promise<InboundMessageV1[]>;   // stores attachments via EvidenceStore port
  sendMessage(tenant: TenantId, to: ChannelAddress, msg: RenderedMessage, ctx: OutboundContext): Promise<SendResult>;
  sendApprovalRequest(req: ApprovalRequest): Promise<SendResult>;      // renders challenge; never decides
  getDeliveryState?(providerMessageId: string): Promise<DeliveryState>;
}
```

Adapters get only ports (`EvidenceStore`, `SecretStore`, `Clock`). They cannot read or write expenses, approvals or payouts.

### 3.2 `InboundMessage v1` (PRD §17.2)

```ts
{
  schema: 'swipeback.inbound.v1',
  tenantId, channel, connectionId, providerEventId, dedupeKey,      // dedupeKey = sha256(channel|connection|providerEventId)
  receivedAt, providerTimestamp,
  sender: { channelAddress, displayName /* untrusted, never identity */,
            authentication: 'dkim_aligned' | 'platform_signed' | 'none' },
  conversation: { threadId, messageId, inReplyTo?, references: [], correlationToken? },
  text: { sanitised, truncated },                                     // untrusted data
  attachments: [{ sha256, mime, sizeBytes, storageKey, filename /* untrusted */, scan }],
  action?: { challengeId, nonce, verb },                              // signed interactive channels only
  consent: { source: 'connected_mailbox' | 'bot_dm', scope },
  correlationId, rawRef? /* retention-limited */
}
```

### 3.3 Engine-side flow (identical for every channel)

1. **Identity:** `channel_identities` lookup on `(channel, channelAddress)` + required authentication strength. Unknown/weak ⇒ `QUARANTINED`, attachment held, one rate-limited enrolment reply (only if sender authentication passed, to avoid backscatter).
2. **Intent** (deterministic precedence): signed action + valid challenge ⇒ `REVIEW_APPROVE|DECLINE|REQUEST_INFO`; correlated to an open question ⇒ `PROVIDE_BUSINESS_PURPOSE | CONFIRM_PAYMENT_SOURCE`; receipt-like attachment/body ⇒ `SUBMIT_RECEIPT`; status/help keywords ⇒ `EXPENSE_STATUS | HELP`. Free text can never authorise payment, change a payee or alter policy — there is no intent that does those things.
3. **Command:** the intent maps to the same role-checked `engine` command regardless of channel.
4. **Outbound:** the notification planner picks the originating channel if its capabilities and messaging window allow, else falls back to email. Every send goes through the `outbound_messages` outbox with idempotency key `(expense, template, expense.version)`. "Sent" is never treated as "received" or "approved".

### 3.4 Channel notes (constraints to design for, verified per provider before building)

| Channel | Inbound auth | Identity enrolment | Outbound constraint | Plan |
|---|---|---|---|---|
| Email (Gmail) | OAuth mailbox + DKIM/DMARC on sender | enrolled member address | free, threaded | **P0, live** |
| Synthetic chat | HMAC-signed CLI/HTTP | seeded identity | free | **P1, built** — proves contract with identical outcomes |
| Slack | v0 request signature, 5-min window | one-time link code DM'd to user, confirmed in Swipeback | free in DMs; interactive buttons → challenge | **Stretch** (go/no-go Sat 22:00) |
| WhatsApp Business | `X-Hub-Signature-256` | phone + one-time code | template-only outside 24 h window; opt-in required | Roadmap |
| Telegram | webhook `secret_token` | deep-link one-time code (no phone identity) | free in bot chats | Roadmap (quick prototype only if all P0 done) |
| Apple Messages for Business | via approved messaging service provider | partner-dependent | customer-initiated; partner/Apple approval | Roadmap — no personal-iMessage automation claims |

---

## 4. Hackathon scope: build vs roadmap

| Build this weekend (P0) | P1 if on schedule | Roadmap (say so on stage) |
|---|---|---|
| Gmail connection with consent + live inbound PDF/image receipts | CSV card import & accounting CSV export polish | Slack production app (stretch demo only) |
| LLM extraction with evidence + uncertainty, baseline extractor | LLM-drafted policy rules (admin-confirmed) | WhatsApp, Telegram, Apple Messages adapters |
| Card-event simulator (signed endpoint + CLI) | Synthetic second channel through same engine | Live card feeds, accounting sync (Xero/QBO) |
| Matching, duplicates, payment-type, deterministic policy | IMAP backup adapter | Real payout provider, payee change workflow |
| One-question follow-up in thread; reply resumes case | Category/VAT extraction improvements | Multi-inbox providers (Outlook/M365) |
| Reviewer magic-link auth + minimal review screen + challenges | | Malware scanning, retention automation, SSO |
| Reimbursement authorisation + idempotent mock payout | | Own-brand cards (concept render only) |
| Audit trail, accounting CSV export of cleared expenses | | |
| 50-case synthetic eval (≥20 held out) + baseline + report | | |
| README, threat model, runbook, fallback video | | |

---

## 5. Milestones, schedule and acceptance tests

Times are targets; checkpoints are hard. Every milestone ends with `corepack pnpm verify` (typecheck + lint + all tests so far) green, plus the milestone's own gate. Nothing is marked done on a failing or skipped test.

### M0 — Foundations · Sat 06:30–08:00
Repo + workspace, TS strict, lint boundaries, Vitest, embedded Postgres, migrations for the full schema, job queue, audit chain, CLI skeleton, synthetic org seed ("Northwind Field Services Ltd — SYNTHETIC").
**Acceptance:**
- `pnpm db:reset && pnpm db:migrate` succeeds on a fresh embedded Postgres; down/up idempotent.
- Job queue: 1,000 jobs across 4 concurrent runners → each executed exactly once; a failing job retries with backoff then dead-letters.
- `UPDATE`/`DELETE` on `audit_events` rejected by Postgres; hash-chain verifier detects a tampered row.
- Lint fails if `packages/domain` imports any IO module.

### M1 — Domain core (pure) · Sat 08:00–11:00
Money, state machines, policy engine + versions, matching, duplicates, payment type, reimbursement eligibility, intents.
**Acceptance:**
- Exhaustive transition test: every `(state, event)` pair either yields the tabled next state or is rejected; `RECEIVED → SIMULATED_PAID` and any skip of `AUTHORIZED` impossible.
- Property test (fast-check, 10k cases): eligibility ⇒ PERSONAL ∧ unmatched ∧ ≤ every cap ∧ verified payee ∧ verified sender ∧ no duplicate ∧ no uncertain decision field. **AC-04, AC-06 (unit level).**
- Matching table tests: two equal candidates ⇒ ambiguous, never matched; amount off by 1p ⇒ no match. **AC-03 (unit).**
- Same inputs ⇒ byte-identical decision (reason codes, clause IDs, policy version).

### M2 — Walking skeleton end-to-end · Sat 11:00–13:30  ★ checkpoint
Channel contract + contract test suite, fixture email adapter (`.eml`), synthetic chat adapter, inbound pipeline, deterministic stub extractor, outbox to a fixture sink, reimbursement + mock payout, export job, PRD §7.4 endpoints.
**Acceptance (`pnpm test:pipeline`, real Postgres):**
- A: card event + receipt ⇒ `AUTO_CLEARED → EXPORTED`, 0 reimbursements. Also with receipt arriving first. **AC-04**
- B: personal, under limits ⇒ exactly one `SIMULATED_PAID` with simulated ref, only after an authorisation row exists. **AC-05**
- Over-cap / duplicate / unknown-sender / unverified-payee cases ⇒ 0 payout attempts on every path. **AC-06**
- Same `.eml` ×5 and same card webhook ×5 ⇒ 1 expense, 1 payout. **AC-09**
- 20 parallel `executePayout` calls on one reimbursement ⇒ 1 provider call; provider timeout ⇒ status query before retry ⇒ still exactly one paid.
- Contract suite passes for fixture-email **and** synthetic-chat adapters; the same receipt via both yields identical decision outcome and reason codes. **§17.6 P1**
- **Checkpoint:** if M2 isn't green by 14:30, cut P1 items and Slack immediately.

### M3 — Live Gmail connector · Sat 13:30–16:30 *(needs your OAuth client by ~13:00)*
Consent page, OAuth flow, encrypted tokens, history-cursor polling, designated-address filter, DKIM/DMARC check, attachments to evidence store, threaded replies via `gmail.send`, anti-loop rules, `RECONNECT_REQUIRED` state.
**Acceptance:**
- Unit (msw-mocked Gmail API): cursor advances and survives restart; expired history ID ⇒ bounded resync, no duplicates; refresh failure ⇒ `RECONNECT_REQUIRED`, no crash, no token in logs; mail not to the designated address ignored; auto-replies and own messages ignored; DKIM fail ⇒ quarantine.
- Live `pnpm verify:gmail`: connection `ACTIVE` with exactly the declared scopes; after you send a new receipt email from the employee address, within 60 s an `inbound_messages` row with Gmail message ID + attachment sha256 and an expense exist; the reply is in the **same Gmail thread** (sent `threadId` == inbound `threadId`). **AC-01, §17.6 P0 #1**

### M4 — AI extraction · Sat 16:30–19:00 *(needs API key)*
Claude extractor, schema validation, evidence verification, arithmetic checks, uncertainty marking, retries/outage handling, injection heuristics, cost logging, baseline extractor.
**Acceptance:**
- CI uses recorded responses (`EXTRACTOR=replay`); `pnpm smoke:extract` runs live on 5 tune receipts and prints fields, confidence and evidence.
- Typed vendor/amount/currency/date with evidence; unverifiable quote ⇒ field `uncertain` and shown as such. **AC-02**
- Schema-invalid output, timeout, 5xx, malformed PDF, arithmetic conflict ⇒ `REVIEW_REQUIRED`, never auto-clear or pay. **AC-10**
- Injection receipts ⇒ decision outcome identical to the clean twin except an added review flag; no field derived from injected instructions.

### M5 — Exception loop + reviewer · Sat 19:00–22:00  ★ checkpoint (Slack go/no-go)
Question selection + templated wording, reminders with caps, reply correlation (thread + plus-address token), magic-link auth, approval challenges, minimal review screen (case list, source receipt preview, extracted fields with uncertainty, policy clause, decision reason, audit trail, actions).
**Acceptance:**
- Missing purpose ⇒ exactly one email with one question; in-thread reply ⇒ same expense resumes under the same `policy_version_id` and clears; further replies don't create expenses or extra questions. **AC-07**
- Playwright: unauthenticated `/a/:id` ⇒ login; reviewer approves/overrides with mandatory reason ⇒ state changes, prior audit events untouched, chain verifies. **AC-08**
- Reused nonce ⇒ rejected; expired challenge ⇒ rejected; stale `version` ⇒ 409; employee role ⇒ 403; claimant approving own expense ⇒ 403.
- Over-auto-pay-limit approval creates no payout until a separate `payment_approver` authorisation.
- **Go/no-go:** Slack is attempted Sunday morning only if M0–M5 are green now.

### — Sleep / buffer · Sat 22:30 – Sun 06:30 (your call) —

### M6 — Evaluation · Sun 06:30–09:00
Generator renders 50 synthetic receipts (HTML → PDF via local Playwright Chromium, plus photo-like PNG variants) with `.eml` wrappers, card events and labels. 30 tune / 20 held-out, held-out generated from different templates and merchants, frozen by checksum manifest **before** tuning. Every run is logged.
**Acceptance (`pnpm eval --split heldout`):** report (JSON + Markdown, also `GET /api/evaluations/report`) with numerators *and* denominators for field accuracy, match precision, false auto-clear rate, false escalation rate, autonomous resolution rate, follow-ups/expense, cost/expense, latency; rule-only baseline side by side; manual baseline from timed hand-processing of 10 cases; every failure listed. Target: 0 false simulated payouts — **reported as measured, whatever it is.** **AC-12**

### M7 — Demo hardening & docs · Sun 09:00–11:30
`pnpm demo:reset`, storyboard runbook, card-sim CLI polish, CSV import/export, README (install, credentials, dataset provenance, threat model, limitations, test commands, competitor references from PRD appendix), synthetic labels everywhere, fallback video of a genuine run.
**Acceptance:** `demo:reset` < 10 s; two consecutive full storyboard rehearsals with a fresh unseen receipt; template test confirms `SYNTHETIC`/`SIMULATED` labels on every email and screen (**AC-11**); `pnpm verify` green on a clean clone.

### M8 — Stretch: Slack · Sun 11:30–12:45, only if go
Slack adapter on the same contract: DM receipt submission, identity linking, reviewer buttons via challenges.
**Acceptance:** contract suite passes for Slack; tampered/old signature rejected; unlinked user ⇒ enrolment message, no expense; button press from non-reviewer ⇒ rejected. If not done, it stays roadmap — no half-working Slack on stage.

**Freeze at 12:45.** Submission (video, ~150-word summary, GitHub link, pricing hypothesis, pilot route) by 13:00.

### Acceptance-criteria traceability

| PRD | Milestone | PRD | Milestone |
|---|---|---|---|
| AC-01 | M3 | AC-07 | M5 |
| AC-02 | M4 | AC-08 | M5 |
| AC-03 | M1, M2 | AC-09 | M2, M3 |
| AC-04 | M1, M2 | AC-10 | M4 |
| AC-05 | M2 | AC-11 | M7 |
| AC-06 | M1, M2 | AC-12 | M6 |

---

## 6. Live demo mapping (PRD §11)

| Time | On stage | Real system path |
|---|---|---|
| 0:20–0:50 | `card-sim` swipe; employee emails receipt photo from phone | signed card webhook; Gmail poll → InboundMessage |
| 0:50–1:15 | Reply lands in employee's thread: "Matched & cleared" | match → policy CLEAR → export; zero finance action |
| 1:15–1:50 | Personal receipt email → reply: "Reimbursement £x — SIMULATED payout ref …" | payment-type PERSONAL → auto authorisation → mock payout |
| 1:50–2:20 | Duplicate/over-cap receipt → one targeted question → employee replies → reviewer gets approval email → authenticated approve | NEEDS_INFO → resume → REVIEW_REQUIRED → challenge → audit |
| 2:20–2:40 | Eval report: held-out denominators, baseline, cost/expense, known failures | `eval_runs` latest held-out run |
| 2:40–3:00 | Economics + labelled concept card render | — |

The reviewer screen appears only in the exception segment. Fallback: recorded genuine run, announced as a recording.

---

## 7. What I need from you before/while M0 runs

1. **Approve or amend this plan.**
2. **Mailbox:** create a dedicated Gmail (e.g. `swipeback.demo…@gmail.com`). In Google Cloud: new project → enable Gmail API → OAuth consent screen *External / Testing* → add that mailbox as a test user → OAuth client type *Web*, redirect `http://localhost:3000/api/oauth/google/callback`. Put the client ID/secret in `swipeback/.env.local` (I'll create the template; I won't print secrets). Needed by ~13:00.
3. **Anthropic API key** for the app in `.env.local` (separate from your shell's `ANTHROPIC_BASE_URL`). Needed by ~16:00.
4. **Hosting:** I recommend the live demo runs locally (embedded Postgres + worker + web — no public URL needed for Gmail polling) with optional hosting later. Say if judges require a hosted URL.
5. **Repo:** I'll create `~/Documents/GitHub/swipeback` with git. Private GitHub repo now, or later?

---

## 8. Progress log

### M0 — Foundations: DONE (Sat 17 Oct, ~07:00 BST)
- `corepack pnpm verify` green: typecheck, lint, 63 tests in 6 files (~2.5 s).
- Gate results: migrate re-run is a no-op and reset+migrate reproduces an identical schema; 1,000 jobs × 4 runners each ran exactly once (work shared by all 4); failing job retried with growing backoff then dead-lettered; lease expiry reclaim tested; `UPDATE`/`DELETE`/`TRUNCATE` on `audit_events` rejected by Postgres; verifier detects altered and deleted rows; domain purity lint fires for fs/http/pg/@swipeback/db/Date.now/Math.random/new Date()/process/fetch.
- Extra (pulled forward from M1/M2 because the triggers already exist): schema-level attack tests for I1–I4, policy immutability/pinning, payout-destination immutability, segregation of duties.
- Deviations from §2.2/§5: **SQL-first migrations + `pg`, no Drizzle** (the invariants live in SQL triggers; a second schema definition would drift). **No down migrations**: "down/up" is replaced by reset+migrate reproducibility, which is what the demo needs.
- Known limitation: the audit hash chain is tamper-*evident* only if the head hash is published outside the database (planned: daily finance digest). Audit appends serialise per organisation (advisory lock) — fine at pilot volume.

### M1 — Domain core: DONE (Sat 17 Oct, ~07:10 BST)
- `corepack pnpm verify` green: 184 tests in 11 files (~4.4 s).
- Built (all pure, in `packages/domain`): versioned policy schema with clause citations (`policy-schema.ts`), deterministic policy engine with outcome precedence INTEGRITY > REJECT > INFO > LIMIT > CLEAR and exactly one question (`policy-engine.ts`), card matching (`matching.ts`), merchant normalisation, duplicate detection, payment-type resolution with card-feed wait, separate reimbursement eligibility with blockers vs human-required (`eligibility.ts`), deterministic intents (`intents.ts`). Demo org policy (NW-1…NW-16) seeded as policy version 1.
- Gate results: exhaustive `(state, event)` table for both machines; graph checks (AUTO_CLEARED unreachable without POLICY_CHECK; nothing cleared without the policy engine or a reviewer; SIMULATED_PAID unreachable without ELIGIBILITY_CHECK, AUTHORIZED and PAYOUT_QUEUED). Property test, 10,000 seeded cases across random policies: auto-authorised ⇒ every PRD §5 control holds; a non-vacuity guard requires >200 auto-authorised cases. Mutation check: removing the per-expense cap, weekly cap or duplicate blocker each fails the suite. Matching: ±1p never matches, two equal candidates are AMBIGUOUS, at-most-one property over 2,000 random feeds. Same inputs give byte-identical decisions; the inputs hash changes with input or policy.
- Correction to the plan wording: an expense can reach APPROVED without POLICY_CHECK (extraction failure → review → human approves). That is intended: only AUTO_CLEARED requires the policy engine. Payout after human approval still needs a separate payment-approver authorisation (`CLEARED_BY_HUMAN_REVIEW`).
