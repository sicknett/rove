import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, FolderPlus, History as HistoryIcon, Library as LibraryIcon, Pencil, Trash2, ArrowUp, ArrowDown, Upload } from 'lucide-react';
import { fetchMeta } from '../addons/client';
import { titleKey } from '../addons/ids';
import type { MetaPreview } from '../addons/types';
import { episodeGuide, useCardArt, useContinueWatching } from '../data/hooks';
import { withCard } from '../library/cardArt';
import { airTime, hasAirClock, type EpisodeRef } from '../library/continue';
import { PosterGrid } from '../media/Grid';
import { WideCard } from '../media/cards';
import { navigate, useNav } from '../nav/router';
import { playContinue, playEpisode } from '../player/launch';
import { useHistory } from '../state/history';
import { parseCollections, useCollections } from '../state/collections';
import { ImportListsButton } from '../lists/ImportLists';
import { Button, Empty, IconButton, Segmented } from '../ui/controls';
import { Img } from '../ui/Img';
import { toast } from '../ui/toast';

type Tab = 'watchlist' | 'continue' | 'history' | 'collections';

export function Library({ tab = 'watchlist' }: { tab?: Tab }) {
  const replace = useNav((s) => s.replace);
  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">Library</h1>
        <Segmented<Tab>
          label="Library section"
          value={tab}
          onChange={(t) => replace({ name: 'library', tab: t })}
          options={[
            { value: 'watchlist', label: 'Watchlist' },
            { value: 'continue', label: 'Continue Watching' },
            { value: 'history', label: 'History' },
            { value: 'collections', label: 'Collections' },
          ]}
        />
      </header>
      <div className="page-body">
        {tab === 'watchlist' && <Watchlist />}
        {tab === 'continue' && <ContinueGrid />}
        {tab === 'history' && <HistoryGrid />}
        {tab === 'collections' && <CollectionsManager />}
      </div>
    </div>
  );
}

type Sort = 'added' | 'name';

/** What is on screen is measured (and its art asked for) once scrolling has paused this long… */
const SETTLE_MS = 140;
/** …or this often while it goes on without a pause. */
const SETTLE_MAX_MS = 450;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === 'auto' || o === 'scroll') return n;
  }
  return null;
}

/**
 * Which of a grid's `count` items are on screen or about to be: the part of the grid inside the
 * scroller's view, with a screen and a bit more after it and most of a screen before (about the
 * rows the windowed grid keeps drawn). Every row of a grid is the same height, so the share of
 * its height in view is the share of its items; that holds for the windowed poster grid and for
 * a plain CSS grid alike, and needs nothing from either. The scroll handler itself only arms a
 * timer: measuring waits for a pause, so a list flicked through from top to bottom asks for the
 * art of where it ends up, not of everything it passed.
 */
function useVisibleRange<T extends HTMLElement>(count: number) {
  const ref = useRef<T>(null);
  // Until it is measured: about a screenful from the top.
  const [range, setRange] = useState({ from: 0, to: 24 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !count) return;
    const scroller = scrollParent(el);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (latest !== undefined) clearTimeout(latest);
      timer = latest = undefined;
      const box = el.getBoundingClientRect();
      if (!(box.height > 0)) return;
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const screen = view.bottom - view.top;
      const from = Math.max(0, Math.floor(((view.top - screen * 0.75 - box.top) / box.height) * count));
      const to = Math.min(count, Math.ceil(((view.bottom + screen * 1.25 - box.top) / box.height) * count));
      setRange((prev) => (prev.from === from && prev.to === to ? prev : { from, to: Math.max(from, to) }));
    };
    const settle = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(measure, SETTLE_MS);
      latest ??= setTimeout(measure, SETTLE_MAX_MS);
    };
    measure();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', settle, { passive: true });
    // The grid's height changes as it lays out and as the window is resized.
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (latest !== undefined) clearTimeout(latest);
      target.removeEventListener('scroll', settle);
      ro.disconnect();
    };
  }, [count]);
  return [ref, range] as const;
}

function Watchlist() {
  const library = useHistory((s) => s.library);
  const cards = useHistory((s) => s.cards);
  const [sort, setSort] = useState<Sort>('added');
  const [type, setType] = useState<'all' | 'movie' | 'series'>('all');
  const items = useMemo(() => {
    // An item a tracker sent may have no art of its own: the remembered card (which useCardArt
    // fills in) completes it.
    const list = Object.values(library)
      .filter((i) => type === 'all' || i.type === type)
      .map((i) => withCard(i, cards));
    list.sort((a, b) => (sort === 'added' ? b.addedAt - a.addedAt : (a.name ?? '').localeCompare(b.name ?? '')));
    return list;
  }, [library, cards, sort, type]);
  // Art only for what is on screen or about to be.
  const [gridRef, range] = useVisibleRange<HTMLDivElement>(items.length);
  useCardArt(items, { range });
  const previews = useMemo((): MetaPreview[] => items.map((i) => ({ id: i.metaId, type: i.type, name: i.name ?? '', poster: i.poster, background: i.background, releaseInfo: i.year })), [items]);
  if (!Object.keys(library).length) {
    return (
      <Empty icon={<LibraryIcon size={40} />} title="Your Watchlist is empty">
        Use the bookmark on any title to save it here. With PublicMetaDB connected, it syncs with your watchlist there.
      </Empty>
    );
  }
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: 'All' },
            { value: 'movie', label: 'Movies' },
            { value: 'series', label: 'Shows' },
          ]}
        />
        <Segmented
          label="Sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'added', label: 'Recently added' },
            { value: 'name', label: 'A–Z' },
          ]}
        />
      </div>
      <div ref={gridRef}>
        <PosterGrid items={previews} />
      </div>
    </>
  );
}

function ContinueGrid() {
  const { items, loading } = useContinueWatching(200, { art: false });
  const [gridRef, range] = useVisibleRange<HTMLDivElement>(items.length);
  // Wide cards show the title's logo, so that is asked for too.
  useCardArt(items, { range, logo: true });
  if (!items.length && !loading) return <Empty title="Nothing in progress">Start something and it shows up here, and on Home.</Empty>;
  return (
    <div className="wide-grid" ref={gridRef}>
      {items.map((it) => (
        <WideCard
          key={`${it.type}:${it.metaId}`}
          title={{ metaId: it.metaId, type: it.type, name: it.name, poster: it.poster, background: it.background, logo: it.logo }}
          image={it.still && it.kind === 'resume' ? it.still : it.background ?? it.still}
          subtitle={it.type === 'series' && it.season !== undefined ? `${it.kind === 'next' ? 'Next · ' : ''}S${it.season} E${it.episode}${it.episodeTitle ? ` · ${it.episodeTitle}` : ''}` : undefined}
          progress={it.progress}
          remainingS={it.durationS && it.positionS && !it.estimated ? it.durationS - it.positionS : undefined}
          continueKey={it.key}
          season={it.season}
          episode={it.episode}
          onPlay={() => void playContinue(it)}
        />
      ))}
    </div>
  );
}

function HistoryGrid() {
  const watched = useHistory((s) => s.watched);
  const cards = useHistory((s) => s.cards);
  const [type, setType] = useState<'all' | 'movie' | 'series'>('all');
  const titles = useMemo(() => {
    // One entry per title. A `tmdb:` id is a different title as a movie and as a show.
    const latest = new Map<string, { metaId: string; type: 'movie' | 'series'; at: number; count: number; tmdbId?: number }>();
    for (const w of Object.values(watched)) {
      const key = titleKey(w.metaId, w.type);
      const prev = latest.get(key);
      latest.set(key, { metaId: w.metaId, type: w.type, at: Math.max(prev?.at ?? 0, w.at), count: (prev?.count ?? 0) + 1, tmdbId: prev?.tmdbId ?? w.tmdbId });
    }
    return [...latest.values()].filter((t) => type === 'all' || t.type === type).sort((a, b) => b.at - a.at);
  }, [watched, type]);
  // A watched mark carries no art: all of it is the remembered card.
  const withArt = useMemo(() => titles.map((t) => withCard(t, cards)), [titles, cards]);
  // Art only for what is on screen or about to be, wherever in the list that is: the long tail
  // of an old history is not waited on, and does not wait for everything above it.
  const [gridRef, range] = useVisibleRange<HTMLDivElement>(withArt.length);
  useCardArt(withArt, { range });
  const previews = useMemo(
    (): MetaPreview[] => withArt.map((t) => ({ id: t.metaId, type: t.type, name: t.name ?? '', poster: t.poster, releaseInfo: t.type === 'series' ? `${t.count} episode${t.count > 1 ? 's' : ''}` : new Date(t.at).toLocaleDateString() })),
    [withArt],
  );
  if (!titles.length) return <Empty icon={<HistoryIcon size={40} />} title="No history yet">Finished movies and episodes appear here. Connect PublicMetaDB in Settings to bring in your history.</Empty>;
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Type"
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: `All · ${titles.length}` },
            { value: 'movie', label: 'Movies' },
            { value: 'series', label: 'Shows' },
          ]}
        />
      </div>
      <div ref={gridRef}>
        <PosterGrid items={previews} />
      </div>
    </>
  );
}

function CollectionsManager() {
  const collections = useCollections((s) => s.collections);
  const { merge, remove, move } = useCollections.getState();
  const file = useRef<HTMLInputElement>(null);

  const importFile = async (f: File) => {
    try {
      const parsed = parseCollections(JSON.parse(await f.text()));
      if (!parsed.length) throw new Error('empty');
      merge(parsed);
      toast.success(`Imported ${parsed.length} collection${parsed.length > 1 ? 's' : ''}`);
    } catch {
      toast.error('That file is not a collection export.');
    }
  };

  return (
    <>
      <div className="toolbar">
        <Button
          variant="secondary"
          icon={<FolderPlus size={16} />}
          onClick={() => {
            const c = useCollections.getState().create('New collection');
            navigate({ name: 'collection-edit', id: c.id });
          }}
        >
          New collection
        </Button>
        <ImportListsButton variant="secondary" />
        <Button variant="ghost" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
          Import collection JSON
        </Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </div>
      {!collections.length ? (
        <Empty icon={<FolderPlus size={40} />} title="No collections">Import a collection file, such as one shared by the community, or import lists from Trakt, MDBList or a media server.</Empty>
      ) : (
        <ul className="manage-list">
          {collections.map((c, i) => (
            <li key={c.id} className="manage-item">
              <button className="manage-item__main" onClick={() => navigate({ name: 'collection', id: c.id })}>
                <Img src={c.backdropImageUrl ?? c.folders[0]?.coverImageUrl ?? undefined} alt="" className="manage-item__img" fallback={<span className="manage-item__mono">{c.title[0]}</span>} />
                <span className="manage-item__text">
                  <span className="manage-item__title">{c.title}</span>
                  <span className="manage-item__sub">
                    {c.folders.length} folder{c.folders.length === 1 ? '' : 's'}
                    {c.pinToTop ? ' · Pinned to the top of Home' : ''}
                  </span>
                </span>
              </button>
              <div className="manage-item__actions">
                <IconButton label="Edit" size="sm" onClick={() => navigate({ name: 'collection-edit', id: c.id })}>
                  <Pencil size={15} />
                </IconButton>
                <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(c.id, i - 1)}>
                  <ArrowUp size={16} />
                </IconButton>
                <IconButton label="Move down" size="sm" disabled={i === collections.length - 1} onClick={() => move(c.id, i + 1)}>
                  <ArrowDown size={16} />
                </IconButton>
                <IconButton
                  label="Delete"
                  size="sm"
                  onClick={() => {
                    remove(c.id);
                    toast.info(`${c.title} deleted`, { label: 'Undo', run: () => merge([c]) });
                  }}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------- Calendar ----------

const DAY = 24 * 3600 * 1000;

export function Calendar() {
  const watched = useHistory((s) => s.watched);
  const progress = useHistory((s) => s.progress);
  const library = useHistory((s) => s.library);
  const [range, setRange] = useState<'upcoming' | 'recent'>('upcoming');

  // Shows being watched (recent activity) or on the watchlist.
  const shows = useMemo(() => {
    const recent = new Map<string, number>();
    for (const w of Object.values(watched)) if (w.type === 'series') recent.set(w.metaId, Math.max(recent.get(w.metaId) ?? 0, w.at));
    for (const p of Object.values(progress)) if (p.type === 'series') recent.set(p.metaId, Math.max(recent.get(p.metaId) ?? 0, p.updatedAt));
    for (const l of Object.values(library)) if (l.type === 'series') recent.set(l.metaId, Math.max(recent.get(l.metaId) ?? 0, l.addedAt));
    return [...recent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id]) => id);
  }, [watched, progress, library]);

  const metas = useQueries({ queries: shows.map((id) => ({ queryKey: ['meta', 'series', id, 'cw'], queryFn: ({ signal }: { signal: AbortSignal }) => fetchMeta('series', id, signal), staleTime: 3 * 3600 * 1000 })) });
  const now = Date.now();
  const entries = useMemo(() => {
    const out: { date: number; metaId: string; name: string; poster?: string; background?: string; ep: EpisodeRef; meta: NonNullable<(typeof metas)[number]['data']> }[] = [];
    metas.forEach((q, i) => {
      const m = q.data;
      if (!m) return;
      // The running order: specials and a season's extras are not new episodes.
      for (const ep of episodeGuide(m).main) {
        if (!ep.released) continue;
        // A date with no time of day is that calendar day here, not midnight UTC (see airTime).
        const d = airTime(ep.released);
        if (!Number.isFinite(d)) continue;
        const inRange = range === 'upcoming' ? d >= now - DAY && d <= now + 45 * DAY : d < now && d >= now - 21 * DAY;
        if (inRange) out.push({ date: d, metaId: shows[i], name: m.name, poster: m.poster, background: m.background, ep, meta: m });
      }
    });
    out.sort((a, b) => (range === 'upcoming' ? a.date - b.date : b.date - a.date));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metas.map((q) => q.dataUpdatedAt).join(','), range, shows]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof entries>();
    for (const e of entries) {
      const label = dayLabel(e.date, now);
      map.set(label, [...(map.get(label) ?? []), e]);
    }
    return [...map.entries()];
  }, [entries, now]);

  const loading = metas.some((q) => q.isLoading);
  return (
    <div className="screen-pad">
      <header className="page-head">
        <h1 className="page-title">Calendar</h1>
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: 'upcoming', label: 'Coming up' },
            { value: 'recent', label: 'Recently aired' },
          ]}
        />
      </header>
      {!shows.length ? (
        <Empty icon={<CalendarDays size={40} />} title="No shows to follow yet">Shows you watch or add to your Watchlist appear here when new episodes air.</Empty>
      ) : !loading && !groups.length ? (
        <Empty title={range === 'upcoming' ? 'Nothing airing in the next six weeks' : 'Nothing aired in the last three weeks'} />
      ) : (
        <div className="calendar">
          {groups.map(([label, list]) => (
            <section key={label} className="calendar__day">
              <h2 className="calendar__date">{label}</h2>
              <div className="calendar__items">
                {list.map((e) => {
                  const isWatched = !!watched[`${e.metaId}:${e.ep.season}:${e.ep.episode}`];
                  const aired = e.date <= now;
                  return (
                    <article key={`${e.metaId}-${e.ep.key ?? e.ep.id}`} className="cal-item">
                      <button className="cal-item__thumb" onClick={() => (aired ? void playEpisode(e.meta, e.metaId, e.ep) : navigate({ name: 'title', type: 'series', id: e.metaId, season: e.ep.season }))}>
                        <Img src={e.ep.thumbnail ?? e.background} alt="" className="cal-item__img" fallback={<span className="card__monogram">{e.name[0]}</span>} />
                        {isWatched && (
                          <span className="episode__watched">
                            <CheckCircle2 size={16} />
                          </span>
                        )}
                      </button>
                      <button className="cal-item__text" onClick={() => navigate({ name: 'title', type: 'series', id: e.metaId, season: e.ep.season })}>
                        <span className="cal-item__show">{e.name}</span>
                        <span className="cal-item__ep">
                          S{e.ep.season} E{e.ep.episode}
                          {e.ep.title ? ` · ${e.ep.title}` : ''}
                        </span>
                        {hasAirClock(e.ep.released) && <span className="cal-item__time">{new Date(e.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function dayLabel(d: number, now: number) {
  const day = new Date(d);
  const today = new Date(now);
  const diff = Math.round((new Date(day.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
