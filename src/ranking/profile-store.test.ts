import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  createCandidateProfile,
  deleteCandidateProfile,
  listCandidateProfiles,
  reviseCandidateProfile,
} from './profile-store.js';

/**
 * `listCandidateProfiles` is the profile hub's one query (`/profile`) —
 * these tests exist to pin the two things widening it added: `claimCount`
 * must reflect only the CURRENT version's claims (never a superseded one,
 * matching `loadCandidateProfile`'s own rule), and the order must be
 * explicit rather than incidental, per this project's own repeated lesson
 * about unordered result sets (Phase 3E's `getSourceHealth` finding).
 */
describe('listCandidateProfiles', () => {
  const profileIds: string[] = [];

  afterEach(async () => {
    for (const id of profileIds.splice(0)) {
      await deleteCandidateProfile(db, id);
    }
  });

  it('reports claimCount for the claims actually created', async () => {
    const { profileId } = await createCandidateProfile(db, {
      label: 'profile-store test: three claims',
      claims: [
        { kind: 'skill', value: 'TypeScript' },
        { kind: 'skill', value: 'PostgreSQL' },
        { kind: 'language', value: 'English' },
      ],
      now: new Date().toISOString(),
    });
    profileIds.push(profileId);

    const rows = await listCandidateProfiles(db);
    const row = rows.find((r) => r.profileId === profileId);
    expect(row?.claimCount).toBe(3);
  });

  it('reports 0 for a profile created with no claims', async () => {
    const { profileId } = await createCandidateProfile(db, {
      label: 'profile-store test: no claims',
      claims: [],
      now: new Date().toISOString(),
    });
    profileIds.push(profileId);

    const rows = await listCandidateProfiles(db);
    const row = rows.find((r) => r.profileId === profileId);
    expect(row?.claimCount).toBe(0);
  });

  it('counts only the CURRENT version’s claims after a revision, not a superseded version’s', async () => {
    const { profileId } = await createCandidateProfile(db, {
      label: 'profile-store test: revised',
      claims: [
        { kind: 'skill', value: 'TypeScript' },
        { kind: 'skill', value: 'PostgreSQL' },
      ],
      now: new Date().toISOString(),
    });
    profileIds.push(profileId);

    // Version 2 carries a different claim count than version 1 did.
    await reviseCandidateProfile(db, {
      profileId,
      claims: [{ kind: 'skill', value: 'TypeScript', origin: 'confirmed' }],
      now: new Date().toISOString(),
    });

    const rows = await listCandidateProfiles(db);
    const row = rows.find((r) => r.profileId === profileId);
    expect(row?.version).toBe(2);
    expect(row?.claimCount).toBe(1);
  });

  it('orders newest first, explicitly rather than incidentally', async () => {
    const now = Date.now();
    const { profileId: older } = await createCandidateProfile(db, {
      label: 'profile-store test: older',
      claims: [],
      now: new Date(now - 60_000).toISOString(),
    });
    profileIds.push(older);
    const { profileId: newer } = await createCandidateProfile(db, {
      label: 'profile-store test: newer',
      claims: [],
      now: new Date(now).toISOString(),
    });
    profileIds.push(newer);

    const rows = await listCandidateProfiles(db);
    const olderIndex = rows.findIndex((r) => r.profileId === older);
    const newerIndex = rows.findIndex((r) => r.profileId === newer);
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('excludes a deleted profile', async () => {
    const { profileId } = await createCandidateProfile(db, {
      label: 'profile-store test: to delete',
      claims: [],
      now: new Date().toISOString(),
    });

    await deleteCandidateProfile(db, profileId);

    const rows = await listCandidateProfiles(db);
    expect(rows.some((r) => r.profileId === profileId)).toBe(false);
  });
});
