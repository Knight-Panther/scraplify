#!/usr/bin/env node
/**
 * Recon for Phase 17B and 17G (docs/PHASE_17_PLAN.md): where ss.ge keeps a
 * listing's poster (account id, contact name, phones, email) and its photo
 * references, on a results page, on listing pages and on an account's
 * profile page. It prints the SHAPE of each page's data only: every key path
 * with its type and how often it is there, URL paths with digits masked, and
 * phone-like and email-like strings as a kind. No name, number, id or text
 * from a page is printed, so the output can go into RECON_NOTES.md as is.
 *
 *   npm run build
 *   sudo /opt/xtelo/current/deploy/with-env.sh worker node scripts/ss-ge-recon-posters.mjs
 *   node scripts/ss-ge-recon-posters.mjs --file=results:<html> --file=detail:<html> ...
 *
 * Live, it makes 7 requests through the crawler's fetcher, policy and 3 s
 * spacing (and SS_GE_PROXY_URL when set, as the nightly crawl does): two
 * results pages (flats for sale, land for sale), three of their listings'
 * pages, and the profile pages of two of their accounts. Run it only when no
 * ss.ge crawl is running. The profile page is not a shape the crawler may
 * fetch (isSsGeUrlAllowed); this script allows exactly
 * /ka/udzravi-qoneba/userlist?userId=<digits> besides, which robots.txt does
 * not disallow. With --file it reads saved pages and requests nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist =
  process.env.XTELO_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { readPageProps } = await load('adapters/ss-ge/page.js');

const POSTER_KEY =
  /user|phone|contact|person|owner|agent|agency|email|mail|company|organi[sz]ation|name|profile|broker|developer/i;
const PHOTO_KEY = /image|photo|img|gallery|thumb|picture|cover|main|media|video/i;
/** Short values of these keys are categories, not people: printed as they are. */
const ENUM_KEY = /type$|status$|kind$|role$/i;

// ---------------------------------------------------------------- shapes

/** What a value is, never what it says. */
function shape(key, value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value !== 'string') return typeof value;
  const s = value.trim();
  if (s === '') return 'string(empty)';
  if (/^https?:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      // A segment that is one plain word (upload, images) stays, and so does a
      // file extension; any other, which could be a name's slug, keeps only
      // its shape: letters become a, digits 9.
      const segment = (part) => {
        if (part === '<guid>' || /^[a-z_]{1,12}$/i.test(part)) return part;
        const ext = /\.[a-z0-9]{2,4}$/i.exec(part)?.[0] ?? '';
        const stem = ext ? part.slice(0, -ext.length) : part;
        return stem.replace(/<guid>|(\p{L})/gu, (m, letter) => (letter ? 'a' : m)) + ext;
      };
      const masked = url.pathname
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
        .replace(/[0-9]/g, '9')
        .split('/')
        .map(segment)
        .join('/');
      return `url ${url.host}${masked}${url.search ? ' ?' + [...url.searchParams.keys()].join('&') : ''}`;
    } catch {
      return 'string(url-like)';
    }
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'string(email)';
  if (/^[+\d\s().*-]{7,}$/.test(s) && /\d{3}/.test(s)) {
    const digits = s.replace(/\D/g, '').length;
    return `string(phone, ${digits} digits${s.includes('*') ? ', masked' : ''})`;
  }
  if (/^\d+$/.test(s)) return `string(${s.length} digits)`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'string(date)';
  if (ENUM_KEY.test(key) && s.length <= 24 && !/\d{4}/.test(s)) return `enum "${s}"`;
  return `string(${s.length} chars)`;
}

/** Every leaf path under `value`, arrays merged as []: path -> {seen, kinds, lengths}. */
function walk(value, at, out, depth = 0) {
  const key =
    at
      .split(/[.[\]]/)
      .filter(Boolean)
      .at(-1) ?? '';
  const entry = (out[at] ??= { seen: 0, kinds: new Map(), lengths: [] });
  entry.seen += 1;
  const kind = shape(key, value);
  entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
  if (depth > 7) return;
  if (Array.isArray(value)) {
    entry.lengths.push(value.length);
    for (const item of value) walk(item, `${at}[]`, out, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    for (const [child, inner] of Object.entries(value))
      walk(inner, `${at}.${child}`, out, depth + 1);
  }
}

function report(title, values, { only } = {}) {
  const out = {};
  for (const value of values) walk(value, '$', out);
  console.log(`\n## ${title} (${values.length})`);
  for (const [at, { seen, kinds, lengths }] of Object.entries(out)) {
    if (only && !only.test(at)) continue;
    const kindText = [...kinds]
      .map(([kind, n]) => (kinds.size > 1 ? `${kind} ×${n}` : kind))
      .join(' | ');
    const lengthText = lengths.length
      ? ` len ${Math.min(...lengths)}..${Math.max(...lengths)}`
      : '';
    console.log(`${at}  [${seen}]  ${kindText}${lengthText}`);
  }
}

/** Paths whose own key is about the poster or the photos, and everything under them. */
const INTERESTING = new RegExp(
  String.raw`(^|[.\]])(` + `${POSTER_KEY.source}|${PHOTO_KEY.source}` + String.raw`)[^.]*($|[.[])`,
  'i',
);

// ---------------------------------------------------------------- finding things

/** The first numeric-looking value under a key named like a user id. Kept in memory only. */
function findUserId(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 6) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (/^user_?id$/i.test(key) && /^\d{1,12}$/.test(String(inner ?? ''))) return String(inner);
  }
  for (const inner of Object.values(value)) {
    const found = findUserId(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

function resultRows(props) {
  const list = props.applicationList;
  const rows = list && typeof list === 'object' ? list.realStateItemModel : undefined;
  return Array.isArray(rows) ? rows : [];
}

// ---------------------------------------------------------------- pages

const files = process.argv.slice(2).filter((arg) => arg.startsWith('--file='));
const pages = { results: [], detail: [], profile: [] };

if (files.length > 0) {
  for (const arg of files) {
    const [kind, file] = arg.slice('--file='.length).split(/:(.+)/);
    if (!(kind in pages) || !file)
      throw new Error(`--file wants results|detail|profile:<path>, got ${arg}`);
    pages[kind].push(readPageProps(readFileSync(file, 'utf8')));
  }
} else {
  const { createHttpFetcher } = await load('net/http-fetcher.js');
  const { createRateLimiter } = await load('net/rate-limiter.js');
  const { resolveUserAgent } = await load('net/user-agent.js');
  const { proxyDispatcherFromEnv } = await load('net/proxy-dispatcher.js');
  const { isSsGeUrlAllowed, ssGePolicy, ssGeSource } = await load('policies/ss-ge.js');
  const { SS_GE_LISTS, buildResultsUrl, buildDetailUrl } = await load('adapters/ss-ge/crawl.js');

  const profileUrl = (userId) =>
    new URL(`/ka/udzravi-qoneba/userlist?userId=${userId}`, ssGeSource.baseUrl).toString();
  const isProfileUrl = (url) => {
    const parsed = new URL(url);
    return (
      parsed.host === 'home.ss.ge' &&
      parsed.pathname === '/ka/udzravi-qoneba/userlist' &&
      [...parsed.searchParams.keys()].join() === 'userId' &&
      /^\d{1,12}$/.test(parsed.searchParams.get('userId') ?? '')
    );
  };
  const proxy = proxyDispatcherFromEnv('SS_GE_PROXY_URL');
  const fetcher = createHttpFetcher({
    isUrlAllowed: (url) => isSsGeUrlAllowed(url) || isProfileUrl(url),
    rateLimiter: createRateLimiter(ssGePolicy.rateLimit),
    userAgent: resolveUserAgent(),
    requestTimeoutMs: 60_000,
    ...(proxy === null ? {} : { dispatcher: proxy.dispatcher }),
  });
  let requests = 0;
  const get = async (label, url) => {
    requests += 1;
    const response = await fetcher.fetch(url);
    console.error(`${label}: http ${response.status}`);
    if (response.status !== 200) return null;
    try {
      return readPageProps(response.body);
    } catch (err) {
      console.error(`${label}: ${err.message}`);
      return null;
    }
  };

  try {
    const lists = ['flat-sale', 'land-sale'].map((key) =>
      SS_GE_LISTS.find((list) => list.key === key),
    );
    const rows = [];
    for (const list of lists.filter(Boolean)) {
      const props = await get(`results ${list.key}`, buildResultsUrl(list, 1));
      if (props) {
        pages.results.push(props);
        rows.push(...resultRows(props));
      }
    }
    // Three listings: the first rows of each list, so one is likely an agency's.
    const ids = rows
      .map((row) => row?.applicationId)
      .filter((id) => /^\d+$/.test(String(id ?? '')));
    const picked = [ids[0], ids[1], ids.at(-1)].filter(Boolean).slice(0, 3);
    const userIds = new Set();
    for (const [index, id] of picked.entries()) {
      const props = await get(`listing ${index + 1}`, buildDetailUrl(String(id)));
      if (!props) continue;
      pages.detail.push(props);
      const userId = findUserId(props);
      if (userId) userIds.add(userId);
    }
    for (const row of rows) {
      const userId = findUserId(row);
      if (userId && userIds.size < 2) userIds.add(userId);
    }
    for (const [index, userId] of [...userIds].slice(0, 2).entries()) {
      const props = await get(`profile ${index + 1}`, profileUrl(userId));
      if (props) pages.profile.push(props);
    }
  } finally {
    await fetcher.close();
  }
  console.error(`requests: ${requests}`);
}

// ---------------------------------------------------------------- report

const rows = pages.results.flatMap(resultRows);
console.log('# ss.ge poster and photo recon (shapes only)');
console.log(
  `pages: ${pages.results.length} results (${rows.length} rows), ${pages.detail.length} listing, ${pages.profile.length} profile`,
);
report('results page: pageProps, top level', pages.results, { only: /^\$\.[^.[]+$/ });
report('results rows: poster and photo fields', rows, { only: INTERESTING });
report('results rows: every key', rows, { only: /^\$\.[^.[]+$/ });
report('listing pages: poster and photo fields', pages.detail, { only: INTERESTING });
report('listing pages: pageProps, two levels', pages.detail, { only: /^\$(\.[^.[]+){1,2}$/ });
report('profile pages: everything', pages.profile);
