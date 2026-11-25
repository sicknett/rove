import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The request TMDB is sent is read off this stand-in. Everything else in the module is unused here.
const asked = vi.fn(async (_path: string, _params: Record<string, string>) => ({ results: [] }));
vi.mock('../../meta/tmdb', () => ({ tmdb: (path: string, params: Record<string, string>) => asked(path, params), tmdbImage: () => undefined }));

const { discoverRequest, fetchTmdbSource, resolveFilterValue } = await import('../../meta/tmdbSources');
const { sameRoute } = await import('../../nav/router');
const { sourceKey } = await import('../../state/collections');
const F = await import('./filters');
type DiscoverFilters = import('./filters').DiscoverFilters;
type TitleHit = import('../shared/hits').TitleHit;

const NOW = new Date(2026, 10, 25, 12).getTime();

beforeEach(() => {
  asked.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('the written form of a filter set', () => {
  it('is empty for everything, and keeps only what narrows', () => {
    expect(F.normalize(undefined)).toEqual({});
    expect(F.normalize({ genres: [], rating: 0, providers: [], sort: undefined })).toEqual({});
    expect(F.normalize({ kind: 'tv' })).toEqual({ kind: 'tv' });
  });

  it('writes the same filters the same way whatever order they were set in', () => {
    const a = F.normalize({ sort: 'rating', genres: [878, 35, 878], rating: 7, to: 1999, from: 1990 });
    const b = F.normalize({ from: 1990, to: 1999, rating: 7, genres: [35, 878], sort: 'rating' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual({ genres: [35, 878], from: 1990, to: 1999, rating: 7, sort: 'rating' });
    expect(Object.keys(a)).toEqual(['genres', 'from', 'to', 'rating', 'sort']);
  });

  it('drops what cannot apply', () => {
    // Horror is no show genre; a running time is a film's; providers need a country.
    expect(F.normalize({ kind: 'tv', genres: [27, 18], runtimeMax: 90 })).toEqual({ kind: 'tv', genres: [18] });
    expect(F.normalize({ providers: [8] })).toEqual({});
    expect(F.normalize({ providers: [337, 8], region: 'GB' })).toEqual({ providers: [8, 337], region: 'GB' });
    expect(F.normalize({ region: 'GB' })).toEqual({});
    expect(F.normalize({ language: 'Korean', rating: 11, from: 12 })).toEqual({});
  });

  it('puts a range the right way round, and lets "recent" stand in for years', () => {
    expect(F.normalize({ from: 1999, to: 1990 })).toEqual({ from: 1990, to: 1999 });
    expect(F.normalize({ runtimeMin: 120, runtimeMax: 90 })).toEqual({ runtimeMin: 90, runtimeMax: 120 });
    expect(F.normalize({ recent: 30, from: 1990, to: 1999 })).toEqual({ recent: 30 });
  });

  it('knows whether anything is set besides Movies or Shows', () => {
    expect(F.isNarrowed({ kind: 'tv' })).toBe(false);
    expect(F.isNarrowed({ kind: 'tv', sort: 'newest' })).toBe(true);
    expect(F.isNarrowed({ genres: [18] })).toBe(true);
  });
});

describe('filters and the route', () => {
  it('is the plain Discover route with nothing set', () => {
    expect(F.discoverRoute({})).toEqual({ name: 'discover' });
    expect(F.discoverRoute({ genres: [] })).toEqual({ name: 'discover' });
    expect(sameRoute(F.discoverRoute(undefined), { name: 'discover' })).toBe(true);
  });

  it('makes one route of one filter set, however it was arrived at', () => {
    const one = F.discoverRoute({ rating: 7, genres: [878, 35] });
    const other = F.discoverRoute({ genres: [35, 878], rating: 7 });
    expect(sameRoute(one, other)).toBe(true);
    expect(one).toEqual({ name: 'discover', filters: { genres: [35, 878], rating: 7 } });
  });

  it('gives the filters back from the route unchanged', () => {
    const set: DiscoverFilters = { kind: 'tv', genres: [18, 80], recent: 365, rating: 8, language: 'ko', providers: [8], region: 'US', sort: 'newest' };
    const route = F.discoverRoute(set);
    expect(F.normalize(route.filters)).toEqual(F.normalize(set));
    expect(sameRoute(F.discoverRoute(route.filters), route)).toBe(true);
  });

  it('carries the catalogs mode beside the filters, so each comes back as it was left', () => {
    const route = F.discoverRoute({ genres: [18] }, { mode: 'catalogs', type: 'movie', catalog: 'a:movie:top', genre: undefined });
    expect(route).toEqual({ name: 'discover', mode: 'catalogs', type: 'movie', catalog: 'a:movie:top', filters: { genres: [18] } });
    expect(Object.keys(route)).toEqual(['name', 'mode', 'type', 'catalog', 'filters']);
  });

  it('carries genres over when Movies becomes Shows and back', () => {
    // Action and Adventure are one show genre; Comedy is the same number; Horror has none.
    expect(F.withKind({ genres: [12, 27, 28, 35], runtimeMax: 90, rating: 7 }, 'tv')).toEqual({ kind: 'tv', genres: [35, 10759], rating: 7 });
    expect(F.withKind({ kind: 'tv', genres: [10759, 10765, 10764] }, 'movie')).toEqual({ genres: [28, 878] });
    expect(F.withKind({ genres: [35] }, 'movie')).toEqual({ genres: [35] });
  });
});

describe('the TMDB request a filter set stands for', () => {
  const params = (f: DiscoverFilters, opts = {}) => discoverRequest(F.toSource(f, opts), 1, NOW);

  it('asks for everything, most popular first, with nothing set', () => {
    expect(F.toSource({})).toEqual({ provider: 'tmdb', tmdbSourceType: 'DISCOVER', mediaType: 'MOVIE', sortBy: 'popularity.desc', filters: {} });
    expect(params({})).toEqual({ kind: 'movie', params: { page: '1', sort_by: 'popularity.desc' } });
    expect(params({ kind: 'tv' })).toEqual({ kind: 'tv', params: { page: '1', sort_by: 'popularity.desc' } });
  });

  it('maps every filter to TMDB’s own parameter for a film', () => {
    expect(params({ genres: [35, 878], from: 1990, to: 1999, rating: 7, runtimeMin: 60, runtimeMax: 90, language: 'en', providers: [8, 337], region: 'US', sort: 'votes' }).params).toEqual({
      page: '1',
      sort_by: 'vote_count.desc',
      with_genres: '35,878',
      'primary_release_date.gte': '1990-01-01',
      'primary_release_date.lte': '1999-12-31',
      'vote_average.gte': '7',
      'vote_count.gte': '50',
      'with_runtime.gte': '60',
      'with_runtime.lte': '90',
      with_original_language: 'en',
      watch_region: 'US',
      with_watch_providers: '8|337',
    });
  });

  it('uses the first air date for shows, and their own sort name', () => {
    expect(params({ kind: 'tv', genres: [18], from: 2020, sort: 'newest' })).toEqual({
      kind: 'tv',
      params: { page: '1', sort_by: 'first_air_date.desc', with_genres: '18', 'first_air_date.gte': '2020-01-01', 'first_air_date.lte': '2026-11-25', 'vote_count.gte': '10' },
    });
    expect(params({ sort: 'newest' }).params.sort_by).toBe('primary_release_date.desc');
  });

  it('asks for enough votes that a score means something', () => {
    expect(params({ sort: 'rating' }).params['vote_count.gte']).toBe('300');
    expect(params({ kind: 'tv', sort: 'rating' }).params['vote_count.gte']).toBe('150');
    expect(params({ rating: 8 }).params['vote_count.gte']).toBe('50');
    expect(params({}).params['vote_count.gte']).toBeUndefined();
    // A starting point's own range stands as it is.
    expect(params({ rating: 7.5, votesMin: 150, votesMax: 1500, sort: 'rating' }).params).toMatchObject({ 'vote_average.gte': '7.5', 'vote_count.gte': '150', 'vote_count.lte': '1500' });
  });

  it('keeps "recent" and the cut-off of "newest" relative to the day it is asked', () => {
    const source = F.toSource({ recent: 30 });
    expect(source.filters).toEqual({ releaseDateGte: 'today-30d', releaseDateLte: 'today' });
    expect(discoverRequest(source, 1, NOW).params).toMatchObject({ 'primary_release_date.gte': '2026-10-26', 'primary_release_date.lte': '2026-11-25' });
    // The same saved source, a month on.
    const later = new Date(2026, 11, 25, 12).getTime();
    expect(discoverRequest(source, 1, later).params).toMatchObject({ 'primary_release_date.gte': '2026-11-25', 'primary_release_date.lte': '2026-12-25' });
    // An upper year the user set is kept over the cut-off.
    expect(F.toSource({ sort: 'newest', to: 2010 }).filters).toMatchObject({ releaseDateLte: '2010-12-31' });
  });

  it('resolves dates written from today, and leaves everything else alone', () => {
    expect(resolveFilterValue('today', NOW)).toBe('2026-11-25');
    expect(resolveFilterValue('today-30d', NOW)).toBe('2026-10-26');
    expect(resolveFilterValue('today-365d', NOW)).toBe('2025-11-25');
    expect(resolveFilterValue('1999-12-31', NOW)).toBe('1999-12-31');
    expect(resolveFilterValue(7.5, NOW)).toBe('7.5');
    expect(resolveFilterValue('8|337', NOW)).toBe('8|337');
  });

  it('keeps a Kids profile to family titles', () => {
    expect(params({ genres: [16] }, { kids: true }).params).toMatchObject({ with_genres: '16,10751', certification_country: 'US', 'certification.lte': 'PG' });
    const shows = params({ kind: 'tv' }, { kids: true }).params;
    expect(shows.with_genres).toBe('10762');
    expect(shows['certification.lte']).toBeUndefined();
  });

  it('is asked for by a Home row exactly as Discover asks for it', async () => {
    // What Discover counts and draws must be what the saved row shows: the same request, and
    // written the same way, since the answer cache is keyed by the parameters as written.
    const sets: DiscoverFilters[] = [
      {},
      { kind: 'tv', genres: [18, 80], rating: 8, sort: 'rating' },
      { genres: [35, 878], from: 1990, to: 1999, rating: 7, runtimeMin: 60, runtimeMax: 90, language: 'en', providers: [8, 337], region: 'US', sort: 'votes' },
      { recent: 30 },
      { kind: 'tv', sort: 'newest' },
    ];
    for (const set of sets) {
      asked.mockClear();
      const source = F.toSource(set, { title: 'A row' });
      await fetchTmdbSource(source, 3);
      const request = discoverRequest(source, 3);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(asked.mock.calls[0][0]).toBe(`/discover/${request.kind}`);
      expect(JSON.stringify(asked.mock.calls[0][1])).toBe(JSON.stringify(request.params));
    }
  });

  it('is one row for one filter set', () => {
    const key = (f: DiscoverFilters, title?: string) => sourceKey(F.toSource(f, { title }));
    expect(key({ genres: [878, 35], rating: 7 })).toBe(key({ rating: 7, genres: [35, 878] }));
    // The name is not part of what a row is.
    expect(key({ rating: 7 }, 'One name')).toBe(key({ rating: 7 }, 'Another'));
    expect(key({ rating: 7 })).not.toBe(key({ rating: 8 }));
    expect(key({ rating: 7 })).not.toBe(key({ kind: 'tv', rating: 7 }));
  });
});

describe('what the bar shows', () => {
  it('offers recent spans, the last two years, then decades', () => {
    const values = F.whenChoices(2026).map((c) => c.label);
    expect(values.slice(0, 7)).toEqual(['Any time', 'Last 30 days', 'Last 12 months', '2026', '2025', '2020s', '2010s']);
    expect(values[values.length - 1]).toBe('Before 1960');
  });

  it('shows the choice in force, and a choice of its own for a value none stands for', () => {
    const when = F.chosen(F.whenChoices(2026), { from: 1990, to: 1999 }, ['from', 'to', 'recent'], '1990s');
    expect(when.value).toBe('d1990');
    expect(F.chosen(F.whenChoices(2026), {}, ['from', 'to', 'recent'], undefined).value).toBe('any');
    const odd = F.chosen(F.RATING_CHOICES, { rating: 7.5 }, ['rating'], 'Rated 7.5+');
    expect(odd.value).toBe('own');
    expect(odd.choices.map((c) => c.label)).toEqual(['Any rating', 'Rated 7.5+', 'Rated 6+', 'Rated 7+', 'Rated 8+']);
    expect(odd.choices[1].set).toEqual({ rating: 7.5 });
  });

  it('says each filter in words', () => {
    expect(F.whenLabel({ from: 1990, to: 1999 })).toBe('1990s');
    expect(F.whenLabel({ from: 2000, to: 2015 })).toBe('2000–2015');
    expect(F.whenLabel({ from: 2026, to: 2026 })).toBe('2026');
    expect(F.whenLabel({ to: 1959 })).toBe('Before 1960');
    expect(F.whenLabel({ from: 2010 })).toBe('Since 2010');
    expect(F.whenLabel({ recent: 30 })).toBe('Last 30 days');
    expect(F.lengthLabel({ runtimeMin: 60, runtimeMax: 90 })).toBe('Under 90 min');
    expect(F.lengthLabel({ runtimeMin: 120 })).toBe('Over 2 hours');
    expect(F.votesLabel({ votesMin: 150, votesMax: 1500 })).toBe('Lesser known');
    expect(F.countLabel(1234, 'movie')).toBe('1,234 movies');
    expect(F.countLabel(1, 'tv')).toBe('1 show');
    expect(F.countLabel(20001, 'tv')).toBe('More than 20,000 shows');
  });

  it('lists the filters in force, each with the set that is left without it', () => {
    const chips = F.activeChips({ genres: [35, 878], from: 1990, to: 1999, rating: 7, providers: [8, 337], region: 'US', sort: 'rating' }, { provider: (id) => (id === 8 ? 'Netflix' : undefined) });
    expect(chips.map((c) => c.label)).toEqual(['Comedy', 'Science Fiction', '1990s', 'Rated 7+', 'Netflix', 'Provider 337']);
    expect(chips[0].without).toEqual({ genres: [878], from: 1990, to: 1999, rating: 7, providers: [8, 337], region: 'US', sort: 'rating' });
    expect(chips[2].without).toEqual({ genres: [35, 878], rating: 7, providers: [8, 337], region: 'US', sort: 'rating' });
    // The last provider takes its country with it.
    expect(F.activeChips({ providers: [8], region: 'US' })[0].without).toEqual({});
    expect(F.activeChips({ kind: 'tv', sort: 'newest' })).toEqual([]);
  });

  it('names a row after its filters', () => {
    expect(F.describe({})).toBe('Popular movies');
    expect(F.describe({ kind: 'tv', genres: [18, 80] })).toBe('Drama & Crime shows');
    expect(F.describe({ genres: [878], from: 1990, to: 1999, rating: 7, providers: [8, 337], region: 'US', sort: 'rating' }, { provider: (id) => (id === 8 ? 'Netflix' : 'Disney Plus') })).toBe(
      'Top rated Science Fiction movies · 1990s · rated 7+ · on Netflix or Disney Plus',
    );
    expect(F.describe({ recent: 30 })).toBe('New this month · Movies');
    expect(F.describe({ kind: 'tv', language: 'ko', sort: 'newest' })).toBe('New shows · in Korean');
  });
});

describe('starting points', () => {
  it('are filters and nothing else, each valid for the kind it is offered for', () => {
    for (const kind of ['movie', 'tv'] as const) {
      for (const p of F.presetsFor(kind)) {
        const set = F.applyPreset({ kind: kind === 'tv' ? 'tv' : undefined }, p);
        expect(F.isNarrowed(set), `${p.id} for ${kind}`).toBe(true);
        expect(F.activePreset(set)?.id, `${p.id} for ${kind}`).toBe(p.id);
      }
    }
    expect(F.presetsFor('tv').some((p) => p.id === 'short')).toBe(false);
  });

  it('replace the other filters but keep Movies or Shows and where to watch', () => {
    const fresh = F.PRESETS.find((p) => p.id === 'fresh')!;
    const set = F.applyPreset({ kind: 'tv', genres: [18], rating: 8, providers: [8], region: 'GB' }, fresh);
    expect(set).toEqual({ kind: 'tv', recent: 30, providers: [8], region: 'GB' });
    expect(F.activePreset(set)?.id).toBe('fresh');
    expect(F.activePreset({ ...set, rating: 7 })).toBeUndefined();
    expect(F.activePreset({})).toBeUndefined();
  });
});

describe('the country for where to watch', () => {
  it('comes from the system languages, the first that names or implies one', () => {
    expect(F.defaultRegion(['en-GB', 'en'])).toBe('GB');
    expect(F.defaultRegion(['fr'])).toBe('FR');
    expect(F.defaultRegion(['es-419', 'pt-BR'])).toBe('BR');
    expect(F.defaultRegion([])).toBe('US');
    expect(F.defaultRegion(['not a tag'])).toBe('US');
  });
});

describe('surprise me', () => {
  const hit = (tmdbId: number, more: Partial<TitleHit> = {}): TitleHit => ({ tmdbId, kind: 'movie', type: 'movie', name: `T${tmdbId}`, rating: 7, votes: 500, popularity: 10, backdrop: '/b.jpg', genres: [], ...more });

  it('draws from the filters with a floor under them, most popular first', () => {
    expect(F.surpriseFilters({ genres: [27], sort: 'newest' })).toEqual({ genres: [27], rating: 6.5, votesMin: 200 });
    expect(F.surpriseFilters({ kind: 'tv', rating: 8 })).toEqual({ kind: 'tv', rating: 8, votesMin: 100 });
    // A set that asks for lesser known titles keeps its own range.
    expect(F.surpriseFilters({ rating: 7.5, votesMin: 150, votesMax: 1500 })).toEqual({ rating: 7.5, votesMin: 150, votesMax: 1500 });
  });

  it('picks a page within reach that has not been drawn from', () => {
    expect(F.surprisePage(3, new Set(), 0)).toBe(1);
    expect(F.surprisePage(3, new Set(), 0.99)).toBe(3);
    expect(F.surprisePage(3, new Set([1, 3]), 0.5)).toBe(2);
    expect(F.surprisePage(3, new Set([1, 2, 3]), 0.5)).toBeNull();
    expect(F.surprisePage(0, new Set(), 0.5)).toBeNull();
    // Never deeper than the best known two hundred.
    expect(F.surprisePage(500, new Set(), 0.999)).toBe(F.SURPRISE_PAGES);
  });

  it('shows each title once, and something unwatched while there is any', () => {
    const pool = [hit(1), hit(2), hit(3, { backdrop: undefined, poster: undefined })];
    const watched = (h: TitleHit) => h.tmdbId === 1;
    expect(F.pickSurprise(pool, new Set(), watched, 0)?.tmdbId).toBe(2);
    expect(F.pickSurprise(pool, new Set(), watched, 0.99)?.tmdbId).toBe(2);
    // Only the watched one is left: better that than nothing.
    expect(F.pickSurprise(pool, new Set([2]), watched, 0.5)?.tmdbId).toBe(1);
    // A title with no picture cannot be featured.
    expect(F.pickSurprise(pool, new Set([1, 2]), watched, 0.5)).toBeNull();
  });
});
