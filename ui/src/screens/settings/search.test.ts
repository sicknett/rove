import { describe, expect, it } from 'vitest';
import { fold, oneSlipApart, searchSettings } from './search';

const ids = (query: string) => searchSettings(query).map((r) => r.id);

describe('settings search', () => {
  it('finds nothing for an empty query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('folds case, accents and punctuation', () => {
    expect(fold('Auto-play “Next”')).toBe('auto play next');
    expect(fold('Café’s')).toBe('cafes');
  });

  it('finds subtitles by the words people use for them', () => {
    for (const q of ['captions', 'subtitles', 'subs', 'cc', 'caption']) {
      const found = ids(q);
      expect(found, q).toContain('languages.subtitleMode');
      expect(found, q).toContain('languages.subtitles');
    }
    // The whole section is offered too.
    expect(ids('captions')).toContain('section:languages');
  });

  it('finds both language lists for "language"', () => {
    const found = ids('language');
    expect(found.slice(0, 3)).toEqual(expect.arrayContaining(['languages.audio', 'languages.subtitles']));
  });

  it('finds every kind of trailer for "trailer"', () => {
    const found = ids('trailer');
    expect(found).toEqual(expect.arrayContaining(['appearance.heroTrailers', 'appearance.heroTrailerStart', 'appearance.hoverPreview']));
    // The plural is the same search.
    expect(ids('trailers')).toEqual(expect.arrayContaining(['appearance.heroTrailers', 'appearance.hoverPreview']));
  });

  it('finds auto-play however it is written', () => {
    for (const q of ['autoplay', 'auto-play', 'auto play']) {
      const found = ids(q);
      expect(found, q).toContain('playback.autoPlayNext');
      expect(found, q).toContain('sources.autoPlay');
    }
  });

  it('puts the intro setting first for "skip intro", and leaves recaps out', () => {
    const found = ids('skip intro');
    expect(found[0]).toBe('playback.skipIntro');
    expect(found).not.toContain('playback.skipRecap');
  });

  it('finds backing up, restoring and updating', () => {
    expect(ids('backup')[0]).toBe('data.backup');
    expect(ids('back up')).toContain('data.backup');
    expect(ids('restore')).toContain('data.restore');
    expect(ids('update')[0]).toBe('about.update');
    expect(ids('version')).toContain('about.update');
  });

  it('finds expert settings by their technical names', () => {
    expect(ids('regex')[0]).toBe('sources.regex');
    expect(ids('vlc')[0]).toBe('sources.externalPlayer');
    expect(ids('passthrough')[0]).toBe('audio.passthrough');
    expect(ids('dolby')).toContain('audio.passthrough');
    expect(ids('gpu')[0]).toBe('playback.hwdec');
    expect(ids('hardware decoding')[0]).toBe('playback.hwdec');
  });

  it('finds everyday problems by how they are described', () => {
    expect(ids('bluetooth')[0]).toBe('audio.delayMs');
    expect(ids('lip sync')).toContain('audio.delayMs');
    expect(ids('still watching')[0]).toBe('playback.stillWatchingAfter');
    expect(ids('colour')).toEqual(expect.arrayContaining(['appearance.accent', 'subtitleStyle.color', 'subtitleStyle.outlineColor']));
    expect(ids('color')).toEqual(ids('colour'));
    expect(ids('font')[0]).toBe('subtitleStyle.font');
    expect(ids('trakt')).toContain('accounts.tracker');
    expect(ids('plex')).toEqual(expect.arrayContaining(['servers.add', 'servers.list']));
    expect(ids('pin')).toContain('profiles.list');
    expect(ids('sidebar')[0]).toBe('appearance.navPosition');
  });

  it('keeps the name of a section from dragging in every control on its page', () => {
    // "language" is in the section's name; the size of subtitles is not about languages.
    expect(ids('language')).toContain('section:languages');
    expect(ids('language')).not.toContain('subtitleStyle.size');
    expect(ids('dolby')[0]).toBe('audio.passthrough');
    // Words for a group still find what is under it.
    expect(ids('banner')).toEqual(expect.arrayContaining(['appearance.heroEnabled', 'appearance.heroSource', 'appearance.heroTrailers']));
  });

  it('needs every word to fit', () => {
    expect(ids('subtitle volume')).toEqual([]);
    expect(ids('poster size')[0]).toBe('appearance.cardSize');
  });

  it('accepts a word cut short', () => {
    expect(ids('subt')).toContain('languages.subtitleMode');
    expect(ids('passthr')[0]).toBe('audio.passthrough');
  });

  it('forgives one slip in a longer word, and nothing more', () => {
    expect(ids('subtitels')).toContain('languages.subtitleMode');
    expect(ids('bluetoth')).toContain('audio.delayMs');
    expect(ids('zzzzzz')).toEqual([]);
    expect(oneSlipApart('trailer', 'trialer')).toBe(true);
    expect(oneSlipApart('trailer', 'trailr')).toBe(true);
    expect(oneSlipApart('trailer', 'trailers')).toBe(true);
    expect(oneSlipApart('trailer', 'trialers')).toBe(false);
    expect(oneSlipApart('volume', 'banner')).toBe(false);
  });

  it('ranks a label match above a mention in a hint', () => {
    // "Reduce motion" mentions trailers in its hint; the trailer switches come first.
    const found = ids('trailers');
    expect(found.indexOf('appearance.heroTrailers')).toBeLessThan(found.indexOf('appearance.reduceMotion'));
  });

  it('says where each result is, and marks the advanced ones', () => {
    const rule = searchSettings('regex')[0];
    expect(rule).toMatchObject({ section: 'playback', sectionLabel: 'Playback', group: 'Sources', advanced: true });
    const section = searchSettings('appearance')[0];
    expect(section).toMatchObject({ id: 'section:appearance', section: 'appearance' });
    expect(section.entry).toBeUndefined();
  });
});
