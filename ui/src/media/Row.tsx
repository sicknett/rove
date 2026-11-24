import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Skeleton } from '../ui/controls';

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
      { rootMargin: margin },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

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
}

export function Row({ title, action, children, shape = 'poster', loading, onNearEnd, className = '' }: RowProps) {
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

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.86, behavior: 'smooth' });
  };

  return (
    <section className={`row ${className}`} aria-label={title}>
      <header className="row__head">
        <h2 className="row__title">{title}</h2>
        {action}
      </header>
      <div className="row__viewport">
        {!edges.start && (
          <button className="row__arrow row__arrow--prev" aria-label="Scroll back" onClick={() => page(-1)}>
            <ChevronLeft size={26} />
          </button>
        )}
        <div className="row__scroller" ref={scroller} onScroll={update}>
          {children}
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
