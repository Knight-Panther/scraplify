'use client';

import { useRouter } from 'next/navigation.js';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';
import {
  applicable,
  formHref,
  formSearch,
  type RealEstateForm,
} from '../../lib/real-estate-form.js';

/**
 * The Real estate tab's filters in the browser (Phase 16B). The address stays
 * the one state: a change here builds the next address and asks the server
 * for it, which answers with the rows, the count and these props again. The
 * form is shown changed at once, and the list dims until the answer comes, as
 * the mockup's round trip does.
 */

export interface PlaceLabel {
  /** `level:ref`. */
  value: string;
  nameKa: string;
  nameEn: string | null;
  /** What kind of place, in a word ("district", "street"); empty for a neighbourhood. */
  kind: string;
}

interface ShellValue {
  form: RealEstateForm;
  /** Change the filters. Typed numbers wait a moment, so each keystroke is not a request. */
  update: (next: RealEstateForm, options?: { debounce?: boolean }) => void;
  pending: boolean;
  /** The server's count for the form it last answered. */
  total: number;
  exact: boolean;
  /** Names of the places the server knows the form to hold, and those picked since. */
  placeNames: ReadonlyMap<string, PlaceLabel>;
  rememberPlace: (label: PlaceLabel) => void;
  /** Under a filter on a listing's own page: of the listings matching everything else, how many had it read. */
  coverage: { read: number; total: number } | null;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error('useShell outside RealEstateShell');
  return value;
}

const NUMBER_PAUSE_MS = 450;

export function RealEstateShell({
  form: served,
  total,
  exact,
  places,
  coverage,
  children,
}: {
  form: RealEstateForm;
  total: number;
  exact: boolean;
  places: PlaceLabel[];
  coverage: { read: number; total: number } | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const servedKey = formSearch(served);
  const [form, setForm] = useState(served);
  const [shownKey, setShownKey] = useState(servedKey);
  // A new answer from the server is the truth again (React's "adjust state when a prop changes").
  if (servedKey !== shownKey) {
    setShownKey(servedKey);
    setForm(served);
  }

  const [picked, setPicked] = useState<ReadonlyMap<string, PlaceLabel>>(new Map());
  const placeNames = useMemo(() => {
    const names = new Map(picked);
    for (const label of places) names.set(label.value, label);
    return names;
  }, [places, picked]);
  const rememberPlace = useCallback((label: PlaceLabel) => {
    setPicked((current) => new Map(current).set(label.value, label));
  }, []);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const update = useCallback(
    (next: RealEstateForm, options: { debounce?: boolean } = {}) => {
      const checked = applicable(next);
      setForm(checked);
      if (timer.current !== null) clearTimeout(timer.current);
      const go = () => {
        timer.current = null;
        startTransition(() => {
          router.replace(formHref(checked), { scroll: false });
        });
      };
      if (options.debounce) timer.current = setTimeout(go, NUMBER_PAUSE_MS);
      else go();
    },
    [router],
  );

  const value = useMemo(
    () => ({ form, update, pending, total, exact, placeNames, rememberPlace, coverage }),
    [form, update, pending, total, exact, placeNames, rememberPlace, coverage],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The results, dimmed while the server answers a change. */
export function PendingResults({ children }: { children: ReactNode }) {
  const { pending } = useShell();
  return (
    <div
      aria-busy={pending}
      className={`transition-opacity duration-150 motion-reduce:transition-none ${pending ? 'opacity-45' : ''}`}
    >
      {children}
    </div>
  );
}

/** A thin bar that runs while the server answers. */
export function PendingBar() {
  const { pending } = useShell();
  return (
    <div aria-hidden="true" className="relative mt-2.5 h-0.5 overflow-hidden bg-border">
      <div
        className={`absolute inset-y-0 left-0 w-[30%] bg-brand-bar ${pending ? 'animate-[re-run_700ms_cubic-bezier(0.2,0.8,0.2,1)_infinite] motion-reduce:animate-none' : '-translate-x-[110%]'}`}
      />
    </div>
  );
}

const WIDE = '(min-width: 900px)';

/** Whether the screen is wide enough for popovers; a phone gets bottom sheets. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}
