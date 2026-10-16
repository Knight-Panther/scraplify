import { parseArgs } from 'node:util';
import {
  PIPELINE_STEPS,
  type PipelineRun,
  type RealEstateRun,
  type StepCodes,
} from '../hermes/event.js';
import { PIPELINE_SOURCES, REAL_ESTATE_PIPELINE_SOURCES } from '../hermes/schema.js';

export type HermesEventOptions =
  | { kind: 'test' }
  | { kind: 'pipeline'; run: PipelineRun }
  | { kind: 'realestate'; run: RealEstateRun };

/** A step's exit code as the run scripts pass it: a number, or `-` for a step that did not run. */
function stepCode(name: string, value: string | undefined): number | null {
  if (value === undefined || value === '-') return null;
  const code = Number(value);
  if (!/^\d{1,3}$/.test(value) || code > 255)
    throw new Error(`--${name} must be an exit code (0-255) or -`);
  return code;
}

/**
 * `hermes-event --test`, or one finished run. A job board's, from
 * `deploy/run-pipeline.sh`:
 *
 *   hermes-event --source=jobs-ge --started-at=2026-10-13T16:10:04Z \
 *     --crawl=0 --dedupe=0 --taxonomy=0 --bundle=0 --retention=- --exit-code=0 [--interrupted]
 *
 * A real-estate source's, from `deploy/run-realestate.sh`, which has the crawl only:
 *
 *   hermes-event --source=ss-ge --started-at=2026-10-15T21:30:02Z --crawl=0 --exit-code=0
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
  const realEstate = source !== undefined && REAL_ESTATE_PIPELINE_SOURCES.includes(source);
  if (source === undefined || !(realEstate || PIPELINE_SOURCES.includes(source))) {
    const known = [...PIPELINE_SOURCES, ...REAL_ESTATE_PIPELINE_SOURCES];
    throw new Error(`--source must be one of ${known.join(', ')}`);
  }
  const startedAt = values['started-at'];
  if (startedAt === undefined || Number.isNaN(Date.parse(startedAt)))
    throw new Error('--started-at must be an ISO-8601 time');
  const exitCode = stepCode('exit-code', values['exit-code']);
  if (exitCode === null) throw new Error('--exit-code is required');

  if (realEstate) {
    const extra = PIPELINE_STEPS.filter((step) => step !== 'crawl' && values[step] !== undefined);
    if (extra.length > 0) {
      throw new Error(`a real-estate run has a crawl step only, not --${extra.join(', --')}`);
    }
    return {
      kind: 'realestate',
      run: {
        sourceSlug: source,
        startedAt: new Date(startedAt).toISOString(),
        crawl: stepCode('crawl', values.crawl),
        exitCode,
        interrupted: values.interrupted,
      },
    };
  }

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
