import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { db } from '../db/client.js';
import {
  createCandidateProfile,
  deleteCandidateProfile,
  listCandidateProfiles,
  loadCandidateProfile,
} from '../ranking/profile-store.js';
import { listRankedOpportunities, runRanking } from '../ranking/run-ranking.js';

/**
 * Candidate profile management and deterministic ranking (§17).
 *
 * The profile is supplied as a reviewed JSON file rather than extracted from a
 * PDF. §17.1 calls for a *reviewed* profile that the user can correct before
 * ranking, and a hand-checked file is the most direct form of that — automatic
 * CV parsing adds an extraction step whose errors would need reviewing anyway,
 * so it belongs after this works, not before.
 *
 * Nothing here prints claim values or evidence spans beyond what the operator
 * asked to see, and nothing logs them: §21.1 lists CV contents alongside
 * credentials as data to redact.
 */

interface ProfileFile {
  label: string;
  claims: Array<{
    kind: string;
    value: string;
    evidence?: string | null;
    origin?: string;
    confidence?: number;
    years?: number | null;
  }>;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: 'string' },
      profile: { type: 'string' },
      limit: { type: 'string' },
      force: { type: 'boolean', default: false },
      'include-ineligible': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const command = positionals[0];
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  switch (command) {
    case 'profile:create': {
      if (values.file === undefined)
        throw new Error('profile:create requires --file <profile.json>');
      const parsed = JSON.parse(await readFile(values.file, 'utf8')) as ProfileFile;
      const created = await createCandidateProfile(db, {
        label: parsed.label,
        claims: parsed.claims,
        now: new Date().toISOString(),
      });
      console.log(`created profile ${created.profileId} (version ${created.version})`);
      console.log(`  ${parsed.claims.length} claim(s)`);
      break;
    }

    case 'profile:list': {
      const profiles = await listCandidateProfiles(db);
      if (values.json) {
        console.log(JSON.stringify(profiles, null, 2));
        break;
      }
      console.log(`${profiles.length} profile(s)`);
      for (const profile of profiles) {
        console.log(`  ${profile.profileId}  v${profile.version}  ${profile.label}`);
      }
      break;
    }

    case 'profile:show': {
      if (values.profile === undefined) throw new Error('profile:show requires --profile <id>');
      const profile = await loadCandidateProfile(db, values.profile);
      if (profile === null) throw new Error(`no active profile with id ${values.profile}`);
      if (values.json) {
        console.log(JSON.stringify(profile, null, 2));
        break;
      }
      console.log(`${profile.label}  (version ${profile.version})`);
      for (const claim of profile.claims) {
        console.log(`  ${claim.kind.padEnd(22)} ${claim.value}`);
      }
      break;
    }

    case 'profile:delete': {
      if (values.profile === undefined) throw new Error('profile:delete requires --profile <id>');
      // A real purge across profile, claims and cached rankings (§6.2), not a
      // flag — see deleteCandidateProfile.
      const result = await deleteCandidateProfile(db, values.profile);
      if (!result.profileDeleted) throw new Error(`no profile with id ${values.profile}`);
      console.log(
        `deleted profile, ${result.claimsDeleted} claim(s) and ${result.rankingsDeleted} cached ranking(s)`,
      );
      break;
    }

    case 'rank': {
      if (values.profile === undefined) throw new Error('rank requires --profile <id>');
      const result = await runRanking(db, { profileId: values.profile, force: values.force });
      console.log(
        `ranked ${result.scored} of ${result.opportunitiesConsidered} opportunit(ies) ` +
          `(${result.cacheHits} cached, ${result.filteredOut} filtered out) ` +
          `profile v${result.profileVersion}, ${result.evaluationVersion}`,
      );
      break;
    }

    case 'results': {
      if (values.profile === undefined) throw new Error('results requires --profile <id>');
      const rows = await listRankedOpportunities(db, {
        profileId: values.profile,
        includeIneligible: values['include-ineligible'],
        ...(limit === undefined ? {} : { limit }),
      });
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      console.log(`${rows.length} ranked opportunit(ies)`);
      for (const row of rows) {
        const score = row.score === null ? 'filtered' : row.score.toFixed(3);
        console.log(`\n  ${score.padStart(8)}  ${row.canonicalTitle}`);
        // §17.2 requires the result to explain itself, so the components and
        // the evidence behind them are printed, not just the number.
        for (const component of (row.componentScores as Array<{
          component: string;
          score: number;
          matched: string[];
          missing: string[];
        }>) ?? []) {
          const matched =
            component.matched.length > 0 ? ` matched: ${component.matched.join(', ')}` : '';
          const missing =
            component.missing.length > 0 ? ` missing: ${component.missing.join(', ')}` : '';
          console.log(
            `            ${component.component.padEnd(20)} ${component.score.toFixed(2)}${matched}${missing}`,
          );
        }
        for (const reason of (row.hardFilterReasons as Array<{ filter: string; detail: string }>) ??
          []) {
          console.log(`            FILTERED (${reason.filter}): ${reason.detail}`);
        }
      }
      break;
    }

    default:
      throw new Error(
        `unknown command "${command ?? ''}" — expected one of: ` +
          'profile:create, profile:list, profile:show, profile:delete, rank, results',
      );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
