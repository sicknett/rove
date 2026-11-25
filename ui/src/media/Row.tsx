import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Skeleton, type MenuItem } from '../ui/controls';
import { openContextMenu, useContextMenu } from '../ui/contextmenu';
import { useDragScroll } from './dragScroll';
import { EASE_OUT, EXPAND_MS, revealShift } from './preview';

/** True once the element has come near the viewport (stays true). */
export function useNearViewport<T extends Element>(margin = '600px') {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      // The margin only reaches past the edge of the observer's own root, so the root is the
      // screen's scroller. With the window as root, the scroller clips first and nothing preloads.
      { root: ref.current.closest('.screen'), rootMargin: margin },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

/**
 * Sits in a row where cards would: a row that did not load (with `children` saying so), or the
 * end of a row whose next page failed. What is loaded stays; "Try again" asks once more.
 */
export function RowRetry({ onRetry, children }: { onRetry: () => void; children?: React.ReactNode }) {
  return (
    <div className="row__note">
      {children}
      <button className="row__more" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * What a row does for a poster card that opens into a hover preview (CardPreview). Cards find it
 * through RowContext, and only cards in a row do: in a grid there is none, and nothing expands.
 */
export interface RowHost {
  /**
   * `card` starts widening to `width`, with the pointer on it at `pointerX`: the row scrolls with
   * it, just enough for the whole of it (and its Top 10 numeral) to end up in view.
   */
  expand: (card: HTMLElement, width: number, pointerX: number) => void;
  /** The expanded card has started to close ('closing'), or is a poster again ('closed'). */
  settle: (state: 'closing' | 'closed') => void;
}

export const RowContext = createContext<RowHost | null>(null);

interface RowProps {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Card shape for the loading placeholders. */
  shape?: 'poster' | 'wide';
  loading?: boolean;
  /** Called when scrolled near the end, to load more. */
  onNearEnd?: () => void;
  className?: string;
  /** Row options (move, hide, …): a ⋯ button in the header, and its right-click menu. */
  menu?: () => (MenuItem | 'divider')[];
}

export function Row({ title, action, children, shape = 'poster', loading, onNearEnd, className = '', menu }: RowProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft < 8;
    const end = el.scrollLeft + el.clientWidth > el.scrollWidth - 8;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    if (onNearEnd && el.scrollLeft + el.clientWidth > el.scrollWidth - el.clientWidth * 1.5) onNearEnd();
  }, [onNearEnd]);

  useEffect(() => {
    update();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, children]);

  // A card of this row is open as a preview, or closing again.
  const [preview, setPreview] = useState<'open' | 'closing' | null>(null);
  const glide = useRef<number | undefined>(undefined);
  // Where the row was before a card opened in it, and where that took it.
  const away = useRef<{ home: number; at: number } | null>(null);
  const host = useMemo<RowHost>(() => {
    // Frame by frame on the card's own curve and time, not a smooth scroll: the card's far edge
    // then stays where it is on screen while the card grows, instead of leaving and coming back.
    const glideTo = (el: HTMLElement, to: number) => {
      const from = el.scrollLeft;
      let began: number | undefined;
      const step = (now: number) => {
        began ??= now;
        const t = Math.min(1, (now - began) / EXPAND_MS);
        el.scrollLeft = from + (to - from) * EASE_OUT(t);
        glide.current = t < 1 ? requestAnimationFrame(step) : undefined;
      };
      cancelAnimationFrame(glide.current ?? 0);
      glide.current = requestAnimationFrame(step);
    };
    return {
      expand(card, width, pointerX) {
        const el = scroller.current;
        if (!el) return;
        setPreview('open');
        // The row's own child the card is in: a Top 10 card sits in a wrapper with its numeral.
        let unit = card;
        while (unit.parentElement && unit.parentElement !== el) unit = unit.parentElement;
        const view = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const shift = revealShift({
          cardLeft: card.getBoundingClientRect().left,
          openWidth: width,
          unitLeft: unit.getBoundingClientRect().left,
          viewLeft: view.left + parseFloat(style.paddingLeft),
          viewRight: view.left + el.clientWidth - parseFloat(style.paddingRight),
          pointerX,
        });
        // Opened again while still closing, "before" is still where the row first was.
        away.current = { home: away.current?.home ?? el.scrollLeft, at: el.scrollLeft + shift };
        if (shift) glideTo(el, away.current.at);
      },
      settle(state) {
        const el = scroller.current;
        const moved = away.current;
        if (state === 'closed') away.current = null;
        setPreview(state === 'closing' ? 'closing' : null);
        if (state !== 'closing' || !el || !moved) return;
        // The row goes back to where it was as the card closes, so it rests where it did before
        // (and where snapping, off meanwhile, will leave it). Not if it has been scrolled since.
        const ours = glide.current !== undefined || Math.abs(el.scrollLeft - moved.at) < 2;
        if (ours && el.scrollLeft !== moved.home) glideTo(el, moved.home);
      },
    };
  }, []);

  // Click and drag with the mouse scrolls the row. A drag takes the row over from a preview
  // that was moving it: the row stays where the drag leaves it.
  useDragScroll(scroller, {
    snap: true,
    onDragStart: () => {
      cancelAnimationFrame(glide.current ?? 0);
      glide.current = undefined;
      away.current = null;
    },
  });

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.86, behavior: 'smooth' });
  };

  return (
    <section className={`row ${className}`} aria-label={title}>
      <header className="row__head" onContextMenu={menu ? (e) => openContextMenu(e, menu()) : undefined}>
        <h2 className="row__title">{title}</h2>
        <span className="row__tools">
          {menu && (
            <button
              className="row__more row__menu"
              aria-label={`${title} row options`}
              title="Row options"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                useContextMenu.getState().show(r.left, r.bottom + 6, menu());
              }}
            >
              <MoreHorizontal size={18} />
            </button>
          )}
          {action}
        </span>
      </header>
      <div className={`row__viewport${preview ? ' is-previewing' : ''}${preview === 'open' ? ' is-preview-open' : ''}`}>
        {!edges.start && (
          <button className="row__arrow row__arrow--prev" aria-label="Scroll back" onClick={() => page(-1)}>
            <ChevronLeft size={26} />
          </button>
        )}
        <div className="row__scroller" ref={scroller} onScroll={update}>
          <RowContext.Provider value={host}>{children}</RowContext.Provider>
          {loading &&
            Array.from({ length: 8 }, (_, i) => (
              <div key={`sk${i}`} className={`card card--${shape}`}>
                <Skeleton className="card__frame card__frame--skeleton" />
                <Skeleton className="card__caption-skeleton" />
              </div>
            ))}
        </div>
        {!edges.end && (
          <button className="row__arrow row__arrow--next" aria-label="Scroll forward" onClick={() => page(1)}>
            <ChevronRight size={26} />
          </button>
        )}
      </div>
    </section>
  );
}
