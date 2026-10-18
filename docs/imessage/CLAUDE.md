# iMessage via BlueBubbles — instructions for Claude Code (3-hour sprint)

You are working on the `bluebubbles-imessage` branch of **Swipeback** (SotonShip 2026, FinTech track).
Your job: let an enrolled employee **iMessage a receipt photo or PDF to a Mac running the BlueBubbles
server**, and have Swipeback process it through the existing engine and reply in the same iMessage chat.

**Time-box (hard, revised: it is ~11:20 on Sun 18 Oct 2026; submissions lock 13:00 BST, code freeze 12:45):**
- **11:20-11:35 Build in parallel with Mac prep.** The human is setting up the Mac/BlueBubbles server at the same time. Start on the parts that do not need the live server (§3 files, tests against a fake client).
- **Spike (§4) must be done by 11:50.** If real messages and attachments cannot be read from the BlueBubbles server by then, finish the fake-client version, mark iMessage "implemented, not live-verified", and stop.
- **Hard cut-off for code: 12:25.** Whatever state it is in, stop adding features then and run `corepack pnpm verify`.
- **12:30: the human and Taran decide whether to merge.** Nothing merges after the 12:45 freeze.
- **You never merge and never open a PR.** Do not let this delay or touch anything on `main`.
- **Priority if time runs out:** (1) text-only and photo receipts inbound + a text reply, (2) PDF, (3) everything else. Cut docs polish before code, never cut tests.

**Read first:** `README.md`, `docs/HANDOFF.md` (§1, §4, §5), `docs/slack/SETUP.md`. The rules in
`docs/HANDOFF.md` §1 ("Non-negotiable product rules") override anything below. **Slack is already on
`main`** (`packages/channels/src/slack/*`, `packages/engine/src/slack*.ts`, `tools/cli/src/slack-commands.ts`):
copy its structure. **Do not modify any Slack file.**

---

## Start here: set up the branch (do this first, once)

Never commit to `main`, never push to `main`, never merge. Never touch `slack-integration`,
`whatsapp-integration`, `encryption-at-rest` or any other branch.

1. `git remote get-url origin` must point to `github.com/36taransingh5-dotcom/swipeback`. If not, stop and ask.
2. `git status --porcelain`: if anything is listed, **stop and ask the user** (do not stash, reset or commit it).
3. ```bash
   git fetch origin
   git ls-remote --heads origin bluebubbles-imessage
   ```
   - **Exists:** `git switch bluebubbles-imessage` (or `git switch -c bluebubbles-imessage --track origin/bluebubbles-imessage`), then `git pull --rebase`. Skip to step 5.
   - **Does not exist:** `git switch -c bluebubbles-imessage origin/main`
4. Add this file at `docs/imessage/CLAUDE.md`, commit and push the branch only:
   ```bash
   mkdir -p docs/imessage
   cp <path-the-user-gave>/CLAUDE.md docs/imessage/CLAUDE.md
   git add docs/imessage/CLAUDE.md
   git commit -m "iMessage (BlueBubbles) plan for Claude Code (branch only, not for main yet)"
   git push -u origin bluebubbles-imessage
   ```
5. Confirm `git branch --show-current` prints `bluebubbles-imessage`. Tell the user, then continue.

Later sessions: `git fetch origin && git rebase origin/main` first; `git push` (`--force-with-lease` only after a rebase, only on this branch).

**Machine note:** this may be a different computer from earlier. If the repo is not cloned, `git clone https://github.com/36taransingh5-dotcom/swipeback`, then `corepack enable && corepack pnpm install`, and copy `.env.example` to `.env.local` (ask the human for values; never print secrets). Postgres must be running for engine tests (see `docs/HANDOFF.md`). If something cannot be set up in 10 minutes, tell the human instead of improvising.

---

## 0. Avoid merge conflicts

1. **New code goes in new files** (§3). Edits to existing files are one-line additions at the exact anchors in §3. Never reformat, reorder or "tidy".
2. **Do not touch:** `README.md` and any existing doc; `docs/slack/**`, `docs/whatsapp/**`, `docs/security/**`; any `**/slack*` or `**/whatsapp*` file; `apps/web/**` and `apps/worker/**`; `packages/db/**` (**no migrations**); `packages/extraction/**`; `packages/domain/**`; `eval/**`; shared test fixtures; `package.json` / `pnpm-lock.yaml` (**no new dependencies**: use Node 24 `fetch` and `node:crypto`).
3. `'imessage'` is already allowed in `CHANNELS`, in `channel_connections.channel` / `channel_identities.channel`, and `REQUIRED_AUTH.imessage = ['platform_signed']` in `inbound.ts`. Do not edit those.
4. **Conflict check before every push** (git ≥ 2.38): `git fetch origin && git merge-tree --write-tree origin/main HEAD >/dev/null && echo "OK vs main"`. It must pass.
5. Commit in small steps, each after `corepack pnpm verify` is green.

---

## 1. Design (decided: read this, do not redesign)

**No inbound webhook.** BlueBubbles can POST webhooks, but they carry no signature, and the generic
`/api/inbox/:connectionId` route does not pass the query string to `verifyInbound`, so a webhook would be
unauthenticated. Instead the engine **polls** the BlueBubbles server over its authenticated REST API,
exactly like Slack's `slack:listen` runs a socket. Consequences: no tunnel, no public URL, no web or worker
change, and nothing on the network can inject a message into Swipeback.

- **Transport authentication:** the BlueBubbles server URL and password (env). Messages fetched this way
  are `senderAuth = 'platform_signed'` (the trusted-transport path, like `fromSocketEnvelope` in Slack).
- **`verifyInbound` (the HTTP path) must always throw `BAD_SIGNATURE`.** There is no HTTP ingress for this channel.
- **Never ingest history.** On first run the cursor starts at "now". The cursor (last seen message date or
  row id) is persisted in a small JSON file under `SB_DATA_DIR` (default `.data/imessage-cursor.json`); no
  database change. On restart, resume from it. Dedupe is also by message guid, so replays are harmless.
- **Accept only:** 1:1 chats (not groups), `isFromMe = false`, service iMessage (ignore SMS/RCS: those
  sender ids are spoofable), a sender handle that is linked to a member (unknown senders still go through
  the engine's normal quarantine path, with the engine's one-reply rule).
- **Channel address:** `imessage:<handle lower-cased>` where the handle is an E.164 phone number or an Apple
  ID email. One helper `imessageChannelAddress(handle)` builds it everywhere (trim, strip spaces and dashes
  in phone numbers, lower-case).
- **Provider:** channel `'imessage'`, provider `'bluebubbles'`, connection `address` = the BlueBubbles
  server's Apple ID or number (a label from env), `capabilities = { attachments: true, threading: false,
  interactiveActions: false, deliveryReceipts: false, businessInitiatedMessages: 'none' }`.
- **Replies:** plain text into the same chat (`chatGuid`), sent via AppleScript (no Private API). The user
  must message first, so the chat already exists. `threadId = 'imessage:<chatGuid>'`.
- **Correlation of a text reply to an open question:** use `findOpenQuestion` as is. One chat per person
  means: a text-only message answers the single open question; a message with an attachment is a new
  expense; with **two** open questions a bare text reply is not guessed, and goes to finance.
- **Fail closed:** a download failure creates no expense without evidence (audit it); unsupported content
  is ignored; a send failure uses the existing outbox retry and dead-letter.

---

## 2. What already exists (do not rebuild)
`packages/channels/src/contract.ts` (`ChannelAdapter`, `InboundMessageV1`, `RawInbound`, `VerifiedInbound`,
`InboundRejectedError`, `OutboundEnvelope`, `SendResult`), `slack/adapter.ts` + `slack/web-api.ts` +
`slack/payload.ts` + `packages/channels/test/slack.test.ts` (pattern: injectable `fetch`, zod schemas,
attachment download → `normaliseMime` → `screenAttachment` → `evidence.put`, `dedupeKeyFor`,
`sanitiseUntrustedText`, `sanitiseShort`, the shared contract suite), `packages/engine/src/slack.ts`
(`slackAdapterFromEnv`, `receiveSlackEvent`, `runSlackSocket`: copy the shape of the loop, retries and
abort handling), `packages/engine/src/inbound.ts` (`ingestInbound`, `loadConnection`, `findOpenQuestion`),
`outbox.ts`, `runtime.ts`, `tools/cli/src/slack-commands.ts` (connect/link/listen/status pattern).

---

## 3. Files

**New files:**

| File | Purpose |
|---|---|
| `packages/channels/src/imessage/bluebubbles-client.ts` | Thin REST client: ping, query new messages, download attachment, send text. Injectable `fetch`. Password in a header or query as the server requires, never logged |
| `packages/channels/src/imessage/payload.ts` | zod schemas for the message objects as the server really returns them (from the spike), `.passthrough()` |
| `packages/channels/src/imessage/adapter.ts` | `BlueBubblesAdapter implements ChannelAdapter` + `fromBlueBubblesMessage()` + `imessageChannelAddress()` |
| `packages/channels/src/imessage/fixtures/*.json` | Real payloads recorded in the spike, **with phone numbers, emails and names replaced by fakes** |
| `packages/channels/test/imessage.test.ts` | Adapter tests |
| `packages/engine/src/imessage.ts` | `bluebubblesAdapterFromEnv`, `receiveBlueBubblesMessage`, `runBlueBubblesPoller` |
| `packages/engine/test/imessage.test.ts` | End to end on real Postgres with a fake BlueBubbles client |
| `tools/cli/src/imessage-commands.ts` | `imessage:connect`, `imessage:link`, `imessage:listen`, `imessage:status` |
| `tools/cli/test/imessage-commands.test.ts` | CLI tests |
| `docs/imessage/SETUP.md` | Mac and BlueBubbles setup, demo runbook, live test results |

**Existing files: one-line additions only, directly after the anchor line** (all verified present and unique on `origin/main`; re-check before editing):

| File | Anchor line | Line(s) to add |
|---|---|---|
| `packages/channels/src/index.ts` | `export * from './slack/web-api.ts';` | `export * from './imessage/adapter.ts';` and `export * from './imessage/bluebubbles-client.ts';` |
| `packages/engine/src/index.ts` | `export * from './slack-commands.ts';` | `export * from './imessage.ts';` |
| `packages/engine/src/runtime.ts` (import) | `import { slackAdapterFromEnv } from './slack.ts';` | `import { bluebubblesAdapterFromEnv } from './imessage.ts';` |
| `packages/engine/src/runtime.ts` (setup) | `  const slack = slackAdapterFromEnv(env, evidence);` | `  const bluebubbles = bluebubblesAdapterFromEnv(env, evidence);` |
| `packages/engine/src/runtime.ts` (registry) | `      ...(slack ? [slack] : []),` | `      ...(bluebubbles ? [bluebubbles] : []),` |
| `tools/cli/src/main.ts` (import) | `import { slackCommands } from './slack-commands.ts';` | `import { imessageCommands } from './imessage-commands.ts';` |
| `tools/cli/src/main.ts` (map) | `  ...slackCommands,` | `  ...imessageCommands,` |
| `.env.example` | `SB_SLACK_SIGNING_SECRET=     # only needed for the HTTP route; empty = HTTP Slack requests rejected` | a blank line, then the block in §5 |

---

## 4. Spike first (20 minutes; this decides whether to continue)

The BlueBubbles API details are **not confirmed**. Do not code from memory. With the user's server running
(§6), against the real server:
1. Ping it. List chats. Note the exact auth mechanism (the docs say a `guid`/`password` query parameter) and the REST docs at `https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks` and the server's Postman collection.
2. Have the user send a **text** and then a **photo** and a **PDF** from their iPhone. Query for new messages and record the raw JSON (message guid, date field and its unit, `isFromMe`, handle, chat guid, service, attachments with guid, mime type and file name).
3. Download one attachment and check its bytes and mime type (HEIC photos are likely).
4. Send one text reply into that chat via the REST API and confirm it arrives on the phone.
5. Save sanitised copies as fixtures (§3). Write a 10-line summary of the real shapes in `docs/imessage/SETUP.md`.
If any of steps 2-4 cannot be done by **11:50**, stop the live work, keep the fake-client build, and tell the user exactly what failed.

---

## 5. Configuration (`.env.local`, never commit values, never print secrets)

```
# --- iMessage via BlueBubbles (see docs/imessage/SETUP.md) ---------------------
# The adapter is registered only when SB_BLUEBUBBLES_URL is set.
SB_BLUEBUBBLES_URL=          # e.g. http://localhost:1234 (the BlueBubbles server)
SB_BLUEBUBBLES_PASSWORD=     # the server password
SB_BLUEBUBBLES_LABEL=        # the bot's Apple ID or number, used as the connection address
```
Existing tests must stay green with none of these set.

---

## 6. Mac and phone setup (the user does this; document it in `docs/imessage/SETUP.md`)
1. On the Mac: sign into **Messages** with a **dedicated Apple ID** (not a personal one). Send one test iMessage to confirm it works.
2. Install the BlueBubbles server from `bluebubbles.app`. Give it **Full Disk Access** when asked. Set a server password. Skip the Private API. If the setup wizard insists on something else, tell the user.
3. Keep the Mac awake for the whole demo: run `caffeinate -dimsu` in a terminal and leave the lid open.
4. Put the server URL, password and the bot's Apple ID in `.env.local`.
5. The sending phone must use a **different Apple ID**. It should text the bot's address first.
6. `corepack pnpm sb imessage:connect`, then `corepack pnpm sb imessage:link --member-email <seeded employee email> --handle <the iPhone's number or Apple ID email>`, then start the worker and `corepack pnpm sb imessage:listen`.

---

## 7. Tests (no network)
- Adapter: shared contract suite; fixtures parse; own messages, group chats, SMS, reactions and empty messages are ignored; `verifyInbound` always throws `BAD_SIGNATURE`; address normalisation (`+44 7700 900123` → `imessage:+447700900123`); image, HEIC and PDF downloaded via a fake client and stored with the right sha256; an HTML or error response is rejected; injection text stays data; send uses the right `chatGuid`; the password never appears in an error.
- Poller: starts at "now" (no history); resumes from the saved cursor; the same message seen twice → one expense; survives a malformed message and a server outage (backoff) and stops cleanly on abort.
- Engine (real Postgres via `test/support`): a receipt → decision → reply; a text answer to a single open question; a new photo while a question is open → a new expense; unknown sender quarantined with at most one reply; download failure → no expense, audited; send failure leaves the case visible to finance; same decision as the email fixture for the same receipt.
- CLI: `imessage:link` writes the right identity format and refuses non-local databases; output masks phone numbers.
- `corepack pnpm verify` must be green before every commit.

---

## 8. Definition of done
- A real photo iMessaged from a linked phone to the bot creates an expense, is decided by the engine, and the reply arrives in that chat. Record the evidence (message guid, attachment sha256, decision, reply guid) in `docs/imessage/SETUP.md` under "Live test results", with date and time. Report real results, including failures.
- **If it was not live-tested, say so there and mark iMessage "implemented, tested against a fake BlueBubbles client, not live-verified".**
- All tests green; only the files in §3 changed; rebased on `origin/main`; the §0 conflict check passes.
- All demo data labelled SYNTHETIC / DEMO; payouts remain simulated. Do not claim iMessage is live in any doc until a real test passed.
- Mask phone numbers in all CLI output and logs. Never print the BlueBubbles password.

## 9. Pitch notes
- Demo beat: "Text the receipt like you'd text a friend." Same engine, rules and audit trail as email.
- Honest limits: it runs through a Mac signed into Messages, not through Apple's business messaging; enrolment is a demo admin command; approvals stay in the web app; users must text the bot first; the Mac must stay awake.
