// "Surprise me": one good title at random out of what the filters allow.
//
// Requests: the first pick asks for at most two pages of 20 (the first, which says how many pages
// there are, and one drawn at random; three when the quality floor leaves nothing and the bare
// filters are asked instead). After that "Another one" draws from what is already here, and asks
// for one more page only when those have all been shown.

import { useCallback, useEffect, useRef, useState } from 'react';
import { discoverPage } from '../../meta/tmdb';
import { discoverRequest } from '../../meta/tmdbSources';
import type { CollectionSource } from '../../state/collections';
import { useHistory } from '../../state/history';
import { canonicalNow } from '../../tracking/idmap';
import { toast } from '../../ui/toast';
import { latestOnly } from '../search/logic';
import { titleHits, type TitleHit } from '../shared/hits';
import { normalize, pickSurprise, sameFilters, surpriseFilters, surprisePage, toSource, type DiscoverFilters } from './filters';

interface Pool {
  source: CollectionSource;
  totalPages: number;
  hits: TitleHit[];
  /** Pages already drawn from. */
  used: Set<number>;
  /** Titles already shown, by TMDB number. */
  shown: Set<number>;
}

async function page(source: CollectionSource, n: number) {
  const r = discoverRequest(source, n);
  const res = await discoverPage(r.kind, r.params);
  return { totalPages: res.totalPages, hits: titleHits(res.results, r.kind) };
}

async function openPool(filters: DiscoverFilters, kids: boolean): Promise<Pool> {
  const good = surpriseFilters(filters);
  let source = toSource(good, { kids });
  let first = await page(source, 1);
  const bare = normalize({ ...filters, sort: undefined });
  // Nothing clears the floor: better a pick from what the filters do find than none.
  if (!first.hits.length && !sameFilters(good, bare)) {
    source = toSource(bare, { kids });
    first = await page(source, 1);
  }
  const pool: Pool = { source, totalPages: first.totalPages, hits: first.hits, used: new Set([1]), shown: new Set() };
  // The first page is the twenty best known. A second one from anywhere in reach goes in with it,
  // so the very first pick is not always one of those.
  const second = surprisePage(first.totalPages, pool.used, Math.random());
  if (second !== null) {
    pool.hits.push(...(await page(source, second)).hits);
    pool.used.add(second);
  }
  return pool;
}

/** A film the profile has already watched is not much of a surprise. Shows are never "watched" as a whole. */
const watched = (h: TitleHit) => h.kind === 'movie' && !!useHistory.getState().watched[canonicalNow(`tmdb:${h.tmdbId}`, 'movie')];

/** A single click asks for this many more pages at most, however little each one holds. */
const PAGES_PER_PICK = 2;

export function useSurprise(filters: DiscoverFilters, kids: boolean) {
  const [pick, setPick] = useState<TitleHit | null>(null);
  const [busy, setBusy] = useState(false);
  const pool = useRef<Pool | null>(null);
  const calls = useRef(latestOnly());
  const key = JSON.stringify([normalize(filters), kids]);

  // Other filters: the pick belonged to the old ones, and so does anything still on its way.
  useEffect(() => {
    const running = calls.current;
    return () => {
      running.cancel();
      pool.current = null;
      setPick(null);
      setBusy(false);
    };
  }, [key]);

  const next = useCallback(async () => {
    const current = calls.current.start();
    setBusy(true);
    try {
      let p = pool.current;
      if (!p) {
        p = await openPool(filters, kids);
        if (!current()) return;
        pool.current = p;
      }
      for (let asked = 0; ; ) {
        const hit = pickSurprise(p.hits, p.shown, watched, Math.random());
        if (hit) {
          p.shown.add(hit.tmdbId);
          setPick(hit);
          // The pick is drawn at the top of the page; the grid may be scrolled far below it.
          window.dispatchEvent(new CustomEvent('rove:scroll-top'));
          return;
        }
        const n = asked < PAGES_PER_PICK ? surprisePage(p.totalPages, p.used, Math.random()) : null;
        if (n === null) {
          // Everything has had its turn: around again. With nothing ever shown there is nothing to pick.
          if (p.shown.size && asked === 0) {
            p.shown.clear();
            continue;
          }
          setPick(null);
          toast.info('Nothing matches these filters, so there is nothing to pick from.');
          return;
        }
        asked++;
        const more = await page(p.source, n);
        if (!current()) return;
        p.used.add(n);
        p.hits.push(...more.hits);
      }
    } catch (e) {
      console.warn('surprise pick failed', e);
      if (current()) toast.error('TMDB did not answer, so nothing was picked. Try again.');
    } finally {
      if (current()) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const close = useCallback(() => setPick(null), []);
  return { pick, busy, next, close };
}
