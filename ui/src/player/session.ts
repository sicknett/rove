// Starting playback: resume position, reusing a recent link, finding sources, auto-picking one,
// or handing the choice to the source picker; then loading it into mpv.

import { create } from 'zustand';
import { addonsFor, fetchStreams, resourceUrl, streamAddonCount } from '../addons/client';
import { useAddons } from '../addons/store';
import { watchKey } from '../addons/ids';
import type { Meta, SourcedStream } from '../addons/types';
import { mpv, appWindow } from '../bridge';
import { invalidate } from '../lib/http';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from '../state/profiles';
import { settingsNow } from '../state/settings';
import { useHistory, type MediaType } from '../state/history';
import { decide, orderStreams } from '../sources/select';
import { expectLoad, getPlayerState, knownPosition, patchPlayerState } from './store';
import { serversFor } from '../servers';

export interface PlayTarget {
  type: MediaType;
  metaId: string;
  /** The id streams are requested with: the movie id, or the episode's video id. */
  videoId: string;
  season?: number;
  episode?: number;
  name: string;
  episodeTitle?: string;
  poster?: string;
  background?: string;
  logo?: string;
  still?: string;
  tmdbId?: number;
  /** Seconds. Leave out to follow the resume setting. */
  startAt?: number;
  /** Start at this share of the video (0–100) instead, when only a percentage is known. */
  startPercent?: number;
}

export interface Session {
  id: number;
  target: PlayTarget;
  stream: SourcedStream;
  meta?: Meta | null;
  /** Every source found for this video, for switching mid-play. */
  streams: SourcedStream[];
  startedAt: number;
  /** Episodes played in a row without the user touching anything. */
  unattendedCount: number;
  /** Started from a link remembered earlier, which may have expired since. */
  reused?: boolean;
}

export interface PickerState {
  target: PlayTarget;
  meta?: Meta | null;
  streams: SourcedStream[];
  pending: number;
  errors: string[];
  /** Start position chosen before the picker opened. */
  startAt: number;
  /** Opened from inside the player to switch sources. */
  switching?: boolean;
  /** No installed addon offers streams for this title at all. */
  noAddon?: boolean;
}

export interface ResumePrompt {
  target: PlayTarget;
  meta?: Meta | null;
  positionS: number;
  durationS: number;
  /** Set when the tracker gave only a share of the video: the times above are guesses. */
  percent?: number;
  /** How playback was asked for (source list, binge count), to carry on with after the answer. */
  opts?: PlayOptions;
}

interface LastLink {
  /** The whole stream, so a reused link keeps its file name, size and media-server ids. */
  stream?: SourcedStream;
  at: number;
  // Links remembered before the whole stream was kept.
  url?: string;
  bingeGroup?: string;
  name?: string;
  addonId?: string;
  addonName?: string;
  headers?: Record<string, string>;
}

interface LinksDoc {
  byVideo: Record<string, LastLink>;
  bingeByTitle: Record<string, string>;
}

interface PlaybackState {
  session: Session | null;
  picker: PickerState | null;
  resumePrompt: ResumePrompt | null;
  /** Sources are loading for this title with no picker open. Full-screen while nothing plays; a card in the player otherwise. */
  finding: PlayTarget | null;
}

export const usePlayback = create<PlaybackState>(() => ({ session: null, picker: null, resumePrompt: null, finding: null }));

let links: LinksDoc = { byVideo: {}, bingeByTitle: {} };
let linksWriter = debouncedWriter((v) => docs.write(profileDoc('links'), v), 1000);
let sessionSeq = 1;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ROVE/0.1 libmpv';
/** How long a slower addon may still change the pick after the first one has answered, unless the setting says. */
const DECIDE_GRACE_SEC = 4;
/** Past this age the switcher asks the addons again: links in an old list may have expired. */
const SOURCES_FRESH_MS = 20 * 60 * 1000;

/** The addons being asked for one video's sources. */
interface Search {
  videoId: string;
  abort: AbortController;
  total: number;
  answered: number;
  /** Nothing is waiting on this search to choose a stream any more; its answers still fill the list. */
  decided: boolean;
  timer: number | undefined;
  /** Lets go of whoever awaits the choice. */
  release: () => void;
}
let search: Search | null = null;
/** When a video's sources were last asked for. */
let listed: { videoId: string; at: number } | null = null;

function settleSearch(s: Search) {
  s.decided = true;
  window.clearTimeout(s.timer);
  s.release();
}

function cancelSearch() {
  if (!search) return;
  search.abort.abort();
  settleSearch(search);
  search = null;
}

export async function loadLinks() {
  linksWriter.flush();
  const name = profileDoc('links');
  linksWriter = debouncedWriter((v) => docs.write(name, v), 1000);
  const doc = await docs.read<LinksDoc>(name).catch(() => null);
  links = { byVideo: doc?.byVideo ?? {}, bingeByTitle: doc?.bingeByTitle ?? {} };
}

function linkStream(l: LastLink): SourcedStream | null {
  if (l.stream?.url) return l.stream;
  if (!l.url) return null;
  return { url: l.url, name: l.name, addonId: l.addonId ?? 'link', addonName: l.addonName ?? '', rank: 0, behaviorHints: { bingeGroup: l.bingeGroup, proxyHeaders: l.headers ? { request: l.headers } : undefined } };
}

function rememberLink(target: PlayTarget, stream: SourcedStream) {
  if (!stream.url) return;
  links.byVideo[target.videoId] = { stream, at: Date.now() };
  if (stream.behaviorHints?.bingeGroup) links.bingeByTitle[target.metaId] = stream.behaviorHints.bingeGroup;
  // Keep the file small: the newest 300 links.
  const entries = Object.entries(links.byVideo).sort((a, b) => b[1].at - a[1].at);
  if (entries.length > 300) links.byVideo = Object.fromEntries(entries.slice(0, 300));
  linksWriter.save(links);
}

/** Forgets the remembered link of a video; with `url`, only if that is the link remembered. */
export function forgetLink(videoId: string, url?: string) {
  const l = links.byVideo[videoId];
  if (!l || (url && linkStream(l)?.url !== url)) return;
  delete links.byVideo[videoId];
  linksWriter.save(links);
}

export function bingeGroupFor(metaId: string): string | undefined {
  return links.bingeByTitle[metaId];
}

function recentLink(videoId: string): SourcedStream | null {
  const l = links.byVideo[videoId];
  const hours = settingsNow().sources.reuseLinkHours;
  if (!l || hours <= 0) return null;
  return Date.now() - l.at < hours * 3600 * 1000 ? linkStream(l) : null;
}

/** Drops the addons' cached answers for a video, so the next search really asks again. */
function forgetAnswers(target: PlayTarget) {
  const type = target.type === 'movie' ? 'movie' : 'series';
  for (const addon of addonsFor('stream', type, target.videoId)) invalidate(resourceUrl(addon, 'stream', type, target.videoId));
}

function savedPosition(target: PlayTarget): { positionS: number; durationS: number; percent?: number } | null {
  const p = useHistory.getState().progress[watchKey(target.metaId, target.season, target.episode)];
  if (!p || !(p.durationS > 0)) return null;
  const share = p.positionS / p.durationS;
  if (p.estimated) return share > 0.01 && share < 0.97 ? { positionS: p.positionS, durationS: p.durationS, percent: share * 100 } : null;
  // Within the last minute: start over.
  if (p.durationS - p.positionS < 60) return null;
  return { positionS: p.positionS, durationS: p.durationS };
}

function headerFields(headers?: Record<string, string>): string {
  if (!headers) return '';
  return Object.entries(headers)
    .filter(([k]) => !/^(user-agent|referer)$/i.test(k))
    .map(([k, v]) => `${k}: ${v.replace(/,/g, '\\,')}`)
    .join(',');
}

// The last save and a media server's stop report read the position of the video being left, so
// they have to run before the player state is reset for the next load. The player registers them
// here; every way out of a video (another stream, stop, the window closing) calls leaveVideo first.
let leaving: (() => Promise<void> | void) | null = null;

/** Registers what must happen when the current video is left. Returns a function that withdraws it. */
export function onLeaveVideo(fn: () => Promise<void> | void): () => void {
  leaving = fn;
  return () => {
    if (leaving === fn) leaving = null;
  };
}

/** Runs the registered leave step once. The promise settles when its network part (if any) is done. */
export function leaveVideo(): Promise<void> {
  const fn = leaving;
  leaving = null;
  try {
    return Promise.resolve(fn?.()).catch(() => undefined);
  } catch (e) {
    // The next stream must still start when the last save of the old one fails.
    console.error('leaving the video failed', e);
    return Promise.resolve();
  }
}

/** Loads a stream into mpv and makes it the current session. */
export function startStream(target: PlayTarget, stream: SourcedStream, startAt: number, meta?: Meta | null, all: SourcedStream[] = [], unattended = 0, reused = false) {
  if (!stream.url) return;
  const previous = usePlayback.getState().session;
  void leaveVideo();
  // A stream is starting, so no search has a choice left to make. One for this same video keeps
  // running: the addons still answering fill the switcher's list.
  if (search) {
    if (search.videoId === target.videoId) settleSearch(search);
    else cancelSearch();
  }
  const headers = stream.behaviorHints?.proxyHeaders?.request;
  const ua = headers && Object.entries(headers).find(([k]) => /^user-agent$/i.test(k))?.[1];
  const referer = headers && Object.entries(headers).find(([k]) => /^referer$/i.test(k))?.[1];
  mpv.set('http-header-fields', headerFields(headers));
  // mpv's own identity unless the addon asks for another; an empty one gets refused by some hosts.
  mpv.set('user-agent', ua ?? DEFAULT_USER_AGENT);
  mpv.set('referrer', referer ?? '');
  const title = target.type === 'series' && target.season !== undefined ? `${target.name} · S${target.season} E${target.episode}${target.episodeTitle ? ` · ${target.episodeTitle}` : ''}` : target.name;
  mpv.set('force-media-title', title);
  // mpv keeps these across files; they were chosen for the video before, not this one. Another
  // source of the same video keeps them.
  const newVideo = previous?.target.videoId !== target.videoId;
  if (newVideo) {
    mpv.set('video-aspect-override', 'no');
    mpv.set('panscan', 0);
    mpv.set('video-zoom', 0);
    mpv.set('sub-delay', 0);
    mpv.set('speed', 1);
  }
  mpv.set('pause', false);
  expectLoad(startAt);
  patchPlayerState({ error: null, loading: true, timePos: startAt, duration: 0, cacheTime: 0, eof: false, ...(newVideo ? { aspect: 'fit' } : null) });
  const args: (string | number)[] = ['loadfile', stream.url, 'replace'];
  if (target.startPercent && target.startPercent > 0.5) args.push(-1, `start=${target.startPercent.toFixed(2)}%`);
  else if (startAt > 1) args.push(-1, `start=${startAt.toFixed(1)}`);
  mpv.command(...args);
  usePlayback.setState({
    session: { id: sessionSeq++, target, stream, meta, streams: all.length ? all : [stream], startedAt: Date.now(), unattendedCount: unattended, reused },
    picker: null,
    finding: null,
    resumePrompt: null,
  });
  useHistory.getState().rememberCard(target.metaId, target.type, { name: target.name, poster: target.poster, background: target.background, logo: target.logo });
}

/**
 * The session's stream has shown its first frame. Only now is the link known to work and worth
 * reusing, and only now is the position known in seconds, so a start by percentage is over.
 */
export function streamStarted(sessionId: number) {
  const sess = usePlayback.getState().session;
  if (!sess || sess.id !== sessionId) return;
  rememberLink(sess.target, sess.stream);
  if (sess.target.startPercent !== undefined) usePlayback.setState({ session: { ...sess, target: { ...sess.target, startPercent: undefined } } });
}

export interface PlayOptions {
  meta?: Meta | null;
  /** Always show the source list instead of auto-playing. */
  choose?: boolean;
  /** Continue a binge: count toward "are you still watching". */
  unattended?: number;
  /** Ignore any saved position. */
  fromStart?: boolean;
  /** The links known so far have failed: skip the remembered link and the cached addon answers. */
  fresh?: boolean;
}

/** The entry point for every Play button. Settles once a stream starts, the picker opens or the search is cancelled. */
export async function play(target: PlayTarget, opts: PlayOptions = {}) {
  const s = settingsNow();
  // Where to start.
  let startAt = opts.fromStart ? 0 : target.startAt ?? 0;
  if (target.startAt === undefined && !opts.fromStart) {
    const saved = savedPosition(target);
    if (saved) {
      if (s.playback.resume === 'ask') {
        usePlayback.setState({ resumePrompt: { target, meta: opts.meta, opts, ...saved } });
        return;
      }
      if (s.playback.resume === 'resume') {
        startAt = saved.positionS;
        if (saved.percent) target = { ...target, startPercent: saved.percent };
      }
    }
  }
  usePlayback.setState({ resumePrompt: null });
  if (opts.fresh) forgetAnswers(target);

  // A link that worked recently starts at once (debrid links last hours).
  const recent = !opts.choose && !opts.fresh ? recentLink(target.videoId) : null;
  if (recent) {
    startStream(target, recent, startAt, opts.meta, [], opts.unattended, true);
    // Load the full list in the background for switching.
    void findSources(target, startAt, opts, true);
    return;
  }
  await findSources(target, startAt, opts, false);
}

/**
 * Asks every addon for sources. The promise settles when the choice is made (a stream starts or
 * the picker opens) or the search is cancelled; the addons that have not answered by then keep
 * going and their sources are added to the list.
 */
function findSources(target: PlayTarget, startAt: number, opts: PlayOptions, background: boolean): Promise<void> {
  const s = settingsNow();
  cancelSearch();
  const type = target.type === 'movie' ? 'movie' : 'series';
  // The user's own media servers come first, then addons in the user's order.
  const servers = serversFor(target.videoId).map((sv) => `server:${sv.id}`);
  const order = [...servers, ...useAddons.getState().addons.map((a) => a.manifest.id)];
  // Who fetchStreams will ask, to know who is still to answer.
  const waiting = [...servers, ...(target.videoId.startsWith('srv:') ? [] : addonsFor('stream', type, target.videoId).map((a) => a.manifest.id))];
  const total = streamAddonCount(type, target.videoId);
  const binge = bingeGroupFor(target.metaId);
  let found: SourcedStream[] = [];
  const errors: string[] = [];
  const asking = opts.choose || s.sources.autoPlay === 'off';

  if (!background) {
    if (asking) usePlayback.setState({ picker: { target, meta: opts.meta, streams: [], pending: total, errors: [], startAt }, finding: null });
    else usePlayback.setState({ finding: target, picker: null });
  }

  if (total === 0) {
    if (!background) {
      usePlayback.setState({ finding: null, picker: { target, meta: opts.meta, streams: [], pending: 0, errors: [], startAt, noAddon: true } });
    }
    return Promise.resolve();
  }

  let release: () => void = () => undefined;
  const chosen = new Promise<void>((resolve) => (release = resolve));
  const me: Search = { videoId: target.videoId, abort: new AbortController(), total, answered: 0, decided: background || asking, timer: undefined, release };
  search = me;
  listed = { videoId: target.videoId, at: Date.now() };
  if (me.decided) release();
  if (background) {
    const p = usePlayback.getState().picker;
    if (p && p.target.videoId === target.videoId) usePlayback.setState({ picker: { ...p, pending: total } });
  }

  let graceOver = false;
  const graceSec = s.sources.pickerTimeoutSec > 0 ? s.sources.pickerTimeoutSec : DECIDE_GRACE_SEC;
  const tryDecide = () => {
    if (me.decided || me.abort.signal.aborted) return;
    const ordered = orderStreams(found, order);
    const d = decide({ ordered, addonOrder: order, waiting, graceOver, mode: s.sources.autoPlay, regex: s.sources.regex, bingeGroup: binge, preferBingeGroup: s.sources.preferBingeGroup });
    if (d.action === 'wait') return;
    settleSearch(me);
    if (d.action === 'play') startStream(target, d.stream, startAt, opts.meta, ordered, opts.unattended);
    else usePlayback.setState({ finding: null, picker: { target, meta: opts.meta, streams: ordered, pending: waiting.length, errors: [...errors], startAt } });
  };

  void fetchStreams(
    type,
    target.videoId,
    (addon, streams, error) => {
      if (me.abort.signal.aborted) return;
      me.answered++;
      const done = me.answered >= total;
      const at = waiting.indexOf(addon.manifest.id);
      if (at >= 0) waiting.splice(at, 1);
      if (done) waiting.length = 0;
      if (streams) found = [...found, ...streams];
      else if (error) errors.push(`${addon.manifest.name} did not answer.`);
      const ordered = orderStreams(found, order);
      const st = usePlayback.getState();
      if (st.picker && st.picker.target.videoId === target.videoId) {
        // A switcher that already shows a list keeps it until the new one has caught up.
        const streams = st.picker.switching && !done && ordered.length < st.picker.streams.length ? st.picker.streams : ordered;
        usePlayback.setState({ picker: { ...st.picker, streams, pending: total - me.answered, errors: [...errors] } });
      }
      if (st.session && st.session.target.videoId === target.videoId) {
        usePlayback.setState({ session: { ...st.session, streams: ordered.length ? ordered : st.session.streams } });
      }
      // The wait for slower addons starts with the first answer.
      if (!me.decided && me.timer === undefined && !done) {
        me.timer = window.setTimeout(() => {
          graceOver = true;
          tryDecide();
        }, graceSec * 1000);
      }
      tryDecide();
    },
    me.abort.signal,
  ).finally(() => {
    if (search === me) search = null;
    // Every addon is done, whatever the count said: never leave "finding" up with nothing pending.
    waiting.length = 0;
    tryDecide();
    settleSearch(me);
  });
  return chosen;
}

/** From the picker (or the in-player switcher). */
export function chooseStream(stream: SourcedStream) {
  const p = usePlayback.getState().picker;
  const sess = usePlayback.getState().session;
  if (p) {
    // Switching mid-play keeps the position.
    const at = p.switching && sess ? currentPosition() : p.startAt;
    startStream(p.target, stream, at, p.meta, p.streams, 0);
  }
}

let positionReader: () => number = () => knownPosition().pos;
export function setPositionReader(fn: () => number) {
  positionReader = fn;
}
/** Where the current video is; survives a failed load or a dead link (see knownPosition). */
export function currentPosition() {
  return positionReader();
}

export function openSwitcher() {
  const sess = usePlayback.getState().session;
  if (!sess) return;
  const at = currentPosition();
  const running = search && search.videoId === sess.target.videoId ? search : null;
  usePlayback.setState({ picker: { target: sess.target, meta: sess.meta, streams: sess.streams, pending: running ? running.total - running.answered : 0, errors: [], startAt: at, switching: true } });
  if (running) return;
  // Links expire. Ask again when the source just failed or the list is old, and past the cache then.
  const failed = !!getPlayerState().error;
  const old = !listed || listed.videoId !== sess.target.videoId || Date.now() - listed.at > SOURCES_FRESH_MS;
  if (failed || old) forgetAnswers(sess.target);
  if (failed || old || sess.streams.length <= 1) void findSources(sess.target, at, { meta: sess.meta, choose: true }, true);
}

export function closePicker() {
  const st = usePlayback.getState();
  // A search for the video that is playing carries on: its answers belong in the switcher's list.
  if (!st.session || search?.videoId !== st.session.target.videoId) cancelSearch();
  usePlayback.setState({ picker: null, finding: null });
  if (!st.session) appWindow.fullscreen(false);
}

export function cancelFinding() {
  cancelSearch();
  usePlayback.setState({ finding: null });
}

export function resumeChoice(fromStart: boolean) {
  const p = usePlayback.getState().resumePrompt;
  if (!p) return;
  usePlayback.setState({ resumePrompt: null });
  void play({ ...p.target, startAt: fromStart ? 0 : p.positionS, startPercent: fromStart ? undefined : p.percent }, { ...p.opts, meta: p.meta });
}

export function stopPlayback() {
  void leaveVideo();
  cancelSearch();
  mpv.command('stop');
  usePlayback.setState({ session: null, picker: null, finding: null });
  appWindow.fullscreen(false);
}

export function flushLinks() {
  return linksWriter.flush();
}
