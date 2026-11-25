// Click and drag to scroll a horizontal strip with the mouse, the way a touch screen does it:
// the strip follows the pointer, carries on a little when let go, and comes to rest on a card.
//
// It costs nothing until a mouse button goes down on the strip: three listeners on the strip
// itself, and the pointer is only followed while the button is held.

import { useEffect } from 'react';

/** The pointer has to move this far with the button down before it is a drag and not a click. */
const THRESHOLD = 6;
/** How long the strip takes to come to rest after it is let go. */
const COAST_MS = 520;
/** How far a release carries: this many milliseconds of the speed it was let go at. */
const CARRY_MS = 260;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Where the strip may come to rest: with one of its children at its start, or at its very end. */
export function restingPlaces(starts: number[], max: number): number[] {
  const places = starts.map((s) => Math.round(s)).filter((s) => s >= 0 && s < max);
  return [...new Set([0, ...places, Math.max(0, Math.round(max))])].sort((a, b) => a - b);
}

/** The resting place nearest to `wanted`. */
export function nearestPlace(places: number[], wanted: number): number {
  let best = places[0] ?? 0;
  for (const p of places) if (Math.abs(p - wanted) < Math.abs(best - wanted)) best = p;
  return best;
}

/** A drag of at least this far moves the strip on by a card, even when it ends nearer the one it left. */
const COMMIT = 24;

/**
 * Where a strip dragged from `from` and wanting to stop at `wanted` comes to rest: the nearest
 * place, but never back where it started when it was really dragged: then at least the next
 * place in the direction it went.
 */
export function placeAfterDrag(places: number[], from: number, wanted: number): number {
  const to = nearestPlace(places, wanted);
  const moved = wanted - from;
  if (Math.abs(moved) < COMMIT || (to - from) * moved > 0) return to;
  const onward = moved > 0 ? places.filter((p) => p > from + 1) : places.filter((p) => p < from - 1).reverse();
  return onward[0] ?? to;
}

/** The speed (px per ms) over the last tenth of a second of `samples` (oldest first). */
export function releaseSpeed(samples: { t: number; x: number }[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= 100);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
}

interface Options {
  /** Come to rest with a child at the strip's start (rows of cards). Off, it rests where it stops. */
  snap?: boolean;
  /** A drag has begun: whatever else was moving the strip should let go of it. */
  onDragStart?: () => void;
}

/**
 * Makes `ref`'s element scroll sideways by dragging it with the mouse. While dragging the element
 * carries `is-dragging` (styles.css turns snapping and the cards' own hover off), and the click
 * that would follow the drag is swallowed, so letting go over a card does not open it.
 */
export function useDragScroll(ref: React.RefObject<HTMLElement | null>, { snap = false, onDragStart }: Options = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startLeft = 0;
    let held = false;
    let dragging = false;
    let swallowClick = false;
    let pointer = -1;
    let coast: number | undefined;
    let idle: number | undefined;
    let samples: { t: number; x: number }[] = [];

    const stopCoast = () => {
      if (coast === undefined) return;
      cancelAnimationFrame(coast);
      coast = undefined;
    };
    const rest = () => {
      stopCoast();
      window.clearTimeout(idle);
      el.classList.remove('is-dragging');
    };
    // Glides from where the strip is to where it should rest near `wanted`, and only then gives
    // it back to the browser's own snapping: handed back anywhere else, it would jump.
    const settle = (wanted: number, dragged = false) => {
      stopCoast();
      const max = el.scrollWidth - el.clientWidth;
      let to = Math.min(max, Math.max(0, wanted));
      if (snap) {
        const box = el.getBoundingClientRect();
        const lead = parseFloat(getComputedStyle(el).paddingLeft) || 0;
        const starts = Array.from(el.children, (c) => c.getBoundingClientRect().left - box.left + el.scrollLeft - lead);
        const places = restingPlaces(starts, max);
        to = dragged ? placeAfterDrag(places, startLeft, to) : nearestPlace(places, to);
      }
      const from = el.scrollLeft;
      if (Math.abs(to - from) < 1) return rest();
      let began: number | undefined;
      const step = (now: number) => {
        began ??= now;
        const t = Math.min(1, (now - began) / COAST_MS);
        el.scrollLeft = from + (to - from) * easeOut(t);
        if (t < 1) coast = requestAnimationFrame(step);
        else rest();
      };
      coast = requestAnimationFrame(step);
    };

    const move = (e: PointerEvent) => {
      if (!held || e.pointerId !== pointer) return;
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < THRESHOLD) return;
        dragging = true;
        onDragStart?.();
        el.classList.add('is-dragging');
        try {
          el.setPointerCapture(pointer);
        } catch {
          /* the pointer is already gone; the drag ends with the next event */
        }
      }
      el.scrollLeft = startLeft - dx;
      samples.push({ t: e.timeStamp, x: e.clientX });
      if (samples.length > 12) samples.shift();
    };

    const up = (e: PointerEvent) => {
      if (!held || e.pointerId !== pointer) return;
      held = false;
      el.removeEventListener('pointermove', move);
      if (!dragging) {
        // A press that stopped a strip mid-glide, and was not a drag: it finishes coming to rest.
        if (el.classList.contains('is-dragging')) settle(el.scrollLeft);
        return;
      }
      dragging = false;
      swallowClick = true;
      // The click (if one comes) is dispatched right after this; anything later is a new click.
      window.setTimeout(() => (swallowClick = false), 0);
      settle(el.scrollLeft - releaseSpeed(samples, e.timeStamp) * CARRY_MS, true);
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      // Sliders and text boxes inside a strip keep their own dragging.
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      // A strip still gliding stops under the pointer, and stays the drag's until it rests.
      stopCoast();
      window.clearTimeout(idle);
      held = true;
      dragging = false;
      pointer = e.pointerId;
      startX = e.clientX;
      startLeft = el.scrollLeft;
      samples = [{ t: e.timeStamp, x: e.clientX }];
      el.addEventListener('pointermove', move);
    };

    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // Pictures and links would otherwise be picked up and dragged as files.
    const noDrag = (e: DragEvent) => e.preventDefault();
    // The wheel (or a trackpad) takes over from a strip that is still gliding; once the wheel
    // has stopped, the strip comes to rest from wherever that left it.
    const wheel = () => {
      if (!el.classList.contains('is-dragging') || held) return;
      stopCoast();
      window.clearTimeout(idle);
      idle = window.setTimeout(() => settle(el.scrollLeft), 160);
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true);
    el.addEventListener('dragstart', noDrag);
    el.addEventListener('wheel', wheel, { passive: true });
    return () => {
      rest();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('click', click, true);
      el.removeEventListener('dragstart', noDrag);
      el.removeEventListener('wheel', wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, snap]);
}
