import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  listingClassifications,
  opportunities,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
  taxonomyTerms,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import type { OpportunityType } from '../domain/opportunity.js';
import {
  assembleIndex,
  type IndexRow,
  loadBrowseIndex,
  loadPublicBrowseIndex,
  parseSalary,
} from './browse-index.js';

const row = (over: Partial<IndexRow> = {}): IndexRow => ({
  opportunityId: 'o1',
  type: 'job',
  canonicalTitle: null,
  canonicalStatus: null,
  sourceListingId: 'l1',
  sourceSlug: 'hr-ge',
  status: 'active',
  title: 'გამყიდველი',
  organization: 'შპს ტესტი',
  url: 'https://www.hr.ge/announcement/1',
  deadlineAt: '2026-12-01T19:59:59.000Z',
  firstSeenAt: '2026-11-10T08:00:00.000Z',
  hay: 'გამყიდველი შპს ტესტი',
  locations: ['თბილისი'],
  salaryRaw: null,
  facts: {},
  guessedField: null,
  readCities: [],
  ...over,
});

describe('parseSalary', () => {
  it('reads hr.ge salary text', () => {
    expect(parseSalary('1500-?')).toEqual([1500, null]);
    expect(parseSalary('1500-2000')).toEqual([1500, 2000]);
    expect(parseSalary('?-2000')).toEqual([null, 2000]);
  });

  it('states nothing for anything else', () => {
    expect(parseSalary(null)).toBeNull();
    expect(parseSalary('?-?')).toBeNull();
    expect(parseSalary('negotiable')).toBeNull();
  });
});

describe('assembleIndex', () => {
  it('merges a cross-posted vacancy: facts from the board that states them, dates from all', () => {
    const [item] = assembleIndex([
      row({
        sourceListingId: 'b',
        salaryRaw: '1500-2000',
        facts: {
          spec: ['გაყიდვები'],
          sen: ['საწყისი რგოლი'],
          lang: ['ქართული'],
          lic: [],
          ben: ['ჯანმრთელობის დაზღვევა'],
          bonus: false,
          stud: true,
          emp: 'ვადიანი კონტრაქტი',
        },
      }),
      row({
        sourceListingId: 'a',
        sourceSlug: 'jobs-ge',
        locations: [],
        deadlineAt: '2026-12-02T19:59:59.000Z',
        firstSeenAt: '2026-11-08T08:00:00.000Z',
        organization: 'შპს ტესტი',
      }),
    ]);
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.kind).toBe('job');
    expect(item.boards).toEqual(['hr-ge', 'jobs-ge']);
    expect(item.orgs).toEqual(['შპს ტესტი']);
    expect(item.members.map((m) => m.sourceListingId)).toEqual(['a', 'b']);
    // Public title: the first member by listing id.
    expect(item.title).toBe('გამყიდველი');
    expect(item.firstSeenAt).toBe('2026-11-08T08:00:00.000Z');
    expect(item.deadlineAt).toBe('2026-12-02T19:59:59.000Z');
    expect(item.deadlinesDisagree).toBe(true);
    expect(item.places).toEqual(['g:თბილისი']);
    expect(item.fields).toEqual(['j:გაყიდვები']);
    expect(item.salary).toEqual([1500, 2000]);
    expect(item.languages).toEqual(['ქართული']);
    expect(item.licences).toEqual([]);
    expect(item.students).toBe(true);
    expect(item.contract).toBe('ვადიანი კონტრაქტი');
    expect(item.hay.split('\n')).toHaveLength(2);
  });

  it('leaves the hr.ge facts unstated for a jobs.ge-only vacancy', () => {
    const [item] = assembleIndex([row({ sourceSlug: 'jobs-ge', locations: [] })]);
    expect(item?.languages).toBeNull();
    expect(item?.licences).toBeNull();
    expect(item?.benefits).toBeNull();
    expect(item?.bonus).toBeNull();
    expect(item?.places).toEqual([]);
    expect(item?.salary).toBeNull();
  });

  it('takes a guessed field only when no member states one, and marks it a guess', () => {
    const [alone] = assembleIndex([row({ sourceSlug: 'jobs-ge', guessedField: 'გაყიდვები' })]);
    expect(alone?.fields).toEqual(['j:გაყიდვები']);
    expect(alone?.fieldGuessed).toBe(true);

    const [stated] = assembleIndex([
      row({ sourceSlug: 'jobs-ge', sourceListingId: 'l1', guessedField: 'საბანკო' }),
      row({
        sourceSlug: 'hr-ge',
        sourceListingId: 'l2',
        facts: { spec: ['გაყიდვები'] },
      }),
    ]);
    expect(stated?.fields).toEqual(['j:გაყიდვები']);
    expect(stated?.fieldGuessed).toBe(false);

    const [none] = assembleIndex([row({ sourceSlug: 'jobs-ge' })]);
    expect(none?.fields).toEqual([]);
    expect(none?.fieldGuessed).toBe(false);
  });

  it('takes read cities only when no member states one, and marks them read', () => {
    const [alone] = assembleIndex([
      row({ sourceSlug: 'jobs-ge', locations: [], readCities: ['ბათუმი', 'ქუთაისი'] }),
    ]);
    expect(alone?.cities).toEqual(['ბათუმი', 'ქუთაისი']);
    expect(alone?.places).toEqual(['g:ბათუმი', 'g:ქუთაისი']);
    expect(alone?.citiesRead).toBe(true);

    const [stated] = assembleIndex([
      row({ sourceSlug: 'jobs-ge', sourceListingId: 'l1', locations: [], readCities: ['ბათუმი'] }),
      row({ sourceSlug: 'hr-ge', sourceListingId: 'l2', locations: ['თბილისი'] }),
    ]);
    expect(stated?.cities).toEqual(['თბილისი']);
    expect(stated?.citiesRead).toBe(false);
  });

  it('reads a tender: CPV divisions, procedure, value in lari', () => {
    const [item] = assembleIndex([
      row({
        type: 'tender',
        sourceSlug: 'etenders-ge',
        facts: {
          cpv: [
            { code: '22100000', label: 'ნაბეჭდი წიგნები' },
            { code: '79800000', label: 'ბეჭდვა' },
          ],
          method: 'ტენდერი ერთი კონვერტის პრინციპით',
          subm: 'platform',
          maxValue: { amount: 1000, currency: 'USD', vat: 'excluded' },
          num: '69689',
        },
      }),
    ]);
    expect(item?.kind).toBe('tender');
    expect(item?.fields).toEqual(['t:22', 't:79']);
    expect(item?.cpvLabel).toBe('ნაბეჭდი წიგნები');
    expect(item?.value).toEqual({ amount: 1000, currency: 'USD', vat: 'excluded' });
    expect(item?.valueGel).toBeCloseTo(2593.4, 1);
    expect(item?.tenderNumber).toBe('69689');
  });

  it('reads a course: country, dates, fee in euros, credits, teaching languages', () => {
    const [item] = assembleIndex([
      row({
        type: 'summer_school',
        sourceSlug: 'summerschoolsineurope-eu',
        locations: ['Pisa, Italy'],
        facts: {
          country: 'Italy',
          city: 'Pisa',
          format: 'online',
          start: '2027-06-07',
          end: '2027-06-11',
          days: 5,
          disc: ['Natural Sciences'],
          fee: { amount: 500, currency: 'GBP', raw: '500 GBP' },
          credits: { unit: 'EC', amount: 3 },
          clang: 'English, German',
        },
      }),
    ]);
    expect(item?.kind).toBe('course');
    expect(item?.places).toEqual(['c:Italy']);
    expect(item?.cities).toEqual([]);
    expect(item?.online).toBe(true);
    expect(item?.fields).toEqual(['c:Natural Sciences']);
    expect(item?.feeEur).toBeCloseTo(598.4, 1);
    expect(item?.credits).toBe(3);
    expect(item?.teaching).toEqual(['English', 'German']);
  });

  it('never guesses a currency the reference table lacks', () => {
    const [item] = assembleIndex([
      row({
        type: 'summer_school',
        sourceSlug: 'summerschoolsineurope-eu',
        facts: { fee: { amount: 900, currency: 'PLN' } },
      }),
    ]);
    expect(item?.fee).toEqual({ amount: 900, currency: 'PLN' });
    expect(item?.feeEur).toBeNull();
  });

  it('gives a programme kind with no Browse kind no kind (it shows under All)', () => {
    const [item] = assembleIndex([row({ type: 'scholarship' })]);
    expect(item?.kind).toBeNull();
  });
});

describe('the loaders', () => {
  const sourceIds: string[] = [];
  const listingIds: string[] = [];
  const opportunityIds: string[] = [];
  const termIds: string[] = [];
  let lastRevisionId = '';

  async function add(spec: {
    title: string;
    type?: OpportunityType;
    status?: 'active' | 'quarantined';
    attributes?: Record<string, unknown>;
    locations?: string[];
    salaryRaw?: string | null;
    opportunityId?: string;
  }) {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId, {
      status: spec.status ?? 'active',
      sourceDeadlineAt: '2099-12-01T00:00:00Z',
      firstSeenAt: '2026-09-01T00:00:00Z',
      lastSeenAt: '2026-09-01T00:00:00Z',
    });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listing.id,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: spec.title,
      titleNormalized: spec.title.toLowerCase(),
      organizationRaw: 'Browse Index Test Org',
      description: 'text',
      locations: spec.locations ?? [],
      salaryRaw: spec.salaryRaw ?? null,
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: '2099-12-01T00:00:00Z' },
      applicationMethod: { type: 'email', value: 'apply@example.invalid' },
      sourceCategories: [],
      structuredAttributes: spec.attributes ?? {},
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listing.id));
    listingIds.push(listing.id);
    lastRevisionId = revisionId;
    let opportunityId = spec.opportunityId;
    if (opportunityId === undefined) {
      opportunityId = randomUUID();
      opportunityIds.push(opportunityId);
      await db.insert(opportunities).values({
        id: opportunityId,
        type: spec.type ?? 'job',
        canonicalTitle: spec.title,
        organizationId: null,
        canonicalStatus: 'active',
        currentCanonicalRevisionId: null,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      });
    }
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listing.id,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: '2026-09-01T00:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
    return opportunityId;
  }

  afterEach(async () => {
    if (listingIds.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      listingIds.length = 0;
    }
    if (opportunityIds.length > 0) {
      await db.delete(opportunities).where(inArray(opportunities.id, opportunityIds));
      opportunityIds.length = 0;
    }
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
    if (termIds.length > 0) {
      await db.delete(taxonomyTerms).where(inArray(taxonomyTerms.id, termIds.splice(0)));
    }
  });

  const hrAttributes = {
    specialty: [{ code: '739', name: 'გაყიდვები', children: [{ name: 'კონსულტაცია' }] }],
    industry: [{ code: null, name: 'საცალო ვაჭრობა', children: [] }],
    languages: ['ქართული'],
    seniorityLevels: ['საწყისი რგოლი'],
    educationLevels: ['საშუალო განათლება'],
    drivingLicenses: [],
    benefits: [],
    isWithBonus: false,
    isSuitableForStudent: false,
    employmentTypeName: 'ვადიანი კონტრაქტი',
    workScheduleName: 'სრული განაკვეთი',
    employmentFormTypeName: 'საველე',
    documents: [{ name: 'not read' }],
  };

  it('reads the facts both surfaces filter on, and only the field names of hr.ge trees', async () => {
    const id = await add({
      title: `Browse index ${randomUUID().slice(0, 8)}`,
      attributes: hrAttributes,
      locations: ['თბილისი'],
      salaryRaw: '1500-?',
    });
    for (const load of [loadBrowseIndex, loadPublicBrowseIndex]) {
      const item = (await load(db)).find((i) => i.id === id);
      expect(item).toBeDefined();
      expect(item?.fields).toEqual(['j:გაყიდვები']);
      expect(item?.industries).toEqual(['საცალო ვაჭრობა']);
      expect(item?.salary).toEqual([1500, null]);
      expect(item?.places).toEqual(['g:თბილისი']);
      expect(item?.workplace).toBe('საველე');
      expect(item?.licences).toEqual([]);
      expect(item?.hay).toContain('Browse Index Test Org');
    }
  });

  it('reads a guessed field on both surfaces, and only a live keyword or human one', async () => {
    const label = `test-guess-${randomUUID().slice(0, 8)}`;
    const termId = randomUUID();
    termIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `profession-${label}`,
      label,
      taxonomyVersion: 'v1',
      parentId: null,
    });
    const classify = (
      revisionId: string,
      over: { method?: 'keyword' | 'deterministic_rule'; supersededAt?: string } = {},
    ) =>
      db.insert(listingClassifications).values({
        id: randomUUID(),
        sourceListingRevisionId: revisionId,
        taxonomyTermId: termId,
        axis: 'profession',
        method: over.method ?? 'keyword',
        confidence: 0.9,
        evidence: {},
        taxonomyVersion: 'v1',
        createdAt: '2026-11-14T00:00:00Z',
        supersededAt: over.supersededAt ?? null,
      });

    const guessed = await add({ title: `Guessed ${randomUUID().slice(0, 8)}` });
    await classify(lastRevisionId);
    const retired = await add({ title: `Retired ${randomUUID().slice(0, 8)}` });
    await classify(lastRevisionId, { supersededAt: '2026-11-14T01:00:00Z' });
    const rule = await add({ title: `Rule ${randomUUID().slice(0, 8)}` });
    await classify(lastRevisionId, { method: 'deterministic_rule' });

    for (const load of [loadBrowseIndex, loadPublicBrowseIndex]) {
      const items = await load(db);
      const item = items.find((i) => i.id === guessed);
      expect(item?.fields).toEqual([`j:${label}`]);
      expect(item?.fieldGuessed).toBe(true);
      for (const id of [retired, rule]) {
        expect(items.find((i) => i.id === id)?.fields).toEqual([]);
      }
    }
  });

  it('reads the places named in a listing text on both surfaces, in order', async () => {
    const names = [
      `test-north-${randomUUID().slice(0, 6)}`,
      `test-south-${randomUUID().slice(0, 6)}`,
    ];
    const ids = names.map(() => randomUUID());
    termIds.push(...ids);
    for (const [i, name] of names.entries()) {
      await db.insert(taxonomyTerms).values({
        id: ids[i] as string,
        axis: 'location',
        code: `location-${name}`,
        label: name,
        taxonomyVersion: 'v1',
        parentId: null,
      });
    }
    const id = await add({ title: `Read ${randomUUID().slice(0, 8)}`, locations: [] });
    // Written second-first, so only `order` puts them right.
    for (const order of [1, 0]) {
      await db.insert(listingClassifications).values({
        id: randomUUID(),
        sourceListingRevisionId: lastRevisionId,
        taxonomyTermId: ids[order] as string,
        axis: 'location',
        method: 'keyword',
        confidence: 1,
        evidence: { order },
        taxonomyVersion: 'v1',
        createdAt: '2026-11-14T00:00:00Z',
      });
    }
    for (const load of [loadBrowseIndex, loadPublicBrowseIndex]) {
      const item = (await load(db)).find((i) => i.id === id);
      expect(item?.cities).toEqual(names);
      expect(item?.citiesRead).toBe(true);
    }
  });

  it('keeps a quarantined member out of the public index and its title', async () => {
    const title = `Browse visible ${randomUUID().slice(0, 8)}`;
    const id = await add({ title });
    await add({
      title: `Browse hidden ${randomUUID().slice(0, 8)}`,
      status: 'quarantined',
      opportunityId: id,
    });
    const pub = (await loadPublicBrowseIndex(db)).find((i) => i.id === id);
    expect(pub?.members).toHaveLength(1);
    expect(pub?.title).toBe(title);
    const local = (await loadBrowseIndex(db)).find((i) => i.id === id);
    expect(local?.members).toHaveLength(2);
  });
});
