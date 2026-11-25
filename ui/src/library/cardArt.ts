// Card art for titles shown without a name or poster (history and watchlist entries a tracker
// sent, mostly): library/art.ts decides where it comes from and what happens on failure; this
// file gives it the real sources, keeps what it finds in history's cards (so the next start
// shows it at once), and watches for remembered pictures that no longer load.

import { useEffect, useMemo, useRef } from 'react';
import { fetchMeta } from '../addons/client';
import { isImdbId, parseId, titleKey } from '../addons/ids';
import { useAddons } from '../addons/store';
import { nativeFetch, debouncedWriter, docs } from '../lib/native';
import { hasTmdb, titleArt, titleArtByImdb } from '../meta/tmdb';
import { useHistory, type HistoryDoc, type MediaType, type TitleCard } from '../state/history';
import { canonicalNow, rememberMapping } from '../tracking/idmap';
import { artIdentity, createArtQueue, GoneArt, resolveArt, saysGone, usableArt, type ArtQueue, type ArtWanted } from './art';

const gone = new GoneArt();
const goneWriter = debouncedWriter((v) => docs.write('art-gone', v), 2000);
let goneLoaded: Promise<void> | null = null;

/** Reads the dead picture links kept from earlier runs. Art is not asked for before this. */
function loadGone(): Promise<void> {
  goneLoaded ??= docs
    .read<Record<string, number>>('art-gone')
    .then((saved) => gone.load(saved))
    .catch(() => undefined);
  return goneLoaded;
}

/** A remembered picture link an `<img>` can load, or nothing (see library/art `usableArt`). */
export function artLink(url: string | null | undefined, size: 'w342' | 'w1280' = 'w342'): string | undefined {
  return usableArt(url, gone, size);
}

let queue: ArtQueue | null = null;

function artQueue(): ArtQueue {
  queue ??= createArtQueue({
    resolve: async (want) => {
      await loadGone();
      return resolveArt(want, {
        hasTmdb,
        byNumber: (kind, id, logo) => titleArt(kind, id, { logo }),
        byImdb: titleArtByImdb,
        addons: (type, metaId) => fetchMeta(type, metaId),
        usable: (url) => !gone.has(url),
      });
    },
    remember: (found) => {
      // What TMDB said an IMDb id is: history entries still under the `tmdb:` id move over.
      for (const f of found) {
        const base = parseId(f.metaId).base;
        if (f.tmdb && isImdbId(base)) rememberMapping(base, f.tmdb);
      }
      useHistory.getState().rememberCards(found.filter((f) => Object.keys(f.card).length));
    },
  });
  return queue;
}

// ---------- Which TMDB title an entry is ----------

type Numbers = Map<string, number>;
let numbersFor: { watched: HistoryDoc['watched']; library: HistoryDoc['library']; map: Numbers } | null = null;

/** Title key -> the TMDB number its history or watchlist entries carry. One pass per change. */
function tmdbNumbers(watched: HistoryDoc['watched'], library: HistoryDoc['library']): Numbers {
  if (numbersFor && numbersFor.watched === watched && numbersFor.library === library) return numbersFor.map;
  const map: Numbers = new Map();
  for (const all of [watched, library] as Record<string, { metaId: string; type: MediaType; tmdbId?: number }>[]) {
    for (const e of Object.values(all)) if (e.tmdbId) map.set(titleKey(e.metaId, e.type), e.tmdbId);
  }
  numbersFor = { watched, library, map };
  return map;
}

function tmdbNumberOf(metaId: string, type: MediaType, numbers: Numbers): number | undefined {
  const key = titleKey(metaId, type);
  const known = numbers.get(key);
  if (known) return known;
  // Resume points are few and change every few seconds while playing: looked at, not indexed.
  for (const p of Object.values(useHistory.getState().progress)) if (p.tmdbId && p.type === type && p.metaId === metaId) return p.tmdbId;
  return undefined;
}

// ---------- The hook ----------

export interface ArtItem {
  metaId: string;
  type: MediaType;
  name?: string;
  poster?: string;
  tmdbId?: number;
}

export interface CardArtOptions {
  /**
   * The part of `items` on screen or about to be (indexes, `to` exclusive): only that is asked
   * about. Without it the whole list is worked through from the top, a few titles at a time.
   */
  range?: { from: number; to: number };
  /** Ask for logo art too (wide cards). */
  logo?: boolean;
}

/**
 * Fills in titles shown without a name or poster and remembers what it finds in history's cards
 * (the caller shows it from there). TMDB first, the metadata addons for what TMDB lacks; a few
 * requests at a time; nothing for what is not wanted any more by the time its turn comes.
 */
export function useCardArt(items: ArtItem[], opts: CardArtOptions = {}) {
  const addonsLoaded = useAddons((s) => s.loaded);
  const historyLoaded = useHistory((s) => s.loaded);
  const ready = addonsLoaded && historyLoaded;
  const watched = useHistory((s) => s.watched);
  const library = useHistory((s) => s.library);
  const owner = useRef<object>({});
  const from = opts.range ? Math.max(0, opts.range.from) : 0;
  const to = opts.range ? Math.min(items.length, opts.range.to) : items.length;
  const logo = !!opts.logo;

  const wanted: ArtWanted[] = [];
  if (ready) {
    const numbers = tmdbNumbers(watched, library);
    for (let i = from; i < to; i++) {
      const it = items[i];
      if (it.name && artLink(it.poster)) continue;
      wanted.push({ metaId: it.metaId, type: it.type, tmdbId: it.tmdbId ?? tmdbNumberOf(it.metaId, it.type, numbers), logo });
    }
  }
  // The same list while it holds the same titles: callers pass a new array on every render.
  const wantedKey = wanted.map((w) => `${titleKey(w.metaId, w.type)}#${w.tmdbId ?? ''}`).join('|');
  const list = useMemo(() => wanted, [wantedKey, logo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    watchBrokenArt();
    artQueue().want(owner.current, list);
  }, [list]);
  useEffect(() => {
    const me = owner.current;
    return () => artQueue().release(me);
  }, []);
}

/**
 * An entry with what its remembered card adds. `own` says whose art wins where both have some:
 * the entry's own (a watchlist item keeps the art it was added with) or the card's.
 */
export function withCard<T extends { metaId: string; type: MediaType } & TitleCard>(entry: T, cards: HistoryDoc['cards'], own: 'entry' | 'card' = 'entry'): T & TitleCard {
  // History is under the IMDb id once it is known; for the moment between learning it and the
  // entries moving over, a card may already be under the new id.
  const c = cards[titleKey(entry.metaId, entry.type)] ?? cards[titleKey(canonicalNow(entry.metaId, entry.type), entry.type)];
  const [a, b]: [TitleCard | undefined, TitleCard | undefined] = own === 'entry' ? [entry, c] : [c, entry];
  return {
    ...entry,
    name: a?.name ?? b?.name,
    poster: artLink(a?.poster) ?? artLink(b?.poster),
    background: artLink(a?.background, 'w1280') ?? artLink(b?.background, 'w1280'),
    logo: artLink(a?.logo) ?? artLink(b?.logo),
    year: a?.year ?? b?.year,
  };
}

// ---------- Remembered pictures that no longer load ----------

/** Wait this long after a picture fails before looking into it (several fail together). */
const CHECK_AFTER_MS = 1500;
/** Links looked into at once. */
const CHECK_ACTIVE_MAX = 2;

let watching = false;
const suspects = new Set<string>();
/** Looked into during this run already, dead or not. */
const checked = new Set<string>();
let checkTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Notices when a picture fails to load anywhere in the window. If it is one history remembers
 * for a title (a card's, a watchlist item's, a resume point's) and its server says it is gone,
 * it is forgotten, kept out of future answers, and the title's art is asked for again: the card
 * gets a picture that works instead of staying broken. A server that merely does not answer, or
 * being offline, changes nothing.
 */
export function watchBrokenArt() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  // `error` does not bubble, but it can be caught on the way down.
  window.addEventListener(
    'error',
    (ev) => {
      const el = ev.target;
      if (!(el instanceof HTMLImageElement)) return;
      const src = el.currentSrc || el.src;
      if (!/^https?:\/\//i.test(src) || checked.has(artIdentity(src))) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      suspects.add(src);
      checkTimer ??= setTimeout(() => {
        checkTimer = undefined;
        void checkSuspects();
      }, CHECK_AFTER_MS);
    },
    true,
  );
}

type Remembered = { url: string; metaId: string; type: MediaType };

/** Every picture link history holds for a title, by `artIdentity`. */
function rememberedArt(): Map<string, Remembered[]> {
  const h = useHistory.getState();
  const out = new Map<string, Remembered[]>();
  const note = (url: string | undefined, metaId: string, type: MediaType) => {
    const link = usableArt(url);
    if (!link || !url) return;
    const id = artIdentity(link);
    out.set(id, [...(out.get(id) ?? []), { url, metaId, type }]);
  };
  for (const [key, c] of Object.entries(h.cards)) {
    const metaId = key.replace(/@(movie|series)$/i, '');
    for (const url of [c.poster, c.background, c.logo]) note(url, metaId, c.type);
  }
  for (const all of [h.library, h.progress] as Record<string, { metaId: string; type: MediaType } & TitleCard>[]) {
    for (const e of Object.values(all)) for (const url of [e.poster, e.background, e.logo]) note(url, e.metaId, e.type);
  }
  return out;
}

async function isGone(url: string): Promise<boolean> {
  try {
    const res = await nativeFetch({ url, method: 'GET', timeoutMs: 10000 });
    return saysGone(res.status, res.headers['content-type']);
  } catch {
    // Could not be asked (no network, or a browser that may not read it): says nothing.
    return false;
  }
}

async function checkSuspects() {
  const batch = [...suspects];
  suspects.clear();
  const remembered = rememberedArt();
  const mine = batch.filter((src) => !checked.has(artIdentity(src)) && remembered.has(artIdentity(src)));
  for (const src of batch) checked.add(artIdentity(src));
  if (!mine.length) return;
  await loadGone();
  let next = 0;
  const dead: Remembered[] = [];
  const worker = async () => {
    while (next < mine.length) {
      const id = artIdentity(mine[next++]);
      const holders = remembered.get(id)!;
      // The link as it was remembered: a card may have asked for another size of it.
      const link = usableArt(holders[0].url);
      if (link && (await isGone(link))) {
        gone.add(link);
        dead.push(...holders);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_ACTIVE_MAX, mine.length) }, worker));
  if (!dead.length) return;
  goneWriter.save(gone.toJSON());
  useHistory.getState().forgetArt([...new Set(dead.map((d) => d.url))]);
  for (const d of dead) artQueue().again(d.metaId, d.type);
}
