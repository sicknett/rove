import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { canBrowse } from '../addons/client';
import type { MetaPreview } from '../addons/types';
import { flatItems, useCatalog } from '../data/hooks';
import { paging, PosterGrid } from '../media/Grid';
import { Row, RowRetry } from '../media/Row';
import { PosterCard } from '../media/cards';
import { navigate, useNav } from '../nav/router';
import { Button, Empty, Spinner } from '../ui/controls';
import { tmdb, tmdbImage } from '../meta/tmdb';
import { Img } from '../ui/Img';
import { useCollections, folderSources, type CollectionSource } from '../state/collections';
import { useSourceItems, blockerMessage, sourceBlocker, sourceLabel, sourceKey, sourceProviderName } from '../data/sources';
import { tmdbKeyId } from '../state/keys';
import { asMediaType } from '../data/hooks';
import { useCatalogSources } from '../servers/useSources';
import { SMART_SOURCE, SmartList } from './home/SmartRows';
import { GenreChips, LoadFailed } from './shared/parts';

// Search and Discover have their own folders; the shell still finds them here.
export { Search } from './search/Search';
export { Discover } from './discover/Discover';

// ---------- One catalog ("See all") ----------

export function CatalogPage(props: { addonId: string; type: string; catalogId: string; title?: string; genre?: string }) {
  // "See all" of a Home row made from the profile's history: it has no addon behind it.
  if (props.addonId === SMART_SOURCE) return <SmartList rowKey={props.catalogId} title={props.title} />;
  return <AddonCatalogPage {...props} />;
}

function AddonCatalogPage({ addonId, type, catalogId, title, genre }: { addonId: string; type: string; catalogId: string; title?: string; genre?: string }) {
  // Not from an addon that is switched off or that this profile may not use (see canBrowse).
  const addon = useCatalogSources().find((a) => a.manifest.id === addonId && canBrowse(a));
  const catalog = addon?.manifest.catalogs.find((c) => c.id === catalogId && c.type === type);
  const replace = useNav((s) => s.replace);
  const q = useCatalog(addonId, type, catalogId, { genre }, !!addon);
  const items = flatItems(q.data?.pages);
  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">{title ?? catalog?.name ?? 'Catalog'}</h1>
        {addon && <span className="page-sub">{addon.manifest.name}</span>}
      </header>
      {catalog && <GenreChips catalog={catalog} value={genre} onChange={(g) => replace({ name: 'catalog', addonId, type, catalogId, title, genre: g })} />}
      <div className="page-body">
        {!addon ? (
          <Empty title="This catalog is not available">Its addon is not installed, or it is switched off in Settings → Addons.</Empty>
        ) : q.isLoadingError ? (
          <LoadFailed title="This catalog did not load" onRetry={() => void q.refetch()}>
            {addon.manifest.name} did not answer.
          </LoadFailed>
        ) : !q.isLoading && items.length === 0 ? (
          <Empty title="Nothing here" />
        ) : (
          <PosterGrid items={items} {...paging(q)} />
        )}
      </div>
    </div>
  );
}

// ---------- Person ----------

interface PersonDetails {
  name: string;
  biography?: string;
  profile_path?: string | null;
  known_for_department?: string;
  birthday?: string;
  place_of_birth?: string;
  combined_credits?: { cast?: Credit[]; crew?: Credit[] };
}
interface Credit {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_count?: number;
  vote_average?: number;
  character?: string;
  job?: string;
}

export function Person({ id, name }: { id: number; name?: string }) {
  const q = useQuery({ queryKey: ['person', id, tmdbKeyId()], queryFn: () => tmdb<PersonDetails>(`/person/${id}`, { append_to_response: 'combined_credits' }), staleTime: 24 * 3600 * 1000 });
  const p = q.data;
  const credits = useMemo(() => {
    const all = [...(p?.combined_credits?.cast ?? []), ...(p?.combined_credits?.crew ?? [])].filter((c) => c.poster_path);
    const seen = new Set<string>();
    return all
      .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
      .filter((c) => {
        const k = `${c.media_type}:${c.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(
        (c): MetaPreview => ({
          id: `tmdb:${c.id}`,
          type: c.media_type === 'tv' ? 'series' : 'movie',
          name: c.title ?? c.name ?? '',
          poster: tmdbImage(c.poster_path, 'w342'),
          releaseInfo: (c.release_date ?? c.first_air_date)?.slice(0, 4),
          imdbRating: c.vote_average ? c.vote_average.toFixed(1) : undefined,
        }),
      );
  }, [p]);
  return (
    <div className="screen-pad">
      <header className="person-head">
        <Img src={tmdbImage(p?.profile_path, 'h632')} alt="" className="person-head__img" fallback={<span className="person-head__mono">{(p?.name ?? name ?? '?')[0]}</span>} />
        <div className="person-head__text">
          <h1 className="page-title">{p?.name ?? name}</h1>
          <p className="page-sub">{[p?.known_for_department, p?.birthday?.slice(0, 4), p?.place_of_birth].filter(Boolean).join(' · ')}</p>
          {p?.biography && <p className="person-head__bio">{p.biography}</p>}
        </div>
      </header>
      {q.isLoading ? (
        <Spinner />
      ) : q.isError ? (
        <LoadFailed title="This page did not load" onRetry={() => void q.refetch()}>
          TMDB did not answer.
        </LoadFailed>
      ) : (
        <PosterGrid items={credits} />
      )}
    </div>
  );
}

// ---------- Collections ----------

/** Why a source cannot be shown at all, in words. */
function Blocked({ why }: { why: NonNullable<ReturnType<typeof sourceBlocker>> }) {
  // Each provider has its own reason (a missing key, a signed-out account, a server switched off).
  const { title, text } = blockerMessage(why);
  return <Empty title={title}>{text}</Empty>;
}

export function CollectionPage({ id, folder }: { id: string; folder?: string }) {
  const collection = useCollections((s) => s.collections.find((c) => c.id === id));
  // The chosen source tab belongs to one folder: another folder starts on its first.
  const [tab, setTab] = useState({ folder, index: 0 });
  const sourceIdx = tab.folder === folder ? tab.index : 0;
  if (!collection) return <Empty title="This collection no longer exists" />;
  const current = collection.folders.find((f) => f.id === folder);
  if (!current) {
    return (
      <div className="screen-pad">
        <header className="page-head">
          <h1 className="page-title">{collection.title}</h1>
          <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => navigate({ name: 'collection-edit', id })}>
            Edit
          </Button>
        </header>
        <div className="folder-grid">
          {collection.folders.map((f) => (
            <button key={f.id} className="folder-tile" onClick={() => navigate({ name: 'collection', id, folder: f.id })}>
              <Img src={f.coverImageUrl ?? undefined} alt="" className="folder-tile__img" fallback={<span className="card__monogram">{f.coverEmoji ?? f.title[0]}</span>} />
              <span className="card__scrim" aria-hidden />
              {!f.hideTitle && <span className="folder-tile__title">{f.title}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const sources = folderSources(current);
  const source = sources[Math.min(sourceIdx, sources.length - 1)];
  const asRows = (collection.viewMode ?? '').toUpperCase() === 'ROWS';
  const blockers = sources.map(sourceBlocker);
  // A folder is its own page in history: up to the collection is Back when that is where the
  // user came from, so the two do not pile up.
  const toCollection = () => {
    const nav = useNav.getState();
    const before = nav.stack[nav.index - 1]?.route;
    if (before?.name === 'collection' && before.id === id && !before.folder) nav.back();
    else nav.replace({ name: 'collection', id });
  };
  return (
    <div className="screen-pad">
      <header className="page-head">
        <div>
          <button className="crumb" onClick={toCollection}>
            {collection.title}
          </button>
          <h1 className="page-title">{current.title}</h1>
        </div>
        <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => navigate({ name: 'collection-edit', id, folder: current.id })}>
          Edit folder
        </Button>
      </header>
      {!sources.length ? (
        <Empty title="This folder has no sources yet">Add an addon catalog, a TMDB source or a list with Edit folder.</Empty>
      ) : asRows ? (
        // Rows that cannot be shown are left out; when that is all of them, the first says why.
        blockers.every(Boolean) ? (
          <Blocked why={blockers[0]!} />
        ) : (
          sources.map((s, i) => <SourceRow key={`${sourceKey(s)}-${i}`} source={s} />)
        )
      ) : (
        <>
          {sources.length > 1 && (
            <div className="chips chips--scroll" role="tablist">
              {sources.map((s, i) => (
                <button key={`${sourceKey(s)}-${i}`} role="tab" aria-selected={i === sourceIdx} className={`chip ${i === sourceIdx ? 'is-on' : ''}`} onClick={() => setTab({ folder, index: i })}>
                  {sourceLabel(s)}
                </button>
              ))}
            </div>
          )}
          {source && <SourceGrid key={sourceKey(source)} source={source} />}
        </>
      )}
    </div>
  );
}

function SourceGrid({ source }: { source: CollectionSource }) {
  const q = useSourceItems(source);
  const items = flatItems(q.data?.pages);
  const blocker = sourceBlocker(source);
  if (blocker) return <Blocked why={blocker} />;
  if (q.isLoadingError)
    return (
      <LoadFailed title="This did not load" onRetry={() => void q.refetch()}>
        {sourceProviderName(source)} did not answer.
      </LoadFailed>
    );
  if (!q.isLoading && !items.length) return <Empty title="Nothing here">This source has no titles right now.</Empty>;
  return <PosterGrid items={items} {...paging(q)} />;
}

function SourceRow({ source }: { source: CollectionSource }) {
  const q = useSourceItems(source);
  const items = flatItems(q.data?.pages);
  if (sourceBlocker(source) || (q.isSuccess && !items.length)) return null;
  return (
    <Row title={sourceLabel(source)} loading={q.isLoading} onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && !q.isFetchNextPageError && void q.fetchNextPage()}>
      {q.isLoadingError && <RowRetry onRetry={() => void q.refetch()}>This row did not load.</RowRetry>}
      {items.map((m) => (
        <PosterCard key={m.id} title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, year: m.releaseInfo, rating: m.imdbRating }} />
      ))}
      {q.isFetchNextPageError && !q.isFetchingNextPage && <RowRetry onRetry={() => void q.fetchNextPage()} />}
    </Row>
  );
}
