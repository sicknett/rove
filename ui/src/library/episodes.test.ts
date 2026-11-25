import { describe, expect, it } from 'vitest';
import type { Video } from '../addons/types';
import { deriveContinue, nextEpisode, seriesPosition, upNext } from './continue';
import { buildGuide, runningOrder, type EpisodeGuide } from './episodes';
import { YELLOWSTONE } from './episodes.fixture';
import type { WatchedEntry } from '../state/history';

const ID = 'tt4236770';
const NOW = Date.parse('2026-11-25T12:00:00Z');

/** A video the way Cinemeta sends one. */
const video = (season: number, episode: number, released: string, name: string, more: Partial<Video> = {}): Video => ({
  id: `${ID}:${season}:${episode}`,
  season,
  episode,
  number: episode,
  name,
  released: released ? `${released}T04:00:00.000Z` : undefined,
  thumbnail: `https://episodes.metahub.space/${ID}/${season}/${episode}/w780.jpg`,
  ...more,
});

const cinemeta = (): Video[] => YELLOWSTONE.map(([s, e, released, name]) => video(s, e, released, name));
/** The 22 "Season 3" extras (specials 49 to 70). */
const season3Extras = () => YELLOWSTONE.filter(([s, e]) => s === 0 && e >= 49 && e <= 70);
const real = (): Video[] => YELLOWSTONE.filter(([s]) => s > 0).map(([s, e, released, name]) => video(s, e, released, name, { runtime: 45 }));

const numbers = (list: { episode: number }[]) => list.map((e) => e.episode);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const season = (g: EpisodeGuide, n: number) => g.seasons.find((x) => x.season === n)!;

/** Every video is in the guide exactly once, and no two rows share a key. */
function expectWhole(g: EpisodeGuide, count: number) {
  expect(g.all).toHaveLength(count);
  expect(new Set(g.all).size).toBe(count);
  expect(new Set(g.all.map((e) => e.key)).size).toBe(count);
  expect(g.seasons.reduce((n, s) => n + s.episodes.length + s.extras.length, 0)).toBe(count);
}

const mark = (s: number, e: number, at: number): WatchedEntry => ({ key: `${ID}:${s}:${e}`, metaId: ID, type: 'series', season: s, episode: e, at });

describe('Cinemeta: specials in season 0', () => {
  const g = buildGuide(cinemeta());

  it('has the numbered seasons in order and Specials last', () => {
    expect(g.seasons.map((s) => s.season)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('lists each season 1…n with no extras', () => {
    expect(numbers(season(g, 1).episodes)).toEqual(range(1, 9));
    expect(numbers(season(g, 2).episodes)).toEqual(range(1, 10));
    expect(numbers(season(g, 5).episodes)).toEqual(range(1, 14));
    for (const s of g.seasons) expect(s.extras).toEqual([]);
    expect(season(g, 1).episodes[0]).toMatchObject({ id: `${ID}:1:1`, title: 'Daybreak' });
  });

  it('keeps the second half of a split season (aired two years later) as episodes', () => {
    // Season 5: 1 to 8 in 2022 and 2023, 9 to 14 in late 2024.
    expect(season(g, 5).episodes.at(-1)).toMatchObject({ episode: 14, title: 'Life Is A Promise' });
  });

  it('has all 71 specials under Specials, the Season 3 extras among them', () => {
    expect(numbers(season(g, 0).episodes)).toEqual(range(1, 71));
    expect(season(g, 0).episodes[48]).toMatchObject({ episode: 49, title: 'Season 3 Behind the Story - Episode 01' });
    expectWhole(g, 124);
  });

  it('runs 1x01 … 5x14, and after 1x09 comes 2x01', () => {
    expect(g.main).toHaveLength(53);
    expect(g.main[0]).toMatchObject({ season: 1, episode: 1 });
    expect(g.main.at(-1)).toMatchObject({ season: 5, episode: 14 });
    expect(nextEpisode(g.all, { season: 1, episode: 9 }, new Set(), NOW)).toMatchObject({ season: 2, episode: 1 });
  });
});

describe('an addon that lists videos twice', () => {
  // The shape that put 22 extras above "1. Daybreak": the Season 3 extras sent a second time
  // under the same ids. Rows keyed by video id then collide, and stay behind on the next tab.
  const again = season3Extras().map(([s, e, released, name]) => video(s, e, released, name, { thumbnail: undefined, runtime: 9 }));
  const g = buildGuide([...again, ...cinemeta()]);

  it('lists each of them once', () => {
    expect(numbers(season(g, 0).episodes)).toEqual(range(1, 71));
    expectWhole(g, 124);
  });

  it('keeps what either listing knew', () => {
    expect(season(g, 0).episodes[48]).toMatchObject({ runtime: 9, thumbnail: `https://episodes.metahub.space/${ID}/0/49/w780.jpg` });
  });

  it('leaves season 1 as 1…9', () => {
    expect(numbers(season(g, 1).episodes)).toEqual(range(1, 9));
    expect(season(g, 1).extras).toEqual([]);
  });

  it('treats the same number under the same name as one episode, whatever its ids', () => {
    const twice = buildGuide([video(1, 1, '2020-01-01', 'Pilot'), { ...video(1, 1, '2020-01-01', 'Pilot'), id: 'tvdb:99:1:1', thumbnail: undefined }, { id: '', season: 1, episode: 2, name: 'Two' }, { id: '', season: 1, episode: 2 }]);
    expect(twice.all.map((e) => [e.id, e.episode])).toEqual([[`${ID}:1:1`, 1], ['', 2]]);
    expectWhole(twice, 2);
  });

  it('keeps two different videos that claim one number, the second beside the episodes', () => {
    const clash = buildGuide([video(1, 1, '2020-01-01', 'Pilot'), { ...video(1, 1, '2020-01-01', 'Pilot: the making of'), id: `${ID}:1:1b` }, video(1, 2, '2020-01-08', 'Two')]);
    expect(season(clash, 1).episodes.map((e) => e.title)).toEqual(['Pilot', 'Two']);
    expect(season(clash, 1).extras.map((e) => e.title)).toEqual(['Pilot: the making of']);
    expectWhole(clash, 3);
    expect(nextEpisode(clash.all, { season: 1, episode: 1 }, new Set(), NOW)).toMatchObject({ title: 'Two' });
  });

  it('places a video listed under two numbers where its id says', () => {
    const moved = buildGuide([{ id: `${ID}:0:49`, season: 1, episode: 49, name: 'Extra' }, { id: `${ID}:0:49`, season: 0, episode: 49, name: 'Extra' }, video(1, 1, '2020-01-01', 'Pilot')]);
    expect(numbers(season(moved, 1).episodes)).toEqual([1]);
    expect(numbers(season(moved, 0).episodes)).toEqual([49]);
    expectWhole(moved, 2);
  });
});

describe('extras the data files in a season', () => {
  // Yellowstone with the 22 Season 3 extras sent as season 1, episodes 49 to 70: a few minutes
  // long, dated 2020, without stills.
  const attached = (more: (e: number) => Partial<Video> = () => ({ thumbnail: undefined, runtime: 9 })) => [
    ...season3Extras().map(([, e, released, name]) => video(1, e, released, name, more(e))),
    ...real(),
  ];
  const g = buildGuide(attached());

  it('shows season 1 as 1…9, with the extras after them in their own group', () => {
    expect(numbers(season(g, 1).episodes)).toEqual(range(1, 9));
    expect(numbers(season(g, 1).extras)).toEqual(range(49, 70));
    expect(season(g, 1).extras.every((e) => e.extra)).toBe(true);
    expect(g.seasons.map((s) => s.season)).toEqual([1, 2, 3, 4, 5]);
    expectWhole(g, 53 + 22);
  });

  it('keeps them out of the running order: after 1x09 comes 2x01, never extra 49', () => {
    expect(g.main).toHaveLength(53);
    expect(g.main.some((e) => e.extra)).toBe(false);
    expect(nextEpisode(g.all, { season: 1, episode: 9 }, new Set(), NOW)).toMatchObject({ season: 2, episode: 1 });
    const pos = seriesPosition([mark(1, 9, NOW - 1000)])!;
    expect(upNext(g.all, pos, NOW)).toMatchObject({ season: 2, episode: 1 });
    const cw = deriveContinue({ progress: {}, watched: { [`${ID}:1:9`]: mark(1, 9, NOW - 1000) }, dismissed: {}, episodes: new Map([[ID, g.all]]), now: NOW });
    expect(cw.items[0]).toMatchObject({ kind: 'next', season: 2, episode: 1 });
    expect(runningOrder(g.all)).toEqual(g.main);
  });

  it('tells them by any one sign: the dates alone', () => {
    const byDate = buildGuide(attached((e) => ({ thumbnail: `https://x/${e}.jpg` })));
    expect(numbers(season(byDate, 1).extras)).toEqual(range(49, 70));
  });

  it('…their length alone', () => {
    const byLength = buildGuide(attached(() => ({ released: undefined, runtime: '9 min' })));
    expect(numbers(season(byLength, 1).extras)).toEqual(range(49, 70));
  });

  it('…missing stills alone', () => {
    const byStills = buildGuide(attached(() => ({ released: undefined, thumbnail: undefined })));
    expect(numbers(season(byStills, 1).extras)).toEqual(range(49, 70));
  });

  it('…or their names alone', () => {
    const byName = buildGuide(attached(() => ({ released: undefined })));
    expect(numbers(season(byName, 1).extras)).toEqual(range(49, 70));
  });

  it('leaves a far-off block that shows no sign of being extras as episodes', () => {
    const plain = buildGuide([...range(1, 9), ...range(49, 70)].map((e) => video(1, e, '', `Chapter ${e}`)));
    expect(numbers(season(plain, 1).episodes)).toEqual([...range(1, 9), ...range(49, 70)]);
    expect(season(plain, 1).extras).toEqual([]);
  });

  it('leaves episodes still to come as episodes, even numbered far ahead and without stills', () => {
    const coded = buildGuide([
      ...range(1, 8).map((e) => video(1, 100 + e, `2026-10-0${e}`, `Night ${e}`, { runtime: 40 })),
      ...range(1, 8).map((e) => video(1, 200 + e, `2026-12-0${e}`, `Night ${e + 8}`, { runtime: 40, thumbnail: undefined })),
    ]);
    expect(season(coded, 1).episodes).toHaveLength(16);
    expect(season(coded, 1).extras).toEqual([]);
  });

  it('takes a short, late clip numbered straight on from the finale as an extra', () => {
    const tail = buildGuide([
      ...range(1, 9).map((e) => video(1, e, `2018-06-${10 + e}`, `One ${e}`, { runtime: 45 })),
      video(1, 10, '2019-08-01', 'Season 1 Recap', { runtime: 5 }),
      ...range(1, 3).map((e) => video(2, e, `2019-06-${10 + e}`, `Two ${e}`, { runtime: 45 })),
    ]);
    expect(numbers(season(tail, 1).episodes)).toEqual(range(1, 9));
    expect(numbers(season(tail, 1).extras)).toEqual([10]);
  });

  it('keeps a full-length episode released late as an episode', () => {
    const late = buildGuide([
      ...range(1, 9).map((e) => video(1, e, `2018-06-${10 + e}`, `One ${e}`, { runtime: 45 })),
      video(1, 10, '2019-08-01', 'The Lost Episode', { runtime: 44 }),
      ...range(1, 3).map((e) => video(2, e, `2019-06-${10 + e}`, `Two ${e}`, { runtime: 45 })),
    ]);
    expect(numbers(season(late, 1).episodes)).toEqual(range(1, 10));
  });
});

describe('absolute numbering', () => {
  it('keeps seasons whose numbers carry on from the season before', () => {
    const g = buildGuide([...range(1, 12).map((e) => video(1, e, '2020-01-01', `E${e}`)), ...range(13, 24).map((e) => video(2, e, '2021-01-01', `E${e}`))]);
    expect(numbers(season(g, 1).episodes)).toEqual(range(1, 12));
    expect(numbers(season(g, 2).episodes)).toEqual(range(13, 24));
    expect(g.seasons.every((s) => s.extras.length === 0)).toBe(true);
    expect(nextEpisode(g.all, { season: 1, episode: 12 }, new Set(), NOW)).toMatchObject({ season: 2, episode: 13 });
  });

  it('keeps one long season whole, in order whatever order it arrives in', () => {
    const g = buildGuide(range(1, 220).reverse().map((e) => ({ id: `kitsu:7:${e}`, season: 1, episode: e, title: `Episode ${e}` })));
    expect(numbers(season(g, 1).episodes)).toEqual(range(1, 220));
    expectWhole(g, 220);
  });

  it('goes by `episode` where `number` counts differently', () => {
    const g = buildGuide([{ id: 'tt1:2:1', season: 2, episode: 1, number: 13, name: 'A' }, { id: 'tt1:2:2', season: 2, episode: 2, number: 14, name: 'B' }]);
    expect(numbers(season(g, 2).episodes)).toEqual([1, 2]);
  });
});

describe('missing and odd fields', () => {
  it('reads season and episode from the id when the fields are missing', () => {
    const g = buildGuide([{ id: 'tt1:2:3', name: 'From the id' }, { id: 'tt1:0:4', name: 'A special' }]);
    expect(g.all.map((e) => [e.season, e.episode])).toEqual([[2, 3], [0, 4]]);
  });

  it('takes `number` when there is no `episode`, and numbers sent as text', () => {
    const g = buildGuide([{ id: 'a', season: 1, number: 2, name: 'Two' }, { id: 'b', season: '1', episode: '1', name: 'One' } as unknown as Video]);
    expect(season(g, 1).episodes.map((e) => [e.episode, e.title])).toEqual([[1, 'One'], [2, 'Two']]);
  });

  it('puts a video with an episode number and no season in season 1', () => {
    const g = buildGuide([{ id: 'kitsu:1:5', title: 'Five' }, { id: 'x', episode: 6, title: 'Six' }]);
    expect(season(g, 1).episodes.map((e) => e.episode)).toEqual([5, 6]);
  });

  it('keeps a video with no number at all, with the Specials, after the numbered ones', () => {
    const g = buildGuide([video(1, 1, '2020-01-01', 'Pilot'), video(0, 3, '2019-12-01', 'Preview'), { id: 'yt:b', title: 'Later clip', released: '2021-02-01' }, { id: 'yt:a', title: 'Earlier clip', released: '2021-01-01' }]);
    expect(season(g, 0).episodes.map((e) => [e.episode, e.title])).toEqual([[3, 'Preview'], [4, 'Earlier clip'], [5, 'Later clip']]);
    expect(g.main.map((e) => e.title)).toEqual(['Pilot']);
    expectWhole(g, 4);
  });

  it('survives nothing, nonsense and repeated empty ids', () => {
    expect(buildGuide(undefined)).toEqual({ seasons: [], main: [], all: [] });
    expect(buildGuide([])).toEqual({ seasons: [], main: [], all: [] });
    const g = buildGuide([null, { id: '', season: 1, episode: 1, name: 'A' }, { id: '', season: 1, episode: 2, name: 'B' }, { season: -1, episode: Number.NaN, id: 'tt1:1:3' }] as unknown as Video[]);
    expect(numbers(season(g, 1).episodes)).toEqual([1, 2, 3]);
    expectWhole(g, 3);
  });

  it('carries what a row shows: name, date, still, minutes, overview', () => {
    const g = buildGuide([{ id: 'tt1:1:1', season: 1, episode: 1, title: 'Named by title', released: '2020-01-01', thumbnail: 'https://x/1.jpg', runtime: '48 min', description: 'What happens.' }]);
    expect(g.all[0]).toEqual({ id: 'tt1:1:1', season: 1, episode: 1, title: 'Named by title', released: '2020-01-01', thumbnail: 'https://x/1.jpg', runtime: 48, overview: 'What happens.', key: '1:1' });
  });
});
