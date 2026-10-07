import { describe, expect, it } from 'vitest';
import { etendersGePolicy, etendersGeSource, isEtendersGeUrlAllowed } from './etenders-ge.js';
import { hrGeSource, jobsGeSource, sourcePolicies } from './index.js';

const SEARCH = 'https://etenders.ge/search/';
const LIVE = `${SEARCH}?ss=-1&ts=_1_2_3_&kw=&tn=&br=&cpv=&st=&end=&stamm=&endamm=`;

describe('etenders.ge source policy', () => {
  it('is registered under its own id, distinct from the job boards', () => {
    expect(etendersGePolicy.sourceId).toBe(etendersGeSource.id);
    expect(sourcePolicies['etenders-ge'].source.id).toBe(etendersGeSource.id);
    expect(new Set([etendersGeSource.id, jobsGeSource.id, hrGeSource.id]).size).toBe(3);
  });

  it('is http-only, unauthenticated, one request at a time 3 s apart, with no linked resources', () => {
    expect(etendersGePolicy.allowedAcquisitionModes).toEqual(['http']);
    expect(etendersGePolicy.authenticationScope).toBe('none');
    expect(etendersGePolicy.rateLimit).toMatchObject({ crawlDelaySeconds: 3, maxConcurrency: 1 });
    expect(etendersGePolicy.linkedResources.retention).toBe('none');
    expect(etendersGePolicy.display.mayRepublishFullContent).toBe(false);
  });
});

describe('isEtendersGeUrlAllowed', () => {
  it('allows the live-set search, its pages, and a recent-arrivals window', () => {
    expect(isEtendersGeUrlAllowed(LIVE)).toBe(true);
    expect(isEtendersGeUrlAllowed(`${LIVE}&pg=2`)).toBe(true);
    expect(
      isEtendersGeUrlAllowed(
        `${SEARCH}?ss=-1&ts=__&kw=&tn=&br=&cpv=&st=28-09-2026&end=&stamm=&endamm=&pg=3`,
      ),
    ).toBe(true);
  });

  it('rejects the parameter shapes that break the site: a bad method 500s, a bare status silently empties', () => {
    expect(isEtendersGeUrlAllowed(LIVE.replace('ss=-1', 'ss=_99'))).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('ss=-1', 'ss=6'))).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('ts=_1_2_3_', 'ts=2'))).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('ts=_1_2_3_', 'ts=_7_'))).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('st=&', 'st=2026-09-28&'))).toBe(false);
    expect(isEtendersGeUrlAllowed(`${LIVE}&pg=0`)).toBe(false);
  });

  it('requires the full parameter set, nothing extra, no duplicates, and empty free-text fields', () => {
    expect(isEtendersGeUrlAllowed(`${SEARCH}?ss=-1&ts=_1_2_3_`)).toBe(false);
    expect(isEtendersGeUrlAllowed(`${LIVE}&favs=1`)).toBe(false);
    expect(isEtendersGeUrlAllowed(`${LIVE}&lng=lang__en`)).toBe(false);
    expect(isEtendersGeUrlAllowed(`${LIVE}&ss=1`)).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('kw=&', 'kw=x&'))).toBe(false);
    expect(isEtendersGeUrlAllowed(`${SEARCH}?annbyme=1`)).toBe(false);
  });

  it('allows detail pages only in the /view/<id>/x form', () => {
    expect(isEtendersGeUrlAllowed('https://etenders.ge/view/69689/x')).toBe(true);
    expect(isEtendersGeUrlAllowed('https://etenders.ge/view/69689')).toBe(false);
    expect(isEtendersGeUrlAllowed('https://etenders.ge/view/69689/some-slug')).toBe(false);
    expect(isEtendersGeUrlAllowed('https://etenders.ge/view/69689/x?lng=lang__en')).toBe(false);
    expect(isEtendersGeUrlAllowed('https://etenders.ge/viewsale/69678/x')).toBe(false);
  });

  it('allows the CPV dictionary in Georgian and English only', () => {
    const cpv = 'https://etenders.ge/Pages/Tender/getTenderCPVSelection.aspx';
    expect(isEtendersGeUrlAllowed(`${cpv}?TenderId=-1&lng=1`)).toBe(true);
    expect(isEtendersGeUrlAllowed(`${cpv}?TenderId=-1&lng=2`)).toBe(true);
    expect(isEtendersGeUrlAllowed(`${cpv}?TenderId=69679&lng=1`)).toBe(false);
    expect(isEtendersGeUrlAllowed(`${cpv}?TenderId=-1&lng=3`)).toBe(false);
  });

  it('never allows state-changing, session, document, logo or keep-alive endpoints', () => {
    for (const path of [
      '/Pages/Tender/TenderDetails/DeleteComment.aspx?del=1',
      '/Pages/Tender/TenderSearch/ToggleFav.aspx?tid=1&crntval=off',
      '/Pages/Tender/TenderSearch/TenderNotFound.aspx',
      '/Pages/Tender/FileHandler/TenderDocsFileHandler.aspx?file=f99e7d34-9bc3-4409-8d14-5ceb99d40eb7',
      '/Pages/Profile/LogoHandler.aspx?tenderid=69689',
      '/Pages/HeartBeat.aspx',
      '/login',
      '/Register',
      '/tenders/?pg=2',
      '/',
    ]) {
      expect(isEtendersGeUrlAllowed(`https://etenders.ge${path}`), path).toBe(false);
    }
  });

  it('rejects other hosts, plain http, and explicit ports', () => {
    expect(
      isEtendersGeUrlAllowed(LIVE.replace('https://etenders.ge', 'https://www.etenders.ge')),
    ).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('https://', 'http://'))).toBe(false);
    expect(isEtendersGeUrlAllowed(LIVE.replace('etenders.ge/', 'etenders.ge:443/'))).toBe(true);
    expect(isEtendersGeUrlAllowed(LIVE.replace('etenders.ge/', 'etenders.ge:8443/'))).toBe(false);
    expect(isEtendersGeUrlAllowed('https://etender.ge/view/69689/x')).toBe(false);
  });
});
