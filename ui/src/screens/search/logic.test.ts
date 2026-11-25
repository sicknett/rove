import { describe, expect, it } from 'vitest';
import type { MetaPreview } from '../../addons/types';
import type { PersonHit, TitleHit } from '../shared/hits';
import {
  addRecent,
  forQuery,
  groupByType,
  isSettled,
  latestOnly,
  matchOwn,
  matchQuality,
  mergeReads,
  ownTitles,
  readQuery,
  removeRecent,
  sortHits,
  sortPreviews,
  tidy,
  topHit,
  withoutKnown,
} from './logic';

const movie = (tmdbId: number, name: string, more: Partial<TitleHit> = {}): TitleHit => ({ tmdbId, kind: 'movie', type: 'movie', name, rating: 0, votes: 0, popularity: 0, genres: [], ...more });
const show = (tmdbId: number, name: string, more: Partial<TitleHit> = {}): TitleHit => ({ ...movie(tmdbId, name, more), kind: 'tv', type: 'series' });
const person = (id: number, name: string, popularity: number): PersonHit => ({ id, name, popularity, knownFor: [] });
const card = (id: string, name: string, type = 'movie', more: Partial<MetaPreview> = {}): MetaPreview => ({ id, type, name, ...more });
const names = (list: { name: string }[]) => list.map((x) => x.name);

describe('reading what was typed', () => {
  it('tidies spaces', () => {
    expect(tidy('  blade   runner ')).toBe('blade runner');
    expect(readQuery('  dune ', 2026)).toEqual({ text: 'dune' });
  });

  it('knows an id from a name', () => {
    expect(readQuery('tt0133093', 2026)).toEqual({ text: 'tt0133093', id: 'tt0133093' });
    expect(readQuery(' TMDB:603 ', 2026)).toEqual({ text: 'TMDB:603', id: 'tmdb:603' });
    // Too short for an IMDb id, and a name that only starts like one.
    expect(readQuery('tt123', 2026).id).toBeUndefined();
    expect(readQuery('tt0133093 matrix', 2026).id).toBeUndefined();
  });

  it('reads a year at the end as a year, and keeps the text as typed', () => {
    expect(readQuery('dune 2021', 2026)).toEqual({ text: 'dune 2021', year: 2021, base: 'dune' });
    expect(readQuery('Dune (1984)', 2026)).toEqual({ text: 'Dune (1984)', year: 1984, base: 'Dune' });
    expect(readQuery('wonder woman 1984', 2026)).toMatchObject({ text: 'wonder woman 1984', year: 1984, base: 'wonder woman' });
  });

  it('does not take every number for a year', () => {
    // No film is listed that far ahead; a year alone is a title; one letter is not a name.
    expect(readQuery('blade runner 2049', 2026)).toEqual({ text: 'blade runner 2049' });
    expect(readQuery('2012', 2026)).toEqual({ text: '2012' });
    expect(readQuery('1917', 2026)).toEqual({ text: '1917' });
    expect(readQuery('x 2020', 2026)).toEqual({ text: 'x 2020' });
    expect(readQuery('apollo 13', 2026)).toEqual({ text: 'apollo 13' });
  });
});

describe('never showing an older query’s results', () => {
  it('holds results back while the box holds other text than was searched', () => {
    expect(isSettled('dune', 'dune')).toBe(true);
    // A space typed after the word is not other text.
    expect(isSettled('dune ', 'dune')).toBe(true);
    expect(isSettled('dune p', 'dune')).toBe(false);
    expect(isSettled('dun', 'dune')).toBe(false);
    expect(isSettled('', 'dune')).toBe(false);
  });

  it('drops an answer that is for another query', () => {
    const answer = { query: 'dune', hits: [1, 2] };
    expect(forQuery(answer, 'dune')).toBe(answer);
    expect(forQuery(answer, 'dune part two')).toBeUndefined();
    expect(forQuery(undefined, 'dune')).toBeUndefined();
  });

  it('lets only the newest of overlapping calls act', async () => {
    const calls = latestOnly();
    const shown: string[] = [];
    const lookUp = async (what: string, ms: number) => {
      const current = calls.start();
      await new Promise((r) => setTimeout(r, ms));
      if (current()) shown.push(what);
    };
    // The first is slower than the second and finishes after it.
    await Promise.all([lookUp('old', 30), lookUp('new', 5)]);
    expect(shown).toEqual(['new']);
  });

  it('makes every running call stale when cancelled', () => {
    const calls = latestOnly();
    const a = calls.start();
    expect(a()).toBe(true);
    calls.cancel();
    expect(a()).toBe(false);
    const b = calls.start();
    expect(b()).toBe(true);
    expect(a()).toBe(false);
  });
});

describe('how well text names something', () => {
  it('ranks the whole name over its start, its words, and a part of it', () => {
    expect(matchQuality('dune', 'Dune')).toBe(3);
    expect(matchQuality('dune', 'Dune: Part Two')).toBe(2);
    expect(matchQuality('tom han', 'Tom Hanks')).toBe(2);
    expect(matchQuality('nolan', 'Christopher Nolan')).toBe(1.5);
    expect(matchQuality('runner', 'Blade Runner')).toBe(1.5);
    expect(matchQuality('unn', 'Blade Runner')).toBe(1);
    expect(matchQuality('dune', 'Arrakis')).toBe(0.3);
  });

  it('looks past capitals, accents, punctuation and a leading article', () => {
    expect(matchQuality('amelie', 'Amélie')).toBe(3);
    expect(matchQuality('godfather', 'The Godfather')).toBe(3);
    expect(matchQuality('the godfather', 'Godfather')).toBe(3);
    expect(matchQuality('spider man', 'Spider-Man')).toBe(3);
    // The original title counts as much as the translated one.
    expect(matchQuality('la casa de papel', 'Money Heist', 'La Casa de Papel')).toBe(3);
  });
});

describe('merging and ordering results', () => {
  it('puts the text as typed first and the name-in-that-year reading behind it', () => {
    const typed = [movie(1, 'Wonder Woman 1984')];
    const inYear = [movie(2, 'Wonder Woman'), movie(1, 'Wonder Woman 1984')];
    expect(mergeReads(typed, inYear)).toEqual({ hits: [typed[0], inYear[0]], byYear: false });
  });

  it('follows the year reading when the text as typed finds nothing', () => {
    const inYear = [movie(438631, 'Dune', { year: '2021' })];
    expect(mergeReads([], inYear)).toEqual({ hits: inYear, byYear: true });
    expect(mergeReads([], null)).toEqual({ hits: [], byYear: false });
    expect(mergeReads([movie(1, 'A')], [])).toEqual({ hits: [movie(1, 'A')], byYear: false });
  });

  const list = [
    movie(1, 'Old favourite', { popularity: 40, date: '1999-03-31', rating: 8.2, votes: 20000 }),
    movie(2, 'New and small', { popularity: 5, date: '2026-01-10', rating: 9.5, votes: 3 }),
    movie(3, 'Undated', { popularity: 90, rating: 6.1, votes: 400 }),
    movie(4, 'Recent hit', { popularity: 90, date: '2024-02-27', rating: 8.2, votes: 9000 }),
  ];

  it('keeps TMDB’s order for relevance', () => {
    expect(sortHits(list, 'relevance')).toBe(list);
  });

  it('orders by popularity, keeping the order they came in for ties', () => {
    expect(names(sortHits(list, 'popularity'))).toEqual(['Undated', 'Recent hit', 'Old favourite', 'New and small']);
  });

  it('orders by date with undated titles last', () => {
    expect(names(sortHits(list, 'newest'))).toEqual(['New and small', 'Recent hit', 'Old favourite', 'Undated']);
  });

  it('orders by rating, but not on the strength of a handful of votes', () => {
    expect(names(sortHits(list, 'rating'))).toEqual(['Old favourite', 'Recent hit', 'Undated', 'New and small']);
  });

  it('orders addon cards by what they carry', () => {
    const cards = [card('a', 'A', 'movie', { releaseInfo: '1999', imdbRating: '8.7' }), card('b', 'B', 'movie', { releaseInfo: '2019-2022', imdbRating: '7.1' }), card('c', 'C')];
    expect(names(sortPreviews(cards, 'newest'))).toEqual(['B', 'A', 'C']);
    expect(names(sortPreviews(cards, 'rating'))).toEqual(['A', 'B', 'C']);
    expect(sortPreviews(cards, 'popularity')).toBe(cards);
  });

  it('groups addon results by type, each title once, movies then shows then the rest', () => {
    const groups = groupByType([[card('tt1', 'A'), card('kitsu:1', 'Anime', 'anime')], undefined, [card('tt2', 'S', 'series'), card('tt1', 'A again')]]);
    expect(groups.map(([type, items]) => [type, names(items)])).toEqual([
      ['movie', ['A']],
      ['series', ['S']],
      ['anime', ['Anime']],
    ]);
  });

  it('leaves out addon results TMDB already found, by kind, name and year', () => {
    const hits = [movie(438631, 'Dune', { year: '2021' }), show(1, 'Dune', { year: '2000' }), movie(2, 'Money Heist: The Movie', { original: 'La casa de papel', year: '2023' })];
    const cards = [
      card('tt1160419', 'Dune', 'movie', { releaseInfo: '2021' }),
      // The same name from another year is another film.
      card('tt0087182', 'Dune', 'movie', { releaseInfo: '1984' }),
      // Premiere years differ by one between sources.
      card('tt0142032', 'DUNE', 'series', { releaseInfo: '2001-2003' }),
      card('tt99', 'La Casa de Papel', 'movie'),
      card('kitsu:9', 'Dune', 'anime', { releaseInfo: '2021' }),
    ];
    expect(withoutKnown(cards, hits).map((m) => m.id)).toEqual(['tt0087182', 'kitsu:9']);
    expect(withoutKnown(cards, [])).toBe(cards);
  });
});

describe('the best match', () => {
  const dune = [
    movie(438631, 'Dune', { year: '2021', popularity: 46, votes: 16034 }),
    movie(693134, 'Dune: Part Two', { year: '2024', popularity: 56, votes: 9048 }),
    movie(1, 'Dune: Part Three', { year: '2026', popularity: 48, votes: 0 }),
    movie(841, 'Dune', { year: '1984', popularity: 13, votes: 3639 }),
  ];

  it('is the best known title of that name', () => {
    expect(topHit(readQuery('dune', 2026), dune, [show(2, 'Dune: Prophecy', { popularity: 30, votes: 900 })], [])).toMatchObject({ kind: 'title', hit: { tmdbId: 438631 } });
  });

  it('takes a year typed with the name into account', () => {
    expect(topHit(readQuery('dune 1984', 2026), dune, [], [])).toMatchObject({ kind: 'title', hit: { tmdbId: 841 } });
  });

  it('is the person when a person is what was typed', () => {
    const films = [movie(5, 'Tom Hanks: The Nomad', { popularity: 2, votes: 40 })];
    const top = topHit(readQuery('tom hanks', 2026), films, [], [person(31, 'Tom Hanks', 10.5), person(32, 'Tom Hanson', 0.5)]);
    expect(top).toMatchObject({ kind: 'person', person: { id: 31 } });
  });

  it('does not let an obscure namesake beat someone famous', () => {
    // A film called exactly "Nolan" that three people have rated, against Christopher Nolan.
    const top = topHit(readQuery('nolan', 2026), [movie(7, 'Nolan', { popularity: 0.4, votes: 3 })], [], [person(525, 'Christopher Nolan', 9.4)]);
    expect(top).toMatchObject({ kind: 'person', person: { id: 525 } });
  });

  it('finds a title behind its article, and a show over a film when the show is the known one', () => {
    expect(topHit(readQuery('godfather', 2026), [movie(238, 'The Godfather', { popularity: 50, votes: 24046 }), movie(9, 'GodFather', { popularity: 1, votes: 20 })], [], [])).toMatchObject({ hit: { tmdbId: 238 } });
    expect(topHit(readQuery('friends', 2026), [movie(8, 'Friends', { popularity: 2, votes: 40 })], [show(1668, 'Friends', { popularity: 150, votes: 8000 })], [])).toMatchObject({ hit: { tmdbId: 1668, type: 'series' } });
  });

  it('is nothing when nothing was found', () => {
    expect(topHit(readQuery('zzqqxx', 2026), [], [], [])).toBeNull();
  });
});

describe('the profile’s own titles', () => {
  const history = {
    library: { tt1: { metaId: 'tt1', type: 'movie' as const, name: 'The Matrix', poster: 'p1', addedAt: 50 } },
    progress: {
      'tt2:1:3': { key: 'tt2:1:3', metaId: 'tt2', type: 'series' as const, season: 1, episode: 3, name: 'Severance', positionS: 100, durationS: 3000, updatedAt: 90 },
      tt1: { key: 'tt1', metaId: 'tt1', type: 'movie' as const, name: 'The Matrix', positionS: 10, durationS: 8000, updatedAt: 70 },
    },
    watched: {
      tt3: { key: 'tt3', metaId: 'tt3', type: 'movie' as const, at: 20 },
      tt4: { key: 'tt4', metaId: 'tt4', type: 'movie' as const, at: 10 },
      'tmdb:603': { key: 'tmdb:603', metaId: 'tmdb:603', type: 'movie' as const, at: 5 },
    },
    cards: { tt3: { type: 'movie' as const, name: 'The Matrix Reloaded', poster: 'p3', year: '2003' }, 'tmdb:603@movie': { type: 'movie' as const, name: 'Matrix, The (TMDB)' } },
  };

  it('lists each title once, under the strongest reason it is theirs', () => {
    const own = ownTitles(history);
    expect(own.map((t) => [t.metaId, t.where, t.name]).sort()).toEqual(
      [
        ['tt1', 'progress', 'The Matrix'],
        ['tt2', 'progress', 'Severance'],
        ['tt3', 'watched', 'The Matrix Reloaded'],
        ['tmdb:603', 'watched', 'Matrix, The (TMDB)'],
      ].sort(),
    );
    // Watched with no name kept anywhere: it cannot be matched, so it is not listed.
    expect(own.some((t) => t.metaId === 'tt4')).toBe(false);
    expect(own.find((t) => t.metaId === 'tt1')).toMatchObject({ poster: 'p1', at: 70 });
    expect(own.find((t) => t.metaId === 'tt3')).toMatchObject({ poster: 'p3', year: '2003' });
  });

  it('matches them by name: names that start with the text first, then the most recent', () => {
    const own = ownTitles(history);
    expect(names(matchOwn('matrix', own))).toEqual(['The Matrix', 'The Matrix Reloaded', 'Matrix, The (TMDB)']);
    expect(names(matchOwn('matrix rel', own))).toEqual(['The Matrix Reloaded']);
    expect(names(matchOwn('sever', own))).toEqual(['Severance']);
    expect(matchOwn('m', own)).toEqual([]);
    expect(matchOwn('dune', own)).toEqual([]);
    expect(matchOwn('matrix', own, 1)).toHaveLength(1);
  });
});

describe('recent searches', () => {
  it('puts the newest first, once, and keeps a dozen', () => {
    expect(addRecent(['matrix', 'dune'], 'Dune')).toEqual(['Dune', 'matrix']);
    expect(addRecent(['a', 'b'], '  blade   runner ')).toEqual(['blade runner', 'a', 'b']);
    expect(addRecent(['a'], '   ')).toEqual(['a']);
    const many = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const next = addRecent(many, 'new');
    expect(next).toHaveLength(12);
    expect(next[0]).toBe('new');
    expect(next).not.toContain('q11');
  });

  it('removes one and leaves the rest in place', () => {
    expect(removeRecent(['matrix', 'dune', 'heat'], 'DUNE')).toEqual(['matrix', 'heat']);
    expect(removeRecent(['matrix'], 'nothing')).toEqual(['matrix']);
  });
});
