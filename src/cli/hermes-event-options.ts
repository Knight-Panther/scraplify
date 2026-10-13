import { parseArgs } from 'node:util';
import { PIPELINE_STEPS, type PipelineRun, type StepCodes } from '../hermes/event.js';
import { etendersGeSource } from '../policies/etenders-ge.js';
import { hrGeSource } from '../policies/hr-ge.js';
import { jobsGeSource } from '../policies/jobs-ge.js';

/** The sources `deploy/run-pipeline.sh` runs. ss.ge joins with Phase 11E. */
const PIPELINE_SOURCES: readonly string[] = [
  jobsGeSource.slug,
  hrGeSource.slug,
  etendersGeSource.slug,
];

export type HermesEventOptions = { kind: 'test' } | { kind: 'pipeline'; run: PipelineRun };

/** A step's exit code as `deploy/run-pipeline.sh` passes it: a number, or `-` for a step that did not run. */
function stepCode(name: string, value: string | undefined): number | null {
  if (value === undefined || value === '-') return null;
  const code = Number(value);
  if (!/^\d{1,3}$/.test(value) || code > 255)
    throw new Error(`--${name} must be an exit code (0-255) or -`);
  return code;
}

/**
 * `hermes-event --test`, or one finished pipeline run:
 *
 *   hermes-event --source=jobs-ge --started-at=2026-10-13T16:10:04Z \
 *     --crawl=0 --dedupe=0 --taxonomy=0 --bundle=0 --retention=- --exit-code=0 [--interrupted]
 */
export function parseHermesEventOptions(args: string[]): HermesEventOptions {
  const { values } = parseArgs({
    args,
    options: {
      test: { type: 'boolean', default: false },
      source: { type: 'string' },
      'started-at': { type: 'string' },
      crawl: { type: 'string' },
      dedupe: { type: 'string' },
      taxonomy: { type: 'string' },
      bundle: { type: 'string' },
      retention: { type: 'string' },
      'exit-code': { type: 'string' },
      interrupted: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.test) return { kind: 'test' };

  const source = values.source;
  if (source === undefined || !PIPELINE_SOURCES.includes(source))
    throw new Error(`--source must be one of ${PIPELINE_SOURCES.join(', ')}`);
  const startedAt = values['started-at'];
  if (startedAt === undefined || Number.isNaN(Date.parse(startedAt)))
    throw new Error('--started-at must be an ISO-8601 time');
  const exitCode = stepCode('exit-code', values['exit-code']);
  if (exitCode === null) throw new Error('--exit-code is required');
  const steps = Object.fromEntries(
    PIPELINE_STEPS.map((step) => [step, stepCode(step, values[step])]),
  ) as StepCodes;
  return {
    kind: 'pipeline',
    run: {
      sourceSlug: source,
      startedAt: new Date(startedAt).toISOString(),
      steps,
      exitCode,
      interrupted: values.interrupted,
    },
  };
}
