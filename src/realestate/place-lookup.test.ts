import { describe, expect, it } from 'vitest';
import { looseWord, nameKey, placeKeys } from './place-lookup.js';

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
