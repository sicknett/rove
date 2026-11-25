// Player state, filled from mpv's property changes. Components read slices of it with
// usePlayer(selector), so the 30 Hz position updates only re-render what shows the position.

import { useSyncExternalStore } from 'react';
import { subscribe as subscribeBridge, type Inbound } from '../bridge';

export interface Track {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  codec?: string;
  selected?: boolean;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
  'demux-channel-count'?: number;
  'audio-channels'?: number;
  'demux-w'?: number;
  'demux-h'?: number;
}

export interface Chapter {
  title?: string;
  time: number;
}

export interface PlayerState {
  /** A file is open (loading or playing). */
  active: boolean;
  loading: boolean;
  pause: boolean;
  timePos: number;
  /** performance.now() when timePos arrived, for smooth interpolation. */
  timeStamp: number;
  duration: number;
  pausedForCache: boolean;
  cacheBuffering: number;
  cacheTime: number;
  seeking: boolean;
  idle: boolean;
  eof: boolean;
  tracks: Track[];
  aid: number | null;
  sid: number | null;
  volume: number;
  mute: boolean;
  title: string;
  audioDelay: number;
  subDelay: number;
  speed: number;
  audioOutput: string;
  hwdec: string;
  videoParams: Record<string, unknown> | null;
  chapters: Chapter[];
  error: string | null;
  window: { maximized: boolean; fullscreen: boolean };
  /** The last audio track that actually played, so a lost output can be told apart from "off". */
  lastAudioTrack: number | null;
  /** The picture mode chosen in the Picture menu (mpv has no single property for it). */
  aspect: string;
}

/** A playback event; `stale` when it belongs to the file before the one now being loaded. */
export type PlayerEvent = Extract<Inbound, { t: 'event' }> & { stale?: boolean };

const initial: PlayerState = {
  active: false,
  loading: false,
  pause: false,
  timePos: 0,
  timeStamp: 0,
  duration: 0,
  pausedForCache: false,
  cacheBuffering: 100,
  cacheTime: 0,
  seeking: false,
  idle: true,
  eof: false,
  tracks: [],
  aid: null,
  sid: null,
  volume: 100,
  mute: false,
  title: '',
  audioDelay: 0,
  subDelay: 0,
  speed: 1,
  audioOutput: '',
  hwdec: '',
  videoParams: null,
  chapters: [],
  error: null,
  window: { maximized: false, fullscreen: false },
  lastAudioTrack: null,
  aspect: 'fit',
};

let state: PlayerState = initial;
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: PlayerEvent) => void>();
const openListeners = new Set<(e: Extract<Inbound, { t: 'open' }>) => void>();

/** The shell asking to open a stream (started with --play). */
export function onOpenRequest(fn: (e: Extract<Inbound, { t: 'open' }>) => void) {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

function setState(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getPlayerState() {
  return state;
}

export function patchPlayerState(patch: Partial<PlayerState>) {
  setState(patch);
}

// Where the video is, kept apart from `timePos`. mpv reports no position (read here as 0) while a
// file loads, after it fails and once it is unloaded, and those are the moments a resume point,
// Retry or a source switch need the real one. So this only follows positions of a file that has
// started playing, and otherwise holds where the load was asked to start.
let known = { pos: 0, dur: 0 };
let intended = 0;
/** The file has shown its first frame at the requested start. */
let settled = false;
/** A load was asked for and mpv has not begun it: events until then are the previous file's. */
let awaitingStart = false;

/** The last certain position and length of the current video; `dur` is 0 until it has played. */
export function knownPosition(): { pos: number; dur: number } {
  return known;
}

/** Call right before `loadfile`, with where the new file should start. */
export function expectLoad(startAt: number) {
  intended = startAt;
  known = { pos: startAt, dur: 0 };
  settled = false;
  awaitingStart = true;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const trackId = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);

function applyProps(v: Record<string, unknown>) {
  const patch: Partial<PlayerState> = {};
  for (const [key, value] of Object.entries(v)) {
    switch (key) {
      case 'pause': patch.pause = value === true; break;
      case 'time-pos': patch.timePos = num(value); patch.timeStamp = performance.now(); break;
      case 'duration': patch.duration = num(value); break;
      case 'paused-for-cache': patch.pausedForCache = value === true; break;
      case 'cache-buffering-state': patch.cacheBuffering = num(value, 100); break;
      case 'demuxer-cache-time': patch.cacheTime = num(value); break;
      case 'seeking': patch.seeking = value === true; break;
      case 'idle-active': patch.idle = value === true; break;
      case 'eof-reached': patch.eof = value === true; break;
      case 'track-list': patch.tracks = Array.isArray(value) ? (value as Track[]) : []; break;
      case 'aid': patch.aid = trackId(value); break;
      case 'sid': patch.sid = trackId(value); break;
      case 'volume': patch.volume = num(value, 100); break;
      case 'mute': patch.mute = value === true; break;
      case 'media-title': patch.title = typeof value === 'string' ? value : ''; break;
      case 'audio-delay': patch.audioDelay = num(value); break;
      case 'sub-delay': patch.subDelay = num(value); break;
      case 'speed': patch.speed = num(value, 1); break;
      case 'current-ao': patch.audioOutput = typeof value === 'string' ? value : ''; break;
      case 'hwdec-current': patch.hwdec = typeof value === 'string' ? value : ''; break;
      case 'video-params': patch.videoParams = value && typeof value === 'object' ? (value as Record<string, unknown>) : null; break;
      case 'chapter-list': patch.chapters = Array.isArray(value) ? (value as Chapter[]) : []; break;
    }
  }
  const aid = patch.aid !== undefined ? patch.aid : state.aid;
  const output = patch.audioOutput !== undefined ? patch.audioOutput : state.audioOutput;
  if (aid && output) patch.lastAudioTrack = aid;
  setState(patch);
  if (settled && typeof v['time-pos'] === 'number' && state.duration > 0) known = { pos: state.timePos, dur: state.duration };
}

export function startListening() {
  return subscribeBridge((message) => {
    if (message.t === 'props') applyProps(message.v);
    else if (message.t === 'open') openListeners.forEach((l) => l(message));
    else if (message.t === 'window') setState({ window: { maximized: message.maximized, fullscreen: message.fullscreen } });
    else if (message.t === 'event') {
      // Events carry no file id. mpv sends them in order, so everything between asking for a load
      // and its `start-file` is the old file winding down, and must not touch the new one.
      const stale = awaitingStart && message.name !== 'start-file';
      if (message.name === 'start-file') {
        awaitingStart = false;
        settled = false;
        known = { pos: intended, dur: 0 };
        setState({ loading: true, error: null, eof: false, lastAudioTrack: null });
      }
      if (!stale) {
        if (message.name === 'playback-restart') settled = true;
        if (message.name === 'playback-restart' || message.name === 'file-loaded') setState({ loading: false });
        if (message.name === 'end-file' && message.reason === 'error') setState({ loading: false, error: message.error ?? 'This stream could not be played.' });
      }
      const event: PlayerEvent = stale ? { ...message, stale: true } : message;
      eventListeners.forEach((l) => l(event));
    }
  });
}

export function onPlayerEvent(fn: (e: PlayerEvent) => void) {
  eventListeners.add(fn);
  return () => {
    eventListeners.delete(fn);
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePlayer<T>(select: (s: PlayerState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
