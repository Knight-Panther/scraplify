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
    ];
    expect(shown.filter((name) => privateOnes.includes(name))).toEqual([]);
  });

  it('shows the places of Phase 14A, appended after every column it had before', async () => {
    const shown = await columns();
    expect(shown.slice(-10)).toEqual([
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
