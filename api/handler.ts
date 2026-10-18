import { getRequestListener } from '@hono/node-server';
import { createRuntime } from '@swipeback/engine';
import { createApp } from '../apps/web/src/app.ts';

const { deps, gmail, truelayer } = createRuntime();
const app = createApp(deps, { secureCookies: true, gmail, truelayer });

export default getRequestListener(app.fetch);
