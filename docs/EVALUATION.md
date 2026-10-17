# End-to-end evaluation (M6, PRD §10, AC-12)

Every case is a scenario played through the real engine: signed card webhooks and RFC 5322 emails enter through the same intake as production; then extraction, card matching, the deterministic policy, follow-up questions, reminders, timeouts and the simulated payout all run on a fresh Postgres database per case. The expected outcome of each case comes from the written demo policy (`tools/cli/src/demo-policy.ts`), not from what the code does. Scoring code only compares; it cannot change an outcome.

- Cases: `tools/cli/src/eval/pipeline-cases.ts`. **29 held-out** (`ph01`–`ph29`), built around the 24 frozen held-out receipt images, and **25 tune** (`pt01`–`pt25`), built on synthetic text e-receipts.
- The held-out cases were frozen by checksum (`eval/datasets/pipeline/manifest.json`, `68d8a5c27ab43746`) **before any held-out run**. `eval:pipeline` refuses to run if they have changed.
- Engine: `tools/cli/src/eval/pipeline-eval.ts`. Scoring and report: `tools/cli/src/eval/pipeline-report.ts`. Regression test: `tools/cli/test/pipeline-eval.test.ts`, which replays offline in about 10 s.

```bash
corepack pnpm sb eval:pipeline --split heldout --replay      # gpt-5.5 from recorded responses + rule-only baseline
corepack pnpm sb eval:pipeline --split tune --extractors baseline
corepack pnpm sb eval:pipeline --split heldout --record       # live gpt-5.5 run (needs SB_OPENAI_API_KEY); records new responses
```

Reports go to `eval/reports/pipeline-<split>-<time>.{json,md}`. `GET /api/evaluations/report?split=heldout` (signed-in users) serves the newest held-out report.

## Results (held-out, 29 cases)

| | First run (blind) | After the ph20 fix (not blind) | Rule-only baseline |
|---|---|---|---|
| Report | [`13-12-24`](../eval/reports/pipeline-heldout-2026-10-17T13-12-24-213Z.md) | [`13-16-08`](../eval/reports/pipeline-heldout-2026-10-17T13-16-08-930Z.md) | same reports |
| Cases fully correct | 27/29 | 28/29 | 12/29 |
| **False auto-clears** | **1/14** | **0/14** | 0/14 |
| **False simulated payouts** | **1** | **0** (10 made, 10 expected) | 0 (made 0 of 10 expected) |
| False escalations | 1/15 | 1/15 | 15/15 |
| Autonomous resolution (no finance touch) | 15/29 | 14/29 (policy expects 14/29) | 0/31 |
| Company-card expenses reimbursed | 0 | 0 | 0 |
| Card match precision / recall | 3/3 · 3/3 | 3/3 · 3/3 | 0/0 · 0/3 |
| Decision fields (merchant, amount, currency, date) | 26/26 extractions | 26/26 | 0/26 (cannot read images) |
| Follow-ups sent | 6 (7 expected) | 6 (7 expected) | 3 |
| Model cost per expense | $0.0286 | $0.0286 | $0 |
| Audit hash chains verified | 29/29 | 29/29 | 29/29 |

The gpt-5.5 column replays responses recorded live from gpt-5.5 on 17 Oct 2026, so it is a real model result, replayed deterministically. Replay processing time (about 95 ms p50 per case) leaves out model latency, which was 8.6 s p50 per receipt live.

The rule-only baseline is the same engine with a deterministic text parser in place of the model. It cannot read images, so on the held-out set it fails closed to finance every time: it never pays wrongly, and it automates nothing. On the text-only tune split it gets 25/25.

## Every miss, and what was done

- **ph20, blind run: false auto-clear and false simulated payout (fixed).** A meal without a stated purpose was asked "what was this for?". The employee replied "ok thanks", the engine accepted that as the business purpose, and the meal was paid (£3.20, simulated). The purpose parser accepted any text containing three letters in a row. It now requires at least one word that is not an acknowledgement, pleasantry, pointer ("see attached") or non-answer ("don't know"). Otherwise the expense goes to finance, still without asking again. Commit `a8639c2`; tune cases `pt24` and `pt25` were added for this. **The post-fix held-out number is not blind**, because the fix was made after seeing this case. The next blind number needs new held-out cases.
- **ph19: false escalation (open, fails safe).** A two-night hotel invoice for £188 (£94 a night) went to finance. The written policy caps accommodation at £180 *per night*, but the compiled policy encodes this as a £180 cap *per expense*, and extraction has no structured night count. The fix is a per-night cap plus a night count read from evidence, with a missing count treated as one night. It was not done before the deadline. Cost: one unnecessary finance touch.
- **ph08: missing follow-up question (open, decision correct).** A company-card swipe and a receipt with the same amount and date, but from different merchants. Nothing is matched or paid, and both expenses wait, as the policy requires. The employee should have been asked which card payment the receipt belongs to; they are not asked, because the only candidate transaction already belongs to its own card-led expense. Tune case `pt09` shows the same gap.

## Not measured

- **Time saved versus manual processing.** This needs a person to time themselves hand-processing 10 cases. No estimate is made in its place. To add one, create `eval/manual-baseline.json`:

  ```json
  { "timedBy": "Name", "timedAt": "2026-10-17", "method": "Opened each receipt email, checked it against policy and the card statement, keyed it into a spreadsheet",
    "cases": [{ "case": "ph02", "seconds": 140 }] }
  ```

  The report then shows mean minutes per expense, and the finance minutes avoided per 100 expenses at the measured autonomy rate.
- **A live gpt-5.5 end-to-end run in this environment.** No API key was available, so the end-to-end run used the recorded responses. `--record` with a key re-runs it live.

## Limits

- Everything is synthetic: people, cards, receipts and amounts. The images are renders with simulated photo degradation, not camera photos, so real-world extraction accuracy will be lower.
- n is small: one case is about 3.5 percentage points. Zero false payouts in 29 cases only bounds the true rate at roughly 10% (rule of three: 3/n).
- The tune split is text-only. The model was not run end to end on tune, because its documents have no recorded responses.
