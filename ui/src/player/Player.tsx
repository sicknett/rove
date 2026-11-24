import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, Captions, Gauge, Info, Keyboard, ListVideo, Maximize, Minimize, MonitorPlay, Pause, Play, RotateCcw, RotateCw, SkipForward, Rows3, Volume1, Volume2, VolumeX, PictureInPicture2,
} from 'lucide-react';
import { appWindow, mpv, send, subscribe } from '../bridge';
import { useSettings, settingsNow } from '../state/settings';
import { fetchStreams } from '../addons/client';
import { episodesOf } from '../data/hooks';
import { watchKey } from '../addons/ids';
import { useHistory } from '../state/history';
import { Img } from '../ui/Img';
import { Button, Dialog, ProgressLine, Sheet } from '../ui/controls';
import { formatTime } from '../format';
import { AudioMenu, SpeedMenu, SubtitleMenu, VideoMenu, resetAspect } from './Menus';
import { Scrubber } from './Scrubber';
import { getPlayerState, onPlayerEvent, usePlayer } from './store';
import { TitleBar } from '../components/TitleBar';
import { openSwitcher, startStream, stopPlayback, usePlayback, type Session } from './session';
import { useDeadLinkRecovery, useNextEpisode, useProgressSaving, useSegments, useTrackSetup } from './runtime';
import { activeSegment, type Segment } from './skips';
import { episodeTarget, playEpisode } from './launch';
import type { EpisodeRef } from '../library/continue';
import { toast } from '../ui/toast';
import { setPip, usePip } from './pip';

type MenuName = 'audio' | 'subs' | 'speed' | 'video' | null;
const HIDE_AFTER_MS = 2800;

export function Player() {
  const session = usePlayback((s) => s.session)!;
  const pause = usePlayer((s) => s.pause);
  const loading = usePlayer((s) => s.loading);
  const buffering = usePlayer((s) => s.pausedForCache || (s.seeking && !s.pause));
  const cacheBuffering = usePlayer((s) => s.cacheBuffering);
  const fullscreen = usePlayer((s) => s.window.fullscreen);
  const error = usePlayer((s) => s.error);
  const audioLost = usePlayer((s) => s.lastAudioTrack !== null && (!s.audioOutput || s.audioOutput === 'null') && !s.loading);
  const pip = usePip();
  const [menu, setMenu] = useState<MenuName>(null);
  const [panel, setPanel] = useState<'episodes' | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [stats, setStats] = useState(false);
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState<{ key: number; kind: 'play' | 'pause' | 'back' | 'forward'; text?: string } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const clickTimer = useRef<number | undefined>(undefined);
  const lastInput = useRef(Date.now());

  useProgressSaving(session);
  useTrackSetup(session);
  useDeadLinkRecovery(session);
  const segments = useSegments(session);
  const next = useNextEpisode(session);

  useEffect(() => resetAspect(), [session.id]);

  // Windows media controls: what is playing, and the keys.
  useEffect(() => {
    const t = session.target;
    send({
      t: 'now-playing',
      state: pause ? 'paused' : 'playing',
      title: t.name,
      subtitle: t.type === 'series' && t.season !== undefined ? `S${t.season} E${t.episode}${t.episodeTitle ? ` · ${t.episodeTitle}` : ''}` : '',
      artwork: t.poster ?? t.still ?? t.background,
      canNext: !!next,
    });
  }, [session.id, pause, next]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => send({ t: 'now-playing', state: 'stopped' }), []);


  const shown = controlsVisible || pause || menu !== null || loading || !!error;

  const poke = useCallback(() => {
    lastInput.current = Date.now();
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hovering.current) setControlsVisible(false);
    }, HIDE_AFTER_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [poke]);

  const showFlash = (kind: 'play' | 'pause' | 'back' | 'forward', text?: string) => setFlash({ key: Date.now(), kind, text });

  const togglePause = useCallback(() => {
    const paused = getPlayerState().pause;
    mpv.set('pause', !paused);
    showFlash(paused ? 'play' : 'pause');
  }, []);

  const seekBy = useCallback(
    (seconds: number) => {
      mpv.command('seek', seconds, 'relative');
      showFlash(seconds < 0 ? 'back' : 'forward', `${Math.abs(seconds)}`);
      poke();
    },
    [poke],
  );

  const setVolume = useCallback((v: number) => {
    const max = Math.min(150, settingsNow().audio.volumeMax);
    const volume = Math.max(0, Math.min(max, Math.round(v)));
    mpv.set('volume', volume);
    if (settingsNow().playback.rememberVolume) localStorage.setItem('rove.volume', String(volume));
    if (getPlayerState().mute && volume > 0) mpv.set('mute', false);
  }, []);

  const exit = useCallback(() => {
    setPip(false);
    stopPlayback();
  }, []);

  const playNext = useCallback(
    async (auto: boolean) => {
      if (!next || !session.meta) return;
      const unattended = auto && lastInput.current < session.startedAt + 5000 ? session.unattendedCount + 1 : 0;
      await playEpisode(session.meta, session.target.metaId, next, { unattended, fromStart: false });
    },
    [next, session],
  );

  useEffect(() => {
    return subscribe((m) => {
      if (m.t !== 'media-key') return;
      if (m.key === 'play') mpv.set('pause', false);
      else if (m.key === 'pause') mpv.set('pause', true);
      else if (m.key === 'next' && next) void playNext(false);
      else if (m.key === 'previous') mpv.command('seek', 0, 'absolute');
      else if (m.key === 'stop') exit();
    });
  }, [next, playNext, exit]);

  const activeSeg = useActiveSegment(segments);
  const skipSegment = useCallback(
    (seg: Segment) => {
      const dur = getPlayerState().duration;
      const end = seg.end ?? dur;
      if (seg.kind === 'credits' && next && (seg.end === null || dur - end < 20)) {
        void playNext(false);
        return;
      }
      mpv.command('seek', end.toFixed(2), 'absolute');
      poke();
    },
    [next, playNext, poke],
  );

  useAutoSkip(activeSeg, skipSegment);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = getPlayerState();
      const step = settingsNow().playback.seekStepSec;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePause();
          break;
        case 'ArrowLeft':
        case 'j':
          e.preventDefault();
          seekBy(e.shiftKey ? -step * 3 : -step);
          break;
        case 'ArrowRight':
        case 'l':
          e.preventDefault();
          seekBy(e.shiftKey ? step * 3 : step);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(s.volume + 5);
          showFlash('forward', `${Math.min(150, Math.round(s.volume + 5))}%`);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(s.volume - 5);
          showFlash('back', `${Math.max(0, Math.round(s.volume - 5))}%`);
          break;
        case 'm':
          mpv.set('mute', !s.mute);
          break;
        case 'f':
          appWindow.fullscreen();
          break;
        case 'i':
          setStats((v) => !v);
          break;
        case 'n':
          if (next) void playNext(false);
          break;
        case 's':
          if (activeSeg) skipSegment(activeSeg);
          break;
        case '.':
          if (s.pause) mpv.command('frame-step');
          break;
        case ',':
          if (s.pause) mpv.command('frame-back-step');
          break;
        case '?':
          setHelp((v) => !v);
          break;
        case 'c': {
          const subs = s.tracks.filter((t) => t.type === 'sub');
          if (!subs.length) break;
          const idx = subs.findIndex((t) => t.id === s.sid);
          const nextSub = idx + 1 < subs.length ? subs[idx + 1].id : 'no';
          mpv.set('sid', nextSub);
          break;
        }
        case 'p':
          setPip(!pip);
          break;
        case 'Escape':
          if (help) setHelp(false);
          else if (menu) setMenu(null);
          else if (s.window.fullscreen) appWindow.fullscreen(false);
          else if (pip) setPip(false);
          break;
        case 'Backspace':
          exit();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && s.duration > 0) mpv.command('seek', Number(e.key) * 10, 'absolute-percent');
          else return;
      }
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exit, menu, poke, seekBy, togglePause, setVolume, next, playNext, activeSeg, skipSegment, help, pip]);

  const onSurfaceClick = (e: React.MouseEvent) => {
    if (menu) {
      setMenu(null);
      return;
    }
    if (e.detail === 1) clickTimer.current = window.setTimeout(togglePause, 220);
    else {
      window.clearTimeout(clickTimer.current);
      appWindow.fullscreen();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('.menu, .sheet')) return;
    const s = getPlayerState();
    const v = s.volume + (e.deltaY < 0 ? 5 : -5);
    setVolume(v);
    showFlash(e.deltaY < 0 ? 'forward' : 'back', `${Math.max(0, Math.min(150, Math.round(v)))}%`);
    poke();
  };

  const t = session.target;
  const epLabel = t.type === 'series' && t.season !== undefined ? `S${t.season} E${t.episode}${t.episodeTitle ? ` · ${t.episodeTitle}` : ''}` : undefined;

  return (
    <div className={`player${shown ? '' : ' player--idle'}${pip ? ' player--pip' : ''}`} onPointerMove={poke} onPointerDown={poke} onWheel={onWheel}>
      <div className="player__surface" onClick={onSurfaceClick} />

      <div className="player__scrim player__scrim--top" />
      <div className="player__scrim player__scrim--bottom" />

      {!pip && <TitleBar overVideo visible={shown} />}

      <div className="player__top">
        <button className="icon-btn icon-btn--lg" aria-label="Back" onClick={exit}>
          <ArrowLeft size={22} />
        </button>
        <div className="player__heading">
          {t.logo && !epLabel ? <Img src={t.logo} alt={t.name} className="player__logo" fallback={<h1 className="player__title">{t.name}</h1>} /> : <h1 className="player__title">{t.name}</h1>}
          {epLabel && <p className="player__subtitle">{epLabel}</p>}
        </div>
      </div>

      {(loading || buffering) && !error && (
        <div className="player__center" aria-live="polite">
          <div className="spinner" />
          {!loading && cacheBuffering < 100 && <span className="player__buffer-pct">{Math.round(cacheBuffering)}%</span>}
        </div>
      )}

      {flash && (
        <div key={flash.key} className="player__flash" aria-hidden>
          {flash.kind === 'play' && <Play size={34} fill="currentColor" strokeWidth={0} />}
          {flash.kind === 'pause' && <Pause size={34} fill="currentColor" strokeWidth={0} />}
          {(flash.kind === 'back' || flash.kind === 'forward') && (
            <span className="player__flash-stack">
              {flash.kind === 'back' ? <RotateCcw size={28} /> : <RotateCw size={28} />}
              {flash.text && <span className="player__flash-text">{flash.text}</span>}
            </span>
          )}
        </div>
      )}

      {error && <ErrorPanel session={session} error={error} onExit={exit} />}

      {audioLost && !error && (
        <div className="toast" role="status">
          <span className="toast__dot" /> Audio device disconnected. Sound comes back when it reconnects.
        </div>
      )}

      {stats && <Stats session={session} />}

      {activeSeg && !error && <SkipButton seg={activeSeg} next={!!next} onSkip={() => skipSegment(activeSeg)} raised={shown} />}

      {next && !error && <UpNext session={session} next={next} segments={segments} onPlay={playNext} />}

      <div className="player__bottom">
        <div className="player__controls" onPointerEnter={() => (hovering.current = true)} onPointerLeave={() => (hovering.current = false)}>
          <Scrubber segments={segments} />
          <div className="controls-row">
            <div className="controls-row__group">
              <button className="icon-btn icon-btn--play" aria-label={pause ? 'Play' : 'Pause'} title={pause ? 'Play (Space)' : 'Pause (Space)'} onClick={togglePause}>
                {pause ? <Play size={26} fill="currentColor" strokeWidth={0} /> : <Pause size={26} fill="currentColor" strokeWidth={0} />}
              </button>
              <button className="icon-btn" aria-label="Back 10 seconds" title="Back (←)" onClick={() => seekBy(-settingsNow().playback.seekStepSec)}>
                <RotateCcw size={21} />
                <span className="icon-btn__badge">{settingsNow().playback.seekStepSec}</span>
              </button>
              <button className="icon-btn" aria-label="Forward 10 seconds" title="Forward (→)" onClick={() => seekBy(settingsNow().playback.seekStepSec)}>
                <RotateCw size={21} />
                <span className="icon-btn__badge">{settingsNow().playback.seekStepSec}</span>
              </button>
              {next && (
                <button className="icon-btn" aria-label="Next episode" title="Next episode (N)" onClick={() => void playNext(false)}>
                  <SkipForward size={21} fill="currentColor" strokeWidth={1.5} />
                </button>
              )}
              <VolumeControl onChange={setVolume} />
            </div>
            <div className="controls-row__group">
              {t.type === 'series' && session.meta && (
                <button className={`icon-btn ${panel === 'episodes' ? 'is-active' : ''}`} aria-label="Episodes" title="Episodes" onClick={() => setPanel('episodes')}>
                  <Rows3 size={21} />
                </button>
              )}
              <button className="icon-btn" aria-label="Sources" title="Sources" onClick={openSwitcher}>
                <ListVideo size={21} />
              </button>
              <MenuButton name="video" label="Picture" open={menu} setOpen={setMenu} icon={<MonitorPlay size={21} />}>
                <VideoMenu />
              </MenuButton>
              <MenuButton name="speed" label="Speed" open={menu} setOpen={setMenu} icon={<Gauge size={21} />}>
                <SpeedMenu />
              </MenuButton>
              <MenuButton name="audio" label="Audio" open={menu} setOpen={setMenu} icon={<AudioLines size={21} />}>
                <AudioMenu />
              </MenuButton>
              <MenuButton name="subs" label="Subtitles" open={menu} setOpen={setMenu} icon={<Captions size={22} />}>
                <SubtitleMenu />
              </MenuButton>
              <button className={`icon-btn${stats ? ' is-active' : ''}`} aria-label="Playback info" title="Playback info (I)" onClick={() => setStats((v) => !v)}>
                <Info size={20} />
              </button>
              <button className="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelp(true)}>
                <Keyboard size={20} />
              </button>
              <button className={`icon-btn ${pip ? 'is-active' : ''}`} aria-label="Picture in picture" title="Picture in picture (P)" onClick={() => setPip(!pip)}>
                <PictureInPicture2 size={20} />
              </button>
              <button className="icon-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)" onClick={() => appWindow.fullscreen()}>
                {fullscreen ? <Minimize size={21} /> : <Maximize size={21} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {panel === 'episodes' && session.meta && <EpisodesPanel session={session} onClose={() => setPanel(null)} />}
      <StillWatching session={session} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

function useActiveSegment(segments: Segment[]): Segment | null {
  const [active, setActive] = useState<Segment | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = getPlayerState();
      const seg = s.duration > 0 ? activeSegment(segments, s.timePos, s.duration) : null;
      setActive((prev) => (prev === seg ? prev : seg));
    }, 300);
    return () => window.clearInterval(id);
  }, [segments]);
  return active;
}

function useAutoSkip(seg: Segment | null, skip: (s: Segment) => void) {
  const done = useRef(new Set<Segment>());
  useEffect(() => {
    if (!seg || done.current.has(seg)) return;
    const p = settingsNow().playback;
    const mode = seg.kind === 'intro' ? p.skipIntro : seg.kind === 'recap' ? p.skipRecap : seg.kind === 'credits' ? p.skipCredits : 'button';
    if (mode !== 'auto') return;
    done.current.add(seg);
    toast.info(`Skipped the ${seg.kind}`);
    skip(seg);
  }, [seg, skip]);
}

function SkipButton({ seg, next, onSkip, raised }: { seg: Segment; next: boolean; onSkip: () => void; raised: boolean }) {
  const p = useSettings((s) => s.settings.playback);
  const mode = seg.kind === 'intro' ? p.skipIntro : seg.kind === 'recap' ? p.skipRecap : seg.kind === 'credits' ? p.skipCredits : 'button';
  if (mode === 'off') return null;
  if (seg.kind === 'credits' && next) return null; // Up Next handles the credits of an episode.
  const label = { intro: 'Skip Intro', recap: 'Skip Recap', credits: 'Skip Credits', preview: 'Skip Preview' }[seg.kind];
  return (
    <button className={`skip-btn ${raised ? 'is-raised' : ''}`} onClick={onSkip} title={`${label} (S) · ${seg.source}`}>
      {label} <SkipForward size={17} fill="currentColor" strokeWidth={1.5} />
    </button>
  );
}

function UpNext({ session, next, segments, onPlay }: { session: Session; next: EpisodeRef; segments: Segment[]; onPlay: (auto: boolean) => Promise<void> }) {
  const p = useSettings((s) => s.settings.playback);
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'dismissed'>('hidden');
  const [left, setLeft] = useState(p.nextCountdownSec);
  const prefetched = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    setPhase('hidden');
    prefetched.current = false;
    started.current = false;
  }, [session.id]);

  // When to show: the credits marker if there is one near the end, else a lead time before the end.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = getPlayerState();
      if (!(s.duration > 0) || s.loading) return;
      const credits = segments.find((x) => x.kind === 'credits' && x.start > s.duration * 0.6);
      const at = credits ? credits.start : s.duration - p.nextLeadSec;
      if (!prefetched.current && s.timePos > s.duration * 0.8) {
        prefetched.current = true;
        void (async () => {
          const target = await episodeTarget(session.meta!, session.target.metaId, next);
          await fetchStreams('series', target.videoId, () => undefined).catch(() => undefined);
        })();
      }
      if (s.timePos >= at && phase === 'hidden') {
        setPhase('shown');
        setLeft(p.nextCountdownSec);
      }
      if (s.timePos < at - 5 && phase === 'dismissed') setPhase('hidden');
    }, 400);
    return () => window.clearInterval(id);
  }, [segments, p.nextLeadSec, p.nextCountdownSec, phase, session, next]);

  // Countdown and end of file.
  useEffect(() => {
    if (phase !== 'shown' || !p.autoPlayNext) return;
    const id = window.setInterval(() => {
      if (getPlayerState().pause) return;
      setLeft((l) => {
        if (l <= 1 && !started.current) {
          started.current = true;
          void onPlay(true);
        }
        return l - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, p.autoPlayNext, onPlay]);

  useEffect(() => {
    return onPlayerEvent((e) => {
      if (e.name === 'end-file' && e.reason === 'eof' && p.autoPlayNext && !started.current) {
        started.current = true;
        void onPlay(true);
      }
    });
  }, [onPlay, p.autoPlayNext]);

  if (phase !== 'shown') return null;
  const total = p.nextCountdownSec;
  return (
    <div className="upnext" role="dialog" aria-label="Next episode">
      <div className="upnext__thumb">
        <Img src={next.thumbnail ?? session.target.background} alt="" className="upnext__img" />
        {p.autoPlayNext && (
          <svg className="upnext__ring" viewBox="0 0 36 36" aria-hidden>
            <circle cx="18" cy="18" r="16" className="upnext__ring-bg" />
            <circle cx="18" cy="18" r="16" className="upnext__ring-fg" style={{ strokeDashoffset: `${100 - (Math.max(0, left) / total) * 100}` }} />
          </svg>
        )}
      </div>
      <div className="upnext__text">
        <span className="upnext__eyebrow">{p.autoPlayNext ? `Next episode in ${Math.max(0, left)}` : 'Next episode'}</span>
        <span className="upnext__title">
          S{next.season} E{next.episode}
          {next.title ? ` · ${next.title}` : ''}
        </span>
        <div className="upnext__actions">
          <Button variant="primary" size="sm" icon={<Play size={14} fill="currentColor" strokeWidth={0} />} onClick={() => void onPlay(false)}>
            Play now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPhase('dismissed')}>
            Keep watching
          </Button>
        </div>
      </div>
    </div>
  );
}

function StillWatching({ session }: { session: Session }) {
  const limit = useSettings((s) => s.settings.playback.stillWatchingAfter);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (limit > 0 && session.unattendedCount >= limit) {
      mpv.set('pause', true);
      setOpen(true);
    } else setOpen(false);
  }, [session.id, session.unattendedCount, limit]);
  if (!open) return null;
  return (
    <Dialog open onClose={() => setOpen(false)} title="Are you still watching?" width={440}>
      <p className="dialog__text">
        {session.target.name} · S{session.target.season} E{session.target.episode}
      </p>
      <div className="dialog__stack">
        <Button
          variant="primary"
          size="lg"
          data-autofocus
          onClick={() => {
            usePlayback.setState({ session: { ...session, unattendedCount: 0 } });
            setOpen(false);
            mpv.set('pause', false);
          }}
        >
          Keep watching
        </Button>
        <Button variant="secondary" size="lg" onClick={stopPlayback}>
          Stop
        </Button>
      </div>
    </Dialog>
  );
}

function EpisodesPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const eps = useMemo(() => episodesOf(session.meta).filter((e) => e.season > 0), [session.meta]);
  const seasons = [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b);
  const [season, setSeason] = useState(session.target.season ?? seasons[0]);
  const progress = useHistory((s) => s.progress);
  const watched = useHistory((s) => s.watched);
  const list = eps.filter((e) => e.season === season).sort((a, b) => a.episode - b.episode);
  const now = Date.now();
  return (
    <Sheet open onClose={onClose} title={session.target.name} subtitle={`Season ${season}`} width={520}>
      <div className="chips chips--scroll">
        {seasons.map((s) => (
          <button key={s} className={`chip chip--sm ${s === season ? 'is-on' : ''}`} onClick={() => setSeason(s)}>
            Season {s}
          </button>
        ))}
      </div>
      <ul className="ep-list">
        {list.map((e) => {
          const key = watchKey(session.target.metaId, e.season, e.episode);
          const current = e.season === session.target.season && e.episode === session.target.episode;
          const upcoming = e.released ? Date.parse(e.released) > now : false;
          const p = progress[key];
          return (
            <li key={e.id}>
              <button
                className={`ep-item ${current ? 'is-current' : ''} ${watched[key] ? 'is-watched' : ''}`}
                disabled={upcoming || current}
                onClick={() => {
                  onClose();
                  void playEpisode(session.meta!, session.target.metaId, e);
                }}
              >
                <span className="ep-item__thumb">
                  <Img src={e.thumbnail} alt="" className="ep-item__img" fallback={<span className="episode__noimg">E{e.episode}</span>} />
                  {p && (
                    <span className="episode__progress">
                      <ProgressLine value={p.positionS / p.durationS} />
                    </span>
                  )}
                </span>
                <span className="ep-item__text">
                  <span className="ep-item__title">
                    {e.episode}. {e.title ?? `Episode ${e.episode}`}
                  </span>
                  <span className="ep-item__sub">{current ? 'Playing now' : upcoming ? `Airs ${new Date(Date.parse(e.released!)).toLocaleDateString()}` : watched[key] ? 'Watched' : p ? `${formatTime(p.durationS - p.positionS)} left` : ''}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function ErrorPanel({ session, error, onExit }: { session: Session; error: string; onExit: () => void }) {
  return (
    <div className="player__error" role="alert">
      <p className="player__error-title">This source would not play</p>
      <p className="player__error-detail">{error}</p>
      <div className="player__error-actions">
        <Button variant="primary" onClick={() => startStream(session.target, session.stream, getPlayerState().timePos || 0, session.meta, session.streams, 0)}>
          Retry
        </Button>
        <Button variant="secondary" icon={<ListVideo size={16} />} onClick={openSwitcher}>
          Try another source
        </Button>
        <Button variant="ghost" onClick={onExit}>
          Back
        </Button>
      </div>
    </div>
  );
}

function MenuButton(props: { name: Exclude<MenuName, null>; label: string; icon: React.ReactNode; open: MenuName; setOpen: (m: MenuName) => void; children: React.ReactNode }) {
  const isOpen = props.open === props.name;
  return (
    <div className="menu-anchor">
      <button className={`icon-btn${isOpen ? ' is-active' : ''}`} aria-label={props.label} title={props.label} aria-expanded={isOpen} onClick={() => props.setOpen(isOpen ? null : props.name)}>
        {props.icon}
      </button>
      {isOpen && props.children}
    </div>
  );
}

function VolumeControl({ onChange }: { onChange: (v: number) => void }) {
  const volume = usePlayer((s) => s.volume);
  const mute = usePlayer((s) => s.mute);
  const level = mute ? 0 : volume;
  const Icon = level === 0 ? VolumeX : level < 50 ? Volume1 : Volume2;
  return (
    <div className="volume">
      <button className="icon-btn" aria-label={mute ? 'Unmute' : 'Mute'} title="Mute (M)" onClick={() => mpv.set('mute', !mute)}>
        <Icon size={22} />
      </button>
      <input
        className="volume__slider"
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.min(100, level)}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${Math.min(100, level)}%` }}
        aria-label="Volume"
      />
      {level > 100 && <span className="volume__boost">{Math.round(level)}%</span>}
    </div>
  );
}

function Stats({ session }: { session: Session }) {
  const vp = usePlayer((s) => s.videoParams);
  const hwdec = usePlayer((s) => s.hwdec);
  const output = usePlayer((s) => s.audioOutput);
  const tracks = usePlayer((s) => s.tracks);
  const cacheTime = usePlayer((s) => s.cacheTime);
  const timePos = usePlayer((s) => s.timePos);
  const video = tracks.find((t) => t.type === 'video' && t.selected);
  const audio = tracks.find((t) => t.type === 'audio' && t.selected);
  const rows: [string, string][] = [
    ['Source', `${session.stream.addonName}${session.stream.name ? ` · ${session.stream.name.split('\n')[0]}` : ''}`],
    ['Video', [video?.codec?.toUpperCase(), vp ? `${vp.w}×${vp.h}` : null, vp?.gamma ? String(vp.gamma) : null, vp?.primaries ? String(vp.primaries) : null].filter(Boolean).join(' · ') || '—'],
    ['Decoder', hwdec && hwdec !== 'no' ? `Hardware (${hwdec})` : 'Software'],
    ['Audio', [audio?.codec?.toUpperCase(), audio?.lang, audio?.['demux-channel-count'] ? `${audio['demux-channel-count']} ch` : null].filter(Boolean).join(' · ') || '—'],
    ['Output', output || 'none'],
    ['Buffered ahead', `${Math.max(0, cacheTime - timePos).toFixed(0)} s`],
  ];
  return (
    <div className="stats">
      {rows.map(([k, v]) => (
        <div key={k} className="stats__row">
          <span className="stats__key">{k}</span>
          <span className="stats__value">{v}</span>
        </div>
      ))}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space or K', 'Play / pause'],
  ['← / →', 'Back / forward (Shift: ×3)'],
  ['↑ / ↓ or wheel', 'Volume'],
  ['M', 'Mute'],
  ['F or double-click', 'Full screen'],
  ['S', 'Skip intro, recap or credits'],
  ['N', 'Next episode'],
  ['C', 'Next subtitle track'],
  ['0–9', 'Jump to 0–90 %'],
  [', / .', 'Frame back / forward (paused)'],
  ['I', 'Playback info'],
  ['P', 'Picture in picture'],
  ['Esc', 'Leave full screen / close'],
  ['Backspace', 'Stop and go back'],
];

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={520}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="shortcuts__row">
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
