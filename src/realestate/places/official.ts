import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Tbilisi's official map (Phase 14B): the city's 10 districts, by
 * OpenStreetMap's borders, and its metro stations, from `tbilisi.json`
 * (© OpenStreetMap contributors, ODbL; written by
 * scripts/fetch-osm-places.mjs). The host's Postgres has no PostGIS, so a
 * point is placed here.
 *
 * ss.ge's map is the other one: its five combined districts ("Old Tbilisi")
 * and its neighbourhoods are not the official districts, and a neighbourhood
 * can straddle two of them. Neither map is renamed into the other (owner,
 * 2026-11-06).
 */

/** Closer than this to a border, a point's district is marked `border`: the borders are simplified by about 10 m, and a pin or a street point is not exact either. */
export const BORDER_METERS = 50;

const point = z.tuple([z.number(), z.number()]);
const officialMapSchema = z.object({
  fetchedAt: z.string(),
  districts: z
    .array(
      z.object({
        /** OSM's relation id. */
        ref: z.number().int().positive(),
        code: z.string().min(1),
        nameKa: z.string().min(1),
        nameEn: z.string().min(1),
        /** [longitude, latitude] rings: the first is the border, any other a hole. */
        rings: z.array(z.array(point).min(4)).min(1),
      }),
    )
    .length(10),
  stations: z
    .array(
      z.object({
        /** Ours, fixed in the file. */
        ref: z.number().int().positive(),
        /** ss.ge's code, as `ss_metro` keys it. */
        code: z.string().min(1),
        osm: z.array(z.number().int().positive()).min(1),
        nameKa: z.string().min(1),
        nameEn: z.string().min(1),
        lines: z.array(z.number().int().positive()).min(1),
        lat: z.number(),
        lng: z.number(),
      }),
    )
    .min(1),
});

export type OfficialMap = z.infer<typeof officialMapSchema>;
export type OfficialDistrict = OfficialMap['districts'][number];
export type MetroStation = OfficialMap['stations'][number];

/**
 * The committed map, read from the source tree: `tsc` does not copy JSON
 * into `dist/`, and this path resolves to the same file from
 * `src/realestate/places/` and `dist/realestate/places/` alike.
 */
export async function loadOfficialMap(): Promise<OfficialMap> {
  const url = new URL('../../../src/realestate/places/tbilisi.json', import.meta.url);
  return officialMapSchema.parse(JSON.parse(await readFile(url, 'utf8')));
}

/** Where a point is on the official map, and how sure that is. */
export interface OfficialPlace {
  district: OfficialDistrict;
  /** `inside`: further than `BORDER_METERS` from any border. `border`: within it, so either side is possible. */
  basis: 'inside' | 'border';
  /** To the district's nearest border, rounded to the metre. */
  borderMeters: number;
}

/** Metres per degree of latitude near Tbilisi; longitude's are this times cos(latitude). */
const METERS_PER_DEGREE = 111_195;

/** Distance in metres from a point to a ring's nearest edge, on a plane local to the point (exact enough within a city). */
function ringDistance(ring: ReadonlyArray<readonly [number, number]>, lat: number, lng: number) {
  const kx = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const ky = METERS_PER_DEGREE;
  let best = Number.POSITIVE_INFINITY;
  for (let at = 1; at < ring.length; at++) {
    const [aLng, aLat] = ring[at - 1] as readonly [number, number];
    const [bLng, bLat] = ring[at] as readonly [number, number];
    const ax = (aLng - lng) * kx;
    const ay = (aLat - lat) * ky;
    const dx = (bLng - aLng) * kx;
    const dy = (bLat - aLat) * ky;
    const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Even-odd ray casting over every ring, so a hole is outside. */
function contains(rings: OfficialDistrict['rings'], lat: number, lng: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let at = 0, prev = ring.length - 1; at < ring.length; prev = at++) {
      const [xi, yi] = ring[at] as [number, number];
      const [xj, yj] = ring[prev] as [number, number];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Each district's bounding box, widened by `BORDER_METERS`, so a point far outside is skipped cheaply. */
const boxes = new WeakMap<
  OfficialDistrict,
  { south: number; north: number; west: number; east: number }
>();
function boxOf(district: OfficialDistrict) {
  let box = boxes.get(district);
  if (box === undefined) {
    const outer = district.rings[0] ?? [];
    const lats = outer.map(([, lat]) => lat);
    const lngs = outer.map(([lng]) => lng);
    const margin = BORDER_METERS / METERS_PER_DEGREE;
    const lngMargin = margin / Math.cos((Math.min(...lats) * Math.PI) / 180);
    box = {
      south: Math.min(...lats) - margin,
      north: Math.max(...lats) + margin,
      west: Math.min(...lngs) - lngMargin,
      east: Math.max(...lngs) + lngMargin,
    };
    boxes.set(district, box);
  }
  return box;
}

/**
 * The official district a point is in. A point inside none but within
 * `BORDER_METERS` of one (a gap the simplified borders leave) gets the
 * nearest, as `border`. Null outside the city's districts.
 */
export function officialDistrictAt(
  map: OfficialMap,
  lat: number,
  lng: number,
): OfficialPlace | null {
  let nearest: { district: OfficialDistrict; meters: number } | null = null;
  for (const district of map.districts) {
    const box = boxOf(district);
    if (lat < box.south || lat > box.north || lng < box.west || lng > box.east) continue;
    const meters = Math.min(...district.rings.map((ring) => ringDistance(ring, lat, lng)));
    if (contains(district.rings, lat, lng)) {
      return {
        district,
        basis: meters <= BORDER_METERS ? 'border' : 'inside',
        borderMeters: Math.round(meters),
      };
    }
    if (meters <= BORDER_METERS && (nearest === null || meters < nearest.meters)) {
      nearest = { district, meters };
    }
  }
  return nearest === null
    ? null
    : { district: nearest.district, basis: 'border', borderMeters: Math.round(nearest.meters) };
}
