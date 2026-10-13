import { spawn, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `deploy/run-pipeline.sh` itself, with a stand-in for `node` that exits with
 * whatever code the test gives each step. The hook must never change what the
 * script returns: its exit code is how systemd, and the operator, learn that a
 * run failed.
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
# Stands in for node in run-pipeline.test.ts: records the call, then exits
# with the code the test set for that step.
echo "$*" >> "$FAKE_NODE_LOG"
case "$1" in
  dist/cli/run-*-crawl.js)
    [ -z "\${FAKE_CRAWL_SLEEP:-}" ] || sleep "$FAKE_CRAWL_SLEEP"
    exit "\${FAKE_CRAWL:-0}"
    ;;
  dist/cli/run-dedupe.js) exit "\${FAKE_DEDUPE:-0}" ;;
  dist/cli/backfill-taxonomy.js) exit "\${FAKE_TAXONOMY:-0}" ;;
  dist/cli/build-matching-bundle.js) exit "\${FAKE_BUNDLE:-0}" ;;
  dist/cli/run-retention.js) exit "\${FAKE_RETENTION:-0}" ;;
  dist/cli/hermes-event.js) exit "\${FAKE_HERMES:-0}" ;;
esac
exit 97
`;

type StepCodes = Partial<Record<'CRAWL' | 'DEDUPE' | 'TAXONOMY' | 'BUNDLE' | 'RETENTION', number>>;

describe.skipIf(BASH === null)('deploy/run-pipeline.sh', () => {
  let bin: string;
  let logFile: string;

  beforeEach(async () => {
    bin = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-pipeline-'));
    logFile = path.join(bin, 'calls.log');
    await fs.writeFile(path.join(bin, 'node'), FAKE_NODE, { mode: 0o755 });
    await fs.writeFile(logFile, '');
  });

  afterEach(async () => {
    await fs.rm(bin, { recursive: true, force: true });
  });

  function environment(steps: StepCodes, hook: Record<string, string>): NodeJS.ProcessEnv {
    // One PATH entry whatever its spelling: Windows calls it `Path`.
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.HERMES_HOOK_ENABLED;
    return {
      ...env,
      [pathKey]: `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`,
      FAKE_NODE_LOG: logFile,
      ...Object.fromEntries(
        Object.entries(steps).map(([step, code]) => [`FAKE_${step}`, `${code}`]),
      ),
      ...hook,
    };
  }

  async function runPipeline(steps: StepCodes, hook: Record<string, string> = {}) {
    await fs.writeFile(logFile, '');
    const result = spawnSync(BASH ?? 'bash', ['deploy/run-pipeline.sh', 'jobs-ge'], {
      cwd: REPO_ROOT,
      env: environment(steps, hook),
      encoding: 'utf8',
    });
    const calls = (await fs.readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
    return { code: result.status, calls, output: `${result.stdout}${result.stderr}` };
  }

  const eventCall = (calls: string[]) =>
    calls.find((call) => call.startsWith('dist/cli/hermes-event.js'));

  // The exit rule, unchanged: the crawl's own failure wins, otherwise the
  // first failed step's code.
  it.each([
    { name: 'every step succeeds', steps: {}, expected: 0, reported: '0 0 0 0 0' },
    { name: 'the crawl fails', steps: { CRAWL: 1 }, expected: 1, reported: '1 0 0 0 -' },
    { name: 'dedupe fails', steps: { DEDUPE: 3 }, expected: 3, reported: '0 3 0 - -' },
    { name: 'taxonomy fails', steps: { TAXONOMY: 4 }, expected: 4, reported: '0 0 4 - 0' },
    { name: 'the bundle fails', steps: { BUNDLE: 5 }, expected: 5, reported: '0 0 0 5 0' },
    { name: 'retention fails', steps: { RETENTION: 6 }, expected: 6, reported: '0 0 0 0 6' },
    {
      name: 'the crawl and dedupe both fail',
      steps: { CRAWL: 2, DEDUPE: 3 },
      expected: 2,
      reported: '2 3 0 - -',
    },
  ] as Array<{ name: string; steps: StepCodes; expected: number; reported: string }>)(
    'returns the same code with the hook unset, set, or failing to write: $name',
    async ({ steps, expected, reported }) => {
      const unset = await runPipeline(steps);
      const set = await runPipeline(steps, { HERMES_HOOK_ENABLED: '1' });
      const unwritable = await runPipeline(steps, { HERMES_HOOK_ENABLED: '1', FAKE_HERMES: '1' });

      expect([unset.code, set.code, unwritable.code]).toEqual([expected, expected, expected]);

      // Unset: the event command is never started.
      expect(eventCall(unset.calls)).toBeUndefined();
      // Set: called once, last, with each step's code and "-" for a skipped one.
      const [crawl, dedupe, taxonomy, bundle, retention] = reported.split(' ');
      expect(eventCall(set.calls)).toMatch(
        new RegExp(
          `^dist/cli/hermes-event\\.js --source=jobs-ge --started-at=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ ` +
            `--crawl=${crawl} --dedupe=${dedupe} --taxonomy=${taxonomy} --bundle=${bundle} ` +
            `--retention=${retention} --exit-code=${expected}$`,
        ),
      );
      expect(set.calls.at(-1)).toBe(eventCall(set.calls));
      // The same steps ran, in the same order, whatever the hook did.
      expect(set.calls.slice(0, -1)).toEqual(unset.calls);
      // The start time is the one thing that differs between two runs.
      const withoutTime = (calls: string[]) =>
        calls.map((call) => call.replace(/--started-at=\S+/, '--started-at=T'));
      expect(withoutTime(unwritable.calls)).toEqual(withoutTime(set.calls));
      expect(unwritable.output).toContain('hermes event not written (exit code 1)');
      expect(unset.output).not.toContain('hermes event');
    },
    60_000,
  );

  it('still refuses an unknown source with its usage line', async () => {
    const result = spawnSync(BASH ?? 'bash', ['deploy/run-pipeline.sh', 'ss-ge'], {
      cwd: REPO_ROOT,
      env: environment({}, { HERMES_HOOK_ENABLED: '1' }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(await fs.readFile(logFile, 'utf8')).toBe('');
  });

  // Signals from Node do not reach an MSYS bash the way systemd's reach a
  // real one, so this runs where the script does: on Linux, CI included.
  it.skipIf(process.platform === 'win32')(
    'reports an interrupted run and goes no further when it is stopped',
    async () => {
      const child = spawn('bash', ['deploy/run-pipeline.sh', 'jobs-ge'], {
        cwd: REPO_ROOT,
        env: environment({}, { HERMES_HOOK_ENABLED: '1', FAKE_CRAWL_SLEEP: '2' }),
      });
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      // Wait for the crawl step to be running, then stop the script as systemd would.
      for (let i = 0; i < 100 && (await fs.readFile(logFile, 'utf8')) === ''; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      child.kill('SIGTERM');

      expect(await exited).toBe(143);
      const calls = (await fs.readFile(logFile, 'utf8')).split('\n').filter((line) => line !== '');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe('dist/cli/run-jobs-ge-crawl.js');
      expect(calls[1]).toMatch(
        /^dist\/cli\/hermes-event\.js --source=jobs-ge --started-at=\S+ --crawl=- --dedupe=- --taxonomy=- --bundle=- --retention=- --exit-code=143 --interrupted$/,
      );
    },
    30_000,
  );
});
