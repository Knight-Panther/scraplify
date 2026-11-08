import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client.js';

/**
 * What `realestate.public_listings` shows the website and Hermes (contract
 * C5), as the database holds it, not as the TypeScript says.
 */
describe('realestate.public_listings', () => {
  async function columns(): Promise<string[]> {
    const { rows } = await db.execute<{ name: string }>(sql`
      select column_name as name
        from information_schema.columns
       where table_schema = 'realestate' and table_name = 'public_listings'
       order by ordinal_position
    `);
    return rows.map((row) => row.name);
  }

  it('never shows a pin, what ss.ge worked out from it, or a parcel’s cadastral code', async () => {
    const shown = await columns();
    const privateOnes = [
      'latitude',
      'longitude',
      'ss_metro',
      'pin_manual',
      'cadastral_code',
      'description',
      'details_wanted_at',
      // Phase 14C: what the pin says, judged.
      'pin_trusted',
      'pin_street_m',
      'pin_official_district_ref',
    ];
    expect(shown.filter((name) => privateOnes.includes(name))).toEqual([]);
  });

  it('shows the location of Phase 14C, appended after every column it had before', async () => {
    const shown = await columns();
    expect(shown.slice(-12)).toEqual([
      'official_district_ref',
      'official_district_basis',
      'location_precision',
      'location_uncertain',
      'location_flags',
      'metro_station',
      'metro_distance_m',
      'metro_minutes',
      'metro_basis',
      'metro_nearby',
      'building_key',
      'location_rules',
    ]);
    expect(shown).toHaveLength(74);
  });

  it('shows the places of Phase 14A, appended after every column it had before', async () => {
    const shown = await columns();
    expect(shown.slice(-22, -12)).toEqual([
      'street_ref',
      'house_number',
      'house_suffix',
      'floor_low',
      'floor_high',
      'district_inferred',
      'complex_ref',
      'complex_name',
      'developer_ref',
      'developer_name',
    ]);
    // The view as Phase 12B left it (migration 0045) comes first, unmoved.
    expect(shown.indexOf('details_read_at')).toBe(51);
  });
});

/** Hermes's place catalogue (contract C6, migration 0050): exactly the columns the contract names. */
describe('realestate.public_places', () => {
  it('shows the columns C6 promises, in order', async () => {
    const { rows } = await db.execute<{ name: string }>(sql`
      select column_name as name
        from information_schema.columns
       where table_schema = 'realestate' and table_name = 'public_places'
       order by ordinal_position
    `);
    expect(rows.map((row) => row.name)).toEqual([
      'source_id',
      'level',
      'ref',
      'origin',
      'code',
      'name_ka',
      'name_en',
      'aliases',
      'match_keys',
      'parent_level',
      'parent_ref',
      'latitude',
      'longitude',
      'point_status',
      'official_district_ref',
      'official_basis',
      'official_shares',
      'active_listings',
      'first_seen_at',
      'last_seen_at',
      'name_roman',
      // Phase 14C (migration 0051): appended. Not the street's own location, which is private.
      'official_source',
    ]);
  });
});
