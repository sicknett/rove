import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Play, Plus, Check, Star, Volume2, VolumeX } from 'lucide-react';
import type { MetaPreview } from '../../addons/types';
import { Button, IconButton } from '../../ui/controls';
import { Img } from '../../ui/Img';
import { navigate, useScreen } from '../../nav/router';
import { asMediaType, useTmdb } from '../../data/hooks';
import { useSettings } from '../../state/settings';
import { toggleWatchlist, useInWatchlist } from '../../library/watchlist';
import { playTitle } from '../../player/launch';

const ROTATE_MS = 9000;
/** How long a title has been showing before its trailer starts by itself. */
const TRAILER_AUTO_MS = 2500;
/** How long the pointer rests on the banner before its trailer starts, when trailers wait for that. */
const TRAILER_HOVER_MS = 900;
/** A trailer that has not started by now is given up on, and the banner moves along. */
const TRAILER_GIVE_UP_MS = 14000;

/**
 * The featured banner at the top of Home. It behaves the way streaming services' billboards do:
 * a title's art shows first, then its trailer fades in over it, the description steps aside and
 * the logo shrinks while it plays, and when the trailer ends the banner moves to the next title.
 */
export function Hero({ items, onBackdrop }: { items: MetaPreview[]; onBackdrop?: (url: string | undefined) => void }) {
  const featured = useMemo(() => items.filter((i) => i.background || i.poster).slice(0, 8), [items]);
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  // A trailer is loading or playing: the banner waits for it instead of rotating away.
  const [trailer, setTrailer] = useState(false);
  const section = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(true);
  // Home stays mounted behind other screens and under the player: the banner rests there, and
  // forgets the pointer (it gets no "leave" once it is hidden).
  const { active } = useScreen();
  useEffect(() => {
    if (!active) setHovered(false);
  }, [active]);
  // Scrolled out of sight, a trailer stops (and the banner does not rotate unseen).
  const hasItems = featured.length > 0;
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.intersectionRatio >= 0.45)), { threshold: [0, 0.45, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, [hasItems]);

  const live = active && inView;
  const paused = hovered || !live || trailer;
  const current = featured[index % Math.max(1, featured.length)];
  const count = featured.length;

  useEffect(() => {
    if (paused || count < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, count]);

  if (!current) return <div className="hero hero--empty" />;
  return (
    <section ref={section} className="hero" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} aria-roledescription="carousel" aria-label="Featured">
      {featured.map((m, i) => (
        <HeroSlide
          key={m.id}
          meta={m}
          active={i === index % count}
          live={live}
          hovered={hovered && active}
          onBackdrop={onBackdrop}
          onTrailer={setTrailer}
          onTrailerEnd={() => count > 1 && setIndex((n) => (n + 1) % count)}
        />
      ))}
      {count > 1 && (
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

const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const SOUND_KEY = 'rove.trailerSound';
/** YouTube draws its own buttons over the picture while a video starts; the trailer stays hidden until they are gone. */
const REVEAL_AFTER_PLAYING_MS = 3200;

/** Out of 100. Trailers are mastered loud, and this is background sound on a menu. */
const TRAILER_VOLUME = 12;

function trailerSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A trailer in the banner, with nothing of YouTube's own interface showing: no playlist (so no
 * previous/next), no controls, and the frame is only faded in once the video is really playing.
 * The page talks to the player through YouTube's frame messages (sound on and off, "it ended").
 */
function HeroTrailer({ id, name, onShown, onEnded }: { id: string; name: string; onShown: () => void; onEnded: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [sound, setSound] = useState(trailerSound);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const shown = useRef(onShown);
  shown.current = onShown;
  const ended = useRef(onEnded);
  ended.current = onEnded;

  const command = (func: string, args: unknown[] = []) => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);

  useEffect(() => {
    let reveal: number | undefined;
    // No picture after a good while (blocked, removed, offline): the banner carries on without it.
    const giveUp = window.setTimeout(() => reveal === undefined && ended.current(), TRAILER_GIVE_UP_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return;
      let data: { event?: string; info?: unknown };
      try {
        data = JSON.parse(e.data) as { event?: string; info?: unknown };
      } catch {
        return;
      }
      const state = data.event === 'onStateChange' ? data.info : data.event === 'infoDelivery' ? (data.info as { playerState?: number } | null)?.playerState : undefined;
      if (state === 1 && reveal === undefined) {
        if (soundRef.current) {
          command('setVolume', [TRAILER_VOLUME]);
          command('unMute');
        }
        reveal = window.setTimeout(() => {
          setVisible(true);
          shown.current();
        }, REVEAL_AFTER_PLAYING_MS);
      } else if (state === 0) {
        ended.current();
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(reveal);
      window.clearTimeout(giveUp);
    };
  }, []);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? '1' : '0');
    } catch {
      /* remembered for this run only */
    }
    if (next) command('setVolume', [TRAILER_VOLUME]);
    command(next ? 'unMute' : 'mute');
  };

  return (
    <>
      <iframe
        ref={frame}
        className={`hero__trailer ${visible ? 'is-visible' : ''}`}
        title={`${name} trailer`}
        src={`${YT_ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
        allow="autoplay; encrypted-media"
        tabIndex={-1}
        // The player only reports its state to a page that has said it is listening.
        onLoad={() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN)}
      />
      {visible && (
        <IconButton label={sound ? 'Mute the trailer' : 'Turn the trailer sound on'} size="lg" className="ibtn--glass hero__sound" onClick={toggleSound}>
          {sound ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </IconButton>
      )}
    </>
  );
}

interface SlideProps {
  meta: MetaPreview;
  active: boolean;
  /** Home is the screen in front and the banner is in view. */
  live: boolean;
  hovered: boolean;
  onBackdrop?: (url: string | undefined) => void;
  onTrailer: (on: boolean) => void;
  onTrailerEnd: () => void;
}

function HeroSlide({ meta, active, live, hovered, onBackdrop, onTrailer, onTrailerEnd }: SlideProps) {
  const type = asMediaType(meta.type);
  const tmdb = useTmdb(meta.type, active ? meta.id : undefined);
  const trailersOn = useSettings((s) => s.settings.appearance.heroTrailers);
  const start = useSettings((s) => s.settings.appearance.heroTrailerStart);
  const inList = useInWatchlist(meta.id, type);
  const [showTrailer, setShowTrailer] = useState(false);
  // The trailer's picture is on screen (not just loading): the text makes room for it.
  const [playing, setPlaying] = useState(false);
  // One trailer per showing of a title: after it has ended it does not start again by itself.
  const [played, setPlayed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const trailerId = tmdb.data?.trailer;

  useEffect(() => {
    if (!active) setPlayed(false);
  }, [active]);

  // The trailer starts by itself after a moment on the title, or only when the pointer rests on
  // the banner, as Settings says. It stops when the banner is left, scrolled away or covered.
  useEffect(() => {
    window.clearTimeout(timer.current);
    const wanted = active && live && trailersOn && !!trailerId && (start === 'auto' ? !played : hovered);
    if (!wanted) {
      setShowTrailer(false);
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => setShowTrailer(true), start === 'auto' ? TRAILER_AUTO_MS : TRAILER_HOVER_MS);
    return () => window.clearTimeout(timer.current);
  }, [active, live, hovered, trailersOn, trailerId, start, played]);

  // The banner waits for a trailer that is loading or playing.
  useEffect(() => {
    if (!active) return;
    onTrailer(showTrailer);
    return () => onTrailer(false);
  }, [active, showTrailer, onTrailer]);

  const background = tmdb.data?.backdrop ?? meta.background ?? meta.poster;
  const logo = meta.logo ?? tmdb.data?.logo;
  // Home colours itself from the picture that is showing.
  useEffect(() => {
    if (active) onBackdrop?.(background);
  }, [active, background, onBackdrop]);
  const rating = Number(meta.imdbRating);
  const year = meta.releaseInfo ?? (meta.year ? String(meta.year) : undefined);
  const genres = (meta.genres ?? tmdb.data?.details?.genres?.map((g) => g.name) ?? []).slice(0, 3);
  const overview = meta.description ?? tmdb.data?.details?.overview;
  const card = { metaId: meta.id, type, name: meta.name, poster: meta.poster, background: meta.background, logo, year };

  return (
    <div className={`hero__slide ${active ? 'is-active' : ''} ${playing ? 'is-playing' : ''}`} aria-hidden={!active} inert={!active}>
      <Img src={background} alt="" className="hero__backdrop" loading="eager" />
      {active && showTrailer && trailerId && (
        <HeroTrailer
          id={trailerId}
          name={meta.name}
          onShown={() => setPlaying(true)}
          onEnded={() => {
            setPlayed(true);
            setShowTrailer(false);
            setPlaying(false);
            onTrailerEnd();
          }}
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
