import { describe, expect, it } from 'vitest';
import { etendersGeSource, hrGeSource, jobsGeSource, sourcePolicies } from './index.js';
import { isSsGeUrlAllowed, ssGePolicy, ssGeSource } from './ss-ge.js';

const RESULTS = 'https://home.ss.ge/ka/udzravi-qoneba/l';
const FLATS_FOR_SALE = `${RESULTS}/bina/iyideba?order=1&page=1`;

describe('ss.ge source policy', () => {
  it('is registered under its own id, distinct from every other source', () => {
    expect(ssGePolicy.sourceId).toBe(ssGeSource.id);
    expect(sourcePolicies['ss-ge'].source.id).toBe(ssGeSource.id);
    expect(new Set([ssGeSource.id, jobsGeSource.id, hrGeSource.id, etendersGeSource.id]).size).toBe(
      4,
    );
  });

  it('is http-only, unauthenticated, one request at a time 3 s apart, on home.ss.ge alone', () => {
    expect(ssGePolicy.allowedAcquisitionModes).toEqual(['http']);
    expect(ssGePolicy.authenticationScope).toBe('none');
    expect(ssGePolicy.rateLimit).toMatchObject({ crawlDelaySeconds: 3, maxConcurrency: 1 });
    expect(ssGePolicy.allowedHosts).toEqual(['home.ss.ge']);
    expect(ssGePolicy.linkedResources.retention).toBe('none');
    expect(ssGePolicy.display.mayRepublishFullContent).toBe(false);
  });
});

describe('isSsGeUrlAllowed', () => {
  it('allows newest-first results pages for every kind and deal in scope', () => {
    for (const kind of ['bina', 'kerdzo-saxli', 'agaraki']) {
      for (const deal of ['iyideba', 'qiravdeba']) {
        expect(isSsGeUrlAllowed(`${RESULTS}/${kind}/${deal}?order=1&page=1`)).toBe(true);
        expect(isSsGeUrlAllowed(`${RESULTS}/${kind}/${deal}?order=1&page=2593`)).toBe(true);
      }
    }
  });

  it('allows the two filters a slice may add: one city and a room count', () => {
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&cityIdList=95`)).toBe(true);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&cityIdList=95&rooms=3`)).toBe(true);
  });

  it('allows a detail page by its numeric id alone', () => {
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/35653707')).toBe(true);
  });

  it('rejects results pages without the exact order and page shape', () => {
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba?page=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba?order=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba?order=2&page=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba?order=1&page=0`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/iyideba?order=1&page=100000`)).toBe(false);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&page=2`)).toBe(false);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}#top`)).toBe(false);
  });

  it('rejects kinds, deals and filters outside the scope', () => {
    expect(isSsGeUrlAllowed(`${RESULTS}/komerciuli/iyideba?order=1&page=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina/qiravdeba-dghiurad?order=1&page=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${RESULTS}/bina?order=1&page=1`)).toBe(false);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&advancedSearch=%7B%7D`)).toBe(false);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&cityIdList=95,96`)).toBe(false);
    expect(isSsGeUrlAllowed(`${FLATS_FOR_SALE}&rooms=0`)).toBe(false);
  });

  it('rejects detail addresses other than the bare id, and the hub pages beside them', () => {
    expect(
      isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/iyideba-3-otaxiani-bina-35653707'),
    ).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/35653707?x=1')).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/0')).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba')).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/calculator')).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/udzravi-qoneba/mshenebare/l')).toBe(false);
  });

  it('rejects account pages, which robots.txt disallows', () => {
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/user')).toBe(false);
    expect(isSsGeUrlAllowed('https://home.ss.ge/ka/user/favorites')).toBe(false);
  });

  it("rejects every other host, including the site's own JSON gateway", () => {
    expect(isSsGeUrlAllowed('https://api-gateway.ss.ge/v1/RealEstate/LegendSearch')).toBe(false);
    expect(isSsGeUrlAllowed('https://ss.ge/ka/udzravi-qoneba/l/bina/iyideba?order=1&page=1')).toBe(
      false,
    );
    expect(isSsGeUrlAllowed(FLATS_FOR_SALE.replace('https://', 'http://'))).toBe(false);
    expect(isSsGeUrlAllowed(FLATS_FOR_SALE.replace('home.ss.ge', 'home.ss.ge:8443'))).toBe(false);
    expect(isSsGeUrlAllowed('not a url')).toBe(false);
  });
});
