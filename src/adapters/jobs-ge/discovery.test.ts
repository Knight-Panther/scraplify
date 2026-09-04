import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAdsPage } from './discovery.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseAdsPage: real fixtures', () => {
  it('page 1: 10 VIP + 300 standard, no ID overlap (RECON_NOTES.md counts)', () => {
    const { vip, standard } = parseAdsPage(loadFixture('ads-page-1.html'));

    expect(vip).toHaveLength(10);
    expect(standard).toHaveLength(300);

    const vipIds = new Set(vip.map((l) => l.sourceRecordId));
    const standardIds = new Set(standard.map((l) => l.sourceRecordId));
    expect(vipIds.size).toBe(10); // no duplicate rows within the partition
    expect(standardIds.size).toBe(300);
    expect([...vipIds].some((id) => standardIds.has(id))).toBe(false);
  });

  it('page 1: every listing resolves to an authorized, well-formed detail URL', () => {
    const { vip, standard } = parseAdsPage(loadFixture('ads-page-1.html'));

    for (const listing of [...vip, ...standard]) {
      expect(listing.url).toBe(`https://www.jobs.ge/ge/?view=jobs&id=${listing.sourceRecordId}`);
      expect(listing.sourceRecordId).toMatch(/^[0-9]+$/);
      expect(listing.title.length).toBeGreaterThan(0);
    }
  });

  it('page 1: spot-check a known VIP listing (id 749914, "მიმტანი" / "Waiter" per RECON_NOTES.md)', () => {
    const { vip } = parseAdsPage(loadFixture('ads-page-1.html'));

    const waiter = vip.find((l) => l.sourceRecordId === '749914');
    expect(waiter).toMatchObject({
      sourceRecordId: '749914',
      title: 'მიმტანი',
      partition: 'vip',
      url: 'https://www.jobs.ge/ge/?view=jobs&id=749914',
    });
  });

  it('last page (19): 10 VIP + 247 standard (RECON_NOTES.md pagination bisection)', () => {
    const { vip, standard } = parseAdsPage(loadFixture('ads-page-19-last.html'));

    expect(vip).toHaveLength(10);
    expect(standard).toHaveLength(247);
  });
});

describe('parseAdsPage: partition assignment and dedup, on minimal synthetic markup', () => {
  // A `class="vip"` title-link class appears on rows in BOTH sections on
  // the real site (confirmed against the fixtures above) — this synthetic
  // page reproduces that trap deliberately, so partition assignment must
  // come only from which container the row is in.
  const HEADER_ROW = '<tr><th>Title</th></tr>';
  function detailRow(id: number, title: string): string {
    return `<tr>
      <td><img id="${id}" class="unstar" /></td>
      <td>
        <a href="/ge/?view=jobs&id=${id}" class="vip">${title}</a>
        <a href="/ge/?view=jobs&id=${id}" target="_blank"><img src="/i/newwindow.gif" /></a>
      </td>
    </tr>`;
  }

  it('assigns partition by container, not by the shared "vip" anchor class', () => {
    const html = `
      <div class="vipEntries">
        <table>${HEADER_ROW}${detailRow(1, 'VIP listing')}</table>
      </div>
      <table id="job_list_table">${HEADER_ROW}${detailRow(2, 'Standard listing')}</table>
    `;

    const { vip, standard } = parseAdsPage(html);

    expect(vip).toEqual([
      {
        sourceRecordId: '1',
        url: 'https://www.jobs.ge/ge/?view=jobs&id=1',
        title: 'VIP listing',
        partition: 'vip',
      },
    ]);
    expect(standard).toEqual([
      {
        sourceRecordId: '2',
        url: 'https://www.jobs.ge/ge/?view=jobs&id=2',
        title: 'Standard listing',
        partition: 'standard',
      },
    ]);
  });

  it('dedupes the title anchor and the "open in new window" icon anchor within one row', () => {
    const html = `<table id="job_list_table">${HEADER_ROW}${detailRow(5, 'One listing')}</table>`;

    const { standard } = parseAdsPage(html);

    expect(standard).toHaveLength(1);
  });

  it('skips a row whose detail link would not pass isJobsGeUrlAllowed', () => {
    const html = `<table id="job_list_table">${HEADER_ROW}
      <tr><td><a href="https://evil.example/?view=jobs&id=1">Off-origin</a></td></tr>
      ${detailRow(6, 'Real listing')}
    </table>`;

    const { standard } = parseAdsPage(html);

    expect(standard).toEqual([
      expect.objectContaining({ sourceRecordId: '6', title: 'Real listing' }),
    ]);
  });

  it('ignores a header row (no detail anchor) instead of throwing', () => {
    const html = `<table id="job_list_table">${HEADER_ROW}</table>`;

    expect(() => parseAdsPage(html)).not.toThrow();
    expect(parseAdsPage(html).standard).toEqual([]);
  });

  it('returns empty partitions when a section is entirely absent from the page', () => {
    const html = `<table id="job_list_table">${HEADER_ROW}${detailRow(7, 'Only standard')}</table>`;

    const { vip, standard } = parseAdsPage(html);

    expect(vip).toEqual([]);
    expect(standard).toHaveLength(1);
  });
});
