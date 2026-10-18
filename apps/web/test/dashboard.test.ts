import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '@swipeback/web';
import { createHarness, type Harness } from '../../../packages/engine/test/harness.ts';

let h: Harness;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  h = await createHarness();
  app = createApp(h.deps, { secureCookies: false });
});
afterAll(async () => { await h.close(); });

async function cookie(memberId: string) {
  const token = randomBytes(32).toString('base64url');
  await h.db.pool.query(
    `INSERT INTO sessions (member_id, token_hash, expires_at) VALUES ($1,$2,clock_timestamp() + interval '1 hour')`,
    [memberId, createHash('sha256').update(token).digest('hex')],
  );
  return `sb_session=${token}`;
}

const get = (path: string, session?: string) => app.request(`http://localhost:3000${path}`,
  session ? { headers: { cookie: session } } : undefined);

describe('team dashboard', () => {
  it('is hosted at /dashboard, gated by role, and scoped to the signed-in workspace', async () => {
    expect((await get('/dashboard')).headers.get('location')).toBe('/login?next=%2Fdashboard');
    const employee = await cookie(h.org.members.employee);
    expect((await get('/dashboard', employee)).status).toBe(303); // Employees cannot open reviewer sessions.
    const payer = (await h.db.pool.query<{ id: string }>(
      `INSERT INTO members (organisation_id, email, display_name, roles)
       VALUES ($1, 'payer@northwind.example', 'Payment approver', ARRAY['payment_approver']) RETURNING id`,
      [h.org.organisationId])).rows[0]!.id;
    expect((await get('/dashboard', await cookie(payer))).status).toBe(403);

    await h.db.pool.query(`INSERT INTO expenses (organisation_id, member_id, source_type, state, merchant, amount_minor, currency)
      VALUES ($1, $2, 'EMAIL', 'RECEIVED', 'Northwind lunch', 1200, 'GBP')`,
    [h.org.organisationId, h.org.members.employee]);
    const otherOrg = (await h.db.pool.query<{ id: string }>(
      `INSERT INTO organisations (name) VALUES ('Other workspace') RETURNING id`)).rows[0]!.id;
    const otherAdmin = (await h.db.pool.query<{ id: string }>(
      `INSERT INTO members (organisation_id, email, display_name, roles)
       VALUES ($1, 'admin@other.example', 'Other Admin', ARRAY['admin']) RETURNING id`, [otherOrg])).rows[0]!.id;
    await h.db.pool.query(`INSERT INTO expenses (organisation_id, member_id, source_type, state, merchant, amount_minor, currency)
      VALUES ($1, $2, 'EMAIL', 'RECEIVED', 'Other workspace dinner', 3200, 'GBP')`, [otherOrg, otherAdmin]);

    const northwind = await get('/dashboard', await cookie(h.org.members.controller));
    expect(northwind.status).toBe(200);
    const northwindHtml = await northwind.text();
    expect(northwindHtml).toContain('Team activity');
    expect(northwindHtml).toContain('Northwind lunch');
    expect(northwindHtml).toContain('Open review queue');
    expect(northwindHtml).not.toContain('Other workspace dinner');

    const other = await get('/dashboard', await cookie(otherAdmin));
    expect(other.status).toBe(200);
    const otherHtml = await other.text();
    expect(otherHtml).toContain('Other workspace dinner');
    expect(otherHtml).not.toContain('Northwind lunch');
  });

  it('serves real provider artwork and labels future connections clearly', async () => {
    const start = await get('/start');
    const html = await start.text();
    expect(html).toContain('/static/providers/gmail');
    expect(html).toContain('/static/providers/slack');
    expect(html).toContain('/static/providers/imessage');
    expect(html).toContain('Via BlueBubbles.');
    expect(html.match(/Coming soon/g)).toHaveLength(2);
    for (const [name, type] of [['gmail', 'image/svg+xml'], ['slack', 'image/png'], ['imessage', 'image/jpeg']]) {
      const image = await get(`/static/providers/${name}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain(type);
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    expect((await get('/static/providers/constructor')).status).toBe(404);
  });
});
