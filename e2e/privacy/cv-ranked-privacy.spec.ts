import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Request, test } from '@playwright/test';
import pg from 'pg';
import { PRIVACY_ORIGIN, PRIVACY_SERVER_LOG } from './server.js';

/**
 * Phase 8D exit gate (change.md §13): "a canary CV produces only allowlisted
 * same-origin GET requests for public assets — no upload/mutation — and
 * leaves no canary text, file metadata, candidate row or ranking in server
 * logs/database."
 *
 * A unique canary goes into the CV's text, its file name and a role the
 * visitor types. The whole landing → /cv-ranked → edit → clear flow is then
 * run against a real `public` production server, and afterwards:
 *
 * - every request the page AND its worker made is a same-origin GET with no
 *   body, to an allowlisted public path, with no canary anywhere in its URL;
 * - no cookie, Web Storage, IndexedDB or Cache Storage entry holds it;
 * - the server's own captured output does not contain it;
 * - no text or JSON column in any database table contains it, and the
 *   candidate/ranking tables have exactly the rows they had before.
 */

const CANDIDATE_TABLES = [
  'candidate_profiles',
  'candidate_profile_claims',
  'rankings',
  'outreach_drafts',
] as const;

/** Public paths CV Ranked may touch. Everything else fails the test. */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/cv-ranked$/,
  /^\/_next\/static\//,
  /^\/api\/matching\/manifest$/,
  /^\/api\/matching\/bundles\/[0-9a-f-]{36}\/opportunities\.json$/,
  /^\/(icon\.svg|logo\.png|hero-bg\.mp4|favicon\.ico)$/,
];

function canaryPdfHtml(canary: string): string {
  return `<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif">
<h1>Canary Candidate ${canary}</h1>
<p>ბუღალტერი ${canary} ბუღალტერი — შპს სანიმუშო ვაჭრობა, 2019–2025.</p>
<p>ფინანსური ანგარიშგება, საგადასახადო დეკლარაციები, IFRS, Excel, 1C. ${canary}</p>
<p>Accountant ${canary}. Financial reporting, payroll, bank reconciliation.</p>
</body></html>`;
}

async function withDb<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; run through npm run test:e2e:privacy');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function candidateCounts(): Promise<Record<string, number>> {
  return withDb(async (client) => {
    const counts: Record<string, number> = {};
    for (const table of CANDIDATE_TABLES) {
      const result = await client.query<{ n: string }>(`select count(*) as n from "${table}"`);
      counts[table] = Number(result.rows[0]?.n);
    }
    return counts;
  });
}

/** Every base-table text/JSON column in `public` that contains `needle`. */
async function columnsContaining(needle: string): Promise<string[]> {
  return withDb(async (client) => {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public'
          and t.table_type = 'BASE TABLE'
          and c.data_type in ('text', 'character varying', 'json', 'jsonb')`,
    );
    const hits: string[] = [];
    for (const { table_name, column_name } of columns.rows) {
      const found = await client.query(
        `select 1 from "${table_name}" where strpos("${column_name}"::text, $1) > 0 limit 1`,
        [needle],
      );
      if (found.rowCount) hits.push(`${table_name}.${column_name}`);
    }
    expect(columns.rows.length, 'the column scan found no columns at all').toBeGreaterThan(50);
    return hits;
  });
}

test('a canary CV stays in the browser', async ({ browser }) => {
  test.setTimeout(120_000);
  const canary = `XCANARY${randomBytes(8).toString('hex').toUpperCase()}`;
  const fileName = `cv-${canary}.pdf`;

  // The canary CV, printed by a separate, network-free page.
  const printer = await browser.newPage();
  await printer.setContent(canaryPdfHtml(canary));
  const pdf = await printer.pdf({ format: 'A4' });
  await printer.close();

  const countsBefore = await candidateCounts();

  const context = await browser.newContext({ baseURL: PRIVACY_ORIGIN });
  const requests: Request[] = [];
  context.on('request', (request) => requests.push(request));
  const page = await context.newPage();

  await page.goto('/', { waitUntil: 'networkidle' });
  const firstCvRequest = requests.length;
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: pdf });
  await page.waitForURL('**/cv-ranked');
  const matches = page.getByRole('heading', { name: 'Matches' });
  await expect(matches, 'the canary CV should reach ranked results').toBeVisible({
    timeout: 45_000,
  });

  // The canary really was read: its evidence line is on screen.
  await expect(page.locator('main')).toContainText(canary);

  // Edit: type the canary as a role, toggle a term, ask for more rows.
  const busy = page.locator('[aria-labelledby=results-heading]');
  await page.getByLabel('Add to roles').fill(`Canary ${canary}`);
  await page.getByLabel('Add to roles').press('Enter');
  await expect(busy).toHaveAttribute('aria-busy', 'false');
  await page
    .locator('section[aria-labelledby=profile-heading] input[type=checkbox]')
    .first()
    .click();
  await expect(busy).toHaveAttribute('aria-busy', 'false');
  const more = page.getByRole('button', { name: 'Show more' });
  if (await more.isVisible()) {
    await more.click();
    await expect(busy).toHaveAttribute('aria-busy', 'false');
  }

  // Browser-side persistence, checked while the session is still live.
  const stored = await page.evaluate(async () => {
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i) ?? '';
        return `${key}=${storage.getItem(key)}`;
      });
    return {
      cookie: document.cookie,
      local: dump(localStorage),
      session: dump(sessionStorage),
      indexedDb: (await indexedDB.databases()).map((db) => db.name ?? ''),
      caches: await caches.keys(),
    };
  });
  expect(stored.indexedDb, 'no IndexedDB database is created').toEqual([]);
  expect(stored.caches, 'no Cache Storage is created').toEqual([]);
  expect(JSON.stringify(stored)).not.toContain(canary);
  for (const cookie of await context.cookies()) {
    expect(`${cookie.name}=${cookie.value}`).not.toContain(canary);
  }

  await page.getByRole('button', { name: 'Clear CV' }).click();
  await expect(page.getByText('Choose a CV', { exact: true })).toBeVisible();

  // --- Network --------------------------------------------------------------
  const cvRequests = requests.slice(firstCvRequest);
  const seen = cvRequests.map((request) => new URL(request.url()).pathname);
  expect(seen, 'the worker fetched the manifest').toContain('/api/matching/manifest');
  expect(
    seen.some((path) => path.startsWith('/api/matching/bundles/')),
    'the worker fetched the bundle file',
  ).toBe(true);
  expect(
    seen.some((path) => path.startsWith('/_next/static/') && path.includes('worker')),
    'the worker script itself was observed',
  ).toBe(true);

  for (const request of requests) {
    const url = new URL(request.url());
    const label = `${request.method()} ${url.pathname}${url.search}`;
    expect(url.origin, label).toBe(PRIVACY_ORIGIN);
    expect(request.method(), label).toBe('GET');
    expect(request.postDataBuffer(), label).toBeNull();
    expect(
      ALLOWED_PATHS.some((allowed) => allowed.test(url.pathname)),
      label,
    ).toBe(true);
    const decoded = decodeURIComponent(request.url());
    expect(decoded, label).not.toContain(canary);
    const headers = await request.allHeaders();
    expect(JSON.stringify(headers), `${label} headers`).not.toContain(canary);
  }

  await context.close();

  // --- Server output ----------------------------------------------------------
  const log = readFileSync(PRIVACY_SERVER_LOG, 'utf8');
  expect(log.length, 'the server log was captured').toBeGreaterThan(0);
  expect(log).not.toContain(canary);
  expect(log).not.toContain(fileName);

  // --- Database -----------------------------------------------------------------
  expect(await candidateCounts()).toEqual(countsBefore);
  expect(await columnsContaining(canary)).toEqual([]);
});
