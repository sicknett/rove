// Home's "For you" row: an ordinary row of poster cards. The line under each name is the
// assistant's reason for the pick (in full on hover).

import { RefreshCw } from 'lucide-react';
import { Row, RowRetry, useNearViewport } from '../media/Row';
import { PosterCard } from '../media/cards';
import { useScreen } from '../nav/router';
import { Spinner, type MenuItem } from '../ui/controls';
import { toast } from '../ui/toast';
import { useForYou, useForYouRow } from './forYou';

type RowMenu = (MenuItem | 'divider')[];

export function ForYouRow({ title, menu }: { title: string; menu: () => RowMenu }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  // Home stays mounted while other screens are open. Each time it comes back on show it may ask
  // again, and only then: whether a new list is due is decided in one place (forYou refreshDue).
  const { active } = useScreen();
  const row = useForYouRow(near && active);
  const { items, loading, error } = row;

  // Nothing saved has been read yet: no row, rather than one that flashes a placeholder.
  if (row.pending) return <div ref={ref} />;

  // With picks on show a failure has no room in the row itself (the header only says that it
  // happened), so a refresh the user asked for says why in a toast.
  const refresh = () =>
    void row.refresh().then(() => {
      const now = useForYou.getState();
      if (now.status === 'error' && now.error && now.cache?.items.length) toast.error(now.error);
    });

  const options = (): RowMenu => [{ label: 'Refresh', icon: <RefreshCw size={16} />, disabled: loading || !row.hasHistory, onSelect: refresh }, 'divider', ...menu()];

  return (
    <div ref={ref}>
      <Row
        title={title}
        menu={options}
        loading={(loading || row.waiting) && !items.length}
        // Yesterday's picks stay while new ones are fetched, and when fetching fails: the header
        // says which.
        action={
          !items.length ? undefined : loading ? (
            <span className="row__status" role="status">
              <Spinner size={14} /> Refreshing
            </span>
          ) : error ? (
            <span className="row__status" title={error}>
              Could not refresh
              <button className="row__more" onClick={refresh}>
                Try again
              </button>
            </span>
          ) : undefined
        }
      >
        {error && !items.length && <RowRetry onRetry={refresh}>{error}</RowRetry>}
        {!row.hasHistory && !items.length && <div className="row__note">Watch a few titles, or add some to your Watchlist, and recommendations appear here.</div>}
        {row.answered && row.hasHistory && !items.length && !loading && !error && (
          <div className="row__note">
            Nothing new to recommend right now.
            <button className="row__more" onClick={refresh}>
              Refresh
            </button>
          </div>
        )}
        {items.map((c) => (
          <PosterCard key={`${c.type}:${c.tmdbId}`} title={{ metaId: c.metaId, type: c.type, name: c.name, poster: c.poster, background: c.background, year: c.year, rating: c.rating }} subtitle={c.reason || undefined} />
        ))}
      </Row>
    </div>
  );
}
