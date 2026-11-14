import { describe, expect, it } from 'vitest';
import { BROWSE_CHUNK, emptyForm, formHref, formSearch } from '../../src/browse/browse-form.js';
import { parseBrowseQuery } from './browse-params.js';

const parse = (query: string, surface: 'local' | 'public' = 'local') =>
  parseBrowseQuery(
    Object.fromEntries(
      [...new URLSearchParams(query).keys()].map((k) => [k, new URLSearchParams(query).getAll(k)]),
    ),
    surface,
  );

describe('parseBrowseQuery', () => {
  it('reads every filter and writes the same address back', () => {
    const query =
      'kind=job&q=%E1%83%92&field=j%3A%E1%83%92%E1%83%90&place=g%3A%E1%83%91%E1%83%90&sen=x&lang=y&ben=z&wf=w&sched=s&emp=e&ind=i&edu=b&smin=1500&smax=3000&bonus=1&nolic=1&stud=1&closing=7&since=3&board=hr-ge&cross=1&status=active&keep=salary&sort=salary&show=80';
    const form = parse(query);
    expect(form.kind).toBe('job');
    expect(form.salary).toEqual({ min: 1500, max: 3000 });
    expect(form.keep).toEqual(['salary']);
    expect(form.show).toBe(80);
    expect(parse(formSearch(form))).toEqual(form);
  });

  it('keeps older addresses working', () => {
    expect(parse('source=jobs-ge').board).toEqual(['jobs-ge']);
    expect(parse('type=tender').kind).toBe('tender');
    expect(parse('type=summer_school').kind).toBe('course');
    // The landing page's "vacancies and tenders": no one kind, so a filter of its own.
    const both = parse('type=job&type=tender&status=active&closing=7');
    expect(both.kind).toBe('');
    expect(both.types).toEqual(['job', 'tender']);
    expect(both.status).toEqual(['active']);
    expect(both.closing).toBe('7');
    expect(parse('sort=deadline').sort).toBe('deadline');
  });

  it('drops what is not on its list', () => {
    const form = parse(
      'kind=boat&closing=5&since=x&online=maybe&subm=fax&dur=w9&ects=lots&status=nope&starts=2027-13&place=x&field=q:1&board=Bad%20Board&smin=-3&type=house&sort=price',
    );
    expect(form).toEqual(emptyForm());
  });

  it('drops filters the kind does not offer, and state on the public site', () => {
    const tender = parse('kind=tender&smin=1500&place=g:x&field=j:a&field=t:45&keep=salary');
    expect(tender.salary).toEqual({ min: null, max: null });
    expect(tender.place).toEqual([]);
    expect(tender.field).toEqual(['t:45']);
    expect(tender.keep).toEqual([]);
    expect(parse('status=active', 'public').status).toEqual([]);
  });

  it('keeps a "keep" only for a set filter on a stated fact', () => {
    expect(parse('kind=job&keep=salary').keep).toEqual([]);
    expect(parse('kind=job&smin=1&keep=salary&keep=salary&keep=board').keep).toEqual(['salary']);
  });

  it('reads a backwards range as the same span', () => {
    expect(parse('kind=course&fmin=900&fmax=100').fee).toEqual({ min: 100, max: 900 });
  });

  it('rounds the depth up to a whole chunk', () => {
    expect(parse('show=41').show).toBe(BROWSE_CHUNK * 2);
    expect(parse('show=abc').show).toBe(BROWSE_CHUNK);
  });

  it('caps a list a hand-made address makes long', () => {
    const many = Array.from({ length: 100 }, (_, i) => `org=o${i}`).join('&');
    expect(parse(many).org).toHaveLength(40);
  });
});

describe('formHref', () => {
  it('gives one address per choice: lists sorted, defaults left out', () => {
    expect(formHref(emptyForm())).toBe('/opportunities');
    const a = formHref({ ...emptyForm(), board: ['jobs-ge', 'hr-ge'] });
    const b = formHref({ ...emptyForm(), board: ['hr-ge', 'jobs-ge'] });
    expect(a).toBe(b);
    expect(a).toBe('/opportunities?board=hr-ge&board=jobs-ge');
  });
});
