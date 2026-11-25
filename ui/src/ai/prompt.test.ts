import { describe, expect, it } from 'vitest';
import { buildPrompt, MAX_ASK_LENGTH, parseSuggestions } from './prompt';
import { AiError } from './types';

const NOW = new Date('2026-11-25T12:00:00Z');

describe('parseSuggestions', () => {
  it('reads the agreed shape', () => {
    const text = JSON.stringify({ suggestions: [{ title: 'Heat', year: 1995, type: 'movie', reason: 'A patient, precise heist film.' }] });
    expect(parseSuggestions(text, NOW)).toEqual([{ title: 'Heat', year: 1995, type: 'movie', reason: 'A patient, precise heist film.' }]);
  });

  it('accepts a bare list, a code fence, and the words servers use for a type', () => {
    const fenced = '```json\n[{"title":"Severance","year":"2022","type":"TV Series","reason":"x"},{"title":"Ronin","year":1998,"type":"film","reason":"y"}]\n```';
    expect(parseSuggestions(fenced, NOW).map((s) => [s.title, s.year, s.type])).toEqual([
      ['Severance', 2022, 'series'],
      ['Ronin', 1998, 'movie'],
    ]);
  });

  it('drops what cannot be used, forgets impossible years and removes repeats', () => {
    const text = JSON.stringify({
      suggestions: [
        { title: '  ', year: 1999, type: 'movie', reason: '' },
        { title: 'A Podcast', year: 2020, type: 'podcast', reason: '' },
        { title: 'Inside Man', year: 2006, type: 'movie', reason: 'first' },
        { title: 'inside man', year: 2006, type: 'movie', reason: 'again' },
        { title: 'Not Out Yet', year: 2031, type: 'movie', reason: 'r' },
        { title: 'No Year', type: 'series', reason: 'r' },
        null,
        'Heat',
      ],
    });
    expect(parseSuggestions(text, NOW)).toEqual([
      { title: 'Inside Man', year: 2006, type: 'movie', reason: 'first' },
      { title: 'Not Out Yet', year: undefined, type: 'movie', reason: 'r' },
      { title: 'No Year', year: undefined, type: 'series', reason: 'r' },
    ]);
  });

  it('keeps a reason to one short line', () => {
    const long = `${'word '.repeat(80)}end`;
    const [s] = parseSuggestions(JSON.stringify({ suggestions: [{ title: 'T', year: 2000, type: 'movie', reason: `two\n lines  here ${long}` }] }), NOW);
    expect(s.reason.startsWith('two lines here word')).toBe(true);
    expect(s.reason.length).toBeLessThanOrEqual(201);
    expect(s.reason.endsWith('…')).toBe(true);
  });

  it('stops at two dozen', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ title: `Title ${i}`, year: 2000, type: 'movie', reason: '' }));
    expect(parseSuggestions(JSON.stringify({ suggestions: many }), NOW)).toHaveLength(24);
  });

  it('says so when the reply is not the agreed JSON', () => {
    for (const bad of ['Sure! Here are some films you might like.', '{"suggestions": "none"}', '{"titles": []}', '{"suggestions":[{"title":"Cut o', '']) {
      let error: unknown;
      try {
        parseSuggestions(bad, NOW);
      } catch (e) {
        error = e;
      }
      expect(error, bad).toBeInstanceOf(AiError);
      expect((error as AiError).kind).toBe('bad-response');
    }
  });

  it('an empty list is an answer, not an error', () => {
    expect(parseSuggestions('{"suggestions":[]}', NOW)).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('sends an ask as the user typed it, within a length', () => {
    const p = buildPrompt({ kind: 'ask', text: `  90s heist movies with a twist ${'x'.repeat(600)}` }, NOW);
    expect(p.user.startsWith('90s heist movies with a twist')).toBe(true);
    expect(p.user.length).toBe(MAX_ASK_LENGTH);
    expect(p.system).toContain('12 to 20 titles');
    expect(p.system).toContain('Today is 2026-11-25.');
    expect(p.system).not.toContain('child');
  });

  it('describes the history for For you, and says when the profile is a child’s', () => {
    const p = buildPrompt(
      {
        kind: 'for-you',
        watched: [
          { name: 'Severance', year: '2022', type: 'series', episodes: 19 },
          { name: 'Heat', year: '1995', type: 'movie' },
        ],
        watchlist: [{ name: 'Dark', type: 'series' }],
        kids: true,
      },
      NOW,
    );
    expect(p.user).toBe('Watched recently:\n- Severance (2022), series, 19 episodes watched\n- Heat (1995), movie\n\nOn the watchlist:\n- Dark, series');
    expect(p.system).toContain('Recommend nothing from either list');
    expect(p.system).toContain('belongs to a child');
  });
});
