import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Clock, Search as SearchIcon, X, Compass, Pencil } from 'lucide-react';
import { catalogExtras, catalogNeeds, catalogSupports, fetchCatalog, genreOptions, provides } from '../addons/client';
import { useAddons } from '../addons/store';
import type { InstalledAddon, ManifestCatalog, MetaPreview } from '../addons/types';
import { flatItems, useCatalog } from '../data/hooks';
import { PosterGrid } from '../media/Grid';
import { Row } from '../media/Row';
import { PosterCard } from '../media/cards';
import { navigate, useNav } from '../nav/router';
import { Button, Empty, Select, Spinner } from '../ui/controls';
import { tmdb, tmdbImage } from '../meta/tmdb';
import { Img } from '../ui/Img';
import { useCollections, folderSources, type CollectionSource } from '../state/collections';
import { useSourceItems, sourceLabel, sourceKey } from '../data/sources';
import { docs } from '../lib/native';
import { profileDoc } from '../state/profiles';
import { asMediaType } from '../data/hooks';
import { isServerAddon } from '../servers';
import { useCatalogSources } from '../servers/useSources';

const typeName = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

function GenreChips({ catalog, value, onChange }: { catalog: ManifestCatalog; value?: string; onChange: (g?: string) => void }) {
  const genres = genreOptions(catalog);
  const required = catalogNeeds(catalog).includes('genre');
  if (!genres.length) return null;
  return (
    <div className="chips chips--scroll" role="radiogroup" aria-label="Genre">
      {!required && (
        <button role="radio" aria-checked={!value} className={`chip ${!value ? 'is-on' : ''}`} onClick={() => onChange(undefined)}>
          All
        </button>
      )}
      {genres.map((g) => (
        <button key={g} role="radio" aria-checked={value === g} className={`chip ${value === g ? 'is-on' : ''}`} onClick={() => onChange(g)}>
          {g}
        </button>
      ))}
    </div>
  );
}

// ---------- Discover ----------

interface CatalogRef {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
  key: string;
}

function browsableCatalogs(addons: InstalledAddon[]): CatalogRef[] {
  const out: CatalogRef[] = [];
  for (const addon of addons.filter((a) => a.enabled && provides(a, 'catalog'))) {
    for (const catalog of addon.manifest.catalogs) {
      // Search-only catalogs belong to Search; genre-required ones are fine (a genre gets picked).
      const needs = catalogNeeds(catalog).filter((n) => n !== 'genre');
      if (needs.length) continue;
      out.push({ addon, catalog, key: `${addon.manifest.id}:${catalog.type}:${catalog.id}` });
    }
  }
  return out;
}

export function Discover({ type, catalog: catalogKey, genre }: { type?: string; catalog?: string; genre?: string }) {
  const addons = useAddons((s) => s.addons);
  const replace = useNav((s) => s.replace);
  const all = useMemo(() => browsableCatalogs(addons), [addons]);
  const types = [...new Set(all.map((c) => c.catalog.type))].sort((a, b) => (a === 'movie' ? -1 : b === 'movie' ? 1 : a === 'series' ? -1 : b === 'series' ? 1 : a.localeCompare(b)));
  const currentType = type && types.includes(type) ? type : types[0];
  const forType = all.filter((c) => c.catalog.type === currentType);
  const current = forType.find((c) => c.key === catalogKey) ?? forType[0];
  const genres = current ? genreOptions(current.catalog) : [];
  const genreRequired = current ? catalogNeeds(current.catalog).includes('genre') : false;
  const currentGenre = genre && genres.includes(genre) ? genre : genreRequired ? genres[0] : undefined;

  const set = (patch: { type?: string; catalog?: string; genre?: string }) => replace({ name: 'discover', type: currentType, catalog: current?.key, genre: currentGenre, ...patch });

  const q = useCatalog(current?.addon.manifest.id ?? '', current?.catalog.type ?? '', current?.catalog.id ?? '', { genre: currentGenre }, !!current);
  const items = flatItems(q.data?.pages);

  if (!all.length) {
    return (
      <div className="screen-pad">
        <Empty icon={<Compass size={40} />} title="Nothing to browse yet">
          Add a metadata addon with catalogs (such as AIOMetadata) in Settings → Addons.
        </Empty>
      </div>
    );
  }

  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">Discover</h1>
        <div className="page-head__controls">
          <div className="segmented" role="radiogroup" aria-label="Type">
            {types.map((t) => (
              <button key={t} role="radio" aria-checked={t === currentType} className={`segmented__item ${t === currentType ? 'is-on' : ''}`} onClick={() => set({ type: t, catalog: undefined, genre: undefined })}>
                {typeName(t)}
              </button>
            ))}
          </div>
          {forType.length > 1 && current && (
            <Select
              label="Catalog"
              value={current.key}
              options={forType.map((c) => ({ value: c.key, label: c.catalog.name, detail: c.addon.manifest.name }))}
              onChange={(k) => set({ catalog: k, genre: undefined })}
            />
          )}
        </div>
      </header>
      {current && <GenreChips catalog={current.catalog} value={currentGenre} onChange={(g) => set({ genre: g })} />}
      <div className="page-body">
        {q.isError ? (
          <Empty title="This catalog did not load">{current?.addon.manifest.name} did not answer. Try again in a moment.</Empty>
        ) : !q.isLoading && items.length === 0 ? (
          <Empty title="Nothing here">This catalog is empty{currentGenre ? ` for ${currentGenre}` : ''}.</Empty>
        ) : (
          <PosterGrid items={items} loading={q.isLoading || q.isFetchingNextPage} hasMore={q.hasNextPage} loadMore={() => !q.isFetchingNextPage && void q.fetchNextPage()} />
        )}
      </div>
    </div>
  );
}

// ---------- One catalog ("See all") ----------

export function CatalogPage({ addonId, type, catalogId, title, genre }: { addonId: string; type: string; catalogId: string; title?: string; genre?: string }) {
  const addon = useCatalogSources().find((a) => a.manifest.id === addonId);
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
        {!q.isLoading && items.length === 0 ? (
          <Empty title="Nothing here" />
        ) : (
          <PosterGrid items={items} loading={q.isLoading || q.isFetchingNextPage} hasMore={q.hasNextPage} loadMore={() => !q.isFetchingNextPage && void q.fetchNextPage()} />
        )}
      </div>
    </div>
  );
}

// ---------- Search ----------

interface SearchTarget {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
}

function searchTargets(addons: InstalledAddon[]): SearchTarget[] {
  const out: SearchTarget[] = [];
  for (const addon of addons.filter((a) => a.enabled && provides(a, 'catalog'))) {
    for (const catalog of addon.manifest.catalogs) {
      if (!catalogSupports(catalog, 'search')) continue;
      const otherRequired = catalogExtras(catalog).filter((e) => e.isRequired && e.name !== 'search');
      if (otherRequired.length) continue;
      out.push({ addon, catalog });
    }
  }
  // Matches on the user's own servers lead each list.
  return out.sort((a, b) => Number(isServerAddon(b.addon)) - Number(isServerAddon(a.addon)));
}

const HISTORY_DOC = () => profileDoc('searches');

export function Search({ q: initial }: { q?: string }) {
  const addons = useCatalogSources();
  const replace = useNav((s) => s.replace);
  const [text, setText] = useState(initial ?? '');
  const [query, setQuery] = useState(initial ?? '');
  const [recent, setRecent] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void docs.read<string[]>(HISTORY_DOC()).then((r) => setRecent(r ?? []));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = text.trim();
      setQuery(q);
      replace({ name: 'search', q: q || undefined });
    }, 380);
    return () => window.clearTimeout(t);
  }, [text, replace]);

  useEffect(() => {
    if (query.length < 2) return;
    const t = window.setTimeout(() => {
      const next = [query, ...recent.filter((r) => r.toLowerCase() !== query.toLowerCase())].slice(0, 12);
      setRecent(next);
      void docs.write(HISTORY_DOC(), next);
    }, 2500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const targets = useMemo(() => searchTargets(addons), [addons]);
  const results = useQueries({
    queries: targets.map((t) => ({
      queryKey: ['search', t.addon.manifest.id, t.catalog.type, t.catalog.id, query],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchCatalog(t.addon, t.catalog, { search: query }, signal),
      enabled: query.length >= 2,
      staleTime: 10 * 60 * 1000,
    })),
  });

  // Merge by type, dropping duplicates across addons.
  const byType = useMemo(() => {
    const map = new Map<string, MetaPreview[]>();
    const seen = new Set<string>();
    results.forEach((r) => {
      for (const m of r.data ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const list = map.get(m.type) ?? [];
        list.push(m);
        map.set(m.type, list);
      }
    });
    return [...map.entries()].sort(([a], [b]) => (a === 'movie' ? -1 : b === 'movie' ? 1 : a === 'series' ? -1 : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(','), query]);

  const loading = results.some((r) => r.isLoading && r.fetchStatus !== 'idle');
  const idMatch = /^(tt\d{5,}|tmdb:\d+)$/i.exec(query);

  return (
    <div className="screen-pad">
      <div className="search-field">
        <SearchIcon size={22} className="search-field__icon" />
        <input
          ref={input}
          className="search-field__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Movies, shows, people… or an IMDb id"
          spellCheck={false}
          aria-label="Search"
          onKeyDown={(e) => e.key === 'Escape' && setText('')}
        />
        {loading && <Spinner size={20} />}
        {text && (
          <button className="ibtn ibtn--sm" aria-label="Clear" onClick={() => (setText(''), input.current?.focus())}>
            <X size={18} />
          </button>
        )}
      </div>

      {!query && recent.length > 0 && (
        <section className="recent-searches">
          <h2 className="eyebrow">Recent searches</h2>
          <div className="chips">
            {recent.map((r) => (
              <button key={r} className="chip" onClick={() => setText(r)}>
                <Clock size={13} /> {r}
              </button>
            ))}
            <button
              className="chip chip--ghost"
              onClick={() => {
                setRecent([]);
                void docs.write(HISTORY_DOC(), []);
              }}
            >
              Clear
            </button>
          </div>
        </section>
      )}

      {!targets.length && <Empty title="No addon can search">Add a metadata addon with search (AIOMetadata can) in Settings → Addons.</Empty>}

      {idMatch && (
        <button className="id-jump" onClick={() => navigate({ name: 'title', type: 'movie', id: idMatch[1].toLowerCase() })}>
          Open {idMatch[1]} directly
        </button>
      )}

      {query.length >= 2 && !loading && byType.length === 0 && targets.length > 0 && <Empty title={`Nothing found for “${query}”`}>Check the spelling, or try the original title.</Empty>}

      {byType.map(([type, items]) => (
        <section key={type} className="search-section">
          <h2 className="row__title">
            {typeName(type)} <span className="row__count">{items.length}</span>
          </h2>
          <PosterGrid items={items} />
        </section>
      ))}
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
  const q = useQuery({ queryKey: ['person', id], queryFn: () => tmdb<PersonDetails>(`/person/${id}`, { append_to_response: 'combined_credits' }), staleTime: 24 * 3600 * 1000 });
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
      {q.isLoading ? <Spinner /> : <PosterGrid items={credits} />}
    </div>
  );
}

// ---------- Collections ----------

export function CollectionPage({ id, folder }: { id: string; folder?: string }) {
  const collection = useCollections((s) => s.collections.find((c) => c.id === id));
  const replace = useNav((s) => s.replace);
  const [sourceIdx, setSourceIdx] = useState(0);
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
            <button key={f.id} className="folder-tile" onClick={() => replace({ name: 'collection', id, folder: f.id })}>
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
  return (
    <div className="screen-pad">
      <header className="page-head">
        <div>
          <button className="crumb" onClick={() => replace({ name: 'collection', id })}>
            {collection.title}
          </button>
          <h1 className="page-title">{current.title}</h1>
        </div>
        <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => navigate({ name: 'collection-edit', id, folder: current.id })}>
          Edit folder
        </Button>
      </header>
      {asRows ? (
        sources.map((s) => <SourceRow key={sourceKey(s)} source={s} />)
      ) : (
        <>
          {sources.length > 1 && (
            <div className="chips chips--scroll" role="tablist">
              {sources.map((s, i) => (
                <button key={sourceKey(s)} role="tab" aria-selected={i === sourceIdx} className={`chip ${i === sourceIdx ? 'is-on' : ''}`} onClick={() => setSourceIdx(i)}>
                  {sourceLabel(s)}
                </button>
              ))}
            </div>
          )}
          {source && <SourceGrid source={source} />}
        </>
      )}
    </div>
  );
}

function SourceGrid({ source }: { source: CollectionSource }) {
  const q = useSourceItems(source);
  const items = flatItems(q.data?.pages);
  const provider = (source.provider ?? 'addon').toLowerCase();
  if (provider === 'trakt') return <Empty title="Trakt lists are not supported yet">This folder comes from a Trakt list. ROVE will show it once Trakt is connected (planned).</Empty>;
  if (!q.isLoading && !items.length) return <Empty title="Nothing here">{provider === 'tmdb' ? 'This needs a TMDB key (Settings → Accounts).' : 'The addon for this catalog is not installed or returned nothing.'}</Empty>;
  return <PosterGrid items={items} loading={q.isLoading || q.isFetchingNextPage} hasMore={q.hasNextPage} loadMore={() => !q.isFetchingNextPage && void q.fetchNextPage()} />;
}

function SourceRow({ source }: { source: CollectionSource }) {
  const q = useSourceItems(source);
  const items = flatItems(q.data?.pages);
  if (q.isSuccess && !items.length) return null;
  return (
    <Row title={sourceLabel(source)} loading={q.isLoading} onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}>
      {items.map((m) => (
        <PosterCard key={m.id} title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, year: m.releaseInfo, rating: m.imdbRating }} />
      ))}
    </Row>
  );
}
