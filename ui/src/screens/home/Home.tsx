import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Compass, EyeOff, FolderOpen, FolderPen, Pencil, Puzzle, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { openContextMenu } from '../../ui/contextmenu';
import { toast } from '../../ui/toast';
import { catalogKey, catalogNeeds, homeCatalogs } from '../../addons/client';
import { ADDONS_UNREADABLE, useAddons } from '../../addons/store';
import type { InstalledAddon, ManifestCatalog, MetaPreview } from '../../addons/types';
import { asMediaType, flatItems, useCardArt, useCatalog, useContinueWatching } from '../../data/hooks';
import { Row, RowRetry, useNearViewport } from '../../media/Row';
import { PosterCard, WideCard } from '../../media/cards';
import { navigate } from '../../nav/router';
import { CONTINUE_KEY, FOR_YOU_KEY, isSmartKey, useHomeLayout, type RowPref } from '../../state/homeLayout';
import { useSmartRowDefs } from '../../recs/hooks';
import { SmartRow } from './SmartRows';
import { useAssistantSettings } from '../../ai';
import { ForYouRow } from '../../ai/ForYouRow';
import { folderSources, listRowKey, parseCollections, useCollections, withHiddenCollectionKeys, type Collection, type CollectionFolder, type CollectionSource, type ListRow } from '../../state/collections';
import { fetchSourcePage, sourceBlocker, sourceKey } from '../../data/sources';
import { ListHomeRow, removeListRow } from '../../lists/ListRow';
import { useSettings } from '../../state/settings';
import { Button, Empty, type MenuItem } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { playContinue } from '../../player/launch';
import { Hero } from './Hero';
import { useAmbient } from './ambient';
import { AmbientLayer } from './AmbientLayer';
import { usePersonalHeroItems } from './heroSource';
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
/** The AI assistant's recommendations (ai/ForYouRow). Exists only while an assistant is connected. */
interface ForYouRowDef {
  kind: 'for-you';
  key: string;
  title: string;
}
/** A list imported as a row of its own (lists/ListRow). */
interface ListRowDef {
  kind: 'list';
  key: string;
  list: ListRow;
  title: string;
}
/** A row made from the profile's own history (recs/, SmartRows): Top picks, Because you watched, the Top 10s, … */
interface SmartRowDef {
  kind: 'smart';
  key: string;
  title: string;
}
type RowDef = CatalogRowDef | CollectionRowDef | ContinueRowDef | ForYouRowDef | ListRowDef | SmartRowDef;

const typeLabel = (t: string) => (t === 'movie' ? 'Movies' : t === 'series' ? 'Shows' : t[0].toUpperCase() + t.slice(1));

function useRowDefs() {
  const addons = useCatalogSources();
  const collections = useCollections((s) => s.collections);
  const lists = useCollections((s) => s.lists);
  const prefs = useHomeLayout((s) => s.items);
  const ensure = useHomeLayout((s) => s.ensure);
  const assistantOn = !!useAssistantSettings();
  const smart = useSmartRowDefs();

  const available = useMemo(() => {
    const defs: RowDef[] = [{ kind: 'continue', key: CONTINUE_KEY, title: 'Continue Watching' }];
    if (assistantOn) defs.push({ kind: 'for-you', key: FOR_YOU_KEY, title: 'For you' });
    for (const d of smart) defs.push({ kind: 'smart', key: d.key, title: d.title });
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
    for (const l of lists) defs.push({ kind: 'list', key: listRowKey(l.id), list: l, title: l.title });
    return defs;
  }, [addons, collections, lists, assistantOn, smart]);

  // Also when the layout itself changes: after "Reset layout" every row is missing from it, and
  // this puts them back. With nothing missing it does nothing.
  useEffect(() => {
    if (useHomeLayout.getState().loaded)
      ensure(
        // With the collections this build cannot show yet, so each has its place when one can.
        withHiddenCollectionKeys(available.map((d) => d.key)),
        // For you joins a Home that is already laid out near the top, like a pinned collection:
        // at the end of a long Home it would never be seen. So do the rows made from history,
        // together and in their own order (recs/recipes SMART_KEYS).
        available.filter((d) => d.kind === 'for-you' || d.kind === 'smart' || (d.kind === 'collection' && d.collection.pinToTop)).map((d) => d.key),
      );
  }, [available, ensure, prefs]);

  return useMemo(() => {
    const prefOf = new Map(prefs.map((p) => [p.key, p]));
    const rows = available
      .map((d) => ({ def: d, pref: prefOf.get(d.key) }))
      .filter((x): x is { def: RowDef; pref: RowPref } => !!x.pref && x.pref.enabled)
      // Exactly the order Settings → Home shows. Pinned collections are placed at the top when
      // they are added (see ensure), not forced above everything, or they bury Continue Watching.
      .sort((a, b) => a.pref.order - b.pref.order)
      .map(({ def, pref }) => ({ ...def, title: pref.customTitle || def.title, hero: !!pref.hero }));
    return rows;
  }, [available, prefs]);
}

type RowMenu = (MenuItem | 'divider')[];

/**
 * Move, hide and edit, straight from a Home row (the same changes Settings → Home layout makes).
 * `shown` is the rows that draw something right now, top to bottom: a row that is switched on but
 * empty (Continue Watching with nothing to continue, a catalog with no titles) is not a neighbour,
 * or moving past it would look like nothing happened.
 */
function rowMenu(row: RowDef, shown: string[]): RowMenu {
  const layout = useHomeLayout.getState();
  // Every row the layout knows, shown or hidden, in order: a move lands next to the neighbour on Home.
  const all = [...layout.items].sort((a, b) => a.order - b.order).map((i) => i.key);
  const at = shown.indexOf(row.key);
  const moveNextTo = (neighbour: string | undefined) => neighbour && layout.moveRow(row.key, all.indexOf(neighbour), all);
  const items: RowMenu = [
    { label: 'Move up', icon: <ArrowUp size={16} />, disabled: at <= 0, onSelect: () => moveNextTo(shown[at - 1]) },
    { label: 'Move down', icon: <ArrowDown size={16} />, disabled: at < 0 || at >= shown.length - 1, onSelect: () => moveNextTo(shown[at + 1]) },
    'divider',
  ];
  if (row.kind === 'collection') items.push({ label: 'Edit folders', icon: <FolderPen size={16} />, onSelect: () => navigate({ name: 'collection-edit', id: row.collection.id }) });
  items.push(
    {
      label: 'Hide from Home',
      icon: <EyeOff size={16} />,
      onSelect: () => {
        layout.setRow(row.key, { enabled: false });
        toast.info(`${row.title} hidden`, { label: 'Undo', run: () => useHomeLayout.getState().setRow(row.key, { enabled: true }) });
      },
    },
    { label: 'Home layout…', icon: <SlidersHorizontal size={16} />, onSelect: () => navigate({ name: 'settings', section: 'home' }) },
  );
  if (row.kind === 'list') items.push('divider', { label: 'Remove list', icon: <Trash2 size={16} />, danger: true, onSelect: () => removeListRow(row.list.id, row.title) });
  return items;
}

export function Home() {
  const loaded = useAddons((s) => s.loaded);
  const addonsUnreadable = useAddons((s) => s.loadFailed);
  const addonCount = useAddons((s) => s.addons.length);
  const heroOn = useHomeLayout((s) => s.heroEnabled);
  const heroSetting = useSettings((s) => s.settings.appearance.heroEnabled);
  const rows = useRowDefs();
  const rowsEl = useRef<HTMLDivElement>(null);
  // Read from the page when a row's menu opens: only the rows themselves know whether they have
  // anything to show.
  const drawnRows = () => [...(rowsEl.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].filter((el) => el.querySelector('.row')).map((el) => el.dataset.row!);
  const allAddons = useAddons((s) => s.addons);
  const collectionCount = useCollections((s) => s.collections.length);
  const anyRowOff = useHomeLayout((s) => s.items.some((i) => !i.enabled && i.key !== CONTINUE_KEY && i.key !== FOR_YOU_KEY && !isSmartKey(i.key)));
  // Rows besides Continue Watching and For you, which both come from what was watched and not
  // from an addon. With none, Home says how to get some; with any, it is a Home.
  const hasRows = rows.some((r) => r.kind !== 'continue' && r.kind !== 'for-you' && r.kind !== 'smart');
  // Catalogs the addon itself keeps off Home (for collections, or needing a genre): offer a way in.
  const keptOff = allAddons.some((a) => a.enabled && a.manifest.catalogs.some((c) => c.showInHome === false || catalogNeeds(c).some((n) => n !== 'search')));
  const showBuildHome = !hasRows && !addonsUnreadable && collectionCount === 0;

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
      .map((f) => folderSources(f).find((src) => !sourceBlocker(src)))
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

  // The user's own pick for the banner (Continue Watching or the watchlist) wins over the rows.
  const personalHero = usePersonalHeroItems();
  const bannerItems = personalHero ?? heroItems;
  // The page takes its colour from the banner's picture.
  const ambientOn = useSettings((s) => s.settings.appearance.ambientHome);
  const [backdrop, setBackdrop] = useState<string | undefined>(undefined);
  const showBanner = heroOn && heroSetting && bannerItems.length > 0;
  const ambient = useAmbient(backdrop, ambientOn && showBanner);

  // Only on a Home with nothing else on it: a media server's rows or collections are a Home too.
  if (loaded && addonCount === 0 && !hasRows && !addonsUnreadable) {
    return (
      <div className="screen-pad">
        <Empty icon={<Puzzle size={40} />} title="Add your addons to fill Home" action={<Button variant="primary" onClick={() => navigate({ name: 'settings', section: 'addons' })}>Open addons</Button>}>
          ROVE shows catalogs from your metadata addon (such as AIOMetadata) and plays from your stream addon (such as AIOStreams).
        </Empty>
      </div>
    );
  }

  return (
    <div className={`home${ambient ? ' home--ambient' : ''}`}>
      {/* The banner's colour, pinned behind the page. */}
      {ambientOn && showBanner && <AmbientLayer color={ambient} />}
      {showBanner && <Hero items={bannerItems} onBackdrop={setBackdrop} />}
      <div ref={rowsEl} className={`home__rows ${showBanner ? 'home__rows--under-hero' : ''}`}>
        {addonsUnreadable && <AddonsUnreadable />}
        {showBuildHome && <NoHomeRows reason={anyRowOff ? 'off' : keptOff ? 'kept-off' : 'none'} />}
        {rows.map((r) => (
          <div key={r.key} data-row={r.key}>
            {r.kind === 'continue' ? (
              <ContinueRow title={r.title} menu={() => rowMenu(r, drawnRows())} />
            ) : r.kind === 'for-you' ? (
              <ForYouRow title={r.title} menu={() => rowMenu(r, drawnRows())} />
            ) : r.kind === 'smart' ? (
              <SmartRow rowKey={r.key} title={r.title} menu={() => rowMenu(r, drawnRows())} />
            ) : r.kind === 'catalog' ? (
              <CatalogRow def={r} menu={() => rowMenu(r, drawnRows())} />
            ) : r.kind === 'list' ? (
              <ListHomeRow list={r.list} title={r.title} menu={() => rowMenu(r, drawnRows())} />
            ) : (
              <CollectionRow def={r} menu={() => rowMenu(r, drawnRows())} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The saved addons exist but could not be read: said plainly, with a way to try again. */
function AddonsUnreadable() {
  return (
    <section className="home-empty">
      <div className="home-empty__text">
        <h2 className="home-empty__title">Your addons could not be loaded</h2>
        <p className="home-empty__body">{ADDONS_UNREADABLE}</p>
      </div>
      <div className="home-empty__actions">
        <Button variant="primary" onClick={() => void useAddons.getState().load()}>
          Try again
        </Button>
      </div>
    </section>
  );
}

/**
 * Shown when Home has no rows besides Continue Watching: every row is switched off, the addons
 * keep their catalogs off Home (common with collection-based setups), or they have none.
 */
function NoHomeRows({ reason }: { reason: 'off' | 'kept-off' | 'none' }) {
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
          {reason === 'off'
            ? 'Every row is switched off. Turn rows back on in Home layout, or import a collection file.'
            : reason === 'kept-off'
              ? 'Your metadata addon keeps its catalogs off Home (they are meant for collections or need a genre picked). Import a collection file to fill Home, or browse every catalog in Discover.'
              : 'Your addons have no catalogs for Home. Add a metadata addon (such as AIOMetadata), or import a collection file.'}
        </p>
      </div>
      <div className="home-empty__actions">
        <Button variant="primary" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
          Import collection
        </Button>
        {reason === 'off' ? (
          <Button variant="secondary" icon={<SlidersHorizontal size={16} />} onClick={() => navigate({ name: 'settings', section: 'home' })}>
            Home layout
          </Button>
        ) : reason === 'kept-off' ? (
          <Button variant="secondary" icon={<Compass size={16} />} onClick={() => navigate({ name: 'discover' })}>
            Open Discover
          </Button>
        ) : (
          <Button variant="secondary" icon={<Puzzle size={16} />} onClick={() => navigate({ name: 'settings', section: 'addons' })}>
            Open addons
          </Button>
        )}
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => (e.target.files?.[0] && void importFile(e.target.files[0]), (e.target.value = ''))} />
      </div>
    </section>
  );
}

function ContinueRow({ title, menu }: { title: string; menu: () => RowMenu }) {
  const { items } = useContinueWatching(30);
  const landscape = useSettings((s) => s.settings.appearance.landscapeContinueWatching);
  useCardArt(items.map((i) => ({ metaId: i.metaId, type: i.type, name: i.name, poster: i.poster })));
  if (!items.length) return null;
  return (
    <Row title={title} menu={menu} shape={landscape ? 'wide' : 'poster'} className="row--continue" action={<button className="row__more" onClick={() => navigate({ name: 'library', tab: 'continue' })}>See all</button>}>
      {items.map((it) => {
        const card = { metaId: it.metaId, type: it.type, name: it.name, poster: it.poster, background: it.background, logo: it.logo };
        const sub = it.type === 'series' && it.season !== undefined ? `${it.kind === 'next' ? 'Next · ' : ''}S${it.season} E${it.episode}${it.episodeTitle ? ` · ${it.episodeTitle}` : ''}` : undefined;
        return landscape ? (
          <WideCard
            key={`${it.type}:${it.metaId}`}
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
          // Like the wide card: the poster plays, the name opens the title, the menu has Remove and Mark watched.
          <PosterCard key={`${it.type}:${it.metaId}`} title={card} subtitle={sub} progress={it.progress} continueKey={it.key} season={it.season} episode={it.episode} onPlay={() => void playContinue(it)} />
        );
      })}
    </Row>
  );
}

function CatalogRow({ def, menu }: { def: CatalogRowDef; menu: () => RowMenu }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const q = useCatalog(def.addon.manifest.id, def.catalog.type, def.catalog.id, {}, near);
  const items = flatItems(q.data?.pages);
  if (q.isSuccess && items.length === 0) return <div ref={ref} />;
  return (
    <div ref={ref}>
      <Row
        title={def.title}
        menu={menu}
        loading={!near || q.isLoading}
        onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && !q.isFetchNextPageError && void q.fetchNextPage()}
        action={
          <button className="row__more" onClick={() => navigate({ name: 'catalog', addonId: def.addon.manifest.id, type: def.catalog.type, catalogId: def.catalog.id, title: def.title })}>
            See all
          </button>
        }
      >
        {q.isLoadingError && <RowRetry onRetry={() => void q.refetch()}>{def.addon.manifest.name} did not answer.</RowRetry>}
        {items.map((m) => (
          <PosterCard
            key={m.id}
            title={{ metaId: m.id, type: asMediaType(m.type), name: m.name, poster: m.poster, background: m.background, logo: m.logo, year: m.releaseInfo, rating: m.imdbRating }}
            progress={(m as { progress?: number }).progress}
          />
        ))}
        {q.isFetchingNextPage && <div className="row__more-spinner" />}
        {q.isFetchNextPageError && !q.isFetchingNextPage && <RowRetry onRetry={() => void q.fetchNextPage()} />}
      </Row>
    </div>
  );
}

/** Home shows this many folders per collection row; Open shows them all. */
const ROW_FOLDER_LIMIT = 24;

/** The shape set for a folder in its editor ("Tile shape"); each tile is drawn in its own. */
const isWide = (f: CollectionFolder) => /landscape|wide/i.test(f.tileShape ?? '');

function CollectionRow({ def, menu }: { def: CollectionRowDef; menu: () => RowMenu }) {
  const folders = def.collection.folders;
  if (!folders.length) return null;
  return (
    <Row
      title={def.title}
      menu={menu}
      shape={folders.every(isWide) ? 'wide' : 'poster'}
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
          className={`card ${isWide(f) ? 'card--wide' : 'card--poster'} card--folder`}
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
