import { describe, expect, it } from 'vitest';
import type { BundleOpportunity } from '../bundle/schema.js';
import {
  buildVocabulary,
  deriveProfile,
  type MatchProfile,
  type ProfileTerm,
  userTerm,
  vocabularyTerm,
} from './profile.js';
import { CONTEXT_FORMS, LEXICON, NOT_WHEN } from './lexicon.js';
import { indexOpportunities, rankOpportunities } from './rank.js';
import { findPhrase, phraseStems, snippet, stem, tokenize } from './text.js';

let seq = 0;
function row(overrides: Partial<BundleOpportunity> = {}): BundleOpportunity {
  seq++;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    opportunityId: id,
    canonicalRevisionId: id,
    semanticInputHash: 'a'.repeat(64),
    type: 'job',
    title: 'ბუღალტერი',
    organization: null,
    deadlineAt: null,
    locations: [],
    taxonomy: [],
    sources: [{ sourceSlug: 'jobs-ge', sourceListingId: id, canonicalUrl: 'https://www.jobs.ge/' }],
    ...overrides,
  };
}

const NOW = Date.parse('2026-09-25T12:00:00Z');
const FINANCE = { axis: 'profession', code: 'profession-fin', label: 'ბუღალტერია / ფინანსები' };
const SALES = { axis: 'profession', code: 'profession-sales', label: 'გაყიდვები' };

function profile(...terms: (ProfileTerm | null)[]): MatchProfile {
  return { terms: terms.filter((term): term is ProfileTerm => term !== null) };
}

describe('text', () => {
  it('reads through soft hyphens and zero-width characters inside a word', () => {
    const text = 'ბუღალ\u00ADტერი Accoun\u200Btant';
    expect(tokenize(text).map((token) => token.stem)).toEqual(['ბუღალტერ', 'accountant']);
    // Offsets still cover the original characters, invisible ones included.
    expect(tokenize(text)[0]).toMatchObject({ start: 0, end: 10 });
  });

  it('lowercases Mtavruli capitals to ordinary Georgian', () => {
    expect(phraseStems('ᲑᲣᲦᲐᲚᲢᲔᲠᲘ')).toEqual(phraseStems('ბუღალტერი'));
  });

  it('brings Georgian case forms of one word to one stem', () => {
    const forms = ['მენეჯერი', 'მენეჯერის', 'მენეჯერად', 'მენეჯერთან', 'მენეჯერებში'];
    expect(new Set(forms.map(stem)).size).toBe(1);
  });

  it('never strips a Georgian word below three letters', () => {
    expect(stem('გორი')).toBe('გორ');
    expect(stem('ის')).toBe('ის');
  });

  it('folds an English plural but leaves -ss alone', () => {
    expect(stem('developers')).toBe(stem('developer'));
    expect(stem('business')).toBe('business');
  });

  it('keeps C++ and C# as tokens and drops bare punctuation', () => {
    expect(tokenize('C++, C# and + alone').map((t) => t.stem)).toEqual([
      'c++',
      'c#',
      'and',
      'alone',
    ]);
  });

  it('matches whole tokens only', () => {
    expect(findPhrase(phraseStems('Google Analytics'), phraseStems('go'))).toBe(-1);
    expect(findPhrase(phraseStems('senior sales manager'), phraseStems('sales manager'))).toBe(1);
  });

  it('quotes the match with context and never cuts into it', () => {
    const text = `${'x '.repeat(60)}worked as Senior Accountant at a bank ${'y '.repeat(60)}`;
    const start = text.indexOf('Senior');
    const quote = snippet(text, start, start + 'Senior Accountant'.length);
    expect(quote).toContain('Senior Accountant');
    expect(quote.startsWith('…')).toBe(true);
    expect(quote.endsWith('…')).toBe(true);
  });
});

describe('lexicon', () => {
  it('keys its context and exception lists by labels that exist', () => {
    const labels = new Set(LEXICON.map((entry) => entry.en));
    for (const key of [...Object.keys(CONTEXT_FORMS), ...Object.keys(NOT_WHEN)]) {
      expect(labels, key).toContain(key);
    }
  });

  it('names only forms an entry really has in its context and exception lists', () => {
    for (const entry of LEXICON) {
      const forms = new Set(entry.forms.map((form) => phraseStems(form).join(' ')));
      for (const form of entry.contextForms ?? []) {
        expect(forms, `${entry.en}: context form "${form}"`).toContain(phraseStems(form).join(' '));
      }
      for (const phrase of entry.notWhen ?? []) {
        const stems = phraseStems(phrase);
        const containsForm = [...forms].some((form) => findPhrase(stems, form.split(' ')) !== -1);
        expect(containsForm, `${entry.en}: exception "${phrase}"`).toBe(true);
      }
    }
  });

  it('keeps at least one title form per role, so every role can be found in a CV', () => {
    for (const entry of LEXICON.filter((e) => e.kind === 'role')) {
      const context = new Set((entry.contextForms ?? []).map((f) => phraseStems(f).join(' ')));
      const titles = entry.forms.filter((form) => !context.has(phraseStems(form).join(' ')));
      expect(titles.length, entry.en).toBeGreaterThan(0);
    }
  });
});

describe('deriveProfile', () => {
  const vocabulary = buildVocabulary([
    row({ title: 'დისპეჩერი', locations: ['თბილისი'], taxonomy: [SALES] }),
    row({ title: 'დისპეჩერი', locations: ['ბათუმი'] }),
    row({ title: 'დისპეჩერი', taxonomy: [FINANCE] }),
  ]);

  it('finds English roles, skills and locations, each with its own evidence', () => {
    const { terms } = deriveProfile(
      'Senior Accountant, Tbilisi. Five years of accounting. Tools: Excel, 1C, SQL.',
      vocabulary,
    );
    const byId = new Map(terms.map((term) => [term.id, term]));
    expect(byId.get('role:accountant')?.evidence).toContain('Accountant');
    expect(byId.get('skill:excel')?.active).toBe(true);
    expect(byId.has('skill:1c')).toBe(true);
    expect(byId.has('skill:sql')).toBe(true);
    // An address is weak evidence of a preference: suggested, not applied.
    expect(byId.get('location:tbilisi')?.active).toBe(false);
  });

  it('finds Georgian roles from corpus titles and fields from taxonomy labels', () => {
    const { terms } = deriveProfile(
      'ვმუშაობდი დისპეჩერად და მოლარედ, შემდეგ ფინანსების განყოფილებაში.',
      vocabulary,
    );
    expect(terms.some((term) => term.kind === 'role' && term.label === 'დისპეჩერი')).toBe(true);
    // A Georgian word the curated list also knows merges into its bilingual term.
    expect(terms.some((term) => term.id === 'role:cashier')).toBe(true);
    const field = terms.find((term) => term.kind === 'field');
    expect(field?.codes).toEqual(['profession-fin']);
  });

  it('drops a generic role that a specific one already covers', () => {
    const { terms } = deriveProfile('Sales manager at a retail chain.', vocabulary);
    const roles = terms.filter((term) => term.kind === 'role').map((term) => term.id);
    expect(roles).toContain('role:sales manager');
    expect(roles).not.toContain('role:manager');
  });

  it('only suggests (never applies) a role read from a field-of-work word', () => {
    const { terms } = deriveProfile(
      'Advisor in banking; led web platform delivery and quality assurance of survey data.',
      vocabulary,
    );
    // Suggested with their quote so the user can tick them, but not applied.
    const applied = terms.filter((term) => term.kind === 'role' && term.active).map((t) => t.id);
    expect(applied).not.toContain('role:banker');
    expect(applied).not.toContain('role:courier');
    expect(applied).not.toContain('role:qa engineer');
    // One passing mention is not even suggested; a recurring field is, unticked.
    expect(terms.some((term) => term.id === 'role:banker')).toBe(false);
    const recurring = deriveProfile('Accounting, IFRS. Led accounting close.', vocabulary).terms;
    expect(recurring.find((term) => term.id === 'role:accountant')?.active).toBe(false);
    // The job title itself is still evidence.
    expect(deriveProfile('Courier, 2019–2021.', vocabulary).terms.map((t) => t.id)).toContain(
      'role:courier',
    );
    expect(userTerm('role', 'delivery')?.id).toBe('role:courier');
  });

  it('reads a long Georgian SME advisor title as the specific role, not bare advisor', () => {
    const { terms } = deriveProfile(
      'მცირე და საშუალო ბიზნესის განვითარების მრჩეველი, 2021 წლიდან.',
      vocabulary,
    );
    const ids = terms.map((term) => term.id);
    expect(ids).toContain('role:sme business advisor');
    expect(ids).not.toContain('role:advisor');
    expect(ids).toContain('skill:sme');
  });

  it('does not take a role the CV only mentions about other people', () => {
    const applied = (text: string) =>
      deriveProfile(text, vocabulary)
        .terms.filter((term) => term.kind === 'role' && term.active)
        .map((term) => term.id);
    // Plurals and the Georgian "with" case name colleagues, not the author.
    expect(applied('Nurse. Assisted physicians and liaised with auditors.')).toEqual([
      'role:nurse',
    ]);
    expect(applied('ტესტერი. ვთანამშრომლობ დეველოპერებთან.')).toEqual(['role:qa engineer']);
    expect(applied('Realtor. Reported directly to the Director of Sales.')).toEqual([
      'role:real estate agent',
    ]);
    // "Accountant's assistant" is an assistant.
    expect(applied('ბუღალტრის თანაშემწე')).not.toContain('role:accountant');
  });

  it('only suggests old, part-time and internship posts next to a current role', () => {
    const { terms } = deriveProfile(
      'Operations director, 2018 – present.\nSecurity guard (internship), 2006.\nCashier, 2005 – 2006.',
      vocabulary,
    );
    const state = new Map(terms.map((term) => [term.id, term.active]));
    expect(state.get('role:director')).toBe(true);
    expect(state.get('role:security guard')).toBe(false);
    expect(state.get('role:cashier')).toBe(false);
    // Alone, a student's part-time job is the profile.
    const student = deriveProfile('Cashier (part-time), 2023 – 2024.', vocabulary).terms;
    expect(student.find((term) => term.id === 'role:cashier')?.active).toBe(true);
  });

  it('suggests a broad role without applying it when a specific one was found', () => {
    const { terms } = deriveProfile(
      'Driver, 2019–2024. Worked with the fleet manager.',
      vocabulary,
    );
    const state = new Map(terms.map((term) => [term.id, term.active]));
    expect(state.get('role:driver')).toBe(true);
    expect(state.get('role:manager')).not.toBe(true);
  });

  it('suggests nothing without supporting text', () => {
    expect(deriveProfile('', vocabulary).terms).toEqual([]);
    expect(deriveProfile('Hobbies: hiking.', vocabulary).terms).toEqual([]);
  });

  it('is deterministic', () => {
    const text = 'Accountant. Excel. Tbilisi. ბუღალტერი.';
    expect(deriveProfile(text, vocabulary)).toEqual(deriveProfile(text, vocabulary));
  });
});

describe('rankOpportunities', () => {
  it('lets an English role reach a Georgian title', () => {
    const accountant = row({ title: 'მთავარი ბუღალტერი' });
    const driver = row({ title: 'მძღოლი' });
    const { results } = rankOpportunities(
      profile(userTerm('role', 'accountant')),
      indexOpportunities([accountant, driver]),
      { now: NOW },
    );
    expect(results.map((r) => r.row.opportunityId)).toEqual([accountant.opportunityId]);
    expect(results[0]?.reasons[0]).toMatchObject({ kind: 'role', exact: true });
  });

  it('lets a Georgian SME advisor CV reach a title written with "SME"', () => {
    const sme = row({ title: 'SME ბიზნეს მრჩეველი' });
    const client = row({ title: 'კლიენტთა მრჩეველი' });
    const derived = deriveProfile(
      'მცირე და საშუალო ბიზნესის განვითარების მრჩეველი',
      buildVocabulary([sme, client]),
    );
    const { results } = rankOpportunities(derived, indexOpportunities([sme, client]), {
      now: NOW,
    });
    // The exact title first; one sharing only the head noun (მრჩეველი) after it.
    expect(results.map((r) => r.row.opportunityId)).toEqual([
      sme.opportunityId,
      client.opportunityId,
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 1);
  });

  it('ranks a title sharing only the head noun after the exact title', () => {
    const exact = row({ title: 'მონაცემთა ანალიტიკოსი' });
    const near = row({ title: 'ფინანსური ანალიტიკოსი' });
    const other = row({ title: 'მონაცემთა ბაზის ადმინისტრატორი' });
    const { results } = rankOpportunities(
      profile(userTerm('role', 'data analyst')),
      indexOpportunities([near, other, exact]),
      { now: NOW },
    );
    expect(results.map((r) => r.row.opportunityId)).toEqual([
      exact.opportunityId,
      near.opportunityId,
    ]);
    expect(results[1]?.reasons[0]).toMatchObject({ kind: 'role', exact: false });
  });

  it('drops a row whose deadline passed after the bundle was built', () => {
    const expired = row({ deadlineAt: '2026-09-24T00:00:00Z' });
    const result = rankOpportunities(
      profile(userTerm('role', 'ბუღალტერი')),
      indexOpportunities([expired]),
      { now: NOW },
    );
    expect(result.results).toEqual([]);
    expect(result.stats.excludedDeadline).toBe(1);
  });

  it('filters on a stated location but never on silence', () => {
    const vocabulary = buildVocabulary([row({ locations: ['თბილისი'] })]);
    const tbilisi = vocabulary.locations[0];
    if (tbilisi === undefined) throw new Error('fixture');
    const inTbilisi = row({ locations: ['თბილისი'] });
    const inBatumi = row({ locations: ['ბათუმი'] });
    const unstated = row({ locations: [] });
    const result = rankOpportunities(
      profile(userTerm('role', 'accountant'), vocabularyTerm('location', tbilisi)),
      indexOpportunities([inTbilisi, inBatumi, unstated]),
      { now: NOW },
    );
    const ids = result.results.map((r) => r.row.opportunityId);
    expect(ids).toContain(inTbilisi.opportunityId);
    expect(ids).toContain(unstated.opportunityId);
    expect(ids).not.toContain(inBatumi.opportunityId);
    expect(result.stats.excludedLocation).toBe(1);
    expect(result.results.find((r) => r.row === unstated)?.locationUnstated).toBe(true);
  });

  it('matches an English city the user typed against Georgian row locations', () => {
    const vocabulary = buildVocabulary([row({ locations: ['თბილისი'] })]);
    const option = vocabulary.locations[0];
    if (option === undefined) throw new Error('fixture');
    const term = vocabularyTerm('location', option);
    expect(term.forms).toContainEqual(phraseStems('Tbilisi'));
  });

  it('matches fields by taxonomy code and does not penalise rows without taxonomy', () => {
    const vocabulary = buildVocabulary([row({ taxonomy: [FINANCE] })]);
    const finance = vocabulary.fields[0];
    if (finance === undefined) throw new Error('fixture');
    const withField = row({ title: 'ბუღალტერი', taxonomy: [FINANCE] });
    const wrongField = row({ title: 'ბუღალტერი', taxonomy: [SALES] });
    const noTaxonomy = row({ title: 'ბუღალტერი' });
    const { results } = rankOpportunities(
      profile(userTerm('role', 'accountant'), vocabularyTerm('field', finance)),
      indexOpportunities([wrongField, noTaxonomy, withField]),
      { now: NOW },
    );
    const score = (r: BundleOpportunity) => results.find((x) => x.row === r)?.score;
    expect(score(withField)).toBe(1);
    expect(score(noTaxonomy)).toBe(1);
    expect(score(wrongField)).toBeLessThan(1);
  });

  it('credits a skill found in a category label and names where', () => {
    const it1 = row({
      title: 'დეველოპერი',
      taxonomy: [{ axis: 'profession', code: 'p-sql', label: 'SQL / მონაცემთა ბაზები' }],
    });
    const { results } = rankOpportunities(
      profile(userTerm('skill', 'SQL')),
      indexOpportunities([it1]),
      { now: NOW },
    );
    expect(results[0]?.reasons).toContainEqual({ kind: 'skill', term: 'SQL', where: 'category' });
  });

  it('returns nothing for rows with no match and ignores inactive terms', () => {
    const inactive = userTerm('role', 'accountant');
    if (inactive === null) throw new Error('fixture');
    inactive.active = false;
    const { results } = rankOpportunities(profile(inactive), indexOpportunities([row()]), {
      now: NOW,
    });
    expect(results).toEqual([]);
  });

  it('orders equal scores by the sooner deadline, then deterministically', () => {
    const later = row({ deadlineAt: '2026-10-20T00:00:00Z' });
    const sooner = row({ deadlineAt: '2026-10-01T00:00:00Z' });
    const none = row();
    const { results } = rankOpportunities(
      profile(userTerm('role', 'accountant')),
      indexOpportunities([none, later, sooner]),
      { now: NOW },
    );
    expect(results.map((r) => r.row)).toEqual([sooner, later, none]);
  });
});
