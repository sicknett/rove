// The rows: for each, which sources it reads and how it turns their answers into one ordered
// list. A recipe only ranks. Leaving out what the profile has seen, and keeping a title out of
// several rows, happens after it (engine.ts, rank.ts assignRows), the same way for every row.

import { blendTopPicks, interleave, MIN_ROW, rankByBlend, rankByRating, ROW_LIMIT, TOP_TEN, uniqueCandidates, type Candidate, type SeedRef } from './rank';
import { discoverSource, seedSource, trendingSource, type SeedBundle, type SourceSpec } from './sources';
import { genreRowPicks, genreRowTitle, topGenres, type GenreAffinity, type Kind } from './taste';

/** Every key starts with this (state/homeLayout SMART_PREFIX is the same text). */
const PREFIX = 'smart_';

export const SMART = {
  topPicks: `${PREFIX}top_picks`,
  because1: `${PREFIX}because_1`,
  because2: `${PREFIX}because_2`,
  because3: `${PREFIX}because_3`,
  trending: `${PREFIX}trending`,
  top10Movies: `${PREFIX}top10_movies`,
  top10Shows: `${PREFIX}top10_shows`,
  newReleases: `${PREFIX}new_releases`,
  genre1: `${PREFIX}genre_1`,
  genre2: `${PREFIX}genre_2`,
  hiddenGems: `${PREFIX}hidden_gems`,
  watchlist: `${PREFIX}watchlist`,
} as const;

/**
 * The rows in the order they first appear on Home, the way a streaming service lays its Home
 * out: the most personal row first, then personal and general rows in turn, so neither kind
 * sits in a block.
 */
export const SMART_KEYS: string[] = [
  SMART.topPicks,
  SMART.because1,
  SMART.trending,
  SMART.top10Movies,
  SMART.because2,
  SMART.newReleases,
  SMART.top10Shows,
  SMART.genre1,
  SMART.because3,
  SMART.genre2,
  SMART.hiddenGems,
  SMART.watchlist,
];

/** A seed as the saved taste profile keeps it: a TMDB title and how much it counts. */
export interface SavedSeed extends SeedRef {
  /** Its history key. */
  key: string;
  weight: number;
  depth: number;
  at: number;
  watched: boolean;
}

export interface SavedTaste {
  /** When it was worked out. */
  at: number;
  /** taste.ts buildTaste's fingerprint of the seeds it was worked out from. */
  fingerprint: string;
  seeds: SavedSeed[];
  genres: GenreAffinity[];
  /** The original languages the profile watches in (taste.ts topLanguages). */
  languages: string[];
}

export interface RecipeContext {
  /** Null with no history to go on (or before the first profile has been worked out). */
  taste: SavedTaste | null;
  /** Today's "Because you watched" titles, by row. */
  because: SeedRef[];
  /** A Kids profile: family titles only. */
  kids: boolean;
  /** Local date, `YYYY-MM-DD`: "new" is counted back from it. */
  today: string;
}

export interface Recipe {
  key: string;
  /** Built from the profile's history. Without one the row does not exist. */
  personal: boolean;
  /**
   * Exists without a history, but asks differently with one (New releases, in the profile's
   * genres). While the first taste profile is being worked out it waits for it, rather than
   * ask once without and once more with.
   */
  usesTaste?: boolean;
  /** A numbered Top 10 (see rank.ts RowFeed.chart). */
  chart?: boolean;
  limit: number;
  min: number;
  /** The row's heading. Also its name in Settings, where it stands in for a row that has nothing to show yet. */
  title: (ctx: RecipeContext) => string;
  /** The line under its name in Settings → Home layout. */
  detail: string;
  /**
   * The sources the row needs, or null when it cannot exist for this profile right now (no
   * history, no genre to name, nothing to say "because" about). `wide` is "See all": some rows
   * read a further page for it.
   */
  plan: (ctx: RecipeContext, wide: boolean) => SourceSpec[] | null;
  /** The row's titles, best first, from the answers to `plan` (in its order; undefined for one that failed). */
  build: (ctx: RecipeContext, data: unknown[], wide: boolean) => Candidate[];
}

const PERSONAL = 'Made for you from what you watch';
const GENERAL = 'Popular on TMDB this week';

const lists = (data: unknown[]) => data.map((d) => (Array.isArray(d) ? (d as Candidate[]) : []));
const bundles = (data: unknown[]) => data.map((d) => d as SeedBundle | undefined);

export function isoDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `days` before a `YYYY-MM-DD` date, as another. */
function daysBefore(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d - days).getTime());
}

const ANIMATION = 16;
const FAMILY_MOVIES = 10751;
const KIDS_SHOWS = 10762;
/** News, Talk and Soap: daily programmes that crowd a list of new shows. */
const DAILY_TV = '10763,10767,10766';
/** A similar title needs this many votes to fill out a "Because you watched" row: under it, TMDB's "similar" is mostly noise. */
const SIMILAR_MIN_VOTES = 50;

/**
 * A discover query for a Kids profile: the Family (movies) or Kids (shows) genre whatever else
 * was asked for, and nothing rated above PG for films.
 */
function forKids(kind: Kind, params: Record<string, string>, genre?: number): Record<string, string> {
  const family = kind === 'movie' ? FAMILY_MOVIES : KIDS_SHOWS;
  const out: Record<string, string> = { ...params, with_genres: genre && genre !== family ? `${genre},${family}` : String(family) };
  delete out.without_genres;
  if (kind === 'movie') Object.assign(out, { certification_country: 'US', 'certification.lte': 'PG' });
  return out;
}

/** Animation outranks everything on TMDB's rated lists. It is kept out of them unless the profile watches it. */
const skipAnimation = (ctx: RecipeContext, genre?: number): Record<string, string> =>
  genre === ANIMATION || ctx.taste?.genres.some((g) => g.id === ANIMATION) ? {} : { without_genres: String(ANIMATION) };

/** What is popular now, for one type. For a Kids profile, from discover: /trending cannot be filtered. */
function popular(kind: Kind, ctx: RecipeContext, page: number): SourceSpec {
  return ctx.kids ? discoverSource(kind, forKids(kind, { sort_by: 'popularity.desc', 'vote_count.gte': '50' }), page) : trendingSource(kind, page);
}

function because(n: 1 | 2 | 3): Recipe {
  return {
    key: `${PREFIX}because_${n}`,
    personal: true,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    // Without a title to name (Settings lists the row all the same), the rows are told apart by their place.
    title: (ctx) => (ctx.because[n - 1]?.name ? `Because you watched ${ctx.because[n - 1].name}` : `Because you watched… (${['first', 'second', 'third'][n - 1]} title)`),
    detail: `${PERSONAL} · a title you watched lately, another one each day`,
    plan: (ctx) => {
      const pick = ctx.because[n - 1];
      return pick?.name ? [seedSource(pick.kind, pick.id)] : null;
    },
    build: (_ctx, data) => {
      const b = bundles(data)[0];
      if (!b) return [];
      // Recommendations first; similar titles only fill what is left of the row.
      return uniqueCandidates([...b.recs, ...b.similar.filter((c) => c.votes >= SIMILAR_MIN_VOTES)]);
    },
  };
}

function topTen(kind: Kind): Recipe {
  return {
    key: kind === 'movie' ? SMART.top10Movies : SMART.top10Shows,
    personal: false,
    chart: true,
    limit: TOP_TEN,
    // Ten or nothing: seven numbered posters are not a Top 10.
    min: TOP_TEN,
    title: () => `Top 10 ${kind === 'movie' ? 'movies' : 'shows'} this week`,
    detail: `${GENERAL} · numbered`,
    plan: (ctx, wide) => (wide ? [popular(kind, ctx, 1), popular(kind, ctx, 2)] : [popular(kind, ctx, 1)]),
    build: (_ctx, data) => uniqueCandidates(lists(data).flat()),
  };
}

function genre(n: 1 | 2): Recipe {
  const pick = (ctx: RecipeContext) => (ctx.taste ? genreRowPicks(ctx.taste.genres)[n - 1] : undefined);
  return {
    key: `${PREFIX}genre_${n}`,
    personal: true,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    title: (ctx) => {
      const g = pick(ctx);
      return g ? genreRowTitle(g) : n === 1 ? 'Your top genre' : 'Your second genre';
    },
    detail: `${PERSONAL} · well rated, in a genre you watch most`,
    plan: (ctx) => {
      const g = pick(ctx);
      if (!g) return null;
      const base = { sort_by: 'popularity.desc', 'vote_average.gte': '6.8', 'vote_count.gte': g.kind === 'movie' ? '300' : '150', with_genres: String(g.id), ...tasteLanguages(ctx), ...skipAnimation(ctx, g.id) };
      const params = ctx.kids ? forKids(g.kind, base, g.id) : base;
      // Two pages: enough to order by rating and popularity together, and to survive the rows above taking some.
      return [discoverSource(g.kind, params, 1), discoverSource(g.kind, params, 2)];
    },
    build: (_ctx, data) => rankByBlend(uniqueCandidates(lists(data).flat())),
  };
}

/** The profile's genres for one type as a discover filter (any of them), or nothing to filter by. */
function tasteGenres(ctx: RecipeContext, kind: Kind): Record<string, string> {
  const top = ctx.taste ? topGenres(kind, ctx.taste.genres) : [];
  return top.length ? { with_genres: top.join('|') } : {};
}

/** The languages the profile watches in as a discover filter (any of them), or nothing to filter by. */
const tasteLanguages = (ctx: RecipeContext): Record<string, string> => (ctx.taste?.languages.length ? { with_original_language: ctx.taste.languages.join('|') } : {});

const RECIPES: Recipe[] = [
  {
    key: SMART.topPicks,
    personal: true,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    title: () => 'Top picks for you',
    detail: `${PERSONAL} · what your most watched titles point to`,
    // A blend needs two titles to blend. With one, its recommendations are the "Because you watched" row.
    plan: (ctx) => ((ctx.taste?.seeds.length ?? 0) >= 2 ? ctx.taste!.seeds.map((s) => seedSource(s.kind, s.id)) : null),
    build: (ctx, data) => {
      const answers = bundles(data);
      return blendTopPicks((ctx.taste?.seeds ?? []).map((s, i) => ({ weight: s.weight, items: answers[i]?.recs ?? [] })));
    },
  },
  because(1),
  {
    key: SMART.trending,
    personal: false,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    title: () => 'Trending this week',
    detail: GENERAL,
    // Two pages: the Top 10 rows show the head of this list themselves, and what they show is not repeated here.
    plan: (ctx) => (ctx.kids ? [popular('movie', ctx, 1), popular('tv', ctx, 1)] : [trendingSource('all', 1), trendingSource('all', 2)]),
    build: (ctx, data) => (ctx.kids ? interleave(...lists(data)) : uniqueCandidates(lists(data).flat())),
  },
  topTen('movie'),
  because(2),
  {
    key: SMART.newReleases,
    personal: false,
    usesTaste: true,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    title: (ctx) => (ctx.taste?.genres.length ? 'New releases you might like' : 'New releases'),
    detail: 'Out in the last two months · in your genres once you have watched something',
    plan: (ctx) => {
      const from = daysBefore(ctx.today, 60);
      // Films by when they could first be watched at home in the US (digital or disc), not by
      // their cinema date: a film in cinemas this week is not something to watch tonight. No
      // older than a year, so a re-release of a classic is not "new".
      const movie = { sort_by: 'popularity.desc', region: 'US', with_release_type: '4|5', 'release_date.gte': from, 'release_date.lte': ctx.today, 'primary_release_date.gte': daysBefore(ctx.today, 365), 'vote_count.gte': '30', ...tasteGenres(ctx, 'movie'), ...tasteLanguages(ctx) };
      // Shows by their first episode: new shows, not every show with an episode this month.
      const tv = { sort_by: 'popularity.desc', 'first_air_date.gte': from, 'first_air_date.lte': ctx.today, 'vote_count.gte': '10', without_genres: DAILY_TV, ...tasteGenres(ctx, 'tv'), ...tasteLanguages(ctx) };
      return ctx.kids ? [discoverSource('movie', forKids('movie', movie)), discoverSource('tv', forKids('tv', tv))] : [discoverSource('movie', movie), discoverSource('tv', tv)];
    },
    build: (_ctx, data) => interleave(...lists(data)),
  },
  topTen('tv'),
  genre(1),
  because(3),
  genre(2),
  {
    key: SMART.hiddenGems,
    personal: true,
    limit: ROW_LIMIT,
    min: MIN_ROW,
    title: () => 'Hidden gems',
    detail: `${PERSONAL} · rated highly, seen by few, in your genres`,
    plan: (ctx) => {
      if (!ctx.taste?.genres.length) return null;
      const since = daysBefore(ctx.today, 20 * 365);
      const specs: SourceSpec[] = [];
      for (const kind of ['movie', 'tv'] as const) {
        // Both of the profile's two strongest genres at once ("Crime" and "Drama"), not either:
        // titles in any one of them are a list of everything.
        const genres = topGenres(kind, ctx.taste.genres, 2);
        if (!genres.length) continue;
        // Enough votes for the rating to mean something, few enough that it is not on every
        // list (films gather several times the votes shows do). Within that band the most voted
        // come first: sorted by rating, the band's top is whatever a few hundred fans rated 9.5.
        const band: Record<string, string> =
          kind === 'movie'
            ? { 'vote_average.gte': '7.1', 'vote_count.gte': '300', 'vote_count.lte': '4000', 'primary_release_date.gte': since }
            : { 'vote_average.gte': '7.6', 'vote_count.gte': '80', 'vote_count.lte': '700', 'first_air_date.gte': since };
        const params = { sort_by: 'vote_count.desc', ...band, with_genres: genres.join(','), ...tasteLanguages(ctx), ...skipAnimation(ctx) };
        specs.push(discoverSource(kind, ctx.kids ? forKids(kind, params) : params));
      }
      return specs.length ? specs : null;
    },
    build: (_ctx, data) => interleave(...lists(data).map(rankByRating)),
  },
];

const BY_KEY = new Map(RECIPES.map((r) => [r.key, r]));

/** The recipe behind a row key. The watchlist row has none: it reads the watchlist, not TMDB. */
export const recipeFor = (key: string): Recipe | undefined => BY_KEY.get(key);

export const WATCHLIST_ROW = {
  key: SMART.watchlist,
  title: 'From your watchlist',
  detail: 'Watchlist titles you have not started, newest first · appears with 8 or more',
  min: MIN_ROW,
  limit: 30,
};

/** A row's heading and its line in Settings, for the profile as it is now. */
export function rowLabel(key: string, ctx: RecipeContext): { title: string; detail: string } {
  if (key === WATCHLIST_ROW.key) return { title: WATCHLIST_ROW.title, detail: WATCHLIST_ROW.detail };
  const r = BY_KEY.get(key);
  return r ? { title: r.title(ctx), detail: r.detail } : { title: key, detail: '' };
}
