import { describe, expect, it } from 'vitest';
import { findImdbId, findTmdbId, parsePmdbTime } from './pmdb';

describe('parsePmdbTime', () => {
  it('reads the formats PublicMetaDB sends', () => {
    expect(parsePmdbTime('2026-10-20 12:00:00.123Z')).toBe(Date.UTC(2026, 9, 20, 12, 0, 0, 123));
    expect(parsePmdbTime('2026-10-20T12:00:00')).toBe(Date.UTC(2026, 9, 20, 12));
    expect(parsePmdbTime('2026-10-20T12:00:00+02:00')).toBe(Date.UTC(2026, 9, 20, 10));
    expect(parsePmdbTime('2026-10-20')).toBe(Date.UTC(2026, 9, 20));
    expect(parsePmdbTime('1792483200')).toBe(1792483200000);
    expect(parsePmdbTime('1792483200000')).toBe(1792483200000);
    expect(parsePmdbTime('')).toBeNull();
    expect(parsePmdbTime('soon')).toBeNull();
  });
});

describe('mapping payloads', () => {
  it('finds ids in loose shapes', () => {
    expect(findTmdbId({ data: [{ tmdb_id: 1399, media_type: 'tv' }] })).toEqual({ id: 1399, mediaType: 'tv' });
    expect(findTmdbId({ themoviedb_id: '603' })).toEqual({ id: 603, mediaType: undefined });
    expect(findImdbId({ mappings: [{ id_type: 'imdb', id_value: 'tt0944947' }] })).toBe('tt0944947');
    expect(findImdbId({ imdb_id: 'tt0133093' })).toBe('tt0133093');
    expect(findImdbId({ imdb_id: 'nope' })).toBeNull();
  });
});
