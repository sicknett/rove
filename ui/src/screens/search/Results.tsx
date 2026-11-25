// Search's results for a settled query: the best match on top, then a row per kind of result
// (All), or one kind in full as a grid that pages on (Movies, Shows, People).

import { Sparkles } from 'lucide-react';
import type { MetaPreview } from '../../addons/types';
import { PosterGrid } from '../../media/Grid';
import { Row, RowRetry } from '../../media/Row';
import { navigate } from '../../nav/router';
import { Button, Empty, Select, Skeleton, Spinner } from '../../ui/controls';
import { discoverRoute } from '../discover/filters';
import { PeopleSkeleton, PersonCard, PreviewCard } from '../shared/cards';
import { Featured, FeaturedPerson } from '../shared/Featured';
import { hitKey, hitPreview, type TitleHit } from '../shared/hits';
import { useTrending } from './data';
import { sortHits, sortPreviews, WHERE_LABEL, type OwnTitle, type Sort } from './logic';
import type { SearchModel } from './model';

export type Tab = 'all' | 'movies' | 'shows' | 'people';

const typeName = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

/** "TMDB", "TMDB and Cinemeta", "TMDB, Cinemeta and Den". */
const named = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');

/** A row shows this many; "See all" opens the kind in full. */
const ROW_SHOWS = 20;

const SORTS: { value: Sort; label: string }[] = [
  { value: 'relevance', label: 'Best match first' },
  { value: 'popularity', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'rating', label: 'Top rated' },
];

/** The kinds of result, and how they are ordered: under the box, above everything found. */
export function ResultTabs({ tab, onTab, sort, onSort, people }: { tab: Tab; onTab: (t: Tab) => void; sort: Sort; onSort: (s: Sort) => void; people: boolean }) {
  const tabs: { value: Tab; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'movies', label: 'Movies' },
    { value: 'shows', label: 'Shows' },
    ...(people ? [{ value: 'people' as const, label: 'People' }] : []),
  ];
  return (
    <div className="search-tabs">
      <div className="chips" role="tablist" aria-label="Kind of result">
        {tabs.map((t) => (
          <button key={t.value} role="tab" aria-selected={tab === t.value} className={`chip ${tab === t.value ? 'is-on' : ''}`} onClick={() => onTab(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* People come in one order: the best known first. */}
      {tab !== 'people' && <Select label="Order of results" className="select--compact" value={sort} options={SORTS} onChange={onSort} />}
    </div>
  );
}

/** The results page before its results: the same shapes, empty. Shown while text is still being typed and while the first answers are on their way. */
export function ResultsSkeleton({ featured }: { featured: boolean }) {
  return (
    <div aria-hidden>
      {featured && <Skeleton className="feature-skeleton" />}
      <Row title="Movies" loading>
        {null}
      </Row>
      <Row title="Shows" loading>
        {null}
      </Row>
    </div>
  );
}

function TitleRow({ title, hits, q, onAll }: { title: string; hits: TitleHit[]; q: SearchModel['movies']; onAll: () => void }) {
  if (!q.isLoading && !hits.length && !q.isError) return null;
  return (
    <Row
      title={title}
      loading={q.isLoading}
      action={
        (hits.length > ROW_SHOWS || q.hasNextPage) && (
          <button className="row__more" onClick={onAll}>
            See all
          </button>
        )
      }
    >
      {q.isError && !hits.length && <RowRetry onRetry={() => void q.refetch()}>{title} did not load.</RowRetry>}
      {hits.slice(0, ROW_SHOWS).map((h) => (
        <PreviewCard key={hitKey(h)} m={hitPreview(h)} />
      ))}
    </Row>
  );
}

function PreviewRow({ title, items, loading, onAll }: { title: string; items: MetaPreview[]; loading?: boolean; onAll?: () => void }) {
  if (!loading && !items.length) return null;
  return (
    <Row
      title={title}
      loading={loading}
      action={
        onAll &&
        items.length > ROW_SHOWS && (
          <button className="row__more" onClick={onAll}>
            See all
          </button>
        )
      }
    >
      {items.slice(0, onAll ? ROW_SHOWS : 60).map((m) => (
        <PreviewCard key={m.id} m={m} progress={(m as { progress?: number }).progress} />
      ))}
    </Row>
  );
}

function OwnRow({ items }: { items: OwnTitle[] }) {
  if (!items.length) return null;
  return (
    <Row title="In your library">
      {items.map((t) => (
        <PreviewCard key={`${t.type}:${t.metaId}`} m={{ id: t.metaId, type: t.type, name: t.name, poster: t.poster, releaseInfo: t.year }} subtitle={WHERE_LABEL[t.where]} />
      ))}
    </Row>
  );
}

/** One kind in full: TMDB's titles, then what addons add, in a grid that pages on. */
function TitleGrid({ hits, extras, q, sort, active, waiting }: { hits: TitleHit[]; extras: MetaPreview[]; q: SearchModel['movies']; sort: Sort; active: boolean; waiting: boolean }) {
  const items = [...hits.map(hitPreview), ...extras];
  const more = () => {
    if (!q.isFetchingNextPage) void q.fetchNextPage();
  };
  // By relevance, more pages follow as the grid is scrolled: they only ever add to its end. In
  // any other order a new page lands in between what is already on screen, so it is asked for
  // by hand. Never for a hidden Search.
  const scrolls = sort === 'relevance';
  return (
    <>
      <PosterGrid
        items={items}
        loading={q.isLoading || q.isFetchingNextPage || (waiting && !items.length)}
        hasMore={scrolls && active && q.hasNextPage}
        loadFailed={q.isFetchNextPageError && !q.isFetchingNextPage}
        loadMore={more}
      />
      {!scrolls && q.hasNextPage && !q.isFetchNextPageError && (
        <p className="load-more">
          {q.isFetchingNextPage ? (
            <Spinner size={18} />
          ) : (
            <button className="row__more" onClick={more}>
              More results
            </button>
          )}
        </p>
      )}
    </>
  );
}

interface Props {
  model: SearchModel;
  tab: Tab;
  onTab: (t: Tab) => void;
  sort: Sort;
  active: boolean;
  /** The connected assistant's name, when there is one: "nothing found" then offers to ask it. */
  assistant?: string;
  onAsk: () => void;
}

export function Results({ model, tab, onTab, sort, active, assistant, onAsk }: Props) {
  const { read, movies, shows, people } = model;
  const movieHits = sortHits(model.movieHits, sort);
  const showHits = sortHits(model.showHits, sort);
  const extrasOf = (type: string) => sortPreviews(model.addonGroups.find(([t]) => t === type)?.[1] ?? [], sort);
  const servers = model.serverName ? `On ${model.serverName}` : 'On your servers';
  const suggest = useTrending(active && !model.loading && model.empty && !model.failed.length);

  if (!model.loading && model.empty) {
    if (model.failed.length) {
      return (
        <Empty
          title="Search did not load"
          action={
            <Button variant="secondary" onClick={model.retry}>
              Try again
            </Button>
          }
        >
          {named(model.failed)} did not answer.
        </Empty>
      );
    }
    const trending = (suggest.titles.data ?? []).filter((h) => h.poster).slice(0, ROW_SHOWS);
    return (
      <>
        <Empty
          title={`Nothing found for “${read.text}”`}
          action={
            <span className="empty__buttons">
              {assistant && (
                <Button variant="primary" icon={<Sparkles size={16} />} onClick={onAsk}>
                  Ask {assistant} instead
                </Button>
              )}
              <Button variant="secondary" onClick={() => navigate(discoverRoute({}))}>
                Browse Discover
              </Button>
            </span>
          }
        >
          Check the spelling, try fewer words or the title in its original language. A year narrows a common name: “dune 2021”.
        </Empty>
        {trending.length > 0 && (
          <Row title="Trending now">
            {trending.map((h) => (
              <PreviewCard key={hitKey(h)} m={hitPreview(h)} />
            ))}
          </Row>
        )}
      </>
    );
  }

  const failedNote = model.failed.length > 0 && !model.loading && (
    <p className="load-more">
      {named(model.failed)} did not answer.
      <button className="row__more" onClick={model.retry}>
        Try again
      </button>
    </p>
  );

  if (tab === 'people') {
    return (
      <>
        {people.isLoading ? (
          <div className="people-grid">
            <PeopleSkeleton count={12} />
          </div>
        ) : !model.peopleHits.length ? (
          <OtherKinds what="people" query={read.text} onAll={() => onTab('all')} />
        ) : (
          <div className="people-grid">
            {model.peopleHits.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
        )}
        {people.hasNextPage && model.peopleHits.length > 0 && (
          <p className="load-more">
            {people.isFetchingNextPage ? (
              <Spinner size={18} />
            ) : (
              <button className="row__more" onClick={() => void people.fetchNextPage()}>
                More people
              </button>
            )}
          </p>
        )}
        {failedNote}
      </>
    );
  }

  if (tab === 'movies' || tab === 'shows') {
    const type = tab === 'movies' ? 'movie' : 'series';
    const q = tab === 'movies' ? movies : shows;
    const hits = tab === 'movies' ? movieHits : showHits;
    const extras = extrasOf(type);
    const onServers = model.serverItems.filter((m) => m.type === type);
    const own = model.own.filter((t) => t.type === type);
    const nothing = !q.isLoading && !model.addonsLoading && !hits.length && !extras.length;
    return (
      <>
        {nothing ? (
          !onServers.length && !own.length && <OtherKinds what={tab} query={read.text} onAll={() => onTab('all')} />
        ) : (
          <section className="search-section">
            <TitleGrid hits={hits} extras={extras} q={q} sort={sort} active={active} waiting={model.addonsLoading} />
          </section>
        )}
        <PreviewRow title={servers} items={onServers} loading={model.serversLoading} />
        <OwnRow items={own} />
        {failedNote}
      </>
    );
  }

  return (
    <>
      {model.tmdbLoading ? <Skeleton className="feature-skeleton" /> : model.top?.kind === 'title' ? <Featured key={hitKey(model.top.hit)} hit={model.top.hit} label="Best match" active={active} /> : model.top ? <FeaturedPerson key={model.top.person.id} person={model.top.person} label="Best match" /> : null}
      <TitleRow title="Movies" hits={movieHits} q={movies} onAll={() => onTab('movies')} />
      <TitleRow title="Shows" hits={showHits} q={shows} onAll={() => onTab('shows')} />
      {(people.isLoading || model.peopleHits.length > 0) && (
        <Row
          title="People"
          action={
            (model.peopleHits.length > ROW_SHOWS || people.hasNextPage) && (
              <button className="row__more" onClick={() => onTab('people')}>
                See all
              </button>
            )
          }
        >
          {people.isLoading && <PeopleSkeleton />}
          {model.peopleHits.slice(0, ROW_SHOWS).map((p) => (
            <PersonCard key={p.id} person={p} />
          ))}
        </Row>
      )}
      <PreviewRow title={servers} items={model.serverItems} loading={model.serversLoading} />
      <OwnRow items={model.own} />
      {model.addonGroups.map(([type, items]) => {
        // With TMDB's own list of the kind above it, this is what addons add to that list.
        const known = type === 'movie' ? movieHits.length > 0 : type === 'series' ? showHits.length > 0 : false;
        const title = known ? `More ${typeName(type).toLowerCase()} from your addons` : typeName(type);
        const openAll = type === 'movie' ? () => onTab('movies') : type === 'series' ? () => onTab('shows') : undefined;
        return <PreviewRow key={type} title={title} items={sortPreviews(items, sort)} onAll={openAll} />;
      })}
      {model.addonsLoading && !model.addonGroups.length && !model.tmdbLoading && !movieHits.length && !showHits.length && (
        <Row title="From your addons" loading>
          {null}
        </Row>
      )}
      {failedNote}
    </>
  );
}

/** A kind with nothing in it, said plainly, with the way back to what was found. */
function OtherKinds({ what, query, onAll }: { what: string; query: string; onAll: () => void }) {
  return (
    <Empty
      title={`No ${what} match “${query}”`}
      action={
        <Button variant="secondary" onClick={onAll}>
          Show all results
        </Button>
      }
    />
  );
}
