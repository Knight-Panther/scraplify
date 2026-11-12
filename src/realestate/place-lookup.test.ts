import { describe, expect, it } from 'vitest';
import {
  askedKind,
  initialForms,
  looseWord,
  nameKey,
  nameKeys,
  placeKeys,
  placeLookupSql,
  placeTextLookupSql,
  romanizedName,
  splitPlaceText,
} from './place-lookup.js';

describe('looseWord', () => {
  it('romanizes and loosens as Hermes does', () => {
    // Hermes's own `loose_words` on each word (workflows/integrations/xtelo.py, 2026-11-07).
    const hermes: Record<string, string> = {
      ჭავჭავაძე: 'cavcavaze',
      ჭავჭავაძის: 'cavcavazis',
      დიღომი: 'digomi',
      დიღმის: 'digmis',
      თემქა: 'temka',
      temqa: 'temka',
      temka: 'temka',
      ortatchala: 'ortacala',
      ორთაჭალა: 'ortacala',
      ვაკე: 'vake',
      ბაგები: 'bagebi',
      ნაძალადევი: 'nazaladevi',
      მთაწმინდა: 'mtacminda',
      ჩუღურეთი: 'cugureti',
      ავჭალა: 'avcala',
      ფონიჭალა: 'ponicala',
      ღრმაღელე: 'grmagele',
      წერეთელი: 'cereteli',
      ხიმშიაშვილის: 'kimsiasvilis',
      ჟურნალისტი: 'zurnalisti',
      ყაზბეგი: 'kazbegi',
      ჯავახიშვილი: 'javakisvili',
      ჰერა: 'hera',
      digomi: 'digomi',
      dighomi: 'digomi',
      Chavchavadze: 'cavcavaze',
    };
    for (const [word, loose] of Object.entries(hermes)) {
      expect(looseWord(word), word).toBe(loose);
    }
  });
});

describe('placeKeys', () => {
  it('gives a street the same key in every form people write it', () => {
    for (const form of [
      'ჭავჭავაძე',
      'ჭავჭავაძის',
      'ჭავჭავაძის გამზ.',
      'ჭავჭავაძის გამზირი',
      'chavchavadze',
      'Chavchavadze Ave',
      'chavchavadzis',
      'Tchavtchavadze avenue',
    ]) {
      expect(nameKey(form), form).toBe('cavcavaz');
    }
  });

  it('keeps initials and numbers', () => {
    expect(nameKey('ი. ჭავჭავაძის გამზ.')).toBe('i cavcavaz');
    expect(nameKey('I. Chavchavadze Avenue')).toBe('i cavcavaz');
    expect(nameKey('დიღომი 1-9')).toBe('digom 1 9');
    expect(nameKey('digomi 1-9')).toBe('digom 1 9');
    expect(nameKey('11 მარტის ქ.')).toBe('11 mart');
    expect(nameKey('აბულაძის I შეს.')).toBe('abulaz i');
  });

  it("folds Hermes's own cases", () => {
    const same = [
      ['Temqa', 'Temka', 'თემქა'],
      ['Digomi', 'Dighomi', 'დიღომი', 'დიღომში'],
      ['Vake', 'ვაკე', 'ვაკეში', 'ვაკის'],
      // Plural in form: the plural ending stays, so the Latin spelling still meets it.
      ['Bagebi', 'ბაგები', 'ბაგებში', 'ბაგების'],
      ['Bzholebi', 'ბჟოლები', 'ბჟოლებში'],
      ['Didi Dighomi', 'Didi Digomi', 'დიდი დიღომი', 'დიდ დიღომში'],
      ['ძველი თბილისი', 'ძველ თბილისში'],
      ['Gldani-Nadzaladevi', 'გლდანი-ნაძალადევი'],
      ['Ortachala', 'Ortatchala', 'ორთაჭალა'],
      ['Saburtalo', 'საბურთალო', 'საბურთალოზე', 'საბურთალოს'],
      ['Gldani', 'გლდანი', 'გლდანში', 'Gldanis'],
      ['Vazha-Pshavela', 'ვაჟა-ფშაველა', 'ვაჟა ფშაველას'],
      ['Krtsanisi', 'კრწანისი', 'კრწანისის'],
      ['Chughureti', 'Chugureti', 'ჩუღურეთი'],
    ];
    for (const forms of same) {
      const keys = forms.map((form) => nameKey(form));
      expect(new Set(keys).size, forms.join(' / ')).toBe(1);
      expect(keys[0], forms[0]).not.toBe('');
    }
  });

  it('keeps the district word, which picks the official map', () => {
    expect(nameKey('Vake')).toBe('vak');
    expect(nameKey('ვაკის რაიონი')).toBe('vak raion');
    expect(nameKey('vakis raioni')).toBe('vak raion');
    expect(nameKey('Vake District')).toBe('vak district');
    expect(nameKey('Vake rayon')).toBe('vak raion');
  });

  it('leaves out words that only name a kind of place', () => {
    expect(placeKeys('ქ.')).toEqual([]);
    expect(placeKeys('გამზირი')).toEqual([]);
    expect(nameKey('სოფ. დიღომი')).toBe(nameKey('დიღომი'));
    expect(nameKey('კონიაკის დას.')).toBe('koniak');
    expect(nameKey('აეროპორტის გზატ.')).toBe('aeroport');
    expect(nameKey('ხიმშიაშვილის უბანი')).toBe(nameKey('Khimshiashvili'));
    expect(nameKey('ბათუმის უბნები')).toBe(nameKey('Batumi'));
    expect(nameKey('გლდანის მ/რ')).toBe('gldan');
    expect(nameKey('Tsereteli Street')).toBe(nameKey('წერეთელი'));
    expect(nameKey('ვაჟა ფშაველას კვარტლები')).toBe(nameKey('Vazha-Pshavela'));
    expect(nameKey('№12')).toBe('12');
  });

  it('does not fold a stem Georgian shortens inside the word: that is what aliases are for', () => {
    expect(nameKey('დიღმის მასივი')).toBe('digm masiv');
    expect(nameKey('Dighomi Massive')).toBe('digom masiv');
  });

  it('reads capital Georgian (Mtavruli) and full-width forms', () => {
    expect(nameKey('ᲕᲐᲙᲔ')).toBe('vak');
    expect(nameKey('ＶＡＫＥ')).toBe('vak');
  });

  it('gives nothing for empty or punctuation-only text', () => {
    expect(placeKeys('')).toEqual([]);
    expect(placeKeys(' .,- ')).toEqual([]);
  });
});

describe('initials (version 3)', () => {
  it('keys a name that starts with initials without them too', () => {
    // ss.ge's Chavchavadze Avenue (street 19, 4,437 listings on 2026-11-12) and two namesakes.
    expect(nameKeys('ი.ჭავჭავაძის გამზ.')).toEqual(['i cavcavaz', 'cavcavaz']);
    expect(nameKeys('ალ. ჭავჭავაძის ქ.')).toEqual(['al cavcavaz', 'cavcavaz']);
    expect(nameKeys('ზ.ჭავჭავაძის ქ.')).toEqual(['z cavcavaz', 'cavcavaz']);
    expect(nameKeys('I. Chavchavadze Avenue')).toEqual(['i cavcavaz', 'cavcavaz']);
    expect(nameKeys('წმ. ნინოს ქ.')).toEqual([nameKey('წმ. ნინოს ქ.'), nameKey('ნინოს ქ.')]);
    // A kind word in that place is left out anyway: one key.
    expect(nameKeys('სოფ. გლდანი')).toEqual(['gldan']);
    expect(nameKeys('ჭავჭავაძის გამზ.')).toEqual(['cavcavaz']);
    // Initials and ჟ together.
    expect(nameKeys('ა.ჟორდანიას ქ.')).toEqual(['a zordani', 'a jordani', 'zordani', 'jordani']);
  });

  it('lets a first name find an initial, exactly', () => {
    expect(initialForms(nameKey('Ilia Chavchavadze'))).toEqual(['i cavcavaz', 'il cavcavaz']);
    expect(initialForms(nameKey('Alexander Chavchavadze'))).toEqual(['a cavcavaz', 'al cavcavaz']);
    // Only a first word of three letters or more, and only before another word.
    expect(initialForms('cavcavaz')).toEqual([]);
    expect(initialForms('i cavcavaz')).toEqual([]);
    expect(initialForms('11 mart')).toEqual([]);
    const built = placeLookupSql('Ilia Chavchavadze');
    expect(JSON.parse(String(built?.params[0]))).toEqual([
      { key: 'ili cavcavaz', kind: null, alts: ['i cavcavaz', 'il cavcavaz'] },
    ]);
  });
});

describe('askedKind', () => {
  it('reads a street word after a name as a street, a village word anywhere as a village', () => {
    for (const words of [
      'Chavchavadze Avenue',
      'Chavchavadze Ave',
      'ჭავჭავაძის გამზირი',
      'ჭავჭავაძის გამზ.',
      'Kazbegi st.',
    ]) {
      expect(askedKind(words), words).toBe('street');
    }
    for (const words of ['Gldani village', 'სოფ. გლდანი', 'კონიაკის დას.', 'Africa settlement']) {
      expect(askedKind(words), words).toBe('village');
    }
    // ქ. before a name is the city; St. before one is a saint; quarter asks for nothing.
    for (const words of [
      'ჭავჭავაძის',
      'Vake',
      'ქ. ბათუმი',
      'St. Nicholas',
      'Khimshiashvili Quarter',
    ]) {
      expect(askedKind(words), words).toBeNull();
    }
    expect(placeLookupSql('Chavchavadze Avenue')).toMatchObject({
      key: 'cavcavaz',
      kind: 'street',
    });
  });
});

describe('romanizedName', () => {
  it('writes a Georgian name in Latin letters by the national system, each word capitalized', () => {
    expect(romanizedName('ჭავჭავაძის გამზ.')).toBe('Chavchavadzis Gamz.');
    expect(romanizedName('წავკისი')).toBe('Tsavkisi');
    expect(romanizedName('ხიმშიაშვილის უბანი')).toBe('Khimshiashvilis Ubani');
    expect(romanizedName('გლდანი-ნაძალადევი')).toBe('Gldani-Nadzaladevi');
    expect(romanizedName('300 არაგველი')).toBe('300 Aragveli');
    expect(romanizedName('ქეთევან წამებულის გამზ. (ავლაბარი)')).toBe(
      'Ketevan Tsamebulis Gamz. (Avlabari)',
    );
  });

  it('keeps the letters a loose key would fold, and leaves Latin as it is', () => {
    // A key folds kh, gh and ts (nameKey); a name to show keeps them.
    expect(romanizedName('ღრმაღელე')).toBe('Ghrmaghele');
    expect(romanizedName('ᲕᲐᲙᲔ')).toBe('Vake');
    expect(romanizedName('Vake District')).toBe('Vake District');
  });
});

describe('splitPlaceText', () => {
  it('splits a text into parts on / , ; and each part into words', () => {
    const split = splitPlaceText(' Temka/Zgvisubani; Vake,  Saburtalo ');
    expect(split.parts.map((part) => part.words)).toEqual([
      ['Temka'],
      ['Zgvisubani'],
      ['Vake'],
      ['Saburtalo'],
    ]);
  });

  it('keys every run of up to four words, and no run of kind words alone', () => {
    const split = splitPlaceText('Vake Saburtalo street');
    expect(Object.fromEntries(split.runs)).toEqual({
      '0:0:1': { key: 'vak', kind: null },
      '0:0:2': { key: 'vak saburtal', kind: null },
      '0:0:3': { key: 'vak saburtal', kind: 'street' },
      '0:1:2': { key: 'saburtal', kind: null },
      '0:1:3': { key: 'saburtal', kind: 'street' },
    });
    // A hyphen keeps one word, so "vake-saburtalo" is a single run.
    expect(Object.fromEntries(splitPlaceText('vake-saburtalo').runs)).toEqual({
      '0:0:1': { key: 'vak saburtal', kind: null },
    });
  });

  it('builds one query for every key and kind, with the per-name limit, or none for kind words alone', () => {
    const built = placeTextLookupSql('Vake, Saburtalo', { placeholders: 'psycopg', limit: 5 });
    expect(built?.params).toEqual([
      JSON.stringify([
        { key: 'vak', kind: null, alts: [] },
        { key: 'saburtal', kind: null, alts: [] },
      ]),
      5,
    ]);
    expect(built?.sql).not.toMatch(/\$\d/);
    expect(placeTextLookupSql('street; ave')).toBeNull();
    // "Chavchavadze" and "Chavchavadze Avenue" share a key, not a kind: two names.
    const avenue = placeTextLookupSql('Chavchavadze Avenue');
    expect(JSON.parse(String(avenue?.params[0]))).toEqual([
      { key: 'cavcavaz', kind: null, alts: [] },
      { key: 'cavcavaz', kind: 'street', alts: [] },
    ]);
  });

  it('takes only a whole number as the limit', () => {
    expect(placeLookupSql('Vake', { limit: Number.NaN })?.params[1]).toBe(50);
    expect(placeLookupSql('Vake', { limit: 2.7 })?.params[1]).toBe(2);
    expect(placeLookupSql('Vake', { limit: 10_000 })?.params[1]).toBe(500);
  });
});
