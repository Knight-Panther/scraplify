# Rights and licences

Phase 8E release item (change.md §11: "Public deployment is gated on documented permission/terms for crawling and republishing each source. Technical access is not publication authority"). This file records what is known and what is still owed. Last checked 2026-09-26.

## Verdict

**Public deployment is blocked only on hr.ge's republication permission.** The code side is clean: every shipped dependency is under a permissive licence, and the one shipped model is MIT-derived (see Models). The owner has permission from jobs.ge (recorded 2026-09-26), and the site assets come from free sources.

## Sources

Crawling behaviour follows each source's `robots.txt` and a versioned policy record (`source_policies`; concept §5.3). Robots rules do not grant permission to republish.

| Source | robots.txt | Terms reviewed | Written permission or official feed | What the public site shows |
| --- | --- | --- | --- | --- |
| jobs.ge | allows listing pages; `Crawl-delay: 5` honoured | settled by permission | **granted:** the owner has full permission from jobs.ge (recorded 2026-09-26). Settled; not to be re-questioned. | title, employer, dates, a link back to jobs.ge. Descriptions are shown only where the source policy allows (redacted in SQL, Phase 8B). |
| hr.ge | allows public paths | **owner to record** | **none yet** | the same, plus hr.ge's own category labels |

Checked 2026-09-26: `terms_url` is empty in both live policy rows (acquisition reviews dated 2026-09-03 and 2026-09-05, owner "project owner"). Those reviews covered acquisition, not republication.

**Owner action (hr.ge only):** record the terms URL, the date it was read, and the decision in its `source_policies` row (`terms_url`, review date, notes, decision owner). Where practical, ask for written permission or an official feed first (concept §5.3). Until then, the public surface should not be announced.

## Site assets

| Asset | Licence | Status |
| --- | --- | --- |
| Noto Sans Georgian, Space Mono, Bebas Neue | SIL Open Font License 1.1 | Fine. `next/font` downloads them at build time and serves them from our own origin. |
| `web/public/hero-bg.mp4` (landing background video) | free source (owner, 2026-09-26) | Fine. 5.8 MB: re-encode if it slows the landing page. |
| `web/public/logo.png`, `web/app/icon.svg` | free source (owner, 2026-09-26) | Fine. |

## Models

| Model | Shipped as | Licence | Status |
| --- | --- | --- | --- |
| `static-e1-v1` (CV Ranked title similarity) | `matching-models/static-e1-v1/` (`model.json` 1.1 MB, `table.int8` 8.9 MB; ~8 MB gzipped), served by `/api/matching/models/…` and run in the visitor's browser | MIT: derived from `intfloat/multilingual-e5-small` (MIT, per its model card) by distillation with Model2Vec (MIT), vocabulary pruning and int8 quantisation. The tokenizer pieces and scores come from the same e5 release. | Fine. MIT permits redistribution of derived weights; the copyright notice travels with the provenance note in `src/matching/models/static-e1.ts`. |

No other model is shipped. `src/matching/embed.ts` still pins the full e5 ONNX port for Node-side evaluation only; it is never served to a browser. Any further model gets a row here before it ships (change.md §11).

## Dependencies

Production dependency tree (`npm ls --omit=dev --all`): 131 packages, all under permissive licences.

| Licence | Packages |
| --- | --- |
| MIT | 85 |
| BSD-2-Clause | 13 |
| BSD-3-Clause | 12 |
| Apache-2.0 | 8, including `pdfjs-dist@6.3.289` |
| ISC | 7 |
| Unlicense | `fast-sha256` |
| BSD | `duck` |
| MIT OR CC0-1.0 | `type-fest` |
| MIT AND Zlib | `pako` |
| MIT OR GPL-3.0-or-later | `jszip`. **Used under MIT.** |
| Apache-2.0 AND LGPL-3.0-or-later | `@img/sharp-*` platform binaries. libvips is LGPL and dynamically linked, so the obligation is attribution and allowing it to be replaced, which an unmodified npm install already allows. |

`npm audit` (all dependencies, 2026-09-26): **0 vulnerabilities.**

To regenerate the inventory, walk `npm ls --omit=dev --all --long --json` and read each package's `license` field from its installed `package.json`. The Phase 8E commit that added this file records the exact one-liner used.
