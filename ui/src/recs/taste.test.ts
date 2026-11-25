import { describe, expect, it } from 'vitest';
import type { HistoryDoc, LibraryItem, ProgressEntry, WatchedEntry } from '../state/history';
import {
  buildTaste,
  genreAffinities,
  genreRowPicks,
  genreRowTitle,
  knownTitles,
  movieDepth,
  recency,
  RECENCY_FLOOR,
  SEED_MIN_WEIGHT,
  SEEDS_PER_KIND,
  seriesDepth,
  STRONG_DEPTH,
  tasteSignals,
  topGenres,
  topLanguages,
  unstartedWatchlist,
} from './taste';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12);
const ago = (days: number) => NOW - days * DAY;

type History = Pick<HistoryDoc, 'progress' | 'watched' | 'library' | 'cards'>;

const film = (id: string, daysAgo: number, extra: Partial<WatchedEntry> = {}): WatchedEntry => ({ key: id, metaId: id, type: 'movie', at: ago(daysAgo), ...extra });
/** `count` episodes of a show, the last of them watched `daysAgo` days ago. */
const episodes = (id: string, count: number, daysAgo: number, extra: Partial<WatchedEntry> = {}): WatchedEntry[] =>
  Array.from({ length: count }, (_, i) => ({ key: `${id}:1:${i + 1}`, metaId: id, type: 'series' as const, season: 1, episode: i + 1, at: ago(daysAgo) - (count - 1 - i) * 3600 * 1000, ...extra }));
const resume = (id: string, share: number, daysAgo: number, extra: Partial<ProgressEntry> = {}): ProgressEntry => ({ key: id, metaId: id, type: 'movie', positionS: share * 6000, durationS: 6000, updatedAt: ago(daysAgo), ...extra });
const listed = (id: string, daysAgo: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({ metaId: id, type: 'movie', addedAt: ago(daysAgo), ...extra });

function history(parts: { watched?: WatchedEntry[]; progress?: ProgressEntry[]; library?: LibraryItem[]; cards?: History['cards'] }): History {
  return {
    watched: Object.fromEntries((parts.watched ?? []).map((w) => [w.key, w])),
    progress: Object.fromEntries((parts.progress ?? []).map((p) => [p.key, p])),
    library: Object.fromEntries((parts.library ?? []).map((l) => [l.metaId, l])),
    cards: parts.cards ?? {},
  };
}

const weightOf = (h: History, id: string) => tasteSignals(h, NOW).find((s) => s.metaId === id)?.weight;

describe('recency', () => {
  it('halves every sixty days and never falls under the floor', () => {
    expect(recency(NOW, NOW)).toBe(1);
    expect(recency(ago(60), NOW)).toBeCloseTo(0.5, 5);
    expect(recency(ago(120), NOW)).toBeCloseTo(0.25, 5);
    expect(recency(ago(3650), NOW)).toBe(RECENCY_FLOOR);
    // A tracker entry with no date is as old as can be, not newer than now.
    expect(recency(0, NOW)).toBe(RECENCY_FLOOR);
    // A clock set back: a time after now is now.
    expect(recency(NOW + DAY, NOW)).toBe(1);
  });
});

describe('how much of a title was watched', () => {
  it('counts a film seen as a whole, a little more for each time it was seen again', () => {
    expect(movieDepth({ watched: true, ageDays: 0 })).toBe(1);
    expect(movieDepth({ watched: true, plays: 2, ageDays: 0 })).toBe(1.25);
    expect(movieDepth({ watched: true, plays: 9, ageDays: 0 })).toBe(1.5);
  });

  it('counts an unfinished film by how far it got', () => {
    expect(movieDepth({ watched: false, share: 0.7, ageDays: 200 })).toBe(0.7);
    expect(movieDepth({ watched: false, share: 0.3, ageDays: 3 })).toBe(0.3);
    // The same resume point, left alone for two months: it was given up on.
    expect(movieDepth({ watched: false, share: 0.3, ageDays: 60 })).toBe(0);
    // Left in its first minutes: no signal, however recent.
    expect(movieDepth({ watched: false, share: 0.05, ageDays: 1 })).toBe(0);
    expect(movieDepth({ watched: false, share: 0.05, ageDays: 90 })).toBe(0);
  });

  it('counts a show by its episodes, the first ones most', () => {
    const d = (episodes: number) => seriesDepth({ episodes, ageDays: 0 });
    expect(d(2)).toBeGreaterThanOrEqual(STRONG_DEPTH);
    expect(d(6)).toBeGreaterThan(d(2));
    expect(d(30)).toBeGreaterThan(d(6));
    expect(d(6) - d(2)).toBeGreaterThan(d(30) - d(26));
    expect(d(30)).toBeGreaterThan(movieDepth({ watched: true, ageDays: 0 }));
  });

  it('takes one episode as a weak signal while recent, and none once the show was dropped', () => {
    expect(seriesDepth({ episodes: 1, ageDays: 2 })).toBe(0.3);
    expect(seriesDepth({ episodes: 1, ageDays: 45 })).toBe(0);
    expect(seriesDepth({ episodes: 0, ageDays: 0 })).toBe(0);
  });
});

describe('taste signals', () => {
  it('weights a title by how much was watched and how recently', () => {
    const h = history({ watched: [film('tt1', 1), film('tt2', 60), film('tt3', 400), ...episodes('tt4', 12, 1), ...episodes('tt5', 2, 1)] });
    // The same film, further back: less.
    expect(weightOf(h, 'tt1')).toBeGreaterThan(weightOf(h, 'tt2')!);
    expect(weightOf(h, 'tt2')).toBeGreaterThan(weightOf(h, 'tt3')!);
    expect(weightOf(h, 'tt2')).toBeCloseTo(0.5, 2);
    // The same day, more of it watched: more.
    expect(weightOf(h, 'tt4')).toBeGreaterThan(weightOf(h, 'tt5')!);
    expect(weightOf(h, 'tt4')).toBeGreaterThan(weightOf(h, 'tt1')!);
    expect(tasteSignals(h, NOW).map((s) => s.metaId)).toEqual(['tt4', 'tt1', 'tt5', 'tt2', 'tt3']);
  });

  it('gives a film abandoned at 5 % no weight, and a film left half way some', () => {
    const h = history({ progress: [resume('tt1', 0.05, 40), resume('tt2', 0.6, 40), resume('tt3', 0.05, 0)] });
    const signals = tasteSignals(h, NOW);
    expect(signals.map((s) => s.metaId)).toEqual(['tt2']);
    expect(signals[0].depth).toBe(0.7);
  });

  it('counts an episode in progress past half as half an episode', () => {
    const half: ProgressEntry = { key: 'tt9:1:3', metaId: 'tt9', type: 'series', season: 1, episode: 3, positionS: 1500, durationS: 2400, updatedAt: ago(0) };
    const two = history({ watched: episodes('tt9', 2, 0) });
    const twoAndAHalf = history({ watched: episodes('tt9', 2, 0), progress: [half] });
    expect(weightOf(twoAndAHalf, 'tt9')).toBeGreaterThan(weightOf(two, 'tt9')!);
    // The same episode finished as well is not counted twice.
    const three = history({ watched: episodes('tt9', 3, 0), progress: [half] });
    expect(weightOf(three, 'tt9')).toBeCloseTo(weightOf(history({ watched: episodes('tt9', 3, 0) }), 'tt9')!, 5);
  });

  it('takes a watchlist title as a weaker signal, and not twice when it was also watched', () => {
    const h = history({ watched: [film('tt1', 0)], library: [listed('tt1', 0), listed('tt2', 0)] });
    const signals = tasteSignals(h, NOW);
    expect(signals.filter((s) => s.metaId === 'tt1')).toHaveLength(1);
    const wish = signals.find((s) => s.metaId === 'tt2')!;
    expect(wish.watched).toBe(false);
    expect(wish.weight).toBeLessThan(weightOf(h, 'tt1')!);
    expect(wish.weight).toBeGreaterThanOrEqual(SEED_MIN_WEIGHT);
  });

  it('names titles from the remembered cards', () => {
    const h = history({ watched: [film('tt1', 0)], cards: { tt1: { type: 'movie', name: 'Heat' } } });
    expect(tasteSignals(h, NOW)[0].name).toBe('Heat');
  });
});

describe('buildTaste', () => {
  it('picks the strongest titles as seeds, movies and shows apart', () => {
    const h = history({
      watched: [...Array.from({ length: 9 }, (_, i) => film(`tt${i + 1}`, i * 10)), ...episodes('tt100', 10, 3), ...episodes('tt101', 4, 30)],
    });
    const t = buildTaste(h, NOW);
    expect(t.seeds.movies).toHaveLength(SEEDS_PER_KIND);
    // Most recent first: each film was seen once, so recency decides.
    expect(t.seeds.movies.map((s) => s.metaId)).toEqual(['tt1', 'tt2', 'tt3', 'tt4', 'tt5', 'tt6']);
    expect(t.seeds.shows.map((s) => s.metaId)).toEqual(['tt100', 'tt101']);
  });

  it('leaves out titles too weak to say anything, and ids TMDB cannot look up', () => {
    const h = history({
      watched: [film('tt1', 0), film('tt2', 900), film('srv:abc:1', 0), film('link:https://example.test/a.mkv', 0), film('kitsu:7', 0)],
    });
    // tt2 is nearly three years old: under the floor for a seed. Server items and bare links have no TMDB title.
    expect(buildTaste(h, NOW).seeds.movies.map((s) => s.metaId)).toEqual(['kitsu:7', 'tt1']);
  });

  it('has a fingerprint that says which titles the seeds are, not in what order', () => {
    const a = buildTaste(history({ watched: [film('tt1', 1), film('tt2', 5)] }), NOW);
    const b = buildTaste(history({ watched: [film('tt1', 5), film('tt2', 1)] }), NOW);
    const c = buildTaste(history({ watched: [film('tt1', 1), film('tt3', 5)] }), NOW);
    expect(a.seeds.movies[0].metaId).not.toBe(b.seeds.movies[0].metaId);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it('finds nothing in an empty history', () => {
    const empty = history({});
    const t = buildTaste(empty, NOW);
    expect(t.signals).toEqual([]);
    expect(t.seeds).toEqual({ movies: [], shows: [] });
    expect(t.fingerprint).toBe('');
    const known = knownTitles(empty);
    expect(known.keys.size + known.tmdb.size + known.unnumbered.length).toBe(0);
    expect(unstartedWatchlist(empty)).toEqual([]);
  });
});

describe('what recommendations leave out', () => {
  it('knows everything watched, started and listed, by history key and by TMDB number', () => {
    const h = history({
      watched: [film('tt1', 0, { tmdbId: 603 }), ...episodes('tt2', 2, 0, { tmdbId: 1396 }), film('tmdb:27205', 0)],
      progress: [resume('tt3', 0.05, 90, { tmdbId: 11 })],
      library: [listed('tt4', 0, { type: 'series', tmdbId: 1399 })],
    });
    const known = knownTitles(h);
    // Even the film abandoned at 5 %: it is in Continue Watching, not something to recommend.
    expect([...known.keys].sort()).toEqual(['tmdb:27205@movie', 'tt1', 'tt2', 'tt3', 'tt4']);
    expect([...known.tmdb].sort()).toEqual(['movie:11', 'movie:27205', 'movie:603', 'tv:1396', 'tv:1399']);
    expect(known.unnumbered).toEqual([]);
  });

  it('lists the titles whose TMDB number is not known, newest first, once each', () => {
    const numbered = episodes('tt7', 1, 0, { tmdbId: 7 })[0];
    const h = history({
      watched: [film('tt1', 9), ...episodes('tt2', 3, 2), film('srv:x:1', 0), numbered, { ...episodes('tt7', 2, 0)[1] }],
    });
    const known = knownTitles(h);
    // The show whose one episode carries a number needs no lookup; a server item cannot be looked up.
    expect(known.unnumbered.map((u) => u.metaId)).toEqual(['tt2', 'tt1']);
    expect(known.tmdb.has('tv:7')).toBe(true);
  });

  it('keeps the watchlist row to titles with nothing watched, newest first', () => {
    const h = history({
      watched: [film('tt1', 0)],
      progress: [resume('tt2', 0.4, 0)],
      library: [listed('tt1', 9), listed('tt2', 8), listed('tt3', 7), listed('tt4', 1)],
    });
    expect(unstartedWatchlist(h).map((i) => i.metaId)).toEqual(['tt4', 'tt3']);
  });
});

describe('genres', () => {
  const crime = { id: 80, name: 'Crime' };
  const drama = { id: 18, name: 'Drama' };
  const western = { id: 37, name: 'Western' };

  it('adds each seed to its genres by weight, and counts the broad ones for less', () => {
    const a = genreAffinities([
      { kind: 'tv', weight: 1, genres: [crime, drama] },
      { kind: 'tv', weight: 0.5, genres: [crime] },
      { kind: 'movie', weight: 0.4, genres: [western, { id: 10770, name: 'TV Movie' }] },
    ]);
    expect(a.map((g) => `${g.kind}:${g.name}`)).toEqual(['tv:Crime', 'tv:Drama', 'movie:Western']);
    // Drama is on the same seed as Crime, at the same weight, and still ranks lower.
    const [c, d] = a;
    expect(c.score).toBeCloseTo(1 / Math.SQRT2 + 0.5, 5);
    expect(d.score).toBeCloseTo((1 / Math.SQRT2) * 0.6, 5);
    // "TV Movie" is not a taste, and does not thin out the film's real genre.
    expect(a[2].score).toBeCloseTo(0.4, 5);
  });

  it('gives each kind its own top genres, borrowing from the other kind at half strength', () => {
    const a = genreAffinities([
      { kind: 'tv', weight: 1, genres: [crime, { id: 10765, name: 'Sci-Fi & Fantasy' }] },
      { kind: 'movie', weight: 0.3, genres: [western] },
    ]);
    expect(topGenres('tv', a)).toEqual([80, 10765, 37]);
    // No crime film was watched: the shows speak for it, and Sci-Fi & Fantasy becomes the two movie genres.
    expect(topGenres('movie', a, 4)).toEqual([14, 80, 878, 37]);
    expect(topGenres('movie', [])).toEqual([]);
  });

  it('gives the two strongest different genres a row each', () => {
    const a = genreAffinities([
      { kind: 'tv', weight: 1, genres: [crime] },
      { kind: 'movie', weight: 0.8, genres: [crime] },
      { kind: 'movie', weight: 0.5, genres: [western] },
    ]);
    expect(genreRowPicks(a).map(genreRowTitle)).toEqual(['Crime shows for you', 'Western movies for you']);
    // Only one genre known: its other kind is the second row.
    expect(genreRowPicks(a.filter((g) => g.id === 80)).map(genreRowTitle)).toEqual(['Crime shows for you', 'Crime movies for you']);
    expect(genreRowPicks([])).toEqual([]);
    expect(genreRowTitle({ kind: 'movie', name: 'Documentary' })).toBe('Documentaries for you');
  });

  it('finds the languages the profile watches in', () => {
    expect(
      topLanguages([
        { weight: 1, language: 'en' },
        { weight: 0.9, language: 'en' },
        { weight: 0.6, language: 'ko' },
        { weight: 0.1, language: 'fr' },
        { weight: 0.5 },
      ]),
    ).toEqual(['en', 'ko']);
    expect(topLanguages([{ weight: 1 }])).toEqual([]);
  });
});
