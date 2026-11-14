import type { RealEstateRow } from '../../../src/realestate/queries.js';
import { absoluteTime, count, relativeTime } from '../../lib/format.js';
import { METRO_STATIONS, stationLine } from '../../lib/real-estate-form.js';
import {
  type Currency,
  detailText,
  floorText,
  listingLabel,
  type MetroText,
  metroText,
  money,
  perMetre,
  placeText,
  posterText,
  priceOf,
  priceUnit,
  streetText,
} from '../../lib/real-estate-row.js';

/**
 * The listings, one row each as ss.ge shows them (Phase 16B): a table from
 * 900px, and below it three lines a row, the price first. Each row opens the
 * listing on ss.ge; this site keeps no page of its own for one.
 */

const STATION = new Map(METRO_STATIONS.map((station) => [station.code, station]));

export interface ResultsProps {
  rows: RealEstateRow[];
  currency: Currency;
  stations: readonly string[];
  /** A folded row's look-alike group, or null. */
  groupHref: (row: RealEstateRow) => string | null;
}

export function Results(props: ResultsProps) {
  return (
    <>
      <div className="hidden min-[900px]:block">
        <ResultsTable {...props} />
      </div>
      <ol className="min-[900px]:hidden">
        {props.rows.map((row, index) => (
          <MobileRow key={row.id} row={row} position={index + 1} {...props} />
        ))}
      </ol>
    </>
  );
}

function Metro({ metro }: { metro: MetroText | null }) {
  if (metro === null) return null;
  if (!metro.near) return <span className="text-faint">over 20 min</span>;
  const station = STATION.get(metro.code);
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1.5"
      title={`${metro.minutes} min walk to ${station?.en ?? metro.code}`}
    >
      <i
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${stationLine(metro.code) === 1 ? 'bg-metro-1' : 'bg-metro-2'}`}
      />
      <span className="numeric shrink-0 text-xs">{metro.minutes} min</span>
      <span className="min-w-0 truncate">{station?.ka ?? metro.code}</span>
    </span>
  );
}

function linkLabel(row: RealEstateRow): string {
  const place = placeText(row);
  return `${listingLabel(row)}${place === null ? '' : `, ${place}`}, on ss.ge (opens in a new tab)`;
}

function Alike({ row, href }: { row: RealEstateRow; href: string | null }) {
  if (href === null) return null;
  const more = row.alikeCount - 1;
  return (
    <a
      href={href}
      className="ml-1.5 shrink-0 text-xs text-accent no-underline hover:underline"
      aria-label={`${more} more ${more === 1 ? 'listing' : 'listings'} like this one`}
      title="The same home, posted again"
    >
      +<span className="numeric">{count(more)}</span> alike
    </a>
  );
}

const TH = 'px-1.5 py-2 text-xs font-medium whitespace-nowrap text-faint';
const TD = 'px-1.5 py-2 whitespace-nowrap';

function ResultsTable({ rows, currency, stations, groupHref }: ResultsProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border-strong text-left">
            <th scope="col" className={TH}>
              Listing
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Rooms
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Area
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Floor
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Price
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Per m²
            </th>
            <th scope="col" className={TH}>
              Location
            </th>
            <th scope="col" className={TH}>
              Street
            </th>
            <th scope="col" className={TH}>
              Metro
            </th>
            <th scope="col" className={TH}>
              Posted by
            </th>
            <th scope="col" className={TH}>
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const price = priceOf(row, currency);
            const unit = priceUnit(row);
            const metre = perMetre(row, currency);
            const place = placeText(row);
            const street = streetText(row);
            const detail = detailText(row);
            return (
              <tr
                key={row.id}
                id={`row-${index + 1}`}
                className="scroll-mt-40 border-b border-border align-baseline transition-colors duration-100 hover:bg-hover motion-reduce:transition-none"
              >
                <td className={`${TD} max-w-[22rem]`}>
                  <span className="flex min-w-0 items-baseline">
                    <a
                      href={row.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={linkLabel(row)}
                      className="truncate text-foreground underline decoration-border-hover underline-offset-[3px] hover:decoration-foreground"
                    >
                      {listingLabel(row)}
                    </a>
                    <Alike row={row} href={groupHref(row)} />
                  </span>
                  {detail === null ? null : (
                    <span className="block truncate text-xs text-faint" title={detail}>
                      {detail}
                    </span>
                  )}
                </td>
                <td className={`${TD} numeric text-right`}>{row.rooms}</td>
                <td className={`${TD} text-right`}>
                  {row.areaM2 === null ? null : (
                    <>
                      <span className="numeric">{count(Math.round(row.areaM2))}</span> m²
                    </>
                  )}
                </td>
                <td className={`${TD} numeric text-right text-faint`}>{floorText(row)}</td>
                <td className={`${TD} numeric text-right`}>
                  {price === null ? null : money(price, currency)}
                  {price === null || unit === null ? null : (
                    <span className="block text-xs text-faint">{unit}</span>
                  )}
                </td>
                <td className={`${TD} numeric text-right text-faint`}>
                  {metre === null ? null : money(metre, currency)}
                </td>
                <td className={`${TD} max-w-36 truncate`} title={place ?? undefined}>
                  {place}
                </td>
                <td className={`${TD} max-w-36 truncate`} title={street ?? undefined}>
                  {street}
                </td>
                <td className={`${TD} max-w-44 overflow-hidden`}>
                  <Metro metro={metroText(row, stations)} />
                </td>
                <td className={`${TD} text-faint`}>{posterText(row)}</td>
                <td className={`${TD} text-faint`}>
                  <time dateTime={row.sourceUpdatedAt} title={absoluteTime(row.sourceUpdatedAt)}>
                    {relativeTime(row.sourceUpdatedAt)}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileRow({
  row,
  position,
  currency,
  stations,
  groupHref,
}: ResultsProps & { row: RealEstateRow; position: number }) {
  const price = priceOf(row, currency);
  const unit = priceUnit(row);
  const metre = perMetre(row, currency);
  const floor = floorText(row);
  const facts = [
    row.rooms === null ? null : row.rooms === 1 ? '1 room' : `${row.rooms} rooms`,
    row.areaM2 === null ? null : `${count(Math.round(row.areaM2))} m²`,
    floor === null ? null : floor.includes('floor') ? floor : `floor ${floor}`,
    posterText(row),
  ].filter((fact) => fact !== null);
  const where = [placeText(row), streetText(row)].filter((part) => part !== null).join(' · ');
  const metro = metroText(row, stations);
  const href = groupHref(row);
  return (
    <li id={`row-${position}`} className="scroll-mt-40 border-b border-border py-[11px]">
      <div className="flex items-baseline justify-between gap-2.5">
        <a
          href={row.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={linkLabel(row)}
          className="min-w-0 text-foreground no-underline"
        >
          <span className="numeric text-base font-bold">
            {price === null ? 'Price not stated' : money(price, currency)}
          </span>
          {unit === null || price === null ? null : (
            <span className="ml-1.5 text-xs text-faint">{unit}</span>
          )}
          {metre === null ? null : (
            <span className="numeric ml-2 text-xs text-faint">{money(metre, currency)}/m²</span>
          )}
        </a>
        <time
          dateTime={row.sourceUpdatedAt}
          title={absoluteTime(row.sourceUpdatedAt)}
          className="shrink-0 text-xs text-faint"
        >
          {relativeTime(row.sourceUpdatedAt)}
        </time>
      </div>
      <div className="mt-px text-[13px] text-muted">
        {[listingLabel(row), ...facts].join(' · ')}
        <Alike row={row} href={href} />
      </div>
      {where === '' && metro === null ? null : (
        <div className="mt-px flex items-baseline justify-between gap-2.5 text-[13px]">
          <span className="min-w-0 flex-auto truncate text-muted">{where}</span>
          {metro === null ? null : (
            <span className="max-w-[55%] min-w-0 shrink overflow-hidden">
              <Metro metro={metro} />
            </span>
          )}
        </div>
      )}
    </li>
  );
}
