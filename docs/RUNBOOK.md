# Demo runbook (PRD §11 storyboard)

Everything on screen is a **SYNTHETIC DEMO**: fictitious people, cards and receipts; payouts are **simulated** (MockPay), and no money moves. Say so out loud once at the start. Never present a replay or a recording as live.

Two ways to run it:

- **Live** (the plan): real Gmail mailbox, real gpt-5.5 calls, receipts sent from a phone.
- **Offline fallback** (no network, or Gmail or OpenAI down): the same engine, using the fixture email transport and recorded gpt-5.5 responses. Announce it as "offline replay of recorded model responses".

Both paths were rehearsed on 17 Oct (offline in full; live receipt round trips are still pending, see `docs/HANDOFF.md` §3).

## Pre-flight (T−30 min)

```bash
git pull && corepack pnpm install && corepack pnpm verify      # all green, or stop and fix
corepack pnpm db:start                                         # own terminal; leave running
corepack pnpm demo:reset                                       # ~2 s; keeps the Gmail connection
corepack pnpm worker                                           # own terminal: "extractor=openai", "Gmail polling"
corepack pnpm web                                              # own terminal: http://localhost:3000
```

Then check:

1. `.env.local` has `SB_RECEIPT_GRACE_MINUTES=1` (the card-swipe chase fires after about a minute) and `SB_EXTRACTOR=llm` with `SB_LLM_PROVIDER=openai`.
2. The `demo:reset` output says **"Kept Gmail connection: swipeback.finance@gmail.com"**. If it says "No Gmail connection kept", sign in as the reviewer, open `/connect` and connect it now (needs the finance mailbox's Google password).
3. Signed in as the reviewer (`techediting5@gmail.com`) in the browser, with `/review` open in one tab. The magic link arrives in that inbox.
4. The phone's mail app is signed in as the employee (`36taransingh5@gmail.com`), with these photos ready: `eval/demo-receipts/shell-watford-58.40-card-4242.jpg`, `eval/demo-receipts/trainline-42.10-personal-card.jpg`, and one over-cap or no-purpose receipt (`eval/datasets/heldout/h09.jpg` is a £46.20 pub lunch over the £35 cap; `h01.jpg` is a Greggs breakfast with no purpose).
5. The eval report is open: `eval/reports/pipeline-heldout-2026-10-17T13-16-08-930Z.md` and `docs/EVALUATION.md`.
6. Rehearse once with a receipt you haven't used yet, then `corepack pnpm demo:reset` again.

## Storyboard

| Time | On stage | What should happen | Real path |
|---|---|---|---|
| 0:20 | `corepack pnpm sb card-sim --amount 58.40 --merchant "SHELL WATFORD 123" --card 4242` | Swipe accepted (SYNTHETIC). After about 60 s, the employee's phone gets **"Receipt needed: GBP 58.40 at SHELL WATFORD 123 on … [SB-1001]"** from the finance mailbox | Signed card webhook → card-led expense → `receipt-chase` job → Gmail send |
| 0:50 | Reply to that email from the phone, attaching the Shell photo | In the same thread: **"Matched to your company-card transaction … and cleared. Company-card spend is never reimbursed."** Finance touched nothing | Gmail poll → gpt-5.5 extraction → receipt must agree with the swipe → policy CLEAR → exported, 0 reimbursements |
| 1:15 | New email from the phone with the Trainline photo, subject "Train" | Reply: **"Reimbursed (simulated)"**, with a `SIMULATED-MP-…` reference | Payment type PERSONAL → deterministic auto-authorisation (≤ £150) → MockPay, exactly once |
| 1:50 | Email `h09.jpg` with "Purpose: team lunch after the commissioning" | Employee reply: **"With finance for review"**. The reviewer gets **"[SB-…] Review needed"** with a sign-in-required link. Open it, show the clause (NW-2, £35 meal cap) and the evidence quotes, then approve with a reason | LIMIT finding → HUMAN_REVIEW → one-time challenge → authenticated decision → audit |
| | *(alternative)* Email `h01.jpg` with no purpose | **One question**: "What was the business purpose?" Reply in the thread → paid. A non-answer like "ok thanks" goes to finance and is never re-asked | INFO finding → single question → resume under the same policy version |
| 2:20 | Show `docs/EVALUATION.md` | Held-out: blind run 27/29 with 1 false payout (found and fixed); after the fix 28/29, 0 false auto-clears, 0 false payouts; autonomy 14/29; $0.03 per expense; known misses listed | `eval/reports/pipeline-heldout-*.json`, `GET /api/evaluations/report` |
| 2:40 | Economics + concept render (labelled as a concept) | Pricing hypothesis: £99/workspace/month + £0.30/expense | — |

The reviewer screen only appears in the exception beat. The product is the email thread.

## Offline fallback (announce it)

Use this when there's no network, Gmail or OpenAI is down, or the Gmail token expired and can't be re-consented. It uses the same engine and database; only the transport (fixture `.eml` instead of Gmail) and the model (recorded gpt-5.5 responses) change. The employee is the seeded synthetic address.

```bash
export SB_EXTRACTOR=openai SB_CASSETTES=replay SB_OPENAI_API_KEY=replay-only
corepack pnpm demo:reset && corepack pnpm sb connect:fixture
S=sam.taylor@northwind.example; H=eval/datasets/heldout
corepack pnpm sb card-sim --amount 61.27 --merchant "ESSO WATFORD WAY LONDON" --at 2026-10-17T07:14:00Z
corepack pnpm sb email --from $S --subject Fuel --attach $H/h03.jpg                 # matched, cleared, no payout
corepack pnpm sb email --from $S --subject Train --attach $H/h16.jpg                # SIMULATED_PAID
corepack pnpm sb email --from $S --subject Breakfast --attach $H/h01.jpg            # one question
corepack pnpm sb reply --from $S --text "Breakfast with the Hertford site crew"     # answered in thread -> paid
corepack pnpm sb email --from $S --subject "Team lunch" --text "Purpose: Team lunch after the St Albans commissioning" --attach $H/h09.jpg   # review
corepack pnpm sb email --from $S --subject "Train again" --attach $H/h16.jpg        # duplicate: no new expense
corepack pnpm sb expenses && corepack pnpm sb audit:verify
```

The outgoing emails are written to `.data/outbox/*.eml`. To open the review email's link, sign in at `/login` as `finance.controller@northwind.example` (the magic link is also written to `.data/outbox`). Only the held-out images have recorded responses; any other photo fails closed to review offline, which is the correct behaviour. Text receipts in `eval/demo-receipts/*.txt` work with no model at all (`SB_EXTRACTOR=baseline`).

## If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| `/review` shows "finance mailbox needs reconnecting" | Gmail refresh token expired (Testing-mode tokens last ~7 days) | `/connect` → reconnect, or switch to the offline fallback |
| No reply within ~30 s | Worker not running, or poll lag | Check the worker terminal; `corepack pnpm sb jobs:stats`; `corepack pnpm sb expenses` |
| Reply says "with finance for review" when you expected a clear | The engine failed closed (unclear photo, model error or timeout) | Say so: that's the safety property. Open the case and show the reason |
| No "Receipt needed" email after a swipe | Grace period is longer than 1 min, or there's no connected mailbox | Check `SB_RECEIPT_GRACE_MINUTES`; `corepack pnpm sb jobs:stats` shows the queued `receipt-chase` |
| Anything else | | Play the recorded genuine run, announced as a recording |

Between rehearsals: `corepack pnpm demo:reset` (about 2 s, with the worker still running). It keeps the Gmail connection and its history cursor, so mail from earlier rehearsals is not re-read.
