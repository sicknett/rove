import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Clock, Search as SearchIcon, X, Compass, Pencil } from 'lucide-react';
import { canBrowse, canOpenType, catalogExtras, catalogNeeds, catalogSupports, fetchCatalog, fetchMeta, genreOptions } from '../addons/client';
import { useAddons } from '../addons/store';
import type { InstalledAddon, ManifestCatalog, MetaPreview } from '../addons/types';
import { flatItems, useCatalog } from '../data/hooks';
import { paging, PosterGrid } from '../media/Grid';
import { Row, RowRetry } from '../media/Row';
import { PosterCard } from '../media/cards';
import { navigate, useNav, useScreen } from '../nav/router';
import { Button, Empty, Select, Spinner } from '../ui/controls';
import { findByImdb, tmdb, tmdbImage } from '../meta/tmdb';
import { Img } from '../ui/Img';
import { useCollections, folderSources, type CollectionSource } from '../state/collections';
import { useSourceItems, sourceBlocker, sourceLabel, sourceKey } from '../data/sources';
import { docs } from '../lib/native';
import { tmdbKeyId } from '../state/keys';
import { profileDoc } from '../state/profiles';
import { asMediaType } from '../data/hooks';
import { isServerAddon } from '../servers';
import { useCatalogSources } from '../servers/useSources';

const typeName = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

/** Something that should have loaded did not (as opposed to loading and being empty). */
function LoadFailed({ title, onRetry, children }: { title: string; onRetry: () => void; children?: React.ReactNode }) {
  return (
    <Empty
      title={title}
      action={
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {children}
    </Empty>
  );
}

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
  for (const addon of addons.filter(canBrowse)) {
    for (const catalog of addon.manifest.catalogs) {
      // Search-only catalogs belong to Search; genre-required ones are fine (a genre gets picked).
      const needs = catalogNeeds(catalog).filter((n) => n !== 'genre');
      if (needs.length || !canOpenType(catalog.type)) continue;
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
        {q.isLoadingError ? (
          <LoadFailed title="This catalog did not load" onRetry={() => void q.refetch()}>
            {current?.addon.manifest.name} did not answer.
          </LoadFailed>
        ) : !q.isLoading && items.length === 0 ? (
          <Empty title="Nothing here">This catalog is empty{currentGenre ? ` for ${currentGenre}` : ''}.</Empty>
        ) : (
          <PosterGrid items={items} {...paging(q)} />
        )}
      </div>
    </div>
  );
}

// ---------- One catalog ("See all") ----------

export function CatalogPage({ addonId, type, catalogId, title, genre }: { addonId: string; type: string; catalogId: string; title?: string; genre?: string }) {
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

// ---------- Search ----------

interface SearchTarget {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
}

function searchTargets(addons: InstalledAddon[]): SearchTarget[] {
  const out: SearchTarget[] = [];
  for (const addon of addons.filter(canBrowse)) {
    for (const catalog of addon.manifest.catalogs) {
      if (!catalogSupports(catalog, 'search') || !canOpenType(catalog.type)) continue;
      const otherRequired = catalogExtras(catalog).filter((e) => e.isRequired && e.name !== 'search');
      if (otherRequired.length) continue;
      out.push({ addon, catalog });
    }
  }
  // Matches on the user's own servers lead each list.
  return out.sort((a, b) => Number(isServerAddon(b.addon)) - Number(isServerAddon(a.addon)));
}

const HISTORY_DOC = () => profileDoc('searches');

const savedSearches = (doc: string) => docs.read<string[]>(doc).then((r) => (Array.isArray(r) ? r : []));

/**
 * Movie or show, for an IMDb id typed into Search. TMDB knows directly; without it, whichever
 * type a metadata addon answers for (a movie when that does not settle it).
 */
async function typeOfImdbId(id: string): Promise<'movie' | 'series'> {
  const known = await findByImdb(id).catch(() => null);
  if (known) return known.kind === 'tv' ? 'series' : 'movie';
  const [movie, series] = await Promise.all([fetchMeta('movie', id).catch(() => null), fetchMeta('series', id).catch(() => null)]);
  const types = [movie?.type, series?.type];
  return types.includes('series') && !types.includes('movie') ? 'series' : 'movie';
}

export function Search({ q: initial }: { q?: string }) {
  const addons = useCatalogSources();
  const screen = useScreen();
  const [text, setText] = useState(initial ?? '');
  const [query, setQuery] = useState(initial ?? '');
  const [recent, setRecent] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void savedSearches(HISTORY_DOC())
      .then(setRecent)
      .catch(() => undefined);
  }, []);

  // The box takes the keyboard whenever Search comes on show (first time, or back from another
  // tab), and on Ctrl+K or "/" while it already is.
  useEffect(() => {
    if (!screen.active) return;
    const focus = () => (input.current?.focus(), input.current?.select());
    input.current?.focus();
    window.addEventListener('rove:focus-search', focus);
    return () => window.removeEventListener('rove:focus-search', focus);
  }, [screen.active]);

  useEffect(() => {
    // Only while this screen is the one on show. `replace` rewrites whichever page is current,
    // so a timer that outlived a click on a result would turn that title's page into Search.
    if (!screen.active) return;
    const t = window.setTimeout(() => {
      const q = text.trim();
      setQuery(q);
      const nav = useNav.getState();
      if (nav.stack[nav.index].key === screen.key) nav.replace({ name: 'search', q: q || undefined });
    }, 380);
    return () => window.clearTimeout(t);
  }, [text, screen.active, screen.key]);

  useEffect(() => {
    if (query.length < 2) return;
    const doc = HISTORY_DOC();
    const t = window.setTimeout(() => {
      // From the saved list, read now: this screen can start with a query before its own copy has
      // loaded (it is empty then), and writing from that copy would wipe the list.
      void savedSearches(doc)
        .then((saved) => {
          const next = [query, ...saved.filter((r) => r.toLowerCase() !== query.toLowerCase())].slice(0, 12);
          setRecent(next);
          return docs.write(doc, next);
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearTimeout(t);
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
  const idMatch = /^(tt\d{5,}|tmdb:\d+)$/i.exec(query)?.[1].toLowerCase();
  // Addons that did not answer are said so: no results from them is not "nothing found".
  const failed = [...new Set(targets.filter((_, i) => results[i]?.isError).map((t) => t.addon.manifest.name))];
  const retry = () => results.forEach((r) => r.isError && void r.refetch());

  const openImdb = async (id: string) => {
    setOpening(true);
    try {
      navigate({ name: 'title', type: await typeOfImdbId(id), id });
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="screen-pad">
      <div className="search-field">
        <SearchIcon size={22} className="search-field__icon" />
        <input
          ref={input}
          className="search-field__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Movies and shows, or an IMDb id"
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

      {query.length < 2 && recent.length > 0 && (
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

      {query.length === 1 && <p className="s-empty">Search starts at two letters.</p>}

      {!targets.length && <Empty title="No addon can search">Add a metadata addon with search (AIOMetadata can) in Settings → Addons.</Empty>}

      {idMatch &&
        (idMatch.startsWith('tt') ? (
          <button className="id-jump" disabled={opening} onClick={() => void openImdb(idMatch)}>
            {opening ? `Opening ${idMatch}…` : `Open ${idMatch} directly`}
          </button>
        ) : (
          // A TMDB number can be a movie and a show at once: the user says which.
          <div className="chips">
            <button className="id-jump" onClick={() => navigate({ name: 'title', type: 'movie', id: idMatch })}>
              Open {idMatch} as a movie
            </button>
            <button className="id-jump" onClick={() => navigate({ name: 'title', type: 'series', id: idMatch })}>
              Open {idMatch} as a show
            </button>
          </div>
        ))}

      {query.length >= 2 &&
        !loading &&
        byType.length === 0 &&
        targets.length > 0 &&
        (failed.length ? (
          <LoadFailed title="Search did not load" onRetry={retry}>
            {failed.join(', ')} did not answer.
          </LoadFailed>
        ) : (
          <Empty title={`Nothing found for “${query}”`}>Check the spelling, or try the original title.</Empty>
        ))}

      {byType.map(([type, items]) => (
        <section key={type} className="search-section">
          <h2 className="row__title">
            {typeName(type)} <span className="row__count">{items.length}</span>
          </h2>
          <PosterGrid items={items} />
        </section>
      ))}

      {byType.length > 0 && failed.length > 0 && !loading && (
        <p className="load-more">
          {failed.join(', ')} did not answer.
          <button className="row__more" onClick={retry}>
            Try again
          </button>
        </p>
      )}
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
  if (why === 'tmdb-key') return <Empty title="This needs a TMDB key">Add one in Settings → Accounts.</Empty>;
  if (why === 'addon') return <Empty title="The addon for this catalog is not available">It is not installed, or it is switched off in Settings → Addons.</Empty>;
  return <Empty title="This source is not supported">ROVE shows addon catalogs and TMDB lists. This source is neither.</Empty>;
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
        <Empty title="This folder has no sources yet">Add an addon catalog or a TMDB list with Edit folder.</Empty>
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
        {(source.provider ?? 'addon').toLowerCase() === 'tmdb' ? 'TMDB' : 'The addon'} did not answer.
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
