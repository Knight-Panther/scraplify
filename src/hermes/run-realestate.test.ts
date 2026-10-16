import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `deploy/run-realestate.sh` itself, with a stand-in for `node`, as
 * `run-pipeline.test.ts` does for the job boards: the crawl's exit code is
 * the script's, whatever the hook does.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

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

const FAKE_NODE = `#!/bin/sh
# Stands in for node in run-realestate.test.ts.
echo "$*" >> "$FAKE_NODE_LOG"
case "$1" in
  dist/cli/run-*-crawl.js)
    [ -z "\${FAKE_CRAWL_SLEEP:-}" ] || sleep "$FAKE_CRAWL_SLEEP"
    exit "\${FAKE_CRAWL:-0}"
    ;;
  dist/cli/hermes-event.js) exit "\${FAKE_HERMES:-0}" ;;
esac
exit 97
`;

const EVENT = (code: number, crawl: string) =>
  new RegExp(
    `^dist/cli/hermes-event\\.js --source=ss-ge --started-at=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ --crawl=${crawl} --exit-code=${code}$`,
  );

describe.skipIf(BASH === null)('deploy/run-realestate.sh', () => {
  let bin: string;
  let logFile: string;

  beforeEach(async () => {
    bin = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-realestate-'));
    logFile = path.join(bin, 'calls.log');
    await fs.writeFile(path.join(bin, 'node'), FAKE_NODE, { mode: 0o755 });
    await fs.writeFile(logFile, '');
  });

  afterEach(async () => {
    await fs.rm(bin, { recursive: true, force: true });
  });

  function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.HERMES_HOOK_ENABLED;
    return {
      ...env,
      [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`,
      FAKE_NODE_LOG: logFile,
      ...extra,
    };
  }

  async function run(args: string[], extra: Record<string, string> = {}) {
    await fs.writeFile(logFile, '');
    const result = spawnSync(BASH ?? 'bash', ['deploy/run-realestate.sh', ...args], {
      cwd: REPO_ROOT,
      env: environment(extra),
      encoding: 'utf8',
    });
    const calls = (await fs.readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
    return { code: result.status, calls, output: `${result.stdout}${result.stderr}` };
  }

  it.each([0, 1, 3])(
    'returns the crawl code %i with the hook unset, set, or failing to write',
    async (crawl) => {
      const crawlEnv = { FAKE_CRAWL: `${crawl}` };
      const unset = await run(['ss-ge'], crawlEnv);
      const set = await run(['ss-ge'], { ...crawlEnv, HERMES_HOOK_ENABLED: '1' });
      const unwritable = await run(['ss-ge'], {
        ...crawlEnv,
        HERMES_HOOK_ENABLED: '1',
        FAKE_HERMES: '1',
      });

      expect([unset.code, set.code, unwritable.code]).toEqual([crawl, crawl, crawl]);
      expect(unset.calls).toEqual(['dist/cli/run-ss-ge-crawl.js']);
      expect(set.calls).toHaveLength(2);
      expect(set.calls[1]).toMatch(EVENT(crawl, `${crawl}`));
      expect(unwritable.output).toContain('hermes event not written (exit code 1)');
      expect(unset.output).not.toContain('hermes event');
    },
    60_000,
  );

  it('passes options through to the crawl, for a run by hand', async () => {
    const result = await run(['ss-ge', '--mode=sweep', '--max-detail-checks=0']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      'dist/cli/run-ss-ge-crawl.js --mode=sweep --max-detail-checks=0',
    ]);
  });

  it('refuses a job board, and no source at all, with its usage line', async () => {
    for (const args of [['jobs-ge'], []]) {
      const result = await run(args, { HERMES_HOOK_ENABLED: '1' });
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.output).toContain('usage:');
    }
  });

  // As in run-pipeline.test.ts: Node's signals do not reach an MSYS bash the
  // way systemd's reach a real one, so this runs on Linux, CI included.
  it.skipIf(process.platform === 'win32')(
    'reports an interrupted run when it is stopped',
    async () => {
      const child = spawn('bash', ['deploy/run-realestate.sh', 'ss-ge'], {
        cwd: REPO_ROOT,
        env: environment({ HERMES_HOOK_ENABLED: '1', FAKE_CRAWL_SLEEP: '2' }),
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      for (let i = 0; i < 100 && (await fs.readFile(logFile, 'utf8')) === ''; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      child.kill('SIGTERM');

      expect(await exited).toBe(143);
      const calls = (await fs.readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatch(
        /^dist\/cli\/hermes-event\.js --source=ss-ge --started-at=\S+ --crawl=- --exit-code=143 --interrupted$/,
      );
    },
    30_000,
  );
});
