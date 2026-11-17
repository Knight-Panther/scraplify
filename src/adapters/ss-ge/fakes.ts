import { readFileSync } from 'node:fs';

/**
 * The reserved fake poster and photo values (`reserved-fakes.json`), for
 * tests only: this repository is public, so no real ss.ge account id, phone
 * or photo path is ever written into it. Never imported by running code.
 */
const RESERVED = JSON.parse(
  readFileSync(new URL('./reserved-fakes.json', import.meta.url), 'utf8'),
) as { userIdPrefix: string; photoGuid: string; phoneNationalPrefix: string };

const twoDigits = (n: number) => {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error(`fake number ${n} is not 0 to 99`);
  return String(n).padStart(2, '0');
};

/** A fake ss.ge account id: `00000000-0000-4000-8000-0000000000NN`. */
export const fakeUserId = (n: number) => `${RESERVED.userIdPrefix}${twoDigits(n)}`;

/** The GUID every fake photo path carries. */
export const FAKE_PHOTO_GUID = RESERVED.photoGuid;

/** A fake Georgian mobile in +995 form: `+9955000000NN`. */
export const fakePhone = (n: number) => `+995${RESERVED.phoneNationalPrefix}${twoDigits(n)}`;

/** The same phone as a poster might type it: `500 00 00 NN`. */
export const fakePhoneTyped = (n: number) => {
  const digits = `${RESERVED.phoneNationalPrefix}${twoDigits(n)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}`;
};

/** A fake photo's file name as a page shows it, with a size word or none. */
export const fakePhotoFileName = (day: string, index: number, size?: string) =>
  `https://static.ss.ge/${day}/${index}_${FAKE_PHOTO_GUID}${size === undefined ? '' : `_${size}`}.jpg`;

/** A reserved fake account id. */
export const FAKE_USER_ID_RE = new RegExp(`^${RESERVED.userIdPrefix}\\d{2}$`);
