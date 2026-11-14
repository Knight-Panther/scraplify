import { describe, expect, it } from 'vitest';
import { cityReader, readCities } from './city-read.js';

const PLACES = [
  'თბილისი',
  'ბათუმი',
  'ქუთაისი',
  'გორი',
  'ქედის მუნიციპალიტეტი',
  'ონი',
  'საზღვარგარეთ',
  'საქართველოს მაშტაბით',
  'თბილისის შემოგარენი',
];
const LATIN = new Map([
  ['თბილისი', 'Tbilisi'],
  ['ბათუმი', 'Batumi'],
  ['ქუთაისი', 'Kutaisi'],
]);
const reader = cityReader(PLACES, LATIN);
const read = (title: string, description: string | null = null, limit?: number) =>
  readCities(reader, { title, description }, limit);

describe('readCities', () => {
  it.each([
    ['ოფისი მდებარეობს თბილისში', ['თბილისი']],
    ['სამუშაო ადგილი: ქ. ბათუმი', ['ბათუმი']],
    ['ქუთაისის ფილიალისთვის', ['ქუთაისი']],
    ['თბილისიდან გორში მიტანა', ['თბილისი', 'გორი']],
    ['Office in Batumi', ['ბათუმი']],
    ['ქედის მუნიციპალიტეტში', ['ქედის მუნიციპალიტეტი']],
  ])('reads %s', (text, expected) => {
    expect(read('ვაკანსია', text)).toEqual(expected);
  });

  it('reads the title as well as the text, in the order named', () => {
    expect(read('მოლარე ბათუმში', 'ასევე თბილისში')).toEqual(['ბათუმი', 'თბილისი']);
  });

  it('reads nothing where no place is named', () => {
    expect(read('გაყიდვების მენეჯერი', 'გამოცდილება 2 წელი')).toEqual([]);
    expect(read('', null)).toEqual([]);
  });

  it('skips a street or a university named after a city', () => {
    expect(read('ვაკანსია', 'მისამართი: ქუთაისის ქუჩა 5')).toEqual([]);
    expect(read('ვაკანსია', 'თბილისის სახელმწიფო უნივერსიტეტის კურსდამთავრებული')).toEqual([]);
    expect(read('ვაკანსია', 'Kutaisi street 12')).toEqual([]);
  });

  it('never reads abroad, nationwide or a too-short name', () => {
    const r = cityReader([...PLACES, 'აბ'], LATIN);
    expect([...r.byStem.values()]).not.toContain('საზღვარგარეთ');
    expect([...r.byStem.values()]).not.toContain('საქართველოს მაშტაბით');
    expect([...r.byStem.values()]).not.toContain('აბ');
    expect(read('ვაკანსია', 'საზღვარგარეთ და საქართველოს მაშტაბით')).toEqual([]);
  });

  it('reads nothing from a list of more places than the limit', () => {
    const text = 'ფილიალები: თბილისი, ბათუმი, ქუთაისი, გორი';
    expect(read('ვაკანსია', text)).toEqual([]);
    expect(read('ვაკანსია', text, 4)).toEqual(['თბილისი', 'ბათუმი', 'ქუთაისი', 'გორი']);
  });

  it('gives a stem two places share to the one listed first', () => {
    const r = cityReader(['ბათუმი', 'ბათუმი-2'], new Map());
    expect(readCities(r, { title: 'ბათუმში', description: null })).toEqual(['ბათუმი']);
  });
});
