import { describe, expect, it } from 'vitest';
import { airTime, deriveContinue, hasAirClock, seriesPosition, upNext, type EpisodeRef } from './continue';
import type { ProgressEntry, WatchedEntry } from '../state/history';

const ep = (season: number, episode: number, released = '2020-01-01'): EpisodeRef => ({ id: `tt1:${season}:${episode}`, season, episode, released });
const NOW = Date.UTC(2026, 10, 24);

function watched(metaId: string, season: number, episode: number, at: number): WatchedEntry {
  return { key: `${metaId}:${season}:${episode}`, metaId, type: 'series', season, episode, at };
}

function progress(metaId: string, at: number, extra: Partial<ProgressEntry> = {}): ProgressEntry {
  return { key: metaId, metaId, type: 'movie', positionS: 600, durationS: 6000, updatedAt: at, ...extra };
}

describe('deriveContinue', () => {
  it('orders resume points by last activity', () => {
    const r = deriveContinue({
      progress: { a: progress('a', 10), b: progress('b', 30), c: progress('c', 20) },
      watched: {},
      dismissed: {},
      episodes: new Map(),
      now: NOW,
    });
    expect(r.items.map((i) => i.metaId)).toEqual(['b', 'c', 'a']);
    expect(r.items[0].progress).toBeCloseTo(0.1);
  });

  it('offers the next episode after the latest finished one', () => {
    const r = deriveContinue({
      progress: {},
      watched: { a: watched('tt1', 1, 1, 100), b: watched('tt1', 1, 2, 200) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(0, 1), ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1)]]]),
      now: NOW,
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'next', season: 1, episode: 3, at: 200, videoId: 'tt1:1:3' });
  });

  it('skips episodes already watched and stops at unreleased ones', () => {
    const r1 = deriveContinue({
      progress: {},
      watched: { a: watched('tt1', 1, 1, 300), b: watched('tt1', 1, 2, 100) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(1, 1), ep(1, 2), ep(1, 3)]]]),
      now: NOW,
    });
    expect(r1.items[0]).toMatchObject({ season: 1, episode: 3 });
    const r2 = deriveContinue({
      progress: {},
      watched: { a: watched('tt1', 1, 2, 300) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(1, 2), ep(1, 3, '2027-05-01')]]]),
      now: NOW,
    });
    expect(r2.items).toHaveLength(0);
  });

  it('prefers a newer resume point of the same show, and asks for episode lists it lacks', () => {
    const r = deriveContinue({
      progress: { k: progress('tt1', 500, { type: 'series', season: 1, episode: 5, key: 'tt1:1:5' }) },
      watched: { a: watched('tt1', 1, 4, 400), b: watched('tt2', 2, 2, 450) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(1, 4), ep(1, 5)]]]),
      now: NOW,
    });
    expect(r.items.map((i) => [i.metaId, i.kind])).toEqual([['tt1', 'resume']]);
    expect(r.needEpisodes).toEqual(['tt2']);
  });

  it('hides dismissed titles until there is newer activity', () => {
    const input = { progress: { a: progress('a', 100) }, watched: {}, episodes: new Map(), now: NOW };
    expect(deriveContinue({ ...input, dismissed: { a: 150 } }).items).toHaveLength(0);
    expect(deriveContinue({ ...input, dismissed: { a: 50 } }).items).toHaveLength(1);
  });

  it('shows entries that have no timestamp', () => {
    // A tracker that sends no date gives 0: nothing was dismissed, so nothing is hidden.
    const r = deriveContinue({
      progress: { a: progress('a', 0) },
      watched: { w: watched('tt1', 1, 1, 0) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(1, 1), ep(1, 2)]]]),
      now: NOW,
    });
    expect(r.items.map((i) => [i.metaId, i.kind]).sort()).toEqual([
      ['a', 'resume'],
      ['tt1', 'next'],
    ]);
    // A real dismissal still hides them.
    expect(deriveContinue({ progress: { a: progress('a', 0) }, watched: {}, dismissed: { a: 10 }, episodes: new Map(), now: NOW }).items).toHaveLength(0);
  });

  it('offers the next episode in order while a show is watched again', () => {
    const episodes = new Map([['tt1', [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)]]]);
    // All four seen last year; the first one again today.
    const old = { b: watched('tt1', 1, 2, 110), c: watched('tt1', 1, 3, 120), d: watched('tt1', 1, 4, 130) };
    const again = deriveContinue({ progress: {}, watched: { a: { ...watched('tt1', 1, 1, 5000), plays: 2 }, ...old }, dismissed: {}, episodes, now: NOW });
    expect(again.items).toEqual([expect.objectContaining({ kind: 'next', season: 1, episode: 2, at: 5000 })]);
    // Then the second one: on to the third, and past the end once the run is complete.
    const second = deriveContinue({ progress: {}, watched: { a: { ...watched('tt1', 1, 1, 5000), plays: 2 }, b: { ...watched('tt1', 1, 2, 6000), plays: 2 }, c: old.c, d: old.d }, dismissed: {}, episodes, now: NOW });
    expect(second.items[0]).toMatchObject({ season: 1, episode: 3 });
  });

  it('still skips watched episodes after catching up on one that was missed', () => {
    // Episode 2 was skipped and watched for the first time today: 3 is not offered again.
    const r = deriveContinue({
      progress: {},
      watched: { a: watched('tt1', 1, 1, 100), c: watched('tt1', 1, 3, 120), b: watched('tt1', 1, 2, 5000) },
      dismissed: {},
      episodes: new Map([['tt1', [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)]]]),
      now: NOW,
    });
    expect(r.items[0]).toMatchObject({ kind: 'next', season: 1, episode: 4 });
  });

  it('keeps a movie and a show apart when they share a TMDB number', () => {
    const r = deriveContinue({
      progress: {
        'tmdb:693': progress('tmdb:693', 100, { key: 'tmdb:693' }),
        'tmdb:693:1:2': progress('tmdb:693', 200, { type: 'series', season: 1, episode: 2, key: 'tmdb:693:1:2' }),
      },
      watched: {},
      dismissed: { 'tmdb:693@movie': 150 },
      episodes: new Map(),
      now: NOW,
    });
    // Two titles; removing the movie from the row does not hide the show.
    expect(r.items.map((i) => i.type)).toEqual(['series']);
    expect(deriveContinue({ progress: { 'tmdb:693': progress('tmdb:693', 100, { key: 'tmdb:693' }), 'tmdb:693:1:2': progress('tmdb:693', 200, { type: 'series', season: 1, episode: 2, key: 'tmdb:693:1:2' }) }, watched: {}, dismissed: {}, episodes: new Map(), now: NOW }).items).toHaveLength(2);
  });
});

describe('upNext', () => {
  it('gives the later episode when two were marked at the same moment', () => {
    // A whole season marked at once: the position is its last episode, on the title page and in the row alike.
    const pos = seriesPosition([watched('tt1', 1, 2, 100), watched('tt1', 1, 3, 100), watched('tt1', 1, 1, 100)])!;
    expect(pos.latest).toMatchObject({ season: 1, episode: 3 });
    expect(upNext([ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1)], pos, NOW)).toMatchObject({ season: 2, episode: 1 });
  });

  it('waits for an episode that has not aired', () => {
    const pos = seriesPosition([watched('tt1', 1, 1, 100)])!;
    expect(upNext([ep(1, 1), ep(1, 2, '2027-05-01')], pos, NOW)).toBeNull();
  });
});

describe('airTime', () => {
  it('reads a date, or midnight UTC standing for one, as that day here', () => {
    const day = new Date(2026, 4, 1).getTime();
    expect(airTime('2026-05-01')).toBe(day);
    expect(airTime('2026-05-01T00:00:00.000Z')).toBe(day);
    expect(new Date(airTime('2026-05-01T00:00:00Z')).getDate()).toBe(1);
    expect(hasAirClock('2026-05-01T00:00:00.000Z')).toBe(false);
  });

  it('keeps a real time of day', () => {
    expect(airTime('2026-05-01T20:30:00.000Z')).toBe(Date.UTC(2026, 4, 1, 20, 30));
    expect(hasAirClock('2026-05-01T20:30:00.000Z')).toBe(true);
    expect(Number.isNaN(airTime(undefined))).toBe(true);
    expect(Number.isNaN(airTime('soon'))).toBe(true);
  });
});
