// A poster's hover preview in a row: when it may open, how the row makes room for it, and the
// line of facts it shows. The drawing is in CardPreview; the card's part is in cards.tsx.
//
// Nothing here costs a card that is not under the pointer: no card subscribes to anything and
// nothing listens for scrolling. The one card the pointer is on is looked at twice, a quarter of
// a second apart, and that is how "resting on it, and nothing is scrolling" is known.

import type { Enriched } from '../data/hooks';
import { tmdbResized } from '../meta/tmdb';
import { settingsNow } from '../state/settings';
import { useContextMenu } from '../ui/contextmenu';

/** How long the pointer rests on a poster before it opens. */
export const DWELL_MS = 500;
/** How long a card takes to widen, and to close again (the same in styles.css: `.card--preview`). */
export const EXPAND_MS = 340;
/** `--ease-out` in styles.css: the row scrolls in step with a card that widens with it. */
export const EASE_OUT = cubicBezier(0.22, 1, 0.36, 1);
/** A 2:3 poster becomes a 16:9 picture of the same height: this many times as wide. */
export const EXPAND_RATIO = 8 / 3;

/** Previews are wanted (the setting), and motion is not being kept down. */
export function previewsOn(): boolean {
  const a = settingsNow().appearance;
  return a.hoverPreview && !a.reduceMotion && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let waiting: number | undefined;
let pointerX = 0;
const follow = (e: PointerEvent) => void (pointerX = e.clientX);

/**
 * The pointer has come onto a poster (at `x`): `open` runs once it has rested there for DWELL_MS,
 * and is told where on the screen the pointer then is. Resting means the poster is still under
 * the pointer and has not moved meanwhile, so nothing opens while the page or the row scrolls,
 * or under a menu. `warm` runs at the first look, halfway (the picture can be on its way by the
 * time the card opens). One poster waits at a time, and the pointer is only followed while one does.
 */
export function armPreview(el: HTMLElement, x: number, open: (pointerX: number) => void, warm?: () => void) {
  disarmPreview();
  pointerX = x;
  window.addEventListener('pointermove', follow, { passive: true });
  let seen: { x: number; y: number } | undefined;
  const look = () => {
    waiting = undefined;
    // No "leave" comes for a card that scrolled away from the pointer or was covered.
    if (!el.isConnected || !el.matches(':hover')) return disarmPreview();
    const r = el.getBoundingClientRect();
    const still = !!seen && Math.abs(r.left - seen.x) < 1 && Math.abs(r.top - seen.y) < 1;
    if (!seen) warm?.();
    seen = { x: r.left, y: r.top };
    if (still && !useContextMenu.getState().open) {
      disarmPreview();
      open(pointerX);
    } else waiting = window.setTimeout(look, DWELL_MS / 2);
  };
  waiting = window.setTimeout(look, DWELL_MS / 2);
}

/** The pointer left, or pressed: the poster that was waiting to open no longer is. */
export function disarmPreview() {
  window.clearTimeout(waiting);
  waiting = undefined;
  window.removeEventListener('pointermove', follow);
}

let closeOpen: (() => void) | undefined;

/**
 * Only one card is expanded at a time, app-wide: the one opening closes the one before it.
 * Returns what to call when this one is gone.
 */
export function claimPreview(close: () => void): () => void {
  if (closeOpen && closeOpen !== close) closeOpen();
  closeOpen = close;
  return () => {
    if (closeOpen === close) closeOpen = undefined;
  };
}

/** An expanding card and the row it is in, in screen coordinates (see `revealShift`). */
export interface Reveal {
  /** Where the card starts now. It widens from there. */
  cardLeft: number;
  /** How wide it will be. */
  openWidth: number;
  /** Where what must stay in view with it starts: the card itself, or its Top 10 numeral. */
  unitLeft: number;
  /** The part of the row cards rest in (inside its padding). */
  viewLeft: number;
  viewRight: number;
  /** Where the pointer is: on the card. */
  pointerX: number;
}

/** The pointer stays at least this far inside the card it opened, when it was that far in. */
const POINTER_INSET = 12;

/**
 * How far a row scrolls so an expanding card ends up whole and in view; positive scrolls forward
 * (the card moves back). Nothing when it fits; when it cannot fit, its start stays in view. And
 * never so far that the card leaves the pointer that opened it: it would close, the row would go
 * back, and it would open again, for as long as the pointer rested there.
 */
export function revealShift({ cardLeft, openWidth, unitLeft, viewLeft, viewRight, pointerX }: Reveal): number {
  const right = cardLeft + openWidth;
  const shift = unitLeft < viewLeft ? unitLeft - viewLeft : right > viewRight ? Math.min(right - viewRight, unitLeft - viewLeft) : 0;
  const least = Math.min(0, cardLeft - pointerX + POINTER_INSET);
  const most = Math.max(0, right - pointerX - POINTER_INSET);
  return Math.min(Math.max(shift, least), most);
}

/** A CSS `cubic-bezier(x1, y1, x2, y2)` timing function: progress (0..1) for a share of the time (0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // The curve's parameter for this time: x(s) only ever rises, so halving finds it.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

/**
 * The picture a preview opens on, at about the size it is drawn: the card's own backdrop when it
 * has one (it can be on its way before TMDB has answered, and does not change under the text
 * once it has), else TMDB's.
 */
export function previewArt(background: string | undefined, tmdb?: Enriched): string | undefined {
  return tmdbResized(background ?? tmdb?.backdrop, 'w780');
}

/** "1h 52m", "47m". */
export function formatRuntime(minutes: number | undefined): string | undefined {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const m = Math.round(minutes);
  return m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

export interface PreviewFacts {
  year?: string;
  /** The age rating ("PG-13", "TV-MA"). */
  certification?: string;
  /** A movie's running time, or how many seasons a show has. */
  length?: string;
  genres: string[];
}

/** The line under a preview's title, from what the card knows and what TMDB said (when it has). */
export function previewFacts(title: { type: string; year?: string | number }, tmdb: Enriched | undefined): PreviewFacts {
  const d = tmdb?.details;
  // A card's year is whatever its source sent ("2019", "2019-2022", a number): shown as the card shows it.
  const year = (title.year ? String(title.year).trim().slice(0, 9) : '') || (d?.release_date ?? d?.first_air_date)?.slice(0, 4) || undefined;
  const seasons = d?.number_of_seasons;
  const length = title.type === 'movie' ? formatRuntime(d?.runtime) : seasons ? `${seasons} season${seasons === 1 ? '' : 's'}` : formatRuntime(d?.episode_run_time?.[0]);
  return { year, certification: tmdb?.certification || undefined, length, genres: (d?.genres ?? []).slice(0, 2).map((g) => g.name) };
}
