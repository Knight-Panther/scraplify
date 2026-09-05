import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../../domain/ids.js';
import { HrGeDetailParseError, parseHrGeDetailPage } from './detail.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

function parseFixture(name: string, announcementId: string) {
  return parseHrGeDetailPage({
    html: loadFixture(name),
    announcementId,
    extractionMethod: 'http',
    provenance: {
      resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
      fetchedAt: '2026-09-05T12:00:00Z',
      notes: null,
    },
  });
}

describe('parseHrGeDetailPage — real fixtures', () => {
  it('email application (492368): organization, email method, salary suppressed', () => {
    const content = parseFixture('detail-492368-email-application.html', '492368');
    expect(content.titleRaw).toBe('გაყიდვების კონსულტანტი');
    expect(content.organizationRaw).toBe('ბებე +');
    expect(content.applicationMethod).toEqual({ type: 'email', value: 'bebeplus.pr@gmail.com' });
    expect(content.salaryRaw).toBeNull(); // showSalary: false
    expect(content.locations).toEqual(['თბილისი']);
    expect(content.publishedDate.raw).toBe('2026-09-04T18:32:04.54');
    expect(content.publishedDate.parsed).toBe(
      new Date('2026-09-04T18:32:04.54+04:00').toISOString(),
    );
    expect(content.deadlineDate.raw).toBe('2026-10-03T19:59:00');
    expect(content.structuredAttributes.hideContactPerson).toBe(true);
    // hideContactPerson: true — must never surface the leaked contact
    // fields anywhere in the output.
    expect(JSON.stringify(content)).not.toContain('REDACTED CONTACT NAME');
  });

  it('anonymous employer (490225): organization withheld, internal "send CV" application', () => {
    const content = parseFixture('detail-490225-anonymous-employer.html', '490225');
    expect(content.organizationRaw).toBeNull(); // isAnonymous: true
    expect(content.applicationMethod).toEqual({ type: 'form', value: null }); // method 2
    expect(content.salaryRaw).toBe('1000-?'); // salaryFrom 1000, salaryTo null, showSalary true
    expect(content.structuredAttributes.isAnonymous).toBe(true);
  });

  it('external ATS + renewed listing (490978): url method, salary range, renewalDate carried', () => {
    const content = parseFixture('detail-490978-external-ats-renewed.html', '490978');
    expect(content.applicationMethod).toEqual({
      type: 'url',
      value: 'https://careers.evolution.com/georgia/turkish-speaking-gp/',
    });
    expect(content.salaryRaw).toBe('960-1900');
    expect(content.structuredAttributes.renewalDate).toBe('2026-09-05T00:05:00.083');
    // The renewal gotcha (RECON_NOTES.md): the parsed publishedDate must
    // still come from publishDate, not from the display string or the
    // renewal date.
    expect(content.publishedDate.raw).toBe('2026-08-27T15:04:58.383');
  });

  it('onsite application + salary with bonus (491887): bonus fields carried in structuredAttributes', () => {
    const content = parseFixture('detail-491887-onsite-application-salary-bonus.html', '491887');
    expect(content.applicationMethod).toEqual({ type: 'form', value: null });
    expect(content.salaryRaw).toBe('800-?');
    expect(content.structuredAttributes.isWithBonus).toBe(true);
    expect(content.structuredAttributes.bonusFrom).toBe(400);
  });

  it('external ATS + experience required (492350): workExperience carried despite showWorkExperience: false', () => {
    const content = parseFixture('detail-492350-external-ats-experience-required.html', '492350');
    expect(content.applicationMethod).toEqual({
      type: 'url',
      value: 'https://cleverstaff.net/i/vacancy-CCWXHQ',
    });
    expect(content.salaryRaw).toBeNull(); // showSalary: false
    // The real point of this fixture (RECON_NOTES.md): showWorkExperience
    // is false here too, exactly like every other sample, yet this
    // listing genuinely requires experience — proof that gating on that
    // flag would wrongly suppress real, meaningful data.
    expect(content.structuredAttributes.workExperienceType).toBe(1);
    expect(content.structuredAttributes.workExperienceFrom).toBe(3);
  });

  it('structuredAttributes carries the nested specialty/industry/seniority fields for every sample', () => {
    for (const [file, id] of [
      ['detail-492368-email-application.html', '492368'],
      ['detail-491887-onsite-application-salary-bonus.html', '491887'],
    ] as const) {
      const content = parseFixture(file, id);
      expect(Array.isArray(content.structuredAttributes.specialty)).toBe(true);
      expect(Array.isArray(content.structuredAttributes.seniorityLevels)).toBe(true);
      expect(Array.isArray(content.structuredAttributes.educationLevels)).toBe(true);
    }
  });

  it('description is decoded to readable plain text, not left as raw entity-encoded HTML', () => {
    const content = parseFixture('detail-492368-email-application.html', '492368');
    expect(content.description).not.toContain('&#');
    expect(content.description).not.toContain('<span>');
    expect(content.description.length).toBeGreaterThan(0);
  });

  it('meaningfulContentHash is deterministic and content-sensitive', () => {
    const a = parseFixture('detail-492368-email-application.html', '492368');
    const b = parseFixture('detail-492368-email-application.html', '492368');
    const c = parseFixture('detail-490225-anonymous-employer.html', '490225');
    expect(a.meaningfulContentHash).toBe(b.meaningfulContentHash);
    expect(a.meaningfulContentHash).not.toBe(c.meaningfulContentHash);
  });
});

describe('parseHrGeDetailPage — structural failures', () => {
  it('throws HrGeDetailParseError when the ng-state island is missing', () => {
    expect(() =>
      parseHrGeDetailPage({
        html: '<html><body>no island</body></html>',
        announcementId: '1',
        extractionMethod: 'http',
        provenance: {
          resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
          fetchedAt: '2026-09-05T12:00:00Z',
          notes: null,
        },
      }),
    ).toThrow();
  });

  it('throws HrGeDetailParseError when no matching announcement entry exists', () => {
    const html =
      '<html><body><script id="ng-state" type="application/json">{"1":{"u":"https://api.p.hr.ge/other","b":{}}}</script></body></html>';
    expect(() =>
      parseHrGeDetailPage({
        html,
        announcementId: '1',
        extractionMethod: 'http',
        provenance: {
          resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
          fetchedAt: '2026-09-05T12:00:00Z',
          notes: null,
        },
      }),
    ).toThrow(HrGeDetailParseError);
  });

  it('throws HrGeDetailParseError when the title is missing', () => {
    const html = `<html><body><script id="ng-state" type="application/json">${JSON.stringify({
      1: {
        u: 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/1',
        b: { data: { announcement: { announcementId: 1 } } },
      },
    })}</script></body></html>`;
    expect(() =>
      parseHrGeDetailPage({
        html,
        announcementId: '1',
        extractionMethod: 'http',
        provenance: {
          resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
          fetchedAt: '2026-09-05T12:00:00Z',
          notes: null,
        },
      }),
    ).toThrow(HrGeDetailParseError);
  });

  it('throws HrGeDetailParseError when the island answers a different announcementId (stale/mismatched entry)', () => {
    const html = `<html><body><script id="ng-state" type="application/json">${JSON.stringify({
      1: {
        u: 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/999',
        b: { data: { announcement: { announcementId: 999, title: 'wrong one' } } },
      },
    })}</script></body></html>`;
    expect(() =>
      parseHrGeDetailPage({
        html,
        announcementId: '1',
        extractionMethod: 'http',
        provenance: {
          resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
          fetchedAt: '2026-09-05T12:00:00Z',
          notes: null,
        },
      }),
    ).toThrow(HrGeDetailParseError);
  });

  it('does NOT throw when optional fields are null/absent — an honest unknown, not a failure', () => {
    const html = `<html><body><script id="ng-state" type="application/json">${JSON.stringify({
      1: {
        u: 'https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/1',
        b: {
          data: {
            announcement: {
              announcementId: 1,
              title: 'minimal listing',
              customerName: null,
              description: null,
              addresses: null,
              salaryFrom: null,
              salaryTo: null,
              showSalary: false,
              applicationMethod: 0,
              applicationDetails: null,
              announcementRequirements: null,
              employerRequirements: null,
            },
          },
        },
      },
    })}</script></body></html>`;
    const content = parseHrGeDetailPage({
      html,
      announcementId: '1',
      extractionMethod: 'http',
      provenance: {
        resourceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' as ResourceId,
        fetchedAt: '2026-09-05T12:00:00Z',
        notes: null,
      },
    });
    expect(content.titleRaw).toBe('minimal listing');
    expect(content.organizationRaw).toBeNull();
    expect(content.salaryRaw).toBeNull();
    expect(content.applicationMethod).toEqual({ type: 'unspecified', value: null });
    expect(content.locations).toEqual([]);
  });
});
