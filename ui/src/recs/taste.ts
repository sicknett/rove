// The taste profile: what a profile's history says about what it likes. Everything here is a
// pure function of the history (and the time), so it can be tested without a network.
//
// A title's weight is how much of it was watched ("depth") times how long ago ("recency"). The
// strongest titles become seeds: the titles recommendations are asked for. Their TMDB genres,
// fetched elsewhere for the seeds only, add up to genre affinities.

import { isImdbId, titleKey, tmdbTitleNumber } from '../addons/ids';
import type { HistoryDoc, LibraryItem, MediaType } from '../state/history';

export type Kind = 'movie' | 'tv';
export const kindOf = (type: MediaType): Kind => (type === 'movie' ? 'movie' : 'tv');
export const typeOf = (kind: Kind): MediaType => (kind === 'movie' ? 'movie' : 'series');
/** How a TMDB title is named in sets and saved documents: `movie:603`. */
export const refKey = (kind: Kind, id: number) => `${kind}:${id}`;

const DAY_MS = 24 * 3600 * 1000;
/** A title watched this long ago counts half as much as one watched today. */
export const HALF_LIFE_DAYS = 60;
/** However old, a title that was watched keeps this share of its weight: an old favourite is still taste. */
export const RECENCY_FLOOR = 0.1;
/** Under this weight a title says too little to ask recommendations for. */
export const SEED_MIN_WEIGHT = 0.2;
/** From this depth a title was watched enough to say "Because you watched" about it. */
export const STRONG_DEPTH = 0.5;
/** Seeds kept per type. Each costs one TMDB request per refresh, so this bounds the cost. */
export const SEEDS_PER_KIND = 6;
/** A title put on the watchlist and not started: interest, but less than watching it. */
const WATCHLIST_DEPTH = 0.35;
/** A resume point this far in counts as watching the title (the same share For you uses). */
const ENGAGED_SHARE = 0.5;
/** Under this share a title was only tried. */
const TRIED_SHARE = 0.15;
/** Something started and left alone for this long was given up on. */
const ABANDONED_AFTER_DAYS = 30;
/** A show marked watched as a whole (no episodes listed) counts as this many episodes. */
const WHOLE_SHOW_EPISODES = 8;

type History = Pick<HistoryDoc, 'progress' | 'watched' | 'library' | 'cards'>;

export interface TasteSignal {
  /** The title's history key (see addons/ids titleKey). */
  key: string;
  metaId: string;
  type: MediaType;
  tmdbId?: number;
  name?: string;
  /** How much of it was watched: 0 for a title given up on, about 1 for a film seen or a show well into, more for a long binge or a rewatch. */
  depth: number;
  /** The newest activity on it. */
  at: number;
  /** depth × recency. */
  weight: number;
  /** Watched, not only put on the watchlist. */
  watched: boolean;
}

export function recency(at: number, now: number): number {
  const ageDays = Math.max(0, now - at) / DAY_MS;
  return Math.max(RECENCY_FLOOR, 0.5 ** (ageDays / HALF_LIFE_DAYS));
}

/**
 * A film: seen is 1 (a little more for each time it was seen again). Unfinished, it depends on
 * how far it got: past half is nearly as good as seen; a part of it is a weak signal while it is
 * recent; a film left in its first minutes, or left alone for a month, says nothing.
 */
export function movieDepth(m: { watched: boolean; plays?: number; share?: number; ageDays: number }): number {
  if (m.watched) return Math.min(1.5, 1 + 0.25 * Math.max(0, (m.plays ?? 1) - 1));
  const share = m.share ?? 0;
  if (share >= ENGAGED_SHARE) return 0.7;
  if (share >= TRIED_SHARE && m.ageDays < ABANDONED_AFTER_DAYS) return 0.3;
  return 0;
}

/**
 * A show: every episode adds, the first ones most (two episodes is about half, six nearly all),
 * and a long run keeps adding a little, so thirty episodes outweigh six. One episode is a weak
 * signal while it is recent and none once the show was left alone for a month: it was tried and
 * dropped.
 */
export function seriesDepth(s: { episodes: number; ageDays: number }): number {
  const n = s.episodes;
  if (n <= 0) return 0;
  if (n < 1.5) return s.ageDays < ABANDONED_AFTER_DAYS ? 0.3 * Math.min(1, n) : 0;
  return 1 - Math.exp(-n / 3) + 0.3 * Math.min(1, n / 30);
}

/** Ids TMDB (or the id map, through PublicMetaDB) can turn into a TMDB title. Server items and bare links cannot be. */
function resolvable(metaId: string, tmdbId: number | undefined): boolean {
  return !!tmdbId || isImdbId(metaId) || tmdbTitleNumber(metaId) !== null || /^(tvdb|mal|anilist|kitsu):/i.test(metaId);
}

interface Seen {
  metaId: string;
  type: MediaType;
  tmdbId?: number;
  name?: string;
  at: number;
  movieWatched: boolean;
  plays: number;
  /** A film's resume point, as a share of it. */
  share: number;
  episodes: Set<string>;
  /** Episodes in progress past half, not finished. */
  halves: Set<string>;
  wholeShow: boolean;
}

/** Every title with a watched mark or a resume point, with what is known about how much was watched. */
function seenTitles(h: History): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  const entry = (metaId: string, type: MediaType, tmdbId: number | undefined, at: number, name?: string): Seen => {
    const key = titleKey(metaId, type);
    let e = seen.get(key);
    if (!e) {
      e = { metaId, type, at: 0, movieWatched: false, plays: 0, share: 0, episodes: new Set(), halves: new Set(), wholeShow: false };
      seen.set(key, e);
    }
    e.tmdbId ??= tmdbId ?? tmdbTitleNumber(metaId) ?? undefined;
    e.name ??= h.cards[key]?.name ?? name ?? h.library[key]?.name;
    e.at = Math.max(e.at, at || 0);
    return e;
  };
  for (const w of Object.values(h.watched)) {
    const e = entry(w.metaId, w.type, w.tmdbId, w.at);
    if (w.type === 'movie') {
      e.movieWatched = true;
      e.plays = Math.max(e.plays, w.plays ?? 1);
    } else if (w.season !== undefined && w.episode !== undefined) e.episodes.add(`${w.season}:${w.episode}`);
    else e.wholeShow = true;
  }
  for (const p of Object.values(h.progress)) {
    const e = entry(p.metaId, p.type, p.tmdbId, p.updatedAt, p.name);
    const share = p.durationS > 0 ? p.positionS / p.durationS : 0;
    if (p.type === 'movie') e.share = Math.max(e.share, share);
    else if (share >= ENGAGED_SHARE) e.halves.add(`${p.season}:${p.episode}`);
  }
  return seen;
}

/**
 * Every title in the history that says something, strongest first: watched and started titles by
 * depth × recency, and watchlist titles not started yet as a weaker signal of their own.
 */
export function tasteSignals(h: History, now: number): TasteSignal[] {
  const out: TasteSignal[] = [];
  const seen = seenTitles(h);
  for (const [key, e] of seen) {
    const ageDays = Math.max(0, now - e.at) / DAY_MS;
    let depth: number;
    if (e.type === 'movie') depth = movieDepth({ watched: e.movieWatched, plays: e.plays, share: e.share, ageDays });
    else {
      let episodes = e.episodes.size + (e.wholeShow ? WHOLE_SHOW_EPISODES : 0);
      for (const half of e.halves) if (!e.episodes.has(half)) episodes += 0.5;
      depth = seriesDepth({ episodes, ageDays });
    }
    if (depth <= 0) continue;
    out.push({ key, metaId: e.metaId, type: e.type, tmdbId: e.tmdbId, name: e.name, depth, at: e.at, weight: depth * recency(e.at, now), watched: true });
  }
  for (const [key, item] of Object.entries(h.library)) {
    // Started or watched: the watching says more than the listing, and is counted above.
    if (seen.has(key)) continue;
    const at = item.addedAt || 0;
    out.push({ key, metaId: item.metaId, type: item.type, tmdbId: item.tmdbId ?? tmdbTitleNumber(item.metaId) ?? undefined, name: h.cards[key]?.name ?? item.name, depth: WATCHLIST_DEPTH, at, weight: WATCHLIST_DEPTH * recency(at, now), watched: false });
  }
  return out.sort((a, b) => b.weight - a.weight || b.at - a.at || a.key.localeCompare(b.key));
}

export interface TasteBase {
  signals: TasteSignal[];
  /** The strongest titles of each type: what recommendations are asked for. */
  seeds: { movies: TasteSignal[]; shows: TasteSignal[] };
  /** Which titles the seeds are, whatever their order: the profile is worked out again when this changes. */
  fingerprint: string;
}

export function buildTaste(h: History, now: number): TasteBase {
  const signals = tasteSignals(h, now);
  const seedable = signals.filter((s) => s.weight >= SEED_MIN_WEIGHT && resolvable(s.metaId, s.tmdbId));
  const movies = seedable.filter((s) => s.type === 'movie').slice(0, SEEDS_PER_KIND);
  const shows = seedable.filter((s) => s.type === 'series').slice(0, SEEDS_PER_KIND);
  const fingerprint = [...movies, ...shows]
    .map((s) => s.key)
    .sort()
    .join('|');
  return { signals, seeds: { movies, shows }, fingerprint };
}

/** Every title the profile already has something on, in the two ways a TMDB title can be matched to it. */
export interface KnownTitles {
  /** History keys (IMDb ids mostly). */
  keys: Set<string>;
  /** TMDB titles (`movie:603`), for entries that carry their TMDB number. */
  tmdb: Set<string>;
  /** Titles whose TMDB number the history does not have: only the id map can match them to a TMDB title. */
  unnumbered: { key: string; metaId: string; type: MediaType; at: number }[];
}

/**
 * What recommendations leave out: everything watched (any episode of a show), everything started,
 * and everything on the watchlist. Matched by history key and by TMDB number, since history holds
 * IMDb ids and TMDB answers with its own.
 */
export function knownTitles(h: Pick<HistoryDoc, 'progress' | 'watched' | 'library'>): KnownTitles {
  const keys = new Set<string>();
  const tmdb = new Set<string>();
  const unnumbered = new Map<string, { key: string; metaId: string; type: MediaType; at: number }>();
  /** Titles some entry gave a TMDB number for: one episode's mark carrying it covers the show. */
  const numbered = new Set<string>();
  const note = (metaId: string, type: MediaType, tmdbId: number | undefined, at: number) => {
    const key = titleKey(metaId, type);
    keys.add(key);
    const n = tmdbId ?? tmdbTitleNumber(metaId);
    if (n) {
      tmdb.add(refKey(kindOf(type), n));
      numbered.add(key);
      unnumbered.delete(key);
    } else if (!numbered.has(key) && resolvable(metaId, undefined)) {
      const prev = unnumbered.get(key);
      unnumbered.set(key, { key, metaId, type, at: Math.max(prev?.at ?? 0, at || 0) });
    }
  };
  for (const w of Object.values(h.watched)) note(w.metaId, w.type, w.tmdbId, w.at);
  for (const p of Object.values(h.progress)) note(p.metaId, p.type, p.tmdbId, p.updatedAt);
  for (const l of Object.values(h.library)) note(l.metaId, l.type, l.tmdbId, l.addedAt);
  return { keys, tmdb, unnumbered: [...unnumbered.values()].sort((a, b) => b.at - a.at) };
}

/** Watchlist titles with nothing watched and nothing started, most recently added first. */
export function unstartedWatchlist(h: Pick<HistoryDoc, 'progress' | 'watched' | 'library'>): LibraryItem[] {
  const started = new Set<string>();
  for (const w of Object.values(h.watched)) started.add(titleKey(w.metaId, w.type));
  for (const p of Object.values(h.progress)) started.add(titleKey(p.metaId, p.type));
  return Object.entries(h.library)
    .filter(([key]) => !started.has(key))
    .map(([, item]) => item)
    .sort((a, b) => b.addedAt - a.addedAt);
}

// ---------- Genres ----------

export interface Genre {
  id: number;
  name: string;
}

export interface GenreAffinity extends Genre {
  kind: Kind;
  score: number;
}

/**
 * Genres nearly everything carries: a count of them says less about a taste than a count of
 * Crime or Western does, so they add less.
 */
const BROAD_GENRES: Record<number, number> = { 18: 0.6, 35: 0.8 };
/** TMDB's "TV Movie" is a format, not a taste. */
const NOT_A_TASTE = new Set([10770]);

/**
 * How much the profile leans to each genre, movies and shows apart (TMDB numbers their genres
 * separately), strongest first. A seed adds its weight to each of its genres, less to each the
 * more genres it has, so a film tagged with five does not count five times.
 */
export function genreAffinities(seeds: { kind: Kind; weight: number; genres: Genre[] }[]): GenreAffinity[] {
  const byKey = new Map<string, GenreAffinity>();
  for (const s of seeds) {
    const genres = s.genres.filter((g) => !NOT_A_TASTE.has(g.id));
    if (!genres.length || !(s.weight > 0)) continue;
    const share = s.weight / Math.sqrt(genres.length);
    for (const g of genres) {
      const key = `${s.kind}:${g.id}`;
      const a = byKey.get(key) ?? { kind: s.kind, id: g.id, name: g.name, score: 0 };
      a.score += share * (BROAD_GENRES[g.id] ?? 1);
      byKey.set(key, a);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.id - b.id || a.kind.localeCompare(b.kind));
}

/**
 * The genres TMDB numbers differently for shows and for movies, each way. Everything else that
 * both have (Drama, Crime, Comedy, …) shares one number.
 */
const TV_TO_MOVIE: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751] };
const MOVIE_TO_TV: Record<number, number[]> = { 28: [10759], 12: [10759], 878: [10765], 14: [10765], 10752: [10768] };
/** Genres both kinds have under one number. */
const SHARED_GENRES = new Set([16, 35, 80, 99, 18, 10751, 9648, 37]);
/** A genre learned from the other kind counts this much: someone who watches crime shows probably likes crime films, less surely. */
const CROSS_KIND = 0.5;

/**
 * The profile's top genre ids for one kind, for a discover query. Genres seen only on the other
 * kind count too, at half strength, so a profile that watches nothing but shows still gets
 * movies in its genres.
 */
export function topGenres(kind: Kind, affinities: GenreAffinity[], count = 3): number[] {
  const score = new Map<number, number>();
  const add = (id: number, s: number) => score.set(id, (score.get(id) ?? 0) + s);
  for (const a of affinities) {
    if (a.kind === kind) add(a.id, a.score);
    else {
      const mapped = (kind === 'movie' ? TV_TO_MOVIE : MOVIE_TO_TV)[a.id] ?? (SHARED_GENRES.has(a.id) ? [a.id] : []);
      for (const id of mapped) add(id, a.score * CROSS_KIND);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, count)
    .map(([id]) => id);
}

/** A language needs this share of the seeds' weight to count as one the profile watches. */
const LANGUAGE_SHARE = 0.15;

/**
 * The languages the profile watches in, by the seeds' original languages: every language with a
 * real share of what was watched, most watched first, three at most. Discover rows are kept to
 * these, or a list of well-rated dramas is mostly in languages the profile never watches.
 * Empty when the seeds' languages are not known.
 */
export function topLanguages(seeds: { weight: number; language?: string }[], count = 3): string[] {
  const byLanguage = new Map<string, number>();
  let total = 0;
  for (const s of seeds) {
    if (!s.language || !(s.weight > 0)) continue;
    byLanguage.set(s.language, (byLanguage.get(s.language) ?? 0) + s.weight);
    total += s.weight;
  }
  return [...byLanguage.entries()]
    .filter(([, w]) => w / total >= LANGUAGE_SHARE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([language]) => language);
}

/** The genres that get a row of their own: the strongest, then the strongest of another genre. */
export function genreRowPicks(affinities: GenreAffinity[], count = 2): GenreAffinity[] {
  const picks: GenreAffinity[] = [];
  for (const a of affinities) {
    if (picks.length >= count) break;
    if (picks.some((p) => p.id === a.id)) continue;
    picks.push(a);
  }
  // One genre is all there is (a single seed tagged with one): its other kind is better than no second row.
  if (picks.length < count) for (const a of affinities) if (picks.length < count && !picks.includes(a)) picks.push(a);
  return picks;
}

/** "Crime shows for you", "Science Fiction movies for you". */
export function genreRowTitle(g: Pick<GenreAffinity, 'kind' | 'name'>): string {
  if (g.name === 'Documentary') return g.kind === 'movie' ? 'Documentaries for you' : 'Documentary shows for you';
  return `${g.name} ${g.kind === 'movie' ? 'movies' : 'shows'} for you`;
}
