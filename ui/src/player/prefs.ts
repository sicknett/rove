// Settings that reach mpv, and per-show audio/subtitle choices.

import { mpv } from '../bridge';
import { debouncedWriter, docs } from '../lib/native';
import { profileDoc } from '../state/profiles';
import { settingsNow, type Settings, subtitleFont } from '../state/settings';
import type { Track } from './store';

/** Pushes the player-facing settings into mpv (on start and whenever they change). */
export function applyPlayerSettings(s: Settings = settingsNow()) {
  const st = s.subtitleStyle;
  mpv.set('sub-font', subtitleFont(st.font));
  mpv.set('sub-font-size', st.size);
  mpv.set('sub-color', st.color);
  mpv.set('sub-bold', st.bold);
  mpv.set('sub-margin-y', st.marginY);
  mpv.set('sub-border-color', st.outlineColor);
  mpv.set('sub-border-size', st.background === 'box' ? 0 : st.outlineSize);
  mpv.set('sub-shadow-offset', st.background === 'shadow' ? 1.25 : 0);
  // mpv 0.40 draws the shadow in the "back" colour too (`sub-shadow-color` is only its old name),
  // so the one option carries the box or the shadow; clearing it for "shadow" drew no shadow.
  mpv.set('sub-back-color', st.background === 'box' ? '#B3000000' : st.background === 'shadow' ? '#99000000' : '#00000000');
  mpv.set('sub-border-style', st.background === 'box' ? 'background-box' : 'outline-and-shadow');
  mpv.set('hwdec', s.playback.hwdec);
  mpv.set('volume-max', s.audio.volumeMax);
  mpv.set('audio-delay', s.audio.delayMs / 1000);
  mpv.set('audio-spdif', s.audio.passthrough ? 'ac3,eac3,dts,dts-hd,truehd' : '');
  mpv.set('audio-exclusive', s.audio.passthrough);
  mpv.set('af', s.audio.normalize ? 'lavfi=[dynaudnorm=f=200:g=11:p=0.9:m=8]' : '');
}

// ---------- Per-show track memory ----------

export interface TrackChoice {
  audioLang?: string;
  audioTitle?: string;
  subLang?: string;
  subTitle?: string;
  /** The user turned subtitles off for this show. */
  subOff?: boolean;
  forced?: boolean;
}

let memory: Record<string, TrackChoice> = {};
let writer = debouncedWriter((v) => docs.write(profileDoc('tracks'), v), 1000);

export async function loadTrackMemory() {
  writer.flush();
  const name = profileDoc('tracks');
  writer = debouncedWriter((v) => docs.write(name, v), 1000);
  memory = (await docs.read<Record<string, TrackChoice>>(name).catch(() => null)) ?? {};
}

export function trackMemory(metaId: string): TrackChoice | undefined {
  return memory[metaId];
}

export function rememberTracks(metaId: string, patch: TrackChoice) {
  memory = { ...memory, [metaId]: { ...memory[metaId], ...patch } };
  writer.save(memory);
}

export function flushTrackMemory() {
  return writer.flush();
}

// ---------- Choosing tracks ----------

const ISO3: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh',
  por: 'pt', rus: 'ru', ara: 'ar', hin: 'hi', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', nob: 'no', dan: 'da', fin: 'fi',
  pol: 'pl', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', ces: 'cs', cze: 'cs', hun: 'hu',
  ukr: 'uk', ron: 'ro', rum: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk', slv: 'sl', lit: 'lt', lav: 'lv',
  est: 'et', msa: 'ms', may: 'ms', fil: 'tl', tgl: 'tl', per: 'fa', fas: 'fa', ben: 'bn', tam: 'ta', tel: 'te', cat: 'ca',
};

/** "eng", "en", "en-US", "English" all to "en". */
export function normLang(code?: string): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase();
  if (!c || c === 'und') return undefined;
  const base = c.split(/[-_]/)[0];
  if (ISO3[base]) return ISO3[base];
  if (base.length === 2) return base;
  const byName: Record<string, string> = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', japanese: 'ja', korean: 'ko', chinese: 'zh', portuguese: 'pt', russian: 'ru', arabic: 'ar', hindi: 'hi', dutch: 'nl' };
  return byName[base] ?? base;
}

const isSdh = (t: Track) => /\b(sdh|cc|hearing impaired|hi)\b/i.test(t.title ?? '');
const isForced = (t: Track) => t.forced === true || /\bforced\b/i.test(t.title ?? '');
const isCommentary = (t: Track) => /commentary/i.test(t.title ?? '');

export interface Selection {
  aid?: number | 'no';
  sid?: number | 'no';
}

/**
 * Picks tracks for a new file: the show's remembered choice first, then preferred languages.
 * Subtitles follow the mode: off, forced only, when the audio is not a preferred language, or always.
 */
export function chooseTracks(tracks: Track[], s: Settings, remembered?: TrackChoice): Selection {
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'sub');
  const prefAudio = s.languages.audio.map(normLang).filter(Boolean) as string[];
  const prefSubs = s.languages.subtitles.map(normLang).filter(Boolean) as string[];
  const out: Selection = {};

  // Audio
  let a: Track | undefined;
  if (remembered?.audioLang) {
    const lang = normLang(remembered.audioLang);
    const same = audio.filter((t) => normLang(t.lang) === lang);
    a = same.find((t) => remembered.audioTitle && t.title === remembered.audioTitle) ?? same.find((t) => !isCommentary(t)) ?? same[0];
  } else if (remembered?.audioTitle) {
    // A track with no language tag is known only by its title.
    a = audio.find((t) => t.title === remembered.audioTitle);
  }
  if (!a) {
    for (const lang of prefAudio) {
      const same = audio.filter((t) => normLang(t.lang) === lang && !isCommentary(t));
      a = same.find((t) => t.default) ?? same[0];
      if (a) break;
    }
  }
  if (!a) a = audio.find((t) => t.default) ?? audio.find((t) => !isCommentary(t)) ?? audio[0];
  if (a) out.aid = a.id;
  const audioLang = normLang(a?.lang);

  // Subtitles
  const pick = (langs: string[], forcedOnly: boolean) => {
    for (const lang of langs) {
      let cands = subs.filter((t) => normLang(t.lang) === lang);
      cands = forcedOnly ? cands.filter(isForced) : cands.filter((t) => !isForced(t));
      if (s.languages.stripSdh) cands.sort((x, y) => Number(isSdh(x)) - Number(isSdh(y)));
      const t = cands.find((x) => x.default) ?? cands[0];
      if (t) return t;
    }
    return undefined;
  };
  if (remembered?.subOff) {
    // Forced subtitles still show for foreign dialogue in a show the user watches without subs.
    const f = pick(audioLang ? [audioLang, ...prefSubs] : prefSubs, true);
    out.sid = f ? f.id : 'no';
    return out;
  }
  if (remembered?.subLang) {
    const lang = normLang(remembered.subLang);
    const same = subs.filter((t) => normLang(t.lang) === lang && (remembered.forced ? isForced(t) : !isForced(t)));
    const t = same.find((x) => remembered.subTitle && x.title === remembered.subTitle) ?? same[0];
    if (t) {
      out.sid = t.id;
      return out;
    }
  } else if (remembered?.subTitle) {
    const t = subs.find((x) => x.title === remembered.subTitle);
    if (t) {
      out.sid = t.id;
      return out;
    }
  }
  // Subtitle languages are the ones the user reads, so audio in one of them is understood.
  const audioUnderstood = !!audioLang && prefSubs.includes(audioLang);
  switch (s.languages.subtitleMode) {
    case 'off':
      out.sid = 'no';
      break;
    case 'forced': {
      const f = pick(audioLang ? [audioLang, ...prefSubs] : prefSubs, true);
      out.sid = f ? f.id : 'no';
      break;
    }
    case 'foreign': {
      if (audioUnderstood || !audioLang) {
        const f = pick([audioLang!, ...prefSubs], true);
        out.sid = f ? f.id : 'no';
      } else out.sid = pick(prefSubs, false)?.id ?? 'no';
      break;
    }
    case 'always':
      out.sid = pick(prefSubs, false)?.id ?? 'no';
      break;
  }
  return out;
}
