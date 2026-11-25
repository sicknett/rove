// Discover: finding something to watch by narrowing down. Its main mode filters all of TMDB
// (Finder); the addons' own catalogs are a second mode beside it (Catalogs). Which mode, which
// filters and which catalog all live in the route, so Back, Forward and coming back to the tab
// restore the page as it was left.

import { useMemo } from 'react';
import { Compass } from 'lucide-react';
import { navigate, useNav, useScreen } from '../../nav/router';
import { Button, Empty, Segmented } from '../../ui/controls';
import { arrowNav } from '../shared/keynav';
import { useTmdbKeyId } from '../shared/parts';
import { Catalogs, useHasCatalogs } from './Catalogs';
import { discoverRoute, normalize, type DiscoverFilters, type DiscoverRoute } from './filters';
import { Finder } from './Finder';

const PLAIN: DiscoverRoute = { name: 'discover' };

/**
 * The shell hands this screen the catalog parameters of its route as props. The filters are read
 * from the route itself, by this screen's own place in history, so every Discover in history
 * (there can be several: Search's genre tiles open new ones) shows its own filters.
 */
export function Discover(_: { type?: string; catalog?: string; genre?: string }) {
  const screen = useScreen();
  const own = useNav((s) => s.stack.find((e) => e.key === screen.key)?.route);
  const route = own?.name === 'discover' ? own : PLAIN;
  const hasKey = !!useTmdbKeyId();
  const hasCatalogs = useHasCatalogs();
  const filters = useMemo(() => normalize(route.filters), [route.filters]);

  /** Rewrites this screen's route in place, when it is the page on show. */
  const go = (next: DiscoverRoute) => {
    const nav = useNav.getState();
    if (nav.stack[nav.index].key === screen.key) nav.replace(next);
  };
  const catalogParams = { type: route.type, catalog: route.catalog, genre: route.genre };

  // Filters need TMDB. Without a key the catalogs are all there is to browse.
  const mode = !hasKey || (route.mode === 'catalogs' && hasCatalogs) ? 'catalogs' : 'filters';

  if (!hasKey && !hasCatalogs) {
    return (
      <div className="screen-pad">
        <Empty
          icon={<Compass size={40} />}
          title="Nothing to discover with yet"
          action={
            <Button variant="secondary" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
              Open Accounts
            </Button>
          }
        >
          Discover narrows TMDB down by genre, year, rating and where to watch, which needs a TMDB key (Settings → Accounts). It can also browse the catalogs of a metadata addon such as AIOMetadata (Settings → Addons).
        </Empty>
      </div>
    );
  }

  const modeSwitch = hasKey && hasCatalogs && (
    <Segmented
      label="What to browse"
      value={mode}
      onChange={(m) => go(discoverRoute(route.filters, { ...catalogParams, mode: m === 'catalogs' ? 'catalogs' : undefined }))}
      options={[
        { value: 'filters', label: 'Filters' },
        { value: 'catalogs', label: 'Catalogs' },
      ]}
    />
  );

  return (
    <div className="screen-pad discover" onKeyDown={(e) => arrowNav(e)}>
      {mode === 'catalogs' ? (
        <Catalogs
          {...catalogParams}
          onSet={(next) => go(discoverRoute(route.filters, { ...next, mode: 'catalogs' }))}
          modeSwitch={modeSwitch}
          note={
            !hasKey && (
              <>
                Filtering by genre, year, rating and where to watch needs a TMDB key.{' '}
                <button className="row__more" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
                  Open Accounts
                </button>
              </>
            )
          }
        />
      ) : (
        <Finder filters={filters} onChange={(next: DiscoverFilters) => go(discoverRoute(next, catalogParams))} modeSwitch={modeSwitch} />
      )}
    </div>
  );
}
