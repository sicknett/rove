// Discover's second mode: the addons' own catalogs, one at a time, as they come. What Discover
// was before it could narrow TMDB down; still the way to see everything a catalog holds.

import { useMemo } from 'react';
import { Compass } from 'lucide-react';
import { canBrowse, canOpenType, catalogNeeds, genreOptions } from '../../addons/client';
import { useAddons } from '../../addons/store';
import type { InstalledAddon, ManifestCatalog } from '../../addons/types';
import { flatItems, useCatalog } from '../../data/hooks';
import { paging, PosterGrid } from '../../media/Grid';
import { useScreen } from '../../nav/router';
import { Empty, Select } from '../../ui/controls';
import { GenreChips, LoadFailed } from '../shared/parts';

const typeName = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

interface CatalogRef {
  addon: InstalledAddon;
  catalog: ManifestCatalog;
  key: string;
}

export function browsableCatalogs(addons: InstalledAddon[]): CatalogRef[] {
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

/** Whether any addon has a catalog to browse. */
export function useHasCatalogs(): boolean {
  const addons = useAddons((s) => s.addons);
  return useMemo(() => browsableCatalogs(addons).length > 0, [addons]);
}

interface Props {
  type?: string;
  catalog?: string;
  genre?: string;
  onSet: (next: { type?: string; catalog?: string; genre?: string }) => void;
  /** The switch back to filters, when there is one to switch to. */
  modeSwitch?: React.ReactNode;
  /** Said under the heading (why filters are not on offer). */
  note?: React.ReactNode;
}

export function Catalogs({ type, catalog: catalogKey, genre, onSet, modeSwitch, note }: Props) {
  const screen = useScreen();
  const addons = useAddons((s) => s.addons);
  const all = useMemo(() => browsableCatalogs(addons), [addons]);
  const types = [...new Set(all.map((c) => c.catalog.type))].sort((a, b) => (a === 'movie' ? -1 : b === 'movie' ? 1 : a === 'series' ? -1 : b === 'series' ? 1 : a.localeCompare(b)));
  const currentType = type && types.includes(type) ? type : types[0];
  const forType = all.filter((c) => c.catalog.type === currentType);
  const current = forType.find((c) => c.key === catalogKey) ?? forType[0];
  const genres = current ? genreOptions(current.catalog) : [];
  const genreRequired = current ? catalogNeeds(current.catalog).includes('genre') : false;
  const currentGenre = genre && genres.includes(genre) ? genre : genreRequired ? genres[0] : undefined;

  const set = (patch: { type?: string; catalog?: string; genre?: string }) => onSet({ type: currentType, catalog: current?.key, genre: currentGenre, ...patch });

  // Only while Discover is the screen on show: a hidden one loads no catalog, and no further pages.
  const q = useCatalog(current?.addon.manifest.id ?? '', current?.catalog.type ?? '', current?.catalog.id ?? '', { genre: currentGenre }, !!current && screen.active);
  const items = flatItems(q.data?.pages);
  const pages = paging(q);

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">Discover</h1>
          {note && <p className="page-sub page-sub--note">{note}</p>}
        </div>
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
          {modeSwitch}
        </div>
      </header>
      {current && <GenreChips catalog={current.catalog} value={currentGenre} onChange={(g) => set({ genre: g })} />}
      <div className="page-body">
        {!current ? (
          <Empty icon={<Compass size={40} />} title="Nothing to browse yet">
            Add a metadata addon with catalogs (such as AIOMetadata) in Settings → Addons.
          </Empty>
        ) : q.isLoadingError ? (
          <LoadFailed title="This catalog did not load" onRetry={() => void q.refetch()}>
            {current.addon.manifest.name} did not answer.
          </LoadFailed>
        ) : !q.isLoading && q.isSuccess && items.length === 0 ? (
          <Empty title="Nothing here">This catalog is empty{currentGenre ? ` for ${currentGenre}` : ''}.</Empty>
        ) : (
          <PosterGrid items={items} {...pages} loading={pages.loading || (!q.data && !q.isError)} hasMore={pages.hasMore && screen.active} />
        )}
      </div>
    </>
  );
}
