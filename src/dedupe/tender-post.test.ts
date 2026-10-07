import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { etendersGeSource } from '../policies/etenders-ge.js';
import {
  descriptionAnnouncesTender,
  hasJobRoleWord,
  isTenderPostTitle,
  opportunityTypeForListing,
} from './tender-post.js';

// Titles as jobs.ge and hr.ge published them (real corpus, 2026-10-07). The
// positives are every tender post the detector finds in the 14,655 job-board
// listings; the negatives are the role titles closest to them in wording.

const TENDER_POST_TITLES = [
  'ტენდერი - საწვავის მომწოდებელი',
  'ტენდერი - ბეჭდვითი მომსახურება',
  'ტენდერი - გენერატორების შესყიდვის თაობაზე',
  'ტენდერი - საოფისე საკანცელარიო ნივთების გრძელვადიანი შეთანხმება',
  'ტენდერი - გრძელვადიანი შეთანხმება საბეჭდი მომსახურების გაწევის თაობაზე',
  'ტენდერი პრემიუმ კლასის საახალწლო სასაჩუქრე ბოქსების შესყიდვაზე',
  'ტენდერი თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის (B სკანი) შესყიდვის თაობაზე',
  'ტენდერი - წინასწარი კვალიფიკაცია და შერჩევა — სატრანსპორტო საშუალებების სერვის-მომსახურების პროვაიდერები',
  'ტენდერი - გათბობა-გაგრილებისა და ვენტილაციის სისტემების მოწყობის სამუშაოების შესყიდვის თაობაზე',
  'ტენდერი - საოპერაციო ბლოკისთვის მობილური კომპიუტერული ურიკების შესყიდვის თაობაზე',
  'ტენდერი - ტაქსით მომსახურება 2026–2029',
  'ტენდერი სამასი ერთეული შრედერის შეძენაზე',
  'ტენდერი სასტუმრო საკონფერენციო მომსახურების შესყიდვაზე',
  'ღვინის ფორუმისთვის ღონისძიებების მართვის მომსახურების გაწევა',
  'ტენდერი - შენობა-ნაგებობაში სახანძრო სისტემის მოწყობა',
  'ტენდერი მაღაზიის მეორადი მაცივრების გაყიდვაზე',
  'ტენდერი მაღაზიის მეორადი თაროების გაყიდვაზე',
  'ტენდერი სარემონტო სამუშაოს მომსახურების შესყიდვაზე',
  'ტენდერი: თვალის ულტრაბგერითი სადიაგნოსტიკო აპარატის შესყიდვა',
  'ტენდერი სატრანსპორტო მომსახურების გაწევაზე',
  'ტენ. შშმ პირებისთვის პანდუსის მოწყობის სამუშაოების შესრულება',
  'ტენდერი -გათბობა-გაგრილების სისტემების სამუშაოების  შესყიდვა',
  'ტენდერი - მობილური კომპიუტერული ურიკების შესყიდვა',
  'შერჩევა - ტაქსით მომსახურების მომწოდებელი',
  // English and etenders.ge-style wordings the boards may use.
  'Tender for the Procurement of 85 Generators',
  'RFQ: 120kW Electric Boiler System and its Installation',
  'Request for Proposals: Mobile Application Development',
  'ფასთა გამოკითხვა ბრენდირებული საკანცელარიო ნივთების შესყიდვაზე',
  'ინტერესთა გამოხატვა ოფისების დასუფთავების მომსახურებაზე',
];

const VACANCY_TITLES = [
  'ტენდერების მენეჯერი',
  'კორპორატიული პროექტებისა და ტენდერების მენეჯერი',
  'ბიზნესის განვითარებისა და სატენდერო პროექტების მენეჯერი',
  'შესყიდვების მენეჯერი',
  'შესყიდვების სპეციალისტი',
  'საერთაშორისო შესყიდვების სპეციალისტი',
  'შესყიდვების სამსახურის მთავარი სპეციალისტი',
  'სტაჟირება შესყიდვების დეპარტამენტში',
  'მძღოლი შესყიდვების დეპარტამენტში',
  'ხარჯებისა და შესყიდვის ბუღალტერი',
  'მომწოდებლებთან კომუნიკაციის სპეციალისტი',
  'ნედლეულის მომწოდებელი / მეტალის დამჭრელი',
  'კონკურსი სტაჟიორის შესარჩევად',
  'ღია კონკურსი აკადემიური თანამდებობების დასაკავებლად',
  'ამერიკის ავტოაუქციონებზე შემსყიდველი პირი',
  'კორპორატიული გაყიდვების მენეჯერი',
  'გაყიდვების მენეჯერი',
  'Tender Manager',
  'Procurement Officer',
  'Head of Procurement for Retail',
  'Expression of Interest - National Consultant',
];

describe('tender-post detector', () => {
  it.each(TENDER_POST_TITLES)('reads %s as a tender post', (title) => {
    expect(isTenderPostTitle(title)).toBe(true);
  });

  it.each(VACANCY_TITLES)('reads %s as a vacancy', (title) => {
    expect(isTenderPostTitle(title)).toBe(false);
  });

  it('vetoes nominative role words only, so a tender for a specialist service stays a tender', () => {
    expect(hasJobRoleWord('ტენდერი - IT სპეციალისტის მომსახურების შესყიდვა')).toBe(false);
    expect(isTenderPostTitle('ტენდერი - IT სპეციალისტის მომსახურების შესყიდვა')).toBe(true);
    expect(hasJobRoleWord('IT სპეციალისტი')).toBe(true);
  });

  it('finds a tender announcement in a description', () => {
    expect(
      descriptionAnnouncesTender('ს.ს. „ლომისი“ აცხადებს ტენდერს Access Control სისტემის…'),
    ).toBe(true);
    // Job ads mention tender documents as a duty; that is not an announcement.
    expect(
      descriptionAnnouncesTender('სატენდერო დოკუმენტაციის მომზადება და ტენდერებში მონაწილეობა'),
    ).toBe(false);
    expect(descriptionAnnouncesTender(null)).toBe(false);
  });

  it('types listings by source, then title, then description', () => {
    const jobBoard = randomUUID();
    const type = (sourceId: string, title: string, descriptionAnnouncesTender = false) =>
      opportunityTypeForListing({ sourceId, title, descriptionAnnouncesTender });

    expect(type(etendersGeSource.id, 'შესყიდვების მენეჯერი')).toBe('tender');
    expect(type(jobBoard, 'ტენდერი - ბეჭდვითი მომსახურება')).toBe('tender');
    expect(
      type(jobBoard, 'Access Control სისტემის Fire Alarm სისტემასთან სინქრონიზაცია', true),
    ).toBe('tender');
    // A role title is a vacancy even when its description announces a tender.
    expect(type(jobBoard, 'ტენდერების მენეჯერი', true)).toBe('job');
    expect(type(jobBoard, 'Access Control სისტემის Fire Alarm სისტემასთან სინქრონიზაცია')).toBe(
      'job',
    );
  });
});
