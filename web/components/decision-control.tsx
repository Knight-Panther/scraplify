import {
  clearOpportunityDecision,
  dismissOpportunity,
  saveOpportunity,
} from '../app/saved/actions.js';
import type { Decision } from '../../src/shortlist/decisions.js';
import { writesEnabled } from '../lib/writes.js';

/**
 * Save, dismiss, or undo — the only writing control in the app.
 *
 * Three plain forms rather than one with several submit buttons, because a
 * form's action is then unambiguous: nothing depends on which button was
 * pressed, so nothing can misread it. No client JavaScript, so this works
 * with scripting off like every other control here.
 *
 * **When writes are disabled the buttons are not rendered as disabled — the
 * current state is rendered as text instead.** A row of dead buttons invites
 * clicking and explains nothing; and this is the read-only instance pointed at
 * the live corpus, where the honest message is "this instance cannot change
 * anything", not "try again".
 *
 * Reversibility is visible rather than guarded. `anti-patterns.md` forbids a
 * scary confirmation for a reversible action and, worse, its opposite — a
 * one-click destructive-looking action with no visible undo. Dismissing is one
 * click and the undo sits next to it afterwards.
 */
export function DecisionControl({
  opportunityId,
  decision,
  note,
  /** Renders the note field. Off in a list, where a textarea per row is noise. */
  withNote = false,
}: {
  opportunityId: string;
  decision: Decision | null;
  note?: string | null;
  withNote?: boolean;
}) {
  if (!writesEnabled()) return <ReadOnlyState decision={decision} note={note ?? null} />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {decision !== 'saved' && (
        <DecisionForm
          action={saveOpportunity}
          opportunityId={opportunityId}
          withNote={withNote}
          note={note ?? null}
          label={decision === 'dismissed' ? 'Save instead' : 'Save'}
        />
      )}
      {decision !== 'dismissed' && (
        <DecisionForm
          action={dismissOpportunity}
          opportunityId={opportunityId}
          withNote={withNote}
          note={note ?? null}
          label={decision === 'saved' ? 'Dismiss instead' : 'Dismiss'}
        />
      )}
      {decision !== null && (
        <DecisionForm
          action={clearOpportunityDecision}
          opportunityId={opportunityId}
          withNote={false}
          note={null}
          label={decision === 'saved' ? 'Unsave' : 'Undo dismissal'}
          quiet
        />
      )}
    </div>
  );
}

function DecisionForm({
  action,
  opportunityId,
  withNote,
  note,
  label,
  quiet = false,
}: {
  action: (form: FormData) => Promise<void>;
  opportunityId: string;
  withNote: boolean;
  note: string | null;
  label: string;
  quiet?: boolean;
}) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      {withNote && (
        <label className="flex min-w-0 items-center gap-2 text-xs text-faint">
          <span className="sr-only">Note</span>
          <input
            type="text"
            name="note"
            defaultValue={note ?? ''}
            placeholder="why, in your own words…"
            // Georgian, so an English dictionary would underline every word.
            spellCheck={false}
            autoComplete="off"
            className="w-56 rounded-[var(--radius)] border border-border bg-surface px-3 py-1 text-sm text-foreground placeholder:text-faint"
          />
        </label>
      )}
      <button
        type="submit"
        className={
          quiet
            ? 'rounded-[var(--radius)] px-3 py-1 text-sm text-muted underline underline-offset-2 hover:text-foreground'
            : 'rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active'
        }
      >
        {label}
      </button>
    </form>
  );
}

/**
 * What the read-only instance shows instead.
 *
 * The decision itself is still worth displaying — it is real data, and this
 * instance can read it — so only the ability to change it is missing, and the
 * text says which.
 */
function ReadOnlyState({ decision, note }: { decision: Decision | null; note: string | null }) {
  if (decision === null) {
    return (
      <p className="text-xs text-faint">
        Not saved or dismissed. This instance is read-only, so it cannot change that.
      </p>
    );
  }
  return (
    <p className="text-xs text-faint">
      {decision === 'saved' ? 'Saved' : 'Dismissed'}
      {note !== null && note !== '' && <> — {note}</>}. This instance is read-only.
    </p>
  );
}
