#!/usr/bin/env node
/**
 * Writes src/realestate/places/tbilisi.json: Tbilisi's 10 official districts
 * with their borders, and its metro stations matched to ss.ge's station codes
 * (Phase 14B, the official map). Run once, by hand, when OpenStreetMap's
 * borders or stations change; the file is committed and read at run time.
 *
 *   node scripts/fetch-osm-places.mjs
 *
 * Two requests to OpenStreetMap's Nominatim (its usage policy allows this:
 * one request at a time, an identifying User-Agent, no bulk). Borders come
 * simplified to 0.0001° (about 10 m) by Nominatim, well inside the 50 m that
 * marks a point as on a border (src/realestate/places/official.ts).
 *
 * Data © OpenStreetMap contributors, under the Open Database License 1.0.
 */
import { writeFileSync } from 'node:fs';

const USER_AGENT =
  process.env.SCRAPLIFY_USER_AGENT?.trim() ||
  'ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/lookup';
const OUT = new URL('../src/realestate/places/tbilisi.json', import.meta.url);
/** Degrees: about 11 m north–south and 8 m east–west in Tbilisi. */
const SIMPLIFY = 0.0001;

/** The 10 districts (admin_level 10 inside Tbilisi's relation 1996871), by relation id. */
const DISTRICTS = [
  [11300449, 'vake'],
  [11300446, 'saburtalo'],
  [11300445, 'didube'],
  [11300438, 'nadzaladevi'],
  [13438812, 'gldani'],
  [13438810, 'chughureti'],
  [13438811, 'mtatsminda'],
  [13438809, 'krtsanisi'],
  [13438808, 'isani'],
  [11300436, 'samgori'],
];

/**
 * The stations: ss.ge's code (`stationTitle` in `nearbySubwayStations`), our
 * own fixed ref, the lines, and the OSM node(s). ss.ge has one code for
 * Station Square, where OSM has a node for each line's hall; the point is
 * their midpoint. Refs never change once published (C6).
 */
const STATIONS = [
  { ref: 1, code: 'akhmeteli', lines: [1], osm: [437955651] },
  { ref: 2, code: 'sarajishvili', lines: [1], osm: [437955710] },
  { ref: 3, code: 'guramishvili', lines: [1], osm: [437955726] },
  { ref: 4, code: 'grmagele', lines: [1], osm: [5267558014] },
  { ref: 5, code: 'didube', lines: [1], osm: [4632061332] },
  { ref: 6, code: 'gotsiridze', lines: [1], osm: [725175525] },
  // OSM's English name is misspelt "Nadzaledevi".
  { ref: 7, code: 'nadzaladevi', lines: [1], osm: [289383777], nameEn: 'Nadzaladevi' },
  {
    ref: 8,
    code: 'station_square',
    lines: [1, 2],
    osm: [7285245525, 7285245526],
    nameKa: 'სადგურის მოედანი',
    nameEn: 'Station Square',
  },
  { ref: 9, code: 'marjanishvili', lines: [1], osm: [289384125] },
  { ref: 10, code: 'rustaveli', lines: [1], osm: [289358478] },
  { ref: 11, code: 'tavisuplebis_moedani', lines: [1], osm: [289358479] },
  { ref: 12, code: 'avlabari', lines: [1], osm: [5768595732] },
  { ref: 13, code: 'samasi_aragveli', lines: [1], osm: [288584312] },
  { ref: 14, code: 'isani', lines: [1], osm: [288584317] },
  { ref: 15, code: 'samgori', lines: [1], osm: [729529330] },
  { ref: 16, code: 'varketili', lines: [1], osm: [7285245527] },
  { ref: 17, code: 'tsereteli', lines: [2], osm: [729578803] },
  { ref: 18, code: 'tech_uni', lines: [2], osm: [729551832] },
  { ref: 19, code: 'medical_uni', lines: [2], osm: [729561142] },
  { ref: 20, code: 'delisi', lines: [2], osm: [729562894] },
  { ref: 21, code: 'vazha_pshavela', lines: [2], osm: [729562896] },
  { ref: 22, code: 'state_uni', lines: [2], osm: [358503996] },
];

async function lookup(ids, extra) {
  const url = `${NOMINATIM}?format=json&namedetails=1&osm_ids=${ids.join(',')}${extra}`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Nominatim answered ${response.status} for ${url}`);
  return response.json();
}

const round = (value, places) => Number(value.toFixed(places));

function names(place, id) {
  const ka = place.namedetails?.name;
  const en = place.namedetails?.['name:en'];
  if (!ka || !en) throw new Error(`OSM ${id} has no Georgian or English name`);
  return { ka, en };
}

const districtPlaces = await lookup(
  DISTRICTS.map(([id]) => `R${id}`),
  `&polygon_geojson=1&polygon_threshold=${SIMPLIFY}`,
);
const districts = DISTRICTS.map(([id, code]) => {
  const place = districtPlaces.find((p) => p.osm_type === 'relation' && p.osm_id === id);
  if (!place) throw new Error(`district relation ${id} is missing`);
  if (place.geojson?.type !== 'Polygon') {
    throw new Error(`district ${id} is a ${place.geojson?.type}, not one polygon`);
  }
  const { ka, en } = names(place, id);
  return {
    ref: id,
    code,
    nameKa: ka,
    nameEn: en,
    // GeoJSON order: [longitude, latitude]; the first ring is the border, any other a hole.
    rings: place.geojson.coordinates.map((ring) =>
      ring.map(([lng, lat]) => [round(lng, 5), round(lat, 5)]),
    ),
  };
});

// Nominatim's lookup is rate-limited to one request a second.
await new Promise((resolve) => setTimeout(resolve, 1500));

const stationPlaces = await lookup(
  STATIONS.flatMap((s) => s.osm.map((id) => `N${id}`)),
  '',
);
const stations = STATIONS.map((station) => {
  const nodes = station.osm.map((id) => {
    const place = stationPlaces.find((p) => p.osm_type === 'node' && p.osm_id === id);
    if (!place) throw new Error(`station node ${id} (${station.code}) is missing`);
    return { ...names(place, id), lat: Number(place.lat), lng: Number(place.lon) };
  });
  const mean = (key) => nodes.reduce((sum, node) => sum + node[key], 0) / nodes.length;
  return {
    ref: station.ref,
    code: station.code,
    osm: station.osm,
    nameKa: station.nameKa ?? nodes[0].ka,
    nameEn: station.nameEn ?? nodes[0].en,
    lines: station.lines,
    lat: round(mean('lat'), 6),
    lng: round(mean('lng'), 6),
  };
});

const file = {
  about:
    "Tbilisi's 10 official districts and its metro stations, from OpenStreetMap: data © OpenStreetMap contributors, available under the Open Database License 1.0 (https://www.openstreetmap.org/copyright). Written by scripts/fetch-osm-places.mjs; borders simplified to 0.0001° by Nominatim. Station refs are ours and never change; codes are ss.ge's.",
  fetchedAt: new Date().toISOString().slice(0, 10),
  districts,
  stations,
};
// One line per district and station, so a refetch diffs by place; biome
// leaves the file alone (biome.json), as it does the fixtures.
const list = (items) => items.map((item) => `  ${JSON.stringify(item)}`).join(',\n');
writeFileSync(
  OUT,
  `{\n "about": ${JSON.stringify(file.about)},\n "fetchedAt": ${JSON.stringify(file.fetchedAt)},\n` +
    ` "districts": [\n${list(districts)}\n ],\n "stations": [\n${list(stations)}\n ]\n}\n`,
);
const points = districts.reduce((sum, d) => sum + d.rings.flat().length, 0);
console.log(
  `wrote ${OUT.pathname}: ${districts.length} districts (${points} border points), ${stations.length} stations`,
);
