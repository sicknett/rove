// Per-profile preferences, with defaults for anything not set yet.

import { create } from 'zustand';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from './profiles';

export type AutoPlayMode = 'off' | 'first' | 'binge' | 'regex';
export type SkipMode = 'off' | 'button' | 'auto';
export type SubtitleMode = 'off' | 'forced' | 'foreign' | 'always';

/** A face every Windows PC has. The player has no fonts of its own, only the ones installed. */
export const DEFAULT_SUBTITLE_FONT = 'Segoe UI';

/**
 * The subtitle font in effect. "Inter" was the default once, but the player never had it (it is
 * this page's font, not one installed in Windows), so it means the default.
 */
export const subtitleFont = (saved: string | undefined) => (!saved || saved === 'Inter' ? DEFAULT_SUBTITLE_FONT : saved);

export interface Settings {
  appearance: {
    accent: 'sage' | 'mist' | 'sand' | 'rose' | 'sky';
    cardSize: 'small' | 'medium' | 'large';
    showRatings: boolean;
    heroEnabled: boolean;
    heroTrailers: boolean;
    /** Trailers start by themselves after a moment on a title, or only under the pointer. */
    heroTrailerStart: 'auto' | 'hover';
    /** What the banner features: the rows (starred ones first), or the user's own titles. */
    heroSource: 'auto' | 'continue' | 'watchlist';
    reduceMotion: boolean;
    /** Where the main navigation sits. */
    navPosition: 'left' | 'top';
    landscapeContinueWatching: boolean;
    /** Home rows made from what the profile watches (recs/): Top picks, Because you watched, Top 10s and the rest. One switch for all of them. */
    smartRows: boolean;
    /** Resting the pointer on a poster in a row widens it into a preview that plays the title's trailer. */
    hoverPreview: boolean;
  };
  playback: {
    autoPlayNext: boolean;
    nextCountdownSec: number;
    /** Show the next-episode card this many seconds before the end when no credits marker exists. */
    nextLeadSec: number;
    stillWatchingAfter: number;
    skipIntro: SkipMode;
    skipRecap: SkipMode;
    skipCredits: SkipMode;
    resume: 'ask' | 'resume' | 'start';
    hwdec: 'auto-safe' | 'no';
    seekStepSec: number;
    rememberVolume: boolean;
  };
  sources: {
    autoPlay: AutoPlayMode;
    regex: string;
    pickerTimeoutSec: number;
    reuseLinkHours: number;
    preferBingeGroup: boolean;
    externalPlayer: string;
  };
  languages: {
    audio: string[];
    subtitles: string[];
    subtitleMode: SubtitleMode;
    stripSdh: boolean;
  };
  subtitleStyle: {
    size: number;
    color: string;
    outlineColor: string;
    outlineSize: number;
    background: 'none' | 'shadow' | 'box';
    bold: boolean;
    marginY: number;
    font: string;
  };
  audio: {
    delayMs: number;
    passthrough: boolean;
    volumeMax: number;
    normalize: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    accent: 'sage',
    cardSize: 'medium',
    showRatings: true,
    heroEnabled: true,
    heroTrailers: true,
    heroTrailerStart: 'auto',
    heroSource: 'auto',
    reduceMotion: false,
    navPosition: 'left',
    landscapeContinueWatching: true,
    smartRows: true,
    hoverPreview: true,
  },
  playback: {
    autoPlayNext: true,
    nextCountdownSec: 10,
    nextLeadSec: 35,
    stillWatchingAfter: 3,
    skipIntro: 'button',
    skipRecap: 'button',
    skipCredits: 'button',
    resume: 'resume',
    hwdec: 'auto-safe',
    seekStepSec: 10,
    rememberVolume: true,
  },
  sources: {
    autoPlay: 'binge',
    regex: '',
    pickerTimeoutSec: 0,
    reuseLinkHours: 6,
    preferBingeGroup: true,
    externalPlayer: '',
  },
  languages: {
    audio: ['en'],
    subtitles: ['en'],
    subtitleMode: 'forced',
    stripSdh: false,
  },
  subtitleStyle: {
    size: 46,
    color: '#F2F2F2',
    outlineColor: '#000000',
    outlineSize: 2.5,
    background: 'shadow',
    bold: false,
    marginY: 48,
    font: DEFAULT_SUBTITLE_FONT,
  },
  audio: {
    delayMs: 0,
    passthrough: false,
    volumeMax: 150,
    normalize: false,
  },
};

type Section = keyof Settings;

interface SettingsState {
  loaded: boolean;
  settings: Settings;
  load: () => Promise<void>;
  set: <S extends Section>(section: S, patch: Partial<Settings[S]>) => void;
  replace: (s: Settings) => void;
  reset: (section?: Section) => void;
}

let writer = debouncedWriter((v) => docs.write(profileDoc('settings'), v));

function merge(stored: Partial<Settings> | null): Settings {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!stored) return out;
  for (const key of Object.keys(out) as Section[]) {
    if (stored[key] && typeof stored[key] === 'object') Object.assign(out[key], stored[key]);
  }
  return out;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  settings: DEFAULT_SETTINGS,

  async load() {
    writer.flush();
    const name = profileDoc('settings');
    writer = debouncedWriter((v) => docs.write(name, v));
    const stored = await docs.read<Partial<Settings>>(name).catch(() => null);
    set({ settings: merge(stored), loaded: true });
  },

  set(section, patch) {
    const settings = { ...get().settings, [section]: { ...get().settings[section], ...patch } };
    set({ settings });
    writer.save(settings);
  },

  replace(s) {
    set({ settings: merge(s) });
    writer.save(get().settings);
  },

  reset(section) {
    const settings = section ? { ...get().settings, [section]: structuredClone(DEFAULT_SETTINGS[section]) } : structuredClone(DEFAULT_SETTINGS);
    set({ settings });
    writer.save(settings);
  },
}));

export function settingsNow(): Settings {
  return useSettings.getState().settings;
}

export function flushSettings() {
  return writer.flush();
}
