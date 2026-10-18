import { getRequestListener } from '@hono/node-server';
import { createRuntime } from '@swipeback/engine';
import { createApp } from '../apps/web/src/app.ts';

const { deps, gmail } = createRuntime();
const app = createApp(deps, { secureCookies: true, gmail });

export default getRequestListener(app.fetch);
