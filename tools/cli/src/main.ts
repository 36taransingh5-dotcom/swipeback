#!/usr/bin/env tsx
/**
 * Swipeback developer console. Not an employee interface: seed data, run the local database,
 * replay scenarios and run evaluations.
 *
 *   corepack pnpm sb <command> [--flags]
 */
import path from 'node:path';
import {
  createPool,
  databaseUrl,
  DEV_PG_PORT,
  isLocalDatabaseUrl,
  jobStats,
  migrate,
  resetSchema,
  verifyAuditChain,
} from '@swipeback/db';
import { extractionCommands } from './extraction-commands.ts';
import { pipelineCommands } from './pipeline-commands.ts';
import { seedDemoOrg, seedOptionsFromEnv } from './seed.ts';

type Command = (args: string[]) => Promise<void>;

const commands: Record<string, { describe: string; run: Command }> = {
  'db:start': {
    describe: `Run the local embedded Postgres in the foreground (port ${DEV_PG_PORT}, data in .data/pg)`,
    run: async () => {
      const { startEmbeddedPostgres } = await import('@swipeback/db/embedded');
      const cluster = await startEmbeddedPostgres({
        dataDir: path.resolve('.data/pg'),
        port: DEV_PG_PORT,
        persistent: true,
        quiet: true,
      });
      await cluster.createDatabase('swipeback');
      console.log(`Postgres ready at ${cluster.url('swipeback').replace(/:[^:@/]+@/, ':***@')}  (Ctrl+C to stop)`);
      await new Promise<void>((resolve) => {
        const stop = () => void cluster.stop().then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    },
  },
  'db:migrate': {
    describe: 'Apply pending migrations and sync state machine tables',
    run: async () => {
      await withPool(async (pool) => {
        const r = await migrate(pool);
        console.log(`Applied: ${r.applied.join(', ') || 'none'}; already applied: ${r.alreadyApplied.length}`);
      });
    },
  },
  'db:reset': {
    describe: 'Drop and recreate the local database schema, then migrate (local databases only)',
    run: async () => {
      const url = databaseUrl();
      if (!isLocalDatabaseUrl(url)) throw new Error('Refusing to reset a non-local database.');
      await withPool(async (pool) => {
        await resetSchema(pool);
        const r = await migrate(pool);
        console.log(`Schema reset. Applied: ${r.applied.join(', ')}`);
      });
    },
  },
  seed: {
    describe: 'Create the synthetic demo organisation (idempotent)',
    run: async () => {
      await withPool(async (pool) => {
        const org = await seedDemoOrg(pool, seedOptionsFromEnv());
        console.log(`${org.created ? 'Seeded' : 'Already seeded'} organisation ${org.organisationId}`);
      });
    },
  },
  'audit:verify': {
    describe: 'Verify the audit hash chain for every organisation',
    run: async () => {
      await withPool(async (pool) => {
        const orgs = await pool.query<{ id: string; name: string }>('SELECT id, name FROM organisations');
        let failed = false;
        for (const o of orgs.rows) {
          const r = await verifyAuditChain(pool, o.id);
          failed ||= !r.ok;
          console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${o.name}: ${r.checked} events, head ${r.headHash ?? '-'}`);
          for (const p of r.problems) console.log(`     seq ${p.seq}: ${p.problem}`);
        }
        if (failed) process.exitCode = 1;
      });
    },
  },
  'jobs:stats': {
    describe: 'Show job queue counts by state',
    run: async () => {
      await withPool(async (pool) => console.log(await jobStats(pool)));
    },
  },
  ...pipelineCommands,
  ...extractionCommands,
};

async function withPool(fn: (pool: ReturnType<typeof createPool>) => Promise<void>): Promise<void> {
  const pool = createPool(databaseUrl(), 2);
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  const cmd = name ? commands[name] : undefined;
  if (!cmd) {
    console.log('Usage: corepack pnpm sb <command>\n');
    for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(16)} ${c.describe}`);
    process.exitCode = name ? 1 : 0;
    return;
  }
  await cmd.run(rest);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
