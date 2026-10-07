import { describe, expect, it } from 'vitest';
import { buyerHeadWord, buyersMatch, normalizeBuyerName } from './tender-buyer.js';

// Buyer names as etenders.ge and the job boards wrote them (2026-10-07).

describe('tender buyer matching', () => {
  it('folds dotted legal forms, quotes and dashes', () => {
    expect(normalizeBuyerName('ს.ს. ლომისი')).toBe('ლომისი');
    expect(normalizeBuyerName('ს. ს. ენერგო-პრო ჯორჯია')).toBe('ენერგო პრო ჯორჯია');
    expect(normalizeBuyerName('შ.პ.ს ტრანსკომ გრუპ')).toBe('ტრანსკომ გრუპ');
    expect(normalizeBuyerName('შპს ავერსი–ფარმა')).toBe('ავერსი ფარმა');
    expect(normalizeBuyerName('შპს "ავერსის კლინიკა"')).toBe('ავერსის კლინიკა');
    expect(normalizeBuyerName("სს ,,კრედო ბანკი''")).toBe('კრედო ბანკი');
  });

  it('matches the same buyer across sites', () => {
    expect(buyersMatch('შპს "ავერსის კლინიკა"', 'ავერსის კლინიკა')).toBe(true);
    expect(buyersMatch('შპს ავერსი–ფარმა', 'ავერსი ფარმა')).toBe(true);
    expect(buyersMatch('UNDP', 'გაეროს განვითარების პროგრამა')).toBe(true);
    expect(buyersMatch('UNICEF', 'Unicef')).toBe(true);
    // A trading name after the legal name.
    expect(buyersMatch('ს.ს. ლომისი', 'ლომისი - ლუდსახარში ნატახტარი')).toBe(true);
    expect(buyersMatch('GIZ', 'GIZ - გერმანიის საერთაშორისო თანამშრომლობის საზოგადოება')).toBe(
      true,
    );
  });

  it('keeps different buyers apart', () => {
    // Two companies of one group.
    expect(buyersMatch('შპს ავერსი–ფარმა', 'ავერსის კლინიკა')).toBe(false);
    expect(buyersMatch('UNICEF', 'გაეროს განვითარების პროგრამა')).toBe(false);
    // A shared first word that names nobody, and the boards' anonymous employer.
    expect(buyersMatch('საქართველოს ბანკი', 'საქართველოს ნოტარიუსთა პალატა')).toBe(false);
    expect(buyersMatch('კომპანია', 'კომპანია ნოსტე')).toBe(false);
    expect(buyersMatch(null, 'ავერსის კლინიკა')).toBe(false);
  });

  it('blocks on the first word that identifies a buyer', () => {
    expect(buyerHeadWord('ლომისი ლუდსახარში ნატახტარი')).toBe('ლომისი');
    expect(buyerHeadWord('საქართველოს ნოტარიუსთა პალატა')).toBeNull();
  });
});
