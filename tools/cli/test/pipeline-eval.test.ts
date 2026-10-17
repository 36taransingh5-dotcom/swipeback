import { createExtractor } from '@swipeback/engine';
import { BaselineExtractor } from '@swipeback/extraction';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELDOUT_CASES, TUNE_CASES } from '../src/eval/pipeline-cases.ts';
import { startEvalDatabase } from '../src/eval/pipeline-eval.ts';
import { evaluate, summarise, verifyHeldoutFrozen } from '../src/eval/pipeline-report.ts';

/**
 * End-to-end regression on recorded model responses (no network). Pins the safety numbers and
 * the exact set of known misses, so an improvement or a regression both show up here and the
 * published report has to be regenerated.
 */
describe('end-to-end pipeline evaluation (replay)', () => {
  let db: Awaited<ReturnType<typeof startEvalDatabase>>;
  beforeAll(async () => {
    db = await startEvalDatabase();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('held-out cases are still the frozen ones', async () => {
    await expect(verifyHeldoutFrozen()).resolves.toMatchObject({ cases: HELDOUT_CASES.length });
  });

  it('gpt-5.5 (recorded) on held-out: no false auto-clear or payout; only ph19 decided wrongly', async () => {
    const extractor = createExtractor({ ...process.env, SB_EXTRACTOR: 'openai', SB_CASSETTES: 'replay' }, { model: 'gpt-5.5' });
    const verdicts = await evaluate(db, HELDOUT_CASES, extractor);
    const s = summarise('gpt-5.5', verdicts);
    expect(s.fields.missingRecordings).toBe(0);
    expect(s.falseAutoClear.n).toBe(0);
    expect(s.payouts.falsePayouts).toBe(0);
    expect(s.corporateReimbursed).toBe(0);
    expect(s.auditChains).toEqual({ n: HELDOUT_CASES.length, d: HELDOUT_CASES.length });
    expect(verdicts.filter((v) => !v.correct).map((v) => v.id)).toEqual(['ph19']);
  }, 120_000);

  it('rule-only baseline fails closed on held-out images: nothing cleared, nothing paid', async () => {
    const s = summarise('baseline', await evaluate(db, HELDOUT_CASES, new BaselineExtractor()));
    expect(s.falseAutoClear.n).toBe(0);
    expect(s.payouts.made).toBe(0);
  }, 120_000);

  it('rule-only baseline on the tune split: every decision correct', async () => {
    const verdicts = await evaluate(db, TUNE_CASES, new BaselineExtractor());
    expect(verdicts.filter((v) => !v.correct).map((v) => v.id)).toEqual([]);
    expect(summarise('baseline', verdicts).payouts.falsePayouts).toBe(0);
  }, 120_000);
});
