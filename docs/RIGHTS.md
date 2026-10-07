# Rights and licences

Phase 8E release item (`docs/archive/change.md` §11: "Public deployment is gated on documented permission/terms for crawling and republishing each source. Technical access is not publication authority"). This file records what is known and what is still owed. Last checked 2026-09-26; the assets and the repository's licence were updated on 2026-09-30, and the dependency count and audit line on 2026-10-05.

## Verdict

**Nothing rights-related blocks public deployment.** The owner has permission from jobs.ge and hr.ge (both recorded 2026-09-26) and from etenders.ge (recorded 2026-10-07). The code side is clean: every shipped dependency is under a permissive licence, and the one shipped model and the build-time model behind the title vectors are both MIT (see Models). The site assets come from free sources.

## Sources

Crawling behaviour follows each source's `robots.txt` and a versioned policy record (`source_policies`; concept §5.3). Robots rules do not grant permission to republish.

| Source | robots.txt | Terms reviewed | Written permission or official feed | What the public site shows |
| --- | --- | --- | --- | --- |
| jobs.ge | allows listing pages; its generic `Crawl-delay: 5` (unchanged since 2019) is waived under the permission: one request at a time, backing off on 429/503 (policy v2, 2026-09-26) | settled by permission | **granted:** the owner has full permission from jobs.ge (recorded 2026-09-26). Settled; not to be re-questioned. | title, employer, dates, a link back to jobs.ge. Descriptions are shown only where the source policy allows (redacted in SQL, Phase 8B). |
| hr.ge | allows public paths | settled by permission | **granted:** the owner has full permission from hr.ge (recorded 2026-09-26). Settled; not to be re-questioned. | the same, plus hr.ge's own category labels |
| etenders.ge | none (404) and no sitemap; 3 s between requests, one at a time (policy v1, 2026-10-07) | read 2026-10-05: no clause on automated access; posted information is open to all users except bids, invite-only details and anonymous buyers (`termsUrl` in the policy) | **granted:** the owner asked etenders.ge and has its confirmation (recorded 2026-10-07). Settled; not to be re-questioned. | not shown publicly yet (Phase 9C). Planned: structured tender fields, CPV labels, a document count and a link back; no descriptions, Q&A, documents or logos (`docs/addEtender.md` §13–14). Invite-only and anonymous tenders are never fetched. |

Checked 2026-09-26: `terms_url` is empty in both live policy rows (acquisition reviews dated 2026-09-03 and 2026-09-05, owner "project owner"). Those reviews covered acquisition, not republication.

No owner action remains for any source.

## Site assets

| Asset | Licence | Status |
| --- | --- | --- |
| Noto Sans Georgian, Space Mono, Bebas Neue | SIL Open Font License 1.1 | Fine. `next/font` downloads them at build time and serves them from our own origin. |
| `web/public/hero-bg.v2.mp4`, `hero-bg.v2-640.mp4` and the `hero-poster.v2*.webp` posters (landing background video) | free source (owner, 2026-09-26) | Fine. Re-encoded from the original 5.8 MB video on 2026-09-28 (1.4 MB and 0.7 MB). |
| `web/public/logo.v2.webp`, `web/app/icon.svg`, `favicon.ico`, `apple-icon.png` | free source (owner, 2026-09-26) | Fine. The WebP logo is a re-encode of the original PNG. |
| `web/app/opengraph-image.jpg` (link-preview banner) | ours | Made on 2026-09-28 from the site's own hero copy. |

## Models

| Model | Shipped as | Licence | Status |
| --- | --- | --- | --- |
| `static-e1-v1` (CV Ranked title similarity) | `matching-models/static-e1-v1/` (`model.json` 1.1 MB, `table.int8` 8.9 MB; ~8 MB gzipped), served by `/api/matching/models/…` and run in the visitor's browser | MIT: derived from `intfloat/multilingual-e5-small` (MIT, per its model card) by distillation with Model2Vec (MIT), vocabulary pruning and int8 quantisation. The tokenizer pieces and scores come from the same e5 release. | Fine. MIT permits redistribution of derived weights; the copyright notice travels with the provenance note in `src/matching/models/static-e1.ts`. |
| `bge-small-en-v1.5` (CV Ranked title vectors, bundle schema 2) | **Not shipped.** It runs only in the worker's daily bundle build, from `/var/lib/xtelo/models` (`Xenova/bge-small-en-v1.5` at a pinned revision, q8 ONNX, 34 MB). What ships is its output: int8 vectors for the lexicon's role labels and the vacancy title keys, in `title-vectors.int8` and `title-vectors.json` of each bundle. | MIT: `BAAI/bge-small-en-v1.5` (MIT, per its model card), ONNX conversion by Xenova, same licence. | Fine. MIT permits using the model and distributing what it computes; the provenance is in `src/matching/models/bge-small-en.ts`. |

No other model is shipped or run in production. `src/matching/embed.ts` still pins the full e5 ONNX port for Node-side evaluation only; it is never served to a browser. Any further model gets a row here before it ships (`docs/archive/change.md` §11).

## Dependencies

Production dependency tree (`npm ls --omit=dev --all`, recounted 2026-10-05 on a Windows install): 158 distinct name@version entries, all under permissive licences. The count depends on the platform, because optional native packages (for example the `@img/sharp-*` binaries) differ per OS. The earlier figure of 131 (2026-09-26) came from an older tree.

| Licence | Packages |
| --- | --- |
| MIT | 101 |
| BSD-2-Clause | 14 |
| BSD-3-Clause | 13 |
| Apache-2.0 | 13, including `pdfjs-dist@6.3.289` |
| ISC | 9 |
| 0BSD | `tslib` |
| CC-BY-4.0 | `caniuse-lite`. Browser-support data, not code, pulled in by `next`. Attribution applies if the data itself is redistributed. |
| Unlicense | `fast-sha256` |
| BSD | `duck` |
| MIT OR CC0-1.0 | `type-fest` |
| MIT AND Zlib | `pako` |
| MIT OR GPL-3.0-or-later | `jszip`. **Used under MIT.** |
| Apache-2.0 AND LGPL-3.0-or-later | `@img/sharp-*` platform binaries. libvips is LGPL and dynamically linked, so the obligation is attribution and allowing it to be replaced, which an unmodified npm install already allows. |

`npm audit` (all dependencies): **0 vulnerabilities** on 2026-10-05. On 2026-09-30 it had reported 1 high, `undici` 8.10.1, the crawler's HTTP client. `undici` 8.11.2 and `next` 16.3.8 were installed that day.

## This repository's licence

Since 2026-09-30 the original code and documentation are under the MIT License (`LICENSE`). It does not extend to material owned by others, which keeps its own terms:

- **Source content.** The saved pages and vacancy texts in `src/adapters/*/fixtures/` and `src/matching/eval/fixtures/` belong to jobs.ge, hr.ge and the employers who posted them. They are kept only to test parsing and matching.
- **Vendored work.** The `static-e1-v1` model (see Models) is MIT under its author's copyright.
- **Site assets.** They are listed above, from free sources under their own terms.
- **Names.** Xtelo and jobster are not licensed.

To regenerate the inventory, walk `npm ls --omit=dev --all --long --json` and read each package's `license` field from its installed `package.json`. The Phase 8E commit that added this file records the exact one-liner used.
