// Starting playback: resume position, reusing a recent link, finding sources, auto-picking one,
// or handing the choice to the source picker; then loading it into mpv.

import { create } from 'zustand';
import { fetchStreams, streamAddonCount } from '../addons/client';
import { useAddons } from '../addons/store';
import { watchKey } from '../addons/ids';
import type { Meta, SourcedStream } from '../addons/types';
import { mpv, appWindow } from '../bridge';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from '../state/profiles';
import { settingsNow } from '../state/settings';
import { useHistory, type MediaType } from '../state/history';
import { autoPick, isPlayable, orderStreams } from '../sources/select';
import { patchPlayerState } from './store';
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
}

interface LastLink {
  url: string;
  bingeGroup?: string;
  name?: string;
  addonId: string;
  addonName: string;
  headers?: Record<string, string>;
  at: number;
}

interface LinksDoc {
  byVideo: Record<string, LastLink>;
  bingeByTitle: Record<string, string>;
}

interface PlaybackState {
  session: Session | null;
  picker: PickerState | null;
  resumePrompt: ResumePrompt | null;
  /** Shown over the player while sources load for a title with no picker open. */
  finding: PlayTarget | null;
}

export const usePlayback = create<PlaybackState>(() => ({ session: null, picker: null, resumePrompt: null, finding: null }));

let links: LinksDoc = { byVideo: {}, bingeByTitle: {} };
let linksWriter = debouncedWriter((v) => docs.write(profileDoc('links'), v), 1000);
let sessionSeq = 1;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ROVE/0.1 libmpv';
let findAbort: AbortController | null = null;

export async function loadLinks() {
  linksWriter.flush();
  const name = profileDoc('links');
  linksWriter = debouncedWriter((v) => docs.write(name, v), 1000);
  const doc = await docs.read<LinksDoc>(name).catch(() => null);
  links = { byVideo: doc?.byVideo ?? {}, bingeByTitle: doc?.bingeByTitle ?? {} };
}

function rememberLink(target: PlayTarget, stream: SourcedStream) {
  if (!stream.url) return;
  links.byVideo[target.videoId] = {
    url: stream.url,
    bingeGroup: stream.behaviorHints?.bingeGroup,
    name: stream.name,
    addonId: stream.addonId,
    addonName: stream.addonName,
    headers: stream.behaviorHints?.proxyHeaders?.request,
    at: Date.now(),
  };
  if (stream.behaviorHints?.bingeGroup) links.bingeByTitle[target.metaId] = stream.behaviorHints.bingeGroup;
  // Keep the file small: the newest 300 links.
  const entries = Object.entries(links.byVideo).sort((a, b) => b[1].at - a[1].at);
  if (entries.length > 300) links.byVideo = Object.fromEntries(entries.slice(0, 300));
  linksWriter.save(links);
}

export function forgetLink(videoId: string) {
  delete links.byVideo[videoId];
  linksWriter.save(links);
}

export function bingeGroupFor(metaId: string): string | undefined {
  return links.bingeByTitle[metaId];
}

function recentLink(videoId: string): LastLink | null {
  const l = links.byVideo[videoId];
  const hours = settingsNow().sources.reuseLinkHours;
  if (!l || hours <= 0) return null;
  return Date.now() - l.at < hours * 3600 * 1000 ? l : null;
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

/** Loads a stream into mpv and makes it the current session. */
export function startStream(target: PlayTarget, stream: SourcedStream, startAt: number, meta?: Meta | null, all: SourcedStream[] = [], unattended = 0) {
  if (!stream.url) return;
  findAbort?.abort();
  const headers = stream.behaviorHints?.proxyHeaders?.request;
  const ua = headers && Object.entries(headers).find(([k]) => /^user-agent$/i.test(k))?.[1];
  const referer = headers && Object.entries(headers).find(([k]) => /^referer$/i.test(k))?.[1];
  mpv.set('http-header-fields', headerFields(headers));
  // mpv's own identity unless the addon asks for another; an empty one gets refused by some hosts.
  mpv.set('user-agent', ua ?? DEFAULT_USER_AGENT);
  mpv.set('referrer', referer ?? '');
  const title = target.type === 'series' && target.season !== undefined ? `${target.name} · S${target.season} E${target.episode}${target.episodeTitle ? ` · ${target.episodeTitle}` : ''}` : target.name;
  mpv.set('force-media-title', title);
  mpv.set('pause', false);
  patchPlayerState({ error: null, loading: true, timePos: startAt, duration: 0, cacheTime: 0, eof: false });
  const args: (string | number)[] = ['loadfile', stream.url, 'replace'];
  if (target.startPercent && target.startPercent > 0.5) args.push(-1, `start=${target.startPercent.toFixed(2)}%`);
  else if (startAt > 1) args.push(-1, `start=${startAt.toFixed(1)}`);
  mpv.command(...args);
  rememberLink(target, stream);
  usePlayback.setState({
    session: { id: sessionSeq++, target, stream, meta, streams: all.length ? all : [stream], startedAt: Date.now(), unattendedCount: unattended },
    picker: null,
    finding: null,
    resumePrompt: null,
  });
  useHistory.getState().rememberCard(target.metaId, target.type, { name: target.name, poster: target.poster, background: target.background, logo: target.logo });
}

export interface PlayOptions {
  meta?: Meta | null;
  /** Always show the source list instead of auto-playing. */
  choose?: boolean;
  /** Continue a binge: count toward "are you still watching". */
  unattended?: number;
  /** Ignore any saved position. */
  fromStart?: boolean;
}

/** The entry point for every Play button. */
export async function play(target: PlayTarget, opts: PlayOptions = {}) {
  const s = settingsNow();
  // Where to start.
  let startAt = opts.fromStart ? 0 : target.startAt ?? 0;
  if (target.startAt === undefined && !opts.fromStart) {
    const saved = savedPosition(target);
    if (saved) {
      if (s.playback.resume === 'ask') {
        usePlayback.setState({ resumePrompt: { target, meta: opts.meta, ...saved } });
        return;
      }
      if (s.playback.resume === 'resume') {
        startAt = saved.positionS;
        if (saved.percent) target = { ...target, startPercent: saved.percent };
      }
    }
  }
  usePlayback.setState({ resumePrompt: null });

  // A link that worked recently starts at once (debrid links last hours).
  const recent = !opts.choose ? recentLink(target.videoId) : null;
  if (recent) {
    startStream(target, { url: recent.url, name: recent.name, addonId: recent.addonId, addonName: recent.addonName, rank: 0, behaviorHints: { bingeGroup: recent.bingeGroup, proxyHeaders: recent.headers ? { request: recent.headers } : undefined } }, startAt, opts.meta, [], opts.unattended);
    // Load the full list in the background for switching.
    void findSources(target, startAt, opts, true);
    return;
  }
  await findSources(target, startAt, opts, false);
}

async function findSources(target: PlayTarget, startAt: number, opts: PlayOptions, background: boolean) {
  const s = settingsNow();
  findAbort?.abort();
  const abort = new AbortController();
  findAbort = abort;
  const type = target.type === 'movie' ? 'movie' : 'series';
  // The user's own media servers come first, then addons in the user's order.
  const order = [...serversFor(target.videoId).map((sv) => `server:${sv.id}`), ...useAddons.getState().addons.map((a) => a.manifest.id)];
  const total = streamAddonCount(type, target.videoId);
  const binge = bingeGroupFor(target.metaId);
  let found: SourcedStream[] = [];
  let decided = background || opts.choose;
  const errors: string[] = [];

  if (!background) {
    if (opts.choose || s.sources.autoPlay === 'off') {
      usePlayback.setState({ picker: { target, meta: opts.meta, streams: [], pending: total, errors: [], startAt }, finding: null });
      decided = true;
    } else {
      usePlayback.setState({ finding: target, picker: null });
    }
  }

  if (total === 0) {
    if (!background) {
      usePlayback.setState({ finding: null, picker: { target, meta: opts.meta, streams: [], pending: 0, errors: [], startAt, noAddon: true } });
    }
    return;
  }

  let answered = 0;
  const tryDecide = (final: boolean) => {
    if (decided || abort.signal.aborted) return;
    const ordered = orderStreams(found, order);
    // With a binge group to follow, wait for it a little, then settle for the rule.
    const pick = autoPick(ordered, { mode: s.sources.autoPlay, regex: s.sources.regex, bingeGroup: binge, preferBingeGroup: s.sources.preferBingeGroup });
    const groupMatch = pick && binge && pick.behaviorHints?.bingeGroup === binge;
    // Wait for the first addon in order to answer before taking a later addon's top pick.
    const firstAddonDone = answered >= total || found.some((x) => x.addonId === order.find((id) => found.some((f) => f.addonId === id)));
    if (pick && (groupMatch || final || (firstAddonDone && answered >= 1 && pick.addonId === ordered.find(isPlayable)?.addonId && answered === total))) {
      decided = true;
      startStream(target, pick, startAt, opts.meta, ordered, opts.unattended);
      return;
    }
    if (final) {
      decided = true;
      usePlayback.setState({ finding: null, picker: { target, meta: opts.meta, streams: ordered, pending: 0, errors, startAt } });
    }
  };

  await fetchStreams(
    type,
    target.videoId,
    (addon, streams, error) => {
      if (abort.signal.aborted) return;
      answered++;
      if (streams) found = [...found, ...streams];
      else if (error) errors.push(`${addon.manifest.name} did not answer.`);
      const ordered = orderStreams(found, order);
      const st = usePlayback.getState();
      if (st.picker && st.picker.target.videoId === target.videoId) {
        usePlayback.setState({ picker: { ...st.picker, streams: ordered, pending: total - answered, errors: [...errors] } });
      }
      if (st.session && st.session.target.videoId === target.videoId) {
        usePlayback.setState({ session: { ...st.session, streams: ordered.length ? ordered : st.session.streams } });
      }
      tryDecide(answered >= total);
    },
    abort.signal,
  );
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

let positionReader: () => number = () => 0;
export function setPositionReader(fn: () => number) {
  positionReader = fn;
}
export function currentPosition() {
  return positionReader();
}

export function openSwitcher() {
  const sess = usePlayback.getState().session;
  if (!sess) return;
  usePlayback.setState({ picker: { target: sess.target, meta: sess.meta, streams: sess.streams, pending: 0, errors: [], startAt: currentPosition(), switching: true } });
  if (sess.streams.length <= 1) void findSources(sess.target, currentPosition(), { meta: sess.meta, choose: true }, true);
}

export function closePicker() {
  const st = usePlayback.getState();
  findAbort?.abort();
  usePlayback.setState({ picker: null, finding: null });
  if (!st.session) appWindow.fullscreen(false);
}

export function cancelFinding() {
  findAbort?.abort();
  usePlayback.setState({ finding: null });
}

export function resumeChoice(fromStart: boolean) {
  const p = usePlayback.getState().resumePrompt;
  if (!p) return;
  usePlayback.setState({ resumePrompt: null });
  void play({ ...p.target, startAt: fromStart ? 0 : p.positionS }, { meta: p.meta });
}

export function stopPlayback() {
  findAbort?.abort();
  mpv.command('stop');
  usePlayback.setState({ session: null, picker: null, finding: null });
  appWindow.fullscreen(false);
}

export function flushLinks() {
  return linksWriter.flush();
}
