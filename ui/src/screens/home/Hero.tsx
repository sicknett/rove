import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Play, Plus, Check, Star } from 'lucide-react';
import type { MetaPreview } from '../../addons/types';
import { Button, IconButton } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { navigate } from '../../nav/router';
import { asMediaType, useTmdb } from '../../data/hooks';
import { useHistory } from '../../state/history';
import { useSettings } from '../../state/settings';
import { toggleWatchlist } from '../../library/watchlist';
import { playTitle } from '../../player/launch';

const ROTATE_MS = 9000;
const TRAILER_DELAY_MS = 3500;

/** The featured banner at the top of Home: rotates through a few titles with their art. */
export function Hero({ items }: { items: MetaPreview[] }) {
  const featured = useMemo(() => items.filter((i) => i.background || i.poster).slice(0, 8), [items]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const current = featured[index % Math.max(1, featured.length)];

  useEffect(() => {
    if (paused || featured.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % featured.length), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, featured.length]);

  if (!current) return <div className="hero hero--empty" />;
  return (
    <section className="hero" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} aria-roledescription="carousel" aria-label="Featured">
      {featured.map((m, i) => (
        <HeroSlide key={m.id} meta={m} active={i === index % featured.length} />
      ))}
      {featured.length > 1 && (
        <div className="hero__dots" role="tablist">
          {featured.map((m, i) => (
            <button key={m.id} role="tab" aria-selected={i === index} aria-label={m.name} className={`hero__dot ${i === index ? 'is-on' : ''}`} onClick={() => setIndex(i)}>
              {i === index && !paused && <span className="hero__dot-fill" style={{ animationDuration: `${ROTATE_MS}ms` }} />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function HeroSlide({ meta, active }: { meta: MetaPreview; active: boolean }) {
  const type = asMediaType(meta.type);
  const tmdb = useTmdb(meta.type, active ? meta.id : undefined);
  const trailersOn = useSettings((s) => s.settings.appearance.heroTrailers);
  const inList = useHistory((s) => !!s.library[meta.id]);
  const [showTrailer, setShowTrailer] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setShowTrailer(false);
    window.clearTimeout(timer.current);
    if (active && trailersOn && tmdb.data?.trailer) timer.current = window.setTimeout(() => setShowTrailer(true), TRAILER_DELAY_MS);
    return () => window.clearTimeout(timer.current);
  }, [active, trailersOn, tmdb.data?.trailer]);

  const background = tmdb.data?.backdrop ?? meta.background ?? meta.poster;
  const logo = meta.logo ?? tmdb.data?.logo;
  const rating = Number(meta.imdbRating);
  const year = meta.releaseInfo ?? (meta.year ? String(meta.year) : undefined);
  const genres = (meta.genres ?? tmdb.data?.details?.genres?.map((g) => g.name) ?? []).slice(0, 3);
  const overview = meta.description ?? tmdb.data?.details?.overview;
  const card = { metaId: meta.id, type, name: meta.name, poster: meta.poster, background: meta.background, logo, year };

  return (
    <div className={`hero__slide ${active ? 'is-active' : ''}`} aria-hidden={!active} inert={!active}>
      <Img src={background} alt="" className="hero__backdrop" loading="eager" />
      {active && showTrailer && tmdb.data?.trailer && (
        <iframe
          className="hero__trailer"
          title={`${meta.name} trailer`}
          src={`https://www.youtube-nocookie.com/embed/${tmdb.data.trailer}?autoplay=1&mute=1&controls=0&loop=1&playlist=${tmdb.data.trailer}&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3&disablekb=1`}
          allow="autoplay; encrypted-media"
          tabIndex={-1}
        />
      )}
      <div className="hero__shade" />
      <div className="hero__content">
        {logo ? <Img src={logo} alt={meta.name} className="hero__logo" loading="eager" fallback={<h1 className="hero__title">{meta.name}</h1>} /> : <h1 className="hero__title">{meta.name}</h1>}
        <div className="hero__meta">
          {rating > 0 && (
            <span className="hero__rating">
              <Star size={13} fill="currentColor" strokeWidth={0} /> {rating.toFixed(1)}
            </span>
          )}
          {year && <span>{year}</span>}
          {tmdb.data?.certification && <span className="tag">{tmdb.data.certification}</span>}
          {genres.map((g) => (
            <span key={g}>{g}</span>
          ))}
        </div>
        {overview && <p className="hero__overview">{overview}</p>}
        <div className="hero__actions">
          <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" strokeWidth={0} />} onClick={() => void playTitle(type, meta.id, card)}>
            Play
          </Button>
          <Button variant="secondary" size="lg" icon={<Info size={18} />} onClick={() => navigate({ name: 'title', type, id: meta.id })}>
            Details
          </Button>
          <IconButton label={inList ? 'Remove from Watchlist' : 'Add to Watchlist'} size="lg" className="ibtn--glass" active={inList} onClick={() => void toggleWatchlist(card)}>
            {inList ? <Check size={20} /> : <Plus size={20} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
