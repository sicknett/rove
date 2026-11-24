import { useEffect, useMemo, useState } from 'react';
import { Bookmark, BookmarkCheck, CheckCircle2, CircleSlash, Clapperboard, Clock, ListVideo, MoreHorizontal, Play, RotateCcw, Star } from 'lucide-react';
import { watchKey } from '../../addons/ids';
import type { Meta } from '../../addons/types';
import { asMediaType, episodesOf, useMeta, useTmdb } from '../../data/hooks';
import type { EpisodeRef } from '../../library/continue';
import { toggleWatchlist } from '../../library/watchlist';
import { navigate, useNav } from '../../nav/router';
import { movieTarget, pickEpisode, playEpisode } from '../../player/launch';
import { play } from '../../player/session';
import { useHistory } from '../../state/history';
import { tmdbImage } from '../../meta/tmdb';
import { metaIdFor } from '../../tracking/idmap';
import { useTracker } from '../../tracking/sync';
import { Button, Dialog, Empty, IconButton, Menu, ProgressLine, Skeleton } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { openContextMenu } from '../../ui/contextmenu';
import { toast } from '../../ui/toast';
import { Row } from '../../media/Row';
import { PosterCard, formatRemaining } from '../../media/cards';
import { formatTime } from '../../format';

function runtimeLabel(meta: Meta | null | undefined, tmdbRuntime?: number) {
  const mins = tmdbRuntime ?? (meta?.runtime ? parseInt(String(meta.runtime), 10) : NaN);
  if (!Number.isFinite(mins) || mins <= 0) return undefined;
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

export function Title({ type, id, season: initialSeason }: { type: string; id: string; season?: number }) {
  const mediaType = asMediaType(type);
  const replace = useNav((s) => s.replace);

  // A `tmdb:` id becomes the IMDb id when one maps, so history lines up with PublicMetaDB.
  useEffect(() => {
    if (!/^tmdb:\d+$/i.test(id)) return;
    let alive = true;
    void metaIdFor(Number(id.split(':')[1]), mediaType === 'movie' ? 'movie' : 'tv', useTracker.getState().apiKey).then((mapped) => {
      if (alive && mapped !== id && /^tt\d+$/.test(mapped)) replace({ name: 'title', type, id: mapped, season: initialSeason });
    });
    return () => {
      alive = false;
    };
  }, [id, type, mediaType, replace, initialSeason]);

  const metaQ = useMeta(type, id);
  const tmdbQ = useTmdb(type, id);
  const meta = metaQ.data;
  const tm = tmdbQ.data;

  useEffect(() => {
    if (meta) useHistory.getState().rememberCard(id, mediaType, { name: meta.name, poster: meta.poster, background: meta.background, logo: meta.logo ?? tm?.logo, year: meta.releaseInfo });
  }, [meta, tm?.logo, id, mediaType]);

  if (metaQ.isLoading) return <TitleSkeleton />;
  if (!meta) {
    return (
      <div className="screen-pad">
        <Empty icon={<Clapperboard size={40} />} title="This title could not be loaded">
          None of your metadata addons know it, or they did not answer. Check Settings → Addons.
        </Empty>
      </div>
    );
  }

  const background = tm?.backdrop ?? meta.background ?? meta.poster;
  const logo = meta.logo ?? tm?.logo;
  const rating = Number(meta.imdbRating ?? tm?.details?.vote_average);
  const year = meta.releaseInfo ?? (meta.year ? String(meta.year) : undefined);
  const genres = meta.genres?.length ? meta.genres : tm?.details?.genres?.map((g) => g.name) ?? [];
  const runtime = runtimeLabel(meta, tm?.details?.runtime ?? tm?.details?.episode_run_time?.[0]);
  const overview = meta.description ?? tm?.details?.overview;
  const card = { metaId: id, type: mediaType, name: meta.name, poster: meta.poster, background: meta.background, logo, year };

  return (
    <div className="title">
      <div className="title__backdrop">
        <Img src={background} alt="" className="title__backdrop-img" loading="eager" />
        <div className="title__backdrop-shade" />
      </div>
      <header className="title__head">
        {logo ? <Img src={logo} alt={meta.name} className="title__logo" loading="eager" fallback={<h1 className="title__name">{meta.name}</h1>} /> : <h1 className="title__name">{meta.name}</h1>}
        <div className="title__meta">
          {rating > 0 && (
            <span className="title__rating">
              <Star size={14} fill="currentColor" strokeWidth={0} /> {rating.toFixed(1)}
            </span>
          )}
          {year && <span>{year}</span>}
          {runtime && <span>{runtime}</span>}
          {tm?.certification && <span className="tag">{tm.certification}</span>}
          {mediaType === 'series' && tm?.details?.number_of_seasons && <span>{tm.details.number_of_seasons} season{tm.details.number_of_seasons > 1 ? 's' : ''}</span>}
          {genres.slice(0, 4).map((g) => (
            <span key={g} className="title__genre">
              {g}
            </span>
          ))}
        </div>
        {tm?.details?.tagline && <p className="title__tagline">{tm.details.tagline}</p>}
        {overview && <p className="title__overview">{overview}</p>}
        <TitleActions meta={meta} id={id} type={mediaType} card={card} trailer={tm?.trailer} />
      </header>

      {mediaType === 'series' && <Episodes meta={meta} id={id} initialSeason={initialSeason} />}

      <Credits id={id} type={type} meta={meta} />
      <MoreLikeThis id={id} type={type} />
      <Facts meta={meta} id={id} type={type} />
    </div>
  );
}

function TitleSkeleton() {
  return (
    <div className="title">
      <div className="title__backdrop">
        <Skeleton className="title__backdrop-img" />
      </div>
      <header className="title__head">
        <Skeleton style={{ width: 380, height: 110, borderRadius: 12 }} />
        <Skeleton style={{ width: 320, height: 18, marginTop: 24 }} />
        <Skeleton style={{ width: 620, height: 64, marginTop: 18 }} />
      </header>
    </div>
  );
}

function TitleActions({ meta, id, type, card, trailer }: { meta: Meta; id: string; type: 'movie' | 'series'; card: Parameters<typeof toggleWatchlist>[0]; trailer?: string }) {
  const progress = useHistory((s) => s.progress);
  const watched = useHistory((s) => s.watched);
  const inList = useHistory((s) => !!s.library[id]);
  const [trailerOpen, setTrailerOpen] = useState(false);

  const plan = useMemo(() => {
    if (type === 'movie') {
      const p = progress[id];
      return { label: p ? 'Resume' : 'Play', detail: p ? formatRemaining(p.durationS - p.positionS) : undefined, progress: p ? p.positionS / p.durationS : undefined, ep: undefined as EpisodeRef | undefined };
    }
    const pick = pickEpisode(meta, id);
    if (!pick) return { label: 'Play', detail: undefined, progress: undefined, ep: undefined };
    const p = progress[watchKey(id, pick.ep.season, pick.ep.episode)];
    return {
      label: `${p ? 'Resume' : 'Play'} S${pick.ep.season} E${pick.ep.episode}`,
      detail: p ? formatRemaining(p.durationS - p.positionS) : pick.ep.title,
      progress: p ? p.positionS / p.durationS : undefined,
      ep: pick.ep,
    };
  }, [type, progress, id, meta]);

  const start = async (choose = false, fromStart = false) => {
    if (type === 'movie') return play(await movieTarget(meta, id, card), { meta, choose, fromStart });
    if (plan.ep) return playEpisode(meta, id, plan.ep, { choose, fromStart });
  };

  const movieWatched = type === 'movie' && !!watched[id];
  const h = useHistory.getState();

  return (
    <div className="title__actions">
      <Button variant="primary" size="lg" className="title__play" icon={<Play size={19} fill="currentColor" strokeWidth={0} />} onClick={() => void start()}>
        <span className="title__play-text">
          <span>{plan.label}</span>
          {plan.detail && <span className="title__play-detail">{plan.detail}</span>}
        </span>
        {plan.progress !== undefined && (
          <span className="title__play-progress">
            <ProgressLine value={plan.progress} />
          </span>
        )}
      </Button>
      <Button variant="secondary" size="lg" icon={<ListVideo size={18} />} onClick={() => void start(true)}>
        Sources
      </Button>
      {trailer && (
        <Button variant="secondary" size="lg" icon={<Clapperboard size={18} />} onClick={() => setTrailerOpen(true)}>
          Trailer
        </Button>
      )}
      <IconButton label={inList ? 'Remove from Watchlist' : 'Add to Watchlist'} size="lg" active={inList} className="ibtn--glass" onClick={() => void toggleWatchlist(card)}>
        {inList ? <BookmarkCheck size={20} /> : <Bookmark size={20} />}
      </IconButton>
      <Menu
        trigger={(p) => (
          <IconButton label="More" size="lg" className="ibtn--glass" ref={p.ref} onClick={p.onClick} aria-expanded={p['aria-expanded']}>
            <MoreHorizontal size={20} />
          </IconButton>
        )}
        items={[
          ...(plan.progress !== undefined ? [{ label: 'Play from the beginning', icon: <RotateCcw size={16} />, onSelect: () => void start(false, true) }] : []),
          type === 'movie'
            ? {
                label: movieWatched ? 'Mark as unwatched' : 'Mark as watched',
                icon: movieWatched ? <CircleSlash size={16} /> : <CheckCircle2 size={16} />,
                onSelect: () => (movieWatched ? h.unmarkWatched([{ metaId: id, type }]) : h.markWatched([{ metaId: id, type }])),
              }
            : {
                label: 'Mark every aired episode watched',
                icon: <CheckCircle2 size={16} />,
                onSelect: () => {
                  const eps = episodesOf(meta).filter((e) => e.season > 0 && (!e.released || Date.parse(e.released) <= Date.now()));
                  h.markWatched(eps.map((e) => ({ metaId: id, type, season: e.season, episode: e.episode })));
                  toast.success(`${eps.length} episodes marked watched`);
                },
              },
          ...(type === 'series'
            ? [
                {
                  label: 'Mark every episode unwatched',
                  icon: <CircleSlash size={16} />,
                  onSelect: () => {
                    const eps = Object.values(useHistory.getState().watched).filter((w) => w.metaId === id);
                    h.unmarkWatched(eps.map((w) => ({ metaId: id, type, season: w.season, episode: w.episode, tmdbId: w.tmdbId })));
                    toast.success('Episodes marked unwatched');
                  },
                },
              ]
            : []),
        ]}
      />
      <Dialog open={trailerOpen} onClose={() => setTrailerOpen(false)} title={`${meta.name} · Trailer`} width={1100}>
        {trailer && (
          <div className="trailer-frame">
            <iframe title="Trailer" src={`https://www.youtube-nocookie.com/embed/${trailer}?autoplay=1&rel=0&modestbranding=1`} allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Episodes({ meta, id, initialSeason }: { meta: Meta; id: string; initialSeason?: number }) {
  const episodes = useMemo(() => episodesOf(meta), [meta]);
  const seasons = useMemo(() => [...new Set(episodes.map((e) => e.season))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)), [episodes]);
  const progress = useHistory((s) => s.progress);
  const watched = useHistory((s) => s.watched);
  const pick = useMemo(() => pickEpisode(meta, id), [meta, id, progress, watched]); // eslint-disable-line react-hooks/exhaustive-deps
  const [season, setSeason] = useState<number | undefined>(initialSeason);
  const current = season ?? pick?.ep.season ?? seasons.find((s) => s > 0) ?? seasons[0];
  const list = episodes.filter((e) => e.season === current).sort((a, b) => a.episode - b.episode);
  const h = useHistory.getState();
  const now = Date.now();

  if (!episodes.length) return null;

  const seasonWatched = list.length > 0 && list.every((e) => watched[watchKey(id, e.season, e.episode)]);
  return (
    <section className="episodes" aria-label="Episodes">
      <header className="episodes__head">
        <div className="episodes__seasons" role="tablist" aria-label="Seasons">
          {seasons.map((s) => (
            <button key={s} role="tab" aria-selected={s === current} className={`chip ${s === current ? 'is-on' : ''}`} onClick={() => setSeason(s)}>
              {s === 0 ? 'Specials' : `Season ${s}`}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={seasonWatched ? <CircleSlash size={16} /> : <CheckCircle2 size={16} />}
          onClick={() => {
            const items = list.filter((e) => !e.released || Date.parse(e.released) <= now).map((e) => ({ metaId: id, type: 'series' as const, season: e.season, episode: e.episode }));
            if (seasonWatched) h.unmarkWatched(items);
            else h.markWatched(items);
          }}
        >
          {seasonWatched ? 'Mark season unwatched' : 'Mark season watched'}
        </Button>
      </header>
      <div className="episodes__grid">
        {list.map((e) => {
          const key = watchKey(id, e.season, e.episode);
          const p = progress[key];
          const isWatched = !!watched[key];
          const released = e.released ? Date.parse(e.released) : NaN;
          const upcoming = Number.isFinite(released) && released > now;
          const v = meta.videos?.find((x) => x.id === e.id);
          const isNext = pick?.ep.id === e.id;
          const onPlay = () => (upcoming ? toast.info(`Airs ${new Date(released).toLocaleDateString()}`) : void playEpisode(meta, id, e));
          return (
            <article
              key={e.id}
              className={`episode ${isWatched ? 'is-watched' : ''} ${upcoming ? 'is-upcoming' : ''} ${isNext ? 'is-next' : ''}`}
              onContextMenu={(ev) =>
                openContextMenu(ev, [
                  { label: 'Play', icon: <Play size={16} />, onSelect: onPlay, disabled: upcoming },
                  { label: 'Play from the beginning', icon: <RotateCcw size={16} />, onSelect: () => void playEpisode(meta, id, e, { fromStart: true }), disabled: upcoming || !p },
                  { label: 'Choose a source', icon: <ListVideo size={16} />, onSelect: () => void playEpisode(meta, id, e, { choose: true }), disabled: upcoming },
                  'divider',
                  isWatched
                    ? { label: 'Mark as unwatched', icon: <CircleSlash size={16} />, onSelect: () => h.unmarkWatched([{ metaId: id, type: 'series', season: e.season, episode: e.episode }]) }
                    : { label: 'Mark as watched', icon: <CheckCircle2 size={16} />, onSelect: () => h.markWatched([{ metaId: id, type: 'series', season: e.season, episode: e.episode }]) },
                  {
                    label: 'Mark watched up to here',
                    icon: <CheckCircle2 size={16} />,
                    onSelect: () => {
                      const upto = episodes.filter((x) => x.season > 0 && (x.season < e.season || (x.season === e.season && x.episode <= e.episode)));
                      h.markWatched(upto.map((x) => ({ metaId: id, type: 'series', season: x.season, episode: x.episode })));
                    },
                  },
                ])
              }
            >
              <button className="episode__thumb" onClick={onPlay} aria-label={`Play episode ${e.episode}`}>
                <Img src={e.thumbnail} alt="" className="episode__img" fallback={<span className="episode__noimg">E{e.episode}</span>} />
                {!upcoming && (
                  <span className="episode__play" aria-hidden>
                    <Play size={18} fill="currentColor" strokeWidth={0} />
                  </span>
                )}
                {isWatched && (
                  <span className="episode__watched" title="Watched">
                    <CheckCircle2 size={16} />
                  </span>
                )}
                {p && (
                  <span className="episode__progress">
                    <ProgressLine value={p.positionS / p.durationS} />
                  </span>
                )}
              </button>
              <div className="episode__text">
                <h3 className="episode__title">
                  <span className="episode__num">{e.episode}.</span> {e.title ?? `Episode ${e.episode}`}
                </h3>
                <p className="episode__meta">
                  {Number.isFinite(released) && <span>{upcoming ? `Airs ${new Date(released).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : new Date(released).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                  {v?.runtime && <span>{String(v.runtime).replace(/\D+$/, '')} min</span>}
                  {p && (
                    <span>
                      <Clock size={12} /> {formatTime(p.durationS - p.positionS)} left
                    </span>
                  )}
                </p>
                {(v?.overview ?? v?.description) && <p className="episode__overview">{v?.overview ?? v?.description}</p>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Credits({ id, type, meta }: { id: string; type: string; meta: Meta }) {
  const tm = useTmdb(type, id).data;
  const cast = tm?.details?.credits?.cast?.slice(0, 20) ?? [];
  const fallback = !cast.length ? meta.app_extras?.cast ?? (meta.cast ?? []).map((name) => ({ name })) : [];
  if (!cast.length && !fallback.length) return null;
  return (
    <Row title="Cast">
      {cast.map((c) => (
        <button key={c.id} className="person" onClick={() => navigate({ name: 'person', id: c.id, label: c.name })}>
          <Img src={tmdbImage(c.profile_path, 'w185')} alt="" className="person__img" fallback={<span className="person__mono">{c.name[0]}</span>} />
          <span className="person__name">{c.name}</span>
          {c.character && <span className="person__role">{c.character}</span>}
        </button>
      ))}
      {fallback.map((c, i) => (
        <div key={i} className="person">
          <Img src={'photo' in c ? (c.photo as string | undefined) : undefined} alt="" className="person__img" fallback={<span className="person__mono">{c.name[0]}</span>} />
          <span className="person__name">{c.name}</span>
        </div>
      ))}
    </Row>
  );
}

function MoreLikeThis({ id, type }: { id: string; type: string }) {
  const tm = useTmdb(type, id).data;
  const recs = (tm?.details?.recommendations?.results ?? []).filter((r) => r.poster_path).slice(0, 20);
  if (!recs.length) return null;
  const kind = tm?.kind === 'movie' ? 'movie' : 'series';
  return (
    <Row title="More like this">
      {recs.map((r) => (
        <PosterCard
          key={r.id}
          title={{
            metaId: `tmdb:${r.id}`,
            type: r.media_type === 'tv' ? 'series' : r.media_type === 'movie' ? 'movie' : kind,
            name: r.title ?? r.name,
            poster: tmdbImage(r.poster_path, 'w342'),
            background: tmdbImage(r.backdrop_path, 'w1280'),
            year: (r.release_date ?? r.first_air_date)?.slice(0, 4),
            rating: r.vote_average ? r.vote_average.toFixed(1) : undefined,
          }}
        />
      ))}
    </Row>
  );
}

function Facts({ meta, id, type }: { meta: Meta; id: string; type: string }) {
  const tm = useTmdb(type, id).data;
  const crew = tm?.details?.credits?.crew ?? [];
  const directors = crew.filter((c) => c.job === 'Director').map((c) => c.name);
  const writers = crew.filter((c) => c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Creator').map((c) => c.name);
  const facts: [string, string | undefined][] = [
    ['Directed by', (directors.length ? directors : Array.isArray(meta.director) ? meta.director : meta.director ? [meta.director] : []).slice(0, 3).join(', ') || undefined],
    ['Written by', [...new Set(writers.length ? writers : meta.writer ?? [])].slice(0, 3).join(', ') || undefined],
    ['Released', tm?.details?.release_date ?? tm?.details?.first_air_date ?? meta.released?.slice(0, 10)],
    ['Status', tm?.details?.status],
    ['Country', meta.country],
    ['Language', meta.language],
    ['Awards', meta.awards],
  ];
  const shown = facts.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <section className="facts" aria-label="Details">
      <h2 className="row__title">Details</h2>
      <dl className="facts__list">
        {shown.map(([k, v]) => (
          <div key={k} className="facts__item">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

