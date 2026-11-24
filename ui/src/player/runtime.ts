// What runs while something plays: saving progress, choosing tracks, adding addon subtitles,
// recovering from a dead link, finding skip segments, and working out the next episode.

import { useEffect, useRef, useState } from 'react';
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
import { applyPlayerSettings, chooseTracks, rememberTracks, trackMemory } from './prefs';
import { forgetLink, play, setPositionReader, usePlayback, type Session } from './session';
import { chapterSegments, fetchSegments, type Segment } from './skips';
import { getPlayerState, onPlayerEvent, usePlayer } from './store';
import { languageName } from '../format';
import { isServerStream, reportToServer } from '../servers';

const LOCAL_SAVE_MS = 5000;
const REMOTE_SAVE_MS = 5 * 60 * 1000;
const PAUSE_SAVE_COOLDOWN_MS = 15000;

function save(session: Session, sync: boolean) {
  // A bare link (quick test) is not a title: nothing to remember.
  if (session.target.metaId.startsWith('link:')) return;
  const s = getPlayerState();
  if (!(s.duration > 0) || !(s.timePos >= 0)) return;
  const t = session.target;
  const result = useHistory.getState().recordProgress(
    {
      metaId: t.metaId,
      type: t.type,
      season: t.season,
      episode: t.episode,
      videoId: t.videoId,
      positionS: s.timePos,
      durationS: s.duration,
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
    setPositionReader(() => getPlayerState().timePos);
    if (!session) return;
    lastRemote.current = Date.now();
    // A media server's own copy: the server hears about playback too, for its resume points.
    const fromServer = isServerStream(session.stream);
    let serverStarted = false;
    // The player may already be on the next file when the stop report goes out.
    const last = { pos: 0, dur: 0 };
    const report = (what: 'start' | 'progress' | 'pause' | 'stop') => {
      if (!fromServer) return;
      const s = getPlayerState();
      if (what !== 'stop') {
        if (!(s.duration > 0)) return;
        last.pos = s.timePos || 0;
        last.dur = s.duration;
      }
      if (what === 'start') serverStarted = true;
      else if (!serverStarted) return;
      void reportToServer(session.stream, what, last.pos, last.dur);
    };
    let tick = 0;
    const local = window.setInterval(() => {
      const s = getPlayerState();
      if (s.loading || s.idle) return;
      const remoteDue = Date.now() - lastRemote.current > REMOTE_SAVE_MS && !s.pause;
      if (remoteDue) lastRemote.current = Date.now();
      save(session, remoteDue);
      if (s.duration > 0) {
        last.pos = s.timePos || 0;
        last.dur = s.duration;
      }
      if (!serverStarted) report('start');
      else if (!s.pause && ++tick % 2 === 0) report('progress');
    }, LOCAL_SAVE_MS);

    let wasPaused = getPlayerState().pause;
    const off = onPlayerEvent((e) => {
      if (e.name === 'end-file') save(session, true);
    });
    const pauseWatch = window.setInterval(() => {
      const paused = getPlayerState().pause;
      if (paused !== wasPaused) report(paused ? 'pause' : 'progress');
      if (paused && !wasPaused && Date.now() - lastPauseSave.current > PAUSE_SAVE_COOLDOWN_MS) {
        lastPauseSave.current = Date.now();
        save(session, true);
      }
      wasPaused = paused;
    }, 500);

    return () => {
      window.clearInterval(local);
      window.clearInterval(pauseWatch);
      off();
      // Leaving this video (stop, next episode, another source): last position goes to the tracker.
      save(session, true);
      report('stop');
    };
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Track choice when a file loads, addon subtitles, and remembering what the user picks. */
export function useTrackSetup(session: Session | null) {
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!session) return;
    applyPlayerSettings();
    return onPlayerEvent((e) => {
      if (e.name !== 'file-loaded' || applied.current === session.id) return;
      applied.current = session.id;
      // Track list arrives with the file; give the props batch a moment.
      window.setTimeout(() => {
        const tracks = getPlayerState().tracks;
        const sel = chooseTracks(tracks, settingsNow(), trackMemory(session.target.metaId));
        if (sel.aid !== undefined) mpv.set('aid', sel.aid);
        if (sel.sid !== undefined) mpv.set('sid', sel.sid);
        void loadAddonSubtitles(session);
      }, 250);
    });
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const embeddedFromStream = session.stream.subtitles ?? [];
  const all = [...embeddedFromStream.map((s) => ({ ...s, addonName: session.stream.addonName })), ...subs];
  if (!all.length) return;
  const prefs = settingsNow().languages.subtitles;
  // Preferred languages first, at most a handful per language so the menu stays usable.
  const perLang = new Map<string, number>();
  const chosen = all.filter((s) => {
    const n = perLang.get(s.lang) ?? 0;
    perLang.set(s.lang, n + 1);
    return n < (prefs.some((p) => s.lang.toLowerCase().startsWith(p)) ? 6 : 2);
  });
  const hadSubs = getPlayerState().tracks.some((tr) => tr.type === 'sub');
  for (const s of chosen) {
    if (usePlayback.getState().session?.id !== session.id) return;
    const label = `${languageName(s.lang) ?? s.lang} · ${s.addonName}`;
    mpv.command('sub-add', s.url, 'auto', label, s.lang);
  }
  // A file with no subtitles of its own: apply the language rules to the added ones.
  if (!hadSubs) {
    window.setTimeout(() => {
      const sel = chooseTracks(getPlayerState().tracks, settingsNow(), trackMemory(session.target.metaId));
      if (sel.sid !== undefined && sel.sid !== 'no') mpv.set('sid', sel.sid);
    }, 1500);
  }
}

/** Saves the user's own track choices for this show. */
export function rememberChoice(session: Session | null, kind: 'audio' | 'sub', trackId: number | 'no') {
  if (!session) return;
  const tr = getPlayerState().tracks.find((t) => t.type === kind && t.id === trackId);
  if (kind === 'audio' && tr) rememberTracks(session.target.metaId, { audioLang: tr.lang, audioTitle: tr.title });
  if (kind === 'sub') {
    if (trackId === 'no') rememberTracks(session.target.metaId, { subOff: true, subLang: undefined, subTitle: undefined });
    else if (tr) rememberTracks(session.target.metaId, { subOff: false, subLang: tr.lang, subTitle: tr.title, forced: tr.forced || /forced/i.test(tr.title ?? '') });
  }
}

/** A failed link that was reused from earlier: drop it and look for sources again. */
export function useDeadLinkRecovery(session: Session | null) {
  useEffect(() => {
    if (!session) return;
    return onPlayerEvent((e) => {
      if (e.name !== 'end-file' || e.reason !== 'error') return;
      const reused = session.streams.length <= 1 && Date.now() - session.startedAt < 60000;
      if (reused) {
        forgetLink(session.target.videoId);
        toast.info('That link has expired. Finding a fresh source…');
        void play({ ...session.target, startAt: getPlayerState().timePos || session.target.startAt }, { meta: session.meta });
      }
    });
  }, [session]);
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
  if (!session || session.target.type !== 'series' || !session.meta || session.target.season === undefined) return null;
  const eps = episodesOf(session.meta);
  return nextEpisode(eps, { season: session.target.season, episode: session.target.episode ?? 0 }, new Set(), Date.now());
}
