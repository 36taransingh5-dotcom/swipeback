# iMessage via BlueBubbles — setup and demo runbook

**Status: implemented, tested against a fake BlueBubbles client, not live-verified.** The REST
shapes below follow the published BlueBubbles docs; the spike against a real server (plan §4) has
not been run yet, so field names may need adjusting on first contact with a live server.

## How it works

No inbound webhook. BlueBubbles can POST webhooks, but they carry no signature, so the engine
**polls** the BlueBubbles server over its password-authenticated REST API instead — the same
trusted-transport pattern as Slack's Socket Mode. Consequences: no tunnel, no public URL, and
nothing on the network can inject a message into Swipeback. `verifyInbound` (the HTTP path) always
rejects with `BAD_SIGNATURE`.

- The poller starts at "now" (never ingests history) and persists a cursor at
  `SB_DATA_DIR/imessage-cursor.json` (default `.data/imessage-cursor.json`). Dedupe is by message
  guid, so replays are harmless.
- Accepted: 1:1 chats only (group chats ignored), `isFromMe = false` (anti-loop), iMessage service
  only (SMS/RCS ignored — their sender ids are spoofable), tapbacks/reactions ignored.
- Sender identity: `imessage:<handle lower-cased>` where the handle is an E.164 phone number or an
  Apple ID email (`+44 7700 900123` → `imessage:+447700900123`). Display names are never read.
- One chat per person, no threading: a text-only message answers the chat's single open question; a
  message with an attachment is always a new expense (it carries no thread id, so it is never
  guessed as an answer).
- Replies are plain text sent into the same chat via AppleScript (no Private API). Approvals stay
  in the authenticated web app; iMessage only points to the review URL.
- Fail closed: a failed attachment download creates no expense (audited, retried by the poller);
  a send failure uses the existing outbox retry and dead-letter.

## Mac and phone setup (a person does this)

1. On the Mac: sign into **Messages** with a **dedicated Apple ID** (not a personal one). Send one
   test iMessage to confirm it works.
2. Install the BlueBubbles server from `bluebubbles.app`. Give it **Full Disk Access** when asked.
   Set a server password. Skip the Private API.
3. Keep the Mac awake for the whole demo: `caffeinate -dimsu` in a terminal, lid open.
4. Put the server URL, password and the bot's Apple ID in `.env.local`:
   ```
   SB_BLUEBUBBLES_URL=http://localhost:1234
   SB_BLUEBUBBLES_PASSWORD=<the server password>
   SB_BLUEBUBBLES_LABEL=<the bot's Apple ID or number>
   ```
5. The sending phone must use a **different Apple ID** and must text the bot first.
6. Enrol (demo admin shortcut, local DB only):
   ```
   corepack pnpm sb imessage:connect
   corepack pnpm sb imessage:link --member-email <seeded employee email> --handle <the iPhone's number or Apple ID email>
   ```
   then start the worker (`corepack pnpm worker`) and `corepack pnpm sb imessage:listen`.
   `corepack pnpm sb imessage:status` shows the connection, linked handles (masked) and recent traffic.

## REST shapes used (from the BlueBubbles docs; confirm on the live server)

- Auth: `?password=<server password>` query parameter on every call.
- `GET /api/v1/ping` — liveness.
- `POST /api/v1/message/query` — body `{ limit, offset, after: <epoch ms>, sort: 'ASC',
  with: ['chats','chats.participants','handle','attachments'] }`, returns `{ data: Message[] }`.
- Message fields read: `guid`, `text`, `dateCreated` (epoch **ms**), `isFromMe`, `service`
  (`'iMessage'` required), `handle.address`, `chats[0].guid` / `.style` (45 = group) /
  `.participants`, `attachments[].{guid,mimeType,transferName,totalBytes}`,
  `associatedMessageGuid` / `associatedMessageType` (tapbacks).
- `GET /api/v1/attachment/:guid/download` — bytes (HEIC likely for photos).
- `POST /api/v1/message/text` — body `{ chatGuid, message, method: 'apple-script' }`,
  returns `{ data: { guid } }`.
- 1:1 chat guid convention: `iMessage;-;<handle>`.

## Live test results

Not run. No live BlueBubbles server was available before the code freeze. All tests run against a
fake BlueBubbles client (`packages/channels/test/imessage.test.ts`,
`packages/engine/test/imessage.test.ts`). Do not claim iMessage is live until a real phone → Mac →
engine → reply round trip has been recorded here with the message guid, attachment sha256, decision
and reply guid.

## Demo data

All demo data is SYNTHETIC / DEMO; payouts remain simulated. Enrolment via `imessage:link` is a
demo admin command, not verified identity proof. Phone numbers are masked in CLI output and audit.
