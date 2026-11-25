// Home's rows made from the profile's own history (recs/): Top picks, Because you watched,
// Trending, the numbered Top 10s, New releases, the genre rows, Hidden gems and From your
// watchlist. Ordinary rows of poster cards; what each shows is worked out in recs/engine.

import { memo, useCallback, useMemo } from 'react';
import { ThumbsDown } from 'lucide-react';
import type { MetaPreview } from '../../addons/types';
import { PosterGrid } from '../../media/Grid';
import { Row, RowRetry, useNearViewport } from '../../media/Row';
import { PosterCard } from '../../media/cards';
import { tmdbImage } from '../../meta/tmdb';
import { navigate } from '../../nav/router';
import { useRecs } from '../../recs/engine';
import { useSmartList, useSmartRow, useWatchlistRow } from '../../recs/hooks';
import { candidateKey, type Candidate } from '../../recs/rank';
import { recipeFor, WATCHLIST_ROW } from '../../recs/recipes';
import { typeOf } from '../../recs/taste';
import { canonicalNow, useCanonicalId } from '../../tracking/idmap';
import { Button, Empty, type MenuItem } from '../../ui/controls';
import { toast } from '../../ui/toast';

type RowMenu = (MenuItem | 'divider')[];

/**
 * "See all" for these rows opens the catalog page under this addon id (screens/browse
 * CatalogPage hands it to SmartList): the rows have no addon, and this way they need no route
 * of their own.
 */
export const SMART_SOURCE = 'rove.smart';

/** The title leaves every row made for this profile, and stays out. The toast takes it back. */
function notInterested(c: Candidate) {
  useRecs.getState().hide(c);
  toast.info(`${c.name} will not be recommended again`, { label: 'Undo', run: () => useRecs.getState().unhide(candidateKey(c)) });
}

/** A recommended title as a poster card. `rank` draws it as a place in a Top 10. */
const SmartCard = memo(function SmartCard({ c, rank }: { c: Candidate; rank?: number }) {
  const type = typeOf(c.kind);
  // TMDB's id for the title, or its IMDb id once the id map knows it (what addons and history speak).
  const metaId = useCanonicalId(`tmdb:${c.id}`, type);
  const title = useMemo(
    () => ({ metaId, type, name: c.name, poster: tmdbImage(c.poster, 'w342'), background: tmdbImage(c.backdrop, 'w1280'), year: c.date?.slice(0, 4), rating: c.rating > 0 ? c.rating.toFixed(1) : undefined }),
    [metaId, type, c],
  );
  const menuExtra = useCallback((): RowMenu => ['divider', { label: 'Not interested', icon: <ThumbsDown size={16} />, onSelect: () => notInterested(c) }], [c]);
  const card = <PosterCard title={title} menuExtra={menuExtra} />;
  if (rank === undefined) return card;
  return (
    <div className="rank" role="group" aria-label={`Number ${rank}`}>
      {card}
      {/* Drawn before the card (styles.css `.rank__num`). Two figures for every place, so the row keeps one rhythm; the padding nought is dimmed. */}
      <span className="rank__num" aria-hidden>
        {rank < 10 && <span className="rank__zero">0</span>}
        {rank}
      </span>
    </div>
  );
});

/** What "See all" on a Top 10 is called: the list behind it is longer than ten. */
const fullTitle = (title: string) => title.replace(/^Top 10 /, 'Top ');

export function SmartRow({ rowKey, title, menu }: { rowKey: string; title: string; menu: () => RowMenu }) {
  if (rowKey === WATCHLIST_ROW.key) return <WatchlistRow title={title} menu={menu} />;
  return <RecipeRow rowKey={rowKey} title={title} menu={menu} />;
}

function RecipeRow({ rowKey, title, menu }: { rowKey: string; title: string; menu: () => RowMenu }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const row = useSmartRow(rowKey, near);
  const chart = !!recipeFor(rowKey)?.chart;
  // The same element whatever the row shows: it is what tells that the row has come near the
  // screen. A row with nothing to show (no history for it, or too few titles) draws nothing in it.
  return (
    <div ref={ref}>
      {row && row.status !== 'none' && (
        <Row
          title={title}
          menu={menu}
          className={chart ? 'row--top10' : ''}
          loading={row.status === 'pending'}
          action={
            row.status === 'ready' ? (
              <button className="row__more" onClick={() => navigate({ name: 'catalog', addonId: SMART_SOURCE, type: 'all', catalogId: rowKey, title: chart ? fullTitle(title) : title })}>
                See all
              </button>
            ) : undefined
          }
        >
          {row.status === 'error' && <RowRetry onRetry={() => useRecs.getState().retry(rowKey)}>TMDB did not answer.</RowRetry>}
          {row.items.map((c, i) => (
            <SmartCard key={candidateKey(c)} c={c} rank={chart ? i + 1 : undefined} />
          ))}
        </Row>
      )}
    </div>
  );
}

/** The profile's own list, so its cards have the usual menu (Remove from Watchlist), not Not interested. */
function WatchlistRow({ title, menu }: { title: string; menu: () => RowMenu }) {
  const items = useWatchlistRow();
  if (!items.length) return null;
  return (
    <Row title={title} menu={menu} action={<button className="row__more" onClick={() => navigate({ name: 'library', tab: 'watchlist' })}>See all</button>}>
      {items.map((i) => (
        <PosterCard key={`${i.type}:${i.metaId}`} title={{ metaId: i.metaId, type: i.type, name: i.name, poster: i.poster, background: i.background, logo: i.logo, year: i.year }} />
      ))}
    </Row>
  );
}

/**
 * "See all": the row's whole list as a grid. Not cut to a row's length, and not thinned by what
 * other rows show (on Home a title goes to one row only; here the list stands alone). Titles
 * watched since, or marked Not interested, are left out as on Home.
 */
export function SmartList({ rowKey, title }: { rowKey: string; title?: string }) {
  const row = useSmartList(rowKey);
  const recipe = recipeFor(rowKey);
  const items = useMemo(
    (): MetaPreview[] =>
      (row?.items ?? []).map((c) => {
        const type = typeOf(c.kind);
        return { id: canonicalNow(`tmdb:${c.id}`, type), type, name: c.name, poster: tmdbImage(c.poster, 'w342'), background: tmdbImage(c.backdrop, 'w1280'), releaseInfo: c.date?.slice(0, 4), imdbRating: c.rating > 0 ? c.rating.toFixed(1) : undefined };
      }),
    [row],
  );
  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">{title ?? 'Made for you'}</h1>
        {recipe && <span className="page-sub">{recipe.personal ? 'Made for you from what you watch' : 'From TMDB'}</span>}
      </header>
      <div className="page-body">
        {!recipe ? (
          <Empty title="This row no longer exists" />
        ) : row?.status === 'error' ? (
          <Empty
            title="This did not load"
            action={
              <Button variant="secondary" onClick={() => useRecs.getState().retry(rowKey)}>
                Try again
              </Button>
            }
          >
            TMDB did not answer.
          </Empty>
        ) : row?.status === 'none' || (row?.status === 'ready' && !items.length) ? (
          <Empty title="Nothing here right now">This row has nothing new for you at the moment.</Empty>
        ) : (
          <PosterGrid items={items} loading={!row || row.status === 'pending'} />
        )}
      </div>
    </div>
  );
}
