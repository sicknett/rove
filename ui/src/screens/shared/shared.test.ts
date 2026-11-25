import { describe, expect, it } from 'vitest';
import { genreNames, genresForKind } from './genres';
import { hitPreview, kidSafe, personHits, plainText, titleHits, toTitleHit, uniqueHits, wellKnown } from './hits';
import { stepFrom, type Box } from './keynav';

describe('titles and people as TMDB sends them', () => {
  it('reads a movie and a show, each by its own field names', () => {
    expect(toTitleHit({ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-31', vote_average: 8.2, vote_count: 26000, popularity: 60, poster_path: '/p.jpg', genre_ids: [28, 878] }, 'movie')).toEqual({
      tmdbId: 603,
      kind: 'movie',
      type: 'movie',
      name: 'The Matrix',
      original: undefined,
      date: '1999-03-31',
      year: '1999',
      rating: 8.2,
      votes: 26000,
      popularity: 60,
      poster: '/p.jpg',
      backdrop: undefined,
      overview: undefined,
      genres: [28, 878],
    });
    expect(toTitleHit({ id: 71446, name: 'Money Heist', original_name: 'La Casa de Papel', first_air_date: '2017-05-02' }, 'tv')).toMatchObject({ kind: 'tv', type: 'series', name: 'Money Heist', original: 'La Casa de Papel', year: '2017' });
  });

  it('takes the kind a mixed list says over the one assumed', () => {
    expect(toTitleHit({ id: 1, name: 'A show', media_type: 'tv' }, 'movie')).toMatchObject({ kind: 'tv', type: 'series' });
  });

  it('leaves out adult titles, people, and anything without a name', () => {
    expect(toTitleHit({ id: 1, title: 'X', adult: true }, 'movie')).toBeNull();
    expect(toTitleHit({ id: 2, name: 'Someone', media_type: 'person' }, 'movie')).toBeNull();
    expect(toTitleHit({ id: 3, title: '  ' }, 'movie')).toBeNull();
    expect(titleHits([{ id: 1, title: 'A' }, { id: 2, title: 'B', adult: true }], 'movie').map((h) => h.name)).toEqual(['A']);
    expect(titleHits(undefined, 'movie')).toEqual([]);
  });

  it('keeps each title once, a movie and a show of one number apart', () => {
    const hits = titleHits([{ id: 1, title: 'A' }, { id: 1, title: 'A again' }, { id: 1, name: 'Show 1', media_type: 'tv' }], 'movie');
    expect(uniqueHits(hits).map((h) => h.name)).toEqual(['A', 'Show 1']);
  });

  it('turns a hit into a card with a tmdb id and sized pictures', () => {
    const [hit] = titleHits([{ id: 603, title: 'The Matrix', release_date: '1999-03-31', vote_average: 8.24, poster_path: '/p.jpg', backdrop_path: '/b.jpg', overview: 'A hacker.' }], 'movie');
    expect(hitPreview(hit)).toEqual({
      id: 'tmdb:603',
      type: 'movie',
      name: 'The Matrix',
      poster: 'https://image.tmdb.org/t/p/w342/p.jpg',
      background: 'https://image.tmdb.org/t/p/w1280/b.jpg',
      releaseInfo: '1999',
      imdbRating: '8.2',
      description: 'A hacker.',
    });
  });

  it('knows what a Kids profile may see', () => {
    const [family, crime] = titleHits([{ id: 1, title: 'A', genre_ids: [16, 10751] }, { id: 2, title: 'B', genre_ids: [80] }], 'movie');
    expect(kidSafe(family)).toBe(true);
    expect(kidSafe(crime)).toBe(false);
  });

  it('offers unasked only people known for something widely seen', () => {
    const people = personHits([
      { id: 287, name: 'Brad Pitt', known_for: [{ id: 550, title: 'Fight Club', vote_count: 30000 }] },
      { id: 9, name: 'Someone', known_for: [{ id: 1, title: 'Obscure', vote_count: 40 }] },
      { id: 10, name: 'Adult performer', adult: true, known_for: [{ id: 2, title: 'X', vote_count: 5000 }] },
      { id: 11, name: '  ' },
    ]);
    expect(people.map((p) => p.name)).toEqual(['Brad Pitt', 'Someone']);
    expect(people.filter(wellKnown).map((p) => p.name)).toEqual(['Brad Pitt']);
  });

  it('compares names without capitals, accents or punctuation', () => {
    expect(plainText('Amélie')).toBe('amelie');
    expect(plainText('  WALL·E!  ')).toBe('wall e');
    expect(plainText('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(plainText('千と千尋の神隠し')).toBe('千と千尋の神隠し');
    expect(plainText(undefined)).toBe('');
  });
});

describe('genres', () => {
  it('names a title’s genres from either list', () => {
    expect(genreNames('movie', [878, 12, 28, 35])).toEqual(['Science Fiction', 'Adventure', 'Action']);
    expect(genreNames('tv', [10765, 99999, 18])).toEqual(['Sci-Fi & Fantasy', 'Drama']);
    expect(genreNames('movie', undefined)).toEqual([]);
  });

  it('carries chosen genres to the other kind', () => {
    expect(genresForKind([28, 12, 35, 27], 'tv')).toEqual([35, 10759]);
    expect(genresForKind([10759, 10765, 10762, 10764], 'movie')).toEqual([28, 878, 10751]);
    expect(genresForKind([18, 80], 'tv')).toEqual([18, 80]);
  });
});

describe('arrow keys between cards', () => {
  // Two rows of three cards under a wide box, as Search lays them out.
  const box: Box = { left: 0, top: 0, right: 900, bottom: 60 };
  const cardAt = (col: number, row: number): Box => ({ left: col * 200, top: 100 + row * 320, right: col * 200 + 180, bottom: 100 + row * 320 + 270 });
  const cards = [cardAt(0, 0), cardAt(1, 0), cardAt(2, 0), cardAt(0, 1), cardAt(1, 1), cardAt(2, 1)];

  it('moves along a row', () => {
    expect(stepFrom(cards, cards[0], 'right')).toBe(1);
    expect(stepFrom(cards, cards[1], 'right')).toBe(2);
    expect(stepFrom(cards, cards[2], 'left')).toBe(1);
    expect(stepFrom(cards, cards[4], 'left')).toBe(3);
  });

  it('stops at the ends of a row instead of wrapping to another', () => {
    expect(stepFrom(cards, cards[2], 'right')).toBe(-1);
    expect(stepFrom(cards, cards[3], 'left')).toBe(-1);
  });

  it('moves to the card straight above or below', () => {
    expect(stepFrom(cards, cards[1], 'down')).toBe(4);
    expect(stepFrom(cards, cards[5], 'up')).toBe(2);
    expect(stepFrom(cards, cards[0], 'up')).toBe(-1);
    expect(stepFrom(cards, cards[4], 'down')).toBe(-1);
  });

  it('takes the nearest row, not a nearer card in a row further on', () => {
    // A short first row: nothing under the third column until the row after.
    const ragged = [cardAt(0, 0), cardAt(2, 1)];
    expect(stepFrom(ragged, { left: 400, top: 0, right: 580, bottom: 60 }, 'down')).toBe(0);
  });

  it('enters the first result from the left end of the box', () => {
    expect(stepFrom(cards, { ...box, right: box.left + 1 }, 'down')).toBe(0);
    // From the whole box every card of the row is straight below, and the middle one would win.
    expect(stepFrom(cards, box, 'down')).toBe(2);
  });

  it('leads from a button to the card under it, and to a row that scrolls sideways', () => {
    const play: Box = { left: 40, top: 20, right: 150, bottom: 68 };
    expect(stepFrom(cards, play, 'down')).toBe(0);
    // Cards scrolled out to the right are still in the page: the one below is the one in view.
    const offscreen = [cardAt(0, 1), cardAt(9, 1), cardAt(10, 1)];
    expect(stepFrom(offscreen, cards[0], 'down')).toBe(0);
  });
});
