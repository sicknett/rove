import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, Captions, ChevronRight, Gauge, MoreHorizontal, Info, Keyboard, ListVideo, Maximize, Minimize, MonitorPlay, Pause, Play, RotateCcw, RotateCw, SkipForward, Rows3, Volume1, Volume2, VolumeX, PictureInPicture2,
} from 'lucide-react';
import { appWindow, mpv, send, subscribe } from '../bridge';
import { useSettings, settingsNow } from '../state/settings';
import { fetchStreams } from '../addons/client';
import { episodeGuide } from '../data/hooks';
import { watchKey } from '../addons/ids';
import { useHistory } from '../state/history';
import { Img } from '../ui/Img';
import { Button, Dialog, ProgressLine, Select, Sheet } from '../ui/controls';
import { formatTime } from '../format';
import { AudioMenu, SpeedMenu, SubtitleMenu, VideoMenu } from './Menus';
import { Scrubber } from './Scrubber';
import { getPlayerState, knownPosition, patchPlayerState, usePlayer } from './store';
import { TitleBar } from '../components/TitleBar';
import { cancelFinding, forgetLink, openSwitcher, startStream, stopPlayback, usePlayback, type PlayTarget, type Session } from './session';
import { markSessionWatched, rememberChoice, useDeadLinkRecovery, useNextEpisode, useProgressSaving, useSegments, useTrackSetup } from './runtime';
import { activeSegment, endingStart, reachedEnd, type Segment } from './skips';
import { episodeTarget, playEpisode } from './launch';
import type { EpisodeRef } from '../library/continue';
import { toast } from '../ui/toast';
import { setPip, usePip } from './pip';

type MenuName = 'audio' | 'subs' | 'speed' | 'video' | 'more' | null;
const HIDE_AFTER_MS = 2800;

export function Player() {
  const session = usePlayback((s) => s.session)!;
  const pause = usePlayer((s) => s.pause);
  const loading = usePlayer((s) => s.loading);
  const buffering = usePlayer((s) => s.pausedForCache || (s.seeking && !s.pause));
  const cacheBuffering = usePlayer((s) => s.cacheBuffering);
  const fullscreen = usePlayer((s) => s.window.fullscreen);
  const error = usePlayer((s) => s.error);
  const eof = usePlayer((s) => s.eof);
  const audioLost = usePlayer((s) => s.lastAudioTrack !== null && (!s.audioOutput || s.audioOutput === 'null') && !s.loading);
  const finding = usePlayback((s) => s.finding);
  // Sources are being found again for this same video (its remembered link had expired).
  const recovering = !!finding && finding.videoId === session.target.videoId;
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
  /** Where a press on the picture began, while it may still become a drag of the mini player. */
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  /** The session a next-episode start is under way for, so the countdown, the end of the file and a click do not each start one. */
  const startingNext = useRef(0);
  /** The session whose end of file has been dealt with. */
  const ended = useRef(0);
  /** How often starting the next episode has come to nothing in a session. */
  const [nextStall, setNextStall] = useState({ id: 0, n: 0 });

  useProgressSaving(session);
  useTrackSetup(session);
  useDeadLinkRecovery(session);
  const segments = useSegments(session);
  const next = useNextEpisode(session);
  // The session object is replaced as sources arrive; handlers read the latest without being rebuilt.
  const live = useRef({ session, segments });
  live.current = { session, segments };

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


  const shown = controlsVisible || pause || menu !== null || loading || recovering || !!error;

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
    return volume;
  }, []);

  const exit = useCallback(() => {
    setPip(false);
    stopPlayback();
  }, []);

  const playNext = useCallback(
    async (auto: boolean) => {
      const { session: sess, segments: segs } = live.current;
      if (!next || !sess.meta || startingNext.current === sess.id) return;
      startingNext.current = sess.id;
      // Moving on during the credits (or once the next-episode card would show) is finishing the
      // episode, even short of the share of it that counts as watched by itself.
      const { pos, dur } = knownPosition();
      if (dur > 0 && pos >= endingStart(segs, dur, settingsNow().playback.nextLeadSec)) markSessionWatched(sess);
      const unattended = auto && lastInput.current < sess.startedAt + 5000 ? sess.unattendedCount + 1 : 0;
      try {
        // The launch shows "finding" in the player at once and gives up if the player is left
        // (or something else is started) while the episode is being looked up.
        await playEpisode(sess.meta, sess.target.metaId, next, { unattended, fromStart: false });
      } catch (e) {
        console.error(e);
        toast.error('Could not start the next episode.');
      } finally {
        if (startingNext.current === sess.id) startingNext.current = 0;
        // Still on this episode: the next one did not start by itself (no source fitted and the
        // list opened, a question is up, or it failed). The card stops counting down for it.
        if (usePlayback.getState().session?.id === sess.id) setNextStall((v) => ({ id: sess.id, n: v.id === sess.id ? v.n + 1 : 1 }));
      }
    },
    [next, session.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The end of the file. mpv holds the last frame there (paused), so something has to follow:
  // the next episode, or back to where the user came from.
  useEffect(() => {
    if (!eof || ended.current === session.id) return;
    const { pos, dur } = knownPosition();
    // No length yet means the report is left over from the file before.
    if (!(dur > 0) || getPlayerState().loading) return;
    ended.current = session.id;
    if (!reachedEnd(pos, dur)) {
      // The data ran out well short of the length: the stream broke off. Shown as a failure,
      // with Retry picking up from here, and the link is not worth reusing.
      forgetLink(session.target.videoId, session.stream.url);
      patchPlayerState({ error: 'The stream stopped before the end. Its link may have expired.' });
      return;
    }
    markSessionWatched(session);
    if (next && session.meta) {
      // With auto-play off the next-episode card stays up and offers it.
      if (settingsNow().playback.autoPlayNext) void playNext(true);
      return;
    }
    exit();
  }, [eof, session.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // `auto`: skipped by the setting, not by the user, so the next episode counts as unattended.
    (seg: Segment, auto = false) => {
      const dur = getPlayerState().duration;
      const end = seg.end ?? dur;
      if (seg.kind === 'credits' && next && (seg.end === null || dur - end < 20)) {
        void playNext(auto);
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
      const el = e.target as HTMLElement;
      // Typing belongs to the field. The volume slider is no such field: it keeps the focus
      // after a click, and the shortcuts must not die with it.
      const typing = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range');
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      // A dialog or sheet on top has the keyboard.
      if (document.querySelector('.overlay')) return;
      const s = getPlayerState();
      const step = settingsNow().playback.seekStepSec;
      // Letters work with Caps Lock on too.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
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
          showFlash('forward', `${setVolume(s.volume + 5)}%`);
          break;
        case 'ArrowDown':
          e.preventDefault();
          showFlash('back', `${setVolume(s.volume - 5)}%`);
          break;
        case 'm':
          mpv.set('mute', !s.mute);
          break;
        case 'f':
          // The mini player stays small; full screen is for the full window.
          if (!pip) appWindow.fullscreen();
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
          // Remembered for the show, like a pick from the menu.
          rememberChoice(live.current.session, 'sub', nextSub);
          break;
        }
        case 'p':
          setPip(!pip);
          break;
        case 'Escape':
          // Speed and Picture opened out of More: Escape goes back to it, then closes it.
          if (menu === 'speed' || menu === 'video') setMenu('more');
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
  }, [exit, menu, poke, seekBy, togglePause, setVolume, next, playNext, activeSeg, skipSegment, pip]);

  const onSurfaceClick = (e: React.MouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (menu) {
      setMenu(null);
      return;
    }
    if (e.detail === 1) clickTimer.current = window.setTimeout(togglePause, 220);
    else {
      window.clearTimeout(clickTimer.current);
      // The mini player has no full screen: a double click brings the full window back.
      if (pip) setPip(false);
      else appWindow.fullscreen();
    }
  };

  // The mini player has no title bar, so dragging the picture moves the window. The move starts
  // only once the pointer has travelled, which leaves a plain click to pause.
  const onSurfacePointerDown = (e: React.PointerEvent) => {
    dragged.current = false;
    dragFrom.current = pip && e.button === 0 ? { x: e.screenX, y: e.screenY } : null;
  };
  const onSurfacePointerMove = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    if (!(e.buttons & 1)) {
      dragFrom.current = null;
      return;
    }
    if (Math.abs(e.screenX - from.x) + Math.abs(e.screenY - from.y) < 6) return;
    dragFrom.current = null;
    dragged.current = true;
    window.clearTimeout(clickTimer.current);
    appWindow.drag();
  };

  const onWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('.menu, .sheet')) return;
    const s = getPlayerState();
    showFlash(e.deltaY < 0 ? 'forward' : 'back', `${setVolume(s.volume + (e.deltaY < 0 ? 5 : -5))}%`);
    poke();
  };

  const moreOpen = menu === 'more' || menu === 'speed' || menu === 'video';
  const t = session.target;
  const epLabel = t.type === 'series' && t.season !== undefined ? `S${t.season} E${t.episode}${t.episodeTitle ? ` · ${t.episodeTitle}` : ''}` : undefined;

  return (
    <div className={`player${shown ? '' : ' player--idle'}${pip ? ' player--pip' : ''}`} onPointerMove={poke} onPointerDown={poke} onWheel={onWheel}>
      <div className="player__surface" onClick={onSurfaceClick} onPointerDown={onSurfacePointerDown} onPointerMove={onSurfacePointerMove} />

      <div className="player__scrim player__scrim--top" />
      <div className="player__scrim player__scrim--bottom" />

      {!pip && <TitleBar overVideo visible={shown} />}

      <div className="player__top">
        <button className="icon-btn icon-btn--lg" aria-label="Back" data-tip="Back (Backspace)" data-tip-below onClick={exit}>
          <ArrowLeft size={22} />
        </button>
        <div className="player__heading">
          {t.logo && !epLabel ? <Img src={t.logo} alt={t.name} className="player__logo" fallback={<h1 className="player__title">{t.name}</h1>} /> : <h1 className="player__title">{t.name}</h1>}
          {epLabel && <p className="player__subtitle">{epLabel}</p>}
        </div>
      </div>

      {(recovering || ((loading || buffering) && !error)) && (
        <div className="player__center" aria-live="polite">
          <div className="spinner" />
          {!loading && !recovering && cacheBuffering < 100 && <span className="player__buffer-pct">{Math.round(cacheBuffering)}%</span>}
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

      {error && !recovering && <ErrorPanel session={session} error={error} onExit={exit} />}

      {audioLost && !error && (
        <div className="toast" role="status">
          <span className="toast__dot" /> Audio device disconnected. Sound comes back when it reconnects.
        </div>
      )}

      {stats && <Stats session={session} />}

      {activeSeg && !error && <SkipButton seg={activeSeg} next={!!next} onSkip={() => skipSegment(activeSeg)} raised={shown} />}

      {next && !error && <UpNext session={session} next={next} segments={segments} onPlay={playNext} stall={nextStall.id === session.id ? nextStall.n : 0} />}

      {finding && !recovering && <FindingCard target={finding} />}

      <div className="player__bottom">
        <div className="player__controls" onPointerEnter={() => (hovering.current = true)} onPointerLeave={() => (hovering.current = false)}>
          <Scrubber segments={segments} />
          <div className="controls-row">
            <div className="controls-row__group">
              <button className="icon-btn icon-btn--play" aria-label={pause ? 'Play' : 'Pause'} data-tip={pause ? 'Play (Space)' : 'Pause (Space)'} onClick={togglePause}>
                {pause ? <Play size={26} fill="currentColor" strokeWidth={0} /> : <Pause size={26} fill="currentColor" strokeWidth={0} />}
              </button>
              <button className="icon-btn" aria-label="Back 10 seconds" data-tip="Back (←)" onClick={() => seekBy(-settingsNow().playback.seekStepSec)}>
                <RotateCcw size={21} />
                <span className="icon-btn__badge">{settingsNow().playback.seekStepSec}</span>
              </button>
              <button className="icon-btn" aria-label="Forward 10 seconds" data-tip="Forward (→)" onClick={() => seekBy(settingsNow().playback.seekStepSec)}>
                <RotateCw size={21} />
                <span className="icon-btn__badge">{settingsNow().playback.seekStepSec}</span>
              </button>
              {next && (
                <button className="icon-btn" aria-label="Next episode" data-tip="Next episode (N)" onClick={() => void playNext(false)}>
                  <SkipForward size={21} fill="currentColor" strokeWidth={1.5} />
                </button>
              )}
              <VolumeControl onChange={setVolume} />
            </div>
            <div className="controls-row__group">
              {t.type === 'series' && session.meta && (
                <button className={`icon-btn ${panel === 'episodes' ? 'is-active' : ''}`} aria-label="Episodes" data-tip="Episodes" onClick={() => setPanel('episodes')}>
                  <Rows3 size={21} />
                </button>
              )}
              <button className="icon-btn" aria-label="Sources" data-tip="Sources" onClick={openSwitcher}>
                <ListVideo size={21} />
              </button>
              <MenuButton name="subs" label="Subtitles" tip="Subtitles (C)" open={menu} setOpen={setMenu} icon={<Captions size={22} />}>
                <SubtitleMenu />
              </MenuButton>
              <MenuButton name="audio" label="Audio" open={menu} setOpen={setMenu} icon={<AudioLines size={21} />}>
                <AudioMenu />
              </MenuButton>
              {/* Everything used less often sits behind one button; Speed and Picture open in its place. */}
              <div className="menu-anchor">
                <button
                  className={`icon-btn${moreOpen ? ' is-active' : ''}`}
                  aria-label="More"
                  data-tip="More: speed, picture, info"
                  aria-expanded={moreOpen}
                  onClick={() => setMenu(moreOpen ? null : 'more')}
                >
                  <MoreHorizontal size={22} />
                </button>
                {menu === 'more' && (
                  <MoreMenu
                    stats={stats}
                    open={(m) => setMenu(m)}
                    onStats={() => (setStats((v) => !v), setMenu(null))}
                    onHelp={() => (setHelp(true), setMenu(null))}
                    onPip={() => (setPip(true), setMenu(null))}
                  />
                )}
                {menu === 'speed' && <SpeedMenu onBack={() => setMenu('more')} />}
                {menu === 'video' && <VideoMenu onBack={() => setMenu('more')} />}
              </div>
              {pip && (
                <button className="icon-btn is-active" aria-label="Leave picture in picture" data-tip="Leave picture in picture (P)" onClick={() => setPip(false)}>
                  <PictureInPicture2 size={20} />
                </button>
              )}
              <button className="icon-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} data-tip="Full screen (F)" onClick={() => appWindow.fullscreen()}>
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

function useAutoSkip(seg: Segment | null, skip: (s: Segment, auto?: boolean) => void) {
  const done = useRef(new Set<Segment>());
  useEffect(() => {
    if (!seg || done.current.has(seg)) return;
    const p = settingsNow().playback;
    const mode = seg.kind === 'intro' ? p.skipIntro : seg.kind === 'recap' ? p.skipRecap : seg.kind === 'credits' ? p.skipCredits : 'button';
    if (mode !== 'auto') return;
    done.current.add(seg);
    toast.info(`Skipped the ${seg.kind}`);
    skip(seg, true);
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

function UpNext({ session, next, segments, onPlay, stall }: { session: Session; next: EpisodeRef; segments: Segment[]; onPlay: (auto: boolean) => Promise<void>; stall: number }) {
  const p = useSettings((s) => s.settings.playback);
  // While sources for the next episode are being found, the finding card stands in for this one.
  const finding = usePlayback((s) => !!s.finding);
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'dismissed'>('hidden');
  const [left, setLeft] = useState(p.nextCountdownSec);
  // Starting the next episode came to nothing (the source list opened, or it failed): from then
  // on the card only offers it, or it would count down into the same result again and again.
  const [manual, setManual] = useState(false);
  const prefetched = useRef(false);
  const started = useRef(false);
  const sessionId = session.id;
  const meta = session.meta;
  const metaId = session.target.metaId;
  const auto = p.autoPlayNext && !manual;

  useEffect(() => {
    setPhase('hidden');
    setManual(false);
    prefetched.current = false;
    started.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (stall) setManual(true);
  }, [stall]);

  // When to show: the credits marker if there is one near the end, else a lead time before the end.
  useEffect(() => {
    const id = window.setInterval(() => {
      const s = getPlayerState();
      if (!(s.duration > 0) || s.loading) return;
      const at = endingStart(segments, s.duration, p.nextLeadSec);
      // Ask the addons about the next episode shortly before the card shows: their answers are
      // only kept for a few minutes, so asking earlier in a long episode would be wasted.
      if (!prefetched.current && meta && s.timePos >= at - 60) {
        prefetched.current = true;
        void (async () => {
          const target = await episodeTarget(meta, metaId, next);
          await fetchStreams('series', target.videoId, () => undefined);
        })().catch(() => undefined);
      }
      if (s.timePos >= at && phase === 'hidden') {
        setPhase('shown');
        setLeft(p.nextCountdownSec);
      }
      // Seeking back out of the ending takes the card away; next time it starts over.
      if (s.timePos < at - 5 && phase !== 'hidden') {
        setPhase('hidden');
        setManual(false);
        started.current = false;
      }
      // At the very end nothing else moves on: if the card only offers, it has to be there.
      if (s.eof && phase === 'dismissed' && !auto) setPhase('shown');
    }, 400);
    return () => window.clearInterval(id);
  }, [segments, p.nextLeadSec, p.nextCountdownSec, auto, phase, meta, metaId, next]);

  // Countdown. Reaching the end of the file starts the next episode too (see the player).
  useEffect(() => {
    if (phase !== 'shown' || !auto || finding) return;
    const id = window.setInterval(() => {
      const s = getPlayerState();
      // A paused video holds the countdown, except at the end, where mpv pauses by itself.
      if (s.pause && !s.eof) return;
      setLeft((l) => l - 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, auto, finding]);

  useEffect(() => {
    if (phase !== 'shown' || !auto || finding || left > 0 || started.current) return;
    started.current = true;
    void onPlay(true);
  }, [left, phase, auto, finding, onPlay]);

  if (phase !== 'shown' || finding) return null;
  const total = p.nextCountdownSec;
  return (
    <div className="upnext" role="dialog" aria-label="Next episode">
      <div className="upnext__thumb">
        <Img src={next.thumbnail ?? session.target.background} alt="" className="upnext__img" />
        {auto && (
          <svg className="upnext__ring" viewBox="0 0 36 36" aria-hidden>
            <circle cx="18" cy="18" r="16" className="upnext__ring-bg" />
            <circle cx="18" cy="18" r="16" className="upnext__ring-fg" style={{ strokeDashoffset: `${100 - (Math.max(0, left) / total) * 100}` }} />
          </svg>
        )}
      </div>
      <div className="upnext__text">
        <span className="upnext__eyebrow">{auto ? `Next episode in ${Math.max(0, left)}` : 'Next episode'}</span>
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

/**
 * "Finding the best source…" for a video that is about to replace the one playing (the next
 * episode, one picked from the list). A card, so the current video stays in view until then.
 */
function FindingCard({ target }: { target: PlayTarget }) {
  return (
    <div className="upnext" role="status" aria-live="polite">
      <div className="upnext__thumb">
        <Img src={target.still ?? target.background} alt="" className="upnext__img" />
      </div>
      <div className="upnext__text">
        <span className="upnext__eyebrow">Finding the best source…</span>
        <span className="upnext__title">
          {target.season !== undefined ? `S${target.season} E${target.episode}${target.episodeTitle ? ` · ${target.episodeTitle}` : ''}` : target.name}
        </span>
        <div className="upnext__actions">
          <Button variant="ghost" size="sm" onClick={cancelFinding}>
            Cancel
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
  // The same guide as the title page (library/episodes): numbered seasons, then Specials; in a
  // season its episodes in order, then the extras the data files there.
  const groups = useMemo(() => episodeGuide(session.meta).seasons, [session.meta]);
  const seasons = groups.map((g) => g.season);
  const seasonName = (s: number) => (s === 0 ? 'Specials' : `Season ${s}`);
  const [season, setSeason] = useState(session.target.season ?? seasons[0]);
  const progress = useHistory((s) => s.progress);
  const watched = useHistory((s) => s.watched);
  const group = groups.find((g) => g.season === season);
  const list = group ? [...group.episodes, ...group.extras] : [];
  const firstExtra = group?.extras[0];
  const now = Date.now();
  const listRef = useRef<HTMLUListElement>(null);
  // Opens on the episode that is playing; another season starts at its top.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.ep-item.is-current');
    if (el) el.scrollIntoView({ block: 'center' });
    else listRef.current?.parentElement?.scrollTo({ top: 0 });
  }, [season]);
  const shown = group?.episodes.length ?? 0;
  const count = `${shown} episode${shown === 1 ? '' : 's'}${group?.extras.length ? ` · ${group.extras.length} extra${group.extras.length === 1 ? '' : 's'}` : ''}`;
  // One season picker that never runs off the panel, however many seasons there are.
  const picker =
    seasons.length > 1 ? (
      <span className="ep-seasons">
        <Select value={season} label="Season" onChange={setSeason} options={groups.map((g) => ({ value: g.season, label: seasonName(g.season), detail: `${g.episodes.length} episodes` }))} />
        <span className="ep-seasons__count">{count}</span>
      </span>
    ) : (
      count
    );
  return (
    <Sheet open onClose={onClose} title={session.target.name} subtitle={picker} width={540}>
      <ul className="ep-list" ref={listRef}>
        {list.map((e) => {
          const key = watchKey(session.target.metaId, e.season, e.episode);
          const current = e.season === session.target.season && e.episode === session.target.episode;
          const upcoming = e.released ? Date.parse(e.released) > now : false;
          const p = progress[key];
          const overview = e.overview;
          return (
            // Keyed by the guide, not the addon's video id: a video listed twice must not leave rows behind.
            <li key={e.key ?? `${e.season}:${e.episode}:${e.id}`} className={e === firstExtra ? 'ep-list__extras' : undefined}>
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
                  {overview && <span className="ep-item__overview">{overview}</span>}
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
        {/* From where the video last really was: the live position reads 0 once a stream has failed. */}
        <Button variant="primary" onClick={() => startStream(session.target, session.stream, knownPosition().pos, session.meta, session.streams, 0)}>
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

const ASPECT_NAMES: Record<string, string> = { fit: 'Fit', fill: 'Fill', zoom: 'Zoom' };

/** The less-used controls, by name. Speed and Picture open their own menus in this one's place. */
function MoreMenu({ stats, open, onStats, onHelp, onPip }: { stats: boolean; open: (m: 'speed' | 'video') => void; onStats: () => void; onHelp: () => void; onPip: () => void }) {
  const speed = usePlayer((s) => s.speed);
  const aspect = usePlayer((s) => s.aspect);
  const row = (icon: React.ReactNode, label: string, detail: string, onClick: () => void, more = false) => (
    <button className="menu__item menu__item--nav" role="menuitem" onClick={onClick}>
      <span className="menu__check menu__check--icon">{icon}</span>
      <span className="menu__label">{label}</span>
      <span className="menu__value">
        {detail}
        {more && <ChevronRight size={15} />}
      </span>
    </button>
  );
  return (
    <div className="menu menu--more" role="menu" onPointerDown={(e) => e.stopPropagation()}>
      {row(<Gauge size={17} />, 'Speed', speed === 1 ? 'Normal' : `${speed}×`, () => open('speed'), true)}
      {row(<MonitorPlay size={17} />, 'Picture', ASPECT_NAMES[aspect] ?? aspect, () => open('video'), true)}
      <div className="menu__divider" />
      {row(<PictureInPicture2 size={17} />, 'Picture in picture', 'P', onPip)}
      {row(<Info size={17} />, 'Playback info', stats ? 'On' : 'I', onStats)}
      {row(<Keyboard size={17} />, 'Keyboard shortcuts', '?', onHelp)}
    </div>
  );
}

function MenuButton(props: { name: Exclude<MenuName, null>; label: string; tip?: string; icon: React.ReactNode; open: MenuName; setOpen: (m: MenuName) => void; children: React.ReactNode }) {
  const isOpen = props.open === props.name;
  return (
    <div className="menu-anchor">
      <button className={`icon-btn${isOpen ? ' is-active' : ''}`} aria-label={props.label} data-tip={props.tip ?? props.label} aria-expanded={isOpen} onClick={() => props.setOpen(isOpen ? null : props.name)}>
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
      <button className="icon-btn" aria-label={mute ? 'Unmute' : 'Mute'} data-tip="Mute (M)" onClick={() => mpv.set('mute', !mute)}>
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
        // Let go of the keyboard focus after a drag, so the arrow keys go back to the player.
        onPointerUp={(e) => e.currentTarget.blur()}
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
  ['Esc', 'Close a menu, leave full screen'],
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
