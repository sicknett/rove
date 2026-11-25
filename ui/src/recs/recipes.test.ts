import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../meta/tmdb', () => ({ tmdb: vi.fn() }));

import { tmdb } from '../meta/tmdb';
import type { Candidate } from './rank';
import { isoDay, recipeFor, rowLabel, SMART, SMART_KEYS, type RecipeContext, type SavedSeed, type SavedTaste } from './recipes';
import { discoverSource, seedSource, toCandidate, trendingSource, type SeedBundle } from './sources';

const ask = vi.mocked(tmdb);
beforeEach(() => ask.mockReset());

const seed = (kind: 'movie' | 'tv', id: number, weight: number): SavedSeed => ({ key: `tt${id}`, kind, id, name: `Seed ${id}`, weight, depth: 1, at: 0, watched: true });
const taste: SavedTaste = {
  at: 0,
  fingerprint: 'tt1396|tt603',
  seeds: [seed('tv', 1396, 1), seed('movie', 603, 0.8)],
  genres: [
    { kind: 'tv', id: 80, name: 'Crime', score: 1 },
    { kind: 'tv', id: 18, name: 'Drama', score: 0.6 },
    { kind: 'movie', id: 878, name: 'Science Fiction', score: 0.5 },
  ],
  languages: ['en'],
};
const newUser: RecipeContext = { taste: null, because: [], kids: false, today: '2026-11-25' };
const regular: RecipeContext = { ...newUser, taste, because: [{ kind: 'tv', id: 1396, name: 'Breaking Bad' }] };

const keys = (key: string, ctx: RecipeContext, wide = false) => recipeFor(key)!.plan(ctx, wide)?.map((s) => s.key) ?? null;
/** The parameters a discover source asks with, read back from its key. */
const params = (sourceKey: string) => Object.fromEntries(sourceKey.replace(/^discover:(movie|tv):/, '').split('&').map((p) => p.split('=') as [string, string]));
const c = (id: number, extra: Partial<Candidate> = {}): Candidate => ({ id, kind: 'tv', name: `T${id}`, poster: '/p.jpg', rating: 7, votes: 500, popularity: 10, genres: [], ...extra });

describe('with no history at all', () => {
  it('has the general rows and none of the personal ones', () => {
    const exists = SMART_KEYS.filter((k) => recipeFor(k)).filter((k) => keys(k, newUser) !== null);
    expect(exists).toEqual([SMART.trending, SMART.top10Movies, SMART.newReleases, SMART.top10Shows]);
  });

  it('asks for trending and the two charts as they are', () => {
    expect(keys(SMART.trending, newUser)).toEqual(['trending:all:1', 'trending:all:2']);
    expect(keys(SMART.top10Movies, newUser)).toEqual(['trending:movie:1']);
    expect(keys(SMART.top10Shows, newUser)).toEqual(['trending:tv:1']);
    // "See all" on a chart reads on.
    expect(keys(SMART.top10Shows, newUser, true)).toEqual(['trending:tv:1', 'trending:tv:2']);
  });

  it('shows new releases without a genre or a language to hold them to', () => {
    const [movie, tv] = keys(SMART.newReleases, newUser)!.map(params);
    expect(movie.with_genres).toBeUndefined();
    expect(movie.with_original_language).toBeUndefined();
    expect(tv.with_genres).toBeUndefined();
    expect(rowLabel(SMART.newReleases, newUser).title).toBe('New releases');
  });
});

describe('with a taste profile', () => {
  it('asks once for every seed for Top picks, and needs two seeds to blend', () => {
    expect(keys(SMART.topPicks, regular)).toEqual(['seed:tv:1396', 'seed:movie:603']);
    expect(keys(SMART.topPicks, { ...regular, taste: { ...taste, seeds: taste.seeds.slice(0, 1) } })).toBeNull();
  });

  it('names a "Because you watched" row after its title, and has no row without one', () => {
    expect(rowLabel(SMART.because1, regular).title).toBe('Because you watched Breaking Bad');
    expect(keys(SMART.because1, regular)).toEqual(['seed:tv:1396']);
    expect(keys(SMART.because2, regular)).toBeNull();
    expect(rowLabel(SMART.because2, regular).title).toBe('Because you watched… (second title)');
  });

  it('takes recommendations first for "Because you watched", and similar titles only to fill', () => {
    const bundle: SeedBundle = { kind: 'tv', id: 1396, genres: [], recs: [c(1), c(2)], similar: [c(2), c(3, { votes: 12 }), c(4, { votes: 90 })] };
    const built = recipeFor(SMART.because1)!.build(regular, [bundle], false);
    // 2 is not repeated, and the similar title hardly anyone voted on is left out.
    expect(built.map((x) => x.id)).toEqual([1, 2, 4]);
    expect(recipeFor(SMART.because1)!.build(regular, [undefined], false)).toEqual([]);
  });

  it('gives the two strongest genres a row each, well rated and in the languages watched', () => {
    expect(rowLabel(SMART.genre1, regular).title).toBe('Crime shows for you');
    expect(rowLabel(SMART.genre2, regular).title).toBe('Drama shows for you');
    const pages = keys(SMART.genre1, regular)!;
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatch(/^discover:tv:/);
    expect(params(pages[0])).toMatchObject({ with_genres: '80', sort_by: 'popularity.desc', 'vote_average.gte': '6.8', 'vote_count.gte': '150', with_original_language: 'en', without_genres: '16', include_adult: 'false', page: '1' });
    expect(params(pages[1]).page).toBe('2');
  });

  it('keeps new releases to the last sixty days, the profile\'s genres and a vote floor', () => {
    const [movieKey, tvKey] = keys(SMART.newReleases, regular)!;
    expect(movieKey).toMatch(/^discover:movie:/);
    // Films by when they came out to watch at home. The shows' genres count for films at half strength.
    expect(params(movieKey)).toMatchObject({ sort_by: 'popularity.desc', region: 'US', with_release_type: '4|5', 'release_date.gte': '2026-09-26', 'release_date.lte': '2026-11-25', 'vote_count.gte': '30', with_genres: '80|878|18', with_original_language: 'en' });
    expect(params(tvKey)).toMatchObject({ sort_by: 'popularity.desc', 'first_air_date.gte': '2026-09-26', 'first_air_date.lte': '2026-11-25', 'vote_count.gte': '10', with_genres: '80|18|10765' });
    expect(rowLabel(SMART.newReleases, regular).title).toBe('New releases you might like');
  });

  it('looks for hidden gems where ratings are high and votes are few', () => {
    const [movie, tv] = keys(SMART.hiddenGems, regular)!.map(params);
    // Both of the two strongest genres at once, for each type.
    expect(movie).toMatchObject({ sort_by: 'vote_count.desc', 'vote_average.gte': '7.1', 'vote_count.gte': '300', 'vote_count.lte': '4000', with_genres: '80,878', with_original_language: 'en' });
    expect(tv).toMatchObject({ sort_by: 'vote_count.desc', 'vote_average.gte': '7.6', 'vote_count.gte': '80', 'vote_count.lte': '700', with_genres: '80,18' });
    expect(keys(SMART.hiddenGems, newUser)).toBeNull();
  });

  it('leaves animation in for a profile that watches it', () => {
    const anime: RecipeContext = { ...regular, taste: { ...taste, genres: [{ kind: 'tv', id: 16, name: 'Animation', score: 2 }, ...taste.genres] } };
    expect(params(keys(SMART.genre2, anime)![0]).without_genres).toBeUndefined();
    expect(params(keys(SMART.hiddenGems, anime)![0]).without_genres).toBeUndefined();
  });
});

describe('for a Kids profile', () => {
  const kids: RecipeContext = { ...regular, kids: true };

  it('asks for family titles only', () => {
    const [movie, tv] = keys(SMART.newReleases, kids)!.map(params);
    expect(movie).toMatchObject({ with_genres: '10751', certification_country: 'US', 'certification.lte': 'PG' });
    expect(tv).toMatchObject({ with_genres: '10762' });
    expect(tv.without_genres).toBeUndefined();
    // The genre itself, and the Kids genre as well.
    expect(params(keys(SMART.genre1, kids)![0]).with_genres).toBe('80,10762');
  });

  it('takes the charts from discover, which can be filtered', () => {
    const [chart] = keys(SMART.top10Movies, kids)!;
    expect(chart).toMatch(/^discover:movie:/);
    expect(params(chart)).toMatchObject({ sort_by: 'popularity.desc', with_genres: '10751', 'certification.lte': 'PG' });
    expect(keys(SMART.trending, kids)!.every((k) => k.startsWith('discover:'))).toBe(true);
  });
});

describe('sources', () => {
  it('reads a seed in one request: genres, language, recommendations and similar titles', async () => {
    ask.mockResolvedValueOnce({
      id: 1396,
      name: 'Breaking Bad',
      original_language: 'en',
      genres: [{ id: 18, name: 'Drama' }],
      recommendations: { results: [{ id: 60059, name: 'Better Call Saul', media_type: 'tv', poster_path: '/a.jpg', vote_average: 8.7, vote_count: 5000, popularity: 90, genre_ids: [80, 18], first_air_date: '2015-02-08' }] },
      similar: { results: [{ id: 1, name: 'No poster' }, { id: 2, name: 'Adult', poster_path: '/b.jpg', adult: true }, { id: 3, name: 'Kept', poster_path: '/c.jpg' }] },
    });
    const bundle = await seedSource('tv', 1396).fetch();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe('/tv/1396');
    expect(ask.mock.calls[0][1]).toEqual({ append_to_response: 'recommendations,similar' });
    expect(bundle).toMatchObject({ kind: 'tv', id: 1396, name: 'Breaking Bad', language: 'en', genres: [{ id: 18, name: 'Drama' }] });
    expect(bundle.recs).toEqual([{ id: 60059, kind: 'tv', name: 'Better Call Saul', poster: '/a.jpg', backdrop: undefined, date: '2015-02-08', rating: 8.7, votes: 5000, popularity: 90, genres: [80, 18] }]);
    expect(bundle.similar.map((s) => s.id)).toEqual([3]);
  });

  it('takes an id TMDB does not know as a seed with nothing to say', async () => {
    ask.mockResolvedValueOnce(null);
    expect(await seedSource('movie', 5).fetch()).toEqual({ kind: 'movie', id: 5, name: undefined, genres: [], language: undefined, recs: [], similar: [] });
  });

  it('asks /trending for the week, and passes a failure on', async () => {
    ask.mockResolvedValueOnce({ results: [{ id: 7, title: 'Film', media_type: 'movie', poster_path: '/f.jpg' }, { id: 8, name: 'Someone', media_type: 'person' }, { id: 9, name: 'Show', media_type: 'tv', poster_path: '/s.jpg' }] });
    const list = await trendingSource('all', 2).fetch();
    expect(ask.mock.calls[0].slice(0, 2)).toEqual(['/trending/all/week', { page: '2' }]);
    expect(list.map((x) => `${x.kind}:${x.id}`)).toEqual(['movie:7', 'tv:9']);
    ask.mockRejectedValueOnce(new Error('HTTP 503'));
    await expect(trendingSource('movie').fetch()).rejects.toThrow('HTTP 503');
  });

  it('names a discover request the same whatever order its parameters come in', async () => {
    const a = discoverSource('movie', { sort_by: 'popularity.desc', with_genres: '80' });
    const b = discoverSource('movie', { with_genres: '80', sort_by: 'popularity.desc' });
    expect(a.key).toBe(b.key);
    expect(discoverSource('tv', { with_genres: '80', sort_by: 'popularity.desc' }).key).not.toBe(a.key);
    ask.mockResolvedValueOnce({ results: [] });
    await a.fetch();
    expect(ask.mock.calls[0].slice(0, 2)).toEqual(['/discover/movie', { include_adult: 'false', sort_by: 'popularity.desc', with_genres: '80', page: '1' }]);
  });

  it('makes no card of a person, or of a title without a name', () => {
    expect(toCandidate({ id: 1, media_type: 'person', name: 'A' }, 'movie')).toBeNull();
    expect(toCandidate({ id: 1, poster_path: '/p.jpg' }, 'movie')).toBeNull();
    expect(toCandidate({ id: 1, name: 'Show', poster_path: '/p.jpg' }, 'tv')).toMatchObject({ kind: 'tv', name: 'Show', rating: 0, votes: 0, genres: [] });
  });
});

describe('isoDay', () => {
  it('is the local date', () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(isoDay(new Date(2026, 11, 31, 0, 1).getTime())).toBe('2026-12-31');
  });
});
