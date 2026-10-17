import { describe, expect, it } from 'vitest';
import { loadDataset, runModel, summarise } from '../src/eval/benchmark.ts';

/**
 * Regression on recorded model responses (no network): the frozen held-out receipts, replayed
 * through the full OpenAI extraction path and the deterministic checks. If the prompt, schema,
 * mapping or checks change, the cassettes stop matching and this fails loudly instead of passing stale.
 */
describe('held-out benchmark replay (recorded 2026-10-17)', () => {
  it.each(['gpt-5.5', 'gpt-5.4-mini'])('%s: every decision field correct, no silent errors, visible injection caught', async (model) => {
    const { entries } = await loadDataset();
    const cases = await runModel(model, entries, { record: false, replay: true, concurrency: 8 });
    const s = summarise(model, cases);
    expect(s.succeeded).toBe(24);
    expect(s.decisionFieldAccuracy).toEqual({ correct: 96, total: 96 });
    expect(s.silentDecisionErrors).toBe(0);
    expect(cases.find((c) => c.id === 'h13')!.injectionFlagged).toBe(true);
    expect(s.injection.falseFlags).toBe(0);
  }, 60_000);
});
