import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../meta/tmdb', () => ({
  searchTitles: vi.fn(),
  tmdbImage: (path: string | null | undefined, size: string) => (path ? `img:${size}${path}` : undefined),
}));
vi.mock('../tracking/idmap', () => ({ metaIdFor: vi.fn(async (id: number) => `tmdb:${id}`) }));

import { searchTitles, type TmdbSearchItem } from '../meta/tmdb';
import { metaIdFor } from '../tracking/idmap';
import { normTitle, pickMatch, resolveSuggestion, resolveSuggestions } from './resolve';

const search = vi.mocked(searchTitles);
const movie = (id: number, title: string, date: string, extra: Partial<TmdbSearchItem> = {}): TmdbSearchItem => ({ id, title, release_date: date, ...extra });
const show = (id: number, name: string, date: string, extra: Partial<TmdbSearchItem> = {}): TmdbSearchItem => ({ id, name, first_air_date: date, ...extra });

beforeEach(() => {
  search.mockReset();
  vi.mocked(metaIdFor).mockClear();
});

describe('normTitle', () => {
  it('ignores case, accents, punctuation and a leading article', () => {
    expect(normTitle('Léon: The Professional')).toBe('leon the professional');
    expect(normTitle('The Good, the Bad & the Ugly')).toBe('good the bad and the ugly');
    expect(normTitle('WALL·E')).toBe('wall e');
  });
});

describe('pickMatch', () => {
  const suspiria = [movie(1, 'Suspiria', '2018-10-26'), movie(2, 'Suspiria', '1977-02-01'), movie(3, 'Suspiria: 25th Anniversary', '2001-01-01')];

  it('picks the film of the right year among films of one name', () => {
    expect(pickMatch(suspiria, { title: 'Suspiria', year: 1977 })?.id).toBe(2);
    expect(pickMatch(suspiria, { title: 'Suspiria', year: 2018 })?.id).toBe(1);
  });

  it('allows the year to be one off, and no further', () => {
    expect(pickMatch(suspiria, { title: 'suspiria', year: 1978 })?.id).toBe(2);
    expect(pickMatch(suspiria, { title: 'Suspiria', year: 1990 })).toBeNull();
  });

  it('prefers the exact year over a neighbouring one', () => {
    const twins = [movie(1, 'Crash', '2005-05-06'), movie(2, 'Crash', '2004-09-10')];
    expect(pickMatch(twins, { title: 'Crash', year: 2004 })?.id).toBe(2);
  });

  it('without a year takes the best known title of exactly that name', () => {
    expect(pickMatch(suspiria, { title: 'Suspiria' })?.id).toBe(1);
    expect(pickMatch([movie(3, 'Suspiria: 25th Anniversary', '2001-01-01')], { title: 'Suspiria' })).toBeNull();
  });

  it('accepts the short form of a longer title only when asked to, and only in the very same year', () => {
    const leon = [movie(101, 'Léon: The Professional', '1994-09-14', { original_title: 'Léon' })];
    // Its original title is the short form: an exact match.
    expect(pickMatch(leon, { title: 'Leon', year: 1995 })?.id).toBe(101);
    const birdman = [movie(7, 'Birdman or (The Unexpected Virtue of Ignorance)', '2014-10-17')];
    expect(pickMatch(birdman, { title: 'Birdman', year: 2014 })).toBeNull();
    expect(pickMatch(birdman, { title: 'Birdman', year: 2014 }, true)?.id).toBe(7);
    expect(pickMatch(birdman, { title: 'Birdman', year: 2015 }, true)).toBeNull();
    expect(pickMatch(birdman, { title: 'Birdman' }, true)).toBeNull();
    // An exact name still wins over a longer one.
    expect(pickMatch([...birdman, movie(8, 'Birdman', '2014-01-01')], { title: 'Birdman', year: 2014 }, true)?.id).toBe(8);
  });

  it('matches a title by its original name, and never something merely similar', () => {
    const results = [show(5, 'Money Heist', '2017-05-02', { original_name: 'La Casa de Papel' }), show(6, 'Heist', '2021-07-14')];
    expect(pickMatch(results, { title: 'La casa de papel', year: 2017 })?.id).toBe(5);
    expect(pickMatch(results, { title: 'Money Heist: Korea', year: 2022 }, true)).toBeNull();
    expect(pickMatch([movie(9, 'Heat', '')], { title: 'Heat', year: 1995 })).toBeNull();
    expect(pickMatch(results, { title: '   ' })).toBeNull();
  });
});

describe('resolveSuggestion', () => {
  it('searches movies for a movie and shows for a series, with the year', async () => {
    search.mockResolvedValueOnce([movie(949, 'Heat', '1995-12-15', { poster_path: '/heat.jpg', backdrop_path: '/heat-bg.jpg', vote_average: 7.9 })]);
    vi.mocked(metaIdFor).mockResolvedValueOnce('tt0113277');
    await expect(resolveSuggestion({ title: 'Heat', year: 1995, type: 'movie', reason: 'Precise.' })).resolves.toEqual({
      metaId: 'tt0113277',
      type: 'movie',
      name: 'Heat',
      poster: 'img:w342/heat.jpg',
      background: 'img:w1280/heat-bg.jpg',
      year: '1995',
      rating: '7.9',
      tmdbId: 949,
      reason: 'Precise.',
    });
    expect(search).toHaveBeenCalledWith('movie', 'Heat', 1995);
    expect(metaIdFor).toHaveBeenCalledWith(949, 'movie');

    search.mockResolvedValueOnce([show(95396, 'Severance', '2022-02-17')]);
    const card = await resolveSuggestion({ title: 'Severance', year: 2022, type: 'series', reason: '' });
    expect(search).toHaveBeenLastCalledWith('tv', 'Severance', 2022);
    expect(card).toMatchObject({ metaId: 'tmdb:95396', type: 'series', name: 'Severance', year: '2022' });
  });

  it('looks again without the year when the year was one off', async () => {
    // TMDB's year filter is exact: 1994 finds nothing for a film released in 1995.
    search.mockResolvedValueOnce([]).mockResolvedValueOnce([movie(1, 'Se7en', '1995-09-22'), movie(2, 'Seven', '1979-01-01')]);
    const card = await resolveSuggestion({ title: 'Se7en', year: 1994, type: 'movie', reason: '' });
    expect(search.mock.calls).toEqual([
      ['movie', 'Se7en', 1994],
      ['movie', 'Se7en'],
    ]);
    expect(card?.tmdbId).toBe(1);
  });

  it('finds a series the assistant called a movie, before settling for a longer-named film', async () => {
    // What TMDB really has for 2019: a film that begins with the series' name.
    const spinOff = movie(575776, 'Chernobyl: Zone of Exclusion. Finale', '2019-09-26');
    search.mockResolvedValueOnce([spinOff]).mockResolvedValueOnce([spinOff]).mockResolvedValueOnce([show(87108, 'Chernobyl', '2019-05-06')]);
    const card = await resolveSuggestion({ title: 'Chernobyl', year: 2019, type: 'movie', reason: '' });
    expect(search).toHaveBeenLastCalledWith('tv', 'Chernobyl', 2019);
    expect(card).toMatchObject({ type: 'series', name: 'Chernobyl', tmdbId: 87108 });
    expect(metaIdFor).toHaveBeenCalledWith(87108, 'tv');
  });

  it('takes a longer title of the same year when nothing has the exact name', async () => {
    const birdman = movie(194662, 'Birdman or (The Unexpected Virtue of Ignorance)', '2014-10-17');
    search.mockResolvedValueOnce([birdman]).mockResolvedValueOnce([birdman]).mockResolvedValueOnce([]);
    const card = await resolveSuggestion({ title: 'Birdman', year: 2014, type: 'movie', reason: '' });
    expect(card).toMatchObject({ type: 'movie', tmdbId: 194662 });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('gives up on a title TMDB does not have, and does not swap types without a year', async () => {
    search.mockResolvedValue([]);
    await expect(resolveSuggestion({ title: 'A Film That Does Not Exist', type: 'movie', reason: '' })).resolves.toBeNull();
    expect(search).toHaveBeenCalledTimes(1);
    expect(metaIdFor).not.toHaveBeenCalled();
  });

  it('keeps the tmdb id when the IMDb id cannot be looked up', async () => {
    search.mockResolvedValueOnce([movie(11, 'Ronin', '1998-09-25')]);
    vi.mocked(metaIdFor).mockRejectedValueOnce(new Error('offline'));
    await expect(resolveSuggestion({ title: 'Ronin', year: 1998, type: 'movie', reason: '' })).resolves.toMatchObject({ metaId: 'tmdb:11' });
  });
});

describe('resolveSuggestions', () => {
  it('keeps the order, drops what does not resolve and what resolves twice, and counts failures', async () => {
    search.mockImplementation(async (kind, query) => {
      if (query === 'Down') throw new Error('TMDB did not answer');
      if (kind === 'movie' && query === 'Heat') return [movie(949, 'Heat', '1995-12-15')];
      if (kind === 'movie' && query === 'Ronin') return [movie(11, 'Ronin', '1998-09-25')];
      return [];
    });
    const { cards, failed } = await resolveSuggestions([
      { title: 'Ronin', year: 1998, type: 'movie', reason: 'a' },
      { title: 'Made Up', year: 2001, type: 'movie', reason: 'b' },
      { title: 'Heat', year: 1995, type: 'movie', reason: 'c' },
      { title: 'Down', year: 2000, type: 'movie', reason: 'd' },
      { title: 'Heat', year: 1996, type: 'movie', reason: 'e' },
    ]);
    expect(cards.map((c) => [c.name, c.reason])).toEqual([
      ['Ronin', 'a'],
      ['Heat', 'c'],
    ]);
    expect(failed).toBe(1);
  });

  it('stops when cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(resolveSuggestions([{ title: 'Heat', year: 1995, type: 'movie', reason: '' }], stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(search).not.toHaveBeenCalled();
  });
});
