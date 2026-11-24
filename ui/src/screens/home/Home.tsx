import { useEffect, useMemo, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Compass, FolderOpen, Pencil, Puzzle, Trash2, Upload } from 'lucide-react';
import { openContextMenu } from '../../ui/contextmenu';
import { toast } from '../../ui/toast';
import { catalogKey, catalogNeeds, homeCatalogs } from '../../addons/client';
import { useAddons } from '../../addons/store';
import type { InstalledAddon, ManifestCatalog, MetaPreview } from '../../addons/types';
import { asMediaType, flatItems, useCardArt, useCatalog, useContinueWatching } from '../../data/hooks';
import { Row, useNearViewport } from '../../media/Row';
import { PosterCard, WideCard } from '../../media/cards';
import { navigate } from '../../nav/router';
import { CONTINUE_KEY, useHomeLayout, type RowPref } from '../../state/homeLayout';
import { folderSources, parseCollections, useCollections, type Collection, type CollectionSource } from '../../state/collections';
import { fetchSourcePage, sourceKey } from '../../data/sources';
import { useSettings } from '../../state/settings';
import { Button, Empty } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { playContinue } from '../../player/launch';
import { Hero } from './Hero';
import { isServerAddon } from '../../servers';
import { useCatalogSources } from '../../servers/useSources';

interface CatalogRowDef {
  kind: 'catalog';
  key: string;
  addon: InstalledAddon;
  catalog: ManifestCatalog;
  title: string;
}
interface CollectionRowDef {
  kind: 'collection';
  key: string;
  collection: Collection;
  title: string;
}
interface ContinueRowDef {
  kind: 'continue';
  key: string;
  title: string;
}
type RowDef = CatalogRowDef | CollectionRowDef | ContinueRowDef;

const typeLabel = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

function useRowDefs() {
  const addons = useCatalogSources();
  const collections = useCollections((s) => s.collections);
  const prefs = useHomeLayout((s) => s.items);
  const ensure = useHomeLayout((s) => s.ensure);

  const available = useMemo(() => {
    const defs: RowDef[] = [{ kind: 'continue', key: CONTINUE_KEY, title: 'Continue Watching' }];
    const seen = new Set<string>();
    for (const addon of addons.filter((a) => a.enabled)) {
      for (const catalog of homeCatalogs(addon)) {
        const key = catalogKey(addon, catalog);
        if (seen.has(key)) continue;
        seen.add(key);
        defs.push({ kind: 'catalog', key, addon, catalog, title: isServerAddon(addon) ? catalog.name : `${catalog.name} · ${typeLabel(catalog.type)}` });
      }
    }
    for (const c of collections) defs.push({ kind: 'collection', key: `collection_${c.id}`, collection: c, title: c.title });
    return defs;
  }, [addons, collections]);

  useEffect(() => {
    if (useHomeLayout.getState().loaded) ensure(available.map((d) => d.key));
  }, [available, ensure]);

  return useMemo(() => {
    const prefOf = new Map(prefs.map((p) => [p.key, p]));
    const rows = available
      .map((d) => ({ def: d, pref: prefOf.get(d.key) }))
      .filter((x): x is { def: RowDef; pref: RowPref } => !!x.pref && x.pref.enabled)
      .sort((a, b) => {
        const pinA = a.def.kind === 'collection' && a.def.collection.pinToTop ? 0 : 1;
        const pinB = b.def.kind === 'collection' && b.def.collection.pinToTop ? 0 : 1;
        return pinA - pinB || a.pref.order - b.pref.order;
      })
      .map(({ def, pref }) => ({ ...def, title: pref.customTitle || def.title, hero: !!pref.hero }));
    return rows;
  }, [available, prefs]);
}

export function Home() {
  const loaded = useAddons((s) => s.loaded);
  const addonCount = useAddons((s) => s.addons.length);
  const heroOn = useHomeLayout((s) => s.heroEnabled);
  const heroSetting = useSettings((s) => s.settings.appearance.heroEnabled);
  const rows = useRowDefs();
  const allAddons = useAddons((s) => s.addons);
  const collectionCount = useCollections((s) => s.collections.length);
  // Catalogs the addon itself keeps off Home (for collections, or needing a genre): offer a way in.
  const keptOff = allAddons.some((a) => a.enabled && a.manifest.catalogs.some((c) => c.showInHome === false || catalogNeeds(c).some((n) => n !== 'search')));
  const showBuildHome = collectionCount === 0 && (keptOff || !rows.some((r) => r.kind !== 'continue'));

  // The banner takes titles from rows marked for it, else the first catalog row, else the first
  // folders of the first collection (collection-based setups have no catalog rows).
  const collections = useCollections((s) => s.collections);
  const heroFeeds = useMemo(() => {
    const marked = rows.filter((r): r is CatalogRowDef & { hero: boolean } => r.kind === 'catalog' && r.hero).slice(0, 2);
    const firstCatalog = rows.find((r): r is CatalogRowDef & { hero: boolean } => r.kind === 'catalog' && r.catalog.type !== 'library' && !isServerAddon(r.addon));
    const catalogFeeds = (marked.length ? marked : firstCatalog ? [firstCatalog] : []).map((r) => ({
      key: r.key,
      source: { provider: 'addon', addonId: r.addon.manifest.id, type: r.catalog.type, catalogId: r.catalog.id } as CollectionSource,
    }));
    if (catalogFeeds.length) return catalogFeeds;
    const first = collections[0];
    return (first?.folders ?? [])
      .slice(0, 3)
      .map((f) => folderSources(f).find((src) => (src.provider ?? 'addon').toLowerCase() !== 'trakt'))
      .filter((src): src is CollectionSource => !!src)
      .slice(0, 2)
      .map((source) => ({ key: sourceKey(source), source }));
  }, [rows, collections]);
  const heroQueries = useQueries({
    queries: heroFeeds.map((f) => ({
      queryKey: ['hero', f.key],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchSourcePage(f.source, (f.source.provider ?? 'addon') === 'tmdb' ? 1 : 0, signal),
      staleTime: 20 * 60 * 1000,
    })),
  });
  const heroItems = useMemo(() => {
    const lists = heroQueries.map((q) => (q.data ?? []).filter((m) => m.background || m.poster));
    const out: MetaPreview[] = [];
    for (let i = 0; i < 10; i++) for (const l of lists) if (l[i] && !out.some((x) => x.id === l[i].id)) out.push(l[i]);
    return out.slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroQueries.map((q) => q.dataUpdatedAt).join(',')]);

  if (loaded && addonCount === 0) {
    return (
      <div className="screen-pad">
        <Empty icon={<Puzzle size={40} />} title="Add your addons to fill Home" action={<Button variant="primary" onClick={() => navigate({ name: 'settings', section: 'addons' })}>Open addons</Button>}>
          ROVE shows catalogs from your metadata addon (such as AIOMetadata) and plays from your stream addon (such as AIOStreams).
        </Empty>
      </div>
    );
  }

  return (
    <div className="home">
      {heroOn && heroSetting && heroItems.length > 0 && <Hero items={heroItems} />}
      <div className={`home__rows ${heroOn && heroSetting && heroItems.length ? 'home__rows--under-hero' : ''}`}>
        {showBuildHome && <NoHomeRows />}
        {rows.map((r) =>
          r.kind === 'continue' ? (
            <ContinueRow key={r.key} title={r.title} />
          ) : r.kind === 'catalog' ? (
            <CatalogRow key={r.key} def={r} />
          ) : (
            <CollectionRow key={r.key} def={r} />
          ),
        )}
      </div>
    </div>
  );
}

/** Shown when no installed catalog can sit on Home (common with collection-based setups). */
function NoHomeRows() {
  const file = useRef<HTMLInputElement>(null);
  const importFile = async (f: File) => {
    try {
      const parsed = parseCollections(JSON.parse(await f.text()));
      if (!parsed.length) throw new Error('empty');
      useCollections.getState().merge(parsed);
      toast.success(`Imported ${parsed.length} collection${parsed.length > 1 ? 's' : ''}`);
    } catch {
      toast.error('That file is not a collection export.');
    }
  };
  return (
    <section className="home-empty">
      <div className="home-empty__text">
        <h2 className="home-empty__title">Build your Home</h2>
        <p className="home-empty__body">
          Your metadata addon keeps its catalogs off Home (they are meant for collections or need a genre picked). Import a collection file to fill Home, or browse every catalog in Discover.
        </p>
      </div>
      <div className="home-empty__actions">
        <Button variant="primary" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
          Import collection
        </Button>
        <Button variant="secondary" icon={<Compass size={16} />} onClick={() => navigate({ name: 'discover' })}>
          Open Discover
        </Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => (e.target.files?.[0] && void importFile(e.target.files[0]), (e.target.value = ''))} />
      </div>
    </section>
  );
}

function ContinueRow({ title }: { title: string }) {
  const { items } = useContinueWatching(30);
  const landscape = useSettings((s) => s.settings.appearance.landscapeContinueWatching);
  useCardArt(items.map((i) => ({ metaId: i.metaId, type: i.type, name: i.name, poster: i.poster })));
  if (!items.length) return null;
  return (
    <Row title={title} shape={landscape ? 'wide' : 'poster'} className="row--continue" action={<button className="row__more" onClick={() => navigate({ name: 'library', tab: 'continue' })}>See all</button>}>
      {items.map((it) => {
        const card = { metaId: it.metaId, type: it.type, name: it.name, poster: it.poster, background: it.background, logo: it.logo };
        const sub = it.type === 'series' && it.season !== undefined ? `${it.kind === 'next' ? 'Next · ' : ''}S${it.season} E${it.episode}${it.episodeTitle ? ` · ${it.episodeTitle}` : ''}` : undefined;
        return landscape ? (
          <WideCard
            key={it.metaId}
            title={card}
            image={it.still && it.kind === 'resume' ? it.still : it.background ?? it.still}
            subtitle={sub}
            progress={it.progress}
            remainingS={it.durationS && it.positionS && !it.estimated ? it.durationS - it.positionS : undefined}
            continueKey={it.key}
            season={it.season}
            episode={it.episode}
            onPlay={() => void playContinue(it)}
          />
        ) : (
          <PosterCard key={it.metaId} title={{ ...card, year: sub }} progress={it.progress} onPlay={() => void playContinue(it)} />
        );
      })}
    </Row>
  );
}

function CatalogRow({ def }: { def: CatalogRowDef }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const q = useCatalog(def.addon.manifest.id, def.catalog.type, def.catalog.id, {}, near);
  const items = flatItems(q.data?.pages);
  if (q.isSuccess && items.length === 0) return <div ref={ref} />;
  return (
    <div ref={ref}>
      <Row
        title={def.title}
        loading={!near || q.isLoading}
        onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
        action={
          <button className="row__more" onClick={() => navigate({ name: 'catalog', addonId: def.addon.manifest.id, type: def.catalog.type, catalogId: def.catalog.id, title: def.title })}>
            See all
          </button>
        }
      >
        {items.map((m) => (
          <PosterCard
            key={m.id}
            title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo, rating: m.imdbRating }}
            progress={(m as { progress?: number }).progress}
          />
        ))}
        {q.isFetchingNextPage && <div className="row__more-spinner" />}
      </Row>
    </div>
  );
}

/** Home shows this many folders per collection row; Open shows them all. */
const ROW_FOLDER_LIMIT = 24;

function CollectionRow({ def }: { def: CollectionRowDef }) {
  const folders = def.collection.folders;
  if (!folders.length) return null;
  const wide = folders.some((f) => (f.tileShape ?? '').toLowerCase().match(/landscape|wide/));
  return (
    <Row
      title={def.title}
      shape={wide ? 'wide' : 'poster'}
      action={
        <span className="row__actions">
          <button className="row__more" onClick={() => navigate({ name: 'collection-edit', id: def.collection.id })}>
            Edit
          </button>
          <button className="row__more" onClick={() => navigate({ name: 'collection', id: def.collection.id })}>
            {folders.length > ROW_FOLDER_LIMIT ? `All ${folders.length}` : 'Open'}
          </button>
        </span>
      }
    >
      {folders.slice(0, ROW_FOLDER_LIMIT).map((f, i) => (
        <div
          key={f.id}
          className={`card ${wide ? 'card--wide' : 'card--poster'} card--folder`}
          onContextMenu={(e) => {
            const store = useCollections.getState();
            const cid = def.collection.id;
            openContextMenu(e, [
              { label: 'Open', icon: <FolderOpen size={16} />, onSelect: () => navigate({ name: 'collection', id: cid, folder: f.id }) },
              { label: 'Edit folder', icon: <Pencil size={16} />, onSelect: () => navigate({ name: 'collection-edit', id: cid, folder: f.id }) },
              'divider',
              { label: 'Move left', icon: <ArrowLeft size={16} />, onSelect: () => store.moveFolder(cid, f.id, i - 1), disabled: i === 0 },
              { label: 'Move right', icon: <ArrowRight size={16} />, onSelect: () => store.moveFolder(cid, f.id, i + 1), disabled: i === folders.length - 1 },
              'divider',
              {
                label: 'Remove from this row',
                icon: <Trash2 size={16} />,
                danger: true,
                onSelect: () => {
                  const removed = store.removeFolder(cid, f.id);
                  if (removed) toast.info(`${f.title} removed`, { label: 'Undo', run: () => store.restoreFolder(cid, removed, i) });
                },
              },
            ]);
          }}
        >
          <button className="card__frame" onClick={() => navigate({ name: 'collection', id: def.collection.id, folder: f.id })} aria-label={f.title}>
            <Img src={f.coverImageUrl ?? undefined} alt="" className="card__img" fallback={<span className="card__monogram">{f.coverEmoji ?? f.title[0]}</span>} />
            {!f.hideTitle && (
              <>
                <span className="card__scrim" aria-hidden />
                <span className="card__folder-title">{f.title}</span>
              </>
            )}
          </button>
        </div>
      ))}
    </Row>
  );
}
