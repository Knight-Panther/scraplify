import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `deploy/export-history.sh` (Phase 17F) with stand-ins for psql, pg_dump,
 * pg_restore and rclone that record their calls. It must export exactly the
 * history tables, refuse a partial export, write each copy once, and never
 * delete anything off the host.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Git for Windows' bash by its path: a bare `bash` there can be WSL's. */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
const BASH = findBash();

const FAKES: Record<string, string> = {
  // Counts each table; the second call (after the dump) adds FAKE_GROWTH rows.
  psql: `#!/bin/sh
cat > /dev/null
echo "psql" >> "$FAKE_LOG"
n=$(cat "$FAKE_DIR/psql-calls" 2>/dev/null || echo 0)
echo $((n + 1)) > "$FAKE_DIR/psql-calls"
extra=0
[ "$n" -eq 0 ] || extra="\${FAKE_GROWTH:-0}"
printf 'public.fx_rates\\t%s\\n' $((336 + extra))
printf 'realestate_archive.listings\\t%s\\n' 13259
`,
  pg_dump: `#!/bin/sh
echo "pg_dump $*" >> "$FAKE_LOG"
for arg in "$@"; do case "$arg" in --file=*) echo dump > "\${arg#--file=}" ;; esac; done
`,
  pg_restore: `#!/bin/sh
echo "pg_restore $*" >> "$FAKE_LOG"
i=0
while [ "$i" -lt "\${FAKE_DATA_TABLES:-2}" ]; do echo "$i; 0 0 TABLE DATA public t$i scraplify"; i=$((i + 1)); done
`,
  rclone: `#!/bin/sh
echo "rclone $*" >> "$FAKE_LOG"
case "$1" in
  copyto) exit "\${FAKE_UPLOAD:-0}" ;;
  size) echo "{\\"count\\":2,\\"bytes\\":\${FAKE_USED:-1000},\\"sizeless\\":0}" ;;
esac
`,
};

describe.skipIf(BASH === null)('deploy/export-history.sh', () => {
  let bin: string;
  let backups: string;
  let logFile: string;

  beforeEach(async () => {
    bin = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-history-'));
    backups = path.join(bin, 'backups');
    logFile = path.join(bin, 'calls.log');
    for (const [name, body] of Object.entries(FAKES)) {
      await fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
    }
    await fs.writeFile(logFile, '');
  });

  afterEach(async () => {
    await fs.rm(bin, { recursive: true, force: true });
  });

  function run(extra: Record<string, string> = {}) {
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const result = spawnSync(BASH ?? 'bash', ['deploy/export-history.sh'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`,
        FAKE_LOG: logFile,
        FAKE_DIR: bin,
        BACKUP_DATABASE_URL: 'postgres://backup@db/scraplify',
        BACKUP_REMOTE: 'offsite:bucket/xtelo',
        HISTORY_REMOTE: 'offsite:bucket/history',
        BACKUP_DIR: backups,
        ...extra,
      },
      encoding: 'utf8',
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const calls = async () =>
    (await fs.readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
  const exports = async () => (await fs.readdir(path.join(backups, 'history'))).sort();

  it('dumps the history tables, by name and strictly, and copies the dump and its counts once', async () => {
    const { code, output } = await run();
    expect(output).toContain('2 tables');
    expect(code).toBe(0);

    const log = await calls();
    const dump = log.find((line) => line.startsWith('pg_dump '));
    expect(dump).toContain('--strict-names');
    expect(dump).toContain('--compress=zstd:9');
    expect(dump?.match(/--table=\S+/g)).toEqual([
      '--table=realestate_archive.*',
      '--table=public.source_listing_revisions',
      '--table=public.source_listing_status_events',
      '--table=public.fx_rates',
    ]);
    const uploads = log.filter((line) => line.startsWith('rclone copyto'));
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload).toMatch(/--checksum --immutable .* offsite:bucket\/history\/xtelo-history-/);
    }
    expect(log.some((line) => /rclone (delete|deletefile|purge|sync|move)/.test(line))).toBe(false);

    const files = await exports();
    expect(files.map((name) => name.replace(/\d{8}-\d{6}/, 'T'))).toEqual([
      'xtelo-history-T.counts',
      'xtelo-history-T.dump',
    ]);
    const counts = await fs.readFile(path.join(backups, 'history', files[0] as string), 'utf8');
    expect(counts).toBe('public.fx_rates\t336\t336\nrealestate_archive.listings\t13259\t13259\n');
  });

  it('records the rows before and after when the history grows during the dump', async () => {
    expect((await run({ FAKE_GROWTH: '4' })).code).toBe(0);
    const files = await exports();
    const counts = await fs.readFile(path.join(backups, 'history', files[0] as string), 'utf8');
    expect(counts.split('\n')[0]).toBe('public.fx_rates\t336\t340');
  });

  it("refuses the nightly copies' folder, whose copies expire", async () => {
    const { code, output } = await run({ HISTORY_REMOTE: 'offsite:bucket/xtelo/' });
    expect(code).toBe(1);
    expect(output).toContain('folder of its own');
    expect(await calls()).toEqual([]);
  });

  it('fails, uploads nothing and leaves no file when a table has no data in the dump', async () => {
    const { code, output } = await run({ FAKE_DATA_TABLES: '1' });
    expect(code).toBe(1);
    expect(output).toContain('holds data for 1 tables, expected 2');
    expect((await calls()).some((line) => line.startsWith('rclone'))).toBe(false);
    expect(await exports()).toEqual([]);
  });

  it('fails the run when the upload fails', async () => {
    expect((await run({ FAKE_UPLOAD: '1' })).code).not.toBe(0);
  });

  it('warns over the budget and still deletes nothing', async () => {
    const { code, output } = await run({ FAKE_USED: '2000000000' });
    expect(code).toBe(0);
    expect(output).toContain('WARNING: the history exports take more');
    expect((await calls()).some((line) => /rclone (delete|deletefile|purge)/.test(line))).toBe(
      false,
    );
  });

  it('keeps the newest exports on the host, each with its counts', async () => {
    const dir = path.join(backups, 'history');
    await fs.mkdir(dir, { recursive: true });
    for (const stamp of ['20260101-100000', '20260201-100000']) {
      await fs.writeFile(path.join(dir, `xtelo-history-${stamp}.dump`), 'old');
      await fs.writeFile(path.join(dir, `xtelo-history-${stamp}.counts`), 'old');
    }
    expect((await run({ HISTORY_RETENTION_COUNT: '2' })).code).toBe(0);
    const files = await exports();
    expect(files).toHaveLength(4);
    expect(files.some((name) => name.includes('20260101'))).toBe(false);
  });

  it('with HISTORY_REMOTE=none, keeps the export here and says so', async () => {
    const { code, output } = await run({ HISTORY_REMOTE: 'none' });
    expect(code).toBe(0);
    expect(output).toContain('exists on this host only');
    expect((await calls()).some((line) => line.startsWith('rclone'))).toBe(false);
  });
});
