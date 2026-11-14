import { describe, expect, it } from 'vitest';
import {
  employerKey,
  type FieldExample,
  features,
  guessField,
  trainFieldModel,
} from './field-guess.js';

const SALES = 'გაყიდვები';
const BANK = 'საბანკო';
const FOOD = 'სასტუმრო / რესტორანი / კვება';
const IT = 'ინფორმაციული ტექნოლოგიები';

function example(title: string, fields: string[], over: Partial<FieldExample> = {}): FieldExample {
  return { title, employer: null, description: null, fields, ...over };
}

/** A small corpus in the shape hr.ge gives: Georgian titles, some English, a few employers. */
const CORPUS: FieldExample[] = [
  example('გაყიდვების მენეჯერი', [SALES]),
  example('გაყიდვების კონსულტანტი', [SALES]),
  example('გამყიდველ-კონსულტანტი', [SALES]),
  example('სავაჭრო წარმომადგენელი', [SALES]),
  example('Sales Manager', [SALES]),
  example('საკრედიტო ოფიცერი', [BANK], { employer: 'სს თიბისი ბანკი' }),
  example('ბანკის ოპერატორი', [BANK], { employer: 'სს თიბისი ბანკი' }),
  example('კლიენტთა მომსახურების სპეციალისტი', [BANK], { employer: 'სს საქართველოს ბანკი' }),
  example('მზარეული', [FOOD]),
  example('მიმტანი', [FOOD], { description: 'რესტორანს სჭირდება მიმტანი, სტუმრების მომსახურება' }),
  example('ბარმენი', [FOOD]),
  example('ჭურჭლის მრეცხავი', [FOOD], { description: 'რესტორანში სამზარეულოს დამხმარე' }),
  example('Java დეველოპერი', [IT]),
  example('Frontend Developer', [IT]),
  example('ქსელის ადმინისტრატორი', [IT]),
  // Two fields at once: counted toward each in half.
  example('გაყიდვების მენეჯერი ბანკში', [SALES, BANK]),
];

describe('guessField', () => {
  const model = trainFieldModel(CORPUS);

  it.each([
    ['უფროსი გაყიდვების მენეჯერი', SALES],
    ['მზარეულის დამხმარე', FOOD],
    ['Senior Java Developer', IT],
    ['მიმტანი ბარში', FOOD],
  ])('reads %s as %s from the title', (title, field) => {
    expect(guessField(model, { title, employer: null, description: null })?.field).toBe(field);
  });

  it('lets the employer decide a title that alone says little', () => {
    const text = { title: 'სპეციალისტი', employer: 'სს თიბისი ბანკი', description: null };
    expect(guessField(model, text)?.field).toBe(BANK);
  });

  it('reads the description when the title is unknown', () => {
    const text = { title: 'ასისტენტი', employer: null, description: 'რესტორანში სამზარეულოს' };
    expect(guessField(model, text)?.field).toBe(FOOD);
  });

  it('gives no guess when no word was ever seen', () => {
    expect(guessField(model, { title: 'ფოტოგრაფი', employer: null, description: null })).toBeNull();
    expect(guessField(model, { title: '', employer: null, description: null })).toBeNull();
  });

  it('reports a probability and a runner-up that add up to at most one', () => {
    const guess = guessField(model, {
      title: 'გაყიდვების მენეჯერი',
      employer: null,
      description: null,
    });
    expect(guess?.probability).toBeGreaterThan(0.5);
    expect(guess?.runnerUp).not.toBeNull();
    expect((guess?.probability ?? 0) + (guess?.runnerUp?.probability ?? 0)).toBeLessThanOrEqual(1);
  });

  it('is less sure of an ambiguous title than of a clear one', () => {
    const clear = guessField(model, { title: 'მზარეული', employer: null, description: null });
    const mixed = guessField(model, { title: 'მენეჯერი', employer: null, description: null });
    expect(clear?.probability ?? 0).toBeGreaterThan(mixed?.probability ?? 1);
  });

  it('does not depend on the order the examples came in', () => {
    const reversed = trainFieldModel([...CORPUS].reverse());
    for (const title of ['გაყიდვების მენეჯერი', 'მენეჯერი', 'Developer', 'ბარმენი']) {
      const text = { title, employer: null, description: null };
      expect(guessField(reversed, text)).toEqual(guessField(model, text));
    }
  });

  it('gives nothing from a model trained on nothing', () => {
    const empty = trainFieldModel([]);
    expect(guessField(empty, { title: 'მზარეული', employer: null, description: null })).toBeNull();
  });
});

describe('features', () => {
  it('weighs title, employer and description words apart, each counted once', () => {
    const f = features({
      title: 'მზარეული მზარეული',
      employer: 'შპს ხინკალი',
      description: 'მზარეული',
    });
    expect([...f.keys()].sort()).toEqual(['d:მზარეულ', 'e:ხინკალ', 't:მზარეულ'].sort());
    expect(f.get('t:მზარეულ')).toBeGreaterThan(f.get('d:მზარეულ') ?? 0);
  });

  it('drops digits and one-letter words', () => {
    expect([
      ...features({ title: '2 x მძღოლი 2026', employer: null, description: null }).keys(),
    ]).toEqual(['t:მძღოლ']);
  });
});

describe('employerKey', () => {
  it('drops legal forms and case, so one employer is one feature', () => {
    expect(employerKey('შპს „ხინკალი"')).toBe(employerKey('ხინკალი'));
    expect(employerKey('Acme LLC')).toBe(employerKey('acme'));
    expect(employerKey('შპს')).toBeNull();
    expect(employerKey(null)).toBeNull();
  });
});
