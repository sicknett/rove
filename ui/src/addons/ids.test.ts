import { describe, expect, it } from 'vitest';
import { idMatchesPrefixes, parseId, titleKey, tmdbIdOf, tmdbTitleNumber } from './ids';

describe('parseId', () => {
  it('reads IMDb titles and episodes', () => {
    expect(parseId('tt0944947')).toEqual({ base: 'tt0944947' });
    expect(parseId('tt0944947:1:2')).toEqual({ base: 'tt0944947', season: 1, episode: 2 });
  });
  it('reads namespaced ids', () => {
    expect(parseId('tmdb:1399')).toEqual({ base: 'tmdb:1399' });
    expect(parseId('tmdb:1399:3:7')).toEqual({ base: 'tmdb:1399', season: 3, episode: 7 });
    expect(parseId('kitsu:1:5')).toEqual({ base: 'kitsu:1', episode: 5 });
  });
  it('keeps media server ids whole', () => {
    expect(parseId('srv:s1:12345')).toEqual({ base: 'srv:s1:12345' });
  });
  it('keeps unknown shapes whole', () => {
    expect(parseId('yt_id:abc')).toEqual({ base: 'yt_id:abc' });
  });
  it('matches id prefixes', () => {
    expect(idMatchesPrefixes('tt1', ['tt'])).toBe(true);
    expect(idMatchesPrefixes('tmdb:1', ['tt'])).toBe(false);
    expect(idMatchesPrefixes('tmdb:1', undefined)).toBe(true);
    expect(tmdbIdOf('tmdb:1399:1:2')).toBe(1399);
  });
});

describe('titleKey', () => {
  it('tells a TMDB movie from the show with the same number', () => {
    expect(titleKey('tmdb:693', 'movie')).toBe('tmdb:693@movie');
    expect(titleKey('tmdb:693', 'series')).toBe('tmdb:693@series');
    expect(titleKey('TMDB:693', 'series')).toBe('tmdb:693@series');
  });
  it('leaves every other id as it is', () => {
    expect(titleKey('tt0944947', 'series')).toBe('tt0944947');
    expect(titleKey('kitsu:1', 'series')).toBe('kitsu:1');
    expect(titleKey('srv:s1:12345', 'movie')).toBe('srv:s1:12345');
  });
  it('reads the number of a bare tmdb title id only', () => {
    expect(tmdbTitleNumber('tmdb:693')).toBe(693);
    expect(tmdbTitleNumber('tmdb:693:3:15')).toBeNull();
    expect(tmdbTitleNumber('tt693')).toBeNull();
  });
});
