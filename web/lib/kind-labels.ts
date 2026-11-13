import type { OpportunityType } from '../../src/domain/opportunity.js';
import type { Locale } from './locale.js';

/**
 * What an opportunity is, in a word, in both languages (Phase 15B). The
 * English is what every screen prints (`labels.ts` reads it from here); the
 * Georgian is for the bilingual pages. The owner read the Georgian on
 * 2026-11-13 and chose "საზაფხულო სკოლა" and "გრანტები".
 *
 * `summer_school` reads "course / school" in English because the source lists
 * winter, spring and autumn courses under the same kind.
 */
const KIND_LABELS: Record<OpportunityType, Record<Locale, string>> = {
  job: { en: 'job', ka: 'ვაკანსია' },
  tender: { en: 'tender', ka: 'ტენდერი' },
  summer_school: { en: 'course / school', ka: 'საზაფხულო სკოლა' },
  scholarship: { en: 'scholarship', ka: 'სტიპენდია' },
  grant: { en: 'grant', ka: 'გრანტები' },
  internship: { en: 'internship abroad', ka: 'სტაჟირება საზღვარგარეთ' },
  volunteering: { en: 'volunteering', ka: 'მოხალისეობა' },
  competition: { en: 'competition', ka: 'კონკურსი' },
  event: { en: 'event', ka: 'ღონისძიება' },
};

const UNKNOWN: Record<Locale, string> = { en: 'unrecognised kind', ka: 'უცნობი ტიპი' };

/**
 * The kinds that are neither a vacancy nor a tender, in the order people look
 * for them: courses first, then money for study, then the rest. Browse's Kind
 * filter lists them after job and tender in this order.
 */
export const PROGRAMME_KIND_ORDER = [
  'summer_school',
  'scholarship',
  'grant',
  'internship',
  'volunteering',
  'competition',
  'event',
] as const satisfies readonly OpportunityType[];

/** The kind's word in `locale`; a kind this build does not know says so instead of its raw value. */
export function kindLabel(type: string, locale: Locale): string {
  return (KIND_LABELS[type as OpportunityType] ?? UNKNOWN)[locale];
}
