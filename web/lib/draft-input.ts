import {
  type DraftLanguage,
  MAX_DRAFT_BODY_CHARS,
  MAX_DRAFT_SUBJECT_CHARS,
} from '../../src/outreach/draft-store.js';

/**
 * Reading the outreach draft screens' form bodies (Phase 6A). Same reasoning as
 * `profile-input.ts`: ids are validated here, because a malformed uuid reaches
 * Postgres as an error rather than an empty result.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Re-exported under this form's own name rather than defined here: the
// domain layer (`draft-store.ts`) owns the real bound, since `generate-draft.ts`
// and `createDraft` both check a model's output against it too. One
// constant, not two that could drift.
export const MAX_BODY_CHARS = MAX_DRAFT_BODY_CHARS;
const MAX_SUBJECT_CHARS = MAX_DRAFT_SUBJECT_CHARS;

type FormLike = { get(name: string): FormDataEntryValue | null };

export class InvalidDraftInputError extends Error {
  readonly code = 'INVALID_DRAFT_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDraftInputError';
  }
}

function text(form: FormLike, name: string): string {
  const raw = form.get(name);
  return typeof raw === 'string' ? raw : '';
}

function readUuid(form: FormLike, name: string, what: string): string {
  const id = text(form, name).trim();
  if (!UUID.test(id)) throw new InvalidDraftInputError(`A valid ${what} id is required.`);
  return id;
}

export const readDraftId = (form: FormLike) => readUuid(form, 'draftId', 'draft');
export const readOpportunityId = (form: FormLike) => readUuid(form, 'opportunityId', 'opportunity');
export const readDraftProfileId = (form: FormLike) => readUuid(form, 'profileId', 'profile');

/** `ka`, `en`, or undefined to use the listing's own language. */
export function readLanguage(form: FormLike): DraftLanguage | undefined {
  const value = text(form, 'language');
  if (value === 'ka' || value === 'en') return value;
  if (value === '' || value === 'auto') return undefined;
  throw new InvalidDraftInputError('Choose Georgian, English, or the listing’s language.');
}

/**
 * §23.2: profile data leaves the machine only when the person knowingly asks.
 * Required on every generation, the same way Phase 5's upload requires it.
 */
export function readGenerationConsent(form: FormLike): boolean {
  return form.get('consent') === 'on';
}

/**
 * The profile version, opportunity revision and listing revision the
 * confirmation screen rendered — echoed back through hidden fields so
 * `generateDraft` can refuse if either moved before the button was pressed.
 * All three are values `/drafts/new` always renders, so a missing or
 * malformed one means the form was tampered with or the request forged, not
 * a legitimate submission; refuse rather than silently skip the check.
 */
export function readExpectedGenerationInputs(form: FormLike): {
  profileVersion: number;
  opportunityRevisionId: string;
  listingRevisionId: string;
} {
  const profileVersionRaw = text(form, 'expectedProfileVersion');
  const profileVersion = Number(profileVersionRaw);
  if (!Number.isInteger(profileVersion) || profileVersion < 1) {
    throw new InvalidDraftInputError('Reload this screen and try again.');
  }
  return {
    profileVersion,
    opportunityRevisionId: readUuid(form, 'expectedOpportunityRevisionId', 'opportunity revision'),
    listingRevisionId: readUuid(form, 'expectedListingRevisionId', 'listing revision'),
  };
}

export function readDraftEdit(form: FormLike): { subject: string | null; body: string } {
  const body = text(form, 'body').replace(/\r\n/g, '\n');
  if (body.trim() === '') throw new InvalidDraftInputError('The draft cannot be empty.');
  if (body.length > MAX_BODY_CHARS) {
    throw new InvalidDraftInputError(`The draft is longer than ${MAX_BODY_CHARS} characters.`);
  }
  const subjectRaw = form.get('subject');
  const subjectTrimmed = typeof subjectRaw === 'string' ? subjectRaw.trim() : '';
  // '' and absent both mean "no subject" — normalized to the same `null` a
  // generated draft's empty subject is stored as (see `writeDraft`), so
  // saving an untouched email whose subject was blank doesn't turn into a
  // '' !== null hash mismatch that silently withdraws a current approval.
  const subject = subjectTrimmed === '' ? null : subjectTrimmed;
  if (subject !== null && subject.length > MAX_SUBJECT_CHARS) {
    throw new InvalidDraftInputError('The subject line is too long.');
  }
  return { subject, body };
}

/** The content hash rendered into the approve form — what the person was looking at. */
export function readExpectedContentHash(form: FormLike): string {
  const hash = text(form, 'contentHash').trim();
  if (!SHA256_HEX.test(hash)) {
    throw new InvalidDraftInputError('Reload the draft and review it before approving.');
  }
  return hash;
}

/**
 * A safe-across-browsers ceiling for a `mailto:` URI. There is no single
 * standard limit — old IE capped full URLs around 2,083 characters, and
 * mail clients and OS protocol handlers (which `mailto:` hands off to,
 * unlike an in-page link) impose their own, generally tighter ones — so this
 * is a conservative bound comfortably under the smallest commonly cited
 * figure, not a measured limit of any specific target.
 */
const MAX_MAILTO_HREF_CHARS = 1800;

/**
 * A `mailto:` link carrying the approved draft, so pressing send stays with the
 * person and their own mail client — or `null` if the encoded link would be
 * unsafe to hand to one. `encodeURIComponent` on every part; line breaks as
 * CRLF per RFC 6068.
 *
 * The allowed draft body is up to 20,000 characters, and Georgian text
 * expands under percent-encoding (each character becomes multiple `%XX`
 * triples), so an approved draft can legitimately produce a `mailto:` URI
 * well past what a browser, OS protocol handler, or mail client reliably
 * accepts — silent truncation of an approved letter would be worse than not
 * offering the shortcut. The caller already handles `null` (it means "no
 * safe mailto link" the same way "not an email draft" already does) by
 * falling back to Copy, which has no such bound.
 */
export function mailtoHref(recipient: string, subject: string | null, body: string): string | null {
  const params = [
    ...(subject ? [`subject=${encodeURIComponent(subject)}`] : []),
    `body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`,
  ];
  const href = `mailto:${encodeURIComponent(recipient).replace(/%40/g, '@')}?${params.join('&')}`;
  return href.length > MAX_MAILTO_HREF_CHARS ? null : href;
}
