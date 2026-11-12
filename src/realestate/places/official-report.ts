import { sql } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../../db/types.js';
import { TBILISI_CITY_REF } from './catalogue.js';

/**
 * The owner's once-over of how ss.ge's Tbilisi areas sit on the official map
 * (`npm run places:official-report`, Phase 14B, docs/PHASE_14_PLAN.md): per
 * ss.ge district and sub-district, its shares of the official districts, and
 * per sub-district the streets that make up the smaller shares, the streets
 * whose own trusted pins cross an official border, and what is not located
 * yet. Not a gate: the mapping is computed from exact borders.
 *
 * It counts the way the place catalogue counts C6's `official_shares`
 * (`refreshPlaceCatalogue`): each active Tbilisi listing in the official
 * district of its street's location. So right after a run its shares are
 * C6's, and a street listed here explains a share there. Reads only.
 */
export interface OfficialReport {
  generatedAt: string;
  tbilisi: {
    listings: number;
    located: number;
    /** Active Tbilisi listings that name no street, and that name no sub-district. */
    noStreet: number;
    noSubdistrict: number;
  };
  /** The official districts, by OSM relation id. */
  official: { ref: number; code: string; name: string }[];
  /** ss.ge's Tbilisi districts, then their sub-districts, busiest first. */
  districts: ReportArea[];
  subdistricts: ReportArea[];
}

export interface ReportArea {
  level: 'district' | 'subdistrict';
  ref: number;
  nameKa: string;
  nameEn: string | null;
  /** The sub-district's ss.ge district; null for a district. */
  districtRef: number | null;
  listings: number;
  /** Listings on a street with an official district. */
  located: number;
  /** Located listings by official district, most first. */
  shares: { ref: number; listings: number }[];
  /** The official district holding most located listings; null when none is located. */
  main: number | null;
  noStreet: number;
  /** Sub-districts only (empty for a district): streets of another official district than `main`, busiest here first. */
  elsewhere: ReportStreet[];
  /** Sub-districts only: streets in `main` whose trusted pins also sit in another official district. */
  crossing: ReportStreet[];
  /** Sub-districts only: streets with no official district yet, busiest first. */
  unplaced: ReportStreet[];
}

export interface ReportStreet {
  ref: number;
  nameKa: string;
  /** Active listings on this street in the area. */
  listings: number;
  official: number | null;
  /** What the street's official district rests on: its listings' pins or ss.ge's point. */
  source: 'pins' | 'ss.ge' | null;
  /** Distinct pin positions its location is the median of; 0 for ss.ge's point. */
  locatedPins: number | null;
  /** The street's distinct trusted pin positions, all Tbilisi, by official district, most first. */
  pins: { ref: number; positions: number }[];
  /**
   * The same, from this sub-district's own listings only. A street placed by
   * pins none of which are here rests on another area's listings: a poster's
   * wrong area, or two streets ss.ge gives one id.
   */
  pinsHere: { ref: number; positions: number }[];
}

/**
 * A street crosses an official border when its trusted pins sit at this many
 * distinct positions or more in a second official district. One stray pin is
 * not a crossing: 14C trusts a pin with one neighbour position, and a street
 * placed on the wrong side of its border shows as two or more.
 */
export const CROSSING_MIN_POSITIONS = 2;

interface AreaCounts {
  listings: number;
  noStreet: number;
  byStreet: Map<number, number>;
}

function counts(map: Map<number, AreaCounts>, ref: number): AreaCounts {
  let entry = map.get(ref);
  if (entry === undefined) {
    entry = { listings: 0, noStreet: 0, byStreet: new Map() };
    map.set(ref, entry);
  }
  return entry;
}

function byMostThenRef<T extends { ref: number }>(value: (item: T) => number) {
  return (a: T, b: T) => value(b) - value(a) || a.ref - b.ref;
}

export async function loadOfficialReport(
  db: DatabaseOrTransaction,
  input: { sourceId: string; at: string },
): Promise<OfficialReport> {
  const { sourceId } = input;
  const places = await db.execute<{
    level: string;
    ref: number;
    parent_level: string | null;
    parent_ref: number | null;
    name_ka: string;
    name_en: string | null;
    code: string | null;
    official_district_ref: number | null;
    official_source: 'pins' | 'ss.ge' | null;
    located_pins: number | null;
  }>(sql`
    select level, ref, parent_level, parent_ref, name_ka, name_en, code,
           official_district_ref, official_source, located_pins
      from realestate.places
     where source_id = ${sourceId}
       and level in ('district', 'subdistrict', 'street', 'official_district')
  `);
  const tbilisi = await db.execute<{
    district_ref: number | null;
    subdistrict_ref: number | null;
    street_ref: number | null;
    n: number;
  }>(sql`
    select district_ref, subdistrict_ref, street_ref, count(*)::integer as n
      from realestate.listings
     where source_id = ${sourceId} and status = 'active' and city_ref = ${TBILISI_CITY_REF}
     group by district_ref, subdistrict_ref, street_ref
  `);
  // Per street over all Tbilisi (`everywhere` 1), and per sub-district and street.
  const pinRows = await db.execute<{
    subdistrict_ref: number | null;
    street_ref: number;
    ref: number;
    everywhere: number;
    positions: number;
  }>(sql`
    select subdistrict_ref, street_ref, pin_official_district_ref as ref,
           grouping(subdistrict_ref) as everywhere,
           count(distinct (latitude, longitude))::integer as positions
      from realestate.listings
     where source_id = ${sourceId} and status = 'active' and city_ref = ${TBILISI_CITY_REF}
       and pin_trusted and street_ref is not null and pin_official_district_ref is not null
     group by grouping sets (
       (street_ref, pin_official_district_ref),
       (subdistrict_ref, street_ref, pin_official_district_ref)
     )
  `);

  const areaRows = new Map<string, (typeof places.rows)[number]>();
  const streets = new Map<number, (typeof places.rows)[number]>();
  const official: OfficialReport['official'] = [];
  for (const row of places.rows) {
    if (row.level === 'street') streets.set(row.ref, row);
    else if (row.level === 'official_district') {
      official.push({
        ref: row.ref,
        code: row.code ?? String(row.ref),
        name: row.name_en ?? row.name_ka,
      });
    } else areaRows.set(`${row.level}:${row.ref}`, row);
  }
  official.sort((a, b) => a.name.localeCompare(b.name));
  const officialRefs = new Set(official.map((o) => o.ref));
  /** A street's official district, as the catalogue counts it: one the map holds. */
  const streetOfficial = (ref: number | null): number | null => {
    const district = ref === null ? null : (streets.get(ref)?.official_district_ref ?? null);
    return district !== null && officialRefs.has(district) ? district : null;
  };

  /** Trusted pin positions by official district, keyed `<street>` for all Tbilisi and `<sub-district>:<street>`. */
  const pins = new Map<string, { ref: number; positions: number }[]>();
  for (const row of pinRows.rows) {
    if (Number(row.everywhere) === 0 && row.subdistrict_ref === null) continue;
    const key =
      Number(row.everywhere) === 1
        ? String(row.street_ref)
        : `${row.subdistrict_ref}:${row.street_ref}`;
    const list = pins.get(key) ?? [];
    list.push({ ref: row.ref, positions: Number(row.positions) });
    pins.set(key, list);
  }
  for (const list of pins.values()) list.sort(byMostThenRef((p) => p.positions));

  const total = { listings: 0, located: 0, noStreet: 0, noSubdistrict: 0 };
  const districtCounts = new Map<number, AreaCounts>();
  const subdistrictCounts = new Map<number, AreaCounts>();
  /** The district each sub-district's listings name most, for one ss.ge left without a parent. */
  const subdistrictDistricts = new Map<number, Map<number, number>>();
  for (const row of tbilisi.rows) {
    const n = Number(row.n);
    total.listings += n;
    if (streetOfficial(row.street_ref) !== null) total.located += n;
    if (row.street_ref === null) total.noStreet += n;
    if (row.subdistrict_ref === null) total.noSubdistrict += n;
    const areas: [Map<number, AreaCounts>, number | null][] = [
      [districtCounts, row.district_ref],
      [subdistrictCounts, row.subdistrict_ref],
    ];
    for (const [map, ref] of areas) {
      if (ref === null) continue;
      const entry = counts(map, ref);
      entry.listings += n;
      if (row.street_ref === null) entry.noStreet += n;
      else entry.byStreet.set(row.street_ref, (entry.byStreet.get(row.street_ref) ?? 0) + n);
    }
    if (row.subdistrict_ref !== null && row.district_ref !== null) {
      const seen = subdistrictDistricts.get(row.subdistrict_ref) ?? new Map<number, number>();
      seen.set(row.district_ref, (seen.get(row.district_ref) ?? 0) + n);
      subdistrictDistricts.set(row.subdistrict_ref, seen);
    }
  }

  const streetOf = (ref: number, listings: number, subdistrict: number | null): ReportStreet => {
    const street = streets.get(ref);
    const placed = streetOfficial(ref);
    return {
      ref,
      nameKa: street?.name_ka ?? String(ref),
      listings,
      official: placed,
      source: placed === null ? null : (street?.official_source ?? null),
      locatedPins: placed === null ? null : (street?.located_pins ?? null),
      pins: pins.get(String(ref)) ?? [],
      pinsHere: subdistrict === null ? [] : (pins.get(`${subdistrict}:${ref}`) ?? []),
    };
  };

  const area = (level: 'district' | 'subdistrict', ref: number, c: AreaCounts): ReportArea => {
    const row = areaRows.get(`${level}:${ref}`);
    const shareOf = new Map<number, number>();
    for (const [street, n] of c.byStreet) {
      const district = streetOfficial(street);
      if (district !== null) shareOf.set(district, (shareOf.get(district) ?? 0) + n);
    }
    const shares = [...shareOf]
      .map(([district, listings]) => ({ ref: district, listings }))
      .sort(byMostThenRef((s) => s.listings));
    const main = shares[0]?.ref ?? null;
    let districtRef: number | null = null;
    if (level === 'subdistrict') {
      districtRef =
        row?.parent_level === 'district' && row.parent_ref !== null
          ? row.parent_ref
          : ([...(subdistrictDistricts.get(ref) ?? [])].sort(
              (a, b) => b[1] - a[1] || a[0] - b[0],
            )[0]?.[0] ?? null);
    }
    const streetsHere = [...c.byStreet]
      .map(([street, n]) => streetOf(street, n, level === 'subdistrict' ? ref : null))
      .sort(byMostThenRef((s) => s.listings));
    const detail = level === 'subdistrict';
    return {
      level,
      ref,
      nameKa: row?.name_ka ?? String(ref),
      nameEn: row?.name_en ?? null,
      districtRef,
      listings: c.listings,
      located: shares.reduce((sum, s) => sum + s.listings, 0),
      shares,
      main,
      noStreet: c.noStreet,
      elsewhere: detail
        ? streetsHere.filter((s) => s.official !== null && s.official !== main)
        : [],
      crossing: detail
        ? streetsHere.filter(
            (s) =>
              s.official !== null &&
              s.official === main &&
              s.pins.some((p) => p.ref !== s.official && p.positions >= CROSSING_MIN_POSITIONS),
          )
        : [],
      unplaced: detail ? streetsHere.filter((s) => s.official === null) : [],
    };
  };

  const busiest = (a: ReportArea, b: ReportArea) => b.listings - a.listings || a.ref - b.ref;
  const districts = [...districtCounts].map(([ref, c]) => area('district', ref, c)).sort(busiest);
  const districtOrder = new Map(districts.map((d, i) => [d.ref, i]));
  const subdistricts = [...subdistrictCounts]
    .map(([ref, c]) => area('subdistrict', ref, c))
    .sort(
      (a, b) =>
        (districtOrder.get(a.districtRef ?? -1) ?? districts.length) -
          (districtOrder.get(b.districtRef ?? -1) ?? districts.length) || busiest(a, b),
    );
  return { generatedAt: input.at, tbilisi: total, official, districts, subdistricts };
}

/** How many streets each list shows per sub-district in Markdown; the JSON has all. */
export const REPORT_STREETS_SHOWN = 15;

/**
 * The report as Markdown, for reading in a terminal or pasting anywhere.
 * Areas show their English name where the owner's file gives one; streets
 * their Georgian name, as ss.ge writes it.
 */
export function formatOfficialReport(
  report: OfficialReport,
  options: { streets?: number } = {},
): string {
  const shown = options.streets ?? REPORT_STREETS_SHOWN;
  const officialName = new Map(
    report.official.map((o) => [o.ref, o.name.replace(/ District$/, '')]),
  );
  const name = (ref: number) => officialName.get(ref) ?? String(ref);
  const int = (n: number) => n.toLocaleString('en-US');
  const pct = (n: number, of: number) => {
    if (of === 0) return '—';
    const p = (100 * n) / of;
    if (p > 0 && p < 0.1) return '<0.1%';
    return p > 99.9 && n < of ? '>99.9%' : `${p.toFixed(1)}%`;
  };
  const cell = (text: string) => text.replaceAll('|', '\\|');
  const areaName = (a: { nameKa: string; nameEn: string | null }) =>
    cell(a.nameEn === null ? a.nameKa : `${a.nameEn} (${a.nameKa})`);
  const districtName = new Map(report.districts.map((d) => [d.ref, areaName(d)]));
  const shareList = (a: ReportArea, from: number) =>
    a.shares
      .slice(from)
      .map((s) => `${name(s.ref)} ${pct(s.listings, a.located)}`)
      .join(' · ') || '—';
  const pinList = (pins: ReportStreet['pins']) =>
    pins.length === 0 ? '—' : pins.map((p) => `${name(p.ref)} ${p.positions}`).join(' · ');
  const placedBy = (s: ReportStreet) =>
    s.source === 'pins' ? `pins (${s.locatedPins ?? 0})` : (s.source ?? '—');
  const more = (rest: ReportStreet[]) =>
    rest.length === 0
      ? []
      : [
          '',
          `…and ${int(rest.length)} more, ${int(rest.reduce((sum, s) => sum + s.listings, 0))} listings.`,
        ];

  const t = report.tbilisi;
  const out: string[] = [
    '# Tbilisi on both maps',
    '',
    `Generated ${report.generatedAt} from the active ss.ge listings. A listing counts in the official district its street lies in, as C6's \`official_shares\` count it; a street is placed by its listings' pins, or by ss.ge's point. Shares are of the located listings. Pins are a street's trusted pins as distinct positions per official district, from the sub-district's own listings ("pins here") and from all Tbilisi's; a street crosses a border when ${CROSSING_MIN_POSITIONS} or more of all its positions lie in a second one. A street placed by pins with none here rests on other areas' listings.`,
    '',
    `Tbilisi: ${int(t.listings)} active listings, ${int(t.located)} on a placed street (${pct(t.located, t.listings)}); ${int(t.noStreet)} name no street, ${int(t.noSubdistrict)} no sub-district.`,
    '',
    "## ss.ge's districts",
    '',
    '| District | Listings | Located | Official districts |',
    '|---|---:|---:|---|',
    ...report.districts.map(
      (d) =>
        `| ${areaName(d)} | ${int(d.listings)} | ${int(d.located)} (${pct(d.located, d.listings)}) | ${shareList(d, 0)} |`,
    ),
    '',
    "## ss.ge's sub-districts",
    '',
    '| Sub-district | District | Listings | Located | Main | Others |',
    '|---|---|---:|---:|---|---|',
    ...report.subdistricts.map((s) => {
      const main =
        s.main === null ? '—' : `${name(s.main)} ${pct(s.shares[0]?.listings ?? 0, s.located)}`;
      const district =
        s.districtRef === null ? '—' : (districtName.get(s.districtRef) ?? String(s.districtRef));
      return `| ${areaName(s)} | ${district} | ${int(s.listings)} | ${int(s.located)} (${pct(s.located, s.listings)}) | ${main} | ${s.shares.length > 1 ? shareList(s, 1) : '—'} |`;
    }),
    '',
    '## Split streets, by sub-district',
    '',
    'Only sub-districts with a street in another official district, or one crossing a border.',
  ];

  const streetTable = (rows: ReportStreet[], official: boolean) => [
    official
      ? '| Street | Listings here | Official district | Placed by | Pins here | Pins, all Tbilisi |'
      : '| Street | Listings here | Placed by | Pins here | Pins, all Tbilisi |',
    official ? '|---|---:|---|---|---|---|' : '|---|---:|---|---|---|',
    ...rows
      .slice(0, shown)
      .map((s) =>
        official
          ? `| ${cell(s.nameKa)} | ${int(s.listings)} | ${s.official === null ? '—' : name(s.official)} | ${placedBy(s)} | ${pinList(s.pinsHere)} | ${pinList(s.pins)} |`
          : `| ${cell(s.nameKa)} | ${int(s.listings)} | ${placedBy(s)} | ${pinList(s.pinsHere)} | ${pinList(s.pins)} |`,
      ),
    ...more(rows.slice(shown)),
  ];

  for (const s of report.subdistricts) {
    if (s.main === null || (s.elsewhere.length === 0 && s.crossing.length === 0)) continue;
    const district = s.districtRef === null ? null : districtName.get(s.districtRef);
    out.push(
      '',
      `### ${areaName(s)}${district === undefined || district === null ? '' : `, ${district}`}`,
      '',
      `${int(s.listings)} listings, ${int(s.located)} located; main official district ${name(s.main)}, ${pct(s.shares[0]?.listings ?? 0, s.located)}.`,
    );
    if (s.elsewhere.length > 0) {
      const listings = s.elsewhere.reduce((sum, x) => sum + x.listings, 0);
      out.push(
        '',
        `Streets in another official district: ${int(s.elsewhere.length)}, ${int(listings)} listings.`,
        '',
        ...streetTable(s.elsewhere, true),
      );
    }
    if (s.crossing.length > 0) {
      out.push(
        '',
        `Streets in ${name(s.main)} whose trusted pins cross a border: ${int(s.crossing.length)}.`,
        '',
        ...streetTable(s.crossing, false),
      );
    }
    const unplaced = s.unplaced.reduce((sum, x) => sum + x.listings, 0);
    if (s.noStreet > 0 || unplaced > 0) {
      const top = s.unplaced
        .slice(0, 5)
        .map((x) => `${cell(x.nameKa)} ${int(x.listings)}`)
        .join(', ');
      out.push(
        '',
        `Not located: ${int(s.noStreet)} listings name no street; ${int(unplaced)} are on ${int(s.unplaced.length)} streets not placed yet${top === '' ? '' : ` (busiest: ${top})`}.`,
      );
    }
  }
  out.push('');
  return out.join('\n');
}
