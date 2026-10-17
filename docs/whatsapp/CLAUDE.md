# WhatsApp integration — instructions for Claude Code

You are working on the `whatsapp-integration` branch of **Swipeback** (SotonShip 2026, FinTech track).
Your job: let an employee **send a receipt photo or PDF on WhatsApp** and have Swipeback process it
through the existing engine and reply in the same WhatsApp chat.

**Read first:** `docs/HANDOFF.md` (sections 1, 4, 5 and 7) and the files listed under "Read before coding".
This file only covers the WhatsApp work. The rules in `docs/HANDOFF.md` §1 ("Non-negotiable product
rules") apply here too and override anything below if they conflict.

---

## Start here: set up the branch (do this first, once)

The user may hand you this file from outside the repo (e.g. their Downloads folder). Before any other
work, put it on its own branch. **Never commit to `main`, never push to `main`, never merge.**

1. Confirm you are in the swipeback repo: `git remote get-url origin` must point to
   `github.com/36taransingh5-dotcom/swipeback`. If not, stop and ask the user where the repo is.
2. Check for uncommitted changes: `git status --porcelain`. If anything is listed, **stop and ask the
   user** — it may be Taran's M6 work. Do not stash, reset, discard or commit it yourself.
3. Fetch and check whether the branch already exists:
   ```bash
   git fetch origin
   git ls-remote --heads origin whatsapp-integration
   ```
   - **If it exists:** `git switch whatsapp-integration` (or `git switch -c whatsapp-integration --track origin/whatsapp-integration` if there is no local copy), then `git pull --rebase`. Skip to step 5.
   - **If it does not exist:** create it from the latest `main`:
     ```bash
     git switch -c whatsapp-integration origin/main
     ```
4. Add this file at `docs/whatsapp/CLAUDE.md` (copy it from wherever the user gave it to you; ask for
   the path if unsure), then commit and push the branch only:
   ```bash
   mkdir -p docs/whatsapp
   cp <path-the-user-gave>/CLAUDE.md docs/whatsapp/CLAUDE.md
   git add docs/whatsapp/CLAUDE.md
   git commit -m "WhatsApp integration plan for Claude Code (branch only, not for main yet)"
   git push -u origin whatsapp-integration
   ```
5. Confirm with `git branch --show-current` (must print `whatsapp-integration`) and
   `git log --oneline origin/main..HEAD` (must show only this branch's commits). Tell the user the
   branch is set up, then continue with the work below.

For every later session: `git switch whatsapp-integration && git fetch origin && git rebase origin/main`
before starting, and push with `git push` (use `git push --force-with-lease` only after a rebase, and
only on this branch).

---

**Hard deadline:** submissions lock Sun 18 Oct 2026, 13:00 BST. WhatsApp has a **hard cut-off of
Sun 08:00 BST**: if it is not reliable by then, stop, leave the branch unmerged, and it becomes a
roadmap slide. Do not let this work delay anything on `main`.

---

## 0. Parallel work: avoid merge conflicts (most important rule)

Taran is working on **M6 (full-pipeline evaluation)** on `main` at the same time. This branch must be
mergeable later with **zero conflicts**. Therefore:

1. **Put new code in new files.** Almost all WhatsApp code lives in new files (see §3).
2. **Edits to existing files must be tiny and additive**: one import line plus one registration line,
   appended next to existing entries. Never reformat, reorder, rename or "tidy" existing code.
3. **Do not touch M6 areas at all:**
   - `tools/cli/src/eval/**`, `eval/**`, `docs/PLAN.md`, `docs/HANDOFF.md`, `docs/EXTRACTION_BENCHMARK.md`
   - `packages/extraction/**`, `packages/domain/**`
   - test fixtures shared with M6 (`test/fixtures/**`, `packages/domain/test/fixtures.ts`)
   - `package.json` / `pnpm-lock.yaml` (do **not** add dependencies; Node's `fetch` and `crypto` are enough)
4. **No database migrations.** The schema already supports WhatsApp (see §2). If you become convinced
   a migration is unavoidable, stop and ask the user, because Taran may add `0006_*` for M6.
5. **Do not create or edit a root `CLAUDE.md` or `README.md`** (Taran owns those). This file lives at
   `docs/whatsapp/CLAUDE.md`.
6. Keep the branch current by **rebasing onto `origin/main`** (`git fetch && git rebase origin/main`)
   at the start of each session and before handing over. Never merge into `main`, never push to `main`,
   never force-push anything except this branch.
7. Commit in small steps with clear messages, each only after `corepack pnpm verify` is green.

---

## 1. Scope

**In scope**
- Inbound: an enrolled employee sends a WhatsApp message with an image (JPEG/PNG/WebP) or a PDF
  document, optionally with a caption → the existing engine creates and decides an expense.
- Outbound: Swipeback's replies (status, one follow-up question, "sent to finance", "reimbursed
  (simulated)") go back in the same WhatsApp chat, as plain text.
- Text-only replies to an open question (e.g. answering "What was this for?").
- Unknown numbers: quarantined; one polite enrolment reply at most (the engine already does this).

**Out of scope (do not build)**
- Card-swipe receipt chasing over WhatsApp (stays on email).
- Interactive buttons, approvals or payments over WhatsApp (approval stays in the web reviewer app).
- Message templates / business-initiated messages, Slack, Telegram, iMessage.
- Real employee self-enrolment flow (demo uses a CLI link command, labelled as demo enrolment).

---

## 2. What already exists (do not rebuild)

- `packages/channels/src/contract.ts`: the `ChannelAdapter` contract and `InboundMessageV1` schema.
  `'whatsapp'` is already in `CHANNELS`.
- `packages/channels/src/synthetic/adapter.ts`: **the model to copy** — signed webhook, attachments
  stored via `EvidenceStore`, normalised with `dedupeKeyFor`, `sanitiseUntrustedText`, `screenAttachment`.
- `packages/db/migrations/0001_core.sql`: `channel_connections.channel` and `channel_identities.channel`
  already allow `'whatsapp'`.
- `packages/engine/src/inbound.ts`: channel-neutral intake. `REQUIRED_AUTH.whatsapp = ['platform_signed']`
  already. `receiveInbound` / `ingestInbound` / `processInbound` do identity, intent, extraction, policy.
  Receipts from chat channels are stored with `source_kind = 'CHAT_MEDIA'`.
- `packages/engine/src/outbox.ts`: replies are queued with the originating `connection_id` and delivered
  by `deliverOutbound` via `adapter.sendMessage`. After a send, `result.threadId` is written to
  `conversation_links`, which is how later replies correlate to the expense (`findOpenQuestion`).
- `packages/engine/src/runtime.ts`: `channelRegistry([...])` — adapters are looked up by `provider`.
- `apps/web/src/app.ts`: `POST /api/inbox/:connectionId` already accepts verified channel webhooks.
- `tools/cli/src/pipeline-commands.ts`: `ensureConnection(...)` pattern for creating a connection.

### Read before coding
`packages/channels/src/contract.ts`, `packages/channels/src/synthetic/adapter.ts`,
`packages/channels/src/sanitise.ts`, `packages/channels/src/testing/contract-suite.ts`,
`packages/engine/src/inbound.ts` (especially `processInbound` and `findOpenQuestion`),
`packages/engine/src/outbox.ts`, `packages/engine/src/runtime.ts`, `apps/web/src/app.ts`,
`tools/cli/src/main.ts`, `tools/cli/src/pipeline-commands.ts`, `tools/cli/src/seed.ts`.

---

## 3. Files

**New files (put nearly everything here):**

| File | Purpose |
|---|---|
| `packages/channels/src/whatsapp/adapter.ts` | `WhatsAppCloudAdapter` implementing `ChannelAdapter` (provider `'whatsapp-cloud'`) |
| `packages/channels/src/whatsapp/graph-api.ts` | Thin Meta Graph API client: download media, send text. Injectable `fetch` for tests |
| `packages/channels/src/whatsapp/payload.ts` | zod schemas for the webhook body; splitting a batch into messages |
| `packages/channels/test/whatsapp.test.ts` | Adapter tests, including the shared contract suite |
| `packages/engine/src/whatsapp.ts` | `receiveWhatsAppWebhook(deps, connectionId, raw)` (batch intake, see §4.3) |
| `packages/engine/test/whatsapp.test.ts` | End-to-end on real Postgres with a fake Graph API |
| `apps/web/src/whatsapp-routes.ts` | `GET` verification + `POST` webhook routes, registered by one line in `app.ts` |
| `tools/cli/src/whatsapp-commands.ts` | `whatsapp:connect`, `whatsapp:link`, `whatsapp:status` |
| `docs/whatsapp/SETUP.md` | Meta setup and demo runbook (from §6 of this file, kept up to date) |

**Existing files: allowed one-line additive edits only**

| File | Edit |
|---|---|
| `packages/channels/src/index.ts` | `export * from './whatsapp/adapter.ts';` (and `graph-api.ts` if needed) |
| `packages/engine/src/index.ts` | export `receiveWhatsAppWebhook` |
| `packages/engine/src/runtime.ts` | add the adapter to `channelRegistry([...])` **only when** WhatsApp env vars are set (like Gmail) |
| `apps/web/src/app.ts` | one line registering the WhatsApp routes |
| `tools/cli/src/main.ts` | import and spread `whatsappCommands` next to the other command maps |
| `.env.example` | append the WhatsApp variable **names** (§5), never values |

---

## 4. Technical design

### 4.1 Meta WhatsApp Cloud API facts (check against Meta's current docs before relying on them)
- **Webhook verification (GET):** Meta calls the callback URL with `hub.mode=subscribe`,
  `hub.verify_token=<your token>`, `hub.challenge=<string>`. Respond `200` with the challenge as plain
  text if the token matches (constant-time compare), else `403`.
- **Webhook events (POST):** JSON body `{ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id, display_phone_number }, contacts: [...], messages: [...], statuses: [...] } }] }] }`.
  One POST can contain **several messages and/or status updates**.
- **Signature:** header `x-hub-signature-256: sha256=<hex>` = HMAC-SHA256 of the **raw body bytes**
  with the **app secret**. Verify before parsing; constant-time compare; reject on mismatch.
- **Message fields:** `from` (sender's WhatsApp number, digits, no `+`), `id` (`wamid.…`),
  `timestamp` (Unix seconds string), `type` (`text` | `image` | `document` | others), `text.body`,
  `image { id, mime_type, sha256, caption }`, `document { id, mime_type, sha256, filename, caption }`,
  `context.id` (present when the user quote-replies to one of our messages).
- **Media download (two steps):** `GET https://graph.facebook.com/<version>/<media-id>` with
  `Authorization: Bearer <token>` → JSON with `url`, `mime_type`, `sha256`, `file_size`; then
  `GET <url>` with the same bearer header → bytes. Media URLs expire after a few minutes, so download
  during intake, not later.
- **Send text:** `POST https://graph.facebook.com/<version>/<phone-number-id>/messages` with JSON
  `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: '<digits>', type: 'text', text: { preview_url: false, body } }`,
  optionally `context: { message_id: '<wamid>' }` to quote-reply. Response: `{ messages: [{ id }] }`.
- **24-hour customer service window:** free-form messages are only allowed within 24 h of the user's
  last message. Outside it, sends fail (error code `131047` at time of writing). Treat as a delivery
  failure (see §4.5). Do not implement templates.
- Graph API version: configurable via `SB_WHATSAPP_GRAPH_VERSION`; set the default to the current
  version listed in Meta's docs when you start.

### 4.2 Adapter (`WhatsAppCloudAdapter`)
- `channel = 'whatsapp'`, `provider = 'whatsapp-cloud'`.
- `capabilities = { attachments: true, threading: true, interactiveActions: false, deliveryReceipts: false, businessInitiatedMessages: 'template_only' }`.
- Constructor takes: `EvidenceStore`, a `WhatsAppGraphClient` (from `graph-api.ts`), the app secret,
  and an optional `now()` for tests. Fail fast on a short/empty secret.
- `verifyInbound(connection, raw)`: verify signature → parse with zod → require
  `metadata.phone_number_id === connection.address` (else `NOT_ADDRESSED_TO_CONNECTION`) → return a
  `VerifiedInbound` for a body containing **exactly one** user message (throw `MALFORMED` otherwise;
  batches go through §4.3). `senderAuth = 'platform_signed'`.
- Extra method `verifyWebhook(connection, raw): VerifiedInbound[]` — same checks, returns **one entry
  per user message**, skipping `statuses` and unsupported message types (log/audit them as ignored).
- `normaliseInbound(verified)`:
  - `channelAddress`: E.164 with `+` (e.g. `+447700900123`). Normalise consistently; this is what
    `channel_identities.channel_address` must contain.
  - `displayName`: from `contacts[].profile.name`, via `sanitiseShort` (display only, never identity).
  - `providerEventId = message.id`; `dedupeKey = dedupeKeyFor('whatsapp', connectionId, message.id)`.
  - `providerTimestamp` from `timestamp`.
  - `text`: `text.body` or the media caption, via `sanitiseUntrustedText` (untrusted data).
  - Attachments: for `image`/`document`, download via the Graph client, check the downloaded bytes'
    sha256 against Meta's `sha256` when present (mismatch → `MALFORMED`), cap size (reuse existing
    limits), `normaliseMime`, `screenAttachment`, then `evidence.put`. Filenames are untrusted.
  - `conversation`: `messageId = message.id`; `inReplyTo = message.context?.id ?? null`;
    `threadId`: see §4.4; `references = []`; `correlationToken = null`.
  - `consent = { source: 'bot_dm', scope: 'whatsapp:<phone_number_id>' }`; `autoGenerated = false`;
    `action = null`; `subject = null`.
  - Validate with `inboundMessageV1Schema.parse`.
- `sendMessage(envelope)`: strip `+` from `envelope.to`; send text (WhatsApp body limit is 4096 chars;
  truncate safely with a note). If `envelope.inReplyTo` looks like a `wamid`, add `context.message_id`.
  Return `{ providerMessageId: <wamid>, threadId: <see §4.4> }`. Throw on non-2xx with a clear error
  message (no tokens in error text).
- `sendApprovalRequest`: WhatsApp is not used for approvals; send a plain message pointing to the
  review app (the URL is authenticated and never approves by itself), same as `sendMessage`.

### 4.3 Batch intake (`packages/engine/src/whatsapp.ts`)
`receiveInbound` handles one event per request, but Meta batches. Add
`receiveWhatsAppWebhook(deps, connectionId, raw)` that: loads the connection (reuse `loadConnection`),
calls `adapter.verifyWebhook` once, then for each verified message calls `adapter.normaliseInbound` and
`ingestInbound`. Rejections are audited exactly like `receiveInbound` does. Return a summary
(`accepted`, `duplicates`, `ignored`). Reuse engine functions; do not modify `inbound.ts`.

### 4.4 Threading and correlation (decide with tests)
`findOpenQuestion` correlates a reply to an open question by `correlationToken`, else by any of
`threadId`, `references`, `inReplyTo` matching `conversation_links` rows for the **same member**.
Our sends write `result.threadId` into `conversation_links`.

Recommended design: use a **per-chat thread id** `wa:<connectionId>:<senderDigits>` as `threadId` for
both inbound messages and send results, and also pass `inReplyTo = context.id` when present.
Then write tests for these cases and adjust if any fails:
1. Receipt photo → auto-cleared → reply arrives in the same chat.
2. Receipt photo → engine asks one question → user answers with **plain text (no quote-reply)** →
   answer attaches to that expense.
3. While a question is open, the user sends a **new, unrelated receipt** → it must become a new
   expense, not be swallowed as the answer (check what `resolveIntent` does with an open RECEIPT vs
   other question kinds). If the per-chat thread causes wrong attachment, switch `threadId` to the
   outbound `wamid` and rely on `inReplyTo` (quote-reply) for correlation, and document the trade-off.

### 4.5 Failure behaviour (must fail closed)
- Bad signature, wrong `phone_number_id`, malformed body → reject (401), audited, nothing ingested.
- Media download fails → transient error: let the webhook return non-2xx so Meta retries; the dedupe
  key prevents duplicates on retry. Never create an expense without its evidence.
- Unsupported types (stickers, audio, location, reactions) → ignored, no reply loop.
- Send outside the 24-hour window or any send error → `deliverOutbound` already records the error and
  retries, then dead-letters; the message stays visibly undelivered. The case must still be visible to
  finance in the reviewer app. Add a test.
- Unknown sender number → existing quarantine path; at most one enrolment reply per day.

### 4.6 Web routes (`apps/web/src/whatsapp-routes.ts`)
- `GET /api/whatsapp/:connectionId` → verification handshake (§4.1).
- `POST /api/whatsapp/:connectionId` → read raw bytes (`c.req.arrayBuffer()`), lowercase headers,
  call `receiveWhatsAppWebhook`. Return `200` on success (Meta expects a fast 2xx), `401` on rejection,
  `404` for an unknown/inactive connection, `5xx` on transient failure so Meta retries.
- Respect the existing security headers middleware; no business logic in the route.

### 4.7 CLI (`tools/cli/src/whatsapp-commands.ts`)
- `whatsapp:connect` → create (idempotently) a `channel_connections` row: `channel='whatsapp'`,
  `provider='whatsapp-cloud'`, `address=<SB_WHATSAPP_PHONE_NUMBER_ID>`, status ACTIVE. Print the
  connection id and the callback URL `<public base>/api/whatsapp/<id>`.
- `whatsapp:link --member-email <addr> --phone +44…` → insert a `channel_identities` row
  (`channel='whatsapp'`, normalised E.164, `verification_method='demo_enrolment'`), audited.
  Refuse non-local databases, like `db:reset` does. Clearly labelled demo enrolment.
- `whatsapp:status` → show connection, linked numbers and last inbound/outbound WhatsApp messages.

---

## 5. Configuration (`.env.local`, never commit values, never print secrets)

```
SB_WHATSAPP_ACCESS_TOKEN=        # Meta system-user token (temporary tokens expire in ~24 h)
SB_WHATSAPP_PHONE_NUMBER_ID=     # the test number's phone number ID
SB_WHATSAPP_APP_SECRET=          # Meta app secret, for x-hub-signature-256
SB_WHATSAPP_VERIFY_TOKEN=        # random string you choose, entered in Meta's webhook settings
SB_WHATSAPP_GRAPH_VERSION=       # optional; default set in code
SB_PUBLIC_BASE_URL=              # the tunnel URL, used only to print the callback URL
```
The adapter is registered only when the first three are set. Without them, everything else must work
exactly as before (existing tests must stay green with no WhatsApp env set).

---

## 6. Meta and tunnel setup (the user does this; document it in `docs/whatsapp/SETUP.md`)
1. developers.facebook.com → create app (type Business) → add the **WhatsApp** product.
2. Use Meta's **free test number**. Copy the phone number ID. Create a **system user token** with
   WhatsApp permissions (the quick temporary token expires after ~24 h — refresh before the demo).
3. Add the team's phones as **allowed recipient numbers** for the test number.
4. Copy the **app secret** (App settings → Basic). Choose a verify token.
5. Start the web app and a tunnel (ngrok or Cloudflare Tunnel) to `http://localhost:3000`. Prefer a
   fixed tunnel URL; a changing URL must be re-entered in Meta.
6. `corepack pnpm sb whatsapp:connect` → paste the printed callback URL and the verify token into
   Meta's webhook config; subscribe to the **messages** field.
7. `corepack pnpm sb whatsapp:link --member-email <seeded employee email> --phone +44…`.
8. Start the worker. Send a receipt photo from the linked phone to the test number.

---

## 7. Tests (no network in tests)
- Adapter (`packages/channels/test/whatsapp.test.ts`): run the shared contract suite
  (`testing/contract-suite.ts`); valid signature accepted; tampered body / wrong secret / missing
  header rejected; wrong `phone_number_id` → `NOT_ADDRESSED_TO_CONNECTION`; batch of 2 messages + 1
  status → 2 verified events; image and PDF downloaded via fake Graph client and stored with correct
  sha256; Meta sha256 mismatch rejected; unsupported type ignored; caption becomes text; injection
  text in caption stays data; send builds the correct request and maps the returned `wamid`.
- Engine (`packages/engine/test/whatsapp.test.ts`, real Postgres via `test/support`): the three
  threading cases in §4.4; same webhook delivered 5× → one expense; unknown number quarantined with at
  most one enrolment reply; send failure leaves the message undelivered and the case reviewable;
  **channel neutrality**: the same receipt via email fixture and via WhatsApp gives the same decision.
- Web: GET handshake success and failure; POST with bad signature → 401.
- Run `corepack pnpm verify` before every commit. The existing ~331 tests must stay green.

---

## 8. Definition of done
- A real photo sent from a linked phone to the test number creates an expense, is decided by the
  existing engine, and the reply arrives in the same WhatsApp chat. Record the evidence (inbound
  message id, attachment sha256, decision, outbound `wamid`) in `docs/whatsapp/SETUP.md` under
  "Live test results", with date and time. Report real results, including failures.
- All tests green; no changes outside the files allowed in §3; branch rebased on `origin/main`
  with no conflicts.
- All demo data labelled SYNTHETIC / DEMO; payouts remain simulated; nothing claims Slack, Telegram
  or iMessage are live.

## 9. Pitch notes (for the team)
- Demo beat: "Paid with your own money? Just WhatsApp the receipt." Same engine, same rules, same
  audit trail as email — show the channel-neutrality test.
- Honest limit to mention: WhatsApp's 24-hour window means follow-ups after a day fall back to
  finance review; real enrolment would verify the phone number by a code sent to the work email.
