'use client';

import { useEffect, useState } from 'react';
import type { FacetKey, FacetResult, PlaceSuggestions } from '../../../src/realestate/facets.js';
import { formSearch, type RealEstateForm } from '../../lib/real-estate-form.js';

/**
 * Counts for the options of an open panel, from `/real-estate/facets`. Asked
 * only while a panel is open (plan 16B: counts can be the costly part), a
 * moment after the last change, and kept per filter set, so reopening a panel
 * costs nothing. While a newer answer is on its way the last one stays shown.
 */

type Facets = Partial<Record<FacetKey, FacetResult | null>>;

const cache = new Map<string, Facets>();
const CACHE_SIZE = 60;
const PAUSE_MS = 120;

function remember(key: string, value: Facets) {
  cache.set(key, value);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

export function useFacets(
  form: RealEstateForm,
  keys: readonly FacetKey[],
  enabled: boolean,
): Facets {
  const search = formSearch(form);
  const wanted = [...new Set(keys)].sort().join(',');
  const [answer, setAnswer] = useState<{ key: string; facets: Facets }>({ key: '', facets: {} });

  useEffect(() => {
    if (!enabled || wanted === '') return;
    const cacheKey = `${search}|${wanted}`;
    const known = cache.get(cacheKey);
    if (known !== undefined) {
      setAnswer({ key: cacheKey, facets: known });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams(search);
      for (const key of wanted.split(',')) params.append('facet', key);
      fetch(`/real-estate/facets?${params}`, { signal: controller.signal })
        .then((response) => (response.ok ? (response.json() as Promise<{ facets: Facets }>) : null))
        .then((body) => {
          if (body === null) return;
          remember(cacheKey, body.facets);
          setAnswer({ key: cacheKey, facets: body.facets });
        })
        .catch(() => {
          // Aborted by a newer change, or the network: the panel shows no counts.
        });
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, wanted, enabled]);

  return enabled ? answer.facets : {};
}

/** One facet's counts, by option value; empty until they come. */
export function countsOf(facets: Facets, key: FacetKey): Readonly<Record<string, number>> | null {
  const result = facets[key];
  return result?.type === 'counts' ? result.counts : null;
}

/** Place suggestions for the Where box, from `/real-estate/places`. */
export async function fetchPlaces(
  form: RealEstateForm,
  text: string,
  signal: AbortSignal,
): Promise<PlaceSuggestions | null> {
  const params = new URLSearchParams(formSearch(form));
  params.set('text', text);
  const response = await fetch(`/real-estate/places?${params}`, { signal });
  return response.ok ? ((await response.json()) as PlaceSuggestions) : null;
}
