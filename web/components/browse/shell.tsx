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
  BROWSE_CHUNK,
  type BrowseForm,
  type FilterKey,
  formHref,
  formSearch,
  normalize,
} from '../../../src/browse/browse-form.js';
import type { BrowseData, BrowseOption } from '../../lib/browse-registry.js';
import { FILTER_WIDE } from '../filter-ui.js';

/**
 * Browse's filters in the browser (Phase 16C). The address stays the one
 * state, as on Real estate (16B): a change builds the next address and asks
 * the server for it, which answers with the rows and these props again. The
 * form shows the change at once, and the list dims until the answer comes.
 */

interface ShellValue {
  form: BrowseForm;
  update: (next: BrowseForm, options?: { debounce?: boolean; keepShow?: boolean }) => void;
  pending: boolean;
  data: BrowseData;
  /** An option's label, from the server's answer or one picked since. */
  label: (key: FilterKey, value: string) => string;
  /** Remember an option picked from the search box until the server names it. */
  remember: (key: FilterKey, option: BrowseOption) => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export function useBrowse(): ShellValue {
  const value = useContext(ShellContext);
  if (value === null) throw new Error('useBrowse outside BrowseShell');
  return value;
}

const NUMBER_PAUSE_MS = 450;

export function BrowseShell({
  form: served,
  data,
  children,
}: {
  form: BrowseForm;
  data: BrowseData;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const servedKey = formSearch(served);
  const [form, setForm] = useState(served);
  const [shownKey, setShownKey] = useState(servedKey);
  // A new answer from the server is the truth again.
  if (servedKey !== shownKey) {
    setShownKey(servedKey);
    setForm(served);
  }

  const [picked, setPicked] = useState<ReadonlyMap<string, BrowseOption>>(new Map());
  const remember = useCallback((key: FilterKey, option: BrowseOption) => {
    setPicked((current) => new Map(current).set(`${key}|${option.value}`, option));
  }, []);
  const label = useCallback(
    (key: FilterKey, value: string) => {
      const option =
        data.options[key]?.find((o) => o.value === value) ?? picked.get(`${key}|${value}`);
      if (option === undefined) return value.replace(/^[gcjt]:/, '');
      // A Georgian word reads with its English in a pill; the English alone is shorter.
      return option.lang === 'ka' && option.hint !== '' ? option.hint : option.label;
    },
    [data.options, picked],
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const update = useCallback(
    (next: BrowseForm, options: { debounce?: boolean; keepShow?: boolean } = {}) => {
      // A new filter starts the list again; a new order keeps how far it was grown.
      const checked = normalize(
        { ...next, show: options.keepShow ? next.show : BROWSE_CHUNK },
        data.surface,
      );
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
    [router, data.surface],
  );

  const value = useMemo(
    () => ({ form, update, pending, data, label, remember }),
    [form, update, pending, data, label, remember],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The results, dimmed while the server answers a change. */
export function PendingResults({ children }: { children: ReactNode }) {
  const { pending } = useBrowse();
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
  const { pending } = useBrowse();
  return (
    <div aria-hidden="true" className="relative mt-2.5 h-0.5 overflow-hidden bg-border">
      <div
        className={`absolute inset-y-0 left-0 w-[30%] bg-brand-bar ${pending ? 'animate-[re-run_700ms_cubic-bezier(0.2,0.8,0.2,1)_infinite] motion-reduce:animate-none' : '-translate-x-[110%]'}`}
      />
    </div>
  );
}

/** Whether the screen is wide enough for popovers; a phone gets bottom sheets. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(FILTER_WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(FILTER_WIDE).matches,
    () => true,
  );
}
