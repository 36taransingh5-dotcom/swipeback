# Slack setup and demo runbook

Send a receipt photo or PDF to the Swipeback bot in a Slack direct message; Swipeback processes it
with the same engine, rules and audit trail as email and replies **in a thread under your message**.

> **SYNTHETIC DEMO.** Demo data only, payouts are simulated, and no real money moves. Approvals stay
> in the authenticated web reviewer app, never in Slack. WhatsApp, Telegram and iMessage are roadmap,
> not live.

Slack uses **Socket Mode**: the bot receives events over an outbound WebSocket, so no public URL or
tunnel is needed.

## 1. Create the Slack app

1. Use a free demo workspace (or one where you may install apps).
2. <https://api.slack.com/apps> → **Create New App → From a manifest**, pick the workspace, paste:

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

3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App-Level Tokens** → generate one with scope `connections:write`
   (`xapp-…`). Copy the **Signing Secret** too (only used by the HTTP route).

## 2. Configure

Put the tokens in `.env.local` (never commit them; the CLI never prints them):

```
SB_SLACK_BOT_TOKEN=xoxb-…
SB_SLACK_APP_TOKEN=xapp-…
SB_SLACK_SIGNING_SECRET=…        # optional
```

Without `SB_SLACK_BOT_TOKEN` the Slack adapter is not registered and nothing else changes.

## 3. Connect and link (local database only)

```bash
corepack pnpm db:start            # separate terminal, if the local database is not already running
corepack pnpm sb db:migrate
corepack pnpm sb seed
corepack pnpm sb slack:connect
corepack pnpm sb slack:link --member-email sam.taylor@northwind.example --lookup
```

- `--lookup` finds the Slack user by email, so the Slack account's email must match the seeded
  employee's. Otherwise pass `--slack-user U0123ABCD` (profile → ⋮ → *Copy member ID*).
- `slack:link` is a **demo enrolment** done by an admin command and is refused on non-local
  databases. A real rollout would link Slack users through their verified work email plus an
  admin approval.

## 4. Run it

Two terminals:

```bash
corepack pnpm worker              # processes jobs and delivers replies
corepack pnpm sb slack:listen     # Socket Mode listener; Ctrl+C to stop
```

In Slack open the **Swipeback (DEMO)** app → **Messages** tab and send a receipt photo or PDF.
`corepack pnpm sb slack:status` shows the connection, linked users and the latest messages in and out.

## How it behaves

- **Reply location:** every reply goes in a thread under the message that started the case.
  Follow-up questions end with "Reply in this thread."
- **Answers:** a text reply inside that thread answers the open question. An answer posted at top
  level is **not** guessed onto an expense: the question stays open, nothing is auto-cleared, and the
  existing reminder and expiry flow hands the case to finance.
- **New receipt:** a new top-level receipt while a question is open is a new expense.
- **Unknown Slack user:** quarantined; at most one enrolment reply per day.
- **Ignored:** bot messages (including our own replies), edits, deletions, channel messages,
  reactions and empty messages. Only direct messages are handled.
- **Fail closed:** a failed or HTML file download creates no expense; the listener retries the
  event. A failed send is recorded on the outbound message and the case stays visible to finance.
- **Wording:** the shared question templates say "reply to this email". In Slack the "Reply in this
  thread." line follows them. Fixing the wording belongs in `templates.ts` on `main`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `slack:connect`: `invalid_auth` | Wrong or revoked `xoxb-` token. |
| `slack:link --lookup`: no user | Slack account email differs from the member's email; use `--slack-user`. |
| Listener logs `invalid_auth` / `not_allowed_token_type` | `SB_SLACK_APP_TOKEN` must be the `xapp-` token with `connections:write`. |
| Listener logs `file_download_returned_html` | Missing `files:read` scope or wrong bot token; reinstall the app after changing scopes. |
| Message sent, no reply | Worker not running, or the Slack user is not linked (check `slack:status`; unknown users get one enrolment reply). |
| Nothing arrives | The app's `message.im` event and Messages tab must be enabled (re-check the manifest). |

## Live test results

_Not yet run._ Record here, with date and time, after a real photo is sent in a DM by a linked user:

| Item | Value |
|---|---|
| Date / time (BST) | |
| Slack message `ts` | |
| Attachment sha256 | |
| Decision | |
| Reply `ts` | |
| Notes / failures | |
