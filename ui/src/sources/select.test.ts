import { describe, expect, it } from 'vitest';
import type { SourcedStream } from '../addons/types';
import { autoPick, badges, decide, isPlayable, orderStreams } from './select';

const s = (addonId: string, rank: number, extra: Partial<SourcedStream> = {}): SourcedStream => ({
  addonId,
  addonName: addonId,
  rank,
  url: `https://cdn.example/${addonId}/${rank}.mkv`,
  ...extra,
});

describe('stream selection', () => {
  it('keeps the user addon order, then each addon order', () => {
    const out = orderStreams([s('b', 0), s('a', 1), s('a', 0)], ['a', 'b']);
    expect(out.map((x) => `${x.addonId}${x.rank}`)).toEqual(['a0', 'a1', 'b0']);
  });

  it('skips rows without a link', () => {
    expect(isPlayable({ name: 'Statistics' })).toBe(false);
    const picked = autoPick([s('a', 0, { url: undefined, name: 'Error' }), s('a', 1)], { mode: 'first' });
    expect(picked?.rank).toBe(1);
  });

  it('follows the previous binge group, except for "first source" and "always ask"', () => {
    const list = [s('a', 0, { behaviorHints: { bingeGroup: 'x' } }), s('a', 1, { behaviorHints: { bingeGroup: 'y' } })];
    expect(autoPick(list, { mode: 'binge', bingeGroup: 'y' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'binge', bingeGroup: 'y', preferBingeGroup: false })?.rank).toBe(0);
    expect(autoPick(list, { mode: 'binge', bingeGroup: 'gone' })?.rank).toBe(0);
    expect(autoPick(list, { mode: 'regex', regex: 'nothing', bingeGroup: 'y' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'first', bingeGroup: 'y' })?.rank).toBe(0);
    expect(autoPick(list, { mode: 'off', bingeGroup: 'y' })).toBeNull();
    expect(autoPick(list, { mode: 'off' })).toBeNull();
  });

  it('matches a regex rule or asks', () => {
    const list = [s('a', 0, { name: '1080p WEB' }), s('a', 1, { name: '2160p DV REMUX' })];
    expect(autoPick(list, { mode: 'regex', regex: '2160p.*remux' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'regex', regex: 'nothing' })).toBeNull();
    expect(autoPick(list, { mode: 'regex', regex: '(' })).toBeNull();
  });

  describe('deciding while addons still answer', () => {
    const base = { mode: 'binge' as const, addonOrder: ['a', 'b', 'c'], graceOver: false };

    it('starts at once when the first addon in the user order has answered', () => {
      const d = decide({ ...base, ordered: [s('a', 0)], waiting: ['b', 'c'] });
      expect(d).toMatchObject({ action: 'play', stream: { addonId: 'a', rank: 0 } });
    });

    it('waits for an addon ahead of the pick, but only until the grace period ends', () => {
      const ordered = [s('b', 0)];
      expect(decide({ ...base, ordered, waiting: ['a', 'c'] }).action).toBe('wait');
      expect(decide({ ...base, ordered, waiting: ['c'] }).action).toBe('play');
      expect(decide({ ...base, ordered, waiting: ['a', 'c'], graceOver: true })).toMatchObject({ action: 'play', stream: { addonId: 'b' } });
    });

    it('gives the previous release a moment to turn up, and takes it the moment it does', () => {
      const other = s('a', 0, { behaviorHints: { bingeGroup: 'x' } });
      const same = s('b', 0, { behaviorHints: { bingeGroup: 'y' } });
      expect(decide({ ...base, bingeGroup: 'y', ordered: [other], waiting: ['b'] }).action).toBe('wait');
      expect(decide({ ...base, bingeGroup: 'y', ordered: [other, same], waiting: ['c'] })).toMatchObject({ action: 'play', stream: { addonId: 'b' } });
      expect(decide({ ...base, bingeGroup: 'y', ordered: [other], waiting: ['b'], graceOver: true })).toMatchObject({ action: 'play', stream: { addonId: 'a' } });
      // "First source" does not look for it at all.
      expect(decide({ ...base, mode: 'first', bingeGroup: 'y', ordered: [other], waiting: ['b'] }).action).toBe('play');
    });

    it('keeps waiting while nothing can play, and always settles once every addon has answered', () => {
      const dead = s('a', 0, { url: undefined });
      expect(decide({ ...base, ordered: [], waiting: ['a'], graceOver: true }).action).toBe('wait');
      expect(decide({ ...base, ordered: [dead], waiting: ['b'], graceOver: true }).action).toBe('wait');
      expect(decide({ ...base, ordered: [dead], waiting: [] }).action).toBe('ask');
      expect(decide({ ...base, ordered: [dead, s('b', 0)], waiting: [] })).toMatchObject({ action: 'play', stream: { addonId: 'b' } });
    });

    it('opens the list after the grace period when a rule matches nothing so far', () => {
      const ordered = [s('a', 0, { name: '720p' })];
      const rule = { ...base, mode: 'regex' as const, regex: '2160p' };
      expect(decide({ ...rule, ordered, waiting: ['b'] }).action).toBe('wait');
      expect(decide({ ...rule, ordered, waiting: ['b'], graceOver: true }).action).toBe('ask');
      expect(decide({ ...rule, ordered: [...ordered, s('b', 0, { name: '2160p' })], waiting: ['c'] })).toMatchObject({ action: 'play', stream: { addonId: 'b' } });
    });
  });

  it('reads badges from formatted text', () => {
    const b = badges({ name: '[RD⚡] AIOStreams 4K', description: 'Dune.Part.Two.2024.2160p.DV.HDR10.HEVC.TrueHD.Atmos.REMUX\n💾 62.5 GB' });
    expect(b).toMatchObject({ resolution: '4K', hdr: 'DV', codec: 'HEVC', audio: 'Atmos', size: '62.5 GB', cached: true, service: 'Real-Debrid', remux: true });
  });
});
