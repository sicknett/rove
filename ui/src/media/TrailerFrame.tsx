// A title's trailer as a silent picture layer: the Home banner's, and the one in a poster's hover
// preview. Whoever shows it gives the frame its class (size and place) and draws its own controls.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const SOUND_KEY = 'rove.trailerSound';
const VOLUME_KEY = 'rove.trailerVolume';
/** YouTube draws its own buttons over the picture while a video starts; the trailer stays hidden until they are gone. */
const REVEAL_AFTER_PLAYING_MS = 3200;
/** A trailer that has not started by now is given up on. */
const GIVE_UP_MS = 14000;
/** Out of 100. Trailers are mastered loud, and this is background sound on a menu. */
const DEFAULT_VOLUME = 12;

function trailerVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function trailerSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

// Two trailers never play at once. One shown with `solo` (a hover preview, which the pointer is
// on) has the stage while it is there; the banner asks here and waits as if it were out of sight.
let solos = 0;
const soloListeners = new Set<() => void>();
const onSolo = (fn: () => void) => (soloListeners.add(fn), () => void soloListeners.delete(fn));
const anySolo = () => solos > 0;
function setSolo(on: boolean) {
  solos += on ? 1 : -1;
  soloListeners.forEach((fn) => fn());
}

/** A trailer shown with `solo` is on screen: any other should wait (pass it `paused`). */
export function useSoloTrailer(): boolean {
  return useSyncExternalStore(onSolo, anySolo);
}

/** What a trailer's controls are drawn from (see `controls`). */
export interface TrailerSound {
  /** Sound is on. Off by default; the choice is remembered. */
  sound: boolean;
  /** 1..100, remembered. */
  volume: number;
  toggleSound: () => void;
  changeVolume: (v: number) => void;
}

interface Props {
  /** The YouTube video. */
  id: string;
  /** The title's name, for the frame's label. */
  name: string;
  /** Scrolled away or behind another screen: the video waits, and carries on when it is back. */
  paused: boolean;
  /** The frame's class. It is given `is-visible` once the picture shows, and `is-paused` while it waits. */
  className: string;
  /** This one has the stage: `useSoloTrailer` is true for the others while it is there. */
  solo?: boolean;
  /** The picture is on screen (not just loading). */
  onShown?: () => void;
  /** The trailer played to its end, or never started. */
  onEnded: () => void;
  /** Sound controls, drawn beside the frame while the picture shows. */
  controls?: (sound: TrailerSound) => React.ReactNode;
}

/**
 * A trailer with nothing of YouTube's own interface showing: no playlist (so no previous/next),
 * no controls, and the frame is only faded in once the video is really playing. The page talks
 * to the player through YouTube's frame messages (sound on and off, "it ended").
 */
export function TrailerFrame({ id, name, paused, className, solo = false, onShown, onEnded, controls }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [sound, setSound] = useState(trailerSound);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const [volume, setVolume] = useState(trailerVolume);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const shown = useRef(onShown);
  shown.current = onShown;
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    if (!solo) return;
    setSolo(true);
    return () => setSolo(false);
  }, [solo]);

  const command = (func: string, args: unknown[] = []) => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);

  useEffect(() => {
    let reveal: number | undefined;
    // No picture after a good while (blocked, removed, offline): whoever shows it carries on without.
    const giveUp = window.setTimeout(() => reveal === undefined && ended.current(), GIVE_UP_MS);
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
          command('setVolume', [volumeRef.current]);
          command('unMute');
        }
        reveal = window.setTimeout(() => {
          setVisible(true);
          shown.current?.();
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
    if (next) command('setVolume', [volume]);
    command(next ? 'unMute' : 'mute');
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      /* remembered for this run only */
    }
    command('setVolume', [v]);
    // Moving the slider is asking for sound.
    if (!sound && v > 0) {
      setSound(true);
      try {
        localStorage.setItem(SOUND_KEY, '1');
      } catch {
        /* as above */
      }
      command('unMute');
    }
  };

  // Out of sight the video waits, and carries on when it is back.
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      if (!paused) return;
    }
    command(paused ? 'pauseVideo' : 'playVideo');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  return (
    <>
      <iframe
        ref={frame}
        className={`${className} ${visible ? 'is-visible' : ''} ${paused ? 'is-paused' : ''}`}
        title={`${name} trailer`}
        src={`${YT_ORIGIN}/embed/${id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
        allow="autoplay; encrypted-media"
        tabIndex={-1}
        // The player only reports its state to a page that has said it is listening.
        onLoad={() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN)}
      />
      {visible && !paused && controls?.({ sound, volume, toggleSound, changeVolume })}
    </>
  );
}
