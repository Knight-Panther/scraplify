import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

/** The columns the rule reads, from whichever table or view a query is over. */
export interface PlausibilityColumns {
  areaM2: SQLWrapper;
  propertyType: SQLWrapper;
  dealType: SQLWrapper;
  priceUsd: SQLWrapper;
  pricePerM2Usd: SQLWrapper;
}

/**
 * A price or area no real listing has: a poster's typo. Measured on the host
 * on 2026-10-27, 248 of 185,839 live listings, and each of 25 sampled was one:
 * a flat "for sale" at $462 (its rent), 1 m² (no area given), a flat "for
 * rent" at $87,500 a month (its sale price), 42,000 m² at $42,000 (the price
 * typed as the area). The bounds are wide on purpose; a 1,100 m² flat at
 * $1.6 million is not caught. Such a listing is kept and shown as posted, but
 * comes after every other one in the Real estate tab's price and area sorts,
 * the top of which it would otherwise take, and the archive marks it
 * (`realestate_archive.listings.implausible`) so statistics can leave it out.
 * Never null: a missing value is not a typo.
 *
 * Per deal (Phase 12A): daily rent is priced by the night ($6 to $450 seen,
 * 2026-11-03), pledge is a loan against the property and runs lower than a
 * sale. Land is sold by the hectare at a few dollars a m², so a large cheap
 * plot is never taken for the price typed as the area.
 *
 * A monthly rent of $200 a m² or more is a sale price too, however far under
 * $50,000 (Hermes found the case, 2026-11-06). Rent flats' 99th percentile was
 * $26 a m², the cheapest 1% of flats for sale $714. It caught 16 live rents,
 * among them flats at $43,000 for 25 m² and $12,000 for 35 m²; $5,200 for
 * 120 m² in Vake ($43) is a rent. The ratio is worked out here: with no area,
 * ss.ge's own price per m² is the whole price.
 */
export function implausibleValuesOf(columns: PlausibilityColumns): SQL {
  const { areaM2, propertyType, dealType, priceUsd, pricePerM2Usd } = columns;
  return sql`coalesce(
  ${areaM2} < 10
  or (${propertyType} <> 'land'
      and ${areaM2} > case when ${propertyType} = 'flat' then 1000 else 10000 end
      and ${pricePerM2Usd} < 100)
  or (${dealType} = 'sale' and ${priceUsd} < 5000)
  or (${dealType} = 'pledge' and ${priceUsd} < 1000)
  or (${dealType} = 'rent' and (${priceUsd} > 50000 or ${priceUsd} < 50 or ${priceUsd} >= 200 * ${areaM2}))
  or (${dealType} = 'daily' and (${priceUsd} > 5000 or ${priceUsd} < 5)),
  false)`;
}
