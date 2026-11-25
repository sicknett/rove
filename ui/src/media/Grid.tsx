import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MetaPreview } from '../addons/types';
import { asMediaType } from '../data/hooks';
import { useSettings } from '../state/settings';
import { PosterCard } from './cards';
import { Skeleton } from '../ui/controls';

const CARD_WIDTH = { small: 150, medium: 176, large: 210 } as const;
const GAP = 22;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement ?? null;
  while (n) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
    n = n.parentElement;
  }
  return null;
}

interface Props {
  items: MetaPreview[];
  loading?: boolean;
  hasMore?: boolean;
  loadMore?: () => void;
  /** The last `loadMore` failed: stop asking on scroll and offer "Try again" under the grid. */
  loadFailed?: boolean;
  progressOf?: (m: MetaPreview) => number | undefined;
}

/**
 * A grid's paging props from an infinite query. A page that fails keeps the pages already
 * loaded and waits for "Try again", instead of being asked for again on every render.
 */
export function paging(q: { isLoading: boolean; isFetchingNextPage: boolean; hasNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => unknown }) {
  return {
    loading: q.isLoading || q.isFetchingNextPage,
    hasMore: q.hasNextPage,
    loadFailed: q.isFetchNextPageError && !q.isFetchingNextPage,
    loadMore: () => {
      if (!q.isFetchingNextPage) void q.fetchNextPage();
    },
  };
}

/** A poster grid that only renders the rows on screen, loading more near the end. */
export function PosterGrid({ items, loading, hasMore, loadMore, loadFailed, progressOf }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSettings((s) => s.settings.appearance.cardSize);
  const [width, setWidth] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setScrollEl(scrollParent(ref.current));
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const target = CARD_WIDTH[size];
  const columns = Math.max(2, Math.floor((width + GAP) / (target + GAP)));
  const cardWidth = width > 0 ? (width - GAP * (columns - 1)) / columns : target;
  const rowHeight = cardWidth * 1.5 + 64;
  const placeholders = loading ? columns * 2 : 0;
  const total = items.length + placeholders;
  const rows = Math.ceil(total / columns);

  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight + GAP,
    overscan: 3,
    scrollMargin: ref.current?.offsetTop ?? 0,
  });

  useEffect(() => virtual.measure(), [rowHeight, columns]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = virtual.getVirtualItems();
  const lastRow = visible[visible.length - 1]?.index ?? 0;
  useEffect(() => {
    if (hasMore && loadMore && !loadFailed && lastRow >= rows - 3) loadMore();
  }, [lastRow, rows, hasMore, loadMore, loadFailed]);

  return (
    <>
      <div ref={ref} className="grid" style={{ height: virtual.getTotalSize(), ['--card-w' as string]: `${cardWidth}px` }}>
        {scrollEl &&
          visible.map((row) => (
            <div
              key={row.key}
              className="grid__row"
              style={{ transform: `translateY(${row.start - virtual.options.scrollMargin}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: GAP }}
            >
              {Array.from({ length: columns }, (_, c) => {
                const i = row.index * columns + c;
                if (i >= total) return <div key={c} />;
                const m = items[i];
                if (!m)
                  return (
                    <div key={c} className="card card--poster">
                      <Skeleton className="card__frame card__frame--skeleton" />
                      <Skeleton className="card__caption-skeleton" />
                    </div>
                  );
                return (
                  <PosterCard
                    key={m.id}
                    title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo, rating: m.imdbRating }}
                    progress={progressOf?.(m)}
                  />
                );
              })}
            </div>
          ))}
      </div>
      {loadFailed && loadMore && (
        <p className="load-more">
          The rest did not load.
          <button className="row__more" onClick={loadMore}>
            Try again
          </button>
        </p>
      )}
    </>
  );
}
