import { useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, FolderPlus, History as HistoryIcon, Library as LibraryIcon, Pencil, Trash2, ArrowUp, ArrowDown, Upload } from 'lucide-react';
import { fetchMeta } from '../addons/client';
import { titleKey } from '../addons/ids';
import type { MetaPreview } from '../addons/types';
import { episodesOf, useCardArt, useContinueWatching } from '../data/hooks';
import { airTime, hasAirClock } from '../library/continue';
import { PosterGrid } from '../media/Grid';
import { WideCard } from '../media/cards';
import { navigate, useNav } from '../nav/router';
import { playContinue, playEpisode } from '../player/launch';
import { useHistory } from '../state/history';
import { parseCollections, useCollections } from '../state/collections';
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
      .map((i) => {
        const c = cards[titleKey(i.metaId, i.type)];
        return { ...i, name: i.name ?? c?.name, poster: i.poster ?? c?.poster, background: i.background ?? c?.background, year: i.year ?? c?.year };
      });
    list.sort((a, b) => (sort === 'added' ? b.addedAt - a.addedAt : (a.name ?? '').localeCompare(b.name ?? '')));
    return list;
  }, [library, cards, sort, type]);
  useCardArt(items);
  const previews: MetaPreview[] = items.map((i) => ({ id: i.metaId, type: i.type, name: i.name ?? '', poster: i.poster, background: i.background, releaseInfo: i.year }));
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
      <PosterGrid items={previews} />
    </>
  );
}

function ContinueGrid() {
  const { items, loading } = useContinueWatching(200);
  useCardArt(items.map((i) => ({ metaId: i.metaId, type: i.type, name: i.name, poster: i.poster })));
  if (!items.length && !loading) return <Empty title="Nothing in progress">Start something and it shows up here, and on Home.</Empty>;
  return (
    <div className="wide-grid">
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
    const latest = new Map<string, { metaId: string; type: 'movie' | 'series'; at: number; count: number }>();
    for (const w of Object.values(watched)) {
      const key = titleKey(w.metaId, w.type);
      const prev = latest.get(key);
      latest.set(key, { metaId: w.metaId, type: w.type, at: Math.max(prev?.at ?? 0, w.at), count: (prev?.count ?? 0) + 1 });
    }
    return [...latest.values()].filter((t) => type === 'all' || t.type === type).sort((a, b) => b.at - a.at);
  }, [watched, type]);
  const withArt = titles.map((t) => {
    const c = cards[titleKey(t.metaId, t.type)];
    return { ...t, name: c?.name, poster: c?.poster };
  });
  // The whole list: the art is fetched a few titles at a time, from the top (see useCardArt).
  useCardArt(withArt);
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
      <PosterGrid items={withArt.map((t) => ({ id: t.metaId, type: t.type, name: t.name ?? '', poster: t.poster, releaseInfo: t.type === 'series' ? `${t.count} episode${t.count > 1 ? 's' : ''}` : new Date(t.at).toLocaleDateString() }))} />
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
        <Button variant="ghost" icon={<Upload size={16} />} onClick={() => file.current?.click()}>
          Import collection JSON
        </Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </div>
      {!collections.length ? (
        <Empty icon={<FolderPlus size={40} />} title="No collections">Import a collection file, such as one shared by the community.</Empty>
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
    const out: { date: number; metaId: string; name: string; poster?: string; background?: string; ep: ReturnType<typeof episodesOf>[number]; meta: NonNullable<(typeof metas)[number]['data']> }[] = [];
    metas.forEach((q, i) => {
      const m = q.data;
      if (!m) return;
      for (const ep of episodesOf(m)) {
        if (ep.season === 0 || !ep.released) continue;
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
                    <article key={`${e.metaId}-${e.ep.id}`} className="cal-item">
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
