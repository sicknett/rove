import { describe, expect, it } from 'vitest';
import { assignRows, BECAUSE_POOL, blendTopPicks, dayNumber, interleave, MIN_ROW, pickBecause, rankByBlend, rankByRating, ROW_LIMIT, steadyRating, uniqueCandidates, type Candidate, type RowFeed } from './rank';

const c = (id: number, extra: Partial<Candidate> = {}): Candidate => ({ id, kind: 'movie', name: `Title ${id}`, poster: '/p.jpg', rating: 7, votes: 1000, popularity: 10, genres: [], ...extra });
const range = (from: number, count: number, extra: Partial<Candidate> = {}) => Array.from({ length: count }, (_, i) => c(from + i, extra));
const ids = (items: Candidate[]) => items.map((x) => x.id);

describe('steadyRating', () => {
  it('does not trust a rating a handful of votes made', () => {
    expect(steadyRating({ rating: 8.9, votes: 12 })).toBeLessThan(steadyRating({ rating: 7.8, votes: 4000 }));
    expect(steadyRating({ rating: 9, votes: 0 })).toBe(6.5);
    expect(steadyRating({ rating: 8, votes: 100000 })).toBeCloseTo(8, 1);
  });
});

describe('blendTopPicks', () => {
  it('puts a title several seeds point at above any that one seed suggests', () => {
    const shared = c(99, { rating: 6.2 });
    const picks = blendTopPicks([
      { weight: 1, items: [c(1, { rating: 9, votes: 50000 }), c(2), shared] },
      { weight: 0.6, items: [c(3), shared, c(4)] },
      { weight: 0.5, items: [c(5), c(6), shared] },
    ]);
    // Third on the strongest seed's list and plainly rated, but three seeds agree on it.
    expect(picks[0].id).toBe(99);
    expect(picks[1].id).toBe(1);
    expect(new Set(ids(picks)).size).toBe(picks.length);
    expect(picks).toHaveLength(7);
  });

  it('leads with the stronger seeds, and each seed with its first suggestions', () => {
    const picks = blendTopPicks([
      { weight: 0.4, items: [c(10), c(11)] },
      { weight: 1, items: [c(20), c(21)] },
    ]);
    expect(ids(picks)).toEqual([20, 21, 10, 11]);
  });

  it('lets rating and vote count decide between titles within reach of each other', () => {
    const picks = blendTopPicks([
      { weight: 1, items: [c(1, { rating: 5.5, votes: 3000 }), c(2, { rating: 8.6, votes: 9000 })] },
      { weight: 1, items: [c(3, { rating: 8.6, votes: 40 })] },
      { weight: 1, items: [c(4, { rating: 8.6, votes: 9000 })] },
    ]);
    // Second on its list, but far better rated than the first.
    expect(ids(picks).indexOf(2)).toBeLessThan(ids(picks).indexOf(1));
    // Both first on their lists with an 8.6: the one 9,000 people rated leads the one 40 did.
    expect(ids(picks).indexOf(4)).toBeLessThan(ids(picks).indexOf(3));
  });

  it('does not let one seed fill the row', () => {
    const picks = blendTopPicks([
      { weight: 1, items: range(100, 20) },
      { weight: 0.3, items: range(200, 20) },
      { weight: 0.2, items: range(300, 20) },
    ]);
    const firstRow = ids(picks.slice(0, ROW_LIMIT));
    const from = (base: number) => firstRow.filter((id) => id >= base && id < base + 100).length;
    // Three seeds: seven titles each at most, so the weakest seeds are in the row too.
    expect(from(100)).toBe(7);
    expect(from(200)).toBe(7);
    expect(from(300)).toBe(6);
    // Nothing is lost: what did not fit comes after.
    expect(picks).toHaveLength(60);
    expect(new Set(ids(picks)).size).toBe(60);
  });

  it('returns nothing without a seed that counts', () => {
    expect(blendTopPicks([])).toEqual([]);
    expect(blendTopPicks([{ weight: 0, items: range(1, 5) }])).toEqual([]);
  });
});

describe('ordering a discover page', () => {
  it('ranks by rating and popularity together', () => {
    const noise = c(1, { rating: 5.2, popularity: 900 });
    const classic = c(2, { rating: 8.7, votes: 20000, popularity: 4 });
    const both = c(3, { rating: 8.2, votes: 9000, popularity: 300 });
    expect(ids(rankByBlend([noise, classic, both]))).toEqual([3, 2, 1]);
    // By popularity alone the order would be the other way round.
    expect(ids(rankByBlend([noise, classic, both], 0))).toEqual([1, 3, 2]);
  });

  it('ranks hidden gems by a rating that needs some votes behind it', () => {
    expect(ids(rankByRating([c(1, { rating: 9.5, votes: 3 }), c(2, { rating: 8.2, votes: 600 }), c(3, { rating: 7.4, votes: 900 })]))).toEqual([2, 3, 1]);
  });

  it('takes lists in turns and drops repeats', () => {
    expect(ids(interleave([c(1), c(2), c(3)], [c(10), c(2)], []))).toEqual([1, 10, 2, 3]);
    // Movie 5 and show 5 are different titles.
    expect(uniqueCandidates([c(5), c(5, { kind: 'tv' }), c(5)])).toHaveLength(2);
  });
});

describe('assignRows', () => {
  const feed = (key: string, items: RowFeed['items'], extra: Partial<RowFeed> = {}): RowFeed => ({ key, items, limit: ROW_LIMIT, min: MIN_ROW, ...extra });
  const shown = (r: ReturnType<typeof assignRows>, key: string) => {
    const row = r.get(key)!;
    return row.status === 'ready' ? ids(row.items) : row.status;
  };

  it('gives a title to the first row that has it, and the rows below their next best', () => {
    const r = assignRows([feed('a', range(1, 30)), feed('b', range(11, 40)), feed('c', [...range(1, 5), ...range(45, 20)])]);
    expect(shown(r, 'a')).toEqual(ids(range(1, 20)));
    // 11–20 went to the row above: this one starts at 21.
    expect(shown(r, 'b')).toEqual(ids(range(21, 20)));
    // 1–5 are in the first row. 45–50 were on the second row's list too, past the twenty it shows: they are free.
    expect(shown(r, 'c')).toEqual(ids(range(45, 20)));
    const all = ['a', 'b', 'c'].flatMap((k) => shown(r, k) as number[]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('shows no row with fewer than eight titles, and such a row keeps nothing from the rows below', () => {
    const r = assignRows([feed('a', range(1, 20)), feed('thin', [...range(1, 20), ...range(30, 7)]), feed('c', range(30, 9)), feed('short', range(100, 7)), feed('eight', range(200, 8))]);
    // Seven left after the row above took its twenty.
    expect(shown(r, 'thin')).toBe('none');
    // So 30–36 are still free for the next row.
    expect(shown(r, 'c')).toEqual(ids(range(30, 9)));
    expect(shown(r, 'short')).toBe('none');
    expect(shown(r, 'eight')).toEqual(ids(range(200, 8)));
  });

  it('lets a chart keep its ranking, and keeps what it shows out of the other rows', () => {
    const r = assignRows([feed('trending', range(1, 40)), feed('chart', range(1, 20), { chart: true, limit: 10, min: 10 }), feed('below', range(5, 40))]);
    // The chart is under Trending on Home, and still shows places 1–10.
    expect(shown(r, 'chart')).toEqual(ids(range(1, 10)));
    expect(shown(r, 'trending')).toEqual(ids(range(11, 20)));
    expect(shown(r, 'below')).toEqual(ids(range(31, 14)));
  });

  it('shows no Top 10 with fewer than ten titles, and then it takes nothing', () => {
    const r = assignRows([feed('chart', range(1, 9), { chart: true, limit: 10, min: 10 }), feed('row', range(1, 12))]);
    expect(shown(r, 'chart')).toBe('none');
    expect(shown(r, 'row')).toEqual(ids(range(1, 12)));
  });

  it('holds a row back until the charts and the rows above it have loaded', () => {
    const waitingAbove = assignRows([feed('a', 'pending'), feed('b', range(1, 20)), feed('chart', range(50, 10), { chart: true, limit: 10, min: 10 })]);
    expect(shown(waitingAbove, 'b')).toBe('pending');
    // A chart waits for nobody.
    expect(shown(waitingAbove, 'chart')).toEqual(ids(range(50, 10)));
    const waitingForChart = assignRows([feed('a', range(1, 20)), feed('chart', 'pending', { chart: true, limit: 10, min: 10 })]);
    expect(shown(waitingForChart, 'a')).toBe('pending');
  });

  it('is not held up by a row that failed or does not apply', () => {
    const r = assignRows([feed('gone', 'none'), feed('failed', 'error'), feed('b', range(1, 20)), feed('chart', 'error', { chart: true })]);
    expect(shown(r, 'gone')).toBe('none');
    expect(shown(r, 'failed')).toBe('error');
    expect(shown(r, 'chart')).toBe('error');
    expect(shown(r, 'b')).toEqual(ids(range(1, 20)));
  });
});

describe('pickBecause', () => {
  const DAY = 24 * 3600 * 1000;
  const seed = (id: number, kind: 'movie' | 'tv', daysAgo: number, extra: Partial<{ depth: number; watched: boolean }> = {}) => ({ id, kind, name: `Seed ${id}`, depth: 1, watched: true, at: 1_000 * DAY - daysAgo * DAY, ...extra });
  const seeds = [seed(1, 'movie', 0), seed(2, 'movie', 1), seed(3, 'tv', 2), seed(4, 'movie', 3), seed(5, 'tv', 4), seed(6, 'movie', 5), seed(7, 'tv', 6)];
  const picked = (day: number, from = seeds) => pickBecause(from, day).map((p) => p.id);

  it('gives the newest strong title the first row, with a show next to a film', () => {
    for (let day = 0; day < 12; day++) {
      const picks = pickBecause(seeds, day);
      expect(picks).toHaveLength(3);
      expect(picks[0].id).toBe(1);
      expect(picks[1].kind).toBe('tv');
      expect(new Set(picks.map((p) => `${p.kind}:${p.id}`)).size).toBe(3);
    }
  });

  it('gives the same answer all day and another one the next', () => {
    expect(picked(20782)).toEqual(picked(20782));
    expect(picked(20783)).not.toEqual(picked(20782));
    // Over a week every recent title has had a row, and none older than the pool has.
    const week = new Set(Array.from({ length: 7 }, (_, i) => picked(20782 + i)).flat());
    expect([...week].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(BECAUSE_POOL).toBe(6);
  });

  it('never names a title that was only tried, or only put on the watchlist', () => {
    const mixed = [seed(1, 'movie', 0, { depth: 0.3 }), seed(2, 'tv', 1, { watched: false }), seed(3, 'movie', 2), seed(4, 'tv', 3)];
    expect(picked(5, mixed).sort()).toEqual([3, 4]);
    expect(picked(5, [])).toEqual([]);
  });

  it('keeps what the day started with, and only fills the empty places', () => {
    const morning = pickBecause([seed(3, 'tv', 2)], 100);
    expect(morning.map((p) => p.id)).toEqual([3]);
    // Two more titles were watched during the day: the first row stays where it is.
    const evening = pickBecause([seed(8, 'movie', 0), seed(9, 'movie', 0.5), seed(3, 'tv', 2)], 100, 3, morning);
    expect(evening.map((p) => p.id)).toEqual([3, 8, 9]);
    // A full day's rows are not touched.
    expect(pickBecause(seeds, 100, 3, evening)).toEqual(evening);
  });
});

describe('dayNumber', () => {
  it('changes at local midnight', () => {
    const minutesWest = 300; // UTC-5
    const justBefore = Date.UTC(2026, 10, 26, 4, 59);
    const justAfter = Date.UTC(2026, 10, 26, 5, 1);
    expect(dayNumber(justAfter, minutesWest)).toBe(dayNumber(justBefore, minutesWest) + 1);
    expect(dayNumber(Date.UTC(2026, 10, 26, 23), minutesWest)).toBe(dayNumber(justAfter, minutesWest));
  });
});
