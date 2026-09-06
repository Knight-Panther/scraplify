# Georgian typography

**Read this before choosing a font.** This is the constraint most likely to make
Xtelo look broken, and it is invisible to anyone testing with Latin placeholder
text. Measured against the live 410-listing corpus:

- **388 of 410 titles are Georgian script only.**
- **22 mix Georgian and Latin inside a single string** — `უფროსი Android
  დეველოპერი`, `ობიექტის MEP ინჟინერი`, `SINSAY-ს მაღაზიის გაყიდვების ასისტენტი`,
  `AI დიზაინერი`.

That second group is the trap. If the chosen font has no Georgian coverage, the
browser silently falls back for just the Georgian runs — so a single heading
renders in **two different typefaces**, with mismatched weight, x-height and
colour. It looks like a bug, and it will not appear in any Latin test content.

## Rules

1. **The primary UI font must cover Georgian (Unicode U+10A0–U+10FF).**
   Inter, Geist and most fashionable UI sans faces do **not**. Verify coverage
   before committing to a family — do not assume.

2. **Prefer one family that covers both scripts.** `Noto Sans Georgian` is the
   safe, complete choice and pairs with `Noto Sans` for Latin by design. BPG
   families (BPG Arial, BPG Nino) are common in Georgian products and acceptable
   if licensing is checked. Whatever is chosen, Latin and Georgian must have
   matching weights and visually matching x-heights, or mixed strings will look
   ransom-noted.

3. **If two families are unavoidable, declare Georgian first in the stack** and
   test a mixed string at every weight actually used.

4. **Never apply `text-transform: uppercase` to content that may be Georgian.**
   Georgian Mkhedruli is unicase — it has no capital letters. Uppercasing either
   does nothing or, in fonts with the feature, maps to Mtavruli forms, which read
   as shouting in an unrelated style. This kills the ALL-CAPS eyebrow label
   pattern outright, which is convenient: `frontend-design` lists it as a
   generated-page tell anyway. Applies to labels, buttons, table headers and
   badges — anywhere user data or Georgian UI copy can appear.

5. **Give Georgian more line-height than a Latin-only design would use.**
   Mkhedruli has pronounced ascenders and descenders and no capitals, so tight
   leading collides. Start around `1.6` for body text and do not go below `1.4`
   for headings. Verify in the browser with real listing titles.

6. **Do not letter-space Georgian.** Tracking tuned for Latin caps damages
   Georgian legibility.

7. **Truncate by grapheme, never by byte or UTF-16 code unit.** Georgian
   characters are multi-byte. Use CSS (`text-overflow: ellipsis`,
   `-webkit-line-clamp`) rather than cutting strings in JavaScript. If a string
   truly must be cut in code, use `Intl.Segmenter`.

8. **Test search with Georgian input.** The listings screen has a text filter.
   Georgian has no case, so case-insensitive matching is a no-op — but
   normalization is not: verify NFC/NFD handling so pasted text matches typed text.

## Checking coverage

Render this string in the chosen font at every weight used, and confirm a single
consistent typeface across it:

```
უფროსი Android დეველოპერი — SINSAY-ს ასისტენტი (2026)
```

If the Latin and Georgian runs look like different fonts, the stack is wrong.
