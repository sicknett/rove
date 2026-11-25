// What runs while something plays: saving progress, choosing tracks, adding addon subtitles,
// recovering from a dead link, finding skip segments, and working out the next episode.

import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSubtitles } from '../addons/client';
import { parseId } from '../addons/ids';
import { mpv } from '../bridge';
import { episodesOf } from '../data/hooks';
import { nextEpisode, type EpisodeRef } from '../library/continue';
import { useHistory } from '../state/history';
import { settingsNow, useSettings } from '../state/settings';
import { useTracker } from '../tracking/sync';
import { tmdbFor } from '../tracking/idmap';
import { toast } from '../ui/toast';
import { applyPlayerSettings, chooseTracks, normLang, rememberTracks, trackMemory } from './prefs';
import { forgetLink, onLeaveVideo, play, streamStarted, usePlayback, type Session } from './session';
import { chapterSegments, fetchSegments, type Segment } from './skips';
import { getPlayerState, knownPosition, onPlayerEvent, usePlayer } from './store';
import { languageName } from '../format';
import { isServerStream, reportToServer } from '../servers';

const LOCAL_SAVE_MS = 5000;
const REMOTE_SAVE_MS = 5 * 60 * 1000;
const PAUSE_SAVE_COOLDOWN_MS = 15000;

/** The session whose video was marked watched from the player: later saves must not bring its resume point back. */
let finishedSession = 0;
/** The session in which the user chose a subtitle track themselves, which the language rules then leave alone. */
let subtitlePickedIn = 0;
/** The video a dead remembered link was last replaced for; a second failure in a row is shown, not retried. */
let recoveredVideo: string | null = null;

/**
 * Marks the session's video watched now, whatever share of it played: the user moved on during
 * the credits, or it ran to its end.
 */
export function markSessionWatched(session: Session) {
  const { dur } = knownPosition();
  if (finishedSession === session.id || !(dur > 0)) return;
  // Recorded as played to the end, which history marks once per viewing however often it is told
  // (the regular saves may have marked it already).
  record(session, true, dur, dur);
  finishedSession = session.id;
}

function save(session: Session, sync: boolean) {
  if (finishedSession === session.id) return;
  // Not the live position: that reads 0 while a file loads and after it fails or is unloaded.
  const { pos, dur } = knownPosition();
  return record(session, sync, pos, dur);
}

function record(session: Session, sync: boolean, pos: number, dur: number) {
  // A bare link (quick test) is not a title: nothing to remember.
  if (session.target.metaId.startsWith('link:')) return;
  if (!(dur > 0) || !(pos >= 0)) return;
  const t = session.target;
  const result = useHistory.getState().recordProgress(
    {
      metaId: t.metaId,
      type: t.type,
      season: t.season,
      episode: t.episode,
      videoId: t.videoId,
      positionS: pos,
      durationS: dur,
      tmdbId: t.tmdbId,
      name: t.name,
      poster: t.poster,
      background: t.background,
      logo: t.logo,
      episodeTitle: t.episodeTitle,
      still: t.still,
    },
    { sync },
  );
  return result;
}

/** Progress for the tracker and Continue Watching. */
export function useProgressSaving(session: Session | null) {
  const lastRemote = useRef(0);
  const lastPauseSave = useRef(0);

  useEffect(() => {
    if (!session) return;
    lastRemote.current = Date.now();
    // A media server's own copy: the server hears about playback too, for its resume points.
    const fromServer = isServerStream(session.stream);
    let serverStarted = false;
    // The player may already be on the next file when the stop report goes out.
    const last = { pos: 0, dur: 0 };
    // Set once the video has been left: nothing may follow the stop report.
    let left = false;
    const report = (what: 'start' | 'progress' | 'pause' | 'stop'): Promise<void> | undefined => {
      if (!fromServer || left) return;
      const k = knownPosition();
      if (k.dur > 0) {
        last.pos = k.pos;
        last.dur = k.dur;
      } else if (what !== 'stop') return;
      if (what === 'start') serverStarted = true;
      else if (!serverStarted) return;
      return reportToServer(session.stream, what, last.pos, last.dur);
    };
    let tick = 0;
    // What the last local save held, so a paused player does not rewrite the same thing every tick.
    let saved: { pos: number; paused: boolean } | null = null;
    const local = window.setInterval(() => {
      const s = getPlayerState();
      if (left || s.loading || s.idle) return;
      const remoteDue = Date.now() - lastRemote.current > REMOTE_SAVE_MS && !s.pause;
      if (remoteDue) lastRemote.current = Date.now();
      const pos = knownPosition().pos;
      if (remoteDue || !saved || saved.paused !== s.pause || Math.abs(saved.pos - pos) >= 1) {
        saved = { pos, paused: s.pause };
        save(session, remoteDue);
      }
      if (!serverStarted) void report('start');
      else if (!s.pause && ++tick % 2 === 0) void report('progress');
    }, LOCAL_SAVE_MS);

    let wasPaused = getPlayerState().pause;
    const off = onPlayerEvent((e) => {
      if (e.name === 'end-file' && !e.stale && !left) save(session, true);
    });
    const pauseWatch = window.setInterval(() => {
      if (left) return;
      const paused = getPlayerState().pause;
      if (paused !== wasPaused) void report(paused ? 'pause' : 'progress');
      if (paused && !wasPaused && Date.now() - lastPauseSave.current > PAUSE_SAVE_COOLDOWN_MS) {
        lastPauseSave.current = Date.now();
        save(session, true);
      }
      wasPaused = paused;
    }, 500);

    // Leaving this video (stop, next episode, another source, the window closing): the last
    // position goes to the tracker and the server. Whatever starts the next load calls this before
    // it resets the player state; by the time this effect is cleaned up the position is gone.
    const leave = () => {
      if (left) return;
      save(session, true);
      const stopped = report('stop');
      left = true;
      return stopped;
    };
    const withdraw = onLeaveVideo(leave);

    return () => {
      window.clearInterval(local);
      window.clearInterval(pauseWatch);
      off();
      withdraw();
      void leave();
    };
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Track choice when a file loads, addon subtitles, and remembering what the user picks. */
export function useTrackSetup(session: Session | null) {
  const applied = useRef<number | null>(null);
  /** The session whose first choice has been made, so later track changes may refine it. */
  const chosen = useRef<number | null>(null);
  useEffect(() => {
    if (!session) return;
    applyPlayerSettings();
    let timer: number | undefined;
    const off = onPlayerEvent((e) => {
      if (e.name !== 'file-loaded' || e.stale || applied.current === session.id) return;
      applied.current = session.id;
      // Track list arrives with the file; give the props batch a moment.
      timer = window.setTimeout(() => {
        if (usePlayback.getState().session?.id !== session.id) return;
        const tracks = getPlayerState().tracks;
        const sel = chooseTracks(tracks, settingsNow(), trackMemory(session.target.metaId));
        if (sel.aid !== undefined) mpv.set('aid', sel.aid);
        if (sel.sid !== undefined) mpv.set('sid', sel.sid);
        chosen.current = session.id;
        void loadAddonSubtitles(session);
      }, 250);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Addon subtitles are added after the file's own, one download at a time. Each arrival gives
  // the language rules another go, so a remembered or preferred language the file lacks is
  // switched to when an addon has it. Once the user picks a track themselves, that stands.
  const tracks = usePlayer((s) => s.tracks);
  useEffect(() => {
    if (!session || chosen.current !== session.id || subtitlePickedIn === session.id) return;
    if (!tracks.some((t) => t.type === 'sub' && t.external)) return;
    const sel = chooseTracks(tracks, settingsNow(), trackMemory(session.target.metaId));
    if (typeof sel.sid === 'number' && sel.sid !== getPlayerState().sid) mpv.set('sid', sel.sid);
  }, [tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep settings live while playing (subtitle style, decoding, audio).
  const settings = useSettings((s) => s.settings);
  useEffect(() => {
    if (session) applyPlayerSettings(settings);
  }, [settings, session]);
}

async function loadAddonSubtitles(session: Session) {
  const t = session.target;
  const hints = { filename: session.stream.behaviorHints?.filename, videoSize: session.stream.behaviorHints?.videoSize, videoHash: session.stream.behaviorHints?.videoHash };
  const subs = await fetchSubtitles(t.type === 'movie' ? 'movie' : 'series', t.videoId, hints).catch(() => []);
  const embeddedFromStream = (session.stream.subtitles ?? []).filter((s) => s?.url);
  // Some addons leave the language out; one such entry must not take the rest down with it.
  const all = [...embeddedFromStream.map((s) => ({ ...s, addonName: session.stream.addonName })), ...subs].map((s) => ({ ...s, lang: s.lang || 'und' }));
  if (!all.length) return;
  // Compared as normalised codes: addons say "eng" or "en-US" where the setting says "en".
  const prefs = settingsNow().languages.subtitles.map(normLang).filter((l): l is string => !!l);
  const rank = (lang: string) => {
    const code = normLang(lang);
    const at = code ? prefs.indexOf(code) : -1;
    return at < 0 ? prefs.length : at;
  };
  // Preferred languages first, at most a handful per language so the menu stays usable.
  const perLang = new Map<string, number>();
  const chosen = [...all]
    .sort((a, b) => rank(a.lang) - rank(b.lang))
    .filter((s) => {
      const key = normLang(s.lang) ?? 'und';
      const n = perLang.get(key) ?? 0;
      perLang.set(key, n + 1);
      return n < (rank(s.lang) < prefs.length ? 6 : 2);
    });
  for (const s of chosen) {
    if (usePlayback.getState().session?.id !== session.id) return;
    const label = `${languageName(s.lang) ?? s.lang} · ${s.addonName}`;
    mpv.command('sub-add', s.url, 'auto', label, s.lang);
  }
}

/** Saves the user's own track choices for this show. */
export function rememberChoice(session: Session | null, kind: 'audio' | 'sub', trackId: number | 'no') {
  if (!session) return;
  const tr = getPlayerState().tracks.find((t) => t.type === kind && t.id === trackId);
  if (kind === 'audio' && tr) rememberTracks(session.target.metaId, { audioLang: tr.lang, audioTitle: tr.title });
  if (kind === 'sub') {
    subtitlePickedIn = session.id;
    if (trackId === 'no') rememberTracks(session.target.metaId, { subOff: true, subLang: undefined, subTitle: undefined });
    else if (tr) rememberTracks(session.target.metaId, { subOff: false, subLang: tr.lang, subTitle: tr.title, forced: tr.forced || /forced/i.test(tr.title ?? '') });
  }
}

/**
 * Keeps the remembered link honest: it is remembered once the stream has really started, and
 * forgotten when it fails. A link reused from earlier that no longer loads is replaced by a
 * fresh search, once; any other failure is left to the error panel.
 */
export function useDeadLinkRecovery(session: Session | null) {
  useEffect(() => {
    if (!session) return;
    let started = false;
    return onPlayerEvent((e) => {
      if (e.stale) return;
      if (e.name === 'playback-restart' && !started) {
        started = true;
        if (recoveredVideo === session.target.videoId) recoveredVideo = null;
        streamStarted(session.id);
        return;
      }
      if (e.name !== 'end-file' || e.reason !== 'error') return;
      forgetLink(session.target.videoId, session.stream.url);
      if (!session.reused || started || recoveredVideo === session.target.videoId) return;
      recoveredVideo = session.target.videoId;
      toast.info('That link has expired. Finding a fresh source…');
      // The target keeps its start-by-percentage: nothing has played, so no better position exists.
      void play({ ...session.target, startAt: knownPosition().pos }, { meta: session.meta, unattended: session.unattendedCount, fresh: true });
    });
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Skip segments for the current video, once its length is known. */
export function useSegments(session: Session | null): Segment[] {
  const duration = usePlayer((s) => s.duration);
  const chapters = usePlayer((s) => s.chapters);
  const [segments, setSegments] = useState<Segment[]>([]);
  useEffect(() => {
    setSegments([]);
  }, [session?.id]);
  useEffect(() => {
    if (!session || !(duration > 0)) return;
    let alive = true;
    const t = session.target;
    void (async () => {
      const apiKey = useTracker.getState().apiKey;
      const base = parseId(t.metaId).base;
      const ids = t.tmdbId ? { id: t.tmdbId } : await tmdbFor(t.metaId, t.type, apiKey).catch(() => null);
      const malId = /^mal:(\d+)/.exec(base)?.[1];
      const segs = await fetchSegments(
        {
          imdbId: /^tt\d+$/.test(base) ? base : undefined,
          tmdbId: ids?.id,
          malId: malId ? Number(malId) : undefined,
          type: t.type,
          season: t.season,
          episode: t.episode ?? parseId(t.videoId).episode,
          duration,
          pmdbKey: apiKey,
        },
        chapterSegments(chapters, duration),
      );
      if (alive) setSegments(segs);
    })();
    return () => {
      alive = false;
    };
    // Chapters arrive with the file; re-run once they do.
  }, [session?.id, duration > 0, chapters.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return segments;
}

/** The episode after this one, if it has aired. */
export function useNextEpisode(session: Session | null): EpisodeRef | null {
  const meta = session?.meta;
  const type = session?.target.type;
  const season = session?.target.season;
  const episode = session?.target.episode;
  // Memoised: the result feeds effect dependencies (media keys, the Up Next countdown).
  return useMemo(() => {
    // Specials sit outside the running order: nothing follows one.
    if (type !== 'series' || !meta || season === undefined || season === 0) return null;
    return nextEpisode(episodesOf(meta), { season, episode: episode ?? 0 }, new Set(), Date.now());
  }, [meta, type, season, episode]);
}
