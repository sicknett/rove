// The page's side of the bridge to ROVE's shell. In a plain browser (vite dev without the
// shell) everything here is a quiet no-op, so the interface can still be worked on.

type Outbound =
  | { t: 'command'; args: string[] }
  | { t: 'set'; name: string; value: string | number | boolean }
  | { t: 'window'; action: 'minimize' | 'toggle-maximize' | 'close' | 'drag' | 'resize-n' | 'resize-ne' | 'resize-nw' }
  | { t: 'fullscreen'; value?: boolean }
  | { t: 'pip'; value: boolean }
  | { t: 'video'; visible: boolean }
  | { t: 'ready' }
  | { t: 'open-external'; url: string }
  | { t: 'open-external-player'; url: string; player: string }
  | { t: 'log'; message: string }
  | { t: 'close-ready' }
  | { t: 'now-playing'; state: 'playing' | 'paused' | 'stopped'; title?: string; subtitle?: string; artwork?: string; canNext?: boolean }
  | { t: 'open-folder'; which: 'logs' | 'screenshots' | 'data' };

export type Inbound =
  | { t: 'props'; v: Record<string, unknown> }
  | { t: 'event'; name: 'start-file' | 'file-loaded' | 'seek' | 'playback-restart' | 'end-file'; reason?: string; error?: string }
  | { t: 'window'; maximized: boolean; fullscreen: boolean; pip?: boolean }
  | { t: 'closing' }
  | { t: 'media-key'; key: 'play' | 'pause' | 'next' | 'previous' | 'stop' }
  | { t: 'open'; url: string; title?: string };

interface RoveBridge {
  platform: string;
  send(message: Outbound): void;
  subscribe(fn: (message: Inbound) => void): () => void;
}

declare global {
  interface Window {
    rove?: RoveBridge;
  }
}

export const inShell = typeof window !== 'undefined' && !!window.rove;

export function send(message: Outbound) {
  window.rove?.send(message);
}

// The shell delivers to a single handler; it fans out here to every listener in the page.
const listeners = new Set<(message: Inbound) => void>();
let attached = false;

export function subscribe(fn: (message: Inbound) => void): () => void {
  listeners.add(fn);
  if (!attached && window.rove) {
    attached = true;
    window.rove.subscribe((m) => {
      for (const l of [...listeners]) {
        try {
          l(m);
        } catch (e) {
          console.error('bridge listener failed', e);
        }
      }
    });
  }
  return () => {
    listeners.delete(fn);
  };
}

export const mpv = {
  command: (...args: (string | number)[]) => send({ t: 'command', args: args.map(String) }),
  set: (name: string, value: string | number | boolean) => send({ t: 'set', name, value }),
};

export const appWindow = {
  minimize: () => send({ t: 'window', action: 'minimize' }),
  toggleMaximize: () => send({ t: 'window', action: 'toggle-maximize' }),
  close: () => send({ t: 'window', action: 'close' }),
  drag: () => send({ t: 'window', action: 'drag' }),
  resize: (edge: 'n' | 'ne' | 'nw') => send({ t: 'window', action: `resize-${edge}` }),
  fullscreen: (value?: boolean) => send({ t: 'fullscreen', value }),
};
