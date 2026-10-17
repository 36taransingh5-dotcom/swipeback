# Extraction model benchmark — GPT-5.5 vs GPT-5.4-mini

**Run:** 17 Oct 2026, 07:25 UTC. Full machine report: [`eval/reports/benchmark-2026-10-17T07-25-08-510Z.md`](../eval/reports/benchmark-2026-10-17T07-25-08-510Z.md). Responses were recorded to `eval/cassettes/`, so the run replays offline (`corepack pnpm sb eval:benchmark --replay`) and is guarded by `tools/cli/test/benchmark-replay.test.ts`.

**Set-up:** 24 frozen held-out synthetic receipt images (18 phone-style photos, 6 PNG scans). Three layouts (till receipt, A5 tax invoice, card-terminal slip). Cash, EUR, USD, discounts, service charges, blur/tilt/low JPEG quality, a day-first date and two injection attempts. Both models had the same files, prompt, schema, reasoning effort (`medium`), image detail (`high`) and the same deterministic checks. Neither the prompt nor the checks were tuned on this set.

## Results

| Metric | gpt-5.5 | gpt-5.4-mini |
|---|---|---|
| Extractions succeeded | 24/24 | 24/24 |
| Decision-field accuracy (merchant, amount, currency, date) | 96/96 | 96/96 |
| Field accuracy (9 fields) | 215/216 | 214/216 |
| Silent decision-field errors (wrong and not flagged) | 0 | 0 |
| Evidence quote-verification failures | 0 | 0 |
| False escalations (correct receipt sent to review) | 0 | 0 |
| Visible injection attempt detected (h13) | yes | yes |
| Latency mean / p50 / p95 | 8.1 s / 8.6 s / 10.1 s | 6.5 s / 5.8 s / 15.0 s |
| Cost per receipt | $0.0326 | $0.0066 |
| Mean output tokens | 794 | 1,181 |

Prices are from OpenAI's pricing page, checked 17 Oct 2026, short-context standard tier: gpt-5.5 $5 / $30 per M tokens, gpt-5.4-mini $0.75 / $4.50.

## What the misses were

- **h17 (gpt-5.4-mini only):** it transcribed "Mastercard ending 4242" but returned no tender. The card digits were right, and payment type is decided from them, so this would not have changed any outcome. It is still a real extraction miss.
- **h14 (both):** both returned `OTHER` for Hudson News (a newsagent), where I had labelled it `MEALS`. The label is debatable. Left as is, because the labels were frozen before the run.
- **h12 (both, injection "missed"):** the near-invisible instruction text does not survive into the image pixels, so neither model could see it, and neither transcription contains it. This is a dataset artefact, not a detection failure. The same trick in a PDF is caught by the deterministic screen on the text layer (`injection-pdf` in the smoke run).

## Recommendation

**Keep `gpt-5.5` as the default (`SB_OPENAI_MODEL=gpt-5.5`). This evaluation does not justify switching to `gpt-5.4-mini`.**

- On this set the two models cannot be told apart on what matters. Both got 0 of 96 decision fields wrong, but zero errors in 96 only bounds the true error rate at roughly ≤3% (rule of three). A 1% versus 3% difference, which matters at payout scale, is invisible at this n.
- The set is saturated: synthetic renders of clean fonts are easier than real crumpled, faded or handwritten receipts, which is exactly where a smaller model is most likely to fall behind.
- gpt-5.4-mini is 4.9× cheaper per receipt (about $0.66 versus $3.26 per 100 receipts). Its typical latency is lower, but its tail is worse (p95 15.0 s versus 10.1 s), and it spent about 50% more output tokens.
- Safety does not depend on the model choice: every decision field's uncertainty, evidence and arithmetic is checked deterministically, and payouts need clean evidence. A cheaper model that errs more would show up as more escalations, not as wrong payments, and that cost is what a fair comparison has to measure.

**What would settle it:** a harder held-out set of 100+ real phone photos of printed receipts (faded thermal paper, folds, shadows, handwriting, multi-item supermarket receipts), scored the same way. Switch only if gpt-5.4-mini's silent-error rate is no worse and its escalation rate is acceptable. `SB_OPENAI_MODEL` makes that switch a configuration change.

## Limits

- Synthetic renders, not camera photos; real-world accuracy will be lower for both models.
- For images there is no independent text layer, so quote verification compares the model's quotes against its own transcription. That catches internal inconsistency, not misreading. PDFs are checked against the real text layer.
- n = 24, one run per model. Latency varies with API load.
