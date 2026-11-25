// Card art: where a title's name and pictures come from, in what order, and what happens when
// they do not arrive. No store, no network and no DOM in here (library/cardArt.ts wires those
// in), so the order and the failure handling can be tested as they are.
//
// The order, for one title:
//  1. TMDB, when there is a key and the title can be asked about there: by its TMDB number (the
//     one a tracker sent with the entry, or a `tmdb:` id), else by its IMDb id. One small request.
//  2. The metadata addons, only for what TMDB did not give: no key, TMDB does not know the title,
//     TMDB has no poster for it, TMDB could not be reached, or the id is neither kind.
// What either gives is kept (history's cards), TMDB's fields first, the addons filling the gaps.
//
// When they do not arrive:
//  - a source that could not be asked (offline, rate limit, server error) says nothing about the
//    title: it is asked again, a little later each time, for as long as the card is on screen;
//  - sources that answered and had nothing settle it for hours, not for good;
//  - a picture link known to be dead is never taken as an answer.

import { isImdbId, parseId, titleKey, tmdbTitleNumber } from '../addons/ids';
import type { Meta } from '../addons/types';
import type { TmdbArt, TmdbKind } from '../meta/tmdb';
import type { MediaType, TitleCard } from '../state/history';

export interface ArtWanted {
  metaId: string;
  type: MediaType;
  /** The title's TMDB number, when the entry carries one (a tracker's do). */
  tmdbId?: number;
  /** Logo art too (wide cards show it). */
  logo?: boolean;
}

export interface ArtSources {
  /** Whether TMDB can be asked at all (there is a key). */
  hasTmdb: () => boolean;
  byNumber: (kind: TmdbKind, id: number, logo: boolean) => Promise<TmdbArt | null>;
  byImdb: (imdbId: string, prefer: TmdbKind) => Promise<TmdbArt | null>;
  addons: (type: MediaType, metaId: string) => Promise<Meta | null>;
  /** False for a picture link that must not be used (known dead). */
  usable?: (url: string) => boolean;
}

export interface ArtFound {
  /** Whatever was found; empty when nothing was. */
  card: TitleCard;
  /** A name and a poster: nothing more to ask for. */
  complete: boolean;
  /** A source could not be asked, and the card is not complete: worth asking again soon. */
  failed: boolean;
  /** Which TMDB title this is, when TMDB answered by IMDb id (so the id map can learn it). */
  tmdb?: { id: number; kind: TmdbKind };
  /** What was asked, in order. */
  asked: ('tmdb' | 'addons')[];
}

/** Without the keys that hold nothing. */
function filled<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/** One title's art, by the order at the top of this file. Never throws. */
export async function resolveArt(want: ArtWanted, src: ArtSources): Promise<ArtFound> {
  const ok = (url: string | undefined) => (url && (src.usable?.(url) ?? true) ? url : undefined);
  const kind: TmdbKind = want.type === 'movie' ? 'movie' : 'tv';
  const base = parseId(want.metaId).base;
  const asked: ArtFound['asked'] = [];
  let card: TitleCard = {};
  let failed = false;
  let tmdb: ArtFound['tmdb'];

  const number = want.tmdbId && want.tmdbId > 0 ? want.tmdbId : tmdbTitleNumber(base);
  const imdb = isImdbId(base) ? base : null;
  if (!base.startsWith('srv:') && (number !== null || imdb) && src.hasTmdb()) {
    asked.push('tmdb');
    try {
      const art = number !== null ? await src.byNumber(kind, number, !!want.logo) : await src.byImdb(imdb!, kind);
      if (art) {
        card = filled({ name: art.name, poster: ok(art.poster), background: ok(art.background), logo: ok(art.logo), year: art.year });
        if (number === null) tmdb = { id: art.id, kind: art.kind };
      }
    } catch {
      failed = true;
    }
  }

  if (!card.poster || !card.name) {
    asked.push('addons');
    try {
      const m = await src.addons(want.type, want.metaId);
      // TMDB's fields stand; the addon fills what is missing.
      if (m) card = { ...filled({ name: m.name, poster: ok(m.poster), background: ok(m.background), logo: ok(m.logo), year: m.releaseInfo ?? (m.year ? String(m.year) : undefined) }), ...card };
    } catch {
      failed = true;
    }
  }

  const complete = !!card.poster && !!card.name;
  return { card, complete, failed: failed && !complete, tmdb, asked };
}

// ---------- The queue ----------

/** Sources answered and had nothing (or only part): ask again after this long. */
export const NOTHING_RETRY_MS = 6 * 3600 * 1000;
/** A source could not be asked: again after this long, doubling each time, up to the cap. */
export const FAILED_RETRY_MS = 30 * 1000;
export const FAILED_RETRY_MAX_MS = 10 * 60 * 1000;
/** Requests in flight at once. Each is one small TMDB answer, or one addon's. */
export const ART_ACTIVE_MAX = 6;
/** Answers are written to history together, this long after the first of a batch. */
const REMEMBER_AFTER_MS = 80;
/**
 * A title that was completed is expected to stop being wanted (its card now has the art). One
 * still wanted this long after is asked about once more: the history it was written to is not
 * the one on screen any more (another profile was opened).
 */
export const DONE_GRACE_MS = 10 * 1000;

export interface ArtResult {
  metaId: string;
  type: MediaType;
  card: TitleCard;
  tmdb?: { id: number; kind: TmdbKind };
}

export interface ArtQueueDeps {
  resolve: (want: ArtWanted) => Promise<ArtFound>;
  /** Everything found since the last call, at once (one write for a screenful). */
  remember: (found: ArtResult[]) => void;
  now?: () => number;
  /** setTimeout, returning the way to cancel. */
  later?: (run: () => void, ms: number) => () => void;
  maxActive?: number;
}

interface Status {
  state: 'asking' | 'done' | 'resting';
  /** Not asked again before this. */
  until: number;
  /** Failures in a row (`resting`), or times completed (`done`). */
  tries: number;
}

export interface ArtQueue {
  /** What `owner` (a screen's list) wants now, most wanted first. Replaces what it wanted before. */
  want: (owner: object, list: ArtWanted[]) => void;
  /** `owner` is gone: what only it wanted and has not been asked for yet is dropped. */
  release: (owner: object) => void;
  /** The title's art is to be asked for again (its remembered picture turned out dead). */
  again: (metaId: string, type: MediaType) => void;
  /** Requests in flight. */
  active: () => number;
}

/**
 * Asks for art a few titles at a time. Only what some owner still wants is ever started, the
 * newest owner's list first, so a list scrolled past costs nothing; a title is asked for once
 * however many lists want it, and what came of it decides when (if ever) it is asked again.
 */
export function createArtQueue(deps: ArtQueueDeps): ArtQueue {
  const now = deps.now ?? Date.now;
  const later =
    deps.later ??
    ((run, ms) => {
      const t = setTimeout(run, ms);
      return () => clearTimeout(t);
    });
  const max = deps.maxActive ?? ART_ACTIVE_MAX;
  const owners = new Map<object, ArtWanted[]>();
  const status = new Map<string, Status>();
  let found: ArtResult[] = [];
  let active = 0;
  let cancelFlush: (() => void) | null = null;
  let cancelWake: (() => void) | null = null;

  const keyOf = (w: { metaId: string; type: MediaType }) => titleKey(w.metaId, w.type);

  const flush = () => {
    cancelFlush = null;
    const batch = found;
    found = [];
    if (batch.length) deps.remember(batch);
  };

  /** The next title to ask about, and when the earliest resting one wakes. */
  const next = (): { want?: ArtWanted; wake?: number } => {
    const t = now();
    let wake: number | undefined;
    for (const list of [...owners.values()].reverse()) {
      for (const w of list) {
        const s = status.get(keyOf(w));
        if (!s) return { want: w };
        if (s.state === 'asking') continue;
        if (s.until <= t) return { want: w };
        wake = Math.min(wake ?? Infinity, s.until);
      }
    }
    return { wake };
  };

  const pump = () => {
    cancelWake?.();
    cancelWake = null;
    while (active < max) {
      const { want, wake } = next();
      if (!want) {
        // Something on screen is resting: look again when it may be asked.
        if (wake !== undefined) cancelWake = later(pump, Math.max(50, wake - now()));
        return;
      }
      // One request serves every list that wants the title: with the logo if any of them does.
      const key = keyOf(want);
      const logo = want.logo || [...owners.values()].some((list) => list.some((w) => w.logo && keyOf(w) === key));
      void ask(logo === !!want.logo ? want : { ...want, logo });
    }
  };

  const ask = async (want: ArtWanted) => {
    const key = keyOf(want);
    const before = status.get(key);
    const tries = before?.state === 'resting' ? before.tries : 0;
    const completed = before?.state === 'done' ? before.tries : 0;
    status.set(key, { state: 'asking', until: 0, tries });
    active++;
    let out: ArtFound;
    try {
      out = await deps.resolve(want);
    } catch {
      out = { card: {}, complete: false, failed: true, asked: [] };
    }
    active--;
    if (Object.keys(out.card).length || out.tmdb) {
      found.push({ metaId: want.metaId, type: want.type, card: out.card, tmdb: out.tmdb });
      cancelFlush ??= later(flush, REMEMBER_AFTER_MS);
    }
    // Completed a second time and wanted even so: it is not this queue's to fix. Left for hours.
    if (out.complete) status.set(key, { state: 'done', until: now() + (completed ? NOTHING_RETRY_MS : DONE_GRACE_MS), tries: completed + 1 });
    else if (out.failed) status.set(key, { state: 'resting', until: now() + Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_MS * 2 ** tries), tries: tries + 1 });
    else status.set(key, { state: 'resting', until: now() + NOTHING_RETRY_MS, tries: 0 });
    pump();
  };

  return {
    want(owner, list) {
      // Set again so the owner that asked last is served first.
      owners.delete(owner);
      if (list.length) owners.set(owner, list);
      pump();
    },
    release(owner) {
      owners.delete(owner);
    },
    again(metaId, type) {
      const key = keyOf({ metaId, type });
      if (status.get(key)?.state !== 'asking') status.delete(key);
      pump();
    },
    active: () => active,
  };
}

// ---------- Dead picture links ----------

/** A dead link is not offered again for this long (a host that was only down gets another go). */
export const GONE_FOR_MS = 7 * 24 * 3600 * 1000;
const GONE_MAX = 800;

/** The same picture whatever size of it TMDB was asked for. */
export function artIdentity(url: string): string {
  return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, '$1*/');
}

/** Picture links known not to load, until when. Saved by whoever owns it (see cardArt). */
export class GoneArt {
  private until = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  load(saved: unknown) {
    if (!saved || typeof saved !== 'object') return;
    for (const [url, t] of Object.entries(saved as Record<string, unknown>)) if (typeof t === 'number' && t > this.now()) this.until.set(url, t);
  }

  add(url: string) {
    this.until.set(artIdentity(url), this.now() + GONE_FOR_MS);
    while (this.until.size > GONE_MAX) this.until.delete(this.until.keys().next().value as string);
  }

  has(url: string): boolean {
    const id = artIdentity(url);
    const t = this.until.get(id);
    if (t === undefined) return false;
    if (t > this.now()) return true;
    this.until.delete(id);
    return false;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.until);
  }
}

/**
 * A remembered picture as something an `<img>` can load: a full link as it is, a bare TMDB image
 * path (`/abc.jpg`, which some trackers send) as that TMDB picture, anything else as nothing.
 * Nothing as well for a link known to be dead.
 */
export function usableArt(url: string | null | undefined, gone?: GoneArt, size: 'w342' | 'w1280' = 'w342'): string | undefined {
  if (!url) return undefined;
  const link = /^https?:\/\//i.test(url) ? url : url.startsWith('//') ? `https:${url}` : /^\/[\w-]+\.(jpe?g|png|webp|svg)$/i.test(url) ? `https://image.tmdb.org/t/p/${size}${url}` : undefined;
  return link && !gone?.has(link) ? link : undefined;
}

/** What says a link is gone for good, as opposed to a server having a bad moment. */
export function saysGone(status: number, contentType: string | undefined): boolean {
  if (status === 401 || status === 403 || status === 404 || status === 410) return true;
  // Answered, but not with a picture (an error page served as 200).
  if (status >= 200 && status < 300) return !!contentType && !/^(image\/|application\/octet-stream|binary\/)/i.test(contentType.trim());
  return false;
}
