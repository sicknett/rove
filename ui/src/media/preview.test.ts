// A poster's hover preview: when it opens, how the row makes room, and the facts it shows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({
  docs: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  secrets: { read: async () => null, write: async () => undefined, remove: async () => undefined },
  debouncedWriter: () => ({ save: () => undefined, flush: async () => undefined }),
}));

// The timers, the pointer and the "reduce motion" query are the window's; there is none under the tests.
let reducedMotion = false;
const listeners = new Map<string, (e: { clientX: number }) => void>();
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (t: number) => clearTimeout(t),
  matchMedia: () => ({ matches: reducedMotion }),
  addEventListener: (type: string, fn: (e: { clientX: number }) => void) => void listeners.set(type, fn),
  removeEventListener: (type: string) => void listeners.delete(type),
});
const movePointer = (clientX: number) => listeners.get('pointermove')?.({ clientX });

const { armPreview, claimPreview, cubicBezier, disarmPreview, DWELL_MS, EASE_OUT, formatRuntime, previewArt, previewFacts, previewsOn, revealShift } = await import('./preview');
const { DEFAULT_SETTINGS, useSettings } = await import('../state/settings');
const { useContextMenu } = await import('../ui/contextmenu');

/** A poster as the waiting looks at it: under the pointer or not, and where it is. */
function poster() {
  const p = { hovered: true, x: 100, y: 200, isConnected: true, matches: () => p.hovered, getBoundingClientRect: () => ({ left: p.x, top: p.y }) };
  return p;
}
const asElement = (p: ReturnType<typeof poster>) => p as unknown as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  useContextMenu.setState({ open: null });
});
afterEach(() => {
  disarmPreview();
  vi.useRealTimers();
});

describe('when a poster opens', () => {
  it('after the pointer has rested on it for the dwell, and not before', () => {
    const open = vi.fn();
    armPreview(asElement(poster()), 150, open);
    vi.advanceTimersByTime(DWELL_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DWELL_MS * 4);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('not when the pointer only passed over it', () => {
    const open = vi.fn();
    const p = poster();
    armPreview(asElement(p), 150, open);
    vi.advanceTimersByTime(DWELL_MS / 2 - 10);
    disarmPreview();
    vi.advanceTimersByTime(DWELL_MS * 4);
    expect(open).not.toHaveBeenCalled();
    // Nor when it went without a "leave" (the card scrolled away from under it).
    armPreview(asElement(p), 150, open);
    p.hovered = false;
    vi.advanceTimersByTime(DWELL_MS * 4);
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('not while the page or the row is scrolling: only once the poster has stopped moving', () => {
    const open = vi.fn();
    const p = poster();
    armPreview(asElement(p), 150, open);
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(DWELL_MS / 2);
      p.x -= 40;
    }
    expect(open).not.toHaveBeenCalled();
    // It has stopped: the next look records where, the one after finds it still there.
    vi.advanceTimersByTime(DWELL_MS);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('not under a menu, and then once the menu has gone', () => {
    const open = vi.fn();
    useContextMenu.setState({ open: { x: 0, y: 0, items: [] } });
    armPreview(asElement(poster()), 150, open);
    vi.advanceTimersByTime(DWELL_MS * 3);
    expect(open).not.toHaveBeenCalled();
    useContextMenu.setState({ open: null });
    vi.advanceTimersByTime(DWELL_MS / 2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('one poster waits at a time, and its picture is asked for halfway', () => {
    const first = vi.fn();
    const second = vi.fn();
    const warm = vi.fn();
    armPreview(asElement(poster()), 150, first);
    vi.advanceTimersByTime(DWELL_MS / 2);
    armPreview(asElement(poster()), 150, second, warm);
    vi.advanceTimersByTime(DWELL_MS / 2);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DWELL_MS / 2);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('is told where the pointer is by then, and follows it only while a poster waits', () => {
    const open = vi.fn();
    expect(listeners.size).toBe(0);
    armPreview(asElement(poster()), 150, open);
    movePointer(190);
    movePointer(231);
    vi.advanceTimersByTime(DWELL_MS);
    expect(open).toHaveBeenCalledWith(231);
    expect(listeners.size).toBe(0);
    // One that never opened stops following too.
    armPreview(asElement(poster()), 150, open);
    expect(listeners.size).toBe(1);
    disarmPreview();
    expect(listeners.size).toBe(0);
  });

  it('only with the setting on and motion not reduced', () => {
    expect(previewsOn()).toBe(true);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, hoverPreview: false } } });
    expect(previewsOn()).toBe(false);
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance, reduceMotion: true } } });
    expect(previewsOn()).toBe(false);
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    reducedMotion = true;
    expect(previewsOn()).toBe(false);
  });
});

describe('one preview at a time', () => {
  it('opening one closes the one before, and a closed one is forgotten', () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    const closeC = vi.fn();
    const goneA = claimPreview(closeA);
    const goneB = claimPreview(closeB);
    expect(closeA).toHaveBeenCalledTimes(1);
    // The first going (it was already told to close) does not disturb the second.
    goneA();
    goneB();
    claimPreview(closeC)();
    expect(closeB).not.toHaveBeenCalled();
    expect(closeC).not.toHaveBeenCalled();
  });
});

describe('making room in the row', () => {
  // The row shows cards between 40 and 1000; a card opens to 470 wide, from 176.
  const row = { viewLeft: 40, viewRight: 1000, openWidth: 470 };
  const card = (cardLeft: number, more: Partial<Parameters<typeof revealShift>[0]> = {}) => revealShift({ ...row, cardLeft, unitLeft: cardLeft, pointerX: cardLeft + 88, ...more });

  it('does not move for a card that fits when open', () => {
    expect(card(40)).toBe(0);
    expect(card(530)).toBe(0);
  });

  it('scrolls forward just enough for a card that would end past the edge', () => {
    expect(card(700)).toBe(170);
    // The last card of the row is no different: the row grows by what the card does.
    expect(card(824)).toBe(294);
  });

  it('scrolls back for a card that starts before the edge (half under the row\'s start)', () => {
    expect(card(-60, { pointerX: 100 })).toBe(-100);
  });

  it('brings a Top 10 card\'s numeral into view with it', () => {
    expect(card(60, { unitLeft: -10 })).toBe(-50);
    expect(card(700, { unitLeft: 640 })).toBe(170);
  });

  it('keeps the card\'s start in view when the row is too narrow for the whole of it', () => {
    expect(card(100, { viewRight: 400 })).toBe(60);
    expect(card(40, { viewRight: 400 })).toBe(0);
  });

  it('never takes the card from under the pointer that opened it', () => {
    // The pointer is on the sliver of a card that shows past the row's padding: scrolling the
    // card wholly into view would leave the pointer beside it, and it would close and reopen.
    const shift = card(990, { pointerX: 1010 });
    expect(shift).toBeLessThan(990 + 470 - 1000);
    expect(990 - shift).toBeLessThan(1010);
    expect(990 - shift + 470).toBeGreaterThan(1010);
    // And at the other end: on the visible part of a card that starts far before the edge.
    const back = card(-150, { pointerX: 20 });
    expect(-150 - back).toBeLessThan(20);
    expect(-150 - back + 470).toBeGreaterThan(20);
    // A pointer at the card's very edge is not a reason to move a card that fits.
    expect(card(530, { pointerX: 531 })).toBe(0);
  });
});

describe('the curve the row scrolls on', () => {
  it('starts and ends where a CSS timing function does', () => {
    expect(EASE_OUT(0)).toBe(0);
    expect(EASE_OUT(1)).toBe(1);
    expect(EASE_OUT(-1)).toBe(0);
    expect(EASE_OUT(2)).toBe(1);
  });

  it('is the straight line for linear control points', () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const t of [0.1, 0.25, 0.5, 0.9]) expect(linear(t)).toBeCloseTo(t, 5);
  });

  it('follows the curve for ease-out and the app\'s own', () => {
    // CSS ease-out is cubic-bezier(0, 0, 0.58, 1). Halfway along that curve (s = 0.5) the time
    // is 3(0.58)(0.25)(0.5) + 0.125 = 0.3425 and the progress 3(0.25)(0.5) + 0.125 = 0.5.
    expect(cubicBezier(0, 0, 0.58, 1)(0.3425)).toBeCloseTo(0.5, 5);
    // --ease-out is fast first: most of the way after a third of the time, and never backwards.
    expect(EASE_OUT(1 / 3)).toBeGreaterThan(0.8);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(EASE_OUT(t)).toBeGreaterThanOrEqual(last);
      last = EASE_OUT(t);
    }
  });
});

describe('the facts under a preview\'s title', () => {
  it('a movie: year, age rating, running time, two genres', () => {
    const tmdb = { certification: 'PG-13', details: { id: 1, runtime: 112, release_date: '2024-03-01', genres: [{ id: 1, name: 'Drama' }, { id: 2, name: 'Crime' }, { id: 3, name: 'Thriller' }] } };
    expect(previewFacts({ type: 'movie', year: '2024' }, tmdb)).toEqual({ year: '2024', certification: 'PG-13', length: '1h 52m', genres: ['Drama', 'Crime'] });
  });

  it('a show: seasons instead of a running time', () => {
    const facts = previewFacts({ type: 'series', year: '2008-2013' }, { certification: 'TV-MA', details: { id: 2, number_of_seasons: 5, episode_run_time: [47] } });
    expect(facts).toEqual({ year: '2008-2013', certification: 'TV-MA', length: '5 seasons', genres: [] });
    expect(previewFacts({ type: 'series' }, { details: { id: 3, number_of_seasons: 1, first_air_date: '2026-01-09' } })).toMatchObject({ year: '2026', length: '1 season' });
    expect(previewFacts({ type: 'series' }, { details: { id: 4, episode_run_time: [47] } }).length).toBe('47m');
  });

  it('what the card knows before TMDB has answered, and nothing made up', () => {
    expect(previewFacts({ type: 'movie', year: '2019' }, undefined)).toEqual({ year: '2019', certification: undefined, length: undefined, genres: [] });
    expect(previewFacts({ type: 'movie' }, {})).toEqual({ year: undefined, certification: undefined, length: undefined, genres: [] });
    expect(previewFacts({ type: 'movie', year: 2021 }, { certification: '', details: { id: 5, runtime: 0 } })).toEqual({ year: '2021', certification: undefined, length: undefined, genres: [] });
  });

  it('running times', () => {
    expect(formatRuntime(47)).toBe('47m');
    expect(formatRuntime(60)).toBe('1h');
    expect(formatRuntime(112)).toBe('1h 52m');
    expect(formatRuntime(0)).toBeUndefined();
    expect(formatRuntime(undefined)).toBeUndefined();
  });
});

describe('the picture a preview opens on', () => {
  it('is the card\'s own backdrop at the size it is drawn, else TMDB\'s', () => {
    expect(previewArt('https://image.tmdb.org/t/p/w1280/a.jpg')).toBe('https://image.tmdb.org/t/p/w780/a.jpg');
    expect(previewArt('https://image.tmdb.org/t/p/w1280/a.jpg', { backdrop: 'https://image.tmdb.org/t/p/original/b.jpg' })).toBe('https://image.tmdb.org/t/p/w780/a.jpg');
    expect(previewArt(undefined, { backdrop: 'https://image.tmdb.org/t/p/original/b.jpg' })).toBe('https://image.tmdb.org/t/p/w780/b.jpg');
    // A picture from anywhere else is used as it is.
    expect(previewArt('https://example.org/art/c.jpg')).toBe('https://example.org/art/c.jpg');
    expect(previewArt(undefined, {})).toBeUndefined();
  });
});
