import { writeFile } from 'node:fs/promises';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { ssGeSource } from '../policies/ss-ge.js';
import {
  formatOfficialReport,
  loadOfficialReport,
  REPORT_STREETS_SHOWN,
} from '../realestate/places/official-report.js';

/**
 * How ss.ge's Tbilisi areas sit on the official map, for the owner's
 * once-over (`npm run places:official-report`, Phase 14B): per area its
 * official shares, and per sub-district its split streets. Markdown on
 * stdout, or JSON with `--json`; `--streets=N` streets per list (default
 * 15; the JSON has all); `--out=<file>` writes the file instead. Reads only,
 * in one read-only snapshot, so it can run beside a crawl.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const streets = Number(value('streets') ?? REPORT_STREETS_SHOWN);
  if (!Number.isInteger(streets) || streets < 0) {
    throw new Error(`--streets must be a whole number, not ${value('streets')}`);
  }
  const report = await db.transaction(
    (tx) =>
      loadOfficialReport(tx, {
        sourceId: ssGeSource.id,
        at: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const text = args.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatOfficialReport(report, { streets });
  const out = value('out');
  if (out === undefined) process.stdout.write(text);
  else await writeFile(out, text, 'utf8');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'ss.ge official report failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
