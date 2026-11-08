import { beforeAll, describe, expect, it } from 'vitest';
import { nameKey } from '../place-lookup.js';
import { type CuratedPlaces, loadCuratedPlaces } from './curated.js';

let curated: CuratedPlaces;
beforeAll(async () => {
  curated = await loadCuratedPlaces();
});

/** Hermes's `AREA_ALIASES`, as it stood when it was ported (Hermes repo, workflows/integrations/xtelo.py, 2026-11-07). */
const HERMES_ALIASES: Readonly<Record<string, string>> = {
  tbilisi: 'თბილისი',
  batumi: 'ბათუმი',
  kutaisi: 'ქუთაისი',
  rustavi: 'რუსთავი',
  gudauri: 'გუდაური',
  bakuriani: 'ბაკურიანი',
  kobuleti: 'ქობულეთი',
  telavi: 'თელავი',
  mtskheta: 'მცხეთა',
  'gldani-nadzaladevi': 'გლდანი-ნაძალადევი',
  'didube-chughureti': 'დიდუბე-ჩუღურეთი',
  'vake-saburtalo': 'ვაკე-საბურთალო',
  'isani-samgori': 'ისანი-სამგორი',
  'old tbilisi': 'ძველი თბილისი',
  gldani: 'გლდანი',
  nadzaladevi: 'ნაძალადევი',
  sanzona: 'სანზონა',
  mukhiani: 'მუხიანი',
  temka: 'თემქა',
  temqa: 'თემქა',
  ivertubani: 'ივერთუბანი',
  avchala: 'ავჭალა',
  lotkini: 'ლოტკინი',
  zahesi: 'ზაჰესი',
  gldanula: 'გლდანულა',
  'tbilisi sea': 'თბილისის ზღვა',
  didube: 'დიდუბე',
  chughureti: 'ჩუღურეთი',
  'dighomi massive': 'დიღმის მასივი',
  'digomi massive': 'დიღმის მასივი',
  kukia: 'კუკია',
  saburtalo: 'საბურთალო',
  'didi dighomi': 'დიდი დიღომი',
  'didi digomi': 'დიდი დიღომი',
  vake: 'ვაკე',
  lisi: 'ლისის ტბა',
  'lisi lake': 'ლისის ტბა',
  'dighomi 1-9': 'დიღომი 1-9',
  'digomi 1-9': 'დიღომი 1-9',
  bagebi: 'ბაგები',
  nutsubidze: 'ნუცუბიძის ფერდობი',
  'vazha-pshavela': 'ვაჟა ფშაველას კვარტლები',
  vashlijvari: 'ვაშლიჯვარი',
  vedzisi: 'ვეძისი',
  tkhinvala: 'თხინვალა',
  ortachala: 'ორთაჭალა',
  isani: 'ისანი',
  varketili: 'ვარკეთილი',
  samgori: 'სამგორი',
  vazisubani: 'ვაზისუბანი',
  navtlughi: 'ნავთლუღი',
  ponichala: 'ფონიჭალა',
  lilo: 'ლილო',
  orkhevi: 'ორხევი',
  mtatsminda: 'მთაწმინდა',
  vera: 'ვერა',
  avlabari: 'ავლაბარი',
  sololaki: 'სოლოლაკი',
  elia: 'ელია',
  abanotubani: 'აბანოთუბანი',
  'old batumi': 'ძველი ბათუმის უბანი',
  khimshiashvili: 'ხიმშიაშვილის უბანი',
  'airport batumi': 'აეროპორტის უბანი',
  makhinjauri: 'მახინჯაური',
};

/** Hermes's `AREA_GROUPS`: "dighomi" is four of ss.ge's areas. */
const HERMES_DIGHOMI = ['დიღომი 1-9', 'დიდი დიღომი', 'დიღმის მასივი', 'სოფ. დიღომი'];

function keysOf(place: CuratedPlaces['places'][number]): string[] {
  return [place.nameKa, place.nameEn, ...(place.aliases ?? [])].map((name) => nameKey(name));
}

describe('curated places', () => {
  it('holds each ss.ge place once', () => {
    const ids = curated.places.map((place) => `${place.level}:${place.ref}`);
    expect(new Set(ids).size).toBe(ids.length);
    const names = curated.places.map((place) => place.nameKa);
    expect(new Set(names).size).toBe(names.length);
  });

  it("finds every place Hermes's own aliases name, by the same words", () => {
    for (const [words, nameKa] of Object.entries(HERMES_ALIASES)) {
      const place = curated.places.find((p) => p.nameKa === nameKa);
      expect(place, nameKa).toBeDefined();
      if (place) expect(keysOf(place), words).toContain(nameKey(words));
    }
  });

  it("gives Hermes's Dighomi group to its four places", () => {
    for (const nameKa of HERMES_DIGHOMI) {
      const place = curated.places.find((p) => p.nameKa === nameKa);
      expect(place && keysOf(place), nameKa).toContain(nameKey('dighomi'));
    }
    const others = curated.places.filter(
      (p) => !HERMES_DIGHOMI.includes(p.nameKa) && keysOf(p).includes(nameKey('dighomi')),
    );
    expect(others).toEqual([]);
  });

  it("keeps Hermes's nearest area for Zgvisubani as a neighbourhood", () => {
    const zgvisubani = curated.neighbourhoods.find((n) => n.code === 'zgvisubani');
    expect(zgvisubani).toMatchObject({ parentLevel: 'subdistrict', parentRef: 36 });
    expect(curated.places.find((p) => p.level === 'subdistrict' && p.ref === 36)?.nameKa).toBe(
      'თბილისის ზღვა',
    );
  });

  it('has only aliases that add a key the names do not already give', () => {
    for (const place of curated.places) {
      const named = [nameKey(place.nameKa), nameKey(place.nameEn)];
      for (const alias of place.aliases ?? []) {
        expect(nameKey(alias), `${place.nameKa}: ${alias}`).not.toBe('');
        expect(named, `${place.nameKa}: ${alias}`).not.toContain(nameKey(alias));
      }
    }
  });
});
