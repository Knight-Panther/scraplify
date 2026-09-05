import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../../domain/ids.js';
import { parseJobsGeDetailPage } from './detail.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

const PROVENANCE = {
  resourceId: '11111111-1111-1111-1111-111111111111' as ResourceId,
  fetchedAt: '2026-09-04T12:00:00Z',
  notes: null,
};

describe('parseJobsGeDetailPage: real fixtures', () => {
  it('mailto pattern (id 749603, "ტრენერი" / Sharm Trading)', () => {
    const result = parseJobsGeDetailPage({
      html: loadFixture('detail-749603-mailto.html'),
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(result.titleRaw).toBe('ტრენერი');
    expect(result.titleNormalized).toBe('ტრენერი');
    expect(result.organizationRaw).toBe('შარმ ტრეიდინგი');
    expect(result.publishedDate).toEqual({
      raw: '02 სექტემბერი',
      parsed: '2026-09-02T00:00:00+04:00',
    });
    expect(result.deadlineDate).toEqual({
      raw: '02 ოქტომბერი',
      parsed: '2026-10-02T00:00:00+04:00',
    });
    expect(result.applicationMethod).toEqual({ type: 'email', value: 'vacancy@sharmtrading.ge' });
    expect(result.description).toContain('ტრენინგების ჩატარების');
    expect(result.description).not.toContain('<b>');
    expect(result.locations).toEqual([]);
    expect(result.salaryRaw).toBeNull();
    expect(result.sourceCategories).toEqual([]);
    expect(result.extractionMethod).toBe('http');
    expect(result.parserVersion).toBe('v1');
    expect(result.rawResourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meaningfulContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance).toEqual(PROVENANCE);
  });

  it('external-link-in-description-text pattern (id 749914, "მიმტანი" / Café Stamba)', () => {
    const result = parseJobsGeDetailPage({
      html: loadFixture('detail-749914-external-link-in-text.html'),
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(result.titleRaw).toBe('მიმტანი');
    expect(result.organizationRaw).toBe('Café Stamba');
    expect(result.publishedDate.parsed).toBe('2026-09-03T00:00:00+04:00');
    expect(result.deadlineDate.parsed).toBe('2026-10-03T00:00:00+04:00');
    expect(result.applicationMethod).toEqual({ type: 'url', value: 'https://wrk.ge/FUCEbNxgaK' });
  });

  it('direct-ATS-link pattern (id 749334, "კონტაქტ ცენტრის მენეჯერი/ოპერატორი" / Ardi Insurance)', () => {
    const result = parseJobsGeDetailPage({
      html: loadFixture('detail-749334-direct-ats-link.html'),
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(result.titleRaw).toBe('კონტაქტ ცენტრის მენეჯერი/ოპერატორი');
    expect(result.organizationRaw).toBe('არდი დაზღვევა');
    expect(result.publishedDate.parsed).toBe('2026-09-02T00:00:00+04:00');
    expect(result.deadlineDate.parsed).toBe('2026-10-02T00:00:00+04:00');
    expect(result.applicationMethod).toEqual({
      type: 'url',
      value: 'https://ardi.selfrecruit.ge/814b2cd0-f8af-4142-a589-0cfc4da797de',
    });
    // The unrelated top-banner ad link (https://bit.ly/31aRg0k) and the
    // sidebar "all listings for this client" link must not be picked up —
    // RECON_NOTES.md's parsing gotcha this test guards against.
    expect(result.applicationMethod?.value).not.toContain('bit.ly');
  });

  it('is deterministic: parsing the same fixture twice yields identical hashes', () => {
    const html = loadFixture('detail-749603-mailto.html');
    const first = parseJobsGeDetailPage({ html, extractionMethod: 'http', provenance: PROVENANCE });
    const second = parseJobsGeDetailPage({
      html,
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(second.rawResourceHash).toBe(first.rawResourceHash);
    expect(second.meaningfulContentHash).toBe(first.meaningfulContentHash);
  });

  it('produces a different meaningfulContentHash for different fixtures', () => {
    const a = parseJobsGeDetailPage({
      html: loadFixture('detail-749603-mailto.html'),
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });
    const b = parseJobsGeDetailPage({
      html: loadFixture('detail-749914-external-link-in-text.html'),
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(a.meaningfulContentHash).not.toBe(b.meaningfulContentHash);
    expect(a.rawResourceHash).not.toBe(b.rawResourceHash);
  });

  it('throws when the expected .dtable title row is absent', () => {
    expect(() =>
      parseJobsGeDetailPage({
        html: '<html><body><p>not a jobs.ge detail page</p></body></html>',
        extractionMethod: 'http',
        provenance: PROVENANCE,
      }),
    ).toThrow(/could not find listing title/);
  });

  it('throws when the title row is present but the description cell is missing (structural drift)', () => {
    const html = `<html><body>
      <table class="dtable">
        <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>Title</b></td></tr>
        <tr><td class="dtitle"><span class="grey">გამოქვეყნდა:</span> <b>02 სექტემბერი</b></td></tr>
      </table>
    </body></html>`;

    expect(() =>
      parseJobsGeDetailPage({ html, extractionMethod: 'http', provenance: PROVENANCE }),
    ).toThrow(/no description cell found/);
  });

  it('throws when neither the organization nor published-date row is found (structural drift)', () => {
    const html = `<html><body>
      <table class="dtable">
        <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>Title</b></td></tr>
        <tr><td>Some description text</td></tr>
      </table>
    </body></html>`;

    expect(() =>
      parseJobsGeDetailPage({ html, extractionMethod: 'http', provenance: PROVENANCE }),
    ).toThrow(/neither .* nor .* row found/);
  });

  it('does not require an organization row when the published row is present (negative control)', () => {
    // Guards against over-tightening the structural-drift check to require
    // BOTH organization and published rows: RECON_NOTES.md's fixtures were
    // sampled by ID recency, not stratified across the announcement types
    // this crawl deliberately aggregates, so there's no evidence every type
    // carries an organization row.
    const html = `<html><body>
      <table class="dtable">
        <tr><td class="dtitle"><span class="grey">დასახელება:</span> <b>Title</b></td></tr>
        <tr><td class="dtitle"><span class="grey">გამოქვეყნდა:</span> <b>02 სექტემბერი</b> / <span class="grey">ბოლო ვადა:</span> <b>02 ოქტომბერი</b></td></tr>
        <tr><td>Some description text</td></tr>
      </table>
    </body></html>`;

    const result = parseJobsGeDetailPage({
      html,
      extractionMethod: 'http',
      provenance: PROVENANCE,
    });

    expect(result.organizationRaw).toBeNull();
    expect(result.publishedDate.raw).toBe('02 სექტემბერი');
  });
});
