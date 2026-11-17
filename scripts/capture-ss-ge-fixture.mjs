#!/usr/bin/env node
/**
 * Fetches one ss.ge page and writes it as a test fixture holding only the
 * fields the parsers read.
 *
 *   node scripts/capture-ss-ge-fixture.mjs results <url> <out-file>
 *   node scripts/capture-ss-ge-fixture.mjs detail <url> <out-file>
 *
 * One GET, with the project's User-Agent. This repository is public and ss.ge
 * pages carry phone numbers, names, user ids, photo paths and a working
 * gateway token, so everything not on the allow-list below is dropped,
 * phone-like runs of digits in free text are masked, account ids and photo
 * paths are replaced with the reserved fakes of
 * `src/adapters/ss-ge/reserved-fakes.json` (Phases 17B and 17G: the same
 * account keeps the same fake within a page, a photo keeps its date, number
 * and size word), and the file is refused when anything
 * `src/adapters/ss-ge/fixtures.test.ts` forbids is still in it. Run captures at
 * least 3 s apart (the source policy's spacing).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const USER_AGENT =
  process.env.SCRAPLIFY_USER_AGENT?.trim() ||
  'ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)';

/** The only account ids and photo GUIDs a fixture may carry (fixtures.test.ts is the gate). */
const RESERVED = JSON.parse(
  readFileSync(new URL('../src/adapters/ss-ge/reserved-fakes.json', import.meta.url), 'utf8'),
);
const FAKE_USER_ID_RE = new RegExp(`^${RESERVED.userIdPrefix}\\d{2}$`);
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The same patterns as fixtures.test.ts; that test is the gate, this is the early refusal. */
const FORBIDDEN = [
  ['the gateway token field', /credentialsToken/],
  ['a JSON web token', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a phone list', /applicationPhones|"phoneNumber"/],
  ['a contact name', /contactPerson|agentContactName|"name"\s*:/],
  ['an agency or company name', /"agencyName"|"companyName"/],
  ['a Georgian mobile number', /(?<![0-9])5[0-9]{8}(?![0-9])/],
  ['an international phone prefix', /\+995/],
];

/** Each real account id on the page gets its own fake, in the order met: 01, 02… */
const fakeUserIds = new Map();
function fakeUserId(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const key = value.trim().toLowerCase();
  if (!fakeUserIds.has(key)) {
    if (fakeUserIds.size >= 99) throw new Error('more than 99 accounts on one page');
    fakeUserIds.set(
      key,
      `${RESERVED.userIdPrefix}${String(fakeUserIds.size + 1).padStart(2, '0')}`,
    );
  }
  return fakeUserIds.get(key);
}

const PHOTO_PATH_RE =
  /(\d{8})\/(\d{1,3})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_[A-Za-z0-9]{1,20})?\.(jpe?g|png|webp|gif)/i;

/** A photo path with the reserved GUID in place of the real one; anything else is dropped. */
function fakePhotoPath(value) {
  const match = typeof value === 'string' ? PHOTO_PATH_RE.exec(value) : null;
  if (match === null) return undefined;
  const [, day, index, size = '', extension] = match;
  return `https://static.ss.ge/${day}/${index}_${RESERVED.photoGuid}${size}.${extension}`;
}

/** The photo fields the parsers read (src/adapters/ss-ge/poster.ts), paths faked. */
function fakePhotos(images) {
  if (!Array.isArray(images)) return images;
  return images.map((image) => {
    const out = pick(image, ['orderNo', 'isMain', 'is360', 'imageType']);
    for (const field of ['fileName', 'fileNameThumb']) {
      const path = fakePhotoPath(image?.[field]);
      if (path !== undefined) out[field] = path;
    }
    return out;
  });
}

/** How many GUIDs are neither a reserved fake account nor the fake photo's. */
function realIdentifiers(text) {
  let found = 0;
  for (const [guid] of text.matchAll(GUID_RE)) {
    if (!FAKE_USER_ID_RE.test(guid) && guid !== RESERVED.photoGuid) found += 1;
  }
  for (const [, value] of text.matchAll(/"userId"\s*:\s*("[^"]*"|[^,}\]]+)/g)) {
    const plain = value.replace(/^"|"$/g, '');
    if (plain !== 'null' && !FAKE_USER_ID_RE.test(plain)) found += 1;
  }
  return found;
}

/** As `PHONE_RE` in src/adapters/ss-ge/list.ts: seven digits or more, however spaced. */
const PHONE_RE = /\+?\d(?:[\s./()+-]{0,3}\d){6,}/g;

/** The fields `src/adapters/ss-ge/list.ts` reads from a results row. */
const ROW_FIELDS = [
  'applicationId',
  'type',
  'dealType',
  'title',
  'totalArea',
  'floorNumber',
  'totalAmountOfFloor',
  'numberOfBedrooms',
  'orderDate',
  'createDate',
  'vipStatus',
  'similarityGroup',
  'description',
  'commercialRealEstateType',
  'landType',
  'imageCount',
  'furniture',
  'withBuiltInKitchen',
  'isExclusive',
  'hasRemoteViewing',
];
/** A metro station near the listing (Phase 14A): its name and walking minutes, never its entrance id. */
const STATION_FIELDS = ['stationTitle', 'timeDistance'];
const PRICE_FIELDS = ['priceGeo', 'unitPriceGeo', 'priceUsd', 'unitPriceUsd', 'currencyType'];
const ADDRESS_FIELDS = [
  'municipalityId',
  'municipalityTitle',
  'cityId',
  'cityTitle',
  'districtId',
  'districtTitle',
  'subdistrictId',
  'subdistrictTitle',
  'streetId',
  'streetTitle',
  'streetNumber',
];
const PAGE_FIELDS = ['initialPage', 'initialTotalApplicationCount', 'initialCardCount'];

/**
 * What `src/adapters/ss-ge/detail.ts` reads from a listing's own page
 * (`applicationData`): whether it is live, its price, and its details (Phase
 * 12B). Phones, contact names and the poster's name are never kept; the
 * account id and photo paths only as reserved fakes (`trimDetail`). The
 * account's listing count and its agency's number are kept (Phase 17B).
 */
const DETAIL_FIELDS = [
  'applicationId',
  'userApplicationCount',
  'agencyId',
  'status',
  'isInactiveApplication',
  'orderDate',
  'endDate',
  'realEstateTypeId',
  'realEstateDealTypeId',
  'title',
  'rooms',
  'bedrooms',
  'floor',
  'floors',
  'totalArea',
  'realEstateStatusId',
  'realEstateStatus',
  'state',
  'project',
  'floorType',
  'floorTypeText',
  'toilet',
  'balcony_Loggia',
  'kitchenArea',
  'areaOfHouse',
  'areaOfYard',
  'userEntityType',
  'locationLatitude',
  'locationLongitude',
  // The yes-or-no fields (AMENITY_FIELDS in src/realestate/kinds.ts).
  'airConditioning',
  'balcony',
  'basement',
  'cableTelevision',
  'drinkingWater',
  'electricity',
  'elevator',
  'fridge',
  'furniture',
  'garage',
  'glazedWindows',
  'heating',
  'hotWater',
  'internet',
  'ironDoor',
  'lastFloor',
  'naturalGas',
  'securityAlarm',
  'sewage',
  'storage',
  'telephone',
  'tv',
  'washingMachine',
  'water',
  'wiFi',
  'withPool',
  'viewOnYard',
  'viewOnStreet',
  'light',
  'comfortable',
  'withBuiltInKitchen',
  'isPetFriendly',
  'hasRemoteViewing',
  // Phase 14A. The developer's name (`companyName`) is never kept: an
  // individual entrepreneur's company is named after a person.
  'isManualPin',
  'streetLocationLatitude',
  'streetLocationLongitude',
  'cadastralCode',
  'projectId',
  'projectName',
  'companyId',
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(source, fields) {
  const out = {};
  if (!isRecord(source)) return out;
  for (const field of fields) if (field in source) out[field] = source[field];
  return out;
}

function maskPhones(value) {
  return typeof value === 'string' ? value.replace(PHONE_RE, '000') : value;
}

/** Each station's name and minutes only. */
function trimStations(value) {
  return Array.isArray(value) ? value.map((station) => pick(station, STATION_FIELDS)) : value;
}

function trimRow(row) {
  const out = pick(row, ROW_FIELDS);
  for (const field of ['title', 'description']) {
    if (field in out) out[field] = maskPhones(out[field]);
  }
  if (isRecord(row.price)) out.price = pick(row.price, PRICE_FIELDS);
  if ('address' in row) {
    out.address = isRecord(row.address) ? pick(row.address, ADDRESS_FIELDS) : row.address;
    if (isRecord(out.address)) {
      out.address.streetTitle = maskPhones(out.address.streetTitle);
      out.address.streetNumber = maskPhones(out.address.streetNumber);
    }
  }
  // Present on a business's rows; its type is all a fixture keeps (never the name).
  if ('userInfo' in row) {
    out.userInfo = isRecord(row.userInfo) ? { userType: row.userInfo.userType } : row.userInfo;
  }
  // Phases 17B and 17G: the account and the photos, as reserved fakes only.
  if ('userId' in row) out.userId = fakeUserId(row.userId);
  if ('appImages' in row) out.appImages = fakePhotos(row.appImages);
  if ('nearbySubwayStations' in row) {
    out.nearbySubwayStations = trimStations(row.nearbySubwayStations);
  }
  return out;
}

function trimResults(pageProps) {
  const out = pick(pageProps, PAGE_FIELDS);
  const list = isRecord(pageProps.applicationList)
    ? pageProps.applicationList.realStateItemModel
    : undefined;
  if (!Array.isArray(list)) throw new Error('no applicationList.realStateItemModel on this page');
  out.applicationList = { realStateItemModel: list.map(trimRow) };
  return out;
}

function trimDetail(pageProps) {
  const data = pageProps.applicationData;
  if (!isRecord(data)) return {};
  const out = pick(data, DETAIL_FIELDS);
  out.title = maskPhones(out.title);
  // A private poster's coordinates point at a home: a fixture keeps them to
  // two decimals, about a kilometre, which is enough to test their range.
  for (const field of ['locationLatitude', 'locationLongitude']) {
    if (typeof out[field] === 'number') out[field] = Math.round(out[field] * 100) / 100;
  }
  // The street's own point is ss.ge's, the same for every listing on it, and
  // kept whole. A parcel's cadastral code leads to its owner through the
  // public registry: only its shape is kept.
  if (typeof out.cadastralCode === 'string')
    out.cadastralCode = out.cadastralCode.replace(/\d/g, '0');
  out.projectName = maskPhones(out.projectName);
  if ('nearbySubwayStations' in data) {
    out.nearbySubwayStations = trimStations(data.nearbySubwayStations);
  }
  if (isRecord(data.price)) out.price = pick(data.price, PRICE_FIELDS);
  if (isRecord(data.address)) {
    out.address = pick(data.address, ADDRESS_FIELDS);
    out.address.streetTitle = maskPhones(out.address.streetTitle);
    out.address.streetNumber = maskPhones(out.address.streetNumber);
  }
  // Phases 17B and 17G: the account and the photos as reserved fakes; the
  // contact name, phones, agency and company names are never kept.
  if ('userId' in data) out.userId = fakeUserId(data.userId);
  if ('appImages' in data) out.appImages = fakePhotos(data.appImages);
  // Field names only, never values: what the page carries that is not kept.
  const dropped = Object.keys(data).filter((key) => !(key in out));
  console.log(`not kept: ${dropped.sort().join(', ')}`);
  const kept = { applicationData: out };
  // The agent block beside the listing: its codes only, never a name or an id.
  if (isRecord(pageProps.initialAgentInfoData)) {
    kept.initialAgentInfoData = pick(pageProps.initialAgentInfoData, [
      'companyId',
      'companyType',
      'infoType',
    ]);
  }
  return kept;
}

async function main() {
  const [mode, url, outFile] = process.argv.slice(2);
  if ((mode !== 'results' && mode !== 'detail') || !url || !outFile) {
    console.error(
      'usage: node scripts/capture-ss-ge-fixture.mjs <results|detail> <url> <out-file>',
    );
    process.exit(2);
  }
  const target = new URL(url);
  if (target.hostname !== 'home.ss.ge') throw new Error('only home.ss.ge pages are captured');

  const response = await fetch(target, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'ka' },
    redirect: 'manual',
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no __NEXT_DATA__ block on this page');
  const data = JSON.parse(match[1]);
  const pageProps = data?.props?.pageProps;
  if (!isRecord(pageProps)) throw new Error('no pageProps on this page');

  const kept = {
    props: { pageProps: mode === 'detail' ? trimDetail(pageProps) : trimResults(pageProps) },
    page: data.page,
    buildId: 'fixture',
  };
  const json = JSON.stringify(kept).replace(/</g, '\\u003c');
  const fixture = `<!DOCTYPE html><html lang="ka"><head><meta charSet="utf-8"/></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>\n`;

  for (const [what, pattern] of FORBIDDEN) {
    if (pattern.test(fixture)) throw new Error(`refusing to write: the fixture contains ${what}`);
  }
  if (realIdentifiers(fixture) > 0) {
    throw new Error('refusing to write: an account id or GUID in it is not a reserved fake');
  }
  writeFileSync(outFile, fixture, 'utf-8');
  if (mode === 'detail') {
    const listing = kept.props.pageProps.applicationData;
    console.log(
      `wrote ${outFile}: listing ${listing?.applicationId ?? 'none'}, ${listing?.status ?? 'no status'}`,
    );
    return;
  }
  const rows = kept.props.pageProps.applicationList.realStateItemModel.length;
  console.log(
    `wrote ${outFile}: page ${kept.props.pageProps.initialPage}, ${rows} rows, total ${kept.props.pageProps.initialTotalApplicationCount}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
