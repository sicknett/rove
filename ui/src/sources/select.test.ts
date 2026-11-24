import { describe, expect, it } from 'vitest';
import type { SourcedStream } from '../addons/types';
import { autoPick, badges, isPlayable, orderStreams } from './select';

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

  it('follows the previous binge group before anything else', () => {
    const list = [s('a', 0, { behaviorHints: { bingeGroup: 'x' } }), s('a', 1, { behaviorHints: { bingeGroup: 'y' } })];
    expect(autoPick(list, { mode: 'first', bingeGroup: 'y' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'off', bingeGroup: 'y' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'off' })).toBeNull();
  });

  it('matches a regex rule or asks', () => {
    const list = [s('a', 0, { name: '1080p WEB' }), s('a', 1, { name: '2160p DV REMUX' })];
    expect(autoPick(list, { mode: 'regex', regex: '2160p.*remux' })?.rank).toBe(1);
    expect(autoPick(list, { mode: 'regex', regex: 'nothing' })).toBeNull();
    expect(autoPick(list, { mode: 'regex', regex: '(' })).toBeNull();
  });

  it('reads badges from formatted text', () => {
    const b = badges({ name: '[RD⚡] AIOStreams 4K', description: 'Dune.Part.Two.2024.2160p.DV.HDR10.HEVC.TrueHD.Atmos.REMUX\n💾 62.5 GB' });
    expect(b).toMatchObject({ resolution: '4K', hdr: 'DV', codec: 'HEVC', audio: 'Atmos', size: '62.5 GB', cached: true, service: 'Real-Debrid', remux: true });
  });
});
