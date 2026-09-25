'use client';

import { useEffect, useRef } from 'react';
import { CvChooser } from '../../../components/cv-chooser.js';
import { count, relativeTime } from '../../../lib/format.js';
import { sourceLabel } from '../../../lib/labels.js';
import { ERROR_MESSAGES, PRIVACY_PROMISE, STAGES } from '../../../lib/cv-ranked/copy.js';
import type { BundleSummary } from '../../../lib/cv-ranked/protocol.js';
import { type CvSessionState, useCvSession } from '../../../lib/cv-ranked/session.js';
import { ProfileEditor } from './profile-editor.js';
import { Results } from './results.js';

const chooserClass =
  'inline-flex h-11 w-fit items-center rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 text-sm font-semibold hover:bg-surface-active';
const quietButtonClass =
  'rounded-[var(--radius)] border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-raised';

export function CvRankedView() {
  const { state, reset, setProfile, showMore } = useCvSession();
  const heading = useRef<HTMLHeadingElement>(null);

  // Each state swap replaces most of the page; moving focus to the heading
  // keeps a keyboard or screen-reader user from being left on a removed node.
  const previous = useRef(state.status);
  useEffect(() => {
    if (previous.current === state.status) return;
    previous.current = state.status;
    heading.current?.focus();
  });

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        {/* Focused only by script, never tabbed to, so it takes no ring:
            globals.css's focus rule is unlayered, which outranks any
            Tailwind utility, hence the inline style. */}
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold"
          style={{ outline: 'none' }}
        >
          CV Ranked
        </h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Choose a CV and it is matched against current vacancies, entirely in this browser.
        </p>
      </header>
      <Body state={state} reset={reset} setProfile={setProfile} showMore={showMore} />
    </main>
  );
}

function Body({
  state,
  reset,
  setProfile,
  showMore,
}: {
  state: CvSessionState;
} & Pick<ReturnType<typeof useCvSession>, 'reset' | 'setProfile' | 'showMore'>) {
  switch (state.status) {
    case 'idle':
      return (
        <div className="mt-6 flex max-w-[var(--measure)] flex-col gap-4">
          <CvChooser
            label="Choose a CV"
            note={'PDF or DOCX, up to 8 MB. Text PDFs only: scans cannot be read.'}
            className={chooserClass}
          />
          <p className="text-sm text-muted">
            Nothing from an earlier visit is kept here. Leaving or refreshing the page ends a
            session, so a CV has to be chosen again.
          </p>
          <p className="text-xs leading-[1.6] text-faint">{PRIVACY_PROMISE}</p>
        </div>
      );

    case 'processing': {
      const current = STAGES.findIndex((entry) => entry.stage === state.stage);
      return (
        <div className="mt-6 flex max-w-[var(--measure)] flex-col gap-4">
          <ol className="flex flex-col gap-1.5 text-sm" aria-live="polite">
            {STAGES.map((entry, index) => (
              <li
                key={entry.stage}
                aria-current={index === current ? 'step' : undefined}
                className={
                  index < current
                    ? 'text-muted'
                    : index === current
                      ? 'font-semibold text-foreground'
                      : 'text-faint'
                }
              >
                <span className="numeric mr-2">{index < current ? '✓' : `${index + 1}.`}</span>
                {entry.label}
                {index === current ? '…' : ''}
              </li>
            ))}
          </ol>
          <button type="button" onClick={reset} className={`${quietButtonClass} w-fit`}>
            Cancel
          </button>
        </div>
      );
    }

    case 'error': {
      const message = ERROR_MESSAGES[state.code];
      const bundleProblem = state.code.startsWith('bundle_') || state.code === 'network';
      return (
        <div className="mt-6 flex max-w-[var(--measure)] flex-col gap-4">
          <div
            role="alert"
            className="rounded-[var(--radius)] border border-border bg-surface px-4 py-4 text-sm"
          >
            <p className="font-semibold">{message.title}</p>
            <p className="mt-1 text-muted">{message.body}</p>
            {state.bundle && <IndexFacts bundle={state.bundle} />}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <CvChooser
              label={bundleProblem ? 'Try again with a CV' : 'Choose another file'}
              note="The previous file was discarded."
              className={chooserClass}
            />
            {bundleProblem && (
              <a
                href="/opportunities"
                className="text-sm text-accent underline underline-offset-2 hover:text-foreground"
              >
                Browse vacancies instead
              </a>
            )}
          </div>
        </div>
      );
    }

    case 'ready': {
      const activeTerms = state.profile.terms.filter(
        (term) => term.active && term.kind !== 'location',
      ).length;
      return (
        <div className="mt-6 flex max-w-[1360px] flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-xs text-muted">
            <p>
              Read a {state.document.kind === 'pdf' ? 'PDF' : 'DOCX'}
              {state.document.pages !== null && (
                <>
                  {' '}
                  of <span className="numeric">{count(state.document.pages)}</span>{' '}
                  {state.document.pages === 1 ? 'page' : 'pages'}
                </>
              )}{' '}
              in this browser. Nothing was uploaded.
            </p>
            <div className="flex items-center gap-3">
              {/* Below lg the profile stacks above the results and runs long. */}
              <a
                href="#results-heading"
                className="text-accent underline underline-offset-2 hover:text-foreground lg:hidden"
              >
                Jump to <span className="numeric">{count(state.ranking.stats.matched)}</span>{' '}
                matches
              </a>
              <button type="button" onClick={reset} className={quietButtonClass}>
                Clear CV
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] lg:gap-10">
            <ProfileEditor
              profile={state.profile}
              vocabulary={state.vocabulary}
              onChange={setProfile}
            />
            <div className="min-w-0">
              <Results
                ranking={state.ranking}
                activeTerms={activeTerms}
                reranking={state.reranking}
                onShowMore={showMore}
              />
              <div className="mt-4 text-xs text-faint">
                <IndexFacts bundle={state.bundle} />
              </div>
            </div>
          </div>
          <Privacy />
        </div>
      );
    }
  }
}

/** When the data was built and last confirmed per board — from the manifest, never estimated. */
function IndexFacts({ bundle }: { bundle: BundleSummary }) {
  return (
    <p className="mt-2 text-xs text-faint">
      Vacancy index of <span className="numeric">{count(bundle.opportunities)}</span> vacancies,
      built{' '}
      <time dateTime={bundle.generatedAt} title={bundle.generatedAt}>
        {relativeTime(bundle.generatedAt)}
      </time>
      {bundle.sourceFreshness.map((source) => (
        <span key={source.sourceSlug}>
          {' '}
          · {sourceLabel(source.sourceSlug)} last confirmed{' '}
          <time dateTime={source.lastSeenAt} title={source.lastSeenAt}>
            {relativeTime(source.lastSeenAt)}
          </time>
        </span>
      ))}
      .
    </p>
  );
}

function Privacy() {
  return (
    <details className="max-w-[var(--measure)] text-xs text-faint">
      <summary className="cursor-pointer text-muted hover:text-foreground">
        What happens to the CV
      </summary>
      <p className="mt-2 leading-[1.6]">{PRIVACY_PROMISE}</p>
    </details>
  );
}
