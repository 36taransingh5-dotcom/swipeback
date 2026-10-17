# Slack integration — instructions for Claude Code

You are working on the `slack-integration` branch of **Swipeback** (SotonShip 2026, FinTech track).
Your job: let an employee **send a receipt photo or PDF to the Swipeback bot in a Slack direct
message** and have Swipeback process it through the existing engine and reply in the same Slack thread.

**Read first:** `README.md`, `docs/HANDOFF.md` (sections 1, 4, 5 and 7) and the files listed under
"Read before coding". The rules in `docs/HANDOFF.md` §1 ("Non-negotiable product rules") apply here
too and override anything below if they conflict.

---

## Start here: set up the branch (do this first, once)

The user may hand you this file from outside the repo (e.g. their Downloads folder). Before any other
work, put it on its own branch. **Never commit to `main`, never push to `main`, never merge anything.
Never touch the `whatsapp-integration` branch.**

1. Confirm you are in the swipeback repo: `git remote get-url origin` must point to
   `github.com/36taransingh5-dotcom/swipeback`. If not, stop and ask the user where the repo is.
2. Check for uncommitted changes: `git status --porcelain`. If anything is listed, **stop and ask the
   user**: it may be someone else's work. Do not stash, reset, discard or commit it yourself.
3. Fetch and check whether the branch already exists:
   ```bash
   git fetch origin
   git ls-remote --heads origin slack-integration
   ```
   - **If it exists:** `git switch slack-integration` (or `git switch -c slack-integration --track origin/slack-integration` if there is no local copy), then `git pull --rebase`. Skip to step 5.
   - **If it does not exist:** create it from the latest `main` (**not** from `whatsapp-integration`):
     ```bash
     git switch -c slack-integration origin/main
     ```
4. Add this file at `docs/slack/CLAUDE.md` (copy it from wherever the user gave it to you; ask for the
   path if unsure), then commit and push the branch only:
   ```bash
   mkdir -p docs/slack
   cp <path-the-user-gave>/CLAUDE.md docs/slack/CLAUDE.md
   git add docs/slack/CLAUDE.md
   git commit -m "Slack integration plan for Claude Code (branch only, not for main yet)"
   git push -u origin slack-integration
   ```
5. Confirm with `git branch --show-current` (must print `slack-integration`) and
   `git log --oneline origin/main..HEAD` (must show only this branch's commits). Tell the user the
   branch is set up, then continue with the work below.

For every later session: `git switch slack-integration && git fetch origin && git rebase origin/main`
before starting, and push with `git push` (use `git push --force-with-lease` only after a rebase, and
only on this branch).

---

**Hard deadline:** submissions lock Sun 18 Oct 2026, 13:00 BST. Slack has a **hard cut-off of
Sun 08:00 BST**: if it is not reliable by then, stop, leave the branch unmerged, and it becomes a
roadmap slide. Do not let this work delay anything on `main`.

---

## 0. Parallel work: avoid merge conflicts (most important rule)

Taran keeps working on `main` (M6 evaluation and M7 demo hardening are merged; more fixes may land).
This branch must merge into `main` later with **zero conflicts**. The WhatsApp work has been
**paused** (its branch is parked, not planned for merging), but it may be revived, so keep the
anchors below anyway.

1. **Put new code in new files.** Almost all Slack code lives in new files (see §3).
2. **Edits to existing files must be tiny, additive, and at the exact anchor lines in §3.** The
   WhatsApp branch appends its lines at the *end* of the same lists; git reports a conflict when two
   branches insert at the same spot, so Slack inserts at *different* spots, with at least one unchanged
   line between Slack's lines and WhatsApp's. Never reformat, reorder, rename or "tidy" existing code.
3. **Do not touch:**
   - `README.md`, `docs/PLAN.md`, `docs/HANDOFF.md`, `docs/RUNBOOK.md` or any other existing doc
   - `docs/whatsapp/**` and any `**/whatsapp*` file
   - `tools/cli/src/eval/**`, `eval/**`, `packages/extraction/**`, `packages/domain/**`
   - `apps/web/**` and `apps/worker/**` (Slack needs no web route and no worker change, see §4.5)
   - shared test fixtures (`test/fixtures/**`, `packages/domain/test/fixtures.ts`)
   - `package.json` / `pnpm-lock.yaml`: **do not add dependencies.** Node 24 has a global `WebSocket`
     and `fetch`; use them instead of `@slack/*` packages.
4. **No database migrations.** The schema already supports Slack (see §2). If a migration seems
   unavoidable, stop and ask the user.
5. **Do not create a root `CLAUDE.md`.** This file lives at `docs/slack/CLAUDE.md`.
6. **Conflict check before every push** (needs git ≥ 2.38):
   ```bash
   git fetch origin
   git merge-tree --write-tree origin/main HEAD >/dev/null && echo "OK vs main"
   # Only if the parked WhatsApp branch still exists:
   git ls-remote --exit-code --heads origin whatsapp-integration >/dev/null \
     && git merge-tree --write-tree origin/whatsapp-integration HEAD >/dev/null && echo "OK vs whatsapp"
   ```
   The `main` check must pass. If the WhatsApp check fails, mention it to the user but do not block
   on it (that branch is paused). If either fails, move your inserted lines so they no longer touch the other branch's lines. Never
   edit the other branch.
7. Commit in small steps with clear messages, each only after `corepack pnpm verify` is green.

---

## 1. Scope

**In scope**
- Inbound: an enrolled employee sends the Swipeback bot a **direct message** with an image
  (JPEG/PNG/WebP/HEIC) or PDF, optionally with text → the existing engine creates and decides an expense.
- Outbound: Swipeback's replies (status, one follow-up question, "sent to finance", "reimbursed
  (simulated)") go back **in a thread under the employee's message**, as plain text.
- Text replies **in that thread** answer an open question (e.g. "What was this for?").
- Unknown Slack users: quarantined; one polite enrolment reply at most (the engine already does this).

**Out of scope (do not build)**
- Buttons, slash commands, modals, App Home, approvals or payment authorisation in Slack (approval
  stays in the web reviewer app).
- Public or private channels (DMs only), card-swipe receipt chasing over Slack (stays on email).
- WhatsApp (paused), Telegram, iMessage. Real self-enrolment (demo uses a CLI link command, labelled demo).
- HTTP Events API mode as the primary path (Socket Mode is primary; see §4.1).

---

## 2. What already exists (do not rebuild)

- `packages/channels/src/contract.ts`: the `ChannelAdapter` contract and `InboundMessageV1` schema.
  `'slack'` is already in `CHANNELS`.
- `packages/channels/src/synthetic/adapter.ts`: **the model to copy** (it was designed as a Slack-style
  signed channel): attachments stored via `EvidenceStore`, normalised with `dedupeKeyFor`,
  `sanitiseUntrustedText`, `screenAttachment`, `sanitiseShort`.
- `packages/db/migrations/0001_core.sql`: `channel_connections.channel` and `channel_identities.channel`
  already allow `'slack'`; receipts from chat channels use `source_kind = 'CHAT_MEDIA'`.
- `packages/engine/src/inbound.ts`: channel-neutral intake. `REQUIRED_AUTH.slack = ['platform_signed']`
  already. `ingestInbound` / `processInbound` do identity, intent, extraction and policy.
- `packages/engine/src/outbox.ts`: replies are queued with the originating `connection_id` and delivered
  by `deliverOutbound` via `adapter.sendMessage`. After a send, `result.threadId` is written to
  `conversation_links`; `findOpenQuestion` in `inbound.ts` uses it to correlate replies.
- `packages/engine/src/runtime.ts`: `channelRegistry([...])`; adapters are looked up by `provider`.
- The generic `POST /api/inbox/:connectionId` route in `apps/web/src/app.ts` calls `receiveInbound` for
  any connection, so the Slack adapter's `verifyInbound` **must** reject unsigned requests (§4.2).
- The paused `whatsapp-integration` branch (if it still exists) contains a sibling adapter with tests.
  You may read it (`git show origin/whatsapp-integration:<path>`) for patterns; do not copy its files
  onto this branch and do not depend on it.

### Read before coding
`packages/channels/src/contract.ts`, `packages/channels/src/synthetic/adapter.ts`,
`packages/channels/src/sanitise.ts`, `packages/channels/src/testing/contract-suite.ts`,
`packages/engine/src/inbound.ts` (especially `receiveInbound`, `ingestInbound`, `processInbound`,
`findOpenQuestion`), `packages/engine/src/outbox.ts`, `packages/engine/src/runtime.ts`,
`tools/cli/src/main.ts`, `tools/cli/src/pipeline-commands.ts`, `tools/cli/src/seed.ts`.

---

## 3. Files

**New files (put nearly everything here):**

| File | Purpose |
|---|---|
| `packages/channels/src/slack/adapter.ts` | `SlackAdapter` implementing `ChannelAdapter` (provider `'slack-bot'`) |
| `packages/channels/src/slack/web-api.ts` | Thin Slack Web API client: `auth.test`, `conversations.open`, `chat.postMessage`, `users.lookupByEmail`, file download. Injectable `fetch` |
| `packages/channels/src/slack/payload.ts` | zod schemas for Socket Mode envelopes and `message` events |
| `packages/channels/test/slack.test.ts` | Adapter tests, including the shared contract suite |
| `packages/engine/src/slack.ts` | `slackAdapterFromEnv`, `receiveSlackEvent`, `runSlackSocket` (§4.3–4.5) |
| `packages/engine/test/slack.test.ts` | End-to-end on real Postgres with a fake Slack API |
| `tools/cli/src/slack-commands.ts` | `slack:connect`, `slack:link`, `slack:listen`, `slack:status` |
| `tools/cli/test/slack-commands.test.ts` | CLI tests |
| `docs/slack/SETUP.md` | Slack app setup and demo runbook (from §6, kept up to date) |

**Existing files: one-line additive edits at these exact anchors only**

Insert each new line **immediately after** the anchor line shown (as it appears on `main`). These
anchors are chosen so Slack's lines never sit next to the WhatsApp branch's lines.

| File | Anchor line (insert directly after it) | Line(s) to add |
|---|---|---|
| `packages/channels/src/index.ts` | `export * from './sink.ts';` | `export * from './slack/adapter.ts';` and `export * from './slack/web-api.ts';` |
| `packages/engine/src/index.ts` | `export * from './case-view.ts';` | `export * from './slack.ts';` |
| `packages/engine/src/runtime.ts` (import) | `import { channelRegistry, systemClock, type EngineDeps } from './deps.ts';` | `import { slackAdapterFromEnv } from './slack.ts';` |
| `packages/engine/src/runtime.ts` (setup) | `  const sink = new DirectorySink(outboxDir);` | `  const slack = slackAdapterFromEnv(env, evidence);` |
| `packages/engine/src/runtime.ts` (registry) | `      new FixtureEmailAdapter(evidence, sink),` | `      ...(slack ? [slack] : []),` |
| `tools/cli/src/main.ts` (import) | `import { evalCommands } from './eval/benchmark.ts';` | `import { slackCommands } from './slack-commands.ts';` |
| `tools/cli/src/main.ts` (map) | `  ...pipelineCommands,` | `  ...slackCommands,` |
| `.env.example` | `SB_APP_URL=http://localhost:3000` | a blank line, then the Slack block from §5 |

If an import-sorting lint rule complains about an anchor, suppress it for that one line rather than
moving the line next to another branch's insertion. Run the §0 conflict check after these edits.

---

## 4. Technical design

### 4.1 Why Socket Mode
Socket Mode lets the bot receive events over an outbound WebSocket, so **no public URL or tunnel is
needed** (unlike WhatsApp). This is the primary path. The HTTP signing-secret check in §4.2 exists only
so the generic `/api/inbox` route stays safe.

### 4.2 Slack platform facts (check against Slack's current docs before relying on them)
- **Socket Mode connection:** `POST https://slack.com/api/apps.connections.open` with
  `Authorization: Bearer <app-level token xapp-…>` → `{ ok, url }`. Open a WebSocket to `url`.
  Frames: `{ type: 'hello' }`; `{ type: 'events_api', envelope_id, payload: { team_id, event_id, event }, retry_attempt? }`;
  `{ type: 'disconnect' }` (reconnect with a fresh `apps.connections.open`).
  **Acknowledge every envelope within 3 seconds** by sending `{ "envelope_id": "<id>" }`, then process.
- **Events:** subscribe the bot to `message.im`. A DM with a file arrives as `event.type = 'message'`,
  `channel_type = 'im'`, often `subtype = 'file_share'`, with `user`, `channel` (`D…`), `ts`,
  optional `thread_ts`, `text`, and `files[]` (`id`, `name`, `mimetype`, `size`, `url_private_download`).
- **Ignore:** messages with `bot_id` or `subtype` of `bot_message`, `message_changed`,
  `message_deleted`, `channel_join` etc. (prevents reply loops with our own posts); non-`im` channels.
- **File download:** `GET <url_private_download>` with `Authorization: Bearer <bot token xoxb-…>`
  (needs `files:read`). If the response is `text/html`, the token or scope is wrong: treat as an error,
  never store the HTML as a receipt.
- **Send:** `conversations.open` (`users=<U…>`) → DM channel id; then `chat.postMessage` with
  `channel`, `text`, and `thread_ts` to reply in the thread. Response has `ts` (the message id).
- **HTTP request signing (only for `verifyInbound`):** headers `x-slack-signature: v0=<hex>` and
  `x-slack-request-timestamp`; signature = HMAC-SHA256 with the **signing secret** over
  `v0:<timestamp>:<raw body>`; reject if the timestamp is more than 5 minutes old. Constant-time compare.
  If no signing secret is configured, `verifyInbound` must always throw `BAD_SIGNATURE`.
- Slack allows business-initiated DMs, so `businessInitiatedMessages = 'free'`.

### 4.3 Adapter (`SlackAdapter`)
- `channel = 'slack'`, `provider = 'slack-bot'`.
- `capabilities = { attachments: true, threading: true, interactiveActions: false, deliveryReceipts: false, businessInitiatedMessages: 'free' }`.
- Constructor: `EvidenceStore`, a `SlackWebClient`, the signing secret (may be empty), optional `now()`.
- `connection.address` = `<team_id>` of the workspace (from `auth.test`). Events whose `team_id`
  differs → `NOT_ADDRESSED_TO_CONNECTION`.
- `verifyInbound(connection, raw)`: HTTP path only, signing-secret check as in §4.2, then parse.
- Extra method `fromSocketEnvelope(connection, envelope): VerifiedInbound | null` for the trusted
  Socket Mode transport (authenticated by the app-level token over TLS): returns `null` for events to
  ignore (§4.2), else a `VerifiedInbound` with `senderAuth = 'platform_signed'`.
- `normaliseInbound(verified)`:
  - `channelAddress = 'slack:<team_id>:<user_id>'` (lower-case). This exact format must be used in
    `channel_identities.channel_address`.
  - `displayName = null` (do not trust profile names; identity comes only from the user id).
  - `providerEventId = '<channel>:<ts>'` (stable across Slack retries, unlike `event_id`);
    `dedupeKey = dedupeKeyFor('slack', connectionId, providerEventId)`.
  - `providerTimestamp` from `ts`.
  - `text` from `event.text` via `sanitiseUntrustedText` (untrusted data). Strip Slack markup minimally
    (`<@U…>` mentions) without interpreting it.
  - Attachments: download each file (max 5, reuse existing size caps), `normaliseMime` (prefer the
    response `content-type`, fall back to `mimetype`), `screenAttachment`, `evidence.put`. Filenames are
    untrusted (`sanitiseShort`).
  - `conversation`: `threadId = 'slack:<channel>:<thread_ts ?? ts>'`, `messageId = ts`,
    `inReplyTo = thread_ts ?? null`, `references = []`, `correlationToken = null`.
  - `consent = { source: 'bot_dm', scope: 'slack:<team_id>' }`; `autoGenerated = false`;
    `action = null`; `subject = null`.
  - Validate with `inboundMessageV1Schema.parse`.
- `sendMessage(envelope)`: parse the user id from `envelope.to`; `conversations.open`; post with
  `thread_ts` taken from `envelope.threadId` when it is a `slack:<channel>:<ts>` id. Return
  `{ providerMessageId: <posted ts>, threadId: 'slack:<channel>:<root ts>' }` (the **root** ts, so
  later replies in that thread correlate). Throw on `ok: false` with Slack's error code (no tokens in
  error text).
- `sendApprovalRequest`: approvals are not done in Slack; send a plain message pointing to the
  authenticated review page (the link never approves by itself), same as `sendMessage`.

### 4.4 Engine glue (`packages/engine/src/slack.ts`)
- `slackAdapterFromEnv(env, evidence)`: return a `SlackAdapter` only when `SB_SLACK_BOT_TOKEN` is set;
  otherwise `null`, and everything else must behave exactly as before.
- `receiveSlackEvent(deps, connectionId, envelope)`: load the connection (reuse `loadConnection`), call
  `adapter.fromSocketEnvelope`, then `normaliseInbound` and `ingestInbound`. Audit rejections like
  `receiveInbound` does. Do not modify `inbound.ts`.
- `runSlackSocket(deps, connectionId, appToken, { signal })`: the Socket Mode loop. Open, ack each
  envelope immediately, then `receiveSlackEvent`; reconnect on `disconnect` or socket close with
  backoff; never crash on one bad event (log it); stop cleanly on abort.

### 4.5 Where it runs (no web or worker edits)
`corepack pnpm sb slack:listen` runs `runSlackSocket` in its own process. For the demo, run it next to
the existing worker (`corepack pnpm worker`), which processes the jobs and delivers replies. Do not
change `apps/worker` or `apps/web`.

### 4.6 Threading and correlation (decide with tests)
`findOpenQuestion` matches a reply to an open question by `correlationToken`, else by `threadId` /
`references` / `inReplyTo` against `conversation_links` for the same member. With the design above,
each receipt starts its own Slack thread and Swipeback replies inside it, so answers given **in the
thread** correlate exactly. The bot's follow-up questions should say "Reply in this thread".
Write tests for:
1. Receipt in a DM → auto-cleared → reply appears in that message's thread.
2. Receipt → one question → user answers in the thread with text → the answer attaches to that expense.
3. While a question is open, the user posts a **new receipt as a new top-level DM** → it becomes a new
   expense, not an answer.
4. User answers at top level instead of in the thread → not silently attached to the wrong expense
   (document what happens; it should end up visible to finance, never auto-cleared on a guess).

### 4.7 Failure behaviour (must fail closed)
- HTTP request with bad or missing signature, stale timestamp, wrong team → rejected, audited.
- File download fails or returns HTML → no expense without its evidence; the event is retried via
  Slack's redelivery or logged as failed; dedupe prevents duplicates.
- Unsupported content (no file and no meaningful text, reactions, edits) → ignored, no reply loop.
- Send failure (`not_in_channel`, `invalid_auth`, rate limit) → `deliverOutbound` already records the
  error, retries and dead-letters; the case stays visible to finance. Add a test.
- Unknown Slack user → existing quarantine path; at most one enrolment reply per day.

### 4.8 CLI (`tools/cli/src/slack-commands.ts`)
- `slack:connect` → call `auth.test`; create (idempotently) a `channel_connections` row:
  `channel='slack'`, `provider='slack-bot'`, `address=<team_id>`, status ACTIVE. Print the team name,
  bot user and connection id.
- `slack:link --member-email <addr> (--slack-user U… | --lookup)` → insert a `channel_identities` row
  (`channel='slack'`, `channel_address='slack:<team_id>:<user_id>'` lower-case,
  `verification_method='demo_enrolment'`), audited. `--lookup` uses `users.lookupByEmail` with the
  member's email. Refuse non-local databases, like `db:reset` does. Clearly labelled demo enrolment.
- `slack:listen` → run the Socket Mode loop until Ctrl-C.
- `slack:status` → connection, linked users, last inbound/outbound Slack messages.

---

## 5. Configuration (`.env.local`, never commit values, never print secrets)

Block to add to `.env.example` (names only):
```
# --- Slack bot (Socket Mode; see docs/slack/SETUP.md) ---------------------------
# The adapter is registered only when SB_SLACK_BOT_TOKEN is set.
SB_SLACK_BOT_TOKEN=          # xoxb-… (Bot User OAuth Token)
SB_SLACK_APP_TOKEN=          # xapp-… (app-level token with connections:write), for Socket Mode
SB_SLACK_SIGNING_SECRET=     # only needed for the HTTP route; empty = HTTP Slack requests rejected
```
Existing tests must stay green with no Slack env set.

---

## 6. Slack app setup (the user does this; document it in `docs/slack/SETUP.md`)
1. Create a free Slack workspace for the demo (or use one where you can install apps).
2. api.slack.com/apps → **Create New App → From a manifest**, pick the workspace, paste:
   ```yaml
   display_information:
     name: Swipeback (DEMO)
     description: Send receipts, get expenses handled. Synthetic demo, simulated payouts.
   features:
     bot_user:
       display_name: swipeback
       always_online: true
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
   oauth_config:
     scopes:
       bot: [chat:write, im:history, im:read, im:write, files:read, users:read, users:read.email]
   settings:
     event_subscriptions:
       bot_events: [message.im]
     interactivity:
       is_enabled: false
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. Basic Information → **App-Level Tokens** → generate one with scope `connections:write` (`xapp-…`).
   Copy the **Signing Secret** too.
5. Put the tokens in `.env.local`. Run `corepack pnpm sb slack:connect`.
6. Link the demo employee: `corepack pnpm sb slack:link --member-email <seeded employee email> --lookup`
   (the Slack account's email must match), or pass `--slack-user U…`.
7. Start the worker and `corepack pnpm sb slack:listen`. In Slack, open the Swipeback app's Messages
   tab and send a receipt photo.

---

## 7. Tests (no network in tests)
- Adapter (`packages/channels/test/slack.test.ts`): shared contract suite; HTTP signature valid /
  tampered / stale / missing / no secret configured; wrong team → `NOT_ADDRESSED_TO_CONNECTION`;
  bot and edited messages ignored; image and PDF downloaded via a fake client and stored with correct
  sha256; HTML download response rejected; text with mentions sanitised and kept as data; injection
  text stays data; send opens the DM, posts in the right thread and maps `ts` → ids.
- Engine (`packages/engine/test/slack.test.ts`, real Postgres via `test/support`): the four threading
  cases in §4.6; the same envelope delivered 5× → one expense; unknown user quarantined with at most one
  enrolment reply; send failure leaves the message undelivered and the case reviewable; **channel
  neutrality**: the same receipt via the email fixture and via Slack gives the same decision; the socket
  loop acks before processing and survives a malformed frame.
- CLI: `slack:link` writes the right identity format and refuses non-local DBs.
- Run `corepack pnpm verify` before every commit; all existing tests must stay green. Run the §0
  conflict check before every push.

---

## 8. Definition of done
- A real photo sent in a DM to the Swipeback bot by a linked user creates an expense, is decided by the
  existing engine, and the reply arrives in that message's thread. Record the evidence (Slack `ts`,
  attachment sha256, decision, reply `ts`) in `docs/slack/SETUP.md` under "Live test results", with
  date and time. Report real results, including failures.
- All tests green; only the files in §3 changed; branch rebased on `origin/main`; the §0 conflict check
  passes against `origin/main`.
- All demo data labelled SYNTHETIC / DEMO; payouts remain simulated; nothing claims WhatsApp, Telegram
  or iMessage are live.

## 9. Pitch notes (for the team)
- Demo beat: "Finance teams already live in Slack. DM the receipt, get the answer in the thread." Same
  engine, rules and audit trail as email.
- WhatsApp, Telegram and iMessage are roadmap: "same engine, one adapter per channel". The paused
  WhatsApp branch can be mentioned as work in progress, never as live.
- Honest limits: demo enrolment is done by an admin command; a real rollout would link Slack users via
  their verified work email and an admin approval. Approvals stay in the authenticated web app on purpose.
