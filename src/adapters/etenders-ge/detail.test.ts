import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../../domain/ids.js';
import {
  EtendersGeDetailParseError,
  parseEtendersGeDetailPage,
  type TenderAttributes,
} from './detail.js';

const PROVENANCE = {
  resourceId: '00000000-0000-4000-8000-000000000000' as ResourceId,
  fetchedAt: '2026-10-07T06:00:00.000Z',
  notes: null,
};

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

function parse(name: string, html = fixture(name)) {
  const id = /detail-(\d+)/.exec(name)?.[1] ?? '';
  const content = parseEtendersGeDetailPage({
    html,
    expectedSourceRecordId: id,
    extractionMethod: 'http',
    provenance: PROVENANCE,
  });
  return { content, attributes: content.structuredAttributes as unknown as TenderAttributes };
}

describe('parseEtendersGeDetailPage', () => {
  it('reads an open reverse auction in USD with its bid window, step and buyer registry ID', () => {
    const { content, attributes } = parse('detail-69679-reverse-auction-open-usd.html');
    expect(content).toMatchObject({
      titleRaw: '0007464 Cisco hardware',
      titleNormalized: '0007464 cisco hardware',
      organizationRaw: 'სს "თიბისი ბანკი"',
      locations: ['თბილისი', 'საქართველო'],
      salaryRaw: null,
      publishedDate: { raw: '05/10/2026 11:12', parsed: '2026-10-05T07:12:00.000Z' },
      deadlineDate: { raw: '13/10/2026 15:00', parsed: '2026-10-13T11:00:00.000Z' },
      applicationMethod: { type: 'form', value: 'https://etenders.ge/view/69679/x' },
      sourceCategories: ['cpv:30200000'],
    });
    expect(attributes).toMatchObject({
      kind: 'tender',
      tenderNumber: '69679',
      status: { code: 1, text: 'გამოცხადებულია' },
      method: { code: 2, text: 'რევერსული აუქციონი' },
      submission: 'platform',
      bidWindow: { start: { parsed: '2026-10-13T08:00:00.000Z' } },
      priceBasis: { vat: 'included', currency: 'USD' },
      maxValue: null,
      minStep: { amount: 1000, currency: 'USD' },
      auctionOnTotal: true,
      cpv: [{ code: '30200000', label: 'კომპიუტერული მოწყობილობები და აქსესუარები' }],
      buyer: { registryId: '204854595', name: 'სს "თიბისი ბანკი"' },
      biddersCount: null,
    });
    expect(attributes.documents).toHaveLength(6);
    expect(attributes.documents[0]).toEqual({
      fileId: '7a6592d6-2ac5-4576-928d-17fef26b7483',
      name: '0007464 Cisco hardware for TBC TBL-02- RFP.docx',
      description: 'სატენდერო დოკუმენტაცია',
      date: '05/10/2026',
      obsolete: false,
    });
  });

  it('reads a completed tender with its bidder count and public Q&A, and a clean description', () => {
    const { content, attributes } = parse('detail-69619-one-envelope-completed-qa.html');
    expect(attributes).toMatchObject({
      status: { code: 99 },
      method: { code: 3, text: 'ტენდერი ერთი კონვერტის პრინციპით' },
      biddersCount: 2,
      qa: { count: 2, lastAt: '2026-09-28T14:29:08.000Z' },
      buyer: { registryId: '205232238' },
    });
    expect(attributes.documents).toHaveLength(9);
    expect(content.description).toBe(
      'სს კრედო ბანკი აცხადებს ტენდერს სავარძლების შესყიდვის შესახებ,\nგისურვებთ წარმატებებს,\nკითხვების შემთხვევაში დამიკავშირდით მეილზე contact-c@example.invalid',
    );
  });

  it('reads an off-platform notice: no price basis, a midnight deadline, and the submission email', () => {
    const { content, attributes } = parse('detail-69674-notice-off-platform-english.html');
    expect(content).toMatchObject({
      titleRaw: 'Development of Three Animated Educational Videos on Sustainable Forest Management',
      locations: [],
      deadlineDate: { raw: '16/10/2026 00:00', parsed: '2026-10-15T20:00:00.000Z' },
      applicationMethod: { type: 'email', value: 'ge_quotation@giz.de' },
    });
    expect(attributes).toMatchObject({
      method: { code: 1, text: 'განცხადება' },
      submission: 'off_platform',
      priceBasis: null,
      buyer: { registryId: '204432710' },
    });
  });

  it('reads a prequalification in USD excluding VAT with a stated maximum value', () => {
    const { attributes } = parse('detail-69617-prequalification-usd-excl-vat.html');
    expect(attributes).toMatchObject({
      method: { code: 5 },
      priceBasis: { vat: 'excluded', currency: 'USD' },
      maxValue: { amount: 120000, vat: 'excluded', currency: 'USD' },
      bidWindow: {
        start: { raw: '23/10/2026 12:30' },
        end: { raw: '25/10/2026 20:00' },
      },
    });
  });

  it('reads every closing status: terminated, failed with no bidders, completed auction', () => {
    expect(parse('detail-69534-terminated-notice.html').attributes).toMatchObject({
      status: { code: 4, text: 'შეწყვეტილი' },
      method: { code: 1 },
      biddersCount: null,
    });
    expect(parse('detail-69607-failed-no-bidders.html').attributes).toMatchObject({
      status: { code: 5, text: 'ტენდერი არ შედგა' },
      biddersCount: 0,
    });
    expect(parse('detail-69611-reverse-auction-completed.html').attributes).toMatchObject({
      status: { code: 99 },
      method: { code: 2 },
      minStep: { amount: 2000, currency: 'GEL' },
      biddersCount: 2,
    });
  });

  it('reads a two-envelope tender with several CPV codes and an empty description', () => {
    const { content, attributes } = parse('detail-69397-two-envelope-completed.html');
    expect(attributes.method.code).toBe(4);
    expect(attributes.priceBasis).toEqual({
      raw: 'დ.ღ.გ-ს ჩათვლით',
      vat: 'included',
      currency: null,
    });
    expect(content.sourceCategories).toEqual([
      'cpv:45200000',
      'cpv:45400000',
      'cpv:50700000',
      'cpv:70300000',
      'cpv:71200000',
    ]);
    expect(content.description).toBe('');
  });

  it('reads the 2015 page with the same template', () => {
    const { content, attributes } = parse('detail-41358-legacy-2015.html');
    expect(content).toMatchObject({
      titleRaw: 'ნატრიუმის ქლორიდი',
      locations: ['გურჯაანი'],
      description: 'გთხოვთ იხილეთ სატენდერო დოკუმენტაცია',
    });
    expect(attributes).toMatchObject({
      maxValue: { amount: 12200, currency: 'GEL', vat: 'included' },
      biddersCount: 1,
      buyer: { registryId: '227766842' },
    });
  });

  it('keeps Q&A out of the meaningful-content hash, but not the status', () => {
    const name = 'detail-69619-one-envelope-completed-qa.html';
    const html = fixture(name);
    const base = parse(name, html).content.meaningfulContentHash;
    const moreQa = html.replace(
      '<table id="TenderCommentsTable">',
      '<table id="TenderCommentsTable"><tr><td><b>თარიღი</b>:</td><td></td><td>01/10/2026 10:00:00</td></tr>',
    );
    expect(parse(name, moreQa).content.meaningfulContentHash).toBe(base);
    const viewsChanged = html.replace(
      /უნიკალური ნახვების რაოდენობა: \d+/,
      'უნიკალური ნახვების რაოდენობა: 9999',
    );
    expect(parse(name, viewsChanged).content.meaningfulContentHash).toBe(base);
    const terminated = html.replace('<b>სტატუსი </b>: დასრულებული', '<b>სტატუსი </b>: შეწყვეტილი');
    expect(parse(name, terminated).content.meaningfulContentHash).not.toBe(base);
  });

  it('refuses a page that is not the requested tender, or whose status is unknown', () => {
    const html = fixture('detail-69679-reverse-auction-open-usd.html');
    expect(() =>
      parseEtendersGeDetailPage({
        html,
        expectedSourceRecordId: '69680',
        extractionMethod: 'http',
        provenance: PROVENANCE,
      }),
    ).toThrow(EtendersGeDetailParseError);
    expect(() =>
      parse(
        'detail-69679-reverse-auction-open-usd.html',
        html.replace('<b>სტატუსი </b>: გამოცხადებულია', '<b>სტატუსი </b>: ახალი სტატუსი'),
      ),
    ).toThrow(/unknown status/);
  });

  it('refuses pages that are not tender pages at all', () => {
    for (const html of [fixture('search-empty.html'), fixture('error-500-method-format.html')]) {
      expect(() =>
        parseEtendersGeDetailPage({
          html,
          expectedSourceRecordId: '69679',
          extractionMethod: 'http',
          provenance: PROVENANCE,
        }),
      ).toThrow(EtendersGeDetailParseError);
    }
  });
});
