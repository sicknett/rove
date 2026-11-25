// Discover's filters: what the route carries, what the bar offers, the TMDB request they stand
// for, and the Home row they can be saved as. Nothing here asks for anything or touches a store,
// so all of it is tested without a screen (filters.test.ts).
//
// One filter set has one written form (`normalize`) and one TMDB source (`toSource`). The grid,
// the count above it and a row saved to Home all read that same source, so what Discover shows
// is what the row will show.

import type { DiscoverFilters, Route } from '../../nav/router';
import type { CollectionSource } from '../../state/collections';
import { genreName, genresForKind, genresOf, KID_GENRE, type Kind } from '../shared/genres';
import type { TitleHit } from '../shared/hits';

export type { DiscoverFilters };

export const kindOf = (f: DiscoverFilters | null | undefined): Kind => (f?.kind === 'tv' ? 'tv' : 'movie');

// ---------- The written form ----------

const whole = (v: unknown, min: number, max: number): number | undefined => {
  const n = Math.round(Number(v));
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

const numbers = (v: unknown): number[] =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => whole(x, 1, 10_000_000)).filter((x): x is number => x !== undefined))].sort((a, b) => a - b);

/**
 * Any filter set in its one written form: only what narrows, nothing out of range, lists sorted,
 * the keys always in the same order. Two sets that ask for the same thing come out identical, so
 * they are the same route and the same cached answer. What cannot apply is dropped: a genre the
 * kind does not have, a running time for shows, providers without a country to look them up in.
 */
export function normalize(input: DiscoverFilters | null | undefined): DiscoverFilters {
  const f = input ?? {};
  const kind = kindOf(f);
  const out: DiscoverFilters = {};
  if (kind === 'tv') out.kind = 'tv';
  const known = new Set(genresOf(kind).map((g) => g.id));
  const genres = numbers(f.genres).filter((g) => known.has(g));
  if (genres.length) out.genres = genres;
  const recent = whole(f.recent, 1, 3650);
  if (recent) out.recent = recent;
  else {
    let from = whole(f.from, 1870, 2100);
    let to = whole(f.to, 1870, 2100);
    if (from && to && from > to) [from, to] = [to, from];
    if (from) out.from = from;
    if (to) out.to = to;
  }
  const rating = Math.round(Number(f.rating) * 2) / 2;
  if (Number.isFinite(rating) && rating > 0 && rating <= 10) out.rating = rating;
  if (kind === 'movie') {
    let min = whole(f.runtimeMin, 1, 600);
    let max = whole(f.runtimeMax, 1, 600);
    if (min && max && min > max) [min, max] = [max, min];
    if (min) out.runtimeMin = min;
    if (max) out.runtimeMax = max;
  }
  const votesMin = whole(f.votesMin, 1, 10_000_000);
  const votesMax = whole(f.votesMax, 1, 10_000_000);
  if (votesMin) out.votesMin = votesMin;
  if (votesMax && (!votesMin || votesMax >= votesMin)) out.votesMax = votesMax;
  if (typeof f.language === 'string' && /^[a-z]{2}$/.test(f.language)) out.language = f.language;
  const providers = numbers(f.providers);
  const region = typeof f.region === 'string' && /^[A-Z]{2}$/.test(f.region) ? f.region : undefined;
  if (providers.length && region) {
    out.providers = providers;
    out.region = region;
  }
  if (f.sort === 'rating' || f.sort === 'newest' || f.sort === 'votes') out.sort = f.sort;
  return out;
}

export const sameFilters = (a: DiscoverFilters | null | undefined, b: DiscoverFilters | null | undefined) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/** Anything set besides Movies or Shows: what Reset would clear. */
export const isNarrowed = (f: DiscoverFilters) => Object.keys(normalize(f)).some((k) => k !== 'kind');

export type DiscoverRoute = Extract<Route, { name: 'discover' }>;

/**
 * The route for a filter set. With nothing set it is the plain Discover route, so the tab and
 * "all movies" are one page. `rest` carries the catalogs mode and what it is looking at, which
 * stay in the route while the filters are on show (and the reverse), so switching between the
 * two brings each back as it was left. Always written in the same order, for `sameRoute`.
 */
export function discoverRoute(filters: DiscoverFilters | null | undefined, rest: Pick<DiscoverRoute, 'mode' | 'type' | 'catalog' | 'genre'> = {}): DiscoverRoute {
  const route: DiscoverRoute = { name: 'discover' };
  if (rest.mode) route.mode = rest.mode;
  if (rest.type) route.type = rest.type;
  if (rest.catalog) route.catalog = rest.catalog;
  if (rest.genre) route.genre = rest.genre;
  const f = normalize(filters);
  if (Object.keys(f).length) route.filters = f;
  return route;
}

/** The same filters for the other kind: genres carried over where shows and movies share them. */
export function withKind(f: DiscoverFilters, kind: Kind): DiscoverFilters {
  if (kindOf(f) === kind) return normalize(f);
  return normalize({ ...f, kind: kind === 'tv' ? 'tv' : undefined, genres: genresForKind(f.genres ?? [], kind) });
}

// ---------- The TMDB source ----------

const SORT_BY: Record<Kind, Record<NonNullable<DiscoverFilters['sort']> | 'popular', string>> = {
  movie: { popular: 'popularity.desc', rating: 'vote_average.desc', newest: 'primary_release_date.desc', votes: 'vote_count.desc' },
  tv: { popular: 'popularity.desc', rating: 'vote_average.desc', newest: 'first_air_date.desc', votes: 'vote_count.desc' },
};

/**
 * The fewest votes a title needs. A score means little from a handful of votes, so asking for a
 * minimum rating asks for a few dozen, and "top rated" for the few hundred TMDB's own chart uses.
 * Newest first asks for a handful: without it the list opens with entries nobody has seen.
 */
function voteFloor(f: DiscoverFilters, kind: Kind): number | undefined {
  if (f.votesMin) return f.votesMin;
  if (f.sort === 'rating') return kind === 'movie' ? 300 : 150;
  if (f.rating) return 50;
  if (f.sort === 'newest') return 10;
  return undefined;
}

export interface SourceOptions {
  /** A Kids profile: Family or Kids titles only, and no film rated above PG. */
  kids?: boolean;
  title?: string;
}

/**
 * The TMDB discover source for a filter set, in the form collections and Home rows keep
 * (meta/tmdbSources.ts reads it). Dates that follow today (`recent`, the cut-off of "newest") are
 * written as `today…`, which is resolved when the request is made: a saved row moves with the
 * calendar.
 */
export function toSource(input: DiscoverFilters | null | undefined, opts: SourceOptions = {}): CollectionSource {
  const f = normalize(input);
  const kind = kindOf(f);
  const filters: Record<string, string | number> = {};
  const genres = opts.kids ? [...new Set([...(f.genres ?? []), KID_GENRE[kind]])].sort((a, b) => a - b) : f.genres ?? [];
  if (genres.length) filters.withGenres = genres.join(',');
  if (f.recent) {
    filters.releaseDateGte = `today-${f.recent}d`;
    filters.releaseDateLte = 'today';
  } else {
    if (f.from) filters.releaseDateGte = `${f.from}-01-01`;
    if (f.to) filters.releaseDateLte = `${f.to}-12-31`;
    // Newest first would otherwise open with titles announced for years from now.
    else if (f.sort === 'newest') filters.releaseDateLte = 'today';
  }
  if (f.rating) filters.voteAverageGte = f.rating;
  const floor = voteFloor(f, kind);
  if (floor) filters.voteCountGte = floor;
  if (f.votesMax) filters.voteCountLte = f.votesMax;
  if (f.runtimeMin) filters.withRuntimeGte = f.runtimeMin;
  if (f.runtimeMax) filters.withRuntimeLte = f.runtimeMax;
  if (f.language) filters.withOriginalLanguage = f.language;
  if (f.providers?.length && f.region) {
    filters.watchRegion = f.region;
    filters.withWatchProviders = f.providers.join('|');
  }
  if (opts.kids && kind === 'movie') {
    filters.certificationCountry = 'US';
    filters.certificationLte = 'PG';
  }
  const source: CollectionSource = { provider: 'tmdb', tmdbSourceType: 'DISCOVER', mediaType: kind === 'tv' ? 'TV' : 'MOVIE', sortBy: SORT_BY[kind][f.sort ?? 'popular'], filters };
  if (opts.title) source.title = opts.title;
  return source;
}

// ---------- What the bar offers ----------

export interface Choice<T> {
  value: string;
  label: string;
  detail?: string;
  set: T;
}

type When = Pick<DiscoverFilters, 'from' | 'to' | 'recent'>;
type Length = Pick<DiscoverFilters, 'runtimeMin' | 'runtimeMax'>;

/** When it came out: the last weeks, single recent years, then decades. `year` is this year. */
export function whenChoices(year: number): Choice<When>[] {
  const decades: Choice<When>[] = [];
  for (let d = Math.floor(year / 10) * 10; d >= 1960; d -= 10) decades.push({ value: `d${d}`, label: `${d}s`, set: { from: d, to: d + 9 } });
  return [
    { value: 'any', label: 'Any time', set: {} },
    { value: 'r30', label: 'Last 30 days', set: { recent: 30 } },
    { value: 'r365', label: 'Last 12 months', set: { recent: 365 } },
    { value: `y${year}`, label: String(year), set: { from: year, to: year } },
    { value: `y${year - 1}`, label: String(year - 1), set: { from: year - 1, to: year - 1 } },
    ...decades,
    { value: 'older', label: 'Before 1960', set: { to: 1959 } },
  ];
}

export const RATING_CHOICES: Choice<Pick<DiscoverFilters, 'rating'>>[] = [
  { value: 'any', label: 'Any rating', set: {} },
  { value: '6', label: 'Rated 6+', set: { rating: 6 } },
  { value: '7', label: 'Rated 7+', set: { rating: 7 } },
  { value: '8', label: 'Rated 8+', set: { rating: 8 } },
];

/** Films only. "Under 90 min" starts at an hour: it means a short feature, not a short. */
export const LENGTH_CHOICES: Choice<Length>[] = [
  { value: 'any', label: 'Any length', set: {} },
  { value: 'short', label: 'Under 90 min', set: { runtimeMin: 60, runtimeMax: 90 } },
  { value: 'mid', label: '90 to 120 min', set: { runtimeMin: 90, runtimeMax: 120 } },
  { value: 'long', label: 'Over 2 hours', set: { runtimeMin: 120 } },
];

export const SORT_CHOICES: Choice<Pick<DiscoverFilters, 'sort'>>[] = [
  { value: 'popular', label: 'Most popular', set: {} },
  { value: 'rating', label: 'Top rated', detail: 'With enough votes to mean it', set: { sort: 'rating' } },
  { value: 'newest', label: 'Newest', detail: 'Already out, latest first', set: { sort: 'newest' } },
  { value: 'votes', label: 'Most voted', detail: 'What the most people have rated', set: { sort: 'votes' } },
];

/** Original languages worth a place in a short list, most asked for first. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Mandarin' },
  { code: 'cn', name: 'Cantonese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'fa', name: 'Persian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'da', name: 'Danish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
];

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();

const written = <T extends object>(set: T, keys: (keyof DiscoverFilters)[]) => JSON.stringify(keys.map((k) => (set as DiscoverFilters)[k] ?? null));

/**
 * The choice that is in force for a group of filters. A value no choice stands for (a starting
 * point's "rated 7.5 and up", years set from elsewhere) gets a choice of its own under `label`,
 * placed second, so the control never shows something other than what is applied.
 */
export function chosen<T extends object>(choices: Choice<T>[], f: DiscoverFilters, keys: (keyof DiscoverFilters)[], label: string | undefined): { choices: Choice<T>[]; value: string } {
  const now = written(f, keys);
  const hit = choices.find((c) => written(c.set, keys) === now);
  if (hit) return { choices, value: hit.value };
  const own: Choice<T> = { value: 'own', label: label ?? 'Custom', set: Object.fromEntries(keys.map((k) => [k, f[k]])) as T };
  return { choices: [choices[0], own, ...choices.slice(1)], value: 'own' };
}

// ---------- In words ----------

export function whenLabel(f: DiscoverFilters): string | undefined {
  if (f.recent) return f.recent === 30 ? 'Last 30 days' : f.recent === 365 ? 'Last 12 months' : `Last ${f.recent} days`;
  if (f.from && f.to) return f.from === f.to ? String(f.from) : f.from % 10 === 0 && f.to === f.from + 9 ? `${f.from}s` : `${f.from}–${f.to}`;
  if (f.from) return `Since ${f.from}`;
  if (f.to) return `Before ${f.to + 1}`;
  return undefined;
}

export const ratingLabel = (f: DiscoverFilters) => (f.rating ? `Rated ${f.rating}+` : undefined);

export function lengthLabel(f: DiscoverFilters): string | undefined {
  const { runtimeMin: min, runtimeMax: max } = f;
  if (min === 60 && max === 90) return 'Under 90 min';
  if (min && max) return `${min} to ${max} min`;
  if (max) return `Under ${max} min`;
  if (min) return min % 60 === 0 ? `Over ${min / 60} ${min === 60 ? 'hour' : 'hours'}` : `Over ${min} min`;
  return undefined;
}

/** A ceiling on votes is how "few people know it" is asked for; a floor alone is said as it is. */
export function votesLabel(f: DiscoverFilters): string | undefined {
  if (f.votesMax) return 'Lesser known';
  if (f.votesMin) return `${f.votesMin.toLocaleString('en-US')}+ votes`;
  return undefined;
}

export interface Names {
  /** A watch provider's name, when its list has arrived. */
  provider?: (id: number) => string | undefined;
}

export interface FilterChip {
  key: string;
  label: string;
  /** The filters with this one taken away. */
  without: DiscoverFilters;
}

/** Every filter in force as something that can be taken away by itself. Sorting is not one. */
export function activeChips(input: DiscoverFilters, names: Names = {}): FilterChip[] {
  const f = normalize(input);
  const kind = kindOf(f);
  const drop = (patch: DiscoverFilters) => normalize({ ...f, ...patch });
  const chips: FilterChip[] = [];
  for (const g of f.genres ?? []) chips.push({ key: `g${g}`, label: genreName(kind, g) ?? `Genre ${g}`, without: drop({ genres: f.genres!.filter((x) => x !== g) }) });
  const when = whenLabel(f);
  if (when) chips.push({ key: 'when', label: when, without: drop({ from: undefined, to: undefined, recent: undefined }) });
  const rating = ratingLabel(f);
  if (rating) chips.push({ key: 'rating', label: rating, without: drop({ rating: undefined }) });
  const length = lengthLabel(f);
  if (length) chips.push({ key: 'length', label: length, without: drop({ runtimeMin: undefined, runtimeMax: undefined }) });
  const votes = votesLabel(f);
  if (votes) chips.push({ key: 'votes', label: votes, without: drop({ votesMin: undefined, votesMax: undefined }) });
  if (f.language) chips.push({ key: 'language', label: `In ${languageName(f.language)}`, without: drop({ language: undefined }) });
  for (const p of f.providers ?? []) chips.push({ key: `p${p}`, label: names.provider?.(p) ?? `Provider ${p}`, without: drop({ providers: f.providers!.filter((x) => x !== p) }) });
  return chips;
}

const SORT_WORD: Record<NonNullable<DiscoverFilters['sort']>, string> = { rating: 'Top rated', newest: 'New', votes: 'Most voted' };

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A filter set as the name of a row: "Top rated Science Fiction movies · 1990s · on Netflix". */
export function describe(input: DiscoverFilters, names: Names = {}): string {
  const f = normalize(input);
  const kind = kindOf(f);
  const what = kind === 'tv' ? 'shows' : 'movies';
  const providers = (f.providers ?? []).map((p) => names.provider?.(p)).filter((n): n is string => !!n);
  const on = providers.length ? `on ${providers.length > 2 ? `${providers.slice(0, -1).join(', ')} or ${providers[providers.length - 1]}` : providers.join(' or ')}` : undefined;
  const preset = activePreset(f);
  if (preset) return [preset.name, capital(what), on].filter(Boolean).join(' · ');
  const genres = (f.genres ?? []).map((g) => genreName(kind, g)).filter((n): n is string => !!n);
  const head = [f.sort ? SORT_WORD[f.sort] : genres.length ? undefined : 'Popular', genres.join(' & ') || undefined, what].filter(Boolean).join(' ');
  const tail = [whenLabel(f), ratingLabel(f)?.toLowerCase(), lengthLabel(f)?.toLowerCase(), votesLabel(f)?.toLowerCase(), f.language ? `in ${languageName(f.language)}` : undefined, on];
  return [capital(head), ...tail].filter(Boolean).join(' · ');
}

/** TMDB stops counting matches here: every larger set (all movies, all dramas) is answered as one more than this. */
const COUNTED_TO = 20_000;

export function countLabel(total: number, kind: Kind): string {
  const noun = kind === 'tv' ? (total === 1 ? 'show' : 'shows') : total === 1 ? 'movie' : 'movies';
  return total > COUNTED_TO ? `More than ${COUNTED_TO.toLocaleString('en-US')} ${noun}` : `${total.toLocaleString('en-US')} ${noun}`;
}

// ---------- Starting points ----------

export interface Preset {
  id: 'acclaimed' | 'gems' | 'short' | 'nineties' | 'fresh' | 'documentaries' | 'family' | 'classics';
  name: string;
  blurb: string;
  /** Offered for this kind alone (a running time is a film's). */
  only?: Kind;
  filters: (kind: Kind) => DiscoverFilters;
}

/**
 * Ready-made filter sets. Each is nothing more than filters: picking one fills the bar in.
 * Hidden gems are best first: by popularity the list would open with this month's releases, which
 * have few votes only because they are new.
 */
export const PRESETS: Preset[] = [
  { id: 'acclaimed', name: 'Critically acclaimed', blurb: 'Rated 8 and up, best first', filters: () => ({ rating: 8, sort: 'rating' }) },
  { id: 'gems', name: 'Hidden gems', blurb: 'Loved by the few who found them', filters: (kind) => ({ rating: 7.5, sort: 'rating', ...(kind === 'movie' ? { votesMin: 150, votesMax: 1500 } : { votesMin: 80, votesMax: 600 }) }) },
  { id: 'short', name: 'Under 90 minutes', blurb: 'A whole film, and an early night', only: 'movie', filters: () => ({ runtimeMin: 60, runtimeMax: 90 }) },
  { id: 'nineties', name: 'From the 90s', blurb: '1990 to 1999', filters: () => ({ from: 1990, to: 1999 }) },
  { id: 'fresh', name: 'New this month', blurb: 'Out in the last 30 days', filters: () => ({ recent: 30 }) },
  { id: 'documentaries', name: 'Top documentaries', blurb: 'True stories, rated 7 and up', filters: () => ({ genres: [99], rating: 7 }) },
  { id: 'family', name: 'Family animation', blurb: 'For everyone on the sofa', filters: (kind) => ({ genres: [16, kind === 'movie' ? 10751 : 10762] }) },
  { id: 'classics', name: 'Classics', blurb: 'Made before 1980, rated 7.5 and up', filters: () => ({ to: 1979, rating: 7.5 }) },
];

export const presetsFor = (kind: Kind) => PRESETS.filter((p) => !p.only || p.only === kind);

/**
 * A starting point applied: its filters in place of the others. Movies or Shows stays as it is,
 * and so does where to watch, which says what the user can play and not what they feel like.
 */
export function applyPreset(current: DiscoverFilters, preset: Preset): DiscoverFilters {
  const kind = kindOf(current);
  return normalize({ ...preset.filters(kind), kind: kind === 'tv' ? 'tv' : undefined, providers: current.providers, region: current.region });
}

/** The starting point the filters amount to, where to watch aside. */
export function activePreset(input: DiscoverFilters): Preset | undefined {
  const f = normalize(input);
  const bare = JSON.stringify(normalize({ ...f, providers: undefined, region: undefined }));
  return presetsFor(kindOf(f)).find((p) => JSON.stringify(applyPreset({ kind: f.kind }, p)) === bare);
}

// ---------- Where to watch ----------

/**
 * The country to look watch providers up in when none has been picked: the first of the system's
 * languages that names one (`en-GB`), else the one a bare language is most spoken in (`fr` →
 * FR), else the US.
 */
export function defaultRegion(languages: readonly string[]): string {
  for (const tag of languages) {
    try {
      const locale = new Intl.Locale(tag);
      const region = locale.region ?? locale.maximize().region;
      if (region && /^[A-Z]{2}$/.test(region)) return region;
    } catch {
      // Not a language tag: the next one.
    }
  }
  return 'US';
}

// ---------- Surprise me ----------

/**
 * The filters "Surprise me" draws from: the ones set, with a floor under them so the pick is
 * something worth an evening (a decent score from enough votes), most popular first. A set that
 * already asks for less-known titles keeps its own vote range.
 */
export function surpriseFilters(input: DiscoverFilters): DiscoverFilters {
  const f = normalize(input);
  const kind = kindOf(f);
  return normalize({ ...f, sort: undefined, rating: Math.max(f.rating ?? 0, 6.5), votesMin: f.votesMin ?? (f.votesMax ? undefined : kind === 'movie' ? 200 : 100) });
}

/** How deep "Surprise me" reaches: the first ten pages are the two hundred best known matches. */
export const SURPRISE_PAGES = 10;

/** A page to draw from, 1-based, that has not been drawn from yet. Null when every page has been. `rand` is in [0, 1). */
export function surprisePage(totalPages: number, used: ReadonlySet<number>, rand: number): number | null {
  const open: number[] = [];
  for (let p = 1; p <= Math.min(totalPages, SURPRISE_PAGES); p++) if (!used.has(p)) open.push(p);
  return open.length ? open[Math.min(open.length - 1, Math.floor(rand * open.length))] : null;
}

/**
 * One title out of `pool` that has not been shown yet: something with a picture to feature, and
 * one the profile has not watched while there is such a one. Null when the pool is used up.
 */
export function pickSurprise(pool: TitleHit[], shown: ReadonlySet<number>, watched: (h: TitleHit) => boolean, rand: number): TitleHit | null {
  const left = pool.filter((h) => !shown.has(h.tmdbId) && (h.backdrop || h.poster));
  const fresh = left.filter((h) => !watched(h));
  const from = fresh.length ? fresh : left;
  return from.length ? from[Math.min(from.length - 1, Math.floor(rand * from.length))] : null;
}
