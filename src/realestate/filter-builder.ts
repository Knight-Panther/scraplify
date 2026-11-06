import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import {
  conditions,
  hasDetailFilter,
  implausibleValues,
  ordering,
  type RealEstateFilters,
  shownRows,
  withoutDetailFilters,
} from './filters.js';
import {
  AMENITY_FIELDS,
  BUILDING_STATUSES,
  CONDITIONS,
  DEAL_TYPES,
  FLOOR_TYPES,
  PROJECTS,
  PROPERTY_TYPES,
} from './kinds.js';

/**
 * Contract C1 (docs/hermes-contracts.md): the Real estate tab's filter rules
 * as SQL text and parameters, for a reader that queries
 * `realestate.public_listings` over its own connection (Hermes). The SQL is
 * built by the same `filters.ts` the tab's own queries are, so the two never
 * disagree. Nothing here touches a database.
 *
 * Raised whenever the input, its meaning or the output changes, new filters
 * included, so a reader can tell what this build understands.
 */
export const FILTER_BUILDER_VERSION = 1;

const instant = z.iso.datetime({ offset: true });
const counts = z.array(z.number().int().min(0)).max(50);
const codes = z.array(z.number().int()).max(50);
const bound = z.number();

/**
 * The input: `RealEstateFilters` as JSON, but `limit` and `offset`, which a
 * reader adds as SQL of its own. Strict: an unknown key or a value of the
 * wrong kind is refused, never ignored, so a misspelled filter cannot widen
 * an answer unnoticed.
 */
const filtersSchema = z.strictObject({
  sourceId: z.uuid().optional(),
  dealType: z.enum(DEAL_TYPES).optional(),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  commercialTypes: codes.optional(),
  landTypes: codes.optional(),
  cityRef: z.number().int().optional(),
  districtRef: z.number().int().optional(),
  subdistrictRef: z.number().int().optional(),
  places: z
    .array(
      z.strictObject({
        level: z.enum(['city', 'district', 'subdistrict']),
        ref: z.number().int(),
      }),
    )
    .max(200)
    .optional(),
  currency: z.enum(['usd', 'gel']).optional(),
  priceMin: bound.optional(),
  priceMax: bound.optional(),
  areaMin: bound.optional(),
  areaMax: bound.optional(),
  floor: z.enum(['not-first', 'not-last', 'middle']).optional(),
  poster: z.enum(['business', 'other']).optional(),
  updatedSince: instant.optional(),
  pricePerM2: z.boolean().optional(),
  roomsIn: counts.optional(),
  floorMin: z.number().int().optional(),
  floorMax: z.number().int().optional(),
  developerOnly: z.boolean().optional(),
  withPhotos: z.boolean().optional(),
  exclusiveOnly: z.boolean().optional(),
  buildingStatuses: z.array(z.enum(BUILDING_STATUSES)).max(50).optional(),
  conditions: z.array(z.enum(CONDITIONS)).max(50).optional(),
  projects: z.array(z.enum(PROJECTS)).max(50).optional(),
  floorTypes: z.array(z.enum(FLOOR_TYPES)).max(50).optional(),
  bathrooms: counts.optional(),
  balconies: counts.optional(),
  kitchenAreaMin: bound.optional(),
  kitchenAreaMax: bound.optional(),
  houseAreaMin: bound.optional(),
  houseAreaMax: bound.optional(),
  yardAreaMin: bound.optional(),
  yardAreaMax: bound.optional(),
  amenities: z.array(z.enum(AMENITY_FIELDS)).max(50).optional(),
  ownerOnly: z.boolean().optional(),
  plausibleOnly: z.boolean().optional(),
  text: z.string().max(200).optional(),
  sort: z.enum(['newest', 'price-asc', 'price-desc', 'ppm2-asc', 'area-desc']).optional(),
  grouped: z.boolean().optional(),
  groupKey: z.string().max(100).optional(),
});

// A filter added to `RealEstateFilters` without a line above fails to compile here.
type InputKeys = keyof z.infer<typeof filtersSchema>;
type FilterKeys = Exclude<keyof RealEstateFilters, 'limit' | 'offset'>;
const sameKeys: [InputKeys] extends [FilterKeys]
  ? [FilterKeys] extends [InputKeys]
    ? true
    : never
  : never = true;
void sameKeys;

/** Reads filters from untrusted JSON, or throws a `ZodError` naming every bad key. */
export function parseRealEstateFilters(input: unknown): RealEstateFilters {
  // JSON holds no `undefined`, so an absent filter is absent, as the type wants.
  return filtersSchema.parse(input) as RealEstateFilters;
}

/** `postgres` numbers the parameters ($1, $2: node-postgres, psql); `psycopg` writes `%s` and doubles every `%`. */
export type Placeholders = 'postgres' | 'psycopg';

export interface BuiltSql {
  sql: string;
  /** Strings, numbers and booleans only; an array value is already a Postgres array literal. */
  params: (string | number | boolean)[];
}

export interface RealEstateFilterSql {
  version: typeof FILTER_BUILDER_VERSION;
  /**
   * The rows the Real estate tab would show: listings on show at `now` that
   * match every filter, and with `grouped`, one per look-alike group. A
   * condition over `realestate.public_listings`, which the query must name
   * as is, with no alias: the SQL refers to `"public_listings"."column"`.
   */
  where: BuiltSql;
  /** The tab's order for `sort` (a typo price or area last), ending in the id. No parameters. */
  orderBy: string;
  /**
   * With a filter on a listing-page field (12B): the listings matching every
   * other filter, never folded. Those of them with `details_read_at is not
   * null` were judged; the tab says "details known for N of M". Otherwise null.
   */
  coverage: BuiltSql | null;
  /** True for a price or area no real listing has (`plausibility.ts`). A boolean expression; no parameters. */
  implausible: string;
}

const dialect = new PgDialect();

function compile(fragment: SQL | undefined, placeholders: Placeholders): BuiltSql {
  const built = dialect.sqlToQuery(fragment ?? sql`true`);
  const params = built.params as BuiltSql['params'];
  for (const param of params) {
    if (!['string', 'number', 'boolean'].includes(typeof param)) {
      throw new Error(`filter-builder: a parameter of type ${typeof param} cannot be handed on`);
    }
  }
  const numbered = { sql: built.sql, params };
  return placeholders === 'postgres' ? numbered : toPsycopg(numbered);
}

/**
 * $1..$n to psycopg's `%s`, with every literal `%` doubled. drizzle numbers
 * each parameter once, in order; SQL that does not is refused, not guessed at.
 */
export function toPsycopg(built: BuiltSql): BuiltSql {
  const numbers = [...built.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  if (numbers.length !== built.params.length || numbers.some((n, i) => n !== i + 1)) {
    throw new Error('filter-builder: parameters are not numbered $1..$n in order');
  }
  return { sql: built.sql.replaceAll('%', '%%').replace(/\$\d+/g, '%s'), params: built.params };
}

function compileStatic(fragment: SQL): string {
  const built = compile(fragment, 'postgres');
  if (built.params.length > 0) throw new Error('filter-builder: expected no parameters');
  return built.sql;
}

/**
 * The SQL for filters given as JSON (`parseRealEstateFilters`) at the
 * instant `now` (ISO 8601 with a zone): what decides whether a listing is
 * still on show. Throws on any input it cannot take.
 */
export function realEstateWhere(
  input: unknown,
  now: string,
  options: { placeholders?: Placeholders } = {},
): RealEstateFilterSql {
  const filters = parseRealEstateFilters(input);
  const asOf = instant.parse(now);
  const placeholders = options.placeholders ?? 'postgres';
  return {
    version: FILTER_BUILDER_VERSION,
    where: compile(shownRows(filters, asOf), placeholders),
    orderBy: compileStatic(sql.join(ordering(filters), sql`, `)),
    coverage: hasDetailFilter(filters)
      ? compile(conditions(withoutDetailFilters(filters), asOf), placeholders)
      : null,
    implausible: compileStatic(implausibleValues),
  };
}
