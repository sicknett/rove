import { describe, expect, it, vi } from 'vitest';
import type { Meta } from '../addons/types';
import type { TmdbArt } from '../meta/tmdb';
import { ART_ACTIVE_MAX, artIdentity, createArtQueue, DONE_GRACE_MS, FAILED_RETRY_MS, GONE_FOR_MS, GoneArt, NOTHING_RETRY_MS, resolveArt, saysGone, usableArt, type ArtFound, type ArtResult, type ArtSources, type ArtWanted } from './art';

const P = 'https://image.tmdb.org/t/p/w342/poster.jpg';
const B = 'https://image.tmdb.org/t/p/w1280/backdrop.jpg';

const tmdbArt = (more: Partial<TmdbArt> = {}): TmdbArt => ({ id: 1396, kind: 'tv', name: 'Breaking Bad', poster: P, background: B, year: '2008', ...more });
const addonMeta = (more: Partial<Meta> = {}): Meta => ({ id: 'tt0903747', type: 'series', name: 'Breaking Bad (addon)', poster: 'https://addon/poster.jpg', background: 'https://addon/bg.jpg', logo: 'https://addon/logo.png', releaseInfo: '2008–2013', ...more });

/** Sources that record what was asked, in order. */
function sources(over: Partial<ArtSources> = {}) {
  const calls: string[] = [];
  const src: ArtSources = {
    hasTmdb: () => true,
    byNumber: vi.fn(async (kind, id, logo) => (calls.push(`tmdb:${kind}/${id}${logo ? '+logo' : ''}`), tmdbArt())),
    byImdb: vi.fn(async (imdb, prefer) => (calls.push(`find:${imdb}/${prefer}`), tmdbArt())),
    addons: vi.fn(async (type, metaId) => (calls.push(`addons:${type}/${metaId}`), addonMeta())),
    ...over,
  };
  const wrap = <K extends 'byNumber' | 'byImdb' | 'addons'>(name: K, label: (...a: Parameters<ArtSources[K]>) => string) => {
    if (!over[name]) return;
    const given = over[name] as (...a: unknown[]) => Promise<unknown>;
    (src[name] as unknown) = async (...a: unknown[]) => (calls.push(label(...(a as Parameters<ArtSources[K]>))), given(...a));
  };
  wrap('byNumber', (kind, id, logo) => `tmdb:${kind}/${id}${logo ? '+logo' : ''}`);
  wrap('byImdb', (imdb, prefer) => `find:${imdb}/${prefer}`);
  wrap('addons', (type, metaId) => `addons:${type}/${metaId}`);
  return { src, calls };
}

const down = async () => {
  throw new Error('HTTP 429');
};

describe('resolveArt: the order', () => {
  it('asks TMDB by the number the entry carries, and nobody else when that gives a name and poster', async () => {
    const { src, calls } = sources();
    const out = await resolveArt({ metaId: 'tt0903747', type: 'series', tmdbId: 1396 }, src);
    expect(calls).toEqual(['tmdb:tv/1396']);
    expect(out).toMatchObject({ complete: true, failed: false, asked: ['tmdb'], card: { name: 'Breaking Bad', poster: P, background: B, year: '2008' } });
    // Asked by number: there is no mapping to learn.
    expect(out.tmdb).toBeUndefined();
  });

  it('asks about a `tmdb:` id directly, as the kind the entry says (movie 693 is not show 693)', async () => {
    const { src, calls } = sources();
    await resolveArt({ metaId: 'tmdb:693', type: 'movie' }, src);
    await resolveArt({ metaId: 'tmdb:693', type: 'series' }, src);
    expect(calls).toEqual(['tmdb:movie/693', 'tmdb:tv/693']);
  });

  it('asks by IMDb id when no number is known, and reports which TMDB title it is', async () => {
    const { src, calls } = sources();
    const out = await resolveArt({ metaId: 'tt0903747', type: 'series' }, src);
    expect(calls).toEqual(['find:tt0903747/tv']);
    expect(out.tmdb).toEqual({ id: 1396, kind: 'tv' });
    expect(out.complete).toBe(true);
  });

  it('uses the title part of an episode id', async () => {
    const { src, calls } = sources();
    await resolveArt({ metaId: 'tt0903747:1:2', type: 'series' }, src);
    expect(calls).toEqual(['find:tt0903747/tv']);
  });

  it('asks for the logo in the same request when a wide card wants one', async () => {
    const { src, calls } = sources();
    await resolveArt({ metaId: 'tmdb:1396', type: 'series', logo: true }, src);
    expect(calls).toEqual(['tmdb:tv/1396+logo']);
  });

  it('falls back to the addons when TMDB does not know the title', async () => {
    const { src, calls } = sources({ byNumber: async () => null });
    const out = await resolveArt({ metaId: 'tmdb:5', type: 'series' }, src);
    expect(calls).toEqual(['tmdb:tv/5', 'addons:series/tmdb:5']);
    expect(out).toMatchObject({ complete: true, asked: ['tmdb', 'addons'], card: { name: 'Breaking Bad (addon)', poster: 'https://addon/poster.jpg' } });
  });

  it('keeps TMDB’s fields and lets the addon fill only the gaps', async () => {
    const { src } = sources({ byNumber: async () => tmdbArt({ poster: undefined, background: undefined }) });
    const out = await resolveArt({ metaId: 'tmdb:1396', type: 'series' }, src);
    expect(out.card).toEqual({ name: 'Breaking Bad', year: '2008', poster: 'https://addon/poster.jpg', background: 'https://addon/bg.jpg', logo: 'https://addon/logo.png' });
    expect(out.complete).toBe(true);
  });

  it('goes straight to the addons without a TMDB key, for ids TMDB cannot be asked about, and for media server items', async () => {
    const noKey = sources({ hasTmdb: () => false });
    await resolveArt({ metaId: 'tt1', type: 'movie', tmdbId: 9 }, noKey.src);
    expect(noKey.calls).toEqual(['addons:movie/tt1']);
    const other = sources();
    await resolveArt({ metaId: 'kitsu:44', type: 'series' }, other.src);
    await resolveArt({ metaId: 'srv:abc:s1', type: 'series', tmdbId: 9 }, other.src);
    expect(other.calls).toEqual(['addons:series/kitsu:44', 'addons:series/srv:abc:s1']);
  });
});

describe('resolveArt: when it does not arrive', () => {
  it('uses the addons when TMDB cannot be reached, and is not a failure once they answer', async () => {
    const { src, calls } = sources({ byNumber: down });
    const out = await resolveArt({ metaId: 'tt1', type: 'movie', tmdbId: 9 }, src);
    expect(calls).toEqual(['tmdb:movie/9', 'addons:movie/tt1']);
    expect(out).toMatchObject({ complete: true, failed: false });
  });

  it('is a failure (asked again soon) when a source could not be reached and nothing complete came back', async () => {
    const both = sources({ byNumber: down, addons: down });
    expect(await resolveArt({ metaId: 'tt1', type: 'movie', tmdbId: 9 }, both.src)).toMatchObject({ card: {}, complete: false, failed: true });
    // TMDB answered "no such title"; the addon is what failed.
    const addon = sources({ byNumber: async () => null, addons: down });
    expect(await resolveArt({ metaId: 'tmdb:9', type: 'movie' }, addon.src)).toMatchObject({ complete: false, failed: true });
    // TMDB failed; the addon answered that it has nothing. Still worth another try at TMDB.
    const tmdbOnly = sources({ byNumber: down, addons: async () => null });
    expect(await resolveArt({ metaId: 'tmdb:9', type: 'movie' }, tmdbOnly.src)).toMatchObject({ complete: false, failed: true });
  });

  it('is settled, not failed, when every source answered and none has it', async () => {
    const { src } = sources({ byNumber: async () => null, addons: async () => null });
    expect(await resolveArt({ metaId: 'tmdb:9', type: 'movie' }, src)).toEqual({ card: {}, complete: false, failed: false, tmdb: undefined, asked: ['tmdb', 'addons'] });
  });

  it('keeps a name that has no poster to go with it', async () => {
    const { src } = sources({ byNumber: async () => tmdbArt({ poster: undefined, background: undefined }), addons: async () => null });
    expect(await resolveArt({ metaId: 'tmdb:9', type: 'series' }, src)).toMatchObject({ card: { name: 'Breaking Bad' }, complete: false, failed: false });
  });

  it('does not take a picture known to be dead as an answer: the next source is asked', async () => {
    const { src, calls } = sources({ usable: (url) => url !== P });
    const out = await resolveArt({ metaId: 'tmdb:1396', type: 'series' }, src);
    expect(calls).toEqual(['tmdb:tv/1396', 'addons:series/tmdb:1396']);
    expect(out.card).toMatchObject({ name: 'Breaking Bad', poster: 'https://addon/poster.jpg', background: B });
  });
});

// ---------- The queue ----------

/** A queue over a hand-driven clock and resolver. */
function harness(maxActive?: number) {
  let t = 1_000_000;
  const timers: { at: number; run: () => void; off: boolean }[] = [];
  const pending: { want: ArtWanted; done: (out: Partial<ArtFound>) => void }[] = [];
  const asked: string[] = [];
  const sent: ArtWanted[] = [];
  const remembered: ArtResult[][] = [];
  const queue = createArtQueue({
    maxActive,
    now: () => t,
    later: (run, ms) => {
      const timer = { at: t + ms, run, off: false };
      timers.push(timer);
      return () => void (timer.off = true);
    },
    resolve: (want) =>
      new Promise<ArtFound>((resolve) => {
        asked.push(want.metaId);
        sent.push(want);
        pending.push({ want, done: (out) => resolve({ card: {}, complete: false, failed: false, asked: [], ...out }) });
      }),
    remember: (found) => void remembered.push(found),
  });
  /** Moves the clock on, running what came due. */
  const advance = (ms: number) => {
    t += ms;
    for (const timer of [...timers]) {
      if (timer.off || timer.at > t) continue;
      timer.off = true;
      timer.run();
    }
  };
  /** Answers the oldest request in flight. */
  const answer = async (out: Partial<ArtFound> = { card: { name: 'N', poster: P }, complete: true }) => {
    pending.shift()!.done(out);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { queue, asked, sent, remembered, pending, advance, answer };
}

const want = (n: number): ArtWanted => ({ metaId: `tt${n}`, type: 'movie' });
const many = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => want(from + i));

describe('the art queue', () => {
  it('has only a few requests in flight, in the order the list gives', async () => {
    const h = harness();
    h.queue.want({}, many(1, 40));
    expect(h.queue.active()).toBe(ART_ACTIVE_MAX);
    expect(h.asked).toEqual(['tt1', 'tt2', 'tt3', 'tt4', 'tt5', 'tt6']);
    await h.answer();
    expect(h.asked).toHaveLength(7);
    expect(h.queue.active()).toBe(ART_ACTIVE_MAX);
  });

  it('never starts what is no longer wanted: a list scrolled past costs nothing', async () => {
    const h = harness(2);
    const screen = {};
    h.queue.want(screen, many(1, 30));
    // Scrolled on before the first two were answered.
    h.queue.want(screen, many(100, 110));
    await h.answer();
    await h.answer();
    expect(h.asked).toEqual(['tt1', 'tt2', 'tt100', 'tt101']);
    h.queue.release(screen);
    await h.answer();
    await h.answer();
    expect(h.asked).toHaveLength(4);
    expect(h.queue.active()).toBe(0);
  });

  it('asks about a title once however many lists want it, the newest list first', async () => {
    const h = harness(1);
    h.queue.want({}, [want(1), want(2)]);
    h.queue.want({}, [want(2), want(3)]);
    await h.answer();
    await h.answer();
    await h.answer();
    expect(h.asked).toEqual(['tt1', 'tt2', 'tt3']);
    expect(h.queue.active()).toBe(0);
  });

  it('asks for the logo when any list wants one, whichever list is served first', async () => {
    const h = harness(1);
    h.queue.want({}, [{ ...want(1), logo: true }]);
    // The newer list is served first, and does not ask for the logo itself.
    h.queue.want({}, [want(2), want(1)]);
    await h.answer();
    await h.answer();
    expect(h.sent).toEqual([{ ...want(1), logo: true }, want(2)]);
    const other = harness(1);
    other.queue.want({}, [want(2)]);
    other.queue.want({}, [{ ...want(1), logo: true }, { ...want(2), logo: true }]);
    await other.answer();
    await other.answer();
    // tt2 was already on its way without one; tt1 is asked once, with it.
    expect(other.sent).toEqual([want(2), { ...want(1), logo: true }]);
  });

  it('writes what it found in one batch, not once per title', async () => {
    const h = harness();
    h.queue.want({}, many(1, 5));
    for (let i = 0; i < 5; i++) await h.answer();
    expect(h.remembered).toEqual([]);
    h.advance(100);
    expect(h.remembered).toHaveLength(1);
    expect(h.remembered[0].map((f) => f.metaId)).toEqual(['tt1', 'tt2', 'tt3', 'tt4', 'tt5']);
  });

  it('does not ask again about a title it completed, once its card has the art', async () => {
    const h = harness();
    const screen = {};
    h.queue.want(screen, [want(1), want(2)]);
    await h.answer();
    await h.answer();
    // The cards have their art now: the list no longer wants them.
    h.queue.want(screen, []);
    h.advance(NOTHING_RETRY_MS * 2);
    h.queue.want(screen, []);
    expect(h.asked).toEqual(['tt1', 'tt2']);
  });

  it('asks once more for a completed title that is wanted again later (another profile’s history), then leaves it', async () => {
    const h = harness();
    h.queue.want({}, [want(1)]);
    await h.answer();
    // Still listed while the answer is on its way to the store: not asked again.
    h.advance(DONE_GRACE_MS - 1000);
    expect(h.asked).toHaveLength(1);
    h.advance(1000);
    expect(h.asked).toHaveLength(2);
    await h.answer();
    h.advance(DONE_GRACE_MS * 3);
    expect(h.asked).toHaveLength(2);
  });

  it('asks again soon after a failure, a little later each time, while the title is still wanted', async () => {
    const h = harness();
    const screen = {};
    h.queue.want(screen, [want(1)]);
    await h.answer({ failed: true });
    h.advance(FAILED_RETRY_MS - 1000);
    expect(h.asked).toHaveLength(1);
    h.advance(1000);
    expect(h.asked).toHaveLength(2);
    await h.answer({ failed: true });
    h.advance(FAILED_RETRY_MS);
    expect(h.asked).toHaveLength(2);
    h.advance(FAILED_RETRY_MS);
    expect(h.asked).toHaveLength(3);
    // Third time lucky: remembered (the card has its art, so the list stops wanting it), and
    // left alone from then on.
    await h.answer();
    h.advance(100);
    expect(h.remembered).toHaveLength(1);
    h.queue.want(screen, []);
    h.advance(NOTHING_RETRY_MS);
    expect(h.asked).toHaveLength(3);
  });

  it('does not retry a failure for a list that has gone', async () => {
    const h = harness();
    const screen = {};
    h.queue.want(screen, [want(1)]);
    await h.answer({ failed: true });
    h.queue.release(screen);
    h.advance(FAILED_RETRY_MS * 10);
    expect(h.asked).toHaveLength(1);
  });

  it('rests for hours when every source answered and had nothing, then asks once more', async () => {
    const h = harness();
    h.queue.want({}, [want(1)]);
    await h.answer({ card: { name: 'Only a name' } });
    h.advance(100);
    expect(h.remembered[0][0].card).toEqual({ name: 'Only a name' });
    h.advance(NOTHING_RETRY_MS - 1000);
    expect(h.asked).toHaveLength(1);
    h.advance(1000);
    expect(h.asked).toHaveLength(2);
  });

  it('treats a resolver that throws as a failure, not as the end', async () => {
    let n = 0;
    let t = 0;
    const queue = createArtQueue({ now: () => t, later: () => () => undefined, resolve: async () => (n++, Promise.reject(new Error('boom'))), remember: () => undefined });
    queue.want({}, [want(1)]);
    await new Promise((done) => setTimeout(done, 0));
    expect(queue.active()).toBe(0);
    t += FAILED_RETRY_MS;
    queue.want({}, [want(1)]);
    expect(n).toBe(2);
  });

  it('asks again at once for a title whose remembered picture turned out dead', async () => {
    const h = harness();
    const screen = {};
    h.queue.want(screen, [want(1)]);
    await h.answer();
    h.queue.again('tt1', 'movie');
    expect(h.asked).toEqual(['tt1', 'tt1']);
  });
});

// ---------- Dead links ----------

describe('dead picture links', () => {
  it('knows a TMDB picture by its path, whatever size was asked for', () => {
    expect(artIdentity('https://image.tmdb.org/t/p/w780/a.jpg')).toBe(artIdentity('https://image.tmdb.org/t/p/original/a.jpg'));
    expect(artIdentity('https://images.metahub.space/poster/small/tt1/img')).toBe('https://images.metahub.space/poster/small/tt1/img');
  });

  it('keeps a dead link out for a week, then gives it another chance; survives a restart', () => {
    let t = 1000;
    const gone = new GoneArt(() => t);
    gone.add('https://image.tmdb.org/t/p/w342/dead.jpg');
    expect(gone.has('https://image.tmdb.org/t/p/w1280/dead.jpg')).toBe(true);
    expect(gone.has(P)).toBe(false);
    const again = new GoneArt(() => t);
    again.load(JSON.parse(JSON.stringify(gone)));
    expect(again.has('https://image.tmdb.org/t/p/w342/dead.jpg')).toBe(true);
    t += GONE_FOR_MS + 1;
    expect(gone.has('https://image.tmdb.org/t/p/w342/dead.jpg')).toBe(false);
    const later = new GoneArt(() => t);
    later.load(JSON.parse(JSON.stringify(again)));
    expect(later.has('https://image.tmdb.org/t/p/w342/dead.jpg')).toBe(false);
    again.load('nonsense');
    again.load(null);
  });

  it('turns what was remembered into something an <img> can load, or nothing', () => {
    expect(usableArt(P)).toBe(P);
    expect(usableArt('//img.example/p.jpg')).toBe('https://img.example/p.jpg');
    // A bare TMDB image path, as some trackers send.
    expect(usableArt('/abc123.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc123.jpg');
    expect(usableArt('/abc123.jpg', undefined, 'w1280')).toBe('https://image.tmdb.org/t/p/w1280/abc123.jpg');
    expect(usableArt('/some/page')).toBeUndefined();
    expect(usableArt('poster.jpg')).toBeUndefined();
    expect(usableArt('')).toBeUndefined();
    expect(usableArt(undefined)).toBeUndefined();
    const gone = new GoneArt();
    gone.add(P);
    expect(usableArt(P, gone)).toBeUndefined();
  });

  it('tells "gone" from "the server is having a bad moment"', () => {
    expect(saysGone(404, undefined)).toBe(true);
    expect(saysGone(410, 'text/html')).toBe(true);
    expect(saysGone(403, undefined)).toBe(true);
    // An error page served as 200.
    expect(saysGone(200, 'text/html; charset=utf-8')).toBe(true);
    expect(saysGone(200, 'image/jpeg')).toBe(false);
    expect(saysGone(200, undefined)).toBe(false);
    expect(saysGone(429, 'text/plain')).toBe(false);
    expect(saysGone(500, 'text/html')).toBe(false);
    expect(saysGone(503, undefined)).toBe(false);
  });
});
