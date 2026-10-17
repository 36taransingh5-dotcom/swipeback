# WhatsApp setup and demo runbook

Swipeback can take a receipt photo or PDF sent on WhatsApp, run it through the same engine as email
(same rules, same audit trail) and reply in the same chat. This is **synthetic demo data on Meta's
free test number**: nothing here is a production WhatsApp Business deployment, and payouts stay
simulated.

Branch: `whatsapp-integration`. Design notes: `docs/whatsapp/CLAUDE.md`.

## What it does and does not do

| In scope | Out of scope |
|---|---|
| Linked employee sends an image (JPEG/PNG/WebP) or PDF, optional caption | Card-swipe receipt chasing (stays on email) |
| Status, one follow-up question, "sent to finance", "reimbursed (simulated)" replies, plain text | Buttons, approvals or payments over WhatsApp (approval stays in the reviewer web app) |
| Plain-text answer to an open question ("What was this for?") | Templates / business-initiated messages, Slack, Telegram, iMessage |
| Unknown numbers are quarantined; at most one polite enrolment reply per day | Real self-enrolment (demo uses `whatsapp:link`, labelled as demo enrolment) |

## 1. Meta side (you do this once)

1. developers.facebook.com -> create an app (type **Business**) -> add the **WhatsApp** product.
2. Use Meta's **free test number**. Copy its **Phone number ID** (not the phone number itself).
3. Create a **system user token** with WhatsApp permissions. The quick "temporary access token" on
   the API setup page **expires after about 24 hours**: refresh it before the demo.
4. Add the team's phones as **allowed recipient numbers** for the test number (Meta sends a code to
   each phone to confirm).
5. Copy the **App secret** (App settings -> Basic). It signs every webhook (`x-hub-signature-256`).
6. Choose a **verify token**: any random string, e.g. `openssl rand -hex 16`.

## 2. Local configuration (`.env.local`, never committed, never printed)

```
SB_WHATSAPP_ACCESS_TOKEN=        # system-user token
SB_WHATSAPP_PHONE_NUMBER_ID=     # the test number's Phone number ID
SB_WHATSAPP_APP_SECRET=          # Meta app secret
SB_WHATSAPP_VERIFY_TOKEN=        # the string you chose in step 6
SB_PUBLIC_BASE_URL=              # your tunnel URL, e.g. https://abc.ngrok-free.app (only used to print the callback URL)
# SB_WHATSAPP_GRAPH_VERSION=v23.0  # optional; default v23.0. Check Meta's docs and bump if it is retired.
```

The adapter only starts when the access token, phone number ID and app secret are all set. Without
them Swipeback behaves exactly as before.

## 3. Run it

```bash
corepack pnpm db:start                  # terminal 1: local Postgres
corepack pnpm sb db:migrate && corepack pnpm seed
corepack pnpm web                       # terminal 2: http://127.0.0.1:3000
corepack pnpm worker                    # terminal 3: processes receipts and sends replies
ngrok http 3000                         # terminal 4 (or a Cloudflare Tunnel). Prefer a fixed URL: a new URL must be re-entered in Meta
```

Put the tunnel URL in `SB_PUBLIC_BASE_URL`, then:

```bash
corepack pnpm sb whatsapp:connect
```

It creates the connection (idempotent) and prints `Callback URL for Meta: <base>/api/whatsapp/<id>`.

In Meta: WhatsApp -> Configuration -> Webhook -> **Edit**, paste the callback URL and your verify
token, **Verify and save**, then **subscribe to the `messages` field**.

Link a phone to a seeded employee (DEMO enrolment, local database only):

```bash
corepack pnpm sb whatsapp:link --member-email sam.taylor@northwind.example --phone +447700900123
```

Check state any time with `corepack pnpm sb whatsapp:status`.

## 4. Demo script

1. From the linked phone, WhatsApp a receipt photo (or PDF) to the test number.
2. Within seconds the reply arrives in the same chat. An in-policy personal receipt is cleared and
   "paid" (simulated). A receipt with no business purpose gets **one** question: answer in plain text.
3. Open the reviewer app to show the case and its audit trail. Same engine, same rules, same trail as email.
4. Pitch beat: "Paid with your own money? Just WhatsApp the receipt."

## 5. How it behaves (and honest limits)

- **Security.** Every webhook is verified by HMAC-SHA256 of the raw body with the app secret before it
  is parsed; wrong signature, wrong phone number ID or a malformed body is rejected and audited, and
  nothing is ingested. The sender's number is the identity (display names are never used). Captions and
  text are untrusted data. Media is checked against Meta's sha256 and stored as immutable evidence.
- **Retries.** A media download failure returns 5xx so Meta retries; the dedupe key makes retries safe
  (the same webhook delivered five times creates one expense). An expense is never created without its evidence.
- **Threading.** WhatsApp has no subject or reply address, so correlation is by thread: replies are
  filed under one per-chat thread and a text-only message arrives on it, so a plain-text answer finds the
  open question. A message with media gets its own thread, so a new receipt becomes a new expense and is
  never swallowed as the answer. Consequences: with several open questions a plain-text answer goes to the
  newest one, and a photo cannot answer a "please send the receipt" question.
- **24-hour window.** Free-form replies are only allowed within 24 hours of the user's last message
  (Meta error 131047). A failed send is recorded and retried, then stays visibly undelivered, and the case
  remains in the reviewer queue. Follow-ups after a day therefore fall back to finance review. There are no templates.
- **Email-only paths.** Card-swipe receipt chases and reviewer notifications are email only.
- **Media host allowlist.** The bearer token is sent only to https hosts ending `.facebook.com`,
  `.fbsbx.com`, `.fbcdn.net` or `.whatsapp.net`. If a real download fails with "no usable download url",
  Meta has served media from another host: add it in `packages/channels/src/whatsapp/graph-api.ts`.
- **Real enrolment** would verify the phone number with a code sent to the work email; the demo link command does not.

## 6. Tests

```bash
corepack pnpm verify
```

No network is used in tests: the Graph API is faked. Covered: the shared channel contract suite, signature
checks, batches, media and sha256, injection text staying data, send request shape, the three threading
cases, redelivery x5, unknown numbers, send failure, channel neutrality (email vs WhatsApp give the same
decision), the webhook routes, and the CLI commands.

On Windows, 11 tests in `packages/domain/test/purity-lint.test.ts` fail on a clean checkout of `main`
(the test builds an ESLint path with `new URL(...).pathname`, which is wrong on Windows). They are
unrelated to WhatsApp and pass on Linux/macOS.

## Live test results

_Not yet run._ Record here, with date and time, for each real test: inbound message id (wamid),
attachment sha256, the decision, and the outbound wamid. Report failures too.

| Date/time (BST) | Inbound wamid | Attachment sha256 | Decision | Outbound wamid | Notes |
|---|---|---|---|---|---|
| | | | | | |
