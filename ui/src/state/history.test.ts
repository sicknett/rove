import { beforeEach, describe, expect, it, vi } from 'vitest';

// Documents live in memory here; every save the store asks for is recorded.
const stored = new Map<string, unknown>();
const saves: unknown[] = [];
let failRead = false;

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  nativeFetch: vi.fn(async () => {
    throw new Error('no network in tests');
  }),
  docs: {
    read: vi.fn(async (name: string) => {
      if (failRead && name.startsWith('history')) throw new Error('could not read history (500)');
      return stored.get(name) ?? null;
    }),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: (v: unknown) => void saves.push(v), flush: async () => undefined }),
}));
vi.mock('../ui/toast', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const { rekeyHistory, useHistory } = await import('./history');
const { rememberMapping } = await import('../tracking/idmap');
type HistoryDoc = import('./history').HistoryDoc;
type ProgressEntry = import('./history').ProgressEntry;
type WatchedEntry = import('./history').WatchedEntry;

const h = () => useHistory.getState();

function resume(key: string, at: number, extra: Partial<ProgressEntry> = {}): ProgressEntry {
  const [metaId, season, episode] = key.startsWith('tmdb:') ? [key.split(':').slice(0, 2).join(':'), ...key.split(':').slice(2).map(Number)] : [key.split(':')[0], ...key.split(':').slice(1).map(Number)];
  return { key, metaId: metaId as string, type: season === undefined ? 'movie' : 'series', season: season as number | undefined, episode: episode as number | undefined, positionS: 600, durationS: 3000, updatedAt: at, ...extra };
}

function mark(key: string, at: number, extra: Partial<WatchedEntry> = {}): WatchedEntry {
  const r = resume(key, at);
  return { key, metaId: r.metaId, type: r.type, season: r.season, episode: r.episode, at, ...extra };
}

const doc = (part: Partial<HistoryDoc>): HistoryDoc => ({ version: 1, progress: {}, watched: {}, library: {}, dismissed: {}, cards: {}, outbox: [], ...part });

beforeEach(async () => {
  stored.clear();
  failRead = false;
  await h().load();
  saves.length = 0;
});

describe('applyRemote', () => {
  it('keeps a resume point that is newer here than on the tracker, and queues it', () => {
    useHistory.setState({ progress: { 'tt1:1:2': resume('tt1:1:2', 2000, { positionS: 1500, synced: true }) } });
    h().applyRemote({ progress: [resume('tt1:1:2', 1000, { positionS: 600, synced: true })], watched: [] }, 5000);
    expect(h().progress['tt1:1:2']).toMatchObject({ positionS: 1500, updatedAt: 2000 });
    expect(h().outbox).toEqual([expect.objectContaining({ op: 'resume', key: 'tt1:1:2' })]);
  });

  it('takes the tracker position when that is newer, keeping the art known here', () => {
    useHistory.setState({ progress: { tt2: resume('tt2', 1000, { positionS: 300, synced: true, poster: 'local.jpg', estimated: true }) } });
    h().applyRemote({ progress: [resume('tt2', 4000, { positionS: 900, name: 'Remote', synced: true })], watched: [] }, 5000);
    expect(h().progress.tt2).toMatchObject({ positionS: 900, updatedAt: 4000, poster: 'local.jpg', name: 'Remote', synced: true });
    expect(h().progress.tt2.estimated).toBeUndefined();
    expect(h().outbox).toEqual([]);
  });

  it('keeps the exact local position when the tracker gives the same share back', () => {
    // 1234.5 s of 3000 went out as 41.15 %; it comes back as that share of a nominal running time.
    useHistory.setState({ progress: { tt3: resume('tt3', 1000, { positionS: 1234.5, synced: true }) } });
    h().applyRemote({ progress: [resume('tt3', 9000, { positionS: 0.4115 * 2700, durationS: 2700, estimated: true, synced: true })], watched: [] }, 9500);
    expect(h().progress.tt3).toMatchObject({ positionS: 1234.5, durationS: 3000, synced: true });
    expect(h().progress.tt3.estimated).toBeUndefined();
    expect(h().outbox).toEqual([]);
  });

  it('recognises its own position coming back capped', () => {
    useHistory.setState({ progress: { tt4: resume('tt4', 1000, { positionS: 2550, synced: true }) } });
    h().applyRemote({ progress: [resume('tt4', 9000, { positionS: 0.79 * 2700, durationS: 2700, estimated: true, synced: true })], watched: [], resumeCap: 0.79 }, 9500);
    expect(h().progress.tt4.positionS).toBe(2550);
  });

  it('removes what the tracker no longer has, but only on a complete pull', () => {
    const local = { progress: { tt5: resume('tt5', 1000, { synced: true }), tt6: resume('tt6', 1000) }, watched: { tt7: mark('tt7', 1000, { synced: true }), tt8: mark('tt8', 1000) } };
    useHistory.setState(local);
    h().applyRemote({ progress: [], watched: [], incomplete: ['progress', 'watched'] }, 5000);
    expect(Object.keys(h().progress).sort()).toEqual(['tt5', 'tt6']);
    expect(Object.keys(h().watched).sort()).toEqual(['tt7', 'tt8']);
    h().applyRemote({ progress: [], watched: [] }, 5000);
    // Entries the tracker never had stay; synced ones it dropped were finished or removed elsewhere.
    expect(Object.keys(h().progress)).toEqual(['tt6']);
    expect(Object.keys(h().watched)).toEqual(['tt8']);
  });

  it('leaves alone what has a change waiting in the outbox', () => {
    useHistory.setState({ progress: {}, watched: {}, outbox: [{ op: 'unwatched', key: 'tt9', metaId: 'tt9', type: 'movie', at: 4000 }] });
    h().applyRemote({ progress: [], watched: [mark('tt9', 1000, { synced: true })] }, 5000);
    expect(h().watched.tt9).toBeUndefined();
  });

  it('takes the latest of several plays the tracker lists, and tells a rewatch from a double entry', () => {
    const DAY = 24 * 3600 * 1000;
    const now = 400 * DAY;
    h().applyRemote({ progress: [], watched: [mark('tt1:1:1', 300 * DAY), mark('tt1:1:1', 20 * DAY), mark('tt1:1:2', 300 * DAY + 5000), mark('tt1:1:2', 300 * DAY)] }, now);
    // Months apart: watched again. Seconds apart: one viewing that was recorded twice.
    expect(h().watched['tt1:1:1']).toMatchObject({ at: 300 * DAY, plays: 2, synced: true });
    expect(h().watched['tt1:1:2']).toMatchObject({ at: 300 * DAY + 5000, synced: true });
    expect(h().watched['tt1:1:2'].plays).toBeUndefined();
    // A later date than the mark known here is another viewing too; pulling it again adds nothing.
    h().applyRemote({ progress: [], watched: [mark('tt1:1:1', 300 * DAY), mark('tt1:1:2', 350 * DAY)] }, now);
    expect(h().watched['tt1:1:2']).toMatchObject({ at: 350 * DAY, plays: 2 });
    h().applyRemote({ progress: [], watched: [mark('tt1:1:1', 300 * DAY), mark('tt1:1:2', 350 * DAY)] }, now);
    expect(h().watched['tt1:1:2'].plays).toBe(2);
    expect(h().watched['tt1:1:1'].plays).toBe(2);
  });

  it('puts what the tracker sends under the id history uses', () => {
    rememberMapping('tt0000693', { id: 693, kind: 'tv' });
    h().applyRemote({ progress: [resume('tmdb:693:3:15', 1000, { synced: true })], watched: [mark('tmdb:693:3:14', 900)] }, 5000);
    expect(h().progress['tt0000693:3:15']).toMatchObject({ metaId: 'tt0000693', tmdbId: 693 });
    expect(h().watched['tt0000693:3:14']).toMatchObject({ metaId: 'tt0000693', tmdbId: 693 });
  });
});

describe('recordProgress', () => {
  const ep = { metaId: 'tt20', type: 'series' as const, season: 1, episode: 1, durationS: 1000 };

  it('marks watched once past the threshold, however often it is called', () => {
    expect(h().recordProgress({ ...ep, positionS: 910, updatedAt: 10_000 })).toBe('watched');
    const after = h();
    expect(after.watched['tt20:1:1'].at).toBe(10_000);
    expect(after.outbox).toEqual([{ op: 'watched', key: 'tt20:1:1', at: 10_000 }]);
    saves.length = 0;
    expect(h().recordProgress({ ...ep, positionS: 915, updatedAt: 15_000 })).toBe('watched');
    expect(h().recordProgress({ ...ep, positionS: 990, updatedAt: 90_000 }, { sync: false })).toBe('watched');
    // Nothing was committed again: same mark, same single outbox entry, no write.
    expect(h().watched).toBe(after.watched);
    expect(h().outbox).toBe(after.outbox);
    expect(saves).toHaveLength(0);
    // Marked again by the player at the credits: still one mark, one outbox entry.
    h().markWatched([{ metaId: 'tt20', type: 'series', season: 1, episode: 1 }], 95_000);
    expect(h().watched['tt20:1:1'].at).toBe(10_000);
    expect(h().outbox).toHaveLength(1);
  });

  it('counts marking a title again on another day as another play', () => {
    const DAY = 24 * 3600 * 1000;
    h().markWatched([{ metaId: 'tt21', type: 'movie' }], 10 * DAY);
    h().markWatched([{ metaId: 'tt21', type: 'movie' }], 10 * DAY + 60_000);
    expect(h().watched.tt21).toMatchObject({ at: 10 * DAY });
    expect(h().watched.tt21.plays).toBeUndefined();
    h().markWatched([{ metaId: 'tt21', type: 'movie' }], 12 * DAY);
    expect(h().watched.tt21).toMatchObject({ at: 12 * DAY, plays: 2 });
  });

  it('clears a resume point left by seeking back, without a second mark', () => {
    h().recordProgress({ ...ep, positionS: 910, updatedAt: 10_000 });
    h().recordProgress({ ...ep, positionS: 500, updatedAt: 20_000 });
    expect(h().progress['tt20:1:1']).toBeDefined();
    expect(h().recordProgress({ ...ep, positionS: 920, updatedAt: 30_000 })).toBe('watched');
    expect(h().progress['tt20:1:1']).toBeUndefined();
    expect(h().watched['tt20:1:1'].at).toBe(10_000);
    expect(h().outbox.filter((o) => o.op === 'watched')).toHaveLength(1);
  });

  it('counts a title finished again from the start as another play', () => {
    useHistory.setState({ watched: { 'tt20:1:1': mark('tt20:1:1', 1000, { synced: true }) } });
    h().recordProgress({ ...ep, positionS: 950, updatedAt: 50_000_000 });
    expect(h().watched['tt20:1:1']).toMatchObject({ at: 50_000_000, plays: 2 });
  });

  it('does nothing when the position has not moved', () => {
    h().recordProgress({ ...ep, positionS: 400, updatedAt: 1000 });
    const before = h();
    saves.length = 0;
    expect(h().recordProgress({ ...ep, positionS: 400.4, updatedAt: 2000 })).toBe('saved');
    expect(h().recordProgress({ ...ep, positionS: 400.4, updatedAt: 3000 }, { sync: false })).toBe('saved');
    expect(h().progress).toBe(before.progress);
    expect(h().outbox).toBe(before.outbox);
    expect(saves).toHaveLength(0);
  });

  it('replaces an estimated position with the real one', () => {
    useHistory.setState({ progress: { 'tt20:1:1': resume('tt20:1:1', 1000, { positionS: 400, durationS: 1000, estimated: true, synced: true, name: 'Show' }) } });
    h().recordProgress({ ...ep, positionS: 400, updatedAt: 2000, name: undefined });
    expect(h().progress['tt20:1:1'].estimated).toBeUndefined();
    // What the caller does not know stays as it was.
    expect(h().progress['tt20:1:1'].name).toBe('Show');
  });

  it('saves under the IMDb id when the title maps, keeping the TMDB id', () => {
    rememberMapping('tt0000030', { id: 30, kind: 'movie' });
    h().recordProgress({ metaId: 'tmdb:30', type: 'movie', positionS: 500, durationS: 5000 });
    expect(Object.keys(h().progress)).toEqual(['tt0000030']);
    expect(h().progress.tt0000030).toMatchObject({ metaId: 'tt0000030', tmdbId: 30 });
    // The show with the same TMDB number is another title and has no mapping: it stays as it is.
    h().recordProgress({ metaId: 'tmdb:30', type: 'series', season: 1, episode: 1, positionS: 500, durationS: 5000 });
    expect(h().progress['tmdb:30:1:1']).toMatchObject({ metaId: 'tmdb:30', tmdbId: 30 });
  });
});

describe('rekeyHistory', () => {
  const canonical = (metaId: string, type: 'movie' | 'series') => (metaId === 'tmdb:693' && type === 'series' ? 'tt0000693' : metaId);

  it('moves entries to the IMDb id and keeps the TMDB id for the tracker', () => {
    const r = rekeyHistory(
      doc({
        progress: { 'tmdb:693:3:15': resume('tmdb:693:3:15', 100, { synced: true }) },
        watched: { 'tmdb:693:3:14': mark('tmdb:693:3:14', 90, { synced: true }) },
        outbox: [{ op: 'resume', key: 'tmdb:693:3:15', at: 100 }],
      }),
      canonical,
    )!;
    expect(r.doc.progress).toEqual({ 'tt0000693:3:15': expect.objectContaining({ key: 'tt0000693:3:15', metaId: 'tt0000693', tmdbId: 693, synced: true }) });
    expect(r.doc.watched).toEqual({ 'tt0000693:3:14': expect.objectContaining({ key: 'tt0000693:3:14', metaId: 'tt0000693', tmdbId: 693 }) });
    expect(r.doc.outbox).toEqual([{ op: 'resume', key: 'tt0000693:3:15', at: 100 }]);
    expect(r.keys.get('tmdb:693:3:15')).toBe('tt0000693:3:15');
  });

  it('keeps the newer of two entries that meet under one key', () => {
    const r = rekeyHistory(
      doc({
        progress: {
          'tmdb:693:3:15': resume('tmdb:693:3:15', 100, { positionS: 100, poster: 'old.jpg' }),
          'tt0000693:3:15': resume('tt0000693:3:15', 200, { positionS: 200 }),
          'tmdb:693:3:16': resume('tmdb:693:3:16', 400, { positionS: 400 }),
          'tt0000693:3:16': resume('tt0000693:3:16', 300, { positionS: 300 }),
        },
        watched: { 'tmdb:693:1:1': mark('tmdb:693:1:1', 500, { synced: true }), 'tt0000693:1:1': mark('tt0000693:1:1', 50) },
      }),
      canonical,
    )!;
    expect(Object.keys(r.doc.progress).sort()).toEqual(['tt0000693:3:15', 'tt0000693:3:16']);
    // The newer position wins either way round; art only the older one had is not lost.
    expect(r.doc.progress['tt0000693:3:15']).toMatchObject({ positionS: 200, poster: 'old.jpg' });
    expect(r.doc.progress['tt0000693:3:16']).toMatchObject({ positionS: 400, metaId: 'tt0000693' });
    expect(r.doc.watched).toEqual({ 'tt0000693:1:1': expect.objectContaining({ at: 500, synced: true, tmdbId: 693 }) });
  });

  it('tells movie 693 from show 693, and leaves alone what does not map', () => {
    const before = doc({
      progress: { 'tmdb:693': resume('tmdb:693', 100), 'tmdb:693:1:1': resume('tmdb:693:1:1', 100), 'tmdb:7:1:1': resume('tmdb:7:1:1', 100) },
      library: { 'tmdb:693': { metaId: 'tmdb:693', type: 'movie', addedAt: 1 }, tt5: { metaId: 'tt5', type: 'movie', addedAt: 2 } },
      cards: { 'tmdb:693': { type: 'series', name: 'The Show' } },
      dismissed: { 'tmdb:693': 50 },
    });
    const r = rekeyHistory(before, canonical)!;
    // The movie stays under its `tmdb:` id; only the show moves. Nothing is dropped.
    expect(Object.keys(r.doc.progress).sort()).toEqual(['tmdb:693', 'tmdb:7:1:1', 'tt0000693:1:1']);
    expect(r.doc.library).toEqual({ 'tmdb:693@movie': expect.objectContaining({ metaId: 'tmdb:693' }), tt5: expect.objectContaining({ metaId: 'tt5' }) });
    expect(r.doc.cards).toEqual({ tt0000693: { type: 'series', name: 'The Show' } });
    // The old dismissal did not say which of the two it hid: it holds for both.
    expect(r.doc.dismissed).toEqual({ 'tmdb:693@movie': 50, tt0000693: 50 });
  });

  it('reports nothing to do when every entry is where it belongs', () => {
    expect(rekeyHistory(doc({ progress: { tt1: resume('tt1', 1), 'tmdb:7:1:1': resume('tmdb:7:1:1', 1) }, library: { 'tmdb:7@series': { metaId: 'tmdb:7', type: 'series', addedAt: 1 } } }), canonical)).toBeNull();
  });

  it('runs in the store once a mapping is learned, without losing the unmapped', () => {
    useHistory.setState({ watched: { 'tmdb:1396:1:1': mark('tmdb:1396:1:1', 10, { synced: true }), 'tmdb:1399:1:1': mark('tmdb:1399:1:1', 10) } });
    rememberMapping('tt0903747', { id: 1396, kind: 'tv' });
    expect(h().rekey()).toBe(true);
    expect(Object.keys(h().watched).sort()).toEqual(['tmdb:1399:1:1', 'tt0903747:1:1']);
    expect(h().rekey()).toBe(false);
  });
});

describe('outbox and watchlist', () => {
  it('drops only what was sent', () => {
    const sent = { op: 'watched' as const, key: 'tt1', at: 10 };
    const newer = { op: 'unwatched' as const, key: 'tt2', metaId: 'tt2', type: 'movie' as const, at: 30 };
    useHistory.setState({ watched: { tt1: mark('tt1', 10) }, outbox: [sent, { op: 'resume', key: 'tt2', at: 20 }, { op: 'resume', key: 'tt3', at: 25 }] });
    // While tt2's resume was on its way, the user changed tt2 again.
    useHistory.setState({ outbox: [sent, { op: 'resume', key: 'tt3', at: 25 }, newer] });
    h().settleOutbox({ done: [sent, { op: 'resume', key: 'tt2', at: 20 }], failed: [{ op: 'resume', key: 'tt3', at: 25 }], synced: { watched: ['tt1'] } });
    expect(h().outbox).toEqual([{ op: 'resume', key: 'tt3', at: 25, tries: 1 }, newer]);
    expect(h().watched.tt1.synced).toBe(true);
  });

  it('queues watchlist changes for the tracker under the title key', () => {
    expect(h().toggleLibrary({ metaId: 'tmdb:99', type: 'movie', name: 'Film' })).toBe(true);
    expect(h().library['tmdb:99@movie']).toMatchObject({ metaId: 'tmdb:99', tmdbId: 99, name: 'Film' });
    expect(h().outbox).toEqual([expect.objectContaining({ op: 'list-add', key: 'list:tmdb:99@movie', metaId: 'tmdb:99', tmdbId: 99 })]);
    expect(h().toggleLibrary({ metaId: 'tmdb:99', type: 'movie' })).toBe(false);
    // The removal replaces the add that had not been sent.
    expect(h().outbox).toEqual([expect.objectContaining({ op: 'list-remove', key: 'list:tmdb:99@movie' })]);
    expect(h().library).toEqual({});
  });

  it('forgets what the tracker had when the account changes', () => {
    useHistory.setState({ progress: { tt1: resume('tt1', 1, { synced: true }) }, watched: { tt2: mark('tt2', 1, { synced: true }) } });
    h().forgetTracker();
    h().applyRemote({ progress: [], watched: [] }, 5000);
    expect(Object.keys(h().progress)).toEqual(['tt1']);
    expect(Object.keys(h().watched)).toEqual(['tt2']);
  });
});

describe('load', () => {
  it('reads the profile history and saves changes', async () => {
    stored.set('history-none', doc({ watched: { tt1: mark('tt1', 5) } }));
    await h().load();
    expect(h().loaded).toBe(true);
    expect(h().readOnly).toBe(false);
    expect(Object.keys(h().watched)).toEqual(['tt1']);
    h().markWatched([{ metaId: 'tt2', type: 'movie' }]);
    expect(saves.length).toBeGreaterThan(0);
  });

  it('never writes after a history file that could not be read', async () => {
    failRead = true;
    await h().load();
    expect(h().loaded).toBe(true);
    expect(h().readOnly).toBe(true);
    h().markWatched([{ metaId: 'tt2', type: 'movie' }]);
    h().recordProgress({ metaId: 'tt3', type: 'movie', positionS: 100, durationS: 1000 });
    h().toggleLibrary({ metaId: 'tt4', type: 'movie' });
    // The changes hold for this run, and nothing goes to disk over the unread file.
    expect(h().watched.tt2).toBeDefined();
    expect(saves).toHaveLength(0);
  });

  it('moves entries whose mapping is already known as it loads', async () => {
    rememberMapping('tt0000042', { id: 42, kind: 'tv' });
    stored.set('history-none', doc({ progress: { 'tmdb:42:1:1': resume('tmdb:42:1:1', 5) }, dismissed: { 'tmdb:42': 3 } }));
    await h().load();
    expect(Object.keys(h().progress)).toEqual(['tt0000042:1:1']);
    expect(h().dismissed).toEqual({ tt0000042: 3 });
    expect(saves.length).toBeGreaterThan(0);
  });
});

describe('card art', () => {
  const P = 'https://image.tmdb.org/t/p/w342/p.jpg';

  it('remembers many cards in one change and one write', () => {
    let changes = 0;
    const stop = useHistory.subscribe(() => changes++);
    h().rememberCards([
      { metaId: 'tt1', type: 'movie', card: { name: 'One', poster: P } },
      { metaId: 'tmdb:7', type: 'series', card: { name: 'Seven', poster: P, background: undefined } },
    ]);
    stop();
    expect(changes).toBe(1);
    expect(saves).toHaveLength(1);
    expect(h().cards).toEqual({ tt1: { name: 'One', poster: P, type: 'movie' }, 'tmdb:7@series': { name: 'Seven', poster: P, type: 'series' } });
  });

  it('adds to what a card already holds, and writes nothing when nothing is new', () => {
    h().rememberCard('tt1', 'movie', { name: 'One', logo: 'https://x/logo.png' });
    h().rememberCards([{ metaId: 'tt1', type: 'movie', card: { poster: P, name: undefined } }]);
    expect(h().cards.tt1).toEqual({ name: 'One', logo: 'https://x/logo.png', poster: P, type: 'movie' });
    saves.length = 0;
    h().rememberCards([{ metaId: 'tt1', type: 'movie', card: { poster: P } }]);
    expect(saves).toHaveLength(0);
  });

  it('puts a card under the IMDb id once the title maps, where its history is', () => {
    rememberMapping('tt0000042', { id: 4242, kind: 'tv' });
    h().rememberCards([{ metaId: 'tmdb:4242', type: 'series', card: { name: 'Mapped', poster: P } }]);
    expect(h().cards.tt0000042).toMatchObject({ name: 'Mapped' });
  });

  it('takes a dead picture out of everything that holds it, and leaves the rest alone', () => {
    const dead = 'https://images.example/poster/gone.jpg';
    useHistory.setState({
      cards: { tt1: { name: 'One', poster: dead, background: P, type: 'movie' }, tt2: { name: 'Two', poster: P, type: 'movie' } },
      library: { tt1: { metaId: 'tt1', type: 'movie', addedAt: 5, name: 'One', poster: dead } },
      progress: { tt1: resume('tt1', 1000, { poster: dead, logo: dead, name: 'One' }) },
    });
    const before = h().cards.tt2;
    h().forgetArt([dead]);
    expect(h().cards.tt1).toEqual({ name: 'One', background: P, type: 'movie' });
    expect(h().cards.tt2).toBe(before);
    expect(h().library.tt1).toEqual({ metaId: 'tt1', type: 'movie', addedAt: 5, name: 'One' });
    expect(h().progress.tt1).toMatchObject({ name: 'One', positionS: 600 });
    expect(h().progress.tt1.poster).toBeUndefined();
    expect(h().progress.tt1.logo).toBeUndefined();
    expect(saves).toHaveLength(1);
    // Nothing holds it any more: nothing to write.
    h().forgetArt([dead]);
    expect(saves).toHaveLength(1);
  });
});
