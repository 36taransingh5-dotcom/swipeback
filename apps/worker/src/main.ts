/**
 * Swipeback worker — where the product actually runs: inbound processing, extraction, policy
 * decisions, follow-ups, payout authorisation, simulated payouts and outbound delivery.
 *
 *   corepack pnpm worker
 */
import { JobRunner } from '@swipeback/db';
import { activeGmailConnections, createRuntime, engineHandlers, loadLocalEnv, pollGmailConnection } from '@swipeback/engine';

loadLocalEnv();
const { pool, deps, gmail } = createRuntime();
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

// Connected mailbox polling (Gmail). Non-overlapping loop; a DB advisory lock makes it safe across workers.
let polling = true;
const pollEvery = Number(process.env.SB_GMAIL_POLL_SECONDS ?? 10) * 1000;
const pollLoop = (async () => {
  if (!gmail) {
    console.log('[worker] Gmail not configured (GOOGLE_OAUTH_* / SB_TOKEN_ENCRYPTION_KEY); mailbox polling off');
    return;
  }
  console.log(`[worker] polling connected Gmail mailboxes every ${pollEvery / 1000}s`);
  while (polling) {
    for (const id of await activeGmailConnections(pool).catch(() => [] as string[])) {
      try {
        const r = await pollGmailConnection(deps, gmail.tokens, id);
        if (r.fetched || r.status !== 'OK') console.log(`[worker] gmail ${id.slice(0, 8)}: ${r.status} fetched=${r.fetched} accepted=${r.accepted} skipped=${r.skipped}${r.resynced ? ' (resynced)' : ''}`);
      } catch (err) {
        console.error(`[worker] gmail ${id.slice(0, 8)} poll failed: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, pollEvery));
  }
})();

const shutdown = async () => {
  console.log('[worker] stopping…');
  polling = false;
  await Promise.race([pollLoop, new Promise((r) => setTimeout(r, 2000))]);
  await Promise.all(runners.map((r) => r.stop()));
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
