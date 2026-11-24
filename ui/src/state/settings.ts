// Per-profile preferences, with defaults for anything not set yet.

import { create } from 'zustand';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from './profiles';

export type AutoPlayMode = 'off' | 'first' | 'binge' | 'regex';
export type SkipMode = 'off' | 'button' | 'auto';
export type SubtitleMode = 'off' | 'forced' | 'foreign' | 'always';

export interface Settings {
  appearance: {
    accent: 'sage' | 'mist' | 'sand' | 'rose' | 'sky';
    cardSize: 'small' | 'medium' | 'large';
    showRatings: boolean;
    heroEnabled: boolean;
    heroTrailers: boolean;
    reduceMotion: boolean;
    landscapeContinueWatching: boolean;
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
    reduceMotion: false,
    landscapeContinueWatching: true,
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
    font: 'Inter',
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
