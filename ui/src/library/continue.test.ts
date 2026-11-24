import { describe, expect, it } from 'vitest';
import { deriveContinue, type EpisodeRef } from './continue';
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
});
