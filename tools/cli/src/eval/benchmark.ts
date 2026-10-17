import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { merchantSimilarity } from '@swipeback/domain';
import { createExtractor, loadLocalEnv } from '@swipeback/engine';
import { finaliseExtraction, type ExtractionResult, type ReceiptFacts } from '@swipeback/extraction';
import { ReceiptRenderer } from '../receipts.ts';
import { checkConsistency, HELDOUT, type DatasetEntry, type Label } from './heldout.ts';

/**
 * Held-out dataset generation (frozen by checksum manifest) and the model benchmark.
 * The benchmark runs every model on byte-identical files with the same prompt, schema, reasoning
 * effort and deterministic checks, and reports what the data says — including failures.
 */

type Command = { describe: string; run: (args: string[]) => Promise<void> };

const DATASET_DIR = path.resolve('eval/datasets/heldout');
const REPORT_DIR = path.resolve('eval/reports');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

interface Manifest {
  split: 'heldout';
  generatedAt: string;
  files: Record<string, { file: string; mime: string; sha256: string }>;
  labelsSha256: string;
}

export async function loadDataset(): Promise<{ manifest: Manifest; entries: (DatasetEntry & { bytes: Buffer; mime: string })[]; manifestHash: string }> {
  const raw = await readFile(path.join(DATASET_DIR, 'manifest.json'), 'utf8').catch(() => {
    throw new Error('held-out set not generated: run `corepack pnpm sb eval:generate`');
  });
  const manifest = JSON.parse(raw) as Manifest;
  const labels = await readFile(path.join(DATASET_DIR, 'labels.json'), 'utf8');
  if (sha256(labels) !== manifest.labelsSha256) throw new Error('labels.json does not match the frozen manifest');
  const entries = [];
  for (const e of HELDOUT) {
    const m = manifest.files[e.id];
    if (!m) throw new Error(`${e.id} missing from manifest`);
    const bytes = await readFile(path.join(DATASET_DIR, m.file));
    if (sha256(bytes) !== m.sha256) throw new Error(`${m.file} does not match the frozen manifest`);
    entries.push({ ...e, bytes, mime: m.mime });
  }
  return { manifest, entries, manifestHash: sha256(raw) };
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

const FIELDS = ['merchant', 'amount', 'currency', 'date', 'cardLast4', 'receiptNumber', 'vatNumber', 'tender', 'category'] as const;
type Field = (typeof FIELDS)[number];
const DECISION: readonly Field[] = ['merchant', 'amount', 'currency', 'date'];
const norm = (s: string | null | undefined) => (s ? s.replace(/[^a-z0-9]/gi, '').toUpperCase() : null);

export function scoreFields(result: ExtractionResult, facts: ReceiptFacts, label: Label): Record<Field, boolean> {
  const r = result.receipt;
  return {
    merchant: !!facts.merchant && merchantSimilarity(facts.merchant, label.merchant) >= 0.75,
    amount: facts.amount?.amountMinor === label.totalMinor,
    currency: facts.amount?.currency === label.currency,
    date: facts.date === label.date,
    cardLast4: (r?.cardLast4.value ?? null) === label.cardLast4,
    receiptNumber: norm(r?.receiptNumber.value) === norm(label.receiptNumber),
    vatNumber: !!r?.vatNumber.value === label.hasVatNumber,
    tender: (r?.tender.value ?? null) === label.tender,
    category: facts.category === label.category,
  };
}

interface CaseResult {
  id: string;
  format: string;
  status: ExtractionResult['status'];
  servedBy: string | null;
  fields: Record<Field, boolean>;
  uncertain: string[];
  flags: string[];
  quoteFailures: number;
  latencyMs: number | null;
  costMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  injectionExpected: boolean;
  injectionFlagged: boolean;
  wrongDecisionFields: string[];
  silentDecisionErrors: string[];
  error: string | null;
}

export async function runModel(model: string, entries: Awaited<ReturnType<typeof loadDataset>>['entries'], opts: { record: boolean; replay: boolean; concurrency: number }): Promise<CaseResult[]> {
  const extractor = createExtractor({ ...process.env, SB_EXTRACTOR: 'openai', SB_CASSETTES: opts.replay ? 'replay' : opts.record ? 'record' : 'off' }, { model });
  const results: CaseResult[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i]!;
      const ctx = { senderText: '', subject: null };
      let result: ExtractionResult;
      try {
        result = await extractor.extract({ kind: 'ATTACHMENT', mime: e.mime, bytes: e.bytes, sha256: sha256(e.bytes) }, ctx);
      } catch (err) {
        // A transient error after the SDK's own retries: counted as a failure, not hidden.
        result = { status: 'FAILED', extractor: 'llm', model, receipt: null, sourceText: null, flags: ['EXTRACTION_FAILED'], error: (err as Error).message, usage: null };
      }
      const facts = finaliseExtraction(result, ctx);
      const fields = scoreFields(result, facts, e.label);
      const wrong = DECISION.filter((f) => !fields[f]);
      const uncertainSet = new Set<string>(facts.uncertainFields);
      results[i] = {
        id: e.id,
        format: e.format,
        status: result.status,
        servedBy: result.model,
        fields,
        uncertain: facts.uncertainFields,
        flags: facts.flags,
        quoteFailures: facts.notes.filter((n) => n.includes('not found in the source')).length,
        latencyMs: result.usage?.latencyMs ?? null,
        costMicros: result.usage?.costMicros ?? null,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        injectionExpected: e.label.injection,
        injectionFlagged: facts.flags.includes('INJECTION_SUSPECTED'),
        wrongDecisionFields: wrong,
        // Wrong AND not marked uncertain: the dangerous case (could flow on without review).
        silentDecisionErrors: result.status === 'SUCCEEDED' ? wrong.filter((f) => !uncertainSet.has(f === 'amount' ? 'amount' : f)) : [],
        error: result.error,
      };
      process.stdout.write('.');
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  process.stdout.write('\n');
  return results;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : 'n/a');
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function summarise(model: string, rs: CaseResult[]) {
  const ok = rs.filter((r) => r.status === 'SUCCEEDED');
  const fieldTotals = Object.fromEntries(FIELDS.map((f) => [f, rs.filter((r) => r.fields[f]).length])) as Record<Field, number>;
  const allFieldsCorrect = rs.reduce((a, r) => a + FIELDS.filter((f) => r.fields[f]).length, 0);
  const decisionCorrect = rs.reduce((a, r) => a + DECISION.filter((f) => r.fields[f]).length, 0);
  const costs = rs.map((r) => r.costMicros).filter((c): c is number => c !== null);
  const lat = rs.map((r) => r.latencyMs).filter((c): c is number => c !== null);
  const injCases = rs.filter((r) => r.injectionExpected);
  const cleanCases = rs.filter((r) => !r.injectionExpected);
  return {
    model,
    servedBy: [...new Set(rs.map((r) => r.servedBy).filter(Boolean))],
    receipts: rs.length,
    succeeded: ok.length,
    fieldAccuracy: { correct: allFieldsCorrect, total: rs.length * FIELDS.length },
    decisionFieldAccuracy: { correct: decisionCorrect, total: rs.length * DECISION.length },
    perField: fieldTotals,
    receiptsAllDecisionFieldsCorrect: rs.filter((r) => r.wrongDecisionFields.length === 0).length,
    quoteVerificationFailures: rs.reduce((a, r) => a + r.quoteFailures, 0),
    receiptsWithUncertainDecisionField: rs.filter((r) => r.uncertain.length > 0).length,
    falseUncertain: rs.filter((r) => r.uncertain.length > 0 && r.wrongDecisionFields.length === 0).length,
    silentDecisionErrors: rs.reduce((a, r) => a + r.silentDecisionErrors.length, 0),
    caughtDecisionErrors: rs.reduce((a, r) => a + r.wrongDecisionFields.length - r.silentDecisionErrors.length, 0),
    injection: { detected: injCases.filter((r) => r.injectionFlagged).length, cases: injCases.length, falseFlags: cleanCases.filter((r) => r.injectionFlagged).length },
    arithmeticFlags: rs.filter((r) => r.flags.includes('ARITHMETIC_MISMATCH')).length,
    latencyMs: { mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, p50: quantile(lat, 0.5), p95: quantile(lat, 0.95) },
    costPerReceiptUsd: costs.length === rs.length ? costs.reduce((a, b) => a + b, 0) / costs.length / 1e6 : null,
    totalCostUsd: costs.reduce((a, b) => a + b, 0) / 1e6,
    meanTokens: {
      input: Math.round(rs.reduce((a, r) => a + (r.inputTokens ?? 0), 0) / rs.length),
      output: Math.round(rs.reduce((a, r) => a + (r.outputTokens ?? 0), 0) / rs.length),
    },
  };
}

function markdown(report: { runAt: string; manifestHash: string; effort: string; summaries: ReturnType<typeof summarise>[]; cases: Record<string, CaseResult[]> }): string {
  const s = report.summaries;
  const row = (label: string, f: (x: ReturnType<typeof summarise>) => string) => `| ${label} | ${s.map(f).join(' | ')} |`;
  const lines = [
    `# Extraction benchmark — held-out receipts`,
    ``,
    `Run ${report.runAt} · held-out manifest \`${report.manifestHash.slice(0, 16)}\` · ${s[0]?.receipts ?? 0} synthetic receipt images · same prompt, schema, reasoning effort (${report.effort}) and deterministic checks for every model.`,
    ``,
    `| Metric | ${s.map((x) => `\`${x.model}\``).join(' | ')} |`,
    `|---|${s.map(() => '---').join('|')}|`,
    row('Extractions succeeded', (x) => `${x.succeeded}/${x.receipts}`),
    row('Field accuracy (9 fields)', (x) => pct(x.fieldAccuracy.correct, x.fieldAccuracy.total)),
    row('Decision-field accuracy (merchant, amount, currency, date)', (x) => pct(x.decisionFieldAccuracy.correct, x.decisionFieldAccuracy.total)),
    row('Receipts with all decision fields correct', (x) => `${x.receiptsAllDecisionFieldsCorrect}/${x.receipts}`),
    row('**Silent decision-field errors** (wrong, not flagged)', (x) => `${x.silentDecisionErrors}`),
    row('Decision-field errors caught by checks', (x) => `${x.caughtDecisionErrors}`),
    row('Evidence quote-verification failures', (x) => `${x.quoteVerificationFailures}`),
    row('Receipts sent to review for uncertainty', (x) => `${x.receiptsWithUncertainDecisionField}`),
    row('…of which actually correct (false escalation)', (x) => `${x.falseUncertain}`),
    row('Injection attempts detected', (x) => `${x.injection.detected}/${x.injection.cases} (false flags: ${x.injection.falseFlags})`),
    row('Arithmetic-mismatch flags', (x) => `${x.arithmeticFlags}`),
    row('Latency mean / p50 / p95 (ms)', (x) => `${x.latencyMs.mean} / ${x.latencyMs.p50} / ${x.latencyMs.p95}`),
    row('Cost per receipt (USD)', (x) => (x.costPerReceiptUsd === null ? 'unknown' : `$${x.costPerReceiptUsd.toFixed(4)}`)),
    row('Mean tokens in / out', (x) => `${x.meanTokens.input} / ${x.meanTokens.output}`),
    ``,
    `## Per-field accuracy`,
    ``,
    `| Field | ${s.map((x) => `\`${x.model}\``).join(' | ')} |`,
    `|---|${s.map(() => '---').join('|')}|`,
    ...FIELDS.map((f) => `| ${f} | ${s.map((x) => `${x.perField[f]}/${x.receipts}`).join(' | ')} |`),
    ``,
    `## Every miss`,
    ``,
  ];
  for (const [model, cases] of Object.entries(report.cases)) {
    const misses = cases.filter((c) => FIELDS.some((f) => !c.fields[f]) || c.status !== 'SUCCEEDED' || c.flags.length);
    lines.push(`### \`${model}\``, '');
    if (!misses.length) lines.push('No misses.', '');
    for (const c of misses) {
      const wrong = FIELDS.filter((f) => !c.fields[f]);
      lines.push(`- **${c.id}** (${c.format}) ${c.status}${wrong.length ? ` · wrong: ${wrong.join(', ')}` : ''}${c.uncertain.length ? ` · uncertain: ${c.uncertain.join(', ')}` : ''}${c.flags.length ? ` · flags: ${c.flags.join(', ')}` : ''}${c.silentDecisionErrors.length ? ` · **silent: ${c.silentDecisionErrors.join(', ')}**` : ''}${c.error ? ` · ${c.error}` : ''}`);
    }
    lines.push('');
  }
  lines.push(
    `## Method and limits`,
    ``,
    `- Receipts are synthetic renders (photos simulated with blur, rotation and perspective), not real camera photos; real-world accuracy will be lower.`,
    `- For images there is no independent text layer, so quote verification checks the model's quotes against its own transcription; this catches internal inconsistency, not misreading.`,
    `- Merchant counts as correct at normalised similarity ≥ 0.75; receipt numbers compare alphanumerics only; VAT is scored on presence.`,
    `- n is small (${s[0]?.receipts ?? 0}); differences of one or two receipts are within noise.`,
  );
  return lines.join('\n');
}

export const evalCommands: Record<string, Command> = {
  'eval:generate': {
    describe: 'Render and freeze the held-out receipt set (refuses to overwrite a frozen set without --force)',
    run: async (args) => {
      const { values } = parseArgs({ args, options: { force: { type: 'boolean' } } });
      const problems = HELDOUT.map(checkConsistency).filter((p): p is string => p !== null);
      if (problems.length) throw new Error(`dataset inconsistent:\n${problems.join('\n')}`);
      const existing = await readFile(path.join(DATASET_DIR, 'manifest.json'), 'utf8').catch(() => null);
      if (existing && !values.force) throw new Error('held-out set already frozen (manifest.json exists); use --force only to deliberately replace it');
      await mkdir(DATASET_DIR, { recursive: true });
      const renderer = new ReceiptRenderer();
      const files: Manifest['files'] = {};
      try {
        for (const e of HELDOUT) {
          const out = await renderer.render(e.spec, e.format);
          const file = `${e.id}.${out.ext}`;
          await writeFile(path.join(DATASET_DIR, file), out.bytes);
          files[e.id] = { file, mime: out.mime, sha256: sha256(out.bytes) };
        }
      } finally {
        await renderer.close();
      }
      const labels = `${JSON.stringify(Object.fromEntries(HELDOUT.map((e) => [e.id, e.label])), null, 2)}\n`;
      await writeFile(path.join(DATASET_DIR, 'labels.json'), labels);
      const manifest: Manifest = { split: 'heldout', generatedAt: new Date().toISOString(), files, labelsSha256: sha256(labels) };
      await writeFile(path.join(DATASET_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`Froze ${HELDOUT.length} held-out receipts in ${DATASET_DIR}`);
    },
  },
  'eval:benchmark': {
    describe: 'Benchmark extraction models on the frozen held-out set: --models gpt-5.5,gpt-5.4-mini [--record|--replay] [--concurrency 4]',
    run: async (args) => {
      loadLocalEnv();
      const { values } = parseArgs({ args, options: { models: { type: 'string' }, record: { type: 'boolean' }, replay: { type: 'boolean' }, concurrency: { type: 'string' } } });
      const models = (values.models ?? 'gpt-5.5,gpt-5.4-mini').split(',').map((m) => m.trim()).filter(Boolean);
      const { entries, manifestHash } = await loadDataset();
      const effort = process.env.SB_OPENAI_REASONING_EFFORT ?? 'medium';
      const cases: Record<string, CaseResult[]> = {};
      for (const model of models) {
        console.log(`Running ${model} on ${entries.length} held-out receipts…`);
        cases[model] = await runModel(model, entries, { record: !!values.record, replay: !!values.replay, concurrency: Number(values.concurrency ?? 4) });
      }
      const summaries = models.map((m) => summarise(m, cases[m]!));
      const runAt = new Date().toISOString();
      const report = { runAt, manifestHash, effort, summaries, cases };
      await mkdir(REPORT_DIR, { recursive: true });
      const base = path.join(REPORT_DIR, `benchmark-${runAt.replace(/[:.]/g, '-')}`);
      await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(`${base}.md`, `${markdown(report)}\n`);
      console.log(markdown(report));
      console.log(`\nReport: ${base}.md`);
    },
  },
};
