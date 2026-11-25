import { beforeEach, describe, expect, it, vi } from 'vitest';

// Documents live in memory here; the assistant and TMDB are stand-ins that count their calls.
const stored = new Map<string, unknown>();

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async () => {
    throw new Error('no network in tests');
  }),
  docs: {
    read: vi.fn(async (name: string) => stored.get(name) ?? null),
    write: vi.fn(async (name: string, value: unknown) => void stored.set(name, structuredClone(value))),
    remove: vi.fn(async () => undefined),
  },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));
vi.mock('../ui/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../meta/tmdb', () => ({ hasTmdb: vi.fn(() => true), searchTitles: vi.fn(async () => []), tmdbImage: () => undefined, externalIds: vi.fn(), findByImdb: vi.fn() }));

const suggest = vi.fn();
vi.mock('./index', () => ({
  assistantFor: () => ({ suggest, check: vi.fn() }),
  assistantSettings: vi.fn(() => ({ provider: 'claude', apiKey: 'k', model: 'claude-opus-5-5' })),
  useAssistantSettings: () => null,
}));
vi.mock('./resolve', () => ({ resolveSuggestions: vi.fn() }));

const { enoughHistory, knownTitles, refreshDue, tasteFrom, useForYou } = await import('./forYou');
const { resolveSuggestions } = await import('./resolve');
const { assistantSettings } = await import('./index');
const { hasTmdb } = await import('../meta/tmdb');
const { useHistory } = await import('../state/history');
const { useProfiles } = await import('../state/profiles');
const { AiError } = await import('./types');
type HistoryDoc = import('../state/history').HistoryDoc;
type AiCard = import('./resolve').AiCard;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('refreshDue', () => {
  const now = Date.UTC(2026, 10, 25, 20);

  it('asks when nothing was ever fetched', () => {
    expect(refreshDue(null, now)).toBe(true);
    expect(refreshDue({ at: 0 }, now)).toBe(true);
  });

  it('asks once a day at most', () => {
    expect(refreshDue({ at: now - 5 * 60 * 1000 }, now)).toBe(false);
    expect(refreshDue({ at: now - (DAY - 1) }, now)).toBe(false);
    expect(refreshDue({ at: now - DAY }, now)).toBe(true);
    expect(refreshDue({ at: now - 3 * DAY }, now)).toBe(true);
  });

  it('waits an hour after a failure, even with nothing to show', () => {
    expect(refreshDue({ at: 0, failedAt: now - 10 * 60 * 1000 }, now)).toBe(false);
    expect(refreshDue({ at: 0, failedAt: now - HOUR }, now)).toBe(true);
    expect(refreshDue({ at: now - 2 * DAY, failedAt: now - 59 * 60 * 1000 }, now)).toBe(false);
    // A failure does not make a fresh answer stale.
    expect(refreshDue({ at: now - 2 * HOUR, failedAt: now - 90 * 60 * 1000 }, now)).toBe(false);
  });

  it('treats an answer dated in the future (the clock was set back) as old', () => {
    expect(refreshDue({ at: now + DAY }, now)).toBe(true);
    expect(refreshDue({ at: 0, failedAt: now + DAY }, now)).toBe(true);
  });
});

const history = (over: Partial<HistoryDoc> = {}): Pick<HistoryDoc, 'progress' | 'watched' | 'library' | 'cards'> => ({ progress: {}, watched: {}, library: {}, cards: {}, ...over });

describe('tasteFrom', () => {
  it('lists what was watched, newest first, one line per title, with names from the cards', () => {
    const taste = tasteFrom(
      history({
        watched: {
          tt1: { key: 'tt1', metaId: 'tt1', type: 'movie', at: 100 },
          'tt2:1:1': { key: 'tt2:1:1', metaId: 'tt2', type: 'series', season: 1, episode: 1, at: 200 },
          'tt2:1:2': { key: 'tt2:1:2', metaId: 'tt2', type: 'series', season: 1, episode: 2, at: 300 },
          tt9: { key: 'tt9', metaId: 'tt9', type: 'movie', at: 400 },
        },
        progress: {
          // Half way through counts; a title only just started does not.
          tt3: { key: 'tt3', metaId: 'tt3', type: 'movie', positionS: 3000, durationS: 5000, updatedAt: 250, name: 'Half Seen', year: '2019' },
          tt4: { key: 'tt4', metaId: 'tt4', type: 'movie', positionS: 100, durationS: 5000, updatedAt: 999, name: 'Barely Started' },
        },
        cards: { tt1: { type: 'movie', name: 'Heat', year: '1995' }, tt2: { type: 'series', name: 'Severance', year: '2022–' } },
        library: {
          tt1: { metaId: 'tt1', type: 'movie', addedAt: 5, name: 'Heat' },
          tt7: { metaId: 'tt7', type: 'series', addedAt: 50, name: 'Dark', year: '2017' },
          tt8: { metaId: 'tt8', type: 'movie', addedAt: 60 },
        },
      }),
    );
    // tt9 has no name anywhere: an id would mean nothing to the assistant.
    expect(taste.watched).toEqual([
      { name: 'Severance', year: '2022', type: 'series', episodes: 2 },
      { name: 'Half Seen', year: '2019', type: 'movie', episodes: undefined },
      { name: 'Heat', year: '1995', type: 'movie', episodes: undefined },
    ]);
    // Already watched (Heat) and unnamed (tt8) are not listed as plans.
    expect(taste.watchlist).toEqual([{ name: 'Dark', year: '2017', type: 'series', episodes: undefined }]);
  });

  it('shows the assistant the forty most recent titles and no more', () => {
    const watched: HistoryDoc['watched'] = {};
    const cards: HistoryDoc['cards'] = {};
    for (let i = 0; i < 120; i++) {
      watched[`tt${i}`] = { key: `tt${i}`, metaId: `tt${i}`, type: 'movie', at: i };
      cards[`tt${i}`] = { type: 'movie', name: `Film ${i}` };
    }
    const taste = tasteFrom(history({ watched, cards }));
    expect(taste.watched).toHaveLength(40);
    expect(taste.watched[0].name).toBe('Film 119');
    expect(taste.watched[39].name).toBe('Film 80');
  });

  it('needs a few titles before recommending', () => {
    expect(enoughHistory({ watched: [], watchlist: [] })).toBe(false);
    expect(enoughHistory({ watched: [{ name: 'A', type: 'movie' }], watchlist: [{ name: 'B', type: 'movie' }] })).toBe(false);
    expect(enoughHistory({ watched: [{ name: 'A', type: 'movie' }, { name: 'C', type: 'movie' }], watchlist: [{ name: 'B', type: 'movie' }] })).toBe(true);
  });

  it('knows every title the profile has anything on, however old', () => {
    const known = knownTitles(
      history({
        watched: { 'tt2:1:1': { key: 'tt2:1:1', metaId: 'tt2', type: 'series', season: 1, episode: 1, at: 1 }, 'tmdb:603': { key: 'tmdb:603', metaId: 'tmdb:603', type: 'movie', at: 1 } },
        progress: { tt4: { key: 'tt4', metaId: 'tt4', type: 'movie', positionS: 1, durationS: 100, updatedAt: 1 } },
        library: { tt7: { metaId: 'tt7', type: 'series', addedAt: 1 } },
      }),
    );
    expect([...known].sort()).toEqual(['tmdb:603@movie', 'tt2', 'tt4', 'tt7']);
  });
});

describe('the For you row asks at most once a day', () => {
  const card = (id: number, metaId = `tt${id}`): AiCard => ({ metaId, type: 'movie', name: `Pick ${id}`, tmdbId: id, reason: `Reason ${id}` });
  const picks = [{ title: 'Pick 1', year: 2001, type: 'movie' as const, reason: 'Reason 1' }];
  const store = () => useForYou.getState();

  beforeEach(async () => {
    stored.clear();
    suggest.mockReset().mockResolvedValue(picks);
    vi.mocked(resolveSuggestions).mockReset().mockResolvedValue({ cards: [card(1), card(2), card(3, 'tt100')], failed: 0 });
    vi.mocked(hasTmdb).mockReturnValue(true);
    vi.mocked(assistantSettings).mockReturnValue({ provider: 'claude', apiKey: 'k', model: 'claude-opus-5-5' });
    useProfiles.setState({ activeId: 'p1' });
    const watched: HistoryDoc['watched'] = {};
    const cards: HistoryDoc['cards'] = {};
    for (const id of ['tt100', 'tt101', 'tt102']) {
      watched[id] = { key: id, metaId: id, type: 'movie', at: 1 };
      cards[id] = { type: 'movie', name: `Seen ${id}` };
    }
    useHistory.setState({ loaded: true, watched, cards, progress: {}, library: {} });
    // Another profile first, so each test starts from an unloaded store.
    useForYou.setState({ profileId: null, cache: null, status: 'idle', error: null });
    await store().load('p1');
  });

  it('fetches once, saves the answer, and does not ask again that day', async () => {
    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0][0]).toMatchObject({ kind: 'for-you', kids: false, watched: [{ name: 'Seen tt100' }, { name: 'Seen tt101' }, { name: 'Seen tt102' }] });
    // tt100 is in the history already: a recommendation of it is not shown.
    expect(store().cache?.items.map((c) => c.name)).toEqual(['Pick 1', 'Pick 2']);
    expect(store().status).toBe('idle');
    expect((stored.get('foryou-p1') as { items: unknown[] }).items).toHaveLength(2);

    await store().refresh();
    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('reads the saved answer on the next start instead of asking', async () => {
    await store().refresh();
    useForYou.setState({ profileId: null, cache: null });
    await store().load('p1');
    expect(store().cache?.items).toHaveLength(2);
    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('asks again after a day, and at once when the user picks Refresh', async () => {
    stored.set('foryou-p1', { version: 1, at: Date.now() - DAY - 1000, items: [card(9)] });
    useForYou.setState({ profileId: null, cache: null });
    await store().load('p1');
    expect(store().cache?.items.map((c) => c.name)).toEqual(['Pick 9']);
    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);

    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);
    await store().refresh({ force: true });
    expect(suggest).toHaveBeenCalledTimes(2);
  });

  it('keeps what it had when a refresh fails, says why, and waits before trying again', async () => {
    stored.set('foryou-p1', { version: 1, at: Date.now() - 2 * DAY, items: [card(9)] });
    useForYou.setState({ profileId: null, cache: null });
    await store().load('p1');
    suggest.mockRejectedValueOnce(new AiError('rate-limit', 'Too many requests for now.'));
    await store().refresh();
    expect(store().status).toBe('error');
    expect(store().error).toBe('Too many requests for now.');
    expect(store().cache?.items.map((c) => c.name)).toEqual(['Pick 9']);

    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(1);
    // "Try again" on the row is the user asking: that goes through.
    await store().refresh({ force: true });
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(store().status).toBe('idle');
  });

  it('asks nobody without an assistant, without enough history, or without TMDB', async () => {
    vi.mocked(assistantSettings).mockReturnValue(null);
    await store().refresh({ force: true });
    vi.mocked(assistantSettings).mockReturnValue({ provider: 'claude', apiKey: 'k', model: 'claude-opus-5-5' });

    useHistory.setState({ watched: {}, cards: {} });
    await store().refresh({ force: true });

    useHistory.setState({ watched: { a: { key: 'a', metaId: 'a', type: 'movie', at: 1 }, b: { key: 'b', metaId: 'b', type: 'movie', at: 1 }, c: { key: 'c', metaId: 'c', type: 'movie', at: 1 } }, cards: { a: { type: 'movie', name: 'A' }, b: { type: 'movie', name: 'B' }, c: { type: 'movie', name: 'C' } } });
    vi.mocked(hasTmdb).mockReturnValue(false);
    await store().refresh({ force: true });
    expect(store().error).toMatch(/TMDB key/);

    expect(suggest).not.toHaveBeenCalled();
  });

  it('keeps each profile’s recommendations apart', async () => {
    await store().refresh();
    useProfiles.setState({ activeId: 'p2' });
    await store().load('p2');
    expect(store().cache).toBeNull();
    await store().refresh();
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(stored.has('foryou-p2')).toBe(true);
  });
});
