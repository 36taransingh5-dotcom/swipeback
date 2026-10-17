/**
 * Swipeback worker — where the product actually runs: inbound processing, extraction, policy
 * decisions, follow-ups, payout authorisation, simulated payouts and outbound delivery.
 *
 *   corepack pnpm worker
 */
import { JobRunner } from '@swipeback/db';
import { createRuntime, engineHandlers, loadLocalEnv } from '@swipeback/engine';

loadLocalEnv();
const { pool, deps } = createRuntime();
const concurrency = Number(process.env.SB_WORKER_CONCURRENCY ?? 2);

const runners = Array.from(
  { length: concurrency },
  (_, i) =>
    new JobRunner(pool, engineHandlers(deps), {
      workerId: `worker-${process.pid}-${i}`,
      onError: (job, err) => console.error(`[worker] ${job.kind}#${job.id} attempt ${job.attempts} failed: ${(err as Error).message}`),
    }),
);
for (const r of runners) r.start();
console.log(`[worker] running ${concurrency} job runner(s); extractor=${deps.extractor.name}, payouts=${deps.payouts.name} (simulated=${deps.payouts.simulated})`);

const shutdown = async () => {
  console.log('[worker] stopping…');
  await Promise.all(runners.map((r) => r.stop()));
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
