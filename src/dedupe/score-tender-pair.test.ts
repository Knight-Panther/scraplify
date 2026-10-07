import { describe, expect, it } from 'vitest';
import type { ListingForScoring } from './score-pair.js';
import { scoreTenderPair, tenderSubject } from './score-tender-pair.js';

/**
 * Golden pairs and hard negatives for tender dedupe (docs/addEtender.md §11,
 * §14.6): the same procurements as etenders.ge (ET), hr.ge (HR) and jobs.ge
 * (JOBS) stored them, 2026-10-07. Titles, buyers and instants are verbatim;
 * application contacts are left out because the scorer does not read them.
 * jobs.ge stores a closing day as Tbilisi midnight, i.e. 20:00 UTC the day
 * before, which is why deadlines are compared as Tbilisi calendar days.
 */

let nextId = 0;
function listing(
  source: 'ET' | 'HR' | 'JOBS',
  organizationRaw: string,
  publishedAt: string,
  deadlineAt: string,
  titleRaw: string,
): ListingForScoring {
  nextId++;
  return {
    sourceId: source,
    sourceListingId: `${source}-${nextId}`,
    titleRaw,
    organizationRaw,
    applicationType: null,
    applicationValue: null,
    publishedAt,
    deadlineAt,
  };
}

const AVERSI_CLINIC_ET = 'შპს "ავერსის კლინიკა"';
const AVERSI_CLINIC = 'ავერსის კლინიკა';

const ET = {
  carts: listing(
    'ET',
    AVERSI_CLINIC_ET,
    '2026-09-28T12:51:00Z',
    '2026-10-15T11:00:00Z',
    'საოპერაციო ბლოკის მობილური კომპიუტერული ურიკები',
  ),
  gynecologicalChairs: listing(
    'ET',
    AVERSI_CLINIC_ET,
    '2026-10-05T09:30:00Z',
    '2026-10-15T11:00:00Z',
    'შპს „ავერსის კლინიკა“ აცხადებს ტენდერს გინეკოლოგიური სავარძლების შესყიდვის თაობაზე',
  ),
  bScan: listing(
    'ET',
    AVERSI_CLINIC_ET,
    '2026-09-25T05:03:00Z',
    '2026-10-07T11:00:00Z',
    'შპს „ავერსის კლინიკა“ აცხადებს ტენდერს თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის (B სკანი) შესყიდვის თაობაზე',
  ),
  hvac: listing(
    'ET',
    AVERSI_CLINIC_ET,
    '2026-09-25T05:08:00Z',
    '2026-10-05T11:00:00Z',
    'შპს „ავერსის კლინიკა“ აცხადებს ტენდერს გათბობა-გაგრილებისა და ვენტილაციის სისტემების მოწყობის სამუშაოების შესყიდვის თაობაზე',
  ),
  fireDetection: listing(
    'ET',
    'ს.ს. ლომისი',
    '2026-09-09T14:00:00Z',
    '2026-09-23T14:00:00Z',
    'ტენდერი შენობა-ნაგებობაში სახანძრო დეტექციისა და განგაშის სისტემის მოწყობაზე',
  ),
  accessControl: listing(
    'ET',
    'ს.ს. ლომისი',
    '2026-09-18T08:35:00Z',
    '2026-10-02T14:00:00Z',
    'ტენდერი Access Control სისტემის Fire Alarm სისტემასთან სინქრონიზაციაზე',
  ),
  generators: listing(
    'ET',
    'შპს ავერსი–ფარმა',
    '2026-09-08T10:09:00Z',
    '2026-09-18T12:00:00Z',
    'გენერატორების შესყიდვა',
  ),
  undpTransport: listing(
    'ET',
    'UNDP',
    '2026-09-29T08:33:00Z',
    '2026-10-13T11:00:00Z',
    'Transportation Services for UN Personnel',
  ),
  unicefPrinting: listing(
    'ET',
    'UNICEF',
    '2026-09-10T10:01:00Z',
    '2026-09-30T14:00:00Z',
    'Long Term Arrangement (LTA) for the Provision of Printing Services',
  ),
  unicefStationery: listing(
    'ET',
    'UNICEF',
    '2026-09-09T14:17:00Z',
    '2026-09-30T14:00:00Z',
    'Long Term Arrangement (LTA) for Office Stationery Items',
  ),
  tradelineRerun: listing(
    'ET',
    'შპს. თრეიდლაინ',
    '2026-09-25T09:00:00Z',
    '2026-10-09T10:00:00Z',
    'ტენდერი DR0018/09/26 – POSM - შიდა საკომუნიაკაციო მასალების დამზადებაზე',
  ),
};

const BOARDS = {
  hrCarts: listing(
    'HR',
    AVERSI_CLINIC,
    '2026-10-01T09:48:53Z',
    '2026-10-15T15:59:00Z',
    'ტენდერი - საოპერაციო ბლოკისთვის მობილური კომპიუტერული ურიკების შესყიდვის თაობაზე',
  ),
  jobsCarts: listing(
    'JOBS',
    AVERSI_CLINIC,
    '2026-09-30T20:00:00Z',
    '2026-10-14T20:00:00Z',
    'ტენდერი - მობილური კომპიუტერული ურიკების შესყიდვა',
  ),
  hrBScan: listing(
    'HR',
    AVERSI_CLINIC,
    '2026-09-28T13:46:49Z',
    '2026-10-07T15:59:00Z',
    'ტენდერი თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის (B სკანი) შესყიდვის თაობაზე',
  ),
  jobsBScan: listing(
    'JOBS',
    AVERSI_CLINIC,
    '2026-09-27T20:00:00Z',
    '2026-10-06T20:00:00Z',
    'ტენდერი: თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის შესყიდვა',
  ),
  hrHvac: listing(
    'HR',
    AVERSI_CLINIC,
    '2026-09-30T12:16:54Z',
    '2026-10-05T15:59:00Z',
    'ტენდერი - გათბობა-გაგრილებისა და ვენტილაციის სისტემების მოწყობის სამუშაოების შესყიდვის თაობაზე',
  ),
  jobsHvac: listing(
    'JOBS',
    AVERSI_CLINIC,
    '2026-09-29T20:00:00Z',
    '2026-10-04T20:00:00Z',
    'ტენდერი -გათბობა-გაგრილების სისტემების სამუშაოების  შესყიდვა',
  ),
  jobsFireDetection: listing(
    'JOBS',
    'ლომისი - ლუდსახარში ნატახტარი',
    '2026-09-08T20:00:00Z',
    '2026-09-25T20:00:00Z',
    'ტენდერი - შენობა-ნაგებობაში სახანძრო სისტემის მოწყობა',
  ),
  jobsAccessControl: listing(
    'JOBS',
    'ლომისი - ლუდსახარში ნატახტარი',
    '2026-09-17T20:00:00Z',
    '2026-10-01T20:00:00Z',
    'Access Control სისტემის Fire Alarm სისტემასთან სინქრონიზაცია',
  ),
  hrGenerators: listing(
    'HR',
    'ავერსი ფარმა',
    '2026-09-09T06:17:50Z',
    '2026-09-18T15:59:00Z',
    'ტენდერი - გენერატორების შესყიდვის თაობაზე',
  ),
  jobsUndpTransport: listing(
    'JOBS',
    'გაეროს განვითარების პროგრამა',
    '2026-09-28T20:00:00Z',
    '2026-10-05T20:00:00Z',
    'ტენდერი სატრანსპორტო მომსახურების გაწევაზე',
  ),
  hrUnicefPrinting: listing(
    'HR',
    'Unicef',
    '2026-09-10T07:17:44Z',
    '2026-09-30T19:59:00Z',
    'ტენდერი - გრძელვადიანი შეთანხმება საბეჭდი მომსახურების გაწევის თაობაზე',
  ),
  hrTaxi: listing(
    'HR',
    'World Vision',
    '2026-10-02T11:59:42Z',
    '2026-10-16T15:59:00Z',
    'ტენდერი - ტაქსით მომსახურება 2026–2029',
  ),
  jobsTaxi: listing(
    'JOBS',
    'World Vision',
    '2026-10-01T20:00:00Z',
    '2026-10-15T20:00:00Z',
    'შერჩევა - ტაქსით მომსახურების მომწოდებელი',
  ),
  hrPrintingOtherBuyer: listing(
    'HR',
    'World Vision',
    '2026-09-08T06:41:34Z',
    '2026-09-30T19:59:00Z',
    'ტენდერი - ბეჭდვითი მომსახურება',
  ),
};

describe('tender pair scoring', () => {
  it.each([
    ['ET carts ~ HR carts', ET.carts, BOARDS.hrCarts],
    ['ET carts ~ JOBS carts', ET.carts, BOARDS.jobsCarts],
    ['HR carts ~ JOBS carts', BOARDS.hrCarts, BOARDS.jobsCarts],
    ['ET B-scan ~ HR B-scan', ET.bScan, BOARDS.hrBScan],
    ['ET B-scan ~ JOBS B-scan', ET.bScan, BOARDS.jobsBScan],
    ['ET HVAC ~ HR HVAC', ET.hvac, BOARDS.hrHvac],
    ['ET HVAC ~ JOBS HVAC', ET.hvac, BOARDS.jobsHvac],
    ['ET Lomisi access control ~ JOBS', ET.accessControl, BOARDS.jobsAccessControl],
    ['ET Aversi Pharma generators ~ HR', ET.generators, BOARDS.hrGenerators],
    ['HR World Vision taxi ~ JOBS', BOARDS.hrTaxi, BOARDS.jobsTaxi],
  ])('merges the golden pair %s', (_name, a, b) => {
    const score = scoreTenderPair(a, b);
    expect(score.decision).toBe('confirmed_same');
    expect(score.signals.deadlineDayGap).toBe(0);
  });

  it.each([
    // The board post's own expiry, 3 days after the bid deadline.
    ['ET Lomisi fire detection ~ JOBS', ET.fireDetection, BOARDS.jobsFireDetection],
    // English on etenders.ge, Georgian on jobs.ge, and the board's expiry 7 days early.
    ['ET UNDP transport ~ JOBS', ET.undpTransport, BOARDS.jobsUndpTransport],
    // Right pair, but in two languages, so the subject cannot be checked.
    ['ET UNICEF printing ~ HR', ET.unicefPrinting, BOARDS.hrUnicefPrinting],
  ])('sends the near-miss golden pair %s to review', (_name, a, b) => {
    expect(scoreTenderPair(a, b).decision).toBe('needs_review');
  });

  it.each([
    // One buyer, one deadline day, different purchases.
    ['Aversi gynecological chairs ~ HR carts', ET.gynecologicalChairs, BOARDS.hrCarts],
    ['Aversi gynecological chairs ~ JOBS carts', ET.gynecologicalChairs, BOARDS.jobsCarts],
    ['Aversi B-scan ~ HR HVAC', ET.bScan, BOARDS.hrHvac],
    ['Aversi carts ~ JOBS B-scan', ET.carts, BOARDS.jobsBScan],
    ['Lomisi fire detection ~ JOBS access control', ET.fireDetection, BOARDS.jobsAccessControl],
    ['Lomisi access control ~ JOBS fire detection', ET.accessControl, BOARDS.jobsFireDetection],
    // Two companies of one group.
    ['Aversi Pharma generators ~ Aversi Clinic B-scan', ET.generators, BOARDS.hrBScan],
    // Same subject, same deadline, different buyer.
    ['UNICEF printing ~ World Vision printing', ET.unicefPrinting, BOARDS.hrPrintingOtherBuyer],
  ])('keeps the hard negative %s apart', (_name, a, b) => {
    expect(scoreTenderPair(a, b).decision).toBe('distinct');
  });

  it('never merges a wrong pair in two languages, even on the same deadline day', () => {
    const score = scoreTenderPair(ET.unicefStationery, BOARDS.hrUnicefPrinting);
    expect(score.signals.deadlineDayGap).toBe(0);
    expect(score.decision).not.toBe('confirmed_same');
  });

  it('keeps two postings on one site apart, as for vacancies', () => {
    expect(scoreTenderPair(ET.carts, ET.gynecologicalChairs).decision).toBe('distinct');
  });

  it('separates tenders whose reference codes differ, and merges on an equal code', () => {
    // The same buyer posting a different procedure on the same days.
    const sameBuyerPost = listing(
      'HR',
      'შპს თრეიდლაინ',
      ET.tradelineRerun.publishedAt ?? '',
      ET.tradelineRerun.deadlineAt ?? '',
      'ტენდერი DR0019/10/02 – POSM მასალების დამზადება',
    );
    expect(scoreTenderPair(ET.tradelineRerun, sameBuyerPost).signals.referenceCodes).toBe(
      'different',
    );
    expect(scoreTenderPair(ET.tradelineRerun, sameBuyerPost).decision).toBe('distinct');

    const sameCodePost = { ...sameBuyerPost, titleRaw: 'ტენდერი DR0018/09/26 POSM' };
    const score = scoreTenderPair(ET.tradelineRerun, sameCodePost);
    expect(score.signals.referenceCodes).toBe('same');
    expect(score.decision).toBe('confirmed_same');
  });

  it('compares subjects without the tender wording and the announcing buyer', () => {
    expect(tenderSubject(ET.bScan.titleRaw)).toBe(
      'თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის b სკანი',
    );
    expect(tenderSubject(BOARDS.jobsBScan.titleRaw)).toBe(
      'თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის',
    );
  });

  it('does not let a one-word subject merge by containment alone', () => {
    const vague = { ...BOARDS.hrCarts, titleRaw: 'ტენდერი - ურიკები' };
    const score = scoreTenderPair(ET.carts, vague);
    expect(score.signals.titleContainment).toBeGreaterThan(0.5);
    expect(score.decision).not.toBe('confirmed_same');
  });
});
