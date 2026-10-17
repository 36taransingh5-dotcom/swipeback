import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createExtractor, loadLocalEnv } from '@swipeback/engine';
import { BaselineExtractor, type Extractor } from '@swipeback/extraction';
import { CLEARED, HELDOUT_CASES, TUNE_CASES, type ExpectedExpense, type Outcome, type PipelineCase } from './pipeline-cases.ts';
import { DocumentStore, EVAL_NOW, runCase, startEvalDatabase, type CaseRun, type EvalDatabase, type MeasuredExpense } from './pipeline-eval.ts';

/**
 * Scoring and reporting for the end-to-end evaluation. Every rate is reported as numerator and
 * denominator; every miss is listed. Nothing here can change an outcome: it only compares what the
 * engine did with what the written policy says it should have done.
 */

const PIPELINE_DIR = path.resolve('eval/datasets/pipeline');
const REPORT_DIR = path.resolve('eval/reports');
const MANUAL_BASELINE = path.resolve('eval/manual-baseline.json');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------------------------
// Freezing the held-out cases
// ---------------------------------------------------------------------------------------------

interface PipelineManifest {
  split: 'heldout';
  frozenAt: string;
  cases: number;
  casesSha256: string;
  heldoutImagesManifestSha256: string;
}

const canonicalCases = (cases: readonly PipelineCase[]) => `${JSON.stringify(cases, null, 2)}\n`;

export async function freezeHeldout(force: boolean): Promise<PipelineManifest> {
  const manifestFile = path.join(PIPELINE_DIR, 'heldout-manifest.json');
  if (!force && (await readFile(manifestFile, 'utf8').catch(() => null))) {
    throw new Error('held-out pipeline cases already frozen; use --force only to deliberately replace them');
  }
  const cases = canonicalCases(HELDOUT_CASES);
  const images = await readFile(path.resolve('eval/datasets/heldout/manifest.json'), 'utf8');
  const manifest: PipelineManifest = {
    split: 'heldout', frozenAt: new Date().toISOString(), cases: HELDOUT_CASES.length, casesSha256: sha256(cases), heldoutImagesManifestSha256: sha256(images),
  };
  await mkdir(PIPELINE_DIR, { recursive: true });
  await writeFile(path.join(PIPELINE_DIR, 'heldout-cases.json'), cases);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Refuses to evaluate held-out cases that differ from the frozen definitions. */
export async function verifyHeldoutFrozen(): Promise<PipelineManifest> {
  const raw = await readFile(path.join(PIPELINE_DIR, 'heldout-manifest.json'), 'utf8').catch(() => {
    throw new Error('held-out pipeline cases are not frozen: run `corepack pnpm sb eval:pipeline:freeze` first');
  });
  const manifest = JSON.parse(raw) as PipelineManifest;
  if (sha256(canonicalCases(HELDOUT_CASES)) !== manifest.casesSha256) throw new Error('held-out case definitions differ from the frozen manifest');
  const images = await readFile(path.resolve('eval/datasets/heldout/manifest.json'), 'utf8');
  if (sha256(images) !== manifest.heldoutImagesManifestSha256) throw new Error('held-out images differ from the frozen manifest');
  return manifest;
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

export interface ExpenseVerdict {
  expected: ExpectedExpense | null;
  measured: MeasuredExpense | null;
  outcomeCorrect: boolean;
  matchCorrect: boolean | null;
}

export interface CaseVerdict {
  id: string;
  scenario: string;
  title: string;
  correct: boolean;
  expenses: ExpenseVerdict[];
  followUps: { expected: number; measured: number };
  quarantine: { expected: number; measured: number };
  falsePayouts: number;
  missedPayouts: number;
  problems: string[];
  run: CaseRun;
}

const isCleared = (o: Outcome | undefined | null) => !!o && CLEARED.includes(o);
const AUTONOMOUS: readonly Outcome[] = ['CLEARED_CARD', 'CLEARED_PAID', 'REJECTED'];

export function scoreCase(c: PipelineCase, run: CaseRun): CaseVerdict {
  const n = Math.max(c.expect.expenses.length, run.expenses.length);
  const expenses: ExpenseVerdict[] = [];
  const problems: string[] = [];
  if (run.error) problems.push(`run error: ${run.error}`);
  problems.push(...run.skippedSteps);
  for (let i = 0; i < n; i++) {
    const expected = c.expect.expenses[i] ?? null;
    const measured = run.expenses[i] ?? null;
    const outcomeCorrect = !!expected && !!measured && expected.outcome === measured.outcome;
    const matchCorrect = expected?.match !== undefined ? measured?.matchedSwipe === expected.match : measured?.matchedSwipe ? false : null;
    if (!expected) problems.push(`unexpected extra expense ${measured!.ref} (${measured!.outcome})`);
    else if (!measured) problems.push(`expected a ${expected.outcome} expense, none was created`);
    else if (!outcomeCorrect) problems.push(`${measured.ref}: expected ${expected.outcome}, got ${measured.outcome} (${measured.state}; ${measured.reasons.join(', ') || 'no decision'})`);
    if (matchCorrect === false) problems.push(`${measured?.ref ?? '?'}: matched to ${measured?.matchedSwipe ?? 'nothing'}, expected ${expected?.match ?? 'no match'}`);
    expenses.push({ expected, measured, outcomeCorrect, matchCorrect });
  }
  let falsePayouts = 0;
  let missedPayouts = 0;
  for (const v of expenses) {
    const paidMinor = v.measured?.reimbursement?.state === 'SIMULATED_PAID' ? v.measured.reimbursement.amountMinor : null;
    const shouldPay = v.expected?.outcome === 'CLEARED_PAID' ? (v.expected.payoutMinor ?? null) : null;
    if (paidMinor !== null && (shouldPay === null || paidMinor !== shouldPay)) {
      falsePayouts++;
      problems.push(`FALSE SIMULATED PAYOUT on ${v.measured!.ref}: ${paidMinor} minor units (expected ${shouldPay ?? 'none'})`);
    }
    if (shouldPay !== null && paidMinor === null) missedPayouts++;
  }
  // Payouts not attached to a scored expense (e.g. on a merged one) are still payouts.
  const scoredPaid = expenses.filter((v) => v.measured?.reimbursement?.state === 'SIMULATED_PAID').length;
  if (run.payouts.length > scoredPaid) {
    falsePayouts += run.payouts.length - scoredPaid;
    problems.push(`${run.payouts.length - scoredPaid} simulated payout(s) on expenses outside the scored set`);
  }
  const quarantine = { expected: c.expect.quarantined ?? 0, measured: run.quarantined };
  if (quarantine.expected !== quarantine.measured) problems.push(`quarantined ${quarantine.measured}, expected ${quarantine.expected}`);
  const followUps = { expected: c.expect.followUps, measured: run.followUps };
  if (!run.auditOk && !run.error) problems.push('audit chain did not verify');
  const correct = !run.error && expenses.every((v) => v.outcomeCorrect && v.matchCorrect !== false) && falsePayouts === 0 && quarantine.expected === quarantine.measured;
  if (followUps.expected !== followUps.measured) problems.push(`follow-ups: ${followUps.measured} sent, expected ${followUps.expected}`);
  return { id: c.id, scenario: c.scenario, title: c.title, correct, expenses, followUps, quarantine, falsePayouts, missedPayouts, problems, run };
}

interface Ratio {
  n: number;
  d: number;
}
const ratio = (n: number, d: number): Ratio => ({ n, d });
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function summarise(label: string, verdicts: CaseVerdict[]) {
  const all = verdicts.flatMap((v) => v.expenses);
  const measured = all.filter((v) => v.measured).map((v) => v.measured!);
  const expectedNotCleared = all.filter((v) => v.expected && !isCleared(v.expected.outcome));
  const expectedCleared = all.filter((v) => v.expected && isCleared(v.expected.outcome));
  const measuredCleared = all.filter((v) => isCleared(v.measured?.outcome));
  const extractions = verdicts.flatMap((v) => v.run.extractions);
  const labelled = extractions.filter((x) => x.docLabelled && !x.missingRecording);
  const matched = all.filter((v) => v.measured?.matchedSwipe);
  const expectedMatches = all.filter((v) => v.expected?.match !== undefined);
  const expenseCount = measured.length;
  const cost = verdicts.reduce((a, v) => a + v.run.llm.costMicros, 0);
  const calls = verdicts.reduce((a, v) => a + v.run.llm.calls, 0);
  const wall = verdicts.map((v) => v.run.wallMs);
  const scenarios: Record<string, Ratio> = {};
  for (const v of verdicts) {
    const s = (scenarios[v.scenario] ??= ratio(0, 0));
    s.d++;
    if (v.correct) s.n++;
  }
  return {
    label,
    cases: ratio(verdicts.filter((v) => v.correct).length, verdicts.length),
    expenseOutcomes: ratio(all.filter((v) => v.outcomeCorrect).length, all.length),
    falseAutoClear: ratio(expectedNotCleared.filter((v) => isCleared(v.measured?.outcome)).length, expectedNotCleared.length),
    autoClearPrecision: ratio(measuredCleared.filter((v) => isCleared(v.expected?.outcome)).length, measuredCleared.length),
    falseEscalation: ratio(expectedCleared.filter((v) => !isCleared(v.measured?.outcome)).length, expectedCleared.length),
    falseEscalationTo: {
      REVIEW: expectedCleared.filter((v) => v.measured?.outcome === 'REVIEW').length,
      WAITING: expectedCleared.filter((v) => v.measured?.outcome === 'WAITING').length,
      REJECTED: expectedCleared.filter((v) => v.measured?.outcome === 'REJECTED').length,
      MISSING: expectedCleared.filter((v) => !v.measured).length,
    },
    autonomousResolution: ratio(measured.filter((m) => AUTONOMOUS.includes(m.outcome)).length, expenseCount),
    autonomousResolutionExpected: ratio(all.filter((v) => v.expected && AUTONOMOUS.includes(v.expected.outcome)).length, all.filter((v) => v.expected).length),
    financeTouches: measured.filter((m) => m.outcome === 'REVIEW' || m.outcome === 'CLEARED_AWAITING_PAYMENT_APPROVAL').length,
    waitingOnEmployee: measured.filter((m) => m.outcome === 'WAITING').length,
    matchPrecision: ratio(matched.filter((v) => v.matchCorrect === true).length, matched.length),
    matchRecall: ratio(expectedMatches.filter((v) => v.matchCorrect === true).length, expectedMatches.length),
    payouts: {
      made: verdicts.reduce((a, v) => a + v.run.payouts.length, 0),
      expected: all.filter((v) => v.expected?.outcome === 'CLEARED_PAID').length,
      falsePayouts: verdicts.reduce((a, v) => a + v.falsePayouts, 0),
      missed: verdicts.reduce((a, v) => a + v.missedPayouts, 0),
    },
    corporateReimbursed: measured.filter((m) => m.paymentType === 'CORPORATE' && m.reimbursement).length,
    followUps: { sent: verdicts.reduce((a, v) => a + v.followUps.measured, 0), expected: verdicts.reduce((a, v) => a + v.followUps.expected, 0), expenses: expenseCount },
    reminders: verdicts.reduce((a, v) => a + v.run.reminders, 0),
    quarantine: ratio(verdicts.filter((v) => v.quarantine.expected === v.quarantine.measured).length, verdicts.length),
    fields: {
      extractions: extractions.length,
      failed: extractions.filter((x) => x.status !== 'SUCCEEDED').length,
      missingRecordings: extractions.filter((x) => x.missingRecording).length,
      merchant: ratio(labelled.filter((x) => x.merchant).length, labelled.length),
      amount: ratio(labelled.filter((x) => x.amount).length, labelled.length),
      currency: ratio(labelled.filter((x) => x.currency).length, labelled.length),
      date: ratio(labelled.filter((x) => x.date).length, labelled.length),
      all4: ratio(labelled.filter((x) => x.merchant && x.amount && x.currency && x.date).length, labelled.length),
    },
    cost: {
      modelCalls: calls,
      totalUsd: cost / 1e6,
      perExpenseUsd: expenseCount ? cost / 1e6 / expenseCount : null,
      unknownCostCalls: verdicts.reduce((a, v) => a + v.run.llm.unknownCost, 0),
    },
    processingMs: { p50: quantile(wall, 0.5), p95: quantile(wall, 0.95), recordedModelLatencyMs: verdicts.reduce((a, v) => a + v.run.llm.latencyMs, 0) },
    auditChains: ratio(verdicts.filter((v) => v.run.auditOk).length, verdicts.length),
    errors: verdicts.filter((v) => v.run.error).map((v) => `${v.id}: ${v.run.error}`),
    scenarios,
  };
}
export type Summary = ReturnType<typeof summarise>;

// ---------------------------------------------------------------------------------------------
// Manual baseline (timed by a person; never estimated by the system)
// ---------------------------------------------------------------------------------------------

interface ManualBaseline {
  timedBy: string;
  timedAt: string;
  method: string;
  cases: { case: string; seconds: number }[];
}

async function loadManualBaseline(): Promise<ManualBaseline | null> {
  const raw = await readFile(MANUAL_BASELINE, 'utf8').catch(() => null);
  return raw ? (JSON.parse(raw) as ManualBaseline) : null;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const pct = (r: Ratio) => (r.d ? `${((100 * r.n) / r.d).toFixed(1)}% (${r.n}/${r.d})` : 'n/a (0/0)');

export type ReportCase = Omit<CaseVerdict, 'run'> & { wallMs: number; llm: CaseRun['llm']; extractions: CaseRun['extractions'] };

export function reportCase({ run, ...rest }: CaseVerdict): ReportCase {
  return { ...rest, wallMs: run.wallMs, llm: run.llm, extractions: run.extractions };
}

export interface PipelineReport {
  kind: 'pipeline-evaluation';
  runAt: string;
  split: string;
  evaluatedAsOf: string;
  heldoutManifest: { casesSha256: string; frozenAt: string } | null;
  runs: { label: string; extractor: string; mode: string; summary: Summary; cases: ReportCase[] }[];
  manualBaseline: { timedBy: string; timedAt: string; method: string; cases: number; meanSeconds: number } | null;
}

export function markdown(r: PipelineReport): string {
  const s = r.runs.map((x) => x.summary);
  const row = (label: string, f: (x: Summary) => string) => `| ${label} | ${s.map(f).join(' | ')} |`;
  const lines = [
    `# End-to-end evaluation — ${r.split} split`,
    '',
    `Run ${r.runAt}, evaluated as of ${r.evaluatedAsOf}. ${r.heldoutManifest ? `Held-out cases frozen ${r.heldoutManifest.frozenAt} (\`${r.heldoutManifest.casesSha256.slice(0, 16)}\`). ` : ''}Every case runs through the real engine (intake → extraction → matching → deterministic policy → follow-ups → simulated payout) on a fresh database. Expected outcomes come from the written policy, not from the code.`,
    '',
    `| Metric | ${r.runs.map((x) => `${x.label}`).join(' | ')} |`,
    `|---|${r.runs.map(() => '---').join('|')}|`,
    row('Cases fully correct', (x) => pct(x.cases)),
    row('Expense outcomes correct', (x) => pct(x.expenseOutcomes)),
    row('**False auto-clear rate** (cleared, should not have been)', (x) => pct(x.falseAutoClear)),
    row('Auto-clear precision', (x) => pct(x.autoClearPrecision)),
    row('False escalation rate (should have cleared, did not)', (x) => `${pct(x.falseEscalation)} — review ${x.falseEscalationTo.REVIEW}, waiting ${x.falseEscalationTo.WAITING}, rejected ${x.falseEscalationTo.REJECTED}, missing ${x.falseEscalationTo.MISSING}`),
    row('Autonomous resolution (no finance touch)', (x) => `${pct(x.autonomousResolution)} — expected ${pct(x.autonomousResolutionExpected)}`),
    row('Finance touches (review + payment approval)', (x) => `${x.financeTouches}`),
    row('Waiting on the employee / card feed', (x) => `${x.waitingOnEmployee}`),
    row('**False simulated payouts**', (x) => `${x.payouts.falsePayouts} (payouts made ${x.payouts.made}, expected ${x.payouts.expected}, missed ${x.payouts.missed})`),
    row('Company-card expenses reimbursed', (x) => `${x.corporateReimbursed}`),
    row('Card match precision', (x) => pct(x.matchPrecision)),
    row('Card match recall', (x) => pct(x.matchRecall)),
    row('Follow-ups per expense', (x) => (x.followUps.expenses ? `${(x.followUps.sent / x.followUps.expenses).toFixed(2)} (${x.followUps.sent}/${x.followUps.expenses}; expected ${x.followUps.expected})` : 'n/a')),
    row('Reminders sent', (x) => `${x.reminders}`),
    row('Identity quarantine correct', (x) => pct(x.quarantine)),
    row('Extraction: all 4 decision fields correct', (x) => `${pct(x.fields.all4)}; failed ${x.fields.failed}/${x.fields.extractions}`),
    row('— merchant / amount / currency / date', (x) => `${x.fields.merchant.n} / ${x.fields.amount.n} / ${x.fields.currency.n} / ${x.fields.date.n} of ${x.fields.all4.d}`),
    row('Model calls · cost per expense', (x) => `${x.cost.modelCalls} · ${x.cost.perExpenseUsd === null ? 'n/a' : `$${x.cost.perExpenseUsd.toFixed(4)}`}${x.cost.unknownCostCalls ? ` (${x.cost.unknownCostCalls} calls of unknown price)` : ''}`),
    row('Processing time per case p50 / p95', (x) => `${x.processingMs.p50} / ${x.processingMs.p95} ms`),
    row('Audit chains verified', (x) => pct(x.auditChains)),
    '',
  ];
  for (const x of r.runs) {
    if (x.summary.fields.missingRecordings) {
      lines.push(`> **${x.label}:** ${x.summary.fields.missingRecordings} extraction(s) had no recorded model response, so those cases were not model results (they failed closed). Record them with \`--record\` and a key.`, '');
    }
  }
  lines.push('## Per scenario (cases fully correct)', '', `| Scenario | ${r.runs.map((x) => x.label).join(' | ')} |`, `|---|${r.runs.map(() => '---').join('|')}|`);
  for (const sc of Object.keys(s[0]?.scenarios ?? {})) lines.push(`| ${sc} | ${s.map((x) => `${x.scenarios[sc]!.n}/${x.scenarios[sc]!.d}`).join(' | ')} |`);
  lines.push('');
  lines.push('## Time saved versus manual processing', '');
  if (r.manualBaseline) {
    const auto = s[0]!.autonomousResolution;
    lines.push(
      `A person (${r.manualBaseline.timedBy}, ${r.manualBaseline.timedAt}) hand-processed ${r.manualBaseline.cases} cases: mean ${(r.manualBaseline.meanSeconds / 60).toFixed(1)} min per expense (${r.manualBaseline.method}).`,
      `With ${pct(auto)} resolved without finance, finance time avoided is about ${((auto.d ? auto.n / auto.d : 0) * r.manualBaseline.meanSeconds / 60 * 100).toFixed(0)} minutes per 100 expenses (exceptions still cost finance their full manual time).`,
      '',
    );
  } else {
    lines.push('**Not measured.** No timed manual baseline exists yet (`eval/manual-baseline.json`). The system does not estimate human time; a person must time themselves processing 10 cases by hand (see `docs/EVALUATION.md`).', '');
  }
  for (const x of r.runs) {
    lines.push(`## Every miss — ${x.label}`, '');
    const misses = x.cases.filter((c) => !c.correct || c.problems.length);
    if (!misses.length) lines.push('No misses.', '');
    for (const c of misses) {
      lines.push(`- **${c.id}** ${c.correct ? '(decision correct)' : '**(wrong)**'} ${c.title}: ${c.problems.join('; ')}`);
    }
    lines.push('');
  }
  lines.push(
    '## Method and limits',
    '',
    '- All receipts, people, cards and amounts are synthetic. Receipt images are renders with simulated photo degradation, not camera photos.',
    '- The model path in replay mode serves the responses recorded from gpt-5.5 on 17 Oct 2026; documents without a recording fail closed and are flagged above. Replay processing time excludes model latency (gpt-5.5 p50 was 8.6 s per receipt in the benchmark).',
    '- The rule-only baseline is the same engine with the deterministic text extractor instead of the model; it cannot read images, so image receipts fail closed to review.',
    '- Outcomes are compared per expense in creation order; a receipt merged into its card-led expense is not a separate expense.',
    '- n is small; one case is several percentage points. Zero observed false payouts in n cases bounds the true rate only at roughly 3/n (rule of three).',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

type Command = { describe: string; run: (args: string[]) => Promise<void> };

export async function evaluate(
  db: EvalDatabase,
  cases: readonly PipelineCase[],
  extractor: Extractor,
  onCase: (v: CaseVerdict) => void = () => undefined,
): Promise<CaseVerdict[]> {
  const docs = await DocumentStore.load();
  const verdicts: CaseVerdict[] = [];
  for (const c of cases) {
    const v = scoreCase(c, await runCase(db, docs, c, extractor));
    onCase(v);
    verdicts.push(v);
  }
  return verdicts;
}

export const pipelineEvalCommands: Record<string, Command> = {
  'eval:pipeline:freeze': {
    describe: 'Freeze the held-out end-to-end cases by checksum (refuses to overwrite without --force)',
    run: async (args) => {
      const { values } = parseArgs({ args, options: { force: { type: 'boolean' } } });
      const m = await freezeHeldout(!!values.force);
      console.log(`Froze ${m.cases} held-out pipeline cases (${m.casesSha256.slice(0, 16)}) in ${PIPELINE_DIR}`);
    },
  },
  'eval:pipeline': {
    describe: 'End-to-end evaluation: --split heldout|tune|all --extractors llm,baseline [--replay|--record] [--model gpt-5.5]',
    run: async (args) => {
      loadLocalEnv();
      const { values } = parseArgs({
        args,
        options: { split: { type: 'string' }, extractors: { type: 'string' }, replay: { type: 'boolean' }, record: { type: 'boolean' }, model: { type: 'string' } },
      });
      const split = values.split ?? 'heldout';
      if (!['heldout', 'tune', 'all'].includes(split)) throw new Error('--split must be heldout, tune or all');
      const cases = split === 'heldout' ? HELDOUT_CASES : split === 'tune' ? TUNE_CASES : [...TUNE_CASES, ...HELDOUT_CASES];
      const manifest = split === 'tune' ? null : await verifyHeldoutFrozen();
      const mode = values.record ? 'record' : values.replay || !process.env.SB_OPENAI_API_KEY ? 'replay' : 'off';
      const model = values.model ?? process.env.SB_OPENAI_MODEL ?? 'gpt-5.5';
      const wanted = (values.extractors ?? 'llm,baseline').split(',').map((x) => x.trim());
      const db = await startEvalDatabase();
      const runs: PipelineReport['runs'] = [];
      try {
        for (const which of wanted) {
          const extractor = which === 'baseline' ? new BaselineExtractor() : createExtractor({ ...process.env, SB_EXTRACTOR: 'openai', SB_CASSETTES: mode }, { model });
          const label = which === 'baseline' ? 'rule-only baseline' : `${model}${mode === 'replay' ? ' (recorded)' : mode === 'record' ? ' (live, recording)' : ' (live)'}`;
          console.log(`\n${label}: ${cases.length} cases`);
          const verdicts = await evaluate(db, cases, extractor, (v) => process.stdout.write(v.correct ? '.' : 'x'));
          process.stdout.write('\n');
          runs.push({ label, extractor: which, mode: which === 'baseline' ? 'deterministic' : mode, summary: summarise(label, verdicts), cases: verdicts.map(reportCase) });
        }
      } finally {
        await db.stop();
      }
      const manual = await loadManualBaseline();
      const runAt = new Date().toISOString();
      const report: PipelineReport = {
        kind: 'pipeline-evaluation', runAt, split, evaluatedAsOf: new Date(EVAL_NOW).toISOString(),
        heldoutManifest: manifest ? { casesSha256: manifest.casesSha256, frozenAt: manifest.frozenAt } : null,
        runs,
        manualBaseline: manual && manual.cases.length
          ? { timedBy: manual.timedBy, timedAt: manual.timedAt, method: manual.method, cases: manual.cases.length, meanSeconds: manual.cases.reduce((a, x) => a + x.seconds, 0) / manual.cases.length }
          : null,
      };
      await mkdir(REPORT_DIR, { recursive: true });
      const base = path.join(REPORT_DIR, `pipeline-${split}-${runAt.replace(/[:.]/g, '-')}`);
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(`${base}.md`, `${markdown(report)}\n`);
      console.log(markdown(report));
      console.log(`\nReport: ${base}.md`);
    },
  },
};
