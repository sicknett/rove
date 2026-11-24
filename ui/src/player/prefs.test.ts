import { describe, expect, it } from 'vitest';
import { chooseTracks, normLang } from './prefs';
import { DEFAULT_SETTINGS, type Settings } from '../state/settings';
import type { Track } from './store';

const tracks: Track[] = [
  { id: 1, type: 'audio', lang: 'jpn', default: true },
  { id: 2, type: 'audio', lang: 'eng', title: 'English' },
  { id: 3, type: 'audio', lang: 'eng', title: 'Director Commentary' },
  { id: 1, type: 'sub', lang: 'eng', title: 'English (Forced)', forced: true },
  { id: 2, type: 'sub', lang: 'eng', title: 'English' },
  { id: 3, type: 'sub', lang: 'eng', title: 'English SDH' },
  { id: 4, type: 'sub', lang: 'spa' },
];

const settings = (patch: Partial<Settings['languages']>): Settings => ({ ...DEFAULT_SETTINGS, languages: { ...DEFAULT_SETTINGS.languages, ...patch } });

describe('track choice', () => {
  it('normalises language codes', () => {
    expect(normLang('eng')).toBe('en');
    expect(normLang('en-US')).toBe('en');
    expect(normLang('English')).toBe('en');
    expect(normLang('und')).toBeUndefined();
  });

  it('prefers the preferred audio language over the default track, never commentary', () => {
    expect(chooseTracks(tracks, settings({ audio: ['en'] })).aid).toBe(2);
    expect(chooseTracks(tracks, settings({ audio: ['ja'] })).aid).toBe(1);
  });

  it('shows only forced subtitles by default when the audio is preferred', () => {
    expect(chooseTracks(tracks, settings({ audio: ['en'], subtitleMode: 'forced' })).sid).toBe(1);
  });

  it('shows full subtitles for foreign audio', () => {
    expect(chooseTracks(tracks, settings({ audio: ['ja'], subtitles: ['en'], subtitleMode: 'foreign' })).sid).toBe(2);
    expect(chooseTracks(tracks, settings({ audio: ['ja'], subtitles: ['es'], subtitleMode: 'always' })).sid).toBe(4);
  });

  it('follows the show memory first', () => {
    const r = chooseTracks(tracks, settings({ audio: ['en'] }), { audioLang: 'jpn', subLang: 'spa' });
    expect(r).toEqual({ aid: 1, sid: 4 });
    expect(chooseTracks(tracks, settings({ audio: ['en'] }), { subOff: true }).sid).toBe(1);
  });

  it('puts SDH last when asked', () => {
    const t: Track[] = [
      { id: 1, type: 'audio', lang: 'ja' },
      { id: 7, type: 'sub', lang: 'en', title: 'SDH' },
      { id: 8, type: 'sub', lang: 'en', title: 'Full' },
    ];
    expect(chooseTracks(t, settings({ audio: ['en'], subtitleMode: 'always', stripSdh: true })).sid).toBe(8);
  });
});
