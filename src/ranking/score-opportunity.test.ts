import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../normalize/text.js';
import {
  type OpportunityForScoring,
  type ProfileClaimForScoring,
  RANKING_EVALUATION_VERSION,
  scoreOpportunity,
} from './score-opportunity.js';

const NOW = '2026-09-06T12:00:00Z';

function claim(
  kind: string,
  value: string,
  extra: { years?: number | null } = {},
): ProfileClaimForScoring {
  return {
    kind,
    value,
    valueNormalized: normalizeTitle(value) ?? '',
    years: extra.years ?? null,
  };
}

function opportunity(overrides: Partial<OpportunityForScoring> = {}): OpportunityForScoring {
  return {
    opportunityId: 'opp-1',
    title: 'Backend Engineer',
    description: 'We need experience with TypeScript, PostgreSQL and Docker.',
    deadlineAt: '2026-10-01T00:00:00Z',
    locations: [],
    canonicalStatus: 'active',
    ...overrides,
  };
}

describe('scoreOpportunity', () => {
  describe('hard filters (§17.2 stage 1)', () => {
    it('never rejects an opportunity for failing to state a location', () => {
      // The single most consequential rule here. jobs.ge publishes no
      // locations at all — 310 of the corpus's 410 listings — so a filter that
      // treated silence as a mismatch would discard three quarters of the
      // corpus while looking like it was working.
      const result = scoreOpportunity(
        opportunity({ locations: [] }),
        [claim('location_preference', 'Tbilisi'), claim('skill', 'TypeScript')],
        { now: NOW },
      );
      expect(result.eligible).toBe(true);
      expect(result.hardFilterReasons).toEqual([]);
    });

    it('applies a location preference only when the listing states a location', () => {
      const matching = scoreOpportunity(
        opportunity({ locations: ['Tbilisi'] }),
        [claim('location_preference', 'Tbilisi')],
        { now: NOW },
      );
      expect(matching.eligible).toBe(true);

      const mismatched = scoreOpportunity(
        opportunity({ locations: ['Batumi'] }),
        [claim('location_preference', 'Tbilisi')],
        { now: NOW },
      );
      expect(mismatched.eligible).toBe(false);
      expect(mismatched.hardFilterReasons[0]?.filter).toBe('location_preference');
    });

    it('rejects an opportunity whose deadline has passed', () => {
      const result = scoreOpportunity(
        opportunity({ deadlineAt: '2026-09-01T00:00:00Z' }),
        [claim('skill', 'TypeScript')],
        { now: NOW },
      );
      expect(result.eligible).toBe(false);
      expect(result.hardFilterReasons[0]?.filter).toBe('deadline_passed');
      expect(result.score).toBeNull();
    });

    it('does not reject an opportunity that states no deadline', () => {
      const result = scoreOpportunity(
        opportunity({ deadlineAt: null }),
        [claim('skill', 'TypeScript')],
        {
          now: NOW,
        },
      );
      expect(result.eligible).toBe(true);
    });

    it('rejects a listing mentioning an excluded profession', () => {
      const result = scoreOpportunity(
        opportunity({ title: 'Sales Manager', description: 'Cold calling and sales targets.' }),
        [claim('excluded_profession', 'sales')],
        { now: NOW },
      );
      expect(result.eligible).toBe(false);
      expect(result.hardFilterReasons[0]?.filter).toBe('excluded_profession');
    });

    it('gives no score at all when a hard filter fires', () => {
      // §17.2 treats hard filtering as a separate funnel stage: a rejected
      // opportunity has no meaningful score, and emitting 0 would make it sort
      // alongside genuinely poor matches instead of being excluded.
      const result = scoreOpportunity(
        opportunity({ deadlineAt: '2026-01-01T00:00:00Z' }),
        [claim('skill', 'TypeScript')],
        { now: NOW },
      );
      expect(result.score).toBeNull();
      expect(result.componentScores).toEqual([]);
    });
  });

  describe('deterministic scoring (§17.2 stage 2)', () => {
    it('scores skill overlap and names both matched and missing skills', () => {
      const result = scoreOpportunity(
        opportunity(),
        [claim('skill', 'TypeScript'), claim('skill', 'PostgreSQL'), claim('skill', 'Kubernetes')],
        { now: NOW },
      );
      const skills = result.componentScores.find((c) => c.component === 'skills');
      expect(skills?.score).toBeCloseTo(2 / 3, 5);
      expect(skills?.matched.sort()).toEqual(['PostgreSQL', 'TypeScript']);
      // §17.2 requires "missing or uncertain requirements" to be surfaced.
      expect(skills?.missing).toEqual(['Kubernetes']);
    });

    it('matches skills as whole words, not substrings', () => {
      // A bare substring test would let a one- or two-letter skill match inside
      // ordinary words in every description and hand every listing a perfect
      // skills score.
      const result = scoreOpportunity(
        opportunity({ title: 'Chef', description: 'Cooking and catering.' }),
        [claim('skill', 'R'), claim('skill', 'Go'), claim('skill', 'C')],
        { now: NOW },
      );
      const skills = result.componentScores.find((c) => c.component === 'skills');
      expect(skills?.matched).toEqual([]);
      expect(skills?.score).toBe(0);
    });

    it('scores a role by similarity to the listing title', () => {
      const close = scoreOpportunity(opportunity(), [claim('role', 'Backend Engineer')], {
        now: NOW,
      });
      const far = scoreOpportunity(opportunity(), [claim('role', 'Pastry Chef')], { now: NOW });

      const closeRole = close.componentScores.find((c) => c.component === 'role');
      const farRole = far.componentScores.find((c) => c.component === 'role');
      expect(closeRole?.score).toBeGreaterThan(farRole?.score ?? 1);
      expect(closeRole?.matched).toHaveLength(1);
      expect(farRole?.missing).toHaveLength(1);
    });

    it('does not let an empty profile outrank a real one', () => {
      // An absent claim is not evidence of a match. If missing skills scored 1
      // "because nothing contradicted them", a blank profile would top every
      // ranking.
      const empty = scoreOpportunity(opportunity(), [], { now: NOW });
      const real = scoreOpportunity(
        opportunity(),
        [claim('skill', 'TypeScript'), claim('role', 'Backend Engineer')],
        { now: NOW },
      );
      expect(real.score ?? 0).toBeGreaterThan(empty.score ?? 0);
    });

    it('does not penalise a listing that names no language requirement', () => {
      // Most listings never mention a language at all; treating that as a
      // failure would drag down almost every score uniformly, which is noise
      // rather than signal.
      const withoutLanguages = scoreOpportunity(opportunity(), [claim('skill', 'TypeScript')], {
        now: NOW,
      });
      const language = withoutLanguages.componentScores.find((c) => c.component === 'language');
      expect(language?.score).toBe(1);
    });

    it('ranks a well-matched opportunity above a poorly-matched one', () => {
      const claims = [
        claim('skill', 'TypeScript'),
        claim('skill', 'PostgreSQL'),
        claim('role', 'Backend Engineer'),
        claim('preferred_profession', 'engineer'),
      ];
      const good = scoreOpportunity(opportunity(), claims, { now: NOW });
      const poor = scoreOpportunity(
        opportunity({
          title: 'Pastry Chef',
          description: 'Baking bread and pastries in a busy kitchen.',
        }),
        claims,
        { now: NOW },
      );
      expect(good.score ?? 0).toBeGreaterThan(poor.score ?? 0);
      expect(good.eligible).toBe(true);
      expect(poor.eligible).toBe(true);
    });

    it('keeps every score within 0-1', () => {
      const result = scoreOpportunity(
        opportunity(),
        [
          claim('skill', 'TypeScript'),
          claim('skill', 'PostgreSQL'),
          claim('skill', 'Docker'),
          claim('role', 'Backend Engineer'),
          claim('language', 'English'),
          claim('preferred_profession', 'engineer'),
        ],
        { now: NOW },
      );
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      for (const component of result.componentScores) {
        expect(component.score).toBeGreaterThanOrEqual(0);
        expect(component.score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('reproducibility and versioning', () => {
    it('is deterministic — identical inputs give an identical result', () => {
      // The phase's exit gate requires reproducible rankings, which is only
      // true while nothing here consults a clock, a model, or randomness.
      const claims = [claim('skill', 'TypeScript'), claim('role', 'Backend Engineer')];
      const first = scoreOpportunity(opportunity(), claims, { now: NOW });
      const second = scoreOpportunity(opportunity(), claims, { now: NOW });
      expect(first).toEqual(second);
    });

    it('stamps the evaluation version on every result', () => {
      const result = scoreOpportunity(opportunity(), [], { now: NOW });
      expect(result.evaluationVersion).toBe(RANKING_EVALUATION_VERSION);
      expect(RANKING_EVALUATION_VERSION).toBe('deterministic-v1');
    });

    it('works on Georgian text, not only Latin', () => {
      // The corpus is majority Georgian; a scorer that only worked on ASCII
      // would score almost every real listing at zero.
      const result = scoreOpportunity(
        opportunity({
          title: 'ბუღალტერი',
          description: 'საჭიროა გამოცდილება ბუღალტერია და ფინანსები მიმართულებით.',
        }),
        [claim('skill', 'ბუღალტერია'), claim('role', 'ბუღალტერი')],
        { now: NOW },
      );
      const skills = result.componentScores.find((c) => c.component === 'skills');
      const role = result.componentScores.find((c) => c.component === 'role');
      expect(skills?.matched).toEqual(['ბუღალტერია']);
      expect(role?.score).toBe(1);
    });
  });
});
