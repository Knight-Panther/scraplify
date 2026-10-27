import type { ListingPrice } from '../../realestate/ingest.js';
import { readListingPrice } from './list.js';
import { isRecord, readPageProps, SsGePageShapeError, tbilisiWallClockToIso } from './page.js';

/**
 * What a detail page says about whether its listing is still live, and its
 * price: a listing a nightly run no longer reads (it was not renewed) may
 * still have had its price edited. Nothing else is read: a results page
 * already carries every field the table shows, and the phone numbers and
 * names on a detail page are never touched.
 */
export type DetailResult =
  | { status: 'active'; endAt: string | null; price: ListingPrice }
  | { status: 'gone'; reason: 'expired' | 'inactive' | 'missing' };

/**
 * The site answers HTTP 200 for every id: an expired listing still renders,
 * marked `Expired`, and an id that does not exist renders a page with no
 * listing record at all (guideline §4.7).
 *
 * A page showing another listing than the one asked for is refused: read as
 * it stands, it would mark the wrong listing live or gone.
 */
export function parseDetailPage(html: string, sourceListingKey: string): DetailResult {
  const listing = readPageProps(html).applicationData;
  if (!isRecord(listing)) return { status: 'gone', reason: 'missing' };
  if (String(listing.applicationId) !== sourceListingKey) {
    throw new SsGePageShapeError('ss.ge listing page is not for the listing asked for');
  }

  if (listing.status === 'Active' && listing.isInactiveApplication !== true) {
    return {
      status: 'active',
      endAt: tbilisiWallClockToIso(listing.endDate),
      price: readListingPrice(listing.price),
    };
  }
  return { status: 'gone', reason: listing.status === 'Expired' ? 'expired' : 'inactive' };
}
