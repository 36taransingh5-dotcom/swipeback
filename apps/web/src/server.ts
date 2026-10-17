/**
 * Swipeback web: authenticated reviewer screens + API. Run alongside the worker.
 *
 *   corepack pnpm web
 */
import { serve } from '@hono/node-server';
import { createRuntime, loadLocalEnv } from '@swipeback/engine';
import { createApp } from './app.ts';

loadLocalEnv();
const { deps } = createRuntime();
const port = Number(process.env.PORT ?? 3000);
const app = createApp(deps, { secureCookies: (process.env.SB_APP_URL ?? '').startsWith('https://') });
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => {
  console.log(`[web] listening on http://${info.address}:${info.port} (app url ${deps.config.appUrl})`);
});
