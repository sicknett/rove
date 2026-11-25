// Arrow keys through results: from the search box down into the cards, between cards in every
// direction, and back up. Rows scroll sideways and grids only hold the rows on screen, so the
// next card is found by where things are drawn, not by their order in the page.

import type { KeyboardEvent } from 'react';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

const centerX = (b: Box) => (b.left + b.right) / 2;
const centerY = (b: Box) => (b.top + b.bottom) / 2;

/**
 * Which of `boxes` an arrow key leads to from `from`, as its index, or -1 when nothing lies that
 * way. Left and right stay in the visual row (boxes that overlap `from` in height) and take the
 * nearest. Up and down take the nearest row that way, and in it the box closest to straight
 * above or below.
 */
export function stepFrom(boxes: Box[], from: Box, dir: Direction): number {
  let best = -1;
  if (dir === 'left' || dir === 'right') {
    let gap = Infinity;
    boxes.forEach((b, i) => {
      const overlap = Math.min(b.bottom, from.bottom) - Math.max(b.top, from.top);
      if (overlap < Math.min(b.bottom - b.top, from.bottom - from.top) / 2) return;
      const d = dir === 'right' ? centerX(b) - centerX(from) : centerX(from) - centerX(b);
      if (d > 1 && d < gap) (gap = d), (best = i);
    });
    return best;
  }
  // The nearest row first: the smallest step up or down among boxes that lie wholly that way.
  const step = (b: Box) => (dir === 'down' ? b.top - from.bottom : from.top - b.bottom);
  const ahead = boxes.map((b, i) => ({ b, i })).filter(({ b }) => step(b) > -2 && Math.abs(centerY(b) - centerY(from)) > 1);
  if (!ahead.length) return -1;
  const nearest = Math.min(...ahead.map(({ b }) => step(b)));
  let off = Infinity;
  for (const { b, i } of ahead) {
    // Boxes of one row start within a few pixels of each other.
    if (step(b) - nearest > 12) continue;
    // Straight above or below counts as no distance at all, so a wide button leads to the card under it.
    const d = b.right < from.left ? from.left - b.right : b.left > from.right ? b.left - from.right : 0;
    const tie = Math.abs(centerX(b) - centerX(from)) / 10000;
    if (d + tie < off) (off = d + tie), (best = i);
  }
  return best;
}

/** What arrow keys move between: poster cards, people, and anything a screen marks with `data-nav`. */
const TARGETS = 'button.card__frame, button.person, [data-nav]';

const DIRECTION: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/**
 * The key handler for a screen's root element. It runs for keys pressed inside that screen only
 * (a hidden screen holds no focus), so there is nothing to switch off while the screen waits.
 *
 * With `input` (Search's box): Down from the box enters the results, Up from the top row returns
 * to it, Escape anywhere in the results returns to it, and typing while a result has the keyboard
 * goes on in the box.
 */
export function arrowNav(e: KeyboardEvent<HTMLElement>, input?: HTMLInputElement | null) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  const root = e.currentTarget;
  const target = e.target as HTMLElement;
  const dir = DIRECTION[e.key];
  const inBox = !!input && target === input;
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

  if (!dir) {
    if (!input || typing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key.length === 1 && e.key !== ' ') {
      // No preventDefault: the letter lands in the box, which now has the keyboard.
      input.focus();
    }
    return;
  }
  if (typing && !(inBox && dir === 'down')) return;

  // Only what is drawn: a row scrolled sideways keeps cards that are not on screen in the page.
  const all = [...root.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => el !== target && !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  const isTarget = target.matches(TARGETS);
  // From a filter or another control only Up and Down lead anywhere: Left and Right are its own.
  if (!isTarget && !inBox && (dir === 'left' || dir === 'right')) return;
  // The box is as wide as the page: its left end stands for it, so Down lands on the first result of the row below, not the middle one.
  const from = boxOf(target);
  const next = all[stepFrom(all.map(boxOf), inBox ? { ...from, right: from.left + 1 } : from, dir)];
  if (next) {
    e.preventDefault();
    next.focus();
    return;
  }
  if (dir === 'up' && input && !inBox) {
    e.preventDefault();
    input.focus();
    input.select();
  }
  // Nothing below: the key scrolls the page as it always does, which brings more of a grid in.
}
