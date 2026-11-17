import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { FAKE_PHOTO_GUID, fakePhone, fakeUserId } from '../adapters/ss-ge/fakes.js';
import { db } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { recordPosterStep } from './poster-identity.js';
import { recordPosterSightings } from './posters.js';

/**
 * The role scripts' Phase 17B and 17G grants, run for real against probe
 * roles inside one transaction that is rolled back: the worker part of
 * `scripts/sql/phase-8b-worker-admin-migration-roles.sql`, its admin part,
 * and all of `scripts/sql/phase-8b-public-role.sql`. The worker must write
 * and read the private directory under its grants alone; the public role
 * (the website's and Hermes's) and the admin role must reach none of it,
 * and the check `deploy/apply-db-roles.sh` runs must say so, and must catch
 * a grant given by mistake.
 */

class RolledBack extends Error {}

/** drizzle wraps the database's error ("Failed query: …") and keeps it as the cause. */
const deniedByPostgres = (err: unknown) =>
  err instanceof Error &&
  err.cause instanceof Error &&
  /^permission denied for (schema|table|view)/.test(err.cause.message);

/** The privacy query `deploy/apply-db-roles.sh` runs, read from the script itself. */
function exposureQuery(): string {
  const script = readFileSync('deploy/apply-db-roles.sh', 'utf8');
  const match =
    /exposed="\$\(runuser -u postgres -- psql -X -tA --dbname="\$database" -c "([\s\S]*?)"\)"/.exec(
      script,
    );
  if (match?.[1] === undefined) throw new Error('apply-db-roles.sh has no exposure check');
  return match[1];
}

describe('the role scripts, for the Phase 17B and 17G private schemas', () => {
  it('let the worker keep the directory, and neither the public nor the admin role reach it', async (context) => {
    const { rows } = await db.execute<{ may: boolean; database: string }>(sql`
      select rolsuper or rolcreaterole as may, current_database() as database
        from pg_roles where rolname = current_user`);
    if (!rows[0]?.may) context.skip('this database user cannot create a role');
    const database = rows[0]?.database as string;

    const suffix = randomBytes(4).toString('hex');
    const worker = `xtelo_probe_worker_${suffix}`;
    const publicRole = `xtelo_probe_public_${suffix}`;
    const admin = `xtelo_probe_admin_${suffix}`;
    const password = randomBytes(16).toString('hex');
    const fill = (text: string) =>
      text
        .replaceAll('scraplify_worker', worker)
        .replaceAll('scraplify_public', publicRole)
        .replaceAll('scraplify_admin', admin)
        .replaceAll(/<STRONG_PASSWORD_HERE(_[A-Z]+)?>/g, password)
        .replaceAll('<TARGET_DATABASE>', `"${database}"`);
    const roleScript = readFileSync(
      'scripts/sql/phase-8b-worker-admin-migration-roles.sql',
      'utf8',
    );
    const [workerPart, rest] = roleScript.split('-- 2. scraplify_admin') as [string, string];
    const adminPart = `-- 2. scraplify_admin${rest.split('-- 3. scraplify_migration')[0]}`;
    const publicScript = readFileSync('scripts/sql/phase-8b-public-role.sql', 'utf8');
    const exposure = exposureQuery()
      .replaceAll('scraplify_public', publicRole)
      .replaceAll('scraplify_admin', admin);
    const exposed = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
      Number((await tx.execute<{ count: string }>(sql.raw(exposure))).rows[0]?.count ?? Number.NaN);

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(fill(workerPart)));
        await tx.execute(sql.raw(fill(adminPart)));
        await tx.execute(sql.raw(fill(publicScript)));

        const sourceId = randomUUID();
        await tx.insert(sources).values({
          id: sourceId,
          slug: `test-source-${sourceId}`,
          displayName: 'Test source',
          baseUrl: 'https://example.invalid/',
        });

        // As the worker: a page's sightings, then the nightly step.
        await tx.execute(sql.raw(`set local role ${worker}`));
        const written = await recordPosterSightings(tx, {
          sourceId,
          seenAt: '2026-12-02T01:00:00.000Z',
          sightings: [1, 2].map((n) => ({
            sourceListingKey: `g${n}`,
            account: { userId: fakeUserId(90 + n), displayName: 'შპს გამოგონილი' },
            contacts: [
              { kind: 'phone', value: fakePhone(90), contactName: '', seenIn: 'listing_page' },
            ],
            photos: {
              origin: 'row',
              refs: [`20241105/${n}_${FAKE_PHOTO_GUID}.jpg`],
              mainRef: null,
              imageCount: 1,
              photos: [],
            },
          })),
        });
        expect(written).toMatchObject({ accountsWritten: 2, photoSetsOpened: 2 });
        await recordPosterSightings(tx, {
          sourceId,
          seenAt: '2026-12-03T01:00:00.000Z',
          sightings: [
            {
              sourceListingKey: 'g1',
              account: null,
              contacts: [],
              photos: { origin: 'row', refs: [], mainRef: null, imageCount: 0, photos: [] },
            },
          ],
        });
        const stepped = await recordPosterStep(tx, {
          sourceId,
          now: '2026-12-03T13:30:00.000Z',
          crawlRunId: null,
        });
        expect(stepped).toMatchObject({ ok: true, error: null, linksWritten: 2 });

        // As the public role, then the admin role: nothing in either schema.
        for (const role of [publicRole, admin]) {
          await tx.execute(sql.raw('reset role'));
          await tx.execute(sql.raw(`set local role ${role}`));
          for (const relation of [
            'realestate_contacts.poster_accounts',
            'realestate_contacts.contacts',
            'realestate_contacts.listing_contacts',
            'realestate_contacts.poster_entities',
            'realestate_contacts.poster_daily',
            'realestate_media.listing_photo_refs',
            'realestate_media.photo_refs',
          ]) {
            await expect(
              tx.transaction((sp) => sp.execute(sql.raw(`select count(*) from ${relation}`))),
              `${role} reads ${relation}`,
            ).rejects.toSatisfy(deniedByPostgres);
          }
        }

        // The deploy's own check: nothing exposed, and a mistaken grant caught.
        await tx.execute(sql.raw('reset role'));
        expect(await exposed(tx)).toBe(0);
        await tx.execute(sql.raw(`grant usage on schema realestate_media to ${publicRole}`));
        await tx.execute(sql.raw(`grant select on realestate_media.photo_refs to ${publicRole}`));
        expect(await exposed(tx)).toBe(2);
        await tx.execute(sql.raw(`grant select (ref) on realestate_media.photo_refs to ${admin}`));
        expect(await exposed(tx)).toBe(3);
        // A view elsewhere that reads the directory, granted to the public role.
        await tx.execute(
          sql.raw(`create view public.probe_leak_${suffix} as
                     select count(*) as n from realestate_contacts.poster_accounts`),
        );
        await tx.execute(sql.raw(`grant select on public.probe_leak_${suffix} to ${publicRole}`));
        expect(await exposed(tx)).toBe(4);
        // The public role script takes the table grants back on a re-run.
        await tx.execute(sql.raw(fill(publicScript)));
        expect(await exposed(tx)).toBe(2);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  });
});
