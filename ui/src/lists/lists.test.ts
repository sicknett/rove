import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each test sets the answers by URL; requests are recorded for checking paths and headers.
type Answer = { status?: number; body: unknown; headers?: Record<string, string> };
const routes: [RegExp, (req: { url: string }) => Answer][] = [];
const calls: { url: string; headers: Record<string, string> }[] = [];

vi.mock('../lib/native', () => ({
  NetworkError: class extends Error {},
  docs: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  secrets: { read: vi.fn(async () => null), write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
  nativeFetch: vi.fn(async (req: { url: string; headers?: Record<string, string> }) => {
    calls.push({ url: req.url, headers: req.headers ?? {} });
    const hit = routes.find(([re]) => re.test(req.url));
    const r = hit ? hit[1](req) : { status: 404, body: {} };
    return { status: r.status ?? 200, url: req.url, headers: r.headers ?? {}, body: JSON.stringify(r.body) };
  }),
}));

// Set here so the tests do not depend on what the build's own env file holds.
vi.stubEnv('VITE_TRAKT_CLIENT_ID', 'trakt-id');
vi.stubEnv('VITE_TMDB_API_KEY', 'tmdb-test-key');

const { parseTraktListLink, traktLikedLists, traktListInfo, traktListItems, traktMyLists, traktPublicLists, traktSearchLists } = await import('../tracking/adapters/trakt');
const { mdblistListInfo, mdblistListItems, mdblistMyLists, mdblistSearchLists, mdblistTopLists, parseMdblistLink } = await import('../tracking/adapters/mdblist');
const { readListPage, mediaOf } = await import('./read');
const { listProviderStatus, listSections, mdblistChoice, traktChoice, TRAKT_NEEDS_APP_ID } = await import('./providers');
type ListSetup = import('./providers').ListSetup;

const account = { provider: 'trakt' as const, accessToken: 'tok', username: 'sean' };
const noServer = () => undefined;
const lastUrl = () => new URL(calls[calls.length - 1].url);

beforeEach(() => {
  routes.length = 0;
  calls.length = 0;
});

describe('Trakt list items', () => {
  const page = [
    { rank: 1, type: 'show', show: { title: 'Breaking Bad', year: 2008, ids: { trakt: 1, imdb: 'tt0903747', tmdb: 1396 }, overview: 'A teacher.', rating: 9.28, genres: ['drama'] } },
    { rank: 2, type: 'movie', movie: { title: 'No IMDb', year: 2020, ids: { trakt: 2, tmdb: 77 } } },
    { rank: 3, type: 'season', season: { number: 1, ids: { trakt: 3 } }, show: { title: 'S', ids: { imdb: 'tt1' } } },
    { rank: 4, type: 'person', person: { name: 'P', ids: { trakt: 4 } } },
    { rank: 5, type: 'movie', movie: { title: 'No ids at all', ids: { trakt: 5 } } },
  ];

  it('reads a public list by number with the app id alone, honouring type and sort', async () => {
    routes.push([/\/lists\/35016391\/items/, () => ({ body: page, headers: { 'X-Pagination-Page': '1', 'X-Pagination-Page-Count': '2' } })]);
    // An account is at hand, but a public list is read without its token.
    const r = await traktListItems({ id: 35016391 }, { media: 'show', sortBy: 'rank', sortHow: 'asc', page: 1, limit: 40 }, account);
    expect(calls[0].url).toBe('https://api.trakt.tv/lists/35016391/items/show/rank/asc?page=1&limit=40&extended=full');
    expect(calls[0].headers).toMatchObject({ 'trakt-api-version': '2', 'trakt-api-key': 'trakt-id' });
    expect(calls[0].headers.Authorization).toBeUndefined();
    // Movies and shows only; an IMDb id when there is one, else the TMDB number.
    expect(r.items).toEqual([
      { metaId: 'tt0903747', type: 'series', name: 'Breaking Bad', year: 2008, tmdbId: 1396, overview: 'A teacher.', rating: 9.28, genres: ['drama'] },
      { metaId: 'tmdb:77', type: 'movie', name: 'No IMDb', year: 2020, tmdbId: 77, overview: undefined, rating: undefined, genres: undefined },
    ]);
    expect(r.next).toBe(2);
  });

  it('stops at Trakt’s last page, and without a page count goes by whether the page was full', async () => {
    routes.push([/\/lists\/7\/items/, () => ({ body: page, headers: { 'x-pagination-page-count': '2' } })]);
    expect((await traktListItems({ id: 7 }, { page: 2, limit: 40 })).next).toBeNull();

    routes.length = 0;
    routes.push([/\/lists\/7\/items/, () => ({ body: page })]);
    expect((await traktListItems({ id: 7 }, { page: 1, limit: 40 })).next).toBeNull();
    expect((await traktListItems({ id: 7 }, { page: 1, limit: 5 })).next).toBe(2);

    routes.length = 0;
    routes.push([/\/lists\/7\/items/, () => ({ body: [] })]);
    expect(await traktListItems({ id: 7 }, { page: 3, limit: 40 })).toEqual({ items: [], next: null });
  });

  it('asks for both kinds in the list’s own order when a source names neither (or says "original")', async () => {
    routes.push([/\/users\/sean\/lists\/machete\/items/, () => ({ body: [] })]);
    await traktListItems({ user: 'sean', slug: 'machete' }, { sortBy: 'original', sortHow: 'desc', page: 1, limit: 40 });
    expect(lastUrl().pathname).toBe('/users/sean/lists/machete/items/movie,show');
    await traktListItems({ user: 'sean', slug: 'machete' }, { media: 'movie', sortBy: 'popularity', sortHow: 'desc', page: 1, limit: 40 });
    expect(lastUrl().pathname).toBe('/users/sean/lists/machete/items/movie/popularity/desc');
  });

  it('reads the account’s own things with its token, and says so when no one is signed in', async () => {
    routes.push([/\/users\/me\//, () => ({ body: [] })]);
    await traktListItems({ watchlist: true }, { media: 'movie', page: 1, limit: 40 }, account);
    expect(lastUrl().pathname).toBe('/users/me/watchlist/movies');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    await traktListItems({ watchlist: true }, { sortBy: 'added', sortHow: 'desc', page: 1, limit: 40 }, account);
    expect(lastUrl().pathname).toBe('/users/me/watchlist/all/added/desc');
    await traktListItems({ user: 'me', slug: '55' }, { page: 1, limit: 40 }, account);
    expect(lastUrl().pathname).toBe('/users/me/lists/55/items/movie,show');

    calls.length = 0;
    await expect(traktListItems({ watchlist: true }, { page: 1, limit: 40 }, null)).rejects.toMatchObject({ kind: 'unauthorized', message: 'Sign in to Trakt to read this list.' });
    expect(calls).toHaveLength(0);
  });

  it('takes an answer that is not a list for a failed read, not an empty list', async () => {
    routes.push([/\/lists\/7\/items/, () => ({ body: { error: 'nope' } })]);
    await expect(traktListItems({ id: 7 }, { page: 1, limit: 40 })).rejects.toMatchObject({ kind: 'retry' });
  });
});

describe('Trakt lists to pick from', () => {
  const list = (id: number, name: string, extra: object = {}) => ({ name, description: 'd', privacy: 'public', item_count: 5, likes: 3, ids: { trakt: id, slug: name.toLowerCase() }, user: { username: 'justin', name: 'Justin N', ids: { slug: 'justin' } }, ...extra });

  it('maps the account’s lists, its likes, popular lists and a search', async () => {
    routes.push(
      [/\/users\/me\/lists$/, () => ({ body: [{ ...list(55, 'Mine'), user: undefined, privacy: 'private' }, { name: 'No id', ids: {} }] })],
      [/\/users\/me\/likes\/lists/, () => ({ body: [{ liked_at: 'x', type: 'list', list: list(56, 'Liked') }] })],
      [/\/lists\/trending/, () => ({ body: [{ like_count: 5, comment_count: 1, list: list(57, 'Hot') }] })],
      [/\/search\/list/, () => ({ body: [{ type: 'list', score: 3, list: list(58, 'Found') }] })],
    );
    expect(await traktMyLists(account)).toEqual([{ id: 55, slug: 'mine', name: 'Mine', description: 'd', itemCount: 5, likes: 3, owner: undefined, ownerSlug: undefined, privacy: 'private' }]);
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect((await traktLikedLists(account)).map((l) => l.id)).toEqual([56]);
    expect((await traktPublicLists('trending')).map((l) => [l.id, l.owner, l.ownerSlug])).toEqual([[57, 'Justin N', 'justin']]);
    // Public lists and the search go out without a token.
    expect(calls[2].headers.Authorization).toBeUndefined();
    expect((await traktSearchLists('star wars')).map((l) => l.name)).toEqual(['Found']);
    expect(lastUrl().searchParams.get('query')).toBe('star wars');
  });

  it('turns a private list of the account’s into a source read as that account, a public one by number', () => {
    expect(traktChoice({ id: 55, name: 'Mine', privacy: 'private', itemCount: 5 }, true)).toMatchObject({ title: 'Mine', detail: 'Private · 5 titles', source: { provider: 'trakt', traktUser: 'me', traktSlug: '55', title: 'Mine' } });
    expect(traktChoice({ id: 56, name: 'Open', privacy: 'public', itemCount: 1 }, true).source).toMatchObject({ provider: 'trakt', traktListId: 56 });
    expect(traktChoice({ id: 57, name: 'Theirs', owner: 'Justin N', itemCount: 1200, likes: 1 })).toMatchObject({ detail: `Justin N · ${(1200).toLocaleString()} titles · 1 like`, source: { traktListId: 57 } });
  });

  it('reads a pasted link, a number, or owner/name', async () => {
    expect(parseTraktListLink('https://trakt.tv/users/sean/lists/star-wars-in-machete-order?sort=rank,asc')).toEqual({ user: 'sean', slug: 'star-wars-in-machete-order' });
    expect(parseTraktListLink('https://app.trakt.tv/lists/2180135')).toEqual({ id: 2180135 });
    expect(parseTraktListLink(' 55 ')).toEqual({ id: 55 });
    expect(parseTraktListLink('sean/machete')).toEqual({ user: 'sean', slug: 'machete' });
    expect(parseTraktListLink('https://example.com/whatever')).toBeNull();

    routes.push([/\/users\/sean\/lists\/machete$/, () => ({ body: list(55, 'Machete') })], [/\/lists\/404$/, () => ({ status: 404, body: {} })]);
    expect(await traktListInfo({ user: 'sean', slug: 'machete' })).toMatchObject({ id: 55, name: 'Machete' });
    expect(await traktListInfo({ id: 404 })).toBeNull();
  });
});

describe('MDBList list items', () => {
  const key = 'mdb-key';

  it('asks for posters and one list of both kinds, and reads the split answer back in list order', async () => {
    routes.push([
      /\/lists\/123\/items/,
      () => ({
        body: {
          movies: [
            { id: 917496, rank: 1, title: 'Beetlejuice Beetlejuice', imdb_id: 'tt2049403', ids: { imdb: 'tt2049403', tmdb: 917496 }, mediatype: 'movie', release_year: 2024, poster: '/p.jpg' },
            { id: 5, rank: 3, title: 'No IMDb', imdb_id: null, mediatype: 'movie', release_year: 2001 },
          ],
          shows: [{ id: 258902, rank: 2, title: 'English Teacher', imdb_id: 'tt20782190', tvdb_id: 421968, mediatype: 'show', release_year: 2024 }],
        },
        headers: { 'X-Has-More': 'false' },
      }),
    ]);
    const r = await mdblistListItems(key, { id: 123 }, { offset: 0, limit: 40 });
    const url = lastUrl();
    expect(url.origin + url.pathname).toBe('https://api.mdblist.com/lists/123/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '40', unified: 'true', append_to_response: 'poster', apikey: key });
    expect(r.items).toEqual([
      { metaId: 'tt2049403', type: 'movie', name: 'Beetlejuice Beetlejuice', year: 2024, tmdbId: 917496, poster: '/p.jpg' },
      { metaId: 'tt20782190', type: 'series', name: 'English Teacher', year: 2024, tmdbId: 258902, poster: undefined },
      { metaId: 'tmdb:5', type: 'movie', name: 'No IMDb', year: 2001, tmdbId: 5, poster: undefined },
    ]);
    expect(r.next).toBeNull();
  });

  it('reads one unified list too, and passes type and sort when the source has them', async () => {
    routes.push([/\/lists\/u\/top\/items/, () => ({ body: [{ id: 1, title: 'A', imdb_id: 'tt1', mediatype: 'show' }, { id: 2, title: 'Episode', mediatype: 'episode' }, { id: 3, mediatype: 'movie' }] })]);
    const r = await mdblistListItems(key, { user: 'u', slug: 'top' }, { media: 'show', sortBy: 'released', sortHow: 'desc', offset: 0, limit: 40 });
    expect(r.items.map((i) => i.metaId)).toEqual(['tt1']);
    expect(Object.fromEntries(lastUrl().searchParams)).toMatchObject({ mediatype: 'show', sort: 'released', order: 'desc' });
    // A sort MDBList does not have (collection files say "original") is not sent.
    await mdblistListItems(key, { user: 'u', slug: 'top' }, { sortBy: 'original', offset: 0, limit: 40 });
    expect(lastUrl().searchParams.has('sort')).toBe(false);
  });

  it('follows the cursor MDBList hands out, and counts titles it skipped', async () => {
    const titles = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, title: `T${from + i}`, imdb_id: i === 0 ? null : `tt${from + i}`, tmdb_id: null, ids: i === 0 ? {} : undefined, mediatype: 'movie' }));
    routes.push([/\/lists\/9\/items/, (req) => (req.url.includes('cursor=abc') ? { body: { movies: titles(100, 2), shows: [] } } : { body: { movies: titles(1, 3), shows: [], pagination: { next_cursor: 'abc' } } })]);
    const first = await mdblistListItems(key, { id: 9 }, { offset: 0, limit: 3 });
    // Three came back, one without any id: the next page still starts after all three.
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe(3);
    const second = await mdblistListItems(key, { id: 9 }, { offset: 3, limit: 3 });
    expect(lastUrl().searchParams.get('cursor')).toBe('abc');
    expect(lastUrl().searchParams.has('offset')).toBe(false);
    expect(second.next).toBeNull();
  });

  it('goes by count when MDBList says nothing about paging: a full page has a next one', async () => {
    routes.push([/\/watchlist\/items/, () => ({ body: [{ id: 1, title: 'A', imdb_id: 'tt1', mediatype: 'movie' }, { id: 2, title: 'B', imdb_id: 'tt2', mediatype: 'movie' }] })]);
    expect((await mdblistListItems(key, { watchlist: true }, { offset: 0, limit: 2 })).next).toBe(2);
    expect((await mdblistListItems(key, { watchlist: true }, { offset: 4, limit: 40 })).next).toBeNull();
    expect(lastUrl().searchParams.get('offset')).toBe('4');
  });

  it('takes an empty or unreadable answer for a failed read', async () => {
    routes.push([/\/lists\/1\/items/, () => ({ body: null })]);
    await expect(mdblistListItems(key, { id: 1 }, { offset: 0, limit: 40 })).rejects.toMatchObject({ kind: 'retry' });
  });
});

describe('MDBList lists to pick from', () => {
  it('maps the key’s lists, top lists and a search, and refuses an answer that is not a list', async () => {
    routes.push(
      [/\/lists\/user\?/, () => ({ body: [{ id: 1, name: 'Mine', slug: 'mine', items: 12, likes: 0, mediatype: 'movie', user_name: 'me' }, { name: 'no id' }] })],
      [/\/lists\/top/, () => ({ body: [{ id: 2, name: 'Top', slug: 'top', items: 100, likes: 9, mediatype: 'show', user_name: 'linas' }] })],
      [/\/lists\/search/, () => ({ body: { error: 'bad' } })],
    );
    expect(await mdblistMyLists('k')).toEqual([{ id: 1, name: 'Mine', slug: 'mine', owner: 'me', description: undefined, mediatype: 'movie', itemCount: 12, likes: 0 }]);
    const [top] = await mdblistTopLists('k');
    expect(mdblistChoice(top)).toMatchObject({ title: 'Top', detail: 'linas · Shows · 100 titles · 9 likes', source: { provider: 'mdblist', mdblistId: 2, title: 'Top' } });
    await expect(mdblistSearchLists('k', 'x')).rejects.toMatchObject({ kind: 'retry' });
  });

  it('finds the list a pasted link points to', async () => {
    expect(parseMdblistLink('https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week?x=1')).toEqual({ user: 'linaspurinis', slug: 'top-watched-movies-of-the-week' });
    expect(parseMdblistLink('2194')).toEqual({ id: 2194 });
    expect(parseMdblistLink('not a link')).toBeNull();
    // Older answers wrap the one list in an array.
    routes.push([/\/lists\/linaspurinis\/top\?/, () => ({ body: [{ id: 2194, name: 'Top Watched', items: 20 }] })], [/\/lists\/5\?/, () => ({ status: 404, body: {} })]);
    expect(await mdblistListInfo('k', { user: 'linaspurinis', slug: 'top' })).toMatchObject({ id: 2194, name: 'Top Watched', itemCount: 20 });
    expect(await mdblistListInfo('k', { id: 5 })).toBeNull();
  });
});

describe('a list page as cards', () => {
  it('gives Trakt titles ordinary card ids and TMDB’s poster', async () => {
    routes.push(
      [/api\.trakt\.tv\/lists\/9\/items\/show\/rank\/asc/, () => ({ body: [{ type: 'show', show: { title: 'Breaking Bad', year: 2008, ids: { imdb: 'tt0903747', tmdb: 1396 }, rating: 9.28 } }, { type: 'movie', movie: { title: 'Only TMDB', year: 1999, ids: { tmdb: 77 } } }], headers: { 'x-pagination-page-count': '1' } })],
      [/api\.themoviedb\.org\/3\/tv\/1396/, () => ({ body: { poster_path: '/bb.jpg', backdrop_path: '/bb-wide.jpg' } })],
      [/api\.themoviedb\.org\/3\/movie\/77/, () => ({ status: 404, body: {} })],
    );
    // As the shipped collections carry it. 0 is the first page for every source.
    const source = { provider: 'trakt', traktListId: 9, mediaType: 'TV', sortBy: 'rank', sortHow: 'asc', title: 'AMC+' };
    const r = await readListPage(source, 0, { trakt: null, mdblistKey: null, server: noServer });
    expect(r.next).toBeNull();
    expect(r.items).toEqual([
      { id: 'tt0903747', type: 'series', name: 'Breaking Bad', releaseInfo: '2008', description: undefined, imdbRating: '9.3', genres: undefined, tmdbId: 1396, poster: 'https://image.tmdb.org/t/p/w342/bb.jpg', background: 'https://image.tmdb.org/t/p/w1280/bb-wide.jpg' },
      // TMDB had nothing for it: it goes without, and the screen asks the metadata addons.
      { id: 'tmdb:77', type: 'movie', name: 'Only TMDB', releaseInfo: '1999', description: undefined, imdbRating: undefined, genres: undefined, tmdbId: 77 },
    ]);
  });

  it('uses MDBList’s own poster, and reads nothing without a key', async () => {
    routes.push([/api\.mdblist\.com\/lists\/3\/items/, () => ({ body: { movies: [{ id: 1, rank: 1, title: 'A', imdb_id: 'tt1', mediatype: 'movie', release_year: 2020, poster: '/a.jpg' }, { id: 2, rank: 2, title: 'B', imdb_id: 'tt2', mediatype: 'movie', poster: 'https://img.example/b.jpg' }], shows: [] } })]);
    const source = { provider: 'mdblist', mdblistId: 3 };
    const r = await readListPage(source, 0, { trakt: null, mdblistKey: 'k', server: noServer });
    expect(r.items.map((i) => i.poster)).toEqual(['https://image.tmdb.org/t/p/w342/a.jpg', 'https://img.example/b.jpg']);
    calls.length = 0;
    expect(await readListPage(source, 0, { trakt: null, mdblistKey: null, server: noServer })).toEqual({ items: [], next: null });
    expect(calls).toHaveLength(0);
  });

  it('reads the media type collection files write', () => {
    expect([mediaOf({ mediaType: 'TV' }), mediaOf({ mediaType: 'MOVIE' }), mediaOf({ mediaType: 'series' }), mediaOf({}), mediaOf({ mediaType: 'all' })]).toEqual(['show', 'movie', 'show', undefined, undefined]);
  });
});

describe('which providers can be used', () => {
  const server = { id: 's1', kind: 'jellyfin' as const, name: 'Den', url: 'http://nas', token: 't', enabled: true, addedAt: 1 };
  const none: ListSetup = { traktApp: false, tracker: null, savedMdblistKey: null, servers: [] };

  it('says what is missing, and where it is put right', () => {
    // No setting gives a build its app id, so this one points nowhere.
    expect(listProviderStatus('trakt', none)).toMatchObject({ ready: false, missing: TRAKT_NEEDS_APP_ID });
    expect(listProviderStatus('trakt', none).section).toBeUndefined();
    expect(TRAKT_NEEDS_APP_ID).toBe('Trakt lists need ROVE’s Trakt app id in this build');
    expect(listProviderStatus('mdblist', none)).toMatchObject({ ready: false, missing: 'Add an MDBList key', section: 'accounts' });
    expect(listProviderStatus('server', none)).toMatchObject({ ready: false, missing: 'Connect a media server', section: 'servers' });
    expect(listProviderStatus('server', { ...none, servers: [{ ...server, enabled: false }] })).toMatchObject({ ready: false, missing: 'This server is switched off', section: 'servers' });
  });

  it('offers public Trakt lists with the app id alone, and the account’s own once signed in', () => {
    const signedOut = { ...none, traktApp: true };
    expect(listProviderStatus('trakt', signedOut)).toMatchObject({ ready: true, summary: 'Public lists', section: 'accounts' });
    expect(listSections('trakt', signedOut).map((s) => s.id)).toEqual(['popular', 'trending', 'search', 'link']);
    const signedIn = { ...signedOut, tracker: account };
    expect(listProviderStatus('trakt', signedIn)).toMatchObject({ ready: true, hint: 'Signed in as sean' });
    expect(listSections('trakt', signedIn).map((s) => s.id)).toEqual(['mine', 'liked', 'popular', 'trending', 'search', 'link']);
    // Another tracker connected: Trakt's public lists still work.
    expect(listProviderStatus('trakt', { ...signedOut, tracker: { provider: 'pmdb', apiKey: 'x' } }).ready).toBe(true);
  });

  it('reads MDBList with a connected tracker’s key or one saved for lists, and lists servers that are on', () => {
    expect(listProviderStatus('mdblist', { ...none, tracker: { provider: 'mdblist', apiKey: 'k' } })).toMatchObject({ ready: true, summary: 'Connected' });
    expect(listProviderStatus('mdblist', { ...none, savedMdblistKey: 'k' })).toMatchObject({ ready: true, summary: 'Key saved' });
    const two = { ...none, servers: [server, { ...server, id: 's2', name: 'Off', enabled: false }] };
    expect(listProviderStatus('server', two)).toMatchObject({ ready: true, summary: '1 server' });
    expect(listSections('server', two)).toMatchObject([{ id: 's1', label: 'Den', kind: 'browse' }]);
  });
});
