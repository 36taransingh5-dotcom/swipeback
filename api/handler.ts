import { getRequestListener } from '@hono/node-server';
import { createRuntime } from '@swipeback/engine';
import { createApp } from '../apps/web/src/app.ts';

const { deps, gmail, truelayer } = createRuntime();
const app = createApp(deps, { secureCookies: true, gmail, truelayer,
  signupSenderConnectionId: process.env.SB_SIGNUP_CONNECTION_ID ?? null });

export default getRequestListener(app.fetch);
