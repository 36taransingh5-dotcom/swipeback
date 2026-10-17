import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberSpend, parseSpendFilters, parseTeamFilters, ReviewError, teamOverview, type SessionMember } from '@swipeback/engine';
import { createApp } from '@swipeback/web';
import { textReceipt } from '../../../test/fixtures/receipts.ts';
import { ALEX, CONTROLLER, createHarness, isoAt, ukDate, type Harness } from '../../../packages/engine/test/harness.ts';

/** Team spend dashboard: per-person totals, category breakdown, sortable and filterable transactions. */

let h: Harness;
let server: ServerType;
let base: string;
let browser: Browser;
let finance: SessionMember;

const attach = (content: string) => [{ filename: 'receipt.txt', mime: 'text/plain', content }];
const receipt = (merchant: string, total: string, daysAgo: number, card = '9911') =>
  textReceipt({ merchant, receiptNo: `R-${Math.floor(Math.random() * 1e6)}`, date: ukDate(daysAgo), items: [['Item', total]], total, paidWith: { card } });

beforeAll(async () => {
  h = await createHarness();
  server = serve({ fetch: createApp(h.deps, { secureCookies: false }).fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.deps.config.appUrl = base;
  browser = await chromium.launch({ headless: true });

  // Sam: a company-card lunch, a personal train fare and a hotel that needs review. Alex: one coffee.
  await h.card({ amountMinor: 1125, merchantDescriptor: 'PRET A MANGER LONDON GB', transactedAt: isoAt(1) });
  await h.email({ subject: 'Lunch', text: 'Purpose: Lunch on site during the Acme boiler install', attachments: attach(receipt('Pret A Manger (Europe) Ltd', '11.25', 1, '4242')) });
  await h.email({ subject: 'Train', text: 'Purpose: Travel to the Acme site visit', attachments: attach(receipt('Trainline', '42.10', 3)) });
  await h.email({ subject: 'Hotel', text: 'Purpose: Overnight for the Acme install', attachments: attach(textReceipt({ merchant: 'Premier Stay Hotel Watford', receiptNo: 'H-1', date: ukDate(2), items: [['Room, 1 night', '210.00']], total: '210.00', vat: '35.00', vatNumber: 'GB000000000', paidWith: { card: '9911' } })) });
  await h.email({ from: ALEX, subject: 'Coffee', text: 'Purpose: Coffee before the Acme site meeting', attachments: attach(receipt('Costa Coffee', '8.40', 5)) });
  await h.drain();

  const m = (await h.db.pool.query<{ id: string; display_name: string; email: string; roles: string[] }>('SELECT id, display_name, email, roles FROM members WHERE id = $1', [h.org.members.controller])).rows[0]!;
  finance = { memberId: m.id, organisationId: h.org.organisationId, email: m.email, displayName: m.display_name, roles: m.roles };
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  await h.close();
});

const sam = () => h.org.members.employee;

describe('team spend read models', () => {
  it('totals each person and sorts by spend; people with no spend are still listed', async () => {
    const t = await teamOverview(h.deps, finance, parseTeamFilters({}));
    expect(t.members[0]).toMatchObject({ memberId: sam(), expenseCount: 3, totals: [{ currency: 'GBP', amountMinor: 26335 }], cards: ['4242'] });
    expect(t.members[1]).toMatchObject({ expenseCount: 1, totals: [{ currency: 'GBP', amountMinor: 840 }] });
    expect(t.members.filter((m) => m.expenseCount === 0).length).toBe(t.members.length - 2);
    expect(t.totals).toEqual([{ currency: 'GBP', amountMinor: 27175 }]);
    expect(t.byCategory.reduce((n, c) => n + c.count, 0)).toBe(4);

    const byName = await teamOverview(h.deps, finance, parseTeamFilters({ sort: 'name' }));
    expect(byName.members.map((m) => m.name)).toEqual([...byName.members.map((m) => m.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('filters by category and date, and sorts a person\'s transactions', async () => {
    const meals = await teamOverview(h.deps, finance, parseTeamFilters({ category: 'MEALS' }));
    expect(meals.byCategory.map((c) => c.category)).toEqual(['MEALS']);
    expect(meals.members.find((m) => m.memberId === sam())!.totals).toEqual([{ currency: 'GBP', amountMinor: 1125 }]);

    const byAmount = await memberSpend(h.deps, finance, sam(), parseSpendFilters({ sort: 'amount' }));
    expect(byAmount.rows.map((r) => r.amountMinor)).toEqual([21000, 4210, 1125]);
    const cheapestFirst = await memberSpend(h.deps, finance, sam(), parseSpendFilters({ sort: 'amount', dir: 'asc' }));
    expect(cheapestFirst.rows.map((r) => r.amountMinor)).toEqual([1125, 4210, 21000]);
    const newestFirst = await memberSpend(h.deps, finance, sam(), parseSpendFilters({}));
    expect(newestFirst.rows.map((r) => r.merchant)).toEqual(['Pret A Manger (Europe) Ltd', 'Premier Stay Hotel Watford', 'Trainline']);
    expect(newestFirst.rows[0]).toMatchObject({ paymentType: 'CORPORATE', cardLast4: '4242' });

    const lastTwoDays = await memberSpend(h.deps, finance, sam(), parseSpendFilters({ from: newestFirst.rows[1]!.date }));
    expect(lastTwoDays.rows.map((r) => r.amountMinor)).toEqual([1125, 21000]);
    const inReview = await memberSpend(h.deps, finance, sam(), parseSpendFilters({ state: 'REVIEW_REQUIRED' }));
    expect(inReview.rows.map((r) => r.merchant)).toEqual(['Premier Stay Hotel Watford']);
  });

  it('ignores unrecognised filter values instead of passing them on', () => {
    expect(parseSpendFilters({ sort: 'amount; DROP TABLE expenses', dir: 'sideways', from: '2026-13-40', category: 'BRIBES', state: 'MERGED' })).toEqual({
      from: null, to: null, category: null, state: null, sort: 'date', dir: 'desc',
    });
  });

  it('is finance-only and tenant-scoped', async () => {
    const employee: SessionMember = { ...finance, memberId: sam(), roles: ['employee'] };
    await expect(teamOverview(h.deps, employee, parseTeamFilters({}))).rejects.toBeInstanceOf(ReviewError);
    const otherOrg: SessionMember = { ...finance, organisationId: '00000000-0000-0000-0000-000000000000' };
    await expect(memberSpend(h.deps, otherOrg, sam(), parseSpendFilters({}))).rejects.toMatchObject({ status: 404 });
    expect((await teamOverview(h.deps, otherOrg, parseTeamFilters({}))).members).toEqual([]);
  });
});

async function signIn(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/team`);
  await page.fill('input[name=email]', CONTROLLER);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=check-email]');
  await h.drain();
  const link = new RegExp(`${base}/auth/callback\\?t=[\\w-]+`).exec(h.sentTo(CONTROLLER).at(-1)!.envelope.text)![0];
  await page.goto(link);
  return page;
}

describe('team spend pages', () => {
  it('lists people, drills into one, sorts by a column and filters by category', async () => {
    const page = await signIn();
    const violations: string[] = [];
    page.on('console', (m) => m.type() === 'error' && violations.push(m.text()));
    expect(new URL(page.url()).pathname).toBe('/team');
    await expect(page.textContent('[data-testid=team-total]')).resolves.toBe('£271.75');
    expect(await page.getAttribute('[data-testid=team-row]', 'data-member')).toBe(sam());
    const bar = await page.$eval('[data-testid=category-breakdown] .bar span', (el) => el.getBoundingClientRect().width);
    expect(bar).toBeGreaterThan(0); // widths come from stylesheet classes, which CSP allows

    await page.click(`[data-member="${sam()}"] a`);
    await page.waitForSelector('[data-testid=transactions]');
    await expect(page.textContent('[data-testid=member-total]')).resolves.toContain('£263.35');
    await page.click('[data-sort=amount]');
    await page.waitForURL(/sort=amount&dir=desc/);
    expect(await page.$$eval('[data-testid=transaction]', (rows) => rows.map((r) => r.querySelector('.num')!.textContent))).toEqual(['£210.00', '£42.10', '£11.25']);
    await page.click('[data-sort=amount]');
    await page.waitForURL(/dir=asc/);
    expect(await page.$$eval('[data-testid=transaction]', (rows) => rows.map((r) => r.querySelector('.num')!.textContent))).toEqual(['£11.25', '£42.10', '£210.00']);

    await page.selectOption('select[name=category]', 'MEALS');
    await page.click('[data-testid=filters] button[type=submit]');
    await page.waitForURL(/category=MEALS/);
    expect(await page.$$eval('[data-testid=transaction]', (rows) => rows.map((r) => r.getAttribute('data-category')))).toEqual(['MEALS']);

    // The transaction links to the full case, with receipt and audit trail.
    await page.click('[data-testid=transaction] a');
    await page.waitForSelector('[data-testid=case]');
    expect(violations).toEqual([]);

    const api = await page.context().request.get(`${base}/api/team/${sam()}/expenses?sort=amount`);
    expect(((await api.json()) as { rows: { amountMinor: number }[] }).rows.map((r) => r.amountMinor)).toEqual([21000, 4210, 1125]);
    await page.context().close();
  });

  it('requires sign-in and 404s an unknown person', async () => {
    expect((await fetch(`${base}/api/team`)).status).toBe(401);
    const page = await signIn();
    const res = await page.goto(`${base}/team/00000000-0000-0000-0000-000000000000`);
    expect(res!.status()).toBe(404);
    await page.context().close();
  });
});
