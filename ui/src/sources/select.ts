// Choosing a stream: which rows can play, what their badges say, and auto-play rules.

import type { SourcedStream, Stream } from '../addons/types';
import type { AutoPlayMode } from '../state/settings';

/** A row mpv can open directly. Statistics and error rows from AIOStreams have no link. */
export function isPlayable(s: Stream): boolean {
  return typeof s.url === 'string' && /^https?:\/\//i.test(s.url);
}

export function streamText(s: Stream): string {
  return [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join('\n');
}

export interface Badges {
  resolution?: '4K' | '1440p' | '1080p' | '720p' | '480p' | 'SD';
  hdr?: 'DV' | 'HDR10+' | 'HDR10' | 'HDR' | 'HLG';
  codec?: 'AV1' | 'HEVC' | 'H.264' | 'VP9';
  audio?: string;
  size?: string;
  cached?: boolean;
  service?: string;
  remux?: boolean;
}

const SERVICES: [RegExp, string][] = [
  [/\b(RD|real-?debrid)\b/i, 'Real-Debrid'],
  [/\b(TB|torbox)\b/i, 'TorBox'],
  [/\b(AD|all-?debrid)\b/i, 'AllDebrid'],
  [/\b(PM|premiumize)\b/i, 'Premiumize'],
  [/\b(DL|debrid-?link)\b/i, 'Debrid-Link'],
  [/\b(ED|easydebrid)\b/i, 'EasyDebrid'],
  [/\b(OC|offcloud)\b/i, 'Offcloud'],
];

export function badges(s: Stream): Badges {
  const t = streamText(s);
  const b: Badges = {};
  if (/\b(2160p|4k|uhd)\b/i.test(t)) b.resolution = '4K';
  else if (/\b1440p\b/i.test(t)) b.resolution = '1440p';
  else if (/\b1080p\b/i.test(t)) b.resolution = '1080p';
  else if (/\b720p\b/i.test(t)) b.resolution = '720p';
  else if (/\b(480p|576p)\b/i.test(t)) b.resolution = '480p';
  if (/\b(dv|dovi|dolby[ ._-]?vision)\b/i.test(t)) b.hdr = 'DV';
  else if (/\bhdr10\+|hdr10plus\b/i.test(t)) b.hdr = 'HDR10+';
  else if (/\bhdr10\b/i.test(t)) b.hdr = 'HDR10';
  else if (/\bhdr\b/i.test(t)) b.hdr = 'HDR';
  else if (/\bhlg\b/i.test(t)) b.hdr = 'HLG';
  if (/\bav1\b/i.test(t)) b.codec = 'AV1';
  else if (/\b(hevc|x265|h\.?265)\b/i.test(t)) b.codec = 'HEVC';
  else if (/\b(avc|x264|h\.?264)\b/i.test(t)) b.codec = 'H.264';
  else if (/\bvp9\b/i.test(t)) b.codec = 'VP9';
  const audio = /\b(atmos)\b/i.test(t)
    ? 'Atmos'
    : /\btruehd\b/i.test(t)
      ? 'TrueHD'
      : /\bdts[ ._-]?(hd|x|ma)\b/i.test(t)
        ? 'DTS-HD'
        : /\bdts\b/i.test(t)
          ? 'DTS'
          : /\b(ddp|dd\+|e-?ac-?3)\b/i.test(t)
            ? 'DD+'
            : /\b(dd|ac-?3)\b/i.test(t)
              ? 'DD'
              : /\baac\b/i.test(t)
                ? 'AAC'
                : /\bflac\b/i.test(t)
                  ? 'FLAC'
                  : undefined;
  if (audio) b.audio = audio;
  const size = /(\d+(?:[.,]\d+)?)\s?(GB|GiB|MB|MiB|TB)\b/i.exec(t);
  if (size) b.size = `${size[1].replace(',', '.')} ${size[2].toUpperCase().replace('IB', 'B')}`;
  else if (typeof s.behaviorHints?.videoSize === 'number') b.size = formatBytes(s.behaviorHints.videoSize);
  b.cached = s.behaviorHints?.cached === true || /⚡|\[\+\]|\bcached\b/i.test(t);
  if (typeof s.behaviorHints?.service === 'string') b.service = s.behaviorHints.service;
  else b.service = SERVICES.find(([re]) => re.test(s.name ?? ''))?.[1];
  b.remux = /\bremux\b/i.test(t);
  return b;
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

/** Addon order first (the user's), then each addon's own order. */
export function orderStreams(streams: SourcedStream[], addonOrder: string[]): SourcedStream[] {
  const pos = new Map(addonOrder.map((id, i) => [id, i]));
  return [...streams].sort((a, b) => (pos.get(a.addonId) ?? 99) - (pos.get(b.addonId) ?? 99) || a.rank - b.rank);
}

export interface AutoPickOptions {
  mode: AutoPlayMode;
  regex?: string;
  /** The binge group of the stream that played the previous episode of this show. */
  bingeGroup?: string | null;
  preferBingeGroup?: boolean;
}

function regexOf(pattern: string | undefined): RegExp | null {
  if (!pattern?.trim()) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** The stream to start without asking, or null to show the picker. */
export function autoPick(ordered: SourcedStream[], o: AutoPickOptions): SourcedStream | null {
  const playable = ordered.filter(isPlayable);
  if (!playable.length) return null;
  if (o.preferBingeGroup !== false && o.bingeGroup) {
    const same = playable.find((s) => s.behaviorHints?.bingeGroup === o.bingeGroup);
    if (same) return same;
  }
  switch (o.mode) {
    case 'off':
      return null;
    case 'first':
      return playable[0];
    case 'binge':
      // Without a previous group to follow, the addon's top pick is the best guess.
      return playable[0];
    case 'regex': {
      const re = regexOf(o.regex);
      return re ? playable.find((s) => re.test(streamText(s))) ?? null : null;
    }
  }
}

export function isValidRegex(pattern: string): boolean {
  if (!pattern.trim()) return true;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}
